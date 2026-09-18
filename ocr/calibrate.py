"""Interactive tool: run this against ONE real screenshot of a card's detail
panel to produce ocr/config/crop_regions.json — the field positions
panel_ocr.py reads. This is the step CLAUDE.md flags as blocking Phase 2:
crop regions can't be guessed, they have to be shown once against a real
screenshot at your actual resolution.

Usage:
    python calibrate.py path/to/heavens-card.png
    python calibrate.py path/to/space-card.png --layout space

Two runs, because there are two panel layouts and no one screenshot shows
both: a Space card has a second main stat row (flat ATK then flat DEF) which
pushes its four substats down one row, so those rows get their own boxes
(--layout space). Both runs write to the same file and merge, the same way
--only does, so the second one does not undo the first.

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

HEAVENS_FIELDS = [
    "slot_tabs", "title", "level", "main_label", "main_value",
    "sub1_label", "sub1_value",
    "sub2_label", "sub2_value",
    "sub3_label", "sub3_value",
    "sub4_label", "sub4_value",
]

# Space cards only. Everything a Space panel shares with a Heavens one
# (slot_tabs, title, level, the FIRST main stat row) is deliberately absent —
# it is already calibrated by the Heavens run and re-dragging it here would
# only add a second chance to get it wrong.
SPACE_FIELDS = [
    "space_main2_value",
    "space_sub1_label", "space_sub1_value",
    "space_sub2_label", "space_sub2_value",
    "space_sub3_label", "space_sub3_value",
    "space_sub4_label", "space_sub4_value",
]

LAYOUTS = {"heavens": HEAVENS_FIELDS, "space": SPACE_FIELDS}
FIELDS = HEAVENS_FIELDS + SPACE_FIELDS

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

# The third miscalibration that reached a batch (Aug 2026): value boxes fitted to
# whatever number was on the calibration card start too far right, and since the
# numbers are RIGHT-aligned the box then clips the leading digit of every wider
# one — a real "10.8%" was imported as "0.8%", in range and so unflagged. The
# boxes have to be sized to the widest value the column can hold, not this card's.
VALUE_HINT = ("the NUMBER only, and extend the box well to the LEFT of it — the "
              "column is right-aligned, so a box that just fits this card's value "
              "silently eats the first digit of every longer one. Stop short of "
              "the yellow bolt icon; the gap between it and the digits is the "
              "left edge to aim for")

FIELD_HINTS = {
    "slot_tabs": "the WHOLE Space/Sun/Moon/Star/Sky tab strip, top-left "
                 "(read by colour, not text — one tab is highlighted red)",
    "title": "the set name in the Set Effect box, lower right, e.g. '[Futility]' "
             "— NOT the big stylized title at the top, which OCR cannot read. On a "
             "Space card it names two sets ('Acceptance & Strife'); box both, the "
             "pipeline takes the Space one",
    "level": "the 'Lv.25' text. Calibrate this on a TWO-DIGIT level and leave "
             "clear margin on both sides — a box fitted snugly to 'Lv.0' clips "
             "the second digit and misreads every maxed card",
    "main_label": "the name of the first stat, the one with its own icon "
                  "(e.g. 'Crit Rate') — not its number",
    "main_value": VALUE_HINT + " (this row's widest value is a 4-digit HP main)",
    "space_main2_value": "the number on the SECOND main stat row of a Space card — "
                         "the flat Defense one, under flat Attack. " + VALUE_HINT,
    **{f"sub{i}_label": SUB_LABEL_HINT for i in range(1, 5)},
    **{f"sub{i}_value": VALUE_HINT for i in range(1, 5)},
    **{f"space_sub{i}_label": SUB_LABEL_HINT + ". NOTE: on a Space card the "
       "substats start BELOW the second main stat row, not below the first"
       for i in range(1, 5)},
    **{f"space_sub{i}_value": VALUE_HINT for i in range(1, 5)},
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


def run_calibration(image_path, out_path, only=None, layout="heavens"):
    import cv2  # imported here, not at module load, so the testable functions
    # above don't require a display/GUI backend to be importable at all

    img = cv2.imread(str(image_path))
    if img is None:
        raise FileNotFoundError(f"could not read image: {image_path}")
    height, width = img.shape[:2]

    fields = [f for f in FIELDS if f in only] if only else LAYOUTS[layout]

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
    # so fixing one bad box doesn't mean dragging all eleven again. --layout is
    # partial for the same reason — the Space rows are calibrated on a Space card
    # in a second run, and must not wipe the Heavens rows from the first.
    if (only or layout != "heavens") and Path(out_path).exists():
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
    parser.add_argument("--layout", choices=sorted(LAYOUTS), default="heavens",
                         help="'space' calibrates only the Space card's extra main stat "
                              "row and its shifted substat rows, merging into an existing "
                              "config. Run it on a Space card after the heavens run")
    parser.add_argument("--only", nargs="+", metavar="FIELD",
                         help="recalibrate just these fields, keeping the rest of an "
                              f"existing config. Fields: {', '.join(FIELDS)}")
    args = parser.parse_args()
    run_calibration(args.image, args.out, only=args.only, layout=args.layout)
