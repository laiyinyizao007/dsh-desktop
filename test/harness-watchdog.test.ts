import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
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
