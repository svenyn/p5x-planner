# How scores and card recommendations are calculated

Reference for the scoring engine in `src/logic.js`. `CLAUDE.md` carries the *why* behind
each design decision and the constraints you must not break; this file is the *what* —
the call order, the constants, and which screen answers which question. Read `CLAUDE.md`
before changing any of it.

Every function named here lives in `src/logic.js` unless stated otherwise.

## 1. Three different numbers, three different scales

Mixing these up is the most common way to misread the tool.

| Number | Range | Comparable across characters? | Produced by |
|---|---|---|---|
| **Card / plan score** | unbounded | **No** — ordinal only | `cardScore`, `scoreLoadout`, `bestPlan` |
| **Build score** | 1-100 | **Yes** — this is the cardinal one | `buildScore` |
| **Triage Score** | build-score points | **Yes** | `runTriage`, via a `buildScore` delta |
| **Vault fit** | 0-100% | within a slot only | `runVault`, a percentile |

A card score is a weighted sum against one character's target. It is meaningful only when
comparing options *for that same character*. Never present it as a damage percentage, and
never rank two different characters by it.

**On screen, a single card's score is shown out of 100** (`cardPct` in `logic.js`): the raw
`cardScore` divided by the score of that slot's `idealCard` for the same character — the
same perfect card that anchors the build score — clamped at 100. This is purely a display
conversion. Raw card scores differ by slot by construction (a Moon/Star/Sky main is worth
about nine rolls, a Sun or Space main can never be one the character wants), so two raw
numbers side by side only say which *slot* is valuable; per-slot normalisation makes the
number answer "how far is this card from the best one that can exist here", which is the
question the Optimise page is asked. It inherits the raw score's limits: it is still not
comparable between characters, and nothing ranks or optimises on it. Plan totals (the
"Total score" tile, "Other set plans", the Upgrades tab's Gain) remain raw.

Beside it is the **headroom** (`cardHeadroom`): the raw points between the card and that
same perfect card. The percentage answers "how far from perfect", the headroom "how much
is there to gain", and they disagree by slot on purpose. A Moon, Star or Sky card with a
wanted main holds about half its slot's ceiling at Lv25 from the main alone (about 12% at
Lv0); a Sun or Space card's main is fixed and weightless, so its whole percentage is
substats and, with equivalent rolls, it reads lower. Measured on random 5★ cards at Lv25:
Sun/Space 26-34, Moon/Star/Sky with a wanted main 57-65, with a wrong main 13-26. The raw
ceilings differ about two to one the other way, so a Sun card's 30 points are worth about
half a Star card's. Headroom is in raw units and puts a character's five slots on one scale. Upgrades'
**Weakest slots** view is built on it, and pairs it with a build-score version of the same
question for the cross-character comparison headroom cannot make — see §6.

The build score divides a loadout's score by the score of a *perfect* loadout for the same
character, so the weights cancel and the result is comparable between characters. Both
halves go through the same `scoreLoadout`, which is what keeps the scale honest — if the
numerator and denominator ever stop using the same rule, the scale stops meaning anything.

## 2. The inputs

Everything starts from `target(charDef)`, which merges, in order:

1. `ARCHETYPES[charDef.arch]` — the floor: default main stats and a weight for every substat.
2. `charDef.ov` — lufel's per-character overrides (`main`, `w`, `targets`, `sets`, `space`).
3. `state.chars[name].targets` — the user's own edits from the Targets dialog. **If present
   this is returned wholesale and steps 1-2 are skipped entirely.**

`charLoadout(name)` supplies the rest of the character — level, ascension, weapon and
refinement, Mindscape nodes, Awareness level — merged over `DEFAULT_LOADOUT`
(`level: 80, asc: 7, weapon: '5', refine: 1, mindSkill: false, mind1: 0, mind2: 0, awareness: 0`).
Level and Ascension are forced, not user-editable.

`t.main[slot]` is a **list, best first**, never a bare stat. Read it through `mainList(t, slot)`
or `mainTop(t, slot)` — both accept a bare string so older saved targets still work.

## 3. Pricing one card — `cardScore(card, t, real)`

```
score = ( Σ substats  (value / maxRoll) × coupledWeight(stat)
        + mainWeight × mainRolls(main, slot, level)
        + MAIN_MATCH_BONUS × MAIN_ALT_DECAY^rank   (only if the main is a recommended one)
        ) × rarityPenalty(rarity)
```

- Substats are converted to **roll value** (`value / maxRoll`) so stats on different scales
  compare fairly. `maxRoll` differs for Space cards (`maxRollSpace`). The table is verified:
  the user's scan of 3947 5★ cards reproduces every maximum exactly, and shows each roll has
  five tiers (ATK% 2.0 / 2.5 / 2.8 / 3.2 / 3.5).
- A main stat counts at its **real magnitude for the card's level**, converted to max rolls
  of its own substat by `mainRolls()`. `MAIN_MAGNITUDE` in `data.js` holds the Lv0 and Lv25
  value of every main, measured off the same scan (identical on every card of a stat,
  linear in level). At Lv25 that is about **nine** rolls for every stat — as much as all four
  substats of a perfect card — so a wanted main with ordinary substats beats a dead main with
  strong ones, which is how the game values them. The earlier `MAIN_ROLLS = 3` estimate got
  that comparison backwards. Sun and Space have fixed mains and are excluded from the main
  term entirely (their magnitudes are in the table for `totalStat`; they sit on their own
  curve, about 7.7 rolls). Non-5★ cards are assumed to follow the 5★ curve up to their own
  level cap; only 5★ have been scanned.
