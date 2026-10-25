"use client";

import { useEffect, useRef, useState } from "react";
import {
  fileUrl,
  getStatus,
  startRecording,
  uploadRecording,
  type ActiveRecording,
  type FinishedRecording,
  type RecordingStatus,
} from "@/lib/recording.ts";

const PROC_LABEL: Record<string, string> = {
  uploaded: "Uploaded…",
  normalizing: "Normalizing video…",
  normalized: "Normalized",
  rendering_debug: "Rendering debug video…",
  debug_ready: "Debug video ready",
  error: "Processing failed",
};

type State =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "recording"; rec: ActiveRecording }
  | { kind: "uploading" }
  | { kind: "done"; id: string }
  | { kind: "error"; message: string; retry?: FinishedRecording };

// Everything inside data-showme-ignore is excluded from events, page state and sensitive tracks.
export function RecorderPanel() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const [steps, setSteps] = useState(0);
  const stopping = useRef(false);

  useEffect(() => {
    if (state.kind !== "recording") return;
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - state.rec.startedAt) / 1000)), 250);
    return () => window.clearInterval(t);
  }, [state]);

  // After upload, poll processing status until it settles.
  const [proc, setProc] = useState<RecordingStatus | null>(null);
  useEffect(() => {
    if (state.kind !== "done") {
      setProc(null);
      return;
    }
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const s = await getStatus(state.id);
        if (cancelled) return;
        setProc(s);
        if (s.state === "debug_ready" || s.state === "error" || (s.state === "normalized" && s.note)) return;
      } catch {
        /* transient; keep polling */
      }
      timer = window.setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [state]);

  async function start() {
    stopping.current = false;
    setSteps(0);
    setElapsed(0);
    setState({ kind: "starting" });
    try {
      const rec = await startRecording();
      rec.onStep(setSteps);
      rec.onEnded(() => void stop(rec));
      setState({ kind: "recording", rec });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState(msg.includes("Permission denied") ? { kind: "idle" } : { kind: "error", message: msg });
    }
  }

  async function stop(rec: ActiveRecording) {
    if (stopping.current) return;
    stopping.current = true;
    setState({ kind: "uploading" });
    let finished: FinishedRecording | undefined;
    try {
      finished = await rec.stop();
      const id = await uploadRecording(finished);
      setState({ kind: "done", id });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e), retry: finished });
    }
  }

  async function retry(rec: FinishedRecording) {
    setState({ kind: "uploading" });
    try {
      setState({ kind: "done", id: await uploadRecording(rec) });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e), retry: rec });
    }
  }

  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div className="recorder" data-showme-ignore="" aria-label="ShowMe recorder">
      {state.kind === "idle" && (
        <button type="button" className="rec-btn" onClick={start}>
          <span className="rec-dot" aria-hidden="true" /> Record
        </button>
      )}
      {state.kind === "starting" && <span className="rec-note">Pick “This tab”, then Share…</span>}
      {state.kind === "recording" && (
        <>
          <span className="rec-live">
            <span className="rec-dot pulse" aria-hidden="true" /> REC {mmss}
          </span>
          <span className="rec-note">{steps} steps</span>
          <button type="button" className="rec-btn stop" onClick={() => stop(state.rec)}>
            Stop
          </button>
        </>
      )}
      {state.kind === "uploading" && <span className="rec-note">Saving recording…</span>}
      {state.kind === "done" && (
        <>
          <span className="rec-note" title={state.id}>
            {proc ? PROC_LABEL[proc.state] ?? proc.state : "Uploaded"}
          </span>
          {proc?.state === "debug_ready" && (
            <a className="rec-btn" href={fileUrl(state.id, "debug.mp4")} target="_blank" rel="noreferrer">
              Open debug video
            </a>
          )}
          {proc?.state === "error" && (
            <span className="rec-error" title={proc.error}>
              {(proc.error ?? "").slice(0, 80)}
            </span>
          )}
          <button type="button" className="rec-btn" onClick={() => setState({ kind: "idle" })}>
            New
          </button>
        </>
      )}
      {state.kind === "error" && (
        <>
          <span className="rec-error" title={state.message}>
            {state.message.length > 90 ? state.message.slice(0, 90) + "…" : state.message}
          </span>
          {state.retry && (
            <button type="button" className="rec-btn" onClick={() => retry(state.retry!)}>
              Retry upload
            </button>
          )}
          <button type="button" className="rec-btn" onClick={() => setState({ kind: "idle" })}>
            Close
          </button>
        </>
      )}
    </div>
  );
}
