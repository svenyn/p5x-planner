# OCR runbook — scanning cards into the planner

How to get cards off the game screen and into `dist/p5x-planner.html`, end to end.
The *why* behind each design decision is in `CLAUDE.md` (§ OCR ingestion); this is the
operating manual.

## 0. Setup, once per session

Nothing here is on PATH. Every command below assumes these two:

```powershell
$env:Path += ";C:\Program Files\Tesseract-OCR"
$PY = "C:\Users\neute\AppData\Local\Programs\Python\Python312\python.exe"
```

**Run everything from `ocr/`.** Most scripts default their `--regions`, `--out` and
`--dir` to paths beside the script, so the working directory rarely matters — except
`pipeline.py`, whose `--out` default (`cards.json`) is relative to the current
directory. Staying in `ocr/` keeps every batch in one place.

```powershell
cd C:\Users\neute\Downloads\p5x-planner\ocr
```

The game must be in **borderless windowed**, not fullscreen exclusive — `ImageGrab`
sees an all-black frame through exclusive mode.

## 1. The commands at a glance

| Command | What it does | Sends input? |
|---|---|---|
| `watch.py --probe` | One settled frame; reports resolution, lit tab, and the card it read. **Start here.** | no |
| `calibrate.py` | Drag boxes on a screenshot → `config/crop_regions.json`. Once per resolution. | no |
| `autowalk.py` | Walks the grid with WASD *and* reads it. One run per rarity. | **yes** |
| `watch.py` | Reads the panel while **you** tap through the list. | no |
| `pipeline.py` | Re-reads a directory of frames (or a recording) through the current code. | no |
| `review_cards.py` | Walk a batch's review pile, correct each card, merge. | no |
| `merge_review.py` | Merge a review file you edited in a text editor. | no |
| `build_level_templates.py` | Bootstrap `config/level_templates.json` from frames with known levels. | no |
| `extract_frames.py` | Recording → deduplicated frames (needs ffmpeg — **not installed here**). | no |

Two facts drive most of the flags:

- **Rarity cannot be read off the panel at all**, so it is per run: set the game's rarity
  filter, pass `--rarity`.
- **Slot *is* read per frame** off the tab strip. Only pass `--slot` as a fallback for
  frames whose strip cannot be read — and never together with `--tabs`.

## 2. Step plan — a full scan

### Step 1 — probe

```powershell
& $PY watch.py --probe
```

Five-second countdown, then it grabs one settled frame, saves it as `_probe.png`, and
prints what it saw. Read that output before anything else:

- **all black** → game is fullscreen exclusive; switch to borderless windowed
- **wrong resolution** → the crop fractions were calibrated on a different screen
- **no lit tab** → the inventory is not open, or `slot_tabs` is miscalibrated
- **fields read as nonsense** → recalibrate (step 2)

Flags: `--probe-delay 5` (countdown), `--window "<title>"` (grab a window's client area
instead of the whole screen), `--rarity`, `--slot`.

### Step 2 — calibrate (only if the probe was wrong, or the resolution changed)

Two runs, because there are two panel layouts — a Space card has a second main-stat row
that pushes its four substats down one.

```powershell
& $PY calibrate.py _probe.png
& $PY calibrate.py path\to\space-card.png --layout space
```

Drag a box per field, Enter/Space to confirm, Enter with no drag to skip a field this
card does not have, Esc to cancel the whole run without writing. Both runs merge into the
same `config/crop_regions.json`. Boxes are stored as fractions of image size, so this is
once per resolution, not once per screenshot.

- `--layout {heavens,space}` — which set of boxes to write (default `heavens`)
- `--only FIELD [FIELD…]` — re-do just those fields
- `--out` — target file

**Recalibrating the `level` box invalidates `config/level_templates.json`** — the
templates are tied to a (crop box, pixel size) pair and refuse rather than compare
nonsense. Re-run step 6 if that happens.

### Step 3 — read the cards

Two ways. Pick one.

#### 3a. autowalk — hands-off, sends keys

Always dry-run first:

```powershell
& $PY autowalk.py --tabs all --dry-run
```

Then for real, one run per rarity filter:

```powershell
& $PY autowalk.py --tabs all --rarity 5 --out cards-43.json
```

