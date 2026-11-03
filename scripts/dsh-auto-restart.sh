#!/usr/bin/env bash
# Keep the DSH Harness running and its client bundles fresh.
#
# This runs from a timer, every 30 seconds. It has two jobs:
#
#   1. Restart the Harness when a client bundle changed after it started.
#
#      The Harness derives a client bundle's revision from the entry's mtime,
#      ctime and size, and recomputes it only on startup or through the HMR
#      hook. A bundle edited after the Harness started is therefore still
#      advertised at its old revision: the browser asks for that revision, the
#      request 404s, and the module graph fails with "required client modules
#      failed to activate".
#
#      This reads the proxy's /healthz answer, which already compares the
#      advertised revisions against the files on disk, and restarts the Harness
#      only when that comparison says a bundle is stale.
#
#   2. Bring the Harness back when it is not running at all.
#
#      `Restart=always` covers a crash, but a `systemctl stop` is an explicit
#      stop: systemd deliberately does not restart a unit that was stopped on
#      purpose, so the Harness stays down until someone starts it. The proxy
#      and the tunnel keep serving, and the public URL answers "Bad gateway"
#      instead of the page.
#
#      The check is `systemctl is-active`, not the proxy's /healthz: /healthz
#      looks for the launch token in the log, and the log still holds the last
#      token of a Harness that is already dead. /healthz therefore reports
#      "ok" while the Harness is gone, and a watchdog built on it would never
#      fire.
#
# The service is only brought back after two consecutive failed checks, so a
# deliberate stop has a grace period of about a minute: a planned maintenance
# stop is not undone by the next tick, and a systemd restart in progress (a
# stop and a start with a gap in between) is not raced.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

HARNESS_SERVICE="${DSH_HARNESS_SERVICE:-dsh-web.service}"
PROXY_PORT="${DSH_PROXY_PORT:-43128}"
# Where the "the Harness is down" counter is kept between ticks. The timer
# runs a fresh process every 30 seconds, so the state has to live on disk.
STATE_DIR="${DSH_STATE_DIR:-/var/lib/dsh-watchdog}"
FAILURE_COUNT_FILE="${STATE_DIR}/harness-down-count"
# How many consecutive failed checks have to add up before the Harness is
# started again. Two ticks is about a minute.
FAILURE_THRESHOLD="${DSH_FAILURE_THRESHOLD:-2}"

mkdir -p "$STATE_DIR"

# Bring the Harness back if it is not running.
#
# `systemctl is-active` answers "active" only for a running unit. A unit that
# failed to start answers "failed" and is treated as down as well.
harness_is_up() {
  [ "$(systemctl is-active "$HARNESS_SERVICE" 2>/dev/null || true)" = "active" ]
}

if harness_is_up; then
  # The Harness is up: forget any earlier failure, so a later outage gets the
  # full grace period again instead of being triggered by a stale count.
  rm -f "$FAILURE_COUNT_FILE"
else
  count=0
  if [ -f "$FAILURE_COUNT_FILE" ]; then
    count="$(cat "$FAILURE_COUNT_FILE" 2>/dev/null || echo 0)"
    case "$count" in
      ''|*[!0-9]*) count=0 ;;
    esac
  fi
  count=$((count + 1))
  printf '%s' "$count" > "$FAILURE_COUNT_FILE"

  if [ "$count" -lt "$FAILURE_THRESHOLD" ]; then
    # Not yet: the stop may be deliberate, or a restart may be in progress.
    exit 0
  fi

  echo "starting ${HARNESS_SERVICE}: it was not running for ${count} consecutive checks"
  sudo systemctl start "$HARNESS_SERVICE"

  # Start the Harness before the bundle check below. The bundle check reads
  # the proxy's /healthz, which asks the Harness for its advertised
  # revisions; with the Harness down there is nothing to compare against, so
  # the check would answer "every bundle matches" and the page would keep
  # serving a stale revision until the next restart.
  rm -f "$FAILURE_COUNT_FILE"
  exit 0
fi

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
