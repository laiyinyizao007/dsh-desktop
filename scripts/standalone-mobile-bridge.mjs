/**
 * Standalone LAN-mobile bridge for DSH Desktop on Linux.
 *
 * DSH Desktop's `src/main/mobile/lan-mobile-bridge.ts` ships a zero-Electron
 * LAN bridge: a PIN-paired HTTP + WebSocket mux that proxies the Harness
 * `/api` RPC surface to a phone on the same network. Upstream it is driven by
 * the Electron main process, which owns the Harness child process and hands
 * the bridge two callbacks (`harnessUrl`, `harnessAuthToken`).
 *
 * On this Raspberry Pi the Harness runs as a separate `dsh web` service
 * instead of an Electron child, so this launcher re-creates the same two
 * callbacks against the running `dsh web` instance and boots the bridge on
 * its own. The bridge code itself is upstream's, unmodified.
 *
 * The bridge performs the launch-token exchange itself: it GETs the harness
 * root with `?token=`, which answers 303 plus a session cookie, and reuses
 * that cookie for every proxied RPC.
 *
 * Usage:
 *   node scripts/standalone-mobile-bridge.mjs [--harness http://127.0.0.1:43129] [--token <launch-token>] [--port 43130]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import { randomInt } from 'node:crypto'

const projectRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--harness') options.harness = argv[++index]
    else if (flag === '--token') options.token = argv[++index]
    else if (flag === '--port') options.port = Number(argv[++index])
    else if (flag === '--tunnel') options.tunnel = true
    else if (flag === '--no-tunnel') options.tunnel = false
    else if (flag === '--pin') options.pin = argv[++index]
    else if (flag === '--public-url') options.publicUrl = argv[++index]
  }
  return options
}

const args = parseArgs(process.argv.slice(2))

/**
 * Resolve the harness base URL and launch token.
 *
 * The harness binds one concrete interface address, so the bridge must talk
 * to that exact authority: `dsh web` refuses wildcard binds, and a loopback
 * base is unreachable when the harness is bound to a LAN or Tailscale
 * address. Both facts come from the harness's own printed URL.
 *
 * The harness prints a fresh launch token on every start, and an earlier
 * token is spent. The bridge therefore waits for the token of the *current*
 * harness process instead of trusting the last line in the log: on a cold
 * boot the harness may not have printed its URL yet, and on a restart the
 * previous line still sits in the log.
 */
async function readHarnessEndpoint() {
  const candidates = [
    process.env.DSH_HARNESS_LOG ?? '/var/log/dsh-web.log',
    '/tmp/dsh-web.log',
    join(projectRoot, '.build', 'dsh-web.log')
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const content = await readFile(path, 'utf8')
    const matches = [...content.matchAll(/http:\/\/([0-9.]+):(\d+)\/\?token=([A-Za-z0-9_-]+)/g)]
    const last = matches.at(-1)
    if (last) {
      return { base: `http://${last[1]}:${last[2]}`, token: last[3] }
    }
  }
  return undefined
}

/**
 * Wait until the harness accepts the launch token.
 *
 * Polls the harness root with the candidate token until it answers 303 (the
 * token exchange) instead of 401. That proves the token belongs to the
 * running harness, not to a previous one.
 */
