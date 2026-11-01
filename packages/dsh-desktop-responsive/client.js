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

    /**
     * How often the plugin checks that the phone layout still holds.
     *
     * A streamed conversation re-renders on every token, so the check runs
     * on a timer rather than on every mutation.
     */
    const VERIFY_INTERVAL_MS = 1000

    /** The attribute that carries the measured viewport, for diagnosis. */
    const VIEWPORT_ATTR = 'data-dshr-viewport'

    /**
     * The smallest share of the window that a visual viewport may claim.
     *
     * A phone's keyboard covers at most half the screen, so a visual
     * viewport below this share is not a keyboard — it is a web view that
     * reports a viewport which never settled, or one that was measured
     * while a sheet was open.
     */
    const VIEWPORT_FLOOR = 0.4

    /** The locale namespace this plugin's own strings live in. */
    const NS = 'desktop-responsive'

    /** The plugin's own strings. */
    const en = {
      'menu.open': 'Open sidebar',
      'menu.close': 'Close sidebar',
      'tabs.open': 'Show the view tabs',
      'tabs.close': 'Hide the view tabs',
      'usage.open': 'Usage stats',
      'usage.close': 'Hide the usage stats',
      'usage.sheet': 'Usage statistics',
      'actions.open': 'More actions',
      'actions.close': 'Hide the actions',
      // Upstream's own name for the model menu. The plugin looks the menu up
      // by it, because several menus share the same surface and only this
      // one lists the session's model and reasoning effort.
      'modelMenu.aria': 'Model and reasoning effort',
    }
    const zh = {
      'menu.open': '打开侧边栏',
      'menu.close': '收起侧边栏',
      'tabs.open': '展开视图标签',
      'tabs.close': '收起视图标签',
      'usage.open': '用量统计',
      'usage.close': '收起用量统计',
      'usage.sheet': '用量统计',
      'actions.open': '更多操作',
      'actions.close': '收起操作',
      'modelMenu.aria': '模型与推理等级',
    }

    /** The plugin's own attributes. */
    const MENU_ATTR = 'data-dshr-menu'
    const TABS_TOGGLE_ATTR = 'data-dshr-tabs-toggle'
    const USAGE_ATTR = 'data-dshr-usage'
    const USAGE_LABEL_ATTR = 'data-dshr-usage-label'
    const SHEET_BACKDROP_ATTR = 'data-dshr-sheet-backdrop'

    /**
     * The focusable elements of a panel.
     *
     * This names a kind of element and not upstream's markup, so it is
     * deliberately not part of the upstream contract: a focus trap has to
     * find whatever the panel made focusable, and upstream's own classes
     * change with every rebuild.
     */
    const FOCUSABLE_SELECTOR = 'button, [href], [tabindex]:not([tabindex="-1"])'

    /** The root attribute that holds the folded rows open. */
    const TABS_OPEN_ATTR = 'data-dshr-tabs'

    /** The attribute the plugin puts on a table's own scroll container. */
    const TABLE_SCROLL_ATTR = 'data-dshr-table-scroll'

    /** The attribute that marks a table container as overflowing. */
    const TABLE_OVERFLOW_ATTR = 'data-dshr-overflow'

    /** The attribute of a control the plugin has taken over. */
    const NO_DRAG_ATTR = 'data-dshr-no-drag'

    /** The attribute of the layer that holds the bottom workbench. */
    const PANEL_LAYER_ATTR = 'data-dshr-panel-layer'

    /** The attribute of the strip holding the plugin's own actions. */
    const ACTION_STRIP_ATTR = 'data-dshr-action-strip'

    /** The attribute of the button that opens the header's actions. */
    const ACTIONS_ATTR = 'data-dshr-actions'

    /** The root attribute that holds the header's actions open. */
    const ACTIONS_OPEN_ATTR = 'data-dshr-actions-open'

    /** The attribute that marks the reading size as the plugin's own. */
    const CONTENT_SCALE_ATTR = 'data-dshr-content-scale'

    /** The attribute the plugin puts on a floating control it adopts. */
    const FLOAT_ATTR = 'data-dshr-float'

    /** The root attribute that opens the usage sheet. */
    const SHEET_OPEN_ATTR = 'data-dshr-sheet'

    /**
     * How far down a drag has to go before the sheet closes.
     */
    const SHEET_DRAG_CLOSE_PX = 40

    /**
     * The band at the top of the sheet that starts a drag. It matches the
     * handle the stylesheet draws; the pills below it stay clickable.
     */
    const SHEET_HANDLE_BAND = 16

    /** Idempotency guard for the injected stylesheet. */
    const STYLE_KEY = 'dsh-desktop-responsive'

    /** Plugin-owned attributes. Namespaced so they cannot collide with upstream. */
    const ROOT_MODE_ATTR = 'data-dshr-mode'
    const DRAWER_ATTR = 'data-dshr-drawer'
    const SCRIM_ATTR = 'data-dshr-scrim'
    const MISSING_ATTR = 'data-dshr-missing'
    /** Marks the element the plugin gave the focus, so it can give it back. */
    const FOCUS_HOST_ATTR = 'data-dshr-focus-host'
    const PROBLEM_ATTR = 'data-dshr-problem'

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
      sidebarCollapsed: {
        // The frame's own state attribute. It is present only while the
        // sidebar is collapsed, so it identifies the frame rather than
        // describing it.
        selector: '[data-sidebar-collapsed]',
        origin: 'attribute',
        package: '@deepseek-ai/dsh-client-ui-layout',
      },
      sidebarToggle: {
        selector: '[data-dsh-region="sidebar-toggle"]',
        origin: 'marker',
        package: '@deepseek-ai/dsh-client-ui-sidebar',
        surface: 'frame',
      },
      bottomPanel: {
        // The bottom workbench of the better-sidebar plugin. It is not
        // part of every deployment, so it is an optional anchor: the
        // plugin is absent on a host without it.
        selector: '[data-dsh-bottom-panel]',
        origin: 'attribute',
        package: 'dsh-better-sidebar',
        optional: true,
      },
      titleRow: {
        // The row's height follows its content — a session with a running
        // task is taller than one without — so the floating controls have
        // to be measured against it rather than against a fixed offset.
        selector: '[data-dsh-region="conversation-title-row"]',
        origin: 'marker',
        package: '@deepseek-ai/dsh-client-ui-conversation',
      },
      headerUtilities: {
        // The slot ids are upstream's public contract, so they survive a
        // rebuild that rehashes the CSS module class names.
        selector: '[data-slot="conversation.session.header.utilities"]',
        origin: 'attribute',
        package: '@deepseek-ai/dsh-client-ui-conversation',
      },
      headerCorner: {
        selector: '[data-slot="conversation.session.header.corner"]',
        origin: 'attribute',
        package: '@deepseek-ai/dsh-client-ui-conversation',
      },
      composerRegion: {
        // Upstream marks the composer's own subtree; the slot attributes
        // are part of its public contract.
        selector: '[data-conversation-region="composer"]',
        origin: 'attribute',
        package: '@deepseek-ai/dsh-client-ui-conversation',
      },
      conversationContent: {
        selector: '[data-conversation-content]',
        origin: 'attribute',
        package: '@deepseek-ai/dsh-client-ui-conversation',
      },
      button: {
        // A semantic element, so it survives a rebuild that rehashes the
        // CSS module class names.
        selector: 'button',
        origin: 'element',
        package: '@deepseek-ai/dsh-client-ui-primitives',
      },
      roleButton: {
        selector: '[role="button"]',
        origin: 'element',
        package: '@deepseek-ai/dsh-client-ui-primitives',
      },
      table: {
        // A semantic element, so it survives a rebuild that rehashes the
        // CSS module class names.
        selector: 'table',
        origin: 'element',
        package: '@deepseek-ai/dsh-client-ui-primitives',
      },
      modelMenu: {
        // Upstream renders every menu into a portal on the body and marks
        // the surface with this attribute. It is upstream's own, so it
        // survives a rebuild that rehashes the CSS module class names.
        selector: '[data-menu-material="translucent"]',
        origin: 'attribute',
        package: '@deepseek-ai/dsh-client-ui-primitives',
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
      conversationHeader: {
        selector: '[data-dsh-region="conversation-header"]',
        origin: 'marker',
        package: '@deepseek-ai/dsh-client-ui-conversation',
      },
      conversationTabs: {
        selector: '[data-dsh-region="conversation-tabs"]',
        origin: 'marker',
        package: '@deepseek-ai/dsh-client-ui-conversation',
      },
      composerDock: {
        selector: '[data-dsh-region="composer-dock"]',
        origin: 'marker',
        package: '@deepseek-ai/dsh-client-ui-conversation',
      },
      chatUserStack: {
        selector: '[data-dsh-region="chat-user-stack"]',
        origin: 'marker',
        package: '@deepseek-ai/dsh-client-ui-chat',
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
      settingsHeader: {
        selector: '[data-dsh-region="settings-header"]',
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
[${SCRIM_ATTR}] {
  position: fixed !important;
  inset: 0 !important;
  z-index: 39 !important;
  background: rgba(0, 0, 0, 0.42) !important;
  opacity: 0 !important;
  pointer-events: none !important;
  transition: opacity 200ms ease !important;
}

[${SCRIM_ATTR}][data-dshr-scrim-open='true'] {
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
   upstream derives it from the content width.

   The width a sent-message bubble actually gets is decided further down.
   Upstream seats the conversation flow 32 px inside the composer card — 16 px
   of side clearance on each side — and the flow keeps its own gutter on top
   of that, so on a 390 px phone a long message ended up in a 303 px column:
   78% of the screen, with 47 px of blank space to its right. A phone chat
   has no room for that hierarchy. The clearance is dropped, and the bubble
   takes the flow's own gutter, which is about 90% of the screen. */
:root[data-dshr-mode='phone'] ${A.conversationContent} {
  --dsh-composer-side-clearance: 0px !important;
  /* The flow's own gutter is now the only gutter, so the column takes all
     of it instead of taking a little off on top of it. */
  --dsh-chat-content-width: min(100%, 920px) !important;
  --dsh-composer-card-max-width: min(calc(100% - 32px), 920px) !important;
}

/* The width handles drag a content width that has no meaning on a phone. */
:root[data-dshr-mode='phone'] ${A.conversationWidthHandle} {
  display: none !important;
}

/* ── The model selector ───────────────────────────────────────────────────
   Upstream folds the model name to its icon when the controls do not fit on
   one line, but it measures the truncated label, so a long model name still
   shows as "MiniMax-M3 H…". The seat reads two inherited variables, so
   setting them on the root folds the label away without touching the
   row — and without fighting the observer upstream puts on it. */
:root[data-dshr-mode='phone'] {
  --dsh-composer-model-text-display: none !important;
  --dsh-composer-model-icon-display: block !important;
}

/* ── The top and bottom chrome ────────────────────────────────────────────
   On a phone the header's view tabs and the composer's dock row are
   navigation and status, not content: together they take about 75 px of
   an 844 px screen. They are folded away by default and brought back with
   the chevrons the plugin renders.

   The rows are collapsed with a zero height rather than \`display: none\`,
   so restoring them does not depend on the upstream display value. */
:root[data-dshr-mode='phone']:not([data-dshr-tabs='open']) ${A.conversationTabs} {
  height: 0 !important;
  min-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
}

:root[data-dshr-mode='phone']:not([data-dshr-tabs='open']) ${A.conversationHeader} {
  min-height: 44px !important;
  padding-top: 6px !important;
}

:root[data-dshr-mode='phone']:not([data-dshr-dock='open']) ${A.composerDock} {
  height: 0 !important;
  min-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
}

/* ── The usage sheet ──────────────────────────────────────────────────────
   The status row under the composer holds the token count, the cost, the
   cache hit rate and the context meter — six numbers in one line, which is
   a lot of screen for information nobody reads while typing.

   On a phone the row is folded away and a single entry brings it back as
   a bottom sheet: the row itself becomes the sheet, so nothing is moved
   in the DOM and React never sees a change. */
:root[data-dshr-mode='phone'][data-dshr-sheet='open'] ${A.composerDock} {
  position: fixed !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  /* Upstream's portals — the context meter's tooltip, the model picker —
     sit at z-index 1100. The sheet has to be above them, or they float on
     top of it. */
  z-index: 1200 !important;
  height: auto !important;
  max-height: 70vh !important;
  overflow-y: auto !important;
  flex-direction: column !important;
  align-items: stretch !important;
  gap: 2px !important;
  padding: 10px 16px calc(16px + env(safe-area-inset-bottom)) !important;
  background: var(--dsw-alias-bg-layer-2) !important;
  border-radius: 16px 16px 0 0 !important;
  box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.28) !important;
}

/* The handle that says the sheet can be dragged away. */
:root[data-dshr-mode='phone'][data-dshr-sheet='open'] ${A.composerDock}::before {
  content: '' !important;
  display: block !important;
  width: 36px !important;
  height: 4px !important;
  margin: 0 auto 10px !important;
  border-radius: 2px !important;
  background: var(--dsw-alias-border-l2) !important;
}

[${SHEET_BACKDROP_ATTR}] {
  position: fixed !important;
  inset: 0 !important;
  z-index: 1199 !important;
  background: rgba(0, 0, 0, 0.4) !important;
  opacity: 0 !important;
  pointer-events: none !important;
  transition: opacity 200ms ease !important;
}

[${SHEET_BACKDROP_ATTR}][data-dshr-sheet-open='true'] {
  opacity: 1 !important;
  pointer-events: auto !important;
}

/* ── Tables ───────────────────────────────────────────────────────────────
   Upstream keeps a wide table's horizontal scroll bar hidden until the
   pointer hovers it. A phone has no pointer, so the table stayed clipped
   and its last columns were simply out of reach.

   The container scrolls on a phone, and a soft shadow at its right edge
   says there is more to the side. The shadow is a gradient rather than a
   fade, so it reads on a light and on a dark surface alike. */
[${TABLE_SCROLL_ATTR}] {
  overflow-x: auto !important;
}

[${TABLE_SCROLL_ATTR}][${TABLE_OVERFLOW_ATTR}] {
  background-image: radial-gradient(farthest-side at 100% 50%, rgba(0, 0, 0, 0.18), rgba(0, 0, 0, 0)) !important;
  background-position: right center !important;
  background-repeat: no-repeat !important;
  background-size: 14px 100% !important;
  background-attachment: scroll !important;
}

/* ── The header's secondary actions ───────────────────────────────────────
   Six small buttons share the top-right corner: the open-in-app actions,
   the bottom panel, the diagnostics and the right sidebar. At 28 px each
   they take a third of a phone's width, and none of them is a target a
   thumb can hit.

   They collapse into one menu instead. The containers are not moved in the
   DOM: they are lifted out of the header's grid and parked below it, so
   React never sees a change and every button keeps its own owner. */
:root[data-dshr-mode='phone'] ${A.headerUtilities},
:root[data-dshr-mode='phone'] ${A.headerCorner} {
  position: fixed !important;
  top: 52px !important;
  z-index: 60 !important;
  display: flex !important;
  align-items: center !important;
  gap: 4px !important;
  padding: 6px !important;
  border-radius: 14px !important;
  background: var(--dsw-alias-bg-layer-2) !important;
  box-shadow: var(--dsw-elevation-panel) !important;
  opacity: 0 !important;
  pointer-events: none !important;
  transform: translateY(-6px) !important;
  transition: opacity 140ms ease, transform 140ms ease;
}

:root[data-dshr-mode='phone'] ${A.headerUtilities} {
  right: calc(68px + var(--dsh-actions-extra, 0px)) !important;
}

:root[data-dshr-mode='phone'] ${A.headerCorner} {
  right: calc(8px + var(--dsh-actions-extra, 0px)) !important;
}

:root[data-dshr-mode='phone'][data-dshr-actions-open='open'] ${A.headerUtilities},
:root[data-dshr-mode='phone'][data-dshr-actions-open='open'] ${A.headerCorner} {
  opacity: 1 !important;
  pointer-events: auto !important;
  transform: none !important;
}

/* Inside the menu the buttons get room to breathe. One of them is a split
   button — a bordered group whose parts share its width — so the group's
   own box is grown instead of the buttons inside it: forcing the buttons
   clips the mark the split button carries. */
:root[data-dshr-mode='phone'] ${A.headerUtilities} > *,
:root[data-dshr-mode='phone'] ${A.headerCorner} > * {
  min-height: 44px !important;
}

/* The room the collapsed menu's trigger needs. */
:root[data-dshr-mode='phone'] ${A.conversationHeader} {
  padding-right: 76px !important;
}

/* ── Type and icons on a phone ────────────────────────────────────────────
   The chrome's smallest labels are 11 px and 12 px. That is fine on a
   desktop and too small on a phone, where the reader is often holding the
   device in one hand. The theme hands out the sizes as design tokens, so
   the phone layout can raise the small end of the scale without touching
   a single component. */
:root[data-dshr-mode='phone'] body {
  --dsw-font-xxxs-11: 12px/15px var(--dsw-font-family) !important;
  --dsw-font-xxs-12: 13px/19px var(--dsw-font-family) !important;
  --dsw-font-xs-13: 14px/21px var(--dsw-font-family) !important;
}

/* The reading size is the user's own setting — the theme writes it onto
   the body as an inline style, and the settings dialog exposes it. The
   plugin only nudges it while it is still the default, so a deliberate
   choice wins. */
:root[data-dshr-mode='phone'][data-dshr-content-scale='on'] body {
  --dsh-content-font-size: 15px !important;
}

:root[data-dshr-mode='phone'] ${A.composerRegion} [contenteditable] {
  line-height: calc(26px + var(--dsh-content-font-delta, 0px)) !important;
}

/* The icons in the surfaces the reader touches most are 14 px and 16 px.
   They carry width and height as attributes, which a stylesheet can
   override; only the icons inside a button are resized, so the artwork
   keeps its proportions. */
:root[data-dshr-mode='phone'] ${A.composerRegion} button svg,
:root[data-dshr-mode='phone'] ${A.conversationHeader} button > svg {
  width: 18px !important;
  height: 18px !important;
}

/* ── Reading comfort ───────────────────────────────────────────────────────
   The markdown body sets its line height from a token, and 24 px on a
   14 px face reads tight for a long answer. The paragraphs get a little
   more air on a phone, where the line is short and the eye has less to
   hold on to. */
:root[data-dshr-mode='phone'] [data-conversation-content] p {
  line-height: calc(26px + var(--dsh-content-font-delta, 0px));
}

/* ── Floating controls ────────────────────────────────────────────────────
   A floating control sits over the text. A translucent, blurred surface
   keeps it readable without hiding what is underneath it. */
[${FLOAT_ATTR}],
[${MENU_ATTR}],
[${TABS_TOGGLE_ATTR}],
[${ACTIONS_ATTR}] {
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent) !important;
  backdrop-filter: blur(8px) saturate(140%) !important;
  -webkit-backdrop-filter: blur(8px) saturate(140%) !important;
  border: 0.5px solid var(--dsw-alias-border-l2) !important;
}

/* ── The sent messages ────────────────────────────────────────────────────
   Upstream caps the sent-message stack at 70% of the content width, and
   at 82% at most. On a phone that leaves the message in about two thirds
   of the screen, and a long message wraps far earlier than it needs to.

   The stack is given the whole column instead. The bubble inside keeps
   its own max-width, so a short message still renders as a small
   bubble and only a long one grows — which is how a phone chat is
   expected to look. */
:root[data-dshr-mode='phone'] ${A.chatUserStack} {
  max-width: 100% !important;
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
${A.settingsOverlay}[data-dshr-mode='phone'] ${A.settingsHeader} {
  flex: none !important;
  height: auto !important;
  min-height: 40px !important;
  padding: 8px 12px !important;
  align-items: center !important;
}

${A.settingsOverlay}[data-dshr-mode='phone'] ${A.settingsOptions} {
  padding: 0 16px 24px !important;
}

/* ── The visible size of the screen ───────────────────────────────────────
   On a phone the on-screen keyboard takes part of the screen without
   changing the layout viewport, so \`height: 100%\` still resolves to the
   full screen. The composer sticks to the bottom of its scroll port, so it
   ends up under the keyboard and the page looks the wrong height; in
   landscape the keyboard takes width as well, and the content runs off the
   side.

   The visual viewport is the only thing that knows how much of the screen
   is left. The script publishes it as \`--dsh-visual-width\` and
   \`--dsh-visual-height\`, and the root is sized to it, so the whole shell
   — and with it the composer — follows the keyboard.

   The rule is not scoped to the phone layout: the shell follows the
   screen whatever the layout is, and a desktop window that is resized or
   dragged shorter is the same case. */
:root {
  width: var(--dsh-visual-width, 100%) !important;
  height: var(--dsh-visual-height, 100%) !important;
}

/* Safari scrolls the layout viewport when the keyboard opens, so the
   visible band starts below its top. The frame moves down with it —
   \`top\` on a relatively positioned element, which keeps \`position:
   fixed\` children anchored to the viewport. */
${A.frame} {
  top: var(--dsh-visual-offset, 0px) !important;
}

/* The dialog covers the viewport, so it has to follow the keyboard too. */
${A.settingsOverlay}[data-dshr-mode='phone'] {
  top: var(--dsh-visual-offset, 0px) !important;
  bottom: auto !important;
  height: var(--dsh-visual-height, 100%) !important;
}

/* ── The collapsed rail ───────────────────────────────────────────────────
   The rail is 56 px wide on Linux and Windows without a title bar — a
   sixth of a phone screen spent on icons. The drawer replaces it, and the
   menu button below replaces the rail's own toggle.

   The conversation title moves right so it does not run under the button.
   The clearance is the variable upstream already uses for the macOS
   traffic lights, so the two never collide. */
:root[data-dshr-mode='phone'] {
  --dsh-frame-leading-clearance: 76px;
}

/* The menu button is the plugin's own element; it stands in for the rail's
   toggle, which the collapsed rail clips. */
[${MENU_ATTR}],
[${TABS_TOGGLE_ATTR}],
[${ACTIONS_ATTR}] {
  position: fixed !important;
  z-index: 30 !important;
  display: none !important;
  place-items: center !important;
  padding: 0 !important;
  border: none !important;
  border-radius: var(--dsw-radius-md) !important;
  background: transparent !important;
  color: var(--dsw-alias-label-primary) !important;
  cursor: pointer !important;
}

[${MENU_ATTR}] {
  /* The floating controls sit on the title row's centre line, so they read
     as one row instead of three things at three heights. The script
     measures that line and publishes it as --dsh-header-centre. */
  top: calc(var(--dsh-header-centre, 25px) - 20px) !important;
  left: 4px !important;
  width: 40px !important;
  height: 40px !important;
}

/* The chevron that folds the view tabs back. It sits beside the menu
   button, in the space the header reserves for its leading area. */
[${TABS_TOGGLE_ATTR}] {
  top: calc(var(--dsh-header-centre, 25px) - 14px) !important;
  left: 48px !important;
  width: 28px !important;
  height: 28px !important;
}

/* The bottom workbench on a phone.
   The panel is a desktop workbench: it is a band along the bottom of a
   two-column window, and on a phone that band is a fraction of the screen
   with a file tree squeezed into it.

   It becomes a full-screen overlay instead. That also settles the gap the
   panel used to leave: the layout pushes the columns down by the height it
   reserves for the panel, while the panel itself is drawn at a height that
   includes the keyboard's inset — so the two disagreed, and the difference
   showed as a bare band above the panel. Covering the screen leaves nothing
   to disagree about. */
:root[data-dshr-mode='phone'] ${A.bottomPanel} {
  top: 0 !important;
  bottom: 0 !important;
  height: 100% !important;
  z-index: 45 !important;
}

/* The layer the workbench is mounted in. It is what the panel's own
   z-index is measured against, so the layer has to clear the plugin's own
   floating controls. */
:root[data-dshr-mode='phone'] [${PANEL_LAYER_ATTR}] {
  z-index: 46 !important;
}

/* The workbench covers the screen, so the plugin's own floating controls
   stay below it: the workbench has its own close button, and a menu
   button showing through its tab bar would only be in the way. */

/* A control the plugin has taken over: it no longer takes the pointer. */
[${NO_DRAG_ATTR}] {
  pointer-events: none !important;
  cursor: default !important;
}

/* The strip holding the items other plugins registered. It sits at the
   right of the menu, and the upstream containers move aside for it: the
   plugin publishes its width as --dsh-actions-extra. */
[${ACTION_STRIP_ATTR}] {
  display: none !important;
}

:root[data-dshr-mode='phone'] [${ACTION_STRIP_ATTR}] {
  position: fixed !important;
  top: 52px !important;
  right: 8px !important;
  z-index: 60 !important;
  /* The strip keeps its box while the menu is shut, so that its width —
     and the room the upstream containers give it — stay correct. */
  display: flex !important;
  align-items: center !important;
  gap: 4px !important;
  padding: 6px !important;
  border-radius: 14px !important;
  background: var(--dsw-alias-bg-layer-2) !important;
  box-shadow: var(--dsw-elevation-panel) !important;
  opacity: 0 !important;
  pointer-events: none !important;
  transform: translateY(-6px) !important;
  transition: opacity 140ms ease, transform 140ms ease;
}

:root[data-dshr-mode='phone'] [${ACTION_STRIP_ATTR}]:empty {
  padding: 0 !important;
}

:root[data-dshr-mode='phone'][data-dshr-actions-open='open'] [${ACTION_STRIP_ATTR}] {
  opacity: 1 !important;
  pointer-events: auto !important;
  transform: none !important;
}

:root[data-dshr-mode='phone'] [${ACTION_STRIP_ATTR}] button {
  width: 44px !important;
  height: 44px !important;
  display: grid !important;
  place-items: center !important;
  padding: 0 !important;
  border: none !important;
  border-radius: 10px !important;
  background: transparent !important;
  color: var(--dsw-alias-label-primary) !important;
  cursor: pointer !important;
}

:root[data-dshr-mode='phone'] [${ACTION_STRIP_ATTR}] button:hover {
  background: var(--dsw-alias-interactive-bg-hover) !important;
}

:root[data-dshr-mode='phone'] [${ACTION_STRIP_ATTR}] svg {
[${TABS_TOGGLE_ATTR}] svg,
[${ACTIONS_ATTR}] svg {
  width: 16px !important;
  height: 16px !important;
  display: block !important;
}

/* The button that opens the header's collapsed actions. */
[${ACTIONS_ATTR}] {
  top: calc(var(--dsh-header-centre, 25px) - 18px) !important;
  right: 28px !important;
  width: 36px !important;
  height: 36px !important;
}

/* The entry that opens the usage sheet. It is a row of the model menu, so
   it takes that menu's own geometry; the plugin only adds the hover it
   would otherwise have to copy from upstream. */
[${USAGE_ATTR}]:hover {
  background: var(--dsw-alias-interactive-bg-hover) !important;
}

[${MENU_ATTR}][data-dshr-menu-visible='true'],
[${TABS_TOGGLE_ATTR}][data-dshr-toggle-visible='true'],
[${ACTIONS_ATTR}][data-dshr-toggle-visible='true'] {
  display: grid !important;
}

[${MENU_ATTR}]:hover,
[${TABS_TOGGLE_ATTR}]:hover,
[${ACTIONS_ATTR}]:hover {
  background: var(--dsw-alias-interactive-bg-hover) !important;
}

[${MENU_ATTR}]:focus-visible,
[${TABS_TOGGLE_ATTR}]:focus-visible,
[${ACTIONS_ATTR}]:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary) !important;
  outline-offset: 2px !important;
}

[${MENU_ATTR}] svg {
[${TABS_TOGGLE_ATTR}] svg,
[${ACTIONS_ATTR}] svg {
  width: 16px !important;
  height: 16px !important;
  display: block !important;
}

[${TABS_TOGGLE_ATTR}] svg,
[${ACTIONS_ATTR}] svg {
  width: 16px !important;
  height: 16px !important;
  display: block !important;
}

@media (prefers-reduced-motion: reduce) {
  [${SCRIM_ATTR}] {
    transition: none !important;
  }
}
`

    /**
     * Install the plugin.
     *
     * @returns {() => void} A disposer that removes everything the plugin added.
     */
    function install(t, service) {
      if (document.querySelector(`style[data-plugin-css="${STYLE_KEY}"]`)) {
        return () => {}
      }
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', STYLE_KEY)
      style.textContent = CSS
      document.head.appendChild(style)

      const state = {
        /** The plugin's translator. */
        t,
        /** The items other plugins registered for the collapsed menu. */
        registeredActions: [],
        /** The current layout mode. */
        mode: 'wide',
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
        /** The menu button that opens the drawer. */
        menu: null,
        /** The chevrons that fold the top and bottom rows back. */
        toggles: {},
        /** The entry that opens the usage sheet. */
        usage: null,
        /** The button that opens the header's collapsed actions. */
        actions: null,
        /** The strip holding the items other plugins registered. */
        actionStrip: null,
        /** The label inside the usage entry. */
        usageLabel: null,
        /** The backdrop behind the usage sheet. */
        sheetBackdrop: null,
        /** Whether the frame has been seen at least once. */
        seenFrame: false,
        /** Whether the boot grace period is over. */
        bootExpired: false,
        /** The anchors reported last, so the same report is not repeated. */
        reportedMissing: '',
        /** The layout problems reported last. */
        reportedProblems: '',
        /** The observer that watches the main panel for a swap. */
        panelObserver: null,
        /** The centre column the panel observer is attached to. */
        panelTarget: null,
        /** The pending animation frame of the frame watch. */
        rafHandle: null,
        /** Whether the plugin has been unloaded. */
        disposed: false,
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
       * How much of the screen is actually visible.
       *
       * On a phone the on-screen keyboard takes part of the screen without
       * changing the layout viewport, so `height: 100%` still resolves to
       * the full screen and the composer — which sticks to the bottom of
       * its scroll port — ends up under the keyboard. In landscape the
       * keyboard also takes width, and the content runs off the side.
       *
       * The visual viewport is the only thing that knows how much is left.
       * The smaller of the two is used on each axis: the visual viewport
       * can be taller than the layout viewport when a browser bar retracts,
       * and the shell must not grow past the layout viewport.
       *
       * A pinch-zoom is not a smaller screen. The visual viewport shrinks
       * when the user zooms in, and re-laying out the shell then would
       * fight the zoom, so the layout viewport is used instead.
       */
      function visibleSize() {
        const vv = window.visualViewport
        const zoomed = vv !== undefined && vv !== null && vv.scale > 1
        if (zoomed || vv === undefined || vv === null) {
          return { width: window.innerWidth, height: window.innerHeight }
        }
        const width = Math.min(Math.round(vv.width), window.innerWidth)
        const height = Math.round(vv.height)
        // A visual viewport that is a fraction of the window's is not a
        // keyboard: on a phone the keyboard never covers more than half the
        // screen, and a web view can report a viewport that never settles.
        // Trusting such a number would leave the shell a third of the screen
        // tall, with the rest of the page bare.
        const floor = Math.round(window.innerHeight * VIEWPORT_FLOOR)
        return {
          width,
          height: height < floor ? window.innerHeight : Math.min(height, window.innerHeight),
        }
      }

      /**
       * How far the visible area is scrolled inside the layout viewport.
       *
       * Safari scrolls the layout viewport when the keyboard opens, to
       * bring the focused field into view. The visible band then starts
       * below the top of the layout viewport, and the shell — which is
       * sized to the visible band — has to move down with it or its top is
       * cut off.
       */
      function visibleOffset() {
        const vv = window.visualViewport
        if (vv === undefined || vv === null || vv.scale > 1) return 0
        return Math.round(vv.offsetTop)
      }

      /** The visible size and offset, published for the stylesheet. */
      function syncViewport() {
        const { width, height } = visibleSize()
        const root = document.documentElement
        root.style.setProperty('--dsh-visual-width', `${width}px`)
        root.style.setProperty('--dsh-visual-height', `${height}px`)
        root.style.setProperty('--dsh-visual-offset', `${visibleOffset()}px`)
        // What the page measured, in a form a device can be asked for: the
        // numbers are also on the root, so a report of a wrong layout can
        // say what the plugin saw.
        const vv = window.visualViewport
        root.setAttribute(
          VIEWPORT_ATTR,
          `${width}x${height}/${window.innerWidth}x${window.innerHeight}` +
            (vv !== undefined && vv !== null ? `/${Math.round(vv.height)}` : '')
        )
      }

      /**
       * The width the layout adapts to.
       *
       * Two things can make the content narrower than the screen: the frame
       * can sit in a pane that is narrower than the window — the desktop
       * shell and the embedded web view both do that — and the visible
       * part of the screen can be narrower than the layout viewport, which
       * is what a landscape keyboard does.
       *
       * The layout follows whichever is narrower, so it is never laid out
       * for more space than the user can actually see.
       */
      function layoutWidth() {
        const visible = visibleSize().width
        const el = frame()
        if (el) {
          const width = el.getBoundingClientRect().width
          if (width > 0) return Math.min(width, visible)
        }
        return visible
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
       * Check the phone layout actually holds.
       *
       * The anchors are not the only thing that can break: upstream can
       * rename the `--dsh-chat-content-width` token, or change the clamp
       * that floors the conversation at 680 px, and no marker would notice.
       * The symptom is the same in every case — the conversation is wider
       * than the frame — so the check is on the symptom.
       *
       * The check is cheap: one `scrollWidth` read on the conversation
       * body. It runs on a timer rather than on every mutation, because a
       * conversation re-renders on every streamed token.
       */
      function verifyLayout() {
        if (state.mode !== 'phone') return
        const el = frame()
        if (el === null) return
        const problems = []

        const content = document.querySelector(A.conversationContent)
        if (content !== null && content.scrollWidth > content.clientWidth + 4) {
          problems.push(
            `conversation content overflows (${content.scrollWidth}px in ${content.clientWidth}px)`
          )
        }

        // The frame is a three-column grid. If upstream changed it, zeroing
        // the first track would be wrong, so the plugin says so instead.
        const grid = el.style.getPropertyValue('grid-template-columns')
        if (grid) {
          const tracks = grid.replace(/minmax\([^)]*\)/g, 'M').trim().split(/\s+/)
          if (tracks.length !== 3) {
            problems.push(`the frame grid has ${tracks.length} tracks, expected 3`)
          }
        }

        if (problems.length === 0) {
          if (state.reportedProblems !== '') {
            state.reportedProblems = ''
            document.documentElement.removeAttribute(PROBLEM_ATTR)
          }
          return
        }
        const report = problems.join('; ')
        if (report === state.reportedProblems) return
        state.reportedProblems = report
        console.error(
          `[${STYLE_KEY}] the phone layout does not hold: ${report}. ` +
            'An upstream layout rule changed; check the anchor manifest.'
        )
        document.documentElement.setAttribute(PROBLEM_ATTR, report)
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
      function syncGrid(el, currentMode) {
        const current = el.style.getPropertyValue('grid-template-columns')
        if (!current) return
        // Anything that is not the value this plugin wrote came from React.
        if (current !== state.writtenGrid) state.lastReactGrid = current

        if (currentMode !== 'phone') {
          if (state.writtenGrid !== null) {
            const restored = state.lastReactGrid ?? current
            if (restored !== current) el.style.setProperty('grid-template-columns', restored)
          }
          state.writtenGrid = null
          return
        }

        // Only the first track is replaced; the rest keep their own spacing.
        // On a phone the rail's track goes away as well: 56 px of icons is
        // a sixth of the screen, and the drawer replaces it.
        const collapsed = current.replace(/^\s*\S+/, '0px')
        if (collapsed !== current) el.style.setProperty('grid-template-columns', collapsed)
        state.writtenGrid = collapsed
      }

      /**
       * How wide the sidebar column's track is.
       *
       * The rail is 56 px on Linux and Windows without a title bar, and
       * already zero on macOS and on a window with a title bar — where the
       * native window controls live. The menu button only stands in for the
       * rail's toggle when the rail actually takes space; otherwise it
       * would sit on top of the platform's own controls.
       */
      function railWidth(el) {
        // React's own track list, not the collapsed one this plugin
        // wrote: the rail's width is what the grid looked like before.
        const current = state.lastReactGrid ?? el.style.getPropertyValue('grid-template-columns')
        const first = /^\s*(\S+)/.exec(current)?.[1] ?? ''
        const width = Number.parseFloat(first)
        return Number.isFinite(width) ? width : 0
      }

      /**
       * The button that opens the drawer.
       *
       * The collapsed rail carries upstream's own toggle, but the rail is
       * hidden on a phone, so the button stands in for it. It is the
       * plugin's own element rather than an injection into upstream's
       * render tree, and it is placed where the rail's toggle was.
       */
      function ensureMenu(t) {
        if (state.menu !== null && state.menu.isConnected) return state.menu
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute(MENU_ATTR, '')
        button.setAttribute('aria-label', t('menu.open'))
        button.innerHTML =
          '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
          '<path d="M2 4h12M2 8h12M2 12h12" fill="none" stroke="currentColor" ' +
          'stroke-width="1.5" stroke-linecap="round"/></svg>'
        button.addEventListener('click', () => {
          if (state.drawerOpen) {
            closeDrawer()
            return
          }
          openDrawer()
        })
        document.body.appendChild(button)
        state.menu = button
        return button
      }

      const CHEVRON_DOWN =
        '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
        '<path d="M4 6.5l4 4 4-4" fill="none" stroke="currentColor" ' +
        'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      const CHEVRON_UP =
        '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
        '<path d="M4 9.5l4-4 4 4" fill="none" stroke="currentColor" ' +
        'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

      /**
       * A chevron that folds a row back into view.
       *
       * The header's view tabs and the composer's dock row are folded away
       * on a phone; these bring them back. They are the plugin's own
       * elements, so they do not depend on upstream's markup.
       */
      function ensureToggle(attribute, icon, label, onClick) {
        if (state.toggles[attribute] !== undefined && state.toggles[attribute].isConnected) {
          return state.toggles[attribute]
        }
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute(attribute, '')
        button.innerHTML = icon
        button.addEventListener('click', onClick)
        document.body.appendChild(button)
        state.toggles[attribute] = button
        return button
      }

      /**
       * Open the drawer by telling upstream to expand the sidebar.
       *
       * The drawer is the upstream sidebar, so opening it means asking
       * upstream to expand the sidebar again. The plugin clicks the upstream
       * toggle rather than reaching into its state: the toggle is the
       * control the user would use, and it keeps the plugin out of
       * upstream's store.
       */
      function openDrawer() {
        const toggle = document.querySelector(A.sidebarToggle)
        if (toggle === null) {
          console.error(
            `[${STYLE_KEY}] cannot open the drawer: the sidebar toggle anchor is missing.`
          )
          return
        }
        toggle.click()
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
        state.mode = currentMode
        document.documentElement.setAttribute(ROOT_MODE_ATTR, currentMode)

        // The settings dialog is portalled into the body and covers the
        // viewport, so it follows the window rather than the frame.
        const overlay = document.querySelector(A.settingsOverlay)
        if (overlay !== null) {
          overlay.setAttribute(
            ROOT_MODE_ATTR,
            visibleSize().width <= PHONE_MAX ? 'phone' : 'wide'
          )
        }

        if (el === null) {
          syncToggles(currentMode)
          auditAnchors()
          return
        }
        state.seenFrame = true
        watchMainPanel()
        syncDrawer(el, currentMode)
        syncGrid(el, currentMode)
        syncMenu(el, currentMode)
        syncToggles(currentMode)
        syncTables()
        syncFloatingControls()
        syncContentScale()
        syncHeaderCentre()
        syncBottomPanel(currentMode)
        syncActions(currentMode)
        auditAnchors()
        verifyLayout()
      }

      /**
       * Show the menu button when the rail it stands in for is hidden.
       *
       * The button replaces the rail's own toggle, so it is only useful
       * where the rail actually took space.
       */
      /**
       * Take the bottom workbench's drag handle away on a phone.
       *
       * The bottom panel is a desktop workbench. On a phone it sits below
       * the fold, translated out of the way — but its resize handle is
       * drawn four pixels above the panel's own edge, so a strip of it
       * stays on the screen and can be dragged up.
       *
       * The handle carries no attribute of its own, so it is found by the
       * one thing that says what it is: it is the only control in the
       * panel that offers a row-resize cursor. A plugin that changes that
       * leaves the handle alone, which is a drag that still works rather
       * than a broken panel.
       */
      function syncBottomPanel(currentMode) {
        const panel = document.querySelector(A.bottomPanel)
        if (panel === null) return
        if (currentMode !== 'phone') {
          for (const el of panel.querySelectorAll(`[${NO_DRAG_ATTR}]`)) {
            el.removeAttribute(NO_DRAG_ATTR)
          }
          return
        }
        // The handle is the panel's first child, and it says what it is
        // with a row-resize cursor. Both have to hold before the plugin
        // touches it: a panel that grows a header would otherwise lose it.
        // The panel sits in a fixed layer of its own, and that layer is
        // what decides whether the panel is above the plugin's own
        // floating controls. The layer carries no attribute, so the plugin
        // marks the one it belongs to.
        const layer = panel.parentElement
        if (layer !== null && layer !== undefined) {
          layer.setAttribute(PANEL_LAYER_ATTR, '')
        }
        const handle = panel.firstElementChild
        if (handle === null) return
        if (getComputedStyle(handle).cursor !== 'row-resize') return
        handle.setAttribute(NO_DRAG_ATTR, '')
      }

      /**
       * Watch the registrations other plugins make.
       *
       * A plugin may register before the header is on screen, so the strip
       * is rebuilt whenever the list changes and whenever the layout
       * settles.
       */
      function watchActions() {
        return service.subscribe(() => {
          state.registeredActions = service.listActions()
          renderActionStrip()
        })
      }

      /**
       * Render the items other plugins registered.
       *
       * The plugin owns this strip, so it can rebuild it whenever a plugin
       * registers or drops an item. Its width is published so that the
       * upstream containers beside it can make room.
       */
      function renderActionStrip() {
        const strip = state.actionStrip
        if (strip === null) return
        const list = service.listActions()
        strip.textContent = ''
        for (const action of list) {
          const button = document.createElement('button')
          button.type = 'button'
          button.setAttribute('data-dshr-action', action.id)
          button.setAttribute('aria-label', action.label)
          button.title = action.label
          if (action.icon !== null) {
            button.innerHTML = action.icon
          } else {
            button.innerHTML =
              '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
              '<circle cx="3.5" cy="8" r="1.4" fill="currentColor"/>' +
              '<circle cx="8" cy="8" r="1.4" fill="currentColor"/>' +
              '<circle cx="12.5" cy="8" r="1.4" fill="currentColor"/></svg>'
          }
          button.addEventListener('click', () => {
            document.documentElement.removeAttribute(ACTIONS_OPEN_ATTR)
            sync(state.mode)
            if (action.onSelect !== null) action.onSelect()
          })
          strip.appendChild(button)
        }
        const width = strip.getBoundingClientRect().width
        document.documentElement.style.setProperty('--dsh-actions-extra', `${Math.round(width)}px`)
      }

      /**
       * The button that opens the header's collapsed actions.
       *
       * Six small buttons used to sit in the top-right corner. They are
       * collapsed into a menu now, and this is what opens it.
       */
      function ensureActions(t) {
        if (state.actions !== null && state.actions.isConnected) return state.actions
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute(ACTIONS_ATTR, '')
        button.setAttribute('aria-haspopup', 'menu')
        button.setAttribute('aria-expanded', 'false')
        button.innerHTML =
          '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
          '<circle cx="3.5" cy="8" r="1.4" fill="currentColor"/>' +
          '<circle cx="8" cy="8" r="1.4" fill="currentColor"/>' +
          '<circle cx="12.5" cy="8" r="1.4" fill="currentColor"/></svg>'
        button.addEventListener('click', () => {
          const root = document.documentElement
          const open = root.getAttribute(ACTIONS_OPEN_ATTR) === 'open'
          if (open) root.removeAttribute(ACTIONS_OPEN_ATTR)
          else root.setAttribute(ACTIONS_OPEN_ATTR, 'open')
          sync(state.mode)
        })
        document.body.appendChild(button)
        state.actions = button
        return button
      }

      /**
       * The strip the plugin's own items live in.
       *
       * It sits at the right of the menu, and the upstream containers move
       * aside for it: the width is published as --dsh-actions-extra.
       */
      function ensureActionStrip() {
        if (state.actionStrip !== null && state.actionStrip.isConnected) return state.actionStrip
        const strip = document.createElement('div')
        strip.setAttribute(ACTION_STRIP_ATTR, '')
        strip.setAttribute('role', 'menu')
        document.body.appendChild(strip)
        state.actionStrip = strip
        renderActionStrip()
        return strip
      }

      /**
       * Publish the title row's centre line.
       *
       * The row's height follows its content — a session with a running
       * task is taller than one without — so a fixed offset would put the
       * floating controls a couple of pixels off the title as soon as the
       * row changes. Measuring the row keeps them on its centre line.
       */
      function syncHeaderCentre() {
        const row = document.querySelector(A.titleRow)
        const root = document.documentElement
        if (row === null) {
          root.style.removeProperty('--dsh-header-centre')
          return
        }
        const rect = row.getBoundingClientRect()
        if (rect.height === 0) {
          root.style.removeProperty('--dsh-header-centre')
          return
        }
        root.style.setProperty('--dsh-header-centre', `${Math.round(rect.y + rect.height / 2)}px`)
      }

      /**
       * Dismiss the actions menu when the user taps elsewhere.
       *
       * A menu that cannot be closed is worse than no menu, so a tap
       * outside it puts it away.
       */
      function onDocumentPointerDown(event) {
        if (document.documentElement.getAttribute(ACTIONS_OPEN_ATTR) !== 'open') return
        const target = event.target
        if (!(target instanceof Element)) return
        if (target.closest(`[${ACTIONS_ATTR}]`) !== null) return
        if (target.closest(A.headerUtilities) !== null) return
        if (target.closest(A.headerCorner) !== null) return
        document.documentElement.removeAttribute(ACTIONS_OPEN_ATTR)
        sync(state.mode)
      }

      /**
       * Keep the collapsed actions in step with the layout.
       *
       * The menu only exists where there is something to collapse, and it
       * closes when the drawer takes the screen or the layout leaves the
       * phone.
       */
      function syncActions(currentMode) {
        const button = ensureActions(state.t)
        ensureActionStrip()
        const utilities = document.querySelector(A.headerUtilities)
        const hasActions = utilities !== null && utilities.querySelector('button') !== null
        const open = document.documentElement.getAttribute(ACTIONS_OPEN_ATTR) === 'open'
        const show = currentMode === 'phone' && hasActions && !state.drawerOpen
        if (!show) {
          button.removeAttribute('data-dshr-toggle-visible')
          document.documentElement.removeAttribute(ACTIONS_OPEN_ATTR)
          return
        }
        button.setAttribute('data-dshr-toggle-visible', 'true')
        button.setAttribute('aria-expanded', open ? 'true' : 'false')
        button.setAttribute('aria-label', open ? state.t('actions.close') : state.t('actions.open'))
      }

      /**
       * Nudge the reading size only while the user has not chosen one.
       *
       * The content font size is a user setting: the theme writes it onto
       * the body as an inline style, and the settings dialog exposes it. A
       * phone wants a little more, but a deliberate choice wins — so the
       * plugin only turns the scale on while the value is still the
       * default.
       */
      function syncContentScale() {
        const value = document.body.style
          .getPropertyValue('--dsh-content-font-size')
          .trim()
        const isDefault = value === '' || value === '14px'
        if (isDefault) document.documentElement.setAttribute(CONTENT_SCALE_ATTR, 'on')
        else document.documentElement.removeAttribute(CONTENT_SCALE_ATTR)
      }

      /**
       * Keep the tables reachable and say so.
       *
       * Upstream hides a wide table's horizontal scroll bar until the
       * pointer hovers it, which on a phone means the last columns are
       * clipped away with no way to reach them. The container is marked so
       * that it always scrolls, and the marker that carries the shadow is
       * only set while the table is actually wider than its container.
       */
      function syncTables() {
        for (const table of document.querySelectorAll(A.table)) {
          const scroller = table.parentElement
          if (scroller === null) continue
          scroller.setAttribute(TABLE_SCROLL_ATTR, '')
          // The flag lives on its own attribute: `dshrTableScroll` would
          // map back onto the marker and overwrite it.
          if (scroller.dataset.dshrTableBound !== 'true') {
            scroller.dataset.dshrTableBound = 'true'
            scroller.addEventListener('scroll', () => updateTableOverflow(scroller), {
              passive: true,
            })
          }
          updateTableOverflow(scroller)
        }
      }

      /**
       * Say so only while there is more of the table to the right.
       *
       * The hint has to disappear once the last column is in view, or it
       * would point at nothing.
       */
      function updateTableOverflow(scroller) {
        const more = scroller.scrollWidth - scroller.scrollLeft - scroller.clientWidth > 2
        if (more) scroller.setAttribute(TABLE_OVERFLOW_ATTR, '')
        else scroller.removeAttribute(TABLE_OVERFLOW_ATTR)
      }

      /**
       * Adopt the floating controls that sit over the text.
       *
       * A small control pinned to the corner of the screen lands on the
       * body text. The plugin cannot tell which control is meant — the
       * button may come from any package — so it adopts the small fixed
       * ones in the corner and gives them a translucent surface.
       */
      function syncFloatingControls() {
        const width = window.innerWidth
        const height = window.innerHeight
        for (const el of document.querySelectorAll(`${A.button}, ${A.roleButton}`)) {
          if (el.hasAttribute(FLOAT_ATTR)) continue
          const cs = getComputedStyle(el)
          if (cs.position !== 'fixed') continue
          const rect = el.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) continue
          if (rect.width > 64 || rect.height > 64) continue
          if (rect.right < width * 0.6 || rect.top < height * 0.5) continue
          el.setAttribute(FLOAT_ATTR, '')
        }
      }

      function syncMenu(el, currentMode) {
        const button = ensureMenu(state.t)
        const visible = currentMode === 'phone' && !state.drawerOpen && railWidth(el) > 0
        if (visible) {
          button.setAttribute('data-dshr-menu-visible', 'true')
          button.setAttribute('aria-label', state.t('menu.open'))
          return
        }
        button.removeAttribute('data-dshr-menu-visible')
      }

      /**
       * Keep the chevrons in step with the folded rows.
       *
       * The view tabs only exist in a session, and the dock only when a
       * composer is on screen, so a chevron appears only when there is
       * something to fold back.
       */
      function syncToggles(currentMode) {
        const root = document.documentElement
        const phone = currentMode === 'phone'

        const tabsOpen = root.getAttribute(TABS_OPEN_ATTR) === 'open'
        const tabs = ensureToggle(TABS_TOGGLE_ATTR, tabsOpen ? CHEVRON_UP : CHEVRON_DOWN,
          tabsOpen ? state.t('tabs.close') : state.t('tabs.open'), () => {
            const open = root.getAttribute(TABS_OPEN_ATTR) === 'open'
            if (open) root.removeAttribute(TABS_OPEN_ATTR)
            else root.setAttribute(TABS_OPEN_ATTR, 'open')
            sync(state.mode)
          })
        const hasTabs = document.querySelector(A.conversationTabs) !== null
        const showTabs = phone && hasTabs && !state.drawerOpen
        if (showTabs) {
          tabs.setAttribute('data-dshr-toggle-visible', 'true')
          tabs.setAttribute('aria-label', tabsOpen ? state.t('tabs.close') : state.t('tabs.open'))
        } else {
          tabs.removeAttribute('data-dshr-toggle-visible')
        }

        const sheetOpen = root.getAttribute(SHEET_OPEN_ATTR) === 'open'
        // The status row belongs to a session; the home screen has no
        // usage to show, so the entry stays out of the way there.
        const content = document.querySelector(A.conversationContent)
        const inSession = content !== null && content.hasAttribute('data-conversation-session')
        // The entry lives in the model menu, so it is only there while that
        // menu is open — and a phone is the only layout that folds the
        // status row away in the first place.
        if (phone && inSession) {
          ensureUsage(state.t, sheetOpen, () => {
            const open = root.getAttribute(SHEET_OPEN_ATTR) === 'open'
            if (open) root.removeAttribute(SHEET_OPEN_ATTR)
            else root.setAttribute(SHEET_OPEN_ATTR, 'open')
            sync(state.mode)
          })
        }
        syncSheetBackdrop(sheetOpen)
        syncSheetSemantics(sheetOpen)
      }

      /**
       * The sheet's modal semantics.
       *
       * The row becomes a dialog while it is open, the content behind it
       * goes inert so that neither the keyboard nor a stray tap reaches
       * the conversation, and the focus moves into the sheet.
       */
      function syncSheetSemantics(open) {
        const dock = document.querySelector(A.composerDock)
        if (dock === null) return
        if (open) {
          dock.setAttribute('role', 'dialog')
          dock.setAttribute('aria-modal', 'true')
          dock.setAttribute('aria-label', state.t('usage.sheet'))
          // The dialog takes the focus itself. Its controls are upstream
          // elements, and the plugin may only query the anchors in its
          // manifest — so the sheet is the focus target, which is what a
          // modal dialog is expected to do anyway.
          if (!dock.hasAttribute('tabindex')) {
            dock.setAttribute('tabindex', '-1')
            dock.setAttribute(FOCUS_HOST_ATTR, '')
          }
          dock.focus({ preventScroll: true })
          return
        }
        dock.removeAttribute('role')
        dock.removeAttribute('aria-modal')
        dock.removeAttribute('aria-label')
        if (dock.hasAttribute(FOCUS_HOST_ATTR)) {
          dock.removeAttribute(FOCUS_HOST_ATTR)
          dock.removeAttribute('tabindex')
        }
      }

      /**
       * The backdrop behind the usage sheet.
       *
       * It is a real element rather than a pseudo-element so that it can
       * take the click that dismisses the sheet.
       */
      function syncSheetBackdrop(open) {
        if (!open) {
          if (state.sheetBackdrop !== null) {
            state.sheetBackdrop.setAttribute('data-dshr-sheet-open', 'false')
            state.sheetBackdrop.remove()
            state.sheetBackdrop = null
          }
          return
        }
        if (state.sheetBackdrop !== null && state.sheetBackdrop.isConnected) {
          state.sheetBackdrop.setAttribute('data-dshr-sheet-open', 'true')
          return
        }
        const backdrop = document.createElement('div')
        backdrop.setAttribute(SHEET_BACKDROP_ATTR, '')
        backdrop.setAttribute('aria-hidden', 'true')
        backdrop.addEventListener('click', () => closeSheet())
        document.body.appendChild(backdrop)
        state.sheetBackdrop = backdrop
      }

      /**
       * The open model menu.
       *
       * Upstream renders the menu into a portal on the body, and several
       * menus share that surface. The model menu is the one upstream names
       * "model and reasoning effort"; the plugin keeps that name in step
       * with upstream's dictionary, and
       * `test/responsive-layout.test.mjs` fails when the two drift apart.
       */
      function modelMenu() {
        const name = state.t('modelMenu.aria')
        for (const surface of document.querySelectorAll(A.modelMenu)) {
          if (surface.getAttribute('aria-label') === name) return surface
        }
        return null
      }

      /**
       * The rows of the model menu's root pane.
       *
       * Upstream marks them with the menu item role. The deeper panes list
       * the models and the effort levels as radio items instead, so the role
       * is what tells the root pane apart from them.
       */
      function menuCells(menu) {
        return [...menu.children].filter(el => el.getAttribute('role') === 'menuitem')
      }

      /**
       * The single entry that opens the usage sheet.
       *
       * The status row under the composer holds the token count, the cost,
       * the cache hit rate and the context meter. On a phone that is too
       * much screen for information nobody reads while typing, so the row
       * is folded away and this entry brings it back as a sheet.
       *
       * The entry lives in the model menu rather than in the corner of the
       * screen. A phone has no room for a second floating control, and the
       * model menu is already where a hand goes for the session's settings.
       * Upstream renders that menu into a portal, so the entry is injected
       * into the open menu instead of placed in the composer.
       */
      function ensureUsage(t, open, onClick) {
        const menu = modelMenu()
        if (menu === null) return null
        const cells = menuCells(menu)
        // Only the root pane lists cells; the deeper panes list the models
        // and the effort levels as radio items.
        if (cells.length === 0) return null
        // The locale resolves after the plugin starts, so the label is
        // looked up on every pass rather than baked in when the entry is
        // created.
        const label = open ? t('usage.close') : t('usage.open')
        const existing = menu.querySelector(`[${USAGE_ATTR}]`)
        if (existing !== null) {
          const text = existing.querySelector(`[${USAGE_LABEL_ATTR}]`)
          if (text !== null) text.textContent = label
          existing.setAttribute('aria-label', label)
          state.usage = existing
          state.usageLabel = text
          return existing
        }
        const template = cells[cells.length - 1]
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('role', 'menuitem')
        button.setAttribute(USAGE_ATTR, '')
        // Upstream's own cell class carries the geometry of a row in this
        // menu, so the entry looks like the rows above it without the
        // plugin copying rules that upstream would then have to keep in
        // step with.
        button.className = template.className
        const text = document.createElement('span')
        text.setAttribute(USAGE_LABEL_ATTR, '')
        const templateText = template.getElementsByTagName('span')[0] ?? null
        if (templateText !== null) text.className = templateText.className
        text.textContent = label
        button.appendChild(text)
        button.addEventListener('click', onClick)
        template.after(button)
        state.usage = button
        state.usageLabel = text
        return button
      }

      /**
       * Close the drawer when the user picks something.
       *
       * On a phone the drawer covers the whole content column, so a panel
       * that opens behind it looks like nothing happened. The main panel is
       * swapped by replacing the child of the main slot, and that swap is
       * the signal: the drawer gets out of the way and the panel is
       * visible.
       *
       * A streamed answer also mutates the centre column, so the changes
       * inside the conversation body are ignored — otherwise the drawer
       * would close while the answer is still arriving.
       *
       * The observer is re-attached when upstream replaces the centre
       * column, so a remount does not silently stop the behaviour.
       */
      function watchMainPanel() {
        const center = document.querySelector(A.center)
        if (center === null) return
        if (state.panelObserver !== null && state.panelTarget === center) return
        if (state.panelObserver !== null) state.panelObserver.disconnect()
        const observer = new MutationObserver(records => {
          if (!state.drawerOpen) return
          const content = document.querySelector(A.conversationContent)
          const isNavigation = records.some(record => {
            if (content === null) return true
            return !content.contains(record.target)
          })
          if (!isNavigation) return
          closeDrawer()
        })
        observer.observe(center, { childList: true, subtree: true })
        state.panelObserver = observer
        state.panelTarget = center
      }

      /**
       * Close the usage sheet.
       */
      function closeSheet() {
        document.documentElement.removeAttribute(SHEET_OPEN_ATTR)
        sync(state.mode)
      }

      /**
       * Let the sheet be dragged away.
       *
       * Only the handle band starts a drag, so the pills in the sheet stay
       * clickable.
       */
      function onPointerDown(event) {
        if (document.documentElement.getAttribute(SHEET_OPEN_ATTR) !== 'open') return
        const dock = document.querySelector(A.composerDock)
        if (dock === null) return
        const rect = dock.getBoundingClientRect()
        if (event.clientY - rect.top > SHEET_HANDLE_BAND) return
        const startY = event.clientY
        const onMove = (move) => {
          if (move.clientY - startY < SHEET_DRAG_CLOSE_PX) return
          window.removeEventListener('pointermove', onMove)
          closeSheet()
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', () => window.removeEventListener('pointermove', onMove), {
          once: true,
        })
      }

      /** Close the drawer when the user presses Escape. */
      /**
       * The focusable rows inside the sheet.
       */
      function sheetItems() {
        const dock = document.querySelector(A.composerDock)
        if (dock === null) return []
        return [...dock.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
          el => !(el instanceof HTMLButtonElement && el.disabled) && el.getClientRects().length > 0
        )
      }

      /**
       * Keep the keyboard inside the sheet.
       *
       * The sheet is a modal surface, so Tab has to cycle within it
       * rather than reach the conversation behind it.
       */
      function trapFocus(event) {
        const items = sheetItems()
        const active = document.activeElement
        if (items.length === 0) {
          event.preventDefault()
          return
        }
        const first = items[0]
        const last = items[items.length - 1]
        if (event.shiftKey && (active === first || active === document.querySelector(A.composerDock))) {
          event.preventDefault()
          last.focus()
          return
        }
        if (!event.shiftKey && active === last) {
          event.preventDefault()
          first.focus()
          return
        }
        if (!event.shiftKey && active === document.querySelector(A.composerDock)) {
          event.preventDefault()
          first.focus()
        }
      }

      function onKeyDown(event) {
        if (event.key !== 'Escape') return
        if (document.documentElement.getAttribute(ACTIONS_OPEN_ATTR) === 'open') {
          event.preventDefault()
          document.documentElement.removeAttribute(ACTIONS_OPEN_ATTR)
          sync(state.mode)
          return
        }
        if (document.documentElement.getAttribute(SHEET_OPEN_ATTR) === 'open') {
          event.preventDefault()
          closeSheet()
          return
        }
        if (!state.drawerOpen) return
        event.preventDefault()
        closeDrawer()
      }

      /** Keep Tab inside the sheet while it is open. */
      function onTab(event) {
        if (event.key !== 'Tab') return
        if (document.documentElement.getAttribute(SHEET_OPEN_ATTR) !== 'open') return
        trapFocus(event)
      }

      const onResize = () => {
        syncViewport()
        sync()
      }

      window.addEventListener('resize', onResize)
      window.addEventListener('orientationchange', onResize)
      // The keyboard closes after the field gives up the focus, and the
      // visual viewport only reports the restored size a moment later.
      document.addEventListener('focusout', () => {
        window.setTimeout(() => {
          syncViewport()
          sync()
        }, 120)
      }, true)
      document.addEventListener('keydown', onKeyDown, true)
      document.addEventListener('pointerdown', onDocumentPointerDown, true)
      document.addEventListener('keydown', onTab, true)
      document.addEventListener('pointerdown', onPointerDown, true)

      // The keyboard resizes the visual viewport, not the window.
      const visualViewport = window.visualViewport
      if (visualViewport !== undefined && visualViewport !== null) {
        visualViewport.addEventListener('resize', onResize)
        visualViewport.addEventListener('scroll', onResize)
      }

      // React rewrites the frame's inline grid on every layout change, and
      // the frame appears after this plugin loads. The observer therefore
      // watches the attributes React owns, and the frame's width is watched
      // separately because the grid is not the only thing that changes it.
      const observer = new MutationObserver(() => {
        try {
          sync()
        } catch (error) {
          console.error(`[${STYLE_KEY}] the layout sync failed.`, error)
        }
      })
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'data-sidebar-collapsed'],
        subtree: true,
      })

      // The settings dialog is portalled into the body, so it shows up as a
      // new child there rather than as a mutation inside the frame.
      // Another plugin may register an item at any time, including before
      // the header is on screen.
      const stopWatchingActions = watchActions()

      const bodyObserver = new MutationObserver(() => {
        try {
          sync()
        } catch (error) {
          console.error(`[${STYLE_KEY}] the layout sync failed.`, error)
        }
      })
      bodyObserver.observe(document.body, { childList: true })

      let resizeObserver = null
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          try {
            sync()
          } catch (error) {
            console.error(`[${STYLE_KEY}] the layout sync failed.`, error)
          }
        })
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
        if (state.disposed) return
        if (watchFrame()) {
          clearTimeout(bootTimer)
          sync()
          return
        }
        state.rafHandle = requestAnimationFrame(waitForFrame)
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
      syncViewport()
      sync()

      // The layout check runs on a timer: a conversation re-renders on
      // every streamed token, and measuring on every mutation would cost
      // more than the check is worth.
      const verifyTimer = setInterval(() => {
        verifyLayout()
        // The visual viewport is the only source for the keyboard, and a
        // web view does not always say when it changed. Measuring again
        // costs nothing and lets a stale number correct itself.
        syncViewport()
      }, VERIFY_INTERVAL_MS)

      return () => {
        state.disposed = true
        if (state.rafHandle !== null) cancelAnimationFrame(state.rafHandle)
        clearTimeout(bootTimer)
        clearInterval(verifyTimer)
        window.removeEventListener('resize', onResize)
        window.removeEventListener('orientationchange', onResize)
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('pointerdown', onDocumentPointerDown, true)
        document.removeEventListener('keydown', onTab, true)
        document.removeEventListener('pointerdown', onPointerDown, true)
        if (visualViewport !== undefined && visualViewport !== null) {
          visualViewport.removeEventListener('resize', onResize)
          visualViewport.removeEventListener('scroll', onResize)
        }
        observer.disconnect()
        stopWatchingActions()
        bodyObserver.disconnect()
        if (resizeObserver !== null) resizeObserver.disconnect()
        if (state.panelObserver !== null) state.panelObserver.disconnect()
        if (state.scrim !== null) state.scrim.remove()
        if (state.menu !== null) state.menu.remove()
        for (const toggle of Object.values(state.toggles)) {
          if (toggle !== null && toggle !== undefined) toggle.remove()
        }
        if (state.usage !== null) state.usage.remove()
        if (state.actions !== null) state.actions.remove()
        if (state.actionStrip !== null && state.actionStrip !== undefined) {
          state.actionStrip.remove()
        }
        document.documentElement.style.removeProperty('--dsh-actions-extra')
        if (state.sheetBackdrop !== null) state.sheetBackdrop.remove()
        document.documentElement.removeAttribute(ROOT_MODE_ATTR)
        document.documentElement.removeAttribute(MISSING_ATTR)
        document.documentElement.removeAttribute(PROBLEM_ATTR)
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
     * The service other plugins use to add items to the collapsed menu.
     *
     * The menu itself is upstream's own slot: a plugin that injects into
     * `conversation.session.header.utilities` lands in it for free, and
     * that is the better path — the item stays a React component and keeps
     * the host's own styling.
     *
     * This service is for the plugins that cannot speak React. It takes a
     * plain description and the plugin renders a button of its own, in its
     * own strip, inside the menu.
     */
    function createService() {
      const actions = new Map()
      const listeners = new Set()
      const notify = () => {
        for (const listener of listeners) listener()
      }
      return {
        /**
         * Add an item to the collapsed menu.
         *
         * @param {object} action - The item's description.
         * @param {string} action.id - A stable id; it replaces an earlier item with the same id.
         * @param {string} action.label - The item's accessible name.
         * @param {string} [action.icon] - An SVG element to show.
         * @param {Function} [action.onSelect] - Called when the item is chosen.
         * @returns {() => void} A function that removes the item.
         */
        registerAction(action) {
          const id = action?.id
          if (typeof id !== 'string' || id === '') {
            throw new Error('dsh-desktop-responsive: an action needs a string id')
          }
          actions.set(id, {
            id,
            label: typeof action.label === 'string' ? action.label : id,
            icon: typeof action.icon === 'string' ? action.icon : null,
            onSelect: typeof action.onSelect === 'function' ? action.onSelect : null,
          })
          notify()
          return () => {
            actions.delete(id)
            notify()
          }
        },
        /** The items registered so far, in registration order. */
        listActions() {
          return [...actions.values()]
        },
        /**
         * Watch for registrations.
         *
         * @param {Function} listener - Called after every change.
         * @returns {() => void} A function that stops watching.
         */
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    /**
     * Activate the plugin.
     *
     * @param {object} ctx - The client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'responsive dictionaries')
      const service = createService()
      ctx.provide('dshDesktopResponsive', service)
      ctx.effect(() => install(ctx.locale.bind(NS), service), 'desktop-responsive layout')
    }

    const inject = ['locale']

    exports.apply = apply
    exports.inject = inject
    exports.anchors = ANCHORS
    exports.phoneMax = PHONE_MAX
    return module.exports
  }
})
