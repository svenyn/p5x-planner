"""Reads card panels off the live screen while you click through the inventory,
so a scanning session needs no screenshot key and no files moved afterwards.

This is extract_frames.py's idea — sample frames, keep one when the picture
stops changing — with the screen itself as the source instead of ffmpeg and a
recording. Everything downstream is unchanged: captured frames go through the
same parse_panel/validate_card as pipeline.py and land in the same cards.json +
*-review.json pair the app's "Import cards (merge)" button already takes.

Pixels only. Nothing here sends input into the game client — you drive the card
list yourself (WASD; two cards per row makes it a repeating D-S-A-S cycle) and
this only ever looks. That is a deliberate constraint, not an oversight: input
automation is a ban risk on an account worth thousands of cards.

Three things it does that hand-taken screenshots cannot:

  * **It will not catch a card mid-animation.** The stat labels animate into
    place when a card is selected, and a frame caught during that holds a real
    but part-assembled label ("ntAcc. A" for Ailment Acc.) with the crop box
    perfectly correct — the one failure mode in this pipeline that is not crop
    calibration. A capture only fires once the panel has held still for
    --settle seconds, so a half-drawn label cannot be what gets read.

  * **It notices the cards you tapped past.** A panel that appears and then
    changes again before it settles is, precisely, a card that went by unread.
    Those are counted, and (unless --no-beep) they click at you, so you can
    keep your eyes on the game and correct your pace by ear.

  * **It knows what screen you are on.** detect_slot_from_tabs finding no lit
    tab means the inventory is not up, so menus, loading screens and battles
    are skipped rather than captured as unreadable cards. Leave it running.

Slot comes free per-frame from that same tab strip, so one run covers all five
tabs and you can switch between them mid-session. Rarity still cannot be read
off the panel at all (see panel_ocr.py), so --rarity is still per-run and you
still scan one rarity tier at a time — use the game's own rarity filter.

--known makes it a catch-up tool. Point it at a save file exported from the
app, sort the inventory by order obtained, start from the newest end, and each
card is labelled new or already-held as it is read. With --expect N it stops
once it has seen N new ones (use the inventory's own total count to learn N,
which is exact and does not care how the sort breaks ties); with --stop-after K
it stops after K consecutive already-held cards. Neither is load-bearing: every
card read is written out regardless, and the app's mergeImport is the authority
on new-vs-levelled-up-vs-duplicate. --known only decides when to stop tapping,
so getting it wrong costs you a few keypresses in one direction or the other.

OCR runs on a worker thread. parse_panel makes about a dozen tesseract calls
per card and each one spawns a subprocess, which is far slower than the ~8fps
grab loop — running it inline would drop cards while it worked. Measured on a
real 20-card run, the capture side finished every card before the reader had got
past the first, so the queue is where the two speeds meet. It drains after you
stop, and a deep queue only costs you a slow finish here — but each entry is a
full-screen image, so a caller that can control its own pace should bound it
(`max_pending`); autowalk.py does.
"""
import argparse
import ctypes
import json
import queue
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path

import imagehash
from PIL import ImageGrab

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from calibrate import load_config  # noqa: E402
from levels import LevelTemplates  # noqa: E402
from panel_ocr import (crop_fraction, detect_grid_cursor, detect_slot_from_tabs,  # noqa: E402
                       parse_panel)
from pipeline import unique_out_path  # noqa: E402
from validate import validate_card  # noqa: E402
from vocab import Vocab  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Where tesseract.exe actually lives on a default Windows install. pytesseract
# only looks on PATH, and prepending it there is a step you would have to redo
# every shell — the whole point of this script is to remove ceremony, so it
# finds the binary itself and only complains if it genuinely is not installed.
TESSERACT_CANDIDATES = [
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
]


def ensure_tesseract():
    """Points pytesseract at a tesseract binary if it is not already on PATH.
    Returns the path used, or None when PATH already resolves it."""
    import shutil

    import pytesseract

    if shutil.which("tesseract"):
        return None
    for candidate in TESSERACT_CANDIDATES:
        if Path(candidate).exists():
            pytesseract.pytesseract.tesseract_cmd = candidate
            return candidate
    raise RuntimeError(
        "tesseract not found on PATH or in " + " / ".join(TESSERACT_CANDIDATES) +
        "\nInstall it, or add it to PATH."
    )


