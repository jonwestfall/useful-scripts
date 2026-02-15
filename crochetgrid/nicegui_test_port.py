#!/usr/bin/env python3
"""
NiceGUI Test Port 1 for Crochet Pattern Grid Designer (FIXED)

Fixes:
- Avoid calling ui.run_javascript before NiceGUI event loop/client exists.
  All JS injection and initial redraw now happen AFTER a client connects,
  inside a @ui.page() context, via ui.timer(..., once=True).

Includes:
- Canvas-based grid editor in the browser
- Modes: Paint / Erase / Fill / Eyedropper
- Left-drag painting (pointer events)
- Right-drag quick erase (suppresses context menu)
- Undo / Redo (snapshot based)
- JSON save / load
- Export PNG / PDF (server-side)
- Optional row/col numbering overlay

Run:
  python nicegui_test_port.py
"""

from __future__ import annotations

import copy
import io
import json
from dataclasses import dataclass
from typing import List, Optional, Tuple

from nicegui import ui, events
from PIL import Image, ImageDraw
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as pdf_canvas


def normalize_hex(s: str) -> str:
    s = (s or "").strip()
    if not s:
        return "#000000"
    if not s.startswith("#"):
        s = "#" + s
    if len(s) == 4:  # #RGB -> #RRGGBB
        s = "#" + "".join([c * 2 for c in s[1:]])
    return s.lower()


@dataclass
class Snapshot:
    grid: List[List[Optional[str]]]
    bg_color: str