- `rank` is the main's index in `mainList(t, slot)`, so lufel's printed order acts as a
  tie-break between legal alternatives — and only a tie-break: with real magnitudes the
  coupling decides between them, and a test pins the bonus to exactly
  `MAIN_MATCH_BONUS × (1 − MAIN_ALT_DECAY)` when the coupling is neutral.
- **`HP Recovery` is priced specially.** It is the only main-only stat — it never rolls as
  a substat, so no weight table prices it. `hpRecoveryMainWeight(t, slot)` values it at the
  character's **top weight if lufel lists it for that slot, and 0 otherwise** (an explicit
  `t.w['HP Recovery']` wins over both). An earlier opportunity-cost pricing — "the best of
  the slot's other mains" — made it never worse than the best main for anyone, and the
  optimiser handed HP Recovery Moons to damage dealers once mains were priced properly.
- `potentialCardScore` (the level-0 panel) grows the main along the same curve as it grows
  the substats; unlike the substats, that part is a certainty.
- `real` (from `realCoupleContext()`) swaps the generic coupling baseline for what the
  character's board actually holds. Omitted, `cardScore` stays context-free, which is what
  the optimiser's single inventory-wide pass depends on.

### Coupling — `couplingFactors(t, slot, main, real)`

Weights are never read straight off the target. Damage is a **product** of separate
factors (`STAT_PRODUCTS`), so stats in different factors of one product are complements:
the deeper you are in one, the less another point of it buys and the more its partner is
worth. Supply is counted in max-roll equivalents; marginal value is `1 / supply`; the
result is normalised on the geometric mean over the factors, so the factors multiply to 1
and the coupling shifts the *balance* inside a card score without inflating it.

**The pre-board baseline is the character's own.** With no real board, `productSupply`
seeds each factor from `seedBaseline(t)`: `damageBase` for the character `t.n` names (base
crit, Awakening-7 crit, the weapon's unconditional ladder, Awakening ATK%), then the ideal
substat allocation on top. `STAT_PRODUCTS`' 5% / 150% pair is only the fallback for a target
with no `n`, and — deliberately — for Elucidators, whose stats are donated to allies and
whose own 0% / 0% crit board says nothing about the ally's balance. This is what decides
between lufel's alternative mains: a DPS at 159% ATK from weapon and Awakening wants the
Damage Multiplier Moon next to an ATK% Sky; a character at 40% crit from their weapon wants
Crit Multiplier on the Star.

**The first product's scaling stat is per character** (`statProducts`): DEF% or HP% takes
ATK%'s seat for the kits in `DAMAGE_SCALE` (§5).

Memoised per target object in a `WeakMap`. `target()` returns a fresh object for
characters on generated archetype defaults, so **pass `t` through** rather than letting a
callee re-derive it, or the cache is defeated on every call. `target()` stamps `t.n` (the
character's name) on both generated and saved targets; the coupling needs it.

There is no tuning exponent — it is 1 because that is the true marginal ratio.
`COUPLE_CLAMP` (`[0.4, 2.5]`) is a guard against pathological weights, not a knob.

## 4. Pricing a whole loadout — `scoreLoadout(cards, char, t, p4value)`

```
total = cardPart + setBonus + spacePairBonus
```

- `cardPart` — sum of `cardScore` over the best card in each of the five slots.
- `setBonus` — `loadoutSetBonus`, which adds `bonus2Value` + `bonus4Value` for whatever
  sets the four Heavens cards actually complete. Both return **0 for off-element sets**.
  `bonus4Value` pays `p4value` for the preferred set, `× 0.72` for the secondary, `× 0.22`
  for anything else. `p4value` defaults to **55** and is the UI's 4-piece slider.
- `spacePairBonus` — `SPACE_PAIR_VALUE` (9) when the Space card pairs with the active 4-piece.

This is the **only** place that decides what a loadout's cards and sets are worth. Keep it
that way, or the two halves of the build score drift apart.

Two terms deliberately live *outside* it, because they price the loadout as a whole rather
than its cards: the stat-target term and the spread term, below.

## 5. The build score — `buildScore(char, cards, p4value, lo, idl, t0)`

```
                actual.total + breakpointGot + spreadGot
score = 100 × ──────────────────────────────────────────      clamped to [1, 100]
                 ideal.total + breakpointMax + spreadMax
```

Returns `null` when nothing is equipped. `parts[]` carries the breakdown the UI renders:
`Card stats`, `Set bonuses`, `Space synergy`, and — only when they apply — `Stat targets`
and `Damage spread`.

### The denominator — `idealLoadout(char, t, p4value)`

A perfect build for that same character: five max-level 5★ cards, all four Heavens cards
in the preferred set, a Space card that pairs with it, a recommended main in every slot,
and every substat roll at maximum magnitude on one of the character's four best stats
other than that card's own main (`idealSubs(t, main)` — the game never mints a substat that
duplicates the main, and `validateCard` rejects one; a test runs every ideal card through
it). `IDEAL_ROLLS = [3, 2, 2, 2]` spreads a max-level 5★'s nine rolls over those four stats.

Funnelling all nine rolls into one substat would score higher, but it is rare enough that
using it as the denominator squashes every real build into the low thirties. Anything that
beats the ideal clamps at 100.

`idealCard` takes the **best-scoring** of a slot's allowed mains, not the first — a first
choice the coupling rates below its own alternative could otherwise be beaten by a card
the user owns.

### Stat targets — `breakpointRows(cards, idealCards, char, t, lo)`

37 of 65 characters carry `ov.targets`: lufel's hard in-battle numbers (180 Speed for Rin,
171% Ailment Accuracy for Howler). Weights make stats fungible; a threshold does not, so
these need their own term.

