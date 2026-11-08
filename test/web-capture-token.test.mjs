import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The launch token is captured from the Harness's log into a file of its own.
 *
 * The log is appended to, not truncated, so it holds the token of every
 * Harness that has ever run. The Harness prints its own URL a moment after
 * it binds its port, which means that in the seconds after a restart the
 * newest token in the log belongs to the Harness that was replaced.
 *
 * The script has to wait for the running Harness's own token, not for a
 * token to appear: the token it stores is what the proxy injects into every
 * request, and a token from a replaced Harness turns every new browser's
 * request into a 401.
 */
const SCRIPT = join(process.cwd(), 'scripts', 'dsh-web-capture-token.mjs')

/**
 * Run the capture script against a log and a Harness that answers for one
 * token only.
 *
 * The Harness is a separate process: the capture script is run with a
 * synchronous call, which blocks this process's event loop, and a server in
 * this process would not answer while it is blocked. The fake answers the
 * request for the live token with the session cookie, and answers
 * everything else with a redirect that carries no cookie — which is what a
 * replaced Harness does.
 */
function startFakeHarness(liveToken) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-capture-harness-'))
  const script = join(dir, 'harness.mjs')
  const portFile = join(dir, 'port')
  writeFileSync(
    script,
    `import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
const live = ${JSON.stringify(liveToken)}
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.searchParams.get('token') === live) {
    response.writeHead(303, { 'set-cookie': 'dsh-auth-abc=1; Path=/' })
  } else {
    response.writeHead(303)
  }
  response.end()
})
server.listen(0, '127.0.0.1', () => {
  writeFileSync(${JSON.stringify(portFile)}, String(server.address().port))
})
`,
    { mode: 0o755 }
  )
  const child = spawn(process.execPath, [script], { stdio: 'ignore' })
  return { dir, portFile, child }
}

function waitForPort(portFile) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(portFile)) return readFileSync(portFile, 'utf8')
    execFileSync('sleep', ['0.05'])
  }
  throw new Error('the fake Harness did not start')
}

/** Run the capture script and report what it did. */
function runCapture({ log, out, port, waitSeconds }) {
  try {
    const stdout = execFileSync('node', [SCRIPT, '--wait', String(waitSeconds), '--log', log, '--out', out], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HARNESS_URL: `http://127.0.0.1:${port}` },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { stdout, stderr: '', exitCode: 0, saved: readFileSync(out, 'utf8') }
  } catch (error) {
    const failure = error
    let saved = null
    try {
      saved = readFileSync(out, 'utf8')
    } catch {
      saved = null
    }
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      exitCode: failure.status ?? 1,
      saved
    }
  }
}

const LINE = 'dsh web: http://100.86.255.34:43129/?token='

describe('the launch token capture', () => {
  it('takes the token the running Harness accepts', () => {
    const live = 'live-token-0001'
    const harness = startFakeHarness(live)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-capture-case-'))
    try {
      const log = join(dir, 'harness.log')
      const out = join(dir, 'launch-token')
      writeFileSync(log, `${LINE}${live}\n`)
      const port = waitForPort(harness.portFile)
      const result = runCapture({ log, out, port, waitSeconds: 5 })
      expect(result.exitCode).toBe(0)
      expect(result.saved).toContain(live)
    } finally {
      harness.child.kill()
      rmSync(harness.dir, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not save the token of a Harness that was replaced', () => {
    // The log holds the old Harness's token, and the running Harness does
    // not accept it.
    const harness = startFakeHarness('live-token-0002')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-capture-case-'))
    try {
      const log = join(dir, 'harness.log')
      const out = join(dir, 'launch-token')
      writeFileSync(log, `${LINE}replaced-token\n`)
      const port = waitForPort(harness.portFile)
      const result = runCapture({ log, out, port, waitSeconds: 1 })
      expect(result.exitCode).toBe(1)
      expect(result.saved).toBeNull()
      expect(result.stderr).toContain('no launch token')
    } finally {
      harness.child.kill()
      rmSync(harness.dir, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('waits for the running Harness to print its own token', () => {
    // The old token is last in the log at first; the new one is appended
    // while the script waits. The script has to keep looking, because the
    // newest token it can see is not yet the one the Harness is serving.
    const harness = startFakeHarness('live-token-0003')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-capture-case-'))
    try {
      const log = join(dir, 'harness.log')
      const out = join(dir, 'launch-token')
      writeFileSync(log, `${LINE}replaced-token\n`)
      const port = waitForPort(harness.portFile)
      // The Harness prints its URL a moment after it binds its port.
      //
      // The append runs in its own process: the capture script is run with a
      // synchronous call, which blocks this process's event loop, so a
      // timer here would not fire until the capture was already over.
      const append = spawn(
        'bash',
        ['-c', `sleep 0.8; printf '%s' "$CONTENT" > "$LOG"`],
        {
          stdio: 'ignore',
          env: {
            ...process.env,
            CONTENT: `${LINE}replaced-token\n${LINE}live-token-0003\n`,
            LOG: log
          }
        }
      )
      try {
        const result = runCapture({ log, out, port, waitSeconds: 10 })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('captured the launch token')
        expect(result.saved).toContain('live-token-0003')
        expect(result.saved).not.toContain('replaced-token')
      } finally {
        append.kill()
      }
    } finally {
      harness.child.kill()
      rmSync(harness.dir, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
