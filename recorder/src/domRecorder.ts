// Records DOM events and sensitive-element tracks in the page. Emits everything immediately to the host;
// keeps no state that must survive a page load.
import { nowEpoch } from "./clock.ts";
import { identifiersOf, interactiveTarget } from "./identity.ts";
import { summarizePageState } from "./pageState.ts";
import { findSensitiveElements, labelFor, normalizeText, sensitiveKind } from "./sensitive.ts";
import type { EventType, RecordedEvent, Rect, TargetInfo, TrackSample, Viewport } from "./types.ts";

export interface RecorderHost {
  emitEvent(e: RecordedEvent): void;
  emitTrack(s: TrackSample): void;
}

export interface DomRecorderOptions {
  trackIntervalMs?: number; // default 250
  scrollIdleMs?: number; // stop rAF sampling this long after the last scroll (default 150)
  idPrefix?: string; // keeps ids unique across page loads (extension)
}

const IGNORE = "[data-showme-ignore]";

export function viewportNow(): Viewport {
  return { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Pure: may this value be stored? Sensitive never; free text never; choices and numeric fields yes. */
export function isSafeValue(opts: { sensitive: boolean; tag: string; type?: string; inputMode?: string }): boolean {
  if (opts.sensitive) return false;
  if (opts.tag === "SELECT") return true;
  const t = (opts.type ?? "").toLowerCase();
  if (["checkbox", "radio", "range", "number"].includes(t)) return true;
  const im = (opts.inputMode ?? "").toLowerCase();
  return im === "numeric" || im === "decimal";
}

function targetInfo(el: Element): TargetInfo {
  const kind = sensitiveKind(el);
  const isForm = ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName);
  const info: TargetInfo = {
    tag: el.tagName.toLowerCase(),
    identifiers: identifiersOf(el),
    bbox: rectOf(el),
    sensitive: kind !== null,
  };
  if (isForm) {
    info.label = labelFor(el) || undefined;
    info.input_type = (el.getAttribute("type") ?? el.tagName.toLowerCase()).toLowerCase();
  } else if (!kind && !el.querySelector("[data-sensitive]")) {
    const t = normalizeText((el as HTMLElement).innerText ?? el.textContent ?? "");
    if (t) info.text = t.slice(0, 80);
  }
  return info;
}

export function startDomRecorder(host: RecorderHost, opts: DomRecorderOptions = {}): () => void {
  const trackIntervalMs = opts.trackIntervalMs ?? 250;
  const scrollIdleMs = opts.scrollIdleMs ?? 150;
  const prefix = opts.idPrefix ?? "e";
  let seq = 0;
  const cleanups: (() => void)[] = [];

  const base = (type: EventType): RecordedEvent => ({
    id: `${prefix}${String(++seq).padStart(4, "0")}`,
    type,
    epoch: nowEpoch(),
    url: location.href,
    viewport: viewportNow(),
  });

  const emit = (e: RecordedEvent, withState = true) => {
    if (withState) e.page_state = summarizePageState();
    host.emitEvent(e);
  };

  const on = <K extends keyof WindowEventMap>(type: K, fn: (ev: WindowEventMap[K]) => void, capture = true) => {
    window.addEventListener(type, fn as EventListener, { capture, passive: true });
    cleanups.push(() => window.removeEventListener(type, fn as EventListener, { capture }));
  };

  // --- clicks (pointer position is the click point) ---
  on("click", (ev) => {
    const raw = ev.target as Element | null;
    if (!raw || raw.closest(IGNORE)) return;
    const el = interactiveTarget(raw);
    const e = base("click");
    e.x = ev.clientX;
    e.y = ev.clientY;
    e.target = targetInfo(el);
    emit(e);
  });

  // --- typing: one event per input; value only when safe ---
  on("input", (ev) => {
    const el = ev.target as HTMLInputElement | null;
    if (!el || el.closest(IGNORE)) return;
    const type = (el.type ?? "").toLowerCase();
    if (el.tagName === "SELECT" || type === "checkbox" || type === "radio") return; // handled by change
    const e = base("input");
    e.target = targetInfo(el);
    if (isSafeValue({ sensitive: e.target.sensitive, tag: el.tagName, type, inputMode: el.inputMode })) {
      e.value = el.value;
    } else {
      e.value_masked = true;
    }
    emit(e, false); // page state is captured on the commit (change) and on the next click
  });

  // --- select / checkbox / text commit ---
  on("change", (ev) => {
    const el = ev.target as HTMLInputElement | HTMLSelectElement | null;
    if (!el || el.closest(IGNORE)) return;
    const type = ((el as HTMLInputElement).type ?? "").toLowerCase();
    let e: RecordedEvent;
    if (el.tagName === "SELECT") {
      e = base("select");
      e.target = targetInfo(el);
      if (!e.target.sensitive) {
        const sel = el as HTMLSelectElement;
        e.value = sel.options[sel.selectedIndex]?.text ?? sel.value;
      } else e.value_masked = true;
    } else if (type === "checkbox" || type === "radio") {
      e = base("checkbox");
      e.target = targetInfo(el);
      e.value = (el as HTMLInputElement).checked;
    } else {
      return; // text commits are covered by input events
    }
    emit(e);
  });

  // --- Enter key ---
  on("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.isComposing) return;
    const el = ev.target as Element | null;
    if (!el || el.closest(IGNORE)) return;
    const e = base("enter");
    e.target = targetInfo(interactiveTarget(el));
    emit(e);
  });

  // --- navigation (SPA history + hash + back/forward) ---
  let lastUrl = location.href;
  const navCheck = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    // Let the new route render before summarizing it.
    window.setTimeout(() => emit(base("navigation")), 50);
  };
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args: Parameters<History["pushState"]>) {
    const r = origPush.apply(this, args);
    navCheck();
    return r;
  };
  history.replaceState = function (...args: Parameters<History["replaceState"]>) {
    const r = origReplace.apply(this, args);
    navCheck();
    return r;
  };
  cleanups.push(() => {
    history.pushState = origPush;
    history.replaceState = origReplace;
  });
  on("popstate", navCheck);
  on("hashchange", navCheck);

  // --- sensitive tracks: every 250ms, every scroll event, every frame while scrolling ---
  const keys = new WeakMap<Element, string>();
  let keySeq = 0;
  const keyOf = (el: Element) => {
    let k = keys.get(el);
    if (!k) {
      const tid = el.getAttribute("data-testid");
      k = tid ? `t:${tid}` : `k${++keySeq}`;
      keys.set(el, k);
    }
    return k;
  };
  const sampleTracks = () => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const boxes = findSensitiveElements(document)
      .filter(({ el }) => !el.closest(IGNORE))
      .map(({ el, kind }) => ({ key: keyOf(el), kind, ...rectOf(el) }))
      .filter((b) => b.w > 0 && b.h > 0 && b.x < vw && b.y < vh && b.x + b.w > 0 && b.y + b.h > 0);
    host.emitTrack({ epoch: nowEpoch(), viewport: viewportNow(), boxes });
  };
  sampleTracks();
  const interval = window.setInterval(() => {
    sampleTracks();
    navCheck(); // safety net for routers that bypass the patched history methods
  }, trackIntervalMs);
  cleanups.push(() => window.clearInterval(interval));

  let rafId = 0;
  let lastScroll = 0;
  let lastScrollEvent = 0;
  const rafLoop = () => {
    sampleTracks();
    if (performance.now() - lastScroll < scrollIdleMs) rafId = requestAnimationFrame(rafLoop);
    else rafId = 0;
  };
  on("scroll", () => {
    lastScroll = performance.now();
    sampleTracks();
    if (!rafId) rafId = requestAnimationFrame(rafLoop);
    // Log a scroll event at most every 500ms (segmentation only needs the gesture).
    if (lastScroll - lastScrollEvent > 500) {
      lastScrollEvent = lastScroll;
      const e = base("scroll");
      e.scroll = { x: window.scrollX, y: window.scrollY };
      emit(e, false);
    }
  });
  cleanups.push(() => rafId && cancelAnimationFrame(rafId));

  // --- viewport resize (segment boundary) ---
  on("resize", () => {
    emit(base("resize"), false);
    sampleTracks();
  });

  return () => {
    sampleTracks();
    cleanups.forEach((c) => c());
  };
}
