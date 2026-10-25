# Project: ShowMe — press Start, do a web workflow, get a highlighted tutorial video, then coach a learner through it live

## Goal
Hackathon MVP for WEB APPS ONLY:
1. CAPTURE: user starts recording, performs a workflow in a web app, stops. We record tab video + a structured DOM event log.
2. PRODUCE: automatically turn the recording into a tutorial video: zoom + pulsing highlight on each action, step
   caption cards, on-screen narration text (subtitles), dead time sped up, misclicks cut, sensitive values blurred.
3. TEACH (practice mode): a learner performs the same workflow live; the system detects which step they're on,
   confirms completed steps, and shows a hint (element highlight + text) when they're stuck or off track.

## Priority / cut line
- MUST for the demo: milestones 1–6 (demo-app with built-in recorder, pipeline, render, practice mode).
- STRETCH: milestone 7 (Chrome extension on real websites), then 8 (Jev).
- If time runs short, keep the extension-specific sections as designed but unbuilt; do not cut tests or the
  render:debug alignment check from milestones 1–6.
- Stop after milestone 2 and show me the render:debug output before continuing.

## Scope
- In: (a) our own fictional hospital web app (primary demo), (b) standard websites via a Chrome extension,
  including sites the user is already logged into.
- Out: desktop apps, remote desktop/Citrix, canvas-rendered apps (Figma, Google Docs/Sheets), cross-origin iframes,
  native browser dialogs (file picker, print), chrome:// pages, multi-tab workflows (single tab for v1).
  Detect unsupported pages and show a clear message instead of failing silently.
- No microphone, no voice commands, no audio in v1. Narration is on-screen text only (see "Future narration").

## Environment & constraints
- Dev machine: M1 MacBook, Chrome 116+. Stack: Next.js, TypeScript, Python/FastAPI, Remotion, ffmpeg.
- Budget near zero:
  - Perception/judgment: Cloudflare Workers AI Clef. Default model `clef` (@cf/cloudflare/clef, 27B, vision).
    `clef-flash` (@cf/cloudflare/clef-flash, 9B, faster/cheaper) is supported as a config option.
    Allowed Clef `model` values are exactly "clef" and "clef-flash". No other variants exist.
  - Text generation (titles, narration text): Gemini Flash-Lite free tier, ONE call per workflow, with a
    responseSchema; validate the JSON. Fall back to the Claude API only on HTTP 429 or a parse/validation failure.
  - No GPUs.
- Secrets via env vars only (Modal secret "showme" when hosted; Vercel env vars for the two NEXT_PUBLIC_* values):
  SHOWME_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, GEMINI_API_KEY, optional ANTHROPIC_API_KEY,
  optional TYPESAFE_API_KEY, DECISION_PROVIDER (clef | clef-flash | jev; default clef — batch judging pass),
  PRACTICE_PROVIDER (clef | clef-flash | jev; default clef-flash — live practice checks, where latency is visible).
  Provide .env.example.
  Never commit secrets.
- Hosting: demo-app on Vercel; backend (FastAPI), ffmpeg normalize and Remotion rendering on Modal (one Volume
  "showme-data" for recordings; secrets in the Modal secret "showme"). The same code still runs fully locally
  (backend on localhost:8000) as the offline fallback. Optimise for a reliable 3-minute live demo.
- Backend access: shared token SHOWME_API_TOKEN (header x-showme-token, or ?token= for media links). Raw
  recording.webm is never served back by the API.
- All patient data is invented. Never seed or store real patient information.
- Privacy rule: no unmasked sensitive pixels or values are ever sent to any MODEL provider (Cloudflare, Gemini,
  Claude, TypeSafe). The raw recording goes only to our own backend storage (private Modal Volume when hosted,
  ./data when local) and is never served back by the API; sensitive regions are blurred in the rendered tutorial.
  Every image sent to a model is masked first. (All demo data is invented.)

