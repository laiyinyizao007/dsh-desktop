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

/** Marker → the upstream package that carries it. */
const MARKERS = {
  layout: '@deepseek-ai+dsh-client-ui-layout',
  sidebar: '@deepseek-ai+dsh-client-ui-layout',
  center: '@deepseek-ai+dsh-client-ui-layout',
  'settings-overlay': '@deepseek-ai+dsh-client-ui-settings-general',
  'settings-nav': '@deepseek-ai+dsh-client-ui-settings-general',
  'settings-nav-list': '@deepseek-ai+dsh-client-ui-settings-general',
  'settings-content': '@deepseek-ai+dsh-client-ui-settings-general',
  'conversation-workspace-row': '@deepseek-ai+dsh-client-ui-conversation',
}

async function pluginSource() {
  return readFile(join(repoRoot, 'packages/dsh-responsive/client.js'), 'utf8')
}

describe('data-dsh-region markers', () => {
  it('every marker the plugin needs is patched into upstream', async () => {
    const patches = new Map()
    for (const name of new Set(Object.values(MARKERS))) {
      const source = await readFile(
        join(repoRoot, 'patches', `${name}+0.2.1-rc.3.patch`),
        'utf8'
      )
      patches.set(name, source)
    }
    for (const marker of Object.keys(MARKERS)) {
      const patch = patches.get(MARKERS[marker])
      expect(patch, `no patch carries ${marker}`).toContain(`"${marker}"`)
    }
  })

  it('the patched files carry the markers at runtime', async () => {
    const files = {
      '@deepseek-ai/dsh-client-ui-layout/lib/client.js': ['layout', 'sidebar', 'center'],
      '@deepseek-ai/dsh-client-ui-settings-general/lib/client.js': [
        'settings-overlay',
        'settings-nav',
        'settings-nav-list',
        'settings-content',
      ],
      '@deepseek-ai/dsh-client-ui-conversation/lib/client.js': ['conversation-workspace-row'],
    }
    for (const [file, markers] of Object.entries(files)) {
      const source = await readFile(join(repoRoot, 'node_modules', file), 'utf8')
      for (const marker of markers) {
        expect(source, `${file} is missing ${marker}`).toContain(`"${marker}"`)
      }
    }
  })
})

describe('dsh-responsive client', () => {
  it('selects on the markers, not on hashed CSS module classes', async () => {
    const source = await pluginSource()
    // The hashed class names change on every upstream build. A comment may
    // name them, but no selector may.
    const selectors = source.match(/querySelector(?:All)?\(([^)]*)\)/g) ?? []
    for (const selector of selectors) {
      expect(selector).not.toMatch(/pI_x6G|P3OORG|_[A-Za-z0-9]{4,6}_(frame|sidebarCol|centerCol)/)
    }
    for (const marker of Object.keys(MARKERS)) {
      // The plugin selects with double quotes in JS and single quotes in
      // the stylesheet (the CSS lives in a template string).
      expect(
        source.includes(`data-dsh-region="${marker}"`) ||
          source.includes(`data-dsh-region='${marker}'`),
        `the plugin never selects on ${marker}`
      ).toBe(true)
    }
  })

  it('names a missing marker instead of failing silently', async () => {
    const source = await pluginSource()
    expect(source).toContain('reportMissingMarkers')
    expect(source).toContain('console.error')
  })

  it('restores the grid track it changed', async () => {
    const source = await pluginSource()
    expect(source).toContain('restoreFirstTrack')
    expect(source).toContain('dshOriginalGrid')
  })

  it('pins the centre column, because a fixed sidebar leaves the grid flow', async () => {
    const source = await pluginSource()
    // Without this the centre column shifts into the sidebar's track and
    // the conversation renders inside a 56 px column.
    expect(source).toContain("grid-column: 2")
  })

  it('lets the conversation content follow the viewport', async () => {
    const source = await pluginSource()
    // The upstream clamp has a 680 px floor, which overflows a phone.
    expect(source).toContain('--dsh-chat-content-width')
  })

  it('respects prefers-reduced-motion', async () => {
    const source = await pluginSource()
    expect(source).toContain('prefers-reduced-motion')
  })

  it('guards its style injection', async () => {
    const source = await pluginSource()
    expect(source).toContain('data-plugin-css="dsh-responsive"')
  })
})
