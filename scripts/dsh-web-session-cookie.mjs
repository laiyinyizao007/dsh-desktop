/**
 * The session cookie, on its way out to the browser.
 *
 * The Harness issues its session cookie with `SameSite=Strict`. That is the
 * right choice for an app that is only ever opened from its own links, and
 * the wrong one for an app that is reached the way a phone reaches this
 * one: a QR code, a chat message, a bookmark in another app. Every one of
 * those is a cross-site arrival.
 *
 * The launch-token exchange is a redirect — the cookie is set by the first
 * response and read by the second — so a browser that withholds the cookie
 * never finishes the exchange. It asks for a fresh token, is redirected
 * again, and gives up on "this page redirected you too many times". Nothing
 * loads: no stylesheet, no application, no workbench. The page that is
 * left behind is the bare shell, which is why it looks like the app
 * failed to start rather than like an authentication problem.
 *
 * `SameSite=Lax` still withholds the cookie from a cross-site POST and
 * from any subresource request, so it keeps the protection Strict gives.
 * What it gives up is the cross-site top-level navigation — which is
 * exactly the arrival that has to work.
 *
 * `Secure` is added for the same reason: a cookie that may cross sites
 * must not travel over plain HTTP, where it can be read off the wire. The
 * Harness also serves the LAN address over HTTP, and a browser drops a
 * `Secure` cookie on a plain connection, so the flag is added only when the
 * request that came in arrived over HTTPS.
 */

/**
 * Whether the client's own request arrived over HTTPS.
 *
 * The proxy is reached over plain HTTP even when the client used HTTPS:
 * the tunnel terminates TLS at the edge and speaks HTTP to nginx, which
 * speaks HTTP to the proxy. nginx therefore reports `http` in
 * `X-Forwarded-Proto`, and a cookie marked `Secure` on that basis would
 * never be sent back — the browser drops a `Secure` cookie on a plain
 * connection, and the exchange would never finish.
 *
 * The edge's own record of the scheme is the truth, and Cloudflare sends it
 * as `CF-Visitor`. A request that came straight in over HTTP carries no
 * such header, which is the answer in that case.
 *
 * @param headers - the client's request headers
 * @returns true when the client's request was encrypted
 */
export function clientArrivedOverHttps(headers) {
  if (headers === null || typeof headers !== 'object') return false
  const forwarded = (headers['x-forwarded-proto'] ?? '').toLowerCase()
  if (forwarded === 'https') return true
  const visitor = headers['cf-visitor']
  if (typeof visitor !== 'string') return false
  return /"scheme"\s*:\s*"https"/i.test(visitor)
}

/**
 * One `Set-Cookie` value, with its attributes made to survive an arrival.
 *
 * @param setCookie - the header value as the Harness sent it
 * @param secure - whether the client's request arrived over HTTPS
 * @returns the header value to send on
 */
export function relaxSessionCookie(setCookie, secure) {
  if (typeof setCookie !== 'string') return setCookie
  if (!/;\s*SameSite=Strict\s*(;|$)/i.test(setCookie)) return setCookie
  let relaxed = setCookie.replace(/;\s*SameSite=Strict\s*(;|$)/i, '; SameSite=Lax$1')
  if (secure && !/;\s*Secure\s*(;|$)/i.test(relaxed)) {
    relaxed = `${relaxed.replace(/;\s*$/, '')}; Secure`
  }
  return relaxed
}

/**
 * Every `Set-Cookie` header of a response, with the session cookie relaxed.
 *
 * @param setCookie - the header, as Node reports it: an array, or one string
 * @param secure - whether the client's request arrived over HTTPS
 * @returns the header to send on
 */
export function relaxSessionCookies(setCookie, secure) {
  if (Array.isArray(setCookie)) {
    return setCookie.map((entry) => relaxSessionCookie(entry, secure))
  }
  return relaxSessionCookie(setCookie, secure)
}
