/**
 * The content digest of a client bundle's entry.
 *
 * The Harness derives a bundle's revision from the entry's mtime, ctime and
 * size, and the proxy used to decide that a bundle was stale by comparing
 * that mtime with the time the Harness started. Two things are wrong with
 * that comparison.
 *
 * It says "stale" for a file whose bytes did not change: a `git checkout`
 * of another branch, a `touch`, an editor's save that rewrote the file
 * with the same content. Each of those restarts the Harness for nothing,
 * and the restart drops the live WebSocket connections and interrupts the
 * work in flight.
 *
 * And it says "not stale" for a file that did change, when the change
 * landed before the Harness started: the Harness then advertises a
 * revision for bytes it is not serving, and the browser is handed a bundle
 * that the Harness will not find again.
 *
 * The digest is of the content, so neither happens. It is cached on the
 * file's mtime and size, so the cost is one read per file that actually
 * moved: the bundles of a profile are a few megabytes, and reading them
 * on every check would cost more than the check is worth.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

/**
 * The digests of the files read so far, and the metadata they were read at.
 *
 * @type {Map<string, { mtimeMs: number, size: number, digest: string }>}
 */
const digests = new Map()

/**
 * The digest of a file's content.
 *
 * @param path - the path of the file
 * @returns the digest, or undefined when the file cannot be read
 */
export function contentDigest(path) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    digests.delete(path)
    return undefined
  }
  const known = digests.get(path)
  if (known !== undefined && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
    return known.digest
  }
  let digest
  try {
    digest = createHash('sha1').update(readFileSync(path)).digest('hex').slice(0, 12)
  } catch {
    digests.delete(path)
    return undefined
  }
  digests.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, digest })
  return digest
}

/**
 * The digests of the resources, as they stand now.
 *
 * @param paths - the paths of the resources, by their id
 * @returns the digest of each resource that can be read
 */
export function currentDigests(paths) {
  const result = new Map()
  for (const [id, path] of paths) {
    const digest = contentDigest(path)
    if (digest !== undefined) result.set(id, digest)
  }
  return result
}
