import { test } from "node:test";
import assert from "node:assert/strict";
import { toVideoT } from "../src/clock.ts";
import { classifySensitive } from "../src/sensitive.ts";
import { pickIdentifier } from "../src/identity.ts";
import { isSafeValue } from "../src/domRecorder.ts";
import { pickFrame, BEFORE_OFFSET_MS, AFTER_OFFSET_MS } from "../src/frames.ts";
import { TrackStore, interpolateBoxes, nearest, scaleBoxes } from "../src/tracks.ts";
import { buildSegments, fitTransform, segmentAt, toOutput, withVideoT, type NormalizeTransform } from "../src/timeline.ts";
import type { TrackSample } from "../src/types.ts";

const vp = (w: number, h: number, dpr = 2) => ({ w, h, dpr });

// ---------- clock / video_t ----------
test("video_t = event epoch - video start epoch", () => {
  assert.equal(toVideoT(1_700_000_012_345.5, 1_700_000_010_000), 2345.5);
  const out = withVideoT([{ epoch: 1000.04 }, { epoch: 1500 }], 1000);
  assert.deepEqual(out.map((e) => e.video_t), [0, 500]);
});

// ---------- sensitive detection ----------
test("DOM marking always wins, then type, autocomplete, label heuristics", () => {
  assert.equal(classifySensitive({ dataSensitive: "mrn" }), "mrn");
  assert.equal(classifySensitive({ dataSensitive: "" }), "marked");
  assert.equal(classifySensitive({ type: "password" }), "password");
  assert.equal(classifySensitive({ autocomplete: "cc-number" }), "card");
  assert.equal(classifySensitive({ autocomplete: "section-x tel-national" }), "phone");
  assert.equal(classifySensitive({ autocomplete: "bday" }), "dob");
  assert.equal(classifySensitive({ label: "Patient MRN" }), "mrn");
  assert.equal(classifySensitive({ label: "Date of birth" }), "dob");
  assert.equal(classifySensitive({ label: "Member ID" }), "member-id");
  assert.equal(classifySensitive({ label: "API key" }), "secret");
  assert.equal(classifySensitive({ label: "Visit reason" }), null);
  assert.equal(classifySensitive({ type: "text", autocomplete: "off", label: "Heart rate" }), null);
});

test("values are stored only when safe", () => {
  assert.equal(isSafeValue({ sensitive: true, tag: "SELECT" }), false);
  assert.equal(isSafeValue({ sensitive: false, tag: "SELECT" }), true);
  assert.equal(isSafeValue({ sensitive: false, tag: "INPUT", type: "text" }), false);
  assert.equal(isSafeValue({ sensitive: false, tag: "INPUT", type: "text", inputMode: "decimal" }), true);
  assert.equal(isSafeValue({ sensitive: false, tag: "INPUT", type: "checkbox" }), true);
  assert.equal(isSafeValue({ sensitive: true, tag: "INPUT", type: "tel" }), false);
});

// ---------- element identity priority ----------
test("identifier priority: data-testid → role + accessible name → CSS path", () => {
  assert.equal(pickIdentifier({ testid: "check-in-complete", role: "button", name: "Complete" }), "testid");
  assert.equal(pickIdentifier({ role: "button", name: "Complete check-in" }), "role_name");
  assert.equal(pickIdentifier({ role: "button" }), "css_path");
  assert.equal(pickIdentifier({}), "css_path");
});

// ---------- frames: before/after selection from the ring buffer ----------
test("before = frame nearest t-100ms, after = frame nearest t+600ms", () => {
  const frames = Array.from({ length: 30 }, (_, i) => ({ epoch: 10_000 + i * 66 })); // ~15 fps
  const t = 10_700;
  const before = pickFrame(frames, t + BEFORE_OFFSET_MS)!;
  const after = pickFrame(frames, t + AFTER_OFFSET_MS)!;
  assert.ok(Math.abs(before.epoch - 10_600) <= 33);
  assert.ok(Math.abs(after.epoch - 11_300) <= 33);
  assert.equal(pickFrame([], 5), undefined);
});

test("nearest picks the closer neighbour, ties go to the earlier one", () => {
  const xs = [{ epoch: 0 }, { epoch: 100 }, { epoch: 200 }];
  assert.equal(nearest(xs, 149)!.epoch, 100);
  assert.equal(nearest(xs, 151)!.epoch, 200);
  assert.equal(nearest(xs, 150)!.epoch, 100);
  assert.equal(nearest(xs, -50)!.epoch, 0);
  assert.equal(nearest(xs, 999)!.epoch, 200);
});

