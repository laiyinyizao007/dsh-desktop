/**
 * The name a re-encoded plugin bundle is kept under.
 *
 * A revision is not the identity of a resource. The Harness cuts a bundle
 * and every one of its package-local chunks from the same build, so they
 * all carry the same revision — `dsh-cost-meter/client.js` and
 * `dsh-cost-meter/client.sidebar-order.js` are both `rev=651a61b9cbbf`.
 *
 * Keying a cache on the revision alone therefore let a bundle and a chunk
 * overwrite each other. The chunk is the one that loses: the bundle is the
 * larger, and it is asked for first. The browser then ran the bundle where
 * it expected the chunk, and the chunk's factory registered a second time
 * under the bundle's id — which the module system refuses:
 *
 *   client-modules: duplicate factory registration for "dsh-cost-meter"
 *   (bundle executed twice without invalidate?)
 *
 * The path says which resource is meant, so it is part of the key. A short
 * digest of it keeps the name bounded: a bundle's path carries every
 * plugin id in its list.
 */
import { createHash } from 'node:crypto'

/**
 * The file name a re-encoded body is kept under.
 *
 * @param revision - the revision the request asked for
 * @param path - the path of the resource, without its query
 * @returns the file name, or undefined when the request asks for no revision
 */
export function bundleCacheName(revision, path) {
  if (revision === undefined || revision === '') return undefined
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 12)
  return `${revision}-${digest}.br`
}
