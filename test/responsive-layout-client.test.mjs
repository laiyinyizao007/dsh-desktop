// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Behaviour of the `dsh-desktop-responsive` client plugin.
 *
 * The upstream contract lives in the plugin's anchor manifest and is checked
 * by `test/responsive-layout.test.mjs`. This file checks what the plugin
 * actually does to the DOM: the drawer, the grid it hands back to the centre
 * column, the dismissal paths, and the cleanup on unload.
 *
 * The plugin is a browser module that registers itself with
 * `window.__ModuleLoader__`. The test stands in for the loader, then calls
 * `apply` with a context that behaves like the client root: `effect` runs
 * the body immediately and keeps the disposer.
 */

/** Load the client plugin and activate it. */
async function activatePlugin() {
  let captured = null
  window.__ModuleLoader__ = {
    load(module) {
      captured = module
    },
  }
  vi.resetModules()
  await import('../packages/dsh-desktop-responsive/client.js')
  if (captured === null) throw new Error('the client plugin did not register itself')
  const exports = captured.factory()
  const disposers = []
  const dictionaries = new Map()
  const services = new Map()
  exports.apply({
    effect(body) {
      disposers.push(body())
    },
    provide(name, service) {
      services.set(name, service)
    },
    get(name) {
      return services.get(name)
    },
    locale: {
      register(namespace, dictionary) {
        dictionaries.set(namespace, dictionary)
      },
      bind(namespace) {
        // The plugin's own dictionary carries both locales; the English one
        // stands in for the running locale, so a key resolves to a real
        // string rather than to itself.
        return key => {
          const dictionary = dictionaries.get(namespace)
          if (dictionary === undefined) return key
          return dictionary.en?.[key] ?? dictionary[key] ?? key
        }
      },
    },
  })
  return {
    anchors: exports.anchors,
    phoneMax: exports.phoneMax,
    services,
    dispose() {
      for (const dispose of disposers.reverse()) dispose?.()
    },
  }
}

/**
 * Stand in for the visual viewport.
 *
 * A phone's keyboard takes part of the screen without changing the
 * window's size, so only the visual viewport knows. The stub replaces it
 * with one that reports a different size.
 */
const viewport = new EventTarget()
viewport.width = 390
viewport.height = 800
viewport.scale = 1
viewport.offsetTop = 0

/**
 * Point the window at the shared visual viewport.
 *
 * The plugin takes hold of the viewport when it installs, so the object
 * has to be the same one for the whole file: a test changes the numbers
 * on it and the plugin sees the change.
 */
function installVisualViewport() {
  Object.defineProperty(window, 'visualViewport', {
    value: viewport,
    configurable: true,
  })
}

/** Change the viewport's numbers, the way a keyboard would. */
function stubVisualViewport({ width, height, scale = 1, offsetTop = 0 }) {
  viewport.width = width
  viewport.height = height
  viewport.scale = scale
  viewport.offsetTop = offsetTop
  viewport.dispatchEvent(new Event('resize'))
}

/** Let the MutationObserver callbacks run. */
function flush() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * Build a stand-in for the upstream frame.
 *
 * Only the shape the plugin binds to is reproduced: the grid frame, the
 * sidebar column with its toggle, the centre column with the conversation
 * body, and the right column.
 */
function buildFrame({ width = 390, collapsed = false, grid } = {}) {
  document.body.innerHTML = ''
  const frame = document.createElement('div')
  frame.setAttribute('data-dsh-region', 'layout')
  frame.style.setProperty(
    'grid-template-columns',
    grid ?? '56px minmax(400px, 1fr) minmax(0px, 0px)'
  )
  if (collapsed) frame.setAttribute('data-sidebar-collapsed', 'true')
  let currentWidth = width
  frame.getBoundingClientRect = () => ({
    width: currentWidth,
    height: 800,
    top: 0,
    left: 0,
    right: currentWidth,
    bottom: 800,
    x: 0,
    y: 0,
  })

  const sidebar = document.createElement('div')
  sidebar.setAttribute('data-dsh-region', 'sidebar')
  const toggle = document.createElement('button')
  toggle.setAttribute('data-dsh-region', 'sidebar-toggle')
  let toggles = 0
  toggle.addEventListener('click', () => {
    toggles += 1
    // Upstream collapses the sidebar when the toggle is pressed.
    if (frame.getAttribute('data-sidebar-collapsed') === null) {
      frame.setAttribute('data-sidebar-collapsed', 'true')
    } else {
      frame.removeAttribute('data-sidebar-collapsed')
    }
  })
  sidebar.appendChild(toggle)
  frame.appendChild(sidebar)

  const center = document.createElement('div')
  center.setAttribute('data-dsh-region', 'center')
  const header = document.createElement('header')
  header.setAttribute('data-dsh-region', 'conversation-header')
  const tabs = document.createElement('div')
  tabs.setAttribute('data-dsh-region', 'conversation-tabs')
  header.appendChild(tabs)
  center.appendChild(header)
  const conversation = document.createElement('div')
  conversation.setAttribute('data-conversation-content', '')
  // The status row belongs to a session.
  conversation.setAttribute('data-conversation-session', 'session-1')
  const dock = document.createElement('div')
  dock.setAttribute('data-dsh-region', 'composer-dock')
  conversation.appendChild(dock)
  center.appendChild(conversation)
  frame.appendChild(center)

  const rightbar = document.createElement('div')
  rightbar.setAttribute('data-rightbar-col', 'true')
  frame.appendChild(rightbar)

  document.body.appendChild(frame)
  return {
    frame,
    sidebar,
    center,
    rightbar,
    toggle,
    toggles: () => toggles,
    setWidth(next) {
      currentWidth = next
    },
  }
}

