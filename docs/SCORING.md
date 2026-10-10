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
3. `state.chars[name].targets` — the user's own edits from the Targets dialog, a **diff**
   applied on top: only the sets, Space card, per-slot main lists and per-stat weights the
   user changed (`targetEdits` computes it on save; saving with nothing changed stores
   `null`). Stat targets, `bp` and `note` always come from step 2. Until Sep 2026 a saved
   target was a full snapshot returned wholesale, so no later data fix reached an edited
   character — Kiyoshi and Yusuke kept an ATK% weight of 4 the DEF/HP-kit override had set
   to 0. `migrateSavedTargets()` converts old snapshots on load (see `docs/SCHEMA.md`).
   `defaultTarget(charDef)` is steps 1-2 alone.

`charLoadout(name)` supplies the rest of the character — level, ascension, weapon and
refinement, Mindscape nodes, Awareness level — merged over `DEFAULT_LOADOUT`
(`level: 80, asc: 7, weapon: '5', refine: 1, mindSkill: false, mind1: 0, mind2: 0, awareness: 0`).
Level and Ascension are forced, not user-editable.

`t.main[slot]` is a **list, best first**, never a bare stat. Read it through `mainList(t, slot)`
or `mainTop(t, slot)` — both accept a bare string so older saved targets still work.

## 3. Pricing one card — `cardScore(card, t)`

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
  term entirely (their magnitudes are in the table for `totalStat` and the damage model's ⓐ,
  §5; they sit on their own curve, about 7.7 rolls). Non-5★ cards are assumed to follow the
  5★ curve up to their own level cap; only 5★ have been scanned.
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
  Healing from a set bonus uses the same rule (§4): one price for healing wherever it lands.
- `potentialCardScore` (the level-0 panel) grows the main along the same curve as it grows
  the substats; unlike the substats, that part is a certainty. Its substat best case is
  `bestCaseUpgrades`: a card below its rarity's `subMax` gains the missing substat on its
  first upgrade, so the best case mints the stat worth most that the card lacks (never its
  main) at one maximum roll, and only the upgrades after that are rolls, each on whichever
  substat is then worth most. Treating every upgrade as a roll on an existing substat was
  wrong both ways — it could not see a fourth substat better than the card's own, and it let
  the first upgrade land where it cannot — on an inventory whose level-0 cards are 60%
  three-substat.
- It is **context-free**: it never looks at the other cards worn. It is the build score's
  card part, the one number every screen shows for a card, and what the optimiser shortlists
  on. Until 28 Sep 2026 a `real` argument (`realCoupleContext()`) priced it against the other
  cards worn instead; the Loadout popup, the card picker and the optimiser's shortlist used
  it, the build score and Weakest slots did not, so one card read two numbers and ranked
  differently on two screens (Kotone Shiomi's worn ATK% Star 110.1 against 107.9, the Crit
  Rate Star beside it 101.5 against 110.6). It was removed; what a card does with the other
  four — stat targets, damage balance — is the build score's other terms, and every screen
  that proposes a swap reports it as a build-score delta (§6).

### Coupling — `couplingFactors(t, slot, main)`

Weights are never read straight off the target. Damage is a **product** of separate
factors (`STAT_PRODUCTS`), so stats in different factors of one product are complements:
the deeper you are in one, the less another point of it buys and the more its partner is
worth. Supply is counted in max-roll equivalents; marginal value is `1 / supply`; the
result is normalised on the geometric mean over the factors, so the factors multiply to 1
and the coupling shifts the *balance* inside a card score without inflating it.

**The baseline is the character's own.** `productSupply` seeds each factor from `seedBaseline(t)`: `damageBase` for the character `t.n` names (base
crit, Awakening-7 crit, the weapon's unconditional ladder, Awakening ATK%), then the ideal
substat allocation on top. `STAT_PRODUCTS`' 5% / 150% pair is only the fallback for a target
with no `n`. This is what decides between lufel's alternative mains: a DPS at 159% ATK from
weapon and Awakening wants the Damage Multiplier Moon next to an ATK% Sky; a character at
40% crit from their weapon wants Crit Multiplier on the Star.

**Elucidators are not coupled.** `computeCoupling` returns no factors when `spreadApplies`
is false. Their stats are donated to allies at 20%, so a roll's worth is decided by the
receiving ally's balance, which nothing here knows. They used to fall back to the 5% / 150%
pair, which is an *ungeared* ally, and priced a Crit Rate roll at 1.8-2.9 times a Crit
Multiplier roll. Fuuka's Crit Multiplier Star (her Spirit Wave turns it into party crit
damage) lost to a Crit Rate one by 11% at equal substats. At a geared ally's board the two
rolls are worth about the same, so their cards are priced on their weights, which is lufel's
own order.

**A stat bought for an ally buff is not coupled** (`BUFF_SOURCE_STATS`, §5): only
Beachflower Minami's crit multiplier and HP% today.

