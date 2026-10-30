import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const root = new URL('../', import.meta.url)
const pluginClientPath = new URL('packages/dsh-desktop-responsive/client.js', root)
const layoutPath = new URL('node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js', root)
const conversationPath = new URL('node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', root)
const settingsPath = new URL('node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js', root)
const pluginSource = await readFile(pluginClientPath, 'utf8')

// ---------- helpers ----------

function observable(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    set: (next) => { value = next; for (const listener of listeners) listener() }
  }
}

/** Parse the opening tags of static markup into attribute maps. */
function elements(markup) {
  return [...markup.matchAll(/<([a-z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/g)].map(([, tag, attrs]) => ({
    tag,
    attrs: Object.fromEntries([...attrs.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, value ?? '']))
  }))
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Match the `[attr]` / `[attr=value]` selectors the plugin's MARKERS use. */
function matches(element, selector) {
  const match = /^\[([\w-]+)(?:=([\w-]+))?\]$/.exec(selector)
  if (!match) throw new Error(`Unsupported marker selector ${selector}`)
  const [, name, value] = match
  return name in element.attrs && (value === undefined || element.attrs[name] === value)
}

/** Evaluate the plugin's client.js and return its module exports. */
function loadPlugin(context = {}) {
  let definition
  vm.runInNewContext(pluginSource, {
    ...context,
    window: { ...context.window, __ModuleLoader__: { load: (value) => { definition = value } } }
  })
  return definition.factory((id) => {
    if (id === 'react') return React
    throw new Error(`Unexpected module ${id}`)
  })
}

/** Just enough of an Element for the plugin's event-origin and popup checks. */
class FakeElement {
  constructor({ inPopup = false, settingsTab = false, rendered = true } = {}) {
    this.inPopup = inPopup
    this.settingsTab = settingsTab
    this.rendered = rendered
    this.scrollIntoView = vi.fn()
  }

  closest(selector) {
    if (this.inPopup && selector.includes('[role=dialog]')) return this
    if (this.settingsTab && selector === '[data-dsh-region=settings-nav-list] > button') return this
    return null
  }

  getClientRects() {
    return this.rendered ? [{}] : []
  }
}

/** A minimal browser surface for the plugin: attributes, style tags, events and matchMedia. */
function createBrowser({ compact = true, drawerOpen = false } = {}) {
  const attributes = new Map()
  const head = []
  const listeners = { keydown: new Set(), click: new Set() }
  const mediaListeners = new Set()
  // `popups` are mounted popup elements; FakeElement.rendered says whether one is open.
  const state = { compact, drawerOpen, popups: [] }
  const media = {
    get matches() { return state.compact },
    addEventListener: (_type, fn) => mediaListeners.add(fn),
    removeEventListener: (_type, fn) => mediaListeners.delete(fn)
  }
  const document = {
    documentElement: {
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, String(value)),
      removeAttribute: (name) => attributes.delete(name)
    },
    head: { appendChild: (node) => { node.remove = () => head.splice(head.indexOf(node), 1); head.push(node) } },
    getElementById: (id) => head.find(node => node.id === id) ?? null,
    createElement: () => ({ id: '', dataset: {}, textContent: '' }),
    // The drawer probe asks whether the frame is open (not collapsed).
    querySelector: (selector) => {
      if (selector === '[data-dsh-region=frame]:not([data-sidebar-collapsed])') return state.drawerOpen ? {} : null
      throw new Error(`Unexpected query ${selector}`)
    },
    // The popup probe lists every mounted menu/dialog/listbox/modal.
    querySelectorAll: (selector) => {
      if (selector === '[role=menu],[role=dialog],[role=listbox],[aria-modal=true]') return state.popups
      throw new Error(`Unexpected query ${selector}`)
    },
    addEventListener: (type, fn) => listeners[type]?.add(fn),
    removeEventListener: (type, fn) => listeners[type]?.delete(fn)
  }
  const window = { matchMedia: vi.fn(() => media), __ModuleLoader__: {} }
  return {
    document, window, attributes, head, state,
    listenerCount: () => listeners.keydown.size + listeners.click.size,
    mediaListenerCount: () => mediaListeners.size,
    key: (key, { defaultPrevented = false, target = new FakeElement() } = {}) => {
      for (const fn of [...listeners.keydown]) fn({ key, defaultPrevented, target })
    },
    click: (target) => { for (const fn of [...listeners.click]) fn({ target }) },
    resize: (nextCompact) => { state.compact = nextCompact; for (const fn of [...mediaListeners]) fn() }
  }
}

function applyPlugin(browser) {
  const plugin = loadPlugin({ document: browser.document, window: browser.window, Element: FakeElement })
  const disposers = []
  const registrations = []
  const toggleSidebar = vi.fn(() => { browser.state.drawerOpen = !browser.state.drawerOpen })
  const sessionsList = observable({ ids: [], byId: { a: { id: 'a', retainedBy: { mainView: 1 } }, b: { id: 'b', retainedBy: {} } } })
  const panelInfo = observable({ activePanelId: null })
  const ctx = {
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    locale: { register: vi.fn(() => () => undefined), bind: () => (key) => `t:${key}` },
    slots: { inject: (_name, callback) => callback(), register: (options, Component) => registrations.push({ options, Component }) },
    layout: { toggleSidebar, panelInfo },
    sessions: { list: sessionsList }
  }
  plugin.apply(ctx)
  return { plugin, ctx, registrations, toggleSidebar, sessionsList, panelInfo, dispose: () => disposers.splice(0).reverse().forEach(fn => fn()) }
}

/** A tiny defineStore stand-in: the frame only reads the snapshot and calls actions. */
function defineStore({ init, actions }) {
  return {
    create: () => {
      const state = init()
      const bound = Object.fromEntries(Object.entries(actions).map(([name, fn]) => [name, (...args) => fn(state, ...args)]))
      return { getSnapshot: () => state, subscribe: () => () => undefined, actions: bound }
    }
  }
}

async function loadLayoutFrame() {
  let exports
  const document = { documentElement: { dataset: {}, hasAttribute: () => false }, querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild: () => {} } }
  vm.runInNewContext(await readFile(layoutPath, 'utf8'), {
    document,
    AbortController,
    window: { innerWidth: 390, __ModuleLoader__: { load: ({ factory }) => {
      exports = factory((id) => {
        if (id === 'react') return React
        if (id === 'react/jsx-runtime') return jsxRuntime
        if (id === '@deepseek-ai/dsh-client-store') return { defineStore }
        throw new Error(`Unexpected module ${id}`)
      })
    } } }
  })
  let registration
  const ctx = {
    effect: (fn, label) => { if (label === 'ui-layout: service + root registration') fn() },
    locale: { register: () => () => undefined, bind: () => (key) => key },
    slots: { entries: () => [], subscribe: () => () => undefined, provideRoot: () => () => undefined, register: (options, Component) => { registration = { options, Component }; return () => undefined } },
    reflect: { provide: () => () => undefined },
    shortcuts: { register: () => () => undefined },
    theme: { getTheme: () => ({}) },
    on: () => () => undefined
  }
  exports.apply(ctx)
  return registration
}

