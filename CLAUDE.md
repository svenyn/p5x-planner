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
npm run triage-perf  # 4000-card x 65-character Triage timing, in a real browser
npm run shots        # writes docs/shot-*.png for visual review
npm run export-tables # build, then write dist/tables.json — the slot/set/substat/alias/
                       # character vocabulary the OCR pipeline should read instead of
                       # hand-copying src/data.js
```

Game data is re-derived from lufel.net rather than hand-edited (see
`docs/DATA-SOURCES.md`):

```
node tools/fetch-lufel-data.js lufel.json    # download lufel's raw /data/ files
node tools/audit-lufel.js lufel.json         # diff against src/data.js, reports only
node tools/gen-data-from-lufel.js lufel.json # emit replacement SETS/SPACE_SETS/CHARACTERS
node tools/gen-awareness.js lufel.json       # patch CHAR_STATS[*].awareness into src/data.js in place
```

Run the audit before changing anything in `src/data.js` by hand — it will usually tell you
the answer, and it never writes.

There is no dev server and no bundler. `dist/p5x-planner.html` must stay a single
self-contained file that runs from `file://`. Open it directly in a browser.

## Architecture

Three sources concatenated by `build.js` in this order — the order matters, `logic.js`
executes immediately on load and depends on both of the others:

| File | Contains |
|---|---|
| `src/data.js` | Game data only, no behaviour. Slots, substat roll tables, 32 sets, 19 Space cards, 8 archetypes, 65 characters in release order. |
| `src/ui.html` | All markup and CSS. No `<script>` tags. |
| `src/logic.js` | State, scoring engine, optimiser, rendering, event wiring. |

### Hard constraint: no browser storage

`localStorage` and `sessionStorage` are **not available** — this ships as a Cowork
artifact where those APIs fail. Persistence is explicit JSON download/upload only
(`save()` / `load()` in `logic.js`). Do not add browser storage; it will silently break
the artifact build.

### Scoring engine

> **`docs/SCORING.md` is the full reference** — the call order end to end, every constant
> in one table, which screen uses which function, the known gaps, and how to verify a
> scoring change before shipping it. The sections below carry the *why* behind each
> decision and the constraints you must not break; go there for the *what*.

Everything routes through five functions in `src/logic.js`:

- `cardScore(card, target)` — weighted **roll value** of substats (`value / maxRoll`, so
  stats on different scales compare fairly), plus the main stat at its **real magnitude
  for the card's level** (`MAIN_MAGNITUDE` in `data.js`, via `mainRolls()` — about nine max
  rolls at Lv25, i.e. as much as all four substats of a perfect card together), with a
  small `MAIN_MATCH_BONUS` tie-break when it is one of the character's recommended mains,
  all scaled by a rarity penalty. Weights are not read straight off the target — they pass
  through `couplingFactors()` first (see below). HP Recovery, the one main-only stat, is
  worth a character's top weight if lufel lists it for that slot and **nothing** otherwise
  (`hpRecoveryMainWeight`) — an earlier opportunity-cost pricing made it never worse than
  the best main for anyone, and handed HP Recovery Moons to damage dealers.
- `bonus2Value(set, char, target)` — a 2-piece "+12% ATK" is worth however many maximum
  ATK% rolls that is, times that stat's weight. Returns 0 for off-element sets.
- `bonus4Value(set, char, target, base)` — `base` defaults to 55 and is user-adjustable in
  the UI. Preferred set gets `base`, secondary `base * 0.72`, anything else `base * 0.22`.
- `bestPlan(char, pool, opts)` — enumerates 4-piece, 2+2, 2-piece-plus-free and no-set
  plans, dedupes identical loadouts, then filters by `opts.policy`
  (`pref` | `force4` | `any4` | `stats`) and returns the winner plus alternatives.
- `buildScore(char, cards, p4value)` — 1-100 for how well a character is geared, or `null`
  if nothing is equipped. See below.
- `damageFactors(cards, char, t, lo)` — lufel's ⓐ ATK, ⓑ damage bonus and ⓓ crit for a whole
  loadout, and their product. The one place that knows those multiply rather than add, which
  is what makes stat *spread* count. See below.

Those first four produce scores that are **ordinal, not cardinal**. They are only
meaningful when comparing options for the same character. Do not present them as damage
percentages or add cross-character comparisons that assume a shared scale.

On screen a single card's score is shown through `cardPct()` — its raw `cardScore` as a share
of that slot's `idealCard` for the same character, 0-100, clamped — with `cardHeadroom()`,
the raw points to that ideal, beside it. Raw card scores differ by slot by construction (a
Moon/Star/Sky main is worth ~nine rolls, a Sun/Space main never one the character wants), so
the percentage is what makes "how far from perfect" read the same in every slot. It has a
knock-on the user noticed at once: a Moon/Star/Sky card with a wanted main is ~50% of its
ceiling at Lv25 before substats count (~12% at Lv0), while a Sun or Space card is all
substats, so those two slots usually read lower with equivalent rolls. That is honest within
a slot but not across slots — a Sun ceiling is about half a Star ceiling — which is what the
headroom is for: it is in raw units, one scale across a character's five slots, so the
largest headroom is the largest gain a replacement could bring. Both are display only:
nothing ranks or optimises on them, plan totals stay raw, and neither compares characters.
The Upgrades tab's **Weakest slots** view is built on the headroom — see below.

### The build score is the one cardinal number

`buildScore` divides the equipped loadout's score by the score of a *perfect* loadout for
that same character, so the weights cancel and the result **is** comparable between
characters. Both halves go through the same `scoreLoadout(cards, char, t, p4value)`, which
is the only place that decides what a loadout is worth — keep it that way, or the numerator
and denominator will drift apart and the scale stops meaning anything.

100 is five max-level 5★ cards, all four Heavens cards in the preferred set, a recommended
main stat in every slot, a Space card that pairs with the 4-piece, and every substat roll
at maximum magnitude on one of the character's four best stats **other than that card's own
main** — the game never mints a substat duplicating the main and `validateCard` rejects one,
so `idealSubs(t, main)` excludes it. Until Sep 2026 it did not, every Moon/Star/Sky ideal
was an impossible card two or three max rolls too rich, and both the build score and every
per-card percentage read low for everyone; a test now runs every ideal card through
`validateCard`. `IDEAL_ROLLS = [3,2,2,2]`
spreads a max-level 5★'s nine rolls (four substats plus five upgrades) over those four
stats. Funnelling all five upgrades into one substat would score higher, but it is so rare
that using it as the denominator squashes every real build into the low thirties; anything
that beats the ideal clamps at 100.

Calibration, printed by `npm run scale` (its `buildScore` block): an optimally-equipped
4000-card synthetic account lands **around 70** (mean 70.5, median 70, range 51-86), and
80+ is genuinely excellent. Nothing clamps at 100. `BUILD_BANDS` is cut at 80/60/40; it was
75/55/35 while a main stat was priced at three rolls, and pricing mains at their measured
magnitude lifted every score by about five points without changing the shape of the
distribution (6/54/5 excellent/good/workable after, 7/54/4 before). Making the ideal card
legal (Sep 2026 — its substats used to duplicate its own main, see below) lifted the mean
by 0.4 and moved the bands to 11/49/5; the median did not move, so the bands were left
alone. If a scoring change moves these, either the change is wrong or `BUILD_BANDS` needs
re-cutting — check before shipping. The same block prints how many Moon/Star/Sky picks carry
a main lufel does not recommend (40 of 195 on the synthetic pool, down from 71): a rise
there means the optimiser is trading the main away for substats again.

### Spread matters, because damage is a product

A weighted sum treats stats as substitutes: nine Crit Multiplier rolls are worth nine rolls
whatever else the build holds. The game does not work that way. Lufel publishes the damage
formula (`lufel.net/article/damage-calc`, recorded in `docs/DATA-SOURCES.md`), and the three
factors the cards move **multiply**:

```
ⓐ (character ATK + weapon ATK) × ATK% + flat ATK
ⓑ 100% + Damage Mult + elemental damage bonus + increased damage taken
ⓓ 100% + Crit Rate × (Crit Mult − 100%)
```

So a loadout that pours every roll into Crit Multiplier and leaves ATK at base multiplies a
ⓓ that a 5% crit rate has already pinned near 1, and is worth far less than the sum of its
rolls says. Two things handle this at different altitudes:

- `couplingFactors()` in `cardScore` — the **first-order, per-card** version. Which stats
  are complements and how much a roll of each is worth at the margin.
- `spreadRow()` in `buildScore` and `bestPlan` — the **exact, per-loadout** version.
  `damageFactors()` evaluates ⓐⓑⓓ from what the loadout actually holds and returns the
  ratio against a perfect build for the same character; the term is worth `SPREAD_VALUE`
  (80) × `damageShare(t)`, awarded in proportion to that ratio.

`damageShare` is why this does not inflate tanks: it is the fraction of a character's weight
budget sitting in the modelled stats — about 0.73 for a DPS and 0.03 for a shield Guardian —
so the term is worth what damage is worth to them, with no archetype whitelist. It counts
Resistance Pierce as *not* captured, because ⓒ is not modelled and a term must not claim
credit for a factor it left out.

