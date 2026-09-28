"""Sends the WASD walk through the card grid, so watch.py has something to read.

**This is the one thing the rest of ocr/ deliberately does not do.** Everything
else here reads pixels and nothing else, because synthetic input into the game
client is a ToS risk on an account worth thousands of cards. The user weighed
that against the tapping and chose this; it is opt-in, it lives in its own file,
and watch.py neither imports nor starts it. See CLAUDE.md.

Two things it deliberately does NOT do, and should not be made to:

  * **No evasion.** No randomised intervals, no humanised timing, no attempt to
    look like a person. Accepting a risk is not the same as hiding from it, and
    a tool that tries to defeat detection is a different tool with a different
    argument behind it.
  * **No unattended running.** It will not send a key or a click unless the
    window that was in the foreground when you started it is still in the
    foreground, so alt-tab is the stop gesture and a stray D can never land in
    your browser. It also stops on its own once the list runs out, and --count
    is a hard ceiling on how many keys it can ever send per tab.

The walk itself: two cards per row, and D only moves right, so the cycle is
D S A S — (0,0) D> (0,1) S> (1,1) A> (1,0) S> (2,0) and repeat. One keypress per
card.

**It knows where it is, and that is how it knows when to stop.** Every key that
moves the panel moves a (row, column) model of the cursor the same way, and a
card is only handed to the reader when that position is one the walk has not
been on before. At the end of the list the cycle can only bounce between the
last two cards — S moves nothing, A lands on a card already read — so a whole
cycle passes with nothing new, and that ends the tab. Without the position
model the end of the list looked exactly like the middle of it: the bounce
re-reads real cards, the panel keeps changing, and only --count ever stopped
it. A key the game dropped mid-list costs nothing either: the next A lands on
a card already read, which is dropped as a revisit, and the walk resyncs.

**It starts from the top.** Before walking a tab it presses W until nothing moves,
then reads which column the grid's red selection frame is in and presses A only
if it is the right-hand one — so you can start it on any card in the list, and
the cursor is at (0,0) when the walk begins, which is what the position model
assumes. The column is read off the pixels, not assumed from the keys, because
a horizontal key at the edge of a row wraps on the real client rather than
staying put — and from the last row's lone card, D jumps back UP to the row
above. The same read corrects the model's column, and any row change a
horizontal key caused, after every key.
--no-rewind skips the rewind if you have already selected the first card.

**It can switch tabs.** --tabs all clicks each Space/Sun/Moon/Star/Sky tab in
turn (starting from whichever is lit), verifies the strip actually reads the new
tab before sending a key, rewinds, walks to the end, and moves on. That is a
mouse click into the game, the same category of input as the keys, gated by the
same foreground check. The slot is read off the strip per frame as always, so
one cards.json holds all five tabs. Rarity still cannot be read (see
panel_ocr.py), so --rarity is still per run: set the game's rarity filter,
then run once per rarity you own. The click is aimed on the grabbed frame, so
the process is made DPI-aware first and refuses to click if the frame and the
cursor's screen disagree in size: on a scaled desktop (this machine runs 125%)
a DPI-unaware click lands a quarter off, just below the strip, and the strip
never reads the new tab. The cursor is also read back before every press.

Pacing is closed-loop, not a fixed interval. After each keypress it waits for
the panel to actually change and settle — the same PanelWatcher watch.py uses —
before sending the next one, so it cannot outrun the reader however slow the
game is being. --interval is a floor under that, not the schedule.

It reads the cards too, so this is one command that walks the list, OCRs it and
exits. That is a watch.Session driven off this file's frame source rather than
its own grab loop, which is why the dependency runs this way round: the file
that sends input imports the one that only reads pixels, and never the reverse.
`--no-read` turns the reading off if you would rather run watch.py separately.

    python autowalk.py --dry-run --tabs all             # prints the plan, sends nothing
    python autowalk.py --rarity 5 --tabs all            # every 5★ card on every tab, one run
    python autowalk.py --rarity 5                       # just the tab that is open
    python autowalk.py --rarity 5 --count 200 \\
        --known p5x-save.json --stop-after 20           # stops early once caught up
"""
import argparse
import ctypes
import sys
import time
from ctypes import wintypes
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from calibrate import load_config  # noqa: E402
from panel_ocr import (TAB_ORDER, crop_fraction, detect_grid_cursor,  # noqa: E402
                       detect_slot_from_tabs)
from pipeline import unique_out_path  # noqa: E402
from vocab import Vocab  # noqa: E402
from watch import (PanelWatcher, Session, _dpi_aware, ensure_tesseract, finish,  # noqa: E402
                   load_known, panel_signature, resolve_source, signature_distance,
                   signature_fields)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


class RunLog:
    """Copies everything the run prints into `<out>.log`, and takes a per-key
    trace that goes to the file only.

    The two Space-tab runs of Sep 2026 that stopped mid-list left nothing to
    read but their card files: what the grid showed after each key, and where
    the walk thought it was, had scrolled away in a terminal. The trace is that
    record, one line per key; it is too long to print, and the screen output is
    unchanged. Worker threads print too, so writes are serialised.
    """

    def __init__(self, path):
        import threading
        self.path = Path(path)
        self.file = open(self.path, "a", encoding="utf-8")
        self.lock = threading.Lock()
        self.stdout, self.stderr = sys.stdout, sys.stderr
        self.file.write(f"\n==== {time.strftime('%Y-%m-%d %H:%M:%S')}  {' '.join(sys.argv)}\n")

    def _stream(self, inner):
        log = self

        class _Tee:
            def write(self, s):
                with log.lock:
                    inner.write(s)
                    log.file.write(s)
                return len(s)

            def flush(self):
                with log.lock:
                    inner.flush()
                    log.file.flush()

            def __getattr__(self, name):
                return getattr(inner, name)
        return _Tee()

    def start(self):
        sys.stdout, sys.stderr = self._stream(self.stdout), self._stream(self.stderr)
        return self

    def trace(self, msg):
        with self.lock:
            self.file.write(f"    · {time.strftime('%H:%M:%S')} {msg}\n")

    def close(self):
        sys.stdout, sys.stderr = self.stdout, self.stderr
        self.file.close()


