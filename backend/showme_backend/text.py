"""TEXT: one LLM call per workflow → a title (≤6 words) and a hint (≤20 words) per kept step, plus a workflow
title and one-sentence summary.

Order: Gemini Flash-Lite (structured output) → Claude, only on HTTP 429 or a parse/validation failure →
deterministic text built from the step itself (so the guide always has words to show).

Input is sensitive-free: element labels, safe values, page headings and paths. Masked values are described as
"hidden" so the model never invents them.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

GEMINI_MODEL_DEFAULT = "gemini-3.5-flash-lite"
CLAUDE_MODEL_DEFAULT = "claude-haiku-5-5"
TITLE_MAX_WORDS = 6
HINT_MAX_WORDS = 20
SUMMARY_MAX_WORDS = 30

# Gemini responseSchema (OpenAPI subset). The same shape is validated for every provider.
RESPONSE_SCHEMA: dict = {
    "type": "OBJECT",
    "properties": {
        "workflow_title": {"type": "STRING"},
        "workflow_summary": {"type": "STRING"},
        "steps": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "number": {"type": "INTEGER"},
                    "title": {"type": "STRING"},
                    "hint": {"type": "STRING"},
                },
                "required": ["number", "title", "hint"],
            },
        },
    },
    "required": ["workflow_title", "workflow_summary", "steps"],
}


class TextError(RuntimeError):
    def __init__(self, msg: str, *, retryable_elsewhere: bool):
        super().__init__(msg)
        self.retryable_elsewhere = retryable_elsewhere  # 429 / bad output → try the fallback provider


@dataclass
class TextResult:
    workflow_title: str
    workflow_summary: str
    steps: dict[int, dict]  # number → {"title", "hint"}
    provider: str
    model: str


# ---------------------------------------------------------------------------------------------------
def _path(url: str | None) -> str | None:
    return urlparse(url).path if url else None


def step_brief(step: dict) -> dict:
    """What the writer sees for one kept step. No sensitive values by construction."""
    t = step.get("target") or {}
    ids = t.get("identifiers") or {}
    after = step.get("after_state") or {}
    before = step.get("before_state") or {}
    value = None
    if step.get("value_masked") or t.get("sensitive"):
        value = "(hidden)"
    elif step.get("value") is not None:
        value = step["value"]
    brief = {
        "number": step["number"],
        "action": step["action"],
        "element_role": ids.get("role"),
        "element_label": t.get("label") or ids.get("name") or t.get("text"),
        "value": value,
        "page": (before.get("headings") or [None])[0] or _path(step.get("url")),
        "goes_to_page": (after.get("headings") or [None])[0] if step.get("navigates_to") else None,
        "pressed_enter": bool(step.get("submitted")),
        "result_message": (after.get("status_texts") or [None])[0],
        "importance": (step.get("decision") or {}).get("importance"),
    }
    return {k: v for k, v in brief.items() if v not in (None, "", False)}


def build_prompt(app_name: str, briefs: list[dict]) -> str:
    return (
        f"You write the on-screen coaching text for an interactive guide that teaches someone a workflow in the web app "
        f'"{app_name}". The guide highlights one element at a time; your text appears in a small card next to it.\n\n'
        "For EVERY step below, write:\n"
        f"- title: at most {TITLE_MAX_WORDS} words, imperative, sentence case, no trailing period "
        '(e.g. "Verify the patient\'s ID").\n'
        f"- hint: at most {HINT_MAX_WORDS} words, one sentence telling the learner exactly what to do, quoting the visible "
        'label in double quotes (e.g. Tick "ID verified" after checking their photo ID.).\n'
        f"Also write workflow_title (at most {TITLE_MAX_WORDS} words) and workflow_summary (one sentence, at most "
        f"{SUMMARY_MAX_WORDS} words).\n\n"
        "Rules: use only the labels and values given; when value is \"(hidden)\" do not invent it (say what to enter, "
        "e.g. \"the patient's name\"); do not mention steps that are not listed; keep the step numbers exactly as given; "
        "write for a new employee, friendly and plain.\n\n"
        f"Steps (JSON):\n{json.dumps(briefs, ensure_ascii=False, indent=1)}"
    )


def _words(s: str) -> int:
    return len(s.split())


def validate(data: Any, numbers: list[int]) -> tuple[str, str, dict[int, dict]]:
    """Raise TextError(retryable_elsewhere=True) on anything off-spec."""
    def bad(msg: str) -> TextError:
        return TextError(f"invalid text output: {msg}", retryable_elsewhere=True)

    if not isinstance(data, dict):
        raise bad("not an object")
    title, summary, steps = data.get("workflow_title"), data.get("workflow_summary"), data.get("steps")
    if not isinstance(title, str) or not title.strip() or _words(title) > TITLE_MAX_WORDS:
        raise bad(f"workflow_title {title!r}")
    if not isinstance(summary, str) or not summary.strip() or _words(summary) > SUMMARY_MAX_WORDS:
        raise bad("workflow_summary")
    if not isinstance(steps, list):
        raise bad("steps not a list")
    out: dict[int, dict] = {}
    for s in steps:
        if not isinstance(s, dict):
            raise bad("step not an object")
        n, t, h = s.get("number"), s.get("title"), s.get("hint")
        if not isinstance(n, int) or n not in numbers or n in out:
            raise bad(f"step number {n!r}")
        if not isinstance(t, str) or not t.strip() or _words(t) > TITLE_MAX_WORDS:
            raise bad(f"step {n} title {t!r}")
        if not isinstance(h, str) or not h.strip() or _words(h) > HINT_MAX_WORDS:
            raise bad(f"step {n} hint {h!r}")
        out[n] = {"title": t.strip().rstrip("."), "hint": h.strip()}
    if sorted(out) != sorted(numbers):
        raise bad(f"expected steps {numbers}, got {sorted(out)}")
    return title.strip().rstrip("."), summary.strip(), out


# ---------------------------------------------------------------------------------------------------
class GeminiWriter:
    name = "gemini"

    def __init__(self, client: httpx.AsyncClient, api_key: str | None = None, model: str | None = None):
        self.client = client
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY", "")
        self.model = model or os.environ.get("GEMINI_MODEL", GEMINI_MODEL_DEFAULT)
        if not self.api_key:
            raise TextError("GEMINI_API_KEY not set", retryable_elsewhere=True)

    @property
    def url(self) -> str:
        return f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent"

    def body(self, prompt: str) -> dict:
        return {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": RESPONSE_SCHEMA,
                "temperature": 0.4,
            },
        }

    async def write(self, prompt: str) -> tuple[Any, dict]:
        r = await self.client.post(self.url, json=self.body(prompt), headers={"x-goog-api-key": self.api_key})
        if r.status_code == 429:
            raise TextError("Gemini HTTP 429 (rate limited)", retryable_elsewhere=True)
        if r.status_code >= 400:
            raise TextError(f"Gemini HTTP {r.status_code}: {r.text[:300]}", retryable_elsewhere=False)
        body = r.json()
        try:
            parts = body["candidates"][0]["content"]["parts"]
            text = "".join(p.get("text", "") for p in parts)
            return json.loads(text), body.get("usageMetadata") or {}
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as e:
            raise TextError(f"Gemini output not parseable: {e!r}", retryable_elsewhere=True) from e


class ClaudeWriter:
    name = "claude"

    def __init__(self, client: httpx.AsyncClient, api_key: str | None = None, model: str | None = None):
        self.client = client
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        self.model = model or os.environ.get("ANTHROPIC_MODEL", CLAUDE_MODEL_DEFAULT)
        if not self.api_key:
            raise TextError("ANTHROPIC_API_KEY not set", retryable_elsewhere=False)

    async def write(self, prompt: str) -> tuple[Any, dict]:
        schema_hint = (
            '\n\nReply with ONLY a JSON object, no prose and no code fences, shaped like: '
            '{"workflow_title": "...", "workflow_summary": "...", "steps": [{"number": 1, "title": "...", "hint": "..."}]}'
        )
        r = await self.client.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": self.api_key, "anthropic-version": "2023-06-01"},
            json={"model": self.model, "max_tokens": 2000, "messages": [{"role": "user", "content": prompt + schema_hint}]},
        )
        if r.status_code >= 400:
            raise TextError(f"Claude HTTP {r.status_code}: {r.text[:300]}", retryable_elsewhere=False)
        body = r.json()
        try:
            text = "".join(b.get("text", "") for b in body["content"] if b.get("type") == "text").strip()
            if text.startswith("```"):
                text = text.strip("`").split("\n", 1)[1] if "\n" in text else text
            return json.loads(text), body.get("usage") or {}
        except (KeyError, TypeError, json.JSONDecodeError) as e:
            raise TextError(f"Claude output not parseable: {e!r}", retryable_elsewhere=False) from e


# ---------------------------------------------------------------------------------------------------
def fallback_text(step: dict) -> dict:
    """Plain, always-available words built from the step itself."""
    b = step_brief(step)
    label = b.get("element_label") or "the highlighted element"
    a = step["action"]
    if a == "toggle":
        verb = "Tick" if step.get("value") is not False else "Untick"
        return {"title": f'{verb} "{label}"'[:60], "hint": f'{verb} the "{label}" checkbox.'}
    if a == "select":
        v = b.get("value")
        if v and v != "(hidden)":
            return {"title": f"Choose {label}", "hint": f'Pick "{v}" in "{label}".'}
        return {"title": f"Choose {label}", "hint": f'Pick an option in "{label}".'}
    if a == "type":
        tail = " and press Enter" if step.get("submitted") else ""
        return {"title": f"Fill in {label}", "hint": f'Type into "{label}"{tail}.'}
    if a == "navigate":
        return {"title": f"Go to {b.get('goes_to_page') or 'the next page'}", "hint": "Open the page shown in the guide."}
    dest = b.get("goes_to_page")
    return {"title": f"Click {label}", "hint": f'Click "{label}"' + (f" to open {dest}." if dest else ".")}


def _log(rec_dir: Path, entry: dict) -> None:
    with (rec_dir / "decisions.jsonl").open("a") as f:
        f.write(json.dumps(entry) + "\n")


async def write_text(rec_dir: Path, kept: list[dict], app_name: str = "LumenCare",
                     client: httpx.AsyncClient | None = None) -> dict:
    """Fills title/narration on kept steps in place and returns the workflow text + provenance."""
    numbers = [s["number"] for s in kept]
    for s in kept:  # deterministic baseline first; providers overwrite on success
        fb = fallback_text(s)
        s["title"], s["narration"] = fb["title"], fb["hint"]
    result = {"title": "Recorded workflow", "summary": f"A {len(kept)}-step workflow in {app_name}.",
              "text_provider": "fallback", "text_model": None, "text_errors": []}
    if not kept:
        return result

    prompt = build_prompt(app_name, [step_brief(s) for s in kept])
    own = client is None
    client = client or httpx.AsyncClient(timeout=60)
    try:
        for make in (GeminiWriter, ClaudeWriter):
            t0 = time.perf_counter()
            try:
                writer = make(client)
                data, usage = await writer.write(prompt)
                title, summary, per_step = validate(data, numbers)
            except TextError as e:
                _log(rec_dir, {"ts": time.time(), "trigger": "text", "provider": make.name, "error": str(e)})
                result["text_errors"].append(f"{make.name}: {e}")
                if make is GeminiWriter and e.retryable_elsewhere:
                    continue  # 429 or invalid output → Claude
                break  # hard error (or Claude failed) → keep the deterministic text
            except httpx.TransportError as e:
                _log(rec_dir, {"ts": time.time(), "trigger": "text", "provider": make.name, "error": repr(e)})
                result["text_errors"].append(f"{make.name}: {e!r}")
                break
            _log(rec_dir, {"ts": time.time(), "trigger": "text", "provider": writer.name, "model": writer.model,
                           "latency_ms": round((time.perf_counter() - t0) * 1000, 1), "usage": usage,
                           "output": {"workflow_title": title, "steps": per_step}})
            for s in kept:
                s["title"], s["narration"] = per_step[s["number"]]["title"], per_step[s["number"]]["hint"]
            result.update(title=title, summary=summary, text_provider=writer.name, text_model=writer.model)
            break
    finally:
        if own:
            await client.aclose()
    return result
