import type { PageState } from "./types.ts";
import { labelFor, normalizeText, sensitiveKind } from "./sensitive.ts";

const IGNORE = "[data-showme-ignore]";

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0;
}

/** Text of an element with any data-sensitive descendants removed. */
function safeText(el: Element): string {
  if (el.closest("[data-sensitive]")) return "";
  if (!el.querySelector("[data-sensitive]")) return normalizeText(el.textContent ?? "");
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll("[data-sensitive]").forEach((n) => n.replaceWith("[redacted]"));
  return normalizeText(clone.textContent ?? "");
}

function collect(selector: string, limit: number): string[] {
  const out: string[] = [];
  for (const el of Array.from(document.querySelectorAll(selector))) {
    if (el.closest(IGNORE) || !visible(el)) continue;
    const t = safeText(el);
    if (t && !out.includes(t)) out.push(t.slice(0, 80));
    if (out.length >= limit) break;
  }
  return out;
}

/** Compact, sensitive-free description of what is on screen. */
export function summarizePageState(): PageState {
  const fields: PageState["fields"] = [];
  for (const el of Array.from(document.querySelectorAll("input, select, textarea"))) {
    if (el.closest(IGNORE) || !visible(el)) continue;
    const input = el as HTMLInputElement;
    const type = (input.type ?? "").toLowerCase();
    if (type === "hidden" || type === "search") continue;
    const label = sensitiveKind(el) && !labelFor(el) ? "[sensitive field]" : labelFor(el) || "(unlabeled)";
    const filled = type === "checkbox" || type === "radio" ? input.checked : String(input.value ?? "").trim() !== "";
    fields.push({ label: label.slice(0, 60), filled });
    if (fields.length >= 30) break;
  }

  const dialogEl = Array.from(document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog]")).find(
    (d) => !d.closest(IGNORE) && visible(d),
  );
  let dialog: string | undefined;
  if (dialogEl) {
    const labelled = dialogEl.getAttribute("aria-labelledby");
    const titleEl = labelled ? document.getElementById(labelled) : dialogEl.querySelector("h1, h2, h3");
    dialog = titleEl ? safeText(titleEl) : dialogEl.getAttribute("aria-label") ?? "dialog";
  }

  return {
    url: location.href,
    title: document.title,
    headings: collect("h1, h2, h3", 8),
    buttons: collect("button, [role=button], input[type=submit]", 20),
    links: collect("a[href]", 20),
    fields,
    dialog,
    status_texts: collect("[role=status] > *, [role=alert], .toast, [aria-live] > *", 5),
  };
}