# ------------------------------ what to grab ------------------------------
#
# Steam's screenshot key captures the game's CLIENT AREA; ImageGrab.grab()
# captures the whole screen. Those are the same picture only when the game is
# exactly fullscreen at the calibrated resolution, and otherwise every
# fractional crop box lands somewhere slightly wrong — the symptom is text
# sitting low or high in an otherwise correctly-placed box, which reads as an
# OCR problem and is not one. So grab the client rect when we can find it, and
# the fractions mean the same thing they meant during calibration.
#
# Reading a window's geometry is not input automation; nothing here sends
# anything to the game.

def _dpi_aware():
    """Without this, a scaled display makes GetClientRect report logical pixels
    while ImageGrab returns physical ones, and the bbox is silently wrong."""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def find_window(needle):
    """The first visible top-level window whose title contains `needle`,
    case-insensitively. Returns (hwnd, title) or (None, None)."""
    user32 = ctypes.windll.user32
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def each(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if not n:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if needle.lower() in buf.value.lower():
            found.append((hwnd, buf.value))
            return False
        return True

    user32.EnumWindows(each, 0)
    return found[0] if found else (None, None)


def client_box(hwnd):
    """The window's client area in screen coordinates — what Steam captures."""
    user32 = ctypes.windll.user32
    rect = wintypes.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(rect))
    origin = wintypes.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(origin))
    return (origin.x, origin.y, origin.x + rect.right, origin.y + rect.bottom)


def make_grabber(hwnd=None):
    """A no-argument callable returning the next frame. The box is recomputed
    per grab, so moving or resizing the window mid-session is handled."""
    if hwnd is None:
        return ImageGrab.grab
    return lambda: ImageGrab.grab(bbox=client_box(hwnd))


def resolve_source(needle):
    """(grabber, description, origin). A needle that matches nothing falls back
    to the whole screen with a warning rather than failing — full-screen is
    correct when the game really is fullscreen, and that is the common case.

    `origin()` is the frame's top-left corner in screen coordinates, recomputed
    per call like the grab box, so something found in a frame can be pointed at
    on screen. Reading it is not input; autowalk.py is what uses it to click.
    """
    if not needle:
        return ImageGrab.grab, "the whole screen", (lambda: (0, 0))
    _dpi_aware()
    hwnd, title = find_window(needle)
    if hwnd is None:
        print(f"  ! no visible window matching {needle!r} — falling back to the whole screen")
        return ImageGrab.grab, "the whole screen", (lambda: (0, 0))
    box = client_box(hwnd)
    return (make_grabber(hwnd),
            f"{title!r} client area {box[2] - box[0]}x{box[3] - box[1]} at ({box[0]},{box[1]})",
            (lambda: client_box(hwnd)[:2]))


def resolve_window(needle):
    """(grabber, description) — resolve_source without the origin."""
    grabber, where, _ = resolve_source(needle)
    return grabber, where


# ------------------------------ panel signature ------------------------------
#
# What counts as "the panel changed" is hashed per-field rather than once over
# the whole panel crop, and the distances are summed. A single 8x8 dhash over
# the entire panel is dominated by the layout, which is identical on every card
# — two cards differing only in one substat's digits can land within any
# threshold loose enough to tolerate the UI's own shimmer, and a collision here
# is worse than a miss because nothing detects it: the second card is silently
# never captured. Hashing each small text crop on its own makes a changed digit
# a large distance in that field's hash, where it cannot be averaged away.

# Calibrated boxes that are not part of the card panel: the tab strip is the
# same on every card in a tab and would dilute the comparison, and the grid is
# the list itself — it moves with the cursor, not with the card.
#
# The main stat's label is left out too, for the opposite reason: it never
# holds still. A name too long for its box — "Ailment Acc.", "Damage Multiplier"
# — is a looping marquee, scrolling for as long as the card is on screen, so its
# hash drifts 25-30 units between frames of the SAME card against a settle
# threshold of 8. With it in the signature the watcher saw a new panel every
# few frames on such a card: autowalk read the last two Star cards 49 times and
# walked on until focus was lost, because a key that moved nothing still
# "changed the panel". The main value, level, set and four substats are what
# tell two cards apart; the label only ever said which of two stats with the
# same value it was, and the position model tells adjacent cards apart anyway.
# The OCR still reads the label (a partial read is resolved by
# vocab._unique_fragment and sent to review); it just no longer decides when
# the panel is new.
NON_PANEL_FIELDS = {"slot_tabs", "grid", "main_label"}


