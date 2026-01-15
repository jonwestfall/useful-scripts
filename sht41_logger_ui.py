import time
import datetime as dt
import threading
import queue
import tkinter as tk
from tkinter import ttk, messagebox

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

    # Keep your current behavior (align to next minute)
    "align_to_minute": True,

    # Sanity range for temp parsing
    "temp_min_c": -40.0,
    "temp_max_c": 125.0,
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

    tmin = CONFIG["temp_min_c"]
    tmax = CONFIG["temp_max_c"]

    if "," in raw:
        parts = [p.strip() for p in raw.split(",")]

        # Your observed format: 4 columns, temp is column 2
        if len(parts) >= 2:
            try:
                candidate = float(parts[1])
                if tmin <= candidate <= tmax:
                    return candidate, raw
            except ValueError:
                pass

        # Fallback: try any field that looks like a sane temperature
        for p in parts:
            try:
                candidate = float(p)
                if tmin <= candidate <= tmax:
                    return candidate, raw
            except ValueError:
                continue

        return None, raw

    if "=" in raw:
        candidate = raw.split("=")[-1].strip()
        try:
            candidate_f = float(candidate)
            if tmin <= candidate_f <= tmax:
                return candidate_f, raw
        except ValueError:
            return None, raw

    try:
        candidate = float(raw)
        if tmin <= candidate <= tmax:
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