# ------------------------------ win32 input ------------------------------
#
# SendInput with KEYEVENTF_SCANCODE rather than a virtual-key code: games read
# the keyboard at a level where a synthetic vk with no scan code attached is
# often simply not seen, and the failure mode is silent.
#
# All three input structs are declared even though only two are used, because
# the union's size is what SendInput validates cbSize against — MOUSEINPUT is
# the largest member, so leaving it out makes every call fail.

ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_VIRTUALDESK = 0x4000
MOUSEEVENTF_ABSOLUTE = 0x8000
SM_CXSCREEN, SM_CYSCREEN = 0, 1
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 76, 77, 78, 79
# how far the cursor may land from where a click was aimed before the click is
# refused — a tab face is ~100px wide, so a few pixels is noise, not a miss
CLICK_TOLERANCE = 4
MAPVK_VK_TO_VSC = 0


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD),
                ("wParamH", wintypes.WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


def _user32():
    if sys.platform != "win32":
        raise RuntimeError("autowalk sends Windows input; this is not Windows.")
    return ctypes.windll.user32


def foreground_window():
    u = _user32()
    hwnd = u.GetForegroundWindow()
    length = u.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    u.GetWindowTextW(hwnd, buf, length + 1)
    return hwnd, buf.value


def _send(inp):
    sent = _user32().SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
    if sent != 1:
        raise RuntimeError(f"SendInput refused the input (error {ctypes.GetLastError()})")


def send_key(char, hold=0.03):
    """One press and release of a letter key, by scan code."""
    u = _user32()
    vk = ord(char.upper())
    scan = u.MapVirtualKeyW(vk, MAPVK_VK_TO_VSC)

    def event(flags):
        _send(INPUT(type=INPUT_KEYBOARD,
                    ki=KEYBDINPUT(wVk=0, wScan=scan, dwFlags=flags, time=0, dwExtraInfo=0)))

    event(KEYEVENTF_SCANCODE)
    time.sleep(hold)
    event(KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP)


def screen_size():
    """The primary display in the pixels this process's cursor lives in. Equal to
    ImageGrab.grab().size only once the process is DPI-aware (see main())."""
    u = _user32()
    return u.GetSystemMetrics(SM_CXSCREEN), u.GetSystemMetrics(SM_CYSCREEN)


def cursor_pos():
    pt = wintypes.POINT()
    if not _user32().GetCursorPos(ctypes.byref(pt)):
        raise RuntimeError(f"GetCursorPos refused ({ctypes.GetLastError()})")
    return pt.x, pt.y


def move_cursor(x, y):
    """Moves the cursor to screen pixel (x, y) through SendInput, the way a real
    mouse does, rather than SetCursorPos — so the game sees the same move and
    hover a hand would produce before the click, not a cursor that teleported.
    Absolute coordinates are normalised over the virtual desktop, which is what
    lets a point on any monitor be addressed."""
    u = _user32()
    vx, vy = u.GetSystemMetrics(SM_XVIRTUALSCREEN), u.GetSystemMetrics(SM_YVIRTUALSCREEN)
    vw, vh = u.GetSystemMetrics(SM_CXVIRTUALSCREEN), u.GetSystemMetrics(SM_CYVIRTUALSCREEN)
    nx = int(round((x - vx) * 65535 / max(1, vw - 1)))
    ny = int(round((y - vy) * 65535 / max(1, vh - 1)))
    _send(INPUT(type=INPUT_MOUSE,
                mi=MOUSEINPUT(dx=nx, dy=ny, mouseData=0,
                              dwFlags=MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                              time=0, dwExtraInfo=0)))


def click_at(x, y, hold=0.05):
    """One left click at screen coordinates: move the cursor there, check it
    really is there, press, release.

    The check is the interlock. A cursor that did not land where it was aimed —
    the game confining it, a monitor layout the move did not address, anything —
    means the button would go down on something unknown, and that is refused
    rather than risked. It cannot see a coordinate-space mismatch on its own,
    though (GetCursorPos answers in the same space the move was given in), which
    is why main() also checks the frame against screen_size().
    """
    move_cursor(x, y)
    time.sleep(0.02)
    cx, cy = cursor_pos()
    if abs(cx - x) > CLICK_TOLERANCE or abs(cy - y) > CLICK_TOLERANCE:
        raise RuntimeError(f"the cursor landed at ({cx}, {cy}), not ({int(x)}, {int(y)}) — "
                           f"not clicking somewhere I did not aim")
    for flags in (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP):
        _send(INPUT(type=INPUT_MOUSE,
                    mi=MOUSEINPUT(dx=0, dy=0, mouseData=0, dwFlags=flags, time=0, dwExtraInfo=0)))
        time.sleep(hold)


# ------------------------------ the tab strip ------------------------------

def tab_click_points(frame, box):
    """Where each of the five tabs is, in frame pixels, in TAB_ORDER.

    The strip is a slanted band — on a 1080p frame its centre line runs from
    y=173 under Space to y=200 under Sky — so the vertical middle of the
    calibrated `slot_tabs` box misses the outer tabs. Instead each column takes
    the median row of its bright pixels (the white tab faces and text, plus the
    red lit tab), which follows the slant. Columns are the same five equal
    slices detect_slot_from_tabs scores, so a click lands in the region whose
    colour that function will then read back.
    """
    w, h = frame.size
    crop = crop_fraction(frame, box)
    a = np.asarray(crop.convert("RGB")).astype(int)
    R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    band = (a.mean(2) > 170) | ((R > 140) & (R - np.maximum(G, B) > 70))
    x0, y0 = int(box[0] * w), int(box[1] * h)
    points = []
    for cols in np.array_split(np.arange(a.shape[1]), len(TAB_ORDER)):
        rows = np.where(band[:, cols[0]:cols[-1] + 1].mean(1) > 0.25)[0]
        y = int(np.median(rows)) if len(rows) else a.shape[0] // 2
        points.append((x0 + int((cols[0] + cols[-1]) / 2), y0 + y))
    return points


def make_tab_clicker(regions, grabber, origin):
    """A `clicker(slot)` that clicks that tab in the live game window.

    `origin()` is the frame's top-left corner in screen coordinates (watch.py's
    resolve_source), so a point found in a frame can be clicked whether the game
    is fullscreen or grabbed as a window. The cursor is then parked at the top
    of the frame, off the strip, so a hover highlight cannot colour the tab read
    that decides whether the click took.
    """
    box = regions["slot_tabs"]

    def click(slot):
        frame = grabber()
        ox, oy = origin()
        x, y = tab_click_points(frame, box)[TAB_ORDER.index(slot)]
        click_at(ox + x, oy + y)
        move_cursor(ox + frame.size[0] // 2, oy + max(2, frame.size[1] // 60))
        return ox + x, oy + y

    return click


def parse_tabs(spec, current):
    """--tabs as a list of slots to walk, in order, starting from the lit one.

    "all" is every tab, rotated so the run begins on the tab already open (no
    click needed for the first). A comma list is taken in the order given.
    """
    if spec is None:
        return [current] if current else []
    if spec.strip().lower() == "all":
        if current in TAB_ORDER:
            i = TAB_ORDER.index(current)
            return TAB_ORDER[i:] + TAB_ORDER[:i]
        return list(TAB_ORDER)
    tabs = []
    for raw in spec.split(","):
        name = raw.strip().capitalize()
        if name not in TAB_ORDER:
            raise ValueError(f"unknown tab {raw.strip()!r}; tabs are {', '.join(TAB_ORDER)}")
        if name not in tabs:
            tabs.append(name)
    return tabs


# ------------------------------ the walk ------------------------------

def walk_keys(pattern, count):
    """The key sequence, as a list. Separated out so the pattern is testable
    without a keyboard: `walk_keys("DSAS", 6) == list("DSASDS")`."""
    if not pattern:
        raise ValueError("pattern must not be empty")
    return [pattern[i % len(pattern)].upper() for i in range(count)]


# How each key is *meant* to move the cursor model. Two columns, so D/A clamp
# at the edges in the model; what the client actually did is read back off the
# grid and wins (see Walker._apply).
MOVES = {"D": (0, 1), "A": (0, -1), "S": (1, 0), "W": (-1, 0)}

# The least the selection frame's row fraction must change for the cursor to
# have changed rows. Rows are 1/6 (Heavens) or 1/5 (Space) of the grid box
# apart, so half the smaller step separates a real row change from jitter.
ROW_JUMP = 0.08


def _grid_read(col, yf):
    """A grid cursor read as the run log prints it."""
    if col is None:
        return "unreadable"
    return f"col {col}" + ("" if yf is None else f" row {yf:.3f}")


class Walker:
    """Drives the sequence, with the sender, the frame source, the focus guard
    and the tab clicker injected so a test can run the whole loop — several
    tabs of it — without sending a key, clicking anything or grabbing a screen.

    `pos` is the cursor model, (row, column); `visited` is every position a card
    was read at on the current tab. `cards` counts cards handed to the reader.
    """

    def __init__(self, watcher, sender, grabber, guard=None, interval=0.4,
                 settle_timeout=3.0, stuck_limit=4, fps=8.0,
                 on_capture=None, should_stop=None,
                 clicker=None, slot_reader=None, tab_timeout=6.0, cursor_reader=None,
                 trace=None):
        self.watcher = watcher
        # One line per key for the run log (RunLog.trace): what was sent, what
        # the grid showed and where the model put the cursor. Never printed.
        self.trace = trace or (lambda msg: None)
        self.sender = sender
        self.grabber = grabber
        self.guard = guard or (lambda: True)
        # frame -> (column, row_fraction): where the grid's selection frame is —
        # which of the two columns, and how far down the visible rows (0-1).
        # (None, None) when it cannot be seen. See detect_grid_cursor.
        self.cursor_reader = cursor_reader
        self._yf = None       # the row fraction on the last frame we looked at
        # How far the selection frame moves for one row, learned from the S/W
        # keys of this tab (the grid shows 6 rows on Heavens tabs, 5 on Space,
        # so it is not a constant). Lets a jump be measured in rows, not just
        # in direction: the client's D off a lone last card has been seen to go
        # up one row on one tab and two on another.
        self._row_steps = []
        # Panel signatures of the cards read on this tab, for the one case the
        # position model cannot settle alone — see run().
        self._sigs = []
        self._sig_fields = signature_fields(watcher.regions)
        # Keys left during which the model's row is only an estimate (the grid
        # has just overruled a key) and a panel matching a card already read is
        # taken as that card — see run().
        self._uncertain = 0
        self.lookalikes = 0
        self.resyncs = 0
        self.retries = 0
        # Where a settled frame goes. Wiring this to a watch.Session is what
        # makes one command both walk the list and read it; left unset, the
        # walker only paces itself and a separate watch.py does the reading.
        self.on_capture = on_capture
        self.should_stop = should_stop or (lambda: False)
        self.clicker = clicker
        self.slot_reader = slot_reader
        self.tab_timeout = tab_timeout
        self.last_tab_frame = None
        # The screen when a rewind gave up. The Moon tab of Sep 27 came up with
        # no selection frame and keys that moved nothing, and nothing was kept
        # to show what was on it; main() saves this next to the output.
        self.lost_frame = None
        self.interval = interval
        self.settle_timeout = settle_timeout
        self.stuck_limit = stuck_limit
        self.period = 1.0 / fps
        self.sent = 0
        self.settled = 0
        self.stuck = 0
        self.revisits = 0
        self.cards = 0
        self.pos = (0, 0)
        self.visited = set()

    # ---- frames ----

    def _settle(self, clock=time.monotonic, sleep=time.sleep):
        """Feeds frames until a new panel settles. Returns that frame, or None
        on timeout — which is what a key that moved nothing looks like."""
        deadline = clock() + self.settle_timeout
        while clock() < deadline:
            frame = self.grabber()
            if self.watcher.feed(frame) == "capture":
                return frame
            sleep(self.period)
        return None

    def _accept(self, frame):
        self.visited.add(self.pos)
        self.cards += 1
        _, yf = self.cursor(frame)
        if yf is not None:
            self._yf = yf
        self._sigs.append(self._signature(frame))
        if self.on_capture:
            self.on_capture(frame)

    def _signature(self, frame):
        return panel_signature(frame, self.watcher.regions, self._sig_fields, self.watcher.hash_size)

    def _seen_before(self, frame):
        """True when this panel reads the same as a card already read on this tab."""
        sig = self._signature(frame)
        return any(signature_distance(sig, s) <= self.watcher.max_distance for s in self._sigs)

    def _rows(self, dy):
        """How many rows a change in the frame's row fraction amounts to —
        at least one, by the learned row step when there is one."""
        if not self._row_steps:
            return 1
        step = sorted(self._row_steps)[len(self._row_steps) // 2]
        return max(1, int(round(abs(dy) / step)))

    def _apply(self, key, col=None, yf=None):
        """Moves the position model for `key`, corrected by what the grid shows.

        The key says what the cursor was asked to do; the grid says what it did.
        The column is taken from the grid outright. The row is the key's move
        unless the selection frame visibly changed rows in a way the key does
        not explain — which the real client does: on the last row's lone card,
        D jumps back UP, to the right-hand card one row above on one tab and two
        rows above on another. Trusting the key there put that card on a new row
        of the model, read it again as new, and the walk cycled between the last
        cards until focus was lost. The size of the jump is measured against the
        row step learned from this tab's own S/W moves, so both cases resolve.

        A vertical key whose frame did not move is still a move: the list
        scrolled under a cursor sitting on the visible edge, and the panel
        changing is what says it moved. Returns a note when the grid overruled
        the key, else None.
        """
        dr, dc = MOVES.get(key.upper(), (0, 0))
        r, c = self.pos
        note = None
        if yf is not None and self._yf is not None:
            dy = yf - self._yf
            if abs(dy) >= ROW_JUMP:
                seen = 1 if dy > 0 else -1
                if dr == 0:
                    n = self._rows(dy)
                    note = f"{key} moved the cursor {'down' if seen > 0 else 'up'} {n} row(s)"
                    dr = seen * n
                elif seen != dr:
                    n = self._rows(dy)
                    note = f"{key} moved the cursor the other way, {n} row(s)"
                    dr = seen * n
                else:
                    # a plain vertical move: this is what one row looks like here
                    self._row_steps.append(abs(dy))
                    del self._row_steps[:-20]
        if yf is not None:
            self._yf = yf
        new_c = min(1, max(0, c + dc))
        if col is not None and col != new_c:
            note = (note + "; " if note else "") + f"grid shows column {col}, model said {new_c}"
            new_c = col
        self.pos = (max(0, r + dr), new_c)
        return note

    def _pace(self, started, clock, sleep):
        remaining = self.interval - (clock() - started)
        if remaining > 0:
            sleep(remaining)

    def await_panel(self, clock=time.monotonic, sleep=time.sleep):
        """Settles and hands the frame over. Kept for callers that want the
        old one-step behaviour; the walk itself decides per position."""
        frame = self._settle(clock=clock, sleep=sleep)
        if frame is None:
            return False
        self._accept(frame)
        return True

    def prime(self, clock=time.monotonic, sleep=time.sleep):
        """Absorbs the card that is already on screen before the first key.

        PanelWatcher treats the first panel it sees as a new one, so without
        this the opening keypress is credited with a settle it had nothing to do
        with — and a first key that genuinely moved nothing would look fine.

        The card is still *read* — it is a real card sitting on screen, so a run
        of N keys yields N+1 cards — it just does not count toward `settled`,
        which is the tally of keys that actually moved something.
        """
        return self.await_panel(clock=clock, sleep=sleep)

    # ---- getting into position ----

    def cursor(self, frame):
        """(column, row_fraction) of the grid's red selection frame, or
        (None, None) when there is no reader or no clear frame."""
        if self.cursor_reader is None or frame is None:
            return None, None
        return self.cursor_reader(frame)

    def column(self, frame):
        return self.cursor(frame)[0]

    def _grid_text(self, frame):
        return _grid_read(*self.cursor(frame))

    def rewind(self, max_keys=3000, clock=time.monotonic, sleep=time.sleep, log=print):
        """Walks the cursor to the top-left card and reads it.

        W until two presses in a row move nothing; then, only if the grid shows
        the cursor in the right-hand column, A — and the grid is read again to
        confirm it moved. The walk's position model starts at (0,0) and can only
        be right if the cursor really is there, so this is what makes "start it
        on any card" true.

        The column is read off the pixels rather than fixed with a blind A
        because a blind A was tried and lost the first card: on the real client
        a horizontal key at the edge of a row does not stay put, it wraps, so an
        A pressed while already on the left card landed on the right one and
        the whole walk ran one column out of phase. Reading the frame says where
        the cursor is; the keys only ever move it when it needs moving.

        The card on screen is absorbed first, without a key: a fresh watcher (or
        one that last saw the previous tab) would otherwise credit the first W
        with a settle it did not cause. The frame the last moving key settled on
        IS the top-left card, so it is handed over here rather than waiting for a
        prime() that would find the watcher had already seen it.

        Returns (status, moved): "ok" with how many keys moved; "unfocused" if
        the game left the foreground; "lost" if the column could not be read or
        could not be brought to the left after three tries — in which case the
        caller must not walk, because it would not know where it is.

        A tab that opens on its first card costs two dead W presses, each a
        settle timeout — about six seconds. A tab that opens where you left it
        costs one W per row back to the top, which `max_keys` bounds.
        """
        moved, dead = 0, 0
        last = self._settle(clock=clock, sleep=sleep)
        while moved < max_keys:
            if not self.guard():
                return "unfocused", moved
            started = clock()
            self.sender("W")
            self.sent += 1
            frame = self._settle(clock=clock, sleep=sleep)
            if frame is None:
                dead += 1
                self.trace(f"rewind W: nothing moved ({dead}/2)")
                if dead >= 2:
                    break
            else:
                dead, moved, last = 0, moved + 1, frame
                self.trace(f"rewind W: moved, grid {self._grid_text(frame)}")
            self._pace(started, clock, sleep)

        if self.cursor_reader is None:
            log("  ! no `grid` box is calibrated, so the cursor's column cannot be read and the "
                "rewind cannot finish. Recalibrate (calibrate.py --only grid), or select the "
                "first card yourself and use --no-rewind.")
            return "lost", moved
        shot = self.grabber()
        col = self.column(shot)
        self.trace(f"rewind: grid column {col}")
        if col is None and moved == 0:
            # Moon and Sky, Sep 27: a tab can open with its selection back on
            # the first card but the list still scrolled to where it was left.
            # The panel shows the first card, the grid shows the list's last
            # rows with no frame in view, and W moves nothing because the
            # selection is already at the top. S then W steps off the first card
            # and back, and the list scrolls to follow the selection into view.
            # Each key is sent once more if it moved nothing, as in the walk; if
            # S still moves nothing, or W never comes back, the column read
            # below gives up as before rather than start from the wrong card.
            log("  the selected card is scrolled out of view — S then W to bring it back")
            for key in ("S", "W"):
                frame = None
                for _ in range(2):
                    if not self.guard():
                        return "unfocused", moved
                    self.sender(key)
                    self.sent += 1
                    frame = self._settle(clock=clock, sleep=sleep)
                    self.trace(f"rewind {key}: {'moved, grid ' + self._grid_text(frame) if frame is not None else 'nothing moved'}")
                    if frame is not None:
                        break
                if frame is None:
                    # S never moved: nothing changed, so the read below still
                    # sees no frame. W never came back: the cursor is a row down,
                    # so it must not be taken for the first card.
                    col, shot = None, self.grabber()
                    break
                last = frame
            else:
                shot = self.grabber()
                col = self.column(shot)
                self.trace(f"rewind: grid column {col}")
        for attempt in range(3):
            if col == 0:
                break
            if col is None:
                log("  ! no selection frame visible in the card grid — is the list on screen?")
                self.lost_frame = shot
                return "lost", moved
            if not self.guard():
                return "unfocused", moved
            self.sender("A")
            self.sent += 1
            frame = self._settle(clock=clock, sleep=sleep)
            if frame is not None:
                last = frame
            shot = frame if frame is not None else self.grabber()
            col = self.column(shot)
            self.trace(f"rewind A: {'moved' if frame is not None else 'nothing moved'}, grid column {col}")
            if col != 0:
                log(f"  A did not bring the cursor to the left column (try {attempt + 1}/3)")
        if col != 0:
            log("  ! could not reach the left column — stopping rather than walking out of step.")
            self.lost_frame = shot
            return "lost", moved

        self.pos, self.visited = (0, 0), set()
        self._sigs, self._row_steps, self._uncertain = [], [], 0
        if last is not None:
            self._accept(last)
            self.trace(f"   new card #{self.cards} at {self.pos}, the top of the list")
        elif self.prime(clock=clock, sleep=sleep):
            self.trace(f"   new card #{self.cards} at {self.pos}, the top of the list")
        else:
            log("  ! could not read the card on screen after rewinding")
        return "ok", moved

    def switch_tab(self, slot, clock=time.monotonic, sleep=time.sleep, log=print):
        """Clicks `slot`'s tab and waits until the strip reads it. False if it
        never does — the click did not take, or landed somewhere else — in
        which case nothing further is sent: typing into an unknown screen is
        the one thing this must never do.

        The click is tried twice: a click the game swallowed (it does drop
        inputs, see FakeGame.drop in the tests) is not worth ending a five-tab
        run over, and click_at has already verified the cursor is on the tab,
        so a second press lands on the same known place. What the strip did
        read is logged, and the last frame kept in `last_tab_frame` for main()
        to save, because "never read Star" on its own says nothing about why.
        """
        if self.clicker is None or self.slot_reader is None:
            return False
        self.last_tab_frame = None
        for attempt in range(2):
            if not self.guard():
                return False
            point = self.clicker(slot)
            if point is not None:
                log(f"  clicked {slot} at screen ({point[0]}, {point[1]})"
                    + (" — again" if attempt else ""))
            deadline = clock() + self.tab_timeout
            read = None
            while clock() < deadline:
                frame = self.grabber()
                read = self.slot_reader(frame)
                if read == slot:
                    return True
                self.last_tab_frame = frame
                sleep(self.period)
            log(f"  the strip reads {read or 'no lit tab'} {self.tab_timeout:g}s after the click")
        return False

    # ---- walking ----

    def run(self, keys, clock=time.monotonic, sleep=time.sleep, log=print, rewind=False):
        """Walks one tab. Returns why it stopped:

            "end"        a whole cycle moved nothing new — the list ran out
            "done"       every key sent (the --count ceiling)
            "satisfied"  the reader said it has what it came for
            "unfocused"  the game left the foreground
            "lost"       the rewind could not put the cursor on the first card
        """
        if rewind:
            status, moved = self.rewind(clock=clock, sleep=sleep, log=log)
            if status == "unfocused":
                log("  focus left the game — stopping.")
                return "unfocused"
            if status == "lost":
                return "lost"
            if moved:
                log(f"  rewound {moved} step(s) to the top of the list")
        else:
            self.prime(clock=clock, sleep=sleep)
        self.stuck = 0
        for key in keys:
            if self.should_stop():
                log("  the reader says it is done — stopping.")
                return "satisfied"
            if not self.guard():
                log("  focus left the game — stopping.")
                return "unfocused"
            self.sender(key)
            self.sent += 1
            started = clock()

            frame = self._settle(clock=clock, sleep=sleep)
            if frame is None:
                # One dropped input is ordinary lag, and a dropped D is the one
                # key the walk cannot recover from on its own: the card to its
                # right is never visited again. So a key that moved nothing is
                # sent once more before it is believed. At the end of the list
                # this doubles the cost of each no-op, which is a few seconds.
                if not self.guard():
                    log("  focus left the game — stopping.")
                    return "unfocused"
                self.sender(key)
                self.sent += 1
                self.retries += 1
                frame = self._settle(clock=clock, sleep=sleep)
            if frame is None:
                # A key that moves nothing is normal at a grid edge and the end
                # of the list, alarming in a run: several in a row means the
                # list is not listening (a popup, a different screen) and
                # continuing would be typing into whatever is there instead.
                self.stuck += 1
                self.trace(f"{key}: nothing moved, model {self.pos}")
                log(f"  {key}: nothing moved ({self.stuck}/{self.stuck_limit})")
            else:
                # The grid says where the cursor really is. Trust it over the
                # key: a dropped D or A, a horizontal key that wrapped at a row
                # edge, or the last lone card's D jumping back up a row would
                # otherwise leave the model out of step and every later card
                # misfiled as a revisit or read twice.
                col, yf = self.cursor(frame)
                before = self.pos
                note = self._apply(key, col, yf)
                if note:
                    self.resyncs += 1
                    log(f"  {key}: {note} — resynced")
                    self._uncertain = self.stuck_limit
                # Only the last row's lone card sends a horizontal key UP a row
                # — on this client D there lands on a right-hand card one or two
                # rows above, a card the walk has already read. When the panel
                # confirms that (it reads the same as a card read on this tab),
                # the list has run out, whatever the row estimate said.
                self.trace(f"{key}: grid {_grid_read(col, yf)}, "
                           f"model {before} -> {self.pos}" + (f" ({note})" if note else ""))
                if key.upper() in ("D", "A") and self.pos[0] < before[0] and self._seen_before(frame):
                    self.revisits += 1
                    log(f"  {key}: jumped back up onto a card already read — the list has run out.")
                    return "end"
                # While the grid has recently overruled a key, the model's row is
                # an estimate (a two-row jump has been measured as one). A fresh
                # position whose panel reads the same as a card already read on
                # this tab is then that card, not a new one. Confined to this
                # window: two identical cards elsewhere in a tab are real, and
                # the position model alone tells them apart.
                if self._uncertain > 0:
                    self._uncertain -= 1
                    if self.pos not in self.visited and self._seen_before(frame):
                        self.lookalikes += 1
                        log(f"  {key}: the panel reads like a card already read — taking it as one")
                        self.visited.add(self.pos)
                if self.pos in self.visited:
                    # Back on a card already read: the bounce at the end of the
                    # list, or the A after a dropped S. Not handed to the reader
                    # — it would be the same card twice — and not progress.
                    self.revisits += 1
                    self.stuck += 1
                    self.trace(f"   {self.pos} already read, not handed over")
                    log(f"  {key}: back on a card already read ({self.stuck}/{self.stuck_limit})")
                else:
                    self.settled += 1
                    self.stuck = 0
                    self._accept(frame)
                    self.trace(f"   new card #{self.cards} at {self.pos}")
            if self.stuck >= self.stuck_limit:
                log("  nothing new for a whole cycle — the list has run out.")
                return "end"

            self._pace(started, clock, sleep)
        return "done"

    def run_tabs(self, tabs, count, pattern="DSAS", current=None, rewind=True,
                 clock=time.monotonic, sleep=time.sleep, log=print):
        """Walks each tab in `tabs` to its end, switching between them.

        Returns (why, report) with one (slot, cards read, why) per tab reached.
        Stops at the first tab that does not switch ("tab") or the first walk
        that ends for any reason other than running out of cards.
        """
        report = []
        for slot in tabs:
            if slot != current:
                log(f"\nswitching to the {slot} tab…")
                if not self.switch_tab(slot, clock=clock, sleep=sleep, log=log):
                    log(f"  the tab strip never read {slot} — stopping rather than "
                        f"sending keys into a screen I cannot identify.")
                    report.append((slot, 0, "tab"))
                    return "tab", report
                current = slot
            log(f"\n— {slot} —")
            before = self.cards
            why = self.run(walk_keys(pattern, count), clock=clock, sleep=sleep, log=log,
                           rewind=rewind)
            report.append((slot, self.cards - before, why))
            if why not in ("end", "done"):
                return why, report
            if why == "done":
                log(f"  --count reached on {slot} before the list ran out; the rest of "
                    f"this tab was not read.")
        return "done", report


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--count", type=int, default=5000,
                        help="most keys to send per tab — a hard ceiling; the list running "
                             "out is what normally ends a tab (default: 5000)")
    parser.add_argument("--tabs", default=None,
                        help='"all" to walk every tab starting from the one that is lit, or a '
                             'comma list (e.g. "Sun,Moon"). Default: only the tab that is open.')
    parser.add_argument("--no-rewind", action="store_true",
                        help="do not press W/A to reach the first card before walking; "
                             "you have selected it yourself")
    parser.add_argument("--pattern", default="DSAS",
                        help="the repeating walk cycle (default: DSAS, for two cards per row)")
    parser.add_argument("--regions", default=str(HERE / "config" / "crop_regions.json"))
    parser.add_argument("--start-delay", type=float, default=5.0,
                        help="seconds to alt-tab to the game before it starts")
    parser.add_argument("--interval", type=float, default=0.4,
                        help="minimum seconds between keys; the panel settling usually decides")
    parser.add_argument("--settle", type=float, default=0.25)
    parser.add_argument("--fps", type=float, default=8.0)
    parser.add_argument("--max-distance", type=int, default=8)
    parser.add_argument("--settle-timeout", type=float, default=3.0,
                        help="how long to wait for the panel to move before calling a key a no-op")
    parser.add_argument("--tab-timeout", type=float, default=6.0,
                        help="how long to wait for the tab strip to show the tab that was clicked")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the plan and send nothing — do this first")
    parser.add_argument("--no-read", action="store_true",
                        help="only walk; leave the reading to a separately-run watch.py")
    parser.add_argument("--out", default=str(HERE / "cards.json"))
    parser.add_argument("--rarity", type=int, choices=[2, 3, 4, 5], default=None,
                        help="stamp every card from this run with this rarity — set the game's "
                             "rarity filter to match, it cannot be read off the screen")
    parser.add_argument("--slot", choices=["Sun", "Moon", "Star", "Sky", "Space"], default=None,
                        help="fallback slot for frames whose tab strip cannot be read; not "
                             "allowed with --tabs")
    parser.add_argument("--known", default=None,
                        help="a save file exported from the app; labels each card new or already-held")
    parser.add_argument("--expect", type=int, default=None,
                        help="stop once this many NEW cards have been read (needs --known)")
    parser.add_argument("--stop-after", type=int, default=None,
                        help="stop after this many consecutive already-held cards (needs --known)")
    parser.add_argument("--window", default=None,
                        help="grab this window's client area instead of the whole screen")
    parser.add_argument("--max-pending", type=int, default=16,
                        help="frames allowed to queue for OCR before the walk waits "
                             "for the reader to catch up (0 = unbounded)")
    parser.add_argument("--no-beep", action="store_true")
    parser.add_argument("--workers", type=int, default=3,
                        help="cards read at once (default: 3). The walk waits for the reader, "
                             "so this is what sets the pace once the queue is full")
    args = parser.parse_args(argv)

    if (args.expect is not None or args.stop_after is not None) and not args.known:
        parser.error("--expect and --stop-after need --known to compare against")
    if args.no_read and (args.known or args.rarity or args.expect or args.stop_after):
        parser.error("--no-read only walks; the reading options belong to watch.py then")
    if args.tabs and args.slot:
        parser.error("--slot names one tab; with --tabs the slot is read off the strip per frame")
    if args.count < 1:
        parser.error("--count must be at least 1")
    try:
        parse_tabs(args.tabs, "Sun")
    except ValueError as e:
        parser.error(str(e))

    keys = walk_keys(args.pattern, args.count)

    if args.dry_run:
        plan = parse_tabs(args.tabs, None) if args.tabs else ["the tab that is open"]
        print(f"would walk: {', '.join(plan)}")
        print(f"  per tab: {'rewind to the first card (W… then A), then ' if not args.no_rewind else ''}"
              f"at most {len(keys)} key(s): {''.join(keys[:40])}{'…' if len(keys) > 40 else ''}")
        print("  stopping a tab once a whole cycle moves nothing new.")
        if args.tabs:
            print("  each further tab is one mouse click on the strip, verified by colour before any key.")
        print("no input was sent. Drop --dry-run to do it for real.")
        return

    # The output's final name (numbered past any earlier batch) is fixed here,
    # before anything is sent, so the log, the frames and a failed tab's
    # screenshot all carry the same one.
    out_path = unique_out_path(Path(args.out))
    run_log = RunLog(out_path.with_suffix(".log")).start()
    try:
        _run(args, keys, out_path, run_log)
    finally:
        run_log.close()
        print(f"run log: {run_log.path}")


def _run(args, keys, out_path, run_log):
    print(f"switch to the game with the card list open — starting in {args.start_delay:g}s")
    for remaining in range(int(args.start_delay), 0, -1):
        print(f"  {remaining}…", end="\r", flush=True)
        time.sleep(1)

    hwnd, title = foreground_window()
    print(f"\nlocked to: {title or '(untitled window)'}")

    # The whole process, not just the grab: PIL makes its own thread DPI-aware
    # for the duration of ImageGrab.grab(), so frames are physical pixels
    # whatever the desktop scaling — but a DPI-unaware process places the
    # cursor in *logical* pixels, and on a 125% desktop every tab click landed a
    # quarter further right and down than the frame said, just under the strip.
    _dpi_aware()

    regions = load_config(args.regions)
    watcher = PanelWatcher(regions,
                           settle_frames=max(1, round(args.settle * args.fps)),
                           max_distance=args.max_distance)

    grabber, where, origin = resolve_source(args.window)
    print(f"reading {where}")
    if args.tabs and not args.window:
        frame_size, screen = grabber().size, screen_size()
        if tuple(frame_size) != tuple(screen):
            print(f"  ! the frame is {frame_size[0]}x{frame_size[1]} but the cursor's screen is "
                  f"{screen[0]}x{screen[1]} — a click aimed on the frame would land elsewhere. "
                  f"Nothing sent. (Display scaling? DPI awareness did not take.)")
            return

    current = None
    if "slot_tabs" in regions:
        current, _ = detect_slot_from_tabs(grabber(), regions["slot_tabs"])
    if args.tabs and current is None:
        print("  ! no lit tab on screen — the card list does not seem to be open. Nothing sent.")
        return
    tabs = parse_tabs(args.tabs, current)
    if args.tabs:
        print(f"tabs: {' → '.join(tabs)} (starting on {current})")
    print(f"sending at most {len(keys)} key(s) per tab. Alt-tab away to stop.\n")

    session = frames_dir = known = None
    if not args.no_read:
        frames_dir = out_path.parent / "_frames"
        ensure_tesseract()
        known = load_known(args.known) if args.known else None
        # Bounded: the walk is closed-loop, so blocking here simply paces the
        # keys to the reader instead of piling full-screen frames in memory.
        session = Session(regions, Vocab(), rarity=args.rarity, slot=args.slot,
                          known=known, expect=args.expect, stop_after=args.stop_after,
                          frames_dir=frames_dir, quiet_misses=args.no_beep,
                          max_pending=args.max_pending, src_prefix=out_path.stem,
                          workers=args.workers)

    guard = lambda: foreground_window()[0] == hwnd  # noqa: E731
    clicker = make_tab_clicker(regions, grabber, origin) if "slot_tabs" in regions else None
    reader = (lambda f: detect_slot_from_tabs(f, regions["slot_tabs"])[0]) if "slot_tabs" in regions else None
    cursor = (lambda f: detect_grid_cursor(f, regions["grid"])) if "grid" in regions else None
    if cursor is None and not args.no_rewind:
        print("  ! no `grid` box in the calibration — the rewind cannot read the cursor's column.")
        print("    Recalibrate with: python calibrate.py <frame> --only grid   (or use --no-rewind)")
        return
    walker = Walker(watcher, send_key, grabber, guard=guard,
                    interval=args.interval, settle_timeout=args.settle_timeout,
                    fps=args.fps, tab_timeout=args.tab_timeout,
                    on_capture=session.submit if session else None,
                    should_stop=session.done.is_set if session else None,
                    clicker=clicker, slot_reader=reader, cursor_reader=cursor,
                    trace=run_log.trace)

    report = []
    try:
        why, report = walker.run_tabs(tabs, args.count, pattern=args.pattern, current=current,
                                      rewind=not args.no_rewind)
    except KeyboardInterrupt:
        why = "interrupted"

    print(f"\n{walker.sent} key(s) sent, {walker.cards} card(s) read, "
          f"{walker.revisits} revisit(s) skipped, {walker.retries} key(s) retried, "
          f"{walker.resyncs} resync(s) from the grid, {walker.lookalikes} lookalike(s) ({why}).")
    for slot, n, w in report:
        print(f"  {slot:>5}: {n} card(s) — {w}")
    if why == "tab":
        print("A tab did not switch. Click it yourself and run again for the remaining tabs.")
        if walker.last_tab_frame is not None:
            where = (frames_dir or out_path.parent)
            where.mkdir(parents=True, exist_ok=True)
            # The numbered name, like the card files: every run of a session
            # shares one --out, so its stem let each run overwrite the last one's.
            path = where / f"{out_path.stem}-tab-{report[-1][0]}.png"
            walker.last_tab_frame.save(path)
            print(f"  the screen as last seen after the click: {path}")
    if why == "lost":
        print("The rewind could not put the cursor on the first card. Select it yourself and "
              "run again with --no-rewind.")
        if walker.lost_frame is not None:
            where = (frames_dir or out_path.parent)
            where.mkdir(parents=True, exist_ok=True)
            path = where / f"{out_path.stem}-lost-{report[-1][0] if report else 'tab'}.png"
            walker.lost_frame.save(path)
            print(f"  the screen when it gave up: {path}")

    if session:
        finish(session, watcher, out_path, frames_dir, known=known)


if __name__ == "__main__":
    main()
