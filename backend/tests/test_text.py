import asyncio
import json

import httpx
import pytest

from showme_backend.judge import build_steps
from showme_backend.providers import MockProvider
from showme_backend.segment import segment
from showme_backend.text import (RESPONSE_SCHEMA, TextError, build_prompt, fallback_text, step_brief, validate,
                                 write_text)

from .workflow_a import workflow_a_events


def kept_steps():
    steps = segment(workflow_a_events())
    kept = [s for s in steps if (s["target"] or {}).get("tag") != "td"]  # drop the misclick
    for n, s in enumerate(kept, 1):
        s["number"] = n
        s["decision"] = {"keep": True, "importance": 1.8}
    return kept


GOOD = {
    "workflow_title": "Check in a patient",
    "workflow_summary": "Find the patient, verify their details and send them to a room.",
    "steps": [
        {"number": 1, "title": "Search for the patient", "hint": "Type the patient's name into \"Search appointments\"."},
        {"number": 2, "title": "Open check-in", "hint": "Click \"Check in\" on their row."},
        {"number": 3, "title": "Verify the patient's ID", "hint": "Tick \"ID verified\" after checking their photo ID."},
        {"number": 4, "title": "Confirm consent", "hint": "Tick \"Consent signed\" once the form is signed."},
        {"number": 5, "title": "Choose the visit reason", "hint": "Pick \"Annual physical\" in \"Visit reason\"."},
        {"number": 6, "title": "Assign a room", "hint": "Pick \"Room 3\" in \"Room assignment\"."},
        {"number": 7, "title": "Complete the check-in.", "hint": "Click \"Complete check-in\" to finish."},
    ],
}


def gemini_ok(payload=GOOD):
    return httpx.Response(200, json={
        "candidates": [{"content": {"parts": [{"text": json.dumps(payload)}], "role": "model"}}],
        "usageMetadata": {"promptTokenCount": 900, "candidatesTokenCount": 210},
    })


def claude_ok(payload=GOOD):
    return httpx.Response(200, json={"content": [{"type": "text", "text": json.dumps(payload)}],
                                     "usage": {"input_tokens": 950, "output_tokens": 230}})


def run(tmp_path, handler, monkeypatch, gemini=True, claude=True):
    if gemini:
        monkeypatch.setenv("GEMINI_API_KEY", "g-key")
    if claude:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "a-key")
    seen = []

    def h(req):
        seen.append(req)
        return handler(req)

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(h)) as c:
            steps = kept_steps()
            res = await write_text(tmp_path, steps, client=c)
            return steps, res

    steps, res = asyncio.run(go())
    log = [json.loads(l) for l in (tmp_path / "decisions.jsonl").read_text().splitlines()] if (tmp_path / "decisions.jsonl").exists() else []
    return steps, res, seen, log


# ---- the prompt never carries sensitive values ----
def test_brief_hides_masked_and_sensitive_values():
    steps = kept_steps()
    assert step_brief(steps[0])["value"] == "(hidden)"  # typed search text was masked at record time
    assert step_brief(steps[4])["value"] == "Annual physical"
    assert step_brief(steps[1])["goes_to_page"] == "Patient Check-In"
    sens = dict(steps[4], target={**steps[4]["target"], "sensitive": True})
    assert step_brief(sens)["value"] == "(hidden)"
    prompt = build_prompt("LumenCare", [step_brief(s) for s in steps])
    assert "Quintero" not in prompt and "LG-" not in prompt and "555-" not in prompt


# ---- validation ----
def test_validate_accepts_good_and_strips_trailing_period():
    title, summary, per = validate(GOOD, list(range(1, 8)))
    assert title == "Check in a patient" and per[7]["title"] == "Complete the check-in"


@pytest.mark.parametrize("mutate", [
    lambda d: d["steps"].pop(),                                              # missing a step
    lambda d: d["steps"].append(dict(d["steps"][0])),                        # duplicate number
    lambda d: d["steps"][0].update(number=99),                               # unknown number
    lambda d: d["steps"][0].update(title="one two three four five six seven"),  # > 6 words
    lambda d: d["steps"][0].update(hint=" ".join(["word"] * 21)),            # > 20 words
    lambda d: d.update(workflow_title=""),
    lambda d: d.pop("workflow_summary"),
])
def test_validate_rejects(mutate):
    d = json.loads(json.dumps(GOOD))
    mutate(d)
    with pytest.raises(TextError) as e:
        validate(d, list(range(1, 8)))
    assert e.value.retryable_elsewhere is True