def signature_fields(regions):
    """Every calibrated field that belongs to the card panel."""
    return sorted(f for f in regions if f not in NON_PANEL_FIELDS)


def panel_signature(image, regions, fields, hash_size=8):
    return tuple(imagehash.dhash(crop_fraction(image, regions[f]), hash_size=hash_size)
                 for f in fields)


def signature_distance(a, b):
    return sum(int(x - y) for x, y in zip(a, b))


class PanelWatcher:
    """Turns a stream of frames into capture events. Pure — no grabbing, no
    OCR, no clock — so the settle/miss logic can be driven frame by frame in a
    test rather than only against a live game.

    feed() returns "capture" the frame a new panel has been stable for
    `settle_frames`, "miss" when a distinct panel appeared and was gone again
    before it settled, and None otherwise.
    """

    def __init__(self, regions, settle_frames=2, max_distance=8, hash_size=8):
        self.regions = regions
        self.fields = signature_fields(regions)
        self.settle_frames = max(1, settle_frames)
        self.max_distance = max_distance
        self.hash_size = hash_size
        self.captured = 0
        self.missed = 0
        self._stable = None   # signature of the last panel we captured
        self._cand = None     # signature we are currently waiting to settle
        self._count = 0

    def reset(self):
        """Called when we leave the inventory screen. Drops the candidate but
        keeps `_stable`, so coming back to the same card does not re-read it."""
        self._cand, self._count = None, 0

    def _is_new(self, sig):
        return self._stable is None or signature_distance(sig, self._stable) > self.max_distance

    def feed(self, image):
        sig = panel_signature(image, self.regions, self.fields, self.hash_size)
        event = None
        if self._cand is None or signature_distance(sig, self._cand) > self.max_distance:
            # The picture moved. If what it moved away from was a real panel we
            # never got to read, that is a card tapped past.
            if self._cand is not None and self._count < self.settle_frames and self._is_new(self._cand):
                self.missed += 1
                event = "miss"
            self._cand, self._count = sig, 1
        else:
            self._count += 1
        # `==`, not `>=`, so one settled panel fires exactly once however long
        # you leave it on screen.
        if self._count == self.settle_frames and self._is_new(self._cand):
            self._stable = self._cand
            self.captured += 1
            return "capture"
        return event


# ------------------------------ known inventory ------------------------------
#
# A ten-line port of cardFingerprint/exactKey from src/logic.js, and only that
# much on purpose. The app's mergeImport resolves rescans against the whole
# inventory as an assignment problem, three passes deep, because getting that
# wrong misreports level-ups; none of that is needed here, where the question
# is the much weaker "have I seen this one before, roughly" and the only thing
# riding on the answer is when to stop tapping.

def _fingerprint(card):
    return "|".join([str(card.get("slot")), str(card.get("set")),
                     str(card.get("rarity")), str(card.get("main"))])


def _subs_close(a, b, eps=0.05):
    """Same substat names, and every value within eps. Tolerant rather than
    exact because both sides are OCR output: the same physical card read twice
    can differ in the last digit, and treating that as a different card would
    make every stop rule fire late."""
    ma = {s.get("stat"): s.get("value") for s in (a or [])}
    mb = {s.get("stat"): s.get("value") for s in (b or [])}
    if set(ma) != set(mb):
        return False
    return all(abs((mb[k] or 0) - (ma[k] or 0)) <= eps for k in ma)


class KnownIndex:
    def __init__(self, cards):
        self.pools = {}
        for c in cards:
            self.pools.setdefault(_fingerprint(c), []).append(c)

    def holds(self, card):
        for ex in self.pools.get(_fingerprint(card), []):
            if ex.get("level") == card.get("level") and _subs_close(ex.get("subs"), card.get("subs")):
                return True
        return False


