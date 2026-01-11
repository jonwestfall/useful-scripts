# Movie Summary Collage

Create quick visual summaries of movie files by extracting evenly spaced screenshots and combining them into a single collage image.

This script uses **FFmpeg** to sample frames from a video and **Pillow** to assemble them into a horizontal contact sheet. It works on **individual movie files or entire directories**.

---

## What This Does

Given a movie file, the script:

1. Detects the total runtime using `ffprobe`
2. Divides the runtime into **5 equal segments** (configurable)
3. Captures a frame from the **midpoint of each segment**
   - Avoids opening/closing fades and black frames
4. Resizes the frames to a consistent height
5. Combines them into a **single collage image**
6. Saves the result as:

```
summary-<movie_filename>.jpg
```

When run on a directory, it repeats this process for **every video file** inside.

---

## Requirements

### System
- **FFmpeg** (must include `ffmpeg` and `ffprobe`)

```bash
brew install ffmpeg        # macOS
sudo apt install ffmpeg    # Debian/Ubuntu
```

### Python
- Python 3.8+
- Pillow

```bash
python3 -m pip install pillow
```

---

## Usage

### Single Movie File

```bash
python movie_summary_collage.py movie.mp4
```

### Entire Directory

```bash
python movie_summary_collage.py ~/Movies
```

Each movie in the directory will produce its own `summary-*` image.

Existing summaries are skipped automatically.

---

## Supported Video Formats

```
.mp4, .mkv, .mov, .avi, .wmv, .flv, .webm, .m4v
```

---

## Command-Line Options

| Option | Description | Default |
|------|------------|---------|
| `--frames` | Number of frames to extract | `5` |
| `--tile-height` | Height (px) of each frame in the collage | `360` |
| `--format` | Output image format (`jpg` or `png`) | `jpg` |

### Example

```bash
python movie_summary_collage.py ~/Movies --frames 7 --tile-height 480 --format png
```

---

## How Frame Timing Works

Frames are sampled at the **midpoint of each equal time segment**, avoiding:

- Black intro frames
- Fade-ins and fade-outs
- End credits

This produces a more representative visual summary.

---

## Output Behavior

- Images are saved **next to the original movie**
- Naming format:
  ```
  summary-<original_filename>.<ext>
  ```
- Existing summaries are skipped (safe to re-run)

---

## Common Use Cases

- Visual previews of large movie libraries
- Media server thumbnails
- Teaching or presentation references
- Archival browsing

---

## Notes & Limitations

- Directory scanning is **non-recursive**
- Audio is ignored
- No subtitles or overlays are added
- Requires FFmpeg in system PATH

---

## License

MIT
