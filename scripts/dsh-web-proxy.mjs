/**
 * Reverse proxy in front of the DSH Harness web UI.
 *
 * Why: `dsh web` authenticates every request with a launch token that it
 * prints on startup and rotates on every restart. A person opening
 * `https://dsh.example.com` would otherwise have to copy a fresh
 * token out of a log after every restart.
 *
 * This proxy removes that step: it reads the current launch token from the
 * Harness log and injects it into the request it forwards upstream, then
 * passes the session cookie the Harness issues back to the browser. From the
 * browser's side the site is a normal, bookmarkable URL that keeps working
 * across Harness restarts.
 *
 * It also fronts the full Harness UI, so the web surface carries the Desktop
 * host plugins (workbenches, market installer, onboarding) rather than the
 * reduced mobile page the LAN bridge serves.
 *
 * Usage:
 *   node scripts/dsh-web-proxy.mjs [--upstream http://127.0.0.1:43129] [--port 43128]
 */
import { createReadStream, existsSync, chmodSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { gzipSync, brotliCompressSync, gunzipSync, constants } from 'node:zlib'
import { VOLT_ENDPOINT, injectVoltBadge, readVoltState } from './dsh-web-volt.mjs'
import { injectBootNotice } from './dsh-web-boot-notice.mjs'
import { clientArrivedOverHttps, relaxSessionCookies } from './dsh-web-session-cookie.mjs'
import { bundleCacheName } from './dsh-web-bundle-cache.mjs'
import {
  BUNDLE_URL_FORMAT,
  cacheableBundleUrl,
  cacheableRequestUrl,
  chunkRequestUrl,
  harnessBundleUrl,
  harnessChunkUrl,
  isBundlePath
} from './dsh-web-plugin-url.mjs'

const HARNESS_LOG = process.env.DSH_HARNESS_LOG ?? '/var/log/dsh-web.log'

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--upstream') options.upstream = argv[++index]
    else if (flag === '--port') options.port = Number(argv[++index])
    else if (flag === '--log') options.log = argv[++index]
  }
  return options
}

const args = parseArgs(process.argv.slice(2))
const logPath = args.log ?? HARNESS_LOG
const upstream = new URL(args.upstream ?? process.env.DSH_UPSTREAM ?? 'http://127.0.0.1:43129')
const port = args.port ?? 43128

/**
 * Whether the Session list is trimmed on its way through this proxy.
 *
 * The Harness answers `session/list` with every Session it can see, and each
 * one carries the full projection block. On a machine with a few hundred
 * Sessions that block is measured in megabytes, and 87% of it is
 * `contextHeaders` — the tool definitions that were sent to the model, one
 * snapshot per turn. A list of conversations needs a title and a timestamp,
 * not the tool schema of every turn; and no client reads the rest of what
 * the block carries.
 *
 * Trimming happens here rather than in the Harness because the proxy is
 * this deployment's own code. The Harness is a released package: changing
 * what it serves means replacing the package and restarting the Harness,
 * which drops the sessions in flight. The trimmed list has the same shape
 * as the one the Harness produces, so a client cannot tell the difference.
 *
 * Set DSH_PROXY_SESSION_LIST_TRIM=0 to pass the list through untouched.
 */
const TRIM_SESSION_LIST = process.env.DSH_PROXY_SESSION_LIST_TRIM !== '0'

/**
 * How many `contextHeaders` snapshots to keep — the newest ones.
 *
 * A snapshot is the tool set as it was at one point in the conversation, so
 * the newest one is the current context; the older ones are history that
 * only the context viewer draws, and each of them is a few kilobytes. Set
 * DSH_PROXY_SESSION_LIST_HEADERS=0 to drop them entirely.
 */
const SESSION_LIST_HEADER_KEEP = Math.max(0, Number(process.env.DSH_PROXY_SESSION_LIST_HEADERS ?? 1))

/**
 * Projection values that no client reads and that a list of conversations
 * does not need. Each one is a per-Session computation on the Harness side
 * as well as bytes on the wire.
 */
const SESSION_LIST_DROP_VALUES = new Set([
  'turnOutline',
  'tokenUsage',
  'sessionStats',
  'contextActivity',
  'subagentTiming',
  'subagentCatalog',
  'permissions',
  'modelSelection',
  'imageLimits',
  'sessionListMetadata'
])

/**
 * Drop the parts of a Session list that a list of conversations does not use.
 *
 * The payload is the Harness's own response, so the shape is left alone —
 * only the projection values are pruned.
 *
 * @param payload - the parsed `session/list` response
 * @returns the same payload, trimmed
 */
function trimSessionList(payload) {
  const items = payload?.result?.value?.items
  if (!Array.isArray(items)) return payload
  for (const item of items) {
    const values = item?.projections?.values
    if (values === undefined || values === null) continue
    for (const key of SESSION_LIST_DROP_VALUES) delete values[key]
    const context = values.contextHeaders
    if (context !== undefined && Array.isArray(context?.headers)) {
      values.contextHeaders = {
        ...context,
        headers: context.headers.slice(-SESSION_LIST_HEADER_KEEP)
      }
    }
  }
  return payload
}

/**
 * How long a trimmed Session list is reused, in milliseconds.
 *
 * Building the list costs the Harness a projection read per Session, and the
 * page asks for it on every load. The list changes when a Session changes,
 * which is not more than a couple of times a second while working, so a
 * second of reuse removes the repeated cost without holding a stale list
 * long enough to be noticed. Set DSH_PROXY_SESSION_LIST_CACHE_MS=0 to
 * rebuild it every time.
 */
const SESSION_LIST_CACHE_MS = Math.max(0, Number(process.env.DSH_PROXY_SESSION_LIST_CACHE_MS ?? 1000))

/** The most recently built Session list, and when it goes stale. */
let sessionListCache = { expiresAt: 0, body: null, headers: null }

/**
 * The launch token the Harness printed most recently.
 *
 * The Harness writes one `dsh web: http://.../?token=...` line per start, so
 * the last one belongs to the running process. The file is written by
 * systemd's append mode, so it may be read mid-write; a partially written
 * line simply does not match, and the previous token stays in use until the
 * new one is complete.
 */
