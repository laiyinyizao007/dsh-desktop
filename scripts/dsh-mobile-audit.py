#!/usr/bin/env python3
"""Walk the DSH UI at a phone viewport and report per-page layout problems.

Clicks every sidebar entry, then measures each resulting page for horizontal
overflow and for elements that extend past the viewport's right edge.

Usage:
  python3 scripts/dsh-mobile-audit.py https://dsh.example.com [--width 390] [--height 844]
"""
import os
import sys
from playwright.sync_api import sync_playwright

URL = (
    sys.argv[1]
    if len(sys.argv) > 1
    else os.environ.get("DSH_HARNESS_URL", "http://127.0.0.1:43129")
)
WIDTH = 390
HEIGHT = 844
if "--width" in sys.argv:
    WIDTH = int(sys.argv[sys.argv.index("--width") + 1])
if "--height" in sys.argv:
    HEIGHT = int(sys.argv[sys.argv.index("--height") + 1])

PROBE = """() => {
    const doc = document.documentElement;
    const wide = [];
    for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > doc.clientWidth + 4) {
            const cls = el.className && el.className.toString
                ? el.className.toString().slice(0, 48) : '';
            wide.push(`${el.tagName.toLowerCase()}.${cls} right=${Math.round(r.right)} w=${Math.round(r.width)}`);
        }
    }
    // Tiny tap targets are the other half of "does not work on a phone".
    const small = [];
    for (const el of document.querySelectorAll('button, a[href], [role=button], input, select')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.height < 28 || r.width < 28) {
            const cls = el.className && el.className.toString
                ? el.className.toString().slice(0, 40) : '';
            const text = (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 24);
            small.push(`${el.tagName.toLowerCase()}.${cls} ${Math.round(r.width)}x${Math.round(r.height)} "${text}"`);
        }
    }
    return {
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        wide: wide.slice(0, 10),
        small: small.slice(0, 10),
        text: document.body.innerText.slice(0, 400),
    };
}"""


def main() -> int:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"]
        )
        context = browser.new_context(
            viewport={"width": WIDTH, "height": HEIGHT},
            is_mobile=True,
            has_touch=True,
            device_scale_factor=2,
        )
        page = context.new_page()
        page.goto(URL, wait_until="networkidle", timeout=90_000)
        page.wait_for_timeout(5000)

        # The collapsed sidebar exposes its entries by aria-label.
        labels = page.evaluate(
            """() => {
                const out = [];
                for (const el of document.querySelectorAll('button, a[href], [role=button]')) {
                    const label = el.getAttribute('aria-label') || el.innerText || '';
                    if (label && label.length < 40) out.push(label.trim());
                }
                return [...new Set(out)];
            }"""
        )
        print(f"=== {WIDTH}x{HEIGHT} :: clickable labels ===")
        print("  ", labels[:30])

        targets = ["Workbenches", "Sessions", "Plugins", "Automation tasks", "More", "Settings"]
        for target in targets:
            probe = page.evaluate(PROBE)
            print(f"\n=== page: {target} ===")
            print(f"  scrollWidth={probe['scrollWidth']} clientWidth={probe['clientWidth']}")
            if probe["wide"]:
                print("  overflow right:")
                for line in probe["wide"]:
                    print("   ", line)
            if probe["small"]:
                print("  small tap targets:")
                for line in probe["small"][:6]:
                    print("   ", line)
            shot = f"/tmp/dsh-m-{target.replace(' ', '_').lower()}.png"
            page.screenshot(path=shot)
            print(f"  shot: {shot}")

            # Move on to the next entry.
            try:
                page.get_by_text(target, exact=True).first.click(timeout=4000)
                page.wait_for_timeout(2500)
            except Exception:
                # Collapsed sidebar: try the aria-label instead.
                try:
                    page.locator(f'[aria-label="{target}"]').first.click(timeout=4000)
                    page.wait_for_timeout(2500)
                except Exception as error:
                    print(f"  (could not click {target}: {type(error).__name__})")

        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
