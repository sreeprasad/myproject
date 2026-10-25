"""JUDGE: ask a DecisionProvider about every candidate step, apply thresholds, write steps.json.

Nothing sensitive goes to the provider: page states are already sensitive-free, values of sensitive fields are
never recorded, and frames were masked in the browser before upload. No video exists anywhere.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .providers import Decision, DecisionProvider, ProviderError, get_provider
from .segment import segment

THRESHOLDS: dict = json.loads((Path(__file__).with_name("thresholds.json")).read_text())

STEP_TYPES = {
    "click": "Clicking a button, link, tab or row",
    "type": "Typing text into a field",
    "select": "Choosing an option from a dropdown",
    "toggle": "Checking or unchecking a checkbox, radio or switch",
    "navigate": "Moving to another page (link, back/forward, address bar)",
    "scroll": "Scrolling to bring something into view",
    "wait": "Waiting for the app to load or respond",
}

STEP_QUESTIONS: dict[str, dict] = {
    "step_type": {
        "type": "choice",
        "instructions": "Which kind of user action is this step?",
        "criteria": STEP_TYPES,
    },
    "meaningful": {
        "type": "noul",
        "instructions": (
            "Is this a deliberate step a learner must perform to complete the workflow "
            "(not a misclick, an accidental click on empty space, an immediately undone action, or idle time)?"
        ),
    },
    "importance": {
        "type": "score",
        "instructions": "How important is this step for someone learning the workflow?",
        "criteria": [
            "Trivial: could be skipped without affecting the outcome",
            "Helpful: makes the workflow smoother but is not required",
            "Essential: the workflow fails or is incomplete without it",
        ],
    },
}


def _element_summary(target: dict | None) -> dict | None:
    if not target:
        return None
    ids = target.get("identifiers") or {}
    out = {
        "tag": target.get("tag"),
        "role": ids.get("role"),
        "name": ids.get("name"),
        "label": target.get("label"),
        "text": target.get("text"),
        "testid": ids.get("testid"),
        "sensitive_field": bool(target.get("sensitive")),
    }
    return {k: v for k, v in out.items() if v not in (None, "")}


def describe_step(step: dict) -> str:
    """One-line human summary (also used as 'previous step' context)."""
    el = _element_summary(step.get("target")) or {}
    name = el.get("label") or el.get("name") or el.get("text") or el.get("testid") or "element"
    a = step["action"]
    if a == "type":
        return f'typed into "{name}"' + (" and pressed Enter" if step.get("submitted") else "")
    if a == "select":
        return f'chose "{step.get("value")}" in "{name}"' if step.get("value") else f'chose an option in "{name}"'
    if a == "toggle":
        return f'{"checked" if step.get("value") else "unchecked"} "{name}"'
    if a == "navigate":
        return f'navigated to {step.get("navigates_to")}'
    s = f'clicked "{name}"'
    return s + (f' → {step["navigates_to"]}' if step.get("navigates_to") else "")


def step_state(step: dict, total: int, prev: dict | None) -> dict:
    """Sensitive-free JSON state for the provider."""
    return {
        "app": "web app workflow recording",
        "step_index": step["index"] + 1,
        "total_steps": total,
        "action": {
            "kind": step["action"],
            "element": _element_summary(step.get("target")),
            "value": None if step.get("value_masked") or (step.get("target") or {}).get("sensitive") else step.get("value"),
            "value_hidden": bool(step.get("value_masked")),
            "url": step.get("url"),
            "navigates_to": step.get("navigates_to"),
            "pressed_enter": step.get("submitted", False),
            "duration_ms": round(step["t_end"] - step["t_start"]),
            "scrolls_before": step.get("scrolls_before", 0),
        },
        "page_before": step.get("before_state"),
        "page_after": step.get("after_state"),
        "previous_step": describe_step(prev) if prev else None,
        "images": "image 1 = screen just before the action, image 2 = ~0.6 s after (sensitive fields are covered)",
    }


def decide(step: dict, answers: dict | None) -> dict:
    """Apply thresholds. With no answers (no provider), keep the step and use the recorded action."""
    t = THRESHOLDS
    if not answers:
        return {"keep": True, "drop_reason": None, "importance": None, "step_type": step["action"], "judged": False}
    meaningful = answers["meaningful"]["noul"]
    keep = meaningful >= t["cut_if_meaningful_below"]
    return {
        "keep": keep,
        "drop_reason": None if keep else f"meaningful={meaningful:.2f} < {t['cut_if_meaningful_below']}",
        "importance": round(answers["importance"]["score"], 3),
        "step_type": answers["step_type"]["choice"],
        "judged": True,
    }


def _log(rec_dir: Path, entry: dict) -> None:
    with (rec_dir / "decisions.jsonl").open("a") as f:
        f.write(json.dumps(entry) + "\n")


async def judge_steps(rec_dir: Path, steps: list[dict], provider: DecisionProvider | None, concurrency: int = 4) -> list[dict]:
    sem = asyncio.Semaphore(concurrency)
    total = len(steps)

    async def one(i: int, step: dict) -> dict:
        prev = steps[i - 1] if i > 0 else None
        images: list[Path] = []
        for k in ("before", "after"):
            name = (step.get("frames") or {}).get(k)
            if name and (rec_dir / name).is_file():
                images.append(rec_dir / name)
        if provider is None:
            return {**step, "judge": None, "decision": decide(step, None)}
        state = step_state(step, total, prev)
        async with sem:
            try:
                d: Decision = await provider.evaluate(state, STEP_QUESTIONS, images if provider.supports_images else None)
            except ProviderError as e:
                _log(rec_dir, {"ts": time.time(), "trigger": "judge_step", "step_id": step["id"], "provider": provider.name,
                               "model": provider.model, "error": str(e)})
                return {**step, "judge": {"error": str(e)}, "decision": decide(step, None)}
        _log(rec_dir, {"ts": time.time(), "trigger": "judge_step", "step_id": step["id"], "provider": d.provider,
                       "model": d.model, "latency_ms": d.latency_ms, "usage": d.usage, "images": len(images),
                       "answers": d.answers})
        return {**step, "judge": {"provider": d.provider, "model": d.model, "answers": d.answers}, "decision": decide(step, d.answers)}

    return list(await asyncio.gather(*(one(i, s) for i, s in enumerate(steps))))


def resolve_provider(name: str | None = None) -> tuple[DecisionProvider | None, str | None]:
    """Provider from DECISION_PROVIDER; (None, reason) when keys are missing so the pipeline still completes."""
    name = name or os.environ.get("DECISION_PROVIDER", "clef")
    try:
        return get_provider(name), None
    except ProviderError as e:
        return None, str(e)


async def build_steps(rec_dir: Path, provider: DecisionProvider | None = None, provider_note: str | None = None,
                      *, text_client=None, write_words: bool = True) -> dict:
    from .text import write_text

    events = json.loads((rec_dir / "events.json").read_text())
    candidates = segment(events)
    judged = await judge_steps(rec_dir, candidates, provider)
    for s in judged:
        s.setdefault("title", None)
        s.setdefault("narration", None)
    kept = [s for s in judged if s["decision"]["keep"]]
    for n, s in enumerate(kept, start=1):
        s["number"] = n  # 1-based position among kept steps (what the learner sees)
    words = await write_text(rec_dir, kept, client=text_client) if write_words else None
    doc = {
        "schema": "showme.steps/1",
        "recording_id": rec_dir.name,
        "generated_at": time.time(),
        "provider": {"name": provider.name, "model": provider.model} if provider else None,
        "provider_note": provider_note,
        "workflow": {
            "title": words["title"] if words else None,
            "summary": words["summary"] if words else None,
            "text_provider": words["text_provider"] if words else None,
            "text_model": words["text_model"] if words else None,
            "text_errors": words["text_errors"] if words else [],
        },
        "start_url": candidates[0]["url"] if candidates else None,
        "start_path": urlparse(candidates[0]["url"]).path if candidates and candidates[0].get("url") else None,
        "counts": {"events": len(events), "candidates": len(candidates), "kept": len(kept)},
        "steps": judged,
    }
    (rec_dir / "steps.json").write_text(json.dumps(doc, indent=1))
    return doc