/**
 * Whether the client accepts Brotli.
 *
 * The Harness compresses with gzip only — its webserver negotiates "gzip"
 * and "identity" and has no Brotli. Brotli is 15-20% smaller than gzip on
 * this kind of JavaScript, and the plugin graph is the largest thing a page
 * loads, so the difference is worth the pass.
 *
 * The upstream is asked for gzip whatever the client asked for, so the
 * proxy always has gzip to work from and can re-encode it to the encoding
 * the client understands.
 *
 * @param headers - the request headers
 * @returns whether the client listed `br` as acceptable
 */
function acceptsBrotli(headers) {
  const header = headers['accept-encoding']
  if (typeof header !== 'string') return false
  return header
    .split(',')
    .map((part) => part.split(';')[0].trim().toLowerCase())
    .includes('br')
}

/**
 * Re-encode a gzip body as Brotli.
 *
 * The body has to be held in memory to be re-encoded, so this is only used
 * for the client bundles, which are the large responses worth the pass.
 *
 * @param body - the gzip-compressed body from the upstream
 * @returns the Brotli-compressed body
 * @throws when the body is not gzip and cannot be decoded
 */
function toBrotli(body) {
  return brotliCompressSync(gunzipSync(body), {
    params: {
      // Quality 5 is where the curve flattens: on this kind of JavaScript
      // it is a few percent larger than quality 11 and an order of magnitude
      // faster to produce — which matters, because the body is re-encoded on
      // the way through. The window is left at its default; a larger one
      // buys very little on a 6 MB body and costs time.
      [constants.BROTLI_PARAM_QUALITY]: 5,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_GENERIC
    }
  })
}

/**
 * Where re-encoded bundles are kept.
 *
 * A bundle's revision is derived from its bytes, so a re-encoded body stays
 * correct for as long as that revision does — and the same revision is asked
 * for again on every cold start. Keeping the body on disk turns the
 * re-encoding from something that costs seconds into something that costs
 * a read.
 */
const BUNDLE_CACHE_DIR = join(
  process.env.DSH_HOME ?? join(process.env.HOME ?? '/home/averypi', '.dsh'),
  'proxy-cache',
  'bundles'
)

/** How many re-encoded bundles to keep before the oldest are dropped. */
const BUNDLE_CACHE_ENTRIES = 24

/** The revision a request asks for, if it asks for one. */
function bundleRevision(url) {
  return /[?&]rev=([A-Za-z0-9_-]+)/.exec(url)?.[1]
}

/**
 * The re-encoded body of a bundle, if it has been kept.
 *
 * @param revision - the revision the request asks for
 * @param path - the path of the resource, without its query
 * @returns the Brotli body, or undefined when there is none
 */
function cachedBundle(revision, path) {
  const name = bundleCacheName(revision, path)
  if (name === undefined) return undefined
  try {
    return readFileSync(join(BUNDLE_CACHE_DIR, name))
  } catch {
    return undefined
  }
}

/**
 * Keep a re-encoded bundle for the next request that asks for it.
 *
 * @param revision - the revision the request asked for
 * @param path - the path of the resource, without its query
 * @param body - the Brotli body
 */
