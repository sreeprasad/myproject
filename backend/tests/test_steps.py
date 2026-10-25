import asyncio
import json

import httpx
import pytest

from showme_backend import judge
from showme_backend.judge import STEP_QUESTIONS, build_steps, decide, step_state
from showme_backend.providers import ClefProvider, MockProvider, ProviderError, parse_clef_response
from showme_backend.segment import segment

from .workflow_a import workflow_a_events


# ---------------- segmentation ----------------
def test_workflow_a_segments_into_expected_steps():
    steps = segment(workflow_a_events())
    summary = [(s["action"], (s["target"] or {}).get("identifiers", {}).get("testid")) for s in steps]
    assert summary == [
        ("type", "appointments-search"),       # click to focus + 9 keystrokes → one step
        ("click", None),                       # misclick (model decides; segmentation keeps it)
        ("click", "check-in-p01"),             # click + navigation merged
        ("toggle", "check-in-id-verified"),    # label click + synthetic click + change → one toggle on the input
        ("toggle", "check-in-consent-signed"),
        ("select", "check-in-visit-reason"),   # click to open + change
        ("select", "check-in-room"),
        ("click", "check-in-complete"),
    ]


def test_step_details():
    steps = {s["target"]["identifiers"].get("testid"): s for s in segment(workflow_a_events()) if s["target"]}
    typed = steps["appointments-search"]
    assert typed["value"] is None and typed["value_masked"] is True  # free text never stored
    assert typed["frames"]["before"] == "frames/e0001_before.jpg"
    nav = steps["check-in-p01"]
    assert nav["navigates_to"].endswith("/check-in/p01")
    assert nav["after_state"]["headings"] == ["Patient Check-In"]
    assert nav["scrolls_before"] == 0
    assert steps["check-in-visit-reason"]["value"] == "Annual physical"
    assert steps["check-in-id-verified"]["value"] is True
    assert steps["check-in-id-verified"]["click_point"] == {"x": 480, "y": 819}
    done = steps["check-in-complete"]
    assert "Checked in · Waiting – Room 3" in done["after_state"]["status_texts"]
    # resize events never become steps; ids are sequential
    assert [s["id"] for s in segment(workflow_a_events())] == [f"s{i:02d}" for i in range(1, 9)]


def test_scroll_is_counted_on_the_next_step():
    steps = segment(workflow_a_events())
    assert steps[1]["scrolls_before"] == 1  # the misclick came right after a scroll


def test_back_navigation_without_click_is_its_own_step():
    ev = [{"id": "e1", "type": "navigation", "epoch": 1, "t": 0, "url": "https://x/a", "page_state": {"url": "https://x/a"}}]
    s = segment(ev)
    assert s[0]["action"] == "navigate" and s[0]["navigates_to"] == "https://x/a" and s[0]["target"] is None


def test_typing_pauses_split_steps_and_enter_submits():
    ev = workflow_a_events()[:5]  # click + first inputs
    later = dict(ev[-1], id="e9", t=ev[-1]["t"] + 10_000)
    enter = dict(later, id="e10", type="enter", t=later["t"] + 50)
    s = segment(ev + [later, enter])
    assert [x["action"] for x in s] == ["type", "type"]
    assert s[1]["submitted"] is True


# ---------------- provider state never carries sensitive values ----------------
def test_step_state_hides_values_of_masked_and_sensitive_fields():
    steps = segment(workflow_a_events())
    st = step_state(steps[0], len(steps), None)
    assert st["action"]["value"] is None and st["action"]["value_hidden"] is True
    sens = dict(steps[5], target={**steps[5]["target"], "sensitive": True})
    assert step_state(sens, 8, steps[4])["action"]["value"] is None
    assert step_state(steps[5], 8, steps[4])["previous_step"] == 'checked "Consent signed"'


def test_question_definitions_match_clef_format():
    for name, q in STEP_QUESTIONS.items():
        assert q["type"] in ("noul", "choice", "score") and q["instructions"]
        if q["type"] == "choice":
            assert isinstance(q["criteria"], dict) and q["criteria"]
        if q["type"] == "score":
            assert isinstance(q["criteria"], list) and len(q["criteria"]) == 3


