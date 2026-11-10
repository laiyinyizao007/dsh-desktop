import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The proxy holds the answers the page asks for more than once in the same
 * moment.
 *
 * The behaviour that matters is not that a value is remembered — it is
 * that the Host is asked once. This runs a real proxy against a Host that
 * counts what it was asked, and asks for the same answer twice.
 */
const PROXY = join(process.cwd(), 'scripts', 'dsh-web-proxy.mjs')


/**
 * A session cookie for the authority the proxy is addressed to.
 *
 * The proxy drops a cookie whose authority is not the one it is asked
 * for, and it answers 401 to a request that carries none. The value is
 * `v1.<payload>.<signature>`; only the payload carries the authority, and
 * the proxy does not check the signature — it only reads the payload to
 * learn which authority the cookie belongs to.
 */
function sessionCookie(authority) {
  const payload = Buffer.from(JSON.stringify({ version: 1, authority }), 'utf8').toString('base64')
  return `dsh-auth-test=v1.${payload}.signature`
}

describe('the proxy holding an answer', () => {
  let upstream
  let proxy
  let proxyPort
  let asked
  let authority
  let cookie
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-cache-'))

  beforeAll(async () => {
    // The Host: it answers every request, and it counts.
    asked = new Map()
    upstream = createServer((request, response) => {
      const path = request.url ?? '/'
      asked.set(path, (asked.get(path) ?? 0) + 1)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ path, asked: asked.get(path) }))
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
    const upstreamPort = upstream.address().port

    proxyPort = 40000 + Math.floor(Math.random() * 20000)
    authority = `127.0.0.1:${proxyPort}`
    cookie = sessionCookie(authority)
    proxy = spawn(
      process.execPath,
      [PROXY, '--port', String(proxyPort), '--upstream', `http://127.0.0.1:${upstreamPort}`, '--log', join(dir, 'proxy.log')],
      { stdio: 'ignore' }
    )
    // Wait for the proxy to answer.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${proxyPort}/__volt`)
        if (response.status !== undefined) break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  })

  afterAll(() => {
    proxy?.kill()
    upstream?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('asks the Host once for an answer the page asks for twice', async () => {
    const path = '/api/credentials/describe'
    const before = asked.get(path) ?? 0

    const headers = { cookie, host: authority }
    const first = await fetch(`http://127.0.0.1:${proxyPort}${path}`, { headers })
    const second = await fetch(`http://127.0.0.1:${proxyPort}${path}`, { headers })
    await first.text()
    await second.text()

    expect(asked.get(path) ?? 0).toBe(before + 1)
  })

  it('hands the second ask the same answer as the first', async () => {
    const path = '/api/agentPresets/list'
    const headers = { cookie, host: authority }
    const first = await fetch(`http://127.0.0.1:${proxyPort}${path}`, { headers })
    const firstBody = await first.text()
    const second = await fetch(`http://127.0.0.1:${proxyPort}${path}`, { headers })
    const secondBody = await second.text()
    // The answer says how many times the Host was asked, so the two
    // bodies differ only if the second one was fetched again.
    const firstAsked = JSON.parse(firstBody).asked
    const secondAsked = JSON.parse(secondBody).asked
    expect(secondAsked).toBe(firstAsked)
  })

  it('does not hand a cookie from one session to the next', async () => {
    const path = '/api/settings/describe'
    const headers = { cookie, host: authority }
    const first = await fetch(`http://127.0.0.1:${proxyPort}${path}`, { headers })
    const firstSetCookie = first.headers.getSetCookie?.() ?? []
    const second = await fetch(`http://127.0.0.1:${proxyPort}${path}`, { headers })
    const secondSetCookie = second.headers.getSetCookie?.() ?? []
    // A held answer is handed to whoever asks next, and that may be
    // another session: a cookie minted for one of them must not travel
    // with it.
    expect(secondSetCookie).toEqual([])
    expect(firstSetCookie).toEqual([])
  })

  it('asks the Host again for something that changes while the page is open', async () => {
    const path = '/api/costMeter/getState'
    const before = asked.get(path) ?? 0
    const headers = { cookie, host: authority }
    await (await fetch(`http://127.0.0.1:${proxyPort}${path}`, { headers })).text()
    await (await fetch(`http://127.0.0.1:${proxyPort}${path}`, { headers })).text()
    expect(asked.get(path) ?? 0).toBe(before + 2)
  })
})
