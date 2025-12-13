#!/usr/bin/env python3
"""
subset_location_history.py

Stream-scan a large Google Location History JSON file to:
  1) report the min/max timestamps found
  2) export a subset of records within a time range

Supports:
  - NDJSON (one JSON object per line)
  - Top-level JSON array: [ {...}, {...}, ... ]
  - JSON object with a list under a key, e.g. {"records":[...]} via --records-key
  - Time fields like "startTime", "endTime", or any ISO-8601-like string fields if --scan-all-times

Time parsing:
  - Handles "Z" and "+/-HH:MM" offsets (e.g., 2021-12-19T06:00:00.000Z, 2010-06-18T17:37:31.100-04:00)
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

# ---- time parsing ----

def parse_dt(s: str) -> Optional[datetime]:
    """
    Parse ISO 8601-ish timestamps commonly seen in Google exports.
    Returns timezone-aware datetime in UTC.
    """
    if not isinstance(s, str):
        return None
    s = s.strip()
    if not s:
        return None

    # Convert trailing Z to +00:00 for fromisoformat
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"

    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None

    # Make timezone-aware; assume UTC if naive
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)

    return dt.astimezone(timezone.utc)


def extract_times(
    obj: Dict[str, Any],
    time_fields: List[str],
    scan_all_times: bool = False,
) -> List[datetime]:
    """
    Pull timestamps from a record.
    Default: only looks at specific fields like startTime/endTime.
    Optional: scan all string fields for parseable datetimes.
    """
    out: List[datetime] = []

    if not scan_all_times:
        for f in time_fields:
            if f in obj:
                dt = parse_dt(obj.get(f))
                if dt:
                    out.append(dt)
        return out

    # Scan all string values in the object (shallow scan, to avoid huge recursion)
    for k, v in obj.items():
        if isinstance(v, str):
            dt = parse_dt(v)
            if dt:
                out.append(dt)
    return out


# ---- streaming JSON readers ----

def iter_ndjson(fp) -> Iterator[Dict[str, Any]]:
    for lineno, line in enumerate(fp, start=1):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"NDJSON parse error on line {lineno}: {e}") from e
        if isinstance(obj, dict):
            yield obj
        else:
            # Some NDJSON variants might store arrays per line; skip safely
            continue


def iter_top_level_array(fp) -> Iterator[Dict[str, Any]]:
    """
    Stream a top-level JSON array without loading it all.
    Minimal character-level parser: reads one object at a time.

    Assumes array elements are JSON objects.
    """
    # Read until '['
    ch = fp.read(1)
    while ch and ch.isspace():
        ch = fp.read(1)
    if ch != "[":
        raise RuntimeError("Not a top-level JSON array (missing '[').")

    buf = []
    depth = 0
    in_str = False
    esc = False

    # Read characters until we find objects {...}
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

        if ch == '"':
            # String outside an object (rare); ignore
            in_str = True
            buf.append(ch)
            continue

        if ch == "{":
            # Start collecting an object
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

            # We have a full JSON object in buf
            raw = "".join(buf)
            obj = json.loads(raw)
            if isinstance(obj, dict):
                yield obj
            # After object ends, loop continues (skipping commas/whitespace/etc.)
            continue

        if ch == "]":
            break

        # Ignore other tokens (numbers/null/etc.) at top-level if present


def iter_json_records(fp, records_key: Optional[str]) -> Iterator[Dict[str, Any]]:
    """
    Try NDJSON first. If it fails, fall back to streaming a top-level array.
    If records_key is provided, expects a top-level object with that key holding an array,
    and will stream that array by scanning until it finds '"records_key": [' then reading objects.
    """
    if records_key:
        yield from iter_keyed_array(fp, records_key)
        return

    # Heuristic: if first non-whitespace is '{' or '[' determine mode
    pos = fp.tell()
    first = fp.read(1)
    while first and first.isspace():
        first = fp.read(1)
    fp.seek(pos)

    if first == "[":
        yield from iter_top_level_array(fp)
        return

    # If it looks like NDJSON (often starts with '{' but has many lines)
    if first == "{":
        # Try NDJSON; if it errors early, user likely has a big object/array format
        try:
            yield from iter_ndjson(fp)
            return
        except RuntimeError:
            fp.seek(0)
            # Fall back: maybe it's a big JSON object (not NDJSON) -> ask user to use --records-key
            raise RuntimeError(
                "File starts with '{' but isn't valid NDJSON.\n"
                "If your export is a single JSON object containing a list (e.g., {'records':[...]}), "
                "re-run with --records-key records (or the correct key name)."
            )

    raise RuntimeError("Unrecognized JSON format. Expected NDJSON, top-level array, or --records-key.")


def iter_keyed_array(fp, key: str) -> Iterator[Dict[str, Any]]:
    """
    Stream objects from a JSON array stored under a top-level key.

    This is a pragmatic scanner: it finds the substring '"<key>"' then the next '['
    and then streams objects in that array like iter_top_level_array does, but starting
    from that point.

    Works for large files without loading all content.
    """
    needle = f'"{key}"'
    window = ""
    # Scan for the key
    while True:
        ch = fp.read(1)
        if not ch:
            raise RuntimeError(f"Could not find key {needle} in file.")
        window = (window + ch)[-max(1024, len(needle) + 10):]
        if needle in window:
            break

    # Now scan forward to the first '[' after the key
    ch = fp.read(1)
    while ch and ch != "[":
        ch = fp.read(1)
    if ch != "[":
        raise RuntimeError(f"Found key {needle} but did not find '[' starting its array.")

    # Now stream objects from this array
    # Reuse the object-capture logic (similar to iter_top_level_array, but we are already inside the array)
    buf = []
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


# ---- main operations ----

def update_range(current: Optional[Tuple[datetime, datetime]], times: List[datetime]) -> Optional[Tuple[datetime, datetime]]:
    if not times:
        return current
    mn = min(times)
    mx = max(times)
    if current is None:
        return (mn, mx)
    return (min(current[0], mn), max(current[1], mx))


def in_range(times: List[datetime], start: Optional[datetime], end: Optional[datetime]) -> bool:
    """
    Decide whether a record is in range.
    If it has multiple times, we include it if ANY timestamp overlaps the requested window.
    """
    if not times:
        return False
    rec_min = min(times)
    rec_max = max(times)
    if start and rec_max < start:
        return False
    if end and rec_min > end:
        return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Scan and subset large Google Location JSON exports.")
    ap.add_argument("input", help="Path to input JSON file")
    ap.add_argument("--mode", choices=["scan", "export"], default="scan",
                    help="scan: print date range; export: write subset file")
    ap.add_argument("--out", default="subset.json", help="Output file path for export mode")
    ap.add_argument("--from", dest="from_dt", default=None,
                    help="Start datetime (inclusive). Example: 2021-01-01 or 2021-01-01T00:00:00Z")
    ap.add_argument("--to", dest="to_dt", default=None,
                    help="End datetime (inclusive). Example: 2021-12-31 or 2021-12-31T23:59:59Z")
    ap.add_argument("--time-fields", default="startTime,endTime",
                    help="Comma-separated fields to treat as timestamps (default: startTime,endTime)")
    ap.add_argument("--scan-all-times", action="store_true",
                    help="Also attempt to parse any string fields as datetimes (shallow scan).")
    ap.add_argument("--records-key", default=None,
                    help="If JSON is a single object containing an array under this key, stream that array.")
    ap.add_argument("--limit", type=int, default=None,
                    help="Optional max records to export (export mode only).")
    args = ap.parse_args()

    time_fields = [x.strip() for x in args.time_fields.split(",") if x.strip()]

    start = parse_dt(args.from_dt) if args.from_dt else None
    end = parse_dt(args.to_dt) if args.to_dt else None

    if start and end and end < start:
        print("Error: --to is earlier than --from", file=sys.stderr)
        return 2

    overall: Optional[Tuple[datetime, datetime]] = None
    total = 0
    matched = 0

    if args.mode == "export" and (start is None and end is None):
        print("Error: export mode requires at least --from or --to", file=sys.stderr)
        return 2

    with open(args.input, "r", encoding="utf-8") as fp:
        records = iter_json_records(fp, args.records_key)

        if args.mode == "scan":
            for obj in records:
                total += 1
                times = extract_times(obj, time_fields, scan_all_times=args.scan_all_times)
                overall = update_range(overall, times)

            if overall is None:
                print("No parseable timestamps found.")
                return 1

            print(f"Records scanned: {total}")
            print(f"Earliest (UTC): {overall[0].isoformat()}")
            print(f"Latest   (UTC): {overall[1].isoformat()}")
            return 0

        # export mode
        with open(args.out, "w", encoding="utf-8") as out:
            out.write("[\n")
            first_written = True

            for obj in records:
                total += 1
                times = extract_times(obj, time_fields, scan_all_times=args.scan_all_times)
                overall = update_range(overall, times)

                if in_range(times, start, end):
                    if args.limit is not None and matched >= args.limit:
                        continue
                    if not first_written:
                        out.write(",\n")
                    json.dump(obj, out, ensure_ascii=False)
                    first_written = False
                    matched += 1

            out.write("\n]\n")

    if overall:
        print(f"Records scanned: {total}")
        print(f"Earliest (UTC): {overall[0].isoformat()}")
        print(f"Latest   (UTC): {overall[1].isoformat()}")
    print(f"Records exported: {matched}")
    print(f"Wrote: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

