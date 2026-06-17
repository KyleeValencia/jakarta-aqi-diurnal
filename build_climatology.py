"""
build_climatology.py
====================

Distil the trained AST-GCN diurnal forecast into a **time-only climatology** for
the static, daily-refreshed website (D-12 deployment, Kylee 2026-06-17).

WHY
---
The served forecast must depend on **time only** (no live data feed) and refresh
**daily** in the cloud (free GitHub Actions cron, not a PC, not a paid server).
So we precompute, per hex cell, the *typical* diurnal curve as a function of the
calendar, and a tiny daily job just looks up "today".

THE TIME KEY = COMBINED (equal blend) — Kylee's pick (½ DOY + ½ MW)
-------------------------------------------------------------------
Month×weekday and day-of-year+weekday are the SAME seasonal signal at two
resolutions, so we *blend* them rather than stack them:

    climatology(date) = 0.5 * DOY_smooth(day_of_year, weekend)      # daily drift
                      + 0.5 * MW(month, weekend)                    # robust level

  * DOY_smooth — the day-of-year seasonal curve, ±14-day circular-smoothed
    (≈3 samples/day-of-year is thin, so smoothing pools ~a month around each day).
    Gives a value that changes EVERY day.
  * MW — the month×weekday/weekend bucket mean (lots of samples → robust level).
  * weekend = (weekday ∈ {Sat,Sun}); present in BOTH components.

Net: changes every day (Kylee wanted daily output) but anchored to a stable,
well-sampled monthly level, and smoother than raw month-stepping.

WHAT IT PRODUCES
----------------
Two layers (this script is the heavy, build-ONCE layer):

  --build   forecast parquet → climatology table
            WORKING_ROOT/jakarta_data/climatology/climatology_r{R}_{model}.parquet
            keyed by (doy, weekend, h3_id, slot_h) with one column per offset.
            (The light daily cron — a later step — just selects today's rows and
            re-emits NB8's slot-keyed web JSON; this artifact is a pure lookup.)

  --verify  print the city-mean 6-point day-curve for a Jan weekday, a Jun
            weekday and a Jun weekend, to prove seasonality + weekday/weekend +
            the blend are real before any frontend is touched.

HONESTY (unchanged): values are µg/m³ from the full feature model run on real
CAMS/ERA5 conditions; "time-only" is the SERVING interface, not the training.
The within-day shape is CAMS-derived and hourly-unvalidatable.

Portable bootstrap mirrors build_web_data.py (env vars → local mirror, else
/kaggle fallback). Reuses aqi_models (config, physics) so it cannot drift.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# --- portable bootstrap (same rule as build_web_data.py / the notebooks) -------
PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("AQI_INPUT_ROOT", str(PROJECT_ROOT / "kaggle" / "input"))
os.environ.setdefault("AQI_WORKING_ROOT", str(PROJECT_ROOT / "kaggle" / "working"))
sys.path.insert(0, str(PROJECT_ROOT / "jakarta-aqi-utils-fix"))

from aqi_utils import paths as P            # noqa: E402
from aqi_models.config import ModelConfig   # noqa: E402
from aqi_models.physics import (  # noqa: E402
    pm25_to_ispu, ispu_to_category, ispu_to_color, ISPU_CATEGORY_COLOR)

OFFSETS = ModelConfig().forecast_offsets()                 # [0, 4, 8, 12]
PRED_COLS = [f"pred_a_plus_{o}h" for o in OFFSETS]
SMOOTH_HALF = 14                                            # ±14-day circular smoothing
DEFAULT_ALPHA = 0.5                                         # combined = a*DOY + (1-a)*MW
N_DOY = 366                                                 # cover leap day


# --------------------------------------------------------------------------- #
# Load
# --------------------------------------------------------------------------- #
def discover_forecast(res: int, model: str) -> Path:
    """Newest diurnal forecast_r{res}_{model}_*.parquet (mirror or working),
    excluding the archived pre-diurnal flat file."""
    name = f"forecast_r{res}_{model}_*.parquet"
    cands = glob.glob(f"{P.KAGGLE_INPUT_ROOT}/**/{name}", recursive=True)
    cands += glob.glob(str(P.WORKING_ROOT / "forecasts" / name))
    cands = [c for c in cands if "_archive" not in c.replace("/", "\\")
             and "prediurnal" not in c.lower() and "_flat" not in c.lower()]
    if not cands:
        raise FileNotFoundError(
            f"no diurnal {name} found — mirror the NB6 forecast or pass --forecast.")
    return Path(max(cands, key=os.path.getmtime))


def load_forecast(path: Path) -> pd.DataFrame:
    df = pd.read_parquet(path, columns=["h3_id", "anchor_ts"] + PRED_COLS)
    df["anchor_ts"] = pd.to_datetime(df["anchor_ts"])
    df["slot"] = df["anchor_ts"].dt.hour.astype(int)
    df["month"] = df["anchor_ts"].dt.month.astype(int)
    df["doy"] = df["anchor_ts"].dt.dayofyear.astype(int)
    df["wend"] = (df["anchor_ts"].dt.dayofweek >= 5).astype(int)
    return df


# --------------------------------------------------------------------------- #
# Climatology components
# --------------------------------------------------------------------------- #
def build_components(df: pd.DataFrame):
    """Return (mw, doy_sm, colidx).

    mw      : DataFrame indexed (month, wend, h3_id, slot), columns = PRED_COLS.
    doy_sm  : dict[wend] -> dict[pred_col] -> DataFrame [doy 1..366 x (h3_id,slot)]
              (±14-day circular-smoothed day-of-year seasonal curve).
    colidx  : the (h3_id, slot) MultiIndex column order shared by all frames.
    """
    cells = sorted(df["h3_id"].unique())
    slots = sorted(df["slot"].unique())
    colidx = pd.MultiIndex.from_product([cells, slots], names=["h3_id", "slot"])

    mw = df.groupby(["month", "wend", "h3_id", "slot"])[PRED_COLS].mean()

    doy_sm: dict[int, dict[str, pd.DataFrame]] = {0: {}, 1: {}}
    for w in (0, 1):
        sub = df[df["wend"] == w]
        for c in PRED_COLS:
            piv = (sub.groupby(["doy", "h3_id", "slot"])[c].mean()
                      .unstack(["h3_id", "slot"])
                      .reindex(index=range(1, N_DOY + 1), columns=colidx))
            pad = pd.concat([piv.iloc[-SMOOTH_HALF:], piv, piv.iloc[:SMOOTH_HALF]])
            sm = (pad.rolling(2 * SMOOTH_HALF + 1, center=True, min_periods=1)
                     .mean().iloc[SMOOTH_HALF:-SMOOTH_HALF])
            sm.index = range(1, N_DOY + 1)
            doy_sm[w][c] = sm
    return mw, doy_sm, colidx


def blended_table(mw, doy_sm, colidx, alpha: float) -> pd.DataFrame:
    """Full combined climatology, keyed (doy, wend, h3_id, slot_h) with one
    column per offset (µg/m³). combined = alpha*DOY_smooth + (1-alpha)*MW."""
    # doy -> month map (leap year covers all 366 days)
    doy2month = {int(d.dayofyear): int(d.month)
                 for d in pd.date_range("2024-01-01", "2024-12-31", freq="D")}
    months_for_doy = [doy2month[i] for i in range(1, N_DOY + 1)]

    frames = []
    for w in (0, 1):
        cols = {}
        for c in PRED_COLS:
            mw_w = mw.xs(w, level="wend")[c].unstack(["h3_id", "slot"]).reindex(columns=colidx)
            mw_by_doy = mw_w.reindex(months_for_doy)
            mw_by_doy.index = range(1, N_DOY + 1)
            blended = alpha * doy_sm[w][c] + (1.0 - alpha) * mw_by_doy
            cols[c] = blended.stack(["h3_id", "slot"], future_stack=True)
        wf = pd.DataFrame(cols)
        wf.index = wf.index.set_names(["doy", "h3_id", "slot"])
        wf["wend"] = w
        frames.append(wf.reset_index())
    out = pd.concat(frames, ignore_index=True)
    out = out.rename(columns={"slot": "slot_h"})
    return out[["doy", "wend", "h3_id", "slot_h"] + PRED_COLS]


def curve_for_date(ts: pd.Timestamp, mw, doy_sm, colidx, alpha: float) -> dict:
    """Combined climatology for one date: {pred_col: Series indexed (h3_id, slot)} µg/m³."""
    w = 1 if ts.dayofweek >= 5 else 0
    out = {}
    for c in PRED_COLS:
        mw_v = mw.loc[(ts.month, w)][c].reindex(colidx)
        doy_v = doy_sm[w][c].loc[ts.dayofyear]
        out[c] = alpha * doy_v + (1.0 - alpha) * mw_v
    return out


# --------------------------------------------------------------------------- #
# Verify (proof) — city-mean 6-point day curve, three dates
# --------------------------------------------------------------------------- #
def _city_day_curve(ts, mw, doy_sm, colidx, alpha):
    """City-mean nowcast (offset 0) across the 6 slots for `ts` → list of (slot, ugm3)."""
    now = curve_for_date(ts, mw, doy_sm, colidx, alpha)["pred_a_plus_0h"]
    by_slot = now.groupby(level="slot").mean()           # mean over cells, per slot
    return [(int(s), float(by_slot.loc[s])) for s in by_slot.index]


def verify(mw, doy_sm, colidx, alpha):
    samples = [
        ("Jan weekday", pd.Timestamp("2026-01-14")),   # Wed
        ("Jun weekday", pd.Timestamp("2026-06-17")),   # Wed (today)
        ("Jun weekend", pd.Timestamp("2026-06-20")),   # Sat
    ]
    print(f"\n== VERIFY: city-mean 6-point day-curve (nowcast, ug/m3), equal blend a={alpha} ==")
    print("            " + "  ".join(f"{h:02d}:00" for h, _ in _city_day_curve(samples[0][1], mw, doy_sm, colidx, alpha)))
    rows = {}
    for label, ts in samples:
        cur = _city_day_curve(ts, mw, doy_sm, colidx, alpha)
        rows[label] = cur
        vals = "  ".join(f"{v:5.1f}" for _, v in cur)
        peak = max(cur, key=lambda t: t[1])
        ispu = pm25_to_ispu(peak[1])
        cat = ispu_to_category(ispu) if ispu is not None else "?"
        print(f"  {label:11s} {vals}   | peak {peak[1]:.1f} ug/m3 @ {peak[0]:02d}:00 -> ISPU {ispu:.0f} {cat}")
    # contrasts
    janw = np.array([v for _, v in rows["Jan weekday"]])
    junw = np.array([v for _, v in rows["Jun weekday"]])
    junwe = np.array([v for _, v in rows["Jun weekend"]])
    print(f"\n  seasonality  |Jun - Jan| (weekday): mean {np.mean(np.abs(junw - janw)):.2f} ug/m3 "
          f"(Jan mean {janw.mean():.1f} vs Jun mean {junw.mean():.1f})")
    print(f"  weekday/wknd |Sat - Wed| (June)   : mean {np.mean(np.abs(junwe - junw)):.2f} ug/m3 "
          f"(Wed mean {junw.mean():.1f} vs Sat mean {junwe.mean():.1f})")


# --------------------------------------------------------------------------- #
# Serve (the light daily-cron step): climatology table + date -> NB8-style web JSON
# --------------------------------------------------------------------------- #
def _forecast_point(offset_h, ugm3):
    """MIRRORS notebook_8_inference._forecast_point (pm25_conc mode): clamp neg/NaN -> 0,
    ug/m3 -> ISPU index via pm25_to_ispu, value = round(idx, 1) + category + colour.
    Kept byte-compatible so build_web_data.py --mode live consumes it unchanged."""
    v = float(ugm3)
    if not np.isfinite(v) or v < 0.0:                  # GNN head can dip negative -> clamp
        v = 0.0
    idx = pm25_to_ispu(v)
    if idx is None or not np.isfinite(idx):
        idx = 0.0
    return {"offset_h": int(offset_h), "value": round(idx, 1),
            "category": ispu_to_category(idx), "colour": ispu_to_color(idx)}


def serve(date: pd.Timestamp, res: int, model: str):
    """Emit today's NB8-style web_data JSON from the prebuilt climatology artifact.
    This is the LIGHT step the daily cron runs (pure lookup + reshape, no forecast read):
    select the (doy, weekend) rows -> {h3_id: {slot: [point...]}} + meta -> WORKING/web_data.
    """
    art = P.WORKING_ROOT / "climatology" / f"climatology_r{res}_{model}.parquet"
    if not art.exists():
        raise FileNotFoundError(f"{art} missing — run `build_climatology.py --build` first.")
    tbl = pd.read_parquet(art)
    doy = int(date.dayofyear)
    wend = 1 if date.dayofweek >= 5 else 0
    day = tbl[(tbl["doy"] == doy) & (tbl["wend"] == wend)]
    if day.empty:                                      # e.g. doy 366 on a non-leap lookup
        doy = min(doy, int(tbl["doy"].max()))
        day = tbl[(tbl["doy"] == doy) & (tbl["wend"] == wend)]

    cells: dict = {}
    for _, row in day.iterrows():
        pts = [_forecast_point(o, row[f"pred_a_plus_{o}h"]) for o in OFFSETS]
        cells.setdefault(row["h3_id"], {})[str(int(row["slot_h"]))] = pts
    slot_hours = sorted(int(s) for s in day["slot_h"].unique())

    meta = {
        "resolution": res,
        "anchor_date": str(pd.Timestamp(date).date()),
        "slot_hours": slot_hours,
        "horizons_h": [int(o) for o in OFFSETS],
        "n_horizons": len(OFFSETS),
        "n_slots": len(slot_hours),
        "n_cells": len(cells),
        "category_legend": {c: ISPU_CATEGORY_COLOR[c] for c in ISPU_CATEGORY_COLOR},
        "time_key": "combined_blend: 0.5*(doy+weekend) + 0.5*(month+weekend)",
        "served_by": "build_climatology.py --serve",
    }
    out = P.ensure_dir(P.WORKING_ROOT / "web_data")
    with open(out / f"forecast_r{res}.json", "w") as fh:
        json.dump(cells, fh)
    with open(out / "meta.json", "w") as fh:
        json.dump(meta, fh, indent=2)

    sample = next(iter(cells))
    s0 = sorted(cells[sample], key=int)[0]
    kind = "weekend" if wend else "weekday"
    print(f"[serve] {meta['anchor_date']} (doy {doy}, {kind}) -> {out}")
    print(f"[serve]   {len(cells)} cells x {len(slot_hours)} slots {slot_hours} | horizons {OFFSETS}")
    print(f"[serve]   sample {sample} slot {s0}: "
          + " ".join(f"+{p['offset_h']}h={p['value']}({p['category']})" for p in cells[sample][s0]))


# --------------------------------------------------------------------------- #
# Cron artifact: a compact, committable climatology for the web-repo daily cron
# --------------------------------------------------------------------------- #
def write_cron_artifact(res: int, model: str):
    """Compact, committable copy of the climatology for the web-repo daily cron.

    The web repo (jakarta-aqi-diurnal) is the ONLY git repo (this project root is not),
    so the daily GitHub Actions cron runs THERE, self-contained, with NO aqi_models. It
    reads this compact file (categorical h3_id + small int keys + float32 µg/m³ + zstd)
    and vendors a tiny ISPU snippet. Master stays full-precision for analysis.
    """
    master = P.WORKING_ROOT / "climatology" / f"climatology_r{res}_{model}.parquet"
    if not master.exists():
        raise FileNotFoundError(f"{master} missing — run `--build` first.")
    df = pd.read_parquet(master)
    df["h3_id"] = df["h3_id"].astype("category")
    df["doy"] = df["doy"].astype("int16")
    df["wend"] = df["wend"].astype("int8")
    df["slot_h"] = df["slot_h"].astype("int8")
    for c in PRED_COLS:
        df[c] = df[c].round(2).astype("float32")
    out = P.ensure_dir(PROJECT_ROOT / "web" / "data") / f"climatology_r{res}.parquet"
    df.to_parquet(out, compression="zstd", index=False)
    print(f"[cron-artifact] wrote {out} ({out.stat().st_size / 1e6:.1f} MB, {len(df):,} rows) "
          f"- compact climatology for the web-repo daily cron")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description="Build / verify / serve the time-only AQI climatology.")
    ap.add_argument("--resolution", type=int, default=7)
    ap.add_argument("--model", default="astgcn")
    ap.add_argument("--forecast", default=None, help="explicit forecast parquet (else auto-discover)")
    ap.add_argument("--alpha", type=float, default=DEFAULT_ALPHA, help="blend weight on DOY (1-alpha on MW)")
    ap.add_argument("--verify", action="store_true", help="print the seasonality proof")
    ap.add_argument("--build", action="store_true", help="write the climatology parquet artifact")
    ap.add_argument("--serve", action="store_true",
                    help="emit today's NB8-style web_data JSON from the artifact (the daily-cron step)")
    ap.add_argument("--date", default=None, help="serve date YYYY-MM-DD (default: today WIB)")
    ap.add_argument("--cron-artifact", action="store_true",
                    help="write the compact web/data climatology parquet for the web-repo daily cron")
    args = ap.parse_args()
    if not (args.verify or args.build or args.serve or args.cron_artifact):   # default: build + verify
        args.verify = args.build = True

    if args.build or args.verify:
        fc_path = Path(args.forecast) if args.forecast else discover_forecast(args.resolution, args.model)
        print(f"[clim] forecast: {fc_path}")
        df = load_forecast(fc_path)
        print(f"[clim] rows={len(df):,}  cells={df['h3_id'].nunique()}  slots={sorted(df['slot'].unique())}  "
              f"dates={df['anchor_ts'].dt.normalize().nunique()}")
        mw, doy_sm, colidx = build_components(df)
        print(f"[clim] components built: MW {len(mw):,} rows | DOY smoothed +/-{SMOOTH_HALF}d, blend a={args.alpha}")
        if args.verify:
            verify(mw, doy_sm, colidx, args.alpha)
        if args.build:
            tbl = blended_table(mw, doy_sm, colidx, args.alpha)
            out = P.ensure_dir(P.WORKING_ROOT / "climatology") / f"climatology_r{args.resolution}_{args.model}.parquet"
            tbl.to_parquet(out, index=False)
            nn = int(tbl[PRED_COLS].isna().any(axis=1).sum())
            print(f"\n[clim] wrote {out}")
            print(f"[clim]   {len(tbl):,} rows = {tbl['h3_id'].nunique()} cells x {tbl['slot_h'].nunique()} slots "
                  f"x {N_DOY} doy x 2 wend | offsets {OFFSETS} | rows with any NaN: {nn}")

    if args.serve:
        date = (pd.Timestamp(args.date) if args.date
                else pd.Timestamp.now(tz="Asia/Jakarta").tz_localize(None).normalize())
        serve(date, args.resolution, args.model)

    if args.cron_artifact:
        write_cron_artifact(args.resolution, args.model)


if __name__ == "__main__":
    main()
