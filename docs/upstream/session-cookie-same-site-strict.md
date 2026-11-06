# dsh-client-connection: the session cookie is `SameSite=Strict`, which breaks a cross-site arrival

**Repository**: https://github.com/deepseek-ai/deepseek-harness — the `@deepseek-ai/dsh-client-connection` package
**File**: `lib/index.js`, the `sessionCookie` function

## The symptom

An app served on a public domain, reached the way a phone reaches one — a
QR code, a link in a chat message, a bookmark in another app — never
loads. The browser ends on *"this page redirected you too many times"*, or
on the bare page shell with nothing on it.

Everything about the app is fine when it is opened from its own links, or
from a bookmark typed into the address bar. The difference is only *how* the
browser arrived.

## What the code does

```js
function sessionCookie(name, value, expiresAt, maxAgeSeconds, secure) {
	const attributes = `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`;
	return secure ? `${attributes}; Secure` : attributes;
}
```

`SameSite=Strict` means the cookie is sent only on same-site requests. A
browser withholds it from a **cross-site** navigation, and from every
subresource request that a cross-site page initiates.

## Why it breaks the app

The launch-token exchange is a **redirect**:

1. The browser asks for `/`. The Harness mints a session cookie and answers
   `303 → ./`, so the token is not left in the address bar.
2. The browser follows the redirect to `./` and sends the cookie it was
   just given.

Step 2 is where a cross-site arrival dies. The cookie was set by the
response to a cross-site navigation, and it is a `Strict` cookie, so it is
not sent on the way back. The Harness sees an anonymous request, mints a
new cookie and redirects again — and the browser gives up.

What is left on the screen is the shell, because nothing but the shell was
ever fetched. It reads as an application that failed to start rather than
as an authentication problem, which is what makes it hard to diagnose.

## The fix

`SameSite=Lax` instead of `Strict`.

Lax still withholds the cookie from a cross-site `POST` and from any
subresource request, so it keeps the protection `Strict` gives against
cross-site request forgery. The one thing it gives up is the cross-site
**top-level navigation** — which is the arrival that has to work.

Nothing else about the cookie has to change: the name, the payload and the
signature are unaffected, and the exchange completes on the second request
as it always did.

The `secure` parameter already exists and already adds `Secure` when the
connection is encrypted, so a deployment that terminates TLS in front of
the Harness gets the flag it should have.

## Why this is worth fixing upstream rather than in a proxy

The attribute is a property of the cookie, and the Harness is what mints
it. A deployment that fronts the Harness with a proxy on a public domain
can rewrite the header on the way out — that is what the DSH Desktop does
(`scripts/dsh-web-session-cookie.mjs`) — but every deployment has to
rediscover the loop, and a client that talks to the Harness directly gets
no fix at all.

## The workaround the DSH Desktop uses, for comparison

The proxy rewrites `SameSite=Strict` to `SameSite=Lax` on the way out, and
adds `Secure` when the client's own request arrived over HTTPS. That last
part cannot be decided from `X-Forwarded-Proto` alone: the tunnel
terminates TLS at the edge and speaks HTTP to nginx, which speaks HTTP to
the proxy, so nginx overwrites that header with its own scheme. The edge's
own record of the scheme — `CF-Visitor` — is the one that tells the truth.

A proxy can only do this for the deployments that have a proxy. The cookie
is the Harness's, and the Harness is what mints it.

## How to see it

Open the app on a domain that is not the one you are already on: a link
from another site, or a second browser profile pointed at the public
domain. The request sequence in the server log is the whole story:

```
GET /   303      ← the cookie is set, and withheld
GET /   303      ← the exchange restarts
GET /   303      ← and again, until the browser gives up
```

The same requests with the cookie sent arrive as `303` followed by `200`.
