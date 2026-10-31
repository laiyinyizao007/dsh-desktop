/**
 * Phone-width layout for the Harness web UI.
 *
 * The Harness frame is a three-column CSS grid. Above 1024 px the sidebar
 * takes its own column. Below that breakpoint the sidebar collapses to a
 * 56 px rail, and expanding it again re-expands "over the squeezed center"
 * — the sidebar keeps a full 264-420 px column while the center column is
 * left with whatever is left over.
 *
 * On a 390 px phone that leaves the center column about 110 px wide: every
 * label breaks one word per line, and every control near the right edge
 * falls outside the viewport. The page does not scroll horizontally, so the
 * user gets no hint that anything is off-screen — just a squeezed, unusable
 * panel.
 *
 * This plugin turns the expanded sidebar into an overlay on phone widths:
 * it floats above the content instead of displacing it, and dims the
 * content behind it.
 *
 * ## How it finds the DOM
 *
 * The frame's CSS module class names are hashed (`pI_x6G_frame`), and the
 * hash changes whenever upstream rebuilds its stylesheet. A plugin that
 * selects on them breaks silently. So the upstream frame carries explicit
 * `data-dsh-region` markers instead (see `patches/`), and this plugin
 * selects on those. The marker list is the whole upstream contract:
 *
 *   [data-dsh-region="layout"]   the grid frame
 *   [data-dsh-region="sidebar"]  the sidebar column
 *   [data-dsh-region="settings-overlay"]   the settings dialog backdrop layer
 *   [data-dsh-region="settings-nav"]      the settings dialog section list
 *   [data-dsh-region="settings-content"]  the settings dialog body column
 *   [data-dsh-region="conversation-workspace-row"]  the home composer's
 *                                                    workspace chip row
 *
 * `reportMissingMarkers()` names a missing marker in the console rather
 * than letting the plugin fail quietly, so an upstream change is visible
 * instead of looking like a styling regression.
 */

const PHONE_MAX = 640

/** Upstream markers this plugin depends on. */
const REQUIRED_MARKERS = ['layout', 'sidebar']

/**
 * Upstream markers for the settings dialog.
 *
 * The settings dialog is portalled into the body, so it is not a descendant
 * of the frame. Its markers are checked separately: a host that does not
 * load the settings plugin simply has no dialog, and that is not a failure.
 */
const SETTINGS_MARKERS = ['settings-overlay', 'settings-nav', 'settings-content']

