// One timeline for every context (page, service worker, offscreen document):
// epoch ms = performance.timeOrigin + performance.now().
export function nowEpoch(): number {
  return performance.timeOrigin + performance.now();
}

/** ms since capture start, 0.1 ms precision. */
export function relT(epoch: number, startEpoch: number): number {
  return Math.round((epoch - startEpoch) * 10) / 10;
}

export function withT<T extends { epoch: number }>(items: T[], startEpoch: number): (T & { t: number })[] {
  return items.map((i) => ({ ...i, t: relT(i.epoch, startEpoch) }));
}
