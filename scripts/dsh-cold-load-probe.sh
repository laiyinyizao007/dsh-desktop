#!/usr/bin/env bash
# Measure one cold page load through the public URL.
#
# A cold load is what a person meets when the edge cache does not hold the
# client bundles: the page asks for the whole plugin graph, and every byte
# of it comes back through the tunnel. This measures that, and prints the
# numbers a change can be judged against:
#
#   * how long the page took to arrive,
#   * how many bundles it asked for, and how many of them the edge already
#     had (a HIT costs the tunnel nothing),
#   * how many bytes came back, over the wire and after decompression,
#   * how long the whole thing took.
#
# The bundle requests are made in parallel, the way a browser makes them:
# eleven at a time, which is what the page itself does.
#
# Usage:
#   scripts/dsh-cold-load-probe.sh [public-url]
set -euo pipefail

BASE="${1:-${DSH_PUBLIC_URL:-https://dsh.averivendell.world}}"
CONCURRENCY="${DSH_PROBE_CONCURRENCY:-11}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! [[ "$BASE" =~ ^https?:// ]]; then
  echo "dsh-cold-load-probe: \"$BASE\" is not an http(s) URL" >&2
  exit 1
fi

# The root page exchanges the launch token for a session cookie, so the
# bundle requests have to carry it — the same way the browser does.
page_started="$(date +%s.%N)"
curl -sSL -o "$WORK/page.html" -c "$WORK/jar" -b "$WORK/jar" "$BASE/"
page_finished="$(date +%s.%N)"

# The URLs the page asks for: the ones in the markup and the ones in the
# module graph it names.
python3 - "$WORK/page.html" "$BASE" > "$WORK/urls" <<'PY'
import re
import sys
from urllib.parse import urljoin

html = open(sys.argv[1], encoding='utf-8', errors='replace').read()
base = sys.argv[2].rstrip('/') + '/'

urls = []
seen = set()
for pattern in (r'(?:src|href)="([^"]+)"', r'"url":"([^"]+)"'):
    for match in re.findall(pattern, html):
        if not (match.startswith('/') or match.startswith('plugins/') or match.startswith('assets/')):
            continue
        if 'plugins/' not in match and not match.startswith('/') and not match.startswith('assets/'):
            continue
        url = urljoin(base, match)
        if url not in seen:
            seen.add(url)
            urls.append(url)

for url in urls:
    print(url)
PY

total="$(wc -l < "$WORK/urls" | tr -d ' ')"
if [ "$total" -eq 0 ]; then
  echo "dsh-cold-load-probe: the page named no bundles — the page at $BASE is not the page"
  exit 1
fi

# The bundle requests only read the cookie the root page handed out, so they
# get their own copy of the jar. Sharing one jar between eleven parallel
# curls means eleven writers on one file: each of them rewrites it on the way
# out, and a bundle that lands in the middle of that is sent without a
# session cookie — which the origin answers with 401. The copy removes the
# race.
cp "$WORK/jar" "$WORK/jar.bundles"

# One line per bundle: the edge's answer, the bytes and the wait.
cat > "$WORK/fetch.sh" <<'FETCH'
#!/usr/bin/env bash
url="$1"
jar="$2"
headers="$(mktemp)"
metrics="$(curl -sS -o /dev/null -D "$headers" -b "$jar" \
  -w '%{http_code} %{size_download} %{time_starttransfer} %{time_total}' "$url" || echo '000 0 0 0')"
status="$(grep -i '^cf-cache-status:' "$headers" | head -1 | tr -d '\r' | awk '{print $2}')"
rm -f "$headers"
echo "${metrics} ${status:-none} ${url}"
FETCH
chmod +x "$WORK/fetch.sh"

bundles_started="$(date +%s.%N)"
xargs -a "$WORK/urls" -P "$CONCURRENCY" -I{} "$WORK/fetch.sh" {} "$WORK/jar.bundles" > "$WORK/results"
bundles_finished="$(date +%s.%N)"

python3 - "$WORK/results" "$total" "$page_started" "$page_finished" "$bundles_started" "$bundles_finished" "$BASE" <<'PY'
import sys

results_path, total, page_started, page_finished, bundles_started, bundles_finished, base = sys.argv[1:8]
total = int(total)

hits = misses = other = 0
bytes_on_the_wire = 0
slowest = (0.0, '')
failed = 0

with open(results_path, encoding='utf-8') as handle:
    for line in handle:
        parts = line.split(None, 4)
        if len(parts) < 5:
            failed += 1
            continue
        code, size, ttfb, total_time, rest = parts[0], parts[1], parts[2], parts[3], parts[4]
        cache = rest.split(' ', 1)[0]
        if code != '200':
            failed += 1
        if cache == 'HIT':
            hits += 1
        elif cache == 'MISS':
            misses += 1
        else:
            other += 1
        bytes_on_the_wire += int(size or 0)
        if float(ttfb or 0) > slowest[0]:
            slowest = (float(ttfb or 0), rest.split(' ', 1)[1].strip())

page = float(page_finished) - float(page_started)
bundles = float(bundles_finished) - float(bundles_started)

print(f'root page      {page * 1000:.0f}ms')
print(f'bundles        {bundles * 1000:.0f}ms wall for {total} requests')
print(f'cache          {hits} HIT, {misses} MISS, {other} neither, {failed} failed')
print(f'transferred    {bytes_on_the_wire / 1024 / 1024:.2f}MB')
print(f'slowest bundle {slowest[0] * 1000:.0f}ms  {slowest[1][:80]}')
print(f'total          {(page + bundles) * 1000:.0f}ms')
PY
