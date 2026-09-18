"""Ties extract_frames.py + calibrate.py's crop_regions.json + panel_ocr.py +
validate.py together: point this at a screen recording (or a directory of
already-captured screenshots) and get back a cards.json ready for the app's
"Import cards (merge)" button on the Save/Load tab, plus a companion
*-review.json listing anything that couldn't be resolved cleanly.

Neither rarity nor slot is visible/readable on the card detail panel (see
panel_ocr.py's docstring — the slot would come from the card's stylized
title, which turned out to use a font Tesseract can't read at all against a
real screenshot). Pass --rarity and --slot to stamp every card from this run
with one value each — this matches scanning one rarity tier of one slot's
cards in a batch, which the game's own UI already sorts by (the Space/Sun/
Moon/Star/Sky tabs). Cards run without both are always sent to the review
file rather than risking a silently wrong value.

A real scanning session is many of these runs back to back — one per
rarity/slot tier — and re-running with the same (or default) --out is the
norm, not a mistake. So the output path is de-duplicated automatically: if
it already exists, run_pipeline picks "<name>-2.json", "-3.json", and so on
rather than overwriting a previous batch's cards.json/*-review.json pair.
"""
import argparse
import json
from pathlib import Path

from PIL import Image

from calibrate import load_config
from levels import LevelTemplates
from extract_frames import extract_and_dedupe
from panel_ocr import parse_panel
from validate import validate_card
from vocab import Vocab

IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg")


def unique_out_path(path):
    """If `path` already exists, returns "<stem>-2<suffix>", "-3", ... instead
    — the first of those that doesn't itself already exist. Otherwise returns
    `path` unchanged. Every batch shares the same default (or user-supplied)
    --out, so without this the second run of a scanning session would
    silently discard the first batch's cards.json and *-review.json."""
    path = Path(path)
    if not path.exists():
        return path
    n = 2
    while True:
        candidate = path.with_name(f"{path.stem}-{n}{path.suffix}")
        if not candidate.exists():
            return candidate
        n += 1


def iter_frame_paths(source, work_dir, fps, max_distance):
    source = Path(source)
    if source.is_dir():
        return sorted(p for p in source.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES)
    return extract_and_dedupe(source, work_dir, fps=fps, max_distance=max_distance)


def run_pipeline(source, regions_path, out_path, rarity=None, slot=None, work_dir=None, fps=2, max_distance=4, vocab=None, levels=None):
    vocab = vocab or Vocab()
    levels = LevelTemplates.load() if levels is None else levels
    regions = load_config(regions_path)
    out_path = unique_out_path(out_path)
    work_dir = Path(work_dir) if work_dir else out_path.parent / "_frames"

    frame_paths = iter_frame_paths(source, work_dir, fps, max_distance)

    valid, invalid = [], []
    for frame_path in frame_paths:
        image = Image.open(frame_path)
        card, conf, notes = parse_panel(image, regions, vocab, rarity=rarity, slot=slot,
                                        levels=levels)
        errs = validate_card(card, vocab)
        card_out = dict(card)
        card_out["conf"] = conf
        card_out["src"] = frame_path.name
        if errs or notes:
            invalid.append({"src": frame_path.name, "card": card_out, "errors": errs, "notes": notes})
        else:
            valid.append(card_out)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"cards": valid}, f, indent=2)

    # Only written when there's something to review: an empty "[]" file is a
    # standing invitation to run review_cards.py against nothing, and every
    # rarity/slot batch that came back completely clean would otherwise leave
    # one behind. review_path is still returned unconditionally so callers can
    # report where it *would* be without needing a second existence check.
    review_path = out_path.with_name(out_path.stem + "-review.json")
    if invalid:
        with open(review_path, "w", encoding="utf-8") as f:
            json.dump(invalid, f, indent=2)
    elif review_path.exists():
        review_path.unlink()

    return valid, invalid, out_path, review_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="a screen recording, or a directory of already-captured screenshots")
    parser.add_argument("--regions", default=str(Path(__file__).parent / "config" / "crop_regions.json"))
    parser.add_argument("--out", default="cards.json")
    parser.add_argument("--rarity", type=int, choices=[2, 3, 4, 5], default=None,
                         help="stamp every card from this run with this rarity — not visible on the detail panel")
    parser.add_argument("--slot", choices=["Sun", "Moon", "Star", "Sky", "Space"], default=None,
                         help="stamp every card from this run with this slot — also not visible/readable")
    parser.add_argument("--fps", type=float, default=2)
    parser.add_argument("--max-distance", type=int, default=4)
    args = parser.parse_args()

    valid, invalid, out_path, review_path = run_pipeline(
        args.source, args.regions, args.out,
        rarity=args.rarity, slot=args.slot, fps=args.fps, max_distance=args.max_distance,
    )
    print(f"{len(valid)} card(s) written to {out_path}")
    if invalid:
        print(f"{len(invalid)} card(s) need review — see {review_path}")
    else:
        print("0 card(s) need review")
