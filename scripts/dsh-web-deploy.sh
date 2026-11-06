#!/usr/bin/env bash
# Install the DSH web deployment on this machine.
#
# Why this exists: the deployment is a pile of systemd units, an nginx
# configuration, a sysctl file and a tunnel configuration, and every one of
# them used to be copied by hand. A copy is a second copy — the machine
# drifts from the repository, and the next person has no way to tell which
# one is right. This installs the repository's templates instead, so the
# repository is the only place the recipe lives.
#
# It writes:
#
#   /etc/systemd/system/dsh-web.service
#   /etc/systemd/system/dsh-web-proxy.service
#   /etc/systemd/system/dsh-web-warm-cache.{service,timer}
#   /etc/systemd/system/dsh-auto-restart.{service,timer}
#   /etc/systemd/system/cloudflared-dsh.service
#   /etc/nginx/conf.d/dsh.conf, /etc/nginx/conf.d/dsh-log-format.conf
#   /etc/sysctl.d/99-dsh-tunnel.conf, /etc/modules-load.d/tcp-bbr.conf
#   /etc/logrotate.d/dsh-web
#   ~/.cloudflared/config-dsh.yml
#
# Every file it writes carries a marker, and `uninstall` removes only the
# files that carry it.
#
# Usage:
#   scripts/dsh-web-deploy.sh check                  # report, change nothing
#   scripts/dsh-web-deploy.sh print                  # show what would be written
#   scripts/dsh-web-deploy.sh install                # install (needs root)
#   scripts/dsh-web-deploy.sh uninstall              # remove what it installed
#
# Options:
#   --domain <name>       the public hostname (Cloudflare tunnel)
#   --bind <addr>         the address the Harness binds; a concrete one
#   --repo <path>         the checkout; defaults to the repository this
#                         script lives in
#   --user <name>         the account the services run as; defaults to the
#                         invoking user
#   --nginx-user <name>   the account nginx's workers run as; defaults to
#                         --user
#   --proxy <url>         the HTTP proxy the Harness's outbound traffic
#                         goes through, e.g. http://127.0.0.1:7890
#   --tunnel <name>       the Cloudflare tunnel's name; defaults to
#                         dsh-desktop
#   --no-nginx            let the reverse proxy own the public port
#   --no-sysctl           leave the kernel's TCP parameters alone
#   --skip-cloudflare     do not install the tunnel; the LAN address only
#   --root <dir>          write under <dir> instead of /, and do not touch
#                         systemd, nginx or the kernel. For testing.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${REPO_ROOT}/deploy"

# ---------------------------------------------------------------- options --

COMMAND="check"
DOMAIN=""
BIND=""
REPO="${REPO_ROOT}"
SERVICE_USER=""
NGINX_USER=""
PROXY_URL=""
TUNNEL_NAME="dsh-desktop"
USE_NGINX=1
USE_SYSCTL=1
USE_CLOUDFLARE=1
ROOT="/"

usage() { sed -n '2,40p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    check|print|install|uninstall) COMMAND="$1"; shift ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --bind) BIND="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    --nginx-user) NGINX_USER="$2"; shift 2 ;;
    --proxy) PROXY_URL="$2"; shift 2 ;;
    --tunnel) TUNNEL_NAME="$2"; shift 2 ;;
    --no-nginx) USE_NGINX=0; shift ;;
    --no-sysctl) USE_SYSCTL=0; shift ;;
    --skip-cloudflare) USE_CLOUDFLARE=0; shift ;;
    --root) ROOT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# Everything below is written under ROOT, and the paths are absolute, so ROOT
# has to end in a slash.
[ "${ROOT}" != "/" ] && ROOT="${ROOT%/}/"

say() { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }
die() { printf 'dsh-web-deploy: %s\n' "$*" >&2; exit 1; }

[ -d "${DEPLOY_DIR}" ] || die "no deploy/ directory next to this script"
[ -d "$REPO" ] || die "no repository at ${REPO}"