## Recording UX
- Step 1: click the ShowMe toolbar icon → opens the side panel (chrome.sidePanel, opened by the action click).
- Step 2: press Alt+Shift+R (chrome.commands) → starts capture. The panel is already open, so the viewport is stable.
  The command is the user invocation that permits chrome.tabCapture.getMediaStreamId().
  A Start button inside the side panel is optional and must be verified to work, not assumed.
- While recording, the panel shows: recording badge, timer, step counter, Stop button. Alt+Shift+R also stops.
- Stop → automatic upload → processing progress → "Tutorial ready" with Play and Practice buttons.
- Do not open, close or resize the side panel during capture. If the viewport changes anyway, handle it (see Timeline & coordinates).

## Repo layout (monorepo)
- /demo-app   Next.js: a FICTIONAL hospital EHR "LumenCare" at "Lumen General Hospital" (clearly made-up brands;
              do not imitate real EHR vendors). Seed 20 invented patients (fake names, DOBs, MRNs, phones, fictional
              insurance plans like "Blue Harbor PPO").
              Pages: Today's Appointments (search + list); Patient Check-In (confirm phone, insurance dropdown,
              "ID verified" + "Consent signed" checkboxes, visit-reason dropdown, room assignment, Complete →
              status "Waiting – Room N"); My Patients → Vitals (BP, HR, temp, SpO2, pain 0–10, Save → chart timeline).
              Every interactive element gets a stable `data-testid`. Mark patient name, DOB, MRN, phone and
              insurance member ID with data-sensitive.
              Workflow A = Patient check-in (primary). Workflow B = Record vitals.
              Includes a built-in Start/Stop recorder and practice panel (fallback if the extension misbehaves on
              stage), using getDisplayMedia with preferCurrentTab for BOTH recording and practice frames.
              README must note the browser picker appears and should be rehearsed.
              The fallback recorder reuses the SAME frame logic as the extension, from the shared module
              /recorder/frames.ts: ring buffer, before = frame nearest t-100ms, after = ~t+600ms, nearest-sample
              masking with 8px padding, video_start_epoch at the MediaRecorder "start" event, first-chunk latency and
              track settings (getSettings() at start and on frame-size change) logged to capture.json.
              Chrome's "sharing this tab" infobar shrinks the viewport right after getDisplayMedia starts: wait for
              the first resize event (or ~500ms, whichever comes first) and re-read viewport size before starting
              MediaRecorder. Resize-segment handling remains the safety net.
- /recorder   Framework-agnostic TS module (no Chrome APIs inside), used by the extension and the demo-app fallback.
              /recorder/frames.ts holds ALL frame logic (ring buffer, before/after selection, masking, JPEG encoding,
              epoch bookkeeping, capture.json data) and takes a MediaStream as input, so the demo-app (getDisplayMedia)
              and the extension's offscreen document (tabCapture) run identical code.
              - Clock: every timestamp is epoch ms = performance.timeOrigin + performance.now() (same formula in
                every context, so tab, service worker and offscreen document share one timeline).
              - Element identity (used for recording AND practice matching), in priority order:
                1) `data-testid`; 2) ARIA role + accessible name; 3) CSS path. Store all available identifiers;
                record which one was used. Real sites with generated class names will usually match on role + name.
              - Events: click (viewport x,y; identifiers, visible text, bounding box), input (field label; value
                MASKED unless safe; never store sensitive values), select/change, checkbox, navigation (URL), scroll,
                Enter, viewport resize (new width/height/devicePixelRatio).
              - Page-state summary per event (JSON, no sensitive values): URL, page title, visible headings, visible
                button/link labels, form field labels + filled/empty status, open dialog/modal title, toast/status text.
              - Sensitive detection: type=password, data-sensitive, autocomplete hints (cc-*, tel, email, bday), label
                heuristics (MRN, DOB, SSN, member ID, API key, token).
              - sensitive_tracks: epoch-timestamped bounding boxes (viewport CSS px) of all sensitive elements every
                250ms, on every scroll event, and on every animation frame while scrolling is active (stop ~150ms
                after the last scroll event).
              - Emits each event and track sample immediately to its host (extension: service worker); keeps no
                state that must survive a page load.
