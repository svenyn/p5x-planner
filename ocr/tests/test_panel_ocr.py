"""No real screenshots exist yet (calibrate.py hasn't been run against one),
so this proves the crop -> OCR -> vocab-resolution chain works mechanically
by rendering a synthetic panel with PIL and feeding it back through
parse_panel() — the same role test/scale.js's synthetic 4000-card inventory
plays for the JS optimiser."""
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont

from panel_ocr import parse_level, parse_panel

W, H = 900, 700
FONT_PATH = r"C:\Windows\Fonts\arial.ttf"


def _fraction_box(px_box):
    x0, y0, x1, y1 = px_box
    return (x0 / W, y0 / H, x1 / W, y1 / H)


def _build_panel(title, level_text, main_label, subs):
    """subs: list of (label, value_text). Returns (image, regions_in_fractions)."""
    if not Path(FONT_PATH).exists():
        pytest.skip("Arial not found — this test needs a real TTF for legible synthetic OCR")
    font = ImageFont.truetype(FONT_PATH, 28)

    img = Image.new("RGB", (W, H), "white")
    draw = ImageDraw.Draw(img)
    px_regions = {}

    def place(key, y, text):
        box = (40, y, W - 40, y + 40)
        draw.text((box[0] + 5, box[1] + 3), text, font=font, fill="black")
        px_regions[key] = box

    place("title", 20, title)
    place("level", 70, level_text)
    place("main_label", 120, main_label)
    y = 180
    for i, (label, value) in enumerate(subs, start=1):
        place(f"sub{i}_label", y, label)
        place(f"sub{i}_value", y + 40, value)
        y += 90

    regions = {k: _fraction_box(v) for k, v in px_regions.items()}
    return img, regions


def test_heavens_card_round_trip(vocab):
    img, regions = _build_panel(
        # the real title font can't be OCR'd (confirmed against a real screenshot,
        # Aug 2026) — this is the Set Effect panel's readable text instead, and
        # slot is passed in rather than parsed from anywhere on the panel
        title="[Futility]",
        level_text="Lv.25",
        main_label="Crit Rate",
        subs=[
            ("Damage Mult.+", "2.1%"),   # real in-game label w/ trailing punctuation
            ("HP", "2.9%"),
            ("Defense", "4.1%"),
            ("Pierce Rate", "3.9%"),      # real in-game label, not "Resistance Pierce"
        ],
    )
    card, conf, notes = parse_panel(img, regions, vocab, rarity=5, slot="Star")

    assert notes == []
    assert card["slot"] == "Star"
    assert card["set"] == "Futility"
    assert card["level"] == 25
    assert card["main"] == "Crit Rate"
    stats = {s["stat"] for s in card["subs"]}
    # "HP" and "Defense" carry a % value here, so they must resolve to their %
    # variant, not the flat one — see vocab.py's norm_stat / FLAT_TO_PERCENT.
    assert stats == {"Damage Multiplier", "HP%", "DEF%", "Resistance Pierce"}
    values = {s["stat"]: s["value"] for s in card["subs"]}
    assert values["Resistance Pierce"] == pytest.approx(3.9)
    assert conf["set"] == 1.0
    assert conf["slot"] == 1.0
    assert all(c == 1.0 for c in conf["subs"])


def test_ocr_decimal_point_miss_is_caught_by_validation_not_ocr(vocab):
    """A '1' immediately followed by a small decimal point is a known hard case —
    Tesseract read a real "1.4%" render of this as "14%" during development. Rather
    than chase perfect OCR fidelity (unwinnable in general — see docs/SCHEMA.md's
    "decimal points at small font sizes" caveat), the pipeline relies on
    validate_card's 5x-maxRoll sanity bound to catch it. Prove that safety net
    actually fires on this exact real misread rather than assuming it would."""
    from validate import validate_card

    card = {
        "slot": "Star", "set": "Futility", "rarity": 5, "level": 25, "main": "Crit Rate",
        "subs": [
            {"stat": "Damage Multiplier", "value": 2.1},
            {"stat": "HP%", "value": 2.9},
            {"stat": "DEF%", "value": 4.1},
            {"stat": "Resistance Pierce", "value": 14.0},  # the misread, not 1.4
        ],
    }
    errs = validate_card(card, vocab)
    assert any("Resistance Pierce" in e and "out of range" in e for e in errs)


