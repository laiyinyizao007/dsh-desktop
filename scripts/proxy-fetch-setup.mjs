/**
 * Route Node's global `fetch` (undici) through the local mihomo proxy.
 *
 * undici deliberately ignores the standard HTTP_PROXY/HTTPS_PROXY environment
 * variables, so a build script that downloads assets with `fetch` goes direct
 * and fails on this network (the GitHub connection is reset mid-handshake).
 *
 * Preload with:
 *   NODE_OPTIONS="--import ./scripts/proxy-fetch-setup.mjs" npm run <script>
 *
 * Set DSH_PROXY_URL to override the proxy (defaults to http://127.0.0.1:7890).
 * Set DSH_NO_PROXY=1 to disable this shim entirely.
 */
import { createRequire } from 'node:module'

if (process.env.DSH_NO_PROXY !== '1') {
  const proxyUrl = process.env.DSH_PROXY_URL ?? 'http://127.0.0.1:7890'
  try {
    const require = createRequire(import.meta.url)
    const { ProxyAgent, setGlobalDispatcher } = require('undici')
    setGlobalDispatcher(new ProxyAgent(proxyUrl))
  } catch (error) {
    console.warn(`[proxy-fetch-setup] proxy dispatch unavailable: ${error.message}`)
  }
}
