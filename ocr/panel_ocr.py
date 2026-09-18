"""Crops a calibrated set of regions out of one card-detail-panel screenshot,
OCRs each, and resolves the text against the game vocabulary (vocab.py).

Card detail panels don't show rarity, so `rarity` is left for the caller to fill
in (usually known from context: which screen the frame came from, or asked of
the user).

The main stat's magnitude IS read, into an optional `mainValue`. cardScore()
still only uses the stat's name, but no guide site publishes what a main stat is
worth at max level, so the panel is the only place that number exists — and it is
needed to total a stat against a build target (see docs/DATA-SOURCES.md). It is
optional on purpose: a card without it scores exactly as it did before, so an
unreadable value must never sink an otherwise good read.

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
    main_value   the main stat's magnitude, right of the label on the same row.
                 Calibrated from column/row profiles over 24 real frames rather
                 than one, so a Lv.25 "1080" and a Lv.0 "162" both clear the box.
    sub{1..4}_label / sub{1..4}_value   up to four substats

    space_main2_value                   a SPACE card shows two main stat rows —
                 flat ATK, then flat DEF (SLOT_INFO in src/data.js) — and the
                 second one pushes every substat down one row. So Space needs its
                 own row geometry: this value plus space_sub{1..4}_label/_value,
                 which parse_panel uses in place of the Heavens boxes whenever the
                 slot is Space. Read with the Heavens boxes instead, a Space card
                 files its flat DEF main as substat 1 and loses substat 4 off the
                 bottom of the panel entirely (Aug 2026 batch).

Slot isn't OCR'd either, for the same reason. Instead it comes from the
game's own Space/Sun/Moon/Star/Sky tab strip, where the selected tab is
highlighted in bright red — a colour check, not a text read, and therefore
immune to the font problem. Calibrate one `slot_tabs` box around the whole
strip; see detect_slot_from_tabs below.
"""
import os
import re
import subprocess
import tempfile

import numpy as np
import pytesseract
from PIL import Image

from plausibility import check_card, level_from_main_value
from vocab import MAIN_STAT_RESTRICTED_THRESHOLD

# Left-to-right order of the in-game tab strip. Deliberately NOT the SLOTS
# order from src/data.js (which starts at Sun) — this is screen order, and
# the two differing is exactly the kind of thing that silently mis-slots a
# whole batch, so it is spelled out here rather than derived.
TAB_ORDER = ["Space", "Sun", "Moon", "Star", "Sky"]

# Prefix of the Space-layout region names (space_sub1_label, ...). A config
# calibrated before those existed simply has none of them, and then Space cards
# read on the Heavens rows exactly as they used to — wrongly, but unchanged, so
# the fix arrives with the recalibration rather than half-applied.
SPACE_PREFIX = "space_"

_DIGIT_FIX = {"O": "0", "o": "0", "l": "1", "I": "1", "S": "5", "s": "5", "B": "8"}

_LABEL_CONFIG = "--psm 7"
_VALUE_CONFIG = "--psm 7 -c tessedit_char_whitelist=0123456789.,/%"

# Second opinion for a value box that read as ONE bare digit — see
# resolve_lone_digit. Same whitelist, but --psm 8 (single word) instead of the
# single-text-line mode, which is what goes wrong on a lone glyph.
_LONE_DIGIT_CONFIG = "--psm 8 -c tessedit_char_whitelist=0123456789.,/%"

# Every value box is read at each of these enlargements and the readings are
# scored by pick_value_reading. Native and 2x were the original pair; 4x was
# added in Sep 2026 for the decimal point in front of a "9" — see there for
# why 4x and not 3x.
_VALUE_SCALES = (1, 2, 4)

# Panel text is near-white on near-black; nothing legible sits between.
_BINARIZE_THRESHOLD = 150


def crop_fraction(image, box):
    w, h = image.size
    x0, y0, x1, y1 = box
    return image.crop((int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)))


