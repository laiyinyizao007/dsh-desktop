/**
 * `dsh-desktop-responsive` — phone-width layout for the Harness web UI.
 *
 * ## What it changes
 *
 * Above 640 px the upstream frame is a three-column CSS grid and everything
 * fits. At or below 640 px three upstream rules break the layout:
 *
 * - The expanded sidebar keeps a 264-420 px column, so the centre column is
 *   left with about 110 px on a 390 px phone. Every label breaks one word
 *   per line and every control near the right edge falls outside the
 *   viewport — and the page does not scroll sideways, so the user gets no
 *   hint that anything is off-screen.
 * - The settings dialog is a two-column panel. At phone width the body gets
 *   about 200 px, so descriptions break one word per line and the value
 *   controls sit past the right edge of the window.
 * - The conversation body sizes its content with
 *   `clamp(680px, …, 920px)`. The clamp has a hard 680 px floor, so the
 *   composer renders 680 px wide inside a 360 px viewport.
 *
 * This plugin turns the expanded sidebar into an overlay drawer, turns the
 * settings dialog into a full-screen tab page, and lets the conversation
 * content and the home composer follow the viewport.
 *
 * ## How it finds the DOM
 *
 * Upstream's CSS module class names are hashed (`pI_x6G_frame`) and the hash
 * changes on every upstream build, so a plugin that selects on them breaks
 * silently. This plugin therefore binds only to the anchors listed in
 * `ANCHORS`, and every anchor is one of two kinds:
 *
 *   - `marker` — a `data-dsh-region` attribute this repository adds to
 *     upstream through a minimal patch. The patch only adds an attribute;
 *     it never restructures upstream's render tree.
 *   - `attribute` — a stable data attribute upstream already ships
 *     (`data-conversation-content`, `data-width-handle`, …).
 *
 * `ANCHORS` is the whole upstream contract. `test/responsive-layout.test.mjs`
 * fails when an anchor disappears from its package, when a patch stops
 * carrying its marker, or when the plugin selects on anything that is not in
 * the manifest. That is what keeps an upstream upgrade cheap: the cost of a
 * new Harness release is one manifest entry per changed surface, not a hunt
 * through renamed class names.
 *
 * ## How the breakpoint is decided
 *
 * The layout adapts to the *frame's* width, not the window's. The desktop
 * shell and the embedded web view can both put the frame in a pane narrower
 * than the window, and a media query on the window would miss that. The
 * decision is written to `data-dshr-mode` on the document root, so the CSS
 * has one switch and the tests have one thing to assert.
 *
 * The settings dialog is the exception: it is portalled into the body and
 * covers the viewport, so it follows the window and carries its own
 * `data-dshr-mode`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-desktop-responsive',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** The width at or below which the UI switches to the phone layout. */
    const PHONE_MAX = 640

    /**
     * How long the plugin waits for the upstream frame before it treats a
     * missing marker as a broken marker rather than a slow start.
     */
    const BOOT_GRACE_MS = 4000

    /** Idempotency guard for the injected stylesheet. */
    const STYLE_KEY = 'dsh-desktop-responsive'

    /** Plugin-owned attributes. Namespaced so they cannot collide with upstream. */
    const ROOT_MODE_ATTR = 'data-dshr-mode'
    const DRAWER_ATTR = 'data-dshr-drawer'
    const SCRIM_ATTR = 'data-dshr-scrim'
    const MISSING_ATTR = 'data-dshr-missing'

    /**
     * The upstream contract.
     *
     * `required` anchors must always be present; the plugin reports them
     * when they are not. `surface` anchors are checked when their surface is
     * on screen — the settings dialog only exists while it is open, so its
     * anchors cannot be required.
     *
     * Every entry names the upstream package that provides it, which is what
     * lets the test check the anchors against the installed sources.
     */
    const ANCHORS = {
      frame: {
        selector: '[data-dsh-region="layout"]',
        origin: 'marker',
        package: '@deepseek-ai/dsh-client-ui-layout',
        required: true,
      },
      sidebar: {
        selector: '[data-dsh-region="sidebar"]',
        origin: 'marker',
        package: '@deepseek-ai/dsh-client-ui-layout',
        required: true,
      },
      center: {
        selector: '[data-dsh-region="center"]',
        origin: 'marker',
        package: '@deepseek-ai/dsh-client-ui-layout',
        required: true,
      },
      rightbarColumn: {
        selector: '[data-rightbar-col]',
        origin: 'attribute',
        package: '@deepseek-ai/dsh-client-ui-layout',
      },
      sidebarResizeHandle: {
        selector: '[data-side="sidebar"]',
        origin: 'attribute',
        package: '@deepseek-ai/dsh-client-ui-layout',
      },
      sidebarToggle: {
        selector: '[data-dsh-region="sidebar-toggle"]',
        origin: 'marker',
        package: '@deepseek-ai/dsh-client-ui-sidebar',
        surface: 'frame',
      },
      conversationContent: {
        selector: '[data-conversation-content]',
        origin: 'attribute',
        package: '@deepseek-ai/dsh-client-ui-conversation',
      },
      conversationWidthHandle: {
        selector: '[data-width-handle]',
        origin: 'attribute',
        package: '@deepseek-ai/dsh-client-ui-conversation',
      },
      workspaceRow: {
        selector: '[data-dsh-region="conversation-workspace-row"]',
        origin: 'marker',
        package: '@deepseek-ai/dsh-client-ui-conversation',
      },
      settingsOverlay: {
        selector: '[data-dsh-region="settings-overlay"]',
        origin: 'marker',
        package: '@deepseek-ai/dsh-client-ui-settings-general',
        surface: 'settings',
      },
      settingsNav: {
        selector: '[data-dsh-region="settings-nav"]',
        origin: 'marker',
        package: '@deepseek-ai/dsh-client-ui-settings-general',
        surface: 'settings',
      },
      settingsNavList: {
        selector: '[data-dsh-region="settings-nav-list"]',
        origin: 'marker',
        package: '@deepseek-ai/dsh-client-ui-settings-general',
        surface: 'settings',
      },
      settingsNavTitle: {
        selector: '[data-dsh-region="settings-nav-title"]',
        origin: 'marker',
        package: '@deepseek-ai/dsh-client-ui-settings-general',
        surface: 'settings',
      },
      settingsContent: {
        selector: '[data-dsh-region="settings-content"]',
        origin: 'marker',
        package: '@deepseek-ai/dsh-client-ui-settings-general',
        surface: 'settings',
      },
      settingsOptions: {
        selector: '[data-dsh-region="settings-options"]',
        origin: 'marker',
        package: '@deepseek-ai/dsh-client-ui-settings-general',
        surface: 'settings',
      },
      settingsFooter: {
        selector: '[data-dsh-settings-sidebar-footer]',
        origin: 'attribute',
        package: '@deepseek-ai/dsh-client-ui-settings-general',
        surface: 'settings',
      },
    }

    /** Selector shorthands, so the stylesheet and the script cannot drift. */
    const A = {}
    for (const [key, anchor] of Object.entries(ANCHORS)) A[key] = anchor.selector

    const CSS = `
/* ───────────────────────────────────────────────────────────────────────────
   Phone layout.

   The switch is \`data-dshr-mode="phone"\`, written by the plugin on the
   document root for the frame and on the settings overlay for the dialog.
   ─────────────────────────────────────────────────────────────────────────── */

/* ── Sidebar drawer ────────────────────────────────────────────────────────
   The expanded sidebar floats over the content instead of displacing it.
   Only the expanded sidebar becomes a drawer: the collapsed rail stays in
   the grid — it is 56 px wide and carries the navigation icons, so it is
   useful on a phone and does not need to float.

   The grid's first track is zeroed by the script; CSS cannot do it, because
   the track list is an inline style React owns. */
:root[data-dshr-mode='phone'] ${A.frame}[data-dshr-drawer='open'] > ${A.sidebar} {
  position: fixed !important;
  inset: 0 auto 0 0 !important;
  width: min(300px, 84vw) !important;
  max-width: 84vw !important;
  z-index: 40 !important;
  overscroll-behavior: contain !important;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28) !important;
}

/* The scrim behind the drawer. It is a real element, not a pseudo-element,
   so it can take the click that dismisses the drawer. */
${SCRIM_ATTR} {
  position: fixed !important;
  inset: 0 !important;
  z-index: 39 !important;
  background: rgba(0, 0, 0, 0.42) !important;
  opacity: 0 !important;
  pointer-events: none !important;
  transition: opacity 200ms ease !important;
}

${SCRIM_ATTR}[data-dshr-scrim-open='true'] {
  opacity: 1 !important;
  pointer-events: auto !important;
}

/* ── Column placement ──────────────────────────────────────────────────────
   The sidebar leaves the grid flow while the drawer is open, so the columns
   that follow it shift one track to the left: the centre column would land
   in the 56 px sidebar track and the conversation would render inside it.
   Pinning the columns keeps each one where it belongs.

   \`grid-area\` is not used because the columns are siblings of other grid
   children (the bottom row spans all columns). */
:root[data-dshr-mode='phone'] ${A.frame} > ${A.center} {
  grid-column: 2 !important;
}

:root[data-dshr-mode='phone'] ${A.frame} > ${A.rightbarColumn} {
  grid-column: 3 !important;
}

/* The resize handle has no meaning for a drawer. */
:root[data-dshr-mode='phone'] ${A.frame} ${A.sidebarResizeHandle} {
  display: none !important;
}

/* ── Conversation content width ────────────────────────────────────────────
   The conversation body declares
     --dsh-chat-content-width: var(--dsh-chat-user-width,
       clamp(680px, calc(var(--dsh-conversation-column-width, 0px) * .64), 920px))
   and the clamp has a hard 680 px floor. On a phone the column is ~360 px, so
   the middle term is ~230 px and the floor wins: the content stays 680 px
   wide and runs off the right edge.

   The declaration has to be overridden on the element that declares it — a
   value set on an ancestor is only inherited, and the body declares its own.
   Overriding the content width also lets the composer card follow, because
   upstream derives it from the content width. */
:root[data-dshr-mode='phone'] ${A.conversationContent} {
  --dsh-chat-content-width: min(calc(100% - 32px), 920px) !important;
}

/* The width handles drag a content width that has no meaning on a phone. */
:root[data-dshr-mode='phone'] ${A.conversationWidthHandle} {
  display: none !important;
}

/* ── Home workspace row ────────────────────────────────────────────────────
   The workspace chip and the mode picker share one non-wrapping row. At
   phone width the chip's own label is truncated and the row keeps a wide
   gutter, so the composer loses the space it needs. The row wraps instead. */
:root[data-dshr-mode='phone'] ${A.workspaceRow} {
  flex-wrap: wrap !important;
  row-gap: 4px !important;
}

/* ── Settings dialog ───────────────────────────────────────────────────────
   The dialog is a two-column panel: a section list on the left, the body on
   the right. Below the phone breakpoint it goes full-screen and the section
   list becomes a horizontal, scrollable tab strip along the top, so the body
   takes the whole width and every control stays reachable. */
${A.settingsOverlay}[data-dshr-mode='phone'] {
  padding: 0 !important;
}

${A.settingsOverlay}[data-dshr-mode='phone'] > [role='dialog'] {
  width: 100vw !important;
  max-width: 100vw !important;
  height: 100vh !important;
  height: 100dvh !important;
  max-height: 100dvh !important;
  border-radius: 0 !important;
  flex-direction: column !important;
}

/* The section list turns into a tab strip along the top. */
${A.settingsOverlay}[data-dshr-mode='phone'] ${A.settingsNav} {
  flex: 0 0 auto !important;
  width: 100% !important;
  max-width: 100% !important;
  flex-direction: row !important;
  align-items: center !important;
  gap: 8px !important;
  padding: 8px 12px !important;
  overflow: hidden !important;
  border-right: none !important;
  border-bottom: 0.5px solid var(--dsw-alias-border-l3) !important;
}

/* The list itself scrolls sideways; the title and the footer slot keep
   their place beside it. Nothing is hidden — a slot that another plugin
   contributes to must stay reachable on a phone. */
${A.settingsOverlay}[data-dshr-mode='phone'] ${A.settingsNavList} {
  flex: 0 1 auto !important;
  min-width: 0 !important;
  flex-direction: row !important;
  align-items: center !important;
  gap: 4px !important;
  padding: 0 !important;
  overflow-x: auto !important;
  overflow-y: hidden !important;
  -webkit-overflow-scrolling: touch !important;
  scrollbar-width: none !important;
}

${A.settingsOverlay}[data-dshr-mode='phone'] ${A.settingsNavList}::-webkit-scrollbar {
  display: none !important;
}

${A.settingsOverlay}[data-dshr-mode='phone'] ${A.settingsNavList} > * {
  flex: none !important;
}

/* The title keeps its own width and stays on one line: in a row it would
   otherwise be squeezed into a two-character column. */
${A.settingsOverlay}[data-dshr-mode='phone'] ${A.settingsNavTitle} {
  flex: 0 0 auto !important;
  white-space: nowrap !important;
}

${A.settingsOverlay}[data-dshr-mode='phone'] ${A.settingsFooter} {
  flex: 0 0 auto !important;
  margin-left: auto !important;
  margin-top: 0 !important;
}

/* The body takes the rest of the screen. */
${A.settingsOverlay}[data-dshr-mode='phone'] ${A.settingsContent} {
  width: 100% !important;
  max-width: 100% !important;
  flex: 1 1 auto !important;
  min-height: 0 !important;
}

/* The header keeps the section actions and the close button on one compact
   row. It stays in the flow: floating it over the body would put the
   section actions on top of the content. */
${A.settingsOverlay}[data-dshr-mode='phone'] ${A.settingsContent} > *:first-child {
  flex: none !important;
  height: auto !important;
  min-height: 40px !important;
  padding: 8px 12px !important;
  align-items: center !important;
}

${A.settingsOverlay}[data-dshr-mode='phone'] ${A.settingsOptions} {
  padding: 0 16px 24px !important;
}

@media (prefers-reduced-motion: reduce) {
  ${SCRIM_ATTR} {
    transition: none !important;
  }
}
`

    /**
     * Install the plugin.
     *
     * @returns {() => void} A disposer that removes everything the plugin added.
     */
    function install() {
      if (document.querySelector(`style[data-plugin-css="${STYLE_KEY}"]`)) {
        return () => {}
      }
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', STYLE_KEY)
      style.textContent = CSS
      document.head.appendChild(style)

      const state = {
        /** Whether the expanded sidebar is currently a drawer. */
        drawerOpen: false,
        /** The track list React last wrote, kept so it can be restored. */
        lastReactGrid: null,
        /** The track list this plugin wrote, so React's value is recognised. */
        writtenGrid: null,
        /** The element that had focus before the drawer opened. */
        focusBeforeDrawer: null,
        /** The scrim element, created on demand. */
        scrim: null,
        /** Whether the frame has been seen at least once. */
        seenFrame: false,
        /** Whether the boot grace period is over. */
        bootExpired: false,
        /** The anchors reported last, so the same report is not repeated. */
        reportedMissing: '',
      }

      /** The frame that owns the grid. */
      function frame() {
        return document.querySelector(A.frame)
      }

      /** Whether the upstream sidebar is expanded. */
      function sidebarExpanded(el) {
        return el.getAttribute('data-sidebar-collapsed') === null
      }

      /**
       * The width the layout adapts to.
       *
       * The frame's own width is the reference, not the window's: the
       * desktop shell and the embedded web view can both put the frame in a
       * pane narrower than the window. Before the frame exists the window is
       * the best estimate, and it keeps the first paint correct.
       */
      function layoutWidth() {
        const el = frame()
        if (el) {
          const width = el.getBoundingClientRect().width
          if (width > 0) return width
        }
        return window.innerWidth
      }

      /** The current layout mode. */
      function mode() {
        return layoutWidth() <= PHONE_MAX ? 'phone' : 'wide'
      }

      /**
       * Name the anchors upstream no longer provides.
       *
       * A missing anchor means upstream changed a surface this plugin
       * adapts. Staying quiet would make that look like a styling bug, so
       * the missing names are logged and published on the root element.
       */
      function auditAnchors() {
        const missing = []
        for (const [key, anchor] of Object.entries(ANCHORS)) {
          if (anchor.required) {
            if (document.querySelector(anchor.selector) !== null) continue
            // The frame renders after this plugin loads, so an anchor that
            // is not there yet proves nothing. It only means something once
            // the frame has been seen — or once the boot grace period is
            // over, which is when a frame that never arrives is a broken
            // marker rather than a slow start.
            if (!state.seenFrame && !state.bootExpired) continue
            missing.push(key)
            continue
          }
          if (anchor.surface !== 'settings') continue
          // The settings anchors only exist while the dialog is open.
          if (document.querySelector(A.settingsOverlay) === null) continue
          if (document.querySelector(anchor.selector) === null) missing.push(key)
        }
        const report = missing.join(',')
        if (report === state.reportedMissing) return missing
        state.reportedMissing = report
        if (missing.length > 0) {
          console.error(
            `[${STYLE_KEY}] upstream anchors missing: ${report}. ` +
              'The phone layout is partly inactive. Check the data-dsh-region patches.'
          )
          document.documentElement.setAttribute(MISSING_ATTR, report)
        } else {
          document.documentElement.removeAttribute(MISSING_ATTR)
        }
        return missing
      }

      /**
       * Give the whole width back to the centre column.
       *
       * The track list is an inline style React owns, so a stylesheet cannot
       * change it — even `!important` loses to an inline declaration. The
       * script rewrites the first track and restores React's own value
       * afterwards.
       *
       * React re-renders the inline style whenever the layout changes, so
       * the last value React wrote is remembered and restored rather than a
       * value captured once: restoring a stale track list would undo a
       * resize the user made after the drawer opened.
       */
      function syncGrid(el) {
        const current = el.style.getPropertyValue('grid-template-columns')
        if (!current) return
        // Anything that is not the value this plugin wrote came from React.
        if (current !== state.writtenGrid) state.lastReactGrid = current

        if (!state.drawerOpen) {
          if (state.writtenGrid !== null) {
            const restored = state.lastReactGrid ?? current
            if (restored !== current) el.style.setProperty('grid-template-columns', restored)
          }
          state.writtenGrid = null
          return
        }

        // Only the first track is replaced; the rest keep their own spacing.
        const collapsed = current.replace(/^\s*\S+/, '0px')
        if (collapsed !== current) el.style.setProperty('grid-template-columns', collapsed)
        state.writtenGrid = collapsed
      }

      /** The scrim behind the drawer. */
      function ensureScrim() {
        if (state.scrim && state.scrim.isConnected) return state.scrim
        const scrim = document.createElement('div')
        scrim.setAttribute(SCRIM_ATTR, '')
        scrim.setAttribute('aria-hidden', 'true')
        scrim.addEventListener('click', () => closeDrawer())
        document.body.appendChild(scrim)
        state.scrim = scrim
        return scrim
      }

      /**
       * Close the drawer.
       *
       * The drawer is the upstream sidebar, so closing it means telling
       * upstream to collapse the sidebar again. The plugin clicks the
       * upstream toggle rather than reaching into its state: the toggle is
       * the control the user would use, and it keeps the plugin out of
       * upstream's store.
       */
      function closeDrawer() {
        const toggle = document.querySelector(A.sidebarToggle)
        if (toggle === null) {
          console.error(
            `[${STYLE_KEY}] cannot close the drawer: the sidebar toggle anchor is missing.`
          )
          return
        }
        toggle.click()
      }

      /**
       * Keep the drawer, the scrim and the frame's grid in step with the
       * upstream sidebar state.
       */
      function syncDrawer(el, currentMode) {
        const open = currentMode === 'phone' && sidebarExpanded(el)
        // The attribute is written on every pass, not only on a change: the
        // collapsed state starts out as `drawerOpen: false`, so an early
        // return on "no change" would leave the attribute unset and the
        // stylesheet without the state it keys off.
        el.setAttribute(DRAWER_ATTR, open ? 'open' : 'closed')
        if (open === state.drawerOpen) return
        state.drawerOpen = open

        if (open) {
          state.focusBeforeDrawer = document.activeElement
          const scrim = ensureScrim()
          scrim.setAttribute('data-dshr-scrim-open', 'true')
          // The content behind the drawer must not be reachable while it is
          // open: the scrim covers it visually, and \`inert\` keeps the
          // keyboard and the screen reader out of it too.
          for (const anchor of [A.center, A.rightbarColumn]) {
            const el = document.querySelector(anchor)
            if (el !== null) el.setAttribute('inert', '')
          }
          const toggle = document.querySelector(A.sidebarToggle)
          if (toggle instanceof HTMLElement && document.activeElement !== toggle) {
            toggle.focus({ preventScroll: true })
          }
          return
        }

        const scrim = state.scrim
        if (scrim !== null) {
          scrim.setAttribute('data-dshr-scrim-open', 'false')
          scrim.remove()
          state.scrim = null
        }
        for (const anchor of [A.center, A.rightbarColumn]) {
          const el = document.querySelector(anchor)
          if (el !== null) el.removeAttribute('inert')
        }
        const previous = state.focusBeforeDrawer
        state.focusBeforeDrawer = null
        if (previous instanceof HTMLElement && previous.isConnected) {
          previous.focus({ preventScroll: true })
        }
      }

      /** Apply the current mode to the frame and the settings dialog. */
      function sync() {
        const el = frame()
        const currentMode = mode()
        document.documentElement.setAttribute(ROOT_MODE_ATTR, currentMode)

        // The settings dialog is portalled into the body and covers the
        // viewport, so it follows the window rather than the frame.
        const overlay = document.querySelector(A.settingsOverlay)
        if (overlay !== null) {
          overlay.setAttribute(
            ROOT_MODE_ATTR,
            window.innerWidth <= PHONE_MAX ? 'phone' : 'wide'
          )
        }

        if (el === null) {
          auditAnchors()
          return
        }
        state.seenFrame = true
        syncDrawer(el, currentMode)
        syncGrid(el)
        auditAnchors()
      }

      /** Close the drawer when the user presses Escape. */
      function onKeyDown(event) {
        if (event.key !== 'Escape') return
        if (!state.drawerOpen) return
        event.preventDefault()
        closeDrawer()
      }

      const onResize = () => sync()

      window.addEventListener('resize', onResize)
      window.addEventListener('orientationchange', onResize)
      document.addEventListener('keydown', onKeyDown, true)

      // React rewrites the frame's inline grid on every layout change, and
      // the frame appears after this plugin loads. The observer therefore
      // watches the attributes React owns, and the frame's width is watched
      // separately because the grid is not the only thing that changes it.
      const observer = new MutationObserver(() => sync())
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'data-sidebar-collapsed'],
        subtree: true,
      })

      // The settings dialog is portalled into the body, so it shows up as a
      // new child there rather than as a mutation inside the frame.
      const bodyObserver = new MutationObserver(() => sync())
      bodyObserver.observe(document.body, { childList: true })

      let resizeObserver = null
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => sync())
      }

      function watchFrame() {
        const el = frame()
        if (el === null) return false
        if (resizeObserver !== null) {
          resizeObserver.disconnect()
          resizeObserver.observe(el)
        }
        return true
      }

      // The frame renders after this plugin loads, so the anchors are not
      // there yet on the first pass. Wait for the frame before reporting.
      function waitForFrame() {
        if (watchFrame()) {
          clearTimeout(bootTimer)
          sync()
          return
        }
        requestAnimationFrame(waitForFrame)
      }

      // If the frame never arrives, upstream has dropped the markers rather
      // than being slow to start. The grace period separates the two.
      const bootTimer = setTimeout(() => {
        state.bootExpired = true
        auditAnchors()
      }, BOOT_GRACE_MS)

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForFrame, { once: true })
      } else {
        waitForFrame()
      }
      sync()

      return () => {
        clearTimeout(bootTimer)
        window.removeEventListener('resize', onResize)
        window.removeEventListener('orientationchange', onResize)
        document.removeEventListener('keydown', onKeyDown, true)
        observer.disconnect()
        bodyObserver.disconnect()
        if (resizeObserver !== null) resizeObserver.disconnect()
        if (state.scrim !== null) state.scrim.remove()
        document.documentElement.removeAttribute(ROOT_MODE_ATTR)
        document.documentElement.removeAttribute(MISSING_ATTR)
        const el = frame()
        if (el !== null) {
          el.removeAttribute(DRAWER_ATTR)
          el.removeAttribute('inert')
          if (state.writtenGrid !== null && state.lastReactGrid !== null) {
            el.style.setProperty('grid-template-columns', state.lastReactGrid)
          }
        }
        style.remove()
      }
    }

    /**
     * Activate the plugin.
     *
     * @param {object} ctx - The client root context.
     */
    function apply(ctx) {
      ctx.effect(() => install(), 'desktop-responsive layout')
    }

    const inject = []

    exports.apply = apply
    exports.inject = inject
    exports.anchors = ANCHORS
    exports.phoneMax = PHONE_MAX
    return module.exports
  }
})
