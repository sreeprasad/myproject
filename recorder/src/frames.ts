// ALL frame logic, shared by the demo-app fallback (getDisplayMedia) and the extension's offscreen
// document (tabCapture): ring buffer, before/after selection, masking, JPEG encoding, MediaRecorder
// epoch bookkeeping and capture.json data. Input is a MediaStream; no Chrome extension APIs.
import { nowEpoch } from "./clock.ts";
import { nearest, scaleBoxes } from "./tracks.ts";
import type { CaptureInfo, TrackSample, Viewport } from "./types.ts";

export interface BufferedFrame {
  epoch: number;
  bitmap: ImageBitmap;
  width: number; // bitmap px (downscaled)
  height: number;
}

/** Pure: frame for "before" (nearest t-100ms) or any target time. */
export function pickFrame<T extends { epoch: number }>(frames: T[], targetEpoch: number): T | undefined {
  return nearest(frames, targetEpoch);
}

export const BEFORE_OFFSET_MS = -100;
export const AFTER_OFFSET_MS = 600;

export interface FrameCaptureOptions {
  maxWidth?: number; // JPEG width (default 1280)
  bufferMs?: number; // ring buffer length (default 1500)
  sampleEveryMs?: number; // buffer sampling interval (default 66 ≈ 15 fps)
  jpegQuality?: number; // default 0.8
  padPx?: number; // mask padding in output px (default 8)
  /** Sensitive-box sample nearest to an epoch (viewport CSS px). */
  trackAt: (epoch: number) => TrackSample | undefined;
}

export class FrameCapture {
  private video: HTMLVideoElement;
  private frames: BufferedFrame[] = [];
  private running = false;
  private lastSample = 0;
  private opts: Required<Omit<FrameCaptureOptions, "trackAt">> & Pick<FrameCaptureOptions, "trackAt">;
  onFrameSize?: (w: number, h: number) => void;

  constructor(stream: MediaStream, opts: FrameCaptureOptions) {
    this.opts = { maxWidth: 1280, bufferMs: 1500, sampleEveryMs: 66, jpegQuality: 0.8, padPx: 8, ...opts };
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    // Keep it in the DOM (some Chrome builds throttle detached videos) but invisible and off-screen.
    v.setAttribute("data-showme-ignore", "");
    Object.assign(v.style, { position: "fixed", left: "-10000px", top: "0", width: "2px", height: "2px", opacity: "0", pointerEvents: "none" });
    v.addEventListener("resize", () => this.onFrameSize?.(v.videoWidth, v.videoHeight));
    this.video = v;
  }

  get videoSize() {
    return { w: this.video.videoWidth, h: this.video.videoHeight };
  }

  async start(): Promise<void> {
    document.body.appendChild(this.video);
    await this.video.play();
    if (!this.video.videoWidth) await new Promise((r) => this.video.addEventListener("loadedmetadata", r, { once: true }));
    this.running = true;
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (v.requestVideoFrameCallback) {
      const loop = () => {
        if (!this.running) return;
        void this.sample();
        v.requestVideoFrameCallback!(loop);
      };
      v.requestVideoFrameCallback(loop);
    }
    // Static pages produce no new video frames; keep the buffer fresh anyway.
    const tick = () => {
      if (!this.running) return;
      void this.sample();
      window.setTimeout(tick, this.opts.sampleEveryMs);
    };
    tick();
  }

  private async sample() {
    const t = nowEpoch();
    if (t - this.lastSample < this.opts.sampleEveryMs * 0.8) return;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return;
    this.lastSample = t;
    const scale = Math.min(1, this.opts.maxWidth / vw);
    const width = Math.round(vw * scale);
    const height = Math.round(vh * scale);
    const bitmap = await createImageBitmap(this.video, { resizeWidth: width, resizeHeight: height, resizeQuality: "medium" });
    this.frames.push({ epoch: t, bitmap, width, height });
    const cutoff = nowEpoch() - this.opts.bufferMs;
    while (this.frames.length > 2 && this.frames[0].epoch < cutoff) this.frames.shift()!.bitmap.close();
  }

  /** Masked JPEG of the buffered frame nearest to `epoch`. */
  async jpegAt(epoch: number): Promise<Blob | null> {
    const f = pickFrame(this.frames, epoch);
    if (!f) return null;
    return this.encode(f);
  }

