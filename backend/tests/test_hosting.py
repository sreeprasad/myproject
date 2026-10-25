from fastapi.testclient import TestClient

from showme_backend import main
from showme_backend.main import app

from .conftest import upload_files


def test_token_required_when_configured(data_dir, monkeypatch):
    monkeypatch.setenv("SHOWME_API_TOKEN", "s3cret")
    calls = []
    monkeypatch.setattr(main.hooks, "process", lambda rec_id: calls.append(rec_id))
    c = TestClient(app)
    assert c.post("/recordings", files=upload_files()).status_code == 401
    assert c.post("/recordings", files=upload_files(), headers={"x-showme-token": "nope"}).status_code == 401
    r = c.post("/recordings", files=upload_files(), headers={"x-showme-token": "s3cret"})
    assert r.status_code == 200
    rec_id = r.json()["id"]
    assert calls == [rec_id]  # processing handed to the hook (Modal spawn), not run in-process
    assert c.get(f"/recordings/{rec_id}/status").status_code == 401
    assert c.get(f"/recordings/{rec_id}/status?token=s3cret").json()["state"] == "uploaded"
    assert c.get("/health").status_code == 200  # health stays open


def test_file_serving_is_allowlisted(data_dir, monkeypatch):
    monkeypatch.setattr(main.hooks, "process", lambda rec_id: None)
    c = TestClient(app)
    rec_id = c.post("/recordings", files=upload_files(frames=(("e0001_after.jpg", b"\xff\xd8x"),))).json()["id"]
    assert len(rec_id.split("-")[-1]) == 12  # unguessable suffix
    assert c.get(f"/recordings/{rec_id}/files/frames/e0001_after.jpg").content == b"\xff\xd8x"
    assert c.get(f"/recordings/{rec_id}/files/capture.json").status_code == 200
    assert c.get(f"/recordings/{rec_id}/files/decisions.jsonl").status_code == 404  # allowed name, not written yet
    assert c.get(f"/recordings/{rec_id}/files/anything.mp4").status_code == 404
    assert c.get(f"/recordings/{rec_id}/files/..%2F..%2Fetc%2Fpasswd").status_code == 404


def test_hooks_called_around_reads_and_writes(data_dir, monkeypatch):
    log = []
    monkeypatch.setattr(main.hooks, "process", lambda rec_id: log.append("process"))
    monkeypatch.setattr(main.hooks, "after_write", lambda: log.append("commit"))
    monkeypatch.setattr(main.hooks, "before_read", lambda: log.append("reload"))
    c = TestClient(app)
    rec_id = c.post("/recordings", files=upload_files()).json()["id"]
    assert log == ["commit", "process"]  # commit BEFORE handing off, so the worker sees the files
    c.get(f"/recordings/{rec_id}/status")
    assert log[-1] == "reload"


def test_cors_allows_vercel_and_localhost_only(data_dir):
    c = TestClient(app)
    ok = c.options("/recordings", headers={"Origin": "https://showme-abc123.vercel.app", "Access-Control-Request-Method": "POST"})
    assert ok.headers.get("access-control-allow-origin") == "https://showme-abc123.vercel.app"
    local = c.options("/recordings", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST"})
    assert local.headers.get("access-control-allow-origin") == "http://localhost:3000"
    bad = c.options("/recordings", headers={"Origin": "https://evil.example.com", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in bad.headers