**Which stat sits in ⓐ is per character.** `DAMAGE_SCALE` names the six kits whose skill
text writes every damage line as a fraction of DEF (Yusuke, Ashiya) or max HP (Junpei, both
Shuns, Kiyoshi Kurotani); for them `scaleStat()` puts DEF/HP and DEF%/HP% where ATK/ATK% sit
for everyone else — in `damageBase`, `damageFactors`, `modelledStats()` (so `damageShare`
books HP% as damage for Junpei, which is why he reads 0.4 and it is correct) and the first
coupling product. Yukimi Fujikawa is deliberately not listed: her DEF feeds shields, never a
damage line. Tropical Motoha is not either: her damage is ATK-scaled and HP is *converted*
into ATK by a passive, which her HP% weight already captures. Those six also have ATK% at 0
in `WEIGHT_OVERRIDES` — the generator caps an unlisted stat at 4, and 4 is a third of a real
weight for a stat their kits never read.

**`CONVERSIONS`** are the always-on stat conversions — Runa's ATK is +60% of her Ailment
Accuracy, Yaoling's +1% per 2 Speed, Tempest Riko's crit damage +84% at 450% SP Recovery, Kumi
and Tropical Motoha's flat ATK from Speed and HP. The weights already put the source stat
first (that is why lufel lists it first), but the damage model did not see the conversion, so
ATK% was over-credited against the source stat for all of them: on Runa's perfect build the
conversion is +166% ATK. `conversionBonus()` reads the in-battle source total, cards included,
and feeds ⓐⓑⓓ, both coupling baselines and `damageShare`. Party-buff conversions (Miku,
Manaka, Fuuka, Yumi, Kayo, Haruna, Leo) are not the character's own damage and are not
listed. Lufel's target notes (`battle_plus_stats`) do the same arithmetic — Tempest Riko's
"패시브(활기): 84%" is her Sun-kissed Blooms — which is also the confirmation that kit lines
belong in the totals the stat targets are scored against.