- /extension  Chrome MV3:
              - Service worker OWNS recording state and the event log (survives full page navigations; the content
                script is re-injected after each load and resumes streaming events). It forwards sensitive_tracks
                samples and viewport/resize info to the offscreen document as they arrive.
              - On Alt+Shift+R: tabCapture.getMediaStreamId() → offscreen document (Chrome 116+) → getUserMedia with
                explicit constraints:
                  video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId, maxWidth, maxHeight,
                                        maxFrameRate: 30 } }
                where maxWidth/maxHeight = viewport CSS size × devicePixelRatio at start (cap at 2560 wide).
                Log the actual track settings (track.getSettings(): width, height, frameRate) at start and whenever
                the decoded frame size changes (video element 'resize' event); these are the authoritative
                videoWidth/videoHeight for each segment.
              - MediaRecorder (WebM). Offscreen doc reports video_start_epoch = timeOrigin + now() at the MediaRecorder
                "start" event, and the epoch time of the first dataavailable chunk; log both.
              - Frames (implemented by /recorder/frames.ts, run inside the offscreen doc): the offscreen doc keeps a ring buffer of the last ~1.5s of frames (downscaled, each with epoch
                timestamp). For each event at time t: "before" = frame nearest t-100ms; "after" = frame at ~t+600ms.
                Encode JPEG ~1280px wide.
              - Masking in the offscreen doc: for each saved frame, take the sensitive_tracks sample nearest the
                frame's timestamp, scale its boxes from viewport CSS px to frame px using the current segment's
                (frameWidth / viewportWidth), pad 8px, and fill them solid before encoding.
                Do NOT use chrome.tabs.captureVisibleTab during recording.
              - Content script (all_frames for same-origin frames) injects /recorder and relays events.
              - Side panel UI for recording status and practice mode. Talks to the local backend.
              - Permissions: tabCapture, offscreen, sidePanel, scripting, activeTab, storage; host permission for the
                demo-app origin and localhost:8000; optional <all_urls> requested at runtime for real websites.
- /backend    FastAPI: POST /recordings, GET /recordings/{id}, GET /recordings/{id}/status,
              POST /recordings/{id}/process, POST /practice/{id}/check. Local storage ./data/<id>/.
- /video      Remotion project rendering the tutorial from steps.json + normalized source video.
- /fixtures   One saved recording of Workflow A (video, events.json, screenshots) for development and tests.

## Timeline & coordinates (core correctness rules)
- Video time of an event: video_t = event_epoch - video_start_epoch. Store both raw epoch and video_t in events.json
  (and in sensitive_tracks).
- Trimming: NEVER trim in ffmpeg. Apply the ~0.5s head/tail trim only as a start offset / end cut in Remotion.
- Coordinates: scale is computed PER VIEWPORT SEGMENT. Segment boundaries = logged resize events and logged
  capture-size changes. overlay_x = x * (videoWidth_segment / viewportWidth_segment); same for y, using the
  logged track settings for videoWidth/videoHeight.
- Normalize (ffmpeg): constant 30 fps MP4 with pinned output dimensions (scale + pad to the initial capture size,
  preserving aspect ratio); record the scale/pad transform per segment and apply it to overlay coordinates.

## Processing pipeline (runs automatically after upload)
1. NORMALIZE (above).
2. SEGMENT raw events into steps (merge keystrokes into one "type" step; merge click→navigation).
   Each step: id, video_t_start, video_t_end, events[], target identifiers + bbox, page-state summary,
   before.jpg, after.jpg (already masked).
