"""SEGMENT: raw recorder events → candidate steps (deterministic, no model).

Merges:
  - consecutive keystrokes in one field (and the click that focused it, and an Enter that submits it) → "type"
  - a click that leads to a navigation within NAV_WINDOW_MS → one "click" step with navigates_to
  - label click + synthetic input click + checkbox change → one "toggle" on the checkbox
  - click that opens a <select> + its change → one "select"
Drops resize events; scroll events are counted on the following step (context only).
"""

from __future__ import annotations

from typing import Any

NAV_WINDOW_MS = 2000
SYNTHETIC_CLICK_MS = 120  # label click → browser-generated click on the control
TYPE_GAP_MS = 6000  # keystrokes further apart start a new "type" step
SELECT_OPEN_MS = 30000  # time a user may spend with a dropdown open
TOGGLE_AFTER_CLICK_MS = 400

Event = dict[str, Any]


def target_key(e: Event | None) -> str | None:
    """Stable identity of an event's element (same priority as the recorder: testid → role+name → CSS path)."""
    if not e or not e.get("target"):
        return None
    ids = e["target"].get("identifiers") or {}
    if ids.get("testid"):
        return f"testid:{ids['testid']}"
    if ids.get("role") and ids.get("name"):
        return f"role:{ids['role']}|{ids['name']}"
    return f"css:{ids.get('css_path', '')}"


def _t(e: Event) -> float:
    return float(e.get("t", e.get("video_t", e.get("epoch", 0))))  # video_t: pre-2026-10-24 recordings


class _Step:
    def __init__(self, kind: str, first: Event):
        self.kind = kind
        self.events: list[Event] = [first]
        self.target_event: Event | None = first if first.get("target") else None
        self.navigates_to: str | None = None
        self.after_state: dict | None = None
        self.submitted = False
        self.scrolls_before = 0

    @property
    def start(self) -> float:
        return _t(self.events[0])

    @property
    def end(self) -> float:
        return _t(self.events[-1])

    @property
    def key(self) -> str | None:
        return target_key(self.target_event)

    def add(self, e: Event, retarget: bool = False) -> None:
        self.events.append(e)
        if retarget and e.get("target"):
            self.target_event = e


def _is_label_click(e: Event) -> bool:
    return e.get("type") == "click" and (e.get("target") or {}).get("tag") == "label"


def segment(events: list[Event]) -> list[dict]:
    evs = sorted((e for e in events if e.get("type") != "resize"), key=_t)
    steps: list[_Step] = []
    pending_scrolls = 0

    def last() -> _Step | None:
        return steps[-1] if steps else None

    def new(kind: str, e: Event) -> None:
        nonlocal pending_scrolls
        s = _Step(kind, e)
        s.scrolls_before = pending_scrolls
        pending_scrolls = 0
        steps.append(s)

    for e in evs:
        typ = e.get("type")
        L = last()
        if typ == "scroll":
            pending_scrolls += 1
            continue

        if typ == "navigation":
            if L and L.kind in ("click", "type", "select", "toggle") and L.navigates_to is None and _t(e) - L.end <= NAV_WINDOW_MS:
                L.add(e)
                L.navigates_to = e.get("url")
                L.after_state = e.get("page_state")
            else:
                new("navigate", e)
                steps[-1].navigates_to = e.get("url")
                steps[-1].after_state = e.get("page_state")
            continue

        if typ == "input":
            k = target_key(e)
            if L and L.kind == "type" and L.key == k and _t(e) - L.end <= TYPE_GAP_MS:
                L.add(e)
            elif L and L.kind == "click" and L.key == k and L.navigates_to is None and _t(e) - L.end <= TYPE_GAP_MS:
                L.kind = "type"  # the click just focused the field
                L.add(e, retarget=True)
            else:
                new("type", e)
            continue

        if typ == "enter":
            if L and L.kind == "type" and L.key == target_key(e):
                L.add(e)
                L.submitted = True
            else:
                new("click", e)  # Enter on a button/link behaves like a click
            continue

        if typ in ("select", "checkbox"):
            kind = "select" if typ == "select" else "toggle"
            k = target_key(e)
            if L and L.kind == "click" and L.navigates_to is None and (
                (L.key == k and _t(e) - L.end <= (SELECT_OPEN_MS if kind == "select" else TOGGLE_AFTER_CLICK_MS))
                or (any(_is_label_click(x) for x in L.events) and _t(e) - L.end <= TOGGLE_AFTER_CLICK_MS)
            ):
                L.kind = kind
                L.add(e, retarget=True)
            elif L and L.kind == kind and L.key == k and _t(e) - L.end <= TOGGLE_AFTER_CLICK_MS:
                L.add(e)  # duplicate change event
            else:
                new(kind, e)
            continue

        if typ == "click":
            if L and L.kind == "click" and L.navigates_to is None and _t(e) - L.end <= SYNTHETIC_CLICK_MS:
                # browser-generated follow-up click (label → control): keep the control as the target
                L.add(e, retarget=bool((e.get("target") or {}).get("identifiers", {}).get("testid")))
            elif L and L.kind in ("toggle", "select") and L.key == target_key(e) and _t(e) - L.end <= SYNTHETIC_CLICK_MS:
                L.add(e)
            else:
                new("click", e)
            continue

    return [_finish(s, i, steps) for i, s in enumerate(steps)]


