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
 *
 * `reportMissingMarkers()` names a missing marker in the console rather
 * than letting the plugin fail quietly, so an upstream change is visible
 * instead of looking like a styling regression.
 */

const PHONE_MAX = 640

/** Upstream markers this plugin depends on. */
const REQUIRED_MARKERS = ['layout', 'sidebar']

const CSS = `
@media (max-width: ${PHONE_MAX}px) {
  /* The expanded sidebar floats over the content instead of displacing it.
     The grid's first track is zeroed by the script below — CSS cannot do it,
     because the track list is an inline style React owns. */
  [data-dsh-region='sidebar'] {
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
 * Give the whole width back to the center column while the drawer is open.
 *
 * The track list is an inline style React owns, so a stylesheet cannot
 * change it — even `!important` loses to an inline declaration. The script
 * rewrites the first track and restores the original afterwards.
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
 * track is re-collapsed on every mutation of the frame.
 */
function sync() {
  const frame = layoutFrame()
  if (!frame) return
  const phone = window.innerWidth <= PHONE_MAX
  const expanded = isSidebarExpanded(frame)

  if (phone && expanded) {
    frame.setAttribute('data-dsh-drawer', 'open')
    collapseFirstTrack(frame)
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
