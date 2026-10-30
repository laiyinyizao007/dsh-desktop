#!/usr/bin/env python3
"""Check how the DSH UI renders at phone viewports.

Usage:
  python3 scripts/dsh-mobile-check.py https://dsh.example.com [--shoot-prefix /tmp/dsh-mobile]
"""
import os
import sys
from playwright.sync_api import sync_playwright

URL = (
    sys.argv[1]
    if len(sys.argv) > 1
    else os.environ.get("DSH_HARNESS_URL", "http://127.0.0.1:43129")
)
PREFIX = "/tmp/dsh-mobile"
if "--shoot-prefix" in sys.argv:
    PREFIX = sys.argv[sys.argv.index("--shoot-prefix") + 1]

VIEWPORTS = [
    ("iphone-se", 375, 667),
    ("iphone-14", 390, 844),
    ("ipad", 820, 1180),
]


def main() -> int:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"]
        )
        for name, width, height in VIEWPORTS:
            context = browser.new_context(
                viewport={"width": width, "height": height},
                is_mobile=True,
                has_touch=True,
                device_scale_factor=2,
            )
            page = context.new_page()
            page.goto(URL, wait_until="networkidle", timeout=90_000)
            page.wait_for_timeout(5000)

            metrics = page.evaluate(
                """() => {
                    const doc = document.documentElement;
                    const overflow = doc.scrollWidth - doc.clientWidth;
                    const wide = [];
                    for (const el of document.querySelectorAll('body *')) {
                        const r = el.getBoundingClientRect();
                        if (r.width > 0 && r.right > doc.clientWidth + 8) {
                            wide.push({
                                tag: el.tagName.toLowerCase(),
                                cls: (el.className && el.className.toString
                                    ? el.className.toString().slice(0, 60) : ''),
                                right: Math.round(r.right),
                                width: Math.round(r.width),
                            });
                        }
                    }
                    return {
                        scrollWidth: doc.scrollWidth,
                        clientWidth: doc.clientWidth,
                        overflowX: overflow,
                        overflowing: wide.slice(0, 12),
                        metaViewport: document.querySelector('meta[name=viewport]')
                            ? document.querySelector('meta[name=viewport]').getAttribute('content')
                            : null,
                    };
                }"""
            )
            print(f"=== {name} ({width}x{height}) ===")
            print(f"  viewport meta: {metrics['metaViewport']}")
            print(
                f"  scrollWidth={metrics['scrollWidth']} clientWidth={metrics['clientWidth']}"
                f" overflowX={metrics['overflowX']}"
            )
            if metrics["overflowing"]:
                print("  elements past the right edge:")
                for item in metrics["overflowing"]:
                    print(
                        f"    <{item['tag']} class={item['cls']!r}> "
                        f"right={item['right']} width={item['width']}"
                    )
            shot = f"{PREFIX}-{name}.png"
            page.screenshot(path=shot, full_page=False)
            print(f"  screenshot: {shot}")
            context.close()
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
