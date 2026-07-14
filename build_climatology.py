"""
build_climatology.py
====================

Distil the trained AST-GCN diurnal forecast into a **time-only climatology** for
the static per-date archive website (D-12 deployment, 2026-06-17).

WHY
---
The served forecast must depend on **time only** (no live data feed). The site is a
pure static per-date archive, built once and committed; the browser picks the date, and
NO scheduled task runs — the daily GitHub Actions cron this file once fed was retired
2026-07-04. So the *typical* diurnal curve is precomputed per hex cell by calendar key.

THE TIME KEY = COMBINED (equal blend, ½ DOY + ½ MW)
---------------------------------------------------
Month×weekday and day-of-year+weekday are the SAME seasonal signal at two
resolutions, so they are *blended* rather than stacked:

    climatology(date) = 0.5 * DOY_smooth(day_of_year, weekend)      # daily drift
                      + 0.5 * MW(month, weekend)                    # robust level

  * DOY_smooth — the day-of-year seasonal curve, ±14-day circular-smoothed
    (≈3 samples/day-of-year is thin, so smoothing pools ~a month around each day).
    Gives a value that changes EVERY day.
  * MW — the month×weekday/weekend bucket mean (lots of samples → robust level).
  * weekend = (weekday ∈ {Sat,Sun}); present in BOTH components.

Net: changes every day (daily output is required) but anchored to a stable,
well-sampled monthly level, and smoother than raw month-stepping.

WHAT IT PRODUCES
----------------
Two layers (this script is the heavy, build-ONCE layer):

  --build   forecast parquet → climatology table
            WORKING_ROOT/jakarta_data/climatology/climatology_r{R}_{model}.parquet
            keyed by (doy, weekend, h3_id, slot_h) with one column per offset.
            (Serving reads a committed per-date archive; the light daily cron that
            once selected "today" from this table is retired. Pure lookup either way.)

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
from aqi_models.physics import pm25_to_ispu, ispu_to_category  # noqa: E402

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
# Cron artifact: RETIRED (2026-07-04). Kept for reproducibility, not used to serve.
# --------------------------------------------------------------------------- #
def write_cron_artifact(res: int, model: str):
    """Compact, committable copy of the climatology. RETIRED — not part of serving.

    Written for a daily GitHub Actions cron in the web repo. That cron was retired on
    2026-07-04: the live site is a pure static per-date archive with client-side date
    selection, so no scheduled task reads this file. The function and the
    `--cron-artifact` flag are kept because the compact encoding (categorical h3_id +
    small int keys + float32 µg/m³ + zstd) is still the cheapest way to ship the table.
    Master stays full-precision for analysis.
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
          f"- compact climatology, retired cron artifact (kept for reproducibility)")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description="Build / verify the time-only AQI climatology.")
    ap.add_argument("--resolution", type=int, default=7)
    ap.add_argument("--model", default="astgcn")
    ap.add_argument("--forecast", default=None, help="explicit forecast parquet (else auto-discover)")
    ap.add_argument("--alpha", type=float, default=DEFAULT_ALPHA, help="blend weight on DOY (1-alpha on MW)")
    ap.add_argument("--verify", action="store_true", help="print the seasonality proof")
    ap.add_argument("--build", action="store_true", help="write the climatology parquet artifact")
    ap.add_argument("--cron-artifact", action="store_true",
                    help="write the compact web/data climatology parquet (cron RETIRED; kept for reproducibility)")
    args = ap.parse_args()
    if not (args.verify or args.build or args.cron_artifact):   # default: build + verify
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

    if args.cron_artifact:
        write_cron_artifact(args.resolution, args.model)


if __name__ == "__main__":
    main()