function storeBundle(revision, path, body) {
  const name = bundleCacheName(revision, path)
  if (name === undefined) return
  try {
    mkdirSync(BUNDLE_CACHE_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(join(BUNDLE_CACHE_DIR, name), body)
  } catch {
    // A cache that cannot be written is not a failure: the body is still
    // served, it is just re-encoded next time.
    return
  }
  try {
    const kept = readdirSync(BUNDLE_CACHE_DIR)
      .filter((name) => name.endsWith('.br'))
      .map((name) => {
        const path = join(BUNDLE_CACHE_DIR, name)
        return { name, mtimeMs: statSync(path).mtimeMs }
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
    for (const entry of kept.slice(BUNDLE_CACHE_ENTRIES)) {
      unlinkSync(join(BUNDLE_CACHE_DIR, entry.name))
    }
  } catch {
    // The cache is an optimisation; failing to tidy it is not worth a
    // complaint.
  }
}

/**
 * The launch token, cached against the log's identity.
 *
 * The log is append-only and grows with every Harness start, so reading it
 * and matching every token in it on every request gets slower as it fills.
 * The file's mtime and size identify its content, so the parse is repeated
 * only when one of them changes — which is exactly when the token can have
 * changed, including the case where the last line is still being written.
 *
 * The token is also tied to the Harness it came from. The Harness rotates
 * its token on every restart, so the token of a Harness that has been
 * replaced is dead: injecting it produces a 401 that looks exactly like a
 * missing token and hides the real cause.
 */
let tokenCache = { mtimeMs: -1, size: -1, token: undefined, identity: '' }

/**
 * The file the captured launch token is kept in.
 *
 * The log is the only place the token is written down, and a log rotation
 * takes it with it. The proxy writes the token here as well, so that a
 * rotated log does not cost the site its access.
 */
const LAUNCH_TOKEN_FILE = process.env.DSH_LAUNCH_TOKEN_FILE ?? '/var/lib/dsh-web/launch-token'

/**
 * The identity of the running Harness, as a string.
 *
 * It is the PID and the process's start time: the PID alone can be reused
 * by an unrelated process, but the start time of a given PID never goes
 * backwards. An empty string means the Harness could not be found, in which
 * case no token can be tied to it.
 */
function harnessIdentity() {
  const pid = harnessPid()
  if (pid === null) return ''
  return `${pid}:${harnessStartedAt()}`
}

/**
 * The launch token captured from a previous run of this proxy.
 *
 * The file holds the Harness's identity as well as the token, and the token
 * is only used when that identity still matches the running Harness: a token
 * from a Harness that has been replaced is dead, and a dead token is worse
 * than no token because it turns a clear "the Harness is not running" into
 * an unexplained 401.
 */
function persistedLaunchToken() {
  let payload
  try {
    payload = JSON.parse(readFileSync(LAUNCH_TOKEN_FILE, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof payload?.token !== 'string' || payload.token === '') return undefined
  if (typeof payload.identity === 'string' && payload.identity !== harnessIdentity()) {
    return undefined
  }
  return payload.token
}

/**
 * Keep the launch token where the log cannot lose it.
 *
 * The file is written to a temporary name and renamed into place, so a
 * reader never sees a half-written file: this is read on every request and
 * a truncated file would be read as "no token".
 */
function persistLaunchToken(token, identity) {
  try {
    mkdirSync(dirname(LAUNCH_TOKEN_FILE), { recursive: true, mode: 0o700 })
    const temporary = `${LAUNCH_TOKEN_FILE}.tmp`
    writeFileSync(
      temporary,
      `${JSON.stringify({ token, identity, capturedAt: Date.now() })}\n`,
      { mode: 0o600 }
    )
    renameSync(temporary, LAUNCH_TOKEN_FILE)
    chmodSync(LAUNCH_TOKEN_FILE, 0o600)
  } catch {
    // The file is a fallback, not the source of truth: the log still is.
    return
  }
}

function currentLaunchToken() {
  const identity = harnessIdentity()
  // A Harness that has been replaced has a different token, so the cached
  // one cannot be reused even if the log has not changed.
  const identityChanged =
    tokenCache.identity !== '' && identity !== '' && tokenCache.identity !== identity

  let stats
  try {
    stats = statSync(logPath)
  } catch {
    return tokenCache.token ?? persistedLaunchToken()
  }
  if (
    !identityChanged &&
    stats.mtimeMs === tokenCache.mtimeMs &&
    stats.size === tokenCache.size
  ) {
    return tokenCache.token ?? persistedLaunchToken()
  }
  let content
  try {
    content = readFileSync(logPath, 'utf8')
  } catch {
    return tokenCache.token ?? persistedLaunchToken()
  }
  const matches = [...content.matchAll(/\?token=([A-Za-z0-9_-]+)/g)]
  const found = matches.at(-1)?.[1]
  if (found !== undefined) {
    tokenCache = { mtimeMs: stats.mtimeMs, size: stats.size, token: found, identity }
    persistLaunchToken(found, identity)
  } else if (identityChanged) {
    // The log holds no token and the Harness has been replaced: the cached
    // token belonged to a Harness that no longer exists.
    tokenCache = { mtimeMs: stats.mtimeMs, size: stats.size, token: undefined, identity }
  } else {
    // The log was truncated and the Harness is the same one: the token it
    // held is still the right one, so it is kept.
    tokenCache = {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      token: tokenCache.token,
      identity
    }
  }
  return tokenCache.token ?? persistedLaunchToken()
}

/** The Harness log, or an empty string when it cannot be read. */
function readLog() {
  if (!existsSync(logPath)) return ''
  try {
    return readFileSync(logPath, 'utf8')
  } catch {
    return ''
  }
}

/** How long ago the Harness log was last written, in seconds. */
function logAgeSeconds() {
  try {
    return Math.round((Date.now() - statSync(logPath).mtimeMs) / 1000)
  } catch {
    return null
  }
}

/**
 * When the Harness process started, in epoch milliseconds.
 *
 * The process's own start time is read from /proc, so it is exact and does
 * not depend on the log's format. A client bundle whose file is newer than
 * this was edited after the Harness published its revisions, which is the
 * usual reason a page refuses to mount.
 */
function harnessStartedAt() {
  const pid = harnessPid()
  if (pid === null) return 0
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // The start time is field 22, in clock ticks since boot.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ticks = Number(fields[19])
    const bootTime = readFileSync('/proc/stat', 'utf8')
    const match = bootTime.match(/^btime (\d+)$/m)
    if (!Number.isFinite(ticks) || match === null) return 0
    const hertz = 100
    return Number(match[1]) * 1000 + (ticks / hertz) * 1000
  } catch {
    return 0
  }
}

/**
 * The PID of the running Harness, if it can be found.
 *
 * The lookup scans every entry in /proc and reads each one's cmdline, which
 * on a busy machine is a thousand-odd file reads. That ran on every request
 * that needed the root page, so the result is cached and revalidated with a
 * single read: a cached PID that no longer answers has exited, and the
 * Harness's PID is not reused while the old process is gone.
 */
let cachedHarnessPid = null

function harnessPid() {
  const proc = process.env.DSH_HARNESS_PID
  if (proc !== undefined && /^[0-9]+$/.test(proc)) return Number(proc)
  if (cachedHarnessPid !== null) {
    try {
      readFileSync(`/proc/${cachedHarnessPid}/cmdline`, 'utf8')
      return cachedHarnessPid
    } catch {
      cachedHarnessPid = null
    }
  }
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(entry)) continue
      let cmd
      try {
        cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8')
      } catch {
        continue
      }
      if (cmd.includes('dsh') && cmd.includes('web') && cmd.includes('43129')) {
        cachedHarnessPid = Number(entry)
        return cachedHarnessPid
      }
    }
  } catch {
    // ignored
  }
  return null
}

/** The Profile's own node_modules, where local plugin links live. */
function profileModules() {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '/home/averypi', '.dsh')
  const candidate = join(home, 'profiles', 'web', 'node_modules')
  return existsSync(candidate) ? candidate : null
}

/** The repository's node_modules, where the Desktop host plugins live. */
function repoModules() {
  const candidate = join(process.env.DSH_REPO ?? process.cwd(), 'node_modules')
  return existsSync(candidate) ? candidate : null
}

/**
 * The Harness root page, which carries the advertised module graph.
 *
 * Synchronous on purpose: the diagnosis runs inside a request handler and
 * has to answer before the response is written.
 *
 * Fetching it spawns a Node process, which costs a few hundred milliseconds
 * and blocks this proxy's event loop while it runs. The page only changes
 * when the Harness restarts — its start time changes with it, and so does
 * the launch token the page is minted from — so the result is cached and
 * the cache is invalidated by either of those.
 */
let rootHtmlCache = { startedAt: -1, token: undefined, html: null }

function rootHtml() {
  const token = currentLaunchToken()
  if (token === undefined) return null
  const startedAt = harnessStartedAt()
  if (
    rootHtmlCache.html !== null &&
    rootHtmlCache.startedAt === startedAt &&
    rootHtmlCache.token === token
  ) {
    return rootHtmlCache.html
  }
  const html = fetchRootHtml(token)
  if (html === null) return null
  rootHtmlCache = { startedAt, token, html }
  return html
}

/**
 * Ask the Harness for its root page, following the token exchange.
 *
 * The exchange has to happen in a separate process: the Harness signs its
 * session cookie against the request authority, and the cookie this call
 * mints must not be reused for the caller's own request.
 */
