import json
import time
from pathlib import Path

# uploaded → building_steps → steps_ready   (or → error)


def write_status(d: Path, state: str, **extra) -> None:
    (d / "status.json").write_text(json.dumps({"state": state, "updated": time.time(), **extra}))


def read_status(d: Path) -> dict:
    p = d / "status.json"
    try:
        return json.loads(p.read_text()) if p.exists() else {"state": "unknown"}
    except json.JSONDecodeError:
        return {"state": "unknown"}