**`CRIT_PROFILE`** is for kits where some or all damage always crits, or cannot crit
(`nocrit` — Kumi's Highlight is close to half her damage and cannot crit until Awareness 6): `locked` is that share,
ⓓ is a mixture of the locked share at 100% (at its `cmClamp`ed crit damage where the kit
clamps it) and the rolled rest, and `lockedCritSupply` feeds the same split into the
coupling so Crit Rate is priced for the rolled share only. Ryuji and Pioneer Shun are
`locked: 1`; Skull's Crit Rate weight is already 0 for this reason, and without this the
spread term valued a Crit Multiplier roll on him at his 5% base rate. Akihiko is `locked:
0.3`: his Theurgy and Finishing Blow always crit (crit damage clamped 250-350%, 300-400% at
Awareness 4) but Lightning Fist, Blitzkrieg and Spark Impact roll, and by his own
coefficients the guaranteed part is 26-29% of his damage. A single guaranteed skill with no
stated share (Junpei's Power Swing, Mayumi's extra action) does not earn an entry. Everyone's
rolled crit rate is capped at 100%.

**`damageBase` must read `flat + pct` for Crit Rate, Crit Multiplier and Damage Multiplier.**
Those are percentage-*unit* stats: a weapon's "+18% critical rate" is 18 points added, and
`charBaseStat` files it under `pct` because `totalStat` sums `flat + pct` for them. Reading
`.flat` alone dropped every crit/damage weapon ladder and Mindscape node from the damage
model — 23 characters' signature weapons, Morgana modelled at 22.4% crit with Golden Legacy's
+18% equipped — while the in-battle totals on screen were right. A test pins all three.

**The one case `damageShare` cannot see is a stat bought to be given away**, which is why
`spreadApplies(char)` gates the whole term off for Elucidators (`arch: 'Navigator'`). Every
Elucidator's passive grants each ally 20% of the Elucidator's corresponding stat — 15% at
4★, and it is a property of the role, verified across all eight — so their Crit Rate and
ATK% are damage stats by name, which is all `damageShare` reads, while what they actually
buy is an *ally's* damage. What a donated point is worth depends on the receiving ally's
balance, which nothing here models, and seven of the eight have a 0% / 0% crit base
besides, so the ⓐⓑⓓ product from their own board is a quantity the game never evaluates.
Ungated it was worth 48-58 points of every Elucidator's build score.

That gate is a game mechanic tied to a role, not the whitelist above: it says "these stats
serve someone else's damage", not "this archetype deals no damage". Do not generalise it
into one. Two better-looking sources were tried first and both are wrong — lufel's role
prose misclassifies five of the eight Elucidators, and a damage coefficient scraped from
skill text reads DEF-scaling kits (Yusuke, Ashiya, Fujikawa) as dealing zero damage while
counting Miku's party-ATK buff as her own. Text extraction is fine for settling a one-off
argument; it is not fine as a scoring input.

Mechanically this mirrors `BREAKPOINT_VALUE`: a bounded budget added to both halves of the
build score and to every plan total in `bestPlan`, saturating at 1. It lives outside
`scoreLoadout` for the same reason the breakpoint term does — `scoreLoadout` prices cards
and sets, and these two price the loadout as a whole.

Two things worth knowing before touching it:

- **The optimiser does not need a second pass.** Picking each slot's card on its own score
  and then penalising the total looks like it should need a refinement pass; one was built
  and measured, and brute-forcing every combination of the top six candidates per slot
  against the full build score found at most **1 point** of headroom, on 2 of 65 characters,
  mean 0.03. The per-card coupling already lands on the balanced pick. If the coupling is
  ever weakened, revisit that.
- **`damageBase()` is memoised per character and setup.** It is pure `CHAR_STATS` arithmetic
  and the optimiser evaluates thousands of loadouts per character; `supplyOf()` likewise
  exists so a loadout is walked once for several stats rather than once per stat. Skipping
  either put `npm run scale` an order of magnitude slower.

`bestPlan` returns its cardSum+set-bonus+breakpoint+spread evaluator as `r.heavensTotal` (an
`evalCards`-style function closed over that call's `t`/`lo`/`idealHeavens`/`wants`/`P4`), so
anything that wants to compare an arbitrary set of Heavens cards against what `bestPlan`
itself would score can call it instead of re-deriving the rule. `upgradesFor()` is the other
caller: it used to gate its "is this swap worth it" delta on `scoreLoadout` alone — cards and
set bonus, no breakpoint or spread — while `bestPlan` had already picked the winning plan
*with* those terms, so a swap that only helped or hurt stat spread could be missed or
over-credited relative to what actually got recommended. `curTotal`/`recTotal` in
`upgradesFor` now both go through `r.heavensTotal`, so the displayed delta is never scored by
different rules than the plan search that produced it.

**A row's Gain and its plan's total are two different numbers, and conflating them was a
bug.** `upgradesFor` only ever proposes a whole 4-piece, so one suggestion is usually
several rows; every one of them carried the whole plan's delta, which read as three
separate +28s when there was one +28 on the table (the user spotted it on the Upgrades
tab). Each row's `delta` is now the marginal of equipping *that* card with the character's
other slots left as they are — exactly what the Equip button beside it does, also through
`r.heavensTotal` — and the plan total moves to `group`, set on every row of the block so
the UI can foot it once with an "Equip all" (`swapCards`, one re-render rather than one per
card). They do not sum, and a single row is often negative while the group is strongly
positive: most of a set switch is the 4-piece bonus, which lands only when the fourth card
goes on. `upGain()` is what ordering uses — rows within a character and characters against
each other — so a 30-point set switch made of four small marginals does not sort below a
single 8-point swap. The Space row keeps its own basis (`cardScore` + `SPACE_PAIR_VALUE`,
since `heavensTotal` prices four Heavens cards and knows nothing about the Space slot), so
it is comparable to the other Space candidates and not to the Heavens rows.

Absolute in-battle numbers remain `totalStat()`'s job, not this one — `damageFactors`
counts each main at its `MAIN_MAGNITUDE` value for the card's level, the same figure
`cardScore` prices it at, identically on both sides of every ratio.

### Stat targets, and what they can and cannot check

37 of the 65 characters carry `ov.targets` — lufel's "recommended stats", the hard numbers
some units need (180 Speed for Rin, 171% Ailment Accuracy for Howler, 4600 ATK for Oracle).
Weights alone cannot express these: weights make stats fungible, a threshold does not.

**The published number is an in-battle total**, so the cards are only ever part of it.
`CHAR_STATS` carries the rest from lufel — base stats by level and ascension, the
Awakening-7 bonus, Mindscape nodes, and both weapons with their 7-step refinement ladders —
and `characters[].loadout` says which of it applies. This is not a detail: Kumi Katayama's
180 Speed is 73 Speed from cards on a 4★ weapon at A0 with no Mindscape, and 14 on a 5★ R7
at A7 with it.

Only **unconditional** weapon passives count automatically. A line like "Increase Speed by
15/…/30." is a stat you always have; "After user uses [Secret Art], increase critical rate by
…" is not, and the generator deliberately refuses to parse it (`b` vs `extra` in
`CHAR_STATS`). The one route for a conditional line is `KIT_STAT_BUFFS` in `logic.js`: a
hand-kept list of lines judged always-on in the character's real rotation, each with its
reason and gated like the rest of the setup — an Awareness node counts only at or above its
level, a weapon line only while that weapon is held, at its refine step, and per-stack lines
at the stack count the kit sustains. 43 characters carry entries after a kit-by-kit pass over
lufel's skill, Awareness and weapon text; the Loadout popup says what was counted. The rules
for what earns an entry are in the table's own comment — rotation buffs of 2+ turns, sustained
stacks and modes, permanent and battle-start lines; never one-turn or Highlight-gated lines,
HP- or team-conditional ones, skill-specific multipliers, or stat conversions (those are
already why the source stat is the character's top weight). Adding an entry is a
per-character judgement about the rotation, not a parse. Skill-level ladders carry all four
printed values as `tiers`, and `kitTierIndex` picks the one the setup's Awareness and Mindscape
reach, the same family rule `pickTier` uses for the stat targets. A second
unconditional stat in the *same sentence* is not a condition, though — the parser once
dropped Mermaid Dreamer's whole "critical damage … and Resonance critical rate …" line and
scored Miyu Sahara [Wavecatcher] 36.3% Crit Multiplier under her real panel — so a weapon may
carry `b` and `extra` together, meaning "this much counted, this clause not". A test asserts
no `extra` is really a plain unconditional stat line.

**Each target carries up to four numbers, not one.** Lufel splits `ov.targets[].tiers` by the
character's own skill-level cap — `LV10`/`LV12`/`LV13` — plus a `+5` variant of whichever cap
applies. `pickTier()` picks the one that matches `characters[].loadout`. **This used to be
gated on Ascension 6; that was wrong, and the user corrected it from firsthand play — it is
Awareness.** `LV10` is the base skill-level cap every skill reaches through plain investment;
`LV12`/`LV13` is that same cap after the specific Awareness node (r3 or r5, see the Awareness
section below) whose skill-level-up lands on this character's own primary skill. Which node
that is varies by kit, not by a fixed rule: cross-referencing all 37 targeted characters'
`skill_priority` against which of their own r3/r5 text names that top skill, the switch is
Awareness 3 for most and Awareness 5 for the seven in `TARGET_TIER_AWARENESS_5`. Two
characters (Mitsuru Kirijo, Koromaru) lead with a Highlight/Theurgy skill neither node ever
names, so the check falls through to their next-priority regular skill instead. One
(Justine & Caroline) could not be resolved this way — her r3/r5 text names a "Selected Skill
1/2" slot that depends on which twin is active, not a real skill name — so she defaults to 3
unverified. Mindscape unlocked adds the further `+5` bump on top, unchanged from the original
model; a character who only ever publishes one family (no low/high split, e.g. Aran Hirano's
`LV10`/`LV12` with no `LV13`) always lands on that family regardless of Awareness. Previously
the bar always used `Math.max` across every tier, which is why it read as "always the
toughest number" no matter what the Setup fields said.

`totalStat()` adds it all up. The one piece that is not from lufel is the revelation **main
stat's magnitude** — unpublished anywhere, but printed on the card panel. The user's own
3947-card scan settled it for 5★: `MAIN_MAGNITUDE` in `data.js` holds the Lv0 and Lv25 value
of every main (linear in between), and `mainMagnitudeFor(card)` uses a scanned `mainValue`
first, then that curve for a 5★, then whatever the inventory has taught `mainMagnitude()`
about other rarities. Missing is still **unknown, never zero**: an unscanned 4★ main trips
`mainsMissing` and the target falls back to the relative measure rather than reporting an
undercount as fact.

**My Palace and party buffs are not modelled** — lufel lists My Palace as its own separate
requirement — so every total is a floor. Say so wherever a total is shown.

Two things the score does that look odd until you know why:

- The bar is capped at what a *perfect* build on that loadout actually reaches. Some targets
  are unreachable from cards plus gear at all (Starlight Morgana wants 50% Crit Rate; a
  flawless build with her recommended mains gets 26), and scoring against a number nothing
  can hit would put 100 out of reach for reasons the user cannot act on.
- The block is worth `BREAKPOINT_VALUE` (80) however many stats it decomposes into, so a
  unit with three targets is not scored out of three times as much as a unit with one.

`bestPlan` adds the same term to every plan's total. It has to: without it the optimiser
trades away the one stat the character must reach for generic quality, and then recommends
a loadout the build score rates *worse* than what the user already had. Target stats are
therefore counted twice — once through their weight, once through this term — which is
deliberate, not a bug.

Main-stat magnitudes are now real (`MAIN_MAGNITUDE`, from the user's scan), so a 5★ card's
main is a true total even without a scanned `mainValue`; `mainValue` still wins when present,
and is the only source for other rarities.

### Awareness — a fourth progression axis, and a universal stat curve plus a per-kit one

Lufel's site has a per-character "Awareness" section — 7 named passives (levels 0-6)
unlocked with Cognitite — that is unrelated to Ascension, Mindscape or the Awakening-7
bonus already described above, despite the name-collision risk: lufel's own data field for
it is called `ritual`, not `awake`. `tools/fetch-lufel-data.js` pulls it from
`/data/characters/<name>/ritual.js`; `tools/gen-awareness.js` writes the result into each
`CHAR_STATS` entry's `awareness` array (`{n, d}` per level, name and full effect text) and
patches `src/data.js` **in place** via a brace-depth scan rather than a full regeneration,
so it never touches anything else in the file — safe to run even when the rest of
`src/data.js` has diverged from `gen-data-from-lufel.js`'s own output.

Two separate things move a stat here, and only one comes from lufel:

- **The universal curve — `AWARENESS_STAT_PCT` in `logic.js`.** Every character's
  in-game Awareness screen adds the same flat HP/ATK/DEF percentage as levels unlock —
  102/105/107/110/112/115% of base at levels 1-6 — confirmed by the user against a real
  panel (Makoto Niijima [Queen]) rather than sourced from lufel, which does not publish
  it. It is not per-character like Awakening-7's `aw`; one constant covers the whole
  roster. `charBaseStat()` adds it into the same `pct` accumulator as Awakening-7's own
  percentage bonuses, on the same "same-factor stats add" basis as everything else there.
- **The named ladder itself — `CHAR_STATS[*].awareness`.** A full scan of all 455
  Awareness descriptions across the 65-character roster found **zero** that are a bare,
  unconditional "Increase \<stat\> by \<N\>%." — every one is gated on a trigger (start of
  battle, on-crit, on-Theurgy, a stack mechanic, a duration) or is a skill-level-up, the
  same bar conditional weapon passives are held to (see `w4`/`w5` above). So a node
  carries an `s`/`v`/`pct` only when `parseRitualBonus()` in `tools/gen-awareness.js`
  finds a real one — today, none do — layered on top of the universal curve, not instead
  of it. `charBaseStat()` applies any that exist, cumulatively up to the loadout's
  `awareness` level, the same threshold pattern Mindscape's `L.mind` boolean uses;
  re-running `gen-awareness.js` after a game patch is what would pick up a future
  character whose kit actually adds one.

The Loadout popup and Targets dialog show both: the universal percentage at the selected
level, and which named abilities are unlocked (name plus a hover tooltip with the full
effect text) — mostly for reference, since almost none of them add anything beyond that
percentage. `awareness` defaults to `0`, not maxed like Ascension and weapon do — the
same reasoning as `mind: false`, since it is a per-character grind rather than something
a well-progressed account has finished on everyone.

### Lufel publishes an order, not magnitudes

`ov.w` is not hand-written. Lufel ranks each character's substats into three priority
tiers, and `gen-data-from-lufel.js` turns that ranking into numbers with a flat map —
tier 1 → 10, tier 2 → 8, tier 3 → 6, anything lufel weighed and left out capped at 4,
over the archetype floor. The ranking is lufel's and is trusted. **The magnitudes are the
generator's own invention**, and one falloff curve is shared by all 65 characters.

That is wrong wherever a character's priorities fall off faster than average. A DPS whose
whole job is one damage number wants its tier-2 stats nearly as much as its tier-1 ones. A
support that chips in a little damage on the side does not — even when lufel correctly
lists that damage stat first, because lufel is answering "which stats does this unit use",
not "how much worse is the second one".

**One overstated weight is charged three times**, which is why this matters more than a
ranking wobble:

1. It ranks substats — the visible one.
2. `damageShare(t)` is computed *from the weights*, so it decides how much of the build
   score is the `SPREAD_VALUE` damage-product term. Overstate a character's damage stats
   and they get graded like a DPS on a damage product their kit never builds.
3. `idealCard` picks the ideal loadout from the top weights, and that ideal is the
   **denominator of every build score**. So the yardstick itself becomes a build the
   character is never played as, and their real gear is measured against it.

Seaside Moko was the standing example. Lufel puts Damage Multiplier in her tier 1
alongside ATK%, for a healer whose Resonance chips for 19% of ATK — real damage, but a
small share of a team total. At lufel's own 10/8/8 a **flawless** heal build could not
score above 82: `damageShare` read 0.649, the highest of any healer, and her ideal card
came out carrying Damage Multiplier and Crit Rate. At 5/3/3 that build scores 96, a crit
build still scores 83 (the damage is real, so it must not be priced to zero), and
`damageShare` lands at 0.524 — beside Yukari's 0.511 and Morgana's 0.529.

`WEIGHT_OVERRIDES` in `gen-data-from-lufel.js` is where a per-character magnitude
judgement lives. Two things earn an entry, both about magnitude, never about order —
reorder by fixing the source data:

- a kit fact the three tiers cannot express (Skull always crits, so Crit Rate is *dead*,
  not merely low; Messa's Rending damage cannot crit at all), or
- a weight vector broader than the character's actual contribution, as above.

Every entry carries a `why`, and applying one prints to stderr, so a regeneration always
says out loud where it is not simply echoing lufel. It lives in the generator, not in
`src/data.js`, for the reason in the provenance list above — a hand edit to `src/data.js`
is reverted by the next run. `test/optimizer.test.js` checks the table against
`src/data.js` outside the page (neither file is visible from inside it) and fails with the
exact mismatch, so the two cannot silently drift.

**Do not mass-retune the roster from this.** `damageShare` versus the character's own
archetype `damageShare` is a smell test, and a weak one: it flags around ten characters,
and when all of them were checked against lufel's skill data **nine were legitimate**.
Two Guardians read 0.30-0.37 against an archetype 0.026 and look like the worst offenders
on paper — Junpei Iori and Shun Kano [Pioneer] — and both are correct: their damage scales
off max HP, so HP% is their damage stat as well as their tank stat, and both crit on a
guarantee rather than a rate, so Crit Multiplier with little or no Crit Rate is the right
shape, not an incoherent one. Four Saboteurs flagged for crit weights turned out to deal as
much damage as real AoE DPS units.

A flag is a candidate to check against the kit, never a licence to invent a number. The
method that actually settles it — a damage index built from lufel's per-character skill
coefficients, and the traps in reading them — is in `docs/SCORING.md` §10. An entry here
needs a reason someone can audit.

One known wrinkle, unfixed: `damageShare` counts a stat as "damage" by name, so an
ATK-scaling healer's ATK% weight is booked as damage even though it is bought for healing.
It is harmless as long as the same weights build the ideal (both sides of the ratio move
together), which is why Moko's 0.524 does not hurt her — but it is why a healer's share
cannot be read as "how much of her is damage".

### Main stats are a list, and which one you take changes the substats

`t.main[slot]` is a **list, best first**, not a single stat. Lufel names alternatives — Ann's
Moon is "ATK% or Damage Multiplier", most DPS Stars are either crit stat, two healers get
three choices — and 94 of the roster's 195 slot recommendations list more than one. Reading
only the head cost every card carrying another of them the `MAIN_MATCH_BONUS`, which was
enough on its own to keep genuinely correct cards out of the recommendation.

Nothing reads the field directly: `mainList(t, slot)` and `mainTop(t, slot)` normalise it,
and both accept a bare string, so archetype defaults and every target saved before this
existed still work. Later alternatives decay by `MAIN_ALT_DECAY` per rank, which is a
tie-break on lufel's printed order and nothing more.

That makes the choice between alternatives real, which is what `STAT_PRODUCTS` prices.
Damage is a **product** of separate factors: ATK total multiplies the damage multiplier,
crit rate multiplies crit multiplier. Stats in different factors of one product are
therefore complements — the deeper you are in one, the less another point of it buys and the
more its partner is worth. Take the Damage Multiplier main and you want ATK% in the
substats; take the ATK% main and you want the reverse.

`couplingFactors(t, slot, main)` returns the per-stat weight multipliers, memoised per
target in a `WeakMap`. Supply is counted in **max-roll equivalents** — points held over
points per max roll — because that is the unit `cardScore` already prices substats in and
the only unit that makes two factors comparable. Marginal value of a factor is then `1 /
supply`, so a weight is scaled by `reference / supply` with the reference the geometric mean
over the factors of the same product. Three consequences worth knowing:

- **There is no tuning constant.** The exponent is 1 because 1 is the true marginal ratio.
  `COUPLE_CLAMP` is a guard against pathological weights, not a knob.
- **It is scale-neutral.** Normalising on the geometric mean makes the factors multiply to
  1, so the coupling moves the balance inside a card score without inflating it — which is
  what keeps `bestPlan`'s plan totals comparable to each other. A test asserts this.
- **The pre-board baseline is the character's own, not a roster-wide guess.** With no real
  cards to look at, `productSupply` seeds each factor from `seedBaseline(t)` — `damageBase`
  for the character named by `t.n` (`target()` stamps it): base crit, Awakening-7 crit, the
  weapon's unconditional ladder, the Awakening ATK%. That is what makes the choice between
  lufel's alternative mains come out right: a DPS with a +30% ATK weapon and Awakening 7
  starts at 159% ATK, so with an ATK% Sky the Damage Multiplier Moon is the better
  complement and the ideal card takes it; a character whose weapon puts them at 40% crit
  wants Crit Multiplier on the Star. `STAT_PRODUCTS`' 5/150 pair is only the fallback for a
  target with no `n` (a hand-built one in a test) — and for **Elucidators**, deliberately:
  their stats are donated to allies at 20%, so the board that decides what a roll is worth
  is an ally's, and their own 0%/0% crit base says nothing about it (`seedBaseline` returns
  null when `spreadApplies` is false). Seven Buff-element support units genuinely carry
  0%/0% — confirmed via lufel's raw data and Miku's own in-game panel — and the generator
  used to read that with `l1.crit_rate || 5`, treating a legitimate 0 as missing data.
- **Reading that 0 correctly is not enough on its own — the crit factor needs a floor.**
  ⓓ is `1 + cr * (cm/100 - 1)`, which is only sane while `cm >= 100`. Feeding those seven
  their real `cm: 0` drives the bonus to -1, so every Crit Rate roll scored as an ~8%
  damage **loss** and the optimiser was being told a crit is worse than a normal hit.
  `damageFactors` now computes `1 + Math.max(0, cr) * Math.max(0, cmBonus)`. Whatever
  `cm: 0` means for these units — they may simply be unable to crit, or the panel may be
  reporting a bonus rather than a total — it cannot mean a crit deals no damage, so the
  floor declines to guess a real value rather than modelling crits as damage-reducing.
  Crit stats are worth nothing to them here, not less than nothing. A test sweeps the
  whole roster asserting Crit Rate never lowers modelled damage for anyone.

The effect is real but modest where it should be: on Ann, taking the Damage Multiplier main
moves her ATK% substats from ×1.01 to ×1.08. It is large only where the game really is
lopsided — at the innate 5% crit rate a Crit Multiplier roll genuinely is worth a fraction
of a Crit Rate roll.

Resistance Pierce is its own factor but is deliberately absent: what a point is worth
depends on the enemy's resistance, which nothing here models. Flat ATK feeds the ATK factor
but is also absent — a max roll of it is worth well under half an ATK% roll, and how much
depends on a base ATK `cardScore` is not given.

One knock-on: `idealCard` has to take the **best-scoring** of a slot's allowed mains, not
the first. It is the denominator of every build score, and a first choice that the coupling
rates below its own alternative could be beaten by a card the user owns.

### Triage's Score is a buildScore delta against the real loadout, not generic weights

`cardScore` is deliberately context-free — it prices a card against a character's *target*
weights, never against what that character actually has equipped. That is correct for the
optimiser, which is choosing a whole loadout from scratch, but it is the wrong tool for
"is this specific card worth giving to this specific character right now": a card that is
mostly Crit Rate can look like the best card in the inventory for a crit-hungry DPS by
`cardScore` alone even when that DPS's real, currently-equipped cards already carry plenty
of Crit Rate and are starved of ATK% or Damage Multiplier instead — exactly the "400% crit
multiplier, 5% crit rate" trap a per-card weight sum cannot see.

So Triage's Score is **not** `cardScore` — it is the `buildScore` delta of actually
swapping the card into its slot, given the character's real other equipped cards, real
weapon and real ascension (via `charLoadout`). Concretely, for each (card, character) pair:
`others` = that character's real equipped cards minus whatever currently sits in the
card's slot, and the marginal is `buildScore(char, others + card) − buildScore(char,
others)`. This is a strict upgrade over the old `cardScore + setFitValue`, not a parallel
metric: `buildScore`'s own `cardPart` already includes coupling, its own `sets` term
already includes `bonus2Value`/`bonus4Value` (so `setFitValue` was folded in rather than
kept as a separate add-on and was deleted), and — the new part — its `spread` term prices
the card against the character's *actual* ⓐⓑⓓ balance, not an idealised one. A card that
only piles onto an already-strong damage factor earns less spread credit than one that
fills a starved factor, even when its standalone `cardScore` is higher (a regression test
in `test/optimizer.test.js` pins the direction of this). It is a bounded correction, not an
override, for the same reason `bestPlan`'s spread term is (see `SPREAD_VALUE` above): a
large enough raw-weight gap between two single-card options can still win despite it, and
whole-loadout comparisons get the full-strength version. Being on the `buildScore` 0-100
scale, the marginal stays comparable across characters, which is what lets it double as the
"who fits best" argmax too.

The **Score** column and the keep/hold/feed verdict use that marginal, maxed over whichever
*eligible* owned character values it most, **graded against the best card of the same slot**
(`topBySlot` in `runTriage`), never the best card in the inventory, and with the card's
**main priced at its level cap and its substats as rolled** (`atMaxLevel`) — the main's
growth is certain, an upgrade's landing spot is not, and 92% of the user's cards are level 0.
The Vault uses the same rule; the optimiser does not. A Sun card's main is
always flat HP and a Space card's flat ATK+DEF, so neither can ever carry a main a damage
dealer wants; with mains priced at nine rolls, ranking them against Star and Moon cards
marked essentially every Sun card feed, which is a fact about the slot, not the card — the
same reason the Vault tab ranks within slot. A test asserts every slot has a 100% card — the user plays almost exclusively in-set, so a
card that completes a preferred set's 4-piece scores a large jump the same way `bestPlan`'s
Space pick hard-prefers a character's literal preferred set over raw score (see the
Space-card comment in `bestPlan`). The one carve-out: when **no eligible character is owned
at all** (an element-locked set with nobody of that element on the roster), the Score falls
back to the same marginal maxed over the *whole* roster instead, so a strong Fire card is
not marked feed just because you haven't pulled a Fire character yet — it might still be
for one you pull later. Off-element characters still contribute a real (if usually small)
marginal here since `bonus2Value`/`bonus4Value` already zero out the set term for them, so
the fallback is not a separate code path, just a wider pool for the same argmax.

The element gate underneath both numbers is **hard, not a ranking nudge**: characters off an
element-locked set's element are removed before either argmax, and no eligible character
means the "best fit" cell reads "— no one in scope" (and the Score falls back as above).
Ranking alone was not enough — the set bonus is worth roughly `bonus2 / 2 + bonus4 / 4` of a
4-piece, and a character with a broad weight vector can out-score that on stats. Motoha Arai
[Tropical] was the standing example: six stats weighted 8 or above, the second-largest
weight vector on the roster, and so the named "best fit" for Fire-locked Strife cards she
can never benefit from.

Performance matters here: Triage rates up to a few thousand cards against every eligible
character, so a naive per-(card, character) `buildScore` call recomputes `idealLoadout` and
re-derives `target()` from scratch every time. `runTriage()` precomputes `t`/`lo`/`idl` once
per character and passes them into `buildScore(char, cards, p4value, lo, idl, t)`, and
`breakpointRows`/`spreadRow` memoise their *ideal*-side computation per `idealCards` array
(a `WeakMap`, since a fresh array only ever comes from one `idealLoadout()` call) — the
ideal side never depends on the hypothetical cards being scored, so recomputing it on every
call was pure waste shared by every caller, not just Triage. Passing `t` through matters for
more than the obvious reason: `couplingFactors` memoises on the identity of the target
object, and `target()` hands back a fresh object every call for characters running on
generated archetype defaults, so skipping this would silently defeat that cache on every
single call. `npm run triage-perf` benchmarks the worst case (4000 cards, all 65 characters)
in a real browser — check it after touching any of this.

### Upgrades is two views of two different questions

The tab carries an in-page sub-tab strip (`#upSubtabs`, panes `#up-pane-better` and
`#up-pane-headroom`) because "what can I equip right now" and "where is this character
weakest" have different answers and one list cannot hold both. `upgradesFor` answers the
first and is bounded by what you own. `headroomRows` answers the second and is bounded by
what the game can mint, so a slot holding the best card in your inventory can still top
it — which is exactly the case the swap list cannot show, because there is nothing to
swap to.

`headroomRows(takeEquipped)` is one row per (owned character, slot), read off what is
equipped. The measure the user asked for is `cardHeadroom` — raw points to that slot's
`idealCard` — but raw scores are in one character's own weight units, so a roster-wide
list sorted on it would partly be ranking characters by how fat their yardstick is. So
each row also carries the same question through `buildScore` (`gain`: the loadout's score
with a perfect card substituted into the slot, minus its score now), which divides by the
character's own perfect loadout and therefore *is* cross-character comparable. Both
columns are shown, the table sorts on `gain`, and the blurb says which is which. Do not
make headroom the default sort.

The **Available now** column is the best card of the **same slot and the same set** in the
inventory. Same set is load-bearing: a within-set swap cannot change how many pieces of
any set are worn, so the set bonus is identical either side of it and the delta really is
the card. Proposing the best card of the slot regardless of set is the exact mistake
`upgradesFor`'s header comment describes, and the other sub-tab already runs the full plan
search that can weigh a set switch properly. The winner is *picked* on `cardScore` (cheap,
and with the set held fixed that is the right ordering) but *reported* as a `buildScore`
delta, and one that comes out flat or negative once the stat-target and spread terms have
spoken is dropped rather than printed as an upgrade.

Both gain columns subtract **`buildScore().raw`**, not `.score`. `.score` is rounded and
floored at 1 for display; a single slot is often worth only a few points, so rounding both
ends first quantises a real difference away and the floor makes a near-empty loadout's
delta wrong outright. Display `score`, measure with `raw`.

Split run/render like Triage and Vault: `runHeadroom()` does the scoring pass into
`hrRowsCache`, `renderHeadroomTable()` filters and sorts it. Only the "may take a card off
someone else" toggle changes what is in scope, so it is the one control that re-runs the
pass. Measured worst case (65 owned characters, 4000 cards, everything equipped): 301 ms
for the pass, 53 ms to redraw. Every equip/unequip path goes through `runUpgradeViews()`,
which skips the headroom pass while its sub-tab is closed — the sub-tab's own handler runs
it on the way in, so it cannot be shown stale, and nobody pays 300 ms per equip for a table
they never opened. The flag it reads is the sub-tab's, not the Upgrades tab's, so equipping
from Optimise while this is the selected view still refreshes it.

### The Vault tab is the counterweight to that gate

Once Triage refuses to name anyone, it will happily call a card junk that a future character
would want, and a fed card does not come back. `runVault()` answers the other question —
what deserves a lock in the game client — and answers it **without reference to the roster**,
so pulling a character cannot change a verdict. Two reasons:

1. `VAULT_TARGET`, a synthetic generic-damage weight vector. Support stats are 0 on purpose;
   it is spelled out rather than borrowed from `ARCHETYPES` so a balance tweak cannot
   silently redefine what "lock this" means.
2. Best fit across the eight `ARCHETYPES`, scored through `archTarget()`.

Two normalisation decisions are load-bearing, and both were arrived at by measurement:

- **Within a slot, never across slots.** A Sun card's main is always flat HP, which the
  damage yardstick weights at 0, so a single pool marks every Sun card feedable and every
  Star card a keeper — a fact about slots, not cards. A test asserts every slot present in
  the inventory produces at least one 100% card.
- **Against archetypes, not characters.** Two character-based versions were built and both
  failed. Raw best-over-65 measures roster size and is always won by the same two or three
  broad-vector characters (28% of a synthetic inventory flagged). Normalising per character
  *then* maxing over the ~59 unowned is worse: a maximum over 59 near-independent
  percentiles is an extreme-value statistic, and with a few hundred cards per slot nearly
  every card is somebody's best-in-slot — it reported 100% fit for the whole inventory.
  Eight archetypes (about five genuinely distinct) is a small enough max to be stable.

Thresholds are **percentiles**, not shares of the best card: `VAULT_LOCK = 0.98` is "top 2%
of that slot for its best role". A share-of-best cutoff sounds equivalent and is not — it
depends on how good the single best card happens to be, and at 0.80 it flagged 59% of a
synthetic inventory. Whether the roster can field the winning archetype is reported next to
the verdict, never scored into it.

### Why the set policy exists

Left to pure stat maximisation the optimiser almost always drops set bonuses, because an
unconstrained pick from a large inventory beats one restricted to a single set. That is not
how the game is played, so `policy: 'pref'` is the default and the UI reports what honouring
the set costs in raw stats. If you change scoring, re-run `npm run scale` and check the
distribution of plan kinds stays sane across all four policies.

## Data provenance — read before touching src/data.js

Sets, Space cards and the roster are derived from **lufel.net**, which the user rates above
Prydwen/Game8/Fragster — not read out of the game client. `docs/DATA-SOURCES.md` has the
full accounting. The load-bearing caveats:

1. **Regenerate, do not hand-edit.** `tools/gen-data-from-lufel.js` produces the
   `SETS` / `SPACE_SETS` / `CHARACTERS` blocks; run `tools/audit-lufel.js` first to see what
   actually differs. Hand edits to those three blocks are lost on the next regeneration
   unless they go into the generator's `SUPERSEDED` table, its `WEIGHT_OVERRIDES` table
   (substat weights — see "Lufel publishes an order, not magnitudes" below) or its
   `bonus2` carry-over. A hand-set weight of **0** is the one exception that survives on
   its own, because the tier map provably never emits one for a stat lufel ranks — but the
   generator now says so on stderr and tells you to record it in the table anyway.
2. **Main stat magnitudes are measured, not published.** No site lists them, lufel included;
   `MAIN_MAGNITUDE` comes from the user's own scan of 3947 5★ cards (every card of a stat
   shows the same value at the same level, linear in level). Other rarities have not been
   scanned and are assumed to sit on the same curve up to their level cap.
