"""Crops a calibrated set of regions out of one card-detail-panel screenshot,
OCRs each, and resolves the text against the game vocabulary (vocab.py).

Card detail panels don't show rarity, and the app's own cardScore() never
uses the main stat's raw magnitude — only its name (see docs/SCHEMA.md,
src/logic.js cardScore()) — so this deliberately never tries to OCR a main
stat's number, and leaves `rarity` for the caller to fill in (usually known
from context: which screen the frame came from, or asked of the user).

Region layout (all boxes are [x0, y0, x1, y1] as fractions 0-1 of image
width/height, produced by calibrate.py against one real screenshot):
    title        the set's name. The big stylized card title (e.g. "Futility:
                 Star") turned out to use a jagged, staggered comic-book font
                 that Tesseract cannot read under any config tried against a
                 real screenshot (Aug 2026) — but the SAME name also appears
                 in plain readable font inside the "Set Effect" box, wrapped
                 in brackets with a small icon glyph (e.g. "[Futility]"),
                 which is what this field should be calibrated against instead.
    level        "Lv.25" / "Lv.0" / "Lv.25/25"
    main_label   the main stat's name (skipped entirely for Sun/Space,
                 whose main stat is fixed — see SLOT_INFO in src/data.js)
    sub{1..4}_label / sub{1..4}_value   up to four substats

Slot isn't OCR'd either, for the same reason. Instead it comes from the
game's own Space/Sun/Moon/Star/Sky tab strip, where the selected tab is
highlighted in bright red — a colour check, not a text read, and therefore
immune to the font problem. Calibrate one `slot_tabs` box around the whole
strip; see detect_slot_from_tabs below.
"""
import re

import numpy as np
import pytesseract
from PIL import Image

# Left-to-right order of the in-game tab strip. Deliberately NOT the SLOTS
# order from src/data.js (which starts at Sun) — this is screen order, and
# the two differing is exactly the kind of thing that silently mis-slots a
# whole batch, so it is spelled out here rather than derived.
TAB_ORDER = ["Space", "Sun", "Moon", "Star", "Sky"]

_DIGIT_FIX = {"O": "0", "o": "0", "l": "1", "I": "1", "S": "5", "s": "5", "B": "8"}

_LABEL_CONFIG = "--psm 7"
_VALUE_CONFIG = "--psm 7 -c tessedit_char_whitelist=0123456789.,/%"


def crop_fraction(image, box):
    w, h = image.size
    x0, y0, x1, y1 = box
    return image.crop((int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)))


def ocr_text(image, box, config, upscale=1):
    """`upscale` enlarges the crop before OCR. Tesseract wants roughly 30px of
    cap height and degrades badly below that — the level field's small slanted
    "Lv.0" was read as "9" at native size but resolves correctly at 3x."""
    crop = crop_fraction(image, box)
    if upscale != 1:
        crop = crop.resize((crop.width * upscale, crop.height * upscale), Image.LANCZOS)
    return pytesseract.image_to_string(crop, config=config).strip()


def parse_number(text):
    """First numeric token in `text`, retrying with common OCR digit-confusion
    fixes (O/o->0, l/I->1, S/s->5, B->8) only if the naive parse finds nothing —
    so clean OCR output is never needlessly mangled by the fallback."""
    if not text:
        return None
    t = str(text).strip().replace(",", ".")
    m = re.search(r"[-+]?\d*\.?\d+", t)
    if m:
        try:
            return float(m.group())
        except ValueError:
            pass
    fixed = "".join(_DIGIT_FIX.get(c, c) for c in t)
    m = re.search(r"[-+]?\d*\.?\d+", fixed)
    if m:
        try:
            return float(m.group())
        except ValueError:
            pass
    return None


def parse_level(text):
    """First integer in e.g. "Lv.25" / "Lv.0" / "Lv.25/25".

    Read with the plain label config, NOT the digits-only whitelist: forcing
    Tesseract to emit only digits over the "Lv." prefix makes it mangle those
    letters into a spurious digit (a real misread — "Lv.0" came back as "9"
    against a real screenshot, silently turning every level-0 card into a
    level-9 one). Letting the letters through and pulling the digits out here
    is both simpler and correct.
    """
    t = text or ""
    m = re.search(r"\d+", t)
    if m:
        return int(m.group())
    fixed = "".join(_DIGIT_FIX.get(c, c) for c in t)
    m = re.search(r"\d+", fixed)
    return int(m.group()) if m else None


def strip_trailing_number(text):
    """Drops a trailing numeric token from a stat label, so a label box drawn
    slightly too wide (catching the value beside it) still resolves. Safe
    because no stat name in SUBSTATS ends in a digit."""
    return re.sub(r"[\s.]*[\d][\d.,]*\s*%?\s*$", "", text or "").strip()