def binarize(crop, threshold=_BINARIZE_THRESHOLD):
    """Hard black/white threshold, which rescues the small slanted level font.

    The level text is drawn with heavy anti-aliasing at ~37px tall; upscaling
    alone leaves Tesseract guessing at the soft edges and it read a real
    "Lv.25" as "128" (Aug 2026 batch). Flattening to two levels first makes
    the same crop read as "LV 25". Polarity is preserved rather than inverted,
    so this is safe on light-background renders (the synthetic test panels)
    as well as on the game's dark one.
    """
    a = np.asarray(crop.convert("L"))
    return Image.fromarray(np.where(a > threshold, 255, 0).astype(np.uint8))


def ocr_text(image, box, config, upscale=1, binary=False):
    """`upscale` enlarges the crop before OCR. Tesseract wants roughly 30px of
    cap height and degrades badly below that — the level field's small slanted
    "Lv.0" was read as "9" at native size but resolves correctly at 3x.

    `binary` applies binarize() first (see there), on the native-resolution
    crop, so it isn't fighting interpolated edge pixels.
    """
    crop = crop_fraction(image, box)
    if binary:
        crop = binarize(crop)
    if upscale != 1:
        crop = crop.resize((crop.width * upscale, crop.height * upscale), Image.LANCZOS)
    return pytesseract.image_to_string(crop, config=config).strip()