# ------------------------------------------------------------ the values --

SERVICE_USER="${SERVICE_USER:-$(id -un)}"
NGINX_USER="${NGINX_USER:-$SERVICE_USER}"
DSH_HOME="${HOME}/.dsh"
CLOUDFLARED_DIR="${ROOT}${HOME#/}/.cloudflared"
LOG_FILE="/var/log/dsh-web.log"
HARNESS_PORT=43129
ENTRY_PORT=43128

if [ "$USE_NGINX" = "1" ]; then
  PROXY_PORT=43131
  NGINX_PORT=43128
else
  PROXY_PORT=43128
  NGINX_PORT=43128
fi

# The system's node is preferred over one on the PATH: a version manager's
# path carries a version in it, and a unit that names it stops working the
# day the version moves.
if [ -x /usr/bin/node ]; then
  NODE=/usr/bin/node
else
  NODE="$(command -v node || true)"
fi
[ -n "$NODE" ] || die "node is not on the PATH"

# The Harness rejects a wildcard bind address, so it has to be one concrete
# interface address. A Tailscale address is preferred: it is stable across
# Wi-Fi changes, and it is the one the phone bridge reaches.
detect_bind() {
  local address=""
  if command -v tailscale >/dev/null 2>&1; then
    address="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  fi
  if [ -z "$address" ]; then
    address="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1 || true)"
  fi
  printf '%s' "$address"
}

if [ -z "$BIND" ]; then
  BIND="$(detect_bind)"
  [ -n "$BIND" ] || die "no interface address found; pass --bind <addr>"
fi

PUBLIC_HOST="${DOMAIN:-$BIND}"

# The proxy's own outbound traffic goes through a proxy only when one runs.
# Node's fetch (undici) ignores the proxy variables, so the dispatcher is
# preloaded instead.
if [ -n "$PROXY_URL" ]; then
  PROXY_ENV="Environment=HTTPS_PROXY=${PROXY_URL}
Environment=HTTP_PROXY=${PROXY_URL}
Environment=http_proxy=${PROXY_URL}
Environment=https_proxy=${PROXY_URL}
Environment=NODE_OPTIONS=--import=${REPO}/scripts/proxy-fetch-setup.mjs"
else
  PROXY_ENV=""
fi

# ------------------------------------------------------------- rendering --

MARKER="# Installed by dsh-web-deploy.sh — re-run the installer to change it."

render() {
  local template="$1"
  # The replacement is done in Python rather than sed because one of the
  # values — the block of proxy environment variables — is several lines
  # long, and sed's `s` command cannot hold a newline.
  #
  # A placeholder with no value behind it is left as it is, so that `--print`
  # shows it rather than quietly writing an empty line.
  DSH_DEPLOY_REPO="$REPO" \
  DSH_DEPLOY_USER="$SERVICE_USER" \
  DSH_DEPLOY_GROUP="$SERVICE_USER" \
  DSH_DEPLOY_DSH_HOME="$DSH_HOME" \
  DSH_DEPLOY_NODE="$NODE" \
  DSH_DEPLOY_BIND="$BIND" \
  DSH_DEPLOY_PUBLIC_HOST="$PUBLIC_HOST" \
  DSH_DEPLOY_DOMAIN="$DOMAIN" \
  DSH_DEPLOY_HARNESS_PORT="$HARNESS_PORT" \
  DSH_DEPLOY_PROXY_PORT="$PROXY_PORT" \
  DSH_DEPLOY_ENTRY_PORT="$ENTRY_PORT" \
  DSH_DEPLOY_NGINX_PORT="$NGINX_PORT" \
  DSH_DEPLOY_LOG_FILE="$LOG_FILE" \
  DSH_DEPLOY_CLOUDFLARED_DIR="$CLOUDFLARED_DIR" \
  DSH_DEPLOY_TUNNEL_ID="${TUNNEL_ID:-}" \
  DSH_DEPLOY_CREDENTIALS="${CREDENTIALS:-}" \
  DSH_DEPLOY_PROXY_ENV="$PROXY_ENV" \
  DSH_DEPLOY_UID="$(id -u)" \
  python3 - "$template" <<'PYTHON'
import os
import re
import sys

text = open(sys.argv[1], encoding='utf-8').read()


def substitute(match):
    name = match.group(1)
    return os.environ.get('DSH_DEPLOY_' + name, match.group(0))


sys.stdout.write(re.sub(r'\$\{([A-Z_]+)\}', substitute, text))
PYTHON
}

