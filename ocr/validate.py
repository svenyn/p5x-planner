"""Python port of validateCard() in src/logic.js.

Kept deliberately in lock-step with the JS version — same checks, same
order, same error style — so a card that would be rejected by the app's own
bulk paste / JSON load / merge import is rejected here too, before it ever
reaches a save file. If you change validateCard() in src/logic.js, mirror
the change here and re-run ocr/tests/test_validate.py.
"""


def validate_card(card, vocab):
    errs = []
    slot = card.get("slot")
    if slot not in vocab.slots:
        errs.append(f'unknown slot "{slot}"')
        return errs

    info = vocab.slot_info[slot]
    set_table = vocab.space_sets if slot == "Space" else vocab.sets
    set_name = card.get("set")
    if set_name not in set_table:
        errs.append(f'"{set_name}" is not a legal set for {slot}')

    rarity = card.get("rarity")
    if rarity not in vocab.rarity:
        errs.append(f'bad rarity "{rarity}"')
        return errs
    r = vocab.rarity[rarity]

    level = card.get("level")
    if not (isinstance(level, int) and 0 <= level <= r["maxLevel"]):
        errs.append(f'level must be 0-{r["maxLevel"]} for {rarity}★')

    main = card.get("main")
    if main not in info["mains"]:
        errs.append(f'"{main}" is not a legal main stat for {slot}')

    subs = card.get("subs") or []
    sub_min, sub_max = r["subMin"], r["subMax"]
    if not (sub_min <= len(subs) <= sub_max):
        want = str(sub_min) if sub_min == sub_max else f"{sub_min}-{sub_max}"
        errs.append(f"{rarity}★ cards have {want} substats, got {len(subs)}")

    seen = set()
    for s in subs:
        stat = s.get("stat")
        if stat not in vocab.substats:
            errs.append(f'unknown substat "{stat}"')
            continue
        if stat == main:
            errs.append(f'substat "{stat}" duplicates the main stat')
        if stat in seen:
            errs.append(f'substat "{stat}" appears twice')
        seen.add(stat)
        mx = vocab.max_roll(stat, slot)
        value = s.get("value")
        cap = mx * 5 if mx is not None else None
        if not (isinstance(value, (int, float)) and cap is not None and 0 < value <= cap):
            errs.append(f'{stat} value {value} is out of range (max ~{cap:.1f})' if cap else
                        f'{stat} value {value} is out of range')

    return errs
