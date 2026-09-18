"""Consistency checks against the measured 5-star tables, on top of validate_card.

validate_card (a port of the app's validateCard) asks whether a card is *legal*: a
known set, a main the slot allows, every substat under five max rolls. A misread
that lands inside those bounds sails through it — a real "1.5" read as "15" is
under Crit Multiplier's 20.5 cap, a real "10.8%" read as "0.8%" is a fine-looking
substat — and nothing downstream can tell. These checks ask the stronger question
the scan itself answered: is this a value the game can actually print?

Three facts carry them, all measured off the user's own scanned inventory rather
than taken from a guide site (docs/DATA-SOURCES.md):

  * A level-0 card holds exactly one roll per substat, and one roll takes exactly
    one of five values per stat (ROLL_TIERS in src/data.js — 3865 level-0 cards,
    every stat, both layouts, no exceptions but a single misread). So a level-0
    substat off its stat's five tiers is a misread, full stop.
  * The main stat's magnitude is a function of level alone (MAIN_MAGNITUDE): the
    same number on every card of that stat at that level, linear in between,
    rounded to what the panel shows. So the level and the main value are two
    independent reads of one fact and must agree — and when the level template
    has no match, the main value can name the level on its own.
  * A card below its rarity's maximum substat count gains the missing one on its
    first upgrade (the app's mergeImport rests on the same rule). So a 5-star with
    three substats at level 5 or above was read wrong somewhere.

Everything here is a NOTE, never a repair. A note sends the card to review with its
frame kept; a repair would be a guess written into the inventory as fact. The
"which reading is right" decision was tried in the other direction for the level
field and produced confidently wrong values — see levels.py. Levelled cards'
substats are deliberately not checked against sums of tiers: the displayed total
of several rolls is not a sum of the displayed tiers (a real Lv25 DEF 130 cannot be
made from 27/32/37/41/46 at any roll count), so the game keeps more precision than
it prints and any such rule would flag good cards.

Only 5-star tables exist. A card of any other rarity, or of unknown rarity, passes
every check here untouched — unknown is not wrong.
"""


def _is_int_curve(curve):
    return all(float(v).is_integer() for v in curve)


def _step(curve):
    """What the panel prints for this main: whole numbers for HP and ATK + DEF,
    one decimal for everything else."""
    return 1.0 if _is_int_curve(curve) else 0.1


def _round_to(value, step):
    return round(round(value / step) * step, 1 if step < 1 else 0)


def _tolerance(curve):
    """One display unit. The panel's rounding is not plain round-half-up — a real
    Lv20 HP main prints 897 where the line gives 896.4 — so exact agreement is too
    strict by one unit, and one unit is still far under any main's per-level step
    (Crit Rate is the finest at 0.64 per level against 0.1 printed)."""
    return _step(curve) + 1e-6


def upgrades_used(level, rarity, vocab):
    info = vocab.rarity.get(rarity)
    if not info or level is None or not info.get("upgrades"):
        return None
    per = info["maxLevel"] / info["upgrades"]
    return min(info["upgrades"], int(level // per))


# ------------------------------ substat tiers ------------------------------

def roll_tiers(vocab, stat, slot):
    """The five values one roll of `stat` can show on this layout, or None when
    the table does not know (no table exported, or an unknown stat)."""
    table = getattr(vocab, "roll_tiers", None) or {}
    entry = table.get(stat)
    if not entry:
        return None
    return entry.get("space" if slot == "Space" else "heavens")


def off_tier(value, tiers, tol=0.051):
    """True when `value` is not within display rounding of any tier."""
    return all(abs(value - t) > tol for t in tiers)


def check_lv0_substats(card, vocab):
    if card.get("rarity") != 5 or card.get("level") != 0:
        return []
    notes = []
    for i, s in enumerate(card.get("subs") or [], start=1):
        tiers = roll_tiers(vocab, s.get("stat"), card.get("slot"))
        value = s.get("value")
        if tiers is None or not isinstance(value, (int, float)):
            continue
        if off_tier(value, tiers):
            shown = "/".join(f"{t:g}" for t in tiers)
            notes.append(f"substat {i}: {s['stat']} {value:g} is not one of the five level-0 "
                         f"rolls ({shown}) — misread")
    return notes


# ------------------------------ main stat curve ------------------------------

def main_curve(vocab, main, rarity):
    """[Lv0, Lv-cap] for a 5-star main, else None — no other rarity has been
    scanned, and assuming they share the curve is the app's business, not a
    ground for flagging a card."""
    if rarity != 5:
        return None
    table = getattr(vocab, "main_magnitude", None) or {}
    curve = table.get(main)
    return list(curve) if curve else None


def main_value_at(vocab, main, level, rarity=5):
    """What the panel prints for this main at this level, or None if unknown."""
    curve = main_curve(vocab, main, rarity)
    info = vocab.rarity.get(rarity)
    if curve is None or info is None or level is None:
        return None
    cap = info["maxLevel"]
    if not 0 <= level <= cap:
        return None
    raw = curve[0] + (curve[1] - curve[0]) * level / cap
    return _round_to(raw, _step(curve))


def level_from_main_value(vocab, main, value, rarity=5):
    """The one level whose printed main value is `value`, or None.

    Every main's per-level step is well above what the panel prints (Crit Rate is
    the finest at 0.64 per level against 0.1 shown), so at most one level can
    match within the one-unit tolerance; the loop still refuses if two do, rather
    than pick. A misread value almost never lands on the curve at all — dropping a
    digit or a decimal point moves it by a factor of ten, far outside 0-cap — which
    is what makes this a safe fallback for the level template and not a guess.
    """
    curve = main_curve(vocab, main, rarity)
    info = vocab.rarity.get(rarity)
    if curve is None or info is None or not isinstance(value, (int, float)):
        return None
    tol = _tolerance(curve)
    hits = [lv for lv in range(info["maxLevel"] + 1)
            if abs(main_value_at(vocab, main, lv, rarity) - value) <= tol]
    return hits[0] if len(hits) == 1 else None


def check_main_value(card, vocab):
    level, value = card.get("level"), card.get("mainValue")
    if level is None or value is None:
        return []
    expected = main_value_at(vocab, card.get("main"), level, card.get("rarity"))
    if expected is None:
        return []
    curve = main_curve(vocab, card.get("main"), card.get("rarity"))
    if abs(expected - value) <= _tolerance(curve):
        return []
    fits = level_from_main_value(vocab, card.get("main"), value, card.get("rarity"))
    where = f" — it is the Lv{fits} value" if fits is not None else " — it is not on the curve at any level"
    return [f"main stat {card.get('main')} {value:g} does not match Lv{level} "
            f"(a 5★ {card.get('main')} main reads {expected:g} there){where}; "
            f"the level or the value was misread"]


# ------------------------------ substat count ------------------------------

def check_sub_count(card, vocab):
    rarity, level = card.get("rarity"), card.get("level")
    info = vocab.rarity.get(rarity)
    if info is None or level is None:
        return []
    n = len(card.get("subs") or [])
    used = upgrades_used(level, rarity, vocab)
    if used and info["subMin"] <= n < info["subMax"]:
        return [f"{n} substats at Lv{level}: a {rarity}★ card gains its {info['subMax']}th "
                f"substat on its first upgrade, so a substat or the level was misread"]
    return []


def check_card(card, vocab):
    """Every note the measured tables can raise against this card."""
    return check_lv0_substats(card, vocab) + check_main_value(card, vocab) + check_sub_count(card, vocab)