# ------------------------------------------------------------- the plan ---

# Every file the installer owns, as "template destination mode".
FILES=()

plan_files() {
  FILES=(
    "systemd/dsh-web.service.in|${ROOT}etc/systemd/system/dsh-web.service|0644"
    "systemd/dsh-web-proxy.service.in|${ROOT}etc/systemd/system/dsh-web-proxy.service|0644"
    "systemd/dsh-web-warm-cache.service.in|${ROOT}etc/systemd/system/dsh-web-warm-cache.service|0644"
    "systemd/dsh-web-warm-cache.timer.in|${ROOT}etc/systemd/system/dsh-web-warm-cache.timer|0644"
    "systemd/dsh-auto-restart.service.in|${ROOT}etc/systemd/system/dsh-auto-restart.service|0644"
    "systemd/dsh-auto-restart.timer.in|${ROOT}etc/systemd/system/dsh-auto-restart.timer|0644"
    "logrotate/dsh-web|${ROOT}etc/logrotate.d/dsh-web|0644"
  )
  if [ "$USE_NGINX" = "1" ]; then
    FILES+=(
      "nginx/dsh.conf.in|${ROOT}etc/nginx/conf.d/dsh.conf|0644"
      "nginx/dsh-log-format.conf.in|${ROOT}etc/nginx/conf.d/dsh-log-format.conf|0644"
    )
  fi
  if [ "$USE_SYSCTL" = "1" ]; then
    FILES+=(
      "sysctl/99-dsh-tunnel.conf|${ROOT}etc/sysctl.d/99-dsh-tunnel.conf|0644"
      "modules-load/tcp-bbr.conf|${ROOT}etc/modules-load.d/tcp-bbr.conf|0644"
    )
  fi
  if [ "$USE_CLOUDFLARE" = "1" ]; then
    FILES+=(
      "systemd/cloudflared-dsh.service.in|${ROOT}etc/systemd/system/cloudflared-dsh.service|0644"
      "cloudflared/config-dsh.yml.in|${CLOUDFLARED_DIR}/config-dsh.yml|0600"
    )
  fi
}

# What a file should end up containing.
desired() {
  local template="$1"
  printf '%s\n%s\n' "$MARKER" "$(render "${DEPLOY_DIR}/${template}")"
}

state_of() {
  local destination="$1"
  if [ ! -e "$destination" ]; then echo "missing"; return; fi
  # A file this installer did not write may still be unreadable — the
  # system directories are root's. That is a state, not an error.
  if [ ! -r "$destination" ]; then echo "unreadable"; return; fi
  if ! head -1 "$destination" | grep -qF "$MARKER"; then echo "foreign"; return; fi
  echo "installed"
}

# ----------------------------------------------------------- the commands --

