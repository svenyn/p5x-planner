"""Covers autowalk's walk, its position model and its stop conditions.

Nothing here sends a key, clicks anything or grabs a screen: Walker takes its
sender, its frame source, its focus guard and its tab clicker as arguments
precisely so the loop that decides when to stop can be run in a test. The
Windows input path underneath is a handful of ctypes declarations that either
work on the machine or do not, and no test here can tell you which.

FakeGame is a card list the way the real one behaves under WASD: two columns,
D/A move within a row, S/W move a row, nothing moves off an edge or past the
last card, and a tab click shows a different list. It records which card each
frame was so a test can ask exactly which cards the reader was handed.
"""
import pytest

from autowalk import Walker, parse_tabs, walk_keys
from panel_ocr import TAB_ORDER
from tests.test_watch import REGIONS, frame
from watch import PanelWatcher


def test_the_cycle_is_one_key_per_card():
    assert walk_keys("DSAS", 6) == ["D", "S", "A", "S", "D", "S"]
    assert walk_keys("DSAS", 1) == ["D"]
    assert walk_keys("dsas", 4) == ["D", "S", "A", "S"]


def test_an_empty_pattern_is_refused():
    with pytest.raises(ValueError):
        walk_keys("", 4)


def test_tabs_all_starts_from_the_lit_tab():
    assert parse_tabs("all", "Moon") == ["Moon", "Star", "Sky", "Space", "Sun"]
    assert parse_tabs("all", None) == TAB_ORDER
    assert parse_tabs("sun, moon", "Sky") == ["Sun", "Moon"]
    assert parse_tabs(None, "Star") == ["Star"]
    with pytest.raises(ValueError):
        parse_tabs("Planet", "Sun")


