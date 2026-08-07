def test_exact_stat_match(vocab):
    assert vocab.norm_stat("Crit Multiplier") == ("Crit Multiplier", 1.0)


def test_alias_stat_match(vocab):
    assert vocab.norm_stat("CDMG") == ("Crit Multiplier", 1.0)
    assert vocab.norm_stat("ehr") == ("Ailment Accuracy", 1.0)


def test_in_game_labels_with_trailing_punctuation(vocab):
    # confirmed from real screenshots, Aug 2026 (see docs/DATA-SOURCES.md)
    assert vocab.norm_stat("Pierce Rate") == ("Resistance Pierce", 1.0)
    assert vocab.norm_stat("Ailment Acc.") == ("Ailment Accuracy", 1.0)
    assert vocab.norm_stat("Crit Mult.") == ("Crit Multiplier", 1.0)
    assert vocab.norm_stat("Damage Mult.+") == ("Damage Multiplier", 1.0)


def test_fuzzy_stat_match_survives_ocr_noise(vocab):
    stat, conf = vocab.norm_stat("Crit Muitiplier")  # 'l' misread as 'i'
    assert stat == "Crit Multiplier"
    assert 0 < conf < 1.0


def test_unresolvable_stat_returns_none(vocab):
    stat, conf = vocab.norm_stat("Completely Made Up Stat")
    assert stat is None
    assert conf == 0.0


def test_exact_set_match(vocab):
    assert vocab.norm_set("Hindrance") == ("Hindrance", 1.0)


def test_alias_set_match(vocab):
    assert vocab.norm_set("strength") == ("Power", 1.0)


def test_bracketed_set_name_resolves(vocab):
    # the in-game Set Effect panel shows "[Futility]" — a small icon glyph, brackets,
    # then the name. Confirmed against a real screenshot, Aug 2026.
    assert vocab.norm_set("[Futility]") == ("Futility", 1.0)


def test_fuzzy_set_match_is_not_defeated_by_case(vocab):
    # regression: the fuzzy fallback used to compare lowercased OCR text against
    # Title Case candidates, which alone could push a clean match below threshold
    resolved, conf = vocab.norm_set("futiliti")  # lowercase + one-letter OCR slip
    assert resolved == "Futility"
    assert conf >= 0.8


def test_screenshot_confirmed_sets_resolve(vocab):
    for name in ("Futility", "Sorrow", "Disappointment", "Change", "Perseverance"):
        resolved, conf = vocab.norm_set(name)
        assert resolved == name
        assert conf == 1.0


def test_unverified_sets_are_not_aliased_away(vocab):
    assert vocab.norm_set("Ruin") == ("Ruin", 1.0)
    assert vocab.norm_set("Prudence") == ("Prudence", 1.0)


def test_slot_aliases(vocab):
    assert vocab.norm_slot("Planet") == ("Sky", 1.0)
    assert vocab.norm_slot("Universe") == ("Space", 1.0)
    assert vocab.norm_slot("star") == ("Star", 1.0)


def test_slot_for_set(vocab):
    assert vocab.slot_for_set("Hindrance") == "Heavens"
    assert vocab.slot_for_set("Perseverance") == "Space"
    assert vocab.slot_for_set("Nonexistent") is None


def test_max_roll_space_vs_heavens(vocab):
    assert vocab.max_roll("Speed", "Star") == 2.2
    assert vocab.max_roll("Speed", "Space") == 2.8
