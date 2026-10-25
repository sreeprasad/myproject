import { test } from "node:test";
import assert from "node:assert/strict";
import { relT, withT } from "../src/clock.ts";
import { classifySensitive } from "../src/sensitive.ts";
import { pickIdentifier } from "../src/identity.ts";
import { isSafeValue } from "../src/domRecorder.ts";
import { pickFrame, BEFORE_OFFSET_MS, AFTER_OFFSET_MS } from "../src/frames.ts";
import { TrackStore, nearest, scaleBoxes } from "../src/tracks.ts";
import type { TrackSample } from "../src/types.ts";

const vp = (w: number, h: number, dpr = 2) => ({ w, h, dpr });

// ---------- clock ----------
test("t = event epoch - capture start epoch", () => {
  assert.equal(relT(1_700_000_012_345.5, 1_700_000_010_000), 2345.5);
  const out = withT([{ epoch: 1000.04 }, { epoch: 1500 }], 1000);
  assert.deepEqual(out.map((e) => e.t), [0, 500]);
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
