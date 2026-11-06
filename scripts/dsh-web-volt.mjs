/**
 * The Pi's power state, and the badge that shows it on the web page.
 *
 * Why: a Pi5 that loses its 5V rail does not shut down cleanly. The SoC
 * stalls, the hardware watchdog resets it, and the machine comes back with
 * nothing to show for it but a `Undervoltage detected!` line in the kernel
 * log. A person watching the page sees the site come back and never learns
 * that the power was the reason. The badge turns that line into something
 * visible without opening a terminal.
 *
 * Every source here may be missing — this runs on a Pi, but the script also
 * has to survive a machine that is not one. A source that cannot be read is
 * reported as `null` so the badge can say "unknown" rather than "fine".
 */
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Where the browser asks for the state. */
export const VOLT_ENDPOINT = '/__volt'

/** The marker that keeps the badge from being injected twice. */
const BADGE_MARKER = 'data-dsh-volt-badge'

/**
 * The under-voltage events in a kernel log.
 *
 * Two formats are read: the journal's (`Nov 03 18:51:22 host kernel: …`)
 * and dmesg's (`[ 741.740022] …`). The journal carries a wall clock, so the
 * last event can be put on a timeline; dmesg only carries seconds since
 * boot, so the time is reported as `null` there rather than as a
 * boot-relative number that would read like a time of day.
 */
