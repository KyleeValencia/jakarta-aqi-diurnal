"""
update_forecast.py - DAILY CRON (self-contained; runs in the jakarta-aqi-diurnal web repo).
=========================================================================================

The free GitHub Actions daily cron runs THIS. It is deliberately self-contained -- the web
repo has NO aqi_models / aqi_utils -- so it depends only on pyarrow + the standard library,
and reads the compact, committed climatology produced offline by
`build_climatology.py --cron-artifact` (web/data/climatology_r{R}.parquet).

What it does each day (a light SELECTOR, no model run, no live data feed):
  1. today's WIB date -> (day-of-year, weekday/weekend)
  2. read that slice of the climatology (per cell, per slot, the 4 horizon values, ug/m3)
  3. ug/m3 -> ISPU index + category + colour (vendored Permen LHK table, mirrors
     aqi_models.physics)
  4. write web/data/forecast_r{R}.json (the frontend contract) + stamp today's date into
     web/data/meta.json (the static legend / disclaimers there are preserved)

The hex geometry (web/data/hexes_r{R}.geojson) never changes, so the cron leaves it alone.

HONESTY: the values are a TIME-ONLY climatology distilled from the trained AST-GCN forecast
-- the typical air for today's date (season + weekday/weekend), NOT a live measurement. The
within-day shape is CAMS-derived and hourly-unvalidatable (see web/data/meta.json disclaimers).
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
RES = 7
OFFSETS = [0, 4, 8, 12]
PRED_COLS = [f"pred_a_plus_{o}h" for o in OFFSETS]

# --- vendored ISPU (mirrors aqi_models.physics; Permen LHK No. 14/2020 -- regulatory
#     constants, near-zero drift). PM2.5 surface concentration (ug/m3) -> ISPU index. ---
PM25_BREAKPOINTS = [
    (0.0,   15.5,  0.0,   50.0,  "BAIK"),
    (15.6,  55.4,  51.0,  100.0, "SEDANG"),
    (55.5,  150.4, 101.0, 200.0, "TIDAK SEHAT"),
    (150.5, 250.4, 201.0, 300.0, "SANGAT TIDAK SEHAT"),
    (250.5, 500.4, 301.0, 500.0, "BERBAHAYA"),
]
ISPU_INDEX_CATEGORY = [
    (50.0, "BAIK"), (100.0, "SEDANG"), (200.0, "TIDAK SEHAT"),
    (300.0, "SANGAT TIDAK SEHAT"), (float("inf"), "BERBAHAYA"),
]
ISPU_CATEGORY_COLOR = {
    "BAIK": "#00B050", "SEDANG": "#0070C0", "TIDAK SEHAT": "#FFC000",
    "SANGAT TIDAK SEHAT": "#FF0000", "BERBAHAYA": "#000000", "TIDAK ADA DATA": "#BFBFBF",
}


def pm25_to_ispu(conc):
    if conc is None or conc != conc or conc < 0:           # None / NaN / negative
        return None
    for x_lo, x_hi, i_lo, i_hi, _ in PM25_BREAKPOINTS:
        if conc <= x_hi:
            return (i_hi - i_lo) / (x_hi - x_lo) * (conc - x_lo) + i_lo
    return PM25_BREAKPOINTS[-1][3]


def ispu_to_category(idx):
    if idx is None or idx != idx:
        return "TIDAK ADA DATA"
    for upper, cat in ISPU_INDEX_CATEGORY:
        if idx <= upper:
            return cat
    return "BERBAHAYA"


def _point(offset_h, ugm3):
    """{offset_h, value, category, colour}; value = ISPU index. Mirrors NB8 _forecast_point:
    clamp neg/NaN ug/m3 -> 0 (the GNN head can dip negative), then map to ISPU."""
    v = float(ugm3)
    if v != v or v < 0.0:
        v = 0.0
    idx = pm25_to_ispu(v)
    if idx is None or idx != idx:
        idx = 0.0
    return {"offset_h": int(offset_h), "value": round(idx, 1),
            "category": ispu_to_category(idx), "colour": ISPU_CATEGORY_COLOR[ispu_to_category(idx)]}


def today_wib():
    return (datetime.now(timezone.utc) + timedelta(hours=7)).date()


def _slice(art, doy, wend):
    return pq.read_table(art, filters=[("doy", "=", doy), ("wend", "=", wend)]).to_pydict()


def main():
    d = today_wib()
    doy = d.timetuple().tm_yday
    wend = 1 if d.weekday() >= 5 else 0

    art = DATA / f"climatology_r{RES}.parquet"
    if not art.exists():
        raise FileNotFoundError(f"{art} missing - commit build_climatology.py --cron-artifact output.")
    cols = _slice(art, doy, wend)
    if not cols["h3_id"]:                                   # e.g. doy 366 in a non-leap year
        all_doy = pq.read_table(art, columns=["doy"]).column("doy").to_pylist()
        doy = min(doy, max(all_doy))
        cols = _slice(art, doy, wend)

    cells: dict = {}
    slots = set()
    for i in range(len(cols["h3_id"])):
        slot = int(cols["slot_h"][i])
        slots.add(slot)
        cells.setdefault(cols["h3_id"][i], {})[str(slot)] = [
            _point(o, cols[c][i]) for o, c in zip(OFFSETS, PRED_COLS)]
    slot_hours = sorted(slots)

    forecast = {"model_status": "live", "anchor_date": str(d), "resolution": RES,
                "slot_hours": slot_hours, "horizons_h": OFFSETS, "cells": cells}
    (DATA / f"forecast_r{RES}.json").write_text(
        json.dumps(forecast, separators=(",", ":")), encoding="utf-8")

    # Stamp today's date into meta.json; preserve its static legend / disclaimers / colours.
    meta_path = DATA / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta.update({"model_status": "live", "anchor_date": str(d),
                 "slot_hours": slot_hours, "horizons_h": OFFSETS,
                 "n_forecast_cells": len(cells)})
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    kind = "weekend" if wend else "weekday"
    print(f"[cron] {d} (doy {doy}, {kind}): wrote forecast_r{RES}.json "
          f"({len(cells)} cells x {len(slot_hours)} slots) + stamped meta.json")


if __name__ == "__main__":
    main()