def load_known(path):
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    cards = raw if isinstance(raw, list) else raw.get("cards", [])
    return KnownIndex(cards)


# ------------------------------ the session ------------------------------

def beep():
    """Short click on a missed card. Threaded because winsound.Beep blocks for
    its whole duration, which at 8fps would itself cost us a frame."""
    def _go():
        try:
            import winsound
            winsound.Beep(880, 70)
        except Exception:
            pass
    threading.Thread(target=_go, daemon=True).start()


def describe(card):
    subs = ", ".join(f'{s.get("stat")} {s.get("value")}' for s in (card.get("subs") or []))
    return (f'{card.get("slot")}/{card.get("set")} {card.get("rarity")}★ '
            f'Lv{card.get("level")} {card.get("main")} — {subs}')


class Session:
    """Owns the OCR worker, the results, and the stop rules. The grab loop
    hands it images and asks it whether to keep going."""

    def __init__(self, regions, vocab, rarity=None, slot=None, known=None,
                 expect=None, stop_after=None, frames_dir=None, quiet_misses=False,
                 levels=None, max_pending=0, src_prefix="watch", workers=1):
        self.regions, self.vocab = regions, vocab
        self.levels = LevelTemplates.load() if levels is None else levels
        self.rarity, self.slot = rarity, slot
        self.known, self.expect, self.stop_after = known, expect, stop_after
        self.frames_dir = frames_dir
        # Frame names must not collide ACROSS runs: every session numbers from
        # 1 into the same _frames/ directory, so a bare "watch-00001.png" meant
        # a later run silently overwrote an earlier run's evidence and left its
        # review entries pointing at somebody else's card. Naming them after the
        # output file keeps each run's frames its own.
        self.src_prefix = src_prefix
        self.quiet_misses = quiet_misses
        self.valid, self.invalid = [], []
        self.new_count, self.known_run = 0, 0
        self.done = threading.Event()
        # OCR is roughly 20x slower than the capture side: a 20-card autowalk
        # finished every keypress before the reader had got past card 1. Each
        # queued frame is a full-screen image, so an unbounded queue turns a
        # long run into gigabytes. A bound makes submit() block instead, which
        # is right for a caller that drives the pace (autowalk) and wrong for
        # one that cannot (watch.py, where you are tapping) — there a stalled
        # grab loop would skip cards without even registering them as missed.
        # So watch.py leaves this at 0 and warns you instead; autowalk sets it.
        self.q = queue.Queue(maxsize=max_pending)
        self._n = 0
        self._lock = threading.Lock()
        # Several readers, because a card is two tesseract launches that spend
        # most of their time in another process: three threads read three cards
        # at once and the walk stops waiting on the reader. Cards are numbered
        # in the order they are taken off the queue, so `src` names still follow
        # the order they were seen; the printed lines may finish out of order.
        self.workers = max(1, int(workers))
        self._threads = [threading.Thread(target=self._run, daemon=True)
                         for _ in range(self.workers)]
        for t in self._threads:
            t.start()

    def submit(self, image):
        self.q.put(image)

    def on_miss(self):
        if not self.quiet_misses:
            beep()

    @property
    def pending(self):
        return self.q.qsize()

    def _run(self):
        while True:
            image = self.q.get()
            if image is None:
                self.q.task_done()
                return
            try:
                self._handle(image)
            except Exception as e:  # a bad frame must not take the worker down
                print(f"  ! failed to read a frame: {e}")
            finally:
                self.q.task_done()

    def _handle(self, image):
        with self._lock:
            self._n += 1
            n = self._n

        card, conf, notes = parse_panel(image, self.regions, self.vocab,
                                        rarity=self.rarity, slot=self.slot,
                                        levels=self.levels)
        errs = validate_card(card, self.vocab)
        card_out = dict(card)
        card_out["conf"] = conf

        src = f"{self.src_prefix}-{n:05d}.png"
        card_out["src"] = src

        flag = "✓"
        if errs or notes:
            flag = "!"
            # Only review cards keep their pixels — that is the only case where
            # anyone goes back to look (review_cards.py's `o`), and a full sweep
            # would otherwise write four thousand PNGs nobody opens.
            if self.frames_dir:
                self.frames_dir.mkdir(parents=True, exist_ok=True)
                try:
                    image.save(self.frames_dir / src)
                except Exception:
                    pass
            with self._lock:
                self.invalid.append({"src": src, "card": card_out,
                                     "errors": errs, "notes": notes})
        else:
            with self._lock:
                self.valid.append(card_out)

        mark = ""
        with self._lock:
            if self.known is not None:
                if self.known.holds(card):
                    mark = " · already have"
                    self.known_run += 1
                else:
                    mark = " · NEW"
                    self.new_count += 1
                    self.known_run = 0

            print(f"{n:5d}  {describe(card)}  {flag}{mark}")
            for note in (notes or [])[:2]:
                print(f"       {note}")
            for err in (errs or [])[:2]:
                print(f"       {err}")

            if self.expect is not None and self.new_count >= self.expect:
                print(f"\n  found the {self.expect} new card(s) you expected — stopping.")
                self.done.set()
            elif self.stop_after is not None and self.known_run >= self.stop_after:
                print(f"\n  {self.known_run} in a row already in the save — caught up, "
                      f"{self.new_count} new. Stopping.")
                self.done.set()

    def drain(self):
        """Waits for the readers to finish what you already tapped past."""
        self.q.join()
        for _ in range(self.workers):
            self.q.put(None)

    def write(self, out_path):
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({"cards": self.valid}, f, indent=2)
        review_path = out_path.with_name(out_path.stem + "-review.json")
        # Same rule as pipeline.py: no empty review file to walk.
        if self.invalid:
            with open(review_path, "w", encoding="utf-8") as f:
                json.dump(self.invalid, f, indent=2)
        elif review_path.exists():
            review_path.unlink()
        return review_path