def _first_with(events: list[Event], key: str, sub: str) -> str | None:
    for e in events:
        v = (e.get(key) or {}).get(sub)
        if v:
            return v
    return None


def _finish(s: _Step, i: int, all_steps: list[_Step]) -> dict:
    nxt = all_steps[i + 1] if i + 1 < len(all_steps) else None
    prev = all_steps[i - 1] if i > 0 else None

    # Page state just before the action: the first event's own snapshot (clicks are captured before their
    # default action runs), else what the previous step left behind.
    before = next((e.get("page_state") for e in s.events if e.get("page_state")), None)
    if before is None and prev is not None:
        before = prev.after_state or next((e.get("page_state") for e in reversed(prev.events) if e.get("page_state")), None)

    # Page state after: navigation/change snapshots are post-action; otherwise the next step's "before".
    after = s.after_state
    if after is None and s.events[-1].get("type") in ("select", "checkbox", "navigation"):
        after = s.events[-1].get("page_state")
    if after is None and nxt is not None:
        after = next((e.get("page_state") for e in nxt.events if e.get("page_state")), None)
    if after is None:
        after = next((e.get("page_state") for e in reversed(s.events) if e.get("page_state")), None)

    te = s.target_event or {}
    target = te.get("target")
    value: Any = None
    value_masked = False
    last_valued = next((e for e in reversed(s.events) if "value" in e or e.get("value_masked")), None)
    if last_valued is not None:
        value_masked = bool(last_valued.get("value_masked"))
        value = None if value_masked else last_valued.get("value")

    frames_before = next((e["frames"]["before"] for e in s.events if (e.get("frames") or {}).get("before")), None)
    frames_after = next((e["frames"]["after"] for e in reversed(s.events) if (e.get("frames") or {}).get("after")), None)

    click = next((e for e in s.events if e.get("type") == "click" and e.get("x") is not None), None)
    return {
        "id": f"s{i + 1:02d}",
        "index": i,
        "action": s.kind,
        "t_start": round(s.start, 1),  # ms since capture start
        "t_end": round(s.end, 1),
        "event_ids": [e["id"] for e in s.events],
        "url": s.events[0].get("url"),
        "navigates_to": s.navigates_to,
        "submitted": s.submitted,
        "scrolls_before": s.scrolls_before,
        "target": target,
        "click_point": {"x": click["x"], "y": click["y"]} if click else None,
        "value": value,
        "value_masked": value_masked,
        "before_state": before,
        "after_state": after,
        "frames": {"before": frames_before, "after": frames_after},
    }
