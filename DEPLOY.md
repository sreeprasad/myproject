# Deploying ShowMe (Vercel + Modal)

```
Chrome ──► Vercel: demo-app (LumenCare + Record panel)
             │  events.json + capture.json + masked JPEGs   (no video)
             ▼
          Modal: showme-api (FastAPI) ──spawn──► build_steps (segment → Clef → steps.json)
             └──────────── Volume "showme-data" ────────────┘
```

## First-time setup (done once)
1. **GitHub:** push the repo (private).
2. **Modal:** `cd backend && python3.12 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && modal setup`
3. **Secret** (`--force` replaces the whole secret, so always pass every key):
   ```bash
   modal secret create showme --force \
     SHOWME_API_TOKEN=<random: openssl rand -hex 16> \
     CLOUDFLARE_ACCOUNT_ID=<account id> \
     CLOUDFLARE_API_TOKEN=<workers ai token> \
     GEMINI_API_KEY=<aistudio.google.com key> \
     DECISION_PROVIDER=clef PRACTICE_PROVIDER=clef-flash
   ```
   Optional: `ANTHROPIC_API_KEY=<key>` (Claude fallback when Gemini rate-limits or returns bad output),
   `GEMINI_MODEL` (default `gemini-3.5-flash-lite`), `ANTHROPIC_MODEL` (default `claude-haiku-5-5`).
   Cloudflare token: dash.cloudflare.com → My Profile → API Tokens → Create Token → **Workers AI** template, 90-day expiry.
4. **Check the models:** `modal run modal_app.py::clef_check` prints Clef `answers` for a noul, a choice and a score
   question. `modal run modal_app.py::gemini_check` prints `text_provider: gemini` plus two titles and hints.
5. **Deploy:** `modal deploy modal_app.py`, which gives `https://<workspace>--showme-api.modal.run`. Check `/health` → `{"ok":true}`.
6. **Vercel:** Add New → Project → import the repo → **Import single project** on `demo-app` (not "Services")
   → Root Directory `demo-app` → env vars `NEXT_PUBLIC_SHOWME_BACKEND` (Modal URL) and `NEXT_PUBLIC_SHOWME_TOKEN`
   (same as `SHOWME_API_TOKEN`) → Deploy.

## Every update
```bash
cd ~/src && unzip -o ~/Downloads/showme-<milestone>.zip        # overwrites files, keeps .git/.venv/node_modules
cd showme/backend && source .venv/bin/activate && modal deploy modal_app.py
cd .. && git add -A && git commit -m "<milestone>" && git push     # Vercel redeploys on push
```
Optional: add `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` as GitHub repo secrets and `.github/workflows/modal-deploy.yml`
redeploys the backend on push.

## Checking a recording
- Status: `https://<modal-url>/recordings/<rec-id>/status?token=<token>`
- Steps: `https://<modal-url>/recordings/<rec-id>/steps?token=<token>`
- Every Clef call (latency, tokens, answers): `https://<modal-url>/recordings/<rec-id>/files/decisions.jsonl?token=<token>`
- Re-run steps for a recording: `modal run modal_app.py::build_steps --rec-id <rec-id>`
- Guide checks show up in `decisions.jsonl` with trigger `guide_idle` / `guide_off_track` / `guide_ambiguous`
- Logs: `modal app logs showme`

## Troubleshooting
| Symptom | Fix |
|---|---|
| Panel: "Upload failed: HTTP 401" | `NEXT_PUBLIC_SHOWME_TOKEN` (Vercel) ≠ `SHOWME_API_TOKEN` (Modal). Fix it, then redeploy Vercel (env changes apply on the next build). |
| Panel: "Failed to fetch" | Wrong `NEXT_PUBLIC_SHOWME_BACKEND`, or a custom domain that isn't `*.vercel.app`. In that case add `SHOWME_ALLOWED_ORIGINS` to the Modal secret. |
| Steps "unjudged" / `provider_note` mentions CLOUDFLARE | Cloudflare keys missing from the Modal secret. Re-create it with all keys and redeploy. |
| `decisions.jsonl` shows HTTP 401/403 from Cloudflare | Token expired or lacks Workers AI permission. Roll it and update the secret. |
| Guide panel shows "Clef check failed (HTTP 503)" | `PRACTICE_PROVIDER` / Cloudflare keys missing from the Modal secret. The guide still works by clicks. |
| `steps.json` → `workflow.text_provider: "fallback"` | Gemini (and Claude) failed or keys are missing. `workflow.text_errors` says why. The guide still works with plain text. |
| Vercel env var value can't be viewed | It's a Secret type (write-only). Paste a new value, then update Modal to match. |

## Cost
Vercel Hobby: free. Modal Starter: $30/month free credits (steps jobs are seconds of CPU). Clef: 10k free
neurons/day; each judged step is ~1–2k input tokens (see `usage` in `decisions.jsonl`).
