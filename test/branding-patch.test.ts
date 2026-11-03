import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

describe('DSH Desktop sidebar branding', () => {

  it('uses upstream platform-aware collapsed titlebar spacing', async () => {
    const client = await readFile(
      path.join(projectRoot, 'node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js'),
      'utf8'
    )

    expect(client).toContain('document.documentElement.dataset.platform === "darwin"')
    expect(client).toContain('document.documentElement.hasAttribute("data-windows-titlebar") ? 0 : 56')
    expect(client).toContain('sidebar === 0 ? collapsedWidth')
  })

  it('installs the source logo into the Harness static frontend', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { scripts: { postinstall: string } }

    expect(packageJson.scripts.postinstall).toContain('node scripts/install-brand-assets.mjs')
  })
})

describe('the favicon the web frontend serves', () => {
  const distDirectory = path.join(
    projectRoot,
    'node_modules',
    '@deepseek-ai',
    'dsh-web-frontend',
    'dist'
  )

  /** The size and colour type of a PNG, read from its header. */
  function readPngHeader(file: Buffer): { width: number; height: number; colorType: number } {
    return {
      width: file.readUInt32BE(16),
      height: file.readUInt32BE(20),
      // 2 is true colour, 3 is the indexed palette.
      colorType: file.readUInt8(25)
    }
  }

  it('is reduced to the size it is displayed at', async () => {
    const file = await readFile(path.join(distDirectory, 'dsh-desktop-logo.png'))

    const header = readPngHeader(file)
    expect(header.width).toBe(256)
    expect(header.height).toBe(256)
  })

  it('is an indexed image, so that it is small enough to fetch', async () => {
    const file = await readFile(path.join(distDirectory, 'dsh-desktop-logo.png'))

    // The source artwork is true colour, and PNG compresses it poorly: the
    // file is a megabyte that neither gzip nor Brotli can reduce, because a
    // PNG is already deflate inside a container. The palette is what makes
    // the file small.
    expect(readPngHeader(file).colorType).toBe(3)
    expect(file.length).toBeLessThan(64 * 1024)
  })

  it('is declared at the size it is served at', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(distDirectory, 'manifest.webmanifest'), 'utf8')
    ) as { icons?: Array<{ src?: string; sizes?: string }> }

    const icon = manifest.icons?.find((entry) => entry.src === '/dsh-desktop-logo.png')
    expect(icon).toBeDefined()
    expect(icon?.sizes).toBe('256x256')
  })
})
