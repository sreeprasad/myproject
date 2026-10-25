# ShowMe

Record a web workflow once, then ShowMe coaches anyone through it **live, inside the real app**: it spotlights the next
element, shows a hint, confirms each step, and nudges when someone is stuck or off track (Cloudflare Clef).

The demo target is **LumenCare**, a FICTIONAL EHR at the fictional **Lumen General Hospital**. Every patient, MRN,
phone number (555-01xx) and plan is invented. Full spec: [`SPEC.md`](SPEC.md). Hosting: [`DEPLOY.md`](DEPLOY.md).

**No video.** Recording captures a DOM event log plus small before/after screenshots, with patient details
**masked in the browser** before anything is uploaded.

## Status
| Milestone | What | State |
|---|---|---|
| 1 | LumenCare demo app (check-in + vitals) | ✅ |
| 2 | Recorder panel → events + masked screenshots → upload (Vercel + Modal) | ✅ |
| 3 | Steps: segmentation + Clef judging → `steps.json` | ✅ verified on a real recording |
| 4 | Step titles + hints (Gemini → Claude → plain fallback) | ✅ verified (gemini-3.5-flash-lite) |
| 5 | **Live guide**: spotlight, hint card, DOM-first progress, Clef when unsure, blur toggle | ✅ built, deploy + try |
| S1–S2 | Chrome extension; Jev provider | stretch |

## Layout
```
showme/
  SPEC.md, DEPLOY.md
  demo-app/   Next.js 16: LumenCare + the Record panel (components/RecorderPanel.tsx, lib/recording.ts)
  recorder/   framework-agnostic TS shared by demo-app and the future extension
              domRecorder (events) · identity (testid → role+name → CSS path) · pageState · sensitive · frames (masked JPEGs)
  backend/    FastAPI (showme_backend/) + modal_app.py
              segment.py (events → steps) · judge.py + providers.py (Clef) · text.py (Gemini/Claude) · thresholds.json · steps_cli.py
```

## Using the hosted app
1. **Record (expert):** **Reset demo data** → **● Record** → share **this tab** → do the check-in → **Stop**.
   The panel shows *Finding steps… → 6 steps ready*.
2. **Guide (learner):** click **▶ Start guide**. Demo data resets, and the page dims except the next element, which gets
   a pulsing ring and a hint card. Do the steps yourself: each one ticks off in the panel ("click" = confirmed by
   your click). Click something else or wait 10 s and the hint turns amber; Clef is then asked, and its bars appear
   (step done / stuck / which step). Toggle **Blur patient details** before screen-recording.

## 3-minute demo script
| Time | Say | Do |
|---|---|---|
| 0:00 | "Training new front-desk staff on an EHR takes shadowing and slide decks." | LumenCare appointments page |
| 0:20 | "I record the check-in once." | **● Record**, share tab, check in Marisol (ID, consent, reason, room, Complete), **Stop** |
| 0:55 | "No video is uploaded. Just clicks and masked screenshots. Clef drops misclicks; Gemini writes the hints." | Panel: *6 steps ready* (optionally open **View steps**) |
| 1:15 | "Now a new hire." | **▶ Start guide**, tick **Blur patient details** |
| 1:25 | "It points at the real button in the real app…" | Click **Check in**: step 1 ticks, the spotlight moves to "ID verified" |
| 1:45 | "…and notices mistakes." | Click **My Patients**: the hint turns amber. Come back (**Take me there**) |
| 2:05 | "If clicks aren't conclusive, Clef looks." | Wait 10 s on a step: Clef bars appear (*stuck*, *which step*) |
| 2:25 | "Do it in any order; it keeps up." | Tick consent before ID: both tick |
| 2:40 | "One recording, every new hire trained." | Finish → "All 6 steps done in …s" |

Backup: screen-record a clean run beforehand (Cmd+Shift+5) with **Blur patient details** on.

## Local development (optional, offline fallback)
```bash
brew install node@22 python@3.12
cd showme
(cd recorder && npm install && npm test)
(cd demo-app && npm install && npm test)
cd backend && python3.12 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && python -m pytest -q

# run (two terminals)
cd backend && source .venv/bin/activate && uvicorn showme_backend.main:app --port 8000 --reload
cd demo-app && npm run dev          # http://localhost:3000 (uses http://localhost:8000 by default)
```
With no Cloudflare keys locally, steps are built but unjudged. Export `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`
in the backend terminal to judge with Clef.

Inspect a recording's steps: `python -m showme_backend.steps_cli <rec-id> [--provider clef|clef-flash|mock]`.

## Conventions the recorder relies on (keep these when editing the app)
- Every interactive element has a stable `data-testid`.
- Patient name, DOB, MRN, phone and member ID carry `data-sensitive`.
- Never put patient identifiers in `aria-label`, `title` or button text (accessible names are stored).
- Anything inside `[data-showme-ignore]` (the ShowMe panel) is excluded from events and page state.
- Only Chrome **tab** capture is accepted (window/screen breaks screenshot masking).
- A full page reload ends a recording; in-app navigation is fine (the extension, S1, removes this limit).

## Manual check of the demo app
Workflow A: search `Quintero` → Check in → tick ID verified + Consent signed → visit reason + room → **Complete
check-in** → row reads **Waiting – Room N**. Workflow B: **My Patients** → **Record vitals** → fill → **Save vitals**.