# ---- provider chain ----
def test_gemini_success_fills_every_kept_step(tmp_path, monkeypatch):
    steps, res, seen, log = run(tmp_path, lambda req: gemini_ok(), monkeypatch)
    assert res["text_provider"] == "gemini" and res["text_model"] == "gemini-3.5-flash-lite"
    assert res["title"] == "Check in a patient"
    assert [s["title"] for s in steps][2] == "Verify the patient's ID"
    assert all(s["narration"] for s in steps)
    req = seen[0]
    assert req.url.path == "/v1beta/models/gemini-3.5-flash-lite:generateContent"
    assert req.headers["x-goog-api-key"] == "g-key"
    body = json.loads(req.content)
    assert body["generationConfig"]["responseMimeType"] == "application/json"
    assert body["generationConfig"]["responseSchema"] == RESPONSE_SCHEMA
    assert len(seen) == 1  # ONE call per workflow
    assert log[-1]["provider"] == "gemini" and log[-1]["usage"]["promptTokenCount"] == 900


def test_gemini_429_falls_back_to_claude(tmp_path, monkeypatch):
    def h(req):
        return httpx.Response(429, json={}) if "googleapis" in str(req.url) else claude_ok()
    steps, res, seen, log = run(tmp_path, h, monkeypatch)
    assert res["text_provider"] == "claude" and len(seen) == 2
    assert seen[1].headers["anthropic-version"] == "2023-06-01"
    assert json.loads(seen[1].content)["model"] == "claude-haiku-5-5"
    assert "429" in res["text_errors"][0]


def test_invalid_gemini_output_falls_back_to_claude(tmp_path, monkeypatch):
    bad = json.loads(json.dumps(GOOD))
    bad["steps"].pop()
    def h(req):
        return gemini_ok(bad) if "googleapis" in str(req.url) else claude_ok()
    _, res, _, _ = run(tmp_path, h, monkeypatch)
    assert res["text_provider"] == "claude"


def test_gemini_hard_error_keeps_deterministic_text_without_trying_claude(tmp_path, monkeypatch):
    steps, res, seen, _ = run(tmp_path, lambda req: httpx.Response(400, json={"error": "bad model"}), monkeypatch)
    assert res["text_provider"] == "fallback" and len(seen) == 1
    assert steps[2]["title"] == 'Tick "ID verified"' and steps[2]["narration"] == 'Tick the "ID verified" checkbox.'


def test_both_fail_keeps_deterministic_text(tmp_path, monkeypatch):
    def h(req):
        return httpx.Response(429) if "googleapis" in str(req.url) else httpx.Response(500, text="overloaded")
    steps, res, _, log = run(tmp_path, h, monkeypatch)
    assert res["text_provider"] == "fallback" and len(res["text_errors"]) == 2
    assert all(s["title"] and s["narration"] for s in steps)
    assert {l["provider"] for l in log} == {"gemini", "claude"}


def test_no_keys_at_all_is_fine(tmp_path, monkeypatch):
    steps, res, seen, _ = run(tmp_path, lambda req: gemini_ok(), monkeypatch, gemini=False, claude=False)
    assert res["text_provider"] == "fallback" and seen == []


def test_fallback_text_shapes():
    s = kept_steps()
    assert fallback_text(s[0]) == {"title": "Fill in Search appointments", "hint": 'Type into "Search appointments".'}
    assert fallback_text(s[1])["hint"] == 'Click "Check in" to open Patient Check-In.'
    assert fallback_text(s[4]) == {"title": "Choose Visit reason", "hint": 'Pick "Annual physical" in "Visit reason".'}


def test_build_steps_writes_workflow_text(tmp_path, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "g-key")
    d = tmp_path / "rec"
    (d / "frames").mkdir(parents=True)
    (d / "events.json").write_text(json.dumps(workflow_a_events()))

    def answers(state, questions):
        misclick = (state["action"]["element"] or {}).get("tag") == "td"
        return {
            "meaningful": {"type": "noul", "noul": 0.05 if misclick else 0.95},
            "importance": {"type": "score", "score": 1.8},
            "step_type": {"type": "choice", "choice": "click"},
        }

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: gemini_ok())) as c:
            return await build_steps(d, MockProvider(answers), text_client=c)

    doc = asyncio.run(go())
    assert doc["workflow"]["title"] == "Check in a patient" and doc["workflow"]["text_provider"] == "gemini"
    kept = [s for s in doc["steps"] if s["decision"]["keep"]]
    assert [s["number"] for s in kept] == list(range(1, 8))
    assert kept[2]["title"] == "Verify the patient's ID"
    dropped = [s for s in doc["steps"] if not s["decision"]["keep"]]
    assert dropped[0]["title"] is None  # dropped steps get no words