def probe(regions, vocab, out_path, rarity=None, slot=None, delay=5.0, window=None,
          settle=0.25, fps=8.0, max_distance=8, settle_wait=6.0):
    """Grabs one frame after a countdown and reports what it saw.

    Everything that can go wrong before a single card is read goes wrong here,
    and each failure looks different:

      * an all-black image means the game is in fullscreen *exclusive* mode,
        which ImageGrab cannot see through — switch it to borderless windowed;
      * the wrong size means the crop fractions are being applied to a screen
        the calibration was not taken on;
      * no lit tab means the inventory is not up, or slot_tabs is miscalibrated;
      * fields that read as nonsense mean the crop boxes need recalibrating
        against a live grab rather than a Steam screenshot.

    The frame is kept, so `calibrate.py ocr/_probe.png` can be pointed straight
    at it if the boxes do need moving.
    """
    print(f"switch to the game with a card selected — grabbing in {delay:g}s")
    for remaining in range(int(delay), 0, -1):
        print(f"  {remaining}…", end="\r", flush=True)
        time.sleep(1)
    grabber, where = resolve_window(window)
    print(f"  source: {where}")

    # Wait for the panel to hold still, exactly as a real run does. Grabbing one
    # frame blind is what the settle gate exists to prevent, and a probe that
    # skips it can report a mid-animation misread as though it were a
    # calibration fault — which is the single most misleading thing this could
    # do, since the two have completely different fixes.
    watcher = PanelWatcher(regions, settle_frames=max(1, round(settle * fps)),
                           max_distance=max_distance)
    period, deadline, settled = 1.0 / fps, time.monotonic() + settle_wait, False
    frame = grabber()
    while time.monotonic() < deadline:
        frame = grabber()
        if watcher.feed(frame) == "capture":
            settled = True
            break
        time.sleep(period)

    shot = Path(out_path).parent / "_probe.png"
    shot.parent.mkdir(parents=True, exist_ok=True)
    frame.save(shot)
    print(f"\ngrabbed {frame.size[0]}x{frame.size[1]} — saved to {shot}")
    if not settled:
        print(f"  ! the picture never held still for {settle:g}s in {settle_wait:g}s of trying.")
        print("    Something on screen is animating continuously. Anything read below")
        print("    may be a mid-animation artefact rather than a calibration fault —")
        print("    they look identical and have completely different fixes.")

    extrema = frame.convert("L").getextrema()
    if extrema[1] < 12:
        print("  ! the frame is entirely black. The game is almost certainly in")
        print("    fullscreen exclusive mode; switch it to borderless windowed.")
        return None

    if "slot_tabs" in regions:
        detected, conf = detect_slot_from_tabs(frame, regions["slot_tabs"])
        if detected is None:
            print("  ! no lit tab found. Either the inventory is not open, or the")
            print("    slot_tabs box needs recalibrating:")
            print(f"    python calibrate.py {shot} --only slot_tabs")
        else:
            print(f"  slot tab: {detected} (confidence {conf:.2f})")
    if "grid" in regions:
        col, row = detect_grid_cursor(frame, regions["grid"])
        if col is None:
            print("  ! no selection frame found in the card grid. autowalk's rewind needs it;")
            print(f"    if a card is selected, recalibrate: python calibrate.py {shot} --only grid")
        else:
            print(f"  grid cursor: {'left' if col == 0 else 'right'} column, "
                  f"{row:.0%} of the way down the visible rows")

    card, _, notes = parse_panel(frame, regions, vocab, rarity=rarity, slot=slot,
                                 levels=LevelTemplates.load())
    errs = validate_card(card, vocab)
    print(f"  read: {describe(card)}")
    for note in notes:
        print(f"    note: {note}")
    for err in errs:
        print(f"    error: {err}")
    if not notes and not errs:
        print("\n  Clean read. Check those values against the panel with your own eyes,")
        print("  then try a real run on twenty cards.")
    else:
        print(f"\n  Compare against the panel. If a field is cut off or empty, recalibrate")
        print(f"  it on this very frame: python calibrate.py {shot} --only <field>")
    return card


