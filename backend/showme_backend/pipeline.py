"""Processing after upload: segment → judge → steps.json. Runs in-process locally (BackgroundTasks) or as the
Modal function build_steps (see backend/modal_app.py). Milestone 4 adds TEXT (titles + hints) after judging.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from .judge import build_steps, resolve_provider
from .status import write_status


def step_steps(d: Path, provider_name: str | None = None) -> bool:
    """Completes even without a provider (steps kept, judged=false)."""
    write_status(d, "building_steps")
    provider, note = resolve_provider(provider_name)

    async def _run() -> dict:
        try:
            return await build_steps(d, provider, note)
        finally:
            if provider is not None:
                await provider.aclose()

    try:
        doc = asyncio.run(_run())
    except Exception as e:  # noqa: BLE001 — surface any failure to the UI
        write_status(d, "error", error=f"steps: {e}")
        return False
    write_status(d, "steps_ready", counts=doc["counts"], provider=doc["provider"], note=note)
    return True


run_all = step_steps
