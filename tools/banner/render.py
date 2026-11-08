"""Render banner.html to docs/banner.png (1280x640) with Playwright and Microsoft Edge.

    pip install playwright
    python tools/banner/render.py
"""
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "docs" / "banner.png"


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge")
        page = browser.new_page(viewport={"width": 1280, "height": 640}, color_scheme="light")
        page.goto((HERE / "banner.html").as_uri())
        page.evaluate("document.fonts.ready")
        page.screenshot(path=str(OUT))
        browser.close()
    print(OUT)


if __name__ == "__main__":
    main()