**The party's crit rate is the user's to set** (`state.teamCrit`, the Roster's "Team crit
rate"). `teamCritFor(char)` adds it to `damageBase`'s crit rate for everyone but Elucidators,
so it reaches ⓓ and both coupling baselines; `genericSupply` adds it to the 5% fallback the
Vault's archetype targets are priced on; and `heldCritRate` counts it toward the 100% cap.
It never enters `totalStat`, so totals and stat targets are unchanged. `damageBase`'s cache
key, `targetMemo` and `prefSetLift` all check it, so a change reprices at once. At 0 it is
the model without it.

**A share of the damage can crit at a higher rate** (`CRIT_PROFILE.extraCr`). Wavecatcher
Miyu's weapon adds 16.4-31.4% crit rate to her Resonance, about half her damage. A Crit
Multiplier point is then worth `cr + share × extra` rather than `cr`, so `productSupply`
reads her Crit Rate supply that much higher, beside `lockedCritSupply`'s term for locked
shares.

**The first product's scaling stat is per character** (`statProducts`): DEF% or HP% takes
ATK%'s seat for the kits in `DAMAGE_SCALE` (§5).

Memoised per target object in a `WeakMap`, through `targetMemo`, which drops the memo when
the character's saved loadout object changes (`idealCardScore` uses the same helper). A saved
target is the same object for as long as it exists, and the baseline above reads the weapon,
Awakening and Awareness — keyed on the target alone, a Setup change never reached those
characters until a reload. `target()` returns a fresh object for
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
  sets the four Heavens cards actually complete. Both return **0 for off-element sets**, and
  `bonus4Value` also returns 0 for a 4-piece bound to another element on a set whose 2-piece
  is universal (`elem4` — only Defeat: accuracy 2-piece, Fire-only 4-piece).
  `bonus4Value` pays `p4value` for the preferred set, `× 0.72` for the secondary, `× 0.22`
  for anything else. `p4value` defaults to **55** and is the UI's 4-piece slider.
- **The preferred set's `p4value` carries `prefSetLift`.** The flat numbers are this tool's
  stand-in for lufel's judgement of a 4-piece, and a 2-piece is priced from its stat. So for
  a character who weights a 2-piece's stat heavily, another configuration of perfect cards
  used to beat the preferred 4-piece. Examples: ATK 2-pieces for Elucidators, Worry's +80%
  SP Recovery for healers, 2+2 splits for 18 characters. The lift is exactly what it takes
  for the preferred 4-piece to match every other 4-piece and every pair of 2-pieces
  (searched among the `SET_LIFT_PAIRS` best 2-pieces). It is measured on whole ideal
  loadouts through `buildScoreOf`, with lifts switched off while measuring. It is zero for
  50 of the 68, memoised per character and P4, and dropped with the Setup or saved target.
  Alternatives are not lifted (CLAUDE.md, "The preferred set is the ceiling").
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

`buildScoreOf(char, worn, …)` is the same computation without that `null`: an empty board
still earns what the stat-target and spread terms credit the character's base stats with
(median 7, up to 15 build points). Anything that subtracts two build scores — Triage's
marginal, Headroom's gains (§6) — measures both ends with it and uses `.raw`; `buildScore`
and `.score` are for display.

Healing in a 2-piece (only Love's +9%) has no substat to price it by, so `bonus2Value` uses
the HP Recovery main's rule: `hpRecoveryMainWeight(t, 'Moon')` (the top weight where lufel
lists a healing main, else 0) times `healingRolls(amt)`, the main's own scale of nine rolls to a
max-level 22.6%. Until Sep 2026 it was a flat 1.5 × the HP% weight whatever the amount: 6-15
points for Love's 2-piece against 36 for the same 9% on a Moon main. That let Worry's SP
Recovery 2-piece beat Love for Lufel, and it paid characters who cast no heals for their HP%.

`setBonus` reads a 2-piece through `bonus2Parts`: the modelled `bonus2` plus any signed
`bonus2Also` term on the same line — today only Prudence's Speed −3, which the in-battle
totals see through the same helper in `supplyOf`.

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
the user owns. In an **open slot** (`mainList` empty — lufel's "-") every legal main is
allowed, so the ceiling is the best card the slot can hold.

**Perfect is a ceiling, and a test holds it there.** No other main in any slot, no other
4-piece and no two 2-pieces of perfect cards may beat the ideal loadout, with stat targets
and spread counted. For sets, `prefSetLift` guarantees it (§4). For mains the model has to
earn it, and in Sep 2026 all but one of ten slot cases were model errors, now fixed: open
slots, Elucidator coupling, Beachflower Minami's buff sources and HP scaling, Kira's kit
lines and dropped weapon stat, and Lufel's archetype weights. The exception is Wavecatcher
Miyu's Crit Multiplier Star (§11), which the test names.

### Stat targets — `breakpointRows(cards, idealCards, char, t, lo)`

39 of 68 characters carry `ov.targets`: lufel's hard in-battle numbers (180 Speed for Rin,
171% Ailment Accuracy for Howler). Weights make stats fungible; a threshold does not, so
these need their own term.

- The whole block is worth `BREAKPOINT_VALUE` (80) **however many stats it decomposes
  into**, so a unit with three targets is not scored out of three times as much as one
  with a single target.
- Each row's ratio is progress **from the character's no-card total**:
  `clamp01((total − bare) / (bar − bare))`, where `bare` is `totalStat` with no cards on the
  same setup. Measured from zero, base stats alone met the median target 64% of the way, so
  a naked character took about 49 of the 80 points. Now base stats earn none, and gear moves
  all of it (about three times as responsive). The relative fallback for missing mains
  already counted cards only.
- The published number is an **in-battle total**, so cards are only part of it.
  `totalStat()` adds base stats by level and ascension, the Awakening-7 bonus, Mindscape
  nodes, weapon passives (unconditional only), the Awareness stat curve, and the
  hand-listed always-on kit lines in `KIT_STAT_BUFFS`, each gated on the Awareness level or
  weapon it comes from. Every stat starts at the in-game panel's baseline — SP Recovery at
  100%, **Ailment Accuracy**, Damage Multiplier and Resistance Pierce at **0%** (Ailment
  Accuracy was wrongly started at 100% until 25 Sep 2026, which met Haru's and Shoki's targets
  with no cards and capped their conversions; Awakening 7's `ailment_accuracy` is now read).
- `pickTier()` selects among a target's up to four tiers (`LV10` / `LV12` / `LV13`, each
  with a `+5` variant) from the character's **Awareness** level — not Ascension — plus
  Mindscape for the `+5` bump.
- The bar is capped at what a *perfect* build on that loadout actually reaches. Some
  targets are unreachable from cards plus gear at all, and scoring against a number
  nothing can hit would put 100 out of reach for reasons the user cannot act on.
- A target met **with no cards at all** on the current setup (`metBare`) is shown with a
  "met without cards" tag but left out of the block, which is then split over the targets
  gear can move — or dropped, when none is left. Fuuka's Crit Multiplier target is the
  standing case: lufel's 64-78% is where her party crit-damage buff caps (its cap over
  0.625% per 1% of her crit damage), and kit text means the total there, so her 150% base
  clears it; it used to be half her block, free. Mitsuru's LV10 ATK target is the other.
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

