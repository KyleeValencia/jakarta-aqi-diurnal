"""
Build compact climatology overlays for the static NB8 daily website data.

Reads:
  web/data/meta.json
  web/data/climatology_r7.parquet

Writes:
  web/data/climatology_r7_YYYY-MM-DD.json

The overlay stores only ISPU numbers:
  {h3_id: {slot_h: [ispu0, ispu4, ispu8, ispu12]}}

The browser blends these numbers with NB8 daily ISPU values, so this script
converts the climatology artifact from PM2.5 ug/m3 to ISPU before writing.
"""

from __future__ import annotations

import argparse
import json
from datetime import date
from pathlib import Path

import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"

PM25_BREAKPOINTS = [
    (0.0, 15.5, 0.0, 50.0),
    (15.6, 55.4, 51.0, 100.0),
    (55.5, 150.4, 101.0, 200.0),
    (150.5, 250.4, 201.0, 300.0),
    (250.5, 500.4, 301.0, 500.0),
]


def pm25_to_ispu(conc: float | None) -> float | None:
    if conc is None or conc != conc or conc < 0:
        return None
    for x_lo, x_hi, i_lo, i_hi in PM25_BREAKPOINTS:
        if conc <= x_hi:
            return (i_hi - i_lo) / (x_hi - x_lo) * (conc - x_lo) + i_lo
    return PM25_BREAKPOINTS[-1][3]


def point_value(ugm3: float | None) -> float:
    if ugm3 is None or ugm3 != ugm3 or ugm3 < 0:
        ugm3 = 0.0
    idx = pm25_to_ispu(float(ugm3))
    if idx is None or idx != idx:
        idx = 0.0
    return round(float(idx), 1)


def selected_dates(meta: dict, only_date: str | None) -> list[str]:
    dates = meta.get("available_dates") or []
    if only_date:
        if only_date not in dates:
            raise ValueError(f"{only_date} is not in meta.available_dates")
        return [only_date]
    if not dates:
        raise ValueError("meta.json has no available_dates")
    return dates


def build_overlay_for_date(rows: dict, offsets: list[int], pred_cols: list[str]) -> dict:
    cells: dict[str, dict[str, list[float]]] = {}
    for i, h3id in enumerate(rows["h3_id"]):
        slot = str(int(rows["slot_h"][i]))
        cells.setdefault(str(h3id), {})[slot] = [
            point_value(rows[col][i]) for col in pred_cols
        ]
    return cells


def main() -> None:
    ap = argparse.ArgumentParser(description="Build NB8 daily climatology overlay JSON files.")
    ap.add_argument("--date", default=None, help="Build one YYYY-MM-DD overlay only.")
    ap.add_argument("--blend-weight", type=float, default=0.5, help="Frontend climatology blend weight.")
    args = ap.parse_args()

    if not 0.0 <= args.blend_weight <= 1.0:
        raise ValueError("--blend-weight must be between 0 and 1")

    meta_path = DATA / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    res = int(meta.get("resolution", 7))
    offsets = [int(v) for v in meta.get("horizons_h", [0, 4, 8, 12])]
    pred_cols = [f"pred_a_plus_{o}h" for o in offsets]
    overlay_pattern = f"climatology_r{res}_{{date}}.json"

    art = DATA / f"climatology_r{res}.parquet"
    if not art.exists():
        raise FileNotFoundError(f"{art} missing")

    dates = selected_dates(meta, args.date)
    table = pq.read_table(art)
    names = set(table.schema.names)
    missing = ["doy", "wend", "h3_id", "slot_h", *pred_cols]
    missing = [c for c in missing if c not in names]
    if missing:
        raise ValueError(f"{art} missing required columns: {missing}")

    df = table.to_pandas()
    built = 0
    total_bytes = 0
    for date_str in dates:
        d = date.fromisoformat(date_str)
        doy = int(d.timetuple().tm_yday)
        wend = 1 if d.weekday() >= 5 else 0
        day = df[(df["doy"] == doy) & (df["wend"] == wend)]
        if day.empty:
            max_doy = int(df["doy"].max())
            day = df[(df["doy"] == min(doy, max_doy)) & (df["wend"] == wend)]
        rows = day[["h3_id", "slot_h", *pred_cols]].to_dict(orient="list")
        payload = build_overlay_for_date(rows, offsets, pred_cols)
        out = DATA / overlay_pattern.replace("{date}", date_str)
        out.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        built += 1
        total_bytes += out.stat().st_size

    modes = [
        {
            "id": "raw",
            "label": "Tanpa klimatologi",
            "description": "Murni hasil model prediksi",
        },
        {
            "id": "blend_climatology",
            "label": "Dengan klimatologi",
            "description": f"{1 - args.blend_weight:.0%} hasil model + {args.blend_weight:.0%} klimatologi ISPU.",
        },
    ]
    meta.update(
        {
            "climatology_file_pattern": overlay_pattern,
            "simulation_modes": modes,
            "default_simulation_mode": "raw",
            "blend_weight": args.blend_weight,
            "climatology_overlay_value": "ISPU index",
            "climatology_overlay_notes": [
                "Overlay values are converted from climatology PM2.5 ug/m3 to ISPU before browser blending.",
                "The blended mode is a simulation/display option, not an independently validated accuracy improvement.",
            ],
        }
    )
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    print(
        f"built={built} pattern={overlay_pattern} total_mb={total_bytes / 1024 / 1024:.2f} "
        f"blend_weight={args.blend_weight}"
    )


if __name__ == "__main__":
    main()
