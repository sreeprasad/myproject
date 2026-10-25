// Live guide progression: pure, framework-agnostic logic shared by the demo app and (later) the extension.
// DOM-first: a step is done when the learner's own event hits the recorded element with the same kind of action.
// The model (Clef) is only consulted by the host for ambiguous / idle / off-track moments.
import { pathOf, sameElement } from "./match.ts";
import type { ElementIdentifiers, PageState, RecordedEvent } from "./types.ts";

/** The subset of a steps.json step the guide uses. */
export interface GuideStep {
  number: number;
  id: string;
  action: "click" | "type" | "select" | "toggle" | "navigate" | string;
  title: string | null;
  narration: string | null;
  url: string | null;
  navigates_to: string | null;
  submitted?: boolean;
  value?: string | boolean | null;
  value_masked?: boolean;
  target: { identifiers?: Partial<ElementIdentifiers>; bbox?: { x: number; y: number; w: number; h: number }; label?: string; text?: string } | null;
  before_state?: PageState | null;
  after_state?: PageState | null;
}

export type DoneBy = "dom" | "clef";

export interface GuideState {
  steps: GuideStep[];
  done: Record<number, { by: DoneBy; at: number; note?: string }>;
  current: number; // index into steps of the first step not done; === steps.length when finished
  startedAt: number;
  lastProgressAt: number;
  wrongAttempts: number; // on the current step
  lastWrongAt: number | null;
}

export type Outcome =
  | { kind: "advanced"; step: number; note?: string }
  | { kind: "early"; step: number } // a later step done before the current one
  | { kind: "typing"; step: number } // keystrokes in the right field; host completes it on pause/Enter
  | { kind: "wrong" }
  | { kind: "ignored" };

export function startGuide(steps: GuideStep[], now: number): GuideState {
  return { steps, done: {}, current: 0, startedAt: now, lastProgressAt: now, wrongAttempts: 0, lastWrongAt: null };
}

export function currentStep(s: GuideState): GuideStep | null {
  return s.steps[s.current] ?? null;
}

export function isFinished(s: GuideState): boolean {
  return s.current >= s.steps.length;
}

/** Path where a step happens (where the learner must be to do it). */
export function stepPath(step: GuideStep): string | null {
  return pathOf(step.before_state?.url ?? step.url);
}

function nextCurrent(s: GuideState): number {
  let i = s.current;
  while (i < s.steps.length && s.done[s.steps[i].number]) i++;
  return i;
}

function markDone(s: GuideState, number: number, by: DoneBy, now: number, note?: string): GuideState {
  const done = { ...s.done, [number]: { by, at: now, ...(note ? { note } : {}) } };
  const next = { ...s, done };
  const cur = nextCurrent(next);
  const advanced = cur !== s.current;
  return { ...next, current: cur, lastProgressAt: now, wrongAttempts: advanced ? 0 : s.wrongAttempts, lastWrongAt: advanced ? null : s.lastWrongAt };
}

/** Does this learner event complete `step`? Returns a note when it completes it with a different choice. */
export function eventCompletes(step: GuideStep, ev: Pick<RecordedEvent, "type" | "url" | "value" | "target">): { ok: boolean; partial?: boolean; note?: string } {
  const recorded = step.target?.identifiers;
  const live = ev.target?.identifiers;
  switch (step.action) {
    case "navigate":
      return { ok: ev.type === "navigation" && pathOf(ev.url) === pathOf(step.navigates_to) };
    case "toggle":
      return { ok: ev.type === "checkbox" && sameElement(live, recorded) && ev.value === (step.value ?? true) };
    case "select": {
      if (ev.type !== "select" || !sameElement(live, recorded)) return { ok: false };
      const differs = step.value != null && ev.value != null && ev.value !== step.value;
      return { ok: true, note: differs ? `chose "${ev.value}" (recording used "${step.value}")` : undefined };
    }
    case "type":
      if (ev.type === "enter" && sameElement(live, recorded)) return { ok: true };
      return { ok: false, partial: ev.type === "input" && sameElement(live, recorded) };
    default: // click (and Enter on a button/link)
      return { ok: (ev.type === "click" || ev.type === "enter") && sameElement(live, recorded) };
  }
}

const WRONG_TYPES = new Set(["click", "select", "checkbox", "enter"]);

/**
 * Feed one learner event. Order of checks:
 *  1. completes the current step → advance
 *  2. completes a later, not-yet-done step on the same page (non-navigating) → done early, keep pointing at current
 *  3. typing into the current step's field → "typing" (host finishes it after a pause, or on Enter)
 *  4. an interactive action that matched nothing → wrong attempt (host may ask Clef)
 */
export function onEvent(s: GuideState, ev: Pick<RecordedEvent, "type" | "url" | "value" | "target">, now: number): { state: GuideState; outcome: Outcome } {
  const cur = currentStep(s);
  if (!cur) return { state: s, outcome: { kind: "ignored" } };

  const r = eventCompletes(cur, ev);
  if (r.ok) return { state: markDone(s, cur.number, "dom", now, r.note), outcome: { kind: "advanced", step: cur.number, note: r.note } };

  const here = pathOf(ev.url);
  for (let i = s.current + 1; i < s.steps.length; i++) {
    const st = s.steps[i];
    if (s.done[st.number] || st.navigates_to || st.action === "navigate") continue;
    if (stepPath(st) !== here) continue;
    if (eventCompletes(st, ev).ok) return { state: markDone(s, st.number, "dom", now), outcome: { kind: "early", step: st.number } };
  }

  if (r.partial) return { state: { ...s, lastProgressAt: now }, outcome: { kind: "typing", step: cur.number } };

  // Clicks that are part of doing a step are not mistakes: a <label> click (the browser follows it with the
  // control's own event), or a click that opens/focuses the target of the current or any pending step.
  if (ev.type === "click" && ev.target) {
    if (ev.target.tag === "label") return { state: s, outcome: { kind: "ignored" } };
    const pendingTargets = s.steps.slice(s.current).filter((st) => !s.done[st.number]).map((st) => st.target?.identifiers);
    if (pendingTargets.some((ids) => sameElement(ev.target!.identifiers, ids))) return { state: s, outcome: { kind: "ignored" } };
  }

  if (WRONG_TYPES.has(ev.type) && ev.target) {
    return { state: { ...s, wrongAttempts: s.wrongAttempts + 1, lastWrongAt: now }, outcome: { kind: "wrong" } };
  }
  return { state: s, outcome: { kind: "ignored" } };
}

/** Host-driven completion: typing paused with a non-empty field, or Clef said step_done ≥ threshold. */
export function completeStep(s: GuideState, number: number, by: DoneBy, now: number): GuideState {
  if (s.done[number]) return s;
  return markDone(s, number, by, now);
}

export function isIdle(s: GuideState, now: number, idleMs: number): boolean {
  return !isFinished(s) && now - s.lastProgressAt >= idleMs;
}