/**
 * Build a stand-in for the model menu upstream renders into a portal.
 *
 * The root pane lists the model and the reasoning effort, each as a row of
 * a label and a value. The plugin adds its usage entry to that pane, so
 * the menu is what the entry is looked up in.
 */
function buildModelMenu({ aria = 'Model and reasoning effort' } = {}) {
  const menu = document.createElement('div')
  menu.setAttribute('data-menu-material', 'translucent')
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', aria)
  const row = (label, value) => {
    const button = document.createElement('button')
    button.setAttribute('role', 'menuitem')
    button.className = 'cell'
    const labelSpan = document.createElement('span')
    labelSpan.className = 'cellLabel'
    labelSpan.textContent = label
    const valueSpan = document.createElement('span')
    valueSpan.className = 'cellValue'
    valueSpan.textContent = value
    button.appendChild(labelSpan)
    button.appendChild(valueSpan)
    return button
  }
  menu.appendChild(row('Model', 'MiniMax-M3'))
  menu.appendChild(row('Reasoning effort', 'High'))
  document.body.appendChild(menu)
  return menu
}

/** Build a stand-in for the portalled settings dialog. */
function buildSettingsDialog() {
  const overlay = document.createElement('div')
  overlay.setAttribute('data-dsh-region', 'settings-overlay')
  const panel = document.createElement('div')
  panel.setAttribute('role', 'dialog')
  const nav = document.createElement('nav')
  nav.setAttribute('data-dsh-region', 'settings-nav')
  const navList = document.createElement('div')
  navList.setAttribute('data-dsh-region', 'settings-nav-list')
  nav.appendChild(navList)
  const title = document.createElement('div')
  title.setAttribute('data-dsh-region', 'settings-nav-title')
  nav.insertBefore(title, navList)
  const footer = document.createElement('div')
  footer.setAttribute('data-dsh-settings-sidebar-footer', 'true')
  nav.appendChild(footer)
  panel.appendChild(nav)
  const content = document.createElement('div')
  content.setAttribute('data-dsh-region', 'settings-content')
  const header = document.createElement('div')
  header.setAttribute('data-dsh-region', 'settings-header')
  content.appendChild(header)
  const options = document.createElement('div')
  options.setAttribute('data-dsh-region', 'settings-options')
  content.appendChild(options)
  panel.appendChild(content)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)
  return { overlay, nav, navList, content, options, footer }
}

