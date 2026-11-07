/**
 * The plugin-graph URLs, in the two forms they come in.
 *
 * The Harness composes one bundle from a list of plugin ids and addresses
 * it as `plugins/??<id>/client.js,<id>/client.js&rev=<hash>` — the `??`
 * keeps a URL parser from truncating the path at the first `?`. An edge
 * cache cannot key on that, so the proxy advertises the same bundle as
 * `plugins/<id>/client.js,<id>/client.js?rev=<hash>&proxy=2`, a path that
 * ends in `.js`, and turns it back on the way upstream.
 *
 * A package-local chunk — `client.sidebar-order.js`, `client.browser.js`
 * and the like — is not a bundle. The Harness serves it by name, under
 * `/plugins/<id>/<file>`. Turning it into the `??` form would ask the
 * Harness for a plugin called `dsh-cost-meter/client.sidebar-order.js`,
 * which it does not have, and the answer is a 404 for a file that is on
 * disk.
 *
 * So the two shapes are told apart by the file name, not by the number of
 * entries: a bundle's entry is always `<id>/client.js` (or `<id>/client.js.map`
 * for its source map), while a chunk is `<id>/client.<something>.js`. A
 * list of one is still a bundle — the Harness composes it from a
 * one-element list — so the number of entries says nothing.
 */

/** The marker the proxy puts in the URLs it advertises. */
export const BUNDLE_URL_FORMAT = 2

/**
 * One entry of a bundle list.
 *
 * The Harness builds every bundle from `<id>/client.js` and its source map
 * from `<id>/client.js.map`. A chunk never ends that way: its file name
 * carries a suffix, as `client.browser.js` does.
 */
const COMBO_ENTRY = /\/client\.js(\.map)?$/

/**
 * Whether a plugin path names a bundle rather than a package-local chunk.
 *
 * A bundle is content-addressed by its revision, so it can be cached
 * forever. A chunk cannot: it borrows the revision of the bundle it was
 * cut from, and that revision changes whenever *any* plugin in that
 * bundle's list changes — even when the chunk's own bytes have not moved.
 * A cached chunk under such a revision is a stale chunk for as long as the
 * edge keeps it, which is a year.
 *
 * @param path - the path of the resource, without its query
 * @returns true when the path names a bundle
 */
export function isBundlePath(path) {
  const list = path.slice('/plugins/'.length)
  return list.split(',').every((entry) => COMBO_ENTRY.test(entry))
}

/**
 * The Harness's own form of a plugin-graph URL.
 *
 * The reverse of {@link cacheableBundleUrl}: the Harness reads the plugin
 * list from the part after `??`, so a request that arrives in the cacheable
 * form has to be turned back before it is forwarded.
 *
 * @param rawUrl - the request URL as it arrived
 * @returns the URL in the Harness's form, or the original when it is not one
 */
export function harnessBundleUrl(rawUrl) {
  if (!rawUrl.startsWith('/plugins/')) return rawUrl
  if (rawUrl.includes('/??')) return rawUrl
  const questionMark = rawUrl.indexOf('?')
  if (questionMark < 0) return rawUrl
  const path = rawUrl.slice(0, questionMark)
  const search = rawUrl.slice(questionMark + 1)
  const list = path.slice('/plugins/'.length)
  // A chunk is a file the Harness serves by name; it is left as it came.
  if (!list.split(',').every((entry) => COMBO_ENTRY.test(entry))) return rawUrl
  // Only the revision is passed on: the Harness derives the revision from
  // the plugin list, so any extra parameter would make the two disagree
  // and the bundle would not be found.
  const revision = /^rev=([^&]*)/.exec(search)?.[1]
  if (revision === undefined) return rawUrl
  return `/plugins/??${list}&rev=${revision}`
}

/**
 * The proxy's own marker on a plugin URL.
 *
 * It is there to give the edge cache a key that changes when the way a
 * resource is delivered changes — the same reason a bundle carries
 * `proxy=<format>`: a cache that holds an entry for the old shape would
 * otherwise keep serving it.
 */
