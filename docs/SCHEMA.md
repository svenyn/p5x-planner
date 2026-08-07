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
times its `maxRoll`, since a card gets at most five upgrade events.
