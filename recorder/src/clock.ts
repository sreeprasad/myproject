// One timeline for every context (page, service worker, offscreen document):
// epoch ms = performance.timeOrigin + performance.now().
export function nowEpoch(): number {
  return performance.timeOrigin + performance.now();
}

export function toVideoT(epoch: number, videoStartEpoch: number): number {
  return Math.round((epoch - videoStartEpoch) * 1000) / 1000;
}