- The whole block is worth `BREAKPOINT_VALUE` (80) **however many stats it decomposes
  into**, so a unit with three targets is not scored out of three times as much as one
  with a single target.
- The published number is an **in-battle total**, so cards are only part of it.
  `totalStat()` adds base stats by level and ascension, the Awakening-7 bonus, Mindscape
  nodes, weapon passives (unconditional only), the Awareness stat curve, and the
  hand-listed always-on kit lines in `KIT_STAT_BUFFS`, each gated on the Awareness level or
  weapon it comes from.
- `pickTier()` selects among a target's up to four tiers (`LV10` / `LV12` / `LV13`, each
  with a `+5` variant) from the character's **Awareness** level — not Ascension — plus
  Mindscape for the `+5` bump.
- The bar is capped at what a *perfect* build on that loadout actually reaches. Some
  targets are unreachable from cards plus gear at all, and scoring against a number
  nothing can hit would put 100 out of reach for reasons the user cannot act on.
- Missing main-stat magnitudes are **unknown, never zero**: when a card that could
  contribute has no `mainValue`, `mainsMissing` trips and the target falls back to the
  relative measure rather than reporting an undercount as fact.

### Damage spread — `spreadRow(cards, idealCards, char, t, lo)`

The card term is a weighted sum, which treats stats as substitutes. Lufel's damage formula
says otherwise — the three factors the cards move **multiply**:

```
ⓐ (character ATK + weapon ATK) × ATK% + flat ATK
ⓑ 100% + Damage Mult + elemental damage bonus + increased damage taken
ⓓ 100% + Crit Rate × (Crit Mult − 100%)
```

`damageFactors(cards, char, t, lo)` evaluates ⓐⓑⓓ from what the loadout actually holds
and returns their product. `spreadRow` awards `SPREAD_VALUE` (80) × `damageShare(t)` in
proportion to the ratio against a perfect build, saturating at 1.

