window.__ModuleLoader__.load({
  id: 'dsh-desktop-responsive',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const NS = 'desktop-responsive'
    const STYLE_ID = 'dsh-desktop-responsive-style'

    // Viewports at or below this width get the compact layout. Upstream's own
    // narrow mode (< 1024px) only collapses the sidebar to a rail; opening it
    // still squeezes the centre column, which leaves ~100px of content on a phone.
    const COMPACT_QUERY = '(max-width: 640px)'
    const VIEWPORT_ATTR = 'data-dsh-viewport'

    // Every upstream DOM hook this plugin depends on. data-dsh-region comes
    // from the local marker patches on dsh-client-ui-layout,
    // dsh-client-ui-conversation and dsh-client-ui-settings-general;
    // data-sidebar-collapsed, data-side and data-shortcut-modal are upstream
    // attributes, data-dsh-settings-sidebar-footer an existing desktop patch
    // seam. test/responsive-layout.test.mjs asserts each one still exists in
    // the installed bundles, so an upstream upgrade that drops a hook fails
    // there instead of silently breaking the phone layout.
    const MARKERS = Object.freeze({
      frame: '[data-dsh-region=frame]',
      sidebar: '[data-dsh-region=sidebar]',
      center: '[data-dsh-region=center]',
      heroWorkspaceRow: '[data-dsh-region=hero-workspace-row]',
      sidebarCollapsed: '[data-sidebar-collapsed]',
      sidebarHandle: '[data-side=sidebar]',
      settingsPanel: '[data-shortcut-modal=settings]',
      settingsNav: '[data-dsh-region=settings-nav]',
      settingsNavList: '[data-dsh-region=settings-nav-list]',
      settingsContent: '[data-dsh-region=settings-content]',
      settingsHeader: '[data-dsh-region=settings-header]',
      settingsFooter: '[data-dsh-settings-sidebar-footer]'
    })

    const POPUP_SELECTOR = '[role=menu],[role=dialog],[role=listbox],[aria-modal=true]'

    const compact = `html[${VIEWPORT_ATTR}=compact]`
    const drawerOpen = `${compact} ${MARKERS.frame}:not(${MARKERS.sidebarCollapsed})`

    function buildStyle() {
      return `
        /* The open sidebar floats over the conversation instead of taking a
           grid track. The inline grid template is upstream's, hence !important. */
        ${drawerOpen} { grid-template-columns:0 minmax(0,1fr) 0 !important; }
        /* The positioned sidebar leaves auto-placement, so pin the centre to its
           track; otherwise it slides into the zero-width first column. */
        ${drawerOpen} > ${MARKERS.center} { grid-column:2; }
        ${drawerOpen} > ${MARKERS.sidebar} {
          position:absolute; z-index:30; left:0; bottom:0; top:var(--dsh-frame-chrome-top,0px);
          width:280px; max-width:calc(100% - 48px);
        }
        ${drawerOpen} > ${MARKERS.sidebarHandle} { display:none; }
        [data-dsh-responsive-backdrop] {
          display:none; position:absolute; inset:var(--dsh-frame-chrome-top,0px) 0 0;
          padding:0; border:0; background:var(--dsw-alias-bg-mask-1); cursor:default;
        }
        ${drawerOpen} [data-dsh-responsive-backdrop] { display:block; }
        ${compact} ${MARKERS.heroWorkspaceRow} { flex-wrap:wrap; row-gap:4px; }

        /* Settings: the 188px side navigation leaves ~120px for the sections on
           a phone. Fill the screen below the window chrome, stack the navigation
           as a scrollable tab strip, and float the close/actions row beside the
           title. The panel's fixed size is upstream's, hence !important. */
        ${compact} ${MARKERS.settingsPanel} {
          flex-direction:column; width:100% !important; max-width:none !important;
          height:calc(100% - var(--dsh-frame-chrome-top,0px)) !important;
          align-self:flex-end; border-radius:0;
        }
        ${compact} ${MARKERS.settingsNav} {
          width:auto; gap:8px; padding:14px 16px 0;
        }
        ${compact} ${MARKERS.settingsNavList} {
          flex-direction:row; flex:none; gap:4px; overflow-x:auto; overflow-y:hidden;
          scrollbar-width:none; margin:0 -16px; padding:0 16px 8px;
          border-bottom:.5px solid var(--dsw-alias-border-l3);
        }
        ${compact} ${MARKERS.settingsNavList} > button { flex:none; height:34px; padding:0 12px; }
        ${compact} ${MARKERS.settingsFooter} { display:none; }
        ${compact} ${MARKERS.settingsContent} { flex:1; min-height:0; }
        ${compact} ${MARKERS.settingsHeader} {
          position:absolute; top:12px; right:12px; height:auto; padding:0;
          align-items:center;
        }
        ${compact} ${MARKERS.settingsHeader} button { white-space:nowrap; }
      `
    }

    function DrawerBackdrop({ close, t }) {
      // Pointer-only dismissal; keyboard users close with Esc (see apply).
      return h('button', {
        type: 'button',
        tabIndex: -1,
        'aria-label': t('closeSidebar'),
        'data-dsh-responsive-backdrop': '',
        onClick: close
      })
    }

    // Popups may stay mounted while closed (a native <dialog> without `open`,
    // a hidden menu), so only a rendered one, or one holding the event's
    // origin, counts as open.
    function hasOpenPopup(origin) {
      if (origin && typeof origin.closest === 'function' && origin.closest(POPUP_SELECTOR) !== null) return true
      for (const popup of document.querySelectorAll(POPUP_SELECTOR)) {
        if (popup.getClientRects().length > 0) return true
      }
      return false
    }

    function isDrawerOpen() {
      return document.documentElement.getAttribute(VIEWPORT_ATTR) === 'compact' &&
        document.querySelector(`${MARKERS.frame}:not(${MARKERS.sidebarCollapsed})`) !== null
    }

    // The Session shown in the main view, read the same way ui-layout's
    // DocumentTitle does: from the public retainedBy.mainView count.
    function mainViewSessionId(listState) {
      const rows = listState && listState.byId ? Object.values(listState.byId) : []
      const row = rows.find(session => (session?.retainedBy?.mainView ?? 0) > 0)
      return row ? row.id : null
    }

    // Fire `onChange` whenever `select(source.getSnapshot())` changes value.
    function watch(source, select, onChange) {
      let previous = select(source.getSnapshot())
      return source.subscribe(() => {
        const next = select(source.getSnapshot())
        if (next === previous) return
        previous = next
        onChange()
      })
    }

    const inject = ['locale', 'slots', 'layout', 'sessions']
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, {
        zh: { closeSidebar: '关闭侧栏' },
        en: { closeSidebar: 'Close sidebar' }
      }))
      const t = ctx.locale.bind(NS)
      const closeDrawer = () => { if (isDrawerOpen()) ctx.layout.toggleSidebar() }

      ctx.effect(() => {
        if (document.getElementById(STYLE_ID)) return
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.dataset.pluginCss = 'dsh-desktop-responsive'
        style.textContent = buildStyle()
        document.head.appendChild(style)
        return () => style.remove()
      })

      ctx.effect(() => {
        const root = document.documentElement
        const query = window.matchMedia(COMPACT_QUERY)
        const sync = () => root.setAttribute(VIEWPORT_ATTR, query.matches ? 'compact' : 'regular')
        sync()
        query.addEventListener('change', sync)
        return () => {
          query.removeEventListener('change', sync)
          root.removeAttribute(VIEWPORT_ATTR)
        }
      })

      ctx.effect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented || !isDrawerOpen()) return
          // An open popup (session menu, picker, dialog) owns Esc even when it
          // does not mark the event handled; close only the innermost layer.
          if (hasOpenPopup(event.target)) return
          closeDrawer()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      })

      // The settings tab strip scrolls horizontally; keep the picked tab whole.
      ctx.effect(() => {
        const onClick = (event) => {
          if (document.documentElement.getAttribute(VIEWPORT_ATTR) !== 'compact') return
          const tab = event.target instanceof Element ? event.target.closest(`${MARKERS.settingsNavList} > button`) : null
          if (tab) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
        document.addEventListener('click', onClick)
        return () => document.removeEventListener('click', onClick)
      })

      // Picking a Session or a main panel from the drawer is navigation: return
      // to the content, as a phone navigation drawer does. Upstream's narrow
      // mode leaves the sidebar open because it does not cover the content.
      ctx.effect(() => watch(ctx.sessions.list, mainViewSessionId, closeDrawer))
      ctx.effect(() => watch(ctx.layout.panelInfo, info => info?.activePanelId ?? null, closeDrawer))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'desktop-responsive-backdrop',
        locale: NS,
        inject: () => ({ t, close: closeDrawer })
      }, DrawerBackdrop))
    }

    exports.apply = apply
    exports.inject = inject
    exports.MARKERS = MARKERS
    exports.COMPACT_QUERY = COMPACT_QUERY
    return module.exports
  }
})