async function waitForLiveToken(base, token) {
  const deadline = Date.now() + 15_000
  let lastStatus = 'no attempt'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/?token=${token}`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(8_000)
      })
      lastStatus = `HTTP ${response.status}`
      // 303 means the token was accepted and a session cookie was issued.
      if (response.status === 303) return true
    } catch (error) {
      lastStatus = `error: ${error.message}`
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  console.warn(`[bridge] token not accepted by ${base} (${lastStatus})`)
  return false
}

/** First non-loopback IPv4 on a private range — the address a phone can reach. */
function preferredLanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (/^10\./.test(entry.address) || /^192\.168\./.test(entry.address)) return entry.address
      const match = /^172\.(\d+)\./.exec(entry.address)
      if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return entry.address
    }
  }
  return undefined
}

/**
 * Resolve the harness base URL and a launch token the running harness accepts.
 *
 * The harness prints a new launch token on every start, and the previous one
 * is spent. So the bridge re-reads the log until the candidate token is
 * accepted by the live harness (303 on the token exchange), which also
 * covers the cold-boot case where the harness has not printed its URL yet.
 */
async function resolveLiveEndpoint() {
  const deadline = Date.now() + 180_000
  let lastError = 'no harness URL found in the log'
  let attempt = 0
  while (Date.now() < deadline) {
    attempt += 1
    const candidate = await readHarnessEndpoint()
    if (candidate) {
      const base = (args.harness ?? candidate.base).replace(/\/$/, '')
      const token = args.token ?? candidate.token
      const accepted = await waitForLiveToken(base, token)
      if (accepted) return { base, token }
      lastError = `token ${token} was rejected by ${base}`
    } else {
      lastError = 'no harness URL found in the log yet'
    }
    console.log(`[bridge] waiting for a live harness token (attempt ${attempt}): ${lastError}`)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error(`Harness launch token unavailable: ${lastError}`)
}

const { base: harnessBase, token: launchToken } = await resolveLiveEndpoint()
console.log(`[bridge] harness ready at ${harnessBase}`)

const { LanMobileBridge } = await import('../.build/mobile-bridge/lan-mobile-bridge.js')

/**
 * The pairing PIN for internet (tunnel) pairing.
 *
 * LAN pairing needs no PIN — the pairing URL's token is enough. Tunnel
 * pairing is different: the phone cannot be trusted by address, so it proves
 * itself with a six-digit PIN. Upstream the Desktop UI generates that PIN and
 * stores it with the user's consent; here the launcher owns the store, so it
 * generates the PIN, records the consent, and prints it.
 */
const pinStorePath = join(projectRoot, '.build', 'mobile-pairing-pin.json')
const pairingPinStore = {
  load() {
    try {
      const parsed = JSON.parse(readFileSync(pinStorePath, 'utf8'))
      const state = {}
      if (typeof parsed.pin === 'string' && /^\d{6}$/.test(parsed.pin)) state.pin = parsed.pin
      if (typeof parsed.pinConsent === 'boolean') state.pinConsent = parsed.pinConsent
      return state
    } catch {
      return {}
    }
  },
  save(state) {
    const document = {}
    if (state.pinConsent === true) {
      document.pinConsent = true
      if (typeof state.pin === 'string' && /^\d{6}$/.test(state.pin)) document.pin = state.pin
    }
    writeFileSync(pinStorePath, `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 })
    return true
  }
}

const storedPin = pairingPinStore.load()
const pairingPin = args.pin ?? storedPin.pin ?? String(randomInt(0, 1_000_000)).padStart(6, '0')
if (storedPin.pin !== pairingPin || storedPin.pinConsent !== true) {
  pairingPinStore.save({ pin: pairingPin, pinConsent: true })
}

/**
 * Persistent store for paired phones.
 *
 * The bridge keeps paired phones in memory, so a restart would make every
 * phone enter the PIN again. The bridge restarts on every harness restart
 * here, which would be constant re-pairing. Persisting the tokens keeps a
 * paired phone paired.
 */
