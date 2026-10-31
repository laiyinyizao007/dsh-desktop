import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
const clientPath = join(repoRoot, 'packages/dsh-desktop-responsive/client.js')

/**
 * The plugin's whole upstream contract is the anchor manifest it exports.
 *
 * Upstream rebuilds its stylesheet whenever it ships, which rehashes the CSS
 * module class names (`pI_x6G_frame` and friends), so a plugin that selects
 * on them breaks silently. The anchors are either a `data-dsh-region` marker
 * this repository patches into upstream, or a stable data attribute upstream
 * already ships.
 *
 * These tests fail when upstream changes one of those surfaces, so the
 * breakage shows up as a failing test instead of a phone screen that quietly
 * stops adapting. The plugin's own behaviour is checked by
 * `test/responsive-layout-client.test.mjs`.
 */

/** The upstream package each anchor belongs to, and the file it lives in. */
const UPSTREAM_FILES = {
  '@deepseek-ai/dsh-client-ui-layout': 'lib/client.js',
  '@deepseek-ai/dsh-client-ui-sidebar': 'lib/client.js',
  '@deepseek-ai/dsh-client-ui-conversation': 'lib/client.js',
  '@deepseek-ai/dsh-client-ui-chat': 'lib/client.js',
  '@deepseek-ai/dsh-client-ui-settings-general': 'lib/client.js',
  '@deepseek-ai/dsh-client-ui-primitives': 'lib/index.js',
  '@deepseek-ai/dsh-client-ui-model-selection': 'lib/client.js',
}

/** The patch file that carries the markers of one upstream package. */
function patchFile(pkg) {
  return join(repoRoot, 'patches', `${pkg.replace('/', '+')}+0.2.1-rc.3.patch`)
}

/** Read one installed upstream file. */
async function upstreamSource(pkg) {
  return readFile(join(repoRoot, 'node_modules', pkg, UPSTREAM_FILES[pkg]), 'utf8')
}

/** The marker value an anchor selector carries, e.g. `layout` → `layout`. */
function markerValue(selector) {
  const match = /\[data-dsh-region=["']([^"']+)["']\]/.exec(selector)
  return match === null ? null : match[1]
}

/** Strip comments so a hashed class name in prose is not read as a selector. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * Load the plugin's manifest.
 *
 * The plugin is a browser module that registers itself with
 * `window.__ModuleLoader__`. The test stands in for the loader so the module
 * can be imported outside a browser; the manifest is then read from the
 * module's own exports, so the contract cannot drift from the code.
 */
async function loadManifest() {
  let captured = null
  globalThis.window = {
    __ModuleLoader__: {
      load(module) {
        captured = module
      },
    },
  }
  vi.resetModules()
  await import('../packages/dsh-desktop-responsive/client.js')
  if (captured === null) throw new Error('the client plugin did not register itself')
  const exports = captured.factory()
  delete globalThis.window
  return exports.anchors
}

describe('the anchor manifest', () => {
  let anchors = null

  beforeEach(async () => {
    anchors = await loadManifest()
  })

  afterEach(() => {
    delete globalThis.window
  })

  it('is not empty', () => {
    expect(Object.keys(anchors).length).toBeGreaterThan(0)
  })

  it('names the package and the origin of every anchor', () => {
    for (const [key, anchor] of Object.entries(anchors)) {
      expect(anchor.package, `${key} has no upstream package`).toBeTruthy()
      expect(
        UPSTREAM_FILES[anchor.package],
        `${key} names an unknown upstream package: ${anchor.package}`
      ).toBeTruthy()
      // 'element' is a semantic HTML element: it has no upstream class
      // name to rehash, so it is as stable as an attribute.
      expect(
        ['marker', 'attribute', 'element'],
        `${key} has an unknown origin`
      ).toContain(anchor.origin)
    }
  })

  it('carries every marker anchor in the patch of its package', async () => {
    for (const [key, anchor] of Object.entries(anchors)) {
      if (anchor.origin !== 'marker') continue
      const marker = markerValue(anchor.selector)
      expect(marker, `${key} has no marker value`).toBeTruthy()
      const patch = await readFile(patchFile(anchor.package), 'utf8')
      expect(patch, `no patch carries ${key}`).toContain(`"${marker}"`)
    }
  })

  it('has every anchor present in the installed upstream source', async () => {
    for (const [key, anchor] of Object.entries(anchors)) {
      const source = await upstreamSource(anchor.package)
      if (anchor.origin === 'marker') {
        const marker = markerValue(anchor.selector)
        expect(source, `${anchor.package} does not carry ${key}`).toContain(`"${marker}"`)
        continue
      }
      if (anchor.origin === 'element') {
        // A semantic element name — `table`, `button` — has no upstream
        // class name to rehash, so the element itself is the contract.
        // Upstream renders it as a string argument to `createElement`, so
        // the name appears quoted rather than as a tag. A selector that
        // carries an attribute is an attribute anchor in disguise and is
        // checked by name below.
        if (!anchor.selector.includes('[')) {
          expect(
            source,
            `${anchor.package} does not carry ${key}`
          ).toMatch(new RegExp(`["'\`]${anchor.selector}["'\`]`))
          continue
        }
        const attribute = anchor.selector.slice(1, -1).split('=')[0]
        expect(source, `${anchor.package} does not carry ${key}`).toContain(attribute)
        continue
      }
      // An upstream attribute is written with a dynamic value — the resize
      // handle renders `"data-side": props.side` — so only the attribute
      // name can be asserted against the source.
      const attribute = anchor.selector.slice(1, -1).split('=')[0]
      expect(source, `${anchor.package} does not carry ${key}`).toContain(attribute)
    }
  })
})

