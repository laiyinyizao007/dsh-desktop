/**
 * The answers the page asks for again and again, kept for a moment.
 *
 * The page opens by asking the Host for everything it can show: the
 * credentials it may use, the presets it may offer, the settings it may
 * change, the list of conversations. Those asks are a dozen or more, they
 * all arrive within the same second, and the Host answers them one at a
 * time — so each one waits behind the others, and the last one to arrive
 * waits for all of them.
 *
 * The answers themselves do not change from one second to the next. They
 * are the Host's configuration, and the configuration is not what the page
 * is opening to see changed.
 *
 * So the answer is held for a moment and shared: a request that arrives
 * just after another one for the same answer is answered from the answer
 * that was already fetched. The Host sees one request where it used to
 * see five, and the page waits for one rather than for five.
 *
 * Only the GET requests listed here are held. Each of them is a
 * description of the Host's own configuration: who may sign in, what a
 * preset is, what the settings are. None of them holds a credential, and
 * none of them is a result of the work in progress — those change while
 * the page is open, and a held answer would show a stale one.
 */

/** How long an answer is held. */
const TTL_MS = 5000

/**
 * The paths whose answers are held.
 *
 * The list is a list of paths, not of prefixes, because a prefix would
 * also catch the routes under it that carry work in progress: the cost
 * meter's per-session figures, the automation board's rows, the catalog
 * that is being refreshed.
 */
const HELD_PATHS = new Set([
  '/api/credentials/describe',
  '/api/agentPresets/list',
  '/api/settings/describe',
  '/api/session/modelCatalog',
  '/api/permissionPresets/catalog',
  '/api/dsh-config-manager/recovery/rollback-points/storage',
  '/sidebar/api/settings.get'
])

/** One held answer per key. */
const held = new Map()

/**
 * Whether this request is one whose answer may be held.
 *
 * A query is part of the key, so two asks for the same path with
 * different arguments are different answers.
 */
function isHoldable(method, path) {
  if (method !== 'GET') return false
  return HELD_PATHS.has(path)
}

/**
 * Hold an answer, replacing whatever was held for the same key.
 *
 * @param key - what identifies the answer: the path and the query.
 * @param answer - the status, the headers and the body to hand out again.
 */
function holdAnswer(key, answer) {
  held.set(key, { expiresAt: Date.now() + TTL_MS, answer })
}

/** Forget every held answer. Used when the Harness restarts. */
function forgetHeld() {
  held.clear()
}

export { HELD_PATHS, held, holdAnswer, forgetHeld, isHoldable }
