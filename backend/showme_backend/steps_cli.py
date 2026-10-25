"""Build and print steps for a recording.

    python -m showme_backend.steps_cli <recording-id>                 # provider from DECISION_PROVIDER (default clef)
    python -m showme_backend.steps_cli <recording-id> --provider mock
    python -m showme_backend.steps_cli --events path/to/events.json   # segmentation only, any file
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from .config import recording_dir
from .judge import build_steps, describe_step, resolve_provider
from .segment import segment


def _table(steps: list[dict]) -> str:
    rows = []
    for s in steps:
        d = s.get("decision") or {}
        keep = "" if not d else ("keep" if d.get("keep") else "DROP")
        ans = ((s.get("judge") or {}).get("answers")) or {}
        m = ans.get("meaningful", {}).get("noul")
        imp = d.get("importance")
        rows.append(
            f"{s['id']}  {s['action']:<8} {keep:<4}  "
            f"{'' if m is None else f'meaningful={m:.2f} '}{'' if imp is None else f'importance={imp:.2f} '}"
            f"{describe_step(s)}"
        )
    return "\n".join(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("recording_id", nargs="?")
    ap.add_argument("--provider", default=None, help="clef | clef-flash | mock (default: $DECISION_PROVIDER or clef)")
    ap.add_argument("--events", type=Path, help="segment a standalone events.json (no judging)")
    a = ap.parse_args()

    if a.events:
        print(_table(segment(json.loads(a.events.read_text()))))
        return
    if not a.recording_id:
        ap.error("recording_id or --events is required")
    provider, note = resolve_provider(a.provider)
    if note:
        print(f"(no provider: {note}; steps will be unjudged)")

    async def run():
        try:
            return await build_steps(recording_dir(a.recording_id), provider, note)
        finally:
            if provider:
                await provider.aclose()

    doc = asyncio.run(run())
    print(_table(doc["steps"]))
    print(f"\n{doc['counts']} → {recording_dir(a.recording_id) / 'steps.json'}")


if __name__ == "__main__":
    main()
