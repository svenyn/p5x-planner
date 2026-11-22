"""No real screenshots exist yet (calibrate.py hasn't been run against one),
so this proves the crop -> OCR -> vocab-resolution chain works mechanically
by rendering a synthetic panel with PIL and feeding it back through
parse_panel() — the same role test/scale.js's synthetic 4000-card inventory
plays for the JS optimiser."""
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont

from panel_ocr import (TAB_ORDER, is_lone_digit, parse_level, parse_panel,
                       pick_value_reading, resolve_lone_digit)

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


def _build_space_panel(title, level_text, main_value, main2_value, subs):
    """A Space panel, which unlike a Heavens one has TWO main stat rows — flat
    ATK then flat DEF — pushing every substat down a row.

    Returns (image, regions). `regions` carries BOTH layouts' boxes over the same
    pixels: the space_* ones on the real rows, and the plain sub* ones where a
    Heavens-layout config would have put them (one row too high). Handing over
    both is what makes a test able to tell which layout parse_panel actually
    used, rather than just that it got four substats from somewhere."""
    if not Path(FONT_PATH).exists():
        pytest.skip("Arial not found — this test needs a real TTF for legible synthetic OCR")
    font = ImageFont.truetype(FONT_PATH, 28)

    img = Image.new("RGB", (W, H), "white")
    draw = ImageDraw.Draw(img)
    regions = {}

    def place(key, box, text):
        if text is not None:
            draw.text((box[0] + 5, box[1] + 3), text, font=font, fill="black")
        regions[key] = _fraction_box(box)

    place("title", (40, 20, W - 40, 60), title)
    place("level", (40, 70, W - 40, 110), level_text)

    # row i: label on the left, value on the right, same line
    rows = [("Attack", str(main_value)), ("Defense", str(main2_value))] + list(subs)
    def label_box(i):
        return (40, 140 + i * 60, 420, 140 + i * 60 + 44)
    def value_box(i):
        return (460, 140 + i * 60, W - 40, 140 + i * 60 + 44)

    for i, (label, value) in enumerate(rows):
        draw.text((label_box(i)[0] + 5, label_box(i)[1] + 3), label, font=font, fill="black")
        draw.text((value_box(i)[0] + 5, value_box(i)[1] + 3), value, font=font, fill="black")

    place("main_label", label_box(0), None)
    place("main_value", value_box(0), None)
    place("space_main2_value", value_box(1), None)
    for i in range(1, len(rows) - 1):
        place(f"space_sub{i}_label", label_box(i + 1), None)
        place(f"space_sub{i}_value", value_box(i + 1), None)
        # the Heavens boxes for the same card, one row too high
        place(f"sub{i}_label", label_box(i), None)
        place(f"sub{i}_value", value_box(i), None)

    return img, regions


def test_space_card_reads_its_substats_below_the_second_main_row(vocab):
    """The Aug 2026 regression: read on the Heavens rows, a Space card files its
    flat DEF main as substat 1 and drops substat 4 off the bottom of the panel."""
    img, regions = _build_space_panel(
        title="Acceptance & Strife", level_text="Lv.25",
        main_value=359, main2_value=359,
        subs=[("Pierce Rate", "6%"), ("Ailment Acc.", "11.9%"),
              ("Crit Rate", "4.5%"), ("HP", "157")],
    )
    card, conf, notes = parse_panel(img, regions, vocab, rarity=5)

    assert card["slot"] == "Space"
    assert card["set"] == "Acceptance"
    assert card["main"] == "ATK + DEF"
    stats = [s["stat"] for s in card["subs"]]
    assert stats == ["Resistance Pierce", "Ailment Accuracy", "Crit Rate", "HP"]
    # the tell for the bug: DEF is the second MAIN, never a substat here
    assert "DEF" not in stats and "DEF%" not in stats
    assert {s["stat"]: s["value"] for s in card["subs"]}["HP"] == pytest.approx(157)
    assert card["mainValue"] == pytest.approx(359)


def test_space_main_rows_that_disagree_drop_the_value_rather_than_pick_one(vocab):
    """flat ATK and flat DEF were identical on all 52 real Space frames, so a
    disagreement means one row was misread — and nothing on the panel says
    which, so guessing would put a wrong magnitude into stat totals."""
    img, regions = _build_space_panel(
        title="Acceptance & Strife", level_text="Lv.25",
        main_value=359, main2_value=59,
        subs=[("Pierce Rate", "6%"), ("Crit Rate", "4.5%")],
    )
    card, conf, notes = parse_panel(img, regions, vocab, rarity=5)

    assert "mainValue" not in card
    assert any("main stat rows disagree" in n for n in notes)