3. JUDGE each step via a DecisionProvider (limited concurrency).
   Interface: DecisionProvider.evaluate(state, questions, images) -> answers; supports_images flag.
   - ClefProvider: POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/cloudflare/{model}
     Body: { "model": "clef" | "clef-flash", "state": <JSON: step events, element labels, page-state summary,
             step index, previous step summary>, "images": [before, after], "questions": {...} }
     Images: each a data URL string ("data:image/jpeg;base64,...") or {"content_type": "image/jpeg", "base64": "..."};
     max 4 images, ≤4 MiB each, ≤13 MiB total request; no remote URLs. REST responses are wrapped:
     read answers from body["result"]["answers"].
     Expected answer shapes (verify against the fetched schema; IF THE SCHEMA DIFFERS, THE SCHEMA WINS and the
     threshold config must be adapted):
       noul → {"type":"noul","noul": p} where p ∈ [0,1] is the probability of "yes";
       choice → {choice, probabilities, confidence}; score → {score, legend, probabilities, confidence}.
     BEFORE implementing, fetch and follow the exact schemas:
       https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json
       https://developers.cloudflare.com/workers-ai/models/clef/schema-output.json
   - JevProvider: TypeSafe typesafe-sdk, TypeSafeClient().system_one(state=..., questions=...) with Choice/Noul/Score.
     Jev is TEXT-ONLY: omit images and rely on the page-state summary in `state`.
   - Same question definitions for all providers. Selected by DECISION_PROVIDER.
   Questions per step:
     - step_type (choice): click | type | select | toggle | navigate | scroll | wait
     - meaningful (noul): Is this a deliberate step a learner must perform (vs misclick, backtrack, idle)?
     - loading (noul): Is the screen mostly waiting/loading during this step?
     - sensitive_visible (noul): Is a patient name, date of birth, MRN, phone number, insurance member ID,
       password or API key visible and NOT already masked on screen after this step?
     - importance (score): ["Trivial", "Helpful", "Essential"]
   All thresholds in one config file (cut if meaningful < 0.3; speed up 4x if loading > 0.7; blur if
   sensitive_visible > 0.5 OR DOM-marked sensitive — DOM marking always wins).
4. TEXT: one Gemini Flash-Lite call with responseSchema → per kept step: title (≤6 words) and narration (≤20 words);
   plus workflow title and 1-sentence summary. Input: step labels, element text, URLs (never sensitive values).
   Validate; Claude fallback only on 429 or validation failure.
5. Write steps.json — single source of truth for rendering and practice mode.
6. RENDER automatically (below) and mark the recording ready.

## Video rendering (Remotion) — highlight mechanics
- Never modify the source video; draw overlays on top of it, frame by frame, using video_t and per-segment scaling.
- Layers (bottom → top): source video (zoomable) → blur boxes → highlight ring → caption card → narration text.
  - Highlight ring: pulsing circle at the click point from video_t-300ms to video_t+1000ms.
  - Zoom: smooth ~1.6x zoom centered on the target bbox, easing in before the click and out after.
  - Blur: blurred copy of the video clipped to each sensitive box. Interpolate boxes linearly between
    sensitive_tracks samples and pad each box by 8px. Blur from the first to the last sample in which it's visible.
  - Caption card: step number + title for the step's duration. Narration text shown as a subtitle bar.
  - Speed up loading segments; cut dropped steps; head/tail trim applied here only.
  - Intro card (workflow title) and outro (summary + step list). No audio.
- Compute each step's on-screen duration in ONE function (so it can later stretch to fit narration audio).
- `npm run render -- <id>` → data/<id>/tutorial.mp4 (also invoked by the pipeline).
- `npm run render:debug -- <id>` → draws only a red dot at every click and outlines every sensitive box,
  to verify time, coordinate and blur alignment.

## Future narration (design for it, do NOT build now)
- Keep each step's text in a `narration` field in steps.json.
- Structure the Remotion composition so an optional per-step <Audio> track can be added later without restructuring.

