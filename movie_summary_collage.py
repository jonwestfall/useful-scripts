#!/usr/bin/env python3
"""
movie_summary_collage.py

Usage:
  python movie_summary_collage.py /path/to/movie.mp4
  python movie_summary_collage.py /path/to/movie_directory

Requirements:
  - ffmpeg and ffprobe installed and in PATH
  - pip install pillow
"""

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import List

from PIL import Image


VIDEO_EXTENSIONS = {
    ".mp4", ".mkv", ".mov", ".avi", ".wmv", ".flv", ".webm", ".m4v"
}


def run_cmd(cmd: List[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )


def get_duration_seconds(video_path: Path) -> float:
    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(video_path),
    ]
    result = run_cmd(cmd)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())
    return float(result.stdout.strip())


def compute_timestamps(duration: float, n: int) -> List[float]:
    segment = duration / n
    return [(i + 0.5) * segment for i in range(n)]


def extract_frame(video_path: Path, timestamp: float, out_path: Path) -> None:
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-ss", f"{timestamp:.3f}",
        "-i", str(video_path),
        "-frames:v", "1",
        "-q:v", "2",
        str(out_path),
    ]
    result = run_cmd(cmd)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())


def make_collage(images: List[Path], out_path: Path, tile_height: int) -> None:
    tiles = []
    for img_path in images:
        img = Image.open(img_path).convert("RGB")
        w, h = img.size
        new_w = int(w * (tile_height / h))
        img = img.resize((new_w, tile_height), Image.LANCZOS)
        tiles.append(img)

    total_width = sum(img.width for img in tiles)
    collage = Image.new("RGB", (total_width, tile_height), (0, 0, 0))

    x = 0
    for img in tiles:
        collage.paste(img, (x, 0))
        x += img.width

    collage.save(out_path, quality=92)


def process_video(video_path: Path, frames: int, tile_height: int, fmt: str) -> None:
    out_path = video_path.with_name(f"summary-{video_path.stem}.{fmt}")
    if out_path.exists():
        print(f"Skipping (already exists): {out_path.name}")
        return

    duration = get_duration_seconds(video_path)
    timestamps = compute_timestamps(duration, frames)

    with tempfile.TemporaryDirectory(prefix="movie_summary_") as tmp:
        tmpdir = Path(tmp)
        frame_paths = []

        for i, ts in enumerate(timestamps, 1):
            frame = tmpdir / f"frame_{i:02d}.jpg"
            extract_frame(video_path, ts, frame)
            frame_paths.append(frame)

        make_collage(frame_paths, out_path, tile_height)

    print(f"Created: {out_path}")


def find_videos(path: Path) -> List[Path]:
    return sorted(
        p for p in path.iterdir()
        if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create 5-frame summary collages from a movie file or directory."
    )
    parser.add_argument("path", help="Movie file or directory")
    parser.add_argument("--frames", type=int, default=5)
    parser.add_argument("--tile-height", type=int, default=360)
    parser.add_argument("--format", choices=["jpg", "png"], default="jpg")
    args = parser.parse_args()

    # Verify ffmpeg tools
    for tool in ("ffmpeg", "ffprobe"):
        if run_cmd([tool, "-version"]).returncode != 0:
            print(f"Error: {tool} not found in PATH", file=sys.stderr)
            return 2

    path = Path(args.path).expanduser().resolve()
    if not path.exists():
        print(f"Error: path not found: {path}", file=sys.stderr)
        return 2

    videos = []
    if path.is_file():
        videos = [path]
    elif path.is_dir():
        videos = find_videos(path)

    if not videos:
        print("No video files found.")
        return 0

    for video in videos:
        try:
            process_video(video, args.frames, args.tile_height, args.format)
        except Exception as e:
            print(f"Failed on {video.name}: {e}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
