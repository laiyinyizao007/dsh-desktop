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
  exports.apply({
    effect(body) {
      disposers.push(body())
    },
  })
  return {
    anchors: exports.anchors,
    phoneMax: exports.phoneMax,
    dispose() {
      for (const dispose of disposers.reverse()) dispose?.()
    },
  }
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
    grid ?? '280px minmax(400px, 1fr) minmax(0px, 0px)'
  )
  if (collapsed) frame.setAttribute('data-sidebar-collapsed', 'true')
  frame.getBoundingClientRect = () => ({
    width,
    height: 800,
    top: 0,
    left: 0,
    right: width,
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
  const conversation = document.createElement('div')
  conversation.setAttribute('data-conversation-content', '')
  center.appendChild(conversation)
  frame.appendChild(center)

  const rightbar = document.createElement('div')
  rightbar.setAttribute('data-rightbar-col', 'true')
  frame.appendChild(rightbar)

  document.body.appendChild(frame)
  return { frame, sidebar, center, rightbar, toggle, toggles: () => toggles }
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
    plugin = await activatePlugin()
  })

  afterEach(() => {
    plugin?.dispose()
    document.body.innerHTML = ''
    document.documentElement.removeAttribute('data-dshr-mode')
    document.documentElement.removeAttribute('data-dshr-missing')
    delete window.__ModuleLoader__
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
    // The rail keeps its track, so the content is not pushed to the side.
    const grid = frame.style.getPropertyValue('grid-template-columns')
    expect(grid.startsWith('280px')).toBe(true)
  })

  it('gives the whole width back to the centre column while the drawer is open', async () => {
    const { frame } = buildFrame({ width: 390 })
    await flush()
    const grid = frame.style.getPropertyValue('grid-template-columns')
    expect(grid.startsWith('0px')).toBe(true)
    expect(grid).toContain('minmax(400px, 1fr)')
  })

  it('restores the grid React wrote when the drawer closes', async () => {
    const { frame } = buildFrame({ width: 390 })
    await flush()
    frame.setAttribute('data-sidebar-collapsed', 'true')
    await flush()
    expect(frame.style.getPropertyValue('grid-template-columns')).toBe(
      '280px minmax(400px, 1fr) minmax(0px, 0px)'
    )
  })

  it('restores the grid React rewrote while the drawer was open', async () => {
    const { frame } = buildFrame({ width: 390 })
    await flush()
    // React re-renders the inline grid whenever the layout changes.
    frame.style.setProperty(
      'grid-template-columns',
      '320px minmax(400px, 1fr) minmax(0px, 0px)'
    )
    await flush()
    frame.setAttribute('data-sidebar-collapsed', 'true')
    await flush()
    // The value React wrote last wins, not the one captured when the
    // drawer opened.
    expect(frame.style.getPropertyValue('grid-template-columns')).toBe(
      '320px minmax(400px, 1fr) minmax(0px, 0px)'
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