function fetchRootHtml(token) {
  const url = new URL(upstream.origin)
  const script = `
    const http = require('node:http')
    const token = ${JSON.stringify(token)}
    const origin = { hostname: ${JSON.stringify(url.hostname)}, port: ${Number(url.port || 80)} }
    // The Harness answers a root request that carries the launch token with
    // a 303 to "./" and a session cookie. The redirect therefore has to be
    // followed *with* that cookie, or the second request is a 401.
    let cookie = ''
    const fetchRoot = (path, redirects) => {
      const headers = { host: origin.hostname + ':' + origin.port }
      if (cookie !== '') headers.cookie = cookie
      const request = http.request({ ...origin, path, method: 'GET', headers }, (response) => {
        const setCookie = response.headers['set-cookie']
        if (Array.isArray(setCookie)) {
          for (const entry of setCookie) {
            const pair = entry.split(';')[0]
            if (pair.startsWith('dsh-auth-')) cookie = pair
          }
        }
        const location = response.headers.location
        if (response.statusCode >= 300 && response.statusCode < 400 && location && redirects > 0) {
          response.resume()
          // The Harness redirects to a *relative* "./", which resolves
          // against the request path, not the origin.
          const target = new URL(location, 'http://' + origin.hostname + ':' + origin.port + path)
          fetchRoot(target.pathname + target.search, redirects - 1)
          return
        }
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { body += chunk })
        response.on('end', () => { process.stdout.write(body) })
      })
      request.on('error', () => {})
      request.end()
    }
    fetchRoot('/?token=' + encodeURIComponent(token), 3)
  `
  try {
    return execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 32 * 1024 * 1024
    })
  } catch {
    return null
  }
}

/**
 * Rewrite the request URL for the upstream.
 *
 * The Harness mints its session cookie only from a root request that carries
 * the launch token, and it answers a *root request that already has a valid
 * cookie* with a 303 redirect to `./`. So the token must be injected exactly
 * once: on the first, cookie-less request. Injecting it on every request
 * would send every later request back through the minting branch and the
 * browser would loop on the redirect.
 *
 * The raw path is manipulated as a string on purpose. Cordis loads plugin
 * bundles from `plugins/??<comma-separated list>&rev=<hash>`, and the `??`
 * makes a URL parser treat everything after the first `?` as a query string —
 * which would truncate the path to `/plugins/` and 404 the request.
 */
function rewriteUrl(rawUrl, hasSessionCookie) {
  // The proxy's marker is removed before the URL goes upstream. The Harness
  // reads a chunk's `rev` and ignores the rest — but a URL it cannot parse
  // is answered with the bundle it has, not with the chunk that was asked
  // for. The marker exists for the edge cache, which sees the URL before
  // this point and never sees it again.
  const raw = harnessChunkUrl(harnessBundleUrl(rawUrl ?? '/'))
  // Split off a real query string, if any. A `??` starts Cordis's plugin
  // list, not a query, so only a single `?` marks one.
  const questionMark = raw.indexOf('?')
  const hasQuery = questionMark >= 0 && raw[questionMark + 1] !== '?'
  let path = hasQuery ? raw.slice(0, questionMark) : raw
  let search = hasQuery ? raw.slice(questionMark) : ''

  // `/connect` is the launch-token exchange for the API carrier: it trades the
  // token for the version-2 cookie that `/api/remote.mux` then requires. The
  // browser holds a version-1 cookie from the root page, which that route
  // does not accept, so the token has to be injected here even though the
  // request already carries a cookie.
  //
  // The token is only good for the root page: the Harness exchanges it for a
  // session cookie there and nowhere else. Appending it to any other path
  // turns the request into one the Harness answers with 404 — and a 404 that
  // an edge cache is willing to keep.
  const isRoot = path === '/' || path === '' || path === './'
  const needsToken = (isRoot && !hasSessionCookie) || path === '/connect'

  if (needsToken) {
    const token = currentLaunchToken()
    // A URL that already carries a token must not get a second one. The
    // Harness prints its root URL with the token in it, and a person who
    // copies that URL to this proxy would otherwise send it upstream as
    // `?token=a&token=b` — which the Harness answers with 401.
    if (token && !/[?&]token=/.test(search)) {
      search = search ? `${search}&token=${encodeURIComponent(token)}` : `?token=${encodeURIComponent(token)}`
    }
  } else {
    // Drop any token the client sent; the cookie already authenticates it.
    search = search.replace(/([?&])token=[^&]*/g, '$1').replace(/^&/, '?')
    if (search === '?') search = ''
  }

  return {
    path,
    search,
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
    protocol: upstream.protocol
  }
}

/**
 * The authority a session cookie was minted for, if it can be read.
 *
 * The cookie carries a base64 payload that names the authority it belongs
 * to. The Harness binds the cookie to that authority and rejects a request
 * whose authority differs, so the proxy can tell whether the cookie in the
 * browser's hand is the one this request needs — and, when it is not,
 * exchange a fresh one instead of forwarding a cookie that would be
 * refused.
 */
function cookieAuthority(value) {
  const equals = value.indexOf('=')
  if (equals < 0) return undefined
  // The value is `v1.<payload>.<signature>`; only the payload carries the
  // authority. Decoding the whole value would fold the signature into the
  // JSON and fail to parse, which would make every cookie look unusable.
  const payload = value.slice(equals + 1).split('.')[1]
  if (payload === undefined || payload === '') return undefined
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
    return typeof decoded.authority === 'string' ? decoded.authority : undefined
  } catch {
    // A cookie that does not decode is treated as unusable.
    return undefined
  }
}

/**
 * The session cookies in a request, reduced to the ones this authority can use.
 *
 * A browser can hold session cookies for several authorities at once — the
 * public domain and the LAN address, say — and it sends every cookie whose
 * domain matches to a host that matches. The Harness binds each cookie to
 * the authority it was minted for and refuses a request whose cookie belongs
 * to another one, so the cookies for other authorities are dropped here
 * instead of being forwarded.
 *
 * Returns the cookie header to send upstream, or undefined when the request
 * should carry no session cookie at all.
 */
function sessionCookiesFor(headers, authority) {
  const cookie = headers.cookie
  if (typeof cookie !== 'string') return undefined
  const kept = []
  let usable = false
  for (const segment of cookie.split(';')) {
    const text = segment.trim()
    if (text === '') continue
    if (!text.startsWith('dsh-auth-')) {
      kept.push(text)
      continue
    }
    const minted = cookieAuthority(text)
    if (minted !== undefined && minted === authority) {
      kept.push(text)
      usable = true
    }
  }
  if (!usable) return undefined
  return kept.join('; ')
}