"What the loadout holds" (`damagePoints`) includes the two fixed mains as flat stat after
the percentage, at their magnitude for the card's level: a Space card's ATK + DEF for ATK
and DEF kits, a Sun card's HP for the HP kits. They were once left out as "cancelling",
which a flat term in a ratio does not (and a Lv0 card does not match a Lv25 one); for the
DEF/HP kits the gap was 5-7% of a perfect ⓐ. On the real inventory folding them in moved no
active character's build score by more than 0.1.

It also includes a completed 4-piece's unconditional stat line (`SET4_STATS` via
`set4StatLines`: Strife's +15% ATK, Reconciliation's +15% HP/ATK/DEF, Labor's +8% for an
Elucidator), the same line the in-battle totals count, so ⓐ and the ATK tile show one number.
Until 28 Sep 2026 it did not (Kotone Shiomi: ⓐ 5316 against a 5603 tile). On the real
inventory it changed no recommendation and moved no build score by more than 0.33; the
`npm run scale` calibration was unchanged.

`damageShare(t, char)` is the fraction of the character's weight budget sitting in
`modelledStats(char)` (the scaling stat's % and flat forms, `Damage Multiplier`, `Crit
Rate`, `Crit Multiplier`) — about 0.73 for a DPS, 0.03 for a shield Guardian, 0.4 for an
HP-scaling one — so the term is worth what damage is worth to them, with no archetype
whitelist. Resistance Pierce counts as **not** captured, because ⓒ is not modelled and a
term must not claim credit for a factor it left out. Neither does a stat in
`BUFF_SOURCE_STATS` — one the kit turns into an ally buff, for a character whose own damage
is a side line. It is left out of the coupling too, since its worth is the buff (up to the
cap lufel's target records), not its effect on the character's own product. Only Beachflower
Minami is listed (crit multiplier and HP%, the sources of Gentle Sea Breeze, Summer Garden
and Bewitching Blossoms). Coupled as her own damage at 5% crit, her Crit Multiplier Star
lost to an HP% one.

**ⓐ is the character's scaling stat.** `DAMAGE_SCALE` names the eight kits whose every damage
line is a fraction of DEF (Yusuke, Ashiya) or max HP (Junpei, Shun Kano, Pioneer Shun,
Kiyoshi Kurotani, Ichigo Shikano [Summer], Minami Miyashita [Beachflower]); `scaleStat()` routes `damageBase`, `damageFactors`, `modelledStats` and
the coupling's first product through DEF/HP for them. Fujikawa (DEF feeds shields only) and
Tropical Motoha (ATK-scaled, HP converted into ATK by a passive) are deliberately absent.
All eight also carry `ATK%: 0` in `WEIGHT_OVERRIDES`.

**`CONVERSIONS`** are kits that turn a non-damage stat into a damage one, always on (17
entries, 16 characters): Runa's ATK is +60% of her Ailment Accuracy, Yaoling's +1% per 2
Speed up to 90%, Tempest Riko's crit damage +84% at 450% SP Recovery, Kumi's +24 flat ATK
per Speed above 100. `conversionBonus(char, cards, lo)` reads the in-battle source total
(base, weapon, kit buffs, cards) and adds the converted amount to ⓐ, ⓑ or ⓓ in
`damageFactors`, to the matching supply in `seedBaseline` so the
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
(baseline, team crit rate included, plus a Crit Rate main) reaches 100 points —
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
| Upgrades &rarr; Custom card | `ccRow` / `ccBest` | Who gains most from a card designed in the Cycle of Fate event, and which card? |
| Upgrades &rarr; Ink card | `ikRow` / `ikExpect` | Which card to make with Vicissitude Ink, how many substats to pick with Elysian Ink, and which to re-roll with Prophetic Ink? |
| Upgrades &rarr; Fortune Revelation | `frRateSet` | Which set to choose when redeeming a Fortune Revelation? |
| Triage &rarr; Keep or feed | `runTriage` | For each card I own — keep, hold, or feed? |
| Triage &rarr; Lock for later (the Vault) | `runVault` | Which cards deserve a lock in the game client? |

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

**A plan's total is the build score's own numerator**: `buildScoreOf(char, cards, P4, lo, idl,
t).total` over the five cards the plan puts on — its four Heavens picks plus the Space card
its rule gives it (`spaceChoice`: a set pairing with the plan's actual 4-piece, then the
character's own Space set under `pref` / `force4`, then score) — against the same perfect
loadout. The denominator is fixed per character, so plans are ranked by the build score they
would earn, and at the default 4-piece value of 55 it is the same number. That brings the
stat targets (real in-battle totals), the spread (five cards against a five-card ideal) and
the Space pairing into plan choice by the build score's own rules; until Sep 2026 the
optimiser had look-alikes of its own — the targets as Heavens substats against a perfect
four-card set, blind to base stats, weapon and mains — and on the real inventory it picked
plans the build score rated 1.7-3.2 points below one it had considered. Target stats are
counted twice — once through their weight, once through the breakpoint term — which is
deliberate. Identical loadouts are collapsed before pricing, which pays for the costlier
evaluation.

`bestPlan` returns its evaluator as **`r.loadoutTotal`**, closed over that call's
`t` / `lo` / `idl` / `P4`. Anything comparing an arbitrary loadout against what `bestPlan`
itself would score must call it rather than re-deriving the rule. `upgradesFor` uses it for
`curTotal`, the group total and every per-row marginal — the Space row included — with
whatever a row does not change, the worn Space card included, left as it is. So no number
shown there is scored by different rules than the plan search that produced it.

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

**Gains are shown in build points, and characters are ranked by them.** `delta` and `group`
are raw, in the character's own units, and order that character's rows (`upGain`). Each row
also carries `pts` / `groupPts`: the same gain × 100 ÷ the character's perfect total, which
is exactly the build score it adds (`upPts`). That is what the Gain column shows and what
orders characters against each other. A raw point is 0.104 build points for Tropical Motoha
and 0.162 for Kiyoshi on the real inventory, so ranking on raw gains (until Sep 2026) put
the largest yardsticks first. A suggestion is listed only from `UPGRADE_MIN_GAIN` (0.1 build
points, the column's precision) up; it was one raw point, a different amount for everyone.

**A trade is priced on both sides.** With "Ignore cards equipped on someone else" unticked, a
proposed card may be worn by another character, and the gains above count only the receiver.
On the real inventory 62 such rows were listed, and for 39 the giver lost more than the
receiver gained even after putting their best free card back (six characters were each told to
take Futaba's Resolve Space card, worth 0.8-3.3 to them and 4.3 to her). So each trade row
carries `giverPts`, and each move `lossPts` — for a 4-piece switch, everything it takes from
everyone, priced jointly — from `giverLoss`: the giver's build points with the taken cards
replaced by their best free card of each slot, same set first, against the giver keeping the
better of the worn card and that free one (a free card that beats the worn one is an upgrade
they have anyway, and crediting it to the trade once made a loss negative and a net larger than
the gain). `upPts` is net of `lossPts`, so characters are ordered by the net; the "on X" tag
shows X's loss and the footer or row shows the net. Nothing is hidden, since the user may value
one character over another and build points cannot know that — but the box is now ticked by
default, which is what the user had chosen, and with it no trade is ever proposed. The Optimise tab, whose Card pool defaults to "All cards", prices its trades the same way: each "on X" tag carries X's loss (`onTagHtml`), and the build-score panel says what the loadout takes, from whom, and the net for the account.

**The shortlist, and the polish.** Each slot's candidates are ranked on context-free
`cardScore` (§3), and a plan takes each set's top card per slot. The build score can prefer
a card further down — it sees the stat targets and the damage balance across the five cards —
so every plan the policy allows within `POLISH_WINDOW` (2) build points of the allowed leader
tries each slot's next `POLISH_DEPTH` (8) same-set cards, Space included, keeping any swap
that raises the build score; plans are then re-ranked and de-duplicated. A test holds that no
single same-set swap in that reach beats the pick. Measured when it replaced the old scheme
(28 Sep 2026: a shortlist priced against the plan's other cards, iterated until stable, and a
4-deep Heavens-only pass over the winner): on the real inventory never worse, 17 characters
better by up to 2.6; on the scale.js account one loss (Runa, `stats`, −0.23); 0.7-1.1 s a roster
against 1.1-1.7 s; calibration 69.5 → 69.6, bands unchanged. Polishing every plan gives the same
picks at 15-20× the cost. Brute-forcing every combination of each slot's top six (an older
experiment) found at most 1 point beyond single swaps, so one pass is enough.

### `runTriage()` — keep / hold / feed

Triage's Score is **not** `cardScore`. It is the `buildScore` delta of actually swapping
the card into its slot given the character's real other equipped cards, real weapon and
real ascension:

```
marginal = buildScoreOf(char, others + card).raw − buildScoreOf(char, others).raw
```

where `others` is that character's real equipped cards minus whatever currently sits in the
card's slot. Both ends are unrounded, and an empty `others` is priced at what the
character's base stats earn rather than 0 (§5): the rounded score left the real inventory on
about thirty distinct values and moved 6% of verdicts, and the zero baseline let a character
wearing nothing win nearly every "best fit". This matters because `cardScore` is context-free: a mostly-Crit-Rate card can
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
every Sun card read as feed. The Vault ranks within slot for the same reason.

The **element gate is hard, not a ranking nudge**: characters off an element-locked set's
element are removed before either argmax. Ranking alone was not enough — a broad weight
vector can out-score a set bonus on stats alone, which is why Motoha Arai [Tropical] was
once the named best fit for Fire-locked Strife cards she can never benefit from.

One carve-out: when **no eligible character is owned at all**, the Score falls back to the
same marginal maxed over the *whole* roster, so a strong Fire card is not marked feed just
because you have not pulled a Fire character yet. The "best fit" cell then reads
"— no one in scope".

**A card the Upgrades tab recommends is never feed.** The marginal prices one card at a
time against what is worn now, but most of a set switch is its 4-piece bonus, which lands
only with the fourth card, so each card of a recommended switch can read as a loss on its
own. On a synthetic inventory 54 of the 340 unequipped cards in the optimiser's 4-piece
plans came out feed (53 of 340 under `pref`). So `runTriage` calls `upgradesFor` for every
character in scope, at the Upgrades tab's own current settings, and a card it names carries
`rec`: the verdict is keep whatever `pct` says, and the Best fit cell names that character,
tagged "upgrade" (the character whose upgrade is worth most if two want the card). `who`
keeps its own meaning, the eligibility argmax. The real inventory had no such card marked
feed at the defaults (Sep 2026) — its 13 recommended cards graded 66-100% on their own —
but the case is one set switch away, and a fed card does not come back. The Optimise tab's
other policies are not asked: it is a per-character exploration tool, and Leo's four level-25
Peace cards, which its `pref`, `any4` and `stats` policies use and nobody on the roster lists,
are what the Vault (Triage's "Lock for later" view) and the "no one in scope" note are for.

**The Vault's answer is read too.** Triage is relative to the characters you own, so it
calls feed a card nobody you own gains from now; the Vault prices the same card against
every role, blind to the roster. `runTriage` runs `vaultRate` — the Vault's scoring pass
without the DOM — over the Vault view's own card set (its percentiles depend on the
population, so the two tabs then say the same about the same card), and `trVerdict` marks a
would-be feed the Vault rates worth a lock **lock**; one it rates worth holding keeps its feed
verdict with a "vault: hold" note. On the real inventory (Sep 2026) that was 76 locks and 266
notes among 1322 feed candidates, leaving 980 plain feed — which only a card-by-card
cross-check of the two tabs used to catch. About 20 ms.

**The default order is the verdict's.** With no column clicked, the "Show" control sorts on
`quality` (`TR_SORT_COLS`): the `trTier` — plain feed, Vault-held feed, lock, hold, keep, an
Upgrades pick — then `pct`. It used to sort on the raw Score, which differs by slot by
construction — a Space card's best is worth about eight points, a Moon card's several times
that — so "worst first" interleaved slots: on the real inventory the first 800 rows, all the
table draws, held 199 hold cards while 723 of the 1322 feed candidates sat below them. They
are now all plain feed. Clicking Score still sorts on Score.

Performance: `runTriage` precomputes `t` / `lo` / `idl` once per character and passes them
into `buildScore`. `npm run triage-perf` benchmarks the worst case (4000 cards × 68
characters) in a real browser — check it after touching any of this. The Upgrades guard is
most of its cost now: 1.6 s → 2.8 s on the benchmark, 0.9 s → 1.4 s on the real inventory.

### `runVault()` — what deserves a lock

The counterweight to Triage's element gate. Once Triage refuses to name anyone it will
happily call a card junk that a future character would want, and a fed card does not come
back. So `runVault` answers its question **without reference to the roster** — pulling a
character cannot change a verdict. Its scoring pass is `vaultRate(cards)`, which Triage also
calls, so a card the Vault rates worth a lock is marked lock on the Triage tab rather than
feed (see above). Two yardsticks:

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
both ends first quantises a real difference away. The baseline is `buildScoreOf`, so a
character wearing nothing is measured from what their base stats already earn, not from 0.

Nothing here scores, ranks or optimises anything the rest of the tool reads — it is a
reading of the current board, and the scoring pass is cached so filters and column sorts
redraw without re-running it (measured: 301 ms for 65 owned characters over 4000 cards,
53 ms to redraw).

### `ccRow(ch, o)` — the custom card (Cycle of Fate event)

The Cycle of Fate event makes a 5★ Sun, Moon, Star or Sky card whose set, slot, main and four
substats the player picks (other events do the same for a Space card — the view's Card type
switch, `o.kind`; a Space card is tried in every released Space set that pairs with a set
`ccSets` offers, rolled on the Space tables, and its alternatives are the other Space sets); the substat *values* are random rolls, and its five upgrades land
at random. For each character in scope:

- **Baseline** (`ccContext`) — the better of what is worn and `bestPlan`'s pick from the pool,
  both priced by that `bestPlan` call's `loadoutTotal`. The gain is measured from there, not
  from what is worn: a better card already owned is free, and crediting it to the crafted card
  would rank the worst-dressed character first.
- **Design** (`ccDesign`) — per slot, the main among the slot's recommended ones (every legal
  main where lufel's slot is open), best `CC_MAIN_POOL` by their perfect card's `cardScore`; the
  substats every four of the best `CC_SUB_POOL` by coupled weight plus any stat with a target;
  each priced as the whole loadout around it.
- **Placement** (`ccPlace`) — the best of: `bestPlan` re-run with the card added (it can
  complete a 4-piece the inventory is one short of), or the card dropped into the baseline or
  the worn loadout. Tried in every set `ccSets` offers (the character's own list plus any set
  in those loadouts; never unreleased or off-element), and the slot's winner designed again in
  the loadout it ends up in.
- **Rolls** (`CC_ROLLS`) — typical: each substat at its average `ROLL_TIERS` value with the
  five upgrades spread evenly (1.25 each, the average of random landing); perfect: the build
  score's own `IDEAL_ROLLS` at maximum; poor: every roll at its lowest tier. Priced at level
  25 — the main's growth is certain.

Gain is `100 × (with − baseline) ÷ idealTotal`, build points, comparable across characters.

**Luck** (`ccOutcomes`): the card arrives at level 0, so its starting tiers, which substat each
of the five upgrades hits and each upgrade's tier are random (all equally likely). The Likely
column is the middle 80% of `CC_SAMPLES` (400) seeded simulations of the recommended card in the
loadout it was placed in, everything else held fixed; floored at 0, since a worse card would not
be worn. Measured on the real inventory (6 Oct 2026): the typical-rolls gain sits within 0.15 of
the simulated average for the top twelve, and the middle 80% spans 1.2-2.5 build points. The
check panel simulates the entered card from its known starting values and a fresh roll of the
recommended card (`CC_CHECK_SAMPLES`, 2000 each), and `ccChanceBetter` is the chance the first
ends up above the second — the keep-or-re-roll question.
`ccSecond` picks the event's second card: the next character's, or a second card for the
first character priced with the first already in the pool and worn — whichever adds more.

Speed: the pool is cut to each slot and set's top `CC_KEEP` cards (all `bestPlan` can reach —
a test holds the answer identical), and the dozen re-runs per character read a narrower
`placePool` (the card's candidate sets, every Space card, each slot's best of any set). About
50 ms a character on the real inventory (4316 cards): 2 s for 37 owned, 3 s for all 68,
run in 50 ms slices so the progress line draws. The "Check a card" panel prices a card the
user rolled (level-0 values) three ways once levelled, against the recommended card at
average rolls, and against every character the last run rated.

## 7. Constants, in one place

All in `src/logic.js` unless noted. Changing any of these changes every score — re-run
the calibration in §9 before shipping.

| Constant | Value | What it controls |
|---|---|---|
| `MAIN_MAGNITUDE` (`data.js`) | per stat, [Lv0, Lv25] | Measured main-stat values; `mainRolls()` converts to max rolls (~9 at Lv25) |
| `MAIN_ROLLS_FALLBACK` | `9` | Used only for a main missing from the table (none today) and to scale HP Recovery |
| `DAMAGE_SCALE` | 8 characters | Kits whose ⓐ is DEF or max HP rather than ATK |
| `BUFF_SOURCE_STATS` | Beachflower Minami (HP%, Crit Mult) | Stats a kit turns into an ally buff: left out of the coupling and of `damageShare` |
| `CRIT_PROFILE` | Ryuji, Pioneer Shun (`locked: 1`); Akihiko (`0.3`, clamp 250-350); Junpei (`0.35`); Kumi (`nocrit: 0.45` until Awareness 6); Wavecatcher Miyu (`extraCr`: 0.5 at +16.4-31.4%, 5★ weapon) | Share of a kit's damage that always crits, cannot crit, or crits at a higher rate |
| `KIT_STAT_BUFFS` | 47 characters, ~155 lines | Conditional lines judged always-on, gated on Awareness / weapon / stacks; skill-level `tiers` follow `kitTierIndex` |
| `CONVERSIONS` | 16 characters | Always-on stat conversions fed into ⓐⓑⓓ and the coupling from in-battle source totals |
| `MAIN_MATCH_BONUS` | `10` | Bump for a main the character actually wants |
| `MAIN_ALT_DECAY` | `0.85` | Per-rank decay across a slot's alternative mains |
| `MAIN_CHOICES` | `3` | Alternatives per slot the target editor exposes |
| `rarityPenalty` | `1 / .82 / .6 / .4` | Whole-card multiplier for 5★ / 4★ / 3★ / 2★ |
| `IDEAL_ROLLS` | `[3, 2, 2, 2]` | How the ideal card spreads nine rolls over four stats |
| `SPACE_PAIR_VALUE` | `9` | Space card pairing with the active 4-piece |
| `POLISH_WINDOW` | `2` build points | Plans this close to the allowed leader get `bestPlan`'s same-set polish (§6) |
| `POLISH_DEPTH` | `8` | Same-set cards per slot, Space included, the polish tries |
| `UPGRADE_MIN_GAIN` | `0.1` build points | Smallest swap the Upgrades tab lists (was one raw point, a different amount per character) |
| `BREAKPOINT_VALUE` | `80` | Whole stat-target block, regardless of target count |
| `SPREAD_VALUE` | `80` | Damage-spread budget, scaled by `damageShare(t)` |
| `COUPLE_CLAMP` | `[0.4, 2.5]` | Guard on coupling multipliers — not a tuning knob |
| `state.teamCrit` | `0` (Roster, saved as `settings.teamCritRate`) | Crit rate the user's supports add, in points, to every damage dealer's crit rate in the damage model and the coupling — never an Elucidator's, never a `totalStat` total or stat target |
| `p4value` default | `55` | 4-piece worth; UI slider. Preferred × 1 (+ `prefSetLift`), secondary × 0.72, other × 0.22 |
| `SET_LIFT_PAIRS` | `8` | 2+2 splits `prefSetLift` searches, among the best 2-pieces for the character |
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

**`npm test`** — 309 assertions in `test/optimizer.test.js`, in ten blocks: plan legality and
set-plan integrity over the whole roster (every plan's total is the build score's numerator,
and no allowed alternative builds higher than the pick); data integrity (sets and their `bonus2Also` terms,
Space pairings, roll tiers, `MAIN_MAGNITUDE`, the hand-kept judgement tables, weapon `extra`
lines); the §7 constants; card pricing and the coupling (scale-neutrality, seeded baselines,
the crit cap, a Setup change reaching a saved target, the NaN sweep over every board,
Elucidators uncoupled in the per-slot pick too, open slots, the level-0 best case minting
a missing fourth substat); loadout pricing and the build score (the
ideal is a legal card and scores exactly 100 for everyone, and no other main, 4-piece or 2+2
of perfect cards beats it — Wavecatcher Miyu's Star named as the one exception, and none at a
20% team crit rate; the team crit rate repricing the coupling at once and surviving a save); the damage model (`flat + pct`,
the fixed mains in ⓐ, the crit floor across the roster, locked and no-crit kits,
conversions, the spread term's direction); stat targets (tiers, kit-buff gating, a target met with no cards left unscored,
unknown-main fallback, Prudence's Speed cost); saved targets as a diff over the data, and old snapshots converted on load; Triage, Vault, Upgrades and Headroom on a
synthetic inventory (unrounded marginals, a bare board priced at what its base stats
earn); import normalisation, validation and the merge budget; and a walk of
the real UI ending in a save/load round trip. `WEIGHT_OVERRIDES` is checked against
`src/data.js` outside the page. Add an assertion for any invariant you rely on. Rebuilt
18 Sep 2026 after the working copy was reverted by mistake; every documented invariant was
re-derived and its expected value checked against the live page before being pinned.

**`npm run scale`** — 4000-card synthetic benchmark across all four set policies, plus a
`buildScore` block that equips every character's `pref` recommendation and scores it. Check
the distribution of plan kinds stays sane. Calibration to hold to:

| Metric | Expected |
|---|---|
| Build score, 4000 cards optimally equipped | **around 70** (mean 69.5, median 71, range 40-84) |
| Bands (excellent / good / workable) | about 7 / 53 / 8 of 68 |
| Moon/Star/Sky picks with a non-recommended main | **33 of 204** (was 71 of 195 at `MAIN_ROLLS = 3`; an open slot never counts) |
| `pref` plan kinds (2+2 / 2+free / 4pc) | about 17 / 49 / 2 |
| 80+ | genuinely excellent |

**The pool is drawn from `Object.keys(SETS)`, so a data refresh that adds, renames or
re-orders a set redraws it.** Every card keeps its slot, rarity, main and substats (one random
number per draw whatever the list's length) but lands in a different set, and set membership
is most of what a `pref` plan is. The lufel refresh of 25 Sep 2026 did exactly that — 32 set
keys became 34, four of them renamed, and a Space card was renamed and re-sorted — and the rows
above moved with no scoring change at all. To
tell pool drift from a real data effect, draw the pool from the *old* key list with the renames
applied and compare against the old data on that same pool: for this refresh the old pool reads
mean 70.5 → 70.3, median 71 → 70, range 51-84 both, bands 10 / 53 / 5 both, 26 non-recommended
mains both and kinds 26 / 39 / 3 both, and only two characters move — Yumi Shiina's corrected
weights (72.8 → 69.3) and Shoki Ikenami [Notte]'s preferred set becoming lufel's Gain (74.4 →
67.5). The new pool's 40 is Yusuke on a thin Opulence draw; he reads 67.9 on the old one.

(Measured 25 Sep 2026 on the 68-character roster. The Triage / level-0 / fixed-main fixes of
that date moved none of the build-score rows (the main count went 44 → 45); starting Ailment
Accuracy at its real 0% moved the mean 70.7 → 70.5, the median 71 → 70 and the top 86 → 83,
and left the bands where they were. Making plan totals the build score's numerator raised the
mean to 71 and the median to 71 — the optimiser now picks what the score rates best — cut the
non-recommended mains 45 → 36, and moved `pref` from 33 / 32 / 3 to 23 / 42 / 3; under
`force4` all 12 characters whose pick changed build higher, by 2.8 on average. Holding the
perfect build as a ceiling — open slots, uncoupled Elucidators, the preferred-set lift and the
kit fixes — moved the mean 71 → 70.7, the top 83 → 84 and the bands to 10 / 53 / 5, cut the
non-recommended mains to 27 (the nine open slots no longer count, and none of the rest is
new), and left Triage and the optimiser's timings within noise.)

Nothing should clamp at 100. If a change moves those, either the change is wrong or
`BUILD_BANDS` needs re-cutting — check before shipping. A rise in the non-recommended-main
count means the optimiser is trading the main away for substats again.

**`npm run triage-perf`** — 4000 cards by 68 characters in a real browser, for anything
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
| **Party buffs are not modelled; the Thieves Den is a user entry** | Every total is a **floor** until the Thieves Den is filled in (header settings, flat points the game shows in battle: see CLAUDE.md). It reaches only the stat targets and the in-battle totals on screen, never `totalStat` or the damage model. Say so wherever a total is shown. |
| **Party crit rate is a user setting, 0 by default** | Lufel's DPS builds put Crit Multiplier on the Star (35 of the 62 who weight both crit stats list it first, 9 list Crit Rate first) and Crit Rate in the substats. That is right in a party that supplies crit rate: an Elucidator's 20% share, Starlight Ren's, Summer Ichigo's or Beachflower Minami's buffs. On the character's own board crit rate is scarce, so at 0 the engine prefers a Crit Rate Star for most of them. It also recommends splitting the preferred 4-piece with Triumph's +7.5% crit-rate 2-piece for about 15 DPS on the real inventory; both predate Sep 2026 (14 splits in the Aug build). Wavecatcher Miyu, who lists only Crit Multiplier, is the one ceiling exception at 0: her Resonance crit rate (`extraCr`) narrows the gap from 2.6% to 1.7% of a perfect build, 0.5% on the real inventory's setup. The Roster's **team crit rate** is that party's crit rate, one number for the roster (§3). At 20 the perfect Star follows lufel's first choice for 24 of 32 (13 at 0), nothing breaks the ceiling, and the Triumph splits drop from 16 to 14 (5 at 40). It is not a kit fact, so it stays the user's to set. From 30 up, Summer Ichigo's HP% Star falls 0.2-0.7% behind a Crit Multiplier one, because her own party buff is counted once in her kit and again in the setting. |
| **Weights run past a kit's cap** | A weight prices a stat linearly, so a buffer's ATK% past the target where their buffs stop growing, Kira's Ailment Accuracy past the 90% his Bleed passive reads, and a healer's SP Recovery past what her rotation spends all keep their full weight. The stat-target term values reaching a cap; nothing discounts running past it. For sets, `prefSetLift` stops this from overturning lufel's order. For mains and substats it remains, and it is why an Elucidator's ATK% Star ties lufel's crit Star (0.002% apart). |
| **A healer's ATK% is coupled with her own Damage Multiplier** | The ATK% / Damage Multiplier product assumes ATK% buys damage. For an ATK-scaling healer it mostly buys healing, yet with any Damage Multiplier weight (the Healer archetype's 1 is enough) it is priced at its marginal against her own damage product — 0.76 of its weight for Lufel. `BUFF_SOURCE_STATS` is the mechanism for taking a stat out; no healer is listed, because none changes a ceiling today. |
| **Resistance Pierce (factor c) is not modelled** | Deliberately excluded from `MODELLED_STATS` and from coupling — its value depends on enemy resistance. |
| **Flat ATK is absent from coupling** | A max roll is worth well under half an ATK% roll, and how much depends on a base ATK `cardScore` is not given. |
| **Conditional kit buffs and conversions are counted only where hand-listed** | `KIT_STAT_BUFFS` (47 characters) and `CONVERSIONS` (16) are judgement tables, not parses. Team- and HP-conditional lines are left out; a chained conversion is evaluated on pre-conversion totals. Lufel's `battle_plus_stats` notes confirm its targets assume the same kind of lines (Ashiya's passive DEF, Runa's weapon accuracy, Chizuko's Awareness-2 stacks, Tempest Riko's conversion). |
| **`damageShare` classifies stats by name** | An ATK-scaling healer's ATK% is booked as damage though it is bought for healing, and an HP-scaling tank's HP% is booked as damage though it is also their tank stat. Harmless while the same weights build the ideal, but a share cannot be read as "how much of them is damage". |
| **A donated stat's real worth is still not modelled** | The spread term is now gated off for Elucidators (§5), so they are no longer scored on a damage product they never compute. What is still missing is the other half: a donated point's value depends on the receiving ally's balance, so nothing prices an Elucidator's stats *positively* either — they are scored on cards, sets and their own stat targets alone. |
| **Off-element sets taken for a Space pairing cannot be scored** | `bonus2Value`/`bonus4Value` return 0 off-element, so lufel's "dead 4-piece to unlock a Space effect" builds are dropped from the target and stated in the character's note. |

Main-stat magnitudes are real for 5★ now. The remaining honest upgrade is a scan of 4★ and
3★ cards to confirm they sit on the same curve.
