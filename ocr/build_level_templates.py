"""Bootstraps config/level_templates.json from frames whose level is known.

    python build_level_templates.py --cards "cards*.json" \
        --shots "C:\\Games\\Steam\\userdata\\...\\screenshots"

Reads every card in the given cards.json files, finds the frame it came from
under --shots by its `src` filename, crops the level field and files that render
under the card's recorded level. A level is only accepted once every frame
claiming it agrees pixel for pixel — the recorded levels are themselves OCR
output, and a level whose frames disagree is exactly the case where some of
those reads were wrong. See levels.py for why this works at all.

Steam keeps a `thumbnails/` directory of 10x7 copies under the *same filenames*
as the real screenshots, so those are skipped explicitly. Picking one up instead
of the real frame silently produces a 7x10 crop, which is the kind of thing that
looks like an OCR bug for an hour.

Levels this cannot bootstrap stay unknown and go to review, where correcting one
teaches it (review_cards.py). Two runs of the game's own level filter would seed
the common ones faster than any amount of cleverness here.
"""
import argparse
import glob
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from calibrate import load_config  # noqa: E402
from levels import LevelTemplates, _bits  # noqa: E402
from panel_ocr import binarize, crop_fraction  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def read_labels(patterns):
    """{frame filename: level} from cards.json files, skipping review files."""
    labels = {}
    for pattern in patterns:
        for path in glob.glob(pattern):
            if "review" in os.path.basename(path):
                continue
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            cards = raw.get("cards", raw) if isinstance(raw, dict) else raw
            for card in cards:
                if card.get("src") and card.get("level") is not None:
                    labels[card["src"]] = card["level"]
    return labels


def index_frames(shot_dirs, wanted):
    found = {}
    for root_dir in shot_dirs:
        for root, _, files in os.walk(root_dir):
            if "thumbnail" in root.lower():
                continue
            for name in files:
                if name in wanted and name not in found:
                    found[name] = os.path.join(root, name)
    return found


def build(labels, frames, box, existing=None):
    """Returns (templates, report). A level is kept only when every frame
    claiming it renders identically."""
    renders = defaultdict(list)
    for name, level in labels.items():
        path = frames.get(name)
        if not path:
            continue
        crop = binarize(crop_fraction(Image.open(path), box))
        renders[level].append((name, _bits(crop), crop))

    templates = existing or LevelTemplates()
    report = []
    for level in sorted(renders):
        entries = renders[level]
        first = entries[0][1]
        disagree = [n for n, b, _ in entries if b.shape != first.shape or np.any(b ^ first)]
        if disagree:
            report.append((level, len(entries), "skipped", f"{len(disagree)} frame(s) disagree"))
            continue
        templates.learn(entries[0][2], level)
        report.append((level, len(entries), "learned", ""))
    return templates, report


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cards", nargs="+", default=[str(HERE / "cards*.json")],
                        help="cards.json files (globs allowed) whose levels are trusted")
    parser.add_argument("--shots", nargs="+", required=True,
                        help="directories to search recursively for the source frames")
    parser.add_argument("--regions", default=str(HERE / "config" / "crop_regions.json"))
    parser.add_argument("--out", default=None, help="default: config/level_templates.json")
    parser.add_argument("--keep-existing", action="store_true",
                        help="add to the current templates instead of starting fresh")
    args = parser.parse_args(argv)

    labels = read_labels(args.cards)
    print(f"{len(labels)} labelled frame(s) in the cards files")
    frames = index_frames(args.shots, set(labels))
    print(f"{len(frames)} of them found under {', '.join(args.shots)}")
    if not frames:
        parser.error("none of the source frames could be found — check --shots")

    box = load_config(args.regions)["level"]
    existing = LevelTemplates.load(args.out) if args.keep_existing and args.out else \
        (LevelTemplates.load() if args.keep_existing else None)
    templates, report = build(labels, frames, box, existing)

    print(f"\n{'level':>6}  {'frames':>6}  result")
    for level, n, result, why in report:
        print(f"{level:>6}  {n:>6}  {result}{'  — ' + why if why else ''}")

    if not len(templates):
        parser.error("no level could be bootstrapped; nothing written")
    path = templates.save(args.out) if args.out else templates.save()
    print(f"\n{len(templates)} template(s) written to {path}: levels {templates.known}")
    print("Anything else stays unknown and goes to review, where correcting it teaches it.")


if __name__ == "__main__":
    main()