class FakeGame:
    """A two-column card list per tab. `drop` holds 1-based key numbers the
    game swallows, the way a laggy client drops an input. `wrap` makes a
    horizontal key at the edge of a row land on the row's other card instead of
    staying put — which is what the real client does, and what lost the first
    card when the rewind pressed A blindly."""

    def __init__(self, tabs=None, tab="Sun", index=0, drop=(), reset_on_switch=True,
                 switch_works=True, wrap=False, lone_jump=1, squash_jump=False,
                 swallow_clicks=0):
        self.tabs = tabs or {"Sun": 7}
        self.tab, self.index = tab, index
        self.keys, self.clicks = [], []
        self.drop = set(drop)
        self.reset_on_switch, self.switch_works, self.wrap = reset_on_switch, switch_works, wrap
        # clicks on a tab the game ignores before one takes — a dropped click,
        # the mouse counterpart of `drop`
        self.swallow_clicks = swallow_clicks
        # what D does on the last row's lone card: the right-hand card this many
        # rows up — one row on the Space tab, two on the Moon tab, as observed
        self.lone_jump = lone_jump
        # report a two-row jump as one row, as the real grid read did on Moon
        self.squash_jump, self._jumped = squash_jump, 0
        self.frames = {}   # frame bytes -> (tab, index)
        self.top = max(0, index // 2 - 5)   # first visible row (the list scrolls with the cursor)

    @property
    def n(self):
        return self.tabs[self.tab]

    ROWS_VISIBLE = 6

    def send(self, key):
        self.keys.append(key)
        if len(self.keys) in self.drop:
            return
        i, col = self.index, self.index % 2
        self._jumped = 0
        if key == "D" and col == 0 and i + 1 < self.n:
            self.index += 1
        elif key == "D" and self.wrap and col == 1:
            self.index -= 1                 # right card: wraps to the row's left card
        elif key == "D" and self.wrap and i > 0:
            # the last row's lone card: jumps to the right-hand card `lone_jump`
            # rows up (index - 1 for one row, index - 3 for two), as far as exists
            self.index = max(1, i - (2 * self.lone_jump - 1))
            self._jumped = (i - self.index + 1) // 2
        elif key == "A" and col == 1:
            self.index -= 1
        elif key == "A" and col == 0 and self.wrap and i + 1 < self.n:
            self.index += 1
        elif key == "S" and i + 2 < self.n:
            self.index += 2
        elif key == "W" and i - 2 >= 0:
            self.index -= 2
        if self.index == i:
            return                          # a key that moved nothing scrolls nothing
        row = self.index // 2
        self.top = min(self.top, row)
        self.top = max(self.top, row - (self.ROWS_VISIBLE - 1))

    def read_column(self, f):
        return self.frames[f.tobytes()][1] % 2

    def read_cursor(self, f):
        """(column, row fraction within the visible rows), like detect_grid_cursor."""
        tab, index = self.frames[f.tobytes()]
        row = index // 2
        if self.squash_jump and self._jumped > 1 and index == self.index:
            row += self._jumped - 1
        if not self.top <= index // 2 < self.top + self.ROWS_VISIBLE:
            return None, None               # the selected card is scrolled out of view
        return index % 2, (row - self.top) / (self.ROWS_VISIBLE - 1)

    def grab(self):
        f = frame(1000 * (TAB_ORDER.index(self.tab) + 1) + self.index)
        self.frames[f.tobytes()] = (self.tab, self.index)
        return f

    def click(self, slot):
        self.clicks.append(slot)
        if self.switch_works and self.clicks.count(slot) > self.swallow_clicks:
            self.tab = slot
            if self.reset_on_switch:
                self.index, self.top = 0, 0

    def read_slot(self, f):
        return self.tab

    def which(self, f):
        return self.frames[f.tobytes()]


def build(fake, guard=None, **kw):
    watcher = PanelWatcher(REGIONS, settle_frames=1)
    got = []
    w = Walker(watcher, fake.send, fake.grab, guard=guard, interval=0,
               settle_timeout=0.05, fps=1000, on_capture=got.append,
               clicker=fake.click, slot_reader=fake.read_slot, tab_timeout=0.05,
               cursor_reader=fake.read_cursor, **kw)
    w.got = got
    return w


def read_cards(fake, walker):
    return [fake.which(f) for f in walker.got]


quiet = dict(log=lambda *a: None)


# ------------------------------ one tab ------------------------------

@pytest.mark.parametrize("n", [1, 2, 5, 6, 7, 12])
def test_every_card_is_read_exactly_once_and_the_list_ends_the_walk(n):
    fake = FakeGame({"Sun": n})
    walker = build(fake)
    why = walker.run(walk_keys("DSAS", 500), **quiet)
    assert why == "end"
    cards = read_cards(fake, walker)
    assert sorted(cards) == [("Sun", i) for i in range(n)]
    assert len(cards) == n                       # no card twice
    assert walker.cards == n
    # The end costs one cycle of keys (dead ones tried twice), not --count.
    assert walker.sent <= n + 10


def test_the_bounce_at_the_end_is_revisits_not_reads():
    fake = FakeGame({"Sun": 6})
    walker = build(fake)
    walker.run(walk_keys("DSAS", 500), **quiet)
    # D S A S D S A S D | S(nothing) A(back to 4) S(nothing) D(back to 5): 2 revisits
    assert walker.revisits == 2
    assert len(walker.got) == 6


def test_a_key_the_game_drops_mid_list_costs_no_card():
    # Key 2 (the S off card 1) is swallowed. The A that follows lands on card 0,
    # already read, which is dropped as a revisit — and the walk is back in phase.
    fake = FakeGame({"Sun": 7}, drop={2})
    walker = build(fake)
    assert walker.run(walk_keys("DSAS", 500), **quiet) == "end"
    cards = read_cards(fake, walker)
    assert sorted(cards) == [("Sun", i) for i in range(7)]
    assert len(cards) == 7


def test_it_stops_once_the_panel_stops_responding():
    # Four dead keys in a row means the list is not listening any more, and
    # continuing would be typing into whatever is on screen instead.
    fake = FakeGame({"Sun": 50}, drop=set(range(1, 100)))
    walker = build(fake, stuck_limit=4)
    assert walker.run(walk_keys("DSAS", 40), **quiet) == "end"
    # each dead key is tried twice before it counts
    assert walker.sent == 8 and walker.retries == 4


def test_without_rewind_the_card_on_screen_is_read_first():
    # A run of N keys reads N+1 cards: the card already showing is a real card.
    fake = FakeGame({"Sun": 50})
    walker = build(fake)
    assert walker.run(walk_keys("DSAS", 4), **quiet) == "done"
    assert walker.sent == 4
    assert read_cards(fake, walker) == [("Sun", 0), ("Sun", 1), ("Sun", 3), ("Sun", 2), ("Sun", 4)]


def test_count_is_a_hard_ceiling():
    fake = FakeGame({"Sun": 50})
    walker = build(fake)
    assert walker.run(walk_keys("DSAS", 5), **quiet) == "done"
    assert walker.sent == 5


def test_losing_focus_stops_before_the_next_key():
    fake = FakeGame({"Sun": 50})
    focused = {"yes": True}
    real_send = fake.send

    def send(key):
        real_send(key)
        if len(fake.keys) == 3:
            focused["yes"] = False   # user alt-tabs away

    walker = build(fake, guard=lambda: focused["yes"])
    walker.sender = send
    assert walker.run(walk_keys("DSAS", 20), **quiet) == "unfocused"
    assert len(fake.keys) == 3


def test_the_guard_is_checked_before_the_very_first_key():
    fake = FakeGame({"Sun": 5})
    walker = build(fake, guard=lambda: False)
    assert walker.run(walk_keys("DSAS", 4), **quiet) == "unfocused"
    assert fake.keys == []
    assert walker.run(walk_keys("DSAS", 4), rewind=True, **quiet) == "unfocused"
    assert fake.keys == []


def test_the_reader_can_end_the_run_early():
    # This is --expect / --stop-after reaching back into the walk: once the
    # session says it has what it came for, there is nothing left to walk to.
    fake = FakeGame({"Sun": 50})
    enough = {"yes": False}
    walker = build(fake, stuck_limit=99)
    walker.should_stop = lambda: enough["yes"]
    walker.on_capture = lambda f: enough.__setitem__("yes", len(fake.keys) >= 3)
    assert walker.run(walk_keys("DSAS", 50), **quiet) == "satisfied"
    assert walker.sent == 3


# ------------------------------ rewind ------------------------------

@pytest.mark.parametrize("wrap", [False, True])
@pytest.mark.parametrize("start", [0, 1, 4, 5, 6])
def test_rewind_reads_the_whole_list_from_any_starting_card(start, wrap):
    fake = FakeGame({"Sun": 7}, index=start, wrap=wrap)
    walker = build(fake)
    assert walker.run(walk_keys("DSAS", 500), rewind=True, **quiet) == "end"
    cards = read_cards(fake, walker)
    assert sorted(cards) == [("Sun", i) for i in range(7)]
    assert len(cards) == 7
    assert cards[0] == ("Sun", 0)


def test_rewind_from_the_first_card_presses_no_horizontal_key():
    # The real client wraps: an A on the left card lands on the right one. So the
    # grid is read instead, and from the left column nothing horizontal is sent.
    fake = FakeGame({"Sun": 7}, wrap=True)
    walker = build(fake)
    assert walker.rewind(**quiet) == ("ok", 0)
    assert fake.keys == ["W", "W"]
    assert read_cards(fake, walker) == [("Sun", 0)]
    assert walker.pos == (0, 0) and walker.visited == {(0, 0)}


def test_rewind_from_the_right_column_presses_a_once_and_checks_it_took():
    fake = FakeGame({"Sun": 7}, index=1, wrap=True)
    walker = build(fake)
    assert walker.rewind(**quiet) == ("ok", 0)
    assert fake.keys == ["W", "W", "A"]
    assert read_cards(fake, walker) == [("Sun", 0)]


def test_rewind_refuses_to_finish_blind():
    # No grid box calibrated: rather than guess the column and walk out of
    # step, stop before the first walk key and say what to do.
    fake = FakeGame({"Sun": 7}, index=1)
    walker = build(fake)
    walker.cursor_reader = None
    assert walker.run(walk_keys("DSAS", 500), rewind=True, **quiet) == "lost"
    assert all(k == "W" for k in fake.keys)


def test_rewind_gives_up_if_a_never_moves_the_cursor_left():
    fake = FakeGame({"Sun": 7}, index=1, drop=set(range(1, 100)))
    walker = build(fake)
    status, _ = walker.rewind(**quiet)
    assert status == "lost"
    assert fake.keys.count("A") == 3


@pytest.mark.parametrize("lone_jump", [1, 2])
@pytest.mark.parametrize("n", [1, 2, 3, 5, 6, 7, 9, 12, 13, 21])
def test_a_wrapping_client_is_walked_completely_and_ends(n, lone_jump):
    # Odd counts are the case that looped on the real client: from the lone
    # last card, D jumps back up to a right-hand card one row up (Space tab) or
    # two rows up (Moon tab), which the key alone would book as a new row.
    fake = FakeGame({"Sun": n}, wrap=True, lone_jump=lone_jump)
    walker = build(fake)
    assert walker.run(walk_keys("DSAS", 500), **quiet) == "end"
    cards = read_cards(fake, walker)
    assert sorted(cards) == [("Sun", i) for i in range(n)] and len(cards) == n
    assert walker.sent <= n + 12


def test_the_lone_last_card_bounce_is_recognised_from_the_row_change():
    fake = FakeGame({"Sun": 5}, wrap=True)
    walker = build(fake)
    walker.run(walk_keys("DSAS", 500), **quiet)
    # D from card 4 (row 2, alone) landed on card 3 (row 1): a row change the
    # key cannot explain, so the model was corrected instead of reading it again.
    assert walker.resyncs >= 1
    assert len(walker.got) == 5


def test_the_moon_tab_case_nine_cards_two_rows_up_ends_after_one_cycle():
    # The exact run the user pasted: nine cards, D from card 8 lands on card 5.
    fake = FakeGame({"Sun": 9}, wrap=True, lone_jump=2)
    walker = build(fake)
    assert walker.run(walk_keys("DSAS", 500), **quiet) == "end"
    assert len(walker.got) == 9
    # ...and it ended within one cycle of the last new card, not after --count
    assert walker.sent <= 9 + 8


def test_the_moon_tab_case_ends_even_when_the_grid_under_measures_the_jump():
    # Third live run: D from card 8 went two rows up to card 5, but the frame
    # read as one row, so the model sat a row too low and the S after it read
    # card 6 as new. The landing card is one already read, and the panel says
    # so — that alone ends the tab, whatever the row estimate.
    fake = FakeGame({"Sun": 9}, wrap=True, lone_jump=2, squash_jump=True)
    walker = build(fake)
    assert walker.run(walk_keys("DSAS", 500), **quiet) == "end"
    assert len(walker.got) == 9
    assert walker.sent <= 9 + 4


def test_two_identical_cards_in_a_tab_are_both_read():
    # The lookalike check must not eat a real duplicate: only a panel that
    # matches an earlier read AND arrives on a key the grid overruled counts.
    fake = FakeGame({"Sun": 6})
    fake.grab_real = fake.grab
    def grab():
        f = fake.grab_real()
        if fake.index == 4:   # card 4 shows the same pixels as card 1
            f = frame(1000 * (TAB_ORDER.index(fake.tab) + 1) + 1)
            fake.frames[f.tobytes()] = (fake.tab, 4)
        return f
    walker = build(fake)
    walker.grabber = grab
    assert walker.run(walk_keys("DSAS", 500), **quiet) == "end"
    assert len(walker.got) == 6


def test_a_dropped_d_is_retried_and_costs_no_card():
    # Key 1 (the D off card 0) is swallowed. Unlike a dropped S, nothing later
    # in the cycle ever comes back for card 1 — so the key is sent again.
    for wrap in (False, True):
        fake = FakeGame({"Sun": 8}, wrap=wrap, drop={1})
        walker = build(fake)
        assert walker.run(walk_keys("DSAS", 500), **quiet) == "end"
        cards = read_cards(fake, walker)
        assert sorted(cards) == [("Sun", i) for i in range(8)] and len(cards) == 8
        assert walker.retries >= 1  # the dropped D, plus the dead keys at the end of the list


def test_a_twice_dropped_d_on_a_wrapping_client_is_resynced_from_the_grid():
    # Both the D and its retry are swallowed. The A two keys later then wraps
    # from the left card instead of moving left; without the grid read the
    # model would be a column out for the rest of the tab and misfile every
    # card after. Card 1 is lost — nothing can get back to it — but nothing else.
    fake = FakeGame({"Sun": 8}, wrap=True, drop={1, 2})
    walker = build(fake)
    assert walker.run(walk_keys("DSAS", 500), **quiet) == "end"
    cards = read_cards(fake, walker)
    assert sorted(cards) == [("Sun", i) for i in range(8) if i != 1] and len(cards) == 7
    assert walker.resyncs >= 1


# ------------------------------ several tabs ------------------------------

def test_every_tab_is_walked_to_its_end_in_turn():
    fake = FakeGame({"Sun": 5, "Moon": 4, "Star": 3}, tab="Sun")
    walker = build(fake)
    why, report = walker.run_tabs(["Sun", "Moon", "Star"], 500, current="Sun", **quiet)
    assert why == "done"
    assert fake.clicks == ["Moon", "Star"]       # the lit tab needs no click
    assert report == [("Sun", 5, "end"), ("Moon", 4, "end"), ("Star", 3, "end")]
    cards = read_cards(fake, walker)
    expected = ([("Sun", i) for i in range(5)] + [("Moon", i) for i in range(4)]
                + [("Star", i) for i in range(3)])
    assert sorted(cards) == sorted(expected)
    assert len(cards) == 12
    # ...and in that order: a tab is finished before the next one is clicked.
    assert [c[0] for c in cards] == ["Sun"] * 5 + ["Moon"] * 4 + ["Star"] * 3


def test_a_tab_that_remembers_its_cursor_is_still_read_from_the_top():
    fake = FakeGame({"Sun": 4, "Moon": 9}, tab="Sun", reset_on_switch=False)
    walker = build(fake)
    why, report = walker.run_tabs(["Sun", "Moon"], 500, current="Sun", **quiet)
    assert why == "done"
    cards = read_cards(fake, walker)
    assert sorted(c for c in cards if c[0] == "Moon") == [("Moon", i) for i in range(9)]
    assert len(cards) == 13


def test_a_tab_that_does_not_switch_stops_the_run_before_any_key():
    fake = FakeGame({"Sun": 3, "Moon": 3}, tab="Sun", switch_works=False)
    walker = build(fake)
    why, report = walker.run_tabs(["Sun", "Moon"], 500, current="Sun", **quiet)
    assert why == "tab"
    assert report == [("Sun", 3, "end"), ("Moon", 0, "tab")]
    # the click is tried once more before giving up, and never a third time
    assert fake.clicks == ["Moon", "Moon"]
    # Nothing was typed after the failed clicks: the last keys are Sun's end-of-list cycle.
    assert len(read_cards(fake, walker)) == 3


def test_a_swallowed_tab_click_is_retried_once_and_the_tab_still_walked():
    fake = FakeGame({"Sun": 3, "Moon": 4}, tab="Sun", swallow_clicks=1)
    walker = build(fake)
    why, report = walker.run_tabs(["Sun", "Moon"], 500, current="Sun", **quiet)
    assert why == "done"
    assert fake.clicks == ["Moon", "Moon"]
    assert report == [("Sun", 3, "end"), ("Moon", 4, "end")]
    assert sorted(c for c in read_cards(fake, walker) if c[0] == "Moon") == [("Moon", i) for i in range(4)]


def test_a_failed_switch_keeps_the_last_frame_and_says_what_the_strip_read():
    fake = FakeGame({"Sun": 3, "Moon": 3}, tab="Sun", switch_works=False)
    walker = build(fake)
    lines = []
    walker.run_tabs(["Sun", "Moon"], 500, current="Sun", log=lines.append)
    assert walker.last_tab_frame is not None            # for main() to save next to the output
    assert any("the strip reads Sun" in line for line in lines)


def test_without_a_clicker_a_second_tab_is_refused_not_walked():
    fake = FakeGame({"Sun": 3, "Moon": 3}, tab="Sun")
    walker = build(fake)
    walker.clicker = None
    why, report = walker.run_tabs(["Sun", "Moon"], 500, current="Sun", **quiet)
    assert why == "tab" and fake.clicks == []


# ------------------------------ the run log ------------------------------

def test_the_trace_accounts_for_every_card_and_every_revisit():
    """The record the two stalled Space runs of Sep 2026 did not leave: what
    each key did, so a walk that stops early can be replayed from its log."""
    lines = []
    fake = FakeGame({"Sun": 6}, index=3)
    walker = build(fake, trace=lines.append)
    assert walker.run(walk_keys("DSAS", 500), rewind=True, **quiet) == "end"
    assert sum("new card #" in ln for ln in lines) == walker.cards == 6
    assert sum("already read" in ln for ln in lines) == walker.revisits
    assert any(ln.startswith("rewind W: nothing moved (2/2)") for ln in lines)
    # every walk key that settled says what the grid showed and where the model went
    moved = [ln for ln in lines if ln[:2] in ("D:", "S:", "A:") and "model" in ln]
    assert moved and all("grid col" in ln and "->" in ln for ln in moved if "nothing moved" not in ln)


def test_the_run_log_copies_the_screen_and_keeps_the_trace_to_the_file(tmp_path, capsys):
    from autowalk import RunLog
    log = RunLog(tmp_path / "cards-3.log").start()
    try:
        print("  Space: 49 card(s) — end")
        log.trace("S: grid unreadable, model (17, 0) -> (18, 0)")
    finally:
        log.close()
    shown = capsys.readouterr().out
    assert "49 card(s)" in shown and "grid unreadable" not in shown
    text = (tmp_path / "cards-3.log").read_text(encoding="utf-8")
    assert "49 card(s)" in text and "grid unreadable" in text
    # a second run into the same name appends rather than wiping the first
    RunLog(tmp_path / "cards-3.log").start().close()
    assert "49 card(s)" in (tmp_path / "cards-3.log").read_text(encoding="utf-8")


def test_a_rewind_that_cannot_see_the_cursor_keeps_the_screen_it_saw():
    """The Moon tab of Sep 27: switched to, two dead W presses, no selection
    frame — and nothing kept to show what was on screen."""
    fake = FakeGame({"Sun": 7}, index=0)
    walker = build(fake)
    walker.cursor_reader = lambda f: (None, None)
    assert walker.run(walk_keys("DSAS", 500), rewind=True, **quiet) == "lost"
    assert walker.lost_frame is not None
    assert fake.which(walker.lost_frame) == ("Sun", 0)


def test_a_tab_whose_first_card_is_scrolled_out_of_view_is_still_read_from_the_top():
    """Sky, Sep 27: the tab put its selection back on the first card but kept
    the list scrolled to its last rows. No frame in view and W moves nothing;
    S then W brings the first card back into view without skipping it."""
    fake = FakeGame({"Sky": 30}, tab="Sky")
    fake.top = 9                                  # showing rows 9-14; the selection is row 0
    walker = build(fake)
    assert walker.run(walk_keys("DSAS", 500), rewind=True, **quiet) == "end"
    assert sorted(read_cards(fake, walker)) == [("Sky", i) for i in range(30)]
    assert fake.keys[:4] == ["W", "W", "S", "W"]


def test_a_hidden_first_card_on_a_list_that_cannot_scroll_still_gives_up():
    # a single row: S moves nothing (sent twice), so there is nothing to bring
    # into view and the rewind stops with the screen it saw, as before
    fake = FakeGame({"Sky": 2}, tab="Sky")
    fake.top = 3
    walker = build(fake)
    assert walker.run(walk_keys("DSAS", 500), rewind=True, **quiet) == "lost"
    assert fake.keys == ["W", "W", "S", "S"]
    assert walker.lost_frame is not None
