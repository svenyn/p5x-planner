"""Turns a screen recording into a small set of deduplicated frames.

A recording of you scrolling through ~4000 cards runs for many minutes at
30-60fps — the overwhelming majority of frames are near-identical to their
neighbour (mid-scroll, or the same card held on screen). Pulling every frame
would mean OCRing the same card dozens of times. Instead this samples a few
frames per second, then drops any frame whose perceptual hash is close to
the last *kept* frame, so a long stretch where nothing moved collapses to
one representative frame.
"""
import subprocess
from pathlib import Path

import imagehash
from PIL import Image


def extract_frames(video_path, out_dir, fps=2):
    """Samples `video_path` at `fps` frames/sec into `out_dir` as 000001.png,
    000002.png, ... Returns the sorted list of written frame paths."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    pattern = str(out_dir / "%06d.png")
    cmd = ["ffmpeg", "-y", "-i", str(video_path), "-vf", f"fps={fps}", "-q:v", "2", pattern]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed (exit {result.returncode}):\n{result.stderr[-2000:]}")
    return sorted(out_dir.glob("*.png"))


def dedupe_frames(frame_paths, hash_size=8, max_distance=4, delete_dropped=True):
    """Keeps a frame only if its perceptual hash differs from the last KEPT
    frame's by more than `max_distance` (Hamming distance over the hash
    bits) — comparing against the last kept frame, not the previous frame,
    so a slow fade or scroll doesn't sneak past one small step at a time.
    Returns the list of kept paths, in order."""
    kept = []
    last_hash = None
    for path in frame_paths:
        # dhash, not phash: phash pulls in scipy.fftpack for its DCT, and scipy's
        # compiled _specfun module is blocked by this machine's application-control
        # policy. dhash needs only PIL/numpy and is plenty robust for "did a static
        # screen actually change", which is all dedup needs here.
        h = imagehash.dhash(Image.open(path), hash_size=hash_size)
        if last_hash is None or (h - last_hash) > max_distance:
            kept.append(path)
            last_hash = h
        elif delete_dropped:
            Path(path).unlink()
    return kept


def extract_and_dedupe(video_path, out_dir, fps=2, max_distance=4):
    frames = extract_frames(video_path, out_dir, fps=fps)
    return dedupe_frames(frames, max_distance=max_distance)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", help="path to the screen recording")
    parser.add_argument("out_dir", help="directory to write deduplicated frames into")
    parser.add_argument("--fps", type=float, default=2, help="sampling rate before dedup (default: 2)")
    parser.add_argument("--max-distance", type=int, default=4, help="perceptual-hash distance threshold (default: 4)")
    args = parser.parse_args()

    kept = extract_and_dedupe(args.video, args.out_dir, fps=args.fps, max_distance=args.max_distance)
    print(f"kept {len(kept)} frame(s) in {args.out_dir}")
