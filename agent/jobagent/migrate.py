"""jobagent migrate --from <old data folder> (v3 V1): brings a JobAgent 2.x data folder over. The user runs it once, with both
versions stopped (denied to Claude). It copies files without reading them, never writes into the old folder, and returns counts."""
import shutil
from pathlib import Path

from . import store
from .discover import eligibility
from .paths import atomic_write_json

SKIP = {"logs", "run", "tmp"}
VERSION = 4


def run(d: Path, src: Path) -> dict:
    src, d = Path(src).resolve(), d.resolve()
    if not (src / "settings.json").is_file():
        raise store.JobError("not_data", "that folder has no settings.json: point --from at the old JobAgent's data folder")
    if src == d or d.is_relative_to(src) or src.is_relative_to(d):
        raise store.JobError("same_folder", "--from must be the old install's data folder, not this one")
    jobs = d / "jobs"
    if jobs.is_dir() and any(jobs.iterdir()):
        raise store.JobError("not_empty", "this JobAgent already has jobs: migrate only works into a new data folder")
    d.mkdir(parents=True, exist_ok=True)
    staging = d / "jobs.migrating"
    # jobs go last, under a temporary name: after a failed copy the folder still counts as new, so running it again works
    items = sorted((p for p in src.iterdir() if p.name not in SKIP and p.suffix not in (".tmp", ".lock")), key=lambda p: p.name == "jobs")
    for p in items:
        try:
            if p.name == "jobs":
                shutil.rmtree(staging, ignore_errors=True)
                shutil.copytree(p, staging)
            elif p.is_dir():
                shutil.copytree(p, d / p.name, dirs_exist_ok=True, ignore=shutil.ignore_patterns("Singleton*", "*.lock", "*.tmp"))
            else:
                shutil.copy2(p, d / p.name)
        except (shutil.Error, OSError) as e:
            raise store.JobError("copy_failed", f"could not copy {p.name}: close the old JobAgent (and its browser window), then run this again") from e
    s = store._load(d / "settings.json")
    if not isinstance(s, dict):
        raise store.JobError("bad_settings", "the old settings.json could not be read")
    f = s.setdefault("filters", {})
    if not f.get("country"):
        found = eligibility.user_countries(f)  # from the locations ("San Diego, CA" -> United States)
        if len(found) == 1:
            f["country"] = found.pop()
    s["version"] = VERSION
    atomic_write_json(d / "settings.json", s)
    if staging.is_dir():
        if jobs.is_dir():
            jobs.rmdir()
        staging.rename(jobs)
    return {"ok": True, "copied": len(items), "jobs": sum(p.is_dir() for p in jobs.iterdir()) if jobs.is_dir() else 0, "country": f.get("country") or None}
