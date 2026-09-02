# Jakarta AQI estimation website

**Live: <https://simulation-aqi-jakarta-diurnal.vercel.app>**

A static, single-page website for the Jakarta diurnal AQI simulation. No backend: a Python script
pre-computes static data files, and a plain HTML/JS/Leaflet page renders them. It runs on the
project's own prediction output (NB8's static-JSON contract), so real forecasts drop in with no
front-end change.

> **Current state: live, historical simulation.** The site serves a fixed archive of 393 dates
> (2024-02-02 to 2025-02-28) on the H3 r7 grid, 290 mainland DKI cells. There is no live
> now-cast. Pick a date and the page replays what the model estimates for that day across the
> full diurnal cycle.
>
> **What the numbers are.** Displayed values are a model simulation for the chosen historical
> date, not a direct measurement. Ground truth exists at **only 5 DKI monitoring stations**, so
> per-cell accuracy away from those stations cannot be checked independently. Differences
> between cells are a model-based display gradation, not measured values. The within-day curve
> shape comes from CAMS, calibrated to ISPU at the daily peak. With no hourly ground data, that
> sub-daily shape cannot be verified either. Any real-world use must state both limits.
>
> Two display modes: *Tanpa klimatologi* (raw model output, the default) and *Dengan klimatologi*
> (50% model + 50% ISPU climatology).

## What it shows (the three product features)

1. **Choose a location**
   *My location* (browser geolocation), *Lat / lon* (type coordinates), or
   click anywhere on the map.
3. **Predicted AQI for that grid cell**
   the coordinate is resolved to its H3 **r7** hex cell
   (`h3.latLngToCell`, v4 API: identical to Python `aqi_utils.h3_grid.latlng_to_cell`), and that
   cell's value + ISPU category are shown on the ISPU colour scale.
   The category names are the ones set by Permen LHK P.14/2020. The exact hex
   values are this project's own, since the regulation names the colours but
   sets no numeric values.
5. **Forecast graph**
   a weather-style line chart across the full 24-hour cycle. The archive is built
   on six fixed clock slots (`00, 04, 08, 12, 16, 20`). For the slot nearest the
   chosen time the chart plots four points at 4-hour steps: **now, +4h, +8h,
   +12h**, each labelled with its ISPU category.

An **About** overlay states the methodology and the accuracy limitations.

## Build the data

From the project root, in the `jakarta-aqi` env:

```bash
# Placeholder build (geometry + meta only, no forecast values):
python web/build_web_data.py --mode pending

# The shipped build: real per-cell forecasts read from NB8 output:
python web/build_web_data.py --mode historical
```

`--mode historical` reads NB8's canonical `web_data/forecast_r{R}.json` and re-emits it in the
front-end contract, so no front-end change is needed. Resolution defaults to r7 (`--resolution`).

## Run locally

```bash
cd web
python -m http.server 8001        # fetch() needs http, not file://
#   -> open http://localhost:8001
```

Geolocation works on `localhost`, and on HTTPS in production. Bootstrap, Leaflet, Chart.js and
h3-js are vendored under `vendor/`, so no CDN is involved. The OpenStreetMap basemap tiles are
still fetched over the network, so the map needs a connection at runtime.

## Deploy

Vercel, serving this `web/` folder only. Never publish the project root: it holds the data mirror
and a flagged API key. Step-by-step in [DEPLOY.md](DEPLOY.md).

## Files

| File | Role |
|------|------|
| `build_web_data.py` | Reads `hex_grid_r7.parquet` via `aqi_utils.paths`; writes the three data files. Category/colour come from `aqi_models.physics`. Modes: `pending` / `historical`. |
| `data/hexes_r7.geojson` | Hex-cell polygons (+ `h3_id`, center). The map layer, 290 mainland cells. |
| `data/forecast_r7.json` | `{ model_status, anchor_date, slot_hours, horizons_h, cells: { h3_id: { slot_h: [ {offset_h, value, category, colour} ] } } }`. Slot-keyed diurnal series. The page shows the slot nearest "now". Empty `cells` in `pending` mode. (A legacy flat `cells: { h3_id: [series] }` is still accepted by the front-end.) |
| `data/meta.json` | Resolution, `model_status`, `anchor_date`, `slot_hours`, horizons, legend, category order, disclaimers. |
| `index.html`, `app.js`, `style.css` | The static front-end. Responsive, and reads only `meta.json` plus the two data files. |
| `.nojekyll`, `DEPLOY.md` | Leftover GitHub Pages flag (inert on Vercel) + the deploy guide. |

## The data contract (how real predictions plug in)

The front-end only knows `meta.json` + `forecast_r{R}.json`. NB8, the inference notebook, is the
canonical producer of the per-cell forecast. `build_web_data.py --mode historical` re-shapes that
output into the contract above and keeps only cells on the current r7 grid. The forecast is **slot-keyed**
(every fixed clock slot, D-12 diurnal). The page picks the slot nearest the user's WIB time and
rolls a current+next-3 window. The `model_status` field drives the pending-vs-historical UI.

## Honest limitations (shown in the About panel)

- **Full diurnal cycle:** the model anchors at every fixed clock slot (selectable 2/3/4-h step,
  default 4 h) and shows the current value plus the next 3. The within-day shape is CAMS-derived
  and ISPU-calibrated at the daily peak, so it cannot be validated hourly.
- **Per-cell accuracy cannot be validated independently:** ground truth is only 5 DKI stations,
  so off-station per-cell differences are an *informed display gradient*, not a measured value.
- **Static demonstrator:** serving a *live, on-demand* model is a separate and possibly paid
  stage (it needs a Python backend host), deliberately deferred. See
  `docs/PROJECT_STATUS.md` §10.
