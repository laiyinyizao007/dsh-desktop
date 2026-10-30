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
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
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

const server = createServer((clientRequest, clientResponse) => {
  const target = rewriteUrl(clientRequest.url ?? '/', hasSessionCookie(clientRequest.headers))
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
      clientResponse.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
      upstreamResponse.pipe(clientResponse)
    }
  )

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

  upstreamRequest.end()
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