3. **Substat roll tables are verified against the client.** Prydwen's `maxRoll` figures were
   single-sourced; the same scan's level-0 cards (one roll per substat) reproduce every
   maximum exactly, for all 13 stats on both the Heavens and Space layouts, and show each
   roll has five tiers (ATK% 2.0/2.5/2.8/3.2/3.5).
4. **Six sets and three Space cards are `unreleased: true`** — lufel lists them, the game
   has not shipped them. They stay in the tables so imports resolve, but a test asserts no
   character targets one.
5. **Do not add speculative `SET_ALIASES`.** A wrong one silently corrupts the user's
   imported inventory. Every entry there has evidence behind it.

When the user supplies real screenshots, correcting this data is higher value than any
code change. Prefer fixing `src/data.js` over tuning the scoring constants.

## Conventions

- Plain ES2019 in the browser, no framework, no build step beyond concatenation.
- Every string interpolated into HTML goes through `esc()`.
- Stat and set names are normalised on entry via `normStat()` / `normSet()` — never compare
  raw user input against the canonical tables directly.
- Character entries in `CHARACTERS` are terse by design (`n` name, `a` alias, `r` rarity,
  `e` element, `arch` archetype, `sets`, `space`, `ov` overrides).
  Archetype defaults in `ARCHETYPES` supply everything `ov` does not override.