/**
 * Whether the request already carries a session cookie for this authority.
 *
 * The authority is the one the request is addressed to — behind nginx that
 * is the authority nginx normalised the request to, which is what the
 * Harness will compare against.
 */
function hasSessionCookie(headers, authority) {
  return sessionCookiesFor(headers, authority) !== undefined
}

/**
 * A diagnosis page, served by the proxy rather than the Harness.
 *
 * The question this answers is "why does the page not load?", and the usual
 * answer is one of two things that look identical from the outside: the
 * browser holds a stale client-bundle revision, or the Harness is not
 * running. The proxy can tell them apart — it reads the launch token from
 * the Harness log and can compare the served bundle revisions against the
 * files on disk.
 */
function diagnose() {
  const token = currentLaunchToken()
  const age = logAgeSeconds()

  const checks = []
  checks.push({
    name: 'harness',
    ok: token !== undefined,
    detail:
      token === undefined
        ? 'no launch token in the log — the Harness is not running'
        : `launch token present, log written ${age}s ago`
  })

  // The Harness derives a client bundle's revision from the entry's mtime,
  // ctime and size. A revision it no longer knows returns 404, and the
  // module graph then fails with "required client modules failed to
  // activate" — so a bundle whose file changed after the Harness started is
  // the single most common cause of a page that will not mount.
  const stale = []
  const startedAt = harnessStartedAt()
  for (const [id, revision] of advertisedRevisions()) {
    const file = clientEntryPath(id)
    if (file === null) continue
    let mtimeMs
    try {
      mtimeMs = statSync(file).mtimeMs
    } catch {
      continue
    }
    if (mtimeMs > startedAt) {
      stale.push({ id, revision, modified: new Date(mtimeMs).toISOString() })
    }
  }
  checks.push({
    name: 'client-bundle-revisions',
    ok: stale.length === 0,
    detail:
      stale.length === 0
        ? 'every bundle matches its advertised revision'
        : `${stale.length} bundle(s) changed after the Harness started: ${stale
            .map((entry) => entry.id)
            .join(', ')} — restart the Harness`
  })

  return {
    ok: checks.every((check) => check.ok),
    checks,
    stale,
    note: 'A stale revision is fixed by restarting the Harness service; the browser cache is not the problem in that case.'
  }
}

/** The revision the Harness advertises for each client bundle. */
function advertisedRevisions() {
  const revisions = new Map()
  const html = rootHtml()
  if (html === null) return revisions
  const pattern = /\{"id":"([^"]+)","url":"([^"]+)"[^}]*?"rev":"([^"]+)"/g
  let match
  while ((match = pattern.exec(html)) !== null) {
    revisions.set(match[1], match[3])
  }
  return revisions
}

