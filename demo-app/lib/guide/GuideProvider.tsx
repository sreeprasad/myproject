"use client";

// Live guide controller: loads steps.json, listens to the learner's DOM events (same recorder code as capture),
// advances DOM-first, and asks Clef only when idle / off track / the target can't be found.
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  completeStep,
  currentStep,
  isFinished,
  isIdle,
  onEvent,
  startDomRecorder,
  startGuide,
  stepPath,
  summarizePageState,
  type GuideState,
  type GuideStep,
  type RecordedEvent,
} from "showme-recorder";
import { useStore } from "@/lib/store.tsx";
import { checkWithClef, getSteps, latestReadyRecording, type CheckResult, type StepsDoc } from "./api.ts";

const IDLE_MS = 10_000; // mirrors thresholds.json guide_idle_seconds (the server returns it too)
const TYPING_PAUSE_MS = 1_500;
const CLEF_MIN_GAP_MS = 2_500;
const SESSION_KEY = "showme-guide";

export type Nudge = null | "wrong" | "idle";

interface GuideCtx {
  active: boolean;
  loading: boolean;
  error: string | null;
  doc: StepsDoc | null;
  state: GuideState | null;
  step: GuideStep | null;
  nudge: Nudge;
  clef: CheckResult | null;
  clefBusy: boolean;
  blur: boolean;
  setBlur: (b: boolean) => void;
  start: (recordingId?: string) => Promise<void>;
  restart: () => void;
  exit: () => void;
  reportTargetMissing: (missing: boolean) => void;
}

const Ctx = createContext<GuideCtx | null>(null);

export function useGuide(): GuideCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useGuide must be used inside GuideProvider");
  return v;
}

function elementLabel(e: RecordedEvent): string {
  const t = e.target;
  return (t?.label ?? t?.identifiers.name ?? t?.text ?? t?.identifiers.testid ?? e.type).slice(0, 60);
}

