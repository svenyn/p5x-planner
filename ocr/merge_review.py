"""Merge a batch's *-review.json back into its cards.json, after you have
corrected the review entries by hand.

    python merge_review.py cards-6

An entry is merged only once its "errors" AND "notes" lists are both empty — the
same rule pipeline.py used to send it to review in the first place. Clearing a
note is how you say "I looked at the screenshot and this is right now"; it is
not paperwork. validate_card cannot stand in for it, because the misreads that
reach review are usually *legal* values: a real Lv.18 read as Lv.8 passes every
range check there is (0-25 for a 5-star) and would merge silently on a validity
test alone. That case is exactly why this refuses on notes, not just errors.

Cards are re-validated on the way in too, so a correction typed wrong — a main
stat the slot cannot roll, a level past the rarity's cap — is held rather than
written. Re-runnable: entries already in cards.json (matched on src) are skipped,
so merging twice is a no-op rather than a duplicate.

Writes both files: merged cards are appended to cards.json and removed from
*-review.json, leaving that file as the list of what is still outstanding.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# validate_card's level message carries a '★', which a cp1252 console cannot
# encode — without this the script dies on the one path that matters most, the
# one reporting a bad correction back to you.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from validate import validate_card  # noqa: E402
from vocab import Vocab  # noqa: E402


def merge(stem, cards_dir=HERE):
    cards_path = Path(cards_dir) / f"{stem}.json"
    review_path = Path(cards_dir) / f"{stem}-review.json"
    vocab = Vocab()

    # pipeline.py (and this function, below) only writes *-review.json when
    # there's something in it, so a batch that came back completely clean has
    # no file here at all — that's success, not an error.
    if not review_path.exists():
        print(f"no {review_path.name} — nothing to merge")
        return [], []

    data = json.loads(cards_path.read_text(encoding="utf-8"))
    review = json.loads(review_path.read_text(encoding="utf-8"))
    have = {c.get("src") for c in data["cards"]}

    merged, kept = [], []
    for entry in review:
        card = entry["card"]
        if card.get("src") in have:
            print(f'  skip    {card.get("src")}  already in {cards_path.name}')
            continue
        errs = validate_card(card, vocab) + list(entry.get("errors") or [])
        open_notes = list(entry.get("notes") or [])
        if errs or open_notes:
            kept.append(entry)
            print(f'  HELD    {card.get("src")}  '
                  f'{"; ".join(errs) or f"{len(open_notes)} unresolved note(s)"}')
            for n in open_notes:
                print(f"             - {n}")
        else:
            merged.append(card)
            print(f'  merge   {card.get("src")}  {card.get("slot")} {card.get("set")} '
                  f'Lv{card.get("level")} {card.get("main")}')

    if merged:
        data["cards"].extend(merged)
        cards_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    if kept:
        review_path.write_text(json.dumps(kept, indent=2), encoding="utf-8")
    elif review_path.exists():
        review_path.unlink()  # nothing left outstanding — don't leave a "[]" behind
    print(f"\n{len(merged)} merged into {cards_path.name} "
          f"({len(data['cards'])} cards total), {len(kept)} left"
          + (f" in {review_path.name}" if kept else ""))
    return merged, kept


if __name__ == "__main__":
    merge(sys.argv[1] if len(sys.argv) > 1 else "cards")
