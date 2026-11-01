#!/usr/bin/env bash
# Restart the Harness when a client bundle changed after it started.
#
# The Harness derives a client bundle's revision from the entry's mtime,
# ctime and size, and recomputes it only on startup or through the HMR hook.
# A bundle edited after the Harness started is therefore still advertised at
# its old revision: the browser asks for that revision, the request 404s,
# and the module graph fails with "required client modules failed to activate".
#
# This runs from a timer. It reads the proxy's /healthz answer, which
# already compares the advertised revisions against the files on disk, and
# restarts the Harness only when that comparison says a bundle is stale.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

HARNESS_SERVICE="${DSH_HARNESS_SERVICE:-dsh-web.service}"
PROXY_PORT="${DSH_PROXY_PORT:-43128}"

body="$(curl -s --max-time 20 "http://127.0.0.1:${PROXY_PORT}/healthz" 2>/dev/null || true)"
if [ -z "$body" ]; then
  # The proxy is not answering. That is a different failure — the proxy
  # restarts itself — so this run stays quiet.
  exit 0
fi

stale="$(printf '%s' "$body" | python3 -c '
import json, sys

try:
    report = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)

for check in report.get("checks", []):
    if check["name"] == "client-bundle-revisions" and not check["ok"]:
        print(" ".join(entry["id"] for entry in report.get("stale", [])))
        break
' 2>/dev/null || true)"

if [ -z "$stale" ]; then
  exit 0
fi

echo "restarting ${HARNESS_SERVICE}: ${stale} changed after it started"
sudo systemctl restart "$HARNESS_SERVICE"
