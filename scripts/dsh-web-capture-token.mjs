/**
 * Capture the Harness's launch token and keep it where it cannot be lost.
 *
 * The Harness prints its root URL — the one that carries the launch token —
 * once, on startup. The proxy reads that line out of the log to inject the
 * token into the requests it forwards upstream, so the token is the single
 * piece of state that decides whether the public URL answers with the page
 * or with a 401.
 *
 * It lives in exactly one place — the log — and that is a fragile place:
 * logrotate truncates the log on a schedule, a log rotation takes the line
 * with it, and from that moment on the proxy has nothing to inject and every
 * new browser gets a 401. The symptom is easy to misread, because a browser
 * that still holds an old session cookie keeps working, so the site looks
 * fine to the person looking at it and broken to everyone else.
 *
 * So this copies the token out of the log into a file of its own, together
 * with the identity of the Harness it belongs to. The proxy falls back to
 * that file when the log has nothing to offer, and ignores it once the
 * Harness it was captured from is gone — a token from a previous Harness is
 * dead, and a dead token is worse than no token at all because it hides the
 * real problem.
 *
 * The Harness's start time is used as the identity rather than its PID: a
 * PID can be reused by an unrelated process, but the start time of a given
 * PID never goes backwards.
 *
 * Usage:
 *   node scripts/dsh-web-capture-token.mjs [--wait 20] [--log PATH] [--out PATH]
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const args = process.argv.slice(2)

/** Read the value of a `--flag value` pair. */
function flag(name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = args[index + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}

/** Whether a `--flag` was given at all. */
function present(name) {
  return args.includes(name)
}

const logPath = flag('--log', process.env.DSH_HARNESS_LOG ?? '/var/log/dsh-web.log')
const outPath = flag('--out', process.env.DSH_LAUNCH_TOKEN_FILE ?? '/var/lib/dsh-web/launch-token')
const waitSeconds = Number(flag('--wait', '20'))
const harnessUnit = flag('--unit', process.env.DSH_HARNESS_UNIT ?? 'dsh-web.service')
// The Harness binds one concrete address, so the check below has to use the
// same one the unit gave it.
const harnessUrl = flag(
  '--url',
  process.env.DSH_HARNESS_URL ?? `http://${process.env.DSH_BIND ?? '127.0.0.1'}:43129`
)

/**
 * Whether the running Harness still accepts this token.
 *
 * A token is only good for the Harness that printed it: the Harness rotates
 * it on every restart. Asking the Harness is the only way to tell a live
 * token from a dead one, and a dead token that is persisted anyway is worse
 * than no token at all — it turns a clear failure into an unexplained 401.
 */
async function harnessAccepts(token) {
  try {
    const response = await fetch(`${harnessUrl}/?token=${encodeURIComponent(token)}`, {
      redirect: 'manual'
    })
    const cookies = response.headers.getSetCookie?.() ?? []
    return cookies.some((cookie) => cookie.startsWith('dsh-auth-'))
  } catch {
    return false
  }
}

/**
 * The PID of the running Harness, if it can be found.
 *
 * The unit's own MainPID is the answer when systemd is in charge, which is
 * the normal case. The /proc scan is the fallback for a Harness that was
 * started by hand.
 */
function harnessPid() {
  const fromEnv = process.env.DSH_HARNESS_PID
  if (fromEnv !== undefined && /^[0-9]+$/.test(fromEnv)) return Number(fromEnv)
  try {
    const pid = execFileSync('systemctl', ['show', harnessUnit, '-p', 'MainPID', '--value'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    if (/^[0-9]+$/.test(pid) && pid !== '0') return Number(pid)
  } catch {
    // No systemd, or the unit is gone. The scan below may still find it.
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
      if (cmd.includes('dsh') && cmd.includes('web') && cmd.includes('43129')) return Number(entry)
    }
  } catch {
    // ignored
  }
  return null
}

/**
 * When the Harness process started, in epoch milliseconds.
 *
 * The start time is field 22 of /proc/<pid>/stat, in clock ticks since the
 * boot; the boot time comes from /proc/stat. Together they give a value
 * that is exact to the tick and unique to the process.
 */
function processStartedAt(pid) {
  if (pid === null) return 0
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ticks = Number(fields[19])
    const match = readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)$/m)
    if (!Number.isFinite(ticks) || match === null) return 0
    return Number(match[1]) * 1000 + (ticks / 100) * 1000
  } catch {
    return 0
  }
}

/** The last launch token in the log, if there is one. */
function tokenInLog() {
  let content
  try {
    content = readFileSync(logPath, 'utf8')
  } catch {
    return undefined
  }
  const matches = [...content.matchAll(/\?token=([A-Za-z0-9_-]+)/g)]
  return matches.at(-1)?.[1]
}

/**
 * Write the captured token where the proxy can find it.
 *
 * The file is written to a temporary name and renamed into place, so a
 * reader never sees a half-written file: the proxy reads this on every
 * request and a truncated file would be read as "no token".
 */
function persist(token, pid, startedAt) {
  const identity = pid === null ? '' : `${pid}:${startedAt}`
  const payload = `${JSON.stringify({ token, identity, pid, startedAt, capturedAt: Date.now() })}\n`
  mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 })
  const temporary = `${outPath}.tmp`
  writeFileSync(temporary, payload, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, outPath)
  chmodSync(outPath, 0o600)
}

const deadline = Date.now() + Math.max(0, waitSeconds) * 1000
let token
for (;;) {
  token = tokenInLog()
  if (token !== undefined) break
  if (Date.now() >= deadline) break
  // The Harness prints its URL a moment after it binds its port.
  await new Promise((resolve) => setTimeout(resolve, 250))
}

if (token === undefined) {
  console.error(
    `dsh-web-capture-token: no launch token in ${logPath} after ${waitSeconds}s` +
      (present('--quiet') ? '' : ` — the Harness may not have started`)
  )
  process.exit(1)
}

const pid = harnessPid()
const startedAt = processStartedAt(pid)

if (!(await harnessAccepts(token))) {
  console.error(
    `dsh-web-capture-token: the Harness at ${harnessUrl} does not accept this token — ` +
      'it belongs to a Harness that has been replaced, so it was not saved'
  )
  process.exit(1)
}

persist(token, pid, startedAt)
console.log(
  `dsh-web-capture-token: captured the launch token for pid ${pid ?? '?'} into ${outPath}`
)