/** Where a client bundle's entry lives, if it is a local package. */
function clientEntryPath(id) {
  for (const root of [profileModules(), repoModules()]) {
    if (root === null) continue
    const candidate = join(root, id, 'client.js')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * The machine's power state, read once and shared.
 *
 * Reading it costs a subprocess — the kernel log is read to count the
 * under-voltage events — and the badge polls it every few seconds, so the
 * reading is cached for a short while. A read that fails is reported as
 * `null`: the badge then says "unknown", which is honest, instead of
 * claiming a healthy rail it never saw.
 */
const VOLT_STATE_TTL_MS = 5000
let voltStateCache = { expiresAt: -1, state: null, pending: null }

function voltState() {
  if (voltStateCache.state !== null && voltStateCache.expiresAt > Date.now()) {
    return Promise.resolve(voltStateCache.state)
  }
  if (voltStateCache.pending !== null) return voltStateCache.pending
  voltStateCache.pending = readVoltState()
    .then((state) => {
      voltStateCache = { expiresAt: Date.now() + VOLT_STATE_TTL_MS, state, pending: null }
      return state
    })
    .catch((error) => {
      console.error(`dsh web proxy: the power state could not be read: ${error.message}`)
      voltStateCache = { expiresAt: Date.now() + VOLT_STATE_TTL_MS, state: null, pending: null }
      return null
    })
  return voltStateCache.pending
}

/**
 * The read-only endpoints the page polls.
 *
 * They are asked for every few seconds by every open page, and they answer
 * with state that does not change from one second to the next: whether the
 * Host needs a restart, what the machine's power state is, what the market
 * offers. Letting an edge cache hold them for a few seconds takes those
 * requests off the tunnel entirely, and the tunnel is the slow path — a
 * request that never reaches it is a request nobody waits for.
 *
 * They are only worth caching because they are GET requests, and only
 * because they hold nothing sensitive: a state that names the machine, and
 * no more. An edge cache ignores cookies, so what they hold is public to
 * anyone who knows the domain — which is already the case for the site as a
 * whole.
 */
const POLLABLE_PATHS = new Set([
  '/__volt',
  '/api/desktop-workbenches/restart-status',
  '/api/desktop-workbenches/market-installs',
  '/plugins/dsh-agent-teams/state'
])

/** How long an edge cache may hold a polled answer. */
const POLLABLE_CACHE_CONTROL = 'public, max-age=5, stale-while-revalidate=60'

const server = createServer((clientRequest, clientResponse) => {
  const requestUrl = clientRequest.url ?? '/'

  if (requestUrl === '/healthz' || requestUrl === '/healthz/') {
    const report = diagnose()
    clientResponse.writeHead(report.ok ? 200 : 503, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    clientResponse.end(`${JSON.stringify(report, null, 2)}\n`)
    return
  }

  // The authority this request is addressed to. The Harness binds its
  // session cookie to the authority it sees, so a cookie minted for a
  // different one has to be dropped rather than forwarded.
  const authority = clientRequest.headers.host
  const carriesSession = hasSessionCookie(clientRequest.headers, authority)

  // Only the root page can be served without a session, and there the
  // launch token is exchanged for one. Answering anything else here keeps
  // the failure out of the edge cache: a 404 the cache is willing to keep
  // would be handed to every later visitor of that URL.
  if (!carriesSession && requestUrl !== '/connect') {
    const isRootRequest = requestUrl === '/' || requestUrl === '' || requestUrl.startsWith('/?')
    if (!isRootRequest) {
      clientResponse.writeHead(401, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store'
      })
      clientResponse.end('dsh web: a session is required for this request\n')
      return
    }
  }

  // The machine's power state, for the badge the page carries.
  //
  // It is read from the kernel log and the voltage sensor, so it says
  // something about the machine rather than about the page — but it still
  // needs a session, which the guard above has already asked for: the proxy
  // is reachable from outside the machine through the tunnel, and the
  // readings (temperature, load, uptime) are the machine's business rather
  // than the world's. The badge is only on a page that has a session, so
  // requiring one costs nothing.
  if (requestUrl === VOLT_ENDPOINT || requestUrl === `${VOLT_ENDPOINT}/`) {
    voltState()
      .then((state) => {
        clientResponse.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': POLLABLE_CACHE_CONTROL
        })
        clientResponse.end(`${JSON.stringify(state)}\n`)
      })
      .catch((error) => {
        clientResponse.writeHead(503, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store'
        })
        clientResponse.end(`${JSON.stringify({ error: error.message })}\n`)
      })
    return
  }

  const target = rewriteUrl(requestUrl, carriesSession)

  // Whether the client would rather have Brotli than the gzip the Harness
  // produces. The bundle path re-encodes the body when this is true.
  const wantsBrotli = acceptsBrotli(clientRequest.headers)

  // A bundle that has already been re-encoded is served from disk. The
  // re-encoding costs seconds, and the same revision is asked for again on
  // every cold start — so the second time around it costs a read.
  //
  // The cache is keyed on the resource as well as on the revision: a bundle
  // and its package-local chunks share one revision, and they are different
  // bodies.
  const revision = bundleRevision(`${target.path}${target.search}`)
  const resourcePath = target.path
  if (wantsBrotli && revision !== undefined) {
    const cached = cachedBundle(revision, resourcePath)
    if (cached !== undefined) {
      clientResponse.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-encoding': 'br',
        'content-length': String(cached.length),
        'cache-control': 'public, max-age=31536000, immutable',
        vary: 'Accept-Encoding'
      })
      clientResponse.end(cached)
      return
    }
  }

  // A request that still uses the Harness's own bundle URL is pointed at the
  // cacheable form, so that the bundle it asks for can be kept by an edge
  // cache instead of being pulled through the tunnel on every load.
  const cacheable = cacheableRequestUrl(requestUrl)
  if (cacheable !== undefined) {
    clientResponse.writeHead(302, {
      location: cacheable,
      'cache-control': 'no-store'
    })
    clientResponse.end()
    return
  }

  // A package-local chunk is pointed at the same shape of URL, for the same
  // reason: the edge cache keys on the whole URL, so a marker on it gives
  // the chunk an entry of its own. A chunk without one shares the entry of
  // whatever was fetched under that URL before — and what was fetched there
  // was, once, the bundle: the browser then ran the bundle in the chunk's
  // place, and the module system refused the second registration of the
  // same factory.
  const markedChunk = chunkRequestUrl(requestUrl)
  if (markedChunk !== undefined) {
    clientResponse.writeHead(302, {
      location: markedChunk,
      'cache-control': 'no-store'
    })
    clientResponse.end()
    return
  }
  const headers = { ...clientRequest.headers }
  // The Harness signs its session cookie against the request authority, so the
  // Host header has to stay the one the browser used. Rewriting it to the
  // upstream authority would make the Harness mint a cookie for a host the
  // browser never talks to, and every later request would come back 401.
  delete headers['content-length']

  // The upstream is asked for gzip whatever the client asked for.
  //
  // The Harness negotiates "gzip" and "identity" and has no Brotli, so a
  // client that lists only `br` would be answered with an uncompressed
  // body. Asking for gzip instead means there is always a compressed body
  // to re-encode — and a client that wanted gzip gets exactly that.
  if (target.path.startsWith('/plugins/') && wantsBrotli) {
    headers['accept-encoding'] = 'gzip'
  }
  // Only the cookies minted for this authority may travel upstream. A cookie
  // for another authority — from a different entry point, or from before a
  // restart — would make the Harness refuse the request; dropping it lets
  // the launch token that `rewriteUrl` just injected mint a usable one.
  const usableCookies = sessionCookiesFor(clientRequest.headers, authority)
  if (usableCookies === undefined) {
    delete headers.cookie
  } else if (usableCookies !== clientRequest.headers.cookie) {
    headers.cookie = usableCookies
  }

  // The Session list is trimmed below, which needs the body as text. Asking
  // the Harness for it uncompressed saves the Harness from compressing a
  // body that is about to be thrown away, and leaves the compressed bytes
  // to be produced once, after the trim.
  const trimsSessionList = TRIM_SESSION_LIST && target.path === '/api/session/list'
  if (trimsSessionList) {
    // A list that was built moments ago is reused rather than rebuilt: the
    // Harness reads a projection per Session to produce one, and the page
    // asks for it on every load.
    if (sessionListCache.body !== null && sessionListCache.expiresAt > Date.now()) {
      clientResponse.writeHead(200, sessionListCache.headers)
      clientResponse.end(sessionListCache.body)
      return
    }
    delete headers['accept-encoding']
  }

  // The Harness's root page carries the plugin graph, and the URLs in it are
  // rewritten so that an edge cache can keep them. Rewriting the page means
  // holding it in memory, so its body is asked for as text.
  const rewritesHtml = target.path === '/' || target.path === '' || target.path.endsWith('.html')
  if (rewritesHtml) delete headers['accept-encoding']

  const forward = target.protocol === 'https:' ? httpsRequest : httpRequest
  const upstreamRequest = forward(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      // The query travels with the path: the launch token is carried in it
      // when the request is the root page and there is no session yet.
      path: `${target.path}${target.search}`,
      method: clientRequest.method,
      headers
    },
    (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers }
      // The session cookie is issued with `SameSite=Strict`, which a browser
      // withholds from a cross-site arrival — and the token exchange is a
      // redirect, so the cookie is set by one response and read by the next.
      // Withheld, the exchange never finishes and the browser gives up on
      // "redirected you too many times". Lax keeps the protection that
      // matters (no cross-site POST, no subresource) and lets the
      // navigation that has to work through.
      const secure = clientArrivedOverHttps(clientRequest.headers)
      if (responseHeaders['set-cookie'] !== undefined) {
        responseHeaders['set-cookie'] = relaxSessionCookies(responseHeaders['set-cookie'], secure)
      }
      // The Harness redirects to a relative path after the token exchange, so
      // the Location header stays usable behind the proxy.
      //
      // Cache policy. The client bundles are content-addressed: the
      // revision in `plugins/??…&rev=<hash>` is derived from the bundle's
      // mtime, ctime and size, so a given revision always maps to the same
      // bytes. The upstream Harness already states this — it answers a
      // revisioned bundle with `public, max-age=31536000, immutable`.
      //
      // This proxy used to override that with `no-store, must-revalidate`,
      // which made every page reload re-download the whole plugin graph
      // (~4 MB compressed). The override was defending against a stale
      // revision — a browser asking for a revision the server no longer
      // has — but that case is already safe: the revision changes with the
      // bytes, so a stale URL 404s instead of serving wrong content, and
      // the module graph reports it. A revisioned bundle can therefore be
      // cached forever.
      //
      // A `/plugins/` URL *without* a revision is not content-addressed (the
      // same path can serve different bytes after a rebuild), so it stays
      // revalidated. `/assets/*` files carry a build hash in their name and
      // are immutable for the same reason as a revisioned bundle.
      //
      // A package-local chunk is a third case. It carries a revision, but
      // it borrows the one of the bundle it was cut from, and that revision
      // moves whenever any plugin in that bundle's list changes — even when
      // the chunk's own bytes have not. Caching it as immutable would keep
      // a stale chunk for the whole year the edge is told to keep it, and
      // a stale chunk is a chunk that never loads: the browser runs a
      // different bundle in its place, and the module system refuses the
      // duplicate registration. A chunk is therefore revalidated like an
      // unversioned path, and the edge keeps it for a short while only.
      const urlWithQuery = `${target.path}${target.search}`
      const hasRevision = /[?&]rev=/.test(urlWithQuery)
      const isBundle = target.path.startsWith('/plugins/') && isBundlePath(target.path)
      if (clientRequest.method === 'GET' && POLLABLE_PATHS.has(target.path)) {
        responseHeaders['cache-control'] = POLLABLE_CACHE_CONTROL
      } else if (target.path.startsWith('/plugins/')) {
        responseHeaders['cache-control'] = hasRevision && isBundle
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=60, must-revalidate'
      } else if (target.path.startsWith('/assets/')) {
        responseHeaders['cache-control'] = 'public, max-age=31536000, immutable'
      } else if (target.path.startsWith('/dsh-desktop-logo')) {
        responseHeaders['cache-control'] = 'public, max-age=86400'
      } else if (target.path.endsWith('/manifest.webmanifest')) {
        // The manifest carries no build hash, and a stale one points the
        // installed app at assets that no longer exist — so it is
        // revalidated rather than cached.
        responseHeaders['cache-control'] = 'no-cache'
      }

      // A revisioned bundle is content-addressed, so it can be cached forever;
      // the proxy used to override the Harness's own `immutable` with
      // `no-store`, which made every reload re-download ~4 MB. A failure is
      // never cached: a 404 caused by a transient fault would otherwise be
      // handed to every later visitor.
      if ((upstreamResponse.statusCode ?? 502) >= 400) {
        responseHeaders['cache-control'] = 'no-store'
      }

      // Brotli for the client bundles.
      //
      // The Harness answers with gzip, and the browser may well have asked
      // for gzip too — in which case the bytes on the wire are gzip's and
      // the client decodes them as gzip. But a browser that lists `br` gets
      // Brotli instead, which is 15-20% smaller on this kind of JavaScript.
      //
      // The body is held in memory to be re-encoded, so this is limited to
      // the plugin bundles, which are the large responses worth the pass.
      // A body that cannot be decoded is forwarded as it arrived.
      if (
        target.path.startsWith('/plugins/') &&
        wantsBrotli &&
        upstreamResponse.statusCode === 200 &&
        (responseHeaders['content-encoding'] ?? '').toLowerCase() === 'gzip'
      ) {
        const chunks = []
        upstreamResponse.on('data', (chunk) => chunks.push(chunk))
        upstreamResponse.on('end', () => {
          const raw = Buffer.concat(chunks)
          const brotli = { ...responseHeaders }
          delete brotli['content-length']
          delete brotli['transfer-encoding']
          try {
            const body = toBrotli(raw)
            storeBundle(bundleRevision(`${target.path}${target.search}`), resourcePath, body)
            brotli['content-encoding'] = 'br'
            brotli['content-length'] = String(body.length)
            brotli['vary'] = 'Accept-Encoding'
            clientResponse.writeHead(upstreamResponse.statusCode ?? 502, brotli)
            clientResponse.end(body)
          } catch {
            // A body that is not gzip after all is forwarded unchanged.
            clientResponse.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
            clientResponse.end(raw)
          }
        })
        clientResponse.on('error', () => {
          upstreamResponse.destroy()
        })
        upstreamResponse.on('error', () => {
          clientResponse.destroy()
        })
        return
      }

      // The root page is rewritten so that the plugin graph it advertises
      // points at URLs an edge cache will keep. The page is small, so
      // holding it in memory costs nothing.
      if (rewritesHtml && upstreamResponse.statusCode === 200) {
        const chunks = []
        upstreamResponse.on('data', (chunk) => chunks.push(chunk))
        upstreamResponse.on('end', () => {
          const raw = Buffer.concat(chunks)
          const page = { ...responseHeaders }
          delete page['content-length']
          delete page['transfer-encoding']
          try {
            // The page carries the badge that shows the machine's power
            // state, so a brownout is visible to whoever is looking at it.
            // It also carries the notice that says the app is still coming
            // up, with a retry button — the plugin graph is several
            // megabytes, and a reader on a slow link would otherwise be
            // looking at a white screen with no way to tell.
            const rewritten = injectBootNotice(injectVoltBadge(cacheableBundleUrl(raw.toString('utf8'))))
            const body = Buffer.from(rewritten, 'utf8')
            page['content-length'] = String(body.length)
            // The page is different every time: the badge carries the
            // machine's current power state, the notice says whether the
            // app is still coming up, and the plugin graph carries the
            // revision of every bundle. A browser that keeps it would
            // come back to a page that points at bundles this server no
            // longer has — and one that says the machine is healthy when
            // it is not.
            page['cache-control'] = 'no-store'
            clientResponse.writeHead(upstreamResponse.statusCode ?? 502, page)
            clientResponse.end(body)
          } catch {
            // A page that cannot be rewritten is served as it arrived.
            clientResponse.writeHead(upstreamResponse.statusCode ?? 502, page)
            clientResponse.end(raw)
          }
        })
        clientResponse.on('error', () => {
          upstreamResponse.destroy()
        })
        upstreamResponse.on('error', () => {
          clientResponse.destroy()
        })
        return
      }

      // The Session list is trimmed rather than streamed, so its body has to
      // be held in memory before anything can be written. Everything else
      // is passed through untouched.
      if (trimsSessionList && upstreamResponse.statusCode === 200) {
        const chunks = []
        upstreamResponse.on('data', (chunk) => chunks.push(chunk))
        upstreamResponse.on('end', () => {
          const raw = Buffer.concat(chunks)
          const trimmed = { ...responseHeaders }
          delete trimmed['content-length']
          delete trimmed['transfer-encoding']
          try {
            const payload = trimSessionList(JSON.parse(raw.toString('utf8')))
            const body = gzipSync(JSON.stringify(payload))
            trimmed['content-encoding'] = 'gzip'
            trimmed['content-length'] = String(body.length)
            trimmed['vary'] = 'Accept-Encoding'
            if (SESSION_LIST_CACHE_MS > 0) {
              sessionListCache = { expiresAt: Date.now() + SESSION_LIST_CACHE_MS, body, headers: trimmed }
            }
            clientResponse.writeHead(upstreamResponse.statusCode ?? 502, trimmed)
            clientResponse.end(body)
          } catch {
            // A body that does not parse is forwarded as it arrived, so a
            // change in the Harness's response shape cannot break the list.
            clientResponse.writeHead(upstreamResponse.statusCode ?? 502, trimmed)
            clientResponse.end(raw)
          }
        })
        clientResponse.on('error', () => {
          upstreamResponse.destroy()
        })
        upstreamResponse.on('error', () => {
          clientResponse.destroy()
        })
        return
      }

      clientResponse.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
      // The browser can go away mid-response. An unhandled 'error' on the
      // socket would take the proxy down with it.
      clientResponse.on('error', () => {
        upstreamResponse.destroy()
      })
      upstreamResponse.on('error', () => {
        clientResponse.destroy()
      })
      upstreamResponse.pipe(clientResponse)
    }
  )

  clientRequest.on('error', () => {
    upstreamRequest.destroy()
  })
  clientResponse.on('error', () => {
    upstreamRequest.destroy()
  })

  upstreamRequest.on('error', (error) => {
    clientResponse.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    clientResponse.end(`DSH upstream unavailable: ${error.message}\n`)
  })

  if (clientRequest.method === 'GET' || clientRequest.method === 'HEAD') {
    clientRequest.resume()
    upstreamRequest.end()
    return
  }
  clientRequest.pipe(upstreamRequest)
})