// ---------- masking: nearest sample + scaling ----------
test("masking uses the track sample nearest the frame and scales CSS px → frame px with padding", () => {
  const store = new TrackStore();
  const mk = (epoch: number, y: number): TrackSample => ({
    epoch,
    viewport: vp(1440, 800),
    boxes: [{ key: "t:phone", kind: "phone", x: 100, y, w: 200, h: 40 }],
  });
  store.add(mk(1000, 300));
  store.add(mk(1250, 250));
  store.add(mk(1100, 280)); // out-of-order insert stays sorted
  assert.deepEqual(store.samples.map((s) => s.epoch), [1000, 1100, 1250]);
  const s = store.nearest(1230)!;
  assert.equal(s.epoch, 1250);
  // frame is 1280 px wide for a 1440 CSS-px viewport → scale 0.888…
  const [b] = scaleBoxes(s.boxes, s.viewport, { w: 1280, h: 1280 * (800 / 1440) }, 8);
  const k = 1280 / 1440;
  assert.ok(Math.abs(b.x - (100 * k - 8)) < 1e-9);
  assert.ok(Math.abs(b.y - (250 * k - 8)) < 1e-9);
  assert.ok(Math.abs(b.w - (200 * k + 16)) < 1e-9);
  assert.ok(Math.abs(b.h - (40 * k + 16)) < 1e-9);
});

test("scaled boxes are clamped to the frame", () => {
  const [b] = scaleBoxes([{ x: -20, y: 790, w: 100, h: 50 }], { w: 1000, h: 800 }, { w: 500, h: 400 }, 8);
  assert.equal(b.x, 0);
  assert.equal(b.y + b.h, 400);
});

// ---------- blur box interpolation ----------
test("boxes interpolate linearly between samples and hold when missing from the next sample", () => {
  const samples = [
    { time: 0, boxes: [{ key: "a", kind: "mrn", x: 0, y: 100, w: 50, h: 20 }, { key: "b", kind: "dob", x: 10, y: 10, w: 10, h: 10 }] },
    { time: 100, boxes: [{ key: "a", kind: "mrn", x: 0, y: 50, w: 50, h: 20 }] },
  ];
  const mid = interpolateBoxes(samples, 50);
  assert.equal(mid.find((b) => b.key === "a")!.y, 75);
  assert.equal(mid.find((b) => b.key === "b")!.y, 10); // held until next sample
  const after = interpolateBoxes(samples, 150);
  assert.deepEqual(after.map((b) => b.key), ["a"]); // gone after the last sample without it
  assert.deepEqual(interpolateBoxes(samples, -1), []);
});

// ---------- per-segment coordinate scaling ----------
const transform: NormalizeTransform = {
  output: { w: 2880, h: 1600 },
  fps: 30,
  sizes: [
    { w: 2880, h: 1600, ...fitTransform({ w: 2880, h: 1600 }, { w: 2880, h: 1600 }) },
    { w: 2880, h: 1500, ...fitTransform({ w: 2880, h: 1500 }, { w: 2880, h: 1600 }) },
  ],
};

test("fitTransform matches ffmpeg scale(decrease) + centered pad", () => {
  assert.deepEqual(fitTransform({ w: 2880, h: 1500 }, { w: 2880, h: 1600 }), { scale: 1, offset_x: 0, offset_y: 50 });
  const t = fitTransform({ w: 1920, h: 1200 }, { w: 1280, h: 720 });
  assert.equal(t.scale, 0.6);
  assert.equal(t.offset_x, (1280 - 1152) / 2);
});

test("click mapping uses the segment active at video_t, including a mid-recording resize", () => {
  const capture = {
    video_start_epoch: 10_000,
    initial_viewport: vp(1440, 800),
    frame_sizes: [
      { epoch: 10_000, width: 2880, height: 1600 },
      { epoch: 15_020, width: 2880, height: 1500 }, // capture shrinks when the viewport does
    ],
  };
  const events = [{ type: "resize" as const, epoch: 15_000, viewport: vp(1440, 750) }];
  const segs = buildSegments(capture, events);
  assert.equal(segs.length, 3);
  assert.equal(segmentAt(segs, 4_999).viewport.h, 800);
  assert.equal(segmentAt(segs, 5_010).viewport.h, 750);
  assert.equal(segmentAt(segs, 6_000).video.h, 1500);

  // Before the resize: dpr 2, no padding.
  const p1 = toOutput({ x: 100, y: 200 }, 1_000, segs, transform);
  assert.deepEqual([p1.x, p1.y], [200, 400]);
  // After the resize: 2880x1500 source padded into 2880x1600 → +50 px vertical offset.
  const p2 = toOutput({ x: 100, y: 200 }, 6_000, segs, transform);
  assert.deepEqual([p2.x, p2.y], [200, 450]);
});

test("buildSegments with no changes is a single segment", () => {
  const segs = buildSegments(
    { video_start_epoch: 0, initial_viewport: vp(1280, 720, 1), frame_sizes: [{ epoch: 0, width: 1280, height: 720 }] },
    [],
  );
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0].video, { w: 1280, h: 720 });
});
