# Deploying ShowMe (Vercel + Modal)

```
Chrome (you) ──► Vercel: demo-app (LumenCare + Record panel)
                    │  upload (x-showme-token)
                    ▼
                 Modal: showme-api (FastAPI) ──spawn──► normalize (ffmpeg) ──spawn──► render_debug (Remotion)
                    └──────────────── Volume "showme-data" (all recordings) ────────────────┘
```

One-time setup takes ~20 minutes, most of it waiting for the first Modal image build.
After that, using it is just opening the Vercel URL in Chrome.

## 1. Push the repo to GitHub (private)
On github.com create an empty **private** repo named `showme` (no README). Then:
```bash
cd ~/src/showme
git init -b main
git add .
git commit -m "ShowMe: milestone 2 (hosted)"
git remote add origin git@github.com:<your-github-user>/showme.git   # or the https URL GitHub shows
git push -u origin main
```

## 2. Modal backend
```bash
cd ~/src/showme/backend
source .venv/bin/activate          # the venv from milestone 2 (python3.12 -m venv .venv if missing)
pip install -r requirements.txt    # now includes the modal client
modal setup                        # opens the browser to log in / create your account

TOKEN=$(openssl rand -hex 16); echo "SAVE THIS TOKEN: $TOKEN"
modal secret create showme SHOWME_API_TOKEN=$TOKEN

modal deploy modal_app.py
```
The first deploy builds two images (ffmpeg, plus Node and headless Chrome for Remotion), which takes about 5–10 min.
When it finishes, it prints a URL like `https://<workspace>--showme-api.modal.run`. Check it:
```bash
curl https://<workspace>--showme-api.modal.run/health      # → {"ok":true}
```
API keys for milestones 3–4 get added later by re-running `modal secret create showme --force ...` with all keys.

## 3. Vercel frontend (no CLI)
1. vercel.com → **Add New… → Project** → import the `showme` GitHub repo.
2. **Root Directory:** `demo-app`. Keep "Include files outside the root directory" **on** (the app uses `../recorder`).
3. **Environment Variables:**
   - `NEXT_PUBLIC_SHOWME_BACKEND` = the Modal URL from step 2 (no trailing slash)
   - `NEXT_PUBLIC_SHOWME_TOKEN` = the token you saved
4. **Deploy.** You get `https://showme-<something>.vercel.app`.

## 4. Use it
Open the Vercel URL in Chrome → **Reset demo data** → **● Record** → share **this tab** → do Workflow A (include one
scroll) → **Stop**. The panel then shows *Uploaded → Normalizing → Rendering debug video → Debug video ready*.
Click **Open debug video**.

## Updating later
- **Frontend:** `git push`. Vercel redeploys automatically.
- **Backend:** `cd backend && modal deploy modal_app.py`. Alternatively, add `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` as GitHub repo
  secrets (Modal → Settings → API Tokens) and `.github/workflows/modal-deploy.yml` deploys on every push.

## Troubleshooting
| Symptom | Fix |
|---|---|
| Panel: "Upload failed: HTTP 401" | `NEXT_PUBLIC_SHOWME_TOKEN` on Vercel ≠ `SHOWME_API_TOKEN` in the Modal secret. Fix, then redeploy Vercel (env vars apply on the next deploy). |
| Panel: "Failed to fetch" | Wrong `NEXT_PUBLIC_SHOWME_BACKEND`, or a custom domain that isn't `*.vercel.app`. In that case add `SHOWME_ALLOWED_ORIGINS` to the Modal secret. |
| "Processing failed: normalize…" / "render:debug failed…" | `modal app logs showme`. Also check `render_debug.log` via `https://…/recordings/<id>` (the file list). |
| Stuck on "Uploaded…" | `modal app list` should show `showme` deployed, then check `modal app logs showme`. |

## Costs (see README)
Vercel Hobby: free. Modal Starter: $30/month free credits. One debug render is a few cents.
