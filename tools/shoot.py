"""Capture the README screenshots and the app shot for the banner from the running app.

Serves the repo on localhost, opens the demo (?demo: sample history and a playing session,
no microphone) in Microsoft Edge with Playwright and writes:

    docs/screenshot-desktop-{light,dark}.png   1280 px wide, top of the page
    docs/screenshot-mobile-{light,dark}.png    390 x 844 phone at 2x
    tools/banner/app.png                       the practice clock panel, dark, 2x

    pip install playwright
    python tools/shoot.py
"""
import functools
import http.server
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args) -> None:
        pass


def serve() -> tuple[http.server.ThreadingHTTPServer, str]:
    handler = functools.partial(Quiet, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/?demo"


def open_demo(browser, url, scheme, **ctx):
    context = browser.new_context(color_scheme=scheme, reduced_motion="reduce", service_workers="block", **ctx)
    page = context.new_page()
    page.goto(url)
    page.evaluate("document.fonts.ready")
    # Fails loudly if app.js did not run, instead of capturing the static "Ready" markup.
    page.wait_for_function("document.getElementById('stage').dataset.status === 'playing'", timeout=10000)
    page.wait_for_timeout(600)  # a few meter frames
    return context, page


def main() -> None:
    server, url = serve()
    DOCS.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", args=["--disable-lcd-text"])
        for scheme in ("light", "dark"):
            context, page = open_demo(browser, url, scheme, viewport={"width": 1280, "height": 900})
            # Down to the end of the stage, today and the 14-day chart.
            bottom = page.evaluate("Math.ceil(document.querySelector('.stage').getBoundingClientRect().bottom) + 12")
            page.screenshot(path=str(DOCS / f"screenshot-desktop-{scheme}.png"),
                            clip={"x": 0, "y": 0, "width": 1280, "height": bottom})
            context.close()

            context, page = open_demo(browser, url, scheme, viewport={"width": 390, "height": 844},
                                      device_scale_factor=2, is_mobile=True, has_touch=True)
            page.screenshot(path=str(DOCS / f"screenshot-mobile-{scheme}.png"))
            context.close()

        context, page = open_demo(browser, url, "dark", viewport={"width": 1280, "height": 900},
                                  device_scale_factor=2)
        page.locator(".stage").screenshot(path=str(ROOT / "tools" / "banner" / "app.png"))
        context.close()
        browser.close()
    server.shutdown()
    for f in sorted(DOCS.glob("screenshot-*.png")) + [ROOT / "tools" / "banner" / "app.png"]:
        print(f)


if __name__ == "__main__":
    main()
