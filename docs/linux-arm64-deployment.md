# Running DSH Desktop on Linux/ARM64

DSH Desktop ships macOS and Windows binaries only — the upstream README lists
Linux as "Not currently supported". This document describes running the
**Harness** (`dsh web`) on Linux, plus the Desktop host plugins (workbenches,
plugin market, onboarding, image generation) and phone access, without
building an Electron app.

Two documents go deeper than this one:
[Web 加载性能：部署结构与维护说明](web-performance-tuning.md) covers the nginx
and Cloudflare layers in front of the Harness, the edge cache and the tunnel
tuning; [火山引擎（火山方舟 Ark）接入记录](volcengine-ark-provider.md) covers
the LLM route.

Everything here is built on two facts about the upstream project:

1. **`dsh web` is the product.** The Electron shell is a window around a local
   Harness; the Harness serves its own complete browser UI.
2. **The Desktop host plugins are ordinary Cordis plugins.** Desktop mounts
   them into its Harness child process through a profile patch layer
   (`build/dsh-desktop.patch.yml`). The same overlay works on a plain
   `dsh web` profile.

---

## 1. Build from source

```bash
git clone https://github.com/dataelement/dsh-desktop.git
cd dsh-desktop

npm ci
npm approve-scripts --allow-scripts-pending   # npm 11 blocks install scripts
npm rebuild                                    # run the approved scripts
```

**npm 11 blocks install scripts by default.** Native packages (`node-pty`,
`koffi`, `esbuild`, `protobufjs`, `@deepseek-ai/dsh-subprocess-local`) install
without their binaries otherwise, and the failure surfaces much later.

### Behind a proxy

Node's `fetch` (undici) ignores `HTTP_PROXY` / `HTTPS_PROXY`, so a build
script that downloads assets goes direct and fails:

```
TypeError: fetch failed
  cause: SocketError: other side closed
```

Preload a dispatcher instead — `scripts/proxy-fetch-setup.mjs` in this
repository does exactly that:

```bash
NODE_OPTIONS="--import ./scripts/proxy-fetch-setup.mjs" npm run office:prepare
```

Use the `=` form in a systemd unit; a space splits the value and Node reports
`--import requires an argument`.

### The office runtime needs a Linux target

`scripts/office-runtime/lock.json` only carries `win-x64`, `mac-arm64` and
`mac-x64`, so `office:prepare` fails with
`Office runtime: unsupported native target linux/arm64`.

Add a `linux-arm64` target:

- `pythonTarget`: `aarch64-unknown-linux-gnu`
- `pythonSha256`: the sha256 of
  `cpython-3.12.14+<release>-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz`
  from the `astral-sh/python-build-standalone` release the lock names
- `wheels`: the aarch64 cp312 manylinux builds of numpy, pandas, pillow and
  lxml, at the versions the other targets pin

Find the wheels by scraping `https://pypi.org/simple/<pkg>/` and matching
`cp312` + `aarch64` + `manylinux` — the PyPI JSON API truncates on large
responses, the simple index does not.

`prepare.mjs` also hardcoded `platform: windows ? 'win32' : 'darwin'`, which
mislabels a Linux runtime; derive it from the target prefix instead.

### Electron packaging (optional)

Only needed if you want an actual desktop app:

```bash
npx electron-vite build
npx electron-builder --linux --arm64 --config electron-builder.linux.cjs
```

`electron-builder.linux.cjs` overrides three upstream hooks that only work on
the platforms they were written for:

- `afterSign` — macOS notarization
- `afterPack` — the upstream gate runs a Windows `.exe` verifier and fails with
  `spawn .../DSH Desktop.exe ENOENT` on Linux
- `beforePack` — prepares the macOS DMG background image

---

## 2. Run the Harness

```bash
node node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --host <ip> --port 43129
```

- `--host` must be **one concrete interface address** — wildcards are rejected.
  A loopback host makes the server unreachable from other devices.
- The printed URL carries a **launch token**: `http://<ip>:<port>/?token=...`

