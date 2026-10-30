#!/usr/bin/env python3
"""Look at a site at a phone viewport and report its layout shape.

Usage:
  python3 scripts/look-at-mobile.py https://gemini.google.com [--width 390] [--shot /tmp/gemini.png]
"""
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "https://gemini.google.com"
WIDTH = 390
if "--width" in sys.argv:
    WIDTH = int(sys.argv[sys.argv.index("--width") + 1])
SHOT = "/tmp/mobile-look.png"
if "--shot" in sys.argv:
    SHOT = sys.argv[sys.argv.index("--shot") + 1]

PROBE = """() => {
  const doc = document.documentElement;
  const fixed = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') {
      const r = el.getBoundingClientRect();
      if (r.width > 40 || r.height > 40) {
        fixed.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 40),
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          z: cs.zIndex,
        });
      }
    }
  }
  // A bottom tab bar is the usual phone pattern.
  const bottom = [...document.querySelectorAll('nav, [role=tablist], [class*=bottom], [class*=tabbar], [class*=tab-bar]')]
    .map(el => {
      const r = el.getBoundingClientRect();
      return { cls: (el.className || '').toString().slice(0, 40), y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) };
    })
    .filter(x => x.h > 20 && x.w > 100 && x.y > 200);
  return {
    vw: doc.clientWidth,
    overflowX: doc.scrollWidth - doc.clientWidth,
    fixedOverlays: fixed.slice(0, 8),
    bottomBars: bottom.slice(0, 6),
    text: document.body.innerText.slice(0, 500),
  };
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
    ctx = browser.new_context(
        viewport={"width": WIDTH, "height": 844},
        is_mobile=True,
        has_touch=True,
        device_scale_factor=2,
        user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    )
    page = ctx.new_page()
    page.goto(URL, wait_until="domcontentloaded", timeout=90_000)
    page.wait_for_timeout(8000)
    data = page.evaluate(PROBE)
    print(f"=== {URL} @ {WIDTH}px ===")
    print(f"  viewport={data['vw']} overflowX={data['overflowX']}")
    print("  fixed overlays:")
    for item in data["fixedOverlays"]:
        print(f"    {item}")
    print("  bottom bars:")
    for item in data["bottomBars"]:
        print(f"    {item}")
    print("  text:")
    print("   ", data["text"][:400].replace("\n", " | "))
    page.screenshot(path=SHOT)
    print(f"  screenshot: {SHOT}")
    browser.close()