`damageShare(t, char)` is the fraction of the character's weight budget sitting in
`modelledStats(char)` (the scaling stat's % and flat forms, `Damage Multiplier`, `Crit
Rate`, `Crit Multiplier`) — about 0.73 for a DPS, 0.03 for a shield Guardian, 0.4 for an
HP-scaling one — so the term is worth what damage is worth to them, with no archetype
whitelist. Resistance Pierce counts as **not** captured, because ⓒ is not modelled and a
term must not claim credit for a factor it left out.

**ⓐ is the character's scaling stat.** `DAMAGE_SCALE` names the six kits whose every damage
line is a fraction of DEF (Yusuke, Ashiya) or max HP (Junpei, Shun Kano, Pioneer Shun,
Kiyoshi Kurotani); `scaleStat()` routes `damageBase`, `damageFactors`, `modelledStats` and
the coupling's first product through DEF/HP for them. Fujikawa (DEF feeds shields only) and
Tropical Motoha (ATK-scaled, HP converted into ATK by a passive) are deliberately absent.
Those six also carry `ATK%: 0` in `WEIGHT_OVERRIDES`.

**`CONVERSIONS`** are kits that turn a non-damage stat into a damage one, always on (17
entries, 16 characters): Runa's ATK is +60% of her Ailment Accuracy, Yaoling's +1% per 2
Speed up to 90%, Tempest Riko's crit damage +84% at 450% SP Recovery, Kumi's +24 flat ATK
per Speed above 100. `conversionBonus(char, cards, lo)` reads the in-battle source total
(base, weapon, kit buffs, cards) and adds the converted amount to ⓐ, ⓑ or ⓓ in
`damageFactors`, to the matching supply in `realCoupleContext` / `seedBaseline` so the
coupling prices ATK% against the source stat correctly, and the source stat joins
`modelledStats` for `damageShare`. Lufel's own target notes do the same arithmetic (Tempest
Riko's "패시브(활기): 84%"). Party-buff conversions that scale an ally's stat and
skill-specific ones are deliberately not listed. A chained conversion (SP Recovery to crit
damage to ATK) is evaluated on pre-conversion totals, an undercount.

**`CRIT_PROFILE`** handles kits where some or all damage always crits, or cannot crit. `locked` is the share
of the kit's damage that is a guaranteed critical; ⓓ becomes `locked × cm_clamped/100 +
(1 − locked) × (1 + cr × cmBonus)`, and `cmClamp` bounds the locked share's crit damage where
the kit says so. Ryuji and Pioneer Shun are `locked: 1` (ⓓ = cm/100). Akihiko is `locked:
0.3` with the Theurgy's 250-350% clamp (300-400% at Awareness 4): sized from his own
coefficients over a representative window, the Theurgy and Finishing Blow are 26-29% of his
damage and Lightning Fist, Blitzkrieg and Spark Impact roll. The coupling sees the same
split through `lockedCritSupply`, which adds `locked / (1 − locked)` to the Crit Rate supply
so a Crit Rate roll is priced for the rolled share only — and adds nothing while the locked
share's crit damage is below its floor, since a Crit Multiplier point cannot reach it
there. Junpei is `locked: 0.35` (Sunder Strike and Power Swing against Blazing Strike and
his Theurgy). `nocrit` is the opposite case: Kumi's Highlight cannot crit until Awareness 6
grants it, and it is close to half her damage, so `nocrit: 0.45, nocritUntilAw: 6` deals that
share at exactly 1× whatever the crit stats. Everyone's rolled crit rate is capped at 100%,
and `computeCoupling` prices a Crit Rate roll at **zero** once what the board actually holds
(baseline plus a Crit Rate main, plus the other cards on a real board) reaches 100 points —
`heldCritRate`, a hard zero rather than the clamp's floor, which `cf()` preserves.

**`damageBase` reads `flat + pct`** for the three percentage-unit stats. `charBaseStat` files
a weapon's "+18% critical rate" under `pct`, which is right for `totalStat`; reading `.flat`
alone here silently dropped every crit and damage weapon ladder (23 signature weapons) and
Mindscape node from the damage model.

**The crit factor is floored at 1.** `ⓓ = 1 + max(0, cr) × max(0, cmBonus)`. Seven
Buff-element supports (Miku, Futaba, Manaka, Riko, Yumi Shiina, Miyu, Kayo) carry a real,
panel-confirmed 0% / 0% crit base, which drives `cmBonus` to −1 and made every Crit Rate
roll score as an ~8% damage **loss**. Whatever `cm: 0` means for them, it cannot mean a
crit deals no damage. A roster-wide test asserts adding Crit Rate never lowers modelled
damage for anyone.

**The term does not apply to Elucidators.** `spreadApplies(char)` returns false for
`arch: 'Navigator'`, and `spreadRow` then reports a zero row. Every Elucidator's kit
passive gives each ally **20%** of the Elucidator's corresponding stat (**15%** at 4★) —
checked against all eight, it is a property of the role — so their Crit Rate and ATK% are
bought to be *donated*. What a donated point is worth depends on the **ally's** balance,
which nothing here models, and seven of the eight carry a 0% / 0% crit base besides. The
ⓐⓑⓓ product computed from their own board is a quantity the game never evaluates.

`damageShare` cannot see this on its own, because it classifies a weight by the stat's
name and their weights are genuinely damage stats — which is why the term was worth
**48-58 points** of every Elucidator's build score. This is a game mechanic tied to a
role, not the archetype whitelist `damageShare` is careful to avoid: it says "these stats
serve someone else's damage", not "this archetype deals no damage".

Two approaches were tried first and rejected, both recorded so they are not retried:

- **lufel's role prose** — misclassifies five of the eight Elucidators (see
  `docs/DATA-SOURCES.md`).
- **A damage coefficient scraped from skill text** — it reads DEF-scaling kits (Yusuke
  Kitagawa, Masaki Ashiya, Yukimi Fujikawa) as dealing *zero* damage, and counts Hatsune
  Miku's party-ATK **buff** as damage she deals. Gating a score on it would have broken
  real DPS units. A text extractor is fine for a one-off argument (§10); it is not fine as
  a scoring input.

Effect, measured on an optimally-equipped synthetic inventory: Elucidator scores move by
−3 to +3, roster mean 64.8 → 64.6 with the median unchanged at 64, and exactly one
character's recommended loadout changes — a Navigator. No non-Navigator is touched.

Two performance facts that are load-bearing, not micro-optimisation:

- `damageBase()` is memoised per character and setup; `supplyOf()` walks a loadout once
  for several stats rather than once per stat. Skipping either put `npm run scale` an
  order of magnitude slower.
- `breakpointRows` and `spreadRow` memoise their **ideal-side** computation per
  `idealCards` array in a `WeakMap`. The ideal side never depends on the hypothetical
  cards being scored, so recomputing it per call was pure waste shared by every caller.

## 6. Where each screen's recommendation comes from

Four different questions, four different functions. Picking the wrong one is a bug.

| Screen | Function | Question it answers |
|---|---|---|
| Roster | `buildScore` | How well is this character geared, 1-100? |
| Optimise | `bestPlan` | Best loadout for this character from the whole inventory? |
| Upgrades &rarr; Better cards available | `upgradesFor` | Which swaps improve what they already wear? |
| Upgrades &rarr; Weakest slots | `headroomRows` | Which equipped card is furthest from the best one that could exist there? |
| Triage | `runTriage` | For each card I own — keep, hold, or feed? |
| Vault | `runVault` | Which cards deserve a lock in the game client? |

The two Upgrades views are sub-tabs of one page and are not the same question. The first
is bounded by what you own; the second is bounded by what the game can mint, so a slot
holding the best card in your inventory can still top it. See `headroomRows` below.

### `bestPlan(char, pool, opts)` — the optimiser

Enumerates four plan kinds, dedupes identical loadouts, filters by `opts.policy`, returns
the winner plus alternatives.

| `kind` | Meaning |
|---|---|
| `4pc` | A full 4-piece of one set |
| `2+2` | Two 2-piece bonuses |
| `2+free` | One 2-piece plus the best available cards |
| `raw` | Best raw stats, no set bonus |

| `opts.policy` | Effect |
|---|---|
| `pref` (default) | Honour the character's preferred/alternative sets |
| `force4` | Require a complete 4-piece |
| `any4` | Any 4-piece, not just a preferred one |
| `stats` | Pure stat maximisation, sets ignored |

Left to pure stat maximisation the optimiser almost always drops set bonuses, because an
unconstrained pick from a large inventory beats one restricted to a single set. That is not
how the game is played, so `pref` is the default and the UI reports what honouring the set
costs in raw stats.

Every plan total includes the breakpoint and spread terms, not just cards and sets. It has
to: without them the optimiser trades away the one stat a character must reach for generic
quality, then recommends a loadout the build score rates *worse* than what the user had.
Target stats are therefore counted twice — once through their weight, once through the
breakpoint term — which is deliberate.

`bestPlan` returns its evaluator as **`r.heavensTotal`**, closed over that call's
`t` / `lo` / `idealHeavens` / `wants` / `P4`. Anything comparing an arbitrary set of
Heavens cards against what `bestPlan` itself would score must call it rather than
re-deriving the rule. `upgradesFor` uses it for `curTotal`, `recTotal` and every per-row
marginal, so no number shown there is scored by different rules than the plan search that
produced it.

**A row's Gain and its plan's total are two different numbers.** `upgradesFor` proposes a
whole 4-piece, never a slot at a time (see the off-target-set regression in
`test/optimizer.test.js`), so one suggestion is usually several rows. Each row's `delta` is
the marginal of equipping *that* card with the character's other slots left as they are —
what the button beside it does — and the plan's total is `group`, carried by every row of
the block and footed once by the UI with an "Equip all". They do not sum, and a single row
can be negative while the group is strongly positive: most of a set switch is the 4-piece
bonus, which lands only when the fourth card goes on, and pulling one card out of a
complete set is a bonus lost for a stat gain that rarely covers it. Until Sep 2026 every
row carried the group total instead, so a three-row suggestion read as three separate +28s
when there was one +28 on the table.

**The optimiser does not need a second refinement pass.** One was built and measured:
brute-forcing every combination of the top six candidates per slot against the full build
score found at most **1 point** of headroom, on 2 of 65 characters, mean 0.03. The
per-card coupling already lands on the balanced pick. If the coupling is ever weakened,
revisit that.

### `runTriage()` — keep / hold / feed

Triage's Score is **not** `cardScore`. It is the `buildScore` delta of actually swapping
the card into its slot given the character's real other equipped cards, real weapon and
real ascension:

```
marginal = buildScore(char, others + card) − buildScore(char, others)
```

where `others` is that character's real equipped cards minus whatever currently sits in the
card's slot. This matters because `cardScore` is context-free: a mostly-Crit-Rate card can
look like the best card in the inventory for a crit-hungry DPS even when that DPS is
already swimming in Crit Rate and starved of ATK%. The marginal prices the card against the
character's *actual* ⓐⓑⓓ balance. Being on the 0-100 scale, it also doubles as the
"who fits best" argmax.

**The main is priced at the level cap, the substats as rolled** (`atMaxLevel`). A main's
growth with level is a certainty and an upgrade landing on the right substat is not; without
this no level-0 Moon, Star or Sky card could grade as a keeper against a max-level one, and
the user's inventory is 92% level 0. The Vault applies the same rule. The optimiser does not
— it dresses the character in what exists now.

**Verdicts are graded within a slot.** `pct` is the marginal divided by the best marginal
among cards *of the same slot* (`topBySlot`), not in the whole inventory. A Sun card's main
is always flat HP and a Space card's flat ATK+DEF, so neither can carry a main a damage
dealer wants; ranked against Moon and Star cards, whose main alone is worth nine rolls,
every Sun card read as feed. The Vault tab ranks within slot for the same reason.

The **element gate is hard, not a ranking nudge**: characters off an element-locked set's
element are removed before either argmax. Ranking alone was not enough — a broad weight
vector can out-score a set bonus on stats alone, which is why Motoha Arai [Tropical] was
once the named best fit for Fire-locked Strife cards she can never benefit from.

One carve-out: when **no eligible character is owned at all**, the Score falls back to the
same marginal maxed over the *whole* roster, so a strong Fire card is not marked feed just
because you have not pulled a Fire character yet. The "best fit" cell then reads
"— no one in scope".

Performance: `runTriage` precomputes `t` / `lo` / `idl` once per character and passes them
into `buildScore`. `npm run triage-perf` benchmarks the worst case (4000 cards × 65
characters) in a real browser — check it after touching any of this.

### `runVault()` — what deserves a lock

The counterweight to Triage's element gate. Once Triage refuses to name anyone it will
happily call a card junk that a future character would want, and a fed card does not come
back. So `runVault` answers its question **without reference to the roster** — pulling a
character cannot change a verdict. Two yardsticks:

1. `VAULT_TARGET`, a synthetic generic-damage weight vector. Support stats are 0 on
   purpose, and it is spelled out rather than borrowed from `ARCHETYPES` so a balance
   tweak cannot silently redefine what "lock this" means.
2. Best fit across the eight `ARCHETYPES`, scored through `archTarget()`.

Two normalisation decisions, both arrived at by measurement:

- **Within a slot, never across slots.** A Sun card's main is always flat HP, which the
  damage yardstick weights at 0, so a single pool marks every Sun card feedable and every
  Star card a keeper — a fact about slots, not cards.
- **Against archetypes, not characters.** Raw best-over-65 measures roster size and is
  always won by the same two or three broad-vector characters (28% of a synthetic
  inventory flagged). Normalising per character *then* maxing over the ~59 unowned is
  worse: a maximum over 59 near-independent percentiles is an extreme-value statistic, and
  it reported 100% fit for the whole inventory.

Thresholds are **percentiles**, not shares of the best card: `VAULT_LOCK = 0.98` is "top 2%
of that slot for its best role", `VAULT_WATCH = 0.93` is "top 7%: worth holding". A
share-of-best cutoff sounds equivalent and is not — it depends on how good the single best
card happens to be, and at 0.80 it flagged 59% of a synthetic inventory. Whether the roster
can field the winning archetype is reported next to the verdict, never scored into it.

### `headroomRows(takeEquipped)` — the weakest slots

One row per (owned character, slot), read off what is already equipped. Three numbers per
row, and they are deliberately on two different scales:

- **Headroom** — `cardHeadroom(cardScore(card, t), slot, t)`, the raw points between the
  equipped card and `idealCard` for that slot. Raw, so it compares that one character's
  five slots against each other and nothing else. An empty slot's headroom is the whole
  ideal, which is correct: nothing is the furthest thing from perfect there is.
- **Build +** — the same question through `buildScore`: the loadout's score with a perfect
  card substituted into the slot, minus its score now. Divided by the character's own
  perfect loadout, so this one *does* compare across characters, which is why the table
  sorts on it by default. A roster-wide list sorted on headroom would partly be ranking
  characters by how fat their own yardstick is.
- **Available now** — the best card of the **same slot and the same set** in the inventory,
  reported as its own `buildScore` delta. Same set is load-bearing, not a convenience: a
  within-set swap cannot change how many pieces of any set are worn, so the set bonus is
  identical either side of it and the delta really is the card. Offering the best card of
  the slot regardless of set is the mistake `upgradesFor`'s header comment describes — it
  breaks a 4-piece for a stat gain that rarely covers it — and the other sub-tab already
  runs the full plan search that can weigh that trade properly. The winner is *picked* on
  `cardScore` (cheap, and with the set held fixed that is the right ordering) but
  *reported* as a build-score delta, and a swap that comes out flat or negative once the
  stat-target and spread terms have had their say is dropped rather than printed as an
  upgrade.

The deltas subtract `buildScore().raw` rather than `.score`: `.score` is rounded and
floored at 1 for display, and a single slot is often worth only a few points, so rounding
both ends first quantises a real difference away.

Nothing here scores, ranks or optimises anything the rest of the tool reads — it is a
reading of the current board, and the scoring pass is cached so filters and column sorts
redraw without re-running it (measured: 301 ms for 65 owned characters over 4000 cards,
53 ms to redraw).

## 7. Constants, in one place

All in `src/logic.js` unless noted. Changing any of these changes every score — re-run
the calibration in §9 before shipping.

| Constant | Value | What it controls |
|---|---|---|
| `MAIN_MAGNITUDE` (`data.js`) | per stat, [Lv0, Lv25] | Measured main-stat values; `mainRolls()` converts to max rolls (~9 at Lv25) |
| `MAIN_ROLLS_FALLBACK` | `9` | Used only for a main missing from the table (none today) and to scale HP Recovery |
| `DAMAGE_SCALE` | 6 characters | Kits whose ⓐ is DEF or max HP rather than ATK |
| `CRIT_PROFILE` | Ryuji, Pioneer Shun (`locked: 1`); Akihiko (`0.3`, clamp 250-350); Junpei (`0.35`); Kumi (`nocrit: 0.45` until Awareness 6) | Share of a kit's damage that always crits or cannot crit |
| `KIT_STAT_BUFFS` | 43 characters, ~150 lines | Conditional lines judged always-on, gated on Awareness / weapon / stacks; skill-level `tiers` follow `kitTierIndex` |
| `CONVERSIONS` | 16 characters | Always-on stat conversions fed into ⓐⓑⓓ and the coupling from in-battle source totals |
| `MAIN_MATCH_BONUS` | `10` | Bump for a main the character actually wants |
| `MAIN_ALT_DECAY` | `0.85` | Per-rank decay across a slot's alternative mains |
| `MAIN_CHOICES` | `3` | Alternatives per slot the target editor exposes |
| `rarityPenalty` | `1 / .82 / .6 / .4` | Whole-card multiplier for 5★ / 4★ / 3★ / 2★ |
| `IDEAL_ROLLS` | `[3, 2, 2, 2]` | How the ideal card spreads nine rolls over four stats |
| `SPACE_PAIR_VALUE` | `9` | Space card pairing with the active 4-piece |
| `BREAKPOINT_VALUE` | `80` | Whole stat-target block, regardless of target count |
| `SPREAD_VALUE` | `80` | Damage-spread budget, scaled by `damageShare(t)` |
| `COUPLE_CLAMP` | `[0.4, 2.5]` | Guard on coupling multipliers — not a tuning knob |
| `p4value` default | `55` | 4-piece worth; UI slider. Preferred × 1, secondary × 0.72, other × 0.22 |
| `MODELLED_STATS` | ATK%, ATK, Damage Mult, Crit Rate, Crit Mult | Stats appearing in ⓐⓑⓓ |
| `AWARENESS_STAT_PCT` | `[0,2,5,7,10,12,15]` | Universal HP/ATK/DEF % per Awareness level |
| `VAULT_LOCK` | `0.98` | Top 2% of a slot → lock |
| `VAULT_WATCH` | `0.93` | Top 7% of a slot → hold |
| `DEFAULT_LOADOUT` | Lv80, A7, 5★ R1 | Level and Ascension are forced, not editable |

`BUILD_BANDS`: `>=80` excellent, `>=60` good, `>=40` workable, else needs work. Re-cut from
75/55/35 when mains were priced at their real magnitude, which lifted every score about five
points without changing the shape of the distribution.

## 8. Where the weights themselves come from

`ov.w` is not hand-written. Lufel ranks each character's substats into three priority
tiers and `tools/gen-data-from-lufel.js` maps them to `10 / 8 / 6`, capping anything lufel
weighed and omitted at 4, over the archetype floor. **The ranking is lufel's; the
magnitudes are the generator's own invention**, and one falloff curve is shared by all 65
characters.

That is wrong wherever a character's priorities fall off faster than average, and it costs
three times over: the ranking, `damageShare` (derived from the weights), and the ideal
loadout the score divides by. `WEIGHT_OVERRIDES` in the generator is where a measured
per-character magnitude judgement lives. See **"Lufel publishes an order, not magnitudes"**
in `CLAUDE.md` for the full rules on what earns an entry — and note it must never be used
to disagree with lufel's *ordering*, only its magnitudes.

`arch` is **never regenerated** — it is carried from `src/data.js`. It comes from lufel's
structured `position` field, which maps 1:1 onto the eight archetypes; the generator
reports any stored archetype that disagrees. See `docs/DATA-SOURCES.md`.

## 9. How to verify a scoring change

Do not ship a scoring change on reasoning alone. Four tools, cheapest first:

**`npm test`** — 226 assertions in `test/optimizer.test.js`, in ten blocks: plan legality and
set-plan integrity over the whole roster; data integrity (sets, Space pairings, roll tiers,
`MAIN_MAGNITUDE`, the hand-kept judgement tables, weapon `extra` lines); the §7 constants;
card pricing and the coupling (scale-neutrality, seeded baselines, the crit cap, the
NaN sweep over every board); loadout pricing and the build score (the ideal is a legal card
and scores exactly 100 for everyone); the damage model (`flat + pct`, the crit floor across
the roster, locked and no-crit kits, conversions, the spread term's direction); stat targets
(tiers, kit-buff gating, unknown-main fallback); Triage, Vault, Upgrades and Headroom on a
synthetic inventory; import normalisation, validation and the merge budget; and a walk of
the real UI ending in a save/load round trip. `WEIGHT_OVERRIDES` is checked against
`src/data.js` outside the page. Add an assertion for any invariant you rely on. Rebuilt
18 Sep 2026 after the working copy was reverted by mistake; every documented invariant was
re-derived and its expected value checked against the live page before being pinned.

**`npm run scale`** — 4000-card synthetic benchmark across all four set policies, plus a
`buildScore` block that equips every character's `pref` recommendation and scores it. Check
the distribution of plan kinds stays sane. Calibration to hold to:

| Metric | Expected |
|---|---|
| Build score, 4000 cards optimally equipped | **around 70** (mean 70.1, median 70, range 52-86) |
| Bands (excellent / good / workable) | about 6 / 54 / 5 of 65 |
| Moon/Star/Sky picks with a non-recommended main | **38 of 195** (was 71 at `MAIN_ROLLS = 3`) |
| 80+ | genuinely excellent |

Nothing should clamp at 100. If a change moves those, either the change is wrong or
`BUILD_BANDS` needs re-cutting — check before shipping. A rise in the non-recommended-main
count means the optimiser is trading the main away for substats again.

**`npm run triage-perf`** — 4000 cards by 65 characters in a real browser, for anything
touching Triage or the memoisation.

**An ad-hoc browser probe** — the fastest way to measure one character's real numbers,
since `logic.js` needs a DOM. Build first, then evaluate inside the page:

```js
const { chromium } = require('playwright');
const b = await chromium.launch(); const p = await b.newPage();
await p.goto('file:///abs/path/dist/p5x-planner.html');
await p.waitForTimeout(300);
const r = await p.evaluate(() => {
  const c = charDef('Tomoko Noge [Seaside]'), t = target(c), lo = charLoadout(c.n);
  return { w: t.w, share: damageShare(t),
           ideal: idealLoadout(c, t).cards.map(x => x.main),
           factors: damageFactors(idealLoadout(c, t).cards, c, t, lo) };
});
```

Run it with `NODE_PATH=<repo>/node_modules` if the script lives outside the repo.

## 10. Answering "should this character want this stat?"

`tools/fetch-lufel-data.js` downloads **per-character skill data** (`dump.skills`) as well
as builds and Awareness. That is the evidence base for any weight argument, and it is not
cached in the repo — re-fetch it when you need it:

```
node tools/fetch-lufel-data.js lufel.json
```

Skill descriptions are Korean with numeric coefficients, so they extract cleanly. Useful
terms: `공격력` ATK, `최대 생명력` max HP, `대미지` damage, `회복` heal,
`크리티컬 확률` crit rate, `크리티컬 효과` crit multiplier, `효과 명중` ailment accuracy,
`반드시 크리티컬` guaranteed critical.

The method that settled the questions in this file — **a damage index**, comparing a
character's real contribution against the top DPS:

```
index = ATK x (best rotation skill % + highlight % / 4)
```

taking `ATK` from `damageBase(char, charLoadout(char.n))` and the coefficients from the
skill text. Use max HP instead of ATK for HP-scaling kits (Junpei, Shun, Summer Ichigo) —
they read as 0% otherwise. Measured against the roster's top DPS at 100%:

| Character | Index | Verdict |
|---|---|---|
| Yukari Takeba (Healer) | 58% | out-damages most DPS — her damage weights are right |
| Runa Dogenzaka (Saboteur) | 31% | about equal to a real AoE DPS — crit stats justified |
| Kumi / Mio (Saboteurs) | 26-27% | about equal to Haru, Akihiko — justified |
| Koromaru (Saboteur) | 19% | borderline |
| Tomoko Noge [Seaside] (Healer) | **16%** | lowest — the one genuine over-weighting |

**Lessons worth keeping**, because each cost a session to learn:

- `damageShare` versus a character's own archetype `damageShare` is a **smell test, not a
  judge**. It flagged 11 characters and the skill data cleared 9 of them, including both
  Guardians that looked worst on paper. Two survived: Seaside Moko (weights) and Yumi
  Shiina (whose problem was the archetype and the spread term, not the weights).
- Check for **guaranteed crit** before calling a Crit-Multiplier-heavy tank incoherent.
  Skull's damage always crits; Junpei's and Shun's crit on a condition. All three
  legitimately want Crit Multiplier with little or no Crit Rate.
- A character who buffs the **party's** crit damage, or debuffs the enemy's crit damage
  **taken**, gains nothing for their own crit substats. Runa, Koromaru, Mio and Yukari all
  read as crit units from a keyword scan and are not, on that axis.
- Stats can be **donated**. An Elucidator's passive gives allies 20% of each of their
  stats, so crit stats are useful to a character who cannot crit at all.
- A stat can be **converted**. Runa and Koromaru gain ATK equal to 60% / 30% of their own
  Ailment Accuracy, which is why Ailment Accuracy is correctly their top weight.

## 11. Known gaps and deliberate approximations

| Gap | Consequence |
|---|---|
| **Main stat magnitudes are measured for 5★ only** | `MAIN_MAGNITUDE` comes from the user's scan of 3947 5★ cards. Other rarities are assumed to sit on the same curve to their level cap; a scanned `mainValue` wins, and an unscanned non-5★ main is unknown, never zero. |
| **Substat roll tables** | Verified against 3947 real cards for all 13 stats, both layouts. No longer a gap. |
| **My Palace and party buffs are not modelled** | Every `totalStat` total is a **floor**. Say so wherever one is shown. |
| **Resistance Pierce (factor c) is not modelled** | Deliberately excluded from `MODELLED_STATS` and from coupling — its value depends on enemy resistance. |
| **Flat ATK is absent from coupling** | A max roll is worth well under half an ATK% roll, and how much depends on a base ATK `cardScore` is not given. |
| **Conditional kit buffs and conversions are counted only where hand-listed** | `KIT_STAT_BUFFS` (43 characters) and `CONVERSIONS` (16) are judgement tables, not parses. Team- and HP-conditional lines are left out; a chained conversion is evaluated on pre-conversion totals. Lufel's `battle_plus_stats` notes confirm its targets assume the same kind of lines (Ashiya's passive DEF, Runa's weapon accuracy, Chizuko's Awareness-2 stacks, Tempest Riko's conversion). |
| **`damageShare` classifies stats by name** | An ATK-scaling healer's ATK% is booked as damage though it is bought for healing, and an HP-scaling tank's HP% is booked as damage though it is also their tank stat. Harmless while the same weights build the ideal, but a share cannot be read as "how much of them is damage". |
| **A donated stat's real worth is still not modelled** | The spread term is now gated off for Elucidators (§5), so they are no longer scored on a damage product they never compute. What is still missing is the other half: a donated point's value depends on the receiving ally's balance, so nothing prices an Elucidator's stats *positively* either — they are scored on cards, sets and their own stat targets alone. |
| **Off-element sets taken for a Space pairing cannot be scored** | `bonus2Value`/`bonus4Value` return 0 off-element, so lufel's "dead 4-piece to unlock a Space effect" builds are dropped from the target and stated in the character's note. |

Main-stat magnitudes are real for 5★ now. The remaining honest upgrade is a scan of 4★ and
3★ cards to confirm they sit on the same curve.
