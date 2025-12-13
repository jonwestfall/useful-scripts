#!/usr/bin/env python3
"""
subset_by_state.py

Subset Google Location History JSON records to a single US state.

- Extracts lat/lon points from common Google Location History structures:
    * visit.topCandidate.placeLocation: "geo:lat,lon"
    * activity.start / activity.end: "geo:lat,lon"
    * timelinePath[].point: "geo:lat,lon"
    * (also scans a few other likely geo: fields)
- Includes a record if ANY point in the record falls within the chosen state.
- Streams a top-level JSON array or a keyed array via --records-key, without loading entire file.

Dependencies:
    pip install geopandas shapely pyproj requests

Example:
    python3 subset_by_state.py LocationHistory_2021.json Mississippi --out MS_2021.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

# --- optional external deps ---
try:
    import requests
    import geopandas as gpd
    from shapely.geometry import Point
except Exception as e:
    print(
        "Missing dependencies. Install with:\n"
        "  pip install geopandas shapely pyproj requests\n",
        file=sys.stderr,
    )
    raise

GEO_RE = re.compile(r"^geo:\s*([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)\s*$", re.IGNORECASE)

# Census GeoJSON for US states (cartographic boundary file).
# This is a stable, widely-used endpoint; if it ever changes, swap URL.
CENSUS_STATES_GEOJSON = (
    "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_state_20m.zip"
)

# -----------------------------
# Streaming JSON readers
# -----------------------------

def iter_top_level_array(fp) -> Iterator[Dict[str, Any]]:
    """Stream objects from a top-level JSON array: [ {...}, {...} ]"""
    ch = fp.read(1)
    while ch and ch.isspace():
        ch = fp.read(1)
    if ch != "[":
        raise RuntimeError("Not a top-level JSON array (missing '[').")

    buf: List[str] = []
    depth = 0
    in_str = False
    esc = False

    while True:
        ch = fp.read(1)
        if not ch:
            break

        if in_str:
            buf.append(ch)
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue

        if ch.isspace() or ch == ",":
            continue

        if ch == "{":
            buf = ["{"]
            depth = 1
            in_str = False
            esc = False

            while depth > 0:
                ch = fp.read(1)
                if not ch:
                    raise RuntimeError("Unexpected EOF while reading an object.")
                buf.append(ch)

                if in_str:
                    if esc:
                        esc = False
                    elif ch == "\\":
                        esc = True
                    elif ch == '"':
                        in_str = False
                    continue

                if ch == '"':
                    in_str = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1

            obj = json.loads("".join(buf))
            if isinstance(obj, dict):
                yield obj
            continue

        if ch == "]":
            break


def iter_keyed_array(fp, key: str) -> Iterator[Dict[str, Any]]:
    """
    Stream objects from a JSON array stored under a top-level key:
      { "<key>": [ {...}, {...} ] }
    """
    needle = f'"{key}"'
    window = ""
    while True:
        ch = fp.read(1)
        if not ch:
            raise RuntimeError(f"Could not find key {needle} in file.")
        window = (window + ch)[-max(2048, len(needle) + 20):]
        if needle in window:
            break

    # find the '[' starting the array
    ch = fp.read(1)
    while ch and ch != "[":
        ch = fp.read(1)
    if ch != "[":
        raise RuntimeError(f"Found key {needle} but did not find '[' starting its array.")

    # Now stream objects inside that array
    buf: List[str] = []
    depth = 0
    in_str = False
    esc = False

    while True:
        ch = fp.read(1)
        if not ch:
            break

        if in_str:
            buf.append(ch)
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue

        if ch.isspace() or ch == ",":
            continue

        if ch == "{":
            buf = ["{"]
            depth = 1
            in_str = False
            esc = False

            while depth > 0:
                ch = fp.read(1)
                if not ch:
                    raise RuntimeError("Unexpected EOF while reading an object.")
                buf.append(ch)

                if in_str:
                    if esc:
                        esc = False
                    elif ch == "\\":
                        esc = True
                    elif ch == '"':
                        in_str = False
                    continue

                if ch == '"':
                    in_str = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1

            obj = json.loads("".join(buf))
            if isinstance(obj, dict):
                yield obj
            continue

        if ch == "]":
            break


def iter_records(path: str, records_key: Optional[str]) -> Iterator[Dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as fp:
        # Peek first non-space char
        pos = fp.tell()
        ch = fp.read(1)
        while ch and ch.isspace():
            ch = fp.read(1)
        fp.seek(pos)

        if records_key:
            yield from iter_keyed_array(fp, records_key)
        else:
            if ch != "[":
                raise RuntimeError(
                    "Input must be a top-level JSON array unless you provide --records-key.\n"
                    "If your file looks like {\"records\":[...]}, re-run with --records-key records."
                )
            yield from iter_top_level_array(fp)


# -----------------------------
# Geo extraction
# -----------------------------

def parse_geo(s: Any) -> Optional[Tuple[float, float]]:
    """Parse 'geo:lat,lon' -> (lat, lon)"""
    if not isinstance(s, str):
        return None
    m = GEO_RE.match(s.strip())
    if not m:
        return None
    lat = float(m.group(1))
    lon = float(m.group(2))
    return lat, lon


def extract_points(obj: Dict[str, Any]) -> List[Tuple[float, float]]:
    """
    Extract (lat, lon) points from common Google Location History record patterns.
    Returns list of points (lat, lon).
    """
    pts: List[Tuple[float, float]] = []

    # visit.topCandidate.placeLocation
    visit = obj.get("visit")
    if isinstance(visit, dict):
        tc = visit.get("topCandidate")
        if isinstance(tc, dict):
            pl = parse_geo(tc.get("placeLocation"))
            if pl:
                pts.append(pl)

    # activity.start/end
    activity = obj.get("activity")
    if isinstance(activity, dict):
        s = parse_geo(activity.get("start"))
        e = parse_geo(activity.get("end"))
        if s:
            pts.append(s)
        if e:
            pts.append(e)

    # timelinePath[].point
    tpath = obj.get("timelinePath")
    if isinstance(tpath, list):
        for step in tpath:
            if isinstance(step, dict):
                p = parse_geo(step.get("point"))
                if p:
                    pts.append(p)

    # (Optional) scan a few other likely fields
    # Sometimes coordinates appear in nested candidates or other keys.
    # We do a shallow scan for "geo:" strings.
    for k, v in obj.items():
        if isinstance(v, str) and v.lower().startswith("geo:"):
            p = parse_geo(v)
            if p:
                pts.append(p)

    return pts


# -----------------------------
# State boundary loading
# -----------------------------

@dataclass
class StateGeom:
    name: str
    stusps: str
    geom  : Any  # shapely geometry


def load_states_geoms(cache_dir: str) -> gpd.GeoDataFrame:
    """
    Download (if needed) and load Census cartographic boundary states.
    Returns GeoDataFrame with geometry in EPSG:4326.
    """
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)

    zip_path = cache / "cb_us_state_20m.zip"
    if not zip_path.exists():
        print(f"Downloading state boundaries to {zip_path} ...", file=sys.stderr)
        r = requests.get(CENSUS_STATES_GEOJSON, stream=True, timeout=60)
        r.raise_for_status()
        with open(zip_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)

    # geopandas can read directly from zip
    gdf = gpd.read_file(f"zip://{zip_path}")
    # Ensure lat/lon CRS
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    else:
        gdf = gdf.to_crs("EPSG:4326")
    return gdf


def select_state_geom(states_gdf: gpd.GeoDataFrame, state_query: str) -> StateGeom:
    q = state_query.strip().lower()

    # Common columns in Census state CB files: NAME, STUSPS
    if "NAME" not in states_gdf.columns or "STUSPS" not in states_gdf.columns:
        raise RuntimeError("Unexpected Census file schema: missing NAME/STUSPS columns.")

    # match by name or USPS code
    hit = states_gdf[
        (states_gdf["NAME"].str.lower() == q) | (states_gdf["STUSPS"].str.lower() == q)
    ]
    if hit.empty:
        # allow partial name match
        hit = states_gdf[states_gdf["NAME"].str.lower().str.contains(q, na=False)]
    if hit.empty:
        raise RuntimeError(f"State not found for query: {state_query!r}")

    row = hit.iloc[0]
    return StateGeom(name=row["NAME"], stusps=row["STUSPS"], geom=row["geometry"])


# -----------------------------
# Main
# -----------------------------

def record_in_state(obj: Dict[str, Any], state_geom: Any) -> bool:
    pts = extract_points(obj)
    if not pts:
        return False

    # Point-in-polygon: include record if ANY point is inside
    for lat, lon in pts:
        p = Point(lon, lat)  # shapely uses (x,y) = (lon,lat)
        if state_geom.contains(p):
            return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description="Subset Google Location History JSON to a US state.")
    ap.add_argument("input", help="Input JSON path (top-level array or use --records-key)")
    ap.add_argument("state", help="State name or USPS code (e.g., 'Mississippi' or 'MS')")
    ap.add_argument("--out", default=None, help="Output JSON path (default: <input>_<STATE>.json)")
    ap.add_argument("--records-key", default=None, help="If records live under a key, e.g. 'records'")
    ap.add_argument("--cache-dir", default=".cache_state_shapes", help="Where to cache Census boundary zip")
    ap.add_argument("--limit", type=int, default=None, help="Optional max records to export")
    args = ap.parse_args()

    states = load_states_geoms(args.cache_dir)
    st = select_state_geom(states, args.state)
    out_path = args.out or f"{Path(args.input).stem}_{st.stusps}.json"

    total = 0
    kept = 0

    print(f"Target state: {st.name} ({st.stusps})", file=sys.stderr)
    print(f"Reading: {args.input}", file=sys.stderr)
    print(f"Writing: {out_path}", file=sys.stderr)

    with open(out_path, "w", encoding="utf-8") as out:
        out.write("[\n")
        first = True

        for obj in iter_records(args.input, args.records_key):
            total += 1
            if record_in_state(obj, st.geom):
                if args.limit is not None and kept >= args.limit:
                    continue
                if not first:
                    out.write(",\n")
                json.dump(obj, out, ensure_ascii=False)
                first = False
                kept += 1

            if total % 50000 == 0:
                print(f"Processed {total:,} records; kept {kept:,}", file=sys.stderr)

        out.write("\n]\n")

    print(f"Done. Processed {total:,} records; kept {kept:,}.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

