"""Playwright launch with the domain guard installed. The process id is recorded in data/run/ so /stop can kill it."""
import os
from contextlib import contextmanager
from pathlib import Path

from . import safety


@contextmanager
def session(d: Path, allowed: list[str], headless: bool = True):
    from playwright.sync_api import sync_playwright

    pid = d / "run" / f"browser-{os.getpid()}.pid"
    pid.parent.mkdir(parents=True, exist_ok=True)
    pid.write_text(str(os.getpid()))
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(headless=headless)
            try:
                ctx = b.new_context(viewport={"width": 1280, "height": 1600}, accept_downloads=False)
                safety.install_guard(ctx, allowed)
                yield ctx
            finally:
                b.close()
    finally:
        pid.unlink(missing_ok=True)


def page_text(d: Path, url: str, allowed: list[str]) -> str:
    """Rendered text of a page whose HTML had no content (single-page apps)."""
    with session(d, allowed) as ctx:
        pg = ctx.new_page()
        pg.goto(url, wait_until="networkidle", timeout=45000)
        return pg.inner_text("body")
