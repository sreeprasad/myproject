import io
import json

import pytest


@pytest.fixture(autouse=True)
def _offline(monkeypatch):
    """Tests never call real Clef / Gemini / Claude, even if keys are exported in your shell."""
    for k in ("SHOWME_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "GEMINI_API_KEY",
              "ANTHROPIC_API_KEY", "DECISION_PROVIDER", "GEMINI_MODEL", "ANTHROPIC_MODEL"):
        monkeypatch.delenv(k, raising=False)


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("SHOWME_DATA_DIR", str(tmp_path / "data"))
    return tmp_path / "data"


def capture_json(w: int = 3456, h: int = 1562) -> dict:
    return {
        "source": "getDisplayMedia",
        "start_epoch": 1_000_000.0,
        "initial_viewport": {"w": w // 2, "h": h // 2, "dpr": 2},
        "track_settings_start": {"width": w, "height": h, "frameRate": 15},
        "frame_sizes": [{"epoch": 1_000_000.0, "t": 0, "width": w, "height": h}],
        "user_agent": "test",
    }


def dumps(o) -> bytes:
    return json.dumps(o).encode()


def upload_files(events=None, capture=None, frames=(("e0001_before.jpg", b"\xff\xd8jpeg"),)):
    events = events if events is not None else [{"id": "e0001", "type": "click", "epoch": 1, "t": 0, "url": "https://x/"}]
    return [
        ("events", ("events.json", io.BytesIO(dumps(events)), "application/json")),
        ("capture", ("capture.json", io.BytesIO(dumps(capture or capture_json())), "application/json")),
    ] + [("frames", (n, io.BytesIO(b), "image/jpeg")) for n, b in frames]
