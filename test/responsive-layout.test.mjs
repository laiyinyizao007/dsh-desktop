import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')

/**
 * The responsive plugin's whole upstream contract is the `data-dsh-region`
 * marker list. Upstream rebuilds its stylesheet whenever it ships, which
 * rehashes the CSS module class names (`pI_x6G_frame` and friends), so a
 * plugin that selects on them breaks silently. The markers below are the
 * stable part.
 *
 * These tests fail when upstream changes the frame's structure, so the
 * breakage shows up as a failing test instead of a phone screen that quietly
 * stops adapting.
 */

const MARKERS = ['layout', 'sidebar']

describe('data-dsh-region markers', () => {
  it('the layout frame carries the layout and sidebar markers', async () => {
    const source = await readFile(
      join(repoRoot, 'node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js'),
      'utf8'
    )
    expect(source).toContain('"data-dsh-region": "layout"')
    expect(source).toContain('"data-dsh-region": "sidebar"')
  })

  it('a replayable patch adds the markers', async () => {
    const patch = await readFile(
      join(repoRoot, 'patches/@deepseek-ai+dsh-client-ui-layout+0.2.1-rc.3.patch'),
      'utf8'
    )
    expect(patch).toContain('data-dsh-region')
    expect(patch).toContain('"layout"')
    expect(patch).toContain('"sidebar"')
  })
})

describe('dsh-responsive client', () => {
  it('selects on the markers, not on hashed CSS module classes', async () => {
    const source = await readFile(
      join(repoRoot, 'packages/dsh-responsive/client.js'),
      'utf8'
    )
    // The hashed class names change on every upstream build. A comment may
    // name them, but no selector may.
    const selectors = source.match(/querySelector(?:All)?\(([^)]*)\)/g) ?? []
    for (const selector of selectors) {
      expect(selector).not.toMatch(/pI_x6G|P3OORG|_[A-Za-z0-9]{4,6}_(frame|sidebarCol|centerCol)/)
    }
    for (const marker of MARKERS) {
      expect(source).toContain(`data-dsh-region="${marker}"`)
    }
  })

  it('names a missing marker instead of failing silently', async () => {
    const source = await readFile(
      join(repoRoot, 'packages/dsh-responsive/client.js'),
      'utf8'
    )
    expect(source).toContain('reportMissingMarkers')
    expect(source).toContain('console.error')
    for (const marker of MARKERS) {
      expect(source).toContain(`'${marker}'`)
    }
  })

  it('restores the grid track it changed', async () => {
    const source = await readFile(
      join(repoRoot, 'packages/dsh-responsive/client.js'),
      'utf8'
    )
    expect(source).toContain('restoreFirstTrack')
    expect(source).toContain('dshOriginalGrid')
  })

  it('respects prefers-reduced-motion', async () => {
    const source = await readFile(
      join(repoRoot, 'packages/dsh-responsive/client.js'),
      'utf8'
    )
    expect(source).toContain('prefers-reduced-motion')
  })

  it('guards its style injection', async () => {
    const source = await readFile(
      join(repoRoot, 'packages/dsh-responsive/client.js'),
      'utf8'
    )
    expect(source).toContain('data-plugin-css="dsh-responsive"')
  })
})