class CrochetModel:
    def __init__(self, rows: int = 30, cols: int = 30, cell_size: int = 18) -> None:
        self.rows = int(rows)
        self.cols = int(cols)
        self.cell_size = int(cell_size)

        self.bg_color: str = "#ffffff"
        self.active_color: str = "#000000"
        self.mode: str = "paint"  # paint | erase | fill | eyedropper
        self.show_numbers: bool = False

        self.grid: List[List[Optional[str]]] = [[None for _ in range(self.cols)] for _ in range(self.rows)]

        self.undo_stack: List[Snapshot] = []
        self.redo_stack: List[Snapshot] = []
        self._pending_snapshot: Optional[Snapshot] = None

    # --- state helpers ---
    def snapshot(self) -> Snapshot:
        return Snapshot(grid=copy.deepcopy(self.grid), bg_color=self.bg_color)

    def push_undo(self, snap: Snapshot) -> None:
        self.undo_stack.append(snap)
        if len(self.undo_stack) > 50:
            self.undo_stack.pop(0)

    def begin_action(self) -> None:
        if self._pending_snapshot is None:
            self._pending_snapshot = self.snapshot()

    def end_action(self) -> None:
        if self._pending_snapshot is None:
            return
        before = self._pending_snapshot
        after = self.snapshot()
        self._pending_snapshot = None

        if json.dumps(before.grid) != json.dumps(after.grid) or before.bg_color != after.bg_color:
            self.push_undo(before)
            self.redo_stack.clear()

    def restore(self, snap: Snapshot) -> None:
        self.grid = copy.deepcopy(snap.grid)
        self.bg_color = snap.bg_color

    def undo(self) -> bool:
        if not self.undo_stack:
            return False
        current = self.snapshot()
        snap = self.undo_stack.pop()
        self.redo_stack.append(current)
        self.restore(snap)
        return True

    def redo(self) -> bool:
        if not self.redo_stack:
            return False
        current = self.snapshot()
        snap = self.redo_stack.pop()
        self.undo_stack.append(current)
        self.restore(snap)
        return True

    # --- grid operations ---
    def in_bounds(self, r: int, c: int) -> bool:
        return 0 <= r < self.rows and 0 <= c < self.cols

    def current_paint_color(self) -> str:
        return normalize_hex(self.active_color)

    def apply_tool_at(self, r: int, c: int) -> bool:
        if not self.in_bounds(r, c):
            return False

        if self.mode == "paint":
            new = self.current_paint_color()
            if self.grid[r][c] != new:
                self.grid[r][c] = new
                return True
            return False

        if self.mode == "erase":
            if self.grid[r][c] is not None:
                self.grid[r][c] = None
                return True
            return False

        if self.mode == "eyedropper":
            picked = self.grid[r][c]
            if picked:
                self.active_color = picked
                return True
            return False

        if self.mode == "fill":
            target = self.grid[r][c]
            replacement = self.current_paint_color()
            if target == replacement:
                return False
            self.bucket_fill(r, c, target, replacement)
            return True

        return False

    def bucket_fill(self, r0: int, c0: int, target: Optional[str], replacement: str) -> None:
        if not self.in_bounds(r0, c0):
            return
        if self.grid[r0][c0] != target:
            return

        stack = [(r0, c0)]
        while stack:
            r, c = stack.pop()
            if not self.in_bounds(r, c):
                continue
            if self.grid[r][c] != target:
                continue
            self.grid[r][c] = replacement
            stack.append((r - 1, c))
            stack.append((r + 1, c))
            stack.append((r, c - 1))
            stack.append((r, c + 1))

    # --- persistence ---
    def to_json_obj(self) -> dict:
        """Export JSON compatible with the original Tk app.

        Original schema (pattern.py):
          {version, rows, cols, background, cells}

        We also include our newer keys for forward-compat.
        """
        return {
            "version": 2,
            "rows": self.rows,
            "cols": self.cols,
            "background": self.bg_color,
            "cells": self.grid,
            # extras:
            "bg_color": self.bg_color,
            "grid": self.grid,
        }

    def load_json_obj(self, obj: dict) -> None:
        # Accept both schemas:
        # A) Tk app: {version, rows, cols, background, cells}
        # B) Early NiceGUI prototype: {version, rows, cols, bg_color, grid}
        rows = int(obj.get("rows", self.rows))
        cols = int(obj.get("cols", self.cols))

        bg = obj.get("background", obj.get("bg_color", self.bg_color))
        bg = normalize_hex(bg) or "#ffffff"

        grid = obj.get("cells", obj.get("grid"))
        if not isinstance(grid, list):
            raise ValueError("Invalid grid in JSON")

        self.rows, self.cols = rows, cols
        self.bg_color = bg
        self.grid = [[None for _ in range(cols)] for _ in range(rows)]

        # Validate shape loosely; if mismatch, load overlapping portion
        for r in range(min(rows, len(grid))):
            row = grid[r]
            if not isinstance(row, list):
                continue
            for c in range(min(cols, len(row))):
                val = row[c]
                self.grid[r][c] = normalize_hex(val) if val else None

        self.undo_stack.clear()
        self.redo_stack.clear()
        self._pending_snapshot = None

    # --- exports ---
    def render_png_bytes(self, show_numbers: bool = False) -> bytes:
        cell = self.cell_size
        w = self.cols * cell
        h = self.rows * cell

        img = Image.new("RGB", (w, h), self.bg_color)
        draw = ImageDraw.Draw(img)

        for r in range(self.rows):
            y0 = r * cell
            for c in range(self.cols):
                x0 = c * cell
                color = self.grid[r][c]
                if color:
                    draw.rectangle([x0, y0, x0 + cell - 1, y0 + cell - 1], fill=color)

        for c in range(self.cols + 1):
            x = c * cell
            draw.line([(x, 0), (x, h)], fill="#cccccc")
        for r in range(self.rows + 1):
            y = r * cell
            draw.line([(0, y), (w, y)], fill="#cccccc")

        if show_numbers:
            for c in range(self.cols):
                draw.text((c * cell + 2, 2), str(c + 1), fill="#333333")
            for r in range(self.rows):
                draw.text((2, r * cell + 2), str(r + 1), fill="#333333")

        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    def render_pdf_bytes(self, show_numbers: bool = False) -> bytes:
        png = self.render_png_bytes(show_numbers=show_numbers)
        buf = io.BytesIO()

        c = pdf_canvas.Canvas(buf, pagesize=letter)
        page_w, page_h = letter

        img = Image.open(io.BytesIO(png))
        iw, ih = img.size
        max_w = page_w - 72
        max_h = page_h - 72
        scale = min(max_w / iw, max_h / ih)
        dw, dh = iw * scale, ih * scale
        x = (page_w - dw) / 2
        y = (page_h - dh) / 2
        c.drawInlineImage(img, x, y, dw, dh)
        c.showPage()
        c.save()

        return buf.getvalue()


