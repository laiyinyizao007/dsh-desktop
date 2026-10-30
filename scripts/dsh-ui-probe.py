#!/usr/bin/env python3
"""Inspect the DSH UI's Workspaces / Workbenches panels in a real browser.

Usage:
  python3 scripts/dsh-ui-probe.py https://dsh.example.com

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


def main() -> int:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"]
        )
        page = browser.new_context(viewport={"width": 1400, "height": 900}).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on(
            "console",
            lambda message: errors.append(f"[{message.type}] {message.text}")
            if message.type == "error"
            else None,
        )

        page.goto(URL, wait_until="networkidle", timeout=90_000)
        page.wait_for_timeout(5000)

        print("=== SIDEBAR TEXT ===")
        print(page.inner_text("body")[:1500])

        for label in ("Workbenches", "Plugins", "Automation tasks"):
            try:
                page.get_by_text(label, exact=True).first.click(timeout=5000)
                page.wait_for_timeout(2500)
                print(f"=== AFTER CLICK: {label} ===")
                print(page.inner_text("body")[:1500])
            except Exception as error:  # noqa: BLE001
                print(f"=== CLICK {label} FAILED: {error} ===")

        print("=== ERRORS ===")
        for line in errors[:20]:
            print(" ", line[:300])
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
