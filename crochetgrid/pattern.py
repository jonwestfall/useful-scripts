#!/usr/bin/env python3
"""
Crochet Pattern Grid Designer (Tkinter) — v2

Adds:
- Scrollable left control panel (so nothing gets cut off)
- Optional row/column numbers overlay in the editor (right canvas)
- Undo/Redo
- Bucket Fill
- Eyedropper

Controls
- Modes: Paint / Erase / Fill / Eyedropper
- Left-click/drag: applies current mode
- Right-click: quick Erase (still works)
"""

from __future__ import annotations

import json
import os
import re
import tkinter as tk
from tkinter import filedialog, messagebox, colorchooser

HEX_RE = re.compile(r"^#([0-9a-fA-F]{6})$")

DEFAULT_PALETTE = [
    "#000000",  # black
    "#FFFFFF",  # white
    "#E74C3C",  # red
    "#F39C12",  # orange
    "#F1C40F",  # yellow
    "#2ECC71",  # green
    "#3498DB",  # blue
    "#9B59B6",  # purple
    "#16A085",  # teal
    "#95A5A6",  # gray
]


def normalize_hex(s: str) -> str | None:
    s = (s or "").strip()
    if not s:
        return None
    if not s.startswith("#"):
        s = "#" + s
    if HEX_RE.match(s):
        return s.upper()
    return None


def safe_basename(path: str) -> str:
    try:
        return os.path.basename(path)
    except Exception:
        return path


class CrochetGridApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Crochet Pattern Grid Designer")
        self.geometry("1200x780")
        self.minsize(980, 620)

        # Model vars
        self.rows = tk.IntVar(value=32)
        self.cols = tk.IntVar(value=29)
        self.cell_px = tk.IntVar(value=20)
        self.bg_color = tk.StringVar(value="#FFFFFF")
        self.active_color = tk.StringVar(value=DEFAULT_PALETTE[0])

        # Mode: paint / erase / fill / eyedropper
        self.mode = tk.StringVar(value="paint")

        # Numbers options (shared for editor overlay + export)
        self.show_numbers_editor = tk.BooleanVar(value=False)
        self.export_show_numbers = tk.BooleanVar(value=True)
        self.origin = tk.StringVar(value="bottom_left")  # bottom_left or bottom_right

        # Export vars
        self.export_cell_px = tk.IntVar(value=30)
        self.export_margin_px = tk.IntVar(value=60)

        # Data: None means "use background"
        self.grid_data: list[list[str | None]] = []

        # Undo/Redo
        self.undo_stack: list[dict] = []
        self.redo_stack: list[dict] = []
        self.max_undo = 60
        self._action_open = False  # so drag paints become 1 undo step

        # UI state
        self._is_dragging = False

        # Build UI
        self._build_ui()
        self._init_grid()

    # ---------------- UI ----------------
    def _on_canvas_motion(self, e: tk.Event) -> None:
        cell = self._cell_from_xy(e.x, e.y)
        if cell is None:
            self.mouse_rc.set("Row: —   Col: —")
            return

        r, c = cell  # r is 0 at top, c is 0 at left

        # Convert to user-facing numbering based on origin choice:
        # - Rows: 1..N from bottom to top
        # - Cols: depends on bottom-left vs bottom-right
        total_rows = len(self.grid_data)
        total_cols = len(self.grid_data[0]) if self.grid_data else 0

        row_num = total_rows - r  # top row -> N, bottom row -> 1

        if self.origin.get() == "bottom_left":
            col_num = c + 1
        else:
            col_num = total_cols - c

        self.mouse_rc.set(f"Row: {row_num}   Col: {col_num}")

    def _on_canvas_leave(self, e: tk.Event) -> None:
        self.mouse_rc.set("Row: —   Col: —")

    def _build_ui(self) -> None:
        self.columnconfigure(1, weight=1)
        self.rowconfigure(0, weight=1)

        # Scrollable left panel
        left_outer = tk.Frame(self)
        left_outer.grid(row=0, column=0, sticky="ns")

        self.left_canvas = tk.Canvas(left_outer, highlightthickness=0)
        self.left_canvas.pack(side="left", fill="y", expand=False)

        left_scroll = tk.Scrollbar(left_outer, orient="vertical", command=self.left_canvas.yview)
        left_scroll.pack(side="right", fill="y")
        self.left_canvas.configure(yscrollcommand=left_scroll.set)

        self.left = tk.Frame(self.left_canvas, padx=10, pady=10)
        self.left_window = self.left_canvas.create_window((0, 0), window=self.left, anchor="nw")

        def _sync_left_width(event: tk.Event) -> None:
            # Keep inner frame width pinned to canvas width
            self.left_canvas.itemconfigure(self.left_window, width=event.width)

        self.left_canvas.bind("<Configure>", _sync_left_width)

        def _update_scrollregion(_: tk.Event | None = None) -> None:
            self.left.update_idletasks()
            self.left_canvas.configure(scrollregion=self.left_canvas.bbox("all"))

        self.left.bind("<Configure>", _update_scrollregion)

        # Mousewheel scrolling (platform-friendly-ish)
        def _on_mousewheel(e: tk.Event) -> None:
            delta = 0
            if hasattr(e, "delta") and e.delta:
                delta = -1 if e.delta > 0 else 1
            else:
                # Linux: Button-4/5
                delta = -1 if getattr(e, "num", 0) == 4 else 1
            self.left_canvas.yview_scroll(delta, "units")

        self.left_canvas.bind_all("<MouseWheel>", _on_mousewheel)
        self.left_canvas.bind_all("<Button-4>", _on_mousewheel)
        self.left_canvas.bind_all("<Button-5>", _on_mousewheel)

        # Main area (right)
        main = tk.Frame(self, padx=10, pady=10)
        main.grid(row=0, column=1, sticky="nsew")
        
        
        # ---- Left panel contents ----
        tk.Label(self.left, text="🧶 Grid", font=("Helvetica", 12, "bold")).pack(anchor="w")

        grid_form = tk.Frame(self.left)
        grid_form.pack(fill="x", pady=(6, 10))

        self._labeled_spinbox(grid_form, "Rows", self.rows, 1, 500, row=0)
        self._labeled_spinbox(grid_form, "Cols", self.cols, 1, 500, row=1)
        self._labeled_spinbox(grid_form, "Cell px (UI)", self.cell_px, 8, 70, row=2)

        tk.Button(self.left, text="New / Resize Grid", command=self.on_new_grid).pack(fill="x")
        tk.Button(self.left, text="Clear (to background)", command=self.on_clear).pack(fill="x", pady=(6, 0))

        # ---- Mode ----
        tk.Label(self.left, text="🛠️ Tools", font=("Helvetica", 12, "bold")).pack(anchor="w", pady=(14, 0))
        mode_box = tk.Frame(self.left)
        mode_box.pack(fill="x", pady=(6, 6))

        for text, val in [("Paint", "paint"), ("Erase", "erase"), ("Fill", "fill"), ("Eyedropper", "eyedropper")]:
            tk.Radiobutton(mode_box, text=text, value=val, variable=self.mode).pack(anchor="w")

        # Undo/Redo
        ur = tk.Frame(self.left)
        ur.pack(fill="x", pady=(6, 10))
        self.undo_btn = tk.Button(ur, text="Undo", command=self.undo)
        self.undo_btn.pack(side="left", fill="x", expand=True)
        self.redo_btn = tk.Button(ur, text="Redo", command=self.redo)
        self.redo_btn.pack(side="left", fill="x", expand=True, padx=(6, 0))

        # ---- Background ----
        tk.Label(self.left, text="🎨 Background", font=("Helvetica", 12, "bold")).pack(anchor="w", pady=(10, 0))
        bg_row = tk.Frame(self.left)
        bg_row.pack(fill="x", pady=(6, 10))

        self.bg_preview = tk.Label(bg_row, text="      ", bg=self.bg_color.get(), relief="groove")
        self.bg_preview.pack(side="left")
        tk.Entry(bg_row, textvariable=self.bg_color, width=10).pack(side="left", padx=8)
        tk.Button(bg_row, text="Pick…", command=self.pick_bg_color).pack(side="left")
        tk.Button(bg_row, text="Apply BG", command=self.apply_bg_color).pack(side="left", padx=(8, 0))

        # ---- Active color ----
        tk.Label(self.left, text="🖌️ Paint Color", font=("Helvetica", 12, "bold")).pack(anchor="w")
        color_row = tk.Frame(self.left)
        color_row.pack(fill="x", pady=(6, 6))

        self.active_preview = tk.Label(color_row, text="      ", bg=self.active_color.get(), relief="groove")
        self.active_preview.pack(side="left")

        self.custom_hex = tk.StringVar(value=self.active_color.get())
        tk.Entry(color_row, textvariable=self.custom_hex, width=10).pack(side="left", padx=8)
        tk.Button(color_row, text="Use Hex", command=self.use_custom_hex).pack(side="left")
        tk.Button(color_row, text="Pick…", command=self.pick_active_color).pack(side="left", padx=(8, 0))

        tk.Label(self.left, text="Palette").pack(anchor="w", pady=(6, 2))
        pal = tk.Frame(self.left)
        pal.pack(fill="x", pady=(0, 10))
        for i, c in enumerate(DEFAULT_PALETTE):
            b = tk.Button(pal, bg=c, width=3, command=lambda cc=c: self.set_active_color(cc))
            b.grid(row=i // 5, column=i % 5, padx=2, pady=2, sticky="ew")

        # ---- Numbering options ----
        tk.Label(self.left, text="🔢 Numbers", font=("Helvetica", 12, "bold")).pack(anchor="w", pady=(12, 0))

        tk.Checkbutton(self.left, text="Show row/col numbers in editor", variable=self.show_numbers_editor,
                       command=self.redraw).pack(anchor="w", pady=(6, 0))
        tk.Checkbutton(self.left, text="Show row/col numbers on export", variable=self.export_show_numbers).pack(
            anchor="w", pady=(4, 0)
        )

        tk.Label(self.left, text="Numbering origin:").pack(anchor="w", pady=(8, 0))
        tk.Radiobutton(self.left, text="Bottom-left", value="bottom_left", variable=self.origin,
                       command=self.redraw).pack(anchor="w")
        tk.Radiobutton(self.left, text="Bottom-right", value="bottom_right", variable=self.origin,
                       command=self.redraw).pack(anchor="w")

        # ---- Save/Load ----
        tk.Label(self.left, text="💾 Save / Load", font=("Helvetica", 12, "bold")).pack(anchor="w", pady=(14, 0))
        tk.Button(self.left, text="Save JSON…", command=self.save_json).pack(fill="x", pady=(6, 0))
        tk.Button(self.left, text="Load JSON…", command=self.load_json).pack(fill="x", pady=(6, 0))

        # ---- Export ----
        tk.Label(self.left, text="📤 Export", font=("Helvetica", 12, "bold")).pack(anchor="w", pady=(14, 0))

        export_opts = tk.Frame(self.left)
        export_opts.pack(fill="x", pady=(6, 8))

        self._labeled_spinbox(export_opts, "Export cell px (PNG)", self.export_cell_px, 5, 200)
        self._labeled_spinbox(export_opts, "Export margin px", self.export_margin_px, 0, 400, pady=(6, 0))

        tk.Button(self.left, text="Export PNG…", command=self.export_png).pack(fill="x")
        tk.Button(self.left, text="Export PDF…", command=self.export_pdf).pack(fill="x", pady=(6, 0))

        tk.Label(
            self.left,
            text="Tip: Right-click is always erase.\n(Left-click does whatever tool you picked.)",
            justify="left",
            fg="#444",
        ).pack(anchor="w", pady=(14, 0))

        # ---- Right canvas ----
        self.canvas = tk.Canvas(main, bg="#F7F7F7", highlightthickness=0)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        self.canvas.bind("<Configure>", lambda e: self.redraw())

        # Mouse-position readout under the canvas
        self.mouse_rc = tk.StringVar(value="Row: —   Col: —")
        rc_bar = tk.Label(main, textvariable=self.mouse_rc, anchor="w", padx=8, relief="groove")
        rc_bar.grid(row=1, column=0, sticky="ew", pady=(8, 0))

        # Track mouse movement over the canvas
        self.canvas.bind("<Motion>", self._on_canvas_motion)
        self.canvas.bind("<Leave>", self._on_canvas_leave)

        # Ensure layout supports the extra row
        main.rowconfigure(0, weight=1)
        main.rowconfigure(1, weight=0)
        main.columnconfigure(0, weight=1)

        # Left-click actions
        self.canvas.bind("<ButtonPress-1>", self._on_left_down)
        self.canvas.bind("<B1-Motion>", self._on_left_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_left_up)

        # Right-click quick erase
        self.canvas.bind("<ButtonPress-3>", self._on_right_down)
        self.canvas.bind("<B3-Motion>", self._on_right_drag)
        self.canvas.bind("<ButtonRelease-3>", self._on_right_up)

        # Status bar
        self.status = tk.StringVar(value="Ready.")
        status_bar = tk.Label(self, textvariable=self.status, anchor="w", relief="sunken", padx=8)
        status_bar.grid(row=1, column=0, columnspan=2, sticky="ew")

        self._update_undo_redo_buttons()

    def _labeled_spinbox(
        self,
        parent: tk.Widget,
        label: str,
        var: tk.IntVar,
        minv: int,
        maxv: int,
        row: int | None = None,
        pady: tuple[int, int] = (2, 2),
    ) -> None:
        frame = parent
        if row is None:
            line = tk.Frame(frame)
            line.pack(fill="x", pady=pady)
        else:
            line = tk.Frame(frame)
            line.grid(row=row, column=0, sticky="ew", pady=pady)
            frame.columnconfigure(0, weight=1)

        tk.Label(line, text=label).pack(side="left")
        sp = tk.Spinbox(line, from_=minv, to=maxv, textvariable=var, width=8)
        sp.pack(side="right")

    # ---------------- Undo / Redo ----------------

    def _snapshot(self) -> dict:
        # Deep copy grid_data
        cells = [row[:] for row in self.grid_data]
        return {
            "rows": len(cells),
            "cols": len(cells[0]) if cells else 0,
            "background": normalize_hex(self.bg_color.get()) or "#FFFFFF",
            "cells": cells,
        }

    def _push_undo(self) -> None:
        self.undo_stack.append(self._snapshot())
        if len(self.undo_stack) > self.max_undo:
            self.undo_stack = self.undo_stack[-self.max_undo :]
        self.redo_stack.clear()
        self._update_undo_redo_buttons()

    def _restore(self, snap: dict) -> None:
        rows = int(snap["rows"])
        cols = int(snap["cols"])
        bg = normalize_hex(snap.get("background", "#FFFFFF")) or "#FFFFFF"
        cells = snap["cells"]

        self.rows.set(rows)
        self.cols.set(cols)
        self.bg_color.set(bg)
        self.bg_preview.configure(bg=bg)
        self.grid_data = [row[:] for row in cells]
        self.redraw()

    def undo(self) -> None:
        if not self.undo_stack:
            return
        self.redo_stack.append(self._snapshot())
        snap = self.undo_stack.pop()
        self._restore(snap)
        self.status.set("Undo.")
        self._update_undo_redo_buttons()

    def redo(self) -> None:
        if not self.redo_stack:
            return
        self.undo_stack.append(self._snapshot())
        snap = self.redo_stack.pop()
        self._restore(snap)
        self.status.set("Redo.")
        self._update_undo_redo_buttons()

    def _update_undo_redo_buttons(self) -> None:
        if hasattr(self, "undo_btn"):
            self.undo_btn.configure(state=("normal" if self.undo_stack else "disabled"))
            self.redo_btn.configure(state=("normal" if self.redo_stack else "disabled"))

    def _begin_action(self) -> None:
        # Start a single undoable action (for drag painting)
        if not self._action_open:
            self._push_undo()
            self._action_open = True

    def _end_action(self) -> None:
        self._action_open = False

    # ---------------- Grid / Rendering ----------------

    def _init_grid(self) -> None:
        r, c = self.rows.get(), self.cols.get()
        self.grid_data = [[None for _ in range(c)] for _ in range(r)]
        self.undo_stack.clear()
        self.redo_stack.clear()
        self._update_undo_redo_buttons()
        self.redraw()

    def on_new_grid(self) -> None:
        r, c = self.rows.get(), self.cols.get()
        if r <= 0 or c <= 0:
            messagebox.showerror("Invalid size", "Rows and columns must be at least 1.")
            return

        self._push_undo()

        old = self.grid_data
        old_r = len(old)
        old_c = len(old[0]) if old else 0

        new_grid = [[None for _ in range(c)] for _ in range(r)]
        for rr in range(min(r, old_r)):
            for cc in range(min(c, old_c)):
                new_grid[rr][cc] = old[rr][cc]

        self.grid_data = new_grid
        self.redraw()
        self.status.set(f"Grid resized to {r}x{c}.")

    def on_clear(self) -> None:
        self._push_undo()
        for r in range(len(self.grid_data)):
            for c in range(len(self.grid_data[0])):
                self.grid_data[r][c] = None
        self.redraw()
        self.status.set("Cleared to background.")

    def redraw(self) -> None:
        self.canvas.delete("all")
        if not self.grid_data:
            return

        rcount = len(self.grid_data)
        ccount = len(self.grid_data[0])
        cell = self.cell_px.get()

        pad = 20
        cw = max(self.canvas.winfo_width(), 1)
        ch = max(self.canvas.winfo_height(), 1)

        grid_w = ccount * cell
        grid_h = rcount * cell

        # Reserve space for numbers overlay if enabled
        num_pad = int(cell * 1.2) if self.show_numbers_editor.get() else 0

        x0 = max((cw - grid_w) // 2, pad + num_pad)
        y0 = max((ch - grid_h) // 2, pad + num_pad)

        self._grid_origin = (x0, y0)
        self._grid_cell = cell

        bg = normalize_hex(self.bg_color.get()) or "#FFFFFF"
        self.bg_preview.configure(bg=bg)

        # Draw cells
        for r in range(rcount):
            for c in range(ccount):
                x1 = x0 + c * cell
                y1 = y0 + r * cell
                x2 = x1 + cell
                y2 = y1 + cell
                fill = self.grid_data[r][c] or bg
                self.canvas.create_rectangle(x1, y1, x2, y2, fill=fill, outline="#C9C9C9")

        # Border
        self.canvas.create_rectangle(x0, y0, x0 + grid_w, y0 + grid_h, outline="#888", width=2)

        # Numbers overlay
        if self.show_numbers_editor.get():
            row_nums, col_nums = self._get_numbering_maps()
            font = ("Helvetica", max(8, int(cell * 0.35)))

            # Column numbers above (aligned to columns)
            for c in range(ccount):
                label = str(col_nums[c])
                cx = x0 + c * cell + cell / 2
                cy = y0 - cell * 0.6
                self.canvas.create_text(cx, cy, text=label, font=font, fill="#111")

            # Row numbers left (row 1 at bottom)
            for r in range(rcount):
                label = str(row_nums[rcount - 1 - r])
                cx = x0 - cell * 0.6
                cy = y0 + r * cell + cell / 2
                self.canvas.create_text(cx, cy, text=label, font=font, fill="#111")

    def _cell_from_xy(self, x: int, y: int) -> tuple[int, int] | None:
        if not self.grid_data:
            return None
        x0, y0 = getattr(self, "_grid_origin", (0, 0))
        cell = getattr(self, "_grid_cell", self.cell_px.get())
        rcount = len(self.grid_data)
        ccount = len(self.grid_data[0])

        gx = x - x0
        gy = y - y0
        if gx < 0 or gy < 0:
            return None
        c = gx // cell
        r = gy // cell
        if 0 <= r < rcount and 0 <= c < ccount:
            return int(r), int(c)
        return None

    # ---------------- Colors ----------------

    def set_active_color(self, color: str) -> None:
        col = normalize_hex(color)
        if not col:
            messagebox.showerror("Invalid color", "That color code is not valid hex (e.g., #A1B2C3).")
            return
        self.active_color.set(col)
        self.custom_hex.set(col)
        self.active_preview.configure(bg=col)

    def use_custom_hex(self) -> None:
        col = normalize_hex(self.custom_hex.get())
        if not col:
            messagebox.showerror("Invalid hex", "Enter a 6-digit hex color, like #33AAFF.")
            return
        self.set_active_color(col)

    def pick_active_color(self) -> None:
        _, hx = colorchooser.askcolor(title="Pick paint color")
        if hx:
            self.set_active_color(hx)

    def pick_bg_color(self) -> None:
        _, hx = colorchooser.askcolor(title="Pick background color")
        if hx:
            self.bg_color.set(hx.upper())
            self.bg_preview.configure(bg=hx)

    def apply_bg_color(self) -> None:
        col = normalize_hex(self.bg_color.get())
        if not col:
            messagebox.showerror("Invalid hex", "Enter a 6-digit hex color, like #FFFFFF.")
            return
        self._push_undo()
        self.bg_color.set(col)
        self.bg_preview.configure(bg=col)
        self.redraw()
        self.status.set("Background color applied (unpainted cells use the background).")

    # ---------------- Actions: paint/erase/fill/eyedropper ----------------

    def _current_paint_color(self) -> str | None:
        return normalize_hex(self.active_color.get())

    def _get_cell_color(self, r: int, c: int) -> str:
        bg = normalize_hex(self.bg_color.get()) or "#FFFFFF"
        return self.grid_data[r][c] or bg

    def _set_cell_color(self, r: int, c: int, color: str | None) -> None:
        self.grid_data[r][c] = color

    def _bucket_fill(self, start_r: int, start_c: int, new_color: str | None) -> None:
        # Flood fill on *effective* color (cell or bg)
        rcount = len(self.grid_data)
        ccount = len(self.grid_data[0])
        target = self._get_cell_color(start_r, start_c)
        replacement = (new_color or (normalize_hex(self.bg_color.get()) or "#FFFFFF"))

        if target == replacement:
            return

        stack = [(start_r, start_c)]
        seen = set()

        while stack:
            r, c = stack.pop()
            if (r, c) in seen:
                continue
            seen.add((r, c))

            if self._get_cell_color(r, c) != target:
                continue

            # If replacement equals background, store None; else store replacement
            bg = normalize_hex(self.bg_color.get()) or "#FFFFFF"
            self._set_cell_color(r, c, None if replacement == bg else replacement)

            if r > 0:
                stack.append((r - 1, c))
            if r < rcount - 1:
                stack.append((r + 1, c))
            if c > 0:
                stack.append((r, c - 1))
            if c < ccount - 1:
                stack.append((r, c + 1))

    def _apply_tool_at(self, x: int, y: int, forced_mode: str | None = None) -> None:
        cell = self._cell_from_xy(x, y)
        if cell is None:
            return
        r, c = cell
        mode = forced_mode or self.mode.get()

        if mode == "eyedropper":
            picked = self._get_cell_color(r, c)
            self.set_active_color(picked)
            self.status.set(f"Picked {picked}")
            return

        if mode in ("paint", "erase", "fill"):
            self._begin_action()

        if mode == "paint":
            col = self._current_paint_color()
            if not col:
                return
            self._set_cell_color(r, c, col)
        elif mode == "erase":
            self._set_cell_color(r, c, None)
        elif mode == "fill":
            col = self._current_paint_color()
            if not col:
                return
            self._bucket_fill(r, c, col)

        self.redraw()

    # Left-click behavior (respects chosen tool)
    def _on_left_down(self, e: tk.Event) -> None:
        self._is_dragging = True
        self._apply_tool_at(e.x, e.y)

    def _on_left_drag(self, e: tk.Event) -> None:
        if not self._is_dragging:
            return
        # Dragging makes sense for paint/erase; for fill/eyedropper do single action
        if self.mode.get() in ("fill", "eyedropper"):
            return
        self._apply_tool_at(e.x, e.y)

    def _on_left_up(self, e: tk.Event) -> None:
        self._is_dragging = False
        self._end_action()

    # Right-click quick erase (always)
    def _on_right_down(self, e: tk.Event) -> None:
        self._is_dragging = True
        self._apply_tool_at(e.x, e.y, forced_mode="erase")

    def _on_right_drag(self, e: tk.Event) -> None:
        if not self._is_dragging:
            return
        self._apply_tool_at(e.x, e.y, forced_mode="erase")

    def _on_right_up(self, e: tk.Event) -> None:
        self._is_dragging = False
        self._end_action()

    # ---------------- JSON Save/Load ----------------

    def _to_json_obj(self) -> dict:
        return {
            "version": 2,
            "rows": len(self.grid_data),
            "cols": len(self.grid_data[0]) if self.grid_data else 0,
            "background": normalize_hex(self.bg_color.get()) or "#FFFFFF",
            "cells": self.grid_data,
        }

    def save_json(self) -> None:
        path = filedialog.asksaveasfilename(
            title="Save pattern JSON",
            defaultextension=".json",
            filetypes=[("JSON", "*.json")],
        )
        if not path:
            return
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self._to_json_obj(), f, indent=2)
        self.status.set(f"Saved JSON: {safe_basename(path)}")

    def load_json(self) -> None:
        path = filedialog.askopenfilename(title="Load pattern JSON", filetypes=[("JSON", "*.json")])
        if not path:
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                obj = json.load(f)

            ver = int(obj.get("version", 1))
            if ver not in (1, 2):
                raise ValueError("Unsupported JSON version.")

            rows = int(obj["rows"])
            cols = int(obj["cols"])
            bg = normalize_hex(obj.get("background", "#FFFFFF")) or "#FFFFFF"
            cells = obj["cells"]

            if len(cells) != rows or any(len(row) != cols for row in cells):
                raise ValueError("Cell data does not match rows/cols.")

            norm_cells: list[list[str | None]] = []
            for r in range(rows):
                out_row = []
                for c in range(cols):
                    v = cells[r][c]
                    if v is None:
                        out_row.append(None)
                    else:
                        nv = normalize_hex(v)
                        out_row.append(nv if nv else None)
                norm_cells.append(out_row)

            self.rows.set(rows)
            self.cols.set(cols)
            self.bg_color.set(bg)
            self.bg_preview.configure(bg=bg)
            self.grid_data = norm_cells

            self.undo_stack.clear()
            self.redo_stack.clear()
            self._update_undo_redo_buttons()

            self.redraw()
            self.status.set(f"Loaded JSON: {safe_basename(path)}")
        except Exception as e:
            messagebox.showerror("Load failed", f"Could not load JSON:\n{e}")

    # ---------------- Numbering ----------------

    def _get_numbering_maps(self) -> tuple[list[int], list[int]]:
        rcount = len(self.grid_data)
        ccount = len(self.grid_data[0]) if self.grid_data else 0

        # row labels: 1..rows bottom->top; we place them by flipping during draw
        row_nums = list(range(1, rcount + 1))

        if self.origin.get() == "bottom_left":
            col_nums = list(range(1, ccount + 1))      # left->right
        else:
            col_nums = list(range(ccount, 0, -1))      # left->right but numbers count down
        return row_nums, col_nums

    # ---------------- Export ----------------

    def export_png(self) -> None:
        try:
            from PIL import Image, ImageDraw, ImageFont
        except Exception:
            messagebox.showerror("Missing dependency", "PNG export requires Pillow.\nInstall with: pip install pillow")
            return

        if not self.grid_data:
            return

        path = filedialog.asksaveasfilename(
            title="Export PNG",
            defaultextension=".png",
            filetypes=[("PNG", "*.png")],
        )
        if not path:
            return

        rcount = len(self.grid_data)
        ccount = len(self.grid_data[0])
        cell = int(self.export_cell_px.get())
        show_nums = bool(self.export_show_numbers.get())
        margin = int(self.export_margin_px.get()) if show_nums else 20
        bg = normalize_hex(self.bg_color.get()) or "#FFFFFF"

        grid_w = ccount * cell
        grid_h = rcount * cell
        img_w = grid_w + margin * 2
        img_h = grid_h + margin * 2

        img = Image.new("RGB", (img_w, img_h), "white")
        draw = ImageDraw.Draw(img)

        try:
            font = ImageFont.truetype("DejaVuSans.ttf", max(10, cell // 2))
        except Exception:
            font = ImageFont.load_default()

        x0, y0 = margin, margin

        # Cells
        for r in range(rcount):
            for c in range(ccount):
                x1 = x0 + c * cell
                y1 = y0 + r * cell
                x2 = x1 + cell
                y2 = y1 + cell
                fill = self.grid_data[r][c] or bg
                draw.rectangle([x1, y1, x2, y2], fill=fill, outline="#B0B0B0")

        draw.rectangle([x0, y0, x0 + grid_w, y0 + grid_h], outline="#333333", width=3)

        if show_nums:
            row_nums, col_nums = self._get_numbering_maps()

            # Columns
            for c in range(ccount):
                label = str(col_nums[c])
                cx = x0 + c * cell + cell / 2
                cy = y0 - (cell * 0.6)
                bb = draw.textbbox((0, 0), label, font=font)
                w, h = bb[2] - bb[0], bb[3] - bb[1]
                draw.text((cx - w / 2, cy - h / 2), label, fill="#111111", font=font)

            # Rows (row 1 at bottom)
            for r in range(rcount):
                label = str(row_nums[rcount - 1 - r])
                cx = x0 - (cell * 0.6)
                cy = y0 + r * cell + cell / 2
                bb = draw.textbbox((0, 0), label, font=font)
                w, h = bb[2] - bb[0], bb[3] - bb[1]
                draw.text((cx - w / 2, cy - h / 2), label, fill="#111111", font=font)

        img.save(path)
        self.status.set(f"Exported PNG: {safe_basename(path)}")

    def export_pdf(self) -> None:
        try:
            from reportlab.pdfgen import canvas as pdf_canvas
            from reportlab.lib.pagesizes import letter
        except Exception:
            messagebox.showerror("Missing dependency", "PDF export requires reportlab.\nInstall with: pip install reportlab")
            return

        if not self.grid_data:
            return

        path = filedialog.asksaveasfilename(
            title="Export PDF",
            defaultextension=".pdf",
            filetypes=[("PDF", "*.pdf")],
        )
        if not path:
            return

        rcount = len(self.grid_data)
        ccount = len(self.grid_data[0])
        show_nums = bool(self.export_show_numbers.get())
        bg = normalize_hex(self.bg_color.get()) or "#FFFFFF"

        page_w, page_h = letter
        margin = 36
        extra = 28 if show_nums else 0

        usable_w = page_w - 2 * margin - extra
        usable_h = page_h - 2 * margin - extra

        cell = min(usable_w / ccount, usable_h / rcount)
        cell = max(6, min(cell, 36))

        grid_w = ccount * cell
        grid_h = rcount * cell

        x0 = margin + (extra if show_nums else 0)
        y0 = margin + (extra if show_nums else 0)

        c = pdf_canvas.Canvas(path, pagesize=letter)
        c.setFont("Helvetica", 9)
        c.drawString(margin, page_h - margin + 8, "Crochet Pattern Grid Export")

        for r in range(rcount):
            for col in range(ccount):
                pdf_x = x0 + col * cell
                pdf_y = y0 + (rcount - 1 - r) * cell

                fill = self.grid_data[r][col] or bg
                r8 = int(fill[1:3], 16) / 255.0
                g8 = int(fill[3:5], 16) / 255.0
                b8 = int(fill[5:7], 16) / 255.0

                c.setFillColorRGB(r8, g8, b8)
                c.setStrokeColorRGB(0.75, 0.75, 0.75)
                c.rect(pdf_x, pdf_y, cell, cell, fill=1, stroke=1)

        c.setStrokeColorRGB(0.2, 0.2, 0.2)
        c.setLineWidth(2)
        c.rect(x0, y0, grid_w, grid_h, fill=0, stroke=1)

        if show_nums:
            row_nums, col_nums = self._get_numbering_maps()
            c.setFont("Helvetica", max(6, int(cell * 0.35)))
            c.setFillColorRGB(0.1, 0.1, 0.1)

            for col in range(ccount):
                label = str(col_nums[col])
                tx = x0 + col * cell + cell * 0.5
                ty = y0 + grid_h + cell * 0.15
                c.drawCentredString(tx, ty, label)

            for r in range(rcount):
                label = str(row_nums[r])  # 1..rows bottom->top
                tx = x0 - cell * 0.25
                ty = y0 + (r * cell) + cell * 0.35
                c.drawRightString(tx, ty, label)

        c.showPage()
        c.save()
        self.status.set(f"Exported PDF: {safe_basename(path)}")


if __name__ == "__main__":
    app = CrochetGridApp()
    app.mainloop()