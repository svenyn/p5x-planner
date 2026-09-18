"""Walk a batch's *-review.json one card at a time, correct it, then merge.

    python review_cards.py cards-6
    python review_cards.py cards-6 --shots "C:\\Games\\Steam\\userdata\\...\\screenshots"

For each flagged card it prints the whole panel as read, with the notes that got
it flagged, and waits. Type a field's number to change it, `a` to accept the card
as shown, `d` to drop it, `q` to stop. Accepting runs the same validate_card the
pipeline uses and refuses if the card would be illegal, so a mistyped correction
cannot be accepted by accident.

Accepting clears the card's notes, which is what merge_review keys off — see the
long note in merge_review.py for why clearing them by hand is the real gate and
validation cannot stand in for it (a real Lv.18 misread as Lv.8 is a perfectly
legal card). At the end this calls merge_review.merge for you, so accepted cards
land in cards.json and everything else stays in the review file for next time.

Values you type are normalised the same way the OCR's are: `crit dmg` resolves to
Crit Multiplier, `ail acc` to Ailment Accuracy, `Acceptence` to Acceptance. If
something does not resolve you are told and asked again, rather than it being
written through unchecked.

--shots DIR (or the P5X_SHOTS environment variable) enables `o`, which opens the
card's screenshot in your image viewer. The directory is searched recursively for
the frame's filename, so pointing it at the screenshots root is enough.
"""
import argparse
import json
import os
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from calibrate import load_config  # noqa: E402
from levels import LevelTemplates  # noqa: E402
from merge_review import merge  # noqa: E402
from panel_ocr import binarize, crop_fraction  # noqa: E402
from validate import validate_card  # noqa: E402
from vocab import Vocab  # noqa: E402

MENU = "  [number] edit   [a]ccept   [d]rop   [o]pen shot   [q]uit"


def fmt(v):
    if isinstance(v, float) and v == int(v):
        return str(int(v))
    return "-" if v is None else str(v)


def rows(card):
    """The editable fields, in panel order. Index -> (label, getter/setter key)."""
    out = [("slot", card.get("slot")), ("set", card.get("set")),
           ("rarity", card.get("rarity")), ("level", card.get("level")),
           ("main", card.get("main")), ("mainValue", card.get("mainValue"))]
    subs = card.get("subs") or []
    for i in range(4):
        s = subs[i] if i < len(subs) else None
        out.append((f"sub{i + 1}", f"{s['stat']} {fmt(s['value'])}" if s else "(empty)"))
    return out


def show(card, entry, idx, total, vocab):
    print(f"\n{'=' * 66}\n[{idx}/{total}] {entry.get('src')}\n{'=' * 66}")
    for i, (label, value) in enumerate(rows(card)):
        print(f"  {i:>2}  {label:<10} {fmt(value)}")
    for n in entry.get("notes") or []:
        print(f"   !  {n}")
    for e in entry.get("errors") or []:
        print(f"   X  {e}")
    live = validate_card(card, vocab)
    for e in live:
        print(f"   X  {e}")
    return live


def ask(prompt, current):
    try:
        raw = input(f"    {prompt} [{fmt(current)}]: ").strip()
    except EOFError:
        return None
    return raw


def edit_stat(vocab, card, prompt, restrict_to, current):
    """Prompt for a stat name and resolve it the way the OCR's reads are."""
    while True:
        raw = ask(prompt, current)
        if raw is None or raw == "":
            return current
        stat, conf = vocab.norm_stat(raw, restrict_to=restrict_to)
        if stat is None:
            legal = ", ".join(restrict_to) if restrict_to else "a known stat"
            print(f"    ? '{raw}' did not resolve. Expected one of: {legal}")
            print("      (press Enter alone to leave it unchanged)")
            continue
        if conf < 1.0:
            print(f"    -> read as {stat}")
        return stat


def edit_number(prompt, current, cast=float):
    while True:
        raw = ask(prompt, current)
        if raw is None or raw == "":
            return current
        try:
            return cast(raw)
        except ValueError:
            print(f"    ? '{raw}' is not a number")
            print("      (press Enter alone to leave it unchanged)")


def edit_field(i, card, vocab):
    slot = card.get("slot")
    info = vocab.slot_info.get(slot, {})
    if i == 0:
        raw = ask("slot", slot)
        if raw:
            s, _ = vocab.norm_slot(raw)
            if s is None:
                print(f"    ? '{raw}' is not a slot. Expected one of: {', '.join(vocab.slots)}")
            else:
                card["slot"] = s
    elif i == 1:
        raw = ask("set", card.get("set"))
        if raw:
            s, _ = vocab.norm_set(raw)
            if s is None:
                print(f"    ? '{raw}' did not resolve to a known set")
            else:
                card["set"] = s
    elif i == 2:
        card["rarity"] = edit_number("rarity", card.get("rarity"), int)
    elif i == 3:
        card["level"] = edit_number("level", card.get("level"), int)
    elif i == 4:
        card["main"] = edit_stat(vocab, card, "main", info.get("mains"), card.get("main"))
    elif i == 5:
        v = edit_number("mainValue", card.get("mainValue"))
        if v is not None:
            card["mainValue"] = v
    elif 6 <= i <= 9:
        n = i - 6
        subs = card.setdefault("subs", [])
        cur = subs[n] if n < len(subs) else None
        print(f"    (blank keeps current, '-' removes this substat)")
        raw = ask("substat", cur["stat"] if cur else None)
        if raw == "-":
            if cur:
                subs.pop(n)
            return
        if raw:
            stat, conf = vocab.norm_stat(raw)
            if stat is None:
                print(f"    ? '{raw}' did not resolve to a known stat")
                return
        elif cur:
            stat = cur["stat"]
        else:
            return
        value = edit_number("value", cur["value"] if cur else None)
        if value is None:
            return
        while len(subs) <= n:
            subs.append({"stat": stat, "value": value})
        subs[n] = {"stat": stat, "value": value}


