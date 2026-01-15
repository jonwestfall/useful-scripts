import time
import datetime as dt
import serial
import requests

CONFIG = {
    "serial_port": "COM3",
    "baudrate": 115200,
    "serial_timeout_s": 2,

    "web_app_url": "https://script.google.com/macros/s/AKfycbxJa13KJcu74a5MHqSs34sdENElzle07lYkxZu3LNI24MYOhpdRYuORolcfpznkgqf5/exec",
    "secret": "CHANGER",

    "interval_seconds": 60,
    "sensor_name": "SHT41-1",
}

def utc_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

def c_to_f(c: float) -> float:
    return (c * 9.0 / 5.0) + 32.0

def parse_temp(line: str):
    """
    Expected formats:
      1) "4023340879, 31.08, 14.75, 184"  -> temp is field 2 (index 1)
      2) "23.56"
      3) "timestamp,23.56"
      4) "temp=23.56"
    Returns: (temp_c or None, raw_line)
    """
    raw = line.strip()
    if not raw:
        return None, raw

    # Comma-separated case
    if "," in raw:
        parts = [p.strip() for p in raw.split(",")]

        # Your observed format: 4 columns, temp is column 2
        if len(parts) >= 2:
            # Prefer column 2 (index 1) as temperature, if it parses and is sane
            try:
                candidate = float(parts[1])
                if -40.0 <= candidate <= 125.0:
                    return candidate, raw
            except ValueError:
                pass

        # Fallback: try any field that looks like a sane temperature
        for p in parts:
            try:
                candidate = float(p)
                if -40.0 <= candidate <= 125.0:
                    return candidate, raw
            except ValueError:
                continue

        return None, raw

    # key=value case
    if "=" in raw:
        candidate = raw.split("=")[-1].strip()
        try:
            candidate_f = float(candidate)
            if -40.0 <= candidate_f <= 125.0:
                return candidate_f, raw
        except ValueError:
            return None, raw

    # plain number
    try:
        candidate = float(raw)
        if -40.0 <= candidate <= 125.0:
            return candidate, raw
        return None, raw
    except ValueError:
        return None, raw


def post_row(temp_c, raw_line):
    payload = {
        "secret": CONFIG["secret"],
        "timestamp_utc": utc_iso(),
        "temp_c": round(temp_c, 2) if temp_c is not None else "",
        "temp_f": round(c_to_f(temp_c), 2) if temp_c is not None else "",
        "raw": raw_line,
        "sensor_name": CONFIG["sensor_name"],
    }
    r = requests.post(CONFIG["web_app_url"], json=payload, timeout=10)
    r.raise_for_status()
    return r.text

def seconds_until_next_minute():
    now = dt.datetime.now()
    next_min = now.replace(second=0, microsecond=0) + dt.timedelta(minutes=1)
    return max(0.0, (next_min - now).total_seconds())

def main():
    with serial.Serial(CONFIG["serial_port"], CONFIG["baudrate"], timeout=CONFIG["serial_timeout_s"]) as ser:
        time.sleep(2)
        try:
            ser.reset_input_buffer()
        except Exception:
            pass

        while True:
            time.sleep(seconds_until_next_minute())

            temp_c = None
            raw_line = ""
            for _ in range(10):
                line = ser.readline().decode("utf-8", errors="replace").strip()
                tc, raw = parse_temp(line)
                raw_line = raw
                if tc is not None:
                    temp_c = tc
                    break

            try:
                resp = post_row(temp_c, raw_line)
                print("Logged:", utc_iso(), temp_c, resp)
            except Exception as e:
                print("Log failed:", e)

if __name__ == "__main__":
    main()