const CSS = `
@media (max-width: ${PHONE_MAX}px) {
  /* ── Sidebar ─────────────────────────────────────────────────────
     Only the expanded sidebar becomes a drawer. The collapsed rail stays
     in the grid — it is 56 px wide and carries the navigation icons, so
     it is useful on a phone and does not need to float.

     The expanded sidebar floats over the content instead of displacing
     it. The grid's first track is zeroed by the script below — CSS
     cannot do it, because the track list is an inline style React owns. */
  [data-dsh-region='layout']:not([data-sidebar-collapsed]) > [data-dsh-region='sidebar'] {
    position: fixed !important;
    inset: 0 auto 0 0 !important;
    width: min(300px, 84vw) !important;
    max-width: 84vw !important;
    z-index: 40 !important;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.24) !important;
    transition: transform 200ms cubic-bezier(0.2, 0, 0, 1) !important;
  }

  /* Behind the drawer: a scrim that dims the content. */
  [data-dsh-region='layout']::after {
    content: '' !important;
    position: fixed !important;
    inset: 0 !important;
    background: rgba(0, 0, 0, 0.4) !important;
    z-index: 39 !important;
    opacity: 0 !important;
    pointer-events: none !important;
    transition: opacity 200ms ease !important;
  }

  [data-dsh-region='layout'][data-dsh-drawer='open']::after {
    opacity: 1 !important;
    pointer-events: auto !important;
  }

  /* The resize handle has no meaning for a drawer. */
  [data-dsh-region='layout'] [data-side='sidebar'] {
    display: none !important;
  }

  /* ── Column placement ─────────────────────────────────────────────
     The sidebar is taken out of the grid flow, so the columns that
     follow it shift one track to the left: the centre column would land
     in the 56 px sidebar track and the conversation would render inside
     it. Pinning the grid areas keeps each column where it belongs.

     grid-area is not used because the columns are siblings of other
     grid children (the bottom row spans all columns). */
  [data-dsh-region='layout'] > [data-dsh-region='center'] {
    grid-column: 2 !important;
  }

  [data-dsh-region='layout'] > [data-rightbar-col] {
    grid-column: 3 !important;
  }

  /* ── Conversation content width ──────────────────────────────────
     The conversation body sizes its content with a clamp over
     --dsh-chat-content-width whose floor is 680 px. The column width
     variable is only set on wide layouts, so on a phone it falls back to
     0 and the clamp pins the content at its 680 px floor. The composer
     then renders 680 px wide inside a 390 px viewport and runs off the
     right edge.

     Below the phone breakpoint the content follows the viewport
     instead. */
  [data-dsh-region='center'] {
    --dsh-chat-content-width: 100% !important;
    --dsh-composer-card-max-width: 100% !important;
    --dsh-conversation-column-width: 100% !important;
  }

  /* ── Settings dialog ──────────────────────────────────────────────
     The dialog is a two-column panel: a section list on the left, the
     body on the right. At phone width that leaves the body about 200 px,
     so descriptions break one word per line and the value controls fall
     outside the viewport.

     Below the phone breakpoint the dialog goes full-screen and the
     section list becomes a horizontal, scrollable tab strip along the
     top. The body then gets the whole width. */
  [data-dsh-region='settings-overlay'] {
    padding: 0 !important;
  }

  [data-dsh-region='settings-overlay'] > [role='dialog'] {
    width: 100vw !important;
    max-width: 100vw !important;
    height: 100dvh !important;
    max-height: 100dvh !important;
    border-radius: 0 !important;
    flex-direction: column !important;
  }

  /* The section list turns into a tab strip along the top. */
  [data-dsh-region='settings-nav'] {
    flex: 0 0 auto !important;
    width: 100% !important;
    max-width: 100% !important;
    flex-direction: row !important;
    align-items: center !important;
    gap: 8px !important;
    padding: 8px 12px !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    -webkit-overflow-scrolling: touch !important;
    scrollbar-width: none !important;
    border-right: none !important;
    border-bottom: 0.5px solid var(--dsw-alias-border-l3) !important;
  }

  [data-dsh-region='settings-nav']::-webkit-scrollbar {
    display: none !important;
  }

  /* The list itself scrolls sideways; the title above it is hidden so the
     strip is one row tall. */
  [data-dsh-region='settings-nav'] > *:not([data-dsh-region='settings-nav-list']) {
    display: none !important;
  }

  [data-dsh-region='settings-nav'] > [data-dsh-region='settings-nav-list'] {
    display: flex !important;
    flex-direction: row !important;
    gap: 8px !important;
    min-height: 0 !important;
    padding: 0 !important;
    overflow: visible !important;
  }

  /* The body takes the rest of the screen. */
  [data-dsh-region='settings-content'] {
    width: 100% !important;
    max-width: 100% !important;
    flex: 1 1 auto !important;
    min-height: 0 !important;
    padding: 16px 16px 24px !important;
    overflow-y: auto !important;
  }

  /* The close button lives in the body's header. With the section list
     moved to the top, that header would read as a second, empty row, so
     the button is pinned to the corner of the dialog instead. */
  [data-dsh-region='settings-content'] > *:first-child {
    position: absolute !important;
    top: 8px !important;
    right: 8px !important;
    z-index: 2 !important;
    width: auto !important;
    height: auto !important;
    padding: 0 !important;
    background: none !important;
    pointer-events: none !important;
  }

  [data-dsh-region='settings-content'] > *:first-child > * {
    pointer-events: auto !important;
  }

  /* ── Home workspace row ───────────────────────────────────────────
     The workspace chip and the mode picker share one non-wrapping row.
     At phone width the chip's own label is truncated to "MiniMax-M3 H…"
     and the row keeps a wide gutter, so the composer loses the space
     it needs. The row wraps instead.

     The children are left alone: forcing a child to 100% collapses the
     hero's own layout, because the row is sized by its content rather
     than by the viewport. */
  [data-dsh-region='conversation-workspace-row'] {
    flex-wrap: wrap !important;
    row-gap: 4px !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-dsh-region='sidebar'],
  [data-dsh-region='layout']::after {
    transition: none !important;
  }
}
`

