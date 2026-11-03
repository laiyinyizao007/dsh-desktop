import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(projectRoot, 'build', 'icon.png')
const lightSource = path.join(projectRoot, 'build', 'logo-light.png')
const darkSource = path.join(projectRoot, 'build', 'logo-dark.png')
const destinationDirectory = path.join(
  projectRoot,
  'node_modules',
  '@deepseek-ai',
  'dsh-web-frontend',
  'dist'
)
const destination = path.join(destinationDirectory, 'dsh-desktop-logo.png')
const lightDestination = path.join(destinationDirectory, 'dsh-desktop-logo-light.png')
const darkDestination = path.join(destinationDirectory, 'dsh-desktop-logo-dark.png')
const indexPath = path.join(destinationDirectory, 'index.html')
const manifestPath = path.join(destinationDirectory, 'manifest.webmanifest')

/**
 * The size the favicon is served at.
 *
 * The source artwork is 1254x1254, which is the size a packaged desktop
 * icon wants — but the web favicon is drawn at 16-32 px, and the manifest's
 * largest entry is what a browser reads for the home-screen icon. Serving
 * the source artwork to both means a page that fetches the icon pulls a
 * megabyte of pixels to display something a few dozen pixels wide.
 *
 * 256 px is the size the PWA manifest asks for and is larger than any
 * display size the icon is actually used at.
 */
const FAVICON_SIZE = 256

/**
 * The number of colours the favicon is reduced to.
 *
 * The source artwork is true colour, and PNG compresses that poorly: the
 * file is a megabyte of mostly-flat pixels that deflate cannot do much
 * with, and neither gzip nor Brotli can do anything with it either — a PNG
 * is already deflate inside a container that gzip would just wrap again.
 *
 * The artwork is a logo, so it has few enough distinct colours to be an
 * indexed PNG. That is the only thing that makes the file small: the
 * palette costs 256 bytes per pixel row of the palette, and the pixels
 * become one byte each.
 */
const FAVICON_COLORS = 256

/**
 * Swap the Harness favicon link for the desktop's own.
 *
 * The href is matched rather than pinned: 0.1.2-alpha.1 moved it from
 * `/favicon.svg` to `./favicon.svg`. Harness 0.1.7-rc.1 declares separate
 * light and dark favicon links; Desktop uses the same PNG for both themes.
 * @param contents - index.html source.
 * @param file - path shown in the failure message.
 * @returns index.html with the desktop icon link.
 */
function replaceIconLink(contents, file) {
  const desktop = '<link rel="icon" type="image/png" href="/dsh-desktop-logo.png" />'
  if (contents.includes(desktop)) return contents
  const matches = contents.match(/<link rel="icon"[^>]*>/gu) ?? []
  const themedLinks = matches.length === 2
    && matches.some((link) => link.includes('media="(prefers-color-scheme: dark)"'))
    && matches.some((link) => link.includes('media="(prefers-color-scheme: light)"'))
  if (matches.length !== 1 && !themedLinks) {
    throw new Error(
      `Could not update DSH Desktop branding in ${file}: expected one icon link or a light/dark pair, found ${String(matches.length)}`
    )
  }
  return themedLinks
    ? contents.replace(matches[0], desktop).replace(matches[1], '')
    : contents.replace(matches[0], desktop)
}

/**
 * Point the web manifest's icon at the desktop logo.
 *
 * Edited as JSON rather than as text: upstream added `"purpose": "any"` to the
 * entry in 0.1.2-alpha.1, which a pinned multi-line string could not survive,
 * and key order is not a contract. The entry still has to exist.
 * @param contents - manifest source.
 * @param file - path shown in the failure message.
 * @returns manifest JSON with the desktop icon.
 */
function replaceManifestIcon(contents, file) {
  const manifest = JSON.parse(contents)
  const icons = Array.isArray(manifest.icons) ? manifest.icons : []
  const target = icons.find((icon) => icon?.src === '/dsh-desktop-logo.png')
    ?? icons.find((icon) => typeof icon?.src === 'string' && icon.src.endsWith('favicon.svg'))
  if (target === undefined) {
    throw new Error(`Could not update DSH Desktop branding in ${file}: no icon entry to replace`)
  }
  target.src = '/dsh-desktop-logo.png'
  target.sizes = `${FAVICON_SIZE}x${FAVICON_SIZE}`
  target.type = 'image/png'
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * The favicon, reduced to the size it is served at.
 *
 * The packaged desktop icon keeps the full-resolution artwork; only the
 * copy that the web frontend serves is reduced, because that is the one a
 * browser downloads.
 *
 * @param file - the source artwork
 * @returns the reduced artwork
 */
async function faviconBytes(file) {
  return sharp(file)
    .resize(FAVICON_SIZE, FAVICON_SIZE, { kernel: 'lanczos3' })
    .png({ palette: true, colors: FAVICON_COLORS, compressionLevel: 9, effort: 10 })
    .toBuffer()
}

await mkdir(destinationDirectory, { recursive: true })
await writeFile(destination, await faviconBytes(source))
await copyFile(lightSource, lightDestination)
await copyFile(darkSource, darkDestination)

const index = await readFile(indexPath, 'utf8')
await writeFile(indexPath, replaceIconLink(index, path.relative(projectRoot, indexPath)))

const manifest = await readFile(manifestPath, 'utf8')
await writeFile(
  manifestPath,
  replaceManifestIcon(manifest, path.relative(projectRoot, manifestPath))
)

console.log(`Installed DSH Desktop brand assets: ${[
  destination,
  lightDestination,
  darkDestination
].map((file) => path.relative(projectRoot, file)).join(', ')}`)
