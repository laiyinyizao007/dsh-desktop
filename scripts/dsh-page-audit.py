#!/usr/bin/env python3
"""Walk the DSH UI page by page at a phone viewport and record what is cut off.

For each page it reports:
  - elements whose right edge is past the viewport (cut off, no scrollbar)
  - elements whose text wraps to more than one line because the box is narrow
  - interactive targets smaller than 44 px on either axis
  - a screenshot

Usage:
  python3 scripts/dsh-page-audit.py https://dsh.example.com [--width 390] [--out /tmp/dsh-pages]
"""
import os
import sys
from pathlib import Path

# Playwright lives in the user site-packages; a background shell may resolve a
# different interpreter, so make the path explicit before importing it.
_USER_SITE = Path.home() / ".local" / "lib" / f"python3.{sys.version_info.minor}" / "site-packages"
if _USER_SITE.is_dir() and str(_USER_SITE) not in sys.path:
    sys.path.insert(0, str(_USER_SITE))

from playwright.sync_api import sync_playwright

URL = (
    sys.argv[1]
    if len(sys.argv) > 1
    else os.environ.get("DSH_HARNESS_URL", "http://127.0.0.1:43129")
)
WIDTH = 390
if "--width" in sys.argv:
    WIDTH = int(sys.argv[sys.argv.index("--width") + 1])
OUT = Path("/tmp/dsh-pages")
if "--out" in sys.argv:
    OUT = Path(sys.argv[sys.argv.index("--out") + 1])
OUT.mkdir(parents=True, exist_ok=True)

PROBE = """() => {
  const doc = document.documentElement;
  const limit = doc.clientWidth;
  const cut = [];
  const cramped = [];
  const small = [];

  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;

    const cls = el.className && el.className.toString ? el.className.toString().slice(0, 44) : '';
    const label = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 40);

    // Cut off: the element extends past the right edge of the viewport.
    if (r.right > limit + 4) {
      cut.push(`${el.tagName.toLowerCase()}.${cls} right=${Math.round(r.right)} w=${Math.round(r.width)} "${label}"`);
    }

    // Cramped: the text needs more lines than the box height allows, which is
    // what a squeezed column looks like.
    if (el.children.length === 0 && label) {
      const lines = Math.round(r.height / parseFloat(cs.lineHeight || 20));
      if (lines >= 3 && r.width < limit * 0.6) {
        cramped.push(`${el.tagName.toLowerCase()}.${cls} w=${Math.round(r.width)} lines~${lines} "${label}"`);
      }
    }

    // Tap targets below the 44 px guideline.
    if (el.matches('button, a[href], [role=button], input, select, [role=switch], [role=tab]')) {
      if (r.height < 32 || r.width < 24) {
        small.push(`${el.tagName.toLowerCase()}.${cls} ${Math.round(r.width)}x${Math.round(r.height)} "${label}"`);
      }
    }
  }
  return {
    cut: cut.slice(0, 12),
    cramped: cramped.slice(0, 8),
    small: small.slice(0, 12),
    overflowX: doc.scrollWidth - limit,
    text: document.body.innerText.slice(0, 200),
  };
}"""

PAGES = [
    ("home", None),
    ("plugins", "Plugins"),
    ("automation", "Automation tasks"),
    ("more", "More"),
    ("settings", "Settings"),
]


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"]
        )
        ctx = browser.new_context(
            viewport={"width": WIDTH, "height": 844},
            is_mobile=True,
            has_touch=True,
            device_scale_factor=2,
        )
        page = ctx.new_page()
        page.goto(URL, wait_until="networkidle", timeout=90_000)
        page.wait_for_timeout(4500)

        # Expand the collapsed sidebar so the navigation is reachable.
        try:
            page.locator('[aria-label="Open sidebar"]').first.click(timeout=8000)
            page.wait_for_timeout(2000)
        except Exception:
            pass

        for name, label in PAGES:
            if label:
                try:
                    page.locator(f'[aria-label="{label}"]').first.click(timeout=6000)
                    page.wait_for_timeout(2500)
                except Exception:
                    try:
                        page.get_by_text(label, exact=True).first.click(timeout=6000)
                        page.wait_for_timeout(2500)
                    except Exception as error:
                        print(f"[{name}] could not open: {type(error).__name__}")
            data = page.evaluate(PROBE)
            shot = OUT / f"{name}.png"
            page.screenshot(path=str(shot))
            print(f"=== {name} ({WIDTH}px) ===")
            print(f"  overflowX={data['overflowX']}")
            if data["cut"]:
                print("  CUT OFF:")
                for line in data["cut"]:
                    print("   ", line)
            if data["cramped"]:
                print("  CRAMPED (text squeezed into a narrow column):")
                for line in data["cramped"]:
                    print("   ", line)
            if data["small"]:
                print("  SMALL TAP TARGETS:")
                for line in data["small"][:8]:
                    print("   ", line)
            print(f"  shot: {shot}")
            print()

        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
