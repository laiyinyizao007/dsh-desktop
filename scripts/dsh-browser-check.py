#!/usr/bin/env python3
"""Open a DSH page in Chromium and report console errors and failed requests.

Usage:
  python3 scripts/dsh-browser-check.py https://dsh.example.com [--shot out.png]

The URL defaults to the DSH_HARNESS_URL environment variable, then to
http://127.0.0.1:43129.
"""
import os
import sys
from playwright.sync_api import sync_playwright

URL = (
    sys.argv[1]
    if len(sys.argv) > 1
    else os.environ.get("DSH_HARNESS_URL", "http://127.0.0.1:43129")
)
SHOT = None
if "--shot" in sys.argv:
    SHOT = sys.argv[sys.argv.index("--shot") + 1]

console_errors = []
page_errors = []
failed_requests = []


def main() -> int:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        context = browser.new_context(viewport={"width": 1400, "height": 900})
        page = context.new_page()

        page.on(
            "console",
            lambda message: console_errors.append(
                f"[{message.type}] {message.text}"
            )
            if message.type in ("error", "warning")
            else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "requestfailed",
            lambda request: failed_requests.append(
                f"{request.method} {request.url[:140]} :: {request.failure}"
            ),
        )
        page.on(
            "response",
            lambda response: failed_requests.append(
                f"HTTP {response.status} {response.url[:140]}"
            )
            if response.status >= 400
            else None,
        )

        page.goto(URL, wait_until="networkidle", timeout=90_000)
        page.wait_for_timeout(6000)

        body = page.inner_text("body")
        print("=== PAGE TITLE ===")
        print(page.title())
        print("=== VISIBLE TEXT (first 1200 chars) ===")
        print(body[:1200])
        print("=== CONSOLE ERRORS/WARNINGS ===")
        for line in console_errors[:60]:
            print(" ", line)
        print("=== PAGE ERRORS ===")
        for line in page_errors[:40]:
            print(" ", line)
        print("=== FAILED REQUESTS ===")
        for line in failed_requests[:40]:
            print(" ", line)

        if SHOT:
            page.screenshot(path=SHOT, full_page=False)
            print(f"=== SCREENSHOT: {SHOT} ===")

        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