/**
 * Report missing upstream markers.
 *
 * A missing marker means upstream changed the frame's structure. The plugin
 * cannot work, and staying quiet would make that look like a styling bug.
 */
function reportMissingMarkers() {
  const missing = REQUIRED_MARKERS.filter(
    marker => !document.querySelector(`[data-dsh-region="${marker}"]`)
  )
  if (missing.length > 0) {
    console.error(
      `[dsh-responsive] upstream markers missing: ${missing.join(', ')}. ` +
        'The responsive layout is inactive. Check the data-dsh-region patches.'
    )
  }
  return missing.length === 0
}

/** The grid frame. */
function layoutFrame() {
  return document.querySelector('[data-dsh-region="layout"]')
}

/** Whether the sidebar is currently expanded. */
function isSidebarExpanded(frame) {
  return frame.getAttribute('data-sidebar-collapsed') === null
}

/**
 * Give the whole width back to the center column.
 *
 * The track list is an inline style React owns, so a stylesheet cannot
 * change it — even `!important` loses to an inline declaration. The script
 * rewrites the first track and restores the original afterwards.
 *
 * The sidebar is always taken out of the grid flow on phone widths (the
 * stylesheet makes it fixed), so its track has to go as well — otherwise
 * the conversation sits next to an empty 56 px column.
 */
function collapseFirstTrack(frame) {
  const style = frame.style
  const current = style.gridTemplateColumns
  if (!current) return null
  const tracks = current.trim().split(/\s+/)
  if (tracks.length < 3) return null
  const original = frame.dataset.dshOriginalGrid || current
  frame.dataset.dshOriginalGrid = original
  if (tracks[0] === '0px') return original
  tracks[0] = '0px'
  style.gridTemplateColumns = tracks.join(' ')
  return original
}

/** Give the sidebar column back to the grid. */
function restoreFirstTrack(frame) {
  const original = frame.dataset.dshOriginalGrid
  if (!original) return
  delete frame.dataset.dshOriginalGrid
  if (frame.style.gridTemplateColumns !== original) {
    frame.style.gridTemplateColumns = original
  }
}

/**
 * Keep the drawer state in step with the sidebar's expanded state.
 *
 * React re-renders the inline grid whenever the layout changes, so the
 * track is re-adjusted on every mutation of the frame.
 *
 * On phone widths the expanded sidebar leaves the grid, so its track has
 * to go to zero — otherwise the conversation sits next to an empty
 * column. The collapsed rail stays in the grid, so its track comes back.
 */
function sync() {
  const frame = layoutFrame()
  if (!frame) return
  const phone = window.innerWidth <= PHONE_MAX
  const expanded = isSidebarExpanded(frame)

  if (phone) {
    if (expanded) {
      frame.setAttribute('data-dsh-drawer', 'open')
      collapseFirstTrack(frame)
    } else {
      frame.removeAttribute('data-dsh-drawer')
      restoreFirstTrack(frame)
    }
  } else {
    frame.removeAttribute('data-dsh-drawer')
    restoreFirstTrack(frame)
  }
}

function install() {
  if (document.querySelector('style[data-plugin-css="dsh-responsive"]')) return
  const style = document.createElement('style')
  style.setAttribute('data-plugin-css', 'dsh-responsive')
  style.textContent = CSS
  document.head.appendChild(style)

  const observer = new MutationObserver(() => sync())

  // The frame renders after this plugin loads, so the markers are not there
  // yet on the first pass. Wait for the layout marker before reporting.
  function waitForFrame() {
    if (layoutFrame()) {
      reportMissingMarkers()
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'data-sidebar-collapsed', 'data-dsh-region'],
        subtree: true,
      })
      window.addEventListener('resize', sync)
      window.addEventListener('orientationchange', sync)
      sync()
      return
    }
    requestAnimationFrame(waitForFrame)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForFrame, { once: true })
  } else {
    waitForFrame()
  }
}

if (typeof window !== 'undefined') {
  if (window.__ModuleLoader__) {
    window.__ModuleLoader__.load({
      id: 'dsh-responsive',
      factory: () => {
        const module = { exports: {} }
        const exports = module.exports
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
        exports.apply = install
        exports.inject = []
        return module.exports
      },
    })
  } else {
    install()
  }
}
