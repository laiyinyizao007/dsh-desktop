/**
 * Keep the header's title clear of the rail's toggle on a narrow screen.
 *
 * Upstream's rail toggle is a fixed button at the left of the header, and
 * the title row starts at the header's own padding — so on a narrow
 * screen the title runs under the button, and the first word of it is
 * covered. The clearance is upstream's own variable: it is what the macOS
 * traffic lights use, and the phone layout sets it to the same 98 px once
 * it has run.
 *
 * This is here rather than in the phone layout because of *when*. The
 * layout plugin arrives with the bundle — about three megabytes of it —
 * and until then the page shows upstream's own layout, which is the one
 * with the overlap. On a phone over a tunnel that is seconds of the
 * reader's time, and it is the first thing they see.
 */

/** The width at or below which the screen is a phone's. */
const NARROW_MAX = 640

/** The room the title keeps on the left, in CSS pixels. */
const LEADING_CLEARANCE = 98

/** The marker that says the style is already in the page. */
const NARROW_MARKER = 'data-dsh-narrow-clearance'

/**
 * The style itself.
 *
 * The clearance is a variable of the upstream's own, so nothing here
 * depends on a class name that a rebuild would rehash.
 */
function buildNarrowStyle() {
  return `<style ${NARROW_MARKER}>
@media (max-width: ${NARROW_MAX}px) {
  :root { --dsh-frame-leading-clearance: ${LEADING_CLEARANCE}px; }
}
</style>`
}

/**
 * Put the style into a page.
 *
 * @param html - the page
 * @returns the page with the style in it
 */
export function injectNarrowClearance(html) {
  if (typeof html !== 'string' || html === '') return html
  if (html.includes(NARROW_MARKER)) return html
  const style = buildNarrowStyle()
  const headEnd = html.toLowerCase().indexOf('</head>')
  if (headEnd === -1) return style + html
  return html.slice(0, headEnd) + style + html.slice(headEnd)
}
