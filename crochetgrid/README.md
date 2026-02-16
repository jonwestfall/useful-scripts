# 🧶 Crochet Pattern Grid Designer (v0.2)

A lightweight desktop application for visually designing crochet
colorwork patterns using a customizable grid.

Built with Python and Tkinter, this project now includes:

-   **pattern.py** → The interactive grid editor\
-   **image_to_crochet_json.py** → An image-to-grid conversion helper
    tool

Written by ChatGPT under the direction of Jon Westfall
(jon@jonwestfall.com)

------------------------------------------------------------------------

## 📸 Demo

![Demo Screenshot](demo_screenshot.png)

------------------------------------------------------------------------

# ✨ Applications Included

## 1️⃣ pattern.py --- Crochet Grid Editor

The main desktop application for designing crochet charts.

### Features

#### Grid Design

-   Customizable grid size (rows × columns)
-   Adjustable on-screen cell size
-   Configurable background color
-   Click-and-drag painting
-   Right-click quick erase

#### Tools

-   🖌 Paint
-   🧽 Erase
-   🪣 Bucket Fill (flood fill)
-   🎯 Eyedropper (color picker)
-   Undo / Redo support

#### Numbering Options

-   Toggle row/column numbers in the editor
-   Toggle row/column numbers in exported files
-   Choose numbering origin:
    -   Bottom-left (standard crochet chart style)
    -   Bottom-right

#### Save & Export

-   Save and load projects as JSON
-   Export as PNG (high resolution)
-   Export as PDF (print-friendly)

#### Live Cell Readout

-   Displays current row/column under the mouse
-   Updates in real-time while painting

------------------------------------------------------------------------

## 2️⃣ image_to_crochet_json.py --- Image Conversion Helper

Convert a simple logo or figure (e.g., black image on white background)
into a crochet grid JSON file compatible with `pattern.py`.

### What It Does

-   Detects figure vs. background automatically
-   Converts image to a specified grid size
-   Exports JSON compatible with the editor
-   Allows advanced control over grid behavior

### Adjustable Options

-   Total rows and columns
-   Header rows (blank rows at the top)
-   Footer rows (blank rows at the bottom)
-   Fill only odd-numbered rows (even rows remain background)
-   Background and figure color selection
-   Optional inversion if auto-detection guesses incorrectly
-   Optional threshold override (0--255)

### Typical Workflow

1.  Run the helper tool
2.  Load an image (logo or high-contrast figure)
3.  Set desired grid size and options
4.  Export JSON
5.  Load JSON into `pattern.py`
6.  Refine or export as PNG/PDF

------------------------------------------------------------------------

# 🧰 Installation

### Requirements

-   Python 3.9+
-   Pillow (required for both tools)
-   reportlab (PDF export in editor)

Install dependencies:

``` bash
pip install pillow reportlab
```

------------------------------------------------------------------------

# 🚀 Running the Applications

From the project directory:

``` bash
python pattern.py
```

``` bash
python image_to_crochet_json.py
```

------------------------------------------------------------------------

# 📂 JSON File Format

Saved JSON files include:

-   Grid size
-   Background color
-   Cell color data
-   Version number
-   Source metadata (when generated from image helper)

This makes patterns fully reloadable and editable.

------------------------------------------------------------------------

# 🧵 Design Philosophy

This project is designed to be:

-   Lightweight
-   Fully offline
-   Simple to understand
-   Easy to extend

Potential future enhancements:

-   Keyboard shortcuts
-   Multi-color auto-detection
-   Pattern legends
-   Stitch annotations
-   Direct PNG preview inside helper tool

------------------------------------------------------------------------

# 📜 License

MIT License.

------------------------------------------------------------------------

# 👤 Author

Created by Jon --- educator, developer, and enthusiast of structured
systems and creative tools.

------------------------------------------------------------------------

Version: 0.2