def watch(regions, vocab, out_path, rarity=None, slot=None, known=None, expect=None,
          stop_after=None, fps=8.0, settle=0.25, max_distance=8, hash_size=8,
          quiet_misses=False, debug=False, window=None, workers=3):
    out_path = unique_out_path(out_path)
    frames_dir = out_path.parent / "_frames"
    settle_frames = max(1, round(settle * fps))

    watcher = PanelWatcher(regions, settle_frames=settle_frames,
                           max_distance=max_distance, hash_size=hash_size)
    session = Session(regions, vocab, rarity=rarity, slot=slot, known=known,
                      expect=expect, stop_after=stop_after, frames_dir=frames_dir,
                      quiet_misses=quiet_misses, src_prefix=out_path.stem, workers=workers)

    grabber, where = resolve_window(window)
    gate = "slot_tabs" in regions
    period = 1.0 / fps
    on_screen, announced = False, False
    nagged = 0.0

    print(f"reading {where}")
    print(f"watching at ~{fps:g}fps · settle {settle:g}s ({settle_frames} frames)"
          f" · rarity {rarity or '(unset — cards will go to review)'}")
    print("open the inventory and start tapping. Ctrl-C when you are done.\n")

    try:
        while not session.done.is_set():
            t0 = time.monotonic()
            frame = grabber()

            if gate:
                detected, _ = detect_slot_from_tabs(frame, regions["slot_tabs"])
                if detected is None:
                    if on_screen:
                        watcher.reset()
                    on_screen = False
                    time.sleep(max(0.0, period - (time.monotonic() - t0)))
                    continue
                if not on_screen and not announced:
                    print(f"  (inventory up — {detected} tab)")
                    announced = True
                on_screen = True

            event = watcher.feed(frame)
            if event == "capture":
                session.submit(frame)
            elif event == "miss":
                session.on_miss()
                if debug:
                    print("       (tapped past one)")

            # Queued frames are full-screen images held in memory until the OCR
            # worker gets to them. In steady state the queue sits near zero — a
            # card takes about as long to read as it does to select — but a fast
            # sweep can outrun it, and the only symptom would otherwise be memory.
            if session.pending > 50 and time.monotonic() - nagged > 10:
                nagged = time.monotonic()
                print(f"       ({session.pending} frames still to read — it will catch up)")

            time.sleep(max(0.0, period - (time.monotonic() - t0)))
    except KeyboardInterrupt:
        print("\n  stopping…")

    review_path = finish(session, watcher, out_path, frames_dir, known)
    return session, watcher, out_path, review_path


