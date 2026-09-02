"""
Build the per-cell monthly aggregate for the static website (revision feature
B-4; defense-minutes point B6 "monthly air-quality chart for the selected
area", with the ug/m3 column also serving point A5).

Reads:  web/data/forecast_r7_*.json   (the daily ISPU archive files)
Writes: web/data/monthly_r7.json      (~hundreds of KB; ships with the site --
                                       data/ is mirrored by deploy_to_vercel.ps1)

Definition (must match what the site displays): for each cell and archive
date, the daily value is the MAX over the six displayed diurnal points
(offset_h == 0 per clock slot -- the same series app.js renders, raw mode,
no climatology blend). Those daily maxima are averaged per calendar month:

  cells[h3_id][YYYY-MM] = [mean_daily_max_ispu, mean_daily_max_pm25]

The ug/m3 column is the mean of per-day inversions through
aqi_models.physics.ispu_to_pm25 (shared-edge 15.5 -> 50 basis, the same
table that wrote the archive) -- NOT an inversion of the mean index, so it
stays exact across bracket boundaries.

Re-run this whenever the daily forecast JSONs are rebuilt.
"""
from __future__ import annotations

import calendar
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"


def _bootstrap_ispu_to_pm25():
    # Same intent as build_climatology_overlay.py: reuse the pipeline's single
    # ISPU table instead of a local copy (a vendored copy is how the stale
    # 15.6->51 table once crept into this repo's dead fork). The overlay
    # script's HERE.parent path no longer exists in this layout, so accept an
    # env override too.
    candidates = [HERE.parent / "jakarta-aqi-utils-fix"]
    env = os.environ.get("AQI_UTILS_ROOT")
    if env:
        candidates.append(Path(env))
    for cand in candidates:
        if (cand / "aqi_models").is_dir():
            sys.path.insert(0, str(cand))
            from aqi_models.physics import ispu_to_pm25  # noqa: E402
            return ispu_to_pm25
    raise SystemExit(
        "aqi_models not found. Set AQI_UTILS_ROOT to the jakarta-aqi-utils-fix "
        "folder (the one containing aqi_models/)."
    )


def main() -> None:
    ispu_to_pm25 = _bootstrap_ispu_to_pm25()

    files = sorted(DATA.glob("forecast_r7_*.json"))
    dates: list[str] = []
    agg: dict[str, dict[str, list[float]]] = {}  # h3 -> month -> [sum_i, sum_p, n]

    for f in files:
        date_str = f.stem[len("forecast_r7_"):]
        if len(date_str) != 10:  # skip anything that isn't forecast_r7_YYYY-MM-DD
            continue
        dates.append(date_str)
        month = date_str[:7]
        cells = json.loads(f.read_text(encoding="utf-8"))
        for h3, slots in cells.items():
            daily_max = None
            for series in slots.values():
                for p in series:
                    if p.get("offset_h") == 0:
                        v = float(p["value"])
                        if daily_max is None or v > daily_max:
                            daily_max = v
                        break
            if daily_max is None:
                continue
            m = agg.setdefault(h3, {}).setdefault(month, [0.0, 0.0, 0])
            m[0] += daily_max
            m[1] += float(ispu_to_pm25(daily_max) or 0.0)
            m[2] += 1

    if not dates:
        raise SystemExit(f"no forecast_r7_YYYY-MM-DD.json files under {DATA}")

    months = sorted({d[:7] for d in dates})
    days = {mo: sum(1 for d in dates if d[:7] == mo) for mo in months}
    incomplete = {}
    for mo in months:
        cal_days = calendar.monthrange(int(mo[:4]), int(mo[5:]))[1]
        if days[mo] < cal_days:
            incomplete[mo] = f"{days[mo]} dari {cal_days} hari"

    cells_out = {
        h3: {mo: [round(s_i / n, 1), round(s_p / n, 1)] for mo, (s_i, s_p, n) in mm.items()}
        for h3, mm in agg.items()
    }
    payload = {
        "meta": {
            "months": months,
            "days": days,
            "incomplete": incomplete,
            "first_date": min(dates),
            "last_date": max(dates),
            "n_dates": len(dates),
            "definition": (
                "rerata ISPU maksimum harian per bulan (mode tanpa klimatologi); "
                "kolom kedua = rerata inversi ug/m3 harian via aqi_models.physics"
            ),
        },
        "cells": cells_out,
    }

    out = DATA / "monthly_r7.json"
    out.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")

    # Self-check: the archive this was built from is 290 cells x 13 months,
    # with only Feb 2024 short (28 of 29 days -- 2024-02-01 missing).
    assert len(cells_out) == 290, len(cells_out)
    assert len(months) == 13, months
    assert days.get("2024-02") == 28, days.get("2024-02")
    assert "2024-02" in incomplete and "2025-02" not in incomplete, incomplete
    sample = cells_out["878c10799ffffff"]["2024-06"]
    print(f"OK: {len(cells_out)} cells x {len(months)} months, {len(dates)} dates "
          f"({min(dates)}..{max(dates)}), incomplete={incomplete}, "
          f"size={out.stat().st_size:,} B, sample DKI1 2024-06={sample}")


if __name__ == "__main__":
    main()