# ---------------- thresholds ----------------
def _answers(meaningful=0.9, importance=2.0, step_type="click"):
    return {
        "meaningful": {"type": "noul", "noul": meaningful},
        "importance": {"type": "score", "score": importance},
        "step_type": {"type": "choice", "choice": step_type},
    }


def test_threshold_decisions():
    step = segment(workflow_a_events())[2]
    assert decide(step, _answers())["keep"] is True
    d = decide(step, _answers(meaningful=0.2))
    assert d["keep"] is False and "meaningful=0.20" in d["drop_reason"]
    assert decide(step, _answers(meaningful=0.3))["keep"] is True  # boundary: cut only BELOW 0.3
    assert decide(step, _answers(importance=1.234567))["importance"] == 1.235
    # no provider → keep everything, unjudged
    assert decide(step, None) == {"keep": True, "drop_reason": None, "importance": None, "step_type": "click", "judged": False}


def test_only_guide_relevant_questions_are_asked():
    assert set(STEP_QUESTIONS) == {"step_type", "meaningful", "importance"}


# ---------------- Clef response parsing ----------------
CLEF_BODY = {
    "result": {
        "model": "clef",
        "answers": {
            "step_type": {"type": "choice", "choice": "toggle", "probabilities": {"toggle": 0.93, "click": 0.07}, "confidence": 0.91},
            "meaningful": {"type": "noul", "noul": 0.97},
            "importance": {"type": "score", "score": 1.83, "legend": {"0": "Trivial", "1": "Helpful", "2": "Essential"},
                           "probabilities": {"0": 0.02, "1": 0.13, "2": 0.85}, "confidence": 0.8},
        },
        "usage": {"input_tokens": 2140, "output_tokens": 0},
    },
    "success": True, "errors": [], "messages": [],
}


def test_parse_clef_response():
    answers, usage = parse_clef_response(CLEF_BODY, STEP_QUESTIONS)
    assert answers["meaningful"]["noul"] == 0.97
    assert answers["step_type"]["choice"] == "toggle" and answers["step_type"]["confidence"] == 0.91
    assert answers["importance"]["probabilities"]["2"] == 0.85
    assert usage["input_tokens"] == 2140


@pytest.mark.parametrize("mutate", [
    lambda b: b["result"]["answers"].pop("meaningful"),
    lambda b: b["result"]["answers"]["meaningful"].update(noul=1.7),
    lambda b: b["result"]["answers"]["meaningful"].update(type="choice"),
    lambda b: b["result"]["answers"]["importance"].pop("score"),
    lambda b: b.update(success=False, errors=[{"code": 5006, "message": "bad input"}]),
])
def test_parse_rejects_bad_responses(mutate):
    body = json.loads(json.dumps(CLEF_BODY))
    mutate(body)
    with pytest.raises(ProviderError):
        parse_clef_response(body, STEP_QUESTIONS)


def test_clef_provider_request_shape_and_retry(tmp_path):
    img = tmp_path / "a.jpg"
    img.write_bytes(b"\xff\xd8fakejpeg")
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        if len(seen) == 1:
            return httpx.Response(429, json={"errors": ["slow down"]})
        return httpx.Response(200, json=CLEF_BODY)

    async def run():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        p = ClefProvider("clef", account_id="acct123", api_token="tok", client=client, max_retries=2)
        judge_sleep = asyncio.sleep
        try:
            asyncio_sleep_calls = []

            async def fast_sleep(s):
                asyncio_sleep_calls.append(s)

            import showme_backend.providers as prov
            prov.asyncio.sleep = fast_sleep
            d = await p.evaluate({"x": 1}, STEP_QUESTIONS, [img])
        finally:
            import showme_backend.providers as prov
            prov.asyncio.sleep = judge_sleep
            await client.aclose()
        return d

    d = asyncio.run(run())
    assert len(seen) == 2  # retried once after 429
    req = seen[-1]
    assert req.url.path == "/client/v4/accounts/acct123/ai/run/@cf/cloudflare/clef"
    assert req.headers["authorization"] == "Bearer tok"
    body = json.loads(req.content)
    assert body["model"] == "clef" and body["state"] == {"x": 1}
    assert body["images"][0].startswith("data:image/jpeg;base64,")
    assert body["questions"]["importance"]["criteria"][0].startswith("Trivial")
    assert d.answers["meaningful"]["noul"] == 0.97 and d.usage["input_tokens"] == 2140


