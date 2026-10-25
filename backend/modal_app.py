"""ShowMe backend on Modal.

    cd backend
    modal deploy modal_app.py        # web URL: https://<workspace>--showme-api.modal.run

Pieces:
  - web          FastAPI app (same code as local) behind @modal.asgi_app
  - build_steps  segment → Clef judging → steps.json (what the live guide follows)
  - clef_check   one tiny real Clef call to verify keys:  modal run modal_app.py::clef_check
All share one Volume ("showme-data") mounted at /data. Secrets come from the Modal secret "showme".
No video is uploaded, stored or rendered.
"""

from __future__ import annotations

from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
DATA = "/data"

app = modal.App("showme")
volume = modal.Volume.from_name("showme-data", create_if_missing=True)
secrets = [modal.Secret.from_name("showme")]

image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install("fastapi[standard]>=0.115", "python-multipart>=0.0.9", "httpx>=0.27")
    .env({"SHOWME_DATA_DIR": DATA})
    # add_local_dir (not add_local_python_source): the package also ships thresholds.json
    .add_local_dir(HERE / "showme_backend", "/root/showme_backend", ignore=["__pycache__"])
)


@app.function(image=image, volumes={DATA: volume}, secrets=secrets, cpu=1.0, memory=1024, timeout=600)
def build_steps(rec_id: str) -> None:
    from showme_backend.config import recording_dir
    from showme_backend.pipeline import step_steps

    volume.reload()
    try:
        step_steps(recording_dir(rec_id))
    finally:
        volume.commit()


@app.function(image=image, secrets=secrets, timeout=120)
def clef_check(model: str = "clef") -> dict:
    """One tiny real Clef call to confirm keys + request/response format."""
    import asyncio

    from showme_backend.providers import ClefProvider

    async def go():
        p = ClefProvider(model)
        try:
            d = await p.evaluate(
                {"ticket": "The Complete check-in button does nothing when I click it."},
                {
                    "is_bug": {"type": "noul", "instructions": "Does this describe a software bug?"},
                    "area": {"type": "choice", "instructions": "Which area is affected?",
                             "criteria": {"check_in": "Patient check-in", "vitals": "Recording vitals", "other": None}},
                    "severity": {"type": "score", "instructions": "How severe is it?",
                                 "criteria": ["Cosmetic", "Annoying", "Blocks the workflow"]},
                },
            )
            return {"model": d.model, "latency_ms": d.latency_ms, "usage": d.usage, "answers": d.answers}
        finally:
            await p.aclose()

    out = asyncio.run(go())
    print(out)
    return out


@app.function(image=image, volumes={DATA: volume}, secrets=secrets, timeout=600, max_containers=4)
@modal.concurrent(max_inputs=20)
@modal.asgi_app(label="showme-api")
def web():
    from showme_backend import main

    main.hooks.before_read = volume.reload
    main.hooks.after_write = volume.commit
    main.hooks.process = lambda rec_id: build_steps.spawn(rec_id)
    return main.app