def ocr_batch(crops, config):
    """OCRs many crops in ONE tesseract process. Returns one text per crop, in order.

    Nearly all of a card's read time was process launches, not recognition: a
    card costs ~16 separate reads (labels, values at two scales — now three, the Space main),
    each spawning tesseract.exe at ~0.3s, so a card took 10 seconds and the
    walk — which never outruns the reader — crawled at that pace. Tesseract's
    list-file mode reads every image named in a text file as its own page under
    the same config, so this is the same crops under the same --psm and
    whitelist, and measured on real frames it returns the identical text — six
    crops in 0.4s where six launches took 1.8s.

    Pages come back separated by form feeds. A crop that reads as nothing still
    gets its separator, so positions line up. If the process fails or the page
    count is wrong the crops are read one at a time instead, so a tesseract
    build without list-file support degrades to the old speed, not to wrong
    text.
    """
    if not crops:
        return []
    cmd = pytesseract.pytesseract.tesseract_cmd
    try:
        with tempfile.TemporaryDirectory() as d:
            paths = []
            for i, crop in enumerate(crops):
                p = os.path.join(d, f"{i:02d}.png")
                crop.save(p)
                paths.append(p)
            lst = os.path.join(d, "list.txt")
            with open(lst, "w", encoding="utf-8") as f:
                f.write("\n".join(paths) + "\n")
            kw = {}
            if os.name == "nt":
                kw["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            # One recognition thread per process: several reader threads run
            # these side by side, and tesseract's own OpenMP fan-out on top of
            # that only oversubscribes the CPU.
            env = dict(os.environ, OMP_THREAD_LIMIT="1")
            out = subprocess.run([cmd, lst, "stdout", *config.split()], capture_output=True,
                                 encoding="utf-8", errors="replace", env=env, **kw)
        if out.returncode == 0:
            pages = out.stdout.split("\f")
            texts = [p.strip() for p in pages]
            if len(texts) >= len(crops):
                return texts[:len(crops)]
    except (OSError, ValueError):
        pass
    return [pytesseract.image_to_string(c, config=config).strip() for c in crops]


class _BatchReader:
    """Reads every label and every value box of one panel in two tesseract
    launches, then answers per-field lookups from the result.

    Which boxes to plan is decided from the slot the tab strip reported: the
    Heavens rows, the Space rows, or both when the strip could not be read. A
    field asked for that was not planned (the title later moved the card to the
    other layout — rare) is read on its own, so nothing is ever skipped, it just
    costs a launch.
    """

    def __init__(self, image, regions, slot):
        self.image, self.regions = image, regions
        heavens, space = slot != "Space", slot in ("Space", None)
        labels = ["title"]
        if slot not in ("Sun", "Space"):
            labels.append("main_label")
        values = ["main_value"]
        for prefix, on in (("", heavens), (SPACE_PREFIX, space)):
            if on:
                labels += [f"{prefix}sub{i}_label" for i in range(1, 5)]
                values += [f"{prefix}sub{i}_value" for i in range(1, 5)]
        if space:
            values.append(f"{SPACE_PREFIX}main2_value")
        self._label_keys = [k for k in labels if k in regions]
        self._value_keys = [k for k in values if k in regions]
        self._labels = self._values = None

    def label(self, key):
        if self._labels is None:
            crops = [crop_fraction(self.image, self.regions[k]) for k in self._label_keys]
            self._labels = dict(zip(self._label_keys, ocr_batch(crops, _LABEL_CONFIG)))
        if key in self._labels:
            return self._labels[key]
        return ocr_text(self.image, self.regions[key], _LABEL_CONFIG)

    def value(self, key):
        """The believed reading of a value box — one read per _VALUE_SCALES,
        scored by pick_value_reading exactly as ocr_value_text does."""
        if self._values is None:
            crops = []
            for k in self._value_keys:
                crops += _value_crops(self.image, self.regions[k])
            texts = ocr_batch(crops, _VALUE_CONFIG)
            n = len(_VALUE_SCALES)
            self._values = {k: pick_value_reading(*texts[n * i:n * (i + 1)])
                            for i, k in enumerate(self._value_keys)}
            # Every box that came back as a bare digit gets its second opinion
            # in ONE more launch — see resolve_lone_digit for why it is needed
            # and why it is only asked here.
            lone = [i for i, k in enumerate(self._value_keys) if is_lone_digit(self._values[k])]
            if lone:
                words = ocr_batch([c for i in lone for c in crops[n * i:n * (i + 1)]],
                                  _LONE_DIGIT_CONFIG)
                for j, i in enumerate(lone):
                    k = self._value_keys[i]
                    self._values[k] = resolve_lone_digit(self._values[k], words[n * j:n * (j + 1)])
        if key in self._values:
            return self._values[key]
        return ocr_value_text(self.image, self.regions[key])


def _marks(text):
    """How many of the two non-digit glyphs a value can carry — the decimal
    point and the percent sign — this reading actually resolved."""
    return ("." in text or "," in text) + ("%" in text)


def _digits(text):
    return sum(c.isdigit() for c in text)


def _value_crops(image, box):
    """The crop of one value box at every scale in _VALUE_SCALES, in that order."""
    c = crop_fraction(image, box)
    return [c if u == 1 else c.resize((c.width * u, c.height * u), Image.LANCZOS)
            for u in _VALUE_SCALES]


def pick_value_reading(*readings):
    """Which of several scales' readings of one value box to believe.

    `readings` are the same crop read at increasing enlargement — one per
    _VALUE_SCALES, native first. Split out from ocr_value_text so the rule can
    be tested against the real reading tuples it was derived from without
    running Tesseract.

    There is no single scale that wins outright. Tesseract drops the decimal
    point on these small italic digits, but not consistently in one direction:
    a real "1.5" read native-scale came back as "15" and a real "7.1%" as
    "71%", both fixed by 2x — while a real "2.2" that read correctly at native
    scale came back as "2" once upscaled. And a point sitting in front of a 9
    is lost at BOTH of those scales: the dot tucks under the 9's tail, so a
    real "1.9" read "19" at 1x and 2x on every one of 23 Space frames in the
    Sep 2026 runs, and a real "5.9" as "59". Every such miss is a 10x error
    that lands in review as out of range. Enlarging further separates them.

    Why 4x and not 3x: every value box of the 4124 frames still on disk (16180
    substat values, 4045 main values) was read at 1x, 2x, 3x and 4x and each
    subset scored against the 1x/2x pick. Adding 3x changed 10 values — nine
    "19" to a real "1.9", and one real Lv25 DEF "55" to a hallucinated "595"
    that the digit-count rule below then preferred. Adding 4x changed exactly
    the nine and nothing else, and it is also the scale that resolved "5.9",
    which 3x still read as "59". Main values were identical under every
    subset. Reading all four costs about twice the value pass of two for no
    further gain, so it is three scales, not four.

    Three tie-breaks, in order. The first two were measured over the 1783
    substat values in the Aug 2026 batches against readings verified by eye off
    the crops; the third scale over the 4124 frames above.

    1. The decimal point and the percent sign. Both are real glyphs in the
       image, so the reading that shows one the others lack saw more of what
       is there; one that dropped it is the one to distrust. A dropped point
       is a 10x error and a dropped "%" quietly turns a % substat into its
       flat sibling (ATK% into ATK), so both are silent when wrong. This is
       also what keeps the larger scale honest the other way: in the same
       sweep 3x read a real "7.1%" as "71%" and a real "4.9%" as nothing at
       all, and lost both to the smaller scales' fuller readings.
    2. Digit count, but ONLY between readings that carry no mark at all.
       The game pads flat ATK/DEF/HP to three digits with a DIM GREY leading
       zero ("032", "092", "055"), which sits close enough to the ink
       threshold that resampling decides whether Tesseract merges it into the
       next digit — a real "032" read as "32" at one scale and "4" at the
       other, and a real "092" the same way round. Between plain integers a
       shorter reading has dropped a digit. Once a decimal point is in play
       the count means nothing, because the point moves with it, and applying
       it there picks a hallucinated "2.35" over a real "2.5".
    3. The smallest scale still standing — native, which is where this field
       started before any of the above was tried against it.

    Thresholding the crop first, the way the level field does, was tried and
    is much worse here (189 wrong reads against 19): the decimal point is a
    small anti-aliased dot that falls below any threshold that clears the
    ghost zero.
    """
    readings = [r or "" for r in readings]
    best = max(_marks(r) for r in readings)
    cands = [r for r in readings if _marks(r) == best]
    if best == 0:
        most = max(_digits(r) for r in cands)
        cands = [r for r in cands if _digits(r) == most]
    return cands[0]


def is_lone_digit(text):
    """A reading that is exactly one digit and nothing else — no point, no
    percent sign. On this panel only a Speed value ever prints that way."""
    return re.fullmatch(r"\d", (text or "").strip()) is not None


def resolve_lone_digit(pick, word_readings):
    """Second opinion on a value box whose believed reading is one bare digit.

    Tesseract's single-line mode (--psm 7, _VALUE_CONFIG) is unreliable on a
    lone glyph: it has one blob to estimate the line's baseline and x-height
    from, and gets it wrong often enough that a real Speed "2" — the one
    level-0 value the panel prints without a point or a percent sign — came
    back as "4". Measured on the Sep 2026 live-grab run: every Speed 2 in rows
    1 and 4 (whose value boxes are ~42px tall against ~35px for rows 2 and 3)
    read ("4", "4", "2") at 1x/2x/4x and the smallest-scale tie-break picked
    the 4 — 64 of the run's 84 review entries, plus one Lv25 card that went
    into the output as a 4 unflagged, since only level-0 values are checked
    against the roll tiers. The committed boxes did the same on 5 of 16, so
    the recalibration exposed it rather than caused it; no scale is safe on
    its own (2x and 4x each read a lone 2 as 4 on other frames).

    Single-word mode (--psm 8) reads the same crops as "2" every time — but it
    is far worse on everything else (1114 values broken against 82 fixed over
    1274 frames: it hallucinates a leading 4, reads 3 as 8, pads flats to
    "032."), so it is asked ONLY when the psm 7 pick is already a bare digit,
    and believed ONLY when it answers with a bare digit too. On a real lone
    "4" it reads nothing at all (3 of 3 Lv25 Speed 4s), so the original
    reading stands. Over the 124 lone-digit picks in that sample this changed
    81 values, all of them a 4 that was a 2 on the crop, and nothing else.
    """
    second = pick_value_reading(*word_readings)
    return second if is_lone_digit(second) else pick


def ocr_value_text(image, box):
    """Reads a substat value box at every scale in _VALUE_SCALES — see
    pick_value_reading for which reading is believed, and why. A bare-digit
    reading gets a second opinion (resolve_lone_digit)."""
    crops = _value_crops(image, box)
    pick = pick_value_reading(*ocr_batch(crops, _VALUE_CONFIG))
    if is_lone_digit(pick):
        pick = resolve_lone_digit(pick, ocr_batch(crops, _LONE_DIGIT_CONFIG))
    return pick


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


# "Lv" followed by the number, tolerating the prefix's usual misreads: the L
# comes back as 1/l/i/| about as often as itself, and the v occasionally as y.
# Anchoring on the prefix is what makes the digits unambiguous — see parse_level.
_LEVEL_RE = re.compile(r"[li1|!]?\s*[vy]\s*[.,:;]?\s*(\d+)", re.I)


def parse_level(text):
    """Parses e.g. "Lv.25" / "Lv.0" / "Lv.25/25". Returns (level, anchored).

    Read with the plain label config, NOT the digits-only whitelist: forcing
    Tesseract to emit only digits over the "Lv." prefix makes it mangle those
    letters into a spurious digit (a real misread — "Lv.0" came back as "9"
    against a real screenshot, silently turning every level-0 card into a
    level-9 one).

    But letting the letters through and taking the first integer isn't safe
    either, because the prefix itself can *become* a leading digit: a real
    "Lv.25" read as "128" (Aug 2026 batch) — the L+v collapsing into a 1. So
    match the prefix explicitly and take the digits that follow it. That also
    gets "Lv.12/25" right, where the first number is the level and the second
    is the cap.

    `anchored` says whether the prefix was found. When it wasn't, the digits
    could be anything at all — including a mangled prefix being read as the
    level — so the caller must treat the value as unverified rather than
    trusting it. The fallback takes the LAST run of digits, not the first,
    because in this layout the number always trails the prefix.
    """
    t = text or ""
    for candidate in (t, "".join(_DIGIT_FIX.get(c, c) for c in t)):
        m = _LEVEL_RE.search(candidate)
        if m:
            return int(m.group(1)), True
    m = re.findall(r"\d+", t)
    return (int(m[-1]), False) if m else (None, False)


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


def detect_grid_cursor(image, box, min_pixels=300, min_share=0.75):
    """Which column of the card grid holds the selected card, by colour.

    The selected tile wears a bright saturated red frame (RGB ~249/34/3) and
    nothing else in the grid is that colour — the Sun and Space tabs' backdrop is
    a dark red halftone that fails the R > 200 test. Two columns, so the answer
    is which half of the calibrated `grid` box holds the red. Measured over 127
    real frames across all five tabs: 780-3200 red pixels per frame, never none,
    and the columns read back alternate exactly the way the cards were tapped.

    Returns (column, row_fraction): column 0 or 1, and how far down the visible
    grid the frame sits (0 top, 1 bottom), or (None, None) when there is no clear
    frame — the grid is not on screen, or the red is split across both halves
    (a badge or popup), in which case guessing would misplace the whole walk.
    autowalk.py uses this to know where the cursor really is; it is a read, not
    an input, so it lives with the other colour checks here.
    """
    crop = crop_fraction(image, box)
    a = np.asarray(crop.convert("RGB")).astype(int)
    R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    red = (R > 200) & (G < 90) & (B < 90)
    total = int(red.sum())
    if total < min_pixels:
        return None, None
    half = a.shape[1] // 2
    left = int(red[:, :half].sum())
    share = max(left, total - left) / total
    if share < min_share:
        return None, None
    rows = np.where(red.any(axis=1))[0]
    return (0 if left > total - left else 1), float(np.median(rows)) / max(1, a.shape[0] - 1)


def parse_panel(image, regions, vocab, rarity=None, slot=None, levels=None):
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

    slot_conf = 1.0 if slot is not None else 0.0
    if "slot_tabs" in regions:
        detected, detect_conf = detect_slot_from_tabs(image, regions["slot_tabs"])
        if detected is None:
            if slot is not None:
                notes.append(f'could not read the slot tab strip; falling back to slot="{slot}"')
        elif slot is not None and detected != slot:
            notes.append(f'slot tab strip reads "{detected}" but slot="{slot}" was passed in')
            slot, slot_conf = detected, detect_conf
        else:
            slot, slot_conf = detected, detect_conf

    # Two tesseract launches for the whole panel instead of one per box — see
    # ocr_batch. Planned from the slot the strip gave; the title read below is
    # the first thing to use it.
    read = _BatchReader(image, regions, slot)
    title_text = read.label("title")
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
        # The set didn't resolve — norm_set only ever returns names from the two
        # tables, so this branch means "unreadable title", not "unknown category".
        # Keep whatever slot we have: it came from the tab strip (or the caller),
        # which is independent evidence and stays good when the title is mush.
        # Discarding it here was turning every Space card with an unresolved
        # paired title into an unslotted one (Aug 2026 batch), and the slot is
        # what selects the row geometry the substats are then read on.
        conf["slot"] = slot_conf

    # Space cards have a second main stat row, which shifts every substat down one
    # row — see the module docstring. The layout can only be picked once the slot
    # is known, which is why this sits below the block above and not beside the
    # region lookups it governs.
    space_layout = slot == "Space" and f"{SPACE_PREFIX}sub1_label" in regions
    prefix = SPACE_PREFIX if space_layout else ""

    # The level is matched against known renders first and only OCR'd if that
    # fails. It is not a fallback ordering for convenience: Tesseract has never
    # been able to read this field reliably — nine pixels of capture noise turns
    # "Lv.0" into "9" — while the UI renders a given level identically every
    # time, which makes a template lookup exact. levels.py has the measurements.
    level_crop = binarize(crop_fraction(image, regions["level"]))
    level = anchored = None
    if levels is not None and levels.usable_for(level_crop):
        matched, distance, why = levels.classify(level_crop)
        if matched is not None:
            level, anchored = matched, True
            conf["level"] = 1.0
        else:
            notes.append(f"level not recognised: {why}")

    def level_by_ocr():
        # binary=True: this field cannot be read from the anti-aliased original
        # at all — see binarize() and parse_level().
        level_text = ocr_text(image, regions["level"], _LABEL_CONFIG, upscale=3, binary=True)
        lv, anch = parse_level(level_text)
        conf["level"] = 1.0 if anch else (0.4 if lv is not None else 0.0)
        if lv is None:
            notes.append(f'could not parse a level from "{level_text}"')
        elif not anch:
            # digits with no readable "Lv." in front of them: the prefix may itself
            # have been read as part of the number, so this can be plausible and
            # still wrong. Always send it to review rather than trusting it.
            notes.append(f'read level {lv} from "{level_text}" without a readable "Lv." prefix')
        # An anchored OCR read is NOT flagged just because no template covers
        # that render yet. Templates are an upgrade to this field, not a new
        # gate on it — flagging here would send every card to review on a
        # machine that has not built them, which is how it works today.
        return lv, anch
    # When no template matched, the level is resolved further down, once the main
    # stat's value has been read: that value is a function of level alone, so it
    # names the level exactly where Tesseract only guesses at it. OCR is the last
    # resort, not the second.

    if slot == "Sun":
        main, main_conf = "HP", 1.0
    elif slot == "Space":
        main, main_conf = "ATK + DEF", 1.0
    elif "main_label" in regions:
        main_text = read.label("main_label")
        # Moon/Star/Sky only ever have a %-based main (SLOT_INFO in src/data.js), so a
        # bare "Attack"/"Defense"/"HP" main always means the % variant there.
        # Restricted to this slot's legal mains: unrestricted, "HP Recovery" clipped
        # to "_P Recovery" fuzzy-matches the substat "SP Recovery" better than it
        # matches its own (differently-spelled, main-only) canonical name, and
        # SP Recovery isn't even legal outside Sky — see norm_stat's docstring.
        legal_mains = vocab.slot_info[slot]["mains"] if slot in vocab.slot_info else None
        main, main_conf = vocab.norm_stat(main_text, value_has_percent=True, restrict_to=legal_mains)
        if main is None:
            notes.append(f'could not resolve main stat from "{main_text}"')
        elif main_conf < MAIN_STAT_RESTRICTED_THRESHOLD / 100.0:
            # Only norm_stat's unique-fragment last resort scores this low, and it
            # fires on labels caught mid-animation. The answer is the one legal
            # main stat the fragment can belong to, but it came from a partial
            # read — note it so the card lands in the review file with the value
            # filled in, rather than being silently accepted or silently dropped.
            notes.append(
                f'main stat "{main}" came from the partial label "{main_text}"; confirm against the screenshot'
            )
    else:
        main, main_conf = None, 0.0
    conf["main"] = main_conf

    subs = []
    sub_confs = []
    for i in range(1, 5):
        label_key, value_key = f"{prefix}sub{i}_label", f"{prefix}sub{i}_value"
        if label_key not in regions or value_key not in regions:
            continue
        label_text = strip_trailing_number(read.label(label_key))
        value_text = read.value(value_key)
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

    # The main stat's magnitude is not published by any guide site, so reading it off
    # the panel is the only way the planner can total a stat against a build target.
    # It is optional on purpose: a card without it still scores exactly as before, so
    # an unreadable value must never sink the card.
    main_value = None
    if "main_value" in regions:
        # Same dual-scale read as the substat values: a percentage main ("21.6%") loses
        # its decimal point at one scale or the other, and which one varies by glyph.
        mv_text = read.value("main_value")
        main_value = parse_number(mv_text)
        if main_value is None:
            notes.append(f'could not parse a main stat value from "{mv_text}"')
        else:
            conf["main_value"] = 1.0

    # A Space main is "ATK + DEF" — two printed numbers, one per row — and on every
    # Space frame of the Aug 2026 batches the two were identical, so `mainValue`
    # records the shared per-stat magnitude rather than a sum or a pair. Reading
    # both is what makes that claim checkable per card: if they disagree, one of
    # them is a misread and there is no way to tell which, so the value is dropped
    # rather than guessed at.
    if space_layout and f"{SPACE_PREFIX}main2_value" in regions:
        m2_text = read.value(f"{SPACE_PREFIX}main2_value")
        main2_value = parse_number(m2_text)
        if main2_value is None:
            notes.append(f'could not parse the second main stat value from "{m2_text}"')
        elif main_value is not None and main2_value != main_value:
            notes.append(f"Space main stat rows disagree: ATK {main_value} vs DEF {main2_value}")
            main_value = None
            conf["main_value"] = 0.0

    if level is None:
        # The main value is the same on every card of that stat at that level, so
        # when it sits exactly on the 5★ curve it names the level with no OCR at all.
        # A misread value is nowhere near the curve (a dropped digit or point is a
        # factor of ten), which is what makes this safe where reading the digits is
        # not. It still goes to review — the frame may be a render worth teaching to
        # the level templates — but with the right value filled in, not garbage.
        inferred = level_from_main_value(vocab, main, main_value, rarity) if main_value is not None else None
        if inferred is not None:
            level = inferred
            conf["level"] = 0.9
            notes.append(f"level {inferred} taken from the main stat value {main_value:g} "
                         f"(no level template matched); confirm and it will be learned")
        else:
            level, _ = level_by_ocr()

    card = {"slot": slot, "set": set_name, "rarity": rarity, "level": level, "main": main, "subs": subs}
    if main_value is not None:
        card["mainValue"] = main_value
    # Cross-checks against the measured tables — a level-0 substat off its five
    # tiers, a main value that is not this level's, a substat count the level
    # rules out. Notes only; see plausibility.py for why never a repair.
    notes.extend(check_card(card, vocab))
    return card, conf, notes