def test_clef_provider_rejects_unknown_model_and_missing_keys(monkeypatch):
    monkeypatch.delenv("CLOUDFLARE_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    with pytest.raises(ValueError):
        ClefProvider("clef-lite", account_id="a", api_token="t")
    with pytest.raises(ProviderError):
        ClefProvider("clef")


# ---------------- end to end: steps.json + decisions.jsonl ----------------
def _rec(tmp_path):
    d = tmp_path / "rec-test"
    (d / "frames").mkdir(parents=True)
    (d / "events.json").write_text(json.dumps(workflow_a_events()))
    for n in ("e0001_before", "e0001_after", "e0002_before"):
        (d / "frames" / f"{n}.jpg").write_bytes(b"\xff\xd8x")
    return d


def test_build_steps_with_mock_provider_drops_misclick_and_logs(tmp_path):
    d = _rec(tmp_path)

    def answers(state, questions):
        el = state["action"]["element"] or {}
        misclick = el.get("tag") == "td"
        a = _answers(meaningful=0.05 if misclick else 0.95)
        a["importance"].update(legend={}, probabilities={}, confidence=1.0)
        a["step_type"].update(probabilities={}, confidence=1.0)
        return a

    mock = MockProvider(answers)
    doc = asyncio.run(build_steps(d, mock))
    assert doc["schema"] == "showme.steps/1"
    assert doc["counts"] == {"events": len(workflow_a_events()), "candidates": 8, "kept": 7}
    dropped = [s for s in doc["steps"] if not s["decision"]["keep"]]
    assert len(dropped) == 1 and dropped[0]["target"]["tag"] == "td"
    kept = [s for s in doc["steps"] if s["decision"]["keep"]]
    assert [s["number"] for s in kept] == list(range(1, 8))
    assert all("title" in s and "narration" in s for s in doc["steps"])
    # images sent only when the frame file exists; first step has before+after
    assert mock.calls[0]["images"][0].endswith("e0001_before.jpg")
    log = [json.loads(l) for l in (d / "decisions.jsonl").read_text().splitlines()]
    assert len(log) == 8 and {l["trigger"] for l in log} == {"judge_step"}
    assert all("latency_ms" in l and l["provider"] == "mock" for l in log)
    assert json.loads((d / "steps.json").read_text())["counts"]["kept"] == 7


def test_build_steps_without_provider_keeps_everything(tmp_path):
    d = _rec(tmp_path)
    doc = asyncio.run(build_steps(d, None, "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set"))
    assert doc["counts"]["kept"] == 8
    assert all(s["decision"]["judged"] is False for s in doc["steps"])
    assert doc["provider_note"].startswith("CLOUDFLARE")


def test_provider_errors_fall_back_per_step(tmp_path):
    d = _rec(tmp_path)

    class Flaky(MockProvider):
        async def evaluate(self, state, questions, images=None):
            if state["step_index"] == 3:
                raise ProviderError("HTTP 500")
            return await super().evaluate(state, questions, images)

    doc = asyncio.run(build_steps(d, Flaky()))
    s3 = doc["steps"][2]
    assert s3["judge"] == {"error": "HTTP 500"} and s3["decision"]["keep"] is True
    assert any("error" in json.loads(l) for l in (d / "decisions.jsonl").read_text().splitlines())


def test_thresholds_live_in_one_file():
    assert judge.THRESHOLDS["cut_if_meaningful_below"] == 0.3
    assert judge.THRESHOLDS["guide_step_done_at_least"] == 0.8