def test_space_card_forces_fixed_main_without_ocr(vocab):
    img, regions = _build_panel(
        title="[Perseverance]",
        level_text="Lv.0",
        main_label="should be ignored — Space main is fixed",
        subs=[
            ("Damage Mult.+", "3.1%"),
            ("Speed", "2.5"),
            ("SP Recovery", "11.2%"),
        ],
    )
    # no slot passed at all — Space is unambiguous from the set name alone
    card, conf, notes = parse_panel(img, regions, vocab, rarity=5)

    assert card["slot"] == "Space"
    assert card["set"] == "Perseverance"
    assert card["main"] == "ATK + DEF"
    assert conf["main"] == 1.0  # forced, not OCR'd
    assert len(card["subs"]) == 3


def test_fewer_than_four_substats_leaves_remaining_slots_empty(vocab):
    img, regions = _build_panel(
        title="[Sorrow]",
        level_text="Lv.0",
        main_label="HP",
        subs=[("Pierce Rate", "2.1%"), ("Defense", "4.1%")],
    )
    card, conf, notes = parse_panel(img, regions, vocab, rarity=5, slot="Sky")
    assert len(card["subs"]) == 2


@pytest.mark.parametrize("text,expected", [
    ("Lv.25", (25, True)),
    ("Lv.0", (0, True)),
    # what Tesseract actually returns for the two real cases, once the crop is
    # binarized (Aug 2026 batch): the period is dropped and case wanders
    ("LV 25", (25, True)),
    ("v0", (0, True)),
    # the cap suffix, if the panel ever shows one: the LEVEL is the first
    # number after the prefix, not the last number in the string
    ("Lv.12/25", (12, True)),
    ("Lv.25/25", (25, True)),
    # the misread that started this: "Lv.25" clipped by a too-narrow crop, the
    # L+v collapsing into a leading 1. No prefix survives, so it must come back
    # unanchored — 128 then fails validate_card's range check, whereas silently
    # returning the leading "1" would have been an in-range, plausible lie.
    ("128", (128, False)),
    ("i289", (289, False)),
    ("", (None, False)),
    ("Lv.", (None, False)),
])
def test_parse_level_anchors_on_the_prefix(text, expected):
    assert parse_level(text) == expected


def test_parse_level_never_reads_a_mangled_prefix_as_the_level():
    """The dangerous failure mode is not a wild number — validate_card catches
    those — it's a small in-range one. If the "L" of "Lv.5" is read as a "1",
    taking the first integer yields 1: a perfectly legal level, silently wrong.
    Anchoring on the prefix has to consume that digit rather than return it."""
    assert parse_level("1v.5") == (5, True)
    assert parse_level("lv.5") == (5, True)
    assert parse_level("|v.5") == (5, True)


def test_unanchored_level_is_flagged_for_review(vocab):
    """A level read with no recognisable "Lv." in front of it may be plausible
    and still wrong, so it must reach the review file. pipeline.py routes on
    notes, not on conf, so the note is what actually does the routing."""
    img, regions = _build_panel(
        title="[Futility]", level_text="17", main_label="Crit Rate",
        subs=[("Damage Mult.+", "2.1%"), ("HP", "2.9%"), ("Defense", "4.1%")],
    )
    card, conf, notes = parse_panel(img, regions, vocab, rarity=5, slot="Star")
    # what the number comes out as doesn't matter (bare digits in a wide box are
    # exactly the case synthetic OCR is flaky on) — what matters is that it lands
    # in range, so validate_card would wave it through, and the note is therefore
    # the only thing standing between a guessed level and the save file.
    assert card["level"] is not None and 0 <= card["level"] <= 25
    assert conf["level"] < 1.0
    assert any('without a readable "Lv." prefix' in n for n in notes)


def test_heavens_set_without_a_slot_is_flagged_not_guessed(vocab):
    img, regions = _build_panel(
        title="[Futility]", level_text="Lv.25", main_label="Crit Rate",
        subs=[("Damage Mult.+", "2.1%")],
    )
    card, conf, notes = parse_panel(img, regions, vocab, rarity=5)  # no slot given
    assert card["slot"] is None
    assert conf["slot"] == 0.0
    assert any("no slot was given" in n for n in notes)
