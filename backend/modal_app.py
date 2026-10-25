"""ShowMe backend on Modal.

    cd backend
    modal deploy modal_app.py        # prints the web URL → set it as NEXT_PUBLIC_SHOWME_BACKEND on Vercel

Pieces:
  - web          FastAPI app (same code as local) behind @modal.asgi_app
  - normalize    ffmpeg → normalized.mp4 + transform.json, then spawns render_debug
  - render_debug Remotion (Node 22 + headless Chrome) → debug.mp4
All share one Volume ("showme-data") mounted at /data. Secrets come from the Modal secret "showme".
"""

from __future__ import annotations

from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DATA = "/data"

app = modal.App("showme")
volume = modal.Volume.from_name("showme-data", create_if_missing=True)
secrets = [modal.Secret.from_name("showme")]

# --- images --------------------------------------------------------------------------------------
api_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .uv_pip_install("fastapi[standard]>=0.115", "python-multipart>=0.0.9")
    .env({"SHOWME_DATA_DIR": DATA, "SHOWME_VIDEO_DIR": "/nonexistent"})
    .add_local_python_source("showme_backend")
)

# Remotion's headless Chrome needs these shared libraries on Debian.
CHROME_DEPS = [
    "libnss3", "libdbus-1-3", "libatk1.0-0", "libgbm-dev", "libasound2", "libxrandr2", "libxkbcommon-dev",
    "libxfixes3", "libxcomposite1", "libxdamage1", "libatk-bridge2.0-0", "libpango-1.0-0", "libcairo2", "libcups2",
    "fonts-liberation", "fonts-noto-color-emoji",
]
NODE_IGNORE = ["node_modules", "**/node_modules", ".next", "out", "*.tsbuildinfo"]

render_image = (
    modal.Image.from_registry("node:22-bookworm-slim", add_python="3.12")
    .apt_install("ffmpeg", *CHROME_DEPS)
    .add_local_dir(REPO / "recorder", "/app/recorder", copy=True, ignore=NODE_IGNORE)
    .add_local_dir(REPO / "video", "/app/video", copy=True, ignore=NODE_IGNORE)
    .run_commands(
        "cd /app/recorder && npm ci --no-audit --no-fund",
        "cd /app/video && npm ci --no-audit --no-fund",
        "cd /app/video && npx remotion browser ensure",
    )
    .env({"SHOWME_DATA_DIR": DATA, "SHOWME_VIDEO_DIR": "/app/video"})
    .add_local_python_source("showme_backend")
)


# --- processing functions --------------------------------------------------------------------------
@app.function(image=api_image, volumes={DATA: volume}, secrets=secrets, cpu=2.0, memory=4096, timeout=900)
def normalize(rec_id: str) -> None:
    from showme_backend.config import recording_dir
    from showme_backend.pipeline import step_normalize

    volume.reload()
    ok = step_normalize(recording_dir(rec_id))
    volume.commit()
    if ok:
        render_debug.spawn(rec_id)


@app.function(image=render_image, volumes={DATA: volume}, secrets=secrets, cpu=4.0, memory=8192, timeout=1800)
def render_debug(rec_id: str) -> None:
    from showme_backend.config import recording_dir
    from showme_backend.pipeline import step_render_debug

    volume.reload()
    try:
        step_render_debug(recording_dir(rec_id))
    finally:
        volume.commit()


# --- web endpoint ----------------------------------------------------------------------------------
@app.function(image=api_image, volumes={DATA: volume}, secrets=secrets, timeout=600, max_containers=4)
@modal.concurrent(max_inputs=20)
@modal.asgi_app(label="showme-api")
def web():
    from showme_backend import main

    main.hooks.before_read = volume.reload
    main.hooks.after_write = volume.commit
    main.hooks.process = lambda rec_id: normalize.spawn(rec_id)
    return main.app
