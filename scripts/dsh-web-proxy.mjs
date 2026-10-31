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
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

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
 * The launch token the Harness printed most recently.
 *
 * The Harness writes one `dsh web: http://.../?token=...` line per start, so
 * the last one belongs to the running process. The file is written by
 * systemd's append mode, so it may be read mid-write; a partially written
 * line simply does not match, and the previous token stays in use until the
 * new one is complete.
 */
function currentLaunchToken() {
  if (!existsSync(logPath)) return undefined
  let content
  try {
    content = readFileSync(logPath, 'utf8')
  } catch {
    return undefined
  }
  const matches = [...content.matchAll(/\?token=([A-Za-z0-9_-]+)/g)]
  const last = matches.at(-1)
  return last?.[1]
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

/** The PID of the running Harness, if it can be found. */
function harnessPid() {
  const proc = process.env.DSH_HARNESS_PID
  if (proc !== undefined && /^[0-9]+$/.test(proc)) return Number(proc)
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
        return Number(entry)
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
 */
function rootHtml() {
  const token = currentLaunchToken()
  if (token === undefined) return null
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
  const raw = rawUrl ?? '/'
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
  const needsToken = !hasSessionCookie || path === '/connect'

  if (needsToken) {
    const token = currentLaunchToken()
    if (token) {
      search = search ? `${search}&token=${encodeURIComponent(token)}` : `?token=${encodeURIComponent(token)}`
    }
  } else {
    // Drop any token the client sent; the cookie already authenticates it.
    search = search.replace(/([?&])token=[^&]*/g, '$1').replace(/^&/, '?')
    if (search === '?') search = ''
  }

  return {
    path: `${path}${search}`,
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
    protocol: upstream.protocol
  }
}

/** Whether the browser already holds the Harness session cookie. */
function hasSessionCookie(headers) {
  const cookie = headers.cookie
  if (typeof cookie !== 'string') return false
  return cookie.split(';').some((segment) => segment.trim().startsWith('dsh-auth-'))
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

  const target = rewriteUrl(requestUrl, hasSessionCookie(clientRequest.headers))
  const headers = { ...clientRequest.headers }
  // The Harness signs its session cookie against the request authority, so the
  // Host header has to stay the one the browser used. Rewriting it to the
  // upstream authority would make the Harness mint a cookie for a host the
  // browser never talks to, and every later request would come back 401.
  delete headers['content-length']

  const forward = target.protocol === 'https:' ? httpsRequest : httpRequest
  const upstreamRequest = forward(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.path,
      method: clientRequest.method,
      headers
    },
    (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers }
      // The Harness redirects to a relative path after the token exchange, so
      // the Location header stays usable behind the proxy.
      //
      // The client bundles carry their revision in the query string, and the
      // Harness derives it from the file's mtime, ctime and size. A browser
      // that kept an old `plugins/??…&rev=…` URL therefore asks for a
      // revision the server no longer has, the request 404s, and the module
      // graph fails with "required client modules failed to activate". The
      // response is immutable for a given revision, but the *set* of
      // revisions changes whenever a bundle is rebuilt — so these must not be
      // cached by the browser.
      if (target.path.startsWith('/plugins/')) {
        responseHeaders['cache-control'] = 'no-store, must-revalidate'
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
  if (!hasSessionCookie(headers)) {
    const token = currentLaunchToken()
    if (token) {
      const separator = clientRequest.url?.includes('?') ? '&' : '?'
      clientRequest.url = `${clientRequest.url ?? '/'}${separator}token=${encodeURIComponent(token)}`
    }
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