It counts down 5s, locks to whatever window is in the foreground, rewinds to the first
card, walks `D S A S`, reads each card, stops when the list runs out, clicks to the next
tab and repeats. **Alt-tab is the stop gesture** — it will not send a key or a click
unless the locked window is still in front.

| Flag | Default | Meaning |
|---|---|---|
| `--tabs` | the open tab only | `all` (starts on the lit one, rotates) or a list: `--tabs Sun,Moon` |
| `--rarity {2,3,4,5}` | none | stamps every card; **set the game's filter to match** |
| `--count N` | 5000 | hard ceiling on keys **per tab**; the list ending is what normally stops it |
| `--dry-run` | off | prints the plan, sends nothing |
| `--no-rewind` | off | you have already selected the first card |
| `--no-read` | off | walk only; run `watch.py` separately to do the reading |
| `--pattern` | `DSAS` | the repeating walk cycle (two cards per row) |
| `--out` | `ocr/cards.json` | auto-suffixed `-2`, `-3`… if it already exists |
| `--start-delay` | 5.0 | seconds to alt-tab to the game before it starts |
| `--interval` | 0.4 | *minimum* seconds between keys — pacing is closed-loop, this is only a floor |
| `--settle` / `--fps` / `--max-distance` | 0.25 / 8 / 8 | panel-settle gate; leave alone |
| `--settle-timeout` | 3.0 | how long to wait before calling a key a no-op |
| `--tab-timeout` | 6.0 | how long to wait for the strip to confirm a tab click |
| `--workers` | 3 | cards OCR'd at once; sets the pace once the queue fills |
| `--max-pending` | 16 | frames allowed to queue before the walk waits (0 = unbounded; each entry is a full-screen image) |
| `--window` | whole screen | grab a window's client area |
| `--known` / `--expect` / `--stop-after` | — | catch-up mode, see 3b |
| `--no-beep` | off | silence the missed-card click |
| `--slot` | — | fallback slot; **not allowed with `--tabs`** |

If a tab click fails, the frame it last saw is written next to the output as
`<out>-tab-<slot>.png` — look at that before guessing why.

#### 3b. watch — you tap, it only looks

```powershell
& $PY watch.py --rarity 5 --out cards-43.json
```

Leave it running and click through the inventory yourself. It fires a capture once the
panel has held still for `--settle` seconds, and clicks at you (unless `--no-beep`) for
every card you tapped past unread. Ctrl-C to stop; it drains the OCR queue and writes.

Catch-up after new pulls — sort the inventory by order obtained, start from the newest:

```powershell
& $PY watch.py --known ..\my-save.json --expect 40 --rarity 5 --out catchup.json
```

| Flag | Default | Meaning |
|---|---|---|
| `--known FILE` | — | a save exported from the app; labels each card new or already-held |
| `--expect N` | — | stop after N **new** cards (needs `--known`) |
| `--stop-after K` | — | stop after K consecutive already-held cards (needs `--known`) |
| `--rarity {2,3,4,5}` | none | stamp; the one thing that cannot be read |
| `--slot` | read per frame | fallback only |
| `--fps` / `--settle` / `--max-distance` / `--hash-size` | 8 / 0.25 / 8 / 8 | capture gate |
| `--workers` | 3 | OCR threads |
| `--window` | whole screen | grab a window's client area |
| `--probe` / `--probe-delay` | off / 5.0 | step 1 |
| `--no-beep` | off | stay silent on a missed card |
| `--debug` | off | verbose |

`--known` is only a stopping rule. Every card read is written out regardless, and the
app's `mergeImport` remains the authority on new vs levelled-up vs duplicate.

### Step 4 — what a run leaves behind

Each run writes a pair beside `--out`:

- `cards-43.json` — clean cards, ready to import
- `cards-43-review.json` — anything with errors or notes
- `_frames/cards-43-00001.png` … — the frame behind every card, named after the output

An existing `--out` is never overwritten: the next run becomes `-2`, `-3`, and so on.

### Step 5 — review

```powershell
& $PY review_cards.py cards-43 --shots "C:\Games\Steam\userdata\98509649\760\remote\3061570\screenshots"
```

The stem is the batch name without `.json`. For each flagged card it prints the panel as
read plus the notes that flagged it, then waits:

```
  [number] edit   [a]ccept   [d]rop   [o]pen shot   [q]uit
```

- **number** — edit that field. Typed values are normalised the same way the OCR's are
  (`crit dmg` → Crit Multiplier, `ail acc` → Ailment Accuracy, `Acceptence` →
  Acceptance); something that does not resolve is refused rather than written through.