/**
 * Forward a WebSocket upgrade.
 *
 * The Harness multiplexes every server-push stream over one WebSocket at
 * `/api/remote.mux`. Without this the browser's WebSocket never opens, and
 * the surfaces that read from a stream — the workspace list, live session
 * events — stay empty while the rest of the page looks fine.
 *
 * The request headers are forwarded as they arrive: the Host must stay the
 * browser's, because the Harness signs its session cookie against that
 * authority and the browser already holds the cookie.
 */
server.on('upgrade', (clientRequest, clientSocket, clientHead) => {
  // The mux socket may arrive without the version-2 cookie, so the launch
  // token is injected here too when the request carries none.
  const headers = { ...clientRequest.headers }
  const authority = clientRequest.headers.host
  if (!hasSessionCookie(headers, authority)) {
    const token = currentLaunchToken()
    if (token) {
      const separator = clientRequest.url?.includes('?') ? '&' : '?'
      clientRequest.url = `${clientRequest.url ?? '/'}${separator}token=${encodeURIComponent(token)}`
    }
    // A cookie minted for another authority would be refused upstream.
    delete headers.cookie
  }
  const upstreamRequest = httpRequest({
    hostname: upstream.hostname,
    port: upstream.port || 80,
    path: clientRequest.url ?? '/',
    method: clientRequest.method,
    headers
  })

  upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    const responseHeaders = { ...upstreamResponse.headers }
    clientSocket.write(
      `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(responseHeaders)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
        .join('\r\n')}\r\n\r\n`
    )
    if (upstreamHead?.length) clientSocket.unshift(upstreamHead)
    if (clientHead?.length) upstreamSocket.unshift(clientHead)

    // A socket that dies mid-stream emits 'error'. Without a listener Node
    // treats it as an unhandled 'error' event and takes the whole process
    // down — a browser that navigates away during the handshake is enough
    // to kill the proxy, and every page load after that fails.
    const teardown = () => {
      clientSocket.destroy()
      upstreamSocket.destroy()
    }
    clientSocket.on('error', teardown)
    upstreamSocket.on('error', teardown)
    clientSocket.on('close', () => upstreamSocket.destroy())
    upstreamSocket.on('close', () => clientSocket.destroy())

    upstreamSocket.pipe(clientSocket)
    clientSocket.pipe(upstreamSocket)
  })

  upstreamRequest.on('response', (response) => {
    // The upstream refused the upgrade; answer the browser with the same
    // status instead of leaving the socket hanging.
    clientSocket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n\r\n`)
    clientSocket.end()
  })

  upstreamRequest.on('error', (error) => {
    console.warn(`[proxy] websocket upgrade failed: ${error.message}`)
    clientSocket.destroy()
  })

  // The browser can drop the socket before the upstream answers.
  clientSocket.on('error', () => {
    upstreamRequest.destroy()
  })

  upstreamRequest.end()
})

// A socket that dies mid-stream emits 'error'. Without a listener Node treats
// it as an unhandled 'error' event and takes the process down. That is not
// hypothetical: a browser that navigates away during the WebSocket
// handshake produced `Error: write EPIPE`, the proxy died, and every
// subsequent page load hung on "loading plugins".
process.on('uncaughtException', (error) => {
  console.warn(`[proxy] uncaught exception: ${error.message}`)
})

server.listen(port, '0.0.0.0', () => {
  console.log(`[proxy] listening on 0.0.0.0:${port} -> ${upstream.origin}`)
  console.log(`[proxy] harness log: ${logPath}`)
})

const shutdown = () => {
  // A live `/api/remote.mux` WebSocket keeps `server.close()` waiting, so the
  // unit would sit in "deactivating" until the browser gave up. Drop every
  // socket explicitly.
  server.closeAllConnections()
  server.close(() => process.exit(0))
  // Do not wait forever for a client that ignores the close.
  setTimeout(() => process.exit(0), 2_000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