### The launch token rotates

The Harness prints a new token on every start and the previous one goes stale.
Anything that talks to the Harness must not capture the token once at startup.

**Do not trust the last line of a log file** — after a restart the log holds
both the old and the new URL. Prove the token is live instead:

```js
const response = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
// 303 => the token was accepted and a session cookie was issued
```

Loop: re-read the log, try the candidate token, stop when it answers 303.

**Where the log is rotated, the token has to live somewhere else.**
`scripts/dsh-web-capture-token.mjs` waits for the Harness to print its URL,
**proves the token is live** with the check above, and only then writes it to
`/var/lib/dsh-web/launch-token` (`0600`) together with the Harness's PID and
start time:

```bash
node scripts/dsh-web-capture-token.mjs --wait 30
```

`dsh-web.service` runs it as an `ExecStartPost`, so every Harness start
captures the new token without anyone watching. The proxy reads the log
first and this file second, and it accepts the file only when the identity
recorded in it still matches the running Harness — a token belonging to a
Harness that has been replaced is not used to answer a request.

A log rotation that takes the token away is not a small problem: the proxy
has no token to give an anonymous visitor, so every new browser gets a 401
while the browsers that still hold a session cookie keep working. The site
looks fine to the one person who is not looking at it.

---

## 3. The Desktop host plugins

