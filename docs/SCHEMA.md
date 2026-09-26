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
      "mainValue": 14.4,
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
    "Ren Amamiya": { "owned": true, "benched": false, "targets": null, "loadout": null }
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

**`cards[].mainValue`** — optional. The main stat's magnitude as printed on the card
detail panel. `cardScore()` never reads it — scoring only cares *which* stat the main is —
but no guide site publishes what a main stat is worth at max level, so this is the only
place that number exists, and without it a stat cannot be totalled against a build target.
Absent on every card saved before it existed and on any card the OCR could not read it
from; everything downstream treats missing as **unknown**, never as zero. One scanned
max-level card settles the magnitude for every card like it (it is deterministic, not a
roll), so `mainMagnitude()` fills the gaps from the rest of the inventory.

A Space card prints its `ATK + DEF` main as **two rows**, one per stat. They carried the
same number on every Space panel scanned so far (52 frames, Aug 2026), so `mainValue` on a
Space card is that shared per-stat magnitude — not a sum, and not one of a pair. The OCR
reads both rows and refuses the value rather than picking a side if they disagree, which
is what keeps that claim checkable per card instead of assumed.

**`characters`** — keyed by exact character name from `CHARACTERS`. `owned` drives the
roster and Triage. `targets` is `null` to use the built-in defaults, or the user's edits
from the Targets dialog as a **diff** over them: `{ "v": 2, "sets"?, "space"?, "main"?,
"w"? }`, carrying only what was changed — `main` only the slots changed, `w` only the
stats changed, e.g. `{ "v": 2, "space": "Growth", "w": { "Speed": 6 } }`. A slot's `main` is
a best-first list; an empty list is an open slot ("any" in the dialog), where no main is
preferred. Everything absent,
and always the stat targets, `bp` and `note`, comes from the data, so a later fix to it
still reaches the character. Files saved before Sep 2026 carry a full snapshot instead
(`sets`, `space`, `main`, `w`, `targets`, `bp`, `note`, no `v`); `load()` converts it,
keeping set, Space and main choices that differ from the data and handing any differing
weight back to the data with a note saying which — the old dialog wrote the whole weight
grid on every save, so those were almost always values the data had since corrected. A main
saved for a slot the data now leaves open is handed back the same way and for the same
reason: the data used to fill those slots with a placeholder, and the old dialog saved it.

**`characters[].benched`** — optional, defaults to `false`. Marks a character you own but
are not building. `ownedChars()` filters on `owned && !benched`, so a benched character
disappears from the optimiser dropdown, Triage's "owned" scope, Upgrades and the Vault's
fielded-role count — everywhere except the Roster tab, which shows it (dimmed, with
a "benched" tag) so it can be un-benched later without losing its saved `targets` or
`loadout`. Absent on files saved before this existed, which is read as `false`.

**`characters[].targets.main`** — recommended main stat per slot, keyed `Moon` / `Star` /
`Sky` (Sun and Space are fixed). The value is a **list, best first**, because lufel names
alternatives rather than one answer — Ann's Moon is `["ATK%", "Damage Multiplier"]`, and two
healers get three choices. Every stat in the list counts as on target; the order only breaks
ties. A bare string is still accepted and means a list of one, so files saved before this
existed load unchanged. Nothing reads the field directly — `mainList()` / `mainTop()` in
`logic.js` normalise both shapes.

**`characters[].loadout`** — optional, `null` to use defaults. Everything about the
character that is not a revelation card, because Lufelnet's stat targets are in-battle
totals: `{ level: 80|100, asc: 0-7, weapon: ""|"4"|"5", refine: 1-7, mindSkill: bool,
mind1: 0-5, mind2: 0-5, awareness: 0-6 }`. It matters more than it looks — Kumi Katayama's
180 Speed target needs 73 Speed from cards on a 4★ weapon at A0 with no Mindscape, and 14
on a 5★ R7 at A7 with it fully invested. Edited in the roster's Loadout popup (its Setup
section), for every character, since the fields move the build score's spread term even
without a stat target; the Targets dialog shows a one-line summary that links there, and
until Sep 2026 carried a second copy of the fields. My Palace and party buffs are deliberately
**not** modelled, so every total is a floor.

Mindscape is 4 paths, not one lock. `mind1`/`mind2` are the two that grant a flat/percent
stat (`CHAR_STATS[name].mind[0]`/`[1]`, lufel's `mind_stats1`/`mind_stats2`) — each levels
0-5, scaling linearly up to lufel's published value at level 5 (lufel only ever publishes
that max; the in-between scaling was confirmed by the user against real play, since no
guide site prints it). `mindSkill` covers the other two paths, which raise a skill's
level cap instead of granting a stat, and drives `pickTier`'s "+5" tier variant. Files
saved before this existed carried a single `mind: bool` covering all 4 paths at once;
`charLoadout()` maps `true` to `mindSkill: true, mind1: 5, mind2: 5` and `false` to all-zero
so old saves still load.