## Practice mode (extension side panel; demo-app fallback panel) — deterministic first
- Loads steps.json, shows a checklist.
- PRIMARY (no model): step N is done when the learner's DOM events match the step's target element (same
  identifier, using the same priority order: data-testid → role + accessible name → CSS path) with the same
  action type, AND the resulting page-state summary matches step N's recorded after-state
  (URL, dialog title, key labels). Advance immediately.
- MODEL (via the DecisionProvider selected by PRACTICE_PROVIDER, default clef-flash), called only when the page has changed (navigation, dialog open/close,
  significant DOM change) and at most once per 2s — never on a fixed timer:
    - when the DOM check is ambiguous (identifier missing, partial page-state match): step_done (noul)
    - when no progress for 10s or the page-state matches no expected state: current_step (choice over step ids +
      "off_track") and stuck (noul)
  Learner frame source:
    - Extension: chrome.tabs.captureVisibleTab (requires host permission), throttled to ≤1 call per 2s.
    - Demo-app fallback: frames from its own getDisplayMedia stream (started when practice begins).
  All learner frames are masked (DOM-marked sensitive boxes, padded 8px) before sending. Jev: page-state only.
  Clef images: recorded before/after for step N + learner's current frame.
- Advance on DOM match, or on step_done ≥ 0.8. If stuck or off_track: highlight the target element in the page
  (recorded identifiers, falling back to bbox) and show the step's narration text as a hint.
- Show the latest model probabilities as small bars in the panel, and label whether a step was confirmed by
  DOM or by model.

## Milestones (build and verify in order; stop and show me after each)
1. demo-app with Workflows A and B working by hand (all interactive elements have data-testid).
2. /recorder (including /recorder/frames.ts) + demo-app Start/Stop → saved fixture with masked before/after frames
   and capture.json. Milestone 2 ALSO includes the minimum needed to verify alignment:
   - the ffmpeg normalize step (constant 30 fps MP4, pinned dimensions — MediaRecorder WebM files lack duration/seek
     cues and seek unreliably in Remotion), and
   - a bare Remotion composition: normalized source video + the red-dot/sensitive-outline debug layer only.
   Run render:debug and verify red dots land on clicked elements and sensitive outlines track fields during scrolling.
3. Segmentation + ClefProvider (clef) + steps.json, building on milestone 2's normalize step; tests with mocked
   provider responses.
4. Narration text (Gemini Flash-Lite with responseSchema, Claude fallback).
5. Full tutorial render, extending milestone 2's Remotion composition (zoom, ring, captions, narration text, blur,
   speed-ups, cuts, trim, intro/outro) → tutorial.mp4; pipeline runs end to end after Stop.
6. Practice mode in demo-app (DOM-first, then model fallback via PRACTICE_PROVIDER using getDisplayMedia frames).
7. Chrome extension (panel open → shortcut start, pinned capture constraints, service-worker-owned state,
   tracks forwarded to offscreen doc, frame ring buffer + masking, practice via captureVisibleTab) on demo-app,
   then on one real public website with full page navigations.
8. JevProvider (text-only) + DECISION_PROVIDER switch.

## Quality bar
- README: macOS setup, env vars, loading the unpacked extension, record → tutorial → practice, 3-minute demo script
  (including rehearsing the getDisplayMedia picker for the fallback).
- Tests: clock/video_t conversion, trim offset, per-segment coordinate scaling (including a mid-recording resize),
  element-identifier priority and matching, segmentation, threshold decisions, steps.json schema, provider response
  parsing (mocked, both providers), frames.ts before/after frame selection from the ring buffer, sensitive masking in JPEGs (nearest-sample selection + scaling), blur box
  interpolation, practice-mode DOM matching.
- Log every provider call (provider, model, latency, answers, trigger reason) to data/<id>/decisions.jsonl.
- Log capture track settings and first-chunk latency to data/<id>/capture.json.
- Don't invent API fields; if a schema detail is unclear, check the docs or ask me.