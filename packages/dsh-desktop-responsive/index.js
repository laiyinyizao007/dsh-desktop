/**
 * `dsh-desktop-responsive` — phone-width layout for the Harness web UI.
 *
 * The whole implementation is client-side (see `client.js`): the frame's
 * layout is a browser concern, and the server has nothing to contribute.
 *
 * This entry point exists so the package is a valid Cordis plugin — the
 * loader requires a named export with an `apply` method.
 */

export const name = 'dsh-desktop-responsive'

export const inject = []

export function apply() {
  // The layout runs entirely in the browser; see `client.js`.
}