Copy the overlay from `build/dsh-desktop.patch.yml` into the profile's patch
layer (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`).

**Two of its rows are prerequisites, not optional.** Without them the whole
client fails with a bare error screen:

```yaml
- id: ui-brand-official
  disabled: true      # else dsh-desktop-client-ui fails to load
- id: ui-settings-account
  disabled: true
- id: ui-sidebar-browser
  disabled: false
```

The first row matters because `dsh-desktop-client-ui` and upstream's
`dsh-client-ui-brand-official` share the `sidebar.brand.mark` slot, and two
occupants cannot share one brand seat. The failure is:

```
Failed to load plugins
dsh-desktop-client-ui
single slot "sidebar.brand.mark" already has a registration at priority 0
```

Then insert the plugins themselves:

```yaml
- insert:
    - id: dsh-desktop-log-bridge
      name: dsh-desktop-log-bridge
    - id: dsh-desktop-client-ui
      name: dsh-desktop-client-ui
    - id: dsh-desktop-workbenches
      name: dsh-desktop-workbenches
      config:
        root: !!js dshHomePath('desktop-workbenches')
    - id: dsh-desktop-onboarding
      name: dsh-desktop-onboarding
    - id: dsh-desktop-market-installer
      name: dsh-desktop-market-installer
    - id: dsh-image-generation
      name: dsh-image-generation
    - id: dsh-desktop-hmr-fallback
      name: dsh-desktop-hmr-fallback
    - id: dsh-desktop-preset-transfer
      name: dsh-desktop-preset-transfer
```

`build/dsh-desktop-market.patch.yml` does **not** carry over: it sets
`inject: [desktopProfiles]`, and `desktopProfiles` only exists under the
Desktop shell. The `dsh-market` community plugin (the full market UI) is
therefore unavailable; `dsh-desktop-market-installer` still is, and it is
what installs workbenches.

`dsh-desktop-office` is separate: its config needs
`DSH_DESKTOP_OFFICE_RESOURCES` and `DSH_DESKTOP_OFFICE_CLI`, which the
packaged Desktop points at its own resources directory.

---

## 4. The plugin market

Upstream Desktop mounts the community market through a separate patch layer
(`build/dsh-desktop-market.patch.yml`):

```yaml
- id: dsh-market
  inject: [desktopProfiles]
  config:
    profile: web
    allowRestart: false
```

That row is **not a dependency** — it is a "this runs under Desktop" gate.
`desktopProfiles` is a service of the Electron shell, so the market never
activates on a web profile. The market package itself never references it;
`Inject.resolve` simply leaves the plugin inactive when a named service is
absent.

Dropping the `inject` row mounts the market on a web profile. Both halves
are needed:

```yaml
- insert:
    - id: dsh-market
      name: "@deepseek-ai/dsh-plugin-market"
      config:
        indexes:
          - https://dshmarket.com/index.json

- insert:
    - id: ui-plugin-market
      name: "@deepseek-ai/dsh-client-ui-plugin-market"
```

The first row is the Host half. The second is the browser half, and it is
mounted the same way the web profile mounts `dsh-client-ui-plugin-manager`:
as an insert row. Neither declares `dsh.bundle`, so neither can be listed
as a profile bundle — the loader refuses a bundle whose package declares
nothing:

```
Error: dsh: profile bundle "…" declares no dsh.bundle in its package.json
```

### Two different catalogs

Two separate services serve catalogs, and they use different formats:

| URL | Format | Serves |
|---|---|---|
| `market.dshdesktop.com/index.json` | `kind: "catalog"`, schemaVersion 2 | the **workbench** catalog, read by `dsh-desktop-workbenches` |
| `dshmarket.com/index.json` | `format: 1` | the **plugin market** index, read by `dsh-market` |

Feeding the workbench catalog to the market fails validation with
`此索引的格式无效` — the market wants format 1, whose entries carry
`versions[]`, `packageName` and a commit hash.

The market index is about 2.8 MB, and a slow link can truncate it. A
truncated download fails JSON parsing, and the UI reports the index as
invalid rather than as a network problem.

## 5. A bookmarkable public URL

`dsh web` authenticates every request with the launch token, so a public URL
cannot just point at it — the visitor would need a fresh token after every
restart.

`scripts/dsh-web-proxy.mjs` is a small reverse proxy that injects the
current token, read from the log the Harness writes to. Four upstream
behaviours make this non-trivial:

1. **The token may be injected exactly once.** The Harness mints its session
   cookie only from a root request carrying the token, and it answers a root
   request that *already* has a valid cookie with `303 → ./`. Injecting the
   token on every request sends every later request back through the minting
   branch, and the browser loops on the redirect.
2. **`/connect` always needs the token.** The root page mints a version-1
   cookie; the API carrier needs a **version-2** cookie, and `/connect` is the
   exchange that issues it. The browser's version-1 cookie does not satisfy
   `/connect`.
3. **The Host header must be the browser's, not the upstream's.** The cookie
   name is `SHA256(authority)` and the payload embeds the same authority.
4. **Cordis plugin bundles use `??` in the path** — `plugins/??<list>&rev=`.
   A URL parser treats everything after the first `?` as a query string and
   truncates the path to `/plugins/`, which 404s a 9 MB bundle. The proxy
   rewrites the URL the page advertises to `plugins/<list>.js?rev=…&proxy=2`
   — a path that ends in `.js`, which is what an edge cache keys on — and
   reverses the rewrite on the way upstream. Without that rewrite the whole
   plugin graph comes back through the tunnel on every page load.

The WebSocket upgrade must be forwarded too. The Harness multiplexes every
server-push stream over one socket at `/api/remote.mux`; without it the
workspace list stays empty while the rest of the page looks fine.

### The mux dies every few seconds, and the page reloads with it

That socket is not just a channel. When it drops, the client treats the
connection as new and re-reads everything: the model catalog, the agent
presets, the whole Session list. The sidebar clears its titles before the
list comes back, so it shows a loading state for as long as the re-read
takes — about two seconds over the public URL — and the model picker spins
for the same reason.

The Harness's mux server watches that socket: it pings it every two seconds
and terminates one that misses two pongs, so a client has roughly four to
six seconds to answer. The ping is queued behind whatever the server is
pushing, and the server pushes megabytes of events to a browser that is
reaching it over a tunnel; the client does not see the ping until the data
has arrived, and its pong has to make one more round trip. The server
therefore terminates the socket it was in the middle of filling, every six
to eight seconds, and the page starts over.

The profile's patch layer raises the interval, which is all it takes:

```yaml
- id: typert-gateway
  name: '@deepseek-ai/dsh-api-gateway'
  config:
    websocketHeartbeatIntervalMs: 15000
```

Fifteen seconds between pings gives the pong time to come back. This setting
is read at boot, so it needs a Harness restart to take effect.

**How to tell the three things apart.** The nginx timing log says how long
each mux connection lasted, and the access log's path counts say how often
the page re-read itself — a `session/list` and a `session/modelCatalog` per
mux connection means the page is restarting. To find out *which side* closed
the socket, the proxy's `upgrade` handler is the place to look: it sees both
sockets, so it can report which one closed first and how many bytes each
way. A close the browser asked for carries a WebSocket close code in the
last frame it sent; a connection that was cut has no close frame at all.

The browser-trust fence also needs the public hostname:

```
dsh web --host <ip> --port 43129 \
  --trusted-host <ip>:43129 \
  --trusted-host dsh.example.com
```

Do **not** tie the proxy to the Harness with `Requires=dsh-web.service`: it
would restart the proxy whenever the Harness restarts, dropping live
WebSocket clients and leaving the URL answering 502 in the gap. The proxy
reads the token from the log on every request, and from
`/var/lib/dsh-web/launch-token` when the log no longer holds one, so it
survives on its own.

In front of the proxy sits nginx, which serves the static assets itself and
normalises the `Host` and `Origin` headers so that one session cookie is
valid through every entry point — the public domain, the LAN address and the
Tailscale address. `docs/web-performance-tuning.md` has the layout.

### The power badge

On a Pi the browser window is often the only screen, so the proxy injects a
small badge into the root page: it shows the rail's state, the temperature
and the load, and it turns amber when the kernel log holds under-voltage
events and red while the rail is sagging right now.

The readings live in `scripts/dsh-web-volt.mjs`, and the proxy serves them at
`/__volt`. Two things are deliberate:

- **A source that cannot be read is `null`, not "fine".** No voltage sensor,
  no readable kernel log — the badge says "unknown" instead of claiming a
  healthy rail it never saw.
- **The endpoint needs a session.** It is reachable from outside the machine
  through the tunnel, and the readings are the machine's business rather
  than the world's.

The badge polls every 30 s, and the endpoint is one of the four the edge
cache is allowed to hold, so the kernel log is read about once a poll and
the answer comes from the edge rather than from the tunnel. Thirty seconds
rather than five: what the badge watches is whether the machine is
undervoltage right now, and nobody can act on that faster than they can
read it.

---

## 6. Phone access

`src/main/mobile/lan-mobile-bridge.ts` is a **PIN-paired HTTP + WebSocket
bridge with no Electron imports** — plain Node. Upstream the Electron main
process drives it; a standalone launcher can drive it too, because it needs
only two callbacks:

```ts
new LanMobileBridge({
  harnessUrl: () => 'http://127.0.0.1:43129',
  harnessAuthToken: () => currentToken,
  locale: 'zh',
  port: 43130
})
```

Compile it and the sibling modules with esbuild:

```bash
npx esbuild src/main/mobile/lan-mobile-bridge.ts src/main/mobile/lan-mobile-pages.ts \
  src/main/mobile/pairing-pin-store.ts src/main/mobile/cloudflared-tunnel.ts \
  src/main/mobile/internet-tunnel.ts src/main/mobile/pinggy-tunnel.ts \
  --outdir=.build/mobile-bridge --format=esm --platform=node --target=node22 \
  --bundle --external:ws --external:qrcode
```

`scripts/standalone-mobile-bridge.mjs` is a working launcher.

Pairing differs by connection mode:

- **LAN** — the pairing URL's token is enough; the phone needs no PIN.
- **Tunnel** — the phone must enter a six-digit PIN, because the bridge cannot
  trust the address.

Upstream keeps paired phones in an in-memory map, so every bridge restart
drops them and the phone must re-pair. `sessionStore` (an option this
repository adds, mirroring the existing `pairingPinStore` pattern) persists
the tokens instead:

```ts
export interface PairedSession { token: string; remoteAddress: string }
export interface SessionStore {
  load(): PairedSession[]
  save(sessions: PairedSession[]): boolean
}
```

Do **not** weaken the tunnel PIN to avoid this — persist the session instead.

### Cloudflare quick tunnel trap

`cloudflared tunnel --url http://127.0.0.1:PORT` reads
`~/.cloudflared/config.yml` **by default**. If that file declares a named
tunnel, cloudflared registers the *named* tunnel's ingress rules instead of
starting a quick tunnel — and every other Host answers **404 from the
Cloudflare edge**. Always spawn a quick tunnel with `--config /dev/null`.

For a stable hostname, create a named tunnel and point it at the reverse
proxy instead.

---

## 7. Model configuration

`llm-pi-ai` routes to any provider in the pi-ai catalog, which already
ships MiniMax:

- provider id `minimax-cn`, endpoint `https://api.minimaxi.com/anthropic`
- models `MiniMax-M3` (1,000,000 context) and `MiniMax-M2.7` (204,800)

The key goes into the credential store under a **single-segment ref** (the
`/` form is for record keys, not refs), and `apiKeyEnv` resolves the value as
a credential ref first and an environment variable second:

```bash
python3 scripts/dsh-rpc.py credentials/set \
  '{"ref":"MINIMAX_CN_API_KEY","value":"sk-..."}'
```

`settings/mutate` writes into the profile's `cordis.patch.yml`, not into
`~/.dsh/storages/` — readable YAML that survives restarts and can be
version-controlled.

Volcengine's Ark is configured the same way, as a `volcengine` provider
beside the MiniMax one, with its key in the credential store under
`VOLCENGINE_API_KEY`. It has its own rules — the models that answer, the
two API shapes it accepts, and the two patches the route needs — and they
are written down in
[火山引擎（火山方舟 Ark）接入记录](volcengine-ark-provider.md).

Keep **one** route per vendor. A provider whose key belongs to another
vendor still shows up in the model picker and cannot answer anything, and
a second route to the same vendor only splits the model list in two.

`locale` and `permission` are runtime state, not settings: writing them
answers `Config field "x" is not volatile`. Set them in the UI.

---

## 8. Calling the Harness directly

`POST /api/<endpoint>` with:

```json
{"type":"client-request","rpcId":"r1","method":"<endpoint>","payload":{"args":{...}}}
```

Three rules:

1. `payload` must contain **exactly one** plain-object `args` field.
2. `method` must equal the endpoint derived from the URL path.
3. The args shape varies per endpoint, and the error names the field:
   `args fields do not match the descriptor: missing "x"; unexpected "y"`.

`scripts/dsh-rpc.py` is a small client for this.

---

## 9. Verify with a real browser

`curl` proves the HTML and the bundles load. It does **not** prove the client
mounted, and it cannot see a WebSocket that never opened.

```bash
python3 scripts/dsh-browser-check.py https://dsh.example.com --shot /tmp/dsh.png
python3 scripts/dsh-ui-probe.py https://dsh.example.com
```

Both drive Chromium through Playwright, print the console errors and the
failed requests, and dump the visible text — the sidebar list (New Session /
Workbenches / Plugins / Workspaces / Settings) is the fastest check that the
UI actually mounted.

`scripts/dsh-page-audit.py` walks the UI page by page at a phone viewport
and reports what a screenshot alone does not: elements cut off at the right
edge, text squeezed into a narrow column, and tap targets under 32 px.
`scripts/look-at-mobile.py` runs the same probe against any other site.

## 10. After changing a plugin

The Harness derives a client bundle's revision from the entry's `mtime`,
`ctime` and size, and it recomputes those only when it starts or when the
HMR hook fires. A bundle whose file changed after the Harness started is
therefore still advertised at its old revision, the browser asks for that
revision, the request 404s, and the module graph fails with:

```
Failed to load plugins
required client modules failed to activate
```

Restarting the Harness is the fix. The proxy serves the diagnosis:

```bash
curl -s https://dsh.example.com/healthz
```

```json
{
  "ok": false,
  "checks": [
    { "name": "harness", "ok": true, "detail": "launch token present, log written 78s ago" },
    { "name": "client-bundle-revisions", "ok": false,
      "detail": "1 bundle(s) changed after the Harness started: dsh-desktop-responsive — restart the Harness" }
  ],
  "stale": [{ "id": "dsh-desktop-responsive", "rev": "b74903fc59b4", "modified": "…" }]
}
```

`scripts/dsh-rebuild.sh` does the whole thing — regenerate the patch files,
restart the Harness, wait for it to publish its revisions, and report:

```bash
scripts/dsh-rebuild.sh              # patch, restart, verify
scripts/dsh-rebuild.sh --no-patches # restart and verify only
scripts/dsh-rebuild.sh --check      # report only, change nothing
```

A revisioned bundle is content-addressed, so the proxy serves it with
`cache-control: public, max-age=31536000, immutable` and advertises it under
a URL an edge cache can key on. The *set* of revisions changes whenever a
bundle is rebuilt — and a rebuilt bundle has a new URL, so the edge's old
entries are simply never asked for again.

After a Harness restart the edge holds nothing for the new revisions, so the
first visitor pulls the whole graph back through the tunnel.
`dsh-web-warm-cache.service` fetches it once, before anybody asks for it,
and a timer runs it every ten minutes. Run it by hand after an upgrade:

```bash
sudo systemctl start dsh-web-warm-cache.service
```

The log must say `N warmed`. `0 warmed` means the page named no bundle at
all — the Harness is not up, or its launch token is gone — and the unit
fails rather than exiting quietly.

`scripts/dsh-cold-load-probe.sh` measures what a visitor actually waits
for, through whichever entry point it is given:

```bash
scripts/dsh-cold-load-probe.sh https://dsh.example.com
scripts/dsh-cold-load-probe.sh http://10.32.7.113:43128
```

It prints the edge's answer for every bundle, so a line that says `MISS`
where it should say `HIT` is the first thing to look at.

## 11. The profile layer at a glance

Everything above lands in the profile's patch layer
(`$DSH_HOME/profiles/<profile>/cordis.patch.yml`), not in the repository.
That is deliberate: the file survives a Harness upgrade, because upstream
does not own it. The rows a Linux web profile typically carries:

```yaml
# Model provider (MiniMax-M3 through the pi-ai catalog)
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      minimax-cn:
        apiKeyEnv: MINIMAX_CN_API_KEY
        models:
          - id: MiniMax-M3
            contextWindow: 1000000

# Default model
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: minimax-cn
    model: MiniMax-M3
    reasoningEffort: high

# The mux WebSocket's heartbeat (see section 5)
- id: typert-gateway
  name: '@deepseek-ai/dsh-api-gateway'
  config:
    websocketHeartbeatIntervalMs: 15000

# The Desktop host plugins (see section 3)
- id: ui-brand-official
  disabled: true
- insert:
    - id: dsh-desktop-client-ui
      name: dsh-desktop-client-ui
    - id: dsh-desktop-workbenches
      name: dsh-desktop-workbenches
      config:
        root: !!js dshHomePath('desktop-workbenches')
    - id: dsh-desktop-market-installer
      name: dsh-desktop-market-installer

# The plugin market (see section 4)
- insert:
    - id: dsh-market
      name: "@deepseek-ai/dsh-plugin-market"
      config:
        indexes:
          - https://dshmarket.com/index.json
    - id: ui-plugin-market
      name: "@deepseek-ai/dsh-client-ui-plugin-market"
```

The API key itself lives in the credential store, not in the patch:

```bash
python3 scripts/dsh-rpc.py credentials/set \
  '{"ref":"MINIMAX_CN_API_KEY","value":"sk-..."}'
```

`apiKeyEnv` resolves as a credential ref first and an environment variable
second, so the key never has to appear in the patch file.