function renderFrame(registration, layoutInfo) {
  const snapshot = {
    panelInfo: { activePanelId: null },
    layoutInfo: { sidebar: 280, viewportWidth: 390, narrowExpanded: false, rightbar: null, rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false, rightbarInstant: false, ...layoutInfo }
  }
  return renderToStaticMarkup(React.createElement(registration.Component, {
    useStore: (selector) => selector(snapshot),
    useSessions: (selector) => selector({ byId: {} }),
    usePanelInfo: (selector) => selector(snapshot.panelInfo),
    actions: new Proxy({}, { get: () => () => undefined }),
    renderSlot: (name) => React.createElement('i', { 'data-test-slot': name }),
    t: (key) => key
  }))
}

// ---------- upstream marker contract ----------

describe('responsive layout marker contract', () => {
  const plugin = loadPlugin()
  const { MARKERS } = plugin

  it('every frame marker the plugin styles is rendered by the installed ui-layout AppFrame', async () => {
    const registration = await loadLayoutFrame()
    expect(registration.options.children['shell.overlay']).toEqual({ kind: 'list', scope: 'root' })

    // Drawer open on a phone: upstream's narrow mode expands the sidebar track.
    const open = elements(renderFrame(registration, { narrowExpanded: true }))
    const collapsed = elements(renderFrame(registration, { narrowExpanded: false }))
    const find = (list, selector) => list.filter(element => matches(element, selector))

    for (const key of ['frame', 'sidebar', 'center']) {
      expect(find(open, MARKERS[key]), `${key} marker (${MARKERS[key]})`).toHaveLength(1)
      expect(find(collapsed, MARKERS[key]), `${key} marker (${MARKERS[key]})`).toHaveLength(1)
    }
    // The open/closed state lives on the frame element itself.
    const [openFrame] = find(open, MARKERS.frame)
    const [closedFrame] = find(collapsed, MARKERS.frame)
    expect(matches(openFrame, MARKERS.sidebarCollapsed)).toBe(false)
    expect(matches(closedFrame, MARKERS.sidebarCollapsed)).toBe(true)
    // The sidebar drag handle exists only while the sidebar is open, and is
    // what the drawer hides.
    expect(find(open, MARKERS.sidebarHandle)).toHaveLength(1)
    expect(find(collapsed, MARKERS.sidebarHandle)).toHaveLength(0)
    // The overlay layer that hosts the backdrop is still rendered by the frame.
    expect(open.some(element => element.attrs['data-shell-overlay'] !== undefined)).toBe(true)
  })

  it('the centre column stays a direct grid child of the frame so it can be pinned to track 2', async () => {
    const registration = await loadLayoutFrame()
    const markup = renderFrame(registration, { narrowExpanded: true })
    expect(markup).toMatch(/<div[^>]*data-dsh-region="frame"[^>]*><div[^>]*data-dsh-region="sidebar"[^>]*>.*?<\/div><div[^>]*data-dsh-region="center"/)
  })

  // ConversationRoot needs the whole session runtime and SettingsRoot portals
  // through the modal layer, so neither renders statically. These source checks
  // guard the attribute on the element that carries the expected class.
  const sourceMarkers = {
    heroWorkspaceRow: [conversationPath, /className: ConversationRoot_module_css_default\.heroWorkspaceRow,\s+"data-dsh-region": "hero-workspace-row",/],
    settingsPanel: [settingsPath, /"data-shortcut-modal": "settings",\s+className: SettingsRoot_module_css_default\.panel,/],
    settingsNav: [settingsPath, /className: SettingsRoot_module_css_default\.nav,\s+"data-dsh-region": "settings-nav",/],
    settingsNavList: [settingsPath, /className: SettingsRoot_module_css_default\.navList,\s+"data-dsh-region": "settings-nav-list",\s+children: rows\.map\(\(row\) => \(0, react_jsx_runtime\.jsxs\)\("button"/],
    settingsContent: [settingsPath, /className: SettingsRoot_module_css_default\.content,\s+"data-dsh-region": "settings-content",/],
    settingsHeader: [settingsPath, /className: SettingsRoot_module_css_default\.header,\s+"data-dsh-region": "settings-header",/],
    settingsFooter: [settingsPath, /"data-dsh-settings-sidebar-footer": true,/]
  }
  const renderedMarkers = ['frame', 'sidebar', 'center', 'sidebarCollapsed', 'sidebarHandle']

  it.each(Object.entries(sourceMarkers))('the %s marker is present in the installed bundle', async (key, [path, pattern]) => {
    expect(MARKERS[key]).toBeDefined()
    expect(await readFile(path, 'utf8'), `${key} marker (${MARKERS[key]})`).toMatch(pattern)
  })

  it('every marker the plugin declares is covered by a render or source check', () => {
    expect(Object.keys(MARKERS).sort()).toEqual([...renderedMarkers, ...Object.keys(sourceMarkers)].sort())
  })
})

// ---------- plugin behaviour ----------

describe('dsh-desktop-responsive client', () => {
  it('marks the viewport from the compact media query and follows changes', () => {
    const browser = createBrowser({ compact: false })
    const { dispose } = applyPlugin(browser)
    expect(browser.window.matchMedia).toHaveBeenCalledWith('(max-width: 640px)')
    expect(browser.attributes.get('data-dsh-viewport')).toBe('regular')
    browser.resize(true)
    expect(browser.attributes.get('data-dsh-viewport')).toBe('compact')
    dispose()
    expect(browser.attributes.has('data-dsh-viewport')).toBe(false)
    expect(browser.mediaListenerCount()).toBe(0)
  })

  it('injects one scoped style tag and removes it on dispose', () => {
    const browser = createBrowser()
    const first = applyPlugin(browser)
    applyPlugin(browser)
    expect(browser.head).toHaveLength(1)
    const [style] = browser.head
    expect(style.id).toBe('dsh-desktop-responsive-style')
    expect(style.dataset.pluginCss).toBe('dsh-desktop-responsive')
    // Every rule is gated on the compact viewport or the plugin's own backdrop,
    // so the regular desktop layout is untouched.
    const selectors = style.textContent.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g).map(s => s.trim())
    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) {
      expect(selector.startsWith('html[data-dsh-viewport=compact]') || selector === '[data-dsh-responsive-backdrop]', selector).toBe(true)
    }
    expect(style.textContent).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    // Load-bearing declarations: each one breaks the phone layout if lost.
    const css = style.textContent.replace(/\s+/g, ' ')
    const drawer = 'html[data-dsh-viewport=compact] [data-dsh-region=frame]:not([data-sidebar-collapsed])'
    expect(css).toContain(`${drawer} { grid-template-columns:0 minmax(0,1fr) 0 !important; }`)
    expect(css).toContain(`${drawer} > [data-dsh-region=center] { grid-column:2; }`)
    expect(css).toMatch(new RegExp(`${escape(drawer)} > \\[data-dsh-region=sidebar\\] \\{ position:absolute; z-index:30;`))
    expect(css).toContain(`${drawer} > [data-side=sidebar] { display:none; }`)
    expect(css).toContain(`${drawer} [data-dsh-responsive-backdrop] { display:block; }`)
    expect(css).toMatch(/\[data-shortcut-modal=settings\] \{ flex-direction:column; width:100% !important; max-width:none !important;/)
    expect(css).toContain('[data-dsh-region=settings-nav-list] { flex-direction:row;')
    first.dispose()
    expect(browser.head).toHaveLength(0)
  })

  it('registers a localized backdrop in the additive shell.overlay list that closes the open drawer', () => {
    const browser = createBrowser({ drawerOpen: true })
    const { registrations, toggleSidebar, ctx } = applyPlugin(browser)
    expect(ctx.locale.register).toHaveBeenCalledWith('desktop-responsive', expect.objectContaining({
      zh: { closeSidebar: '关闭侧栏' }, en: { closeSidebar: 'Close sidebar' }
    }))
    const backdrop = registrations.find(item => item.options.name === 'shell.overlay')
    expect(backdrop.options.id).toBe('desktop-responsive-backdrop')
    const props = backdrop.options.inject()
    const markup = renderToStaticMarkup(React.createElement(backdrop.Component, props))
    expect(markup).toBe('<button type="button" tabindex="-1" aria-label="t:closeSidebar" data-dsh-responsive-backdrop=""></button>')
    props.close()
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
    props.close()
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
  })

  it('closes the drawer on Escape only while it is open in the compact layout', () => {
    const browser = createBrowser({ drawerOpen: true })
    const { toggleSidebar, dispose } = applyPlugin(browser)
    browser.key('Enter')
    browser.key('Escape', { defaultPrevented: true })
    expect(toggleSidebar).not.toHaveBeenCalled()
    // A rendered menu or dialog opened from the drawer takes Esc first ...
    browser.state.popups = [new FakeElement({ rendered: true })]
    browser.key('Escape')
    expect(toggleSidebar).not.toHaveBeenCalled()
    // ... and so does one that holds the key event's origin.
    browser.state.popups = []
    browser.key('Escape', { target: new FakeElement({ inPopup: true }) })
    expect(toggleSidebar).not.toHaveBeenCalled()
    // Popups that stay mounted while closed (a <dialog> without `open`) must
    // not disable Esc for the drawer.
    browser.state.popups = [new FakeElement({ rendered: false })]
    browser.key('Escape')
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
    browser.key('Escape')
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
    // A regular-width window keeps upstream behaviour: the sidebar is a column.
    browser.state.drawerOpen = true
    browser.resize(false)
    browser.key('Escape')
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
    dispose()
    expect(browser.listenerCount()).toBe(0)
  })

  it('scrolls a picked settings tab into view only in the compact layout', () => {
    const browser = createBrowser({ compact: false })
    applyPlugin(browser)
    const tab = new FakeElement({ settingsTab: true })
    browser.click(tab)
    expect(tab.scrollIntoView).not.toHaveBeenCalled()
    browser.resize(true)
    browser.click(new FakeElement())
    browser.click(tab)
    expect(tab.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest', inline: 'nearest' })
  })

  it('closes the drawer after navigating to another Session or main panel', () => {
    const browser = createBrowser({ drawerOpen: true })
    const { toggleSidebar, sessionsList, panelInfo } = applyPlugin(browser)
    const rows = sessionsList.getSnapshot().byId
    // List updates that keep the same main-view Session are not navigation.
    sessionsList.set({ ids: [], byId: { ...rows, c: { id: 'c', retainedBy: {} } } })
    expect(toggleSidebar).not.toHaveBeenCalled()
    sessionsList.set({ ids: [], byId: { a: { id: 'a', retainedBy: {} }, b: { id: 'b', retainedBy: { mainView: 1 } } } })
    expect(toggleSidebar).toHaveBeenCalledTimes(1)

    browser.state.drawerOpen = true
    panelInfo.set({ activePanelId: 'plugins' })
    expect(toggleSidebar).toHaveBeenCalledTimes(2)
    // A closed drawer is left alone.
    panelInfo.set({ activePanelId: null })
    expect(toggleSidebar).toHaveBeenCalledTimes(2)
  })
})

// ---------- composition ----------

describe('dsh-desktop-responsive composition', () => {
  it('is mounted by the desktop profile patch yml', async () => {
    const patch = (await readFile(new URL('build/dsh-desktop.patch.yml', root), 'utf8')).replaceAll('\r\n', '\n')
    expect(patch).toMatch(/- id: dsh-desktop-responsive\n      name: dsh-desktop-responsive/u)
  })

  it('is a root file dependency reachable from the @deepseek-ai/dsh closure', async () => {
    const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
    expect(manifest.dependencies['dsh-desktop-responsive']).toBe('file:packages/dsh-desktop-responsive')
    const dshPatch = await readFile(new URL('patches/@deepseek-ai+dsh+0.2.1-rc.3.patch', root), 'utf8')
    expect(dshPatch).toContain('+    "dsh-desktop-responsive": "0.1.0",')
  })

  it('declares a client provider for every service it injects', async () => {
    const pkg = JSON.parse(await readFile(new URL('packages/dsh-desktop-responsive/package.json', root), 'utf8'))
    const plugin = loadPlugin()
    const providers = {
      locale: '@deepseek-ai/dsh-client-locale',
      slots: '@deepseek-ai/dsh-client-ui-renderer',
      layout: '@deepseek-ai/dsh-client-ui-layout',
      sessions: '@deepseek-ai/dsh-api-session-controller'
    }
    expect(plugin.inject).toEqual(Object.keys(providers))
    for (const provider of Object.values(providers)) expect(pkg.dsh.client.inject).toContain(provider)
    expect(pkg.dsh.client.platform).toBe('web')
  })
})
