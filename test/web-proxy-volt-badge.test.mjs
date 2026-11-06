import { describe, expect, it } from 'vitest'
import {
  VOLT_ENDPOINT,
  buildVoltBadge,
  findRpiVoltAlarmPath,
  injectVoltBadge,
  parseLoad,
  parseTemperature,
  parseVoltageEvents,
  readUndervoltageAlarm,
  readVoltState
} from '../scripts/dsh-web-volt.mjs'

describe('parseVoltageEvents', () => {
  it('counts the events in a journal kernel log and keeps the last one', () => {
    const log = [
      'Nov 03 18:51:22 BaveryPi kernel: hwmon hwmon4: Undervoltage detected!',
      'Nov 03 18:51:24 BaveryPi kernel: hwmon hwmon4: Voltage normalised',
      'Nov 03 18:51:42 BaveryPi kernel: hwmon hwmon4: Undervoltage detected!',
      'Nov 03 18:51:44 BaveryPi kernel: hwmon hwmon4: Voltage normalised'
    ].join('\n')

    expect(parseVoltageEvents(log)).toEqual({ count: 2, lastEvent: 'Nov 03 18:51:42' })
  })

  it('counts the events in a dmesg log but reports no wall clock', () => {
    const log = [
      '[ 741.740022] hwmon hwmon4: Undervoltage detected!',
      '[ 743.755804] hwmon hwmon4: Voltage normalised'
    ].join('\n')

    expect(parseVoltageEvents(log)).toEqual({ count: 1, lastEvent: null })
  })

  it('reports a log it cannot read as unknown rather than as clean', () => {
    expect(parseVoltageEvents(undefined)).toEqual({ count: null, lastEvent: null })
  })

  it('reports an empty log as no events', () => {
    expect(parseVoltageEvents('')).toEqual({ count: 0, lastEvent: null })
  })
})

describe('findRpiVoltAlarmPath', () => {
  const readDir = () => ['hwmon0', 'hwmon4']

  it('finds the alarm file of the voltage sensor', () => {
    const readFile = (path) => {
      if (path.endsWith('/hwmon4/name')) return 'rpi_volt\n'
      if (path.endsWith('/hwmon0/name')) return 'cpu_thermal\n'
      return ''
    }

    expect(findRpiVoltAlarmPath('/sys/class/hwmon', readFile, readDir)).toBe(
      '/sys/class/hwmon/hwmon4/in0_lcrit_alarm'
    )
  })

  it('reports no sensor when the machine has none', () => {
    const readFile = (path) => (path.endsWith('/hwmon0/name') ? 'cpu_thermal\n' : '')

    expect(findRpiVoltAlarmPath('/sys/class/hwmon', readFile, readDir)).toBeNull()
  })
})

describe('readUndervoltageAlarm', () => {
  const readDir = () => ['hwmon0', 'hwmon4']

  it('reads the live alarm bit', () => {
    const readFile = (path) => {
      if (path.endsWith('/hwmon4/name')) return 'rpi_volt\n'
      if (path.endsWith('in0_lcrit_alarm')) return '1\n'
      return ''
    }

    expect(readUndervoltageAlarm(readFile, '/sys/class/hwmon', readDir)).toBe(true)
  })

  it('reports a normal rail as no alarm', () => {
    const readFile = (path) => {
      if (path.endsWith('/hwmon4/name')) return 'rpi_volt\n'
      if (path.endsWith('in0_lcrit_alarm')) return '0\n'
      return ''
    }

    expect(readUndervoltageAlarm(readFile, '/sys/class/hwmon', readDir)).toBe(false)
  })

  it('reports an unreadable sensor as unknown', () => {
    const readFile = () => {
      throw new Error('EACCES')
    }

    expect(readUndervoltageAlarm(readFile, '/sys/class/hwmon', readDir)).toBeNull()
  })
})

describe('parseTemperature', () => {
  it('turns millidegrees into degrees', () => {
    expect(parseTemperature('56200')).toBe(56.2)
  })

  it('reports a reading it cannot read as unknown', () => {
    expect(parseTemperature('nonsense')).toBeNull()
  })
})

describe('parseLoad', () => {
  it('reads the three load averages', () => {
    expect(parseLoad('0.52 0.79 0.88 1/234 5678')).toEqual([0.52, 0.79, 0.88])
  })

  it('reports a reading it cannot read as unknown', () => {
    expect(parseLoad('')).toBeNull()
  })
})

