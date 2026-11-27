"""Job-site logins (LinkedIn, Indeed). Their postings are often hidden from logged-out visitors, so JobAgent reads them in its
own browser profile (data/browser/), where the user logs in once (`jobagent login <site>` opens a window) and stays logged in.
JobAgent cannot reuse the user's everyday browser: Chrome encrypts its cookies for Chrome alone.
A saved password lives in the OS keychain (Windows Credential Manager), never in data/. Claude is denied `login` and `credentials`."""
import getpass
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from . import browser, safety, store
from .ats.base import Closed
from .paths import atomic_write_json

SITES = {
    "linkedin": {"name": "LinkedIn", "hosts": ["linkedin.com"], "login": "https://www.linkedin.com/login",
                 "check": "https://www.linkedin.com/feed/", "user": "#username", "pass": "#password"},
    "indeed": {"name": "Indeed", "hosts": ["indeed.com"], "login": "https://secure.indeed.com/auth",
               "check": "https://secure.indeed.com/settings/account", "user": "input[type=email]", "pass": "input[type=password]"},
}
AUTH = ("/login", "/uas/", "/authwall", "/checkpoint", "/auth", "/signin", "/account/login")
BOT_CHECK = re.compile(r"just a moment|blocked|verify you are human|security check|are you a robot", re.I)
KEYCHAIN = "JobAgent"
RETRY_HOURS = 6  # a failed automatic login is not retried sooner: repeated failures get accounts locked


class NeedsLogin(Exception):
    def __init__(self, site: str):
        super().__init__(site)
        self.site = site


def site_for(url: str) -> str | None:
    return next((k for k, s in SITES.items() if safety.host_ok(url, s["hosts"])), None)


def _on_auth(url: str) -> bool:
    return any(urlsplit(url).path.startswith(a) for a in AUTH)


# ---- saved passwords (OS keychain) ----

def saved(site: str) -> dict | None:
    import keyring

    try:
        v = keyring.get_password(KEYCHAIN, site)
        return json.loads(v) if v else None
    except Exception:  # noqa: BLE001 - no keychain, or an unreadable entry: as if none were saved
        return None


def _ask(name: str) -> tuple[str | None, str | None]:
    """A small box on the computer's screen (the app starts this from a Telegram button), else the terminal."""
    try:
        import tkinter as tk
        from tkinter import simpledialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        user = simpledialog.askstring("JobAgent", f"Your {name} email (or phone number):", parent=root)
        pw = simpledialog.askstring("JobAgent", f"Your {name} password:", show="•", parent=root) if user else None
        root.destroy()
        return user, pw
    except Exception:  # noqa: BLE001 - no screen
        if not sys.stdin.isatty():
            raise
        user = input(f"Your {name} email (or phone number): ").strip()
        return user, getpass.getpass(f"Your {name} password: ") if user else None


def credentials_set(site: str) -> dict:
    import keyring

    user, pw = _ask(SITES[site]["name"])
    if not user or not pw:
        return {"ok": False, "code": "cancelled", "error": "nothing was saved"}
    keyring.set_password(KEYCHAIN, site, json.dumps({"user": user.strip(), "pass": pw}))
    return {"ok": True, "site": site, "saved": True}


def credentials_delete(site: str) -> dict:
    import keyring

    try:
        keyring.delete_password(KEYCHAIN, site)
    except keyring.errors.PasswordDeleteError:
        pass  # nothing was saved
    return {"ok": True, "site": site, "saved": False}


# ---- the browser profile ----

def _logged_in(ctx, site: str) -> bool | None:
    """Open a page only logged-in users can see, in its own tab: logged out, the site redirects to its login page.
    None: a bot check ("Just a moment...", Indeed's "Blocked") hid the answer."""
    s, pg = SITES[site], ctx.new_page()
    try:
        pg.goto(s["check"], wait_until="domcontentloaded", timeout=30000)
        if _on_auth(pg.url):
            return False
        return None if BOT_CHECK.search(pg.title()) else safety.host_ok(pg.url, s["hosts"])
    except Exception:  # noqa: BLE001 - offline or timed out
        return False
    finally:
        pg.close()


def _fill(pg, site: str, creds: dict) -> None:
    """Type the saved login. Indeed asks for the email first, then the password on the next screen. Anything else
    (a code sent by email, a CAPTCHA, "sign in with a code") is left to the user."""
    s = SITES[site]
    try:
        pg.locator(s["user"]).first.fill(creds["user"], timeout=15000)
        if not pg.locator(s["pass"]).first.is_visible():
            pg.locator(s["user"]).first.press("Enter")
        pg.locator(s["pass"]).first.fill(creds["pass"], timeout=15000)
        pg.locator(s["pass"]).first.press("Enter")
    except Exception:  # noqa: BLE001 - the page is not the usual login form
        pass


