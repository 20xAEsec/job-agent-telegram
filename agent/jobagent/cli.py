import argparse
import json
import sys
from pathlib import Path

from . import accounts, bench, canary, check, errlog, feedback, fetch, fill, formplan, llm, log, maintain, pair, profile, repair, resolve, resume, review, safety, store, submit, tailor
from .discover import ats_api, boards
from .docs.plan import DocError
from .paths import default_data_dir


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="jobagent")
    p.add_argument("--data-dir", type=Path, default=default_data_dir())
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("setup-check")

    pp = sub.add_parser("pair")
    g = pp.add_mutually_exclusive_group(required=True)
    g.add_argument("--new", action="store_true")
    g.add_argument("--reset", action="store_true")
    pp.add_argument("--bot", help="bot username: also return the t.me link and a QR code")

    rs = sub.add_parser("resume").add_subparsers(dest="sub", required=True)
    ri = rs.add_parser("import")
    ri.add_argument("path")
    ri.add_argument("--version", action="store_true", help="store it as an extra resume version, not the main resume")
    rs.add_parser("outline")
    rs.add_parser("bank")
    rs.add_parser("remove").add_argument("name")
    sub.add_parser("resume-check")
    tp = sub.add_parser("tailor")
    tp.add_argument("job_id")
    tp.add_argument("--fallback", action="store_true")
    sub.add_parser("cover-letter").add_argument("job_id")

    sub.add_parser("fetch").add_argument("job_id")
    sub.add_parser("canary").add_argument("--live", metavar="URL", help="also read one real posting's form (nothing is typed)")
    sub.add_parser("inspect").add_argument("job_id")
    sub.add_parser("resolve").add_argument("job_id")  # job site listing -> the employer's fillable posting (writes meta.json only)
    fl = sub.add_parser("fill")
    fl.add_argument("job_id")
    fl.add_argument("--dry-run", action="store_true")
    sub.add_parser("submit").add_argument("job_id")  # channel server only: denied to Claude
    # The v4 engine (app only, denied to Claude): one tool-less judgment's input file, and the check that writes its answer.
    ll = sub.add_parser("llm")
    ll.add_argument("op", choices=["input", "accept"])
    ll.add_argument("name", choices=llm.NAMES)
    ll.add_argument("--job")
    ll.add_argument("--file", help="accept: the answer JSON")
    ll.add_argument("--extra", default="{}", help="a small JSON object (tier, errors, the change request)")
    sub.add_parser("plan").add_subparsers(dest="sub", required=True).add_parser("build").add_argument("job_id")
    sub.add_parser("maintain")  # the daily upkeep (app only, denied to Claude): prune old job files, expire unanswered auto-search jobs
    bn = sub.add_parser("bench").add_subparsers(dest="sub", required=True).add_parser("screen")  # the maintainer's replay: counts only
    bn.add_argument("--data", required=True, help="a data folder to read (never written)")
    bn.add_argument("--llm", action="store_true", help="also run the quick sort (uses Claude)")
    rp = sub.add_parser("repair")  # start/test/prepare: Claude. publish/discard: the app only (publish is denied to Claude)
    rp.add_argument("op", choices=["start", "test", "prepare", "publish", "discard"])
    rp.add_argument("repair_id")
    # job-site logins: the user only (denied to Claude). `login status` reads, `login <site>` opens a window on the screen.
    sub.add_parser("login").add_argument("site", choices=[*accounts.SITES, "status"])
    cr = sub.add_parser("credentials")
    cr.add_argument("op", choices=["set", "delete"])
    cr.add_argument("site", choices=list(accounts.SITES))
    jb = sub.add_parser("job").add_subparsers(dest="sub", required=True)
    jn = jb.add_parser("new")
    jn.add_argument("url")
    jn.add_argument("--source", default="manual")
    jb.add_parser("get").add_argument("job_id")
    js = jb.add_parser("set-status")
    js.add_argument("job_id")
    js.add_argument("status")
    js.add_argument("--detail", default="")
    jb.add_parser("list").add_argument("--status")
    rv = sub.add_parser("review").add_subparsers(dest="sub", required=True)
    rv.add_parser("build").add_argument("job_id")
    rv.add_parser("hash").add_argument("job_id")
    lg = sub.add_parser("log").add_subparsers(dest="sub", required=True)
    lg.add_parser("upsert").add_argument("job_id")
    lg.add_parser("export")
    lo = lg.add_parser("outcome")
    lo.add_argument("job_id")
    lo.add_argument("value")

    sub.add_parser("discover").add_subparsers(dest="sub", required=True).add_parser("poll")
    sub.add_parser("feedback").add_subparsers(dest="sub", required=True).add_parser("summary")
    sub.add_parser("coverage").add_argument("job_id")
    bd = sub.add_parser("boards").add_subparsers(dest="sub", required=True)
    ba = bd.add_parser("add")
    ba.add_argument("ats", choices=boards.ATS)
    ba.add_argument("slugs", nargs="+")
    bd.add_parser("list")
    br = bd.add_parser("remove")
    br.add_argument("ats", choices=[*boards.ATS, "any"])
    br.add_argument("slugs", nargs="+")
    bc = bd.add_parser("check")
    bc.add_argument("slug")
    bc.add_argument("--ats", choices=boards.ATS)

    ps = sub.add_parser("profile").add_subparsers(dest="sub", required=True)
    ps.add_parser("write-draft").add_argument("file")
    ps.add_parser("show").add_argument("--section")
    an = ps.add_parser("answer").add_subparsers(dest="op", required=True)
    ls = an.add_parser("list")
    ls.add_argument("--json", action="store_true")  # accepted for the documented CLI shape; output is always JSON
    ls.add_argument("--include-job")
    an.add_parser("get").add_argument("key")
    st = an.add_parser("set")
    st.add_argument("key")
    st.add_argument("--question", required=True)
    st.add_argument("--value", required=True)
    st.add_argument("--scope", choices=["global", "job"], default="global")
    st.add_argument("--job")
    st.add_argument("--sensitive", action="store_true")
    an.add_parser("delete").add_argument("key")
    sf = ps.add_parser("set-field")
    sf.add_argument("section")
    sf.add_argument("key")
    sf.add_argument("value")
    return p


