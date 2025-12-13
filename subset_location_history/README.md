# Google Location History Subsetter

This directory contains a small Python utility for working with **very large Google Location History JSON exports** (e.g., from Google Takeout) that are too big to load into ChatGPT or typical tools all at once.

The script **streams** the data instead of loading it into memory, so it works even on multi-GB files.

---

## What This Script Does

`subset_location_history.py` can:

1. **Scan a large JSON file** and report the **earliest and latest timestamps** it contains
2. **Export a subset** of records between two dates into a smaller JSON file
3. Handle multiple Google export formats:
   - NDJSON (one JSON object per line)
   - A top-level JSON array (`[ {...}, {...} ]`)
   - A JSON object containing a list under a key (e.g. `"records": [ ... ]`)

All timestamps are normalized to **UTC** internally.

---

## Requirements

- Python **3.9+** (no external libraries required)
- Enough disk space for the subset output file

---

## Basic Usage

### 1️⃣ Scan the date range of a file

This tells you what time span the file actually covers.

```bash
python3 subset_location_history.py LocationHistory.json --mode scan
```

Output example:

```text
Records scanned: 1248392
Earliest (UTC): 2010-06-18T19:57:03+00:00
Latest   (UTC): 2024-11-02T03:41:55+00:00
```

---

### 2️⃣ Export a date-limited subset

Example: export **calendar year 2021** only.

```bash
python3 subset_location_history.py LocationHistory.json \
  --mode export \
  --from 2021-01-01T00:00:00Z \
  --to   2021-12-31T23:59:59Z \
  --out  LocationHistory_2021.json
```

The output file will be a valid JSON array.

---

## Common Google Takeout Variants

### 📁 JSON object with records under a key

Some Google exports look like:

```json
{
  "records": [
    { ... },
    { ... }
  ]
}
```

In that case, specify the key name:

```bash
python3 subset_location_history.py LocationHistory.json \
  --mode scan \
  --records-key records
```

---

### 📄 NDJSON (one object per line)

If each line is its own JSON object, the script will auto-detect this format.  
No extra flags needed.

---

## Timestamp Handling

By default, the script looks for:

```
startTime
endTime
```

You can override this if needed:

```bash
--time-fields startTime,endTime,activityTime
```

If timestamps appear in unexpected places, you can enable a broader scan:

```bash
--scan-all-times
```

⚠️ This scans all string fields in each record (slower, but thorough).

---

## Optional Flags

| Flag | Purpose |
|-----|--------|
| `--limit N` | Export at most `N` matching records |
| `--out FILE` | Output file path (default: `subset.json`) |
| `--from` | Start datetime (inclusive) |
| `--to` | End datetime (inclusive) |

Date formats accepted:
- `YYYY-MM-DD`
- `YYYY-MM-DDTHH:MM:SSZ`
- `YYYY-MM-DDTHH:MM:SS±HH:MM`

---

## Notes for Future Me

- The script **streams** records; memory usage stays low even for huge files.
- A record is included if **any** of its timestamps overlap the requested range.
- Output timestamps are unchanged; only filtering uses UTC normalization.
- If parsing fails early, the file is probably a single JSON object → use `--records-key`.

---

## Typical Workflow

1. Run `--mode scan` to learn the real date range
2. Decide what slice you want
3. Export that slice
4. Feed the smaller file into ChatGPT / Python / GIS tools

---

## Why This Exists

Because Google Location History files are enormous, ChatGPT has limits, and *future me will not remember how any of this works.*

You’re welcome, future me. 🙂
