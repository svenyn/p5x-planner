# P5X Revelation Planner — working notes for Claude Code

Read-only build tracker and Revelation Card recommender for the gacha game
*Persona 5: The Phantom X*. The user has ~4000 cards and needs to know which to equip,
on whom, and which are safe to feed away.

## Commands

```
npm install          # playwright only, used for tests
npm run build        # src/ -> dist/p5x-planner.html
npm test             # build, then run assertions headlessly; exits non-zero on failure
npm run scale        # 4000-card synthetic benchmark, compares set policies
npm run shots        # writes docs/shot-*.png for visual review
npm run export-tables # build, then write dist/tables.json — the slot/set/substat/alias/
                       # character vocabulary the OCR pipeline should read instead of
                       # hand-copying src/data.js
```

There is no dev server and no bundler. `dist/p5x-planner.html` must stay a single
self-contained file that runs from `file://`. Open it directly in a browser.

## Architecture

Three sources concatenated by `build.js` in this order — the order matters, `logic.js`
executes immediately on load and depends on both of the others:

| File | Contains |
|---|---|
| `src/data.js` | Game data only, no behaviour. Slots, substat roll tables, 22 sets, 15 Space cards, 8 archetypes, 63 characters. |
| `src/ui.html` | All markup and CSS. No `<script>` tags. |
| `src/logic.js` | State, scoring engine, optimiser, rendering, event wiring. |

### Hard constraint: no browser storage

`localStorage` and `sessionStorage` are **not available** — this ships as a Cowork
artifact where those APIs fail. Persistence is explicit JSON download/upload only
(`save()` / `load()` in `logic.js`). Do not add browser storage; it will silently break
the artifact build.

### Scoring engine

Everything routes through four functions in `src/logic.js`:

- `cardScore(card, target)` — weighted **roll value** of substats (`value / maxRoll`, so
  stats on different scales compare fairly), plus the main stat at `weight * 3.0` with a
  `+10` bump when it matches the character's target, all scaled by a rarity penalty.
- `bonus2Value(set, char, target)` — a 2-piece "+12% ATK" is worth however many maximum
  ATK% rolls that is, times that stat's weight. Returns 0 for off-element sets.
- `bonus4Value(set, char, target, base)` — `base` defaults to 55 and is user-adjustable in
  the UI. Preferred set gets `base`, secondary `base * 0.72`, anything else `base * 0.22`.
- `bestPlan(char, pool, opts)` — enumerates 4-piece, 2+2, 2-piece-plus-free and no-set
  plans, dedupes identical loadouts, then filters by `opts.policy`
  (`pref` | `force4` | `any4` | `stats`) and returns the winner plus alternatives.

Scores are **ordinal, not cardinal**. They are only meaningful when comparing options for
the same character. Do not present them as damage percentages or add cross-character
comparisons that assume a shared scale.

### Why the set policy exists

Left to pure stat maximisation the optimiser almost always drops set bonuses, because an
unconstrained pick from a large inventory beats one restricted to a single set. That is not
how the game is played, so `policy: 'pref'` is the default and the UI reports what honouring
the set costs in raw stats. If you change scoring, re-run `npm run scale` and check the
distribution of plan kinds stays sane across all four policies.

## Data provenance — read before touching src/data.js

All game data came from community guides in August 2026, **not from the game client**.
`docs/DATA-SOURCES.md` has the full accounting. The load-bearing caveats:

1. **Guide sites disagree on set names.** Game8, Prydwen and Fragster each use different
   translations. `SET_ALIASES` holds only mappings with real evidence — `strength -> Power`
   is confirmed because both have identical Space-card pairings. **Do not add speculative
   aliases**; a wrong one silently corrupts the user's imported inventory. Two names,
   `Ruin` and `Prudence`, could not be matched to anything and are separate `SETS` entries
   with `unverified: true` and `bonus2: null`.
2. **Main stat magnitudes are unpublished.** No source lists what a main stat is worth at
   Lv25, so main stats are weighted by priority, not real numbers.
3. **Substat roll tables are single-sourced** (Prydwen) and unverified against the client.
4. **25 of 63 characters have no published build** and carry archetype defaults, marked
   `conf: 'low'`. These are guesses and the UI says so.

When the user supplies real screenshots, correcting this data is higher value than any
code change. Prefer fixing `src/data.js` over tuning the scoring constants.

## Conventions

- Plain ES2019 in the browser, no framework, no build step beyond concatenation.
- Every string interpolated into HTML goes through `esc()`.
- Stat and set names are normalised on entry via `normStat()` / `normSet()` — never compare
  raw user input against the canonical tables directly.
- Character entries in `CHARACTERS` are terse by design (`n` name, `a` alias, `r` rarity,
  `e` element, `arch` archetype, `conf` confidence, `sets`, `space`, `ov` overrides).
  Archetype defaults in `ARCHETYPES` supply everything `ov` does not override.
- Add an assertion to `test/optimizer.test.js` for any invariant you rely on. The existing
  ones cover slot legality, set-plan integrity, off-element rejection, alias resolution and
  main-stat legality across the whole roster.

## Planned next: OCR ingestion (not built)

Phase 2 is a Python pipeline that reads card detail panels from a screen recording and
emits the save-file JSON in `docs/SCHEMA.md`. It is blocked on real screenshots to
calibrate crop regions. Design constraint the user agreed to: **read pixels only, never
send synthetic input into the game client** — input automation is a ToS risk on an account
worth thousands of cards.
