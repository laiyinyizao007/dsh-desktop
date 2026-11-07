import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLE_URL_FORMAT,
  cacheableBundleUrl,
  cacheableRequestUrl,
  chunkRequestUrl,
  harnessBundleUrl,
  harnessChunkUrl,
  isBundlePath
} from '../scripts/dsh-web-plugin-url.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const proxySource = readFileSync(join(here, '../scripts/dsh-web-proxy.mjs'), 'utf8')

/**
 * The two forms a plugin URL comes in.
 *
 * The Harness composes one bundle from a list of plugin ids and addresses
 * it as `plugins/??<id>/client.js,<id>/client.js&rev=<hash>`. The proxy
 * advertises the same bundle as
 * `plugins/<id>/client.js,<id>/client.js?rev=<hash>&proxy=2`, a path an
 * edge cache can key on.
 */
const MERGED =
  '/plugins/@deepseek-ai/dsh-api-gateway/client.js,@deepseek-ai/dsh-client-ui-open-in-app/client.js'
const MERGED_REV = '811c5f958a39'

describe('harnessBundleUrl', () => {
  it('turns a merged bundle back into the list the Harness reads', () => {
    expect(harnessBundleUrl(`${MERGED}?rev=${MERGED_REV}&proxy=2`)).toBe(
      `/plugins/??${MERGED.slice('/plugins/'.length)}&rev=${MERGED_REV}`
    )
  })

  it('turns a one-element list into the list the Harness reads', () => {
    // One plugin on its own is a bundle too: the Harness composes it from
    // a one-element list. The number of entries says nothing.
    expect(harnessBundleUrl('/plugins/@deepseek-ai/dsh-api-gateway/client.js?rev=90ea62fd2151&proxy=2')).toBe(
      '/plugins/??@deepseek-ai/dsh-api-gateway/client.js&rev=90ea62fd2151'
    )
  })

  it('turns a bundle source map back into the list the Harness reads', () => {
    expect(harnessBundleUrl('/plugins/@deepseek-ai/dsh-api-gateway/client.js.map?rev=90ea62fd2151')).toBe(
      '/plugins/??@deepseek-ai/dsh-api-gateway/client.js.map&rev=90ea62fd2151'
    )
  })

  it('leaves the Harness’s own form alone', () => {
    const own = `/plugins/??${MERGED.slice('/plugins/'.length)}&rev=${MERGED_REV}`
    expect(harnessBundleUrl(own)).toBe(own)
  })

  it('leaves a package-local chunk as it arrived', () => {
    // `dsh-cost-meter/client.sidebar-order.js` is a file the Harness serves
    // by name. Rewriting it into the list form is what answered a 404 for a
    // file that is on disk.
    const chunk = '/plugins/dsh-cost-meter/client.sidebar-order.js?rev=651a61b9cbbf'
    expect(harnessBundleUrl(chunk)).toBe(chunk)
  })

  it('leaves a chunk with a suffixed name alone', () => {
    const chunk = '/plugins/@deepseek-ai/dsh-api-gateway/client.browser.js?rev=90ea62fd2151'
    expect(harnessBundleUrl(chunk)).toBe(chunk)
    const map = '/plugins/@deepseek-ai/dsh-api-gateway/client.browser.js.map?rev=90ea62fd2151'
    expect(harnessBundleUrl(map)).toBe(map)
  })

  it('keeps only the revision', () => {
    // The Harness derives the revision from the plugin list, so an extra
    // parameter would make the two disagree and the bundle would not be
    // found.
    expect(harnessBundleUrl(`${MERGED}?rev=${MERGED_REV}&proxy=2`)).not.toContain('proxy=')
  })

  it('leaves a path that is not a plugin bundle alone', () => {
    expect(harnessBundleUrl('/api/session/list')).toBe('/api/session/list')
    expect(harnessBundleUrl('/plugins/style.css?rev=abc')).toBe('/plugins/style.css?rev=abc')
    expect(harnessBundleUrl(`/plugins/${MERGED.slice('/plugins/'.length)}`)).toBe(
      `/plugins/${MERGED.slice('/plugins/'.length)}`
    )
  })
})

describe('cacheableBundleUrl', () => {
  it('rewrites the list in an HTML attribute', () => {
    expect(cacheableBundleUrl(`/plugins/??a/client.js,b/client.js&amp;rev=${MERGED_REV}`)).toBe(
      `/plugins/a/client.js,b/client.js?rev=${MERGED_REV}&proxy=${BUNDLE_URL_FORMAT}`
    )
  })

  it('rewrites the list in the module graph', () => {
    // The module graph lives in a <script>, so its entities are intact and
    // the revision is written as `&rev=`.
    expect(cacheableBundleUrl(`/plugins/??a/client.js,b/client.js&rev=${MERGED_REV}`)).toBe(
      `/plugins/a/client.js,b/client.js?rev=${MERGED_REV}&proxy=${BUNDLE_URL_FORMAT}`
    )
  })

  it('leaves the path in a shape a cache can key on', () => {
    const cached = cacheableBundleUrl(`/plugins/??a/client.js,b/client.js&rev=${MERGED_REV}`)
    expect(cached).toMatch(/\.js\?rev=/)
  })

  it('leaves a URL that is not a list alone', () => {
    expect(cacheableBundleUrl('/api/session/list')).toBe('/api/session/list')
    expect(cacheableBundleUrl('/plugins/a/client.js?rev=abc')).toBe('/plugins/a/client.js?rev=abc')
  })
})

