"""Synthetic Workflow A event log in the exact shape the recorder emits (for segmentation/judge tests)."""

from __future__ import annotations

BASE = "https://myproject.vercel.app"


def _ps(url: str, headings: list[str], fields: list[tuple[str, bool]] | None = None, status: list[str] | None = None) -> dict:
    return {
        "url": url, "title": "LumenCare", "headings": headings, "buttons": [], "links": [],
        "fields": [{"label": l, "filled": f} for l, f in (fields or [])], "status_texts": status or [],
    }


def _target(tag: str, testid: str | None, role: str | None, name: str | None, *, label=None, text=None,
            sensitive=False, input_type=None, bbox=(100, 100, 120, 32)) -> dict:
    ids = {"css_path": f"main > {tag}"}
    if testid:
        ids["testid"] = testid
    if role:
        ids["role"] = role
    if name:
        ids["name"] = name
    ids["used"] = "testid" if testid else ("role_name" if role and name else "css_path")
    t = {"tag": tag, "identifiers": ids, "bbox": dict(zip("xywh", bbox)), "sensitive": sensitive}
    if label:
        t["label"] = label
    if text:
        t["text"] = text
    if input_type:
        t["input_type"] = input_type
    return t


def workflow_a_events() -> list[dict]:
    appts = f"{BASE}/appointments"
    checkin = f"{BASE}/check-in/p01"
    ps_list = _ps(appts, ["Today's Appointments"], [("Search appointments", False)])
    ps_form = _ps(checkin, ["Patient Check-In"], [("Confirm phone number", True), ("Insurance plan", True), ("Member ID", True),
                                                   ("ID verified", False), ("Consent signed", False), ("Visit reason", False),
                                                   ("Room assignment", False)])
    ev: list[dict] = []

    def add(type_: str, t: float, url: str, **kw) -> dict:
        e = {"id": f"e{len(ev) + 1:04d}", "type": type_, "epoch": 1_000_000 + t, "t": t, "url": url,
             "viewport": {"w": 1728, "h": 781, "dpr": 2}, **kw}
        ev.append(e)
        return e

    search = _target("input", "appointments-search", "searchbox", "Search appointments", label="Search appointments", input_type="search")
    add("click", 900, appts, x=1400, y=262, target=search, page_state=ps_list, frames={"before": "frames/e0001_before.jpg", "after": "frames/e0001_after.jpg"})
    for i, t in enumerate(range(1300, 2300, 120)):  # typing "Quintero" (masked: free text)
        add("input", t, appts, target=search, value_masked=True, **({"frames": {"before": "frames/e0002_before.jpg"}} if i == 0 else {}))
    add("scroll", 2500, appts, scroll={"x": 0, "y": 40})
    # misclick on empty table space
    add("click", 3100, appts, x=700, y=600, target=_target("td", None, None, None), page_state=ps_list)
    link = _target("a", "check-in-p01", "link", "Check in", text="Check in")
    add("click", 3800, appts, x=1555, y=353, target=link, page_state=ps_list)
    add("navigation", 3870, checkin, page_state=ps_form)
    # label click → synthetic input click → change
    label = _target("label", None, None, None, text="ID verified")
    add("click", 6000, checkin, x=480, y=819, target=label, page_state=ps_form)
    idv = _target("input", "check-in-id-verified", "checkbox", "ID verified", label="ID verified", input_type="checkbox")
    add("click", 6004, checkin, x=480, y=819, target=idv)
    add("checkbox", 6006, checkin, target=idv, value=True, page_state=ps_form)
    cons = _target("input", "check-in-consent-signed", "checkbox", "Consent signed", label="Consent signed", input_type="checkbox")
    add("click", 7000, checkin, x=418, y=855, target=cons, page_state=ps_form)
    add("checkbox", 7003, checkin, target=cons, value=True, page_state=ps_form)
    reason = _target("select", "check-in-visit-reason", "combobox", "Visit reason", label="Visit reason", input_type="select")
    add("click", 8000, checkin, x=600, y=973, target=reason, page_state=ps_form)
    add("select", 9500, checkin, target=reason, value="Annual physical", page_state=ps_form)
    room = _target("select", "check-in-room", "combobox", "Room assignment", label="Room assignment", input_type="select")
    add("click", 10500, checkin, x=1300, y=973, target=room, page_state=ps_form)
    add("select", 11400, checkin, target=room, value="Room 3", page_state=ps_form)
    add("resize", 11600, checkin)
    done = _target("button", "check-in-complete", "button", "Complete check-in", text="Complete check-in")
    add("click", 12500, checkin, x=1500, y=1049, target=done, page_state=ps_form)
    add("navigation", 12560, appts, page_state=_ps(appts, ["Today's Appointments"], status=["Checked in · Waiting – Room 3"]))
    return ev
