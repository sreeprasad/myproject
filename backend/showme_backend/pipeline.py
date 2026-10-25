"""Processing steps after upload. Each step is a plain function of the recording dir so it can run
locally (BackgroundTasks) or as a Modal function (see backend/modal_app.py).

Milestone 2: normalize → render:debug. Later milestones insert segment → judge → text → render tutorial.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from .config import REPO_ROOT
from .normalize import normalize
from .status import write_status


def video_dir() -> Path:
    return Path(os.environ.get("SHOWME_VIDEO_DIR", REPO_ROOT / "video"))


def step_normalize(d: Path) -> bool:
    write_status(d, "normalizing")
    try:
        t = normalize(d)
    except Exception as e:  # noqa: BLE001 — surface any failure to the UI
        write_status(d, "error", error=f"normalize: {e}")
        return False
    write_status(d, "normalized", output=t["output"], duration_ms=t.get("duration_ms"))
    return True


def step_render_debug(d: Path) -> bool:
    vdir = video_dir()
    node = shutil.which("node")
    script = vdir / "scripts" / "render.mjs"
    if not node or not script.exists() or not (vdir / "node_modules").exists():
        # Not fatal: the recording is normalized; render:debug can be run by hand.
        write_status(d, "normalized", note="render:debug skipped (video/ not installed here)")
        return False
    write_status(d, "rendering_debug")
    env = {**os.environ, "SHOWME_DATA_DIR": str(d.parent)}
    proc = subprocess.run([node, str(script), "--debug", d.name], cwd=vdir, env=env, capture_output=True, text=True)
    (d / "render_debug.log").write_text(proc.stdout + "\n--- stderr ---\n" + proc.stderr)
    if proc.returncode != 0 or not (d / "debug.mp4").exists():
        tail = (proc.stderr or proc.stdout).strip().splitlines()[-3:]
        write_status(d, "error", error="render:debug failed: " + " | ".join(tail))
        return False
    write_status(d, "debug_ready", debug_video="debug.mp4")
    return True


def run_all(d: Path) -> None:
    if step_normalize(d):
        step_render_debug(d)