# -------------- App / Page --------------

model = CrochetModel(rows=30, cols=30, cell_size=18)


def canvas_dims() -> Tuple[int, int]:
    return model.cols * model.cell_size, model.rows * model.cell_size


def js_bind_handlers() -> str:
    # binds pointer events on the canvas and forwards them as window CustomEvents
    return """
    (function() {
      const canvas = document.getElementById('grid_canvas');
      if (!canvas) return;

      canvas.addEventListener('contextmenu', e => e.preventDefault());

      function pack(e) {
        const rect = canvas.getBoundingClientRect();
        return {
          offsetX: e.clientX - rect.left,
          offsetY: e.clientY - rect.top,
          button: e.button,
        };
      }

      canvas.onpointerdown = (e) => window.dispatchEvent(new CustomEvent('ng_pointerdown', {detail: pack(e)}));
      canvas.onpointermove = (e) => window.dispatchEvent(new CustomEvent('ng_pointermove', {detail: pack(e)}));
      canvas.onpointerup   = (e) => window.dispatchEvent(new CustomEvent('ng_pointerup',   {detail: pack(e)}));
      canvas.onpointerleave= (e) => window.dispatchEvent(new CustomEvent('ng_pointerleave',{detail: pack(e)}));
    })();
    """


def js_redraw_all() -> str:
    w, h = canvas_dims()
    cell = model.cell_size
    show = "true" if model.show_numbers else "false"
    grid_json = json.dumps(model.grid)
    bg = model.bg_color

    return f"""
    (function(){{
      const canvas = document.getElementById('grid_canvas');
      if(!canvas) return;
      const ctx = canvas.getContext('2d');
      const cell = {cell};
      canvas.width = {w};
      canvas.height = {h};

      ctx.fillStyle = {json.dumps(bg)};
      ctx.fillRect(0,0,canvas.width,canvas.height);

      const grid = {grid_json};

      for(let r=0; r<grid.length; r++) {{
        const row = grid[r];
        for(let c=0; c<row.length; c++) {{
          const col = row[c];
          if(col) {{
            ctx.fillStyle = col;
            ctx.fillRect(c*cell, r*cell, cell, cell);
          }}
        }}
      }}

      ctx.strokeStyle = '#cccccc';
      ctx.lineWidth = 1;
      for(let c=0; c<={model.cols}; c++) {{
        ctx.beginPath();
        ctx.moveTo(c*cell + 0.5, 0);
        ctx.lineTo(c*cell + 0.5, canvas.height);
        ctx.stroke();
      }}
      for(let r=0; r<={model.rows}; r++) {{
        ctx.beginPath();
        ctx.moveTo(0, r*cell + 0.5);
        ctx.lineTo(canvas.width, r*cell + 0.5);
        ctx.stroke();
      }}

      if({show}) {{
        ctx.fillStyle = '#333333';
        ctx.font = '10px sans-serif';
        for(let c=0; c<{model.cols}; c++) {{
          ctx.fillText(String(c+1), c*cell + 2, 10);
        }}
        for(let r=0; r<{model.rows}; r++) {{
          ctx.fillText(String(r+1), 2, r*cell + 10);
        }}
      }}
    }})();
    """


