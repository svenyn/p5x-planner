from validate import validate_card

GOOD = {
    "slot": "Star", "set": "Hindrance", "rarity": 5, "level": 25, "main": "Crit Rate",
    "subs": [
        {"stat": "Crit Multiplier", "value": 16.4},
        {"stat": "Resistance Pierce", "value": 8.4},
        {"stat": "ATK%", "value": 14},
        {"stat": "Speed", "value": 6.6},
    ],
}


def test_accepts_well_formed_card(vocab):
    assert validate_card(GOOD, vocab) == []


def test_rejects_illegal_main_for_slot(vocab):
    bad = {**GOOD, "main": "SP Recovery"}
    assert validate_card(bad, vocab)


def test_rejects_substat_duplicating_main(vocab):
    bad = {**GOOD, "subs": GOOD["subs"] + [{"stat": "Crit Rate", "value": 5}]}
    assert validate_card(bad, vocab)


def test_rejects_too_many_substats_for_rarity(vocab):
    bad = {**GOOD, "rarity": 2}
    assert validate_card(bad, vocab)


def test_rejects_value_far_above_roll_ceiling(vocab):
    bad = {**GOOD, "subs": [{"stat": "Crit Multiplier", "value": 500}] + GOOD["subs"][1:]}
    assert validate_card(bad, vocab)


def test_rejects_unknown_slot(vocab):
    bad = {**GOOD, "slot": "Bogus"}
    assert validate_card(bad, vocab) == ['unknown slot "Bogus"']


def test_rejects_set_illegal_for_slot(vocab):
    # Perseverance is a Space-only set; illegal on a Heavens slot
    bad = {**GOOD, "set": "Perseverance"}
    assert validate_card(bad, vocab)


def test_space_card_with_fixed_main(vocab):
    card = {
        "slot": "Space", "set": "Creation", "rarity": 5, "level": 25, "main": "ATK + DEF",
        "subs": [
            {"stat": "Crit Multiplier", "value": 20.8},
            {"stat": "Crit Rate", "value": 10.4},
            {"stat": "ATK%", "value": 17.2},
            {"stat": "Speed", "value": 8.4},
        ],
    }
    assert validate_card(card, vocab) == []
