// Pixel-level alignment check for a normalized recording (no browser needed).
// For every click: map (x, y, video_t) through the same timeline math the renderer uses, grab that
// pixel from normalized.mp4 at that time, and check it is the magenta target square.
// Also checks the sensitive bar's interpolated box sits on the cyan bar.
//
// Usage (from repo root):  node --experimental-strip-types fixtures/verify_alignment.ts [recording-id]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildSegments, toOutput } from "../recorder/src/timeline.ts";
import { interpolateBoxes } from "../recorder/src/tracks.ts";

const id = process.argv[2] ?? "synthetic-alignment";
const dir = path.join(process.env.SHOWME_DATA_DIR ?? path.join(import.meta.dirname, "..", "data"), id);
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const transform = read("transform.json");
const capture = read("capture.json");
const events = read("events.json");
const tracks = read("sensitive_tracks.json");
const segments = buildSegments(capture, events);

function pixel(tMs: number, x: number, y: number): [number, number, number] {
  const ts = Math.max(0, (tMs - (transform.source_start_ms ?? 0)) / 1000);
  const buf = execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-ss", ts.toFixed(3), "-i", path.join(dir, "normalized.mp4"),
    "-frames:v", "1", "-vf", `format=rgb24,crop=2:2:${Math.round(x)}:${Math.round(y)}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
  return [buf[0], buf[1], buf[2]];
}

const near = (a: [number, number, number], b: [number, number, number], tol = 60) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
let failures = 0;

for (const e of events.filter((e: { type: string }) => e.type === "click")) {
  const p = toOutput({ x: e.x, y: e.y }, e.video_t, segments, transform);
  const px = pixel(e.video_t, p.x, p.y);
  const ok = near(px, [255, 0, 255]);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} click ${e.id} t=${e.video_t}ms css(${e.x},${e.y}) → out(${p.x.toFixed(1)},${p.y.toFixed(1)}) rgb=${px.join(",")}`);
}

const samples = tracks.map((s: { video_t: number; boxes: unknown[] }) => ({ time: s.video_t, boxes: s.boxes }));
for (const t of [500, 1600, 1750, 2300, 4000]) {
  for (const b of interpolateBoxes(samples, t)) {
    const c = toOutput({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, t, segments, transform);
    const px = pixel(t, c.x, c.y);
    const ok = near(px, [0, 229, 255]);
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} sensitive ${b.key} t=${t}ms centre → out(${c.x.toFixed(1)},${c.y.toFixed(1)}) rgb=${px.join(",")}`);
  }
}

console.log(failures ? `\n${failures} alignment check(s) failed` : "\nall alignment checks passed");
process.exit(failures ? 1 : 0);
