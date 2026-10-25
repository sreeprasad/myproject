import { test } from "node:test";
import assert from "node:assert/strict";
import { completeStep, currentStep, isFinished, isIdle, onEvent, startGuide, stepPath, type GuideStep } from "../src/guide.ts";

const BASE = "https://myproject-six-green.vercel.app"; // learner host differs from the recording's preview host
const REC = "https://myproject-n1sht0165-x.vercel.app";
const ids = (testid: string, role: string, name: string) => ({ identifiers: { testid, role, name, css_path: "x" } });
const ps = (url: string) => ({ url, title: "", headings: [], buttons: [], links: [], fields: [], status_texts: [] });

const steps: GuideStep[] = [
  { number: 1, id: "s01", action: "click", title: "Start patient check-in", narration: "", url: `${REC}/appointments`, navigates_to: `${REC}/check-in/p01`, target: ids("check-in-p01", "link", "Check in"), before_state: ps(`${REC}/appointments`) },
  { number: 2, id: "s02", action: "toggle", value: true, title: "Verify patient ID", narration: "", url: `${REC}/check-in/p01`, navigates_to: null, target: ids("check-in-id-verified", "checkbox", "ID verified"), before_state: ps(`${REC}/check-in/p01`) },
  { number: 3, id: "s03", action: "toggle", value: true, title: "Confirm consent", narration: "", url: `${REC}/check-in/p01`, navigates_to: null, target: ids("check-in-consent-signed", "checkbox", "Consent signed"), before_state: ps(`${REC}/check-in/p01`) },
  { number: 4, id: "s04", action: "select", value: "Annual physical", title: "Select visit reason", narration: "", url: `${REC}/check-in/p01`, navigates_to: null, target: ids("check-in-visit-reason", "combobox", "Visit reason"), before_state: ps(`${REC}/check-in/p01`) },
  { number: 5, id: "s05", action: "type", title: "Add a note", narration: "", url: `${REC}/check-in/p01`, navigates_to: null, target: ids("check-in-note", "textbox", "Note"), before_state: ps(`${REC}/check-in/p01`) },
  { number: 6, id: "s06", action: "click", title: "Complete the check-in", narration: "", url: `${REC}/check-in/p01`, navigates_to: `${REC}/appointments`, target: ids("check-in-complete", "button", "Complete check-in"), before_state: ps(`${REC}/check-in/p01`) },
];
const ev = (type: string, testid: string | null, url: string, value?: string | boolean) => ({
  type: type as never, url, value,
  target: testid ? { tag: "x", identifiers: { testid, css_path: "y", used: "testid" as const }, bbox: { x: 0, y: 0, w: 1, h: 1 }, sensitive: false } : undefined,
});

test("steps happen on paths, not hosts", () => {
  assert.equal(stepPath(steps[0]), "/appointments");
  assert.equal(stepPath(steps[1]), "/check-in/p01");
});

test("the right click advances, by DOM", () => {
  let s = startGuide(steps, 0);
  const r = onEvent(s, ev("click", "check-in-p01", `${BASE}/appointments`), 100);
  assert.deepEqual(r.outcome, { kind: "advanced", step: 1, note: undefined });
  s = r.state;
  assert.equal(currentStep(s)?.number, 2);
  assert.equal(s.done[1].by, "dom");
});

test("toggles need the recorded checked state", () => {
  let s = startGuide(steps, 0);
  s = completeStep(s, 1, "dom", 1);
  assert.equal(onEvent(s, ev("checkbox", "check-in-id-verified", `${BASE}/check-in/p01`, false), 2).outcome.kind, "wrong");
  assert.equal(onEvent(s, ev("checkbox", "check-in-id-verified", `${BASE}/check-in/p01`, true), 3).outcome.kind, "advanced");
});