do_check() {
  plan_files
  say "DSH web deployment — ${REPO}"
  say ""
  say "  bind          ${BIND}:${HARNESS_PORT}"
  say "  public host   ${PUBLIC_HOST}"
  say "  proxy port    ${PROXY_PORT}${USE_NGINX:+  (nginx ${NGINX_PORT} in front)}"
  say ""
  local missing=0 foreign=0 stale=0 unreadable=0
  for entry in "${FILES[@]}"; do
    IFS='|' read -r template destination mode <<< "$entry"
    local state; state="$(state_of "$destination")"
    local detail=""
    case "$state" in
      missing) missing=$((missing + 1)); detail="not installed" ;;
      foreign) foreign=$((foreign + 1)); detail="present, but not written by this installer" ;;
      unreadable) unreadable=$((unreadable + 1)); detail="present, but not readable without root" ;;
      *)
        if ! diff -q <(desired "$template") "$destination" >/dev/null 2>&1; then
          stale=$((stale + 1)); detail="installed, but differs from the template"
        else
          detail="installed"
        fi
        ;;
    esac
    printf '  %-46s %s\n' "$destination" "$detail"
  done
  say ""
  if [ "$missing" -gt 0 ] || [ "$stale" -gt 0 ] || [ "$foreign" -gt 0 ] || [ "$unreadable" -gt 0 ]; then
    say "  $missing missing, $stale differing, $foreign not written by this installer, $unreadable not readable"
    return 1
  fi
  say "  everything is in place"
  return 0
}

do_print() {
  plan_files
  for entry in "${FILES[@]}"; do
    IFS='|' read -r template destination mode <<< "$entry"
    say "===== ${destination}"
    desired "$template"
    say ""
  done
}

