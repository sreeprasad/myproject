import io
import json

from fastapi.testclient import TestClient

from showme_backend import main
from showme_backend.main import app

from .conftest import upload_files
from .workflow_a import workflow_a_events


def test_upload_has_no_video_and_builds_steps(data_dir):
    client = TestClient(app)
    r = client.post("/recordings", files=upload_files(events=workflow_a_events()))
    assert r.status_code == 200, r.text
    rec_id = r.json()["id"]
    # TestClient runs background tasks before returning.
    st = client.get(f"/recordings/{rec_id}/status").json()
    assert st["state"] == "steps_ready", st
    assert st["counts"] == {"events": len(workflow_a_events()), "candidates": 8, "kept": 8}  # no keys → unjudged
    files = client.get(f"/recordings/{rec_id}").json()["files"]
    assert set(files) == {"events.json", "capture.json", "frames/e0001_before.jpg", "status.json", "steps.json", "decisions.jsonl"}
    assert not any(f.endswith((".webm", ".mp4")) for f in files)
    steps = client.get(f"/recordings/{rec_id}/steps").json()
    assert steps["schema"] == "showme.steps/1" and steps["provider"] is None and "CLOUDFLARE" in steps["provider_note"]
    # no Gemini/Claude keys → deterministic words, so the guide always has text
    assert steps["workflow"]["text_provider"] == "fallback"
    kept = [s for s in steps["steps"] if s["decision"]["keep"]]
    assert all(s["title"] and s["narration"] for s in kept)
    assert steps["start_path"] == "/appointments"


def test_video_field_is_not_accepted_as_a_requirement(data_dir):
    # A client that still sends a video part is ignored for that part (not stored).
    client = TestClient(app)
    files = upload_files() + [("video", ("recording.webm", io.BytesIO(b"x" * 100), "video/webm"))]
    rec_id = client.post("/recordings", files=files).json()["id"]
    assert not (data_dir / rec_id / "recording.webm").exists()


def test_rejects_bad_frame_names(data_dir):
    client = TestClient(app)
    r = client.post("/recordings", files=upload_files(frames=(("../evil.jpg", b"x"),)))
    assert r.status_code == 200  # basename taken → stays inside frames/
    assert not (data_dir / "evil.jpg").exists()
    assert client.post("/recordings", files=upload_files(frames=(("bad name.png", b"x"),))).status_code == 400


def test_bad_json_is_rejected(data_dir):
    client = TestClient(app)
    files = [
        ("events", ("events.json", io.BytesIO(b"{not json"), "application/json")),
        ("capture", ("c.json", io.BytesIO(b"{}"), "application/json")),
    ]
    assert client.post("/recordings", files=files).status_code == 400


def test_steps_404_until_ready(data_dir, monkeypatch):
    monkeypatch.setattr(main.hooks, "process", lambda rec_id: None)
    client = TestClient(app)
    rec_id = client.post("/recordings", files=upload_files()).json()["id"]
    r = client.get(f"/recordings/{rec_id}/steps")
    assert r.status_code == 404 and "uploaded" in r.text


def test_unknown_and_bad_ids(data_dir):
    client = TestClient(app)
    assert client.get("/recordings/rec-nope").status_code == 404
    assert client.get("/recordings/..%2Fetc").status_code in (400, 404)


def test_list_recordings(data_dir):
    client = TestClient(app)
    rec_id = client.post("/recordings", files=upload_files()).json()["id"]
    assert [r["id"] for r in client.get("/recordings").json()] == [rec_id]
    assert json.loads((data_dir / rec_id / "status.json").read_text())["state"] == "steps_ready"
