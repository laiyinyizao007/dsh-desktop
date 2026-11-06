import { describe, expect, it } from 'vitest'
import { injectBootNotice } from '../scripts/dsh-web-boot-notice.mjs'

describe('injectBootNotice', () => {
  it('puts the notice into the page', () => {
    const html = injectBootNotice('<html><body><div id="root"></div></body></html>')

    expect(html).toContain('data-dsh-boot-notice')
    expect(html.indexOf('data-dsh-boot-notice')).toBeLessThan(html.indexOf('</body>'))
  })

  it('does not add a second notice to a page that already carries one', () => {
    const once = injectBootNotice('<html><body></body></html>')
    const twice = injectBootNotice(once)

    expect(twice).toBe(once)
    expect(twice.split('<div data-dsh-boot-notice').length - 1).toBe(1)
  })

  it('still adds the notice to a page that has no body element', () => {
    const html = injectBootNotice('<div id="root"></div>')

    expect(html).toContain('data-dsh-boot-notice')
  })

  it('leaves a page it cannot read alone', () => {
    expect(injectBootNotice(undefined)).toBeUndefined()
    expect(injectBootNotice('')).toBe('')
  })
})

describe('the notice', () => {
  it('stays out of the way until the boot has taken long enough to worry about', () => {
    const html = injectBootNotice('<html><body></body></html>')

    // The card is hidden by default and appears after the delay, so a page
    // that comes up in two seconds never shows it.
    expect(html).toContain('display:none')
    expect(html).toContain('seconds >= 8')
  })

  it('waits for the app to mount before it goes away', () => {
    const html = injectBootNotice('<html><body></body></html>')

    // The upstream boot screen marks itself, and the app replaces the body,
    // so both are how the notice knows the client has come up.
    expect(html).toContain('data-dsh-boot')
    expect(html).toContain("document.getElementById('root')")
  })

  it('offers a way to try again', () => {
    const html = injectBootNotice('<html><body></body></html>')

    expect(html).toContain('data-dsh-boot-notice-retry')
    expect(html).toContain('location.reload()')
  })
})
