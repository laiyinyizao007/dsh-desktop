#!/usr/bin/env node
/**
 * Warm the client bundles a page is about to load.
 *
 * A page's first load pulls the whole plugin graph: the bootstrap script and
 * the two bundle groups the HTML preloads. Measured on this deployment, that
 * is about 3.5 MB of JavaScript, and over the public tunnel it takes ten to
 * thirty seconds. A second load is fast, because the bundles are
 * content-addressed and carry `immutable` — the browser keeps them, and so
 * does the edge cache.
 *
 * The point of warming is to make the *first* load as fast as the second:
 * the bundles are fetched once, before anybody asks for them, so the edge
 * cache holds them and the first visitor gets them from there.
 *
 * The URLs are read from the Harness's own root page, so the graph is
 * whatever the Harness currently advertises — a rebuilt bundle changes its
 * revision, and the next warm run picks up the new URL.
 *
 * This runs from a timer, after the Harness has started. It is a warm-up,
 * not a health check: a failure here means the bundles are not warm, and the
 * next run tries again.
 */

import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'

const PROXY_PORT = Number(process.env.DSH_PROXY_PORT ?? 43128)
const PROXY_HOST = process.env.DSH_PROXY_HOST ?? '127.0.0.1'
const LOG_PATH = process.env.DSH_HARNESS_LOG ?? '/var/log/dsh-web.log'
/**
 * How long to wait for the Harness to publish its launch token.
 *
 * The Harness prints the token when it starts. A warm run that fires
 * before that would find nothing to fetch, so it waits for the token
 * rather than giving up.
 */
const TOKEN_WAIT_MS = Number(process.env.DSH_WARM_TOKEN_WAIT_MS ?? 60_000)

/**
 * The launch token the Harness printed most recently.
 *
 * @returns the token, or undefined when the log holds none
 */
function launchToken() {
  let content
  try {
    content = readFileSync(LOG_PATH, 'utf8')
  } catch {
    return undefined
  }
  const matches = [...content.matchAll(/\?token=([A-Za-z0-9_-]+)/g)]
  return matches.at(-1)?.[1]
}

/**
 * Wait for the Harness to print a launch token.
 *
 * @returns the token
 */
async function waitForToken() {
  const deadline = Date.now() + TOKEN_WAIT_MS
  while (Date.now() < deadline) {
    const token = launchToken()
    if (token !== undefined) return token
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`no launch token in ${LOG_PATH} after ${TOKEN_WAIT_MS}ms`)
}

/**
 * Fetch the Harness's root page, following the token exchange.
 *
 * The Harness answers a root request that carries the launch token with a
 * 303 to "./" and a session cookie, and the redirect has to be followed
 * *with* that cookie — the second request is a 401 without it.
 *
 * @param token - the launch token
 * @returns the root page and the session cookie
 */
function fetchRootPage(token) {
  return new Promise((resolve, reject) => {
    let cookie = ''
    const request = httpRequest(
      {
        hostname: PROXY_HOST,
        port: PROXY_PORT,
        path: `/?token=${encodeURIComponent(token)}`,
        method: 'GET',
        headers: { host: `${PROXY_HOST}:${PROXY_PORT}` }
      },
      (response) => {
        const setCookie = response.headers['set-cookie']
        if (Array.isArray(setCookie)) {
          for (const entry of setCookie) {
            const pair = entry.split(';')[0]
            if (pair.startsWith('dsh-auth-')) cookie = pair
          }
        }
        const location = response.headers.location
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          location !== undefined &&
          cookie !== ''
        ) {
          response.resume()
          resolve(fetchRootPageWithCookie(cookie))
          return
        }
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`root page answered ${response.statusCode}`))
            return
          }
          resolve({ body, cookie })
        })
      }
    )
    request.on('error', reject)
    request.end()
  })
}

/**
 * Fetch the root page with a session cookie in hand.
 *
 * @param cookie - the session cookie
 * @returns the root page
 */
function fetchRootPageWithCookie(cookie) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: PROXY_HOST,
        port: PROXY_PORT,
        path: '/',
        method: 'GET',
        headers: { host: `${PROXY_HOST}:${PROXY_PORT}`, cookie }
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`root page answered ${response.statusCode}`))
            return
          }
          resolve({ body, cookie })
        })
      }
    )
    request.on('error', reject)
    request.end()
  })
}

/**
 * The bundle URLs the page loads.
 *
 * The HTML names them: one bootstrap script and the bundle groups it
 * preloads. Those are the three requests a first load makes, and they are
 * what has to be warm.
 *
 * @param html - the root page
 * @returns the URLs, without duplicates
 */
function bundleUrls(html) {
  const urls = new Set()
  for (const match of html.matchAll(/<script[^>]+src="(plugins\/[^"]+)"/g)) {
    urls.add(match[1].replace(/&amp;/g, '&'))
  }
  for (const match of html.matchAll(/<link[^>]+href="(plugins\/[^"]+)"/g)) {
    urls.add(match[1].replace(/&amp;/g, '&'))
  }
  return [...urls]
}

/**
 * Fetch one bundle, so that the edge cache holds it.
 *
 * The request carries the session cookie, because the proxy answers a
 * request without one with a 401 — and a 401 is not worth caching.
 *
 * @param url - the bundle URL
 * @param cookie - the session cookie
 * @returns the number of bytes received
 */
function warmBundle(url, cookie) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: PROXY_HOST,
        port: PROXY_PORT,
        path: `/${url}`,
        method: 'GET',
        headers: {
          host: `${PROXY_HOST}:${PROXY_PORT}`,
          cookie,
          // Brotli, so the warmed bytes are the ones a browser would get.
          'accept-encoding': 'br, gzip'
        }
      },
      (response) => {
        let bytes = 0
        response.on('data', (chunk) => {
          bytes += chunk.length
        })
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`${url} answered ${response.statusCode}`))
            return
          }
          resolve(bytes)
        })
      }
    )
    request.on('error', reject)
    request.end()
  })
}

const token = await waitForToken()
const { body, cookie } = await fetchRootPage(token)
const urls = bundleUrls(body)
if (urls.length === 0) {
  throw new Error('the root page names no bundle to warm')
}

let total = 0
for (const url of urls) {
  const bytes = await warmBundle(url, cookie)
  total += bytes
  console.log(`warmed ${bytes} bytes  ${url.split('?')[0].slice(0, 80)}`)
}
console.log(`warmed ${urls.length} bundle(s), ${total} bytes`)
