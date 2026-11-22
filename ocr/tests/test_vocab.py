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


STAR_MAINS = ["ATK%", "DEF%", "HP%", "Crit Rate", "Crit Multiplier", "Ailment Accuracy"]


def test_mid_animation_label_resolves_by_unique_fragment(vocab):
    # Real reads from the Aug 2026 batch: the panel's label animation was still
    # playing, so "Ailment Acc." came back part-assembled. Both carry a run of
    # characters no other legal Star main contains — see _unique_fragment.
    for raw in ("ntAcc. A", "G Ailmen"):
        stat, conf = vocab.norm_stat(raw, value_has_percent=True, restrict_to=STAR_MAINS)
        assert stat == "Ailment Accuracy", raw
        # low enough that parse_panel notes it for review rather than trusting it
        assert 0 < conf < 0.65, raw


def test_fragment_shared_by_two_legal_mains_is_refused(vocab):
    # "rit" belongs to Crit Rate and Crit Multiplier alike; guessing between them
    # is exactly what the uniqueness requirement exists to prevent.
    assert vocab.norm_stat("rit", restrict_to=STAR_MAINS) == (None, 0.0)
    assert vocab.norm_stat("Crit", restrict_to=STAR_MAINS)[0] != "Crit Multiplier"


def test_short_fragment_is_refused(vocab):
    # Pins MAIN_STAT_FRAGMENT_MIN from both sides: 4 characters of an unambiguous
    # label is not enough to name it, 5 is. Both of these runs belong to Ailment
    # Accuracy and to nothing else Star can roll, so uniqueness is not what
    # separates them — length is.
    assert vocab.norm_stat("ilme", restrict_to=STAR_MAINS) == (None, 0.0)
    assert vocab.norm_stat("tacc", restrict_to=STAR_MAINS) == (None, 0.0)
    assert vocab.norm_stat("ilmen", restrict_to=STAR_MAINS)[0] == "Ailment Accuracy"
    assert vocab.norm_stat("ntacc", restrict_to=STAR_MAINS)[0] == "Ailment Accuracy"


def test_fragment_fallback_does_not_answer_non_stat_text(vocab):
    # Panel chrome that would mean the label crop had drifted off the stat row
    # entirely. The fallback is a tie-break among a slot's legal mains, not a
    # licence to name one.
    for raw in ("Compare", "Enhance", "Reset", "Details", "ID:60010018887", "Stacks up to 3"):
        assert vocab.norm_stat(raw, restrict_to=STAR_MAINS) == (None, 0.0), raw


def test_exact_set_match(vocab):
    assert vocab.norm_set("Hindrance") == ("Hindrance", 1.0)


def test_alias_set_match(vocab):
    assert vocab.norm_set("strength") == ("Power", 1.0)


def test_bracketed_set_name_resolves(vocab):
    # the in-game Set Effect panel shows "[Futility]" — a small icon glyph, brackets,
    # then the name. Confirmed against a real screenshot, Aug 2026.
    assert vocab.norm_set("[Futility]") == ("Futility", 1.0)


def test_paired_space_title_resolves_to_the_space_set(vocab):
    """A Space card's Set Effect box names its own set AND the Heavens set it
    combines with. All five pairings seen in the Aug 2026 batches; before this
    the whole string matched nothing and every Space card went to review."""
    for title, expected in [
        ("Acceptance & Strife", "Acceptance"),
        ("Growth & Opulence", "Growth"),
        ("Departure & Control", "Departure"),
        ("Creation & Worry", "Creation"),
        ("Awareness & Truth", "Awareness"),
    ]:
        assert vocab.norm_set(title) == (expected, 1.0)


def test_paired_title_picks_the_space_set_not_the_first_name(vocab):
    """The Space set is printed first, so "first name wins" gets the same answer
    on every real frame — but membership in SPACE_SETS is the actual reason it is
    the right one, and that keeps holding if OCR ever hands the names over the
    other way round."""
    assert vocab.norm_set("Strife & Acceptance") == ("Acceptance", 1.0)


def test_paired_title_with_no_resolvable_part_is_refused(vocab):
    assert vocab.norm_set("Nonsense & Gibberish") == (None, 0.0)


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
