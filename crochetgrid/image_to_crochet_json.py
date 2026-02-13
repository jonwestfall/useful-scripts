#!/usr/bin/env python3
"""
image_to_crochet_json.py — Companion app for Crochet Pattern Grid Designer

Turns a simple figure/ground image (e.g., black logo on white background) into a
grid JSON that can be loaded into pattern.py.

Features:
- Choose image file
- Specify rows/cols
- Reserve header/footer rows (blank)
- Toggle "fill odd numbered rows only" (even rows become background)
- Auto figure/ground detection + optional invert
- Choose background and figure colors (hex or picker)
- Save JSON compatible with pattern.py (version 2 format)

Dependencies:
- Pillow: pip install pillow
(Tkinter is usually included with Python on Windows/macOS; Linux may need system package.)
"""

from __future__ import annotations

import json
import re
import tkinter as tk
from tkinter import filedialog, messagebox, colorchooser

from PIL import Image, ImageOps

HEX_RE = re.compile(r"^#([0-9a-fA-F]{6})$")


def normalize_hex(s: str) -> str | None:
    s = (s or "").strip()
    if not s:
        return None
    if not s.startswith("#"):
        s = "#" + s
    if HEX_RE.match(s):
        return s.upper()
    return None


def otsu_threshold(gray_img: Image.Image) -> int:
    """
    Compute Otsu threshold from an 8-bit grayscale PIL image without numpy.
    Returns threshold in [0..255].
    """
    if gray_img.mode != "L":
        gray_img = gray_img.convert("L")
    hist = gray_img.histogram()  # 256 bins

    total = sum(hist)
    if total == 0:
        return 128

    sum_total = sum(i * h for i, h in enumerate(hist))

    sum_b = 0
    w_b = 0
    max_var = -1.0
    threshold = 128

    for t in range(256):
        w_b += hist[t]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break

        sum_b += t * hist[t]
        m_b = sum_b / w_b
        m_f = (sum_total - sum_b) / w_f

        # between-class variance
        var_between = w_b * w_f * (m_b - m_f) ** 2
        if var_between > max_var:
            max_var = var_between
            threshold = t

    return threshold


def infer_figure_is_dark(gray_img: Image.Image, t: int) -> bool:
    """
    Decide whether the figure is dark-on-light or light-on-dark.
    Heuristic: whichever side is *smaller* is likely the figure.
    Returns True if figure pixels are < t (dark).
    """
    if gray_img.mode != "L":
        gray_img = gray_img.convert("L")
    pixels = gray_img.getdata()
    dark = sum(1 for p in pixels if p < t)
    light = len(pixels) - dark
    # If dark is the minority, treat dark as figure; else light as figure.
    return dark <= light


def image_to_grid_json(
    image_path: str,
    rows: int,
    cols: int,
    header_rows: int,
    footer_rows: int,
    bg_hex: str,
    figure_hex: str,
    odd_rows_only: bool,
    force_invert: bool,
    threshold_override: int | None = None,
) -> dict:
    """
    Convert image into pattern.py-compatible JSON dict.
    None means background; figure cells store figure_hex.
    """
    if rows <= 0 or cols <= 0:
        raise ValueError("Rows and columns must be at least 1.")
    if header_rows < 0 or footer_rows < 0:
        raise ValueError("Header/footer rows cannot be negative.")
    if header_rows + footer_rows >= rows:
        raise ValueError("Header + footer rows must be less than total rows.")

    bg = normalize_hex(bg_hex) or "#FFFFFF"
    fg = normalize_hex(figure_hex) or "#000000"

    img = Image.open(image_path)
    img = ImageOps.exif_transpose(img)  # handle phone rotation
    gray = img.convert("L")

    t = threshold_override if threshold_override is not None else otsu_threshold(gray)
    figure_is_dark = infer_figure_is_dark(gray, t)

    # Determine if we should invert selection
    # "figure_is_dark" means pixels < t are figure.
    # If not, pixels >= t are figure.
    invert = force_invert

    usable_rows = rows - header_rows - footer_rows

    # Resize to target grid resolution for sampling
    # We map the figure into the usable area only.
    # Use LANCZOS to preserve shape, then threshold per cell.
    resized = gray.resize((cols, usable_rows), Image.Resampling.LANCZOS)

    cells: list[list[str | None]] = [[None for _ in range(cols)] for _ in range(rows)]

    for ru in range(usable_rows):
        grid_r = header_rows + ru  # top-based row in full grid

        # user-facing row numbering matches your editor/export logic:
        # row 1 is bottom, row N is top
        row_num_from_bottom = rows - grid_r

        fill_this_row = True
        if odd_rows_only and (row_num_from_bottom % 2 == 0):
            fill_this_row = False

        for c in range(cols):
            if not fill_this_row:
                cells[grid_r][c] = None
                continue

            p = resized.getpixel((c, ru))
            is_dark = p < t

            if figure_is_dark:
                is_figure = is_dark
            else:
                is_figure = not is_dark

            if invert:
                is_figure = not is_figure

            cells[grid_r][c] = fg if is_figure else None

    return {
        "version": 2,
        "rows": rows,
        "cols": cols,
        "background": bg,
        "cells": cells,
        "source": {
            "image": image_path,
            "threshold": t,
            "figure_is_dark": figure_is_dark,
            "invert": invert,
            "header_rows": header_rows,
            "footer_rows": footer_rows,
            "odd_rows_only": odd_rows_only,
        },
    }


class ImageToCrochetApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Image → Crochet Grid JSON")
        self.geometry("620x560")
        self.minsize(520, 480)

        self.image_path = tk.StringVar(value="")
        self.rows = tk.IntVar(value=32)
        self.cols = tk.IntVar(value=29)
        self.header_rows = tk.IntVar(value=0)
        self.footer_rows = tk.IntVar(value=0)
        self.bg_hex = tk.StringVar(value="#FFFFFF")
        self.fg_hex = tk.StringVar(value="#000000")
        self.odd_rows_only = tk.BooleanVar(value=False)
        self.force_invert = tk.BooleanVar(value=False)
        self.use_threshold_override = tk.BooleanVar(value=False)
        self.threshold_override = tk.IntVar(value=128)

        self.status = tk.StringVar(value="Choose an image, then export JSON.")

        self._build_ui()

    def _build_ui(self) -> None:
        pad = {"padx": 10, "pady": 8}

        top = tk.Frame(self)
        top.pack(fill="both", expand=True, **pad)

        tk.Label(top, text="🧶 Image → Crochet Grid (JSON)", font=("Helvetica", 14, "bold")).pack(anchor="w")

        # Image picker
        img_row = tk.Frame(top)
        img_row.pack(fill="x", pady=(10, 6))

        tk.Label(img_row, text="Image:").pack(side="left")
        tk.Entry(img_row, textvariable=self.image_path).pack(side="left", fill="x", expand=True, padx=8)
        tk.Button(img_row, text="Browse…", command=self.pick_image).pack(side="left")

        # Grid params
        tk.Label(top, text="Grid settings", font=("Helvetica", 12, "bold")).pack(anchor="w", pady=(10, 0))
        grid = tk.Frame(top)
        grid.pack(fill="x", pady=(6, 0))

        self._spin(grid, "Rows", self.rows, 1, 500, 0, 0)
        self._spin(grid, "Cols", self.cols, 1, 500, 0, 1)
        self._spin(grid, "Header rows (blank top)", self.header_rows, 0, 500, 1, 0)
        self._spin(grid, "Footer rows (blank bottom)", self.footer_rows, 0, 500, 1, 1)

        # Colors
        tk.Label(top, text="Colors", font=("Helvetica", 12, "bold")).pack(anchor="w", pady=(10, 0))
        colors = tk.Frame(top)
        colors.pack(fill="x", pady=(6, 0))

        self.bg_preview = tk.Label(colors, text="      ", bg=self.bg_hex.get(), relief="groove")
        self.bg_preview.grid(row=0, column=0, sticky="w")
        tk.Label(colors, text="Background").grid(row=0, column=1, sticky="w", padx=(8, 0))
        tk.Entry(colors, textvariable=self.bg_hex, width=10).grid(row=0, column=2, sticky="w", padx=8)
        tk.Button(colors, text="Pick…", command=self.pick_bg).grid(row=0, column=3, sticky="w")

        self.fg_preview = tk.Label(colors, text="      ", bg=self.fg_hex.get(), relief="groove")
        self.fg_preview.grid(row=1, column=0, sticky="w", pady=(8, 0))
        tk.Label(colors, text="Figure").grid(row=1, column=1, sticky="w", padx=(8, 0), pady=(8, 0))
        tk.Entry(colors, textvariable=self.fg_hex, width=10).grid(row=1, column=2, sticky="w", padx=8, pady=(8, 0))
        tk.Button(colors, text="Pick…", command=self.pick_fg).grid(row=1, column=3, sticky="w", pady=(8, 0))

        # Options
        tk.Label(top, text="Options", font=("Helvetica", 12, "bold")).pack(anchor="w", pady=(10, 0))
        opts = tk.Frame(top)
        opts.pack(fill="x", pady=(6, 0))

        tk.Checkbutton(opts, text="Fill odd-numbered rows only (even rows stay background)",
                       variable=self.odd_rows_only).pack(anchor="w")
        tk.Checkbutton(opts, text="Invert figure/ground (if auto-detect is wrong)",
                       variable=self.force_invert).pack(anchor="w", pady=(4, 0))

        # Threshold override
        thr = tk.Frame(top)
        thr.pack(fill="x", pady=(10, 0))
        tk.Checkbutton(thr, text="Override threshold (0–255)", variable=self.use_threshold_override).pack(side="left")
        tk.Spinbox(thr, from_=0, to=255, textvariable=self.threshold_override, width=6).pack(side="left", padx=8)

        # Buttons
        btns = tk.Frame(top)
        btns.pack(fill="x", pady=(16, 0))

        tk.Button(btns, text="Export JSON…", command=self.export_json).pack(side="left")
        tk.Button(btns, text="Quick Test (no save)", command=self.quick_test).pack(side="left", padx=(10, 0))

        # Status
        tk.Label(self, textvariable=self.status, anchor="w", relief="sunken", padx=10).pack(fill="x", side="bottom")

    def _spin(self, parent: tk.Widget, label: str, var: tk.IntVar, lo: int, hi: int, r: int, c: int) -> None:
        box = tk.Frame(parent)
        box.grid(row=r, column=c, sticky="ew", padx=(0 if c == 0 else 10, 0), pady=(0 if r == 0 else 8, 0))
        tk.Label(box, text=label).pack(anchor="w")
        tk.Spinbox(box, from_=lo, to=hi, textvariable=var, width=10).pack(anchor="w")

    def pick_image(self) -> None:
        path = filedialog.askopenfilename(
            title="Choose image",
            filetypes=[
                ("Images", "*.png *.jpg *.jpeg *.bmp *.gif *.tif *.tiff *.webp"),
                ("All files", "*.*"),
            ],
        )
        if path:
            self.image_path.set(path)
            self.status.set("Image selected. Ready to export JSON.")

    def pick_bg(self) -> None:
        _, hx = colorchooser.askcolor(title="Pick background color")
        if hx:
            self.bg_hex.set(hx.upper())
            self.bg_preview.configure(bg=hx)

    def pick_fg(self) -> None:
        _, hx = colorchooser.askcolor(title="Pick figure color")
        if hx:
            self.fg_hex.set(hx.upper())
            self.fg_preview.configure(bg=hx)

    def _validate(self) -> tuple[str, dict] | None:
        path = self.image_path.get().strip()
        if not path:
            messagebox.showerror("Missing image", "Choose an image file first.")
            return None

        rows = int(self.rows.get())
        cols = int(self.cols.get())
        header = int(self.header_rows.get())
        footer = int(self.footer_rows.get())

        bg = normalize_hex(self.bg_hex.get())
        fg = normalize_hex(self.fg_hex.get())
        if not bg:
            messagebox.showerror("Invalid background color", "Background must be a 6-digit hex like #FFFFFF.")
            return None
        if not fg:
            messagebox.showerror("Invalid figure color", "Figure must be a 6-digit hex like #000000.")
            return None

        thr = None
        if self.use_threshold_override.get():
            thr = int(self.threshold_override.get())
            if thr < 0 or thr > 255:
                messagebox.showerror("Invalid threshold", "Threshold must be between 0 and 255.")
                return None

        try:
            obj = image_to_grid_json(
                image_path=path,
                rows=rows,
                cols=cols,
                header_rows=header,
                footer_rows=footer,
                bg_hex=bg,
                figure_hex=fg,
                odd_rows_only=bool(self.odd_rows_only.get()),
                force_invert=bool(self.force_invert.get()),
                threshold_override=thr,
            )
        except Exception as e:
            messagebox.showerror("Conversion failed", str(e))
            return None

        return path, obj

    def export_json(self) -> None:
        validated = self._validate()
        if not validated:
            return
        _, obj = validated

        out = filedialog.asksaveasfilename(
            title="Save crochet grid JSON",
            defaultextension=".json",
            filetypes=[("JSON", "*.json")],
        )
        if not out:
            return

        with open(out, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2)

        self.status.set(f"Exported JSON: {out}")

    def quick_test(self) -> None:
        validated = self._validate()
        if not validated:
            return
        _, obj = validated

        src = obj.get("source", {})
        self.status.set(
            f"OK. threshold={src.get('threshold')} figure_is_dark={src.get('figure_is_dark')} invert={src.get('invert')}. "
            "Export JSON when ready."
        )


if __name__ == "__main__":
    app = ImageToCrochetApp()
    app.mainloop()

