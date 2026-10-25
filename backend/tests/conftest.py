import json
import shutil
import subprocess
from pathlib import Path

import pytest

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
needs_ffmpeg = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("SHOWME_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("SHOWME_VIDEO_DIR", str(tmp_path / "no-video"))  # skip render:debug in tests
    monkeypatch.delenv("SHOWME_API_TOKEN", raising=False)
    return tmp_path / "data"


def make_webm(path: Path, w: int = 640, h: int = 360, seconds: float = 2.0, fps: int = 24) -> None:
    """Small VFR-ish VP8 WebM similar to what MediaRecorder produces."""
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"testsrc2=size={w}x{h}:rate={fps}:duration={seconds}",
            "-c:v", "libvpx", "-b:v", "500k", "-deadline", "realtime", "-cpu-used", "8",
            str(path),
        ],
        check=True,
    )


def capture_json(w: int, h: int) -> dict:
    return {
        "source": "getDisplayMedia",
        "video_start_epoch": 1_000_000.0,
        "mime_type": "video/webm;codecs=vp8",
        "initial_viewport": {"w": w // 2, "h": h // 2, "dpr": 2},
        "track_settings_start": {"width": w, "height": h, "frameRate": 30},
        "frame_sizes": [{"epoch": 1_000_000.0, "width": w, "height": h, "video_t": 0}],
        "user_agent": "test",
    }


@pytest.fixture
def capture_factory():
    return capture_json


@pytest.fixture
def webm_factory():
    return make_webm


def dumps(o) -> bytes:
    return json.dumps(o).encode()
