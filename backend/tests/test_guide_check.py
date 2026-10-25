import json

from fastapi.testclient import TestClient

from showme_backend import guide as guide_mod
from showme_backend.main import app

from .conftest import upload_files
from .workflow_a import workflow_a_events


def _recording(client):
    rec_id = client.post("/recordings", files=upload_files(events=workflow_a_events())).json()["id"]
    assert client.get(f"/recordings/{rec_id}/status").json()["state"] == "steps_ready"
    return rec_id


LEARNER = {
    "path": "/check-in/p01",
    "page_state": {"title": "LumenCare", "headings": ["Patient Check-In"], "buttons": ["Complete check-in"],
                   "fields": [{"label": "ID verified", "filled": False}], "status_texts": [], "extra": "dropped"},
    "seconds_on_step": 12, "wrong_attempts": 2,
    "recent_actions": [{"type": "click", "element": "My Patients", "seconds_ago": 3, "value": "dropped"}],
}


def test_check_returns_clef_answers_and_thresholds(data_dir, monkeypatch):
    monkeypatch.setenv("PRACTICE_PROVIDER", "mock")
    guide_mod._last_call.clear()
    c = TestClient(app)
    rec_id = _recording(c)
    r = c.post(f"/practice/{rec_id}/check", json={"step_number": 3, "trigger": "idle", "learner": LEARNER})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["provider"] == "mock" and out["step_number"] == 3
    assert set(out["answers"]) == {"step_done", "stuck", "current_step"}
    assert out["thresholds"] == {"step_done": 0.8, "stuck": 0.6, "idle_seconds": 10, "min_seconds_between_calls": 2}
    log = [json.loads(l) for l in (data_dir / rec_id / "decisions.jsonl").read_text().splitlines()]
    assert log[-1]["trigger"] == "guide_idle" and log[-1]["step_number"] == 3


def test_questions_and_state_are_sensitive_free_and_clipped(data_dir, monkeypatch):
    guide_mod._last_call.clear()
    c = TestClient(app)
    monkeypatch.setenv("PRACTICE_PROVIDER", "mock")
    rec_id = _recording(c)
    seen = {}
    from showme_backend.providers import MockProvider

    real = guide_mod.get_provider

    def capture(name):
        p = MockProvider()
        orig = p.evaluate

        async def ev(state, questions, images=None):
            seen.update(state=state, questions=questions, images=images)
            return await orig(state, questions, images)

        p.evaluate = ev
        return p

    monkeypatch.setattr(guide_mod, "get_provider", capture)
    c.post(f"/practice/{rec_id}/check", json={"step_number": 2, "trigger": "off_track", "learner": LEARNER})
    q = seen["questions"]
    assert q["current_step"]["type"] == "choice" and "off_track" in q["current_step"]["criteria"]
    assert len([k for k in q["current_step"]["criteria"] if k.startswith("step_")]) == 8
    learner = seen["state"]["learner"]
    assert "extra" not in learner["page"] and "value" not in learner["recent_actions"][0]
    assert seen["state"]["expected_step"]["number"] == 2
    monkeypatch.setattr(guide_mod, "get_provider", real)


def test_rate_limit_bad_input_and_missing_provider(data_dir, monkeypatch):
    guide_mod._last_call.clear()
    monkeypatch.setenv("PRACTICE_PROVIDER", "mock")
    c = TestClient(app)
    rec_id = _recording(c)
    ok = {"step_number": 1, "trigger": "ambiguous", "learner": LEARNER}
    assert c.post(f"/practice/{rec_id}/check", json=ok).status_code == 200
    assert c.post(f"/practice/{rec_id}/check", json=ok).status_code == 429  # < 2 s later
    guide_mod._last_call.clear()
    assert c.post(f"/practice/{rec_id}/check", json={**ok, "trigger": "bored"}).status_code == 400
    assert c.post(f"/practice/{rec_id}/check", json={**ok, "step_number": 99}).status_code == 400
    monkeypatch.setenv("PRACTICE_PROVIDER", "clef-flash")  # no Cloudflare keys in tests
    guide_mod._last_call.clear()
    assert c.post(f"/practice/{rec_id}/check", json=ok).status_code == 503
    assert c.post("/practice/rec-nope/check", json=ok).status_code == 404