describe('the plugin source', () => {
  it('does not select on a hashed CSS module class', async () => {
    const source = stripComments(await readFile(clientPath, 'utf8'))
    // Upstream's class names look like `pI_x6G_frame`; the hash changes on
    // every upstream build, so a selector on one breaks silently.
    expect(source).not.toMatch(/\.[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9]{4,6}_[A-Za-z]/)
    expect(source).not.toMatch(/["'`][A-Za-z][A-Za-z0-9]*_[A-Za-z0-9]{4,6}_[A-Za-z]/)
  })

  it('selects only on anchors from the manifest', async () => {
    const anchors = await loadManifest()
    const source = stripComments(await readFile(clientPath, 'utf8'))
    const known = new Set(Object.values(anchors).map(anchor => anchor.selector))
    const used = new Set()
    for (const match of source.matchAll(/\[data-[a-z-]+(?:=["'][^"']*["'])?\]/g)) {
      used.add(match[0])
    }
    for (const selector of used) {
      // The plugin's own attributes are namespaced, so they are not part of
      // the upstream contract.
      const isPluginOwned = selector.startsWith('[data-dshr-') || selector.startsWith('[data-plugin-css')
      expect(
        known.has(selector) || isPluginOwned,
        `the plugin selects on ${selector}, which is not in the manifest`
      ).toBe(true)
    }
    // Every anchor has to be used, or the manifest carries dead weight.
    for (const [key, anchor] of Object.entries(anchors)) {
      expect(
        source.includes(anchor.selector),
        `the plugin never selects on ${key} (${anchor.selector})`
      ).toBe(true)
    }
  })

  it('names a missing anchor instead of failing silently', async () => {
    const source = await readFile(clientPath, 'utf8')
    expect(source).toContain('auditAnchors')
    expect(source).toContain('console.error')
  })

  it('respects prefers-reduced-motion', async () => {
    const source = await readFile(clientPath, 'utf8')
    expect(source).toContain('prefers-reduced-motion')
  })

  it('guards its style injection', async () => {
    const source = await readFile(clientPath, 'utf8')
    expect(source).toContain('data-plugin-css')
    expect(source).toContain('dsh-desktop-responsive')
  })

  it('does not assume upstream DOM structure', async () => {
    const source = stripComments(await readFile(clientPath, 'utf8'))
    // A structural selector such as `:first-child` encodes an assumption
    // about upstream's render tree that no marker can protect. Every
    // element the plugin touches has to carry an anchor instead.
    const structural = source.match(/:\s*(first-child|last-child|nth-child|nth-of-type|first-of-type|last-of-type)\b/g)
    expect(
      structural,
      `the plugin relies on upstream's DOM structure: ${structural?.join(', ')}`
    ).toBeNull()
  })

  it('does not reach into upstream for anything but its anchors', async () => {
    const source = stripComments(await readFile(clientPath, 'utf8'))
    // The frame's grid is the one upstream value the plugin reads, and it
    // reads it through the style property rather than through a selector.
    const reads = source.match(/querySelector(?:All)?\(([^)]*)\)/g) ?? []
    const anchors = await loadManifest()
    const known = new Set(Object.values(anchors).map(anchor => anchor.selector))
    for (const read of reads) {
      const argument = /querySelector(?:All)?\(([^)]*)\)/.exec(read)?.[1] ?? ''
      if (argument.includes('`')) continue // A template built from the manifest.
      const literal = /'([^']+)'|"([^"]+)"/.exec(argument)
      if (literal === null) continue
      const selector = literal[1] ?? literal[2]
      expect(
        known.has(selector) || selector.startsWith('[data-dshr-'),
        `the plugin queries ${selector}, which is not in the manifest`
      ).toBe(true)
    }
  })
})

describe("the plugin's own dictionary", () => {
  it('names the model menu the way upstream names it', async () => {
    // The plugin finds the model menu by the name upstream gives it, so the
    // two dictionaries have to agree. Upstream ships its strings inside its
    // own bundle rather than in a locale file.
    const upstream = await upstreamSource('@deepseek-ai/dsh-client-ui-model-selection')
    const names = [...upstream.matchAll(/"menu\.aria":\s*"([^"]+)"/g)].map(match => match[1])
    expect(names.length).toBeGreaterThan(0)
    const plugin = await readFile(clientPath, 'utf8')
    const own = [...plugin.matchAll(/'modelMenu\.aria':\s*'([^']+)'/g)].map(match => match[1])
    for (const name of names) {
      expect(
        own,
        `the plugin does not know the model menu name "${name}"; upstream renamed it`
      ).toContain(name)
    }
  })
})

describe('the upstream patches', () => {
  it('are named after the installed upstream version', async () => {
    // patch-package applies a patch whose file name carries another
    // version, but only with a warning. Renaming the file is mechanical,
    // so the drift is caught here instead of in a build log.
    const anchors = await loadManifest()
    const packages = new Set(Object.values(anchors).map(anchor => anchor.package))
    for (const pkg of packages) {
      const manifest = JSON.parse(
        await readFile(join(repoRoot, 'node_modules', pkg, 'package.json'), 'utf8')
      )
      const file = join(
        repoRoot,
        'patches',
        `${pkg.replace('/', '+')}+${manifest.version}.patch`
      )
      await expect(readFile(file, 'utf8'), `${pkg} has no patch for ${manifest.version}`).resolves.toBeTruthy()
    }
  })
})