describe('dsh-desktop-responsive client', () => {
  let plugin = null

  beforeEach(async () => {
    installVisualViewport()
    // The default is a viewport that agrees with the window, which is what
    // a desktop browser reports.
    viewport.width = window.innerWidth
    viewport.height = window.innerHeight
    viewport.scale = 1
    viewport.offsetTop = 0
    plugin = await activatePlugin()
  })

  afterEach(() => {
    plugin?.dispose()
    document.body.innerHTML = ''
    document.documentElement.removeAttribute('data-dshr-mode')
    document.documentElement.removeAttribute('data-dshr-missing')
    document.documentElement.style.removeProperty('--dsh-visual-width')
    document.documentElement.style.removeProperty('--dsh-visual-height')
    document.documentElement.style.removeProperty('--dsh-visual-offset')
    delete window.__ModuleLoader__
    // The viewport stub must not leak into the next test.
    delete window.visualViewport
  })

  it('switches to the phone layout when the frame is narrow', async () => {
    buildFrame({ width: 390 })
    await flush()
    expect(document.documentElement.getAttribute('data-dshr-mode')).toBe('phone')
  })

  it('keeps the wide layout when the frame is wide', async () => {
    buildFrame({ width: 1280 })
    await flush()
    expect(document.documentElement.getAttribute('data-dshr-mode')).toBe('wide')
  })

  it('adapts to the frame width, not the window width', async () => {
    // A narrow frame inside a wide window is still a phone layout.
    window.innerWidth = 1280
    buildFrame({ width: 390 })
    await flush()
    expect(document.documentElement.getAttribute('data-dshr-mode')).toBe('phone')
  })

  it('turns the expanded sidebar into a drawer', async () => {
    const { frame } = buildFrame({ width: 390, collapsed: false })
    await flush()
    expect(frame.getAttribute('data-dshr-drawer')).toBe('open')
  })

  it('leaves the collapsed rail in the grid', async () => {
    const { frame } = buildFrame({ width: 390, collapsed: true })
    await flush()
    expect(frame.getAttribute('data-dshr-drawer')).toBe('closed')
    // On a phone the rail's track goes away too: the drawer replaces it.
    const grid = frame.style.getPropertyValue('grid-template-columns')
    expect(grid.startsWith('0px')).toBe(true)
  })

  it('gives the whole width back to the centre column while the drawer is open', async () => {
    const { frame } = buildFrame({ width: 390 })
    await flush()
    const grid = frame.style.getPropertyValue('grid-template-columns')
    expect(grid.startsWith('0px')).toBe(true)
    expect(grid).toContain('minmax(400px, 1fr)')
  })

  it('restores the grid React wrote when the layout goes back to wide', async () => {
    const { frame, setWidth } = buildFrame({ width: 390 })
    await flush()
    expect(frame.style.getPropertyValue('grid-template-columns')).toBe(
      '0px minmax(400px, 1fr) minmax(0px, 0px)'
    )
    setWidth(1280)
    window.dispatchEvent(new window.Event('resize'))
    await flush()
    expect(frame.style.getPropertyValue('grid-template-columns')).toBe(
      '56px minmax(400px, 1fr) minmax(0px, 0px)'
    )
  })

  it('restores the grid React rewrote while the phone layout was active', async () => {
    const { frame, setWidth } = buildFrame({ width: 390 })
    await flush()
    // React re-renders the inline grid whenever the layout changes.
    frame.style.setProperty(
      'grid-template-columns',
      '64px minmax(400px, 1fr) minmax(0px, 0px)'
    )
    await flush()
    setWidth(1280)
    window.dispatchEvent(new window.Event('resize'))
    await flush()
    // The value React wrote last wins, not the one captured when the
    // phone layout started.
    expect(frame.style.getPropertyValue('grid-template-columns')).toBe(
      '64px minmax(400px, 1fr) minmax(0px, 0px)'
    )
  })

  it('closes the drawer on Escape', async () => {
    const { frame, toggles } = buildFrame({ width: 390 })
    await flush()
    expect(frame.getAttribute('data-dshr-drawer')).toBe('open')
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    )
    await flush()
    expect(toggles()).toBe(1)
    expect(frame.getAttribute('data-dshr-drawer')).toBe('closed')
  })

  it('closes the drawer when the scrim is clicked', async () => {
    const { frame, toggles } = buildFrame({ width: 390 })
    await flush()
    const scrim = document.querySelector('[data-dshr-scrim]')
    expect(scrim).not.toBeNull()
    scrim.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await flush()
    expect(toggles()).toBe(1)
  })

  it('makes the content behind the drawer inert', async () => {
    const { center } = buildFrame({ width: 390 })
    await flush()
    expect(center.hasAttribute('inert')).toBe(true)
  })

  it('releases the content when the drawer closes', async () => {
    const { frame, center } = buildFrame({ width: 390 })
    await flush()
    frame.setAttribute('data-sidebar-collapsed', 'true')
    await flush()
    expect(center.hasAttribute('inert')).toBe(false)
  })

  it('gives the settings dialog the window width, not the frame width', async () => {
    window.innerWidth = 1280
    buildFrame({ width: 390 })
    const { overlay } = buildSettingsDialog()
    await flush()
    // The frame is narrow but the dialog covers the viewport, so it stays
    // a desktop dialog.
    expect(overlay.getAttribute('data-dshr-mode')).toBe('wide')
    expect(document.documentElement.getAttribute('data-dshr-mode')).toBe('phone')
  })

  it('gives the settings dialog the phone layout in a narrow window', async () => {
    window.innerWidth = 390
    buildFrame({ width: 390 })
    const { overlay } = buildSettingsDialog()
    await flush()
    expect(overlay.getAttribute('data-dshr-mode')).toBe('phone')
  })

  it('names a missing anchor instead of failing silently', async () => {
    buildFrame({ width: 390 })
    // The settings dialog is on screen but its body marker is gone.
    const { overlay } = buildSettingsDialog()
    overlay
      .querySelector('[data-dsh-region="settings-content"]')
      .removeAttribute('data-dsh-region')
    await flush()
    const missing = document.documentElement.getAttribute('data-dshr-missing') ?? ''
    expect(missing).toContain('settingsContent')
  })

  it('closes the drawer when the main panel is swapped', async () => {
    const { frame, center, toggles } = buildFrame({ width: 390 })
    await flush()
    expect(frame.getAttribute('data-dshr-drawer')).toBe('open')
    // Upstream replaces the child of the main slot when the panel changes.
    const slot = document.createElement('div')
    slot.setAttribute('data-slot', 'main')
    slot.appendChild(document.createElement('div'))
    center.replaceChildren(slot)
    await flush()
    expect(toggles()).toBe(1)
    expect(frame.getAttribute('data-dshr-drawer')).toBe('closed')
  })

  it('keeps the drawer open while the conversation streams', async () => {
    const { frame, center, toggles } = buildFrame({ width: 390 })
    await flush()
    expect(frame.getAttribute('data-dshr-drawer')).toBe('open')
    // A streamed answer adds nodes inside the conversation body.
    const content = center.querySelector('[data-conversation-content]')
    content.appendChild(document.createElement('p'))
    await flush()
    expect(toggles()).toBe(0)
    expect(frame.getAttribute('data-dshr-drawer')).toBe('open')
  })

  it('reports a conversation that overflows the frame', async () => {
    const { center } = buildFrame({ width: 390 })
    const content = center.querySelector('[data-conversation-content]')
    // jsdom does no layout, so the overflow is declared rather than measured.
    Object.defineProperty(content, 'scrollWidth', { value: 680, configurable: true })
    Object.defineProperty(content, 'clientWidth', { value: 334, configurable: true })
    await flush()
    const problem = document.documentElement.getAttribute('data-dshr-problem') ?? ''
    expect(problem).toContain('conversation content overflows')
  })

  it('reports a frame grid that is no longer three columns', async () => {
    const { frame } = buildFrame({ width: 390 })
    frame.style.setProperty('grid-template-columns', '56px minmax(0px, 1fr) 0px 200px')
    await flush()
    const problem = document.documentElement.getAttribute('data-dshr-problem') ?? ''
    expect(problem).toContain('tracks')
  })

  it('shows a menu button where the hidden rail had its toggle', async () => {
    buildFrame({ width: 390, collapsed: true })
    await flush()
    const button = document.querySelector('[data-dshr-menu]')
    expect(button).not.toBeNull()
    expect(button.getAttribute('data-dshr-menu-visible')).toBe('true')
    expect(button.getAttribute('aria-label')).toBe('Open sidebar')
  })

  it('hides the menu button when the rail took no space to begin with', async () => {
    // macOS and a window with a title bar already have a zero-width rail;
    // the platform's own window controls live there.
    buildFrame({ width: 390, grid: '0px minmax(400px, 1fr) minmax(0px, 0px)' })
    await flush()
    const button = document.querySelector('[data-dshr-menu]')
    expect(button).not.toBeNull()
    expect(button.hasAttribute('data-dshr-menu-visible')).toBe(false)
  })

  it('opens the drawer from the menu button', async () => {
    const { frame, toggles } = buildFrame({ width: 390, collapsed: true })
    await flush()
    document.querySelector('[data-dshr-menu]').click()
    await flush()
    expect(toggles()).toBe(1)
    expect(frame.getAttribute('data-dshr-drawer')).toBe('open')
  })

  it('hides the menu button while the drawer is open', async () => {
    buildFrame({ width: 390, collapsed: true })
    await flush()
    document.querySelector('[data-dshr-menu]').click()
    await flush()
    expect(
      document.querySelector('[data-dshr-menu]').hasAttribute('data-dshr-menu-visible')
    ).toBe(false)
  })

  it('publishes the visible width and height of the screen', async () => {
    buildFrame({ width: 390 })
    await flush()
    const root = document.documentElement
    expect(root.style.getPropertyValue('--dsh-visual-width')).toBe(
      `${window.innerWidth}px`
    )
    expect(root.style.getPropertyValue('--dsh-visual-height')).toBe(
      `${window.innerHeight}px`
    )
  })

  it('follows the visible width when a landscape keyboard takes the side', async () => {
    // A frame that is wider than the visible part of the screen: the
    // layout must not be laid out for more space than the user can see.
    window.innerWidth = 844
    const { frame } = buildFrame({ width: 844 })
    stubVisualViewport({ width: 420, height: 360 })
    window.dispatchEvent(new window.Event('resize'))
    await flush()
    expect(document.documentElement.getAttribute('data-dshr-mode')).toBe('phone')
    expect(document.documentElement.style.getPropertyValue('--dsh-visual-width')).toBe(
      '420px'
    )
  })

  it('keeps the layout viewport when the user pinch-zooms', async () => {
    // A zoom is not a smaller screen: re-laying out the shell would fight
    // the zoom.
    buildFrame({ width: 390 })
    stubVisualViewport({ width: 200, height: 300, scale: 2 })
    window.dispatchEvent(new window.Event('resize'))
    await flush()
    expect(document.documentElement.style.getPropertyValue('--dsh-visual-width')).toBe(
      `${window.innerWidth}px`
    )
    expect(document.documentElement.style.getPropertyValue('--dsh-visual-height')).toBe(
      `${window.innerHeight}px`
    )
  })

  it('publishes the scroll offset of the visible area', async () => {
    // Safari scrolls the layout viewport when the keyboard opens, so the
    // visible band starts below its top.
    buildFrame({ width: 390 })
    stubVisualViewport({ width: 390, height: 520, offsetTop: 180 })
    window.dispatchEvent(new window.Event('resize'))
    await flush()
    expect(
      document.documentElement.style.getPropertyValue('--dsh-visual-offset')
    ).toBe('180px')
  })

  it('publishes the visible height for the on-screen keyboard', async () => {
    buildFrame({ width: 390 })
    await flush()
    const height = document.documentElement.style.getPropertyValue('--dsh-visual-height')
    expect(height).toBe(`${window.innerHeight}px`)
  })

  it('follows the visual viewport when the keyboard opens', async () => {
    buildFrame({ width: 390 })
    await flush()
    // A phone's keyboard takes the bottom of the screen without changing
    // the window's height, so only the visual viewport knows.
    const viewport = { height: 520, offsetTop: 0 }
    Object.defineProperty(window, 'visualViewport', {
      value: {
        get height() {
          return viewport.height
        },
        offsetTop: 0,
        addEventListener() {},
        removeEventListener() {},
      },
      configurable: true,
    })
    window.dispatchEvent(new window.Event('resize'))
    await flush()
    expect(document.documentElement.style.getPropertyValue('--dsh-visual-height')).toBe(
      '520px'
    )
    delete window.visualViewport
  })

  it('folds the view tabs and the status row away on a phone', async () => {
    buildFrame({ width: 390 })
    await flush()
    const style = document.querySelector('style[data-plugin-css="dsh-desktop-responsive"]')
    const css = style.textContent
    // The rows collapse with a zero height rather than display: none, so
    // restoring them does not depend on the upstream display value.
    expect(css).toContain('conversation-tabs')
    expect(css).toContain('composer-dock')
    expect(css).toMatch(/conversation-tabs[\s\S]{0,200}height: 0 !important/)
    expect(css).toMatch(/composer-dock[\s\S]{0,200}height: 0 !important/)
  })

  it('gives a sent message the whole width of a phone', async () => {
    buildFrame({ width: 390 })
    await flush()
    const style = document.querySelector('style[data-plugin-css="dsh-desktop-responsive"]')
    const css = style.textContent
    // The side clearance upstream reserves for the composer card is dropped,
    // so the flow's own gutter is the only margin around the conversation.
    expect(css).toMatch(/dsh-composer-side-clearance: 0px !important/)
    // The column takes that gutter whole instead of taking a little off on
    // top of it.
    expect(css).toMatch(/dsh-chat-content-width: min\(100%, 920px\) !important/)
    // And the bubble takes the column, so a long message fills the screen
    // while a short one still renders as a small bubble.
    expect(css).toMatch(
      /data-dsh-region="chat-user-stack"\][^}]*max-width: 100% !important/
    )
  })

  it('offers a chevron for the folded tabs and an entry for the status row', async () => {
    buildFrame({ width: 390, collapsed: true })
    await flush()
    const tabs = document.querySelector('[data-dshr-tabs-toggle]')
    expect(tabs).not.toBeNull()
    expect(tabs.getAttribute('data-dshr-toggle-visible')).toBe('true')
    // The usage entry is a row of the model menu, so it arrives with it.
    buildModelMenu()
    await flush()
    const usage = document.querySelector('[data-dshr-usage]')
    expect(usage).not.toBeNull()
    expect(usage.getAttribute('role')).toBe('menuitem')
    // It sits after the rows upstream rendered, and takes their geometry.
    expect(usage.previousElementSibling.textContent).toContain('High')
    expect(usage.className).toBe('cell')
  })

  it('puts the usage entry in the model menu rather than in the corner', async () => {
    buildFrame({ width: 390, collapsed: true })
    await flush()
    // Nothing floats in the corner of the screen any more.
    expect(document.querySelector('[data-dshr-usage]')).toBeNull()
    buildModelMenu()
    await flush()
    const usage = document.querySelector('[data-dshr-usage]')
    expect(usage).not.toBeNull()
    expect(usage.parentElement.getAttribute('data-menu-material')).toBe('translucent')
  })

  it('leaves the deeper panes of the model menu alone', async () => {
    buildFrame({ width: 390, collapsed: true })
    await flush()
    // The pane that lists the models uses radio items, not cells.
    const menu = document.createElement('div')
    menu.setAttribute('data-menu-material', 'translucent')
    menu.setAttribute('role', 'group')
    const radio = document.createElement('button')
    radio.setAttribute('role', 'menuitemradio')
    radio.setAttribute('aria-checked', 'true')
    menu.appendChild(radio)
    document.body.appendChild(menu)
    await flush()
    expect(document.querySelector('[data-dshr-usage]')).toBeNull()
  })

  it('folds the tabs back when their chevron is pressed', async () => {
    buildFrame({ width: 390, collapsed: true })
    await flush()
    expect(document.documentElement.hasAttribute('data-dshr-tabs')).toBe(false)
    document.querySelector('[data-dshr-tabs-toggle]').click()
    await flush()
    expect(document.documentElement.getAttribute('data-dshr-tabs')).toBe('open')
  })

  it('opens the usage sheet from its single entry', async () => {
    buildFrame({ width: 390, collapsed: true })
    buildModelMenu()
    await flush()
    expect(document.documentElement.hasAttribute('data-dshr-sheet')).toBe(false)
    document.querySelector('[data-dshr-usage]').click()
    await flush()
    expect(document.documentElement.getAttribute('data-dshr-sheet')).toBe('open')
    // The sheet has a backdrop that dismisses it.
    const backdrop = document.querySelector('[data-dshr-sheet-backdrop]')
    expect(backdrop).not.toBeNull()
    backdrop.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await flush()
    expect(document.documentElement.hasAttribute('data-dshr-sheet')).toBe(false)
  })

  it('closes the usage sheet on Escape', async () => {
    buildFrame({ width: 390, collapsed: true })
    buildModelMenu()
    await flush()
    document.querySelector('[data-dshr-usage]').click()
    await flush()
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    )
    await flush()
    expect(document.documentElement.hasAttribute('data-dshr-sheet')).toBe(false)
  })

  it('folds the model selector to its icon on a phone', async () => {
    buildFrame({ width: 390 })
    await flush()
    const style = document.querySelector('style[data-plugin-css="dsh-desktop-responsive"]')
    // The seat reads two inherited variables, so the root can fold the
    // model name away without touching the row upstream measures.
    expect(style.textContent).toContain('--dsh-composer-model-text-display: none')
    expect(style.textContent).toContain('--dsh-composer-model-icon-display: block')
  })

  it('hides the folded-row controls in the wide layout', async () => {
    buildFrame({ width: 1280 })
    await flush()
    expect(
      document.querySelector('[data-dshr-tabs-toggle]').hasAttribute('data-dshr-toggle-visible')
    ).toBe(false)
    // A wide layout shows the status row itself, so it needs no entry.
    buildModelMenu()
    await flush()
    expect(document.querySelector('[data-dshr-usage]')).toBeNull()
  })

  it('lets a wide table scroll sideways on a phone', async () => {
    buildFrame({ width: 390 })
    const conversation = document.querySelector('[data-conversation-content]')
    const table = document.createElement('table')
    conversation.appendChild(table)
    await flush()
    // Upstream hides a wide table's scroll bar until the pointer hovers
    // it, which on a phone leaves the last columns out of reach.
    const scroller = table.parentElement
    expect(scroller.getAttribute('data-dshr-table-scroll')).toBe('')
    const style = document.querySelector('style[data-plugin-css="dsh-desktop-responsive"]')
    expect(style.textContent).toMatch(/data-dshr-table-scroll\][\s\S]{0,120}overflow-x: auto/)
  })

  it('shows the table hint only while there is more to the right', async () => {
    buildFrame({ width: 390 })
    const conversation = document.querySelector('[data-conversation-content]')
    const table = document.createElement('table')
    conversation.appendChild(table)
    await flush()
    const scroller = table.parentElement
    // jsdom does no layout, so the sizes are declared rather than measured.
    Object.defineProperty(scroller, 'scrollWidth', { value: 640, configurable: true })
    Object.defineProperty(scroller, 'clientWidth', { value: 350, configurable: true })
    Object.defineProperty(scroller, 'scrollLeft', { value: 0, writable: true, configurable: true })
    await flush()
    expect(scroller.hasAttribute('data-dshr-overflow')).toBe(true)
    scroller.scrollLeft = 290
    scroller.dispatchEvent(new window.Event('scroll'))
    await flush()
    expect(scroller.hasAttribute('data-dshr-overflow')).toBe(false)
  })

  it('gives the body text a little more room to breathe', async () => {
    buildFrame({ width: 390 })
    await flush()
    const style = document.querySelector('style[data-plugin-css="dsh-desktop-responsive"]')
    expect(style.textContent).toMatch(/data-conversation-content\] p[\s\S]{0,120}line-height: calc\(26px/)
  })

  it('raises the smallest chrome labels on a phone', async () => {
    buildFrame({ width: 390 })
    await flush()
    const style = document.querySelector('style[data-plugin-css="dsh-desktop-responsive"]')
    // The theme hands the sizes out as tokens, so the phone layout can
    // raise the small end without touching a component.
    expect(style.textContent).toContain('--dsw-font-xxxs-11: 12px/15px')
    expect(style.textContent).toContain('--dsw-font-xxs-12: 13px/19px')
    expect(style.textContent).toContain('--dsw-font-xs-13: 14px/21px')
  })

  it('nudges the reading size only while the user has not chosen one', async () => {
    buildFrame({ width: 390 })
    await flush()
    // The default: the plugin may raise it.
    expect(document.documentElement.getAttribute('data-dshr-content-scale')).toBe('on')
    // The user picked a size: their choice wins.
    document.body.style.setProperty('--dsh-content-font-size', '16px')
    await flush()
    expect(document.documentElement.hasAttribute('data-dshr-content-scale')).toBe(false)
    document.body.style.removeProperty('--dsh-content-font-size')
  })

  it('grows the icons in the surfaces the reader touches', async () => {
    buildFrame({ width: 390 })
    await flush()
    const style = document.querySelector('style[data-plugin-css="dsh-desktop-responsive"]')
    // The injected stylesheet carries the interpolated selector.
    expect(style.textContent).toMatch(
      /data-conversation-region="composer"\] button svg[\s\S]{0,160}width: 18px/
    )
  })

  it('collapses the actions in the header into one menu', async () => {
    // The rail is collapsed, so the drawer is not covering the screen.
    buildFrame({ width: 390, collapsed: true })
    const header = document.querySelector('[data-dsh-region="conversation-header"]')
    const utilities = document.createElement('div')
    utilities.setAttribute('data-slot', 'conversation.session.header.utilities')
    utilities.appendChild(document.createElement('button'))
    header.appendChild(utilities)
    await flush()
    // The trigger stands in for the six small buttons.
    const trigger = document.querySelector('[data-dshr-actions]')
    expect(trigger).not.toBeNull()
    expect(trigger.getAttribute('data-dshr-toggle-visible')).toBe('true')
    // The menu is folded away until it is asked for.
    expect(document.documentElement.hasAttribute('data-dshr-actions-open')).toBe(false)
    trigger.click()
    await flush()
    expect(document.documentElement.getAttribute('data-dshr-actions-open')).toBe('open')
  })

  it('publishes the title row centre so the controls line up', async () => {
    buildFrame({ width: 390, collapsed: true })
    const center = document.querySelector('[data-dsh-region="conversation-header"]')
    const row = document.createElement('div')
    row.setAttribute('data-dsh-region', 'conversation-title-row')
    center.appendChild(row)
    await flush()
    // The row's height follows its content, so the controls are measured
    // against it rather than pinned to a fixed offset.
    row.getBoundingClientRect = () => ({ y: 10, height: 34, top: 10, bottom: 44, width: 280, left: 20, right: 300 })
    await flush()
    expect(document.documentElement.style.getPropertyValue('--dsh-header-centre')).toBe('27px')
  })

  it('lets another plugin add an item to the collapsed menu', async () => {
    // The frame appears after the plugin installed; the observer notices.
    buildFrame({ width: 390, collapsed: true })
    await flush()
    const service = plugin.services.get('dshDesktopResponsive')
    expect(service).toBeDefined()
    const chosen = []
    const remove = service.registerAction({
      id: 'demo:action',
      label: '示例操作',
      onSelect: () => chosen.push('demo:action'),
    })
    await flush()
    const strip = document.querySelector('[data-dshr-action-strip]')
    expect(strip).not.toBeNull()
    const button = strip.querySelector('[data-dshr-action="demo:action"]')
    expect(button).not.toBeNull()
    expect(button.getAttribute('aria-label')).toBe('示例操作')
    button.click()
    await flush()
    expect(chosen).toEqual(['demo:action'])
    remove()
    await flush()
    expect(strip.querySelector('[data-dshr-action="demo:action"]')).toBeNull()
  })

  it('writes every plugin attribute selector with its brackets', async () => {
    await activatePlugin()
    const style = document.querySelector('style[data-plugin-css="dsh-desktop-responsive"]')
    // A selector without its brackets is not a selector: the browser drops
    // the whole rule and the attribute silently stops matching. Comments
    // are skipped — they talk about the attributes in prose.
    const css = style.textContent.replace(/\/\*[\s\S]*?\*\//g, '')
    const bare = css.match(/(^|[^\[])\bdata-dshr-[a-z-]+/g) || []
    expect(bare).toEqual([])
    // An anchor's selector already carries its own brackets, so wrapping it
    // in another pair is not a selector at all: the browser drops the rule
    // and the style silently stops applying.
    expect(css).not.toMatch(/\[\[[^\]]+\]\]/)
  })

  it('ignores a visual viewport that is too small to be a keyboard', async () => {
    // A web view can report a viewport that never settled. A phone's
    // keyboard never covers more than half the screen, so anything below
    // that is not a keyboard and the shell keeps the window's height.
    stubVisualViewport({ width: 390, height: 120 })
    await activatePlugin()
    await flush()
    const root = document.documentElement
    expect(root.style.getPropertyValue('--dsh-visual-height')).toBe(`${window.innerHeight}px`)
  })

  it('follows a visual viewport that a keyboard could explain', async () => {
    stubVisualViewport({ width: 390, height: 500 })
    await activatePlugin()
    await flush()
    const root = document.documentElement
    expect(root.style.getPropertyValue('--dsh-visual-height')).toBe('500px')
  })

  it('takes the bottom workbench drag handle away on a phone', async () => {
    // The bottom panel is a desktop workbench. On a phone it sits below the
    // fold, but its resize handle stays on the screen and can be dragged.
    buildFrame({ width: 390, collapsed: true })
    const panel = document.createElement('div')
    panel.setAttribute('data-dsh-bottom-panel', '')
    const handle = document.createElement('div')
    handle.style.cursor = 'row-resize'
    panel.appendChild(handle)
    document.body.appendChild(panel)
    await flush()
    expect(handle.getAttribute('data-dshr-no-drag')).toBe('')
    // A wide window keeps the drag.
    buildFrame({ width: 1280 })
    document.body.appendChild(panel)
    await flush()
    expect(handle.hasAttribute('data-dshr-no-drag')).toBe(false)
  })

  it('makes the bottom workbench a full-screen overlay on a phone', async () => {
    await activatePlugin()
    const style = document.querySelector('style[data-plugin-css="dsh-desktop-responsive"]')
    const css = style.textContent
    // The workbench is a band along the bottom of a desktop window. On a
    // phone it covers the screen, which also settles the gap the band
    // left between the conversation and the panel.
    expect(css).toMatch(
      /data-dshr-mode='phone'\] \[data-dsh-bottom-panel\][^{]*\{[^}]*height: 100%/
    )
    // The layer the panel is mounted in decides what the panel's own
    // z-index is measured against, so it has to clear the plugin's own
    // floating controls.
    expect(css).toMatch(/data-dshr-panel-layer\][^{]*\{[^}]*z-index: 46/)
  })

  it('injects its stylesheet exactly once', async () => {
    buildFrame({ width: 390 })
    await flush()
    expect(
      document.querySelectorAll('style[data-plugin-css="dsh-desktop-responsive"]').length
    ).toBe(1)
  })

  it('removes everything it added when it is unloaded', async () => {
    buildFrame({ width: 390 })
    await flush()
    plugin.dispose()
    expect(document.querySelector('style[data-plugin-css="dsh-desktop-responsive"]')).toBeNull()
    expect(document.querySelector('[data-dshr-scrim]')).toBeNull()
    expect(document.documentElement.hasAttribute('data-dshr-mode')).toBe(false)
  })
})
