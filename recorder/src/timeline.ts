// Pure timeline + coordinate math used by the renderer (and tests). No DOM.
//
// Mapping a click from viewport CSS px to the normalized video:
//   1. pick the segment active at video_t (boundaries = resize events + capture frame-size changes)
//   2. source px = x * (videoWidth_segment / viewportWidth_segment)
//   3. normalized px = source px * transform.scale + transform.offset (ffmpeg scale+pad, see transform.json)
import type { CaptureInfo, RecordedEvent, TrackSample, Viewport } from "./types.ts";

export interface Segment {
  start_t: number; // video_t (ms), inclusive
  viewport: Viewport;
  video: { w: number; h: number }; // source capture px
}

export interface NormalizeTransform {
  output: { w: number; h: number };
  fps: number;
  // One entry per distinct source frame size: scale and centered offset into the pinned output.
  sizes: { w: number; h: number; scale: number; offset_x: number; offset_y: number }[];
}

/** Pure: same scale+pad math ffmpeg uses with force_original_aspect_ratio=decrease + centered pad. */
export function fitTransform(src: { w: number; h: number }, out: { w: number; h: number }) {
  const scale = Math.min(out.w / src.w, out.h / src.h);
  return { scale, offset_x: (out.w - src.w * scale) / 2, offset_y: (out.h - src.h * scale) / 2 };
}

export function videoT(epoch: number, videoStartEpoch: number): number {
  return epoch - videoStartEpoch;
}

/** Build viewport/capture segments. Events/tracks/frame sizes must carry epoch; video_t derived here. */
export function buildSegments(
  capture: Pick<CaptureInfo, "video_start_epoch" | "initial_viewport" | "frame_sizes">,
  events: Pick<RecordedEvent, "type" | "epoch" | "viewport">[],
): Segment[] {
  type Change = { t: number; viewport?: Viewport; video?: { w: number; h: number } };
  const changes: Change[] = [];
  for (const f of capture.frame_sizes) {
    changes.push({ t: Math.max(0, videoT(f.epoch, capture.video_start_epoch)), video: { w: f.width, h: f.height } });
  }
  for (const e of events) {
    if (e.type === "resize") changes.push({ t: Math.max(0, videoT(e.epoch, capture.video_start_epoch)), viewport: e.viewport });
  }
  changes.sort((a, b) => a.t - b.t);

  const first = capture.frame_sizes[0];
  let cur: Segment = {
    start_t: 0,
    viewport: capture.initial_viewport,
    video: first ? { w: first.width, h: first.height } : { w: capture.initial_viewport.w, h: capture.initial_viewport.h },
  };
  const segments: Segment[] = [cur];
  for (const c of changes) {
    const next: Segment = { start_t: c.t, viewport: c.viewport ?? cur.viewport, video: c.video ?? cur.video };
    if (next.viewport.w === cur.viewport.w && next.viewport.h === cur.viewport.h && next.video.w === cur.video.w && next.video.h === cur.video.h) continue;
    if (next.start_t <= cur.start_t) {
      segments[segments.length - 1] = { ...next, start_t: cur.start_t };
    } else {
      segments.push(next);
    }
    cur = segments[segments.length - 1];
  }
  return segments;
}

export function segmentAt(segments: Segment[], t: number): Segment {
  let s = segments[0];
  for (const seg of segments) {
    if (seg.start_t <= t) s = seg;
    else break;
  }
  return s;
}

/** Viewport CSS px → normalized output px at video time t. */
export function toOutput(
  pt: { x: number; y: number },
  t: number,
  segments: Segment[],
  transform: NormalizeTransform,
): { x: number; y: number; scale: number } {
  const seg = segmentAt(segments, t);
  const sx = seg.video.w / seg.viewport.w;
  const sy = seg.video.h / seg.viewport.h;
  const tf =
    transform.sizes.find((s) => s.w === seg.video.w && s.h === seg.video.h) ?? {
      ...fitTransform(seg.video, transform.output),
    };
  return {
    x: pt.x * sx * tf.scale + tf.offset_x,
    y: pt.y * sy * tf.scale + tf.offset_y,
    scale: sx * tf.scale, // CSS px → output px (for box sizes and padding)
  };
}

/** Attach video_t to events and track samples (ms relative to the MediaRecorder start). */
export function withVideoT<T extends { epoch: number }>(items: T[], videoStartEpoch: number): (T & { video_t: number })[] {
  return items.map((i) => ({ ...i, video_t: Math.round(videoT(i.epoch, videoStartEpoch) * 10) / 10 }));
}

export type { TrackSample };