- `CHARACTERS` array order **is** the display order — the roster grid, the optimiser's
  character picker and Triage all iterate it directly, none of them re-sort. It is release
  order, taken from lufel.net's GLB/JP schedule (`/apps/schedule/data.js`) by
  `gen-data-from-lufel.js`, not `release_order` from `character_info.js`, which shares one
  value across the whole launch roster. Do not re-sort it by name.
- Add an assertion to `test/optimizer.test.js` for any invariant you rely on. The existing
  ones cover slot legality, set-plan integrity, off-element rejection, alias resolution and
  main-stat legality across the whole roster.

### Import merge: matched by confidence, and growth has to be affordable

Cards have no serial number, so `mergeImport` infers "same physical card" per fingerprint
pool (slot/set/rarity/main) in passes of falling confidence — exact rescan, then clean
level-up, then ambiguous — each pass taking the closest pair across the whole pool rather
than in arrival order. Three rules were each added after a real false match:

- **A level-up must be affordable, not merely monotonic** (`rollBudgetFits`). Upgrades
  land on a fixed cadence (`upgradesUsed`), each puts one roll on one substat or mints the
  fourth, and a roll sits inside its stat's `ROLL_TIERS` range. "Every value went up" is
  not evidence: in a pool of several hundred Sun/Power HP cards a fed Lv0 card with three
  low rolls will find some unrelated Lv25 card carrying those names higher, and the old
  rule overwrote the record with a stranger — the "recognised as an upgrade but not the
  same card" bug the user reported. The update pass needs each gain to be k whole rolls
  within k×min..k×max (tolerance of one display unit per roll, because the game keeps more
  precision than it prints — never a sum-of-printed-tiers match) with Σk ≤ upgrades
  gained; the ambiguous pass only needs the *fewest* rolls that could explain the growth
  to fit, so OCR noise still reaches a human while an impossible pair is simply new.
