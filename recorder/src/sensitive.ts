// Sensitive-field detection. DOM marking (data-sensitive) always wins; heuristics add coverage on real sites.

const LABEL_PATTERNS: [RegExp, string][] = [
  [/\bmrn\b|medical record/i, "mrn"],
  [/\bdob\b|date of birth|birth ?date/i, "dob"],
  [/\bssn\b|social security/i, "ssn"],
  [/member ?id|subscriber ?id|policy ?(number|no)/i, "member-id"],
  [/api[ _-]?key|secret|access[ _-]?token|\btoken\b/i, "secret"],
  [/password|passcode/i, "password"],
  [/phone|mobile|\btel\b/i, "phone"],
];

const AUTOCOMPLETE_KINDS: [RegExp, string][] = [
  [/^cc-/, "card"],
  [/^tel/, "phone"],
  [/^email$/, "email"],
  [/^bday/, "dob"],
  [/password/, "password"],
];

/** Pure: classify from attribute/label strings. Returns the kind, or null if not sensitive. */
export function classifySensitive(input: {
  dataSensitive?: string | null;
  type?: string | null;
  autocomplete?: string | null;
  label?: string | null;
}): string | null {
  if (input.dataSensitive !== undefined && input.dataSensitive !== null) return input.dataSensitive || "marked";
  if ((input.type ?? "").toLowerCase() === "password") return "password";
  const ac = (input.autocomplete ?? "").toLowerCase().trim();
  if (ac) {
    for (const token of ac.split(/\s+/)) {
      for (const [re, kind] of AUTOCOMPLETE_KINDS) if (re.test(token)) return kind;
    }
  }
  const label = input.label ?? "";
  if (label) for (const [re, kind] of LABEL_PATTERNS) if (re.test(label)) return kind;
  return null;
}

const FORM_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function labelFor(el: Element): string {
  const doc = el.ownerDocument;
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const t = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ")
      .trim();
    if (t) return t;
  }
  if (el.id) {
    const l = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (l?.textContent) return normalizeText(l.textContent);
  }
  const wrapping = el.closest("label");
  if (wrapping?.textContent) return normalizeText(wrapping.textContent);
  const ph = el.getAttribute("placeholder");
  return ph ? ph.trim() : "";
}

export function sensitiveKind(el: Element): string | null {
  // An element inside a data-sensitive container is sensitive too.
  const marked = el.closest("[data-sensitive]");
  if (marked) return marked.getAttribute("data-sensitive") || "marked";
  if (!FORM_TAGS.has(el.tagName)) return null;
  return classifySensitive({
    dataSensitive: null,
    type: el.getAttribute("type"),
    autocomplete: el.getAttribute("autocomplete"),
    label: labelFor(el),
  });
}

/** All sensitive elements currently in the document (DOM-marked + detected form fields). */
export function findSensitiveElements(doc: Document): { el: Element; kind: string }[] {
  const out: { el: Element; kind: string }[] = [];
  const seen = new Set<Element>();
  doc.querySelectorAll("[data-sensitive]").forEach((el) => {
    seen.add(el);
    out.push({ el, kind: el.getAttribute("data-sensitive") || "marked" });
  });
  doc.querySelectorAll("input, textarea").forEach((el) => {
    if (seen.has(el) || el.closest("[data-sensitive]")) return;
    const kind = sensitiveKind(el);
    if (kind) out.push({ el, kind });
  });
  return out;
}

export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