def detect_slot_from_tabs(image, box, min_fraction=0.15, min_ratio=1.8):
    """Which slot tab is highlighted, by colour rather than OCR.

    Splits the calibrated tab-strip `box` into five equal columns (one per
    TAB_ORDER entry) and scores each by its fraction of bright saturated red
    pixels. The page background behind the strip is itself a dark red, so
    "reddish" alone is not enough to discriminate — the test requires a high
    red channel AND a wide margin over green/blue, which the dark backdrop
    fails. Measured on a real screenshot (Aug 2026): selected tab ~0.37,
    every other column <= 0.10.

    Returns (slot, confidence). Returns (None, 0.0) when no column is clearly
    red (wrong screen, strip occluded) or when the best two are too close to
    call — a wrong slot is far worse than an unresolved one, since it would
    silently mis-file the whole card.
    """
    crop = crop_fraction(image, box)
    a = np.asarray(crop.convert("RGB")).astype(int)
    R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    bright_red = (R > 140) & (R - np.maximum(G, B) > 70)

    fracs = [bright_red[:, c[0]:c[-1] + 1].mean() if len(c) else 0.0
             for c in np.array_split(np.arange(a.shape[1]), len(TAB_ORDER))]

    order = sorted(range(len(fracs)), key=lambda i: fracs[i], reverse=True)
    best, second = order[0], order[1]
    if fracs[best] < min_fraction:
        return None, 0.0
    # a runner-up close behind usually means red bleeding across a column
    # boundary (the tabs are slanted parallelograms), not a real second match
    if fracs[second] > 0 and fracs[best] / fracs[second] < min_ratio:
        return None, 0.0
    ratio = fracs[best] / fracs[second] if fracs[second] > 0 else float("inf")
    return TAB_ORDER[best], min(1.0, ratio / 4.0)


def parse_panel(image, regions, vocab, rarity=None, slot=None):
    """Returns (card, conf, notes).

    `card` uses the same shape docs/SCHEMA.md describes, minus `equipped`
    (not visible on this screen either). `conf` is a 0-1 score per field,
    matching the schema v2 `conf` object. `notes` lists anything that
    couldn't be resolved, for the review dialog.

    `rarity` is never read off the panel — see the module docstring — so it
    stays the caller's responsibility. `slot` is detected from the tab strip
    when a `slot_tabs` region is calibrated, and the `slot` argument then
    acts as a fallback for frames where that detection is inconclusive.
    Per-image evidence beats a batch-wide assumption, so detection wins when
    the two disagree, but the disagreement is always noted (sending the card
    to review) rather than silently resolved.
    """
    notes = []
    conf = {}

    if "slot_tabs" in regions:
        detected, detect_conf = detect_slot_from_tabs(image, regions["slot_tabs"])
        if detected is None:
            if slot is not None:
                notes.append(f'could not read the slot tab strip; falling back to slot="{slot}"')
        elif slot is not None and detected != slot:
            notes.append(f'slot tab strip reads "{detected}" but slot="{slot}" was passed in')
            slot = detected
        else:
            slot = detected

    title_text = ocr_text(image, regions["title"], _LABEL_CONFIG)
    set_name, set_conf = vocab.norm_set(title_text)
    conf["set"] = set_conf
    if set_name is None:
        notes.append(f'could not resolve set from title "{title_text}"')

    category = vocab.slot_for_set(set_name) if set_name else None
    if category == "Space":
        if slot is not None and slot != "Space":
            notes.append(f'"{set_name}" is a Space set but slot="{slot}" was passed in')
        slot = "Space"
        conf["slot"] = set_conf
    elif category == "Heavens":
        if slot is None:
            notes.append(f'"{set_name}" is a Heavens set but no slot was given')
            conf["slot"] = 0.0
        elif slot == "Space":
            notes.append(f'"{set_name}" is a Heavens set but slot="Space" was passed in')
            conf["slot"] = 0.0
        else:
            conf["slot"] = 1.0
    else:
        slot = None
        conf["slot"] = 0.0

    level_text = ocr_text(image, regions["level"], _LABEL_CONFIG, upscale=3)  # see parse_level
    level = parse_level(level_text)
    conf["level"] = 1.0 if level is not None else 0.0
    if level is None:
        notes.append(f'could not parse a level from "{level_text}"')

    if slot == "Sun":
        main, main_conf = "HP", 1.0
    elif slot == "Space":
        main, main_conf = "ATK + DEF", 1.0
    elif "main_label" in regions:
        main_text = ocr_text(image, regions["main_label"], _LABEL_CONFIG)
        # Moon/Star/Sky only ever have a %-based main (SLOT_INFO in src/data.js), so a
        # bare "Attack"/"Defense"/"HP" main always means the % variant there.
        main, main_conf = vocab.norm_stat(main_text, value_has_percent=True)
        if main is None:
            notes.append(f'could not resolve main stat from "{main_text}"')
    else:
        main, main_conf = None, 0.0
    conf["main"] = main_conf

    subs = []
    sub_confs = []
    for i in range(1, 5):
        label_key, value_key = f"sub{i}_label", f"sub{i}_value"
        if label_key not in regions or value_key not in regions:
            continue
        label_text = strip_trailing_number(ocr_text(image, regions[label_key], _LABEL_CONFIG))
        value_text = ocr_text(image, regions[value_key], _VALUE_CONFIG)
        # ATK/DEF/HP substats share one label with their %-of-stat sibling — only the
        # value's trailing '%' tells the two apart (see vocab.py's norm_stat).
        stat, stat_conf = vocab.norm_stat(label_text, value_has_percent="%" in value_text)
        value = parse_number(value_text)
        if stat is None and value is None:
            continue  # nothing legible in either box — this card has fewer than 4
            # substats, and this slot is genuinely blank. A blank region isn't
            # guaranteed to OCR as an empty string (stray marks/anti-aliasing can
            # read as noise text), so "both boxes failed" is the real signal, not
            # "label box was literally empty".
        if stat is None:
            notes.append(f'could not resolve substat {i} from "{label_text}"')
        if value is None:
            notes.append(f'could not parse a value for substat {i} from "{value_text}"')
        if stat is not None and value is not None:
            subs.append({"stat": stat, "value": value})
            sub_confs.append(min(stat_conf, 1.0))
    conf["subs"] = sub_confs

    card = {"slot": slot, "set": set_name, "rarity": rarity, "level": level, "main": main, "subs": subs}
    return card, conf, notes
