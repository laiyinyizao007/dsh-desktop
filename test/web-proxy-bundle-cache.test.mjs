import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleCacheName } from '../scripts/dsh-web-bundle-cache.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const proxySource = readFileSync(join(here, '../scripts/dsh-web-proxy.mjs'), 'utf8')

/**
 * A bundle and its package-local chunks share one revision.
 *
 * The Harness cuts them from the same build, so
 * `dsh-cost-meter/client.js` and `dsh-cost-meter/client.sidebar-order.js`
 * are both `rev=651a61b9cbbf`. A cache keyed on the revision alone let the
 * bundle overwrite the chunk, and the browser then ran the bundle where it
 * expected the chunk: the chunk's factory registered a second time under
 * the bundle's id, and the module system refused it —
 *
 *   client-modules: duplicate factory registration for "dsh-cost-meter"
 */
const REVISION = '651a61b9cbbf'
const BUNDLE = '/plugins/dsh-cost-meter/client.js'
const CHUNK = '/plugins/dsh-cost-meter/client.sidebar-order.js'

describe('bundleCacheName', () => {
  it('gives a bundle and its chunk different names under one revision', () => {
    expect(bundleCacheName(REVISION, BUNDLE)).not.toBe(bundleCacheName(REVISION, CHUNK))
  })

  it('gives the same name to the same resource under the same revision', () => {
    expect(bundleCacheName(REVISION, CHUNK)).toBe(bundleCacheName(REVISION, CHUNK))
  })

  it('gives a different name to the same resource under another revision', () => {
    expect(bundleCacheName(REVISION, CHUNK)).not.toBe(bundleCacheName('90ea62fd2151', CHUNK))
  })

  it('carries the revision, so a stale entry is not mistaken for a fresh one', () => {
    expect(bundleCacheName(REVISION, CHUNK)).toContain(REVISION)
  })

  it('keeps the name bounded, however long the path is', () => {
    const long = `/plugins/${Array.from({ length: 80 }, (_, i) => `plugin-${i}/client.js`).join(',')}`
    const name = bundleCacheName(REVISION, long)
    expect(name.length).toBeLessThan(64)
    expect(name.endsWith('.br')).toBe(true)
  })

  it('has no answer for a request that asks for no revision', () => {
    expect(bundleCacheName(undefined, CHUNK)).toBeUndefined()
    expect(bundleCacheName('', CHUNK)).toBeUndefined()
  })

  it('tells two different bundles apart under one revision', () => {
    const other = '/plugins/dsh-workbench-project-console/client.js'
    expect(bundleCacheName(REVISION, BUNDLE)).not.toBe(bundleCacheName(REVISION, other))
  })
})

describe('the proxy', () => {
  it('takes the cache name from the shared module', () => {
    expect(proxySource).toContain("from './dsh-web-bundle-cache.mjs'")
    expect(proxySource).not.toMatch(/function bundleCacheName/)
  })

  it('passes the resource path to both the read and the write', () => {
    // The path is what tells a bundle apart from its chunk. A call that
    // leaves it out would read one resource's body for another's request.
    expect(proxySource).toMatch(/cachedBundle\(revision, resourcePath\)/)
    expect(proxySource).toMatch(/storeBundle\(bundleRevision\(target\.path\), resourcePath, body\)/)
    expect(proxySource).not.toMatch(/cachedBundle\(revision\)/)
  })

  it('keys the cache on the path without its query', () => {
    // The revision is already part of the key, so the query would only
    // repeat it — and the query carries the parameters the proxy adds.
    expect(proxySource).toContain("const resourcePath = target.path.split('?')[0]")
  })
})
