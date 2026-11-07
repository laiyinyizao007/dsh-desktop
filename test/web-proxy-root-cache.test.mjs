import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const proxyScript = join(here, '../scripts/dsh-web-proxy.mjs')

/**
 * The root page, as the proxy serves it.
 *
 * The page is different every time — the badge carries the machine's
 * current power state, the notice says whether the app is still coming up,
 * and the plugin graph carries the revision of every bundle. A browser that
 * keeps it comes back to a page that points at bundles this server no
 * longer has, and that says the machine is healthy when it is not.
 */
describe("the proxy's root page", () => {
  let upstream
  let proxy
  let base
  let temp

  beforeAll(async () => {
    temp = mkdtempSync(join(tmpdir(), 'dsh-proxy-root-'))
    // The Harness answers a root request that carries the launch token
    // with the page itself; the proxy only needs something to rewrite.
    upstream = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body><div id="root"></div></body></html>')
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = upstream.address().port

    const tokenFile = join(temp, 'launch-token')
    writeFileSync(tokenFile, 'test-token')
    const logFile = join(temp, 'harness.log')
    writeFileSync(logFile, `launch token: http://127.0.0.1:${upstreamPort}/?token=test-token\n`)

    const port = 40_000 + Math.floor(Math.random() * 10_000)
    base = `http://127.0.0.1:${port}`
    proxy = spawn(process.execPath, [proxyScript, '--port', String(port), '--upstream', `http://127.0.0.1:${upstreamPort}`, '--log', logFile], {
      env: { ...process.env, DSH_LAUNCH_TOKEN_FILE: tokenFile, DSH_HOME: temp },
      stdio: 'ignore'
    })
    // Wait for the proxy to accept connections.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await fetch(base, { redirect: 'manual' })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  })

  afterAll(async () => {
    proxy?.kill()
    upstream?.close()
    rmSync(temp, { recursive: true, force: true })
  })

  it('tells the browser not to keep it', async () => {
    const response = await fetch(base, { redirect: 'manual' })
    expect(response.status).toBe(200)
    // A page with no cache header at all is kept by the browser's own
    // heuristic, and the one that comes back points at bundles this server
    // no longer has.
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('still serves the page', async () => {
    const response = await fetch(base, { redirect: 'manual' })
    const body = await response.text()
    expect(body).toContain('id="root"')
  })
})