do_install() {
  plan_files
  local changed=0
  local changed_units=""
  for entry in "${FILES[@]}"; do
    IFS='|' read -r template destination mode <<< "$entry"
    local content; content="$(desired "$template")"
    mkdir -p "$(dirname "$destination")"
    if [ -e "$destination" ] && diff -q <(printf '%s\n' "$content") "$destination" >/dev/null 2>&1; then
      note "unchanged  ${destination}"
      continue
    fi
    printf '%s\n' "$content" > "$destination"
    chmod "$mode" "$destination"
    note "written    ${destination}"
    changed=$((changed + 1))
    # A unit whose file changed is running the old definition. It has to be
    # restarted for the new one to mean anything.
    case "$destination" in
      */systemd/system/*.service|*/systemd/system/*.timer)
        changed_units="${changed_units} $(basename "$destination")" ;;
    esac
  done
  say ""
  say "${changed} file(s) written."

  if [ "$ROOT" != "/" ]; then
    say "(--root was given: systemd, nginx and the kernel were left alone)"
    return 0
  fi

  say ""
  say "enabling the units"
  systemctl daemon-reload
  for unit in $changed_units; do
    systemctl enable --now "$unit"
    systemctl restart "$unit" || warn "${unit} did not restart"
  done
  systemctl enable --now dsh-web.service dsh-web-proxy.service
  systemctl enable --now dsh-web-warm-cache.timer dsh-auto-restart.timer
  if [ "$USE_CLOUDFLARE" = "1" ]; then
    systemctl enable --now cloudflared-dsh.service
    if [ -n "$TUNNEL_ID" ]; then
      # The DNS record for the hostname points at the tunnel. cloudflared
      # answers "record already exists" when it is there, which is not a
      # failure of the installation.
      if ! cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN" >/dev/null 2>&1; then
        note "the DNS record for ${DOMAIN} is already there"
      fi
    fi
    install_cache_rule
  fi

  if [ "$USE_NGINX" = "1" ]; then
    say ""
    say "checking nginx"
    # nginx's workers have to be able to read the checkout, and the home
    # directory is 0700 — so they run as the account that owns it.
    reconcile_nginx
    if nginx -t; then
      systemctl reload nginx
    else
      warn "nginx refused the configuration; it was not reloaded"
      # nginx.conf may already have been edited, and a configuration nginx
      # refuses to read would keep it from starting at all. Put it back.
      if [ -f /etc/nginx/nginx.conf.bak-dsh-web-deploy ]; then
        cp /etc/nginx/nginx.conf.bak-dsh-web-deploy /etc/nginx/nginx.conf
        warn "nginx.conf was restored from its backup"
      fi
      return 1
    fi
  fi

  if [ "$USE_SYSCTL" = "1" ]; then
    say ""
    say "applying the kernel parameters"
    modprobe tcp_bbr 2>/dev/null || true
    sysctl --system >/dev/null
  fi

  say ""
  say "checking"
  sleep 3
  curl -s --max-time 10 "http://127.0.0.1:${PROXY_PORT}/healthz" || true
  say ""
}

do_uninstall() {
  plan_files
  for entry in "${FILES[@]}"; do
    IFS='|' read -r template destination mode <<< "$entry"
    [ -e "$destination" ] || continue
    if [ ! -r "$destination" ]; then
      note "left alone (not readable)  ${destination}"
      continue
    fi
    if ! head -1 "$destination" | grep -qF "$MARKER"; then
      note "left alone (not written by this installer)  ${destination}"
      continue
    fi
    rm -f "$destination"
    note "removed    ${destination}"
  done
  say ""
  if [ "$ROOT" != "/" ]; then return 0; fi
  systemctl daemon-reload
  for unit in dsh-web.service dsh-web-proxy.service dsh-web-warm-cache.timer dsh-auto-restart.timer cloudflared-dsh.service; do
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
  done
  say "the units were disabled. The Cloudflare tunnel and the DNS record are left alone."
}

# nginx's workers read the checkout directly, and the home directory is
# 0700, so they cannot run as www-data without an ACL on every directory of
# the path — an ACL that npm install breaks every time a dependency is
# updated. Running them as the account that owns the checkout is steadier.
#
# The timing log's format also used to live in nginx.conf. It is a file of
# its own now, so an old definition left in nginx.conf would be a second
# definition of the same name and nginx would refuse to start.
reconcile_nginx() {
  local config="/etc/nginx/nginx.conf"
  [ -f "$config" ] || { warn "no ${config}"; return 0; }
  [ -w "$config" ] || { warn "${config} is not writable; nginx was left as it is"; return 0; }
  cp -n "$config" "${config}.bak-dsh-web-deploy" 2>/dev/null || true

  if ! grep -qE "^user[[:space:]]+${NGINX_USER};" "$config"; then
    if grep -qE "^user[[:space:]]+" "$config"; then
      sed -i -E "s|^user[[:space:]]+[^;]+;|user ${NGINX_USER};|" "$config"
      note "nginx's workers now run as ${NGINX_USER}"
    fi
  fi

  if grep -qE "^[[:space:]]*log_format[[:space:]]+dsh_timing" "$config"; then
    # The definition spans several lines; the one that follows starts with a
    # continuation. Take the whole block out.
    python3 - "$config" <<'PYTHON'
import re
import sys

path = sys.argv[1]
text = open(path, encoding='utf-8').read()
pattern = re.compile(r'^[ \t]*log_format[ \t]+dsh_timing[^;]*?;[ \t]*\n', re.M | re.S)
open(path, 'w', encoding='utf-8').write(pattern.sub('', text))
PYTHON
    note "the timing log's format moved out of ${config}"
  fi
}

# ------------------------------------------------------------ cloudflare --

resolve_tunnel() {
  TUNNEL_ID=""
  CREDENTIALS=""
  command -v cloudflared >/dev/null 2>&1 || return 0
  local listing
  listing="$(cloudflared tunnel list --output json 2>/dev/null || true)"
  [ -n "$listing" ] || return 0
  TUNNEL_ID="$(printf '%s' "$listing" | python3 -c "
import json, sys
try:
    tunnels = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
for tunnel in tunnels:
    if tunnel.get('name') == '${TUNNEL_NAME}':
        print(tunnel['id']); break
")"
  [ -n "$TUNNEL_ID" ] || return 0
  CREDENTIALS="${CLOUDFLARED_DIR}/${TUNNEL_ID}.json"
  [ -e "$CREDENTIALS" ] || CREDENTIALS=""
}

if [ "$USE_CLOUDFLARE" = "1" ]; then
  if [ -z "$DOMAIN" ]; then
    warn "no --domain given and --skip-cloudflare was not passed: the tunnel is not configured"
    USE_CLOUDFLARE=0
  elif ! command -v cloudflared >/dev/null 2>&1; then
    warn "cloudflared is not installed: the tunnel is not configured"
    USE_CLOUDFLARE=0
  else
    resolve_tunnel
    if [ -z "$TUNNEL_ID" ]; then
      warn "no tunnel named ${TUNNEL_NAME}; create it with: cloudflared tunnel create ${TUNNEL_NAME}"
    fi
  fi
fi

# The four read-only endpoints the page polls are worth keeping at the edge:
# they are asked for over and over, and each one is a round trip through the
# tunnel. Cloudflare will not keep a path it does not recognise as cacheable
# unless a rule says so, and the rule has to be created with a zone token —
# the tunnel's own credentials are not enough.
#
# A zone token in CLOUDFLARE_API_TOKEN creates the rule; without one the
# rule is printed instead, ready to paste.
install_cache_rule() {
  local zone="${CLOUDFLARE_ZONE_ID:-}"
  local token="${CLOUDFLARE_API_TOKEN:-}"
  # The expression and the body are built in Python: they hold quotes,
  # braces and commas, and assembling them by hand in the shell is how they
  # get assembled wrong.
  local body
  body="$(CLOUDFLARE_DOMAIN="$DOMAIN" python3 - <<'PYTHON'
import json
import os

domain = os.environ['CLOUDFLARE_DOMAIN']
paths = [
    "/__volt",
    "/api/desktop-workbenches/restart-status",
    "/api/desktop-workbenches/market-installs",
    "/plugins/dsh-agent-teams/state",
]
expression = (
    '(http.host eq "{}" and http.request.method in {{"GET" "HEAD"}} '
    'and http.request.uri.path in {{{}}})'
).format(domain, " ".join('"{}"'.format(path) for path in paths))
body = {
    "rules": [
        {
            "expression": expression,
            "action": "set_cache_settings",
            "action_parameters": {
                "cache": True,
                "edge_ttl": {"mode": "override_origin", "default": 30},
                "browser_ttl": {"mode": "override_origin", "default": 5},
            },
        }
    ]
}
print(json.dumps(body))
PYTHON
)"
  if [ -z "$zone" ] || [ -z "$token" ]; then
    say ""
    say "the edge cache rule for the polled endpoints has to be created by hand:"
    say "  zone id : ${zone:-<your zone id>}"
    say "  token   : ${token:-<a token with Zone > Cache Rules > Edit>}"
    say "  path    : /zones/<zone id>/rulesets/phases/http_request_cache_settings/entrypoint"
    say "  method  : PUT"
    say "  body    : ${body}"
    return 0
  fi
  say ""
  say "creating the edge cache rule"
  local ruleset
  ruleset="$(curl -s -H "Authorization: Bearer ${token}" \
    "https://api.cloudflare.com/client/v4/zones/${zone}/rulesets/phases/http_request_cache_settings/entrypoint" \
    | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("result", {}).get("id", ""))
except Exception:
    print("")')"
  if [ -z "$ruleset" ]; then
    warn "the zone's cache-settings ruleset could not be read; the rule was not created"
    return 1
  fi
  printf '%s' "$body" > /tmp/dsh-cache-rule.json
  curl -s -X PUT -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/zones/${zone}/rulesets/${ruleset}" \
    --data-binary @/tmp/dsh-cache-rule.json \
    | python3 -c 'import json,sys
result = json.load(sys.stdin)
print("  rule:", "created" if result.get("success") else [e.get("message") for e in result.get("errors", [])])'
  rm -f /tmp/dsh-cache-rule.json
}

# ------------------------------------------------------------------ main --

case "$COMMAND" in
  check) do_check ;;
  print) do_print ;;
  install) do_install ;;
  uninstall) do_uninstall ;;
esac