const sessionStorePath = join(projectRoot, '.build', 'mobile-paired-sessions.json')
const sessionStore = {
  load() {
    try {
      const parsed = JSON.parse(readFileSync(sessionStorePath, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (entry) =>
          entry &&
          typeof entry.token === 'string' &&
          /^[A-Za-z0-9_-]{43}$/.test(entry.token) &&
          typeof entry.remoteAddress === 'string'
      )
    } catch {
      return []
    }
  },
  save(sessions) {
    try {
      writeFileSync(sessionStorePath, `${JSON.stringify(sessions, undefined, 2)}\n`, { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }
}

/**
 * The live launch token.
 *
 * The bridge calls this for every Harness exchange, so re-reading the log
 * keeps it working across a harness restart: the token in memory goes stale,
 * but the log always holds the newest one. The bridge's callback is
 * synchronous, so the read has to be too.
 */
let currentToken = launchToken
function liveHarnessToken() {
  if (args.token) return args.token
  try {
    for (const path of [process.env.DSH_HARNESS_LOG ?? '/var/log/dsh-web.log', '/tmp/dsh-web.log']) {
      if (!existsSync(path)) continue
      const content = readFileSync(path, 'utf8')
      const matches = [...content.matchAll(/\/\?token=([A-Za-z0-9_-]+)/g)]
      const last = matches.at(-1)
      if (last) {
        currentToken = last[1]
        break
      }
    }
  } catch {
    // Keep the previous token; the bridge retries on 401.
  }
  return currentToken
}

const bridge = new LanMobileBridge({
  harnessUrl: () => harnessBase,
  harnessAuthToken: () => liveHarnessToken(),
  locale: 'zh',
  port: args.port ?? 43130,
  tunnelLog: (message) => console.warn('[bridge]', message),
  onConnectedChange: (connected) => {
    console.log('[bridge] phone connected:', connected)
  },
  pairingPinStore,
  sessionStore,
  // The system cloudflared reads `~/.cloudflared/config.yml` by default, which
  // on this machine declares a *named* tunnel (wecom-relay / openclaw). A
  // quick tunnel must ignore that config, otherwise cloudflared registers the
  // named tunnel's ingress rules and every other Host answers 404.
  cloudflaredPath: '/usr/local/bin/cloudflared',
  createCloudflareTunnel: (port) => startQuickTunnel(port)
})

/**
 * Start a Cloudflare quick tunnel.
 *
 * `startCloudflareQuickTunnel` spawns `cloudflared tunnel --url ...` without
 * a config override, so cloudflared would pick up `~/.cloudflared/config.yml`
 * and register this machine's named tunnel instead of a quick one. Spawn it
 * with `--config /dev/null` so the quick tunnel is what actually starts.
 */
async function startQuickTunnel(port) {
  const { spawn } = await import('node:child_process')
  const { extractTryCloudflareUrl } = await import('../.build/mobile-bridge/cloudflared-tunnel.js')
  const binaryPath = '/usr/local/bin/cloudflared'
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ['tunnel', '--config', '/dev/null', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGTERM')
        reject(new Error('Cloudflare quick tunnel timed out after 45s'))
      }
    }, 45_000)
    const handle = (chunk) => {
      const text = chunk.toString()
      const url = extractTryCloudflareUrl(text)
      if (url && !settled) {
        settled = true
        clearTimeout(timer)
        console.log(`[bridge] tunnel online: ${url}`)
        resolve({
          provider: 'cloudflare',
          url,
          process: child,
          stop: async () => {
            child.kill('SIGTERM')
          }
        })
      }
    }
    child.stdout?.on('data', handle)
    child.stderr?.on('data', handle)
    child.once('error', (error) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    })
    child.once('exit', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`Cloudflare quick tunnel exited with code ${code}`))
      }
    })
  })
}

const snapshot = await bridge.start()
const lanAddress = preferredLanAddress()
console.log(`[bridge] harness: ${harnessBase}`)
console.log(`[bridge] listening on port ${snapshot.port}`)
console.log(`[bridge] phone URL: http://${lanAddress ?? '<lan-ip>'}:${snapshot.port}/desktop`)

const pairingFile = join(projectRoot, '.build', 'mobile-pairing-url.txt')
const lanPairingFile = join(projectRoot, '.build', 'mobile-lan-pairing-url.txt')
const tunnelFile = join(projectRoot, '.build', 'mobile-tunnel-url.txt')
const pinFile = join(projectRoot, '.build', 'mobile-pairing-pin.txt')

/**
 * Publish the current pairing URL.
 *
 * The pairing token is single-use and short-lived (5 minutes upstream), so
 * the URL has to be refreshed for a phone that has not paired yet.
 * `bridge.start()` on a running bridge rotates the token when it has expired
 * and returns the fresh snapshot, which is the upstream-supported way to get
 * a new link.
 *
 * With a tunnel active the pairing URL points at the public address, because
 * that is where the phone can reach the bridge.
 */
