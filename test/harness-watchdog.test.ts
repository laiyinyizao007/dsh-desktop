import { describe, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The watchdog lives in `scripts/dsh-auto-restart.sh` and runs from a timer.
 *
 * The script has two jobs: restart the Harness when a client bundle changed
 * after it started, and bring the Harness back when it is not running at all.
 * The second job is the one this file guards, because the failure it prevents
 * is silent: a `systemctl stop` is an explicit stop, so `Restart=always` does
 * not apply, the proxy and the tunnel keep serving, and the public URL
 * answers "Bad gateway" with nothing in the logs to explain it.
 *
 * The script is exercised as a real process, not through a re-implementation:
 * a copy of it is run with `systemctl` and `sudo` replaced by fakes, so the
 * behaviour under test is the behaviour of the shipped script.
 */

const SCRIPT = join(process.cwd(), 'scripts', 'dsh-auto-restart.sh')

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
  /** The `systemctl` commands the script asked for, one per line. */
  calls: string
}

/**
 * Run the watchdog with `systemctl` and `sudo` faked.
 *
 * The fake `systemctl` answers `is-active` from `activeState` and records
 * every `start` and `restart` it is asked to do. The fake `sudo` is a no-op
 * that lets its arguments through, so the script's own command line is what
 * gets asserted on.
 */
function runWatchdog(options: {
  activeState: string
  stateDir: string
  healthz?: string
  env?: Record<string, string>
}): RunResult {
  const bin = mkdtempSync(join(tmpdir(), 'dsh-watchdog-'))
  const calls: string[] = []
  const systemctl = join(bin, 'systemctl')
  const sudo = join(bin, 'sudo')
  writeFileSync(
    systemctl,
    `#!/bin/bash
if [ "$1" = "is-active" ]; then
  echo "${options.activeState}"
  exit 0
fi
echo "$@" >> "${join(bin, 'calls')}"
exit 0
`,
    { mode: 0o755 }
  )
  writeFileSync(sudo, `#!/bin/bash\nexec "$@"\n`, { mode: 0o755 })
  try {
    const stdout = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        DSH_STATE_DIR: options.stateDir,
        DSH_HARNESS_SERVICE: 'dsh-web.service',
        DSH_PROXY_PORT: '1',
        ...options.env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const callsFile = join(bin, 'calls')
    return {
      stdout,
      stderr: '',
      exitCode: 0,
      calls: existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : ''
    }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number }
    const callsFile = join(bin, 'calls')
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      exitCode: failure.status ?? 1,
      calls: existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : ''
    }
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
}

const counterFile = (stateDir: string) => join(stateDir, 'harness-down-count')
const staleFile = (stateDir: string) => join(stateDir, 'stale-bundles-noticed')

/**
 * The /healthz answer of a proxy whose bundles are stale.
 *
 * The shape is the proxy's own: a list of checks, and the stale bundles
 * named by id.
 */
const STALE_HEALTHZ = JSON.stringify({
  ok: false,
  checks: [
    { name: 'harness', ok: true, detail: 'launch token present' },
    { name: 'client-bundle-revisions', ok: false, detail: '1 bundle(s) changed after the Harness started' }
  ],
  stale: [{ id: 'dsh-desktop-responsive', rev: 'abc123' }]
})

/** The same answer with nothing stale. */
const FRESH_HEALTHZ = JSON.stringify({
  ok: true,
  checks: [
    { name: 'harness', ok: true, detail: 'launch token present' },
    { name: 'client-bundle-revisions', ok: true, detail: 'every bundle matches its advertised revision' }
  ],
  stale: []
})

/**
 * Run the watchdog against a proxy that answers /healthz with the given body.
 *
 * The proxy is a separate process: the watchdog is run with a synchronous
 * call, which blocks this process's event loop, and a server in this
 * process would not answer while it is blocked.
 */
async function runWithHealthz(
  options: { healthz: string; stateDir: string }
): Promise<RunResult> {
  const bin = mkdtempSync(join(tmpdir(), 'dsh-watchdog-proxy-'))
  const serverScript = join(bin, 'proxy.mjs')
  const portFile = join(bin, 'port')
  writeFileSync(
    serverScript,
    `import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
const body = ${JSON.stringify(options.healthz)}
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(body)
})
server.listen(0, '127.0.0.1', () => {
  writeFileSync(${JSON.stringify(portFile)}, String(server.address().port))
})
`,
    { mode: 0o755 }
  )
  const server = spawn(process.execPath, [serverScript], { stdio: 'ignore' })
  try {
    // Wait for the server to say which port it took.
    let port = ''
    for (let attempt = 0; attempt < 100 && port === ''; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (existsSync(portFile)) port = readFileSync(portFile, 'utf8')
    }
    if (port === '') throw new Error('the fake proxy did not start')
    return runWatchdog({
      activeState: 'active',
      stateDir: options.stateDir,
      env: { DSH_PROXY_PORT: port }
    })
  } finally {
    server.kill()
    rmSync(bin, { recursive: true, force: true })
  }
}