def _dispatch(a) -> dict:
    d = a.data_dir
    if a.cmd == "setup-check":
        return check.run(d)
    if a.cmd == "pair":
        return pair.new_code(d, a.bot) if a.new else pair.reset(d)
    if a.cmd == "resume":
        if a.sub == "import":
            return resume.import_resume(d, a.path, a.version)
        return tailor.outline(d) if a.sub == "outline" else tailor.bank_status(d) if a.sub == "bank" else resume.remove_version(d, a.name)
    if a.cmd == "resume-check":
        return tailor.resume_check(d)
    if a.cmd == "tailor":
        return tailor.tailor(d, a.job_id, a.fallback)
    if a.cmd == "cover-letter":
        return tailor.cover_letter(d, a.job_id)
    if a.cmd == "fetch":
        return fetch.fetch(d, a.job_id)
    if a.cmd == "canary":
        return canary.run(a.live)
    if a.cmd == "resolve":
        return resolve.resolve(d, a.job_id)
    if a.cmd == "inspect":
        return fetch.inspect_job(d, a.job_id)
    if a.cmd == "fill":
        return fill.fill_job(d, a.job_id, a.dry_run)
    if a.cmd == "submit":
        return submit.run(d, a.job_id)
    if a.cmd == "llm":
        extra = json.loads(a.extra or "{}")
        if not isinstance(extra, dict):
            return {"ok": False, "code": "bad_extra", "error": "--extra must be a JSON object"}
        return llm.build_input(d, a.name, a.job, extra) if a.op == "input" else llm.accept(d, a.name, a.job, a.file or "", extra)
    if a.cmd == "plan":
        return formplan.build(d, a.job_id)
    if a.cmd == "bench":
        return bench.screen(Path(a.data), a.llm)
    if a.cmd == "maintain":
        return maintain.run(d)
    if a.cmd == "repair":
        return repair.run(d, a.op, a.repair_id)
    if a.cmd == "login":
        return {"ok": True, "sites": accounts.status(d)} if a.site == "status" else accounts.login(d, a.site)
    if a.cmd == "credentials":
        return accounts.credentials_set(a.site) if a.op == "set" else accounts.credentials_delete(a.site)
    if a.cmd == "job":
        if a.sub == "new":
            return store.new_job(d, a.url, a.source)
        if a.sub == "get":
            return store.get_job(d, a.job_id)
        if a.sub == "set-status":
            return store.set_status(d, a.job_id, a.status, a.detail)
        return {"ok": True, "jobs": store.list_jobs(d, a.status)}
    if a.cmd == "discover":
        return ats_api.poll(d)
    if a.cmd == "feedback":
        return feedback.summary(d)
    if a.cmd == "coverage":
        return {"ok": True, **review.coverage(d, a.job_id)}
    if a.cmd == "boards":
        if a.sub == "check":
            return boards.check(a.slug, a.ats)
        if a.sub == "remove":
            return boards.remove(d, a.ats, a.slugs)
        return boards.add(d, a.ats, a.slugs) if a.sub == "add" else {"ok": True, "boards": boards.load_boards(d)}
    if a.cmd == "review":
        return review.build(d, a.job_id) if a.sub == "build" else review.hash_(d, a.job_id)
    if a.cmd == "log":
        return log.upsert(d, a.job_id) if a.sub == "upsert" else log.export(d) if a.sub == "export" else log.outcome(d, a.job_id, a.value)
    if a.sub == "write-draft":
        return profile.write_draft(d, a.file)
    if a.sub == "set-field":
        return profile.set_field(d, a.section, a.key, a.value)
    if a.sub == "show":
        return profile.show(d, a.section)
    if a.op == "list":
        return profile.answer_list(d, a.include_job)
    if a.op == "get":
        return profile.answer_get(d, a.key)
    if a.op == "set":
        return profile.answer_set(d, a.key, a.question, a.value, a.scope, a.job, a.sensitive)
    return profile.answer_delete(d, a.key)


def main(argv=None) -> int:
    a = _parser().parse_args(argv)
    exc = None
    try:
        res = _dispatch(a)
    except (profile.ProfileError, resume.ResumeError, DocError, store.JobError, safety.SafetyError, repair.RepairError) as e:
        exc, res = e, {"ok": False, "code": e.code, "error": str(e)}
    except Exception as e:  # noqa: BLE001 - contract: always one JSON object on stdout
        exc, res = e, {"ok": False, "code": "internal", "error": type(e).__name__}
    if not res.get("ok"):
        errlog.record(a.data_dir, a.cmd, str(res.get("code", "?")), exc)
    print(json.dumps(res))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