def _tab_strip(img, selected):
    """Paints a synthetic Space/Sun/Moon/Star/Sky strip with one tab highlighted
    in the game's bright red, and returns its region box. detect_slot_from_tabs
    reads colour, not text, so five flat rectangles are a faithful stand-in."""
    draw = ImageDraw.Draw(img)
    x0, y0, x1, y1 = 40, 600, 640, 660
    draw.rectangle((x0, y0, x1, y1), fill=(40, 10, 10))
    i = TAB_ORDER.index(selected)
    w = (x1 - x0) // len(TAB_ORDER)
    draw.rectangle((x0 + i * w, y0, x0 + (i + 1) * w, y1), fill=(230, 40, 40))
    return _fraction_box((x0, y0, x1, y1))


def test_unreadable_title_does_not_throw_away_the_slot_from_the_tab_strip(vocab):
    """The slot comes from the tab strip's colour, which is independent evidence
    and stays good when the title is mush. Discarding it alongside the set turned
    every Space card whose paired title failed to resolve into an unslotted one —
    and the slot is what picks the row geometry the substats are read on."""
    img, regions = _build_space_panel(
        title="~~~ unreadable ~~~", level_text="Lv.25",
        main_value=359, main2_value=359,
        subs=[("Pierce Rate", "6%"), ("Ailment Acc.", "11.9%"),
              ("Crit Rate", "4.5%"), ("HP", "157")],
    )
    regions["slot_tabs"] = _tab_strip(img, "Space")
    card, conf, notes = parse_panel(img, regions, vocab, rarity=5)

    assert card["set"] is None
    assert card["slot"] == "Space"
    assert len(card["subs"]) == 4        # still read on the Space rows
    assert any("could not resolve set" in n for n in notes)


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


@pytest.mark.parametrize("native,upscaled,expected", [
    # a dropped decimal point is a 10x error, so the reading that kept one wins
    ("15", "1.5", "1.5"),
    ("17%", "1.7%", "1.7%"),
    # ...but not the other way round: upscaling dropped the point on this one
    ("2.2", "2", "2.2"),
    ("7.1%", "71%", "7.1%"),
    # a dropped "%" is silent rather than large — it turns a % substat into its
    # flat sibling — so it counts the same way
    ("47", "2%", "2%"),
    ("44", "5.2%", "5.2%"),
    # the game's dim grey leading zero ("032"): whether Tesseract merges it into
    # the next digit flips with the resampling, in both directions
    ("32", "4", "32"),
    ("4", "32", "32"),
    ("4", "92", "92"),
    # but digit count is only evidence between two PLAIN readings. Here 2x
    # hallucinated a digit onto a real "2.5"; counting digits would take it
    ("2.5", "2.35", "2.5"),
    # nothing to choose between them: native, as before any of this
    ("84", "84", "84"),
    ("2", "2", "2"),
])
def test_value_tie_break_prefers_the_reading_that_resolved_more(native, upscaled, expected):
    """Every case here is a real (native, 2x) pair from the Aug 2026 batches,
    with `expected` read by eye off the crop — see pick_value_reading."""
    assert pick_value_reading(native, upscaled) == expected


@pytest.mark.parametrize("readings,expected", [
    # the decimal point in front of a 9 tucks under its tail and is lost at
    # BOTH of the original scales; only 4x sees it. Real "1.9" and "5.9" Speed
    # substats from the Sep 2026 Space runs, read as 19 and 59 and sent to
    # review as out of range.
    (("19", "19", "1.9"), "1.9"),
    (("59", "59", "5.9"), "5.9"),
    # the larger scale is held to the same rule the other way: a scale that
    # drops a point the smaller ones kept, or reads nothing at all, loses
    (("7.1%", "7.1%", "71%"), "7.1%"),
    (("4.9%", "4.9%", ""), "4.9%"),
    # among equally-marked readings the smallest scale wins, so a larger scale
    # hallucinating a digit onto a real value still loses
    (("2.5", "2.35", "2.55"), "2.5"),
    # the grey-zero digit-count rule applies across all plain readings...
    (("4", "32", "32"), "32"),
    # ...which is why 3x is NOT one of the scales: on a real Lv25 DEF "55" it
    # read "595", and a longer plain reading wins. 4x read the same box "53"
    # and the smaller scales keep it.
    (("55", "55", "595"), "595"),
    (("55", "55", "53"), "55"),
    # all empty stays empty rather than raising
    (("", "", ""), ""),
])
def test_value_pick_scores_every_scale_by_the_same_rule(readings, expected):
    """Real 1x/2x/4x reading tuples from the Sep 2026 frames (and the 3x
    readings that kept 3x out) — see pick_value_reading and _VALUE_SCALES."""
    assert pick_value_reading(*readings) == expected


