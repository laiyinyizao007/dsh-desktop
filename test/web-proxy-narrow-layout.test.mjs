import { describe, expect, it } from 'vitest'
import { injectNarrowClearance } from '../scripts/dsh-web-narrow-layout.mjs'

describe('the narrow layout', () => {
  it('keeps the title clear of the rail\'s toggle', () => {
    const html = injectNarrowClearance('<html><head><title>x</title></head><body></body></html>')
    // The clearance is a variable of the upstream's own, so nothing here
    // depends on a class name that a rebuild would rehash.
    expect(html).toContain('--dsh-frame-leading-clearance: 98px')
    expect(html).toMatch(/@media \(max-width: 640px\)/)
  })

  it('puts the style in the head, so it is in place before the app mounts', () => {
    const html = injectNarrowClearance('<html><head><title>x</title></head><body></body></html>')
    expect(html.indexOf('data-dsh-narrow-clearance')).toBeLessThan(html.indexOf('</head>'))
  })

  it('leaves a page that already has the style alone', () => {
    const once = injectNarrowClearance('<html><head></head><body></body></html>')
    expect(injectNarrowClearance(once)).toBe(once)
  })

  it('leaves a page it cannot read alone', () => {
    expect(injectNarrowClearance('')).toBe('')
    expect(injectNarrowClearance(undefined)).toBe(undefined)
  })
})