test("a later step on the same page done first counts early; pointer stays, then skips it", () => {
  let s = startGuide(steps, 0);
  s = completeStep(s, 1, "dom", 1);
  let r = onEvent(s, ev("checkbox", "check-in-consent-signed", `${BASE}/check-in/p01`, true), 2);
  assert.deepEqual(r.outcome, { kind: "early", step: 3 });
  assert.equal(currentStep(r.state)?.number, 2);
  r = onEvent(r.state, ev("checkbox", "check-in-id-verified", `${BASE}/check-in/p01`, true), 3);
  assert.equal(currentStep(r.state)?.number, 4); // 3 was already done
});

test("navigating steps are never completed early, and clicking a pending step's target isn't a mistake", () => {
  let s = startGuide(steps, 0);
  s = completeStep(s, 1, "dom", 1);
  const r = onEvent(s, ev("click", "check-in-complete", `${BASE}/check-in/p01`), 2);
  assert.equal(r.outcome.kind, "ignored");
  assert.equal(currentStep(r.state)?.number, 2);
  assert.equal(r.state.wrongAttempts, 0);
});

test("label clicks and opening the current dropdown are part of doing the step, not wrong", () => {
  let s = startGuide(steps, 0);
  s = completeStep(s, 1, "dom", 1);
  const label = { ...ev("click", null, `${BASE}/check-in/p01`), target: { tag: "label", identifiers: { css_path: "label", used: "css_path" as const }, bbox: { x: 0, y: 0, w: 1, h: 1 }, sensitive: false } };
  assert.equal(onEvent(s, label, 2).outcome.kind, "ignored");
  for (const n of [2, 3]) s = completeStep(s, n, "dom", n);
  assert.equal(onEvent(s, ev("click", "check-in-visit-reason", `${BASE}/check-in/p01`), 5).outcome.kind, "ignored");
});

test("selects advance with any option but note a different choice", () => {
  let s = startGuide(steps, 0);
  for (const n of [1, 2, 3]) s = completeStep(s, n, "dom", n);
  const r = onEvent(s, ev("select", "check-in-visit-reason", `${BASE}/check-in/p01`, "Vaccination"), 5);
  assert.equal(r.outcome.kind, "advanced");
  assert.match(r.state.done[4].note ?? "", /Vaccination.*Annual physical/);
});

test("typing is partial until the host completes it (pause) or Enter", () => {
  let s = startGuide(steps, 0);
  for (const n of [1, 2, 3, 4]) s = completeStep(s, n, "dom", n);
  let r = onEvent(s, ev("input", "check-in-note", `${BASE}/check-in/p01`), 10);
  assert.deepEqual(r.outcome, { kind: "typing", step: 5 });
  assert.equal(r.state.lastProgressAt, 10);
  r = onEvent(r.state, ev("enter", "check-in-note", `${BASE}/check-in/p01`), 11);
  assert.equal(r.outcome.kind, "advanced");
});

test("wrong clicks count, then reset on progress; non-interactive events are ignored", () => {
  let s = startGuide(steps, 0);
  s = onEvent(s, ev("click", "nav-patients", `${BASE}/appointments`), 1).state;
  s = onEvent(s, ev("click", "nav-patients", `${BASE}/appointments`), 2).state;
  assert.equal(s.wrongAttempts, 2);
  assert.equal(onEvent(s, ev("scroll", null, `${BASE}/appointments`), 3).outcome.kind, "ignored");
  s = onEvent(s, ev("click", "check-in-p01", `${BASE}/appointments`), 4).state;
  assert.equal(s.wrongAttempts, 0);
});

test("Clef can complete a step; finishing and idleness", () => {
  let s = startGuide(steps, 0);
  assert.equal(isIdle(s, 9_999, 10_000), false);
  assert.equal(isIdle(s, 10_000, 10_000), true);
  s = completeStep(s, 1, "clef", 5);
  assert.equal(s.done[1].by, "clef");
  for (const n of [2, 3, 4, 5, 6]) s = completeStep(s, n, "dom", 6 + n);
  assert.equal(isFinished(s), true);
  assert.equal(currentStep(s), null);
  assert.equal(isIdle(s, 1e9, 10_000), false);
});
