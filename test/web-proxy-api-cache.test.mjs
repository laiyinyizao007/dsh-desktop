import { describe, expect, it, beforeEach } from 'vitest'
import { held, holdAnswer, forgetHeld, isHoldable, HELD_PATHS } from '../scripts/dsh-web-api-cache.mjs'

/**
 * The proxy holds the answers the page asks for more than once in the same
 * moment, so that the Host sees one request where it used to see five.
 *
 * The held answers are the Host's own configuration — who may sign in,
 * what a preset is, what the settings are — and they are held for a few
 * seconds only.
 */
describe('the held answers', () => {
  beforeEach(() => {
    forgetHeld()
  })

  it('holds the configuration the page asks for at once', () => {
    for (const path of [
      '/api/credentials/describe',
      '/api/agentPresets/list',
      '/api/settings/describe'
    ]) {
      expect(isHoldable('GET', path)).toBe(true)
    }
  })

  it('does not hold what changes while the page is open', () => {
    // The cost meter's figures, the automation board's rows and the
    // catalog being refreshed are work in progress: holding them would
    // show a stale one.
    for (const path of [
      '/api/costMeter/getState',
      '/api/costMeter/getSessionCost',
      '/capital-automation/board',
      '/api/desktop-workbenches/catalog',
      '/api/session/list'
    ]) {
      expect(isHoldable('GET', path)).toBe(false)
    }
  })

  it('does not hold anything that is not a read', () => {
    expect(isHoldable('POST', '/api/agentPresets/list')).toBe(false)
    expect(isHoldable('DELETE', '/api/agentPresets/list')).toBe(false)
  })

  it('does not hold a path it does not know', () => {
    expect(isHoldable('GET', '/api/something-else')).toBe(false)
  })

  it('hands the held answer back for the same key', () => {
    const answer = { status: 200, headers: {}, body: Buffer.from('{}') }
    holdAnswer('/api/settings/describe', answer)
    const entry = held.get('/api/settings/describe')
    expect(entry).toBeDefined()
    expect(entry.answer).toBe(answer)
    expect(entry.expiresAt).toBeGreaterThan(Date.now())
  })

  it('keeps the answers apart by key', () => {
    holdAnswer('/api/settings/describe', { status: 200, headers: {}, body: Buffer.from('a') })
    holdAnswer('/api/credentials/describe', { status: 200, headers: {}, body: Buffer.from('b') })
    expect(held.size).toBe(2)
    expect(held.get('/api/settings/describe').answer.body.toString()).toBe('a')
    expect(held.get('/api/credentials/describe').answer.body.toString()).toBe('b')
  })

  it('forgets every answer when the Harness restarts', () => {
    holdAnswer('/api/settings/describe', { status: 200, headers: {}, body: Buffer.from('{}') })
    expect(held.size).toBeGreaterThan(0)
    forgetHeld()
    expect(held.size).toBe(0)
  })

  it('holds nothing that carries a credential', () => {
    // The list is checked by name, because an answer that carries a
    // credential must not be held: it would be handed to the next request
    // for it, which may be a different session.
    const names = [...HELD_PATHS].join(' ')
    expect(names).not.toMatch(/token|secret|password|credential-?value/i)
  })
})