@ui.page("/")
def main_page() -> None:
    # drawing state per-client/page
    is_drawing = {"down": False, "last_cell": None, "button": 0}

    ui.add_head_html("""
    <style>
      #grid_canvas { touch-action: none; }
    </style>
    """)

    def cell_from_event(e: events.GenericEventArguments) -> Optional[Tuple[int, int]]:
        ox = e.args.get("offsetX")
        oy = e.args.get("offsetY")
        if ox is None or oy is None:
            return None
        cell = model.cell_size
        c = int(ox // cell)
        r = int(oy // cell)
        if not model.in_bounds(r, c):
            return None
        return r, c

    def update_toolbar_state() -> None:
        undo_btn.props(f'color={"primary" if model.undo_stack else "grey"}')
        redo_btn.props(f'color={"primary" if model.redo_stack else "grey"}')

    def redraw() -> None:
        ui.run_javascript(js_redraw_all())
        update_toolbar_state()

    def apply_at(r: int, c: int) -> None:
        changed = model.apply_tool_at(r, c)
        color_picker.value = model.active_color
        if changed:
            redraw()

    def on_pointerdown(e: events.GenericEventArguments) -> None:
        cell = cell_from_event(e)
        if cell is None:
            return
        btn = e.args.get("button", 0)
        is_drawing["down"] = True
        is_drawing["button"] = btn
        is_drawing["last_cell"] = None

        model.begin_action()

        r, c = cell
        if btn == 2:
            prev_mode = model.mode
            model.mode = "erase"
            apply_at(r, c)
            model.mode = prev_mode
        else:
            apply_at(r, c)
        is_drawing["last_cell"] = cell

    def on_pointermove(e: events.GenericEventArguments) -> None:
        if not is_drawing["down"]:
            return
        cell = cell_from_event(e)
        if cell is None:
            return
        if cell == is_drawing["last_cell"]:
            return
        r, c = cell

        btn = is_drawing["button"]
        if btn == 2:
            prev_mode = model.mode
            model.mode = "erase"
            apply_at(r, c)
            model.mode = prev_mode
        else:
            apply_at(r, c)
        is_drawing["last_cell"] = cell

    def on_pointerup(_: events.GenericEventArguments) -> None:
        if not is_drawing["down"]:
            return
        is_drawing["down"] = False
        is_drawing["last_cell"] = None
        model.end_action()
        redraw()

    def set_mode(value: str) -> None:
        model.mode = value

    def set_active_color(value: str) -> None:
        model.active_color = normalize_hex(value)

    def set_bg_color(value: str) -> None:
        model.begin_action()
        model.bg_color = normalize_hex(value)
        model.end_action()
        redraw()

    def toggle_numbers(value: bool) -> None:
        model.show_numbers = bool(value)
        redraw()

    def do_undo() -> None:
        if model.undo():
            redraw()

    def do_redo() -> None:
        if model.redo():
            redraw()

    def new_grid(rows: int, cols: int, cell_size: int) -> None:
        rows = int(rows)
        cols = int(cols)
        cell_size = int(cell_size)
        model.begin_action()
        model.rows, model.cols, model.cell_size = rows, cols, cell_size
        model.grid = [[None for _ in range(cols)] for _ in range(rows)]
        model.bg_color = "#ffffff"
        model.active_color = "#000000"
        model.undo_stack.clear()
        model.redo_stack.clear()
        model._pending_snapshot = None
        model.end_action()
        # update inputs
        rows_in.value, cols_in.value, cell_in.value = rows, cols, cell_size
        bg_picker.value = model.bg_color
        color_picker.value = model.active_color
        redraw()

    def clear_grid() -> None:
        model.begin_action()
        for r in range(model.rows):
            for c in range(model.cols):
                model.grid[r][c] = None
        model.end_action()
        redraw()

    def download_json() -> None:
        payload = json.dumps(model.to_json_obj(), indent=2).encode("utf-8")
        ui.download(payload, filename="crochet_pattern.json")

    async def load_json_from_upload(e: events.UploadEventArguments) -> None:
        try:
            raw = e.file.read()
            # NiceGUI versions differ: read() may return bytes or a coroutine of bytes
            if hasattr(raw, '__await__'):
                raw = await raw
            # Sometimes libraries return str; normalize to bytes
            if isinstance(raw, str):
                raw = raw.encode('utf-8')
            obj = json.loads(raw.decode('utf-8'))
            model.load_json_obj(obj)
            bg_picker.value = model.bg_color
            color_picker.value = model.active_color
            rows_in.value = model.rows
            cols_in.value = model.cols
            cell_in.value = model.cell_size
            redraw()
            ui.notify("Loaded JSON.")
        except Exception as ex:
            ui.notify(f"Failed to load: {ex}", type="negative")

    def download_png() -> None:
        ui.download(model.render_png_bytes(show_numbers=model.show_numbers), filename="crochet_pattern.png")

    def download_pdf() -> None:
        ui.download(model.render_pdf_bytes(show_numbers=model.show_numbers), filename="crochet_pattern.pdf")

    # Layout
    with ui.row().classes("w-full"):
        with ui.column().classes("w-80 gap-3"):
            ui.label("Crochet Grid (NiceGUI Test Port 1)").classes("text-lg font-bold")

            ui.select(
                {"paint": "Paint", "erase": "Erase", "fill": "Bucket Fill", "eyedropper": "Eyedropper"},
                value="paint",
                label="Mode",
                on_change=lambda e: set_mode(e.value),
            ).classes("w-full")

            color_picker = ui.color_input(label="Active color", value=model.active_color, on_change=lambda e: set_active_color(e.value)).classes("w-full")
            bg_picker = ui.color_input(label="Background color", value=model.bg_color, on_change=lambda e: set_bg_color(e.value)).classes("w-full")

            ui.switch("Show row/col numbers", value=False, on_change=lambda e: toggle_numbers(e.value))

            with ui.row().classes("w-full"):
                undo_btn = ui.button("Undo", on_click=do_undo).classes("flex-1")
                redo_btn = ui.button("Redo", on_click=do_redo).classes("flex-1")

            with ui.card().classes("w-full"):
                ui.label("Grid settings").classes("font-semibold")
                rows_in = ui.number(label="Rows", value=model.rows, min=1, max=200).classes("w-full")
                cols_in = ui.number(label="Cols", value=model.cols, min=1, max=200).classes("w-full")
                cell_in = ui.number(label="Cell size (px)", value=model.cell_size, min=6, max=60).classes("w-full")
                with ui.row().classes("w-full"):
                    ui.button("New grid", on_click=lambda: new_grid(rows_in.value, cols_in.value, cell_in.value)).classes("flex-1")
                    ui.button("Clear", on_click=clear_grid).classes("flex-1")

            with ui.card().classes("w-full"):
                ui.label("Save / Load").classes("font-semibold")
                with ui.row().classes("w-full"):
                    ui.button("Download JSON", on_click=download_json).classes("flex-1")
                    ui.upload(on_upload=load_json_from_upload, label="Load JSON", auto_upload=True).props("accept=.json").classes("flex-1")

            with ui.card().classes("w-full"):
                ui.label("Export").classes("font-semibold")
                with ui.row().classes("w-full"):
                    ui.button("PNG", on_click=download_png).classes("flex-1")
                    ui.button("PDF", on_click=download_pdf).classes("flex-1")

            ui.markdown(
                "- Left click/drag: apply selected mode\n"
                "- Right click/drag: quick erase\n"
                "- Eyedropper picks active color from a colored cell\n"
                "- Fill floods contiguous region matching the clicked cell\n"
            ).classes("text-sm text-gray-600")

        with ui.column().classes("flex-1"):
            with ui.card().classes("w-full"):
                ui.html('<canvas id="grid_canvas"></canvas>').classes("w-full")

            # Listen for the custom DOM events dispatched by JS
            ui.on("ng_pointerdown", on_pointerdown)
            ui.on("ng_pointermove", on_pointermove)
            ui.on("ng_pointerup", on_pointerup)
            ui.on("ng_pointerleave", on_pointerup)

    # After the client connects, bind JS handlers and do the first draw
    ui.timer(0.05, lambda: ui.run_javascript(js_bind_handlers()), once=True)
    ui.timer(0.10, redraw, once=True)


ui.run(title="Crochet Grid - NiceGUI Test Port 1", reload=False)