def login(d: Path, site: str, wait: int = 300) -> dict:
    """Open a browser window on the user's screen at the site's login page (saved login typed in) and wait until they are in."""
    name = SITES[site]["name"]
    done = None
    try:
        with browser.session(d, None, headless=False, profile=True) as ctx:
            if _logged_in(ctx, site):
                _remember(d, site, ok=True)
                return {"ok": True, "site": site, "logged_in": True, "already": True}
            pg = ctx.pages[0] if ctx.pages else ctx.new_page()
            pg.goto(SITES[site]["login"], wait_until="domcontentloaded", timeout=30000)
            if creds := saved(site):
                _fill(pg, site, creds)
            for _ in range(wait // 3):
                pg.wait_for_timeout(3000)  # raises once the user closes the window
                if not _on_auth(pg.url) and _logged_in(ctx, site):
                    done = True
                    break
    except Exception as e:  # noqa: BLE001 - the window was closed, or the profile is open in another JobAgent window
        if "user data directory is already in use" in str(e).lower() or "processsingleton" in str(e).lower():
            return {"ok": False, "code": "busy", "error": "a JobAgent browser window is already open; close it and try again"}
    if done is None:
        done = status(d, [site]).get(site, {}).get("logged_in", False)  # they may have finished just before closing the window
    if done:
        _remember(d, site, ok=True)
        return {"ok": True, "site": site, "logged_in": True}
    return {"ok": False, "code": "not_logged_in", "error": f"the {name} login was not finished"}


def status(d: Path, sites: list[str] | None = None) -> dict:
    out, last = {}, store._load(d / "logins.json") or {}
    try:
        with browser.session(d, [h for s in SITES.values() for h in s["hosts"]], profile=True) as ctx:
            for k in sites or SITES:
                v = _logged_in(ctx, k)
                # shortcut: behind a bot check (Indeed, always) the last login result stands in; it can be out of date.
                out[k] = {"name": SITES[k]["name"], "logged_in": (last.get(k) or {}).get("ok") if v is None else v, "saved": saved(k) is not None}
    except Exception:  # noqa: BLE001 - the login window is open (it holds the profile)
        return {k: {"name": SITES[k]["name"], "logged_in": None, "saved": saved(k) is not None} for k in sites or SITES}
    for k, v in out.items():
        cache(d, k, logged_in=v["logged_in"], saved=v["saved"], at=store.now())
    return out


def cache(d: Path, site: str, **kv) -> None:
    """data/login_status.json: what the app's Job site logins screen shows without opening a browser."""
    c = store._load(d / "login_status.json") or {}
    c[site] = {**(c.get(site) or {}), **kv}
    atomic_write_json(d / "login_status.json", c)


def _remember(d: Path, site: str, ok: bool) -> None:
    st = store._load(d / "logins.json") or {}
    st[site] = {"at": store.now(), "ok": ok}
    atomic_write_json(d / "logins.json", st)
    cache(d, site, logged_in=ok, at=store.now())


def _auto_login(d: Path, ctx, site: str) -> bool:
    """Log in with the saved password, without a window. At most once per RETRY_HOURS after a failure."""
    creds = saved(site)
    last = (store._load(d / "logins.json") or {}).get(site) or {}
    if not creds or (not last.get("ok", True) and datetime.now(timezone.utc) - datetime.fromisoformat(last["at"]) < timedelta(hours=RETRY_HOURS)):
        return False
    pg = ctx.new_page()
    try:
        pg.goto(SITES[site]["login"], wait_until="domcontentloaded", timeout=30000)
        _fill(pg, site, creds)
        pg.wait_for_timeout(8000)
        ok = _logged_in(ctx, site)
    except Exception:  # noqa: BLE001
        ok = False
    finally:
        pg.close()
    _remember(d, site, ok)
    return ok


def _read(pg, url: str) -> str | None:
    r = pg.goto(url, wait_until="load", timeout=45000)
    if r is not None and r.status in (404, 410):
        raise Closed(url)
    pg.wait_for_timeout(2500)  # both sites draw the posting after load
    if _on_auth(pg.url):
        return None
    main = pg.locator("main")
    text = main.first.inner_text() if main.count() else ""
    text = text if len(text) >= 200 else pg.inner_text("body")
    return text if len(text) >= 200 else None  # a bot-check page has almost no text


def page_text(d: Path, url: str) -> str:
    """The posting's text, read in the logged-in profile. Raises NeedsLogin when the site shows its login page instead."""
    site = site_for(url)
    with browser.session(d, SITES[site]["hosts"], profile=True) as ctx:
        pg = ctx.new_page()
        text = _read(pg, url)
        if text is None and _auto_login(d, ctx, site):
            text = _read(pg, url)
    if text is None:
        cache(d, site, logged_in=False, at=store.now())
        raise NeedsLogin(site)
    return text
