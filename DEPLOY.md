# Deploying the Jakarta AQI site to Vercel

The live site is <https://simulation-aqi-jakarta-diurnal.vercel.app>. Vercel watches the
`jakarta-aqi-diurnal` repo and rebuilds on every push to `main`, so "deploying" here means:
mirror this folder into that repo's clone, then push.

> ⚠️ **Publish ONLY this `web/` folder. Never the whole project root.**
> The project root holds the Kaggle data mirror and a flagged Copernicus API key
> (see `docs/PROJECT_STATUS.md` §6). The deploy script below mirrors *this folder only*,
> which is what keeps the public repository free of data and secrets. Do not point it at a
> parent directory.

---

## 0. The three places involved

| Path / name | Role |
|---|---|
| `Desktop\test web\web` | the folder you edit |
| `Desktop\jakarta-aqi-diurnal-upload` | clone wired to `origin = jakarta-aqi-diurnal`, a pure staging area |
| Vercel project `simulation-aqi-jakarta-diurnal` | builds the repo above |

> **Two traps.**
>
> This folder's own git remote points at `jakarta-AQI-simulation-sample`, which is **not** the
> repo Vercel builds. Pushing from here deploys nothing.
>
> The older URL `jakarta-aqi-diurnal.vercel.app` is dead (`DEPLOYMENT_NOT_FOUND`). The live one
> is `simulation-aqi-jakarta-diurnal.vercel.app`.

## 1. Prerequisites

- **git** installed.
- Push access to the `jakarta-aqi-diurnal` repo.
- The staging clone already present at `Desktop\jakarta-aqi-diurnal-upload`. The deploy script
  refuses to run without it.

## 2. Build the data

```powershell
# Placeholder build (geometry + meta only, no forecast numbers):
python web/build_web_data.py --mode pending

# The shipped build: real per-cell forecasts read from NB8 output:
python web/build_web_data.py --mode historical
```

Both write to `web/data/` and need no front-end change. Resolution defaults to r7
(`--resolution`).

## 3. Deploy

Run from `Desktop\test web`:

```powershell
# Preview: list what would change, copy nothing.
powershell -ExecutionPolicy Bypass -File deploy_to_vercel.ps1 -DryRun

# Mirror and stage, but stop before commit + push.
powershell -ExecutionPolicy Bypass -File deploy_to_vercel.ps1 -PrepOnly

# Full deploy: mirror, commit, push. Vercel redeploys on its own.
powershell -ExecutionPolicy Bypass -File deploy_to_vercel.ps1
```

What the script does, in order:

1. Hard-resets the clone to `origin/main`. The clone is pure staging with no local work to
   preserve, and the reset guarantees the later push fast-forwards instead of being rejected.
2. Mirrors this folder in with robocopy `/MIR`, so the repo ends up matching the source exactly,
   stale files included. Excluded: `.git`, `__pycache__`, `data_climatology`, `*.pyc`,
   `*.parquet`, and `ADMIN_PARQUET_CONTRACT.md`.
3. Stages everything and shows the diff.

`-PrepOnly` stops there and prints the two git commands to run yourself, keeping the public
write a deliberate manual step rather than a side effect of running a script.

## 4. Confirm it landed

Open <https://simulation-aqi-jakarta-diurnal.vercel.app> after the push. A static folder this
size builds in well under a minute.

> Geolocation ("Lokasi saya") needs HTTPS. Vercel serves HTTPS, so it works in production.
> Locally it only works on `localhost`.

---

## Notes

- **Custom domain:** add it in the Vercel dashboard under the project's Domains tab. Do not put
  a `CNAME` file in this folder. That is a GitHub Pages mechanism and does nothing on Vercel.
- **What needs internet:** Bootstrap, Leaflet, Chart.js and h3-js are vendored under `vendor/`,
  so no CDN is involved in loading the app. The OpenStreetMap basemap tiles are still fetched
  over the network, so the map needs a connection even though the application code does not.
- **Asset paths are relative** (`style.css`, `app.js`, `data/...`), so the site works from a
  domain root or a sub-path without extra configuration.
- This deploys the **static demonstrator**. Serving a live, on-demand model is a separate and
  possibly paid stage, since it needs a Python backend host. See `docs/PROJECT_STATUS.md` §10.
