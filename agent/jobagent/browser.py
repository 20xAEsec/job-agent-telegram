"""Playwright launch with the domain guard installed. The process id is recorded in data/run/ so /stop can kill it."""
import os
from contextlib import contextmanager
from pathlib import Path

from . import safety

# Without these, LinkedIn and Indeed see an automated browser and refuse logins more often.
STEALTH = {"ignore_default_args": ["--enable-automation"], "args": ["--disable-blink-features=AutomationControlled"]}


def _profile(p, d: Path, headless: bool):
    """JobAgent's own browser profile (data/browser/), where the user's job-site logins are kept. Real Chrome when installed."""
    kw = {"user_data_dir": str(d / "browser"), "headless": headless, "accept_downloads": False, **STEALTH,
          **({"viewport": {"width": 1280, "height": 1600}} if headless else {"no_viewport": True})}
    try:
        return p.chromium.launch_persistent_context(channel="chrome", **kw)
    except Exception:  # noqa: BLE001 - Chrome not installed: the bundled Chromium
        return p.chromium.launch_persistent_context(**kw)


@contextmanager
def session(d: Path, allowed: list[str] | None, headless: bool = True, profile: bool = False):
    """`profile`: use the logged-in profile (only one process can hold it). `allowed` None: no domain guard (a window the user drives)."""
    from playwright.sync_api import sync_playwright

    pid = d / "run" / f"browser-{os.getpid()}.pid"
    pid.parent.mkdir(parents=True, exist_ok=True)
    pid.write_text(str(os.getpid()))
    try:
        with sync_playwright() as p:
            if profile:
                ctx = _profile(p, d, headless)
                close = ctx.close
            else:
                b = p.chromium.launch(headless=headless)
                close = b.close
                ctx = b.new_context(viewport={"width": 1280, "height": 1600}, accept_downloads=False)
            try:
                if allowed is not None:
                    safety.install_guard(ctx, allowed)
                yield ctx
            finally:
                try:
                    close()
                except Exception:  # noqa: BLE001 - the user already closed the window
                    pass
    finally:
        pid.unlink(missing_ok=True)


def page_text(d: Path, url: str, allowed: list[str]) -> str:
    """Rendered text of a page whose HTML had no content (single-page apps)."""
    with session(d, allowed) as ctx:
        pg = ctx.new_page()
        pg.goto(url, wait_until="networkidle", timeout=45000)
        return pg.inner_text("body")
