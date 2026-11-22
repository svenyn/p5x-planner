"""The measured-table checks in plausibility.py, against the numbers they were
derived from (docs/DATA-SOURCES.md): five roll tiers per stat, one main value per
level, one extra substat on the first upgrade. Everything is a note, never a
repair — so these assert what gets flagged and, just as much, what does not."""
import pytest

from plausibility import (check_card, check_lv0_substats, check_main_value, check_sub_count,
                          level_from_main_value, main_value_at)


def card(**kw):
    base = {"slot": "Star", "set": "Futility", "rarity": 5, "level": 0, "main": "Crit Rate",
            "subs": [{"stat": "ATK%", "value": 2.8}, {"stat": "Speed", "value": 1.5},
                     {"stat": "HP", "value": 112}]}
    base.update(kw)
    return base


# ------------------------------ level-0 tiers ------------------------------

def test_a_level_0_value_on_its_tier_is_not_flagged(vocab):
    assert check_lv0_substats(card(), vocab) == []


def test_a_level_0_value_off_its_tier_is_a_misread(vocab):
    # The one silent error found in 11,000 scanned values: Speed 4.0 on a level-0
    # card, under the 11.0 range cap and nowhere near a real roll.
    notes = check_lv0_substats(card(subs=[{"stat": "Speed", "value": 4.0}]), vocab)
    assert len(notes) == 1 and "Speed 4" in notes[0] and "1.3/1.5/1.8/2/2.2" in notes[0]


def test_a_dropped_decimal_point_is_caught_even_inside_the_range_cap(vocab):
    # 1.5 read as 15: legal by validate_card (Crit Multiplier caps at 20.5), impossible here.
    notes = check_lv0_substats(card(subs=[{"stat": "Crit Multiplier", "value": 15.0}]), vocab)
    assert len(notes) == 1


def test_space_cards_use_the_space_tiers(vocab):
    # 4.3 is a Space ATK% roll and not a Heavens one; 3.5 is both.
    assert check_lv0_substats(card(slot="Space", set="Perseverance", main="ATK + DEF",
                                   subs=[{"stat": "ATK%", "value": 4.3}]), vocab) == []
    assert len(check_lv0_substats(card(subs=[{"stat": "ATK%", "value": 4.3}]), vocab)) == 1


def test_levelled_and_other_rarity_cards_are_left_alone(vocab):
    # Several rolls do not sum to displayed tiers, and no 4★ has ever been scanned.
    assert check_lv0_substats(card(level=25, subs=[{"stat": "Speed", "value": 4.0}]), vocab) == []
    assert check_lv0_substats(card(rarity=4, subs=[{"stat": "Speed", "value": 4.0}]), vocab) == []


# ------------------------------ main value curve ------------------------------

@pytest.mark.parametrize("main,level,shown", [
    ("HP", 0, 162), ("HP", 16, 750), ("HP", 25, 1080),
    ("ATK%", 14, 19.6), ("Crit Multiplier", 20, 31.2), ("ATK + DEF", 23, 335),
])
def test_the_curve_reproduces_scanned_main_values(vocab, main, level, shown):
    assert main_value_at(vocab, main, level) == pytest.approx(shown, abs=0.05)


def test_the_panel_rounds_within_one_unit_of_the_line(vocab):
    # A real Lv20 HP main prints 897 where the line gives 896.4 — one unit is
    # tolerated, so this is not flagged and still names its level.
    assert check_main_value(card(slot="Sun", main="HP", level=20, mainValue=897), vocab) == []
    assert level_from_main_value(vocab, "HP", 897) == 20


@pytest.mark.parametrize("main,value,level", [
    ("HP", 162, 0), ("HP", 1080, 25), ("Crit Rate", 11.8, 14), ("Speed", 20.3, 25),
    ("ATK + DEF", 274, 18),
])
def test_a_main_value_names_its_level(vocab, main, value, level):
    assert level_from_main_value(vocab, main, value) == level


@pytest.mark.parametrize("main,value", [
    ("HP", 108),      # 1080 with a dropped digit — below Lv0
    ("HP", 1000),     # between two levels
    ("ATK%", 314),    # 31.4 with a dropped point — far past the cap
    ("Speed", 31),    # 3.1 with a dropped point
])
def test_a_misread_main_value_names_no_level(vocab, main, value):
    assert level_from_main_value(vocab, main, value) is None


def test_no_curve_for_other_rarities(vocab):
    assert main_value_at(vocab, "HP", 0, rarity=4) is None
    assert level_from_main_value(vocab, "HP", 162, rarity=4) is None


def test_a_main_value_that_is_not_this_levels_is_flagged_and_says_whose_it_is(vocab):
    notes = check_main_value(card(slot="Sun", main="HP", level=0, mainValue=1080), vocab)
    assert len(notes) == 1
    assert "does not match Lv0" in notes[0] and "Lv25" in notes[0]


def test_a_matching_main_value_is_quiet(vocab):
    assert check_main_value(card(slot="Sun", main="HP", level=0, mainValue=162), vocab) == []
    assert check_main_value(card(level=25, mainValue=18.8), vocab) == []


# ------------------------------ substat count ------------------------------

def test_three_substats_at_level_0_is_a_mint_card(vocab):
    assert check_sub_count(card(), vocab) == []


def test_three_substats_past_the_first_upgrade_is_a_misread(vocab):
    notes = check_sub_count(card(level=5), vocab)
    assert len(notes) == 1 and "3 substats at Lv5" in notes[0]
    assert check_sub_count(card(level=25), vocab)


def test_four_substats_at_any_level_is_fine(vocab):
    four = card()["subs"] + [{"stat": "DEF%", "value": 4.1}]
    assert check_sub_count(card(level=25, subs=four), vocab) == []


def test_a_rarity_whose_maximum_is_three_is_never_short(vocab):
    assert check_sub_count(card(rarity=3, level=15), vocab) == []


def test_check_card_gathers_every_note(vocab):
    c = card(slot="Sun", main="HP", level=5, mainValue=162,
             subs=[{"stat": "Speed", "value": 4.0}, {"stat": "ATK%", "value": 2.8},
                   {"stat": "DEF%", "value": 4.1}])
    notes = check_card(c, vocab)
    # not level 0, so no tier note; the main value is Lv0's; three subs at Lv5
    assert len(notes) == 2
    assert any("does not match Lv5" in n for n in notes)
    assert any("3 substats at Lv5" in n for n in notes)