class LoggerWorker(threading.Thread):
    """
    Background logger thread. Communicates back to the UI via a queue of events.
    """
    def __init__(self, ui_queue: queue.Queue, stop_event: threading.Event):
        super().__init__(daemon=True)
        self.ui_queue = ui_queue
        self.stop_event = stop_event

    def emit(self, event_type: str, message: str = "", **data):
        payload = {"type": event_type, "message": message, **data}
        self.ui_queue.put(payload)

    def run(self):
        self.emit("status", "Starting logger…")

        try:
            with serial.Serial(
                CONFIG["serial_port"],
                CONFIG["baudrate"],
                timeout=CONFIG["serial_timeout_s"]
            ) as ser:
                time.sleep(2)
                try:
                    ser.reset_input_buffer()
                except Exception:
                    pass

                self.emit("status", f"Connected to {CONFIG['serial_port']} @ {CONFIG['baudrate']}")

                while not self.stop_event.is_set():
                    # Sleep strategy
                    if CONFIG.get("align_to_minute", True):
                        sleep_s = seconds_until_next_minute()
                        # Allow stop during sleep
                        if self._sleep_interruptible(sleep_s):
                            break
                    else:
                        if self._sleep_interruptible(CONFIG["interval_seconds"]):
                            break

                    # Read temperature
                    temp_c = None
                    raw_line = ""
                    for _ in range(10):
                        if self.stop_event.is_set():
                            break
                        line = ser.readline().decode("utf-8", errors="replace").strip()
                        tc, raw = parse_temp(line)
                        raw_line = raw
                        if tc is not None:
                            temp_c = tc
                            break

                    if self.stop_event.is_set():
                        break

                    # Update UI with last reading
                    if temp_c is not None:
                        self.emit(
                            "reading",
                            "",
                            timestamp=utc_iso(),
                            temp_c=temp_c,
                            temp_f=c_to_f(temp_c),
                            raw=raw_line
                        )
                    else:
                        self.emit(
                            "reading",
                            "No valid temperature reading this cycle",
                            timestamp=utc_iso(),
                            temp_c=None,
                            temp_f=None,
                            raw=raw_line
                        )

                    # Post to Sheets
                    try:
                        resp = post_row(temp_c, raw_line)
                        self.emit("posted", f"Posted OK: {resp}", timestamp=utc_iso())
                    except Exception as e:
                        self.emit("error", f"Post failed: {e}", timestamp=utc_iso())

        except Exception as e:
            self.emit("error", f"Serial open failed: {e}")

        self.emit("status", "Logger stopped.")

    def _sleep_interruptible(self, seconds: float) -> bool:
        """
        Sleep in small chunks so Stop responds quickly.
        Returns True if stop_event was set during sleep.
        """
        end = time.time() + max(0.0, seconds)
        while time.time() < end:
            if self.stop_event.is_set():
                return True
            time.sleep(min(0.25, end - time.time()))
        return self.stop_event.is_set()


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("SHT41 Logger")
        self.geometry("560x320")
        self.resizable(False, False)

        self.ui_queue = queue.Queue()
        self.stop_event = threading.Event()
        self.worker = None

        self._build_ui()
        self._poll_queue()

    def _build_ui(self):
        pad = {"padx": 10, "pady": 6}

        # Config frame
        frm = ttk.LabelFrame(self, text="Settings")
        frm.pack(fill="x", **pad)

        self.port_var = tk.StringVar(value=CONFIG["serial_port"])
        self.baud_var = tk.IntVar(value=CONFIG["baudrate"])
        self.sensor_var = tk.StringVar(value=CONFIG["sensor_name"])
        self.align_var = tk.BooleanVar(value=CONFIG.get("align_to_minute", True))

        row = 0
        ttk.Label(frm, text="COM Port:").grid(column=0, row=row, sticky="w", **pad)
        ttk.Entry(frm, textvariable=self.port_var, width=10).grid(column=1, row=row, sticky="w", **pad)

        ttk.Label(frm, text="Baud:").grid(column=2, row=row, sticky="w", **pad)
        ttk.Entry(frm, textvariable=self.baud_var, width=10).grid(column=3, row=row, sticky="w", **pad)

        row += 1
        ttk.Label(frm, text="Sensor name:").grid(column=0, row=row, sticky="w", **pad)
        ttk.Entry(frm, textvariable=self.sensor_var, width=20).grid(column=1, row=row, sticky="w", **pad)

        ttk.Checkbutton(frm, text="Align to minute boundary", variable=self.align_var).grid(
            column=2, row=row, columnspan=2, sticky="w", **pad
        )

        # Control frame
        ctrl = ttk.Frame(self)
        ctrl.pack(fill="x", **pad)

        self.start_btn = ttk.Button(ctrl, text="Start Logging", command=self.start_logging)
        self.start_btn.pack(side="left", padx=5)

        self.stop_btn = ttk.Button(ctrl, text="Stop", command=self.stop_logging, state="disabled")
        self.stop_btn.pack(side="left", padx=5)

        # Status frame
        st = ttk.LabelFrame(self, text="Status")
        st.pack(fill="both", expand=True, **pad)

        self.status_var = tk.StringVar(value="Idle.")
        self.last_read_var = tk.StringVar(value="—")
        self.last_post_var = tk.StringVar(value="—")

        ttk.Label(st, text="State:").grid(column=0, row=0, sticky="w", **pad)
        ttk.Label(st, textvariable=self.status_var).grid(column=1, row=0, sticky="w", **pad)

        ttk.Label(st, text="Last reading:").grid(column=0, row=1, sticky="w", **pad)
        ttk.Label(st, textvariable=self.last_read_var).grid(column=1, row=1, sticky="w", **pad)

        ttk.Label(st, text="Last post:").grid(column=0, row=2, sticky="w", **pad)
        ttk.Label(st, textvariable=self.last_post_var).grid(column=1, row=2, sticky="w", **pad)

        # Make the second column expand visually (even though window is fixed)
        st.grid_columnconfigure(1, weight=1)

    def start_logging(self):
        if self.worker and self.worker.is_alive():
            return

        # Apply UI settings to CONFIG
        CONFIG["serial_port"] = self.port_var.get().strip()
        CONFIG["baudrate"] = int(self.baud_var.get())
        CONFIG["sensor_name"] = self.sensor_var.get().strip() or CONFIG["sensor_name"]
        CONFIG["align_to_minute"] = bool(self.align_var.get())

        if not CONFIG["serial_port"].upper().startswith("COM"):
            messagebox.showerror("Invalid COM port", "Please enter a valid COM port like COM3.")
            return

        self.stop_event.clear()
        self.worker = LoggerWorker(self.ui_queue, self.stop_event)
        self.worker.start()

        self.status_var.set("Running…")
        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")

    def stop_logging(self):
        if not self.worker:
            return
        self.stop_event.set()
        self.status_var.set("Stopping…")
        self.stop_btn.configure(state="disabled")

        # Re-enable Start after the worker actually stops (handled via queue)
        # But in case it’s stuck, we’ll re-enable after a short delay.
        self.after(1500, lambda: self.start_btn.configure(state="normal"))

    def _poll_queue(self):
        try:
            while True:
                evt = self.ui_queue.get_nowait()
                self._handle_event(evt)
        except queue.Empty:
            pass
        self.after(200, self._poll_queue)

    def _handle_event(self, evt: dict):
        et = evt.get("type")

        if et == "status":
            self.status_var.set(evt.get("message", ""))

            # If worker indicates stopped, reset buttons
            if "stopped" in (evt.get("message", "").lower()):
                self.start_btn.configure(state="normal")
                self.stop_btn.configure(state="disabled")

        elif et == "reading":
            ts = evt.get("timestamp", "")
            temp_c = evt.get("temp_c")
            temp_f = evt.get("temp_f")
            raw = evt.get("raw", "")

            if temp_c is None:
                self.last_read_var.set(f"{ts} | (no valid temp) | raw: {raw}")
            else:
                self.last_read_var.set(f"{ts} | {temp_c:.2f} °C / {temp_f:.2f} °F | raw: {raw}")

        elif et == "posted":
            ts = evt.get("timestamp", "")
            msg = evt.get("message", "")
            self.last_post_var.set(f"{ts} | {msg}")

        elif et == "error":
            ts = evt.get("timestamp", "")
            msg = evt.get("message", "")
            self.last_post_var.set(f"{ts} | {msg}")
            self.status_var.set("Error (see Last post).")

        else:
            # Unknown event type
            pass


def main():
    app = App()
    app.mainloop()


if __name__ == "__main__":
    main()
