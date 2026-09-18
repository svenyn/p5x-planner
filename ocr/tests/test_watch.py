"""Drives watch.py's settle/miss state machine frame by frame.

The point of PanelWatcher being pure — no screen grabbing, no clock — is that
the two behaviours worth trusting can be tested without a running game: that a
settled panel is read exactly once, and that a panel tapped past before it
settles is counted rather than silently lost.

Frames are seeded noise rather than rendered panels on purpose. What is under
test is "did the picture change and stay changed", which is the same question
whatever the pixels are, and noise gives well-separated hashes without needing
a TTF on the machine (test_panel_ocr.py skips itself when Arial is missing).
"""
import json

import numpy as np
from PIL import Image

from watch import KnownIndex, PanelWatcher, panel_signature, signature_fields

REGIONS = {
    "title": [0.0, 0.0, 1.0, 0.25],
    "level": [0.0, 0.25, 1.0, 0.5],
    "sub1_value": [0.0, 0.5, 1.0, 0.75],
    "slot_tabs": [0.0, 0.75, 1.0, 1.0],
    "grid": [0.0, 0.75, 0.5, 1.0],
    "main_label": [0.5, 0.75, 1.0, 1.0],
}


def frame(seed):
    """A deterministic, distinctive frame. The same seed is the same card."""
    rng = np.random.RandomState(seed)
    return Image.fromarray(rng.randint(0, 256, (96, 96, 3), dtype=np.uint8))


def feed_all(watcher, image, n):
    return [watcher.feed(image) for _ in range(n)]


def test_slot_tabs_is_not_part_of_the_signature():
    # The lit tab is identical for every card in a tab, so including it would
    # only dilute the per-field distances that distinguish two cards.
    assert "slot_tabs" not in signature_fields(REGIONS)
    # ...and neither is the grid: it moves with the cursor, not with the card.
    assert signature_fields(REGIONS) == ["level", "sub1_value", "title"]


def test_a_scrolling_main_label_is_not_a_new_panel():
    # The main stat's label is a looping marquee when the name is too long for
    # its box, so it differs between frames of the same card. It is not part
    # of the signature: a card whose label alone keeps moving is one card, read
    # once, however long it stays on screen.
    assert "main_label" not in signature_fields(REGIONS)
    w = PanelWatcher(REGIONS, settle_frames=2)
    base = frame(1)
    assert feed_all(w, base, 3).count("capture") == 1
    for tick in range(2, 12):
        scrolled = base.copy()
        scrolled.paste(frame(100 + tick).crop((0, 0, 48, 24)), (48, 72))   # only the label box moves
        assert w.feed(scrolled) is None
    assert w.captured == 1 and w.missed == 0
    # ...while a change anywhere else on the panel is still a new card
    assert feed_all(w, frame(2), 3).count("capture") == 1


def test_identical_frames_have_distance_zero():
    fields = signature_fields(REGIONS)
    a = panel_signature(frame(1), REGIONS, fields)
    b = panel_signature(frame(1), REGIONS, fields)
    assert a == b


def test_a_settled_panel_captures_exactly_once():
    w = PanelWatcher(REGIONS, settle_frames=3)
    events = feed_all(w, frame(1), 10)
    assert events.count("capture") == 1
    # ...on the third frame, not the first — that delay is the whole animation guard
    assert events[:3] == [None, None, "capture"]
    assert w.captured == 1
    assert w.missed == 0


def test_each_new_card_captures_once():
    w = PanelWatcher(REGIONS, settle_frames=2)
    for seed in (1, 2, 3):
        feed_all(w, frame(seed), 4)
    assert w.captured == 3
    assert w.missed == 0


def test_a_card_tapped_past_is_counted_not_captured():
    w = PanelWatcher(REGIONS, settle_frames=3)
    feed_all(w, frame(1), 5)          # read properly
    w.feed(frame(2))                  # flashes by — one frame, never settles
    events = feed_all(w, frame(3), 5)  # and this one is held
    assert "capture" in events
    assert w.captured == 2            # cards 1 and 3
    assert w.missed == 1              # card 2


def test_the_miss_is_reported_on_the_frame_it_happens():
    w = PanelWatcher(REGIONS, settle_frames=3)
    feed_all(w, frame(1), 4)
    w.feed(frame(2))
    assert w.feed(frame(3)) == "miss"


def test_flicking_back_to_the_card_just_read_is_not_a_miss():
    # Coming back to the panel already captured is not a card that went unread,
    # so it must not beep at you.
    w = PanelWatcher(REGIONS, settle_frames=3)
    feed_all(w, frame(1), 4)
    w.feed(frame(1))
    feed_all(w, frame(2), 4)
    assert w.missed == 0


def test_settle_of_one_captures_immediately():
    w = PanelWatcher(REGIONS, settle_frames=1)
    assert w.feed(frame(1)) == "capture"


