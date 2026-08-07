"""No real screen recording exists yet, so this builds a tiny synthetic video
with ffmpeg itself (two solid-color segments back to back) — plays the same
role the PIL-rendered panel does for panel_ocr.py: proves the mechanics work
without needing real footage."""
import subprocess

import pytest

from extract_frames import extract_and_dedupe, extract_frames


@pytest.fixture
def two_segment_video(tmp_path):
    """A 4-second video: 2s of a fine static grid, then 2s of a coarse static
    grid, at 10fps. dhash converts to grayscale and measures internal
    gradients, so two segments need genuinely different structure, not just
    different colors (flat colour fields hash identically) — this is a
    property of dhash, not of real screenshots, which are full of text/UI
    edges. The grid stays fixed within each segment so dedup still has
    near-duplicate frames to collapse."""
    out = tmp_path / "sample.mp4"
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2:r=10,drawgrid=w=16:h=16:t=2:c=white",
        "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2:r=10,drawgrid=w=64:h=64:t=2:c=white",
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0",
        str(out),
    ]
    subprocess.run(cmd, capture_output=True, text=True, check=True)
    return out


def test_extract_frames_samples_at_requested_fps(two_segment_video, tmp_path):
    frames = extract_frames(two_segment_video, tmp_path / "frames", fps=5)
    # 4 seconds at 5fps ~= 20 frames
    assert 18 <= len(frames) <= 22
    for f in frames:
        assert f.exists()


def test_dedupe_collapses_each_static_segment_to_one_frame(two_segment_video, tmp_path):
    kept = extract_and_dedupe(two_segment_video, tmp_path / "frames", fps=5, max_distance=4)
    # ~20 raw frames (10 red, 10 blue) should collapse to exactly one frame per color
    assert len(kept) == 2


def test_dedupe_deletes_dropped_frames_from_disk(two_segment_video, tmp_path):
    frame_dir = tmp_path / "frames"
    frames = extract_frames(two_segment_video, frame_dir, fps=5)
    raw_count = len(frames)
    kept = extract_and_dedupe(two_segment_video, tmp_path / "frames2", fps=5, max_distance=4)
    remaining_on_disk = list((tmp_path / "frames2").glob("*.png"))
    assert len(remaining_on_disk) == len(kept) < raw_count
