"""Live guide model checks (POST /practice/{id}/check).

The browser decides progress from DOM events first. It only calls this when that isn't conclusive:
  trigger "ambiguous"  the target element couldn't be found / matched
  trigger "idle"       no progress for guide_idle_seconds
  trigger "off_track"  the learner clicked something that matches no step
We ask PRACTICE_PROVIDER (default clef-flash) three questions and return the raw answers; the browser applies
thresholds from thresholds.json (also returned here so both sides agree).

Learner state arrives sensitive-free (page-state summaries never contain sensitive values). Images: the step's
recorded before/after frames, already masked at record time. The learner's screen is not captured.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from .judge import THRESHOLDS, _element_summary
from .providers import DecisionProvider, ProviderError, get_provider

TRIGGERS = {"ambiguous", "idle", "off_track"}
_last_call: dict[str, float] = {}  # per recording, process-local rate limit


class GuideCheckError(Exception):
    def __init__(self, status: int, msg: str):
        super().__init__(msg)
        self.status = status


def _clip(v: Any, n: int = 80) -> Any:
    return v[:n] if isinstance(v, str) else v


def sanitize_learner(learner: dict) -> dict:
    """Keep only the fields we expect, clipped. Page state is produced by the recorder (sensitive-free)."""
    ps = learner.get("page_state") or {}
    page_state = {
        "path": _clip(learner.get("path"), 200),
        "title": _clip(ps.get("title")),
        "headings": [_clip(h) for h in (ps.get("headings") or [])[:8]],
        "buttons": [_clip(b) for b in (ps.get("buttons") or [])[:20]],
        "fields": [{"label": _clip(f.get("label"), 60), "filled": bool(f.get("filled"))} for f in (ps.get("fields") or [])[:30]
                   if isinstance(f, dict)],
        "dialog": _clip(ps.get("dialog")),
        "status_texts": [_clip(t) for t in (ps.get("status_texts") or [])[:5]],
    }
    recent = []
    for a in (learner.get("recent_actions") or [])[-8:]:
        if isinstance(a, dict):
            recent.append({"type": _clip(a.get("type"), 20), "element": _clip(a.get("element"), 60), "seconds_ago": a.get("seconds_ago")})
    return {
        "page": page_state,
        "seconds_on_step": learner.get("seconds_on_step"),
        "wrong_attempts": learner.get("wrong_attempts"),
        "recent_actions": recent,
    }


def guide_questions(kept: list[dict], step: dict) -> dict:
    n = step["number"]
    criteria = {f"step_{s['number']}": (s.get("title") or s["action"])[:80] for s in kept}
    criteria["off_track"] = "Doing something unrelated to this workflow"
    return {
        "step_done": {
            "type": "noul",
            "instructions": (
                f'Has the learner already completed step {n}: "{step.get("title")}" ({step.get("narration")})? '
                "Image 1 shows the screen before this step and image 2 right after it, as originally recorded; "
                "compare with the learner's current page state."
            ),
        },
        "stuck": {
            "type": "noul",
            "instructions": "Does the learner seem stuck or confused (no progress, repeated wrong clicks, wrong page)?",
        },
        "current_step": {
            "type": "choice",
            "instructions": "Which step of the workflow is the learner on right now?",
            "criteria": criteria,
        },
    }


def guide_state(steps_doc: dict, kept: list[dict], step: dict, learner: dict, trigger: str) -> dict:
    return {
        "workflow": (steps_doc.get("workflow") or {}).get("title"),
        "trigger": trigger,
        "expected_step": {
            "number": step["number"],
            "of": len(kept),
            "title": step.get("title"),
            "hint": step.get("narration"),
            "action": step["action"],
            "element": _element_summary(step.get("target")),
            "page_headings_before": (step.get("before_state") or {}).get("headings"),
            "page_headings_after": (step.get("after_state") or {}).get("headings"),
        },
        "learner": learner,
    }


def _log(rec_dir: Path, entry: dict) -> None:
    with (rec_dir / "decisions.jsonl").open("a") as f:
        f.write(json.dumps(entry) + "\n")


async def check(rec_dir: Path, body: dict, provider: DecisionProvider | None = None) -> dict:
    trigger = body.get("trigger")
    if trigger not in TRIGGERS:
        raise GuideCheckError(400, f"trigger must be one of {sorted(TRIGGERS)}")
    p = rec_dir / "steps.json"
    if not p.is_file():
        raise GuideCheckError(404, "steps not ready")
    doc = json.loads(p.read_text())
    kept = [s for s in doc["steps"] if (s.get("decision") or {}).get("keep")]
    step = next((s for s in kept if s.get("number") == body.get("step_number")), None)
    if step is None:
        raise GuideCheckError(400, "unknown step_number")

    min_gap = float(THRESHOLDS["guide_min_seconds_between_model_calls"])
    now = time.monotonic()
    last = _last_call.get(rec_dir.name)
    if last is not None and now - last < min_gap:
        raise GuideCheckError(429, f"at most one check every {min_gap:g}s")
    _last_call[rec_dir.name] = now

    learner = sanitize_learner(body.get("learner") or {})
    own = provider is None
    if provider is None:
        try:
            provider = get_provider(os.environ.get("PRACTICE_PROVIDER", "clef-flash"))
        except ProviderError as e:
            raise GuideCheckError(503, f"no guide model available: {e}")
    images = [rec_dir / n for n in ((step.get("frames") or {}).get("before"), (step.get("frames") or {}).get("after"))
              if n and (rec_dir / n).is_file()]
    questions = guide_questions(kept, step)
    state = guide_state(doc, kept, step, learner, trigger)
    try:
        d = await provider.evaluate(state, questions, images if provider.supports_images else None)
    except ProviderError as e:
        _log(rec_dir, {"ts": time.time(), "trigger": f"guide_{trigger}", "step_number": step["number"],
                       "provider": provider.name, "model": provider.model, "error": str(e)})
        raise GuideCheckError(502, str(e))
    finally:
        if own:
            await provider.aclose()
    _log(rec_dir, {"ts": time.time(), "trigger": f"guide_{trigger}", "step_number": step["number"],
                   "provider": d.provider, "model": d.model, "latency_ms": d.latency_ms, "usage": d.usage,
                   "images": len(images), "answers": d.answers})
    return {
        "step_number": step["number"],
        "trigger": trigger,
        "provider": d.provider,
        "model": d.model,
        "latency_ms": d.latency_ms,
        "answers": d.answers,
        "thresholds": {
            "step_done": THRESHOLDS["guide_step_done_at_least"],
            "stuck": THRESHOLDS["guide_stuck_above"],
            "idle_seconds": THRESHOLDS["guide_idle_seconds"],
            "min_seconds_between_calls": min_gap,
        },
    }