- **Same level means same card or a different card, never a decision.** Nothing changes
  between upgrade thresholds, so a same-level value mismatch outside OCR tolerance is
  added as new. But it is *not* proof of a second card: a same-level read one value off
  is also what a single misread digit looks like, on either scan — the Sep 2026 full scan
  read a Lv25 Moon's Speed 2 as 4.0, and the new read was the wrong one. Such pairs are
  reported side by side (`unmatchedNear`), both kept, neither removable here.
- **Unmatched existing cards are reported, and removal is opt-in.** On a scan of the whole
  inventory they are the cards fed since the last one, which no per-card verdict can say;
  the review lists them, flags equipped ones, and offers removal behind an unchecked box.
  Cards with an **exact twin the scan did read** are excluded and listed apart
  (`unmatchedTwins`): identical cards sit adjacent in the game's list and autowalk reads
  two identical adjacent panels as one. Verified Sep 2026 — the full scan had zero
  identical pairs against twenty in the save, each pair two Steam screenshots a second
  apart with the cursor moved and the panel unchanged.

Verify a merge change against real data, not just the fixtures: load the newest save
and today's scan in a headless page and compare bucket counts under the old and new rule
(the Sep 2026 full scan against the Aug 29 save: 311 new, 2 level-ups, 0 ambiguous under
both, so the fix changed nothing on that import but closes the gap for the next one).

## OCR ingestion (`ocr/`)

A Python pipeline that reads card detail panels from screenshots (or a screen recording)
and emits the save-file JSON in `docs/SCHEMA.md`. Design constraint the user agreed to:
**read pixels only, never send synthetic input into the game client** — input automation is
a ToS risk on an account worth thousands of cards.

**That constraint was lifted for one file, deliberately, by the user.** The card list is
navigated with WASD, two cards per row, which makes the walk a repeating `D S A S` cycle —
the shape of a macro. It was put to the user with the argument against it (the 4179-card
sweep is already done; what remains is ~20 keypresses per catch-up, so the saving is small
and the exposure is the whole account) and they chose it anyway. So:

- `ocr/autowalk.py` sends the keys, and reads the cards too, so it is one command that
  walks the list, OCRs it and exits. It does that by driving a `watch.Session` off its own
  frame source rather than duplicating the reader. **The dependency direction is the whole
  separation**: the file that sends input imports the pixels-only one, never the reverse,
  so `watch.py` still knows nothing about input and starts nothing. `--no-read` falls back
  to walking only, with a separately-run `watch.py` doing the reading.
- **Do not add evasion.** No randomised intervals, no humanised timing, no anti-detection
  anything. Accepting a risk is not hiding from it, and a tool built to defeat detection is
  a different tool with a different argument behind it. The docstring says so; keep it.
- Its interlocks are load-bearing, not decoration: a foreground-window guard checked before
  every key and click (so alt-tab is the stop gesture and a stray `D` cannot land in a
  browser), `--count` as a hard ceiling per tab, a `--dry-run` that prints and sends
  nothing, and a stop after `stuck_limit` consecutive keys that made no progress.
- **It tracks the cursor, and that is how it knows the list has ended.** `Walker.pos` is a
  (row, column) model moved by every key that moved the panel, and a settled frame is only
  handed to the reader when that position has not been read before on this tab. Without it
  the end of the list was invisible: the `D S A S` cycle bounces between the last two cards,
  the panel keeps changing, every bounce was re-read as a card, and only `--count` ever
  stopped the run. With it, the end is one cycle of no-ops and revisits, which trips
  `stuck_limit`. A dropped S is free — the A that follows lands on a card already read and
  is skipped as a revisit — but a dropped D is not: nothing later in the cycle ever returns
  for the card to its right. So any key that moved nothing is sent once more before it is
  believed (`retries` in the summary); that doubles the cost of each real no-op at the end of
  a list, a few seconds per tab. The one case it gets wrong is two *adjacent*
  cards that are pixel-identical (same set, level, main, substats and values): the second
  reads as "nothing moved" and the model falls a step behind until the next dropped-looking
  key resyncs it. That costs one card and is reported in the revisit count, and it was
  judged rarer than the alternative — a signature-based "seen before" check, which would
  silently skip every identical pair anywhere in the inventory, and an inventory this size
  has several. The bottom-right `ID:` on the panel was checked as a way out and is **the
  player's UID**, identical on all 60 frames sampled, not a card serial.
- **It rewinds first** (`Walker.rewind`): W until two presses move nothing, then it reads
  which column the grid's red selection frame is in (`detect_grid_cursor`, a colour check
  over the calibrated `grid` box) and presses A only from the right-hand column, re-reading
  the grid to confirm. So the position model's (0,0) is true wherever the cursor started.
  **The first version pressed A blindly and lost the first card**: on the real client a
  horizontal key at the edge of a row *wraps* to the row's other card rather than staying
  put, so an A on the left card landed on the right one and the whole walk ran a column out
  of phase (13 cards read, the first never visited — the user caught it on the very first
  live test). Never assume an edge key is a no-op; read the grid. The same read corrects the
  model after every walk key (`resyncs` in the summary): the column outright, and the row
  whenever the selection frame visibly changed rows in a way the key does not explain
  (`Walker._apply`, threshold `ROW_JUMP`). **The second and third live tests found why that
  matters**: on a tab with an odd card count, D from the last row's lone card jumps back *up*
  to a right-hand card — one row up on the Space tab, **two rows up on the Moon tab**. Keyed
  as "D changes the column", that card landed on a new model row, was read again as new, and
  the walk cycled among the last cards until alt-tab; corrected by *one* row it still looped
  on Moon. So the jump is measured in rows against the row step learned from that tab's own
  S/W moves (the grid shows 6 rows on Heavens tabs, 5 on Space — not a constant). **That
  measurement also came out one row short on the fourth live run**, so the row estimate is
  not what ends a tab. Two things are: a horizontal key that moved the cursor *up* onto a
  panel that reads like a card already read on this tab (`_seen_before`, the watcher's own
  signature) ends the tab outright — only the lone last card does that; and for one cycle
  after any grid overrule (`_uncertain`), a fresh model position whose panel matches a card
  already read is taken as that card. The signature check is deliberately confined to those
  two moments: two genuinely identical cards elsewhere in a tab are real, and the position
  model alone tells them apart. Even counts never trip any of this, which is why the first
  live test missed it.
  Vertical keys whose frame did not move are still moves (the list scrolled under a cursor on
  the visible edge); the panel changing is the evidence, not the frame. Without a `grid` box the rewind refuses
  to finish (`"lost"`) rather than guess; `--no-rewind` skips it. The card on screen is
  absorbed *before* the first W, or a fresh watcher would credit that W with a settle it did
  not cause.
- **`--tabs all` clicks through the five tabs.** A mouse click on the strip is the same
  category of input as the keys and goes through the same guard. `tab_click_points` finds
  each tab's centre from the strip's bright band per column rather than the box's middle,
  because the strip is slanted (y=173 under Space to y=200 under Sky at 1080p). The click is
  verified by `detect_slot_from_tabs` reading the new tab back before any key is sent; if the
  strip never reads it, the run stops with `"tab"` rather than typing into a screen it cannot
  identify. Rarity still cannot be read, so a full inventory is one run per rarity filter,
  not one run.
