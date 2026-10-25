"""ShowMe backend (FastAPI). Runs locally (uvicorn showme_backend.main:app --port 8000) or on Modal
(backend/modal_app.py wraps the same app and swaps in Modal storage/processing hooks).
"""

from __future__ import annotations

import hmac
import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Callable

from fastapi import BackgroundTasks, Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .config import data_dir, recording_dir
from .pipeline import run_all
from .status import read_status, write_status

# ---- hooks (Modal replaces these; local defaults below) -------------------------------------------
Hook = Callable[[], None]


class Hooks:
    # Called before reading anything another worker may have written (Modal: volume.reload()).
    before_read: Hook = staticmethod(lambda: None)
    # Called after writing files other workers must see (Modal: volume.commit()).
    after_write: Hook = staticmethod(lambda: None)
    # Start processing a recording. None → run in-process via BackgroundTasks.
    process: Callable[[str], None] | None = None


hooks = Hooks()

# ---- app -----------------------------------------------------------------------------------------
DEFAULT_ORIGINS = r"http://(localhost|127\.0\.0\.1)(:\d+)?|https://[a-z0-9-]+\.vercel\.app|chrome-extension://[a-p]{32}"
app = FastAPI(title="ShowMe backend")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=f"^({os.environ.get('SHOWME_ALLOWED_ORIGINS', DEFAULT_ORIGINS)})$",
    allow_methods=["*"],
    allow_headers=["*"],
)

FRAME_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}\.jpg$")
SERVABLE = re.compile(r"^(debug\.mp4|tutorial\.mp4|normalized\.mp4|[a-z_]+\.json|frames/[A-Za-z0-9_-]{1,64}\.jpg)$")
MAX_VIDEO_BYTES = 1_500 * 1024 * 1024


def require_token(
    x_showme_token: str | None = Header(default=None),
    token: str | None = Query(default=None),
) -> None:
    """If SHOWME_API_TOKEN is set, every request must carry it (header, or ?token= for <video> links)."""
    expected = os.environ.get("SHOWME_API_TOKEN")
    if not expected:
        return
    got = x_showme_token or token or ""
    if not hmac.compare_digest(got, expected):
        raise HTTPException(401, "missing or wrong token")


def _dir_or_404(rec_id: str) -> Path:
    try:
        d = recording_dir(rec_id)
    except ValueError:
        raise HTTPException(400, "bad id")
    hooks.before_read()
    if not d.exists():
        raise HTTPException(404, "recording not found")
    return d


async def _save(upload: UploadFile, dst: Path, limit: int) -> int:
    size = 0
    with dst.open("wb") as f:
        while chunk := await upload.read(1 << 20):
            size += len(chunk)
            if size > limit:
                raise HTTPException(413, f"{upload.filename} too large")
            f.write(chunk)
    return size


def _start_processing(background: BackgroundTasks, d: Path) -> None:
    if hooks.process is not None:
        hooks.process(d.name)
    else:
        background.add_task(run_all, d)


@app.post("/recordings", dependencies=[Depends(require_token)])
async def create_recording(
    background: BackgroundTasks,
    video: UploadFile = File(...),
    events: UploadFile = File(...),
    sensitive_tracks: UploadFile = File(...),
    capture: UploadFile = File(...),
    frames: list[UploadFile] = File(default=[]),
):
    rec_id = time.strftime("rec-%Y%m%d-%H%M%S-") + secrets.token_hex(6)
    d = recording_dir(rec_id)
    (d / "frames").mkdir(parents=True)
    await _save(video, d / "recording.webm", MAX_VIDEO_BYTES)
    for up, name in ((events, "events.json"), (sensitive_tracks, "sensitive_tracks.json"), (capture, "capture.json")):
        await _save(up, d / name, 200 * 1024 * 1024)
        try:
            json.loads((d / name).read_text())
        except json.JSONDecodeError:
            raise HTTPException(400, f"{name} is not valid JSON")
    saved = 0
    for fr in frames:
        name = Path(fr.filename or "").name
        if not FRAME_NAME.match(name):
            raise HTTPException(400, f"bad frame name: {fr.filename!r}")
        await _save(fr, d / "frames" / name, 8 * 1024 * 1024)
        saved += 1
    write_status(d, "uploaded", frames=saved)
    hooks.after_write()
    _start_processing(background, d)
    return {"id": rec_id, "frames": saved}


@app.get("/recordings", dependencies=[Depends(require_token)])
def list_recordings():
    hooks.before_read()
    out = []
    for d in sorted(data_dir().iterdir(), reverse=True):
        if d.is_dir() and (d / "recording.webm").exists():
            out.append({"id": d.name, **read_status(d)})
    return out


@app.get("/recordings/{rec_id}", dependencies=[Depends(require_token)])
def get_recording(rec_id: str):
    d = _dir_or_404(rec_id)
    files = sorted(str(p.relative_to(d)) for p in d.rglob("*") if p.is_file())
    capture = json.loads((d / "capture.json").read_text()) if (d / "capture.json").exists() else None
    return {"id": rec_id, "status": read_status(d), "files": files, "capture": capture}


@app.get("/recordings/{rec_id}/status", dependencies=[Depends(require_token)])
def get_status(rec_id: str):
    return read_status(_dir_or_404(rec_id))


@app.get("/recordings/{rec_id}/files/{path:path}", dependencies=[Depends(require_token)])
def get_file(rec_id: str, path: str):
    if not SERVABLE.match(path):
        raise HTTPException(404, "not servable")
    d = _dir_or_404(rec_id)
    p = d / path
    if not p.is_file():
        raise HTTPException(404, "file not found")
    return FileResponse(p)


@app.post("/recordings/{rec_id}/process", dependencies=[Depends(require_token)])
def process(rec_id: str, background: BackgroundTasks):
    d = _dir_or_404(rec_id)
    _start_processing(background, d)
    return {"id": rec_id, "queued": True}


@app.get("/health")
def health():
    return {"ok": True}
