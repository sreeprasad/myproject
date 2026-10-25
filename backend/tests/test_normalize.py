import json

import pytest

from showme_backend.normalize import compute_transform, ffmpeg_cmd, fit, normalize

from .conftest import needs_ffmpeg


def test_fit_matches_scale_decrease_plus_centered_pad():
    assert fit(2880, 1500, 2880, 1600) == {"w": 2880, "h": 1500, "scale": 1.0, "offset_x": 0.0, "offset_y": 50.0}
    t = fit(1920, 1200, 1280, 720)
    assert t["scale"] == pytest.approx(0.6)
    assert t["offset_x"] == pytest.approx(64.0)
    assert t["offset_y"] == pytest.approx(0.0)


def test_output_is_initial_capture_size_made_even_with_one_entry_per_size():
    cap = {"frame_sizes": [{"width": 2879, "height": 1601}, {"width": 2879, "height": 1500}, {"width": 2879, "height": 1601}]}
    t = compute_transform(cap)
    assert t["output"] == {"w": 2878, "h": 1600}
    assert t["fps"] == 30
    assert [(s["w"], s["h"]) for s in t["sizes"]] == [(2879, 1601), (2879, 1500)]


def test_probe_fallback_and_error():
    assert compute_transform({}, (1280, 720))["output"] == {"w": 1280, "h": 720}
    with pytest.raises(ValueError):
        compute_transform({})


def test_ffmpeg_command_is_cfr_pinned_and_never_trims():
    cmd = ffmpeg_cmd("in.webm", "out.mp4", 1280, 720)
    vf = cmd[cmd.index("-vf") + 1]
    assert vf.startswith("fps=30,")
    assert "pad=1280:720" in vf and "force_original_aspect_ratio=decrease" in vf
    assert "-ss" not in cmd and "-t" not in cmd and "-to" not in cmd


@needs_ffmpeg
def test_normalize_produces_30fps_mp4_and_transform(tmp_path, webm_factory, capture_factory):
    d = tmp_path / "rec"
    d.mkdir()
    webm_factory(d / "recording.webm", 640, 360, seconds=2.0, fps=24)
    (d / "capture.json").write_text(json.dumps(capture_factory(640, 360)))
    t = normalize(d)
    assert (d / "normalized.mp4").exists()
    assert t["output"] == {"w": 640, "h": 360}
    assert t["duration_ms"] == pytest.approx(2000, abs=80)
    saved = json.loads((d / "transform.json").read_text())
    assert saved["fps"] == 30 and "source_start_ms" in saved

    import subprocess

    rate = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate,width,height",
         "-of", "csv=p=0", str(d / "normalized.mp4")],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert rate.startswith("640,360,30/1")