  /** before = frame nearest t-100ms (now); after = frame nearest t+600ms (waits until it exists). */
  async beforeAfter(eventEpoch: number): Promise<{ before: Blob | null; after: Blob | null }> {
    const before = await this.jpegAt(eventEpoch + BEFORE_OFFSET_MS);
    const wait = eventEpoch + AFTER_OFFSET_MS + this.opts.sampleEveryMs - nowEpoch();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const after = await this.jpegAt(eventEpoch + AFTER_OFFSET_MS);
    return { before, after };
  }

  private async encode(f: BufferedFrame): Promise<Blob> {
    const canvas = new OffscreenCanvas(f.width, f.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(f.bitmap, 0, 0);
    const sample = this.opts.trackAt(f.epoch);
    if (sample && sample.boxes.length) {
      ctx.fillStyle = "#1f2933";
      for (const b of scaleBoxes(sample.boxes, sample.viewport, { w: f.width, h: f.height }, this.opts.padPx)) {
        ctx.fillRect(b.x, b.y, b.w, b.h);
      }
    }
    return canvas.convertToBlob({ type: "image/jpeg", quality: this.opts.jpegQuality });
  }

  stop() {
    this.running = false;
    this.frames.forEach((f) => f.bitmap.close());
    this.frames = [];
    this.video.srcObject = null;
    this.video.remove();
  }
}

export interface CaptureSessionOptions extends FrameCaptureOptions {
  source: CaptureInfo["source"];
  viewport: Viewport;
  timesliceMs?: number;
  videoBitsPerSecond?: number;
}

/** MediaRecorder + FrameCapture + capture.json bookkeeping for one recording. */
export class CaptureSession {
  readonly frames: FrameCapture;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  readonly info: CaptureInfo;
  private stream: MediaStream;
  private opts: CaptureSessionOptions;

  constructor(stream: MediaStream, opts: CaptureSessionOptions) {
    this.stream = stream;
    this.opts = opts;
    this.frames = new FrameCapture(stream, opts);
    const settings = stream.getVideoTracks()[0]?.getSettings() ?? {};
    this.info = {
      source: opts.source,
      video_start_epoch: 0,
      mime_type: "",
      initial_viewport: opts.viewport,
      track_settings_start: { width: settings.width, height: settings.height, frameRate: settings.frameRate },
      frame_sizes: [],
      user_agent: navigator.userAgent,
    };
    this.frames.onFrameSize = (width, height) => {
      const last = this.info.frame_sizes[this.info.frame_sizes.length - 1];
      if (!last || last.width !== width || last.height !== height) {
        this.info.frame_sizes.push({ epoch: nowEpoch(), width, height });
      }
    };
  }

  /** Resolves at the MediaRecorder "start" event with video_start_epoch. */
  async start(): Promise<number> {
    await this.frames.start();
    const { w, h } = this.frames.videoSize;
    if (this.info.frame_sizes.length === 0) this.info.frame_sizes.push({ epoch: nowEpoch(), width: w, height: h });

    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    this.info.mime_type = mime;
    const rec = new MediaRecorder(this.stream, {
      mimeType: mime || undefined,
      videoBitsPerSecond: this.opts.videoBitsPerSecond ?? 5_000_000,
    });
    this.recorder = rec;
    rec.ondataavailable = (ev) => {
      if (ev.data.size === 0) return;
      if (this.chunks.length === 0) {
        this.info.first_chunk_epoch = nowEpoch();
        this.info.first_chunk_latency_ms = Math.round(this.info.first_chunk_epoch - this.info.video_start_epoch);
      }
      this.chunks.push(ev.data);
    };
    return new Promise((resolve, reject) => {
      rec.onstart = () => {
        this.info.video_start_epoch = nowEpoch();
        resolve(this.info.video_start_epoch);
      };
      rec.onerror = (e) => reject(e);
      rec.start(this.opts.timesliceMs ?? 1000);
    });
  }

  async stop(): Promise<{ video: Blob; capture: CaptureInfo }> {
    const rec = this.recorder;
    if (rec && rec.state !== "inactive") {
      await new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
        rec.stop();
      });
    }
    this.info.stop_epoch = nowEpoch();
    this.frames.stop();
    this.stream.getTracks().forEach((t) => t.stop());
    return { video: new Blob(this.chunks, { type: this.info.mime_type || "video/webm" }), capture: this.info };
  }
}
