# P5X Revelation Planner

A read-only build tracker and Revelation Card recommender for *Persona 5: The Phantom X*.

It answers three questions: what should this character be wearing, what does that cost me
compared to the alternatives, and which of these several thousand cards can I safely feed
away.

Nothing talks to the game. Nothing talks to a server. It is one HTML file that reads a JSON
file you control.

## Quick start

```
npm install
npm run build
```

Then open `dist/p5x-planner.html` in any browser. To pick up where you left off, load your
save file on the **Save / Load** tab.

## On your phone

A phone will not run a local HTML file properly, so the phone version lives on a web
address — GitHub Pages, which is free — and installs from there as an app with its own
icon that also opens with no connection.

```
npm run site
```

This writes a `site/` folder: the same page as `dist/p5x-planner.html`, plus what a phone
needs to install it (an app manifest, icons, and a small offline helper, `sw.js`).
`dist/p5x-planner.html` itself is unchanged.

One-time setup on GitHub:

1. Create a new **public** repository, e.g. `p5x-planner`.
2. On its empty page choose **uploading an existing file**, drag in everything inside
   `site/`, and commit.
3. **Settings → Pages**: Source "Deploy from a branch", branch `main`, folder `/ (root)`,
   Save. After a minute the app is at `https://<your-username>.github.io/p5x-planner/`.

On the phone, open that address, then:

- **Android (Chrome):** menu ⋮ → **Install app** (or **Add to Home screen**).
- **iPhone (Safari):** Share → **Add to Home Screen**.

To update it later: `npm run site` again and upload the new `site/` files over the old
ones. The installed app picks up the new version the next time it opens online.

Things that work differently on a phone:

- **Share one save between the laptop and the phone** with **Data → Sync with GitHub**: the
  save goes in a private repository of yours (free), and the header's Load and Save then
  use it. The setup steps are in that section. Without it, each device has its own save
  file and you move the `.json` between them.
- **Save before you leave the app.** A phone closes apps without asking, so the
  "unsaved changes" warning a laptop browser shows cannot be relied on.
- **Portraits are left out**, because the site is public and game art is not ours to
  redistribute; the roster shows initials instead. `npm run site -- --with-art` includes
  them if you accept that.
- Triage over a few thousand cards takes noticeably longer on a phone.

## The tabs

**Optimise** picks a full loadout — Sun, Moon, Star, Sky and a Space card — for one
character. It compares four kinds of plan against each other: a full 4-piece set, a 2+2
split, a 2-piece with the remaining slots free, and pure stat maximisation with no set bonus
at all. The winner is shown with every card's substats annotated by roll value, and the
runners-up are listed with the score gap so you can see what you are giving up.

The **Set policy** control decides how much the optimiser is allowed to care about set
bonuses, and **4-piece value** decides how much a 4-piece effect is worth relative to raw
substats. That second number is a judgement call rather than a known quantity, which is
exactly why it is exposed — raise it if you think set effects matter more than the default
assumes.

