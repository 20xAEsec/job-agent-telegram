"""Pick an ATS from a URL, then (for company sites with ?gh_jid=) from the page HTML."""
import re
from urllib.parse import parse_qs, urlsplit

GH_HOST = re.compile(r"^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$")
GH_EMBED = re.compile(r"greenhouse\.io/embed/job_(?:board/js|app)\?for=([\w-]+)")


def _gh(board: str, posting_id: str) -> dict:
    return {"ats": "greenhouse", "board": board.lower(), "posting_id": posting_id}


def from_url(url: str) -> dict:
    u = urlsplit(url.strip())
    if GH_HOST.match((u.hostname or "").lower()):
        m = re.match(r"^/([^/]+)/jobs/(\d+)", u.path)
        if m:
            return _gh(m[1], m[2])
        q = parse_qs(u.query)  # boards.greenhouse.io/embed/job_app?for=acme&token=123
        if u.path.startswith("/embed/job_app") and q.get("for") and (q.get("token") or q.get("gh_jid")):
            return _gh(q["for"][0], (q.get("token") or q["gh_jid"])[0])
    return {"ats": "generic"}


def from_html(url: str, html: str) -> dict:
    """Company career page with the Greenhouse embed: the board slug is in the embed script, the posting id in ?gh_jid=."""
    jid = parse_qs(urlsplit(url).query).get("gh_jid", [""])[0]
    m = GH_EMBED.search(html or "")
    return _gh(m[1], jid) if m and jid.isdigit() else {"ats": "generic"}


def adapter_for(meta: dict):
    if meta.get("ats") == "greenhouse" and meta.get("board") and meta.get("posting_id"):
        from .greenhouse import Greenhouse

        return Greenhouse()
    return None  # generic / Lever / Ashby arrive in stage f