describe('cacheableRequestUrl', () => {
  it('points the Harness’s own form at the cacheable form', () => {
    expect(cacheableRequestUrl(`/plugins/??a/client.js,b/client.js&rev=${MERGED_REV}`)).toBe(
      `/plugins/a/client.js,b/client.js?rev=${MERGED_REV}&proxy=${BUNDLE_URL_FORMAT}`
    )
  })

  it('has no answer for anything else', () => {
    expect(cacheableRequestUrl('/api/session/list')).toBeUndefined()
    expect(cacheableRequestUrl('/plugins/a/client.js?rev=abc')).toBeUndefined()
  })
})

describe('chunkRequestUrl', () => {
  it('marks a chunk so the edge cache keys it apart from a bundle', () => {
    // The edge cache keys on the whole URL. A chunk shares its revision
    // with the bundle it was cut from, so without a marker of its own it
    // shares that bundle's entry — and what was kept there was the bundle.
    const chunk = '/plugins/dsh-cost-meter/client.sidebar-order.js?rev=651a61b9cbbf'
    const marked = chunkRequestUrl(chunk)
    expect(marked).toBe(
      `/plugins/dsh-cost-meter/client.sidebar-order.js?rev=651a61b9cbbf&proxy=${BUNDLE_URL_FORMAT}`
    )
    expect(marked).not.toBe(chunk)
  })

  it('leaves a bundle alone', () => {
    expect(chunkRequestUrl(`${MERGED}?rev=${MERGED_REV}&proxy=2`)).toBeUndefined()
    expect(chunkRequestUrl('/plugins/@deepseek-ai/dsh-api-gateway/client.js?rev=abc')).toBeUndefined()
  })

  it('leaves a chunk that already carries the marker alone', () => {
    const marked = '/plugins/dsh-cost-meter/client.sidebar-order.js?rev=651a61b9cbbf&proxy=2'
    expect(chunkRequestUrl(marked)).toBeUndefined()
  })

  it('has no answer for a chunk without a revision', () => {
    expect(chunkRequestUrl('/plugins/dsh-cost-meter/client.sidebar-order.js')).toBeUndefined()
  })

  it('has no answer for anything that is not a plugin', () => {
    expect(chunkRequestUrl('/api/session/list?rev=abc')).toBeUndefined()
  })

  it('keeps the revision it was given', () => {
    const marked = chunkRequestUrl('/plugins/dsh-cost-meter/client.sidebar-order.js?rev=651a61b9cbbf')
    expect(marked).toContain('rev=651a61b9cbbf')
  })
})

describe('harnessChunkUrl', () => {
  it('takes the marker off before the URL goes upstream', () => {
    // The Harness answers a URL it cannot parse with the bundle it has,
    // so the marker must not reach it.
    const marked = '/plugins/dsh-cost-meter/client.sidebar-order.js?rev=651a61b9cbbf&proxy=2'
    expect(harnessChunkUrl(marked)).toBe(
      '/plugins/dsh-cost-meter/client.sidebar-order.js?rev=651a61b9cbbf'
    )
  })

  it('leaves a chunk without the marker alone', () => {
    const chunk = '/plugins/dsh-cost-meter/client.sidebar-order.js?rev=651a61b9cbbf'
    expect(harnessChunkUrl(chunk)).toBe(chunk)
  })

  it('leaves a bundle alone', () => {
    const bundle = `${MERGED}?rev=${MERGED_REV}&proxy=2`
    expect(harnessChunkUrl(bundle)).toBe(bundle)
  })

  it('leaves anything that is not a plugin alone', () => {
    expect(harnessChunkUrl('/api/session/list?rev=abc&proxy=2')).toBe('/api/session/list?rev=abc&proxy=2')
  })
})

describe('isBundlePath', () => {
  it('calls a merged list a bundle', () => {
    expect(isBundlePath(MERGED)).toBe(true)
  })

  it('calls a one-element list a bundle', () => {
    expect(isBundlePath('/plugins/@deepseek-ai/dsh-api-gateway/client.js')).toBe(true)
  })

  it('calls a source map a bundle', () => {
    expect(isBundlePath('/plugins/@deepseek-ai/dsh-api-gateway/client.js.map')).toBe(true)
  })

  it('does not call a package-local chunk a bundle', () => {
    // A chunk borrows the revision of the bundle it was cut from, so it is
    // not content-addressed: caching it for a year keeps a stale chunk.
    expect(isBundlePath('/plugins/dsh-cost-meter/client.sidebar-order.js')).toBe(false)
  })

  it('does not call a chunk with a suffixed name a bundle', () => {
    expect(isBundlePath('/plugins/@deepseek-ai/dsh-api-gateway/client.browser.js')).toBe(false)
  })
})

describe('the proxy', () => {
  it('takes the URL helpers from the shared module', () => {
    expect(proxySource).toContain("from './dsh-web-plugin-url.mjs'")
    expect(proxySource).not.toMatch(/function harnessBundleUrl/)
    expect(proxySource).not.toMatch(/function cacheableBundleUrl/)
    expect(proxySource).not.toMatch(/function cacheableRequestUrl/)
    expect(proxySource).not.toMatch(/const BUNDLE_URL_FORMAT\s*=/)
  })

  it('caches a chunk for a short while, not forever', () => {
    // A bundle is content-addressed and can be kept for a year. A chunk
    // borrows a revision that moves without its bytes moving, so keeping it
    // that long serves a chunk that no longer exists.
    expect(proxySource).toContain('hasRevision && isBundle')
    expect(proxySource).toContain("isBundlePath(target.path)")
  })

  it('marks a chunk before the edge sees it, and unmarks it before the Harness does', () => {
    // The marker is for the edge cache: it gives the chunk an entry of its
    // own. The Harness must not see it — it answers a URL it cannot parse
    // with the bundle it has.
    expect(proxySource).toContain('chunkRequestUrl(requestUrl)')
    expect(proxySource).toContain('harnessChunkUrl(harnessBundleUrl(rawUrl')
  })
})
