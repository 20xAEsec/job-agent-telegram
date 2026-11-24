"""Pick an ATS from a URL, then (for company sites with ?gh_jid= / ?ashby_jid=) from the page HTML."""
import re
from urllib.parse import parse_qs, urlsplit

GH_HOST = re.compile(r"^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$")
GH_EMBED = re.compile(r"greenhouse\.io/embed/job_(?:board/js|app)\?for=([\w-]+)")
LEVER_HOST = re.compile(r"^jobs(\.eu)?\.lever\.co$")
ASHBY_HOST = "jobs.ashbyhq.com"
ASHBY_EMBED = re.compile(r"jobs\.ashbyhq\.com/([\w.-]+)/embed")
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
ATS_NAMES = {"greenhouse": "Greenhouse", "lever": "Lever", "ashby": "Ashby"}


def _gh(board: str, posting_id: str) -> dict:
    return {"ats": "greenhouse", "board": board.lower(), "posting_id": posting_id}


def from_url(url: str) -> dict:
    u = urlsplit(url.strip())
    host = (u.hostname or "").lower()
    if GH_HOST.match(host):
        m = re.match(r"^/([^/]+)/jobs/(\d+)", u.path)
        if m:
            return _gh(m[1], m[2])
        q = parse_qs(u.query)  # boards.greenhouse.io/embed/job_app?for=acme&token=123
        if u.path.startswith("/embed/job_app") and q.get("for") and (q.get("token") or q.get("gh_jid")):
            return _gh(q["for"][0], (q.get("token") or q["gh_jid"])[0])
    if (lv := LEVER_HOST.match(host)) and (m := re.match(rf"^/([\w.-]+)/({UUID})", u.path, re.I)):  # /acme/<uuid> or /acme/<uuid>/apply
        return {"ats": "lever", "board": m[1].lower(), "posting_id": m[2].lower(), **({"eu": True} if lv[1] else {})}
    if host == ASHBY_HOST and (m := re.match(rf"^/([\w.-]+)/({UUID})", u.path, re.I)):  # /acme/<uuid> or /acme/<uuid>/application
        return {"ats": "ashby", "board": m[1].lower(), "posting_id": m[2].lower()}
    return {"ats": "generic"}


def canonical(g: dict) -> str:
    """The one URL a fillable posting is known by (its id is built from it)."""
    if g["ats"] == "greenhouse":
        return f"https://job-boards.greenhouse.io/{g['board']}/jobs/{g['posting_id']}"
    if g["ats"] == "lever":
        return f"https://jobs{'.eu' if g.get('eu') else ''}.lever.co/{g['board']}/{g['posting_id']}"
    return f"https://{ASHBY_HOST}/{g['board']}/{g['posting_id']}"


def from_html(url: str, html: str) -> dict:
    """Company career page with an ATS embed: the board slug is in the embed script, the posting id in ?gh_jid= / ?ashby_jid=."""
    q = parse_qs(urlsplit(url).query)
    jid, aid = q.get("gh_jid", [""])[0], q.get("ashby_jid", [""])[0].lower()
    if (m := GH_EMBED.search(html or "")) and jid.isdigit():
        return _gh(m[1], jid)
    if (m := ASHBY_EMBED.search(html or "")) and re.fullmatch(UUID, aid):
        return {"ats": "ashby", "board": m[1].lower(), "posting_id": aid}
    return {"ats": "generic"}


def postings_in(html: str) -> list[dict]:
    """Every distinct fillable posting linked from a page (an employer page's "Apply" button), in page order."""
    out = []
    for u in re.findall(r"""https?://[\w.-]+\.(?:greenhouse\.io|lever\.co|ashbyhq\.com)/[^\s"'<>\\]+""", html or ""):
        g = from_url(u.replace("&amp;", "&"))
        if g["ats"] != "generic" and g not in out:
            out.append(g)
    return out


def adapter_for(meta: dict):
    if not (meta.get("board") and meta.get("posting_id")):
        return None
    if meta.get("ats") == "greenhouse":
        from .greenhouse import Greenhouse

        return Greenhouse()
    if meta.get("ats") == "lever":
        from .lever import Lever

        return Lever()
    if meta.get("ats") == "ashby":
        from .ashby import Ashby

        return Ashby()
    return None
