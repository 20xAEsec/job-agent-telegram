"""data/logs/agent.log: why a `jobagent` command failed. Command, code, error type and traceback frames only.
The exception text is left out on purpose: it can carry answers or posting text."""
import traceback
from datetime import datetime, timezone
from pathlib import Path

MAX_BYTES = 1_000_000  # shortcut: one rotated copy (.1), when a longer history is needed keep more


def record(data_dir: Path, cmd: str, code: str, exc: BaseException | None = None) -> None:
    try:
        lines = [f"{datetime.now(timezone.utc).isoformat(timespec='milliseconds')} {cmd} -> {code}"]
        if exc is not None:
            lines[0] += f" ({type(exc).__name__})"
            # file, line and function only: source lines can hold literal values
            lines += [f"  {Path(f.filename).name}:{f.lineno} in {f.name}" for f in traceback.extract_tb(exc.__traceback__)]
        p = data_dir / "logs" / "agent.log"
        p.parent.mkdir(parents=True, exist_ok=True)
        if p.exists() and p.stat().st_size > MAX_BYTES:
            p.replace(p.with_name(p.name + ".1"))
        with open(p, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    except Exception:  # noqa: BLE001 - logging must never break the command
        pass
