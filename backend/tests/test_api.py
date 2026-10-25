import io
import json
import time

from fastapi.testclient import TestClient

from showme_backend.main import app

from .conftest import dumps, needs_ffmpeg


def _upload(client, webm: bytes, capture: dict, frames=(("e0001_before.jpg", b"\xff\xd8jpeg"),)):
    files = [
        ("video", ("recording.webm", io.BytesIO(webm), "video/webm")),
        ("events", ("events.json", io.BytesIO(dumps([{"id": "e0001", "type": "click", "epoch": 1, "video_t": 0}])), "application/json")),
        ("sensitive_tracks", ("sensitive_tracks.json", io.BytesIO(dumps([])), "application/json")),
        ("capture", ("capture.json", io.BytesIO(dumps(capture)), "application/json")),
    ] + [("frames", (n, io.BytesIO(b), "image/jpeg")) for n, b in frames]
    return client.post("/recordings", files=files)


def test_rejects_path_traversal_in_frame_names(data_dir, capture_factory):
    client = TestClient(app)
    r = _upload(client, b"x", capture_factory(640, 360), frames=(("../evil.jpg", b"x"),))
    # The basename is taken, so "../evil.jpg" becomes "evil.jpg" inside frames/ — never outside.
    assert r.status_code == 200
    assert not (data_dir / "evil.jpg").exists()
    r2 = _upload(client, b"x", capture_factory(640, 360), frames=(("bad name.png", b"x"),))
    assert r2.status_code == 400


def test_bad_json_is_rejected(data_dir):
    client = TestClient(app)
    files = [
        ("video", ("recording.webm", io.BytesIO(b"x"), "video/webm")),
        ("events", ("events.json", io.BytesIO(b"{not json"), "application/json")),
        ("sensitive_tracks", ("s.json", io.BytesIO(b"[]"), "application/json")),
        ("capture", ("c.json", io.BytesIO(b"{}"), "application/json")),
    ]
    assert client.post("/recordings", files=files).status_code == 400


def test_unknown_and_bad_ids(data_dir):
    client = TestClient(app)
    assert client.get("/recordings/rec-nope").status_code == 404
    assert client.get("/recordings/..%2Fetc").status_code in (400, 404)


@needs_ffmpeg
def test_upload_then_normalize(tmp_path, data_dir, webm_factory, capture_factory):
    src = tmp_path / "in.webm"
    webm_factory(src, 640, 360, seconds=1.0)
    client = TestClient(app)
    r = _upload(client, src.read_bytes(), capture_factory(640, 360))
    assert r.status_code == 200, r.text
    rec_id = r.json()["id"]
    # TestClient runs background tasks before returning, but poll to be safe.
    for _ in range(50):
        st = client.get(f"/recordings/{rec_id}/status").json()
        if st["state"] in ("normalized", "error"):
            break
        time.sleep(0.1)
    assert st["state"] == "normalized", st
    info = client.get(f"/recordings/{rec_id}").json()
    assert "normalized.mp4" in info["files"] and "transform.json" in info["files"]
    assert "frames/e0001_before.jpg" in info["files"]
    assert json.loads((data_dir / rec_id / "transform.json").read_text())["output"] == {"w": 640, "h": 360}
