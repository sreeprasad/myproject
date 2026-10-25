"""NORMALIZE: MediaRecorder WebM -> constant 30 fps MP4 with pinned output dimensions.

Never trims. Writes normalized.mp4 and transform.json (the scale/pad applied to each source frame size,
plus the source start time, so the renderer can map video_t and viewport px onto the output).

Usage:  python -m showme_backend.normalize <recording-id>
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

from .config import OUTPUT_FPS, recording_dir


def even(n: float) -> int:
    n = int(round(n))
    return n - (n % 2)


def fit(src_w: int, src_h: int, out_w: int, out_h: int) -> dict:
    """Same math as ffmpeg scale=...:force_original_aspect_ratio=decrease + centered pad."""
    scale = min(out_w / src_w, out_h / src_h)
    return {
        "w": src_w,
        "h": src_h,
        "scale": scale,
        "offset_x": (out_w - src_w * scale) / 2,
        "offset_y": (out_h - src_h * scale) / 2,
    }


def compute_transform(capture: dict, probed: tuple[int, int] | None = None) -> dict:
    """Output = initial capture size (made even); one fit() entry per distinct source frame size."""
    sizes = [(int(f["width"]), int(f["height"])) for f in capture.get("frame_sizes", []) if f.get("width")]
    if not sizes and probed:
        sizes = [probed]
    if not sizes:
        raise ValueError("capture.json has no frame_sizes and the video could not be probed")
    out_w, out_h = even(sizes[0][0]), even(sizes[0][1])
    distinct = list(dict.fromkeys(sizes))
    return {
        "output": {"w": out_w, "h": out_h},
        "fps": OUTPUT_FPS,
        "sizes": [fit(w, h, out_w, out_h) for (w, h) in distinct],
    }


def ffprobe(path: Path) -> dict:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,start_time,r_frame_rate,nb_frames:format=start_time,duration",
            "-of", "json", str(path),
        ],
        check=True, capture_output=True, text=True,
    )
    return json.loads(out.stdout)


def _float(x) -> float | None:
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def ffmpeg_cmd(src: Path, dst: Path, out_w: int, out_h: int, fps: int = OUTPUT_FPS) -> list[str]:
    vf = (
        f"fps={fps},"
        f"scale={out_w}:{out_h}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,"
        f"pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:color=black,"
        "format=yuv420p"
    )
    return [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(src),
        "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-movflags", "+faststart", "-an",
        str(dst),
    ]


def normalize(rec_dir: Path) -> dict:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RuntimeError("ffmpeg/ffprobe not found on PATH (macOS: brew install ffmpeg)")
    src = rec_dir / "recording.webm"
    if not src.exists():
        raise FileNotFoundError(src)
    capture = json.loads((rec_dir / "capture.json").read_text()) if (rec_dir / "capture.json").exists() else {}

    probe = ffprobe(src)
    stream = (probe.get("streams") or [{}])[0]
    probed = (int(stream["width"]), int(stream["height"])) if stream.get("width") else None
    transform = compute_transform(capture, probed)

    # MP4 output starts at t=0 = the first source frame. If the WebM's first frame isn't at pts 0,
    # the renderer must shift video_t by this much.
    start = _float(stream.get("start_time")) or _float(probe.get("format", {}).get("start_time")) or 0.0
    transform["source_start_ms"] = round(start * 1000, 3)

    dst = rec_dir / "normalized.mp4"
    subprocess.run(ffmpeg_cmd(src, dst, transform["output"]["w"], transform["output"]["h"]), check=True)

    out = ffprobe(dst)
    transform["duration_ms"] = round((_float(out.get("format", {}).get("duration")) or 0) * 1000, 1)
    (rec_dir / "transform.json").write_text(json.dumps(transform, indent=1))
    return transform


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    t = normalize(recording_dir(argv[1]))
    print(json.dumps(t, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
