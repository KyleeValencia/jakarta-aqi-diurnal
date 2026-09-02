"""
Build the static gazetteer for the location-search feature (revision B-3;
defense-minutes point B5 "search by a specific location").

One-off build step WITH network access (Overpass API); the site itself stays
fully static and offline -- it only reads the JSON this writes.

Writes: web/data/gazetteer_dki.json
  {"meta": {...}, "entries": [[label, lat, lon], ...]}   (label is unique)

Sources:
  - OpenStreetMap via Overpass: DKI Jakarta administrative boundaries,
    admin_level 6 (kecamatan) and 7 (kelurahan), center points only.
    (c) OpenStreetMap contributors, ODbL 1.0 -- recorded in the meta block
    and in vendor/THIRD_PARTY_NOTICES.md.
  - Local catalog of udara.jakarta.go.id sensor stations (names + coords)
    as searchable landmarks.

Entries whose point falls outside the r7 study grid (hexes_r7.geojson) are
dropped -- e.g. Kepulauan Seribu -- so every search hit resolves to a cell
the site can actually display.
"""
from __future__ import annotations

import csv
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import h3  # v4 API (latlng_to_cell), same convention as the pipeline

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"

# Main instance first, public mirror as fallback (main returns 504 when busy).
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
OVERPASS_QUERY = """
[out:json][timeout:120];
area["ISO3166-2"="ID-JK"]->.jkt;
(
  relation(area.jkt)["boundary"="administrative"]["admin_level"="6"];
  relation(area.jkt)["boundary"="administrative"]["admin_level"="7"];
);
out tags center;
"""

# Landmark source: the sensor catalog snapshot already in the repo.
STATION_CSV = Path(
    r"C:\Users\Lenovo\Documents\AQI research data Kaggle Notebook Jupyter"
    r"\udara_live_pull\udara_station_catalog_2026-06-11_0144.csv"
)

ADMIN_TYPE = {"6": "kecamatan", "7": "kelurahan"}


def grid_cells() -> set[str]:
    gj = json.loads((DATA / "hexes_r7.geojson").read_text(encoding="utf-8"))
    return {f["properties"]["h3_id"] for f in gj["features"]}


def fetch_overpass() -> list[dict]:
    last_err = None
    for url in OVERPASS_URLS:
        for attempt in (1, 2):
            req = urllib.request.Request(
                url,
                data=("data=" + urllib.parse.quote(OVERPASS_QUERY)).encode("utf-8"),
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    # overpass-api.de rejects the default Python UA with HTTP 406
                    "User-Agent": "jakarta-aqi-thesis-gazetteer/1.0 (one-off build script)",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=180) as resp:
                    return json.loads(resp.read().decode("utf-8"))["elements"]
            except Exception as e:  # 504 when busy; try again, then the mirror
                last_err = e
                print(f"  {url} attempt {attempt} failed: {e}")
                time.sleep(5)
    raise SystemExit(f"all Overpass endpoints failed: {last_err}")


def main() -> None:
    cells = grid_cells()
    in_grid = lambda lat, lon: h3.latlng_to_cell(lat, lon, 7) in cells  # noqa: E731

    entries: list[tuple[str, float, float]] = []
    dropped_outside = 0

    # --- OSM admin boundaries -------------------------------------------------
    elements = fetch_overpass()
    n_admin = 0
    for el in elements:
        tags = el.get("tags", {})
        center = el.get("center")
        name = tags.get("name")
        typ = ADMIN_TYPE.get(tags.get("admin_level", ""))
        if not (name and center and typ):
            continue
        lat, lon = float(center["lat"]), float(center["lon"])
        if not in_grid(lat, lon):
            dropped_outside += 1
            continue
        entries.append((f"{name} ({typ})", round(lat, 5), round(lon, 5)))
        n_admin += 1

    if n_admin < 100:
        sys.exit(f"Overpass returned only {n_admin} in-grid admin areas -- "
                 "response looks incomplete, refusing to write a thin gazetteer.")

    # --- local sensor landmarks ----------------------------------------------
    n_sensor = 0
    with STATION_CSV.open(encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            lat, lon = float(row["latitude"]), float(row["longitude"])
            if not in_grid(lat, lon):
                dropped_outside += 1
                continue
            entries.append((f'{row["station"]} (sensor)', round(lat, 5), round(lon, 5)))
            n_sensor += 1

    # --- dedupe + write -------------------------------------------------------
    seen: dict[str, tuple[float, float]] = {}
    dup = 0
    for label, lat, lon in entries:
        if label in seen:
            dup += 1
            continue
        seen[label] = (lat, lon)
    out_entries = [[label, lat, lon] for label, (lat, lon) in sorted(seen.items())]

    payload = {
        "meta": {
            "license": ("Admin boundaries (c) OpenStreetMap contributors, ODbL 1.0 "
                        "(openstreetmap.org/copyright), via Overpass API; sensor "
                        "landmarks from the udara.jakarta.go.id station catalog "
                        "snapshot 2026-06-11."),
            "n_admin": n_admin,
            "n_sensor": n_sensor,
        },
        "entries": out_entries,
    }
    out = DATA / "gazetteer_dki.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    print(f"OK: {len(out_entries)} entries ({n_admin} admin + {n_sensor} sensor, "
          f"{dup} duplicate labels merged, {dropped_outside} outside grid), "
          f"size={out.stat().st_size:,} B")


if __name__ == "__main__":
    main()
