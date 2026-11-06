/**
 * Pre-compress the Harness's client bundle for nginx's static serving.
 *
 * The Harness serves its client bundle from
 * `node_modules/@deepseek-ai/dsh-web-frontend/dist`. When nginx fronts the
 * Harness it serves those files itself, which lets it answer with a
 * pre-compressed Brotli or gzip body instead of compressing on every
 * request — this machine is a Raspberry Pi, and per-request compression of
 * a 900 kB script is not free.
 *
 * For every compressible file this writes two siblings:
 *
 *   <file>.br   Brotli, quality 11 — what a modern browser gets
 *   <file>.gz   gzip, level 9     — what an older one gets
 *
 * nginx picks them up through `brotli_static` / `gzip_static`. A file that
 * already has fresh siblings is skipped, so this is cheap to re-run after a
 * Harness upgrade.
 *
 * Usage:
 *   node scripts/dsh-web-assets-precompress.mjs [--force] [--quiet]
 */
import { readdirSync, statSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { brotliCompressSync, gzipSync, constants } from 'node:zlib'

const DIST = join(
  process.cwd(),
  'node_modules',
  '@deepseek-ai',
  'dsh-web-frontend',
  'dist'
)

/** File extensions worth compressing. */
const COMPRESSIBLE = new Set(['.js', '.css', '.svg', '.json', '.webmanifest', '.html', '.map'])

/** Files that are already compressed and only grow. */
const INCOMPRESSIBLE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot'])

/** Minimum size worth compressing: below this the headers cost more than the saving. */
const MIN_SIZE = 1024

function walk(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) walk(full, found)
    else if (entry.isFile()) found.push(full)
  }
  return found
}

/** Whether a sibling variant is at least as new as its source. */
function variantIsFresh(variant, source) {
  if (!existsSync(variant)) return false
  try {
    return statSync(variant).mtimeMs >= statSync(source).mtimeMs
  } catch {
    return false
  }
}

function compress(source) {
  const extension = source.slice(source.lastIndexOf('.')).toLowerCase()
  if (INCOMPRESSIBLE.has(extension)) return undefined
  if (!COMPRESSIBLE.has(extension)) return undefined

  let original
  try {
    original = readFileSync(source)
  } catch {
    return undefined
  }
  if (original.length < MIN_SIZE) return undefined

  const brotli = brotliCompressSync(original, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: original.length
    }
  })
  const gzip = gzipSync(original, { level: 9 })

  writeFileSync(`${source}.br`, brotli)
  writeFileSync(`${source}.gz`, gzip)

  return {
    bytes: original.length,
    brotli: brotli.length,
    gzip: gzip.length
  }
}

const force = process.argv.includes('--force')
const quiet = process.argv.includes('--quiet')

if (!existsSync(DIST)) {
  console.error(`dsh-web-assets-precompress: no dist directory at ${DIST}`)
  process.exit(1)
}

const files = walk(DIST)
let total = 0
let saved = 0
let skipped = 0

for (const file of files) {
  if (file.endsWith('.br') || file.endsWith('.gz')) continue
  if (!force && variantIsFresh(`${file}.br`, file) && variantIsFresh(`${file}.gz`, file)) {
    skipped += 1
    continue
  }
  const result = compress(file)
  if (result === undefined) {
    skipped += 1
    continue
  }
  total += result.bytes
  saved += result.bytes - Math.min(result.brotli, result.gzip)
  if (!quiet) {
    const name = relative(DIST, file)
    console.log(
      `${name}  ${(result.bytes / 1024).toFixed(1)}KB → br ${(result.brotli / 1024).toFixed(1)}KB / gz ${(result.gzip / 1024).toFixed(1)}KB`
    )
  }
}

console.log(
  `dsh-web-assets-precompress: ${files.length} files, ${skipped} already fresh, ` +
  `${(total / 1024 / 1024).toFixed(2)}MB → best variant saves ${(saved / 1024 / 1024).toFixed(2)}MB`
)
