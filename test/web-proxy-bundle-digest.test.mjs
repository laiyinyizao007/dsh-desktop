import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentDigest, currentDigests } from '../scripts/dsh-web-bundle-digest.mjs'

describe('contentDigest', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-digest-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('gives the same digest for the same content', () => {
    const a = join(dir, 'a.js')
    const b = join(dir, 'b.js')
    writeFileSync(a, 'same bytes')
    writeFileSync(b, 'same bytes')
    expect(contentDigest(a)).toBe(contentDigest(b))
  })

  it('gives a different digest for different content', () => {
    const a = join(dir, 'a.js')
    const b = join(dir, 'b.js')
    writeFileSync(a, 'one')
    writeFileSync(b, 'two')
    expect(contentDigest(a)).not.toBe(contentDigest(b))
  })

  it('gives the same digest when the file is written again with the same content', () => {
    // This is the case the timestamp could not tell: the bytes are the
    // ones the Harness is already serving, and a restart would serve them
    // again for nothing.
    const path = join(dir, 'a.js')
    writeFileSync(path, 'unchanged')
    const first = contentDigest(path)
    const later = new Date(Date.now() + 60_000)
    writeFileSync(path, 'unchanged')
    utimesSync(path, later, later)
    expect(statSync(path).mtimeMs).toBeGreaterThan(statSync(path).ctimeMs - 1)
    expect(contentDigest(path)).toBe(first)
  })

  it('gives a different digest when the content changes', () => {
    const path = join(dir, 'a.js')
    writeFileSync(path, 'before')
    const first = contentDigest(path)
    writeFileSync(path, 'after')
    expect(contentDigest(path)).not.toBe(first)
  })

  it('has no answer for a file that cannot be read', () => {
    expect(contentDigest(join(dir, 'missing.js'))).toBeUndefined()
  })
})

describe('currentDigests', () => {
  it('reports the digest of each resource it can read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-digest-'))
    try {
      const a = join(dir, 'a.js')
      const b = join(dir, 'b.js')
      writeFileSync(a, 'a')
      writeFileSync(b, 'b')
      const digests = currentDigests([
        ['one', a],
        ['two', b],
        ['gone', join(dir, 'gone.js')]
      ])
      expect(digests.size).toBe(2)
      expect(digests.get('one')).toBe(contentDigest(a))
      expect(digests.get('two')).toBe(contentDigest(b))
      expect(digests.has('gone')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