- **The click is aimed in frame pixels, so the process must be DPI-aware.** This desktop
  runs at 125% scaling (physical 1920x1080, logical 1536x864). Pillow makes only its own
  thread DPI-aware for the duration of a grab, so frames are always physical pixels, but a
  DPI-unaware process places the cursor in logical ones: the first `--tabs all` run aimed
  Star at (418, 196) and the click landed at (522, 245), just under the strip, and the strip
  kept reading Moon. `main()` now calls `_dpi_aware()` before anything (`watch.py` only did
  so for `--window`), refuses to click at all if the grabbed frame and the cursor's screen
  differ in size, and `click_at` reads the cursor back before pressing. `switch_tab` retries a
  click once, logs what the strip did read, and the frame it last saw is saved next to the
  output as `<out>-tab-<slot>.png` — "never read Star" on its own says nothing about why.
- Pacing is **closed-loop** — it waits for the panel to actually change and settle, reusing
  `watch.py`'s `PanelWatcher`, so it cannot outrun the reader. `--interval` is a floor, not
  a schedule. `Walker.prime()` absorbs the card already on screen before the first key,
  because `PanelWatcher` counts the first panel it sees as new and would otherwise credit
  the opening keypress with a settle it did not cause.
- `Walker` takes its sender, frame source and focus guard as arguments so `tests/
  test_autowalk.py` can run the whole loop without a keyboard. The ctypes `SendInput` path
  underneath is untestable here and unverified against the real client — it uses
  `KEYEVENTF_SCANCODE` because games commonly ignore a synthetic virtual-key with no scan
  code, and the failure is silent.

Everything else in `ocr/` stays pixels-only. If a future change wants input automation
anywhere outside `autowalk.py`, that is a new decision and needs asking again.

**Rarity is still per run, and here is why no detector was built.** Nothing on the panel
names it. Two cues were measured (Sep 2026): the gold of the card tile — the same on all
five tabs, so it is not a slot colour — sits at RGB (216, 183, 27) ±25 on every one of 150
Heavens frames sampled, but Space card art is colourful enough to swamp the thumbnail's
median, and more to the point **no 4★ frame has ever been captured**, so there is nothing to
validate any threshold against. The other route is the numbers: if a 4★'s level-0 main
value or roll tiers differ from the 5★ tables below, rarity falls out of the panel with no
pixels at all. One `watch.py --probe --rarity 4` on a real 4★ card settles both questions;
until then a detector would be a guess written into the inventory as fact.

### Plausibility: what the scan itself proved, checked back against every card

`ocr/plausibility.py`. `validate_card` asks whether a card is *legal*; these ask whether it
is a value the game can print. Three facts from the user's own 4200-card scan carry them:

- **Level-0 substats take exactly five values per stat** (`ROLL_TIERS` in `data.js`,
  exported to `tables.json`): across 3865 level-0 cards every stat showed those five and
  nothing else, ~200 cards per tier on Heavens, 4-14 on Space, top tier equal to `maxRoll`
  (a test in `optimizer.test.js` pins that). A level-0 value off its tiers is a misread that
  passed the range check — the one found in 11,000 values was a Speed `4.0`, a dropped-point
  class of error nothing else could see. **Levelled cards are not checked against sums of
  tiers**: a real Lv25 DEF `130` is not reachable from 27/32/37/41/46 at any roll count, so
  the game carries more precision than it prints and the rule would flag good cards
  (measured: 53 of 335 levelled cards fail even at ±0.15).
- **The main value is a function of level alone** (`MAIN_MAGNITUDE`), to within one display
  unit — the panel's rounding is not plain round-half-up (a real Lv20 HP prints 897 where the
  line gives 896.4). So level and main value are two independent reads of one fact:
  `check_main_value` flags a disagreement, and `level_from_main_value` names the level when
  the template has no match, ahead of Tesseract. On all 4200 scanned cards the inference
  reproduces the recorded level exactly. A misread main value lands nowhere near the curve
  (a dropped digit or point is a factor of ten), which is what makes this safe where reading
  the digits is not. An inferred level still goes to review — the frame is a render worth
  teaching to the templates — but with the right value filled in.
- **A card below `subMax` gains the missing substat on its first upgrade**, which
  `mergeImport` already assumes; every 3-substat card in the scan is level 0.

All of it is **notes, never repairs**, for the reason the level field taught: a
confidently wrong value reaches `cards.json`, a flagged one goes to review. Running the
checks over the 4200 cards already scanned raises exactly one note, the Speed misread.

### The level is matched, not OCR'd

`ocr/levels.py`. **Tesseract cannot read the level field and never could** — that is
measured, not a guess. The whole margin it ever had is nine pixels: two captures of the
*same* Lv.0 card, one from Steam's screenshot key and one from a live screen grab, differ
by 9px out of 6969 after thresholding, and that is enough to turn `Lv.0` into `9`. The
Aug 2026 batches read levels correctly by landing on the right side of that coin flip
consistently, not by reading them.

Everything else was tried and measured before this was built, and the negative results are
worth keeping so nobody retries them:

| Approach | Result |
|---|---|
| Threshold sweep (90-230) | no value reads both capture methods correctly |
| Upscale sweep (2-8x), binary on and off | same |
| JPEG round-trip at four qualities | no change — it is not compression |
| Vote across psm 7/8/13 at two upscales | identical to the single read, 29/120 |
| Gaussian blur to match Steam's softness | **worse**: at r=0.6 returns a *confidently wrong* level |
| Averaged, normalised template correlation | 112/120 but **7 wrong-and-trusted** |

That blur result is the one to remember: a confidently wrong value reaches `cards.json`,
where a flagged one goes to review. Optimise the wrong-and-trusted column, never the
accuracy column.

The field does not need reading, though. The UI renders a given level identically every
time, so it is a 26-way lookup:

```
two frames of the same level     0 px apart, every pair, exactly
Lv.0 vs Lv.25                  365 px apart, every pair, exactly
live grab vs Steam, same card    9 px apart
```

So `LevelTemplates` keeps one binarised render per level and matches by Hamming distance.
Against all **4025** labelled frames in the batches: **4025 correct, 0 wrong, 0 unknown.**

Three things hold it together:

- **`ACCEPT_MAX` (25) comes from the closest template pair, not from the noise.** Levels 16
  and 18 are 80px apart, so a true Lv.16 can only be *closer* to 18 if its noise exceeds
  40 — anything accepted at or below 25 cannot be confused with a neighbour whatever the
  capture does. `MARGIN` (40) must then stay under that same 80 or a clean Lv.16 gets
  refused as "too close to call". A test asserts both conditions across the shipped
  templates, so adding a template that breaks the spacing fails the build rather than
  quietly misreading a level.
- **An unknown render returns unknown.** It is never rounded into the nearest known level.
  That is the whole safety property; `parse_panel` falls back to Tesseract and then to a
  note, so the card goes to review.
- **Templates are tied to a (crop box, pixel size).** Recalibrating `level` or changing
  resolution invalidates them, so the shape is stored and a mismatch refuses rather than
  comparing nonsense.

It learns. `build_level_templates.py` bootstraps from frames whose level is already
recorded, accepting a level only when every frame claiming it agrees pixel for pixel; it
skips Steam's `thumbnails/` directory, whose 10x7 copies share the real filenames and
silently produce a 7x10 crop. After that, correcting a level in `review_cards.py` teaches
that render (`--no-learn` opts out), so a level is unreadable at most once. It refuses to
overwrite a render it already recognises, so one careless accept cannot poison a good
template.

Nine levels are currently shipped (0, 12, 14, 16, 18, 20, 22, 23, 25) — the user verified
all nine renders by eye against the panel.

### `watch.py` is the capture path; `pipeline.py` is the fallback

`watch.py` grabs the screen at ~8fps (`PIL.ImageGrab` — no ffmpeg, which is not installed
on this machine anyway) and feeds the same `parse_panel` → `validate_card` → `cards.json` +
`-review.json` path `pipeline.py` uses. It exists because a scanning session was one Steam
screenshot per card across 4000 cards, then a folder move, then a run per rarity/slot tier.

Three things about it are load-bearing rather than convenience:

- **The settle gate is a correctness fix, not a nicety.** A capture only fires once the
  panel has been unchanged for `--settle` seconds (0.25 default, `settle_frames` after
  multiplying by fps), so a card tapped past mid-transition is counted, never read
  half-drawn. It cannot make a *marquee* settle, though — see the main-label note below.
- **The main-stat label is a looping marquee and is excluded from the signature.** A name
  too long for its box ("Ailment Acc.", "Damage Multiplier") scrolls continuously for as long
  as the card is shown. Measured on the Sep 2026 Star run: between frames of the same card
  every field's hash was identical except `main_label`, which drifted 25-29 units against a
  threshold of 8. With it in the signature a card whose label scrolls is a "new panel" every
  few frames, and autowalk's end-of-list detection — which relies on a dead key producing
  *no* settled panel — never fired: the last two Star cards were read 49 times until focus
  was lost. `NON_PANEL_FIELDS` in `watch.py` now leaves it out; the value, level, set and
  substats identify the card. The label is still OCR'd, and a partial read still goes to
  review through `_unique_fragment` — it just no longer decides when a panel is new. Note
  that Crit Multiplier and Ailment Accuracy share every main value (5.7 at Lv0, 37.6 at
  Lv25), so the main value cannot settle a scrolled label on its own.
