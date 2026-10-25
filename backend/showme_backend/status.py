import json
import time
from pathlib import Path

# uploaded → normalizing → normalized → rendering_debug → debug_ready   (any step can → error)


def write_status(d: Path, state: str, **extra) -> None:
    prev = read_status(d)
    keep = {k: v for k, v in prev.items() if k not in ("state", "updated", "error")}
    (d / "status.json").write_text(json.dumps({**keep, "state": state, "updated": time.time(), **extra}))


def read_status(d: Path) -> dict:
    p = d / "status.json"
    try:
        return json.loads(p.read_text()) if p.exists() else {"state": "unknown"}
    except json.JSONDecodeError:
        return {"state": "unknown"}
