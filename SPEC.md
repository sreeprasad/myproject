# Project: ShowMe: record a web workflow once, then coach anyone through it live in the real app

## Goal (hackathon MVP, web apps only)
1. CAPTURE: an expert presses Record, performs a workflow in a web app, presses Stop. We capture a structured DOM
   event log plus masked before/after screenshots per action. **No video is recorded, uploaded, stored or rendered.**
2. STEPS: the event log becomes clean steps (misclicks dropped by Clef), with titles and one-line hints (Gemini).
3. LIVE GUIDE (centrepiece): a learner clicks "Start guide" in the same app. ShowMe spotlights the next element,
   shows the hint, confirms each step as they do it, and nudges them when they're stuck or off track. Clef judges
   ambiguous moments live; its probabilities are shown in the panel.
The shareable demo video is a normal screen recording of a live-guide run (plus a backup clip for stage).

## Priority / cut line
- MUST: M1 demo-app ✅, M2 capture + hosted upload ✅, M3 steps ✅ (deploying), M4 step text, M5 live guide.
- STRETCH, in order: S1 Chrome extension (guide on real websites), S2 JevProvider (text-only) switch.
- Do not cut tests.

## Scope
- In: (a) our own fictional hospital web app (primary demo), (b) later, standard websites via a Chrome extension.
- Out: desktop apps, remote desktop/Citrix, canvas-rendered apps (Figma, Google Docs/Sheets), cross-origin iframes,
  native browser dialogs, chrome:// pages, multi-tab workflows. Detect unsupported pages and say so clearly.
- No microphone, no voice, no audio, no video output.

## Environment & constraints
- Dev machine: M1 MacBook, Chrome 116+. Stack: Next.js 16 + TypeScript (demo-app, recorder), Python 3.12 + FastAPI.
- Hosting: demo-app on Vercel (root dir `demo-app`); backend on Modal (FastAPI web endpoint + `build_steps` function,
  one Volume "showme-data", secrets in the Modal secret "showme"). The same backend runs locally for offline use.
- Models:
  - Perception/judgment: Cloudflare Workers AI **Clef**. `clef` (27B) for step judging (DECISION_PROVIDER),
    `clef-flash` (9B) for live guide checks (PRACTICE_PROVIDER). Allowed `model` values are exactly "clef" and
    "clef-flash".
  - Text (M4): Gemini Flash-Lite, ONE call per workflow, responseSchema + validation; Claude API fallback only on
    HTTP 429 or a parse/validation failure.
  - No GPUs. Budget ~$0: Vercel Hobby, Modal Starter credits, Clef free tier (10k neurons/day), Gemini free tier.
- Secrets via env only: SHOWME_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, GEMINI_API_KEY,
  optional ANTHROPIC_API_KEY, optional TYPESAFE_API_KEY, DECISION_PROVIDER, PRACTICE_PROVIDER (Modal secret);
  NEXT_PUBLIC_SHOWME_BACKEND, NEXT_PUBLIC_SHOWME_TOKEN (Vercel). Never commit or paste secrets.
- Backend access: shared token (header x-showme-token, or ?token= for links). Demo-grade only: the token ships in
  the client bundle; acceptable because all data is invented.
- All patient data is invented. Never seed or store real patient information.
- **Privacy rule:** no unmasked sensitive pixels or values ever leave the browser. Uploads = events.json (sensitive
  values never recorded), capture.json, and before/after JPEGs whose sensitive regions were filled solid in the
  browser. Model providers only ever see sensitive-free state JSON and those masked JPEGs.

## Capture (demo-app panel now; extension later)
- Record (bottom-left panel) → Chrome's "share this tab" prompt (getDisplayMedia, preferCurrentTab; window/screen
  rejected). The stream feeds ONLY an in-memory ring buffer of ~1.5 s of downscaled frames; nothing else is kept.
