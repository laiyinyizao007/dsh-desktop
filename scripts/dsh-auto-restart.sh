#!/usr/bin/env bash
# Keep the DSH Harness running, and say when its client bundles are stale.
#
# This runs from a timer, every 30 seconds. It has two jobs:
#
#   1. Say when a client bundle changed after the Harness started.
#
#      The Harness derives a client bundle's revision from the entry's mtime,
#      ctime and size, and recomputes it only on startup or through the HMR
#      hook. A bundle edited after the Harness started is therefore still
#      advertised at its old revision: the browser asks for that revision, the
#      request 404s, and the module graph fails with "required client modules
#      failed to activate".
#
#      This reads the proxy's /healthz answer, which already compares the
#      advertised revisions against the files on disk.
#
#      The Harness is not restarted for this. A restart drops the live
#      WebSocket connections and interrupts whatever the agent is doing,
#      and editing a plugin is a thing a person does while they are working.
#      The warning names the bundles that changed and the command to restart
#      with; the restart is the person's to make, when they are ready for it.
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
# The unit that fills the edge cache with the client bundles. A Harness
# restart is what invalidates it: the bundles are content-addressed, so a
# rebuilt bundle has a new revision and therefore a new URL, and the edge has
# never seen it. Without a warm-up the first person to arrive after an
# upgrade pulls the whole plugin graph through the tunnel.
WARM_CACHE_SERVICE="${DSH_WARM_CACHE_SERVICE:-dsh-web-warm-cache.service}"
# Where the "the Harness is down" counter is kept between ticks. The timer
# runs a fresh process every 30 seconds, so the state has to live on disk.
STATE_DIR="${DSH_STATE_DIR:-/var/lib/dsh-watchdog}"
FAILURE_COUNT_FILE="${STATE_DIR}/harness-down-count"
# Where the time of the last "the launch token is missing" warning is kept.
TOKEN_WARNING_FILE="${STATE_DIR}/token-missing-warned-at"
# Where the set of stale bundles last reported is kept.
#
# The warning is only useful when it is new: the check runs every 30 seconds,
# and the same stale bundle stays stale until the Harness is restarted. The
# set is kept so that a warning is printed when the set changes, and not
# again for the same one.
STALE_NOTICE_FILE="${STATE_DIR}/stale-bundles-noticed"
# How long to wait between two such warnings. The check runs every 30
# seconds, and the warning is only useful when it is new.
TOKEN_WARNING_INTERVAL="${DSH_TOKEN_WARNING_INTERVAL:-3600}"
# How many consecutive failed checks have to add up before the Harness is
# started again. Two ticks is about a minute.
FAILURE_THRESHOLD="${DSH_FAILURE_THRESHOLD:-2}"

mkdir -p "$STATE_DIR"

# Fill the edge cache with the client bundles.
#
# It runs in the background: the warm-up pulls tens of megabytes through the
# tunnel, and the watchdog has nothing to do until its next tick.
warm_the_edge_cache() {
  sudo systemctl start --no-block "$WARM_CACHE_SERVICE" >/dev/null 2>&1 || true
}

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
  warm_the_edge_cache

  # Start the Harness before the bundle check below. The bundle check reads
  # the proxy's /healthz, which asks the Harness for its advertised
  # revisions; with the Harness down there is nothing to compare against, so
  # the check would answer "every bundle matches" and the page would keep
  # serving a stale revision until the next restart.
  rm -f "$FAILURE_COUNT_FILE"
  rm -f "$STALE_NOTICE_FILE"
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
  # Nothing is stale: the Harness is serving what is on disk. The record of
  # what was reported is cleared, so that the same bundle reported again
  # later is reported again.
  rm -f "$STALE_NOTICE_FILE"

  # The Harness is running but has no launch token the proxy can inject, so
  # every new browser gets a 401 while the browsers that still hold a session
  # cookie keep working. Restarting the Harness would not help — it would
  # print a new token, but the log rotation that took the old one away takes
  # this one away too, and the loop would never end.
  #
  # So this only says so, at most once an hour: the fix is to capture the
  # token again, not to restart anything.
  missing_token="$(printf '%s' "$body" | python3 -c '
import json, sys

try:
    report = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)

for check in report.get("checks", []):
    if check["name"] == "harness" and not check["ok"]:
        print(check.get("detail", ""))
        break
' 2>/dev/null || true)"
  if [ -n "$missing_token" ]; then
    now="$(date +%s)"
    last="$(cat "$TOKEN_WARNING_FILE" 2>/dev/null || echo 0)"
    case "$last" in
      ''|*[!0-9]*) last=0 ;;
    esac
    if [ $((now - last)) -ge "$TOKEN_WARNING_INTERVAL" ]; then
      printf '%s' "$now" > "$TOKEN_WARNING_FILE"
      echo "the Harness is running but its launch token is missing (${missing_token}) — new browsers get a 401 until it is captured again"
    fi
  fi
  exit 0
fi

# A bundle changed after the Harness started.
#
# The Harness is not restarted for this. A restart drops the live WebSocket
# connections and interrupts whatever the agent is doing, and editing a
# plugin is a thing a person does while they are working — so the restart
# is theirs to make, when they are ready for it. Until then the browser
# asks for a revision the Harness no longer has, and the page says so.
#
# The warning is printed when the set of stale bundles changes, and not again
# for the same one: the check runs every 30 seconds, and the same bundle
# stays stale until the Harness is restarted.
if [ "$(cat "$STALE_NOTICE_FILE" 2>/dev/null || true)" != "$stale" ]; then
  printf '%s' "$stale" > "$STALE_NOTICE_FILE"
  echo "these client bundles changed after the Harness started: ${stale}"
  echo "  the page will not load until it is restarted:"
  echo "  sudo systemctl restart ${HARNESS_SERVICE}"
fi
exit 0