describe('readVoltState', () => {
  const kernelLog = [
    'Nov 03 18:51:22 BaveryPi kernel: hwmon hwmon4: Undervoltage detected!',
    'Nov 03 18:51:42 BaveryPi kernel: hwmon hwmon4: Undervoltage detected!'
  ].join('\n')

  function deps(overrides = {}) {
    return {
      readFile: (path) => {
        if (path.endsWith('/hwmon4/name')) return 'rpi_volt\n'
        if (path.endsWith('in0_lcrit_alarm')) return '1\n'
        if (path.endsWith('thermal_zone0/temp')) return '56200\n'
        if (path.endsWith('/proc/loadavg')) return '0.52 0.79 0.88 1/234 5678\n'
        if (path.endsWith('/proc/uptime')) return '1234.56 9876.54\n'
        return ''
      },
      readDir: () => ['hwmon0', 'hwmon4'],
      hwmonDir: '/sys/class/hwmon',
      thermalPath: '/sys/class/thermal/thermal_zone0/temp',
      loadavgPath: '/proc/loadavg',
      uptimePath: '/proc/uptime',
      kernelLog,
      ...overrides
    }
  }

  it('reports the alarm, the event count and the machine state together', async () => {
    const state = await readVoltState(deps())

    expect(state.undervoltage).toBe(true)
    expect(state.events).toBe(2)
    expect(state.lastEvent).toBe('Nov 03 18:51:42')
    expect(state.temperature).toBe(56.2)
    expect(state.load).toEqual([0.52, 0.79, 0.88])
    expect(state.uptime).toBe(1234.56)
    expect(typeof state.updatedAt).toBe('string')
  })

  it('falls back to dmesg when the journal cannot be read', async () => {
    const exec = async (file) => {
      if (file === 'journalctl') throw new Error('no journal')
      return { stdout: '[ 741.740022] hwmon hwmon4: Undervoltage detected!\n' }
    }

    const state = await readVoltState(deps({ kernelLog: undefined, exec }))

    expect(state.events).toBe(1)
    expect(state.lastEvent).toBeNull()
  })

  it('reports the event count as unknown when no log can be read at all', async () => {
    const exec = async () => {
      throw new Error('nothing readable')
    }

    const state = await readVoltState(deps({ kernelLog: undefined, exec }))

    expect(state.events).toBeNull()
    expect(state.lastEvent).toBeNull()
  })
})

describe('injectVoltBadge', () => {
  it('puts the badge into the page', () => {
    const html = injectVoltBadge('<html><body><div id="app"></div></body></html>')

    expect(html).toContain('data-dsh-volt-badge')
    expect(html).toContain(VOLT_ENDPOINT)
    expect(html.indexOf('data-dsh-volt-badge')).toBeLessThan(html.indexOf('</body>'))
  })

  it('does not add a second badge to a page that already carries one', () => {
    const once = injectVoltBadge('<html><body></body></html>')
    const twice = injectVoltBadge(once)

    expect(twice).toBe(once)
    expect(twice.split('<div data-dsh-volt-badge').length - 1).toBe(1)
  })

  it('still adds the badge to a page that has no body element', () => {
    const html = injectVoltBadge('<div id="app"></div>')

    expect(html).toContain('data-dsh-volt-badge')
  })

  it('leaves a page it cannot read alone', () => {
    expect(injectVoltBadge(undefined)).toBeUndefined()
  })
})

describe('buildVoltBadge', () => {
  it('asks the proxy for the state and refreshes itself', () => {
    const badge = buildVoltBadge()

    expect(badge).toContain(VOLT_ENDPOINT)
    expect(badge).toContain('setInterval')
  })

  it('sits at the top, not at the bottom', () => {
    const badge = buildVoltBadge()

    expect(badge).toMatch(/top:calc\(12px \+ env\(safe-area-inset-top\)\)/)
    expect(badge).not.toMatch(/bottom:/)
  })

  it('shows only the dot and the temperature', () => {
    const badge = buildVoltBadge()

    expect(badge).toContain('data-dsh-volt-dot')
    expect(badge).toContain('data-dsh-volt-text')
    // The face is the temperature, not a sentence.
    expect(badge).toContain('>--°C<')
  })

  it('keeps the full story in the tooltip', () => {
    const badge = buildVoltBadge()

    expect(badge).toContain('badge.title')
    expect(badge).toContain('最近一次欠压')
  })
})
