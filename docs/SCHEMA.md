# Save file schema

The planner reads and writes one JSON file. This is the contract the Phase 2 OCR pipeline
has to satisfy — produce this shape and the tool consumes it unchanged.

```json
{
  "version": 1,
  "savedAt": "2026-08-07T09:14:22.000Z",
  "nextId": 4001,
  "cards": [
    {
      "id": "c1",
      "slot": "Star",
      "set": "Hindrance",
      "rarity": 5,
      "level": 25,
      "main": "Crit Rate",
      "equipped": "Ren Amamiya",
      "subs": [
        { "stat": "Crit Multiplier", "value": 12.4 },
        { "stat": "ATK%",            "value": 8.7 },
        { "stat": "Resistance Pierce", "value": 5.1 },
        { "stat": "Speed",           "value": 4.4 }
      ]
    }
  ],
  "characters": {
    "Ren Amamiya": { "owned": true, "targets": null }
  }
}
```

## Fields

**`cards[].id`** — any string, unique within the file. The tool regenerates these on load,
so the OCR pipeline can use sequential values.

**`cards[].slot`** — one of `Sun`, `Moon`, `Star`, `Sky`, `Space`. Some guides call `Sky`
the *Planet* slot and `Space` the *Universe* slot; the bulk-paste parser accepts both
spellings, but the JSON must use the canonical five.

**`cards[].set`** — must match a key in `SETS` (four-slot sets) or `SPACE_SETS` (Space
cards) in `src/data.js`. Space-slot cards take a Space set name, never a four-slot set name.

**`cards[].rarity`** — `2`, `3`, `4` or `5`. Determines max level and substat count:
5★ caps at Lv25 with 4 substats, 4★ at Lv20 with 4, 3★ at Lv15 with 3, 2★ at Lv10 with 2.

**`cards[].level`** — integer, `0` to the rarity's cap.

**`cards[].main`** — must be legal for the slot. `Sun` is always `HP` and `Space` is always
`ATK + DEF`; the other three roll from a fixed pool listed in `SLOT_INFO`.

**`cards[].equipped`** — the exact character name it is currently equipped on, or `null`.
Used by the "only unequipped cards" pool filter and by Triage to avoid recommending you feed
something you are wearing.

**`cards[].subs`** — up to four entries. `stat` must be a key in `SUBSTATS`; `value` is the
raw in-game number with no percent sign. A substat never duplicates the card's main stat and
never appears twice on the same card.

**`characters`** — keyed by exact character name from `CHARACTERS`. `owned` drives the
roster and Triage. `targets` is `null` to use the built-in defaults, or a full override
object with `sets`, `space`, `main`, `w`, `bp` and `note`.

## Legal values

Rather than duplicating them here and letting the two drift apart, read them from the
built file:

```js
Object.keys(SUBSTATS)      // the 13 substats
Object.keys(SETS)          // four-slot sets
Object.keys(SPACE_SETS)    // Space cards
SLOT_INFO[slot].mains      // legal main stats for a slot
CHARACTERS.map(c => c.n)   // exact character names
```

## Validating pipeline output

The quickest check is to load the file in the tool and look at the Inventory tab — the
count tells you how many cards survived. For a stricter check, the same normalisation the
bulk parser uses is available: `normStat()` returns `null` for an unrecognised stat name and
`normSet()` returns `null` for an unrecognised set, so run every OCR result through both and
treat `null` as a card that needs a human to look at the screenshot again.

Expect OCR to confuse visually similar values — `8` and `B`, `5` and `S`, decimal points at
small font sizes. A cheap sanity filter: a substat value should never exceed roughly five
times its `maxRoll`, since a card gets at most five upgrade events. `validateCard()` in
`src/logic.js` runs exactly this set of checks (legal slot/set/rarity/level/main, substat
count for the rarity, no duplicate or main-shadowing substat, the `5×maxRoll` bound) and is
the single gate all three import paths (bulk paste, JSON load, merge import) run every card
through — a card that fails it never reaches the inventory.

## Optional fields (schema v2)

Two additional per-card fields are recognised if present, ignored if absent, so v1 files
keep loading unchanged:

- **`cards[].conf`** — an object of per-field confidence, `0`–`1`, for fields the OCR
  pipeline was unsure about, e.g. `{ "main": 0.4 }`. Not yet surfaced in the UI.
- **`cards[].src`** — a string identifying where the card came from (a frame index, a
  screenshot filename). Useful for tracing a bad card back to the source image.

## Importing a rescan without losing your inventory

Loading a file on the Save/Load tab **replaces** `cards` and `characters` wholesale — it is
meant for resuming your own previously-downloaded save, not for merging in newly scanned
cards. For that, the same tab's **Import cards (merge)** control reads a `{ "cards": [...] }`
file and merges it into the current inventory via `mergeImport()`:

Cards have no in-game serial number, so "the same physical card, scanned again" is inferred
from `slot` + `set` + `rarity` + `main` (its fingerprint) plus how close its level and
substat values are to an existing card sharing that fingerprint. An incoming card is
classified as:

- **new** — no existing card shares its fingerprint. Added as-is.
- **a level-up** — shares a fingerprint with an existing card, and every substat the
  existing card already had is present at the same value or higher on the incoming card
  (upgrades only add roll value). The existing card is updated in place; its `id` and
  `equipped` are preserved.
- **a duplicate** — matches an existing card at the same level with the same substat
  values. Skipped.
- **ambiguous** — shares a fingerprint but the numbers don't cleanly fit either case above
  (most often a value decrease, which usually means OCR noise on one of the two scans, but
  could also be a second copy of an identical roll). Never applied automatically — the
  Import Review dialog lists it for a manual decision (skip / add as new / replace
  existing), defaulting to skip.
