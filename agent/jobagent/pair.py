"""Pairing: a one-time code carried in a Telegram deep link (t.me/<bot>?start=<code>), shown only in the local terminal."""
import hashlib
import json
import secrets
import time

from .paths import atomic_write_json

TTL_SECONDS = 15 * 60
ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no 0/o/1/l/i: readable if someone types it


def new_code(data_dir, bot: str | None = None) -> dict:
    """Create a pairing code. Only its sha256 is stored; the code (and the link and QR built from it) is returned for local display."""
    settings = data_dir / "settings.json"
    if settings.exists() and json.loads(settings.read_text("utf-8")).get("paired_user_id") is not None:
        return {"ok": False, "code": "already_paired", "error": "Already paired. Run `pair --reset` first."}
    code = "".join(secrets.choice(ALPHABET) for _ in range(10))
    atomic_write_json(
        data_dir / "pair.json",
        {"code_hash": hashlib.sha256(code.encode()).hexdigest(), "expires_at": time.time() + TTL_SECONDS, "attempts": 0},
    )
    out = {"ok": True, "pairing_code": code, "valid_minutes": TTL_SECONDS // 60}
    if bot:
        link = f"https://t.me/{bot.lstrip('@')}?start={code}"
        out |= {"link": link, "qr": qr_text(link)}
    return out


def qr_text(text: str) -> str:
    """The QR code as text blocks for a terminal (dark modules drawn light, so it scans on a dark background)."""
    import io

    import qrcode

    q = qrcode.QRCode(border=2)
    q.add_data(text)
    buf = io.StringIO()
    q.print_ascii(out=buf, invert=True)
    return buf.getvalue()


def reset(data_dir) -> dict:
    """Unpair. Local terminal only; the bot reads settings.json fresh, so no restart is needed."""
    settings = data_dir / "settings.json"
    if settings.exists():
        s = json.loads(settings.read_text("utf-8"))
        s["paired_user_id"] = None
        atomic_write_json(settings, s)
    (data_dir / "pair.json").unlink(missing_ok=True)
    return {"ok": True}