- **a** — accept. Runs the same `validate_card` the pipeline uses and refuses an illegal
  card, and **teaches the level templates** the corrected render, so a level is
  unreadable at most once.
- **d** — drop it. **o** — open the screenshot in your image viewer. **q** — stop; the
  rest stay in the review file.

At the end it calls `merge_review` for you: accepted cards land in `cards-43.json`,
everything else stays in `cards-43-review.json`.

| Flag | Default | Meaning |
|---|---|---|
| `stem` (positional) | `cards` | batch name without `.json`, e.g. `cards-43` |
| `--shots DIR` | `$env:P5X_SHOTS` | searched recursively; enables `o` and level learning |
| `--dir` | `ocr/` | where the json files live |
| `--no-learn` | off | do not teach corrected levels to the templates |

If you would rather edit the review JSON in a text editor, do that and then:

```powershell
& $PY merge_review.py cards-43
```

An entry merges only once **both** its `errors` and `notes` lists are empty. Clearing a
note is how you say "I looked at the screenshot and this is right now" — validation
cannot stand in for it, because a real Lv.18 misread as Lv.8 is a perfectly legal card.
Safe to re-run: entries already in `cards.json` are skipped.

### Step 6 — import into the app

Open `dist/p5x-planner.html`, Save/Load tab, **Import cards (merge)**, and give it
`cards-43.json`. There is no browser storage, so export the save yourself afterwards.

## 3. Re-reading a batch instead of rescanning

A review pile from before a bug fix is replayable, not something to rescan. Every flagged
card keeps its frame, and `pipeline.py` takes a directory of images:

```powershell
& $PY pipeline.py _frames --rarity 5 --out redo.json
```

| Flag | Default | Meaning |
|---|---|---|
| `source` (positional) | — | a directory of screenshots, **or** a screen recording |
| `--rarity {2,3,4,5}` | none | stamp; without it every card goes to review |
| `--slot {Sun,Moon,Star,Sky,Space}` | read per frame | fallback only |
| `--regions` | `config/crop_regions.json` | crop boxes |
| `--out` | `cards.json` *(relative to cwd)* | auto-suffixed if it exists |
| `--fps` / `--max-distance` | 2 / 4 | recording sampling + dedup; ignored for a directory |

The recording path needs `ffmpeg`, which is **not installed on this machine** — that is
also why `ocr/tests/test_extract_frames.py` always errors. Use a frames directory.

## 4. Level templates

Levels are matched against stored renders rather than OCR'd (`levels.py`) — Tesseract
cannot read that field and never could. Nine renders ship. Correcting a level in
`review_cards.py` teaches it, so this is normally self-maintaining. To bootstrap from
scratch:

```powershell
& $PY build_level_templates.py --cards "cards*.json" --shots "C:\Games\Steam\userdata\98509649\760\remote\3061570\screenshots"
```

| Flag | Default | Meaning |
|---|---|---|
| `--shots` (**required**) | — | one or more directories of frames |
| `--cards` | `cards*.json` in `ocr/` | which recorded cards to learn from |
| `--regions` | `config/crop_regions.json` | must match what produced the frames |
| `--out` | `config/level_templates.json` | |
| `--keep-existing` | off | add to the current templates rather than rebuilding |

A level is accepted only once every frame claiming it agrees pixel for pixel.

## 5. Tests

```powershell
& $PY -m pytest tests --ignore=tests/test_extract_frames.py
```

The ignore is the missing ffmpeg, not a real failure.

## 6. Rules of thumb

- **A wrong card read is almost always crop calibration, not OCR code.** Diagnose from
  the pixels — threshold a region and read its column/row profiles across a whole batch —
  before touching the parsing.
- **The one exception is the main-stat label**, a looping marquee for names too long for
  the box. Scrambled or wrapped text (`ntAcc. A`) means the marquee and no capture timing
  fixes it; text cut off at a box edge means calibration.
- **Optimise the wrong-and-trusted column, never the accuracy column.** A flagged card
  costs a few seconds in review; a confidently wrong one reaches `cards.json`.
- Do not delete a batch's `_frames/` while its review file is still open.
- `autowalk.py` is the only thing here that sends input, deliberately. Do not add evasion,
  and do not add input automation anywhere else without asking.