def teach_level(entry, card, shots_dir, regions, templates):
    """Records this frame's level render, now that a human has confirmed it.

    Only for renders the matcher did NOT already recognise — those are the ones
    worth learning, and re-teaching a render we know is how a mistaken accept
    would overwrite a good template. Requires --shots: the frame is the evidence,
    and without it there is nothing to learn from.
    """
    if regions is None or templates is None or not shots_dir:
        return None
    src, level = entry.get("src"), card.get("level")
    if not src or level is None:
        return None
    hit = next(Path(shots_dir).rglob(src), None)
    if hit is None:
        return None
    try:
        crop = binarize(crop_fraction(Image.open(hit), regions["level"]))
    except Exception:
        return None
    if not templates.usable_for(crop):
        # No templates yet, or built at another crop size — learn() would either
        # start the file off this one render or raise. Starting it here is fine.
        if templates.shape is not None:
            return None
    else:
        already, _, _ = templates.classify(crop)
        if already == level:
            return None
        if already is not None:
            return f"! this render already matches level {already}; not overwriting it"
    replaced = templates.learn(crop, level)
    templates.save()
    return (f"learned level {level} from this frame"
            + (" (replacing the previous render)" if replaced else ""))


def walk(stem, cards_dir, shots_dir, learn=True):
    review_path = Path(cards_dir) / f"{stem}-review.json"
    # pipeline.py (and this function, below) only writes *-review.json when
    # there's something in it — a batch with nothing flagged has no file here
    # at all, which is the clean-run case, not an error.
    if not review_path.exists():
        print(f"no {review_path.name} — nothing to review.")
        return
    review = json.loads(review_path.read_text(encoding="utf-8"))
    if not review:
        print(f"{review_path.name} is empty - nothing to review.")
        return
    vocab = Vocab()
    regions = templates = None
    if learn:
        try:
            regions = load_config(Path(__file__).resolve().parent / "config" / "crop_regions.json")
            templates = LevelTemplates.load()
        except Exception as e:
            print(f"(level learning off: {e})")

    keep, dropped, accepted = [], 0, 0
    for n, entry in enumerate(review, 1):
        card = entry["card"]
        quit_now = False
        while True:
            errs = show(card, entry, n, len(review), vocab)
            print(MENU)
            try:
                choice = input("> ").strip().lower()
            except EOFError:
                quit_now = True
                break
            if choice.isdigit() and 0 <= int(choice) <= 9:
                edit_field(int(choice), card, vocab)
            elif choice == "a":
                if errs:
                    print("  ! still invalid - fix the X lines above before accepting")
                    continue
                entry["notes"], entry["errors"] = [], []
                accepted += 1
                print("  accepted")
                taught = teach_level(entry, card, shots_dir, regions, templates)
                if taught:
                    print(f"  {taught}")
                break
            elif choice == "d":
                dropped += 1
                print("  dropped")
                card = None
                break
            elif choice == "o":
                if not open_shot(entry.get("src"), shots_dir):
                    print("  ! no --shots directory set, or frame not found there")
            elif choice == "q":
                quit_now = True
                break
            else:
                print("  ? unknown option")
        if quit_now:
            keep.extend(review[n - 1:])
            print("\nstopping here; the rest stay in the review file")
            break
        if card is not None:
            keep.append(entry)

    if keep:
        review_path.write_text(json.dumps(keep, indent=2), encoding="utf-8")
    elif review_path.exists():
        review_path.unlink()  # nothing left outstanding — don't leave a "[]" behind
    print(f"\n{accepted} accepted, {dropped} dropped.")
    if accepted:
        print("merging...")
        merge(stem, cards_dir)


def open_shot(src, shots_dir):
    if not src or not shots_dir:
        return False
    hit = next(Path(shots_dir).rglob(src), None)
    if hit is None:
        return False
    try:
        os.startfile(str(hit))  # noqa: S606 - Windows only, this is the point
    except AttributeError:
        return False
    return True


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("stem", nargs="?", default="cards", help="e.g. cards-6")
    p.add_argument("--shots", default=os.environ.get("P5X_SHOTS"),
                   help="screenshots directory, searched recursively, for [o]pen")
    p.add_argument("--dir", default=str(HERE), help="where the json files live")
    p.add_argument("--no-learn", action="store_true",
                   help="do not record confirmed level renders as templates (see levels.py)")
    a = p.parse_args()
    walk(a.stem, a.dir, a.shots, learn=not a.no_learn)
