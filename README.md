# ShowMe

Press Start, do a web workflow, get a highlighted tutorial video, then coach a learner through it live.

The demo target is **LumenCare**, a FICTIONAL EHR at the fictional **Lumen General Hospital**.
Every patient, MRN, phone number (555-01xx) and insurance plan is invented. The full spec is in `SPEC.md`.

## Status

| Milestone | What | State |
|---|---|---|
| 1 | demo-app with Workflows A and B working by hand | ✅ |
| 2 | recorder + frames.ts + Start/Stop panel + upload + normalize + render:debug | ✅ synthetic check passed on Mac; real recording pending |
| 2b | hosted: demo-app on Vercel, backend/normalize/render on Modal, auto debug render after Stop | ✅ built — **deploy with `DEPLOY.md`** |
| 3–8 | segmentation/judging, narration, full render, practice, extension, Jev | later |

## Hosted (Vercel + Modal)
See **[DEPLOY.md](DEPLOY.md)**. After a one-time setup you only open the Vercel URL in Chrome. Recording, upload,
normalize and the debug render happen automatically, and the panel shows an **Open debug video** button.
Everything below is the local/offline setup, which is still useful as a fallback on stage.

## macOS setup (M1), one time

```bash
brew install node@22 ffmpeg python@3.12
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
node -v      # v22.6+
ffmpeg -version | head -1

cd showme
(cd recorder && npm install && npm test)          # 12 tests
(cd demo-app && npm install && npm test)          # 7 tests
(cd video && npm install)
cd backend && python3 -m venv .venv && source .venv/bin/activate \
  && pip install -r requirements.txt && python -m pytest -q && cd ..   # 9 tests
```

## Run it (three terminals, from `showme/`)

```bash
# 1. backend (stores recordings in showme/data/, normalizes automatically after upload)
cd backend && source .venv/bin/activate && uvicorn showme_backend.main:app --port 8000 --reload

# 2. demo app
cd demo-app && npm run dev            # http://localhost:3000

# 3. renders
cd video && npm run render:debug -- <recording-id>
```

The first `render:debug` downloads Remotion's headless Chrome (~100 MB, one time).

## Milestone 2 verification

### Step A: synthetic alignment check (no browser recording needed)
This proves normalize + coordinate math + the Remotion overlay are wired correctly before real recordings are involved.
```bash
python3 fixtures/make_synthetic.py                                   # data/synthetic-alignment/
(cd backend && source .venv/bin/activate && python -m showme_backend.normalize synthetic-alignment)
node --experimental-strip-types fixtures/verify_alignment.ts        # pixel checks → "all alignment checks passed"
(cd video && npm run render:debug -- synthetic-alignment)            # → data/synthetic-alignment/debug.mp4
```
In `debug.mp4`, every **red dot sits on a magenta square** (including after the viewport shrinks at 3 s), and the
**yellow outline rides the cyan bar** while it moves (1–2.5 s).

### Step B: a real recording of Workflow A
1. Open http://localhost:3000 and click **Reset demo data**.
2. Click **● Record** (bottom-left). Chrome asks to share **this tab**. Pick it and press **Share**.
   (Rehearse this: it's the picker you'll see on stage.) A "sharing this tab" bar appears. That's expected and handled.
3. Do Workflow A: search `Quintero` → **Check in** → tick **ID verified** + **Consent signed** →
   pick visit reason + room → **Complete check-in**.
4. To test blur tracking, also **scroll** on a page with patient data. If nothing scrolls, make the window shorter first.
5. Click **Stop**. The panel shows `Saved rec-…`. Copy that id.
6. Wait about 5 s for normalize, then check `curl localhost:8000/recordings/<id>/status` → `"state":"normalized"`.
7. `cd video && npm run render:debug -- <id>` → open `data/<id>/debug.mp4`.

**What "good" looks like:** each red dot appears exactly on the button, checkbox or dropdown you clicked, at the moment you
clicked it. Yellow outlines cover the patient name, DOB, MRN, phone and member ID, and stay on them while you scroll.
The HUD (top right) shows `video_t`, the viewport and the source size.

**Also check** `data/<id>/frames/*.jpg`. Before/after screenshots have the sensitive fields **filled in solid**.

**Report back:** a screenshot or two from `debug.mp4`. If dots are offset, say whether they're consistently early or late (a time
problem) or shifted in one direction (a coordinate problem), and send `data/<id>/capture.json`.

Once it looks right, save it as the dev fixture: `cp -r data/<id> fixtures/workflow-a` (milestone 3 builds on it).

## What's where
```
showme/
  SPEC.md              the agreed spec
  demo-app/            Next.js 16: LumenCare + the fallback recorder panel (components/RecorderPanel.tsx, lib/recording.ts)
  recorder/            framework-agnostic TS (no Chrome APIs), shared by demo-app now and the extension later
    src/domRecorder.ts   events (click/input/select/checkbox/navigation/scroll/enter/resize) + sensitive_tracks
    src/identity.ts      data-testid → role + accessible name → CSS path
    src/pageState.ts     sensitive-free page summary per event
    src/sensitive.ts     data-sensitive (always wins) + type/autocomplete/label heuristics
    src/frames.ts        ring buffer, before(t-100ms)/after(t+600ms), masking, JPEG, MediaRecorder + capture.json
    src/tracks.ts        nearest-sample lookup, box scaling, interpolation
    src/timeline.ts      video_t, viewport/capture segments, ffmpeg scale+pad mapping
  backend/             FastAPI: POST/GET /recordings, /status, /process; normalize.py (ffmpeg → CFR 30 fps MP4 + transform.json)
  video/               Remotion: Debug composition + scripts/render.mjs
  fixtures/            synthetic alignment generator + pixel verifier
  data/                recordings (gitignored)
```

## Recording output (`data/<id>/`)
| File | Contents |
|---|---|
| `recording.webm` | raw tab capture (stays on this machine) |
| `events.json` | every event with `epoch`, `video_t`, viewport, target identifiers, masked values, page state, frame names |
| `sensitive_tracks.json` | timestamped boxes (viewport CSS px) of every sensitive element |
| `capture.json` | `video_start_epoch`, first-chunk latency, track settings, every decoded frame-size change |
| `frames/<event>_before.jpg`, `_after.jpg` | masked screenshots |
| `normalized.mp4`, `transform.json` | 30 fps CFR MP4 at the initial capture size; per-size scale/pad + `source_start_ms` |
| `debug.mp4` | render:debug output |

## Conventions the recorder relies on (keep these when editing the app)
- Every interactive element has a stable `data-testid`.
- Patient name, DOB, MRN, phone and insurance member ID carry `data-sensitive`.
- Never put patient identifiers in `aria-label`, `title` or button text. Accessible names are used for element identity.
- Anything inside `[data-showme-ignore]` (the recorder panel) is excluded from events, page state and tracks.
- The fallback recorder only works with Chrome's **tab** capture. Picking a window or screen is rejected with a message.
- Recording state lives in the page, so client-side navigation is fine but a full page reload ends the recording
  (the extension in milestone 7 fixes this with service-worker-owned state).

## Milestone 1 manual check (still valid)
Workflow A: search `Quintero` → Check in → fill → **Complete check-in** → row reads **Waiting – Room N**.
Workflow B: **My Patients** → **Record vitals** → BP 122/78, HR 72, 98.6, SpO2 98, pain 2 → **Save vitals** → new
timeline entry.
