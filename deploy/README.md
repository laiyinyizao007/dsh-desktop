# deploy/ — the deployment recipe

Everything a machine needs to run the DSH web UI, in one place.

Before this directory existed, the recipe was a set of files that had been
copied onto one machine by hand. The copies drifted from the repository, the
next person could not tell which one was right, and the documentation
described a system that no longer matched any of them. These files are the
recipe; `scripts/dsh-web-deploy.sh` installs them.

```
scripts/dsh-web-deploy.sh install --domain dsh.example.com
```

The installer writes:

| File | What it does |
|---|---|
| `etc/systemd/system/dsh-web.service` | the Harness |
| `etc/systemd/system/dsh-web-proxy.service` | the reverse proxy that injects the launch token |
| `etc/systemd/system/dsh-web-warm-cache.{service,timer}` | fills the edge cache with the client bundles |
| `etc/systemd/system/dsh-auto-restart.{service,timer}` | restarts the Harness when a bundle changed under it |
| `etc/systemd/system/cloudflared-dsh.service` | the tunnel |
| `etc/nginx/conf.d/dsh.conf` | serves the static assets, normalises the authority |
| `etc/nginx/conf.d/dsh-log-format.conf` | the timing log's format |
| `etc/sysctl.d/99-dsh-tunnel.conf` | the kernel's TCP parameters |
| `etc/modules-load.d/tcp-bbr.conf` | loads BBR, which the parameters above ask for |
| `etc/logrotate.d/dsh-web` | rotates the Harness's log |
| `~/.cloudflared/config-dsh.yml` | the tunnel's routing |

Every file it writes carries a marker, and `uninstall` removes only the
files that carry it — a file somebody put there by hand is left alone.

## The templates

A `.in` file is a template: `${NAME}` is replaced with a value the installer
knows. The ones it knows:

| Placeholder | Meaning |
|---|---|
| `${REPO}` | the checkout |
| `${USER}` `${GROUP}` | the account the services run as |
| `${DSH_HOME}` | `~/.dsh` |
| `${NODE}` | the node binary |
| `${BIND}` | the address the Harness binds — a concrete one, never a wildcard |
| `${PUBLIC_HOST}` | the hostname the browser uses |
| `${DOMAIN}` | the public hostname, for the tunnel |
| `${HARNESS_PORT}` `${PROXY_PORT}` `${ENTRY_PORT}` `${NGINX_PORT}` | the ports |
| `${LOG_FILE}` | the Harness's log |
| `${CLOUDFLARED_DIR}` `${TUNNEL_ID}` `${CREDENTIALS}` | the tunnel |
| `${PROXY_ENV}` | the proxy environment variables, when there is a proxy |
| `${UID}` | the numeric user id |

A placeholder with no value behind it is left as it is, so `--print` shows
it rather than quietly writing an empty line.

## The commands

```
scripts/dsh-web-deploy.sh check       # report, change nothing; exits non-zero when something is missing
scripts/dsh-web-deploy.sh print       # show what would be written
scripts/dsh-web-deploy.sh install     # install (needs root)
scripts/dsh-web-deploy.sh uninstall   # remove what it installed
```

`install` is idempotent: a file whose content already matches is left
alone. `--root <dir>` writes under a directory instead of `/` and touches
neither systemd nor nginx nor the kernel, which is how the installer is
tested.

## What is not here

**The model providers.** The key and the model list are the deployment's
own business, and they belong to whoever runs it — they go into the
profile's patch layer and the credential store, not into this directory.

**The Cloudflare account.** A tunnel, a DNS record and an edge cache rule
belong to a Cloudflare zone. The installer creates the tunnel and the DNS
record with the official CLI when the tunnel already exists, and it creates
the cache rule when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID` are
in the environment; without them it prints the rule and the API path
instead.
