"""Interactive tool: run this against ONE real screenshot of a card's detail
panel to produce ocr/config/crop_regions.json — the field positions
panel_ocr.py reads. This is the step CLAUDE.md flags as blocking Phase 2:
crop regions can't be guessed, they have to be shown once against a real
screenshot at your actual resolution.

Usage:
    python calibrate.py path/to/screenshot.png

For each field in turn, a window opens on the image — drag a box around
that field, press Enter/Space to confirm and move to the next one, or Enter
with no drag to skip a field that isn't present on this particular card
(e.g. sub4_label/sub4_value on a card with only 3 substats). Esc cancels
the whole run without writing anything.

The result is resolution-independent (boxes are stored as fractions of
image width/height), so it only needs to be run once per device/resolution,
not once per screenshot.
"""
import argparse
import json
from pathlib import Path

FIELDS = [
    "slot_tabs", "title", "level", "main_label",
    "sub1_label", "sub1_value",
    "sub2_label", "sub2_value",
    "sub3_label", "sub3_value",
    "sub4_label", "sub4_value",
]

# Shown before each drag, so it's clear what to aim at — several of these are
# not the obvious thing on screen (see panel_ocr.py's module docstring).
#
# Two of these hints exist because of real miscalibrations that reached a batch
# (Aug 2026): a level box fitted to a "Lv.0" card clipped the second digit of
# every "Lv.25" card and read it as 128, and sub label boxes dragged to the
# value column swallowed the yellow enhancement bolt, which OCRs as junk glued
# onto the stat name. Both came from calibrating against one unrepresentative
# card, so both hints say what the WORST case looks like, not the typical one.
SUB_LABEL_HINT = ("the substat's NAME only. Stop well before the yellow bolt icon "
                  "to its right (the 'enhanced' marker, only present on levelled "
                  "cards) and before the value column — either one bleeding in "
                  "corrupts short names like 'Speed' and 'HP'")

FIELD_HINTS = {
    "slot_tabs": "the WHOLE Space/Sun/Moon/Star/Sky tab strip, top-left "
                 "(read by colour, not text — one tab is highlighted red)",
    "title": "the set name in the Set Effect box, lower right, e.g. '[Futility]' "
             "— NOT the big stylized title at the top, which OCR cannot read",
    "level": "the 'Lv.25' text. Calibrate this on a TWO-DIGIT level and leave "
             "clear margin on both sides — a box fitted snugly to 'Lv.0' clips "
             "the second digit and misreads every maxed card",
    "main_label": "the name of the first stat, the one with its own icon "
                  "(e.g. 'Crit Rate') — not its number",
    **{f"sub{i}_label": SUB_LABEL_HINT for i in range(1, 5)},
}


def px_box_to_fraction(box, width, height):
    x, y, w, h = box
    return [x / width, y / height, (x + w) / width, (y + h) / height]


def build_regions(px_boxes, width, height):
    """px_boxes: dict field -> (x, y, w, h) in pixels (cv2.selectROI's shape).
    A field left as a zero-area box (skipped by the user) is dropped, so
    calibrate.py never has to know in advance how many substats a given
    sample card has."""
    regions = {}
    for field, box in px_boxes.items():
        x, y, w, h = box
        if w <= 0 or h <= 0:
            continue
        regions[field] = px_box_to_fraction(box, width, height)
    return regions


def save_config(regions, image_size, out_path):
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"image_size_hint": list(image_size), "fields": regions}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return payload


def load_config(path):
    """Returns the flat field -> [x0,y0,x1,y1] dict panel_ocr.parse_panel expects."""
    with open(path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    return payload["fields"]


def run_calibration(image_path, out_path, only=None):
    import cv2  # imported here, not at module load, so the testable functions
    # above don't require a display/GUI backend to be importable at all

    img = cv2.imread(str(image_path))
    if img is None:
        raise FileNotFoundError(f"could not read image: {image_path}")
    height, width = img.shape[:2]

    fields = [f for f in FIELDS if f in only] if only else FIELDS

    px_boxes = {}
    for field in fields:
        hint = FIELD_HINTS.get(field)
        print(f"\n{field}" + (f" — {hint}" if hint else ""))
        window = f"Drag a box around: {field}  (Enter/Space=confirm, no drag=skip, Esc=quit)"
        box = cv2.selectROI(window, img, showCrosshair=True)
        cv2.destroyWindow(window)
        if box == (0, 0, 0, 0):
            print(f"  skipped {field}")
            continue
        px_boxes[field] = box
        print(f"  {field}: {box}")

    regions = build_regions(px_boxes, width, height)

    # --only is a partial recalibration: keep every field not being redone,
    # so fixing one bad box doesn't mean dragging all eleven again.
    if only and Path(out_path).exists():
        existing = load_config(out_path)
        merged = dict(existing)
        merged.update(regions)
        regions = merged

    save_config(regions, (width, height), out_path)
    print(f"\nWrote {out_path} with {len(regions)} field(s).")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="a real screenshot of one card's detail panel")
    parser.add_argument("--out", default=str(Path(__file__).parent / "config" / "crop_regions.json"))
    parser.add_argument("--only", nargs="+", metavar="FIELD",
                         help="recalibrate just these fields, keeping the rest of an "
                              f"existing config. Fields: {', '.join(FIELDS)}")
    args = parser.parse_args()
    run_calibration(args.image, args.out, only=args.only)