**Teams** builds a party around one character, usually a damage dealer. By default it
calculates: every team you can field is priced by how much stronger it makes that character's
hits, using lufel's damage formula and each member's kit (their buffs and debuffs, unlocked by
their Awareness and weapon, scaled by their own stats, for as many turns as their rotation keeps
them up). Each seat shows what that member adds and what their kit does that the calculation
cannot price; lufel's own recommended team is priced the same way for comparison. Kits are
entered for the whole roster. Wonder counts too: enter his Persona, three skill cards and weapon
on the tab (saved with your save file), and it also suggests the setup that would help that team
most, if you own it. **Build from: lufel's recommended teams** switches to the list-based view
described next. That view starts from the
teams lufel.net recommends with them and fills every seat from the characters you own: lufel's
own pick where you have them, otherwise whoever lufel links to that character most (the same
seat in another of their teams, a synergy partner it names with its reason, the same role), and
only then your best-built character, marked "filler". Each seat lists replacements, and **Busy
elsewhere** takes someone out when they fight in another team, rebuilding the rest. Below the
team: the order the thieves act in by Speed (with their worn cards; Wonder's comes from the
**Wonder's Speed** field, since it depends on his Persona), lufel's skill rotation for
each member at the Awareness their Setup says, any of lufel's stat targets they are short of,
and the synergies lufel names between the members. With Fuuka as the Elucidator a fifth seat
holds the backup her Oracle Shift swaps in, chosen from the backups lufel recommends for her,
with a plain explanation of how the swap works.

**Inventory** takes cards one at a time through a keyboard-driven form, or in bulk through
a paste box. The bulk format is one card per line:

```
Slot | Set | Rarity | Level | Main stat | sub value, sub value, ...
Star | Hindrance | 5 | 25 | Crit Rate | CDMG 16.4, Pen 8.4, ATK% 14, SPD 6.6
```

Stat and set names are matched loosely, so `CDMG`, `Crit DMG` and `Crit Multiplier` all
resolve to the same stat, and `Planet` and `Sky` are the same slot.

**Triage** is the tab built for a large inventory. It scores every card against every
character you own, rates it by its best match, and sorts worst-first. The bottom of that
list is your feed pile.

**Score** is not "what is this card worth on its own". It is how many points equipping the
card would actually add to someone's build score, given what they already have equipped —
so it counts stats, set fit and stat spread together, against their real weapon and
ascension. A card that piles more onto a stat a build already has plenty of scores low even
when its raw stats look strong, which is the whole point: a fifth source of Crit Multiplier
is not worth what the first was.

**Best fit** names whoever that gain is largest for, so the two columns agree by
construction. An element-locked set such as Strife is filtered to Fire characters before
either is worked out, and Best fit reads "no one in scope" when you own none of them. In
that one case Score widens to the whole roster instead, so a strong Fire card is not marked
feed just because you have not pulled a Fire character yet.

**Vault** is the counterweight. Triage only knows today's roster, so it will call a card junk
that a character you have not pulled would want — and a fed card does not come back. This tab
lists what is worth locking in the game client, ranked without any reference to who you own.
A card qualifies if it is loaded with the stats every damage dealer wants, or if it lands in
the top few percent of your inventory for one of the eight archetypes. Rankings are within a
slot, so Sun cards compete with Sun cards. Where the roster cannot field the archetype a card
suits, it says so — those are the expensive ones to feed by mistake.

**Upgrades** is two views of one page. **Better cards available** sweeps every character
you own at once and lists the swaps that would actually improve what they wear, including
cards currently equipped on someone else — those are tagged with their owner, since taking
one is a trade rather than a free win. Rows that make up a single 4-piece switch are
bracketed together with what the whole switch is worth, because most of that is the set
bonus and it only lands once all four are equipped.

**Weakest slots** answers the other half. It is one row per equipped slot, ranked by
*headroom* — the raw score a perfect card for that slot would add over the one worn now.
That is bounded by what the game can mint rather than by what you own, so a slot holding
the best card in your inventory can still be the weakest thing on the character, which is
the case the swap list cannot show you. Headroom is in one character's own score units, so
it compares that character's five slots and nothing else; the **Build +** column beside it
is the same question in build-score points, which do compare across characters, and the
table sorts on that. **Available now** is the best card of the same slot *and the same set*
you already own — same set, so equipping it cannot break a 4-piece — with what the swap is
worth and a button to do it. Filter by element, slot, equipped rarity or minimum headroom,
or narrow to empty slots, each character's single worst slot, or only the slots you can fix
today.

**Roster** holds all 65 characters as portrait cards in release order, laid out like
lufel.net's. Every
target is editable: preferred sets, the Space card, main stat per slot, and a weight from 0
to 10 for each of the thirteen substats. Characters whose builds are documented carry real
published targets; the rest carry archetype defaults and are flagged.

Portraits are optional and nothing ships with the build — game art is not this project's to
redistribute, and 65 embedded images would bloat the single-file build. `dist/art/` is
gitignored for the same reason. To fetch them from lufel.net:

```
npm run export-tables       # fetch-art matches names against dist/tables.json
python tools/fetch-art.py --dry-run   # check the name matching first
python tools/fetch-art.py
```

That covers all 65 characters. Anything the name matching cannot resolve with confidence is
reported and skipped, and keeps its placeholder — a wrong portrait is worse than none. To
add one by hand, drop a `.webp` into `dist/art/` named after the character in lowercase with
non-letters replaced by hyphens:

```
dist/art/ren-amamiya.webp
dist/art/ren-amamiya-starlight.webp
dist/art/justine-caroline.webp
```

Any portrait that is missing falls back to an element-tinted placeholder, so a partial set
is fine. Portraits are loaded relatively, which works when opening the file directly but
not in the Cowork artifact build, where the placeholders are always used.

**Save / Load** downloads and restores the save file, and merges an incremental scan into
the inventory you already have. Nothing persists on its own between sessions.

**Scanning cards** is the written procedure for the OCR pipeline in `ocr/` — install,
capture, calibrate, run, import, and work the review pile, with a table of what each failure
mode actually means. It is documentation only; the page runs nothing. `docs/shot-howto.png`
is a render of it.

## How scoring works

A substat is converted to **roll value** — its magnitude divided by the largest single roll
that stat can produce — so that 12.4% Crit Multiplier and 5.5 Speed can be compared on one
scale. Roll values are multiplied by that character's weight for the stat and summed. The
main stat counts at its real magnitude for the card's level — about nine rolls at max level,
as much as all four substats of a perfect card — plus a small tie-break bonus for matching
the target. Set bonuses are converted onto the same scale: a 2-piece "+12% ATK" is worth
however many maximum ATK% rolls that is.

Those plan scores are **ordinal**. They are only meaningful when comparing loadouts for the
*same* character — a 260 for one character and a 240 for another tell you nothing.

Two numbers in the interface are not ordinal and can be read across characters: the **build
score** on the Roster tab, which is a percentage of what a perfect loadout for that same
character would reach, and Triage's **Score**, which is measured in build-score points.

## What to be skeptical about

The game data was assembled from community guides in August 2026, not read out of the game
client. Four things are worth knowing, and `docs/DATA-SOURCES.md` covers them in full:

Guide sites do not agree on set names, so two sets that appear in build guides — **Ruin**
and **Prudence** — could not be matched to any verified set list and carry unknown 2-piece
effects. No source publishes what a main stat is actually worth, so the magnitudes were
measured off the user's own scanned 5★ cards; the substat roll tables were verified against
the same scan (other rarities have not been scanned). And 10 of
the 65 characters have a published build whose best set or Space card is not out yet, so
they carry the best obtainable alternative and are marked `med` confidence in the interface.

All of it is editable, and all of it improves the moment it is checked against real
screenshots.

## Repository layout

```
build.js                 concatenates src/ into dist/, no bundler
src/data.js              game data only — slots, stats, sets, characters
src/ui.html              markup and CSS
src/logic.js             scoring engine, optimiser, rendering
dist/p5x-planner.html    the build output; this is the whole app
test/optimizer.test.js   155 headless assertions, exits non-zero on failure
test/scale.js            4000-card benchmark across all four set policies
test/screenshots.js      renders docs/shot-*.png for visual review
ocr/                     the OCR pipeline — capture to cards.json
ocr/watch.py             live screen capture; the usual way in
ocr/autowalk.py          walks the list with WASD as well as reading it — opt-in
ocr/levels.py            level read by template match, not OCR
ocr/build_level_templates.py   bootstraps those renders from frames you have already read
ocr/review_cards.py      walk the review pile; correcting a level teaches it
tools/export-tables.js   exports src/data.js as dist/tables.json for the pipeline
docs/SCHEMA.md           save-file format
docs/DATA-SOURCES.md     provenance and what to verify
docs/SCORING.md          how scores and card recommendations are calculated
CLAUDE.md                working notes for Claude Code
```

## Scanning cards instead of typing them

`ocr/` reads card detail panels off the screen and writes the JSON the **Save / Load** tab
imports. Everything in it reads pixels and nothing else, with one deliberate exception noted
below.

```
pip install -r ocr/requirements.txt
npm run export-tables                                    # dist/tables.json, the vocabulary
python ocr/calibrate.py one-screenshot.png               # once per device
python ocr/watch.py --probe --rarity 5                   # confirm it can see the game
python ocr/watch.py --rarity 5                           # then click through the cards
```

**Run the probe first.** It waits for the panel to settle, grabs one frame and reports the
resolution, the lit slot tab and the card it read. Fullscreen-exclusive mode (an all-black
grab), a resolution that does not match the calibration, and a miscalibrated crop box all
look like OCR faults otherwise, and they have completely different fixes. Playing windowed
needs `--window "Persona5"` so it grabs the game's client area rather than the whole screen.

`watch.py` reads panels off the live screen as you click, so there is no screenshot key and
no folder of images to move afterwards. It only reads a panel that has held still, which
rules out the half-drawn stat labels a hand-taken screenshot can catch, and it counts (and
clicks at you about) any card you tapped past. `python ocr/pipeline.py shots/ --rarity 5
--slot Star` still takes a directory of screenshots or a screen recording if you would
rather capture by hand.

`ocr/autowalk.py --rarity 5 --tabs all` sends the WASD keys as well, so one command walks
every tab, reads every card and exits: it rewinds to the first card (reading the grid's
selection frame to know which column it is in, because the client wraps at row edges), walks
the list, knows the end when a whole cycle turns up nothing new, clicks the next tab (and
checks the strip really changed before sending another key), and repeats. Set the game's rarity filter first
and run once per rarity — rarity is the one thing the screen does not show. **That is the
exception to the pixels-only rule** — a fixed repeating key cycle is the shape of a macro
and a ban risk, it is opt-in, it lives in its own file, and it carries no timing
randomisation or anything else meant to avoid notice. Its interlocks are real: `--dry-run`
prints the plan and sends nothing, the foreground window is rechecked before every key and
click so alt-tab stops it, `--count` is a hard ceiling per tab, and a cycle that moves
nothing new ends the tab. `watch.py` does the same job with your own fingers.

The card **level** is not OCR'd. Tesseract cannot read that small slanted font
reliably — two captures of the same card differ by nine pixels and that is enough to turn
`Lv.0` into `9` — but the UI renders a given level identically every time, so it is matched
against known renders instead. On 4025 labelled frames that is 4025 correct, 0 wrong. A
render it does not know comes back *unknown* and goes to review, never rounded to the
nearest level it does know; correcting one there teaches it.

Catching up after a few pulls is `--known p5x-save.json --expect 12`: sort the inventory by
order obtained, start from the newest end, and it stops once it has found the twelve new
ones.

Rarity is not printed on the detail panel, so a run is scanned one rarity tier at a time.
The slot is read from the tab strip by colour on every frame, so tabs can be mixed freely.
Every card is also checked against what the scan itself proved: a level-0 substat must be
one of its stat's five roll values, the main stat's value must be the one its level prints,
and a card past its first upgrade must carry its full substat count — a misread that slips
under the range check is caught there. Cards that read cleanly land in
`cards.json`; everything ambiguous lands in `cards-review.json` with the frame it came from
and what went wrong. The full procedure, including what to aim each crop box at and what
each failure mode means, is the **Scanning cards** tab in the app.