- **`panel_signature` hashes each field crop separately and sums the distances**, rather
  than taking one dhash over the whole panel. One hash over the whole panel is dominated
  by the layout, which is identical on every card, so two cards differing in a single
  substat digit can land inside any threshold loose enough to tolerate the UI's own
  shimmer. That collision is worse than a missed card, because nothing detects it: the
  second card is silently never captured. `slot_tabs` is excluded from the signature — the
  lit tab is the same on every card in a tab and would only dilute the comparison.
- **A panel that appears and changes again before settling is a card tapped past**, so it
  is counted and beeped rather than lost silently. `PanelWatcher` is pure — no grabbing, no
  clock — precisely so `tests/test_watch.py` can drive that frame by frame.

OCR runs on worker threads (`Session(workers=3)` by default). **A card is two tesseract
launches, not sixteen.** It used to be one per box — labels, values at two scales, the
Space main — and at ~0.3s per process launch a card took 10 seconds, which is what paced
the autowalk once its queue filled (the user saw it "stop on each card for five seconds").
`ocr_batch` in `panel_ocr.py` writes a card's crops to a temp dir and runs tesseract once in
list-file mode per config (labels; values), splitting the output on form feeds. Same crops,
same `--psm 7` and whitelist, so the text is the same: on 200 real frames the batched read
matched the per-crop read on every card (the two recorded discrepancies were both identical
in single mode too, i.e. old calibration, not batching). Measured: 0.32s per card
single-threaded, 0.14s wall with three threads, against 10.3s before. If the list-file run
fails or returns the wrong page count it falls back to per-crop launches, so an odd tesseract
build gets the old speed, never wrong text. `_BatchReader` plans the boxes from the slot the
tab strip gave and reads an unplanned box on its own, so a title that moves the card to the
other layout costs a launch rather than a skipped field. Tesseract's own OpenMP fan-out is
pinned to one thread per process (`OMP_THREAD_LIMIT=1`) so three readers do not oversubscribe
eight cores. Inline OCR would drop cards while it worked; `tests/test_watch.py` covers the
drain-and-write path end to end against a scripted fake screen, because that is the part
that deadlocks rather than fails.

**Values are read at three scales, not two — `_VALUE_SCALES` is `(1, 2, 4)`.** Tesseract
loses the decimal point in front of a 9 at *both* of the original scales: the dot tucks
under the 9's tail, so a real Speed `1.9` read `19` on every one of 23 Space frames in the
Sep 2026 runs and a `5.9` read `59`, each a 10x error that landed in review as out of range
(the user spotted it as "the Speed decimal is placed wrong"; only a fifth of Space Speed
rolls are 1.9 and a Heavens tier never ends in 9, so it looked Speed-specific). 4x sees the
dot. It is 4x and not 3x on measurement, not taste: every value box of the 4124 frames still
on disk was read at all four scales and each subset scored against the 1x/2x pick — 3x fixed
nine `19`s but also turned a real Lv25 DEF `55` into a hallucinated `595` that the
digit-count rule then preferred, and never resolved `5.9`; 4x changed exactly the nine and
nothing else, main values included. `pick_value_reading` takes any number of readings and
applies the same three tie-breaks (marks, then digit count among plain readings, then the
smallest scale), so a larger scale that drops a mark or reads nothing still loses. The extra
scale is the expensive one — a 4x crop is sixteen times the pixels — but the value pass is
a small share of a card: end to end `parse_panel` went from 0.65s to 0.73s per card
single-threaded on 16 real frames. Reading all four scales doubled the value pass for no
further gain, which is why it is three.

**A value that reads as one bare digit gets a second opinion in single-word mode.** Speed is
the only stat the panel ever prints as a lone glyph (a level-0 "2", or a levelled 4 or 7), and
Tesseract's single-line mode is unreliable on a lone glyph: with one blob to fix the baseline
from, a real "2" read as "4". On the Sep 2026 live-grab run *every* Speed 2 in rows 1 and 4 —
whose value boxes are ~42px tall against ~35px for rows 2 and 3 — read `("4","4","2")` across
the three scales and the smallest-scale tie-break kept the 4: 64 of that run's 84 review
entries, and one Lv25 card written out as a 4 with no flag, because only level-0 values are
checked against the roll tiers. The committed boxes did it on 5 of 16 of the same frames, so
the recalibration exposed it rather than caused it, and no single scale is trustworthy on a
lone 2 (2x and 4x each read one as 4 on other frames). `--psm 8` reads those crops as "2"
every time, but it is *much* worse on everything else (1114 values broken against 82 fixed,
over a 1274-frame stratified sample — it hallucinates leading 4s, reads 3 as 8, pads flats to
"032."), so `resolve_lone_digit` asks it only when the psm 7 pick is already a bare digit and
believes it only when it answers with a bare digit too; on a real lone 4 it reads nothing and
the original stands. One extra launch per card that has such a value, i.e. a few percent of
cards. Do not switch `_VALUE_CONFIG` to psm 8 wholesale — that was measured, and the numbers
above are why not.

Slot comes free per-frame from `detect_slot_from_tabs`, so tabs can be mixed in one run —
but only if `--slot` is *not* passed, since every card whose strip disagrees with it is
sent to review. No lit tab at all means the inventory is not up, which doubles as the
"am I on the right screen" gate. Rarity still cannot be read at all, so `--rarity` remains
per-run. Auto-detecting it by frame colour, the same way the tab strip works, is the
obvious next step and would remove the last reason to split a session into runs.

`--known` loads a save file and labels each card new or already-held, with `--expect N` and
`--stop-after K` to end the run. `KnownIndex` is a deliberately thin port of
`cardFingerprint`/`exactKey` from `logic.js` — tolerant substat matching, no assignment
problem — because the only thing riding on it is when to stop tapping. Every card read is
written out regardless; `mergeImport` in the app remains the authority on
new-vs-levelled-up-vs-duplicate, and it must stay that way.

Three flags exist because of things measured on this machine, not guesses:

- **`--probe`** grabs one settled frame and reports the resolution, the lit tab and the card
  it read. It exists because the setup failures are indistinguishable downstream:
  fullscreen-exclusive mode returns an all-black grab, a resolution mismatch shifts every
  crop, and a bad box cuts a field — all three arrive as "the OCR is wrong". It waits for
  the settle gate like a real run does; an earlier version grabbed one frame blind and could
  report a mid-animation artefact as a calibration fault, which is the most misleading thing
  it could do.
- **`--window`** grabs a window's client area instead of the whole screen. Steam's
  screenshot key captures the client area, so the crop fractions only mean the same thing
  when the game is exactly fullscreen at the calibrated resolution. Reading window geometry
  is not input automation. (On this machine the game's client area *is* the full screen, so
  it changes nothing here — it is for windowed play.)
- **`--max-pending`** (autowalk only) bounds the OCR queue. Measured on a real 20-card run,
  the capture side finished every keypress before the reader had got past card 1 — roughly
  20:1 — and each queued entry is a full-screen image, so unbounded meant ~1.2GB for 200
  cards. Blocking is correct for autowalk, which sets its own pace, and wrong for `watch.py`,
  where a stalled grab loop would skip cards without even registering them as missed.

Saved frames are named after the output file (`cards-42-00001.png`), not a bare counter.
Every session numbers from 1 into the same `_frames/`, so a shared prefix meant a later run
silently overwrote an earlier run's evidence and left its review entries pointing at another
card's screenshot. That happened once and cost three review piles.

A review pile from before a fix is **replayable, not something to rescan** — `parse_panel`
keeps the frame for every card it flags and `pipeline.py` takes a directory of images, so
`python pipeline.py _frames --rarity 5 --out redo.json` re-reads them through the current
code. That recovered a 20-card batch whose levels all read wrong before `levels.py` existed.

Every defect found in it so far has been **crop-box calibration, not OCR code**: a level
box fitted to a `Lv.0` card that clipped every `Lv.25`; label boxes that swallowed the
yellow "enhanced" bolt; value boxes fitted to one card's number that clipped the leading
digit of every wider one (a real `10.8%` imported as `0.8%`). Diagnose from the pixels —
threshold a region and read its column/row profiles across a whole batch — before touching
the parsing.

The one exception is the **scrolling main label**. A main-stat name too long for its box
is a looping marquee, so any frame of such a card holds a real but wrapped label with the
crop box perfectly correct — `Ailment Acc.` read as `ntAcc. A`, `cc. Ailme` and `G Ailmen`
(batch_3 and the Sep 2026 Star run; it was first taken for a settle-in animation, but the
frames show the text wrapping end-to-start). Scrambled or wrapped text means the marquee;
text cut off at a box edge means calibration. No capture timing fixes it — the label never
holds still — so `norm_stat`'s `_unique_fragment` recovers it when the surviving run of
characters belongs to exactly one of the slot's legal mains, and always leaves a note so the
card still lands in the review file. It is deliberately conservative: measured over a whole batch's labels
plus 216 junk strings, requiring a 5-character unique run fired on 1 of 648 junk trials,
where any ratio-based rule loose enough to catch `ntAcc. A` fired on ~95.

**There are two panel layouts.** A Space card shows *two* main stat rows (flat ATK, then
flat DEF), which pushes its four substats down one row, so it has its own region boxes
(`space_*` in `config/crop_regions.json`, calibrated with `calibrate.py --layout space`).
Read on the Heavens rows, a Space card files its second main as substat 1 and loses substat
4 off the bottom. Its Set Effect box also names *two* sets — its own and the Heavens set it
combines with, e.g. `Acceptance & Strife` — and `vocab.norm_set` splits that, preferring
the one in `SPACE_SETS`.
