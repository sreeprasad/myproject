// Element identity for the live guide: does a learner's event hit the recorded element, and where is that
// element on the current page? Same priority as recording: data-testid → ARIA role + accessible name → CSS path.
import { accessibleName, roleOf } from "./identity.ts";
import type { ElementIdentifiers } from "./types.ts";

type Ids = Partial<ElementIdentifiers> | undefined | null;

/** Pure: is `live` the same element as `recorded`? The highest-priority identifier the recording has decides. */
export function sameElement(live: Ids, recorded: Ids): boolean {
  if (!live || !recorded) return false;
  if (recorded.testid) return live.testid === recorded.testid;
  if (recorded.role && recorded.name) return live.role === recorded.role && live.name === recorded.name;
  return !!recorded.css_path && live.css_path === recorded.css_path;
}

/** Pure: path of a URL (pages are matched by path, never by host: Vercel preview URLs differ per deploy). */
export function pathOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url, "http://x").pathname;
  } catch {
    return null;
  }
}

const CANDIDATES =
  "a[href], button, input, select, textarea, label, summary, [role], [tabindex], [data-testid]";

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none";
}

/** DOM: find the recorded element on the current page, or null. Skips anything inside [data-showme-ignore]. */
export function findTarget(doc: Document, ids: Ids): Element | null {
  if (!ids) return null;
  const ok = (el: Element | null) => !!el && !el.closest("[data-showme-ignore]");
  if (ids.testid) {
    const el = doc.querySelector(`[data-testid="${CSS.escape(ids.testid)}"]`);
    return ok(el) ? el : null;
  }
  if (ids.role && ids.name) {
    for (const el of Array.from(doc.querySelectorAll(CANDIDATES))) {
      if (!ok(el) || !isVisible(el)) continue;
      if (roleOf(el) === ids.role && accessibleName(el) === ids.name) return el;
    }
    return null;
  }
  if (ids.css_path) {
    try {
      const el = doc.querySelector(ids.css_path);
      return ok(el) ? el : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** DOM: what to spotlight. Tiny controls (checkboxes, radios) get their whole label so the ring is visible. */
export function spotlightElement(el: Element): Element {
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  if (el.tagName === "INPUT" && (type === "checkbox" || type === "radio")) return el.closest("label") ?? el;
  return el;
}