def finish(session, watcher, out_path, frames_dir, known=None):
    """Drains the OCR worker, writes both files and reports. Shared with
    autowalk.py, which runs the same session behind its own frame source."""
    # A second Ctrl-C lands here, while the worker is still reading what you
    # already tapped past. Losing a whole batch to an impatient keypress would be
    # the worst failure available, so write whatever has been read either way.
    try:
        if session.pending:
            print(f"  reading the last {session.pending} frame(s)… (Ctrl-C again to skip)")
        session.drain()
    except KeyboardInterrupt:
        print("  skipped — writing what was read so far.")
    review_path = session.write(out_path)

    print(f"\n{len(session.valid)} card(s) written to {out_path}")
    if session.invalid:
        print(f"{len(session.invalid)} card(s) need review — see {review_path}")
        print(f"    python review_cards.py {out_path.stem} --shots {frames_dir}")
    if watcher.missed:
        print(f"{watcher.missed} card(s) went past before the panel settled — "
              f"tap a little slower, or lower --settle.")
    if known is not None:
        print(f"{session.new_count} new, {len(session.valid) + len(session.invalid) - session.new_count} "
              f"already in the save.")
    return review_path


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--regions", default=str(HERE / "config" / "crop_regions.json"))
    parser.add_argument("--out", default=str(HERE / "cards.json"))
    parser.add_argument("--rarity", type=int, choices=[2, 3, 4, 5], default=None,
                        help="stamp every card from this run with this rarity — "
                             "not readable off the panel, so use the game's rarity filter")
    parser.add_argument("--slot", choices=["Sun", "Moon", "Star", "Sky", "Space"], default=None,
                        help="fallback only; the lit tab wins when it can be read")
    parser.add_argument("--known", default=None,
                        help="a save file exported from the app; labels each card new or already-held")
    parser.add_argument("--expect", type=int, default=None,
                        help="stop once this many NEW cards have been read (needs --known)")
    parser.add_argument("--stop-after", type=int, default=None,
                        help="stop after this many consecutive already-held cards (needs --known)")
    parser.add_argument("--fps", type=float, default=8.0)
    parser.add_argument("--settle", type=float, default=0.25,
                        help="seconds the panel must hold still before it is read (default: 0.25)")
    parser.add_argument("--max-distance", type=int, default=8,
                        help="summed per-field hash distance that counts as a different card")
    parser.add_argument("--hash-size", type=int, default=8)
    parser.add_argument("--no-beep", action="store_true", help="stay silent on a missed card")
    parser.add_argument("--workers", type=int, default=3,
                        help="cards read at once (default: 3); each is two tesseract launches")
    parser.add_argument("--probe", action="store_true",
                        help="grab one frame after a countdown, report what it saw, and exit")
    parser.add_argument("--probe-delay", type=float, default=5.0)
    parser.add_argument("--window", default=None,
                        help="grab this window's CLIENT AREA instead of the whole screen, "
                             "matched on a substring of its title. Use it whenever the game "
                             "is not exactly fullscreen at the calibrated resolution.")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args(argv)

    if (args.expect is not None or args.stop_after is not None) and not args.known:
        parser.error("--expect and --stop-after need --known to compare against")

    where = ensure_tesseract()
    if where:
        print(f"using tesseract at {where}")

    if args.probe:
        probe(load_config(args.regions), Vocab(), Path(args.out),
              rarity=args.rarity, slot=args.slot, delay=args.probe_delay,
              window=args.window, settle=args.settle, fps=args.fps,
              max_distance=args.max_distance)
        return

    known = load_known(args.known) if args.known else None
    if known is not None:
        print(f"{sum(len(v) for v in known.pools.values())} card(s) loaded from {args.known}")

    watch(load_config(args.regions), Vocab(), Path(args.out),
          rarity=args.rarity, slot=args.slot, known=known, expect=args.expect,
          stop_after=args.stop_after, fps=args.fps, settle=args.settle,
          max_distance=args.max_distance, hash_size=args.hash_size,
          quiet_misses=args.no_beep, debug=args.debug, window=args.window,
          workers=args.workers)


if __name__ == "__main__":
    main()