- Wait for Chrome's sharing infobar resize (≤500 ms) before starting, so the viewport is stable.
- Stop (or Chrome's "Stop sharing") → upload events.json + capture.json + masked frames → status polling →
  "N steps ready" → (M5) "Start guide".

## Repo layout
- /demo-app  Next.js: FICTIONAL EHR "LumenCare" at "Lumen General Hospital". 20 invented patients. Pages: Today's
             Appointments (search + list); Patient Check-In (phone, insurance + member ID, "ID verified",
             "Consent signed", visit reason, room → "Waiting – Room N"); My Patients → Vitals (BP, HR, temp, SpO2,
             pain → chart timeline). Every interactive element has a stable data-testid; name, DOB, MRN, phone,
             member ID carry data-sensitive. Never put patient identifiers in aria-label/title/button text.
             Workflow A = check-in (primary), B = vitals. Contains the recorder panel (and the guide in M5).
- /recorder  Framework-agnostic TS (no Chrome extension APIs), shared with the future extension:
             - clock.ts: epoch ms = performance.timeOrigin + performance.now(); t = epoch − start_epoch.
             - identity.ts: element identity in priority order data-testid → ARIA role + accessible name → CSS path;
               all available identifiers stored with the one used. Same rules drive guide matching.
             - domRecorder.ts: click, input (value only when safe: never sensitive or free text), select, checkbox,
               navigation (history patch + URL poll), scroll, Enter, resize; sensitive_tracks every 250 ms, on
               scroll and every frame while scrolling (kept in the browser for masking; not uploaded).
             - pageState.ts: sensitive-free summary per event (URL, title, headings, buttons, links, field labels
               + filled/empty, dialog title, status/toast text).
             - sensitive.ts: data-sensitive always wins; plus type=password, autocomplete (cc-*, tel, email, bday),
               label heuristics (MRN, DOB, SSN, member ID, API key, token, phone).
             - frames.ts: ring buffer; before = frame nearest t−100 ms, after = frame nearest t+600 ms; mask with the
               nearest sensitive-track sample (scaled CSS px → frame px, 8 px padding, solid fill); JPEG ≤1280 px.
             - tracks.ts: nearest-sample lookup and box scaling.
- /backend   FastAPI (showme_backend) + modal_app.py:
             POST /recordings (events, capture, frames) · GET /recordings · GET /recordings/{id} ·
             GET /recordings/{id}/status · GET /recordings/{id}/steps · GET /recordings/{id}/files/{json|jsonl|frames}
             · POST /recordings/{id}/process. Storage: ./data/<id>/ locally, the Modal Volume when hosted.

## Steps pipeline (runs automatically after upload; status: uploaded → building_steps → steps_ready | error)
1. SEGMENT (deterministic): merge click-to-focus + keystrokes (+ Enter) → "type"; click + navigation within 2 s →
   one "click" with navigates_to; label click + synthetic control click + change → "toggle" on the control; click
   that opens a select + its change → "select"; scrolls counted on the next step; resizes ignored. Each step: id,
   action, t_start/t_end, event_ids, target (identifiers, label, text, bbox, sensitive), click_point, value (only if
   safe), before_state, after_state, frames {before, after}.
2. JUDGE each step with a DecisionProvider (concurrency 4; per-step fallback to "keep, unjudged" on errors):
   - step_type (choice): click | type | select | toggle | navigate | scroll | wait
   - meaningful (noul): deliberate learner step vs misclick / undone action / idle
   - importance (score): Trivial | Helpful | Essential
   Keep if meaningful ≥ 0.3. All thresholds live in backend/showme_backend/thresholds.json.
   Clef request: {"model", "state", "images": [data URLs ≤4], "questions": {name: {"type":"noul","instructions"} |
   {"type":"choice","instructions","criteria":{option: description|null}} | {"type":"score","instructions",
   "criteria":[low…high]}}}. REST response: body.result.answers[name] = noul {noul: p} | choice {choice,
   probabilities, confidence} | score {score, legend, probabilities, confidence}; body.result.usage.input_tokens.
   Verified live 2026-10-24 (modal run modal_app.py::clef_check). If the published schema differs, the schema wins.
3. TEXT (M4): Gemini → per kept step title (≤6 words) + narration/hint (≤20 words) + workflow title/summary.
4. Write steps.json (schema "showme.steps/1"): recording_id, provider, provider_note, workflow {title, summary},
   start_url, counts {events, candidates, kept}, steps[] (each with judge answers, decision {keep, drop_reason,
   importance, step_type, judged}, number among kept steps, title, narration). Single source of truth for the guide.
- Every provider call → data/<id>/decisions.jsonl (trigger, step_id, provider, model, latency_ms, usage, answers
  or error).

## Live guide (M5): demo-app panel first, extension later. Deterministic first
- "Start guide" loads steps.json (kept steps). Checklist in the panel; "Blur patient details" toggle (CSS blur on
  [data-sensitive]) so screen recordings stay clean.
- Current step: dim the page except the target (spotlight), pulsing ring on it, hint card (title + narration).
  Target found by recorded identifiers (data-testid → role + accessible name → CSS path), falling back to the
  recorded bbox; re-located on scroll, resize and DOM changes. If the step's page differs (URL), say where to go.
- PRIMARY progress (no model): a learner event on the same element (same identifier priority) with the same action
  type, AND the resulting page state matches the step's after_state (URL, dialog title, key labels) → advance.
- MODEL (PRACTICE_PROVIDER, default clef-flash), only when the page changed and at most once per 2 s, never on a
  timer: ambiguous DOM match → step_done (noul); no progress for 10 s or page matches no expected state →
  current_step (choice over step ids + "off_track") and stuck (noul). Images: the step's recorded before/after +
  the learner's current frame, all masked. Advance on DOM match or step_done ≥ 0.8.
- Stuck/off-track: re-highlight the target and show the hint more prominently. Show the latest probabilities as
  small bars, and label each completed step "confirmed by DOM" or "confirmed by Clef".

## Milestones (build and verify in order; stop and show me after each)
1. ✅ demo-app with Workflows A and B (data-testid everywhere).
2. ✅ recorder + masked frames + upload; hosted on Vercel + Modal. (A video/debug-render path existed here and was
   removed on 2026-10-24: video is out of scope.)
3. ✅ STEPS: segmentation + ClefProvider + thresholds + steps.json + decisions.jsonl; GET /steps. Verify on a real
   recording after deploy.
4. STEP TEXT: Gemini Flash-Lite (responseSchema) → titles + hints + workflow title/summary; Claude fallback.
5. LIVE GUIDE in the demo-app (spotlight, ring, hint card, checklist, DOM-first progress, Clef fallback,
   probability bars, blur toggle).
S1. Chrome extension: capture + guide on real sites (service-worker-owned state, offscreen document using
    recorder/frames.ts with tabCapture, side panel).
S2. JevProvider (text-only) + DECISION_PROVIDER / PRACTICE_PROVIDER switches.

## Quality bar
- README + DEPLOY: macOS setup, env vars, Vercel/Modal deploy, record → steps → guide, 3-minute demo script.
- Tests: clock/t, identifier priority + guide matching, sensitive detection + value masking, frame selection and
  masking math, segmentation, threshold decisions, steps.json shape, provider request/response parsing (mocked),
  API (token, CORS, allowlisted files, no video accepted).
- Don't invent API fields; if a schema detail is unclear, check the docs or ask.
