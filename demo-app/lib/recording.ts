"use client";

// Demo-app recorder: getDisplayMedia (current tab) + the shared /recorder modules.
// The tab stream only feeds a short in-memory frame buffer; no video is recorded or uploaded.
// Uploaded: events.json, capture.json and masked before/after JPEGs.
import {
  CaptureSession,
  TrackStore,
  startDomRecorder,
  viewportNow,
  withT,
  type RecordedEvent,
} from "showme-recorder";

export const BACKEND_URL = (process.env.NEXT_PUBLIC_SHOWME_BACKEND ?? "http://localhost:8000").replace(/\/+$/, "");
// Shared demo token (sent as x-showme-token). It ships in the client bundle, so it only keeps out casual
// traffic; that is acceptable here because all data is invented.
export const BACKEND_TOKEN = process.env.NEXT_PUBLIC_SHOWME_TOKEN ?? "";
const authHeaders = (): HeadersInit => (BACKEND_TOKEN ? { "x-showme-token": BACKEND_TOKEN } : {});

const FRAME_EVENTS = new Set(["click", "select", "checkbox", "navigation", "enter"]);

export interface ActiveRecording {
  startedAt: number;
  stop: () => Promise<FinishedRecording>;
  onStep: (cb: (steps: number) => void) => void;
  onEnded: (cb: () => void) => void;
}

export interface FinishedRecording {
  files: Record<string, Blob>; // name → masked JPEG (frames/…)
  json: { events: unknown; capture: unknown };
}

/** Chrome's "sharing this tab" infobar shrinks the viewport right after capture starts. */
function waitForInfobar(maxMs = 500): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(timer);
      // Give layout one frame to settle after the resize.
      requestAnimationFrame(() => resolve());
    };
    const onResize = () => done();
    const timer = window.setTimeout(done, maxMs);
    window.addEventListener("resize", onResize, { once: true });
  });
}

export async function startRecording(): Promise<ActiveRecording> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("This browser cannot capture the tab (getDisplayMedia missing).");

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 15, max: 30 } }, // frames feed a short screenshot buffer only
    audio: false,
    // Chrome-specific hints: offer this tab first and don't allow switching mid-recording.
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    surfaceSwitching: "exclude",
  } as DisplayMediaStreamOptions);

  const track = stream.getVideoTracks()[0];
  const surface = (track.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface;
  if (surface && surface !== "browser") {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error(`Please pick "This tab" in the picker (you chose a ${surface}). Click positions only line up for tab capture.`);
  }

  await waitForInfobar();

  const tracks = new TrackStore();
  const events: RecordedEvent[] = [];
  const pending: Promise<void>[] = [];
  const files: Record<string, Blob> = {};
  let steps = 0;
  let stepCb: (n: number) => void = () => {};
  let endedCb: () => void = () => {};
  let lastInput: { key: string; epoch: number } | null = null;

  const session = new CaptureSession(stream, {
    source: "getDisplayMedia",
    viewport: viewportNow(),
    trackAt: (epoch) => tracks.nearest(epoch),
  });
  await session.start();

  const wantsFrames = (e: RecordedEvent) => {
    if (FRAME_EVENTS.has(e.type)) return true;
    if (e.type !== "input") return false;
    // Only the first keystroke of a typing burst gets frames.
    const key = e.target?.identifiers.testid ?? e.target?.identifiers.css_path ?? "";
    const first = !lastInput || lastInput.key !== key || e.epoch - lastInput.epoch > 1500;
    lastInput = { key, epoch: e.epoch };
    return first;
  };

  const stopDom = startDomRecorder({
    emitTrack: (s) => tracks.add(s),
    emitEvent: (e) => {
      events.push(e);
      if (["click", "select", "checkbox", "enter"].includes(e.type)) stepCb(++steps);
      if (!wantsFrames(e)) return;
      pending.push(
        session.frames.beforeAfter(e.epoch).then(({ before, after }) => {
          e.frames = {};
          if (before) {
            e.frames.before = `frames/${e.id}_before.jpg`;
            files[e.frames.before] = before;
          }
          if (after) {
            e.frames.after = `frames/${e.id}_after.jpg`;
            files[e.frames.after] = after;
          }
        }),
      );
    },
  });

  // The user can also stop from Chrome's "Stop sharing" bar.
  track.addEventListener("ended", () => endedCb());

  let stopped: Promise<FinishedRecording> | null = null;
  const stop = () => {
    if (stopped) return stopped;
    stopped = (async () => {
      stopDom();
      await Promise.allSettled(pending);
      const capture = session.stop();
      const start = capture.start_epoch;
      return {
        files,
        json: {
          // Events before capture started (none expected) are dropped.
          events: withT(events, start).filter((e) => e.t >= 0),
          capture: { ...capture, frame_sizes: withT(capture.frame_sizes, start) },
        },
      };
    })();
    return stopped;
  };

  return {
    startedAt: Date.now(),
    stop,
    onStep: (cb) => (stepCb = cb),
    onEnded: (cb) => (endedCb = cb),
  };
}

export async function uploadRecording(rec: FinishedRecording): Promise<string> {
  const form = new FormData();
  form.append("events", new Blob([JSON.stringify(rec.json.events, null, 1)], { type: "application/json" }), "events.json");
  form.append("capture", new Blob([JSON.stringify(rec.json.capture, null, 1)], { type: "application/json" }), "capture.json");
  for (const [name, blob] of Object.entries(rec.files)) form.append("frames", blob, name.replace(/^frames\//, ""));
  const res = await fetch(`${BACKEND_URL}/recordings`, { method: "POST", body: form, headers: authHeaders() });
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

export interface RecordingStatus {
  state: "uploaded" | "building_steps" | "steps_ready" | "error" | "unknown";
  counts?: { events: number; candidates: number; kept: number };
  error?: string;
  note?: string | null;
}

export async function getStatus(id: string): Promise<RecordingStatus> {
  const res = await fetch(`${BACKEND_URL}/recordings/${id}/status`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`status: HTTP ${res.status}`);
  return (await res.json()) as RecordingStatus;
}

const tokenQuery = () => (BACKEND_TOKEN ? `?token=${encodeURIComponent(BACKEND_TOKEN)}` : "");

export function fileUrl(id: string, name: string): string {
  return `${BACKEND_URL}/recordings/${id}/files/${name}${tokenQuery()}`;
}

export function stepsUrl(id: string): string {
  return `${BACKEND_URL}/recordings/${id}/steps${tokenQuery()}`;
}