def test_reset_drops_the_candidate_but_not_the_last_capture():
    # Leaving the inventory screen mid-animation must not later count as a miss,
    # and coming back to the same card must not re-read it.
    w = PanelWatcher(REGIONS, settle_frames=3)
    feed_all(w, frame(1), 4)
    w.feed(frame(2))
    w.reset()
    feed_all(w, frame(1), 4)
    assert w.captured == 1
    assert w.missed == 0


# ------------------------------ known inventory ------------------------------

def card(level=25, subs=None, **kw):
    base = {"slot": "Star", "set": "Futility", "rarity": 5, "main": "Crit Rate",
            "level": level, "subs": subs if subs is not None else [{"stat": "ATK%", "value": 4.2}]}
    base.update(kw)
    return base


def test_known_index_holds_an_identical_card():
    assert KnownIndex([card()]).holds(card())


def test_known_index_tolerates_a_last_digit_of_ocr_drift():
    idx = KnownIndex([card(subs=[{"stat": "ATK%", "value": 4.2}])])
    assert idx.holds(card(subs=[{"stat": "ATK%", "value": 4.23}]))
    assert not idx.holds(card(subs=[{"stat": "ATK%", "value": 4.9}]))


def test_known_index_rejects_a_different_level():
    assert not KnownIndex([card(level=25)]).holds(card(level=20))


def test_known_index_rejects_different_substat_names():
    idx = KnownIndex([card(subs=[{"stat": "ATK%", "value": 4.2}])])
    assert not idx.holds(card(subs=[{"stat": "Speed", "value": 4.2}]))


def test_known_index_rejects_a_different_fingerprint():
    idx = KnownIndex([card()])
    assert not idx.holds(card(set="Strife"))
    assert not idx.holds(card(slot="Sky"))
    assert not idx.holds(card(rarity=4))
    assert not idx.holds(card(main="Crit Multiplier"))


def test_known_index_matches_against_any_card_in_the_pool():
    # Hundreds of cards can share one fingerprint — Sun/Power 5★ HP is a sixth
    # of this inventory — so a hit anywhere in the pool counts.
    pool = [card(level=n) for n in range(0, 26)]
    assert KnownIndex(pool).holds(card(level=13))


# ------------------------------ end to end ------------------------------

def test_watch_writes_a_cards_file_from_a_scripted_screen(tmp_path, vocab, monkeypatch):
    """Runs the real watch() loop against a fake screen.

    Worth having as a test rather than only against the game: the grab loop,
    the OCR worker thread, the queue drain on Ctrl-C and the file write are the
    parts that deadlock rather than fail, and none of them are exercised by the
    state-machine tests above.
    """
    from tests.test_panel_ocr import _build_panel

    import watch as watch_mod

    one, regions = _build_panel(
        title="[Futility]", level_text="Lv.25", main_label="Crit Rate",
        subs=[("Damage Mult.+", "2.1%"), ("HP", "2.9%"), ("Defense", "4.1%"), ("Pierce Rate", "3.9%")],
    )
    two, _ = _build_panel(
        title="[Opulence]", level_text="Lv.20", main_label="Crit Multiplier",
        subs=[("Damage Mult.+", "3.1%"), ("Speed", "2.5"), ("SP Recovery", "11.2%"),
              ("Defense", "4.6%")],
    )

    # Each card held long enough to settle, then the user hits Ctrl-C.
    script = [one] * 3 + [two] * 3

    def fake_grab(*a, **kw):
        if not script:
            raise KeyboardInterrupt
        return script.pop(0)

    monkeypatch.setattr(watch_mod.ImageGrab, "grab", fake_grab)

    out = tmp_path / "cards.json"
    session, watcher, out_path, _ = watch_mod.watch(
        regions, vocab, out, rarity=5, slot="Star", fps=1000, settle=0.002,
        quiet_misses=True,
    )

    assert watcher.captured == 2
    assert watcher.missed == 0
    written = json.loads(out_path.read_text(encoding="utf-8"))
    assert len(written["cards"]) + len(session.invalid) == 2
    for c in written["cards"]:
        assert c["rarity"] == 5 and c["slot"] == "Star"


def test_watch_stops_itself_once_expect_is_met(tmp_path, vocab, monkeypatch):
    from tests.test_panel_ocr import _build_panel

    import watch as watch_mod

    one, regions = _build_panel(
        title="[Futility]", level_text="Lv.25", main_label="Crit Rate",
        subs=[("Damage Mult.+", "2.1%"), ("HP", "2.9%"), ("Defense", "4.1%"), ("Pierce Rate", "3.9%")],
    )
    # Held indefinitely: only --expect can end this run, so if the stop rule
    # does not fire the test hangs rather than quietly passing.
    monkeypatch.setattr(watch_mod.ImageGrab, "grab", lambda *a, **kw: one)

    session, watcher, out_path, _ = watch_mod.watch(
        regions, vocab, tmp_path / "cards.json", rarity=5, slot="Star",
        known=KnownIndex([]), expect=1, fps=1000, settle=0.002, quiet_misses=True,
    )
    assert session.new_count == 1