export function parseVoltageEvents(log) {
  if (typeof log !== 'string') return { count: null, lastEvent: null }
  let count = 0
  let lastEvent = null
  for (const line of log.split('\n')) {
    if (!line.includes('Undervoltage detected!')) continue
    count += 1
    const stamp = line.match(/^(\w{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d)/)
    if (stamp !== null) lastEvent = stamp[1]
  }
  return { count, lastEvent }
}

/**
 * The alarm file of the voltage sensor, if this machine has one.
 *
 * The sensor is exposed as an hwmon device named `rpi_volt`; the index it
 * gets is not fixed, so it is looked up by name.
 */
export function findRpiVoltAlarmPath(hwmonDir, readFile = readFileSync, readDir = readdirSync) {
  let entries
  try {
    entries = readDir(hwmonDir)
  } catch {
    return null
  }
  for (const entry of entries) {
    let name
    try {
      name = readFile(join(hwmonDir, entry, 'name'), 'utf8')
    } catch {
      continue
    }
    if (name.trim() === 'rpi_volt') return join(hwmonDir, entry, 'in0_lcrit_alarm')
  }
  return null
}

/**
 * Whether the rail is under voltage right now.
 *
 * `null` means the machine did not answer, which is different from `false`.
 */
export function readUndervoltageAlarm(readFile = readFileSync, hwmonDir = '/sys/class/hwmon', readDir = readdirSync) {
  const path = findRpiVoltAlarmPath(hwmonDir, readFile, readDir)
  if (path === null) return null
  try {
    return readFile(path, 'utf8').trim() === '1'
  } catch {
    return null
  }
}

/** Millidegrees to degrees. */
export function parseTemperature(millidegrees) {
  const value = Number(millidegrees)
  return Number.isFinite(value) ? value / 1000 : null
}

/** The three load averages out of `/proc/loadavg`. */
export function parseLoad(text) {
  if (typeof text !== 'string') return null
  const loads = text.trim().split(/\s+/).slice(0, 3).map(Number)
  if (loads.length !== 3 || loads.some((value) => !Number.isFinite(value))) return null
  return loads
}

/**
 * The kernel log of this boot.
 *
 * The journal is the better source — it carries a wall clock — but it is
 * not readable everywhere, so dmesg is the fallback. Neither being readable
 * is reported as `null` rather than as an empty log: a log that could not
 * be read must not read as a log that held no events.
 */
async function readKernelLog(exec) {
  for (const [file, args] of [
    ['journalctl', ['-k', '-b', '--no-pager']],
    ['dmesg', []]
  ]) {
    try {
      const { stdout } = await exec(file, args)
      if (typeof stdout === 'string' && stdout !== '') return stdout
    } catch {
      // Try the next source: neither being readable is reported by the caller.
    }
  }
  return null
}

/**
 * Everything the badge shows, read in one go.
 *
 * The dependencies are parameters so that the reading can be exercised
 * without a Pi under it.
 */
export async function readVoltState(deps = {}) {
  const readFile = deps.readFile ?? ((path) => readFileSync(path, 'utf8'))
  const readDir = deps.readDir ?? ((path) => readdirSync(path))
  const exec = deps.exec ?? ((file, args) => execFileAsync(file, args))
  const hwmonDir = deps.hwmonDir ?? '/sys/class/hwmon'
  const thermalPath = deps.thermalPath ?? '/sys/class/thermal/thermal_zone0/temp'
  const loadavgPath = deps.loadavgPath ?? '/proc/loadavg'
  const uptimePath = deps.uptimePath ?? '/proc/uptime'

  const readText = (path) => {
    try {
      return readFile(path, 'utf8')
    } catch {
      return null
    }
  }

  const kernelLog = deps.kernelLog ?? (await readKernelLog(exec))
  const events = parseVoltageEvents(kernelLog)

  const temperature = parseTemperature(readText(thermalPath) ?? '')
  const load = parseLoad(readText(loadavgPath) ?? '')

  let uptime = null
  const uptimeText = readText(uptimePath)
  if (uptimeText !== null) {
    const seconds = Number(uptimeText.trim().split(/\s+/)[0])
    if (Number.isFinite(seconds)) uptime = seconds
  }

  return {
    updatedAt: new Date().toISOString(),
    undervoltage: readUndervoltageAlarm(readFile, hwmonDir, readDir),
    events: events.count,
    lastEvent: events.lastEvent,
    temperature,
    load,
    uptime
  }
}

/**
 * The badge itself.
 *
 * It is deliberately small and sits at the top, out of the way of the page:
 * the point is to be legible without taking up the room at the bottom, where
 * a phone puts its thumb and the keyboard. The colour of the dot carries the
 * state — green for a healthy rail, amber for events that already happened,
 * red for a rail that is sagging right now — and the temperature is the one
 * reading worth seeing at a glance. The rest of the story goes into the
 * tooltip, where it is there for whoever asks.
 */
export function buildVoltBadge() {
  return `<div ${BADGE_MARKER} title="电源状态读取中" style="position:fixed;right:12px;top:calc(12px + env(safe-area-inset-top));z-index:2147483000;display:flex;align-items:center;gap:5px;padding:3px 8px;border-radius:999px;background:rgba(24,24,30,.72);color:#cdd6f4;font:11px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-shadow:0 1px 6px rgba(0,0,0,.35);cursor:pointer;user-select:none;backdrop-filter:blur(4px)">
  <span data-dsh-volt-dot style="width:7px;height:7px;border-radius:50%;background:#a6adc8;flex:none"></span>
  <span data-dsh-volt-text>--°C</span>
</div>
<script>
(function () {
  var badge = document.querySelector('[${BADGE_MARKER}]')
  if (badge === null) return
  var dot = badge.querySelector('[data-dsh-volt-dot]')
  var text = badge.querySelector('[data-dsh-volt-text]')
  var COLORS = { ok: '#a6e3a1', warn: '#f9e2af', bad: '#f38ba8', unknown: '#a6adc8' }

  function describe(state) {
    if (state === null || state === undefined) return ['电源 未知', 'unknown']
    if (state.undervoltage === true) return ['电源 欠压中', 'bad']
    if (state.undervoltage === false && state.events > 0) return ['电源 欠压 ' + state.events + ' 次', 'warn']
    if (state.undervoltage === false) return ['电源 正常', 'ok']
    return ['电源 未知', 'unknown']
  }

  function refresh() {
    fetch('${VOLT_ENDPOINT}')
      .then(function (response) { return response.ok ? response.json() : null })
      .then(function (state) {
        var described = describe(state)
        dot.style.background = COLORS[described[1]]
        // The face is just the temperature next to the dot; the colour
        // tells the rest. The tooltip keeps the full story.
        var temp = state !== null && state !== undefined && typeof state.temperature === 'number'
          ? Math.round(state.temperature) + '°C'
          : '--°C'
        text.textContent = temp
        var details = [described[0]]
        if (state !== null && state !== undefined && typeof state.temperature === 'number') {
          details.push('温度 ' + state.temperature.toFixed(1) + '°C')
        }
        if (state !== null && state !== undefined && Array.isArray(state.load)) {
          details.push('负载 ' + state.load.map(function (value) { return value.toFixed(2) }).join(' / '))
        }
        if (state !== null && state !== undefined && typeof state.lastEvent === 'string') {
          details.push('最近一次欠压 ' + state.lastEvent)
        }
        badge.title = details.join(' · ')
      })
      .catch(function () {
        // The badge is a hint, not a feature of the page: a failed poll
        // leaves the last reading on screen instead of replacing it.
      })
  }

  refresh()
  // Thirty seconds rather than five.
  //
  // What this watches is whether the machine is undervoltage right now, and
  // a person cannot act on that any faster than they can read it. Polling
  // it every five seconds meant a request every five seconds for the life
  // of the page, and this path was the most requested of all.
  setInterval(refresh, 30000)
  badge.addEventListener('click', function () { badge.style.display = 'none' })
})()
</script>`
}

/**
 * Put the badge into a page.
 *
 * The page is a single-page app that owns the whole body, so the badge goes
 * in front of its closing tag. A page that has no body element still gets
 * the badge, appended at the end.
 */
export function injectVoltBadge(html) {
  if (typeof html !== 'string' || html === '') return html
  if (html.includes(BADGE_MARKER)) return html
  const badge = buildVoltBadge()
  const bodyEnd = html.toLowerCase().lastIndexOf('</body>')
  if (bodyEnd === -1) return html + badge
  return html.slice(0, bodyEnd) + badge + html.slice(bodyEnd)
}