`awareness` (default `0`) is the "Awareness" ladder — 7 named passives per character
(0-6), unlocked with Cognitite, unrelated to Ascension/Mindscape/Awakening-7. Absent on
files saved before this existed, read as `0`. It moves a total two ways: a universal
HP/ATK/DEF percentage (102/105/107/110/112/115% of base at levels 1-6, `AWARENESS_STAT_PCT`
in `logic.js`, the same for every character) that always applies, plus whichever named
ability is unlocked at that level — almost always a conditional kit passive, not a flat
stat, so see `CHAR_STATS[name].awareness` in `src/data.js` for the rare case (if any) that
also carries a modelled `s`/`v`/`pct` on top.

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
small font sizes. A cheap sanity filter: a substat value should never exceed its `maxRoll`
times the number of rolls the card can be holding, which is **one plus the upgrades its
level has earned** — upgrades arrive every `maxLevel / upgrades` levels (5, at every
rarity), so a Lv0 card cannot carry more than a single max roll of anything and a Lv25 5★
tops out at six.

Reading that bound off the rarity alone rather than the level misses a whole class of
misread: `Speed 4` on a Lv0 card is under five max Speed rolls, so it imports clean, but
Speed is 2.2 a roll and an unlevelled card has had exactly one. Seven such cards reached
this user's inventory before the bound was tightened.

The bound stays deliberately loose — the roll table is now verified against the client for
5★ cards (see `DATA-SOURCES.md`) but other rarities are not, and rejecting a card the user
genuinely owns is worse than admitting a bad one — so it only rejects what is impossible
outright.

`validateCard()` in `src/logic.js` runs exactly this set of checks (legal
slot/set/rarity/level/main, substat count for the rarity, no duplicate or main-shadowing
substat, the per-level roll bound) and is the single gate all three import paths (bulk
paste, JSON load, merge import) run every card through — a card that fails it never reaches
the inventory.

## Optional fields (schema v2)

Two additional per-card fields are recognised if present, ignored if absent, so v1 files
keep loading unchanged:

- **`cards[].conf`** — an object of per-field confidence, `0`–`1`, for fields the OCR
  pipeline was unsure about, e.g. `{ "main": 0.4 }`. Not yet surfaced in the UI.
- **`cards[].src`** — a string identifying where the card came from (a frame index, a
  screenshot filename). Useful for tracing a bad card back to the source image.

## Optional fields (schema v3)

- **`prefs`** — an object of UI view state: the Roster tab's `rsFilter` (`all` / `owned` /
  `unowned`) / `rsElement` / `rsSort` / `rsHideBenched` / `rsQ` and its view (`rsView`:
  `cards` or `list`), the Inventory tab's `flSlot` / `flSet` / `flRar` / `flMain` / `flSub` /
  `flQ` and its column sort (`invSort: { key, dir }`), the Triage/Vault/Upgrades scope selects
  (`trScope`, `trShow`, `trRar`, `vaRar`, `vaShow`, `upRar`) and Triage's verdict chips
  (`trVerdict`, the pressed tiers 0-5). Written by `collectPrefs()`, read by `applyPrefs()` in
  `src/logic.js`. Ignored if absent, so v1/v2 files keep loading unchanged; any field the
  loading build no longer recognises (a renamed set, a dropped filter option) is likewise
  ignored rather than rejected. Files saved before Sep 2026 may carry `rsHideUnowned`, the
  Roster's old "Hide not owned" checkbox: when true it opens the Roster on `owned`.
- **`settings`** — scoring assumptions, as opposed to view state. Two today, both written by
  `savePayload()`:
  - `teamCritRate`, the team crit rate (the header's scoring settings), in percentage points (0-100): the crit
    rate the user's usual supports add to every damage dealer when cards are valued. Absent, or anything
    that is not a positive number, reads as 0, which is how files saved before it existed load.
  - `thievesDen`, the Thieves Den's battle effects (same popover): an object of flat points per stat, from
    `ATK`, `HP`, `DEF`, `Speed`, `Crit Rate`, `Crit Multiplier`, `Ailment Accuracy` and `SP Recovery`, e.g.
    `{ "ATK": 119, "HP": 473, "Crit Rate": 1, "Crit Multiplier": 2 }`. Only stats with a value are written.
    It is added to the in-battle totals a stat target is checked against, nothing else. Absent keys, and
    anything not a positive number, read as 0.

## Importing a rescan without losing your inventory

Loading a file (the header's **Load**, the Data tab, or dropping a save file on the page)
**replaces** `cards` and `characters` wholesale — it is meant for resuming your own
previously-downloaded save, not for merging in newly scanned cards. For that, **Import scan**
(the header, or the Data tab's **Import cards (merge)**; a dropped file with no `characters`
goes the same way) reads a `{ "cards": [...] }`
file and merges it into the current inventory via `mergeImport()`. The Inventory tab's
bulk-paste box accepts the same JSON pasted as text — anything starting with `{` or `[` is
parsed as JSON and routed to the same review rather than to the one-card-per-line parser.

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

Which existing card an incoming one is measured against is decided **by confidence, not by
arrival order**: within a fingerprint, exact rescans claim their counterparts first, then
clean level-ups, and only what is unclaimed on both sides is paired up for review — and
inside each pass the closest pair wins across the whole pool. Resolving it greedily in scan
order instead lets a genuinely new card claim the existing card that the *next* incoming
card is an exact rescan of, after which the whole run shifts by one and every card in it is
reported ambiguous against somebody else's twin. Results still come back in scan order, so
the review table lines up with the file you handed over.
