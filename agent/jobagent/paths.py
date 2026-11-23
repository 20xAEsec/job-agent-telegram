import json
import os
from pathlib import Path


def default_data_dir() -> Path:
    # agent/jobagent/paths.py -> repo root / data
    return Path(__file__).resolve().parents[2] / "data"


def atomic_write_json(path: Path, obj) -> None:
    """Write <file>.tmp then rename, so readers never see a half-written file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def atomic_write_text(path: Path, text: str) -> None:
    """Like atomic_write_json but byte-exact: no newline translation (profile.md round-trips)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(text.encode("utf-8"))
    os.replace(tmp, path)