export const PROXY_MARKER = 'proxy'

/**
 * The URL a package-local chunk is fetched from.
 *
 * A chunk is fetched under the revision of the bundle it was cut from, so
 * its URL does not change when the chunk's own bytes change — and an edge
 * cache that kept the old answer under that URL would keep serving it for
 * as long as it is told to. The answer it kept was, once, a different
 * bundle: the browser ran that bundle in the chunk's place, and the module
 * system refused the second registration of the same factory.
 *
 * The marker makes the edge's key different from the one it held, so the
 * chunk is fetched again, and the answer it is given now is the one this
 * proxy produces.
 *
 * @param rawUrl - the request URL as it arrived
 * @returns the URL to redirect to, or undefined when the request is not a chunk
 */
export function chunkRequestUrl(rawUrl) {
  if (!rawUrl.startsWith('/plugins/')) return undefined
  const questionMark = rawUrl.indexOf('?')
  if (questionMark < 0) return undefined
  const path = rawUrl.slice(0, questionMark)
  if (isBundlePath(path)) return undefined
  const search = rawUrl.slice(questionMark + 1)
  if (new RegExp(`(^|&)${PROXY_MARKER}=`).test(search)) return undefined
  const revision = /^rev=([^&]*)/.exec(search)?.[1]
  if (revision === undefined) return undefined
  const rest = search.replace(/^rev=[^&]*&?/, '').replace(/&?$/, '')
  return `/plugins/${path.slice('/plugins/'.length)}?rev=${revision}${rest ? `&${rest}` : ''}&${PROXY_MARKER}=${BUNDLE_URL_FORMAT}`
}

/**
 * A chunk URL without the proxy's marker.
 *
 * The Harness derives a chunk's revision from the bundle it was cut from,
 * so it reads the `rev` parameter and ignores the rest — but a parameter it
 * does not know is still a parameter it has not been asked to ignore, and
 * the answer it gives for a URL it cannot parse is the bundle it has.
 *
 * @param rawUrl - the request URL as it arrived
 * @returns the URL in the Harness's form, or the original when it is not one
 */
export function harnessChunkUrl(rawUrl) {
  if (!rawUrl.startsWith('/plugins/')) return rawUrl
  const questionMark = rawUrl.indexOf('?')
  if (questionMark < 0) return rawUrl
  const path = rawUrl.slice(0, questionMark)
  if (isBundlePath(path)) return rawUrl
  const search = rawUrl.slice(questionMark + 1)
  const withoutMarker = search
    .split('&')
    .filter((part) => !part.startsWith(`${PROXY_MARKER}=`))
    .join('&')
  return withoutMarker === search ? rawUrl : `${path}?${withoutMarker}`
}

/**
 * The cacheable form of a request that still uses the Harness's own URL.
 * The URLs in the module graph are rewritten when the page is served, but a
 * client that loaded an older page — or a URL that was copied out of the
 * log — still asks for the Harness's own form. Sending it on to the
 * Harness would work, but the answer would never be cached, so the request
 * is pointed at the cacheable form instead.
 *
 * @param rawUrl - the request URL as it arrived
 * @returns the URL to redirect to, or undefined when the request is not one
 */
export function cacheableRequestUrl(rawUrl) {
  const match = /^\/plugins\/\?\?(.+)&rev=([^&]+)/.exec(rawUrl)
  if (match === null) return undefined
  return `/plugins/${match[1]}?rev=${match[2]}&proxy=${BUNDLE_URL_FORMAT}`
}

/**
 * The cacheable form of a URL the page advertises.
 *
 * The page's own URLs are in the Harness's form, and the edge cache keys
 * on the path — so a path that ends in `.js` and carries the revision is
 * what gets cached.
 *
 * @param value - the URL as it appears in the page
 * @returns the URL to advertise
 */
export function cacheableBundleUrl(value) {
  return value.replace(
    /(plugins)\/\?\?([^"']*?)&(?:amp;)?rev=([^"'&]+)/g,
    `$1/$2?rev=$3&proxy=${BUNDLE_URL_FORMAT}`
  )
}
