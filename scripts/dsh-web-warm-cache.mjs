/**
 * Warm the edge cache with the Harness's client bundles.
 *
 * The bundles are content-addressed and served with a one-year immutable
 * cache header, so an edge cache is willing to keep them — but only after
 * somebody asks for them once. Until then every page load pulls the whole
 * plugin graph back through the tunnel, which is the slowest part of a cold
 * start on a narrow link.
 *
 * This asks for every bundle once, through the public URL, so that the edge
 * holds them before the first person arrives. Run it after a Harness
 * upgrade — a new bundle has a new revision, and therefore a new URL, and
 * the edge has never seen it.
 *
 * Usage:
 *   node scripts/dsh-web-warm-cache.mjs [--url https://dsh.example.com]
 */
const args = process.argv.slice(2)
const urlIndex = args.indexOf('--url')
const base = urlIndex >= 0 ? args[urlIndex + 1] : process.env.DSH_PUBLIC_URL ?? 'http://127.0.0.1:43128'
const waitIndex = args.indexOf('--wait')
const waitSeconds = waitIndex >= 0 ? Number(args[waitIndex + 1]) : 60

if (!base.startsWith('http')) {
  console.error(`dsh-web-warm-cache: "${base}" is not an http(s) URL`)
  process.exit(1)
}

/**
 * The session the Harness needs for a request.
 *
 * The root page exchanges the launch token for a cookie; every other
 * request has to carry it.
 */
async function openSession() {
  const jar = new Map()
  const absorb = (response) => {
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0]
      const equals = pair.indexOf('=')
      if (equals > 0) jar.set(pair.slice(0, equals), pair.slice(equals + 1))
    }
  }
  const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ')

  const first = await fetch(`${base}/`, { redirect: 'manual' })
  absorb(first)
  await first.arrayBuffer()
  const second = await fetch(`${base}/`, { headers: { cookie: cookie() }, redirect: 'manual' })
  absorb(second)
  const html = await second.text()
  return { html, cookie: cookie(), status: second.status }
}

/** Every URL the page asks the edge for. */
function pageUrls(html) {
  const urls = new Set()
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const value = match[1]
    if (value.startsWith('/') || value.startsWith('plugins/') || value.startsWith('assets/')) {
      urls.add(new URL(value, base).toString())
    }
  }
  // The module graph names the bundles the client loads at runtime; they are
  // part of the page as well, and the edge has to hold them too.
  for (const match of html.matchAll(/"url":"([^"]+)"/g)) {
    const value = match[1]
    if (value.includes('plugins/')) urls.add(new URL(value, base).toString())
  }
  return [...urls]
}

/**
 * The page and its session, waited for.
 *
 * The page is empty when the Harness is not answering with one: it is
 * starting, it has just restarted and lost its launch token, or the proxy
 * in front of it cannot find one. All three clear up in seconds, so the
 * warm-up waits for them rather than reporting an empty success.
 */
async function openSessionWhenReady() {
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000
  for (;;) {
    try {
      const session = await openSession()
      const urls = pageUrls(session.html)
      if (urls.length > 0) return { ...session, urls }
      console.log(
        `dsh-web-warm-cache: the page has no bundles yet (status ${session.status}), waiting`
      )
    } catch (error) {
      console.log(`dsh-web-warm-cache: ${String(error)}, waiting`)
    }
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

const session = await openSessionWhenReady()
if (session === undefined) {
  console.error(
    `dsh-web-warm-cache: the page at ${base} never offered a bundle after ${waitSeconds}s — ` +
      'the edge cache was not warmed, and the first page load will pull the whole plugin graph'
  )
  process.exit(1)
}

const { cookie, urls } = session
console.log(`dsh-web-warm-cache: warming ${urls.length} URLs through ${base}`)

let warmed = 0
let failed = 0
let bytes = 0
for (const url of urls) {
  try {
    const started = Date.now()
    const response = await fetch(url, { headers: { cookie, 'accept-encoding': 'gzip, br' } })
    const body = Buffer.from(await response.arrayBuffer())
    bytes += body.length
    if (response.status === 200) {
      warmed += 1
      const status = response.headers.get('cf-cache-status')
      console.log(`  ok   ${String(response.status)}  ${(body.length / 1024).toFixed(0).padStart(6)}KB  ${Date.now() - started}ms  ${status ?? '-'}  ${url.slice(base.length).slice(0, 60)}`)
    } else {
      failed += 1
      console.log(`  FAIL ${response.status}  ${url.slice(base.length).slice(0, 80)}`)
    }
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${String(error)}  ${url.slice(base.length).slice(0, 80)}`)
  }
}

console.log(
  `dsh-web-warm-cache: ${warmed} warmed, ${failed} failed, ${(bytes / 1024 / 1024).toFixed(2)}MB fetched`
)

// A run that warmed nothing is a failure, not a quiet success: it used to
// report "0 warmed, 0 failed" and exit 0, which is exactly how the edge
// cache went unfilled for a whole day without anybody noticing.
if (warmed === 0) {
  console.error('dsh-web-warm-cache: nothing was warmed — the edge cache is still cold')
  process.exit(1)
}
