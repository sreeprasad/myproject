// Pure helpers for sensitive tracks: nearest-sample lookup, box scaling and interpolation.
import type { Rect, TrackBox, TrackSample } from "./types.ts";

/** Index of the sample whose epoch is nearest to `epoch` (samples sorted by epoch). -1 if empty. */
export function nearestIndex<T extends { epoch: number }>(items: T[], epoch: number): number {
  if (items.length === 0) return -1;
  let lo = 0;
  let hi = items.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].epoch < epoch) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(items[lo - 1].epoch - epoch) <= Math.abs(items[lo].epoch - epoch)) return lo - 1;
  return lo;
}

export function nearest<T extends { epoch: number }>(items: T[], epoch: number): T | undefined {
  const i = nearestIndex(items, epoch);
  return i < 0 ? undefined : items[i];
}

/** Append-only store kept sorted by epoch. */
export class TrackStore {
  readonly samples: TrackSample[] = [];
  add(s: TrackSample) {
    const arr = this.samples;
    let i = arr.length;
    while (i > 0 && arr[i - 1].epoch > s.epoch) i--;
    arr.splice(i, 0, s);
  }
  nearest(epoch: number): TrackSample | undefined {
    return nearest(this.samples, epoch);
  }
}

/**
 * Scale boxes from viewport CSS px to a target pixel space (a frame, or the source video), then pad.
 * scaleX = targetW / viewportW, scaleY = targetH / viewportH. Result is clamped to the target.
 */
export function scaleBoxes(
  boxes: Rect[],
  viewport: { w: number; h: number },
  target: { w: number; h: number },
  padPx = 8,
): Rect[] {
  const sx = target.w / viewport.w;
  const sy = target.h / viewport.h;
  return boxes.map((b) => {
    const x0 = Math.max(0, b.x * sx - padPx);
    const y0 = Math.max(0, b.y * sy - padPx);
    const x1 = Math.min(target.w, (b.x + b.w) * sx + padPx);
    const y1 = Math.min(target.h, (b.y + b.h) * sy + padPx);
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  });
}

/**
 * Boxes at time t (any monotonic clock shared by samples, e.g. video_t), linearly interpolated
 * between the bracketing samples. A box present only in the earlier sample is held until the next
 * sample (blur from first to last sample in which it is visible). Samples must be sorted by `time`.
 */
export function interpolateBoxes(
  samples: { time: number; boxes: TrackBox[] }[],
  t: number,
): TrackBox[] {
  if (samples.length === 0) return [];
  if (t < samples[0].time) return [];
  let i = 0;
  while (i + 1 < samples.length && samples[i + 1].time <= t) i++;
  const a = samples[i];
  const b = samples[i + 1];
  if (!b) return a.boxes;
  const f = (t - a.time) / Math.max(1e-6, b.time - a.time);
  const next = new Map(b.boxes.map((x) => [x.key, x]));
  return a.boxes.map((box) => {
    const nb = next.get(box.key);
    if (!nb) return box;
    return {
      ...box,
      x: box.x + (nb.x - box.x) * f,
      y: box.y + (nb.y - box.y) * f,
      w: box.w + (nb.w - box.w) * f,
      h: box.h + (nb.h - box.h) * f,
    };
  });
}