export function GuideProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { dispatch, notify } = useStore();
  const [doc, setDoc] = useState<StepsDoc | null>(null);
  const [state, setState] = useState<GuideState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nudge, setNudge] = useState<Nudge>(null);
  const [clef, setClef] = useState<CheckResult | null>(null);
  const [clefBusy, setClefBusy] = useState(false);
  const [blur, setBlur] = useState(false);

  const stateRef = useRef<GuideState | null>(null);
  stateRef.current = state;
  // Update the ref synchronously so back-to-back events (label click → change) see the latest state.
  const commit = useCallback((next: GuideState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const docRef = useRef<StepsDoc | null>(null);
  docRef.current = doc;
  const recent = useRef<{ type: string; element: string; at: number }[]>([]);
  const lastClefAt = useRef(0);
  const askedIdleFor = useRef<number | null>(null);
  const typingTimer = useRef<number | null>(null);
  const targetMissing = useRef<{ since: number | null; asked: number | null }>({ since: null, asked: null });

  const active = !!state;

  // ---- blur toggle (CSS on [data-sensitive]) ----
  useEffect(() => {
    document.documentElement.classList.toggle("showme-blur", blur);
  }, [blur]);

  // ---- Clef (only when DOM evidence isn't enough) ----
  const askClef = useCallback(async (trigger: CheckResult["trigger"]) => {
    const s = stateRef.current;
    const d = docRef.current;
    const step = s && currentStep(s);
    if (!s || !d || !step) return;
    const now = Date.now();
    if (now - lastClefAt.current < CLEF_MIN_GAP_MS) return;
    lastClefAt.current = now;
    setClefBusy(true);
    try {
      const res = await checkWithClef(d.recording_id, step.number, trigger, {
        path: window.location.pathname,
        page_state: summarizePageState(),
        seconds_on_step: Math.round((now - s.lastProgressAt) / 1000),
        wrong_attempts: s.wrongAttempts,
        recent_actions: recent.current.slice(-8).map((a) => ({ type: a.type, element: a.element, seconds_ago: Math.round((now - a.at) / 1000) })),
      });
      if (!res) return;
      setClef(res);
      const cur = stateRef.current;
      if (cur && currentStep(cur)?.number === res.step_number && res.answers.step_done.noul >= res.thresholds.step_done) {
        commit(completeStep(cur, res.step_number, "clef", Date.now()));
        setNudge(null);
        notify(`Clef confirmed step ${res.step_number}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setClefBusy(false);
    }
  }, [notify, commit]);

  // ---- learner events → engine ----
  const onLearnerEvent = useCallback((e: RecordedEvent) => {
    const s = stateRef.current;
    if (!s || isFinished(s)) return;
    const now = Date.now();
    if (e.type !== "scroll" && e.type !== "resize") recent.current.push({ type: e.type, element: elementLabel(e), at: now });
    const { state: next, outcome } = onEvent(s, e, now);
    commit(next);
    if (outcome.kind === "advanced" || outcome.kind === "early") {
      setNudge(null);
      askedIdleFor.current = null;
      targetMissing.current = { since: null, asked: null };
      if (outcome.kind === "advanced" && outcome.note) notify(`Step ${outcome.step}: ${outcome.note}`);
    } else if (outcome.kind === "typing") {
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
      const el = document.querySelector<HTMLInputElement>(`[data-testid="${CSS.escape(e.target?.identifiers.testid ?? "")}"]`);
      typingTimer.current = window.setTimeout(() => {
        const cur = stateRef.current;
        if (cur && currentStep(cur)?.number === outcome.step && (!el || el.value.trim() !== "")) {
          commit(completeStep(cur, outcome.step, "dom", Date.now()));
          setNudge(null);
        }
      }, TYPING_PAUSE_MS);
    } else if (outcome.kind === "wrong") {
      setNudge("wrong");
      if (next.wrongAttempts >= 2) void askClef("off_track");
    }
  }, [askClef, notify, commit]);

  useEffect(() => {
    if (!active) return;
    const stop = startDomRecorder(
      { emitEvent: onLearnerEvent, emitTrack: () => {} },
      { trackIntervalMs: 60_000, idPrefix: "g" },
    );
    return stop;
  }, [active, onLearnerEvent]);

  // ---- idle + missing-target watchdog ----
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => {
      const s = stateRef.current;
      const step = s && currentStep(s);
      if (!s || !step) return;
      const now = Date.now();
      if (isIdle(s, now, IDLE_MS) && askedIdleFor.current !== step.number) {
        askedIdleFor.current = step.number;
        setNudge("idle");
        void askClef("idle");
      }
      const m = targetMissing.current;
      if (m.since && now - m.since > 3000 && m.asked !== step.number) {
        m.asked = step.number;
        void askClef("ambiguous");
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [active, askClef]);

  const reportTargetMissing = useCallback((missing: boolean) => {
    const m = targetMissing.current;
    if (missing && m.since == null) m.since = Date.now();
    if (!missing) m.since = null;
  }, []);

  // ---- lifecycle ----
  const begin = useCallback((d: StepsDoc) => {
    const kept = d.steps.filter((s) => s.decision?.keep).sort((a, b) => a.number - b.number);
    dispatch({ type: "reset" }); // the demo app starts from a clean state so recorded targets exist again
    recent.current = [];
    lastClefAt.current = 0;
    askedIdleFor.current = null;
    targetMissing.current = { since: null, asked: null };
    setClef(null);
    setNudge(null);
    setError(null);
    setDoc(d);
    commit(startGuide(kept, Date.now()));
    try {
      sessionStorage.setItem(SESSION_KEY, d.recording_id);
    } catch {
      /* ignore */
    }
    const first = kept[0] ? stepPath(kept[0]) : d.start_path;
    if (first && first !== window.location.pathname) router.push(first);
  }, [dispatch, router, commit]);

  const start = useCallback(async (recordingId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const id = recordingId ?? (await latestReadyRecording());
      if (!id) throw new Error("No recording with steps yet. Record a workflow first.");
      begin(await getSteps(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [begin]);

  const restart = useCallback(() => {
    if (docRef.current) begin(docRef.current);
  }, [begin]);

  const exit = useCallback(() => {
    commit(null);
    setDoc(null);
    setClef(null);
    setNudge(null);
    setBlur(false);
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }, [commit]);

  // A mid-guide page change clears a stale "wrong" nudge.
  useEffect(() => {
    setNudge((n) => (n === "wrong" ? null : n));
  }, [pathname]);

  const value = useMemo<GuideCtx>(
    () => ({
      active,
      loading,
      error,
      doc,
      state,
      step: state ? currentStep(state) : null,
      nudge,
      clef,
      clefBusy,
      blur,
      setBlur,
      start,
      restart,
      exit,
      reportTargetMissing,
    }),
    [active, loading, error, doc, state, nudge, clef, clefBusy, blur, start, restart, exit, reportTargetMissing],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