describe('the Harness watchdog', () => {
  it('does nothing while the Harness is running', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dsh-watchdog-state-'))
    try {
      const result = runWatchdog({ activeState: 'active', stateDir })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
      // No counter is written while the Harness is up: a later outage gets
      // the full grace period instead of inheriting a stale count.
      expect(existsSync(counterFile(stateDir))).toBe(false)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('waits for a second failed check before starting the Harness', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dsh-watchdog-state-'))
    try {
      const first = runWatchdog({ activeState: 'inactive', stateDir })
      expect(first.exitCode).toBe(0)
      expect(first.stdout).toBe('')
      expect(readFileSync(counterFile(stateDir), 'utf8')).toBe('1')

      const second = runWatchdog({ activeState: 'inactive', stateDir })
      expect(second.exitCode).toBe(0)
      expect(second.stdout).toContain('starting dsh-web.service')
      expect(second.stdout).toContain('2 consecutive checks')
      // The command is a `start`, not a `restart`: the unit is already down.
      expect(second.calls).toContain('start dsh-web.service')
      expect(second.calls).not.toContain('restart')
      // The counter is cleared, so a later outage starts counting again.
      expect(existsSync(counterFile(stateDir))).toBe(false)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('forgets an earlier failure once the Harness is running again', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dsh-watchdog-state-'))
    try {
      runWatchdog({ activeState: 'inactive', stateDir })
      expect(readFileSync(counterFile(stateDir), 'utf8')).toBe('1')

      runWatchdog({ activeState: 'active', stateDir })
      expect(existsSync(counterFile(stateDir))).toBe(false)

      // The next outage must take two checks again, not one.
      const first = runWatchdog({ activeState: 'inactive', stateDir })
      expect(first.stdout).toBe('')
      expect(readFileSync(counterFile(stateDir), 'utf8')).toBe('1')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('treats a failed unit as down', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dsh-watchdog-state-'))
    try {
      // A unit that failed to start answers "failed", not "inactive".
      const first = runWatchdog({ activeState: 'failed', stateDir })
      expect(first.stdout).toBe('')
      expect(readFileSync(counterFile(stateDir), 'utf8')).toBe('1')

      const second = runWatchdog({ activeState: 'failed', stateDir })
      expect(second.stdout).toContain('starting dsh-web.service')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('recovers from a corrupt counter instead of refusing to run', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dsh-watchdog-state-'))
    try {
      writeFileSync(counterFile(stateDir), 'not-a-number')
      const first = runWatchdog({ activeState: 'inactive', stateDir })
      expect(first.exitCode).toBe(0)
      expect(first.stdout).toBe('')
      expect(readFileSync(counterFile(stateDir), 'utf8')).toBe('1')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('says which bundles changed instead of restarting the Harness', async () => {
    // A restart drops the live WebSocket connections and interrupts whatever
    // the agent is doing, and editing a plugin is a thing a person does while
    // they are working — so the restart is theirs to make.
    const stateDir = mkdtempSync(join(tmpdir(), 'dsh-watchdog-state-'))
    try {
      const result = await runWithHealthz({ healthz: STALE_HEALTHZ, stateDir })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('dsh-desktop-responsive')
      // The command to run is named, so that the person reading the log does
      // not have to know it.
      expect(result.stdout).toContain('sudo systemctl restart dsh-web.service')
      // The Harness is not restarted for it.
      expect(result.calls).not.toContain('restart')
      expect(result.calls).not.toContain('start dsh-web.service')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('says it once for the same set of bundles', async () => {
    // The check runs every 30 seconds, and a bundle stays stale until the
    // Harness is restarted. Saying it again would be noise.
    const stateDir = mkdtempSync(join(tmpdir(), 'dsh-watchdog-state-'))
    try {
      const first = await runWithHealthz({ healthz: STALE_HEALTHZ, stateDir })
      expect(first.stdout).toContain('dsh-desktop-responsive')

      const second = await runWithHealthz({ healthz: STALE_HEALTHZ, stateDir })
      expect(second.stdout).toBe('')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('says it again once the bundles are fresh and stale once more', async () => {
    // The record of what was reported is cleared when nothing is stale, so
    // that the same bundle reported later is reported again.
    const stateDir = mkdtempSync(join(tmpdir(), 'dsh-watchdog-state-'))
    try {
      await runWithHealthz({ healthz: STALE_HEALTHZ, stateDir })
      expect(existsSync(staleFile(stateDir))).toBe(true)

      const fresh = await runWithHealthz({ healthz: FRESH_HEALTHZ, stateDir })
      expect(fresh.stdout).toBe('')
      expect(existsSync(staleFile(stateDir))).toBe(false)

      const staleAgain = await runWithHealthz({ healthz: STALE_HEALTHZ, stateDir })
      expect(staleAgain.stdout).toContain('dsh-desktop-responsive')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('checks the unit rather than the proxy health endpoint', () => {
    // The proxy's /healthz looks for the launch token in the log, and the log
    // still holds the token of a Harness that is already dead — /healthz
    // answers "ok" while the Harness is gone. A watchdog built on /healthz
    // would never fire, so the script must ask systemd for the unit state.
    const script = readFileSync(SCRIPT, 'utf8')
    // Strip the comment block so the assertion is about what the script
    // executes, not about what it explains.
    const code = script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    expect(code).toContain('systemctl is-active')
    // The liveness decision is taken before /healthz is ever consulted, so a
    // healthy /healthz can never stand in for a running Harness.
    const livenessCheck = code.indexOf('systemctl is-active')
    const healthzRead = code.indexOf('/healthz')
    expect(livenessCheck).toBeGreaterThan(-1)
    expect(healthzRead).toBeGreaterThan(livenessCheck)
    // The bundle check still reads /healthz; that is its own job.
    expect(code).toContain('/healthz')
  })
})
