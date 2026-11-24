import contextlib
import json
import os
import threading
import time
from pathlib import Path


def default_data_dir() -> Path:
    # agent/jobagent/paths.py -> repo root / data
    return Path(__file__).resolve().parents[2] / "data"


@contextlib.contextmanager
def locked(path: Path, wait: float = 20.0):
    """Hold <file>.lock across a read-modify-write, so the app and Claude writing at the same moment cannot lose an update.
    A lock file left by a crashed process is taken over after 30 s."""
    lock = path.with_name(path.name + ".lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    end = time.monotonic() + wait
    while True:
        try:
            os.close(os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > 30:
                    lock.unlink(missing_ok=True)
                    continue
            except OSError:
                pass
            if time.monotonic() > end:
                raise TimeoutError(f"{path.name} is busy")
            time.sleep(0.02)
    try:
        yield
    finally:
        lock.unlink(missing_ok=True)


def _tmp(path: Path) -> Path:
    return path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")  # one temp name per writer


def atomic_write_json(path: Path, obj) -> None:
    """Write a temp file then rename, so readers never see a half-written file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _tmp(path)
    tmp.write_text(json.dumps(obj, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def atomic_write_text(path: Path, text: str) -> None:
    """Like atomic_write_json but byte-exact: no newline translation (profile.md round-trips)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _tmp(path)
    tmp.write_bytes(text.encode("utf-8"))
    os.replace(tmp, path)
