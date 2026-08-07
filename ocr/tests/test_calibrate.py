"""Covers the testable core of calibrate.py — everything except the actual
mouse-drag loop, which needs a display and can't be driven from a test."""
import json

from calibrate import build_regions, load_config, px_box_to_fraction, save_config


def test_px_box_to_fraction():
    # a 100x50 box at (200, 100) inside a 1920x1080 image
    assert px_box_to_fraction((200, 100, 100, 50), 1920, 1080) == [
        200 / 1920, 100 / 1080, 300 / 1920, 150 / 1080,
    ]


def test_build_regions_drops_zero_area_boxes():
    px_boxes = {
        "title": (10, 10, 200, 40),
        "sub4_label": (0, 0, 0, 0),  # user skipped this field
        "sub4_value": (0, 0, 0, 0),
    }
    regions = build_regions(px_boxes, 1920, 1080)
    assert "title" in regions
    assert "sub4_label" not in regions
    assert "sub4_value" not in regions


def test_save_and_load_round_trip(tmp_path):
    regions = {"title": [0.05, 0.02, 0.4, 0.08], "level": [0.05, 0.1, 0.2, 0.15]}
    out_path = tmp_path / "crop_regions.json"
    save_config(regions, (1920, 1080), out_path)

    loaded = load_config(out_path)
    assert loaded == regions


def test_saved_file_records_the_calibration_resolution(tmp_path):
    out_path = tmp_path / "crop_regions.json"
    save_config({"title": [0, 0, 1, 1]}, (1920, 1080), out_path)
    with open(out_path) as f:
        payload = json.load(f)
    assert payload["image_size_hint"] == [1920, 1080]
