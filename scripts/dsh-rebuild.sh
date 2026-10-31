#!/usr/bin/env bash
# Rebuild a local host plugin and make the Harness serve it again.
#
# Why this exists: the Harness derives a client bundle's revision from the
# entry's mtime, ctime and size, and it only recomputes those when it starts
# or when the HMR hook fires. A bundle whose file changed after the Harness
# started is therefore served at a revision the server no longer has — the
# request 404s and the module graph fails with "required client modules
# failed to activate". The proxy's /healthz reports exactly that.
#
# Usage:
#   scripts/dsh-rebuild.sh                 # regenerate patches, restart, verify
#   scripts/dsh-rebuild.sh --no-patches    # restart and verify only
#   scripts/dsh-rebuild.sh --check         # report only, change nothing
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

HARNESS_SERVICE="${DSH_HARNESS_SERVICE:-dsh-web.service}"
PROXY_PORT="${DSH_PROXY_PORT:-43128}"
WAIT_SECONDS="${DSH_RESTART_WAIT:-32}"

regenerate_patches=1
check_only=0

for argument in "$@"; do
  case "$argument" in
    --no-patches) regenerate_patches=0 ;;
    --check) check_only=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $argument" >&2; exit 2 ;;
  esac
done

say() { printf '  %s\n' "$1"; }

health() {
  curl -s --max-time 20 "http://127.0.0.1:${PROXY_PORT}/healthz" 2>/dev/null || true
}

report() {
  local body
  body="$(health)"
  if [ -z "$body" ]; then
    say "the proxy did not answer on port ${PROXY_PORT}"
    return 1
  fi
  printf '%s' "$body" | python3 -c '
import json, sys

try:
    report = json.load(sys.stdin)
except Exception as error:
    print("  could not read the report: %s" % error)
    raise SystemExit(1)

for check in report.get("checks", []):
    mark = "ok  " if check["ok"] else "FAIL"
    print("  %s %s: %s" % (mark, check["name"], check["detail"]))
for entry in report.get("stale", []):
    print("       %s was modified at %s" % (entry["id"], entry["modified"]))
raise SystemExit(0 if report.get("ok") else 1)
'
}

if [ "$check_only" -eq 1 ]; then
  say "checking"
  report || exit 1
  exit 0
fi

if [ "$regenerate_patches" -eq 1 ]; then
  say "regenerating the patch files"
  # patch-package diffs the installed package against its published version.
  # A package whose patch is already applied has no diff to record, so the
  # existing patch file is kept — it is the record of what was applied, not
  # a product of this run.
  failed=0
  for patch_file in patches/*.patch; do
    [ -e "$patch_file" ] || continue
    package_and_version="$(basename "$patch_file" .patch)"
    package="${package_and_version%+*}"
    version="${package_and_version##*+}"
    [ -d "node_modules/${package}" ] || continue
    if ! output="$(npx patch-package "${package}" --version "${version}" 2>&1)"; then
      # "already applied" and "no patch file" are both fine.
      if ! printf '%s' "$output" | grep -qiE 'no patch file|already applied'; then
        say "  ${package}: ${output##*$'\n'}"
        failed=$((failed + 1))
      fi
    fi
  done
  if [ "$failed" -gt 0 ]; then
    say "${failed} package(s) did not regenerate — see above"
  else
    say "done"
  fi
fi

say "restarting ${HARNESS_SERVICE}"
sudo systemctl restart "$HARNESS_SERVICE"

say "waiting ${WAIT_SECONDS}s for the Harness to publish its revisions"
sleep "$WAIT_SECONDS"

say "checking"
if report; then
  say "the page will load"
else
  say "the report is still red — see the bundles named above"
  exit 1
fi
