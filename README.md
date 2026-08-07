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

## The four tabs

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

**Roster** holds all 63 characters. Every target is editable: preferred sets, the Space
card, main stat per slot, and a weight from 0 to 10 for each of the thirteen substats.
Characters whose builds are documented carry real published targets; the rest carry
archetype defaults and are flagged.

## How scoring works

A substat is converted to **roll value** — its magnitude divided by the largest single roll
that stat can produce — so that 12.4% Crit Multiplier and 5.5 Speed can be compared on one
scale. Roll values are multiplied by that character's weight for the stat and summed. The
main stat is worth roughly three rolls, plus a bonus for exactly matching the target. Set
bonuses are converted onto the same scale: a 2-piece "+12% ATK" is worth however many
maximum ATK% rolls that is.

Scores are ordinal. They are only meaningful when comparing options for the *same*
character — a 260 for one character and a 240 for another tell you nothing.

## What to be skeptical about

The game data was assembled from community guides in August 2026, not read out of the game
client. Four things are worth knowing, and `docs/DATA-SOURCES.md` covers them in full:

Guide sites do not agree on set names, so two sets that appear in build guides — **Ruin**
and **Prudence** — could not be matched to any verified set list and carry unknown 2-piece
effects. No source publishes what a main stat is actually worth at level 25. The substat
roll tables come from a single source and were never checked against the client. And 25 of
the 63 characters have no published build at all, so they carry archetype defaults that are
marked `low` confidence in the interface.

All of it is editable, and all of it improves the moment it is checked against real
screenshots.

## Repository layout

```
build.js                 concatenates src/ into dist/, no bundler
src/data.js              game data only — slots, stats, sets, characters
src/ui.html              markup and CSS
src/logic.js             scoring engine, optimiser, rendering
dist/p5x-planner.html    the build output; this is the whole app
test/optimizer.test.js   17 headless assertions, exits non-zero on failure
test/scale.js            4000-card benchmark across all four set policies
test/screenshots.js      renders docs/shot-*.png for visual review
docs/SCHEMA.md           save-file format
docs/DATA-SOURCES.md     provenance and what to verify
CLAUDE.md                working notes for Claude Code
```

## Not built yet

Phase 2 is an OCR pipeline that reads card detail panels from a screen recording and writes
the save-file JSON directly, so a four-thousand-card inventory does not have to be typed.
It is blocked on real screenshots to calibrate against. The design constraint is that it
reads pixels only and never sends synthetic input into the game client.