@pytest.mark.parametrize("pick,word_readings,expected", [
    # the Sep 2026 live-grab run: every Speed 2 in rows 1 and 4 read
    # ("4", "4", "2") under psm 7 and the tie-break kept the 4; psm 8 reads
    # the same crops as 2, so it wins
    ("4", ("2", "2", "2"), "2"),
    # a real Lv25 Speed 4 (3 of 3 in the Steam corpus): psm 8 reads nothing,
    # so the psm 7 reading stands rather than being thrown away
    ("4", ("", "", ""), "4"),
    # agreement, with a scale or two dropping out, changes nothing
    ("2", ("", "2", "2"), "2"),
    ("7", ("7", "7", "7"), "7"),
    # psm 8 is only believed for a bare digit — its own failure modes ("4.",
    # "032.", "2.20") never replace the reading
    ("2", ("2.", "4.", "4."), "2"),
    ("4", ("032.", "032.", "032."), "4"),
])
def test_lone_digit_second_opinion_is_believed_only_when_it_is_a_lone_digit(pick, word_readings, expected):
    """Real (psm 7 pick, psm 8 readings) pairs — see resolve_lone_digit."""
    assert resolve_lone_digit(pick, word_readings) == expected


@pytest.mark.parametrize("text,expected", [
    ("2", True), (" 4 ", True), ("", False), (None, False),
    ("2%", False), ("2.2", False), ("32", False), ("2,", False),
])
def test_is_lone_digit(text, expected):
    assert is_lone_digit(text) is expected


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


# ---- the grid cursor -------------------------------------------------------
#
# A 1920x1080 frame drawn to the real `grid` box and tile geometry: the selection
# frame is a red outline round one tile, the "art" is red blobs no wider than the
# 18 px the widest measured card art reached (Departure's red-caped rider).

GRID_BOX = (0.028, 0.225, 0.268, 0.8)
SEL_RED = (249, 34, 3)
TILE_X = {0: (54, 269), 1: (290, 505)}
ROW_PITCH = 100  # six rows inside the box; the real pitch is ~104 with the list scrolled part-way


def _tile_y(row):
    y0 = int(250 + row * ROW_PITCH)
    return y0, y0 + 85


def _grid_frame(selected=None, art=(), extra_frames=()):
    """selected: (row, col) wearing the red frame; art: (row, col) tiles carrying red art."""
    img = Image.new("RGB", (1920, 1080), (90, 12, 10))  # the dark red backdrop fails R > 200
    draw = ImageDraw.Draw(img)
    for row, col in art:
        x0, _ = TILE_X[col]
        y0, _ = _tile_y(row)
        for i in range(4):  # four cape-sized blobs, 16 px wide: ~2000 px of red a tile
            draw.rectangle((x0 + 30 + 40 * i, y0 + 20, x0 + 45 + 40 * i, y0 + 50), fill=SEL_RED)
    for row, col in ([selected] if selected else []) + list(extra_frames):
        x0, x1 = TILE_X[col]
        y0, y1 = _tile_y(row)
        draw.rectangle((x0, y0, x1, y1), outline=SEL_RED, width=6)
    return img


def _row_fraction(row):
    y0, y1 = _tile_y(row)
    top, bottom = GRID_BOX[1] * 1080, GRID_BOX[3] * 1080
    return ((y0 + y1) / 2 - top) / (bottom - top)


def test_grid_cursor_is_found_by_its_frame_through_red_card_art():
    """The Departure case: enough red art in view that the frame's column holds
    under 75% of the red, which is where counting red pixels returned "no
    cursor" and the Space walk stopped mid-list."""
    import numpy as np
    from panel_ocr import crop_fraction, detect_grid_cursor
    art = [(3, 0), (3, 1), (4, 1), (2, 1), (1, 1)]
    img = _grid_frame(selected=(5, 0), art=art)

    a = np.asarray(crop_fraction(img, GRID_BOX)).astype(int)
    red = (a[:, :, 0] > 200) & (a[:, :, 1] < 90) & (a[:, :, 2] < 90)
    left = red[:, : a.shape[1] // 2].sum()
    assert left / red.sum() < 0.75, "the fixture must defeat a red-pixel count to test anything"

    col, yf = detect_grid_cursor(img, GRID_BOX)
    assert col == 0
    assert yf == pytest.approx(_row_fraction(5), abs=0.02)


def test_grid_cursor_row_follows_the_frame_not_the_art():
    from panel_ocr import detect_grid_cursor
    for row in range(6):
        col, yf = detect_grid_cursor(_grid_frame(selected=(row, 1), art=[(0, 1), (5, 1), (2, 0)]), GRID_BOX)
        assert col == 1
        assert yf == pytest.approx(_row_fraction(row), abs=0.02)


def test_red_art_alone_is_never_taken_for_the_cursor():
    from panel_ocr import detect_grid_cursor
    assert detect_grid_cursor(_grid_frame(art=[(r, c) for r in range(6) for c in (0, 1)]), GRID_BOX) == (None, None)


def test_frames_in_both_columns_are_not_guessed():
    from panel_ocr import detect_grid_cursor
    img = _grid_frame(selected=(2, 0), extra_frames=[(4, 1)])
    assert detect_grid_cursor(img, GRID_BOX) == (None, None)
