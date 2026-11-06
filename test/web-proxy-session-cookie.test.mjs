import { describe, expect, it } from 'vitest'
import {
  clientArrivedOverHttps,
  relaxSessionCookie,
  relaxSessionCookies
} from '../scripts/dsh-web-session-cookie.mjs'

/**
 * The cookie the Harness issues, verbatim.
 *
 * `SameSite=Strict` is what it sends, and it is the reason a phone that
 * arrives from another app never gets past the token exchange: the browser
 * withholds a Strict cookie from a cross-site navigation, and the exchange
 * is a redirect.
 */
const HARNESS_COOKIE =
  'dsh-auth-DV9Q-NmFHvnf0utc3EHROODr5UJoNXerg0ttKeM9ovw=v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxMDAuODYuMjU1LjM0OjQzMTI5IiwiaXNzdWVkQXQiOiIxNzkzOTQ3MDg5NjY4LCJleHBpcmVzQXQiOjE3OTY1MzU1NjA1NjJ9.signature' +
  '; Max-Age=2592000; Path=/; Expires=Sun, 06 Dec 2026 06:42:07 GMT; HttpOnly; SameSite=Strict'

describe('relaxSessionCookie', () => {
  it('lets the cookie travel on a cross-site navigation', () => {
    const relaxed = relaxSessionCookie(HARNESS_COOKIE, false)

    expect(relaxed).toContain('SameSite=Lax')
    expect(relaxed).not.toContain('SameSite=Strict')
  })

  it('keeps the value, the lifetime and the other attributes', () => {
    const relaxed = relaxSessionCookie(HARNESS_COOKIE, false)

    expect(relaxed.startsWith('dsh-auth-DV9Q-')).toBe(true)
    expect(relaxed).toContain('Max-Age=2592000')
    expect(relaxed).toContain('Path=/')
    expect(relaxed).toContain('HttpOnly')
    expect(relaxed).toContain('Expires=Sun, 06 Dec 2026 06:42:07 GMT')
  })

  it('marks the cookie Secure when the request arrived over HTTPS', () => {
    const relaxed = relaxSessionCookie(HARNESS_COOKIE, true)

    expect(relaxed).toContain('SameSite=Lax')
    expect(relaxed).toContain('Secure')
  })

  it('leaves the cookie unmarked when the request arrived over plain HTTP', () => {
    const relaxed = relaxSessionCookie(HARNESS_COOKIE, false)

    expect(relaxed).not.toContain('Secure')
  })

  it('does not add a second Secure attribute', () => {
    const already = `${HARNESS_COOKIE}; Secure`
    const relaxed = relaxSessionCookie(already, true)

    expect(relaxed.split('Secure').length - 1).toBe(1)
  })

  it('leaves a cookie that is not Strict alone', () => {
    const lax = 'dsh-auth-x=v1.body.sig; Max-Age=1; Path=/; HttpOnly; SameSite=Lax'

    expect(relaxSessionCookie(lax, true)).toBe(lax)
  })

  it('leaves a cookie it cannot read alone', () => {
    expect(relaxSessionCookie(undefined, true)).toBeUndefined()
    expect(relaxSessionCookie('', true)).toBe('')
  })
})

describe('relaxSessionCookies', () => {
  it('relaxes every cookie of a response', () => {
    const relaxed = relaxSessionCookies([HARNESS_COOKIE, 'other=1; Path=/'], false)

    expect(Array.isArray(relaxed)).toBe(true)
    expect(relaxed[0]).toContain('SameSite=Lax')
    expect(relaxed[1]).toBe('other=1; Path=/')
  })

  it('handles a response that carries one cookie', () => {
    const relaxed = relaxSessionCookies(HARNESS_COOKIE, false)

    expect(relaxed).toContain('SameSite=Lax')
  })
})

describe('clientArrivedOverHttps', () => {
  it('trusts the scheme the proxy was told', () => {
    expect(clientArrivedOverHttps({ 'x-forwarded-proto': 'https' })).toBe(true)
    expect(clientArrivedOverHttps({ 'x-forwarded-proto': 'http' })).toBe(false)
  })

  it('asks the edge when the proxy only sees the tunnel', () => {
    // nginx overwrites X-Forwarded-Proto with its own scheme, so the edge's
    // record is the only one that knows how the client connected.
    expect(
      clientArrivedOverHttps({ 'x-forwarded-proto': 'http', 'cf-visitor': '{"scheme":"https"}' })
    ).toBe(true)
    expect(
      clientArrivedOverHttps({ 'x-forwarded-proto': 'http', 'cf-visitor': '{"scheme":"http"}' })
    ).toBe(false)
  })

  it('reports a request that came straight in over HTTP', () => {
    expect(clientArrivedOverHttps({})).toBe(false)
    expect(clientArrivedOverHttps({ 'cf-visitor': 'not json' })).toBe(false)
  })

  it('reports no headers as plain HTTP', () => {
    expect(clientArrivedOverHttps(undefined)).toBe(false)
    expect(clientArrivedOverHttps(null)).toBe(false)
  })
})
