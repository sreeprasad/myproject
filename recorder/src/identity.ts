import type { ElementIdentifiers, IdentifierKind } from "./types.ts";
import { labelFor, normalizeText, sensitiveKind } from "./sensitive.ts";

const IMPLICIT_ROLES: Record<string, string> = {
  BUTTON: "button",
  A: "link",
  SELECT: "combobox",
  TEXTAREA: "textbox",
  H1: "heading",
  H2: "heading",
  H3: "heading",
  LI: "listitem",
  NAV: "navigation",
  TR: "row",
};

export function roleOf(el: Element): string | undefined {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  if (el.tagName === "A" && !el.hasAttribute("href")) return undefined;
  if (el.tagName === "INPUT") {
    const t = (el.getAttribute("type") ?? "text").toLowerCase();
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "submit" || t === "button" || t === "reset") return "button";
    if (t === "range") return "slider";
    if (t === "search") return "searchbox";
    return "textbox";
  }
  return IMPLICIT_ROLES[el.tagName];
}

/**
 * Accessible name, simplified. Returns undefined when the element is sensitive or its name would
 * contain sensitive content, so identifiers never carry patient data.
 */
export function accessibleName(el: Element): string | undefined {
  if (sensitiveKind(el)) return undefined;
  const tag = el.tagName;
  let name = "";
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    name = labelFor(el);
  } else {
    name = el.getAttribute("aria-label") ?? "";
    if (!name) {
      if (el.querySelector("[data-sensitive]")) return undefined;
      name = normalizeText((el as HTMLElement).innerText ?? el.textContent ?? "");
    }
  }
  name = name.trim();
  if (!name || name.length > 80) return name ? name.slice(0, 80) : undefined;
  return name;
}

export function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1 && cur.tagName !== "HTML") {
    let part = cur.tagName.toLowerCase();
    if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
      parts.unshift(`${part}#${cur.id}`);
      break;
    }
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    cur = parent;
  }
  return parts.join(" > ");
}

/** Pure: which identifier wins, in priority order data-testid → role + accessible name → CSS path. */
export function pickIdentifier(ids: { testid?: string; role?: string; name?: string }): IdentifierKind {
  if (ids.testid) return "testid";
  if (ids.role && ids.name) return "role_name";
  return "css_path";
}

export function identifiersOf(el: Element): ElementIdentifiers {
  const testid = el.getAttribute("data-testid") ?? undefined;
  const role = roleOf(el);
  const name = role ? accessibleName(el) : undefined;
  const ids = { testid, role, name, css_path: cssPath(el) };
  return { ...ids, used: pickIdentifier(ids) };
}

/** The element a user "meant": nearest interactive ancestor of the event target. */
export function interactiveTarget(el: Element): Element {
  return (
    el.closest(
      "button, a[href], input, select, textarea, label, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [role=option], [data-testid]",
    ) ?? el
  );
}
