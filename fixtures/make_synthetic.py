"""Synthetic alignment fixture: a fake "tab recording" with KNOWN click targets, including a
mid-recording viewport resize (like Chrome's sharing infobar appearing).

Writes data/synthetic-alignment/{recording.webm, events.json, sensitive_tracks.json, capture.json}.
Each click has a magenta square drawn at exactly its location in the video while it happens, so:
  - fixtures/verify_alignment.ts checks the math pixel-by-pixel (no browser needed), and
  - `npm run render:debug -- synthetic-alignment` should show every red dot centred on a magenta square,
    and the yellow sensitive outline riding on the moving cyan bar.

Usage:  python3 fixtures/make_synthetic.py
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get("SHOWME_DATA_DIR", REPO / "data")) / "synthetic-alignment"

DPR = 2
START_EPOCH = 1_761_350_000_000.0
FPS_SRC = 24  # deliberately not 30: normalize must convert to CFR 30

# Two viewport segments: 720x450 for 0–3 s, then 720x420 (an infobar took 30 CSS px) for 3–6 s.
SEGMENTS = [
    {"t0": 0.0, "t1": 3.0, "vw": 720, "vh": 450},
    {"t0": 3.0, "t1": 6.0, "vw": 720, "vh": 420},
]
# Clicks in viewport CSS px at video time (s).
CLICKS = [
    {"t": 0.8, "x": 120, "y": 90},
    {"t": 1.9, "x": 600, "y": 380},
    {"t": 3.6, "x": 360, "y": 210},
    {"t": 5.2, "x": 80, "y": 400},
]
SQ = 16  # target square half-size in CSS px
# A sensitive bar that scrolls up during 1.0–2.5 s (CSS px).
BAR = {"x": 200, "w": 260, "h": 28, "y0": 300, "y1": 120, "t0": 1.0, "t1": 2.5}


def seg_at(t: float) -> dict:
    return SEGMENTS[0] if t < SEGMENTS[1]["t0"] else SEGMENTS[1]


def bar_y(t: float) -> float:
    if t <= BAR["t0"]:
        return BAR["y0"]
    if t >= BAR["t1"]:
        return BAR["y1"]
    f = (t - BAR["t0"]) / (BAR["t1"] - BAR["t0"])
    return BAR["y0"] + (BAR["y1"] - BAR["y0"]) * f


def make_segment(seg: dict, path: Path) -> None:
    w, h = seg["vw"] * DPR, seg["vh"] * DPR
    dur = seg["t1"] - seg["t0"]
    draws = [
        # light "page" background + header band so frames look like a UI
        f"drawbox=x=0:y=0:w={w}:h={60 * DPR}:color=0x0f6e74:t=fill",
    ]
    for c in CLICKS:
        if seg["t0"] <= c["t"] < seg["t1"]:
            lt = c["t"] - seg["t0"]
            draws.append(
                f"drawbox=x={(c['x'] - SQ) * DPR}:y={(c['y'] - SQ) * DPR}:w={2 * SQ * DPR}:h={2 * SQ * DPR}"
                f":color=0xff00ff:t=fill:enable='between(t,{lt - 0.4:.3f},{lt + 0.6:.3f})'"
            )
    # moving sensitive bar (y animates linearly between t0 and t1 in global time)
    t_off = seg["t0"]
    y_expr = (
        f"if(lt(t+{t_off},{BAR['t0']}),{BAR['y0']},if(gt(t+{t_off},{BAR['t1']}),{BAR['y1']},"
        f"{BAR['y0']}+({BAR['y1']}-{BAR['y0']})*(t+{t_off}-{BAR['t0']})/({BAR['t1']}-{BAR['t0']})))*{DPR}"
    )
    # drawbox evaluates x/y once, so the moving bar is an overlay (overlay re-evaluates per frame).
    graph = (
        f"[0:v]{','.join(draws)}[base];"
        f"[1:v]format=yuv420p[bar];"
        f"[base][bar]overlay=x={BAR['x'] * DPR}:y='{y_expr}':eval=frame:shortest=1[out]"
    )
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c=0xf4f6f8:s={w}x{h}:r={FPS_SRC}:d={dur}",
            "-f", "lavfi", "-i", f"color=c=0x00e5ff:s={BAR['w'] * DPR}x{BAR['h'] * DPR}:r={FPS_SRC}:d={dur}",
            "-filter_complex", graph, "-map", "[out]",
            "-c:v", "libvpx", "-b:v", "2M", "-deadline", "realtime", "-cpu-used", "8", "-g", str(FPS_SRC),
            str(path),
        ],
        check=True,
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        parts = []
        for i, seg in enumerate(SEGMENTS):
            p = Path(tmp) / f"seg{i}.webm"
            make_segment(seg, p)
            parts.append(p)
        lst = Path(tmp) / "list.txt"
        lst.write_text("".join(f"file '{p}'\n" for p in parts))
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst),
             "-c", "copy", str(OUT / "recording.webm")],
            check=True,
        )

    ep = lambda t: START_EPOCH + t * 1000  # noqa: E731
    vp = lambda s: {"w": s["vw"], "h": s["vh"], "dpr": DPR}  # noqa: E731

    events = []
    n = 0
    # The resize event (infobar) right at the segment boundary.
    n += 1
    events.append({"id": f"e{n:04d}", "type": "resize", "epoch": ep(3.0), "video_t": 3000.0, "url": "synthetic://", "viewport": vp(SEGMENTS[1])})
    for c in CLICKS:
        n += 1
        s = seg_at(c["t"])
        events.append({
            "id": f"e{n:04d}", "type": "click", "epoch": ep(c["t"]), "video_t": c["t"] * 1000, "url": "synthetic://",
            "viewport": vp(s), "x": c["x"], "y": c["y"],
            "target": {"tag": "div", "identifiers": {"testid": f"target-{n}", "css_path": "div", "used": "testid"},
                       "bbox": {"x": c["x"] - SQ, "y": c["y"] - SQ, "w": 2 * SQ, "h": 2 * SQ}, "sensitive": False},
        })
    events.sort(key=lambda e: e["epoch"])

    tracks = []
    t = 0.0
    while t <= 6.0 + 1e-9:
        s = seg_at(t)
        tracks.append({
            "epoch": ep(t), "video_t": round(t * 1000, 1), "viewport": vp(s),
            "boxes": [{"key": "t:bar", "kind": "member-id", "x": BAR["x"], "y": bar_y(t), "w": BAR["w"], "h": BAR["h"]}],
        })
        t += 0.25

    capture = {
        "source": "getDisplayMedia",
        "video_start_epoch": START_EPOCH,
        "first_chunk_epoch": START_EPOCH + 1000,
        "first_chunk_latency_ms": 1000,
        "mime_type": "video/webm;codecs=vp8",
        "initial_viewport": vp(SEGMENTS[0]),
        "track_settings_start": {"width": 720 * DPR, "height": 450 * DPR, "frameRate": 30},
        "frame_sizes": [
            {"epoch": ep(0), "video_t": 0, "width": 720 * DPR, "height": 450 * DPR},
            {"epoch": ep(3.0), "video_t": 3000, "width": 720 * DPR, "height": 420 * DPR},
        ],
        "user_agent": "synthetic",
    }

    (OUT / "events.json").write_text(json.dumps(events, indent=1))
    (OUT / "sensitive_tracks.json").write_text(json.dumps(tracks))
    (OUT / "capture.json").write_text(json.dumps(capture, indent=1))
    (OUT / "frames").mkdir(exist_ok=True)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