async function publishPairingUrl() {
  const current = await bridge.start()
  const pairingUrl = current.pairingUrl
  if (!pairingUrl) return
  // The LAN link always uses the bridge's own address: a phone on the same
  // network pairs there directly and needs no PIN.
  await writeFile(lanPairingFile, `${pairingUrl}\n`, 'utf8')
  if (args.publicUrl) {
    // Fixed public hostname: only the token rotates.
    const token = new URL(pairingUrl).searchParams.get('token')
    if (!token) return
    const publicPairingUrl = `${args.publicUrl.replace(/\/$/, '')}/pair?token=${token}`
    await writeFile(pairingFile, `${publicPairingUrl}\n`, 'utf8')
    await writeFile(tunnelFile, `${args.publicUrl.replace(/\/$/, '')}\n`, 'utf8')
    console.log(`[bridge] pairing URL: ${publicPairingUrl}`)
    return
  }
  await writeFile(pairingFile, `${pairingUrl}\n`, 'utf8')
  console.log(`[bridge] pairing URL: ${pairingUrl}`)
  if (current.tunnelActive && current.tunnelUrl) {
    await writeFile(tunnelFile, `${current.tunnelUrl}\n`, 'utf8')
    console.log(`[bridge] public URL: ${current.tunnelUrl}`)
  }
}

await publishPairingUrl()
console.log(`[bridge] pairing URL file: ${pairingFile}`)

// Bring up the internet tunnel so the phone can reach the bridge from
// anywhere, the same way DSH Desktop's "switch to internet tunnel" does.
if (args.tunnel === true) {
  const tunnelSnapshot = await bridge.toggleTunnel(true)
  if (tunnelSnapshot.tunnelError) {
    console.error(`[bridge] tunnel failed: ${tunnelSnapshot.tunnelError}`)
  } else {
    console.log(`[bridge] tunnel provider: ${tunnelSnapshot.tunnelProvider}`)
    console.log(`[bridge] tunnel URL: ${tunnelSnapshot.tunnelUrl}`)
    await writeFile(tunnelFile, `${tunnelSnapshot.tunnelUrl}\n`, 'utf8')
    // Tunnel pairing is PIN-gated: the phone proves itself with this code.
    await writeFile(pinFile, `${pairingPin}\n`, 'utf8')
    console.log(`[bridge] pairing PIN: ${pairingPin}`)
  }
}

/**
 * Publish the pairing URL under a fixed public address.
 *
 * With a named Cloudflare tunnel in front of the bridge, the public hostname
 * is fixed even though the bridge's own quick-tunnel hostname is not. The
 * pairing URL has to carry that fixed hostname, otherwise the phone would
 * be told to pair through an address that changes on every restart.
 */
if (args.publicUrl) {
  const publicBase = args.publicUrl.replace(/\/$/, '')
  const current = await bridge.start()
  const token = current.pairingUrl
    ? new URL(current.pairingUrl).searchParams.get('token')
    : undefined
  if (token) {
    const publicPairingUrl = `${publicBase}/pair?token=${token}`
    await writeFile(pairingFile, `${publicPairingUrl}\n`, 'utf8')
    await writeFile(tunnelFile, `${publicBase}\n`, 'utf8')
    await writeFile(pinFile, `${pairingPin}\n`, 'utf8')
    console.log(`[bridge] public URL: ${publicBase}`)
    console.log(`[bridge] pairing PIN: ${pairingPin}`)
    console.log(`[bridge] pairing URL: ${publicPairingUrl}`)
  }
}

// Refresh well inside the token lifetime so the published link is always
// usable when the user opens it.
const refreshTimer = setInterval(() => {
  publishPairingUrl().catch((error) => {
    console.warn('[bridge] pairing URL refresh failed:', error.message)
  })
}, 60_000)
refreshTimer.unref()

const shutdown = async () => {
  clearInterval(refreshTimer)
  await bridge.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
