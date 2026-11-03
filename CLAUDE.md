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
npm run triage-perf  # 4000-card x 68-character Triage timing, in a real browser
npm run shots        # writes docs/shot-*.png for visual review, laptop and phone width;
                     # `npm run shots -- path/to/save.json` shoots a real save instead
npm run export-tables # build, then write dist/tables.json — the slot/set/substat/alias/
                       # character vocabulary the OCR pipeline should read instead of
                       # hand-copying src/data.js
npm run site         # build, then write site/ — the phone app (PWA) for GitHub Pages:
                     # index.html + manifest, icons, offline service worker; README
                     # "On your phone". `-- --with-art` adds dist/art/ — portraits and Persona
                     # pictures (public!) — and the build lists the files changed since the last one
```

`site/` is the only place a manifest or service worker goes. `tools/build-site.js` injects
them into a copy of the built page, so `dist/p5x-planner.html` stays a file:// / artifact
page with neither (a manifest fetch from file:// is a console error, and the tests fail on
those).

Game data is re-derived from lufel.net rather than hand-edited (see
`docs/DATA-SOURCES.md`):

```
node tools/fetch-lufel-data.js lufel.json    # download lufel's raw /data/ files
node tools/audit-lufel.js lufel.json         # diff against src/data.js, reports only
node tools/gen-data-from-lufel.js lufel.json # emit replacement SETS/SPACE_SETS/CHARACTERS
node tools/gen-awareness.js lufel.json       # patch CHAR_STATS[*].awareness into src/data.js in place
node tools/gen-teams.js lufel.json           # replace the TEAMS block (lufel's parties, partners, rotations)
node tools/gen-bosses.js [boss.js]           # replace the BOSSES block (lufel's calc/boss.js: DEF, coefficient, resistances)
node tools/gen-wonder-innate.js [folder]     # replace the WONDER_INNATE block (each Persona's innate skills,
                                             # WONDER_UNRELEASED: Personas not out on Global yet, and
                                             # WONDER_PERSONA: rarity, talent ranks, learn levels, rank values)
node tools/gen-skill-damage.js lufel.json    # replace the SKILL_DMG block (damage per skill and Highlight)
node tools/fetch-persona-art.js              # the Personas tab's pictures into dist/art/ (gitignored, like the portraits)
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
| `src/data.js` | Game data only, no behaviour. Slots, substat roll tables, 34 sets, 19 Space cards, 8 archetypes, 68 characters in release order. |
| `src/ui.html` | All markup and CSS. No `<script>` tags. |
| `src/logic.js` | State, scoring engine, optimiser, rendering, event wiring. |

### Hard constraint: no browser storage

`localStorage` and `sessionStorage` are **not available** — this ships as a Cowork
artifact where those APIs fail. Persistence is explicit JSON download/upload only
(`save()` / `load()` in `logic.js`). Do not add browser storage; it will silently break
the artifact build.

The one sanctioned exception is the **GitHub sync** (Data tab, Oct 2026): the save can live in
a private GitHub repository through the contents API, and the header's Load/Save use it once
connected (`syncLoad`/`syncSave`; the Data tab's buttons stay file-based). Only its connection —
repository, file name, access token — goes in `localStorage`, only when "Remember on this device"
is ticked, and every access is in try/catch, so the artifact just forgets it. The inventory itself
is never stored in the browser. A write names the version it replaces (`syncSha`); GitHub refuses
a stale one (409, or 422 naming the sha) and the user is asked before overwriting another
device's save. Connect refuses a public repository. Tests run it against a fake API (section 10).

Because the save file is the only persistence, the page guards it without storage: the header
says "Unsaved changes" and turns Save red whenever the state differs from the last load or save
(`isDirty`), the page asks before it is closed on unsaved work (`beforeunload`), and loading over
unsaved work asks first. A dropped file loads too: a save (it carries `characters`) replaces
everything, a scan's card list goes to the import review.

### The page's plumbing: `commit()`, fingerprints, undo

Added in the Sep 2026 UI pass; each piece closes a defect found on the real inventory.

- **Every change to state goes through `commit()`** — cards, equips, locks, ownership and
  benching, targets, setups, the team crit rate, imports. It redraws Inventory, Roster and the
  Optimise picker, runs Optimise and Upgrades if they are on screen (both defer while hidden —
  `optStale`, `upViewsStale` — and `showTab` runs them on the way in), marks Triage/Vault runs
  stale and updates the save indicator. Before it, each action redrew its own pick of views:
  Inventory's ✕ redrew only Inventory, a target reset never re-ran Optimise, "Mark these as
  equipped" left the Roster's chip stale. A new mutation path must call it.
- **"Changed" is a fingerprint comparison, not a counter.** `dataSignature()` hashes the cards,
  ownership, targets, setups and team crit (about 2 ms over 4000 cards). The save indicator
  compares it with `savedSig`. A Triage run stores `triageSig()` and the Vault `vaultSig()`, and
  `markStaleRuns` shows a "Scored before your latest changes" banner with Re-run when they differ.
  Until Sep 2026 only the team crit rate was checked, so a Triage run kept its verdicts after an
  import without a word, on the one screen whose "feed" cannot be undone. Because it compares
  content, an undo or a value set back reads as current again. **Each run's fingerprint holds what
  that run reads and nothing else**, or the banner cries wolf: Triage hashes every card with its
  wearer and lock, ownership, the targets and setups of the characters it rated and of anyone
  wearing a card (Upgrades' trade pricing reads the giver's), the team crit rate and its controls;
  the Vault hashes only the cards' contents (`cardsSig(false)`: not who wears them, not locks),
  ownership (for "unfielded"), team crit and its floor. Hashing wearers had the Vault flagged
  stale after every equip.
- **Undo is one level, in memory, offered in a toast for 15 s** (and Ctrl+Z outside a text field)
  by the actions that are easy to regret: deleting a card, un-owning or benching, resetting a
  target, taking a card off someone else (`swapCard`), "Equip all", "Mark these as equipped", an
  import, "Clear everything". `snapshotState()` is the card list and characters as JSON; `undo()`
  restores into the surviving card objects, so anything holding one still points at the live card.
  **An undo expires at the next `commit()`** — it restores a whole snapshot, so taken after a later
  edit it would silently revert that too — and each undoable action commits, then offers its own.
  A modal dialog sits in the browser's top layer, so an undo offered from inside `#dlg` (the
  Loadout popup, its card picker) lives in it and Undo redraws that popup; a dialog opened later
  takes in a plain message but never a pending undo, which would close it and lose an edit.
- **Questions are asked in the toast, not with `confirm()`** (`askToast`): a sandboxed artifact
  frame without `allow-modals` answers `confirm()` with an instant false, which would make Load
  over unsaved work, a dropped save and "Clear everything" silently do nothing. The toast's button
  is a real click, so it may open the file picker itself.
- **First visit runs, later edits only mark stale.** Triage, its Vault view, Upgrades and
  Optimise run on their first visit of a session (an empty tab behind a Run button was a click
  every session); after that Triage and the Vault are never re-run on their own.
- **Bind a container's buttons with a selector scoped to that container.** `renderInv` and
  `renderRoster` both used page-wide `[data-edit]`, and `renderInv` a page-wide `.sortH`, so
  whichever drew last won: after a load (which ends on the Roster) Inventory's Edit called
  `editTargets` with a card id and threw, the Roster's Targets buttons went dead after any
  Inventory redraw, and a Triage header click re-sorted the Inventory. A test clicks each.

- **Optimise holds only a character it was sent to.** `optForced` is the roster click-through's
  character, kept selected through every redraw even when not owned; a pick from the list clears
  it, and so does a load. Forcing whatever happened to be selected kept an unowned default over
  the first character marked owned, and a benched character selected as "not owned".

The UI rules that go with it: answers before explanations (Optimise shows the recommended
loadout first, the Loadout popup the five cards first, with Setup and stats in collapsible
sections whose open state is remembered per character through the card picker and the card
editor — `loSections` — and whose Setup the two Setup links open outright); **a card reads one
Score on every screen** — context-free `cardScore`, the build score's own card part — and every
screen that proposes a single swap (the card picker's Build column and default order, Weakest
slots' "Available now", each Optimise card's "equip only this", Optimise's "vs pick" column)
chooses and reports it as a build-score delta, never on the Score (see "One card price" below);
how-to-read prose is folded with `explainHtml(gist, body)`, never deleted; a substat
is printed with its unit through `subVal`/`subsInlineHtml` (coloured by the character's coupled
weights when one is in view) and a card block through `cardBlockHtml`; sortable headers come
from `sortThHtml` (a real button, `aria-sort`); `.field` labels are tied to their controls by
`linkLabels` (page once, each dialog in `showDlg`). The Vault is Triage's second view ("Lock for
later"); `showTab('vault')` still lands there. The Setup is edited only in the Loadout popup; the
Targets dialog links to it.

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
  the best main for anyone, and handed HP Recovery Moons to damage dealers. Healing from a
  2-piece (Love's +9%) is priced by the same rule on the main's own scale (`healingRolls`,
  nine rolls to a max-level 22.6% main). Until Sep 2026 it was a flat 1.5 × the HP% weight
  whatever the amount, a sixth to a third of the same healing on a main, which made Worry's
  SP Recovery 2-piece beat Love for Lufel, whose own set it is.
- `bonus2Value(set, char, target)` — a 2-piece "+12% ATK" is worth however many maximum
  ATK% rolls that is, times that stat's weight. Returns 0 for off-element sets.
- `bonus4Value(set, char, target, base)` — `base` defaults to 55 and is user-adjustable in
  the UI. Preferred set gets `base`, secondary `base * 0.72`, anything else `base * 0.22`.
- `bestPlan(char, pool, opts)` — enumerates 4-piece, 2+2, 2-piece-plus-free and no-set
  plans, dedupes identical loadouts, then filters by `opts.policy`
  (`pref` | `force4` | `any4` | `stats`) and returns the winner plus alternatives.
- `buildScore(char, cards, p4value)` — 1-100 for how well a character is geared, or `null`
  if nothing is equipped. See below.
- `damageFactors(cards, char, t, lo)` — lufel's ⓐ ATK, ⓑ damage bonus, ⓒ defence and ⓓ crit for a
  whole loadout, and their product. The one place that knows those multiply rather than add, which
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
4000-card synthetic account lands **around 70** (mean 69.6, median 71, range 42-84, across
the 68-character roster as of 25 Sep 2026; the pool is drawn over `Object.keys(SETS)`, so
the lufel refresh that day, which added two sets and renamed four, redrew it — on the
pool before it the same data reads 70.3, 70, 51-84, and `docs/SCORING.md` §9 says how to
make that comparison. Ranking the optimiser's shortlist on the build score's own card price
and polishing near-winning plans (28 Sep 2026) put 0.1 on the mean and 2 on the bottom of the
range; the bands did not move. Before the refresh: starting Ailment Accuracy at its real 0% took
0.2 off the mean and the top of the range from 86, whose owner had been met-for-free,
making plan totals the build score's own numerator put 0.5 back, since the optimiser now
picks what the score rates best, and holding lufel's set order and opening lufel's "-" slots
took 0.3 off again, by raising a few perfect builds; pricing Love's healing like the healing
main put 0.1 back, and scoring stat targets from the no-card total took 0.3 off), and
80+ is genuinely excellent. Nothing clamps at 100. `BUILD_BANDS` is cut at 80/60/40; it was
75/55/35 while a main stat was priced at three rolls, and pricing mains at their measured
magnitude lifted every score by about five points without changing the shape of the
distribution (6/54/5 excellent/good/workable after, 7/54/4 before). Making the ideal card
legal (Sep 2026 — its substats used to duplicate its own main, see below) lifted the mean
by 0.4 and moved the bands to 11/49/5; the median did not move, so the bands were left
alone (7/53/8 on today's 68 and pool, 10/53/5 on the pool before). Reading each kit's own damage off its
Teams fight and modelling ⓒ (Nov 2026, below) took the mean from 69.5 to 70.1 (the kit numbers 0.5, ⓒ 0.1),
the range to 41-84 and the bands to 8/52/8; the median stayed 71. If a scoring change moves these, either the change is wrong or `BUILD_BANDS` needs
re-cutting — check before shipping. The same block prints how many Moon/Star/Sky picks carry
a main lufel does not recommend (32 of 204 on today's synthetic pool as of 3 Nov 2026, 31 earlier, 33 before the 28 Sep polish, and 26 on the one before
it, down from 71 of 195 at three rolls a main; an open slot never counts, since any main is on
target there): a rise there on an unchanged pool means the optimiser is trading the main away
for substats again.

### Spread matters, because damage is a product

A weighted sum treats stats as substitutes: nine Crit Multiplier rolls are worth nine rolls
whatever else the build holds. The game does not work that way. Lufel publishes the damage
formula (`lufel.net/article/damage-calc`, recorded in `docs/DATA-SOURCES.md`), and the three
factors the cards move **multiply**:

```
ⓐ (character ATK + weapon ATK) × ATK% + flat ATK
ⓑ 100% + Damage Mult + elemental damage bonus + increased damage taken
ⓒ 1 − E / (E + 1400), E = enemy DEF × max(0, (1 + coefficient) × (1 − Pierce) − DEF down)
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
Resistance Pierce since ⓒ is modelled (Nov 2026); until then it did not, since a term must not
claim credit for a factor it leaves out. Nor does it count a stat in **`BUFF_SOURCE_STATS`** — one a
kit turns into an ally buff, for a character whose own damage is a side line. That stat is
left out of the coupling too, because what it is worth is the buff (linear up to the cap
lufel's target records), not what it adds to the character's own damage product. Only
Beachflower Minami is listed: her crit multiplier and max HP drive Gentle Sea Breeze, Summer
Garden and Bewitching Blossoms, and coupled as her own damage at a 5% crit rate a Crit
Multiplier roll priced at 0.63, so lufel's Crit Multiplier Star lost to an HP% one. Most
buffers' ATK% feeds a buff and their own damage alike; booking it as damage is harmless
while the same weights build the ideal (a known gap, `docs/SCORING.md`), so they are not
listed.

**Which stat sits in ⓐ is per character.** `DAMAGE_SCALE` names the eight kits whose skill
text writes every damage line as a fraction of DEF (Yusuke, Ashiya) or max HP (Junpei, both
Shuns, Kiyoshi Kurotani, Summer Ichigo, Beachflower Minami); for them `scaleStat()` puts DEF/HP and DEF%/HP% where ATK/ATK% sit
for everyone else — in `damageBase`, `damageFactors`, `modelledStats()` (so `damageShare`
books HP% as damage for Junpei, which is why he reads 0.4 and it is correct) and the first
coupling product. Yukimi Fujikawa is deliberately not listed: her DEF feeds shields, never a
damage line. Tropical Motoha is not either: her damage is ATK-scaled and HP is *converted*
into ATK by a passive, which her HP% weight already captures. Those eight also have ATK% at 0
in `WEIGHT_OVERRIDES` — the generator caps an unlisted stat at 4, and 4 is a third of a real
weight for a stat their kits never read.

**`CONVERSIONS`** are the always-on stat conversions — Runa's ATK is +60% of her Ailment
Accuracy, Yaoling's +1% per 2 Speed, Tempest Riko's crit damage +84% at 450% SP Recovery, Kumi
and Tropical Motoha's flat ATK from Speed and HP. The weights already put the source stat
first (that is why lufel lists it first), but the damage model did not see the conversion, so
ATK% was over-credited against the source stat for all of them: on Runa's perfect build the
conversion is +119% ATK (R1, no Mindscape; it read +166% while Ailment Accuracy was wrongly
started at 100% — see below). `conversionBonus()` reads the in-battle source total, cards included,
and feeds ⓐⓑⓓ, both coupling baselines and `damageShare`. Party-buff conversions (Miku,
Manaka, Fuuka, Yumi, Kayo, Haruna, Leo) are not the character's own damage and are not
listed. Lufel's target notes (`battle_plus_stats`) do the same arithmetic — Tempest Riko's
"패시브(활기): 84%" is her Sun-kissed Blooms — which is also the confirmation that kit lines
belong in the totals the stat targets are scored against.

**`CRIT_PROFILE`** is for kits where some or all damage always crits (the share that cannot crit
at all is measured, `kitMix` below; Kumi's was a hand-entered `nocrit: 0.45` until Nov 2026): `locked` is that share,
ⓓ is a mixture of the locked share at 100% (at its `cmClamp`ed crit damage where the kit
clamps it) and the rolled rest, and `lockedCritSupply` feeds the same split into the
coupling so Crit Rate is priced for the rolled share only. Ryuji and Pioneer Shun are
`locked: 1`; Skull's Crit Rate weight is already 0 for this reason, and without this the
spread term valued a Crit Multiplier roll on him at his 5% base rate. Akihiko is `locked:
0.3`: his Theurgy and Finishing Blow always crit (crit damage clamped 250-350%, 300-400% at
Awareness 4) but Lightning Fist, Blitzkrieg and Spark Impact roll, and by his own
coefficients the guaranteed part is 26-29% of his damage. A single guaranteed skill with no
stated share (Junpei's Power Swing, Mayumi's extra action) does not earn an entry. Everyone's
rolled crit rate is capped at 100%. The third shape, `extraCr`, is a share that crits at a
*higher* rate: Wavecatcher Miyu's Mermaid Dreamer adds 16.4-31.4% crit rate to her Resonance
only, which her kit's coefficients put at about half her damage at Awareness 0. ⓓ mixes the
two rates, and the coupling reads her Crit Rate supply `share × extra` higher (a Crit
Multiplier point is then worth `cr + share × extra`), gated on the weapon being held.

**The team crit rate** (the header's scoring-settings popover — it sat in the Roster's filter
bar until Sep 2026 though every tab reads it — `state.teamCrit`, saved as `settings.teamCritRate`) is
the crit rate the user's usual supports add, in points, one number for the roster. Every
crit rate above is the character's own, but a real team adds more: an Elucidator's 20%
share, and a crit-rate buffer such as Summer Ichigo (+14.6%), Starlight Ren (+15.6%) or
Beachflower Minami (+15.6% on one ally). Lufel's crit advice assumes one: 35 of the 62 who
weight both crit stats put Crit Multiplier first on the Star, which only pays once crit rate
is covered. At 0 the engine reads crit rate as scarce for everyone. It then takes a Crit Rate
Star for 18 of the 32 whose lufel list has both, and splits about 15 of the real inventory's
4-pieces for Triumph's +7.5% crit-rate 2-piece.

`teamCritFor(char)` adds it where the damage model reads a crit rate: `damageBase` (so ⓓ
and both coupling baselines), the generic board the Vault's archetype targets are priced
on (`genericSupply`), and the 100% cap (`heldCritRate`). It is 0 for an Elucidator, whose
stats are donated and who is not coupled. It **never enters `totalStat`**, so on-screen
totals and stat targets stay what the character has alone. Lufel's own crit-rate targets do
the same: Starlight Morgana's 50% counts the Elucidator share and My Palace, not another
party member's buff. Three memos read it and check it (`damageBase`'s key, `targetMemo`,
`prefSetLift`). Triage and the Vault keep their last run and mark it stale
(`markStaleRuns`) rather than re-run a several-second sweep on each edit — on any change the
run read, not only this one (see "The page's plumbing" above).

**The team buffs** (Nov 2026, the same popover, `state.teamBuffs`, saved as `settings.teamBuffs`)
are the rest of what those supports add, the same way: ATK %, damage %, crit multiplier % and
enemy DEF down %, in points. `teamBuffsFor(char)` puts them with the crit rate into
`damageBase` (ATK only for an ATK kit, nothing for an Elucidator), and `genericSupply` on the
Vault's board; never into `totalStat`. Every memo and fingerprint that read the crit rate reads
`teamSig()` (all five), and `damageBase` keys on `teamKey()`, rebuilt only when
`state.teamCrit` or the `state.teamBuffs` object changes (every write assigns a fresh object) —
building the key per call cost Triage's benchmark a fifth of its time. All 0 by default, so
nothing moves until the user sets them. With a typical team (15 / +80 / +30 / +30) 6 of the 33
Optimise picks on the real save change.

**What a kit does to its own damage is read off its Teams fight** (`kitMix`, Nov 2026; the user
asked which of the Teams calculations could make build scores more accurate). The damage model
priced every hit as able to crit and the character's damage as their stats alone. But a
Highlight cannot crit unless its text says so (`tcHlCrits`: a Theurgy, SKILL_DMG `hlCrit`, or
`TC_HL_CRIT_AW` — Kumi's A6), damage over time never does, and a kit adds into the same factors
the cards fill (DPS_KIT_BONUS, timed KIT_STAT_BUFFS, its own TEAM_BUFFS lines), so a Damage
Multiplier roll is worth less beside a kit's own +60% damage. `kitMix(char, lo)` plays the
character's fight alone once per Setup — the reference fight: lufel's rotation as written, blank
teammates, no Wonder, at the page's defaults whatever its controls say (`tcKitRun` makes
tcFight/tcBossNow/tcWeakMode/tcFoes/tcDownPts/tmFitOn read their defaults), with **no cards**
(state swapped out and restored, a private `tcMemoNew` memo), so one number serves every
loadout the optimiser tries. The fight books each hit when `P.track` is set (spread() notes it,
gain() books it): damage before the crit factor, whether it could crit, what was added into each
factor. `kitMix` returns `nc` (share of pre-crit damage that cannot crit) and `x` (damage-weighted
mean ATK%, flat ATK, damage, crit rate and crit multiplier over critting hits, Pierce, DEF down).
`damageBase` reads the base **without** the kit's timed lines (`noTimed`) and adds `x`, so a
timed line counts at its rotation's uptime, not every turn; `damageFactors` deals `nc` at 1×.
**The fight's own evaluation is `lo.bare`** (`tcEvalFor`): no kit numbers, no team buffs, no ⓒ in
`damageFactors`, since the fight plays the kit and prices the team and ⓒ itself — keep every fight
call on a bare setup or it counts them twice. `kitMixReady` (set just before the page's first
render) keeps it from running while the file is still loading; `damageBase` does not remember a
result taken while the kit could not be measured. Null, the model as before, for an Elucidator, a
kit with no SKILL_DMG and one with no damage of its own (four support Highlights deal none: YUI,
Ayaka, Mayumi, Beachflower Minami read 0% for that reason). All 68 fights take about 70 ms. On the
real save: `nc` 25-31% for most, 40-53% for Yaoling, Shun Kano, Kiyoshi, Kumi, Wavecatcher Miyu;
kit damage bonuses +4% (Firecracker Yaoling) to +113% (J&C); Mitsuru takes 88% of the foe's DEF
on average. 3 of 33 Optimise picks changed (Yaoling, Mayumi's Space card, Mitsuru), build scores
moved −1.3 to +2.7. A test holds it independent of worn cards and of the Teams controls.

**ⓒ, the foe's defence, is in the build model** (`buildDefence`, Nov 2026): lufel's formula against
the boss the Teams page's Auto picks for the character (`buildBoss`: area example DEF 821 for an
AoE DPS, single boss DEF 1280 otherwise), Pierce from the character, the kit and the cards, DEF
down from the kit and the team buffs. Because the formula subtracts DEF down after Pierce scales
the DEF, DEF already taken off makes each Pierce point worth more, not less (a test pins the
direction). The Damage factors panel (Optimise, Loadout popup) shows ⓒ and one line each for what
the kit and the team buffs contribute.

Measured on the default setups: at 10 the perfect Star follows lufel's first choice for
20 of 32 (13 at 0); at 20, 24 of 32, and perfect is a ceiling for everyone, Wavecatcher
Miyu included (a test pins that). From 30 up, Summer Ichigo's HP% Star falls 0.2-0.7%
behind a Crit Multiplier one. Her kit line already counts her own party crit buff, so a
high setting counts it twice for her.

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

- **One card price, and a polish instead of a second yardstick (Sep 2026).** A plan takes
  each set's top card per slot by `cardScore`, which cannot see the stat targets or the damage
  balance across the five cards; the build score can. So `bestPlan` polishes: every plan the
  policy allows within `POLISH_WINDOW` (2) build points of the allowed leader tries each slot's
  next `POLISH_DEPTH` (8) same-set cards, **its Space card included**, keeping any swap that
  raises the build score, and the plans are then re-ranked and de-duplicated. A test holds that
  no single same-set swap in reach beats the pick. Until Sep 2026 the shortlist was ranked
  against the plan's other cards instead (`realCoupleContext`, iterated up to five times until
  its anchor stopped moving), with a smaller pass over the winner only (4 deep, Heavens only).
  That was a second yardstick the build score never used, so the Loadout popup, the card picker
  and Optimise showed a card one number while Weakest slots showed another, and the table under
  Kotone Shiomi's recommendation put a card the pick had beaten first (her worn ATK% Star 72,
  the picked Crit Rate one 67, 0.1 higher built). It was removed — `realCoupleContext` and the
  `real` parameter of `cardScore`/`couplingFactors` are gone — after measuring both on the real
  inventory (37 characters × `pref`/`force4` × both pools) and the scale.js account (68 × three
  policies): never worse on the real inventory, 17 characters better by up to 2.6 points, mean
  +0.005 to +0.22 per scenario; one loss on the synthetic account (Runa, `stats`, −0.23). The
  window is measured on the *allowed* leader — taken on the overall one, a `force4` run whose
  4-pieces all sat 2 points under a 2+2 polished none of them (Haru, Aran). Polishing every
  plan gives the same pick in every scenario at 15-20× the cost; the winner-only pass missed
  Space cards (Starlight Ren) and plans that win only once polished (Tropical Motoha's Virtue
  4-piece). Faster, too: 0.7-1.1 s a roster against 1.1-1.7 s, the iteration having gone with
  the anchor. An older experiment still stands: brute-forcing every combination of each slot's
  top six found at most 1 point beyond single swaps, so one pass is enough.
- **`damageBase()` is memoised per character and setup.** It is pure `CHAR_STATS` arithmetic
  and the optimiser evaluates thousands of loadouts per character; `supplyOf()` likewise
  exists so a loadout is walked once for several stats rather than once per stat. Skipping
  either put `npm run scale` an order of magnitude slower.

**A plan's total is the build score's own numerator.** `bestPlan` prices every plan with
`buildScoreOf(char, cards, P4, lo, idl, t).total` over the five cards it would put on — the
four Heavens picks plus the Space card its rule gives that plan (`spaceChoice`: pairing with
the plan's actual 4-piece, then the character's own Space set under `pref`/`force4`) —
against the same `idealLoadout`. The denominator is fixed per character, so ranking plans by
that numerator is ranking them by the build score they would earn, and at the default 4-piece
value of 55 the two are the same number (a test asserts it, and that no allowed alternative
builds higher than the pick). Before Sep 2026 the optimiser had its own look-alike terms: the
stat target as the four Heavens cards' substats and 2-piece bonuses against a perfect
four-card set — blind to the base stats, weapon and mains that are most of the real
in-battle total — the spread against a four-card ideal, and the Space card chosen only after
the plan was fixed. On the real inventory that read Justine & Caroline's Damage Multiplier
target at 29% while it was met in battle, kept buying Speed and Ailment Accuracy past met
bars, and picked plans the build score rated 1.7-3.2 points below one it had considered
(Yukari, Beachflower Minami, Shun Kano, Runa). Identical loadouts are collapsed *before*
pricing now, which paid for the costlier evaluation (`npm run scale` within a few percent).

`bestPlan` returns that evaluator as `r.loadoutTotal`, closed over the call's `t`/`lo`/`idl`/
`P4`, so anything that wants to compare an arbitrary loadout against what `bestPlan` itself
would score calls it instead of re-deriving the rule. `upgradesFor()` is the other caller:
it once gated its "is this swap worth it" delta on `scoreLoadout` alone while `bestPlan`
picked *with* the stat-target and spread terms; every number it shows now goes through
`r.loadoutTotal`, with whatever a row does not change — the worn Space card included — left
as it is.

**A row's Gain and its plan's total are two different numbers, and conflating them was a
bug.** `upgradesFor` only ever proposes a whole 4-piece, so one suggestion is usually
several rows; every one of them carried the whole plan's delta, which read as three
separate +28s when there was one +28 on the table (the user spotted it on the Upgrades
tab). Each row's `delta` is now the marginal of equipping *that* card with the character's
other slots left as they are — exactly what the Equip button beside it does, also through
`r.loadoutTotal` — and the plan total moves to `group`, set on every row of the block so
the UI can foot it once with an "Equip all" (`swapCards`, one re-render rather than one per
card). They do not sum, and a single row is often negative while the group is strongly
positive: most of a set switch is the 4-piece bonus, which lands only when the fourth card
goes on. `upGain()` orders a character's rows, so a 30-point set switch made of four small
marginals does not sort below a single 8-point swap. **Characters are ordered, and the Gain
column is shown, in build points** (`upPts`: the raw gain × 100 ÷ the character's perfect
total, i.e. exactly the build score the swap adds). A raw gain is in the character's own
units: one raw point is 0.104 build points for Tropical Motoha and 0.162 for Kiyoshi on the
real inventory. So ranking on it (until Sep 2026) put whoever has the biggest yardstick
first. With every card and set allowed it ranked Miku and Yumi above Yaoling, whose
upgrade is the largest in build points. The listing gate is in build points too
(`UPGRADE_MIN_GAIN`, 0.1, the column's precision); as one raw point it let the same swap
through for one character and not another. The Space row is priced the same way — the whole loadout with that one
card swapped in, the Heavens as they will be once the rows above are equipped — so its Gain
counts what the card's substats do for the stat targets and spread and sits on the same
scale as the Heavens rows. (It used to be `cardScore` + `SPACE_PAIR_VALUE`, comparable only to
other Space candidates, because the evaluator priced four Heavens cards and knew nothing
about the Space slot.) Its candidate is still chosen by the pairing/pref rule.

**A trade is priced on both sides.** With "Ignore cards equipped on someone else" unticked,
a proposed card may be worn by another character, and every gain above counts only the
receiver: on the real inventory 39 of the 62 rows that took a card off someone cost the giver
more than the receiver gained. `giverLoss` prices the giver's side — their build points with
the taken cards replaced by their best free card of each slot (same set first), against their
keeping the better of the worn card and that free one, so a free upgrade they could make
anyway is never credited to the trade and a loss is never negative. Each trade row carries
`giverPts`, each move `lossPts` (a 4-piece switch prices everything it takes, from everyone,
jointly), and `upPts` nets it off, which is what orders characters. The "on X" tag shows X's
loss and the footer or row shows the net. Nothing is hidden, because the user may value one
character above another; but the box is ticked by default now, which is what the user had
chosen, and then no trade is proposed at all. The Optimise tab's Card pool defaults to "Only unequipped cards" (the user's choice, Oct 2026; it was "All cards" until then, and the control is not saved in prefs, so the HTML default is what every session opens on); on "All cards" it prices its trades the same way: every "on X" tag carries X's loss (`onTagHtml`), and the recommendation's headline states what the loadout takes, from whom, and the net — as a warning when the net is negative, with a one-click "Show a loadout that takes nothing". On the real inventory Kumi's recommendation read "+3" in green while netting −25.1 for the account; the net used to be small print under it.

**The Optimise tab shows plan totals on the build score's 0-100 scale** (`100 × total ÷ idealTotal`,
both at the tab's 4-piece value), in "Other set plans considered" and the "ignoring set bonuses"
line. At the default 55 that is exactly the build score each plan would earn. They used to be
raw (643.6, "598.5 / −45.2") beside the /100 score, a second scale for the same thing.

Absolute in-battle numbers remain `totalStat()`'s job, not this one — `damageFactors`
counts each main at its `MAIN_MAGNITUDE` value for the card's level, the same figure
`cardScore` prices it at, identically on both sides of every ratio. That includes the two
**fixed** mains, as flat stat added after the percentage: a Space card's ATK + DEF for ATK
and DEF kits, a Sun card's HP for the HP kits. Until Sep 2026 `damagePoints` skipped both
as "cancelling" — but a flat term on both sides of a ratio does not cancel, and a Lv0 card
does not match a Lv25 one; for the seven DEF/HP kits it was 5-7% of a perfect ⓐ. `cardScore`
still prices neither, since every card of the slot carries the same main.

### Stat targets, and what they can and cannot check

39 of the 68 characters carry `ov.targets` — lufel's "recommended stats", the hard numbers
some units need (180 Speed for Rin, 171% Ailment Accuracy for Howler, 4600 ATK for Oracle).
Weights alone cannot express these: weights make stats fungible, a threshold does not.

**The published number is an in-battle total**, so the cards are only ever part of it.
`CHAR_STATS` carries the rest from lufel — base stats by level and ascension, the
Awakening-7 bonus, Mindscape nodes, and both weapons with their 7-step refinement ladders —
and `characters[].loadout` says which of it applies. This is not a detail: Kumi Katayama's
180 Speed is 73 Speed from cards on a 4★ weapon at A0 with no Mindscape, and 14 on a 5★ R7
at A7 with it. A character whose Setup was never saved runs on `DEFAULT_LOADOUT` — the 5★
weapon at R1, no Mindscape, Awareness 0 (Level 80 and Ascension 7 are always forced) — and
`setupIsDefault` makes the Roster, the Loadout popup and Optimise say so: on the real inventory
that was 21 of the 36 active characters (Sep 2026), with nothing on screen to tell them apart.

**Every stat starts from the game's own panel baseline**: Speed, Crit Rate and Crit
Multiplier from `CHAR_STATS` (Awakening 7 replacing them where it publishes a value), SP
Recovery at 100%, and **Ailment Accuracy, Damage Multiplier and Resistance Pierce at 0%**.
Ailment Accuracy was modelled at 100% until the user checked a real panel (25 Sep 2026: 0%
with no cards). The 100 put every AA total 100 high — Haru (150) and Shoki (100) met their
targets with no cards and their AA conversions sat at their caps before a card was worn —
and it was also the only reason Awakening 7's `ailment_accuracy` was left unread (at a 100
base, lufel's 34.9 could only be a bonus; at 0 a total and a bonus coincide, so it is read).
At 0 the lufel numbers line up: Shoki's conversion caps at 100 AA, exactly his target, and
Haru's crit-damage stacks at 150, exactly hers. Four AA targets (Chizuko 173, Mio 171,
Koromaru 170.8, Aran 161) are now out of reach at the default R1 with no Mindscape and are
scored against what a perfect build reaches, like any unreachable target; the Setup fields
are what brings them back into range.

Only **unconditional** weapon passives count automatically. A line like "Increase Speed by
15/…/30." is a stat you always have; "After user uses [Secret Art], increase critical rate by
…" is not, and the generator deliberately refuses to parse it (`b` vs `extra` in
`CHAR_STATS`). The one route for a conditional line is `KIT_STAT_BUFFS` in `logic.js`: a
hand-kept list of lines judged always-on in the character's real rotation, each with its
reason and gated like the rest of the setup — an Awareness node counts only at or above its
level, a weapon line only while that weapon is held, at its refine step, and per-stack lines
at the stack count the kit sustains. 47 characters carry entries after a kit-by-kit pass over
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
no `extra` is really a plain unconditional stat line. The parser also keeps only **one** stat
line per weapon, and a second unconditional *sentence* goes nowhere, not even into `extra`:
Bloodletter's "+15% ailment accuracy" was the one case on the roster (a scan of every weapon's
text, Sep 2026), and it is counted through `KIT_STAT_BUFFS` with Kira's Doctor-mode accuracy and
his Bleed damage line. That moved his Star back to lufel's ATK%.

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

**Party buffs are not modelled, and the Thieves Den (My Palace) is the user's entry** — so a
total is a floor unless the Den is filled in. Say so wherever a total is shown. The one party
buff the scoring can assume, the team crit rate, is kept out of these totals on purpose (see
`CRIT_PROFILE` above). The Thieves Den — its level's items and its rating, Qualia, which follows
the roster's overall power — adds flat stats to everyone **in combat only**: lufel's guide says
they never show on the character screen before a battle, and lufel's targets count them
("Thieves Den 50LV 65 / 70LV 110 / Thieves Den Rating"). No formula for them is published, so
the header settings take the numbers the game shows (`state.den`, `denBonus`, saved as
`settings.thievesDen`): the in-battle stat screen minus the character screen. `breakpointRows`
adds them to the worn, perfect and no-card totals alike, after its ideal-side memo, and the
on-screen totals add them too — **never `totalStat`**, whose conversions feed the damage model.
Measured on the user's account (26 Sep 2026, Den 56, Qualia 355): ATK +119, HP +473, crit rate
+1, crit multiplier +2.

**A 4-piece's unconditional stat line counts in the totals** (`SET4_STATS`, read by
`cardStatContribution` through `set4StatLines`), the same rule as a weapon's unconditional
passive. None did until Sep 2026, and Miku's character screen showed the gap: her HP, ATK and DEF
all carry her Labor 4-piece's +8% ("when equipped by an Elucidator: all allies' HP, ATK and DEF
+8%"), and the planner matched her screen only with it. Labor (Elucidators only), Reconciliation
(+15% HP/ATK/DEF in combat), Strife (+15% ATK; the Fire-weak half is conditional) and the
unreleased Cruelty carry one; everything else in a 4-piece needs a turn, a trigger or an enemy
state. `bonus4Value` still prices the set as a whole — this is its stat in the in-battle totals.
It moved one build score on the real inventory (Miku, +1.05) and nothing in the calibration.
**The damage model reads the same line** (`damagePoints`, so ⓐⓑⓓ and the coupling), as a
2-piece's stat has always been in the product beside `bonus2Value`. Until 28 Sep 2026 it did not,
and Kotone Shiomi's ⓐ read 5316 beside her ATK tile's 5603 — Strife's 15% of her 1910 base, the
perfect build short by the same 287; a test holds ⓐ and the tile equal. On the real inventory it
changed no recommendation among the 37 active characters and moved no build score by more than
0.33 (Kumi); the calibration did not move.

**Miku's reference panel** (the user's, 26 Sep 2026, cards exactly as saved) is the one full
check against the game there is, and a test reproduces it: character screen ATK 4627 / HP 9358 /
DEF 1790 / crit 38 / crit multiplier 58.5 at Awareness 0, R0, Mindscape 5/5; in battle ATK 4746 /
HP 9831 / crit 39 / crit multiplier 60.5. It settled three things besides the two above: her
Awakening 7 is +19% ATK on Global, not lufel's 29 (`GLB_STAT_OVERRIDES`, with every other ATK%
source pinned), her weapon's "party crit damage +18.1%" is not on her own screen (dropped from
`KIT_STAT_BUFFS`), and weapon refinement is counted from **R0** in the game — `refine` stays a
1-7 ladder index, and `refineLabel` shows it one lower.

Four things the score does that look odd until you know why:

- Progress toward a target is measured **from the character's no-card total**, not from
  zero: a row's ratio is the share of the gap from what the character has with no cards to
  the bar that the cards close (`breakpointRows`). Measured from zero, base stats alone met
  the median target 64% of the way (61% on average, over the 45 scored), so a naked
  character took about 49 of the block's 80 points, and loadouts differed only in the rest.
  Since Sep 2026 base stats earn none of it. It moved the synthetic calibration by only 0.3
  (optimal builds close their gaps). On the real inventory it cost the 36 geared characters
  0.4 on average, most for those still short: Yaoling's 159 Speed of 180, from 139.9 with no
  cards, reads 48% where it read 88%. The Recommended-stats table says what the percentage
  now means.
- The bar is capped at what a *perfect* build on that loadout actually reaches. Some targets
  are unreachable from cards plus gear at all (Starlight Morgana wants 50% Crit Rate; a
  flawless build with her recommended mains gets 26), and scoring against a number nothing
  can hit would put 100 out of reach for reasons the user cannot act on.
- The block is worth `BREAKPOINT_VALUE` (80) however many stats it decomposes into, so a
  unit with three targets is not scored out of three times as much as a unit with one.
- A target the character already meets **with no cards at all** on the current setup is
  shown but left out of the block (`metBare` in `breakpointRows`). No loadout can earn or
  lose it, so scoring it only handed every loadout the same free points and watered down the
  targets gear does move. Fuuka is the standing case: lufel's Crit Multiplier 64-78% is the
  crit damage at which her party crit-damage buff stops growing ("10% + 0.625% per 1% of
  Fuuka's critical damage, up to 40%" — lufel's number is the cap over 0.625; Global's 4.12
  buff made it 12% + 0.75% up to 48%, and 48 over 0.75 is the same 64). Kit text means
  the *total* there, as Starlight Ren's "up to 31.4% … at 197.6% critical damage" (his target
  is 197.6) and Tempest Riko's explicit "the portion that exceeds 100%" show, so her 150%
  base clears it before a card is worn. It was half her block, leaving her ATK target — the
  one gear moves — the other half. Mitsuru's LV10 ATK target (2928, under her no-card 3190)
  is the other; at a Setup whose tier her base does not clear, it counts again. Checked
  against lufel's raw `minimum_stats` and skill text in Sep 2026, which is also where an
  earlier guess (that 64 was the 20% share Fuuka passes to allies) was ruled out.

`bestPlan` scores every plan with this same term — literally, since a plan's total is
`buildScoreOf(...).total` (see the scoring-engine section). It has to: without it the
optimiser trades away the one stat the character must reach for generic quality, and then
recommends a loadout the build score rates *worse* than what the user already had. Target
stats are therefore counted twice — once through their weight, once through this term — which
is deliberate, not a bug.

Main-stat magnitudes are now real (`MAIN_MAGNITUDE`, from the user's scan), so a 5★ card's
main is a true total even without a scanned `mainValue`; `mainValue` still wins when present,
and is the only source for other rarities — **except a 5★ value off its level's curve**
(`mainValueFitsLevel`, one display unit of tolerance), where the level wins, as it does in
`cardScore`. The card editor kept a scanned value when the level changed, so cards scanned at
Lv0 and set to Lv25 by hand carried their Lv0 main: Kotone Shiomi's four worn cards counted
4.6% ATK mains, her ATK target read 75% instead of met, and Weakest slots and Optimise
disagreed about her Sky. The editor and the import's level-up now drop a stale value, and
`load()` drops and reports any already saved.

### Awareness — a fourth progression axis, and a universal stat curve plus a per-kit one

Lufel's site has a per-character "Awareness" section — 7 named passives (levels 0-6)
unlocked with Cognitite — that is unrelated to Ascension, Mindscape or the Awakening-7
bonus already described above, despite the name-collision risk: lufel's own data field for
it is called `ritual`, not `awake`. `tools/fetch-lufel-data.js` pulls it from
`/data/characters/<name>/ritual.js`; `tools/gen-awareness.js` writes the result into each
`CHAR_STATS` entry's `awareness` array (`{n, d}` per level, name and full effect text) and
patches `src/data.js` **in place** via a brace-depth scan rather than a full regeneration,
so it never touches anything else in the file — safe to run even when the rest of
`src/data.js` has diverged from `gen-data-from-lufel.js`'s own output. It replaces an
existing `awareness` field rather than appending one (until Sep 2026 every re-run stacked a
second copy on all 65 entries), and its scan skips comments — a `// lufel's …` note on
Makoto Niijima's Mindscape line used to open a string that never closed and abort the run.
It writes the file's own line endings (a bare `\n` left 476 mixed ones in the CRLF
`src/data.js`), and a second run is byte-identical to the first.
A new character's `CHAR_STATS` entry has to exist before it runs; it only adds the field.
After a full regeneration — the generator emits `CHAR_STATS` without the field — run it
again, or every Awareness tooltip goes blank. Global text that differs from lufel's goes in its
`GLB_AWARENESS_OVERRIDES` table (whole levels, a `why` each, printed on stderr when applied, and
a test holds `src/data.js` to it): today Fuuka's 4.12 buff to Awareness 1, 2 and 6, in our own
wording from the user's change list. Drop an entry once lufel's English table carries the change.
Her skill buffs (Radiant Power, Holy Prayer, Spirit Wave: base, rate and cap each ×1.2, or ×4/3
for Holy Prayer) are stored nowhere, since skill text is not data here, and they leave her stat
targets as they were: lufel's targets are each cap over its rate, and both grew alike. None of it
enters scoring — an Elucidator's party buffs are not on her own panel (Miku's reference panel, above).

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

The Loadout popup's Setup section shows both (the Targets dialog only links to it now): the universal percentage at the selected
level, and which named abilities are unlocked (name plus a hover tooltip with the full
effect text) — mostly for reference, since almost none of them add anything beyond that
percentage. `awareness` defaults to `0`, not maxed like Ascension and weapon do — the
same reasoning as `mind: false`, since it is a per-character grind rather than something
a well-progressed account has finished on everyone.

### Teams: lufel's parties, filled from the roster (Oct 2026)

The Teams tab (`#tab-teams`, `tmTeams`/`tmAssemble`/`tmCandidates`/`renderTeams`) builds a party
around one character from `TEAMS` at the end of `src/data.js`, which `tools/gen-teams.js` writes
between two marker comments from lufel's `party.js` and `operation.js` (re-run after a refresh;
a second run is byte-identical). Rules that hold it together:

- **lufel decides, build scores only break ties.** A seat keeps lufel's pick when it is owned, not
  benched and not marked busy; otherwise it goes to the candidate with the most lufel evidence —
  the same seat in another lufel team with this character, a partner either side lists (with
  lufel's sentence as the reason), the same archetype as the missing pick. Only a thief or
  Elucidator seat with no such candidate takes the best-built free character, labelled "filler".
  Teams rank by required seats left empty, then lufel picks kept, then a team from the
  character's own page, then mean build score.
- **Fuuka's backup is a seat only while Fuuka is the Elucidator**, filled only from lufel's
  reasons (her partner list is her backup list) and optional: an empty backup never makes a team
  rank below one of fillers. A partner entry's `a` is the Awareness lufel's reason relies on; a
  candidate whose Setup is below it is ranked down and the row says so.
- **Rotations are lufel's, chosen, and since Oct 31 2026 fitted to the team, never composed from
  nothing**: `tmRotPick` takes the highest Awareness level the member's Setup reaches (lufel's
  lowest, flagged, when it reaches none), and a rotation whose label names a teammate ("Miku",
  "with Manaka") only when that teammate is in the team (`tmLabelWho`). The fit (`tcRotFit`, the
  "Fit rotations to this team" checkbox, a pref on by default) is described under the calculated
  basis below; it never touches the character the team is built around.
- **Turn order is in-battle Speed** — `totalStat` with worn cards plus the Thieves Den. Wonder's
  is the user's entry (`state.wonderSpd`, saved as `settings.wonderSpeed` beside the team crit
  rate, in the unsaved-changes fingerprint and the undo snapshot): his Persona is not a card, so
  the planner cannot compute it: it follows the Personas he uses and skill cards tune it. Unset is
  unknown, never zero — he is taken to act just before the damage dealer (the user's rule, Nov 2026:
  players tune him to), and the turn order says so.
  The Elucidator acts outside the order; the page says so.
- **No lufel prose beyond one-liners.** Partner reasons and rotation notes are short and shown
  as lufel's; the long reviews are linked, not copied (the site build is public). A mechanic worth
  explaining goes in `TEAM_MECHANICS` in our own words — today only Fuuka's Oracle Shift.
- The busy list is a pref (`tmBusy`), the chosen party and seat overrides are this session only
  (`tmPick`). It reads state and writes none. Wonder's Personas have a busy list of their own (the
  user asked, Nov 2026; `tmBusyP`, a pref, marked from buttons on his seat): a busy Persona is never
  suggested (`tcWonderBest`), and in his own setup it is left out with its skill cards for pricing
  (`wonderHere`, what `tcWonder` reads by default) while the saved setup keeps it; the seat says so.
  Both lists are in `tcMemo`'s key and `tmInputSig`, and "Clear all" clears both.
- **It calculates only when Calculate is pressed** (`#tmCalc`, `tmCalculate`; the user asked, Nov
  2026: a calculated team takes seconds, and every dropdown change waited for one). A visit, a
  settings change and `commit()` only redraw the controls (`tmRefresh`) and the status line above
  the result (`tmMarkStale`): before the first Calculate it says to press it; after, it compares
  `tmInputSig()` — the controls, the busy list and `dataSignature()` — with the run's and, when they
  differ, keeps the team on screen marked out of date with a Calculate button. The buttons inside a
  result (Use, Busy elsewhere, a lufel party, back to the recommended team, Wonder's suggested
  setup) still work it out again at once, on the damage dealer it shows (`tmShownDps`).
  `renderTeams()` is the calculation itself, synchronous; the button defers it 30 ms so
  "Calculating…" paints first. A lufel-basis team renders in 10-30 ms on the real save.

### Teams, calculated: what the others do for one damage dealer (Oct 2026)

lufel's team lists are written once and age as characters release (Ann's page still names
Futaba where Miku or Fuuka buff more), so the Teams tab's default basis ("Build from:
Calculated from the kits", `#tmBasis`, a pref) prices every team the user can field instead
(`tcSearch`/`tcLineup`/`tcMember`/`tcMultiplier`/`tcTeams`). The number is how many times the
damage dealer's own damage the team makes it, against one reference boss, through lufel's
damage formula (`docs/DATA-SOURCES.md`, the damage-formula section):

- **ⓐⓑⓓ are `damageFactors(..., extra)`** — the damage dealer's own cards, Setup, conversions
  and crit profile with the team's buffs added; an ATK buff reaches ⓐ only for an ATK kit (a DEF
  or HP kit's hits ignore it). The team crit rate setting is zeroed for this: the supports who
  supply that crit rate are counted one by one.
- **ⓒ is lufel's defence formula**, 1 − E/(E+1400) with E = DEF × max(0, (1 + coefficient) ×
  (1 − Pierce) − DEF down), against the boss the page picks (`#tmBoss`, a pref): one of lufel's
  defence-calculator bosses, `BOSSES` at the end of `src/data.js`, written by `tools/gen-bosses.js`
  (base DEF, coefficient, resistances; Korean demon names translated in its `NAME_EN`). `TC_BOSS`
  takes the picked boss's numbers whenever `tcMemo`'s key changes. A test reproduces the article's
  worked example. ⓕ is a weakness hit (1.2) raised by weakness-damage buffs, **only when the damage
  dealer's element is weak on that boss** (`#tmWeak`: every hit, the boss's resistances, or none;
  `tcWeakFor`) — a resisted or neutral hit takes no weakness-damage buff, and a resist's ×0.5 is on
  both sides of the ratio. Each thief's own hits fill the gauge at 21% only on a weakness hit, 17%
  otherwise. ⓖ is final damage / damage amplification.
- **The fight's defaults follow the damage dealer** (Nov 2026; the user asked for the most faithful
  setup). lufel's non-Sea-of-Souls bosses are Nightmare's Gateway's: one boss at DEF 1280 (Baal,
  Atabaka, Yatsukamizu; lufel's "Single Boss (Example)") or a boss with linked helpers at DEF 821
  (Vishnu, Mara, Surt; the "Area Boss (Example)"), where Vishnu, Kartikeya and Dominion bring 4. Each is
  weak to one element and is fought with a team of it. So `#tmBoss` and `#tmFoes` default to Auto: an
  `AoE DPS` (lufel's Sweeper) fights the area example with 4 more foes, everyone else the single example
  alone (`tcBossNow`, `tcFoes`, `TC_AUTO_BOSS`); `#tmWeak` defaults to every hit on a weakness. They
  resolve for `tcFocus`, the damage dealer the last entry point named (`tcMemoFor(D)`: `tcSim`,
  `tcMember`, `tcMultiplier`, `tcSearch`, `tcLineup`, `tcTeams`, `tcWonder`, `tcPairFor`), and the memo
  key holds what they resolved to. The old default, the article's Vishnu with one foe and weakness by
  its resistances, fought an area boss's DEF as a lone foe and gave only Fire a weakness (no listed
  boss is weak to Ice). Measured on the real save (19 damage dealers): boss DEF mattered most (821 to
  1280 changed the best team for Ren, YUI, the twins and Makoto Yuki); the weakness mode barely moved a
  team; 9, 12 and 15 rounds mostly agree while 6 changes it for 12 of 19; 3 and 5 foes agree. Fight
  length is 6 rounds since 2 Nov 2026 (`TC_FIGHT_DEFAULT`; the user: most Sea of Souls and Nightmare's
  Gateway fights last about that long; it was 12). The build model's own fight (`kitMix`) plays the same
  6; the calibration did not move (70.1 / 71 / 41-84, bands 8/52/8). The judged `chance`/`share`/
  `stacks`/`up` figures that depend on fight length (a ramp to a cap, a battle-start window, "all but
  the first") were re-judged over 6 rounds the same day — Akechi's A1 Deduction and +25%, Ichigo's
  Chains of Love lines and her DPS_COUNTS_AS shares, Ryuji's Comeback Kid, Yusuke's Shadowkiller,
  Seiji's Knight's Reward, Radiance Motoha's Reshape and Expedition's Edge, YUI's Potato Power,
  Toshiya's A2 Curse, Junpei's second Fired Up — each `why` giving both the 6- and 12-round reckoning.
  Steady-state averages (a cycle that refills, a per-round rate) were left alone. A change of the
  default again means walking these. `applyPrefs`
  reads a save's exact old trio (`8`/`boss`/`1`), which every save stored, as untouched, and a fight
  length of `12` in a save without `tmFightDefault` likewise. Extra foes are
  still copies of the boss, not the DEF-364 helpers.
- **What each member supplies is `TEAM_BUFFS` in `logic.js`**: kit lines turned into numbers,
  one entry per effect (`k` the factor, four-tier `v` or a 7-step weapon `ladder`, `per` for a
  value that grows with the supporter's own stat up to a cap, `to`, `on`/`dur` or a judged `up`,
  `aw`/`weapon` gates, `elem`/`arch` limits, `why`), and `TEAM_BUFF_SKIPS`, what the kit does for
  damage that cannot be priced (extra turns, gauge, weakness creation, Down, Resonance, skill
  amplification, copying), shown under each member. Every Elucidator also adds 20% of her ATK
  (as flat ATK), crit rate, crit multiplier, damage and Pierce from her worn cards (15% at 4★) —
  computed, not entered. Entered in Oct 2026 for the whole roster (68; 25 in a first pass, the
  rest in a second, damage dealers mostly with nothing for the team) from lufel's English skill,
  Awareness and weapon text, by hand-checked batches against one written brief (scratch sheets
  and brief are not kept); a kit not entered counts as adding nothing and the seat says so. One
  buff two skills refresh is one entry with `on: ["1", "2"]` (`tcCover` counts its turns once);
  two entries are kept apart only where the kit says they stack (J&C's Warden's Judgement). Each entry's `why` says where its number comes from; a judged `up` says how it was judged.
  **"X% + r more per N of a stat, up to a maximum of Y%": Y caps the scaled part, and X comes
  on top.** lufel's own stat targets prove it — Fuuka's ATK target 3502 is 40 ÷ 1.143 × 100 and
  her crit-multiplier target 64 is 40 ÷ 0.625; Mio's 31.2% at 1% per 5.47% ailment accuracy lands
  on 170.7%, the accuracy cap Koromaru's kit names outright, and every tier lands on its own cap.
  Half the first batches read Y as the total, 20-25% low on Mayumi, Runa, Mio, Kumi, Yukari,
  Manaka and Fuuka; that was corrected (Oct 2026) and the reading is not a choice to revisit.
  The user asked again about Kumi's Hard Knocks (Nov 2026): lufel's Japanese text names the cap
  "追加低下分" (the *added* decrease), and lufel's defence calculator lists 48.8% (9.8 + 39.0); English,
  Korean and Chinese are ambiguous there. Runa's Furrious Bark is unambiguous in every language (the cap
  sits inside the brackets with the ailment-accuracy part) and the calculator gives 68.3%. Only an
  in-game reading of the debuff would overturn it.
  **Effects that do not stack** are `excl` (Nov 2026, the user asked for Runa's Welcome Hug): cast lines
  of one character with the same `excl`; lines of one `src` add up as one effect and of the effects up
  on a foe only the largest counts (`tcExclDrop`, per foe, so Welcome Hug's all-foe cut reaches the foes
  Furrious Bark's one-foe cut misses); the quick screen counts the smaller only on turns the larger leaves
  uncovered (`tcExclQuick`). Welcome Hug was not priced at all until then, and Furrious Bark was read as
  all foes and 2 turns at A6 (lufel: 3). On the real save only Mio's best team moved (20.9× to 22.0×,
  Runa already in it).
- **A rotation is fitted to the team, within lufel's own** (`tcRotFit`, Oct 31 2026). lufel writes
  a character's rotations once, for a typical team, so a member's rotation is adjusted to the team on
  screen without inventing a cadence: every rotation lufel writes for them at their Awareness (the
  ones `tmRotPick` shows) is a skeleton whose *plain* skill turns — a bare "1", "2" or "3" — are
  re-chosen among the plain skills those rotations use; every other turn (a burst "1+1+3", a
  Highlight, a Transformation, an item, Fatigue, an idle "-", Miku's "2 Fire") stays where lufel
  put it, because its place is the kit's; and no plain skill is used more or less often, per turn
  of the rotation, than lufel's rotations at that level use it — the stand-in for SP and cooldowns,
  which nothing models. A skill lufel never writes into a rotation is never introduced, with one
  exception for a stated kit reason (`TC_ROT_ADD`: Firecracker Rin's Skill 2, her only Burn below
  Awareness 2, on up to 2 of 6 turns — see Technicals below). Each
  candidate is priced as the whole team (the other seats at lufel's rotations, the backup as the
  backup, Wonder) with the member's rotation-dependent lines re-covered; the winner is the one that
  makes the damage dealer's hits strongest, ties to lufel's as written, then the fewest turns
  changed. Candidates and their covers are memoised per member, damage dealer and lufel list
  (`tcMemo.rot`, one entry per distinct coverage, a few dozen at most); a team context prices
  those. `tcMember(..., fit)` returns the result as `rot` (seq, base option, changed turns, gain
  over lufel's first option as written, `same`), null when nothing priced depends on the order or
  only one way to choose the turns exists; `tcLineup` fits every seat but the backup, so the
  search's exact re-pricing of the leaders and every replacement see it, while the sweep stays at
  lufel's. On the real save (Oct 31 2026) it chose Fuuka's idle-free second option (+2.7%) and put
  Kotone's Skill 3 on turn 4 (+3.9%); Koromaru's rotation follows the damage dealer's element (his
  shared damage line is `on: ['1','2','3']` since, as its reason always said). A fresh render costs
  about 40 ms more; a repeat is unchanged. The Rotation panel shows the fitted rotation first with
  the changed turns highlighted (`.tmRot .t.fit`) and lufel's as written folded under it, or says
  "Already the best fit" with how many other ways were tried; the member's lines read the fitted
  uptimes. `tcTeamSet` builds the Set both the lineup and the panel key the memo on, with the 4th
  seat as `backup`. Off, everything is lufel's as written, as before.
- **The number is the fight, played round by round** (`tcSim`, Nov 2026; the user asked for turn
  order, cooldowns, a measured Highlight gauge, the damage dealers' Resonance and damage over time,
  and Summer Ayaka, Catchy Hook, starting gauge and Kotone Shiomi's Fortune done properly). Over the
  rounds `#tmFight` sets (6 by default, a pref and part of `tcMemo`'s key), the Elucidator acts at
  the start of each round, the four thieves — the damage dealer, two teammates, Wonder — once each
  in Speed order (`tmSpeed`; Wonder just before the damage dealer while his Speed is unset; a tie goes to the teammate), and
  the enemy last. **A buff on an ally counts down after that ally's own action, a debuff on the
  enemy after the enemy's** (lufel's "'Speed' and 'Turn Order'" guide): a supporter acting before the
  damage dealer lands this round's hit, one acting after waits a round, and a 1-turn debuff cast
  after the damage dealer acted never meets a hit. Each member follows their lufel rotation (or the
  fitted one); `tcMemberCalc` hands the fight its lines split into what is on whatever happens
  (`sim.consts`: passives, judged `up`, the Elucidator share) and what a cast, a Highlight or a use
  per battle sets off (`sim.events`, each tied to its line by `ref`, so the page shows the uptime
  the fight gave it). The damage dealer's damage is their skills (`SKILL_DMG`, lufel's English text
  by `tools/gen-skill-damage.js`, with 28 hand corrections in its `FIXES`), their Highlight or
  Theurgy when it fires, and `DPS_KIT`: Resonance, follow-ups, summons, damage over time and token
  turns for 32 kits, each with its trigger — their own actions or a skill, a token ("Gunshot",
  "Transform", a whole "1111"), their Highlight, **a teammate's action or Highlight**, the end of
  their turn, the enemy's turn — and gates (`after`/`dur` a skill or token, `max` a round, `chance`,
  `stacks`, `aw`, `weapon`); damage over time does not crit. Their own damage bonuses on those hits
  are `DPS_KIT_BONUS` (below). `DPS_KIT_SKIPS` is what those kits do that cannot be priced, shown on
  the damage dealer's seat with the damage mix the fight gave them.
  Both came from four hand-checked research batches against one brief (Nov 2026); each `why` says
  where its number comes from and what was judged. Every hit is priced with what is up at that
  moment (memoised per buff state), against the unbuffed hit with its crit, so a hit that cannot
  crit (damage over time, a Highlight) is worth less by the crit factor. Skill numbers are read at
  the skill-level tier the Setup reaches (`SKILL_DMG` `dt`, `tcSkillD`, the same tier rule as the kit
  lines; a `FIXES` value scales by its text's own tier ratios). **A Highlight does not crit** (lufel's
  guide) unless its text or an Awareness says it can (`hlCrit`: J&C, Kasumi, Radiance Motoha); a
  Theurgy does. Wonder's skills are cast turn by turn too: `tcWonder` lays his cast skills on a
  six-turn schedule (`sim.cast`: each every its longest duration, the turns left are attacks), so
  only his passives, weapon and judged lines stay averaged. The team's number is that total over
  the same fight with teammates who add nothing (they still act and attack: the gauge fills and
  every Highlight is the damage dealer's). A member's part is the fight without them; Wonder's, the
  fight with his setup blank. Fuuka's backup is played out too (next bullet but one). A fresh render
  is 0.4-1.0 s on the real save, a repeat 0.1-0.3 s.
- **The damage dealer's own rotation is fitted to the team in the fight** (`tcSimFitDps`, Nov 2026;
  the user: adapting rotations to the team is the point of the tool). Same candidates as a
  teammate's fit (`tcRotVariants`: lufel's options at their Awareness, plain turns re-chosen within
  lufel's frequencies, no cooldown broken), but each is priced by the fight with this team, so turn
  order, the gauge and what teammates set off decide it: every candidate under the spending order
  lufel's as written did best with, the top `TC_DPS_FIT_TOP` (2) under every order, a change kept only
  if it gains `TC_DPS_FIT_MIN` (0.1%). Every candidate is tried for every team: ranking a pool by the
  fight alone and trying only its head missed the rotation a teammate's debuff rounds called for (a
  test holds that case). The reference fight fits the damage dealer alone too, so the number is the
  team's, not the fit's. `tcSim`'s `fit` is `true` (teammates and damage dealer) or `'mates'`
  (teammates only): the search fights its 30 leaders with `'mates'` and re-fights the 10 it shows with
  `true`. The Rotation panel shows the damage dealer's fitted rotation like a teammate's. On the
  real save: Makoto Yuki +8.8%, Wavecatcher Miyu +8.5%, Frostgale Kotone +1.3%; Ann and Ren keep
  lufel's.
- **The teammates' rotations are fitted in the fight too** (`tcSimFitTeam`, `fit` `'full'`, Nov 2026):
  after the damage dealer's, each teammate's and the Elucidator's candidates are played with the
  others' rotations as they stand, the best kept (same 0.1% bar), pass after pass until none changes
  (at most `TC_FIT_PASSES`, 3), starting from the quick fit (`tcRotFit`, which still screens the
  sweep). One member's debuff rounds decide where another's buff or hit belongs, which the quick
  model's share-of-turns cannot see (a test pins such a case). A teammate's candidates that cast the
  same priced skills and hit the boss on the same turns are one candidate (Kumi's 90, Runa's 160
  shrink a lot); an Elucidator's are all tried. A composed member takes up to `TC_FIT_STEPS` (2) changes
  a pass (Nov 2026; it was 1, so a rotation moved at most three changes from where the quick fit started it,
  and once Kotone Shiomi's numbers changed Ichigo's best team settled at 24.7× where the rotations found
  before priced 25.7×). Over the real save's 48 leading lineups 2 gave +0.4% on average and never less, the
  search about 9% slower; 4 lost to 2 on two lineups, and a second start from lufel's rotations as written
  added 0.07% for 30% more time. It is still a local search: Ryuji's twins team prices 24.6× where the
  rotations it had before Kotone's weapon was priced give 24.8×. `fits[name]` feeds the Rotation panel. Cost is held
  by fitting fully only what is shown: the search re-fights its shown 10 with `true`, gives the
  leading `TC_FULL_TOP` (3) the full fit, and also the best shown team of each other Elucidator (the
  full fit is the only one that fits hers, so what it gains depends most on her: Miku's team for Akihiko,
  her at A1, was 4th at 20.7× and 27.0× fully fitted, above the 25.6× that led; Nov 2026), and lets the
  best of those lead, about 10% more search time on the real save; the headline, its rotations
  and line uptimes are the full fit; members' parts, the next teams, lufel's team, replacements and
  Wonder's suggestion are priced with `true` and scaled to the headline (`Lref`), like for like. A
  fresh render is 0.6-1.0 s on the real save. The damage-formula memo is per damage dealer for the
  render (`tcMemo.dmg`).
- **The Highlight gauge, as lufel's HIGHLIGHT guide measures it**: one gauge for the team, 17% per
  thief action that does not hit (`TC_GAUGE_MISS`: a buff, a shield, Wonder casting a card) and 21%
  for one that hits the boss's weakness (`TC_GAUGE_ACT`; `tcStepHits`: a skill with damage by
  `SKILL_DMG`, or an attack token), capped at
  100%, empty at the start (so the first Highlight is in round 2), not charged by Highlights,
  All-Out Attacks or the Elucidator; a Highlight spends 100% and its user cannot use it again for 4
  of their own actions (`TC_HL_COOL`). Four thieves charge 68-84% a round, fewer than four Highlights
  every four rounds, so who gets them is a choice: `tcSimBest` plays the fight with the gauge spent
  in several orders (the damage dealer first; each teammate whose Highlight carries lines first,
  then the damage dealer; all those teammates first) and spent as soon as it fills or held for the
  moment just before the damage dealer acts unless the next action would overflow it, and keeps the
  best; the page names it. A member whose Highlight carries no line never spends the gauge.
  **Theurgy, as lufel's Theurgy guide has it**: a gauge per S.E.E.S. member, +35 at the start of
  their turn (`TC_TH_TURN`), to what their Theurgy needs (`SKILL_DMG` `th`: Yukari, Mitsuru, Koromaru,
  Aigis 70; Makoto Yuki 100; Akihiko, Junpei 140), used just before the damage dealer acts or before
  its user's next turn; starting gauge and faster fill from `TC_THEURGY` (Yukari's and Akihiko's
  A1 +70, Makoto Yuki at least 35, Koromaru's automatic Assist 70, Junpei's and Mitsuru's A6 ×2).
  Played out from the kits: Catchy Hook fires the damage dealer's Highlight at once, outside its
  cooldown and the gauge, with its damage bonus, and it triggers every "when an ally uses a
  Highlight" line like any other; Ayaka's Highlight and Holy Prayer fill the gauge, Spotlight cuts
  the others' cooldown, Arrow of Life and Holy Prayer fill a Theurgy; Miku's Virtual Concert is 2
  extra rounds after the thieves act (her timed buffs run 2 turns longer, her Virtual-Concert lines
  hold only then, and from A1 every cooldown resets and the gauge fills twice as fast); **Summer
  Ayaka's Concerto of Time**: no one else may spend the gauge, at the start of each of her turns
  she fires one ally's Highlight free (by the spending order, their cooldown 3), her gauge caps at
  250% (300% at A2) and refills from Celestial Concerto, Improvised Song and A2, and as the damage
  dealer she spends 200% (300% at A2) a Highlight as lufel's HL(2)/HL(3); **Kotone Shiomi's
  Fortune** (A1) fires her Highlight free on the burst turn of her rotation, once (twice at A6);
  a Highlight with no cooldown that lufel writes into a rotation costs no gauge (Kasumi, Radiance
  Motoha); Ayaka's Superstar fills the gauge at the start (`TC_HL_START`); Manaka's Da Capo is an
  extra action for the damage dealer in set rounds, with Crescendo, Fortissimo and Team
  Ambassador on it. **Skill cooldowns** (`SKILL_DMG` `cool`): the rotation fit never proposes a
  rotation that casts a skill again inside its cooldown (`tcBreaksCooldown`).
- **The quick screen** (`tcMultiplier`, `tcMember`'s `vec`) is the averaged model the sweep over
  every pair of thieves, the fit and replacement shortlists use before the fight prices the
  leaders: uptime as the share of turns a rotation keeps a line up (`tcCover`), a Highlight every 5
  turns for a thief whose rotation has none (84% a round shared four ways; `tcSeqHL`), a Theurgy
  every requirement ÷ 35 turns, and the damage dealer's Highlight as a share of their damage
  (`tcDpsHl`, `tcDpsRate`) that Highlight-only damage (`hlDm`, `hlFinal`), extra Highlights (`hlx`,
  `hlxDm`), gauge (`hlGauge`, `thGauge`) and cooldown cuts (`hlCdRate`, `hlCd`, `hlFree`) move; with
  the gauge shared the gauge, not the cooldown, holds it back there. Lines triggered by Highlights
  use `on: 'dpsHL'`/`'anyHL'`, `dur: 'next'` (until the damage dealer's next Highlight), `only:
  'HL'|'TH'`, `durAw: [aw, dur]`; a once-per-battle line `battle` (`TC_BATTLE`). The search's
  leaders, replacements (the best 6 a seat by the screen), Fuuka's backup and Wonder's suggested
  setup are all priced by the fight.
- **Wonder** is a member like any other, priced from the setup the user enters on the tab — three
  Persona slots, each with the three skill cards that Persona has learned (a card is cast only
  while its Persona is in use), plus a weapon and refinement (`state.wonder`, saved as
  `settings.wonder`, in the fingerprint and the undo snapshot; `wonderFrom` drops anything
  `WONDER_BUFFS` does not know or the Personas tab does not own, and reads a pre-slots save's single
  Persona as slot 1).
  `WONDER_BUFFS`/`WONDER_SKIPS` come from lufel's Persona files, skill cards
  (`/data/kr/wonder/skills.js`) and Wonder weapons (`/data/kr/wonder/weapons.js`), the DEF-down
  values cross-checked against lufel's defence calculator (`/data/kr/calc/defense-data.js`).
  Every weapon lufel lists as released is a key of `WONDER_BUFFS.weapons`, since the keys are the
  dropdown: one with nothing for the team (Abyss Fang, All In, Plasma Blade, Whisperer's Sting) has
  `[]` and its reason in `WONDER_SKIPS`, which Wonder's seat shows as "Not priced" (Nov 2026; until
  then those weapons could not be chosen, and no skip note was shown). Sennight Inferno's knockdown
  DEF cut is `on: 'knock'`, fight-only (`sim.knock`), like a teammate's. Glimmer's Blessing names no
  ally; the user chose to count it on the damage dealer, always on (it is reapplied every 2 turns).
  **Ice Age's Ancient Frost follows his casts** (`allyCast`, Nov 2026; the user asked after Starry Compass
  beat the dagger made for Wavecatcher Miyu): on the damage dealer at battle start for 3 turns (`'wStart'`,
  fired in round 1) and renewed only by a skill cast on an ally alone (`onAlly`: a skill with any line on a
  foe, such as Janosik's Tatra Shot, is cast on the foe). It had been a judged 80% whatever he cast. The
  quick screen reads his ally casts per six turns (`allyCastUp`, optimistic: a cast in the opening window
  renews nothing), the fight plays them. `tcWonderBest` re-checks the weapon once its Personas are chosen
  (the quick screen's best `TC_WB_WEAPONS`, 3, fought; a change gets one more pass over the slots), since a
  weapon chosen with no Personas can never be Ice Age. On the real save, Miyu's best team: with the
  suggested Personas (no ally casts) Ice Age fell from +3.4% to +1.1% and Starry Compass (+4.2%) stays;
  with Dionysus casting Revolution on her Ice Age beats Starry Compass on the same Personas (21.93× to
  21.82×), but Kohryu / Janosik / Belphegor with Starry Compass is higher still (22.14×), and the
  suggestion is that now. It missed Kohryu at first: with Janosik and Belphegor spending his six turns the
  quick screen's top six for the last slot were all Personas that take turns from them (Dionysus, Succubus,
  Koumokuten… — rated first, and each loses in the fight), and Kohryu, whose +15% ATK works in reserve
  and takes no turn, sat 15th; every Persona fought added nothing, and Leanan Sidhe kept the slot on the
  tie-break. So each slot's shortlist also takes the quick screen's best `TC_WB_IDLE` (3) that take none of
  his turns (`tcWbShort`; `inUse` 0 for that slot). On the real save only Miyu's suggestion changed (16
  damage dealers), at 0.02-0.17 s more a suggestion.
  His stats are not tracked, so a value that grows with them is taken at its cap, and his skills
  at their top rank; his own damage is not counted, his Highlight comes from the shared gauge in
  the fight (above), from whichever of his Personas' Highlights does most.
  **A Persona's passives work only while it is in use** — the user asked, and the Persona text
  settles it: the exceptions say so in their own words ("activate even in reserve": Sahimochi-no-
  Kami, Kohryu, Sraosha, Vasuki, Shiva; Sandalphon's "when not present"), and what they do in
  reserve is build stacks paid out on use, or raise DEF; lufel's notes agree (Throne's Burn "even
  in Sub-persona slot", Koumokuten's buff "persists after switching"). So `tcWonder` gives his six
  actions in six turns to active skills by worth per action, keeping one only if the whole setup
  gains (casting a second Persona's skill takes turns from the first, whose passives then count
  for fewer turns), in two orders — by worth, and slot by slot — the better kept, so a later slot
  never costs anything; idle turns go to the Persona whose passives are worth most. The page
  shows each Persona's share of his turns and what goes uncast.
  **An on-cast passive fires only on the casts its text names** (`castOn`, Nov 2026: `'ally'` for
  Dionysus, Succubus, Jikokuten, Raphael, Throne; `'foe'` for Bishamonten and the other "skill on a foe"
  lines; none, any skill). Until then every turn the Persona was in use counted, its attack turns too,
  so an ally-triggered passive fired on turns the page showed as attacks. An idle turn is now an attack
  (a skill on a foe) or, when the Persona has an ally skill and its passives are worth more that way, a
  recast of it ("Rebellion again", token `wr`), which does not hit the boss (17% gauge, no Down). On the
  real save Succubus and Dionysus moved by at most 1.4 points for 15 of 16 damage dealers (both recast
  their own unique, and in the fight recasting beat attacking for both). Dionysus fell 5 points for Ryuji.
  **A Persona's innate skills count** (Nov 2026, the user asked): `WONDER_INNATE` in `src/data.js`
  (written by `tools/gen-wonder-innate.js` from lufel's 155 Persona files) lists each Persona's
  innate skills; **a Persona Global does not have yet is never offered** (`WONDER_UNRELEASED`, the same
  block, Nov 2026; the user asked): lufel shows every Persona whatever the server, so the generator reads
  its GLB schedule — a Persona released in a version after the last one dated on or before the day it
  runs is not out (Macabre, Raphael, Gabriel on 2 Nov 2026); one the schedule never names shipped at
  launch. `wonderPersonas()` leaves them out, so the dropdowns, the suggestion and a loaded setup do too;
  their `WONDER_BUFFS` lines stay for release day. Re-run the generator after a release. One with a skill
  card of the same name is priced as that card, cast while its Persona
  is in use (16 Personas have such a skill — Auto-Mataru, Matarukaja, Tarukaja, Rakunda, Rebellion,
  Debilitate; the rest are attacks, heals, DEF or Wonder's own stats). A Persona with only priced innate
  skills can be chosen too (`wonderPersonas()`). **One skill from two sources counts once**, from the
  strongest source: two Personas' unique Rebellion, an innate Rakunda and a unique one, a card and an
  innate skill, Auto-Mataru III and IV — the rest are listed as "the same buff, counted once". Before,
  each source was its own buff and stacked. Rakunda and Marakunda (or Tarukaja and Matarukaja) are
  still separate: whether P5X stacks the one-target and party versions is not settled.
  **The Personas tab is Wonder's collection** (`#tab-personas`, `state.personas`, saved as
  `settings.personas`; Nov 2026, the user asked): which Personas are owned, each one's level, talent rank and
  skill level (6/7/8), and the skill cards it has learned. Laid out like the Roster: a card per Persona with
  its art (`art/persona-<slug>.webp`, `tools/fetch-persona-art.js`; a full-body cut-out, shown whole, the
  initials hidden once it loads) and a one-click Obtained (undoable); the card opens a popup (`openPersona`,
  dialog view `persona`) whose edits commit at once and which lists what the Teams tab counts at those
  settings, each line at its value now beside its top one (`psDialogOut`). Only owned Personas are offered, suggested or kept
  in a loaded setup (`wonderPersonas()`), and a slot's skill cards are its Persona's (`wonderFrom` reads them
  from the collection; the Teams card boxes write there). The first time — a new page, or a save without
  `settings.personas` — every Persona out on Global is owned at the top of every rank, which is what was
  priced before, and the old setup's cards move onto their Personas (`personasFrom`); after that a Persona
  with no record is not owned (released since). The ranks change numbers through `WONDER_PERSONA`, which
  `tools/gen-wonder-innate.js` writes from lufel's Korean text: `learn` (an innate skill counts from the
  level it is learned at, `wonderInnateHere`), `tv` (a talent number's value at each rank, lined up sentence
  by sentence; null before the rank that adds the clause — Janosik's crit lines arrive at Hunting IV) and
  `sv` (a unique-skill, Highlight or innate number printed a/b/c). `personaLines`/`personaInnateLines` give
  a Persona's lines at its record; a passive reads `tv` first, the rest `sv` first, each falling back on the
  other (16 unique-skill lines are really a talent's). 136 of the 142 priced Persona lines follow a rank this
  way; the rest keep their top value. Skill cards taught to a Persona keep theirs, and a Persona's level
  does nothing to a line that grows with Wonder's stats (still not tracked). Bulk marks are undoable.
  **`tcWonderBest` suggests three Personas with the skill cards each has learned** (the user asked for no
  cards before the collection existed; the default collection has none): the weapon, then each
  slot the Persona that adds most to the others, or, when none adds anything (his six actions are
  spent), the one that does most on its own. **It is chosen by the fight**, not the quick screen (the
  user found character-made Personas missing): the screen's averages misjudge short effects, so it only
  shortlists each slot (its best `TC_WB_SHORT`, 6, its best `TC_WB_IDLE`, 3, that take none of his turns
  — see Ice Age above — plus any Persona with a line it cannot price —
  continuous damage, Resonance) and `tcSim` with the cheaper fit picks; one improvement pass. Measured on
  the real save, the fight's top five single Personas sit within the screen's top 13 for every damage
  dealer tried. A render costs about 0.2 s more (1.2-1.4 s). `adds` (not enumerable, so not saved or
  compared) is each slot's share, by the fight, and the seat names the ones that add nothing.
  **Personas made for a kit** (Nov 2026): a research pass over all 155 Personas against lufel's text,
  in three batches, entered what new fields can now express — `minHits` (a buff for skills hitting
  that often: Zaou-Gongen's Threefold Transcendence), `dotDm`/`dotFinal`/`resDm` keys (Vasuki's
  continuous-damage multiplier, Nian, Sahimochi-no-Kami's Resonance), `reserve` (works while another
  Persona is in use: Kohryu, Koumokuten's battle-start buff) and `onCast` with `dur` (refreshed by each
  skill he casts with it, for that long) — and corrected 19 lines: Shiva's DEF cut was credited every
  turn though a cast each turn never reaches the 2 Wisdom it needs, Koumokuten's buff counted 6 rounds
  not 3, Okuninushi was under-counted, and Parvati, King Frost and Narcissus counted even when their
  trigger skill is never cast. The damage dealers' side is `DPS_HITS` (hits per cast of each skill and
  the Highlight, 60 characters, `DPS_HITS_AW` for hits an Awareness adds) and `DPS_COUNTS_AS` (skills a
  kit says count as continuous damage or Resonance: Ichigo, Kira (Korean only, `koOnly`), Summer Ayaka
  from A6, Wavecatcher Miyu's Aerial Tide, Runa's Skill 3); the fight prices each skill with what
  reaches a cast of its hit count (`curX(others, hits)`) and its counts-as share. With all of it on the
  real save the character-made Personas rise (Vasuki #26 to #8 for Ichigo, Zaou-Gongen #45 to #34 for
  Makoto Yuki) but Gabriel and Succubus still lead: their packages are larger. Wonder's own damage is
  still not counted, and much of what character-made Personas do raises it (Shiva's +33% Psychokinesis,
  the +29.1% ATK talents). The same research found SKILL_DMG numbers that are now fixed in `FIXES`:
  Pioneer Shun's Skill 1 (249 to 83: later hits on the same foe deal 20%), Mio's Skill 3 (241.6 added
  her two alternative casts; 120.8, the mean of the two, since at Awareness 0 every other Skill 3
  reaches the 4 stacks Requiem Guidance needs, so 8% low from Awareness 1), Starlight Morgana's Skill 3
  (145.4 to 72.7: Whirlwind Waltz and the Crash! it unlocks alternate on her "3"s) and Kiyoshi's Skill 2
  (45 to 20.2; the Sacred Flame tick is a `DPS_KIT` dot on the enemy's turn, half the turns, 0.8 from
  Awareness 1). YUI's Skill 2 stays 59.6: its +25% to the main target is a damage bonus, already in
  `DPS_KIT_BONUS`. On the real save no best team changed: Kiyoshi's multiplier fell 8%, Mio's 6%,
  Starlight Morgana's 3% and Pioneer Shun's 6% at Awareness 2 (Skill 1 is not in his Awareness 0
  rotation, so nothing there).
  **His six turns are under Rotation** (`tcWonder(...).turns`: each turn's Persona and what it casts,
  or the Persona he attacks with), for your setup and for the suggested one when it differs.
  **His casts go on the damage dealer's heavy turns** (Nov 2026): skill by skill, `tcWonder` places its
  casts on the free turns whose coverage (each turn once, over the fight) holds most of the damage
  dealer's damage, turn by turn from their lufel rotation; a Highlight-only line counts Highlights only.
  Sraosha's unique lands on Kasumi's Highlight turns 3 and 6, as lufel says.
  **Why character-made Personas ranked low** (the user asked, Nov 2026), and what was done: Bishamonten's
  Tower of Purification reads the boss's elemental ailments (`perAil`, below); Sraosha's God's Ear stacks
  are full for a Bless damage dealer whose rotation uses Highlights (`ifBlessHl`); Sahimochi-no-Kami's
  Resonance amplification is a separate multiplier (`resFinal`, as lufel says) and its Serrated stacks
  count the damage dealer's Resonance (`resStacks`, `TC_RES_RATE`: activations a round, judged per kit);
  Pazuzu keeps the foe Cursed (`curse`, the share of turns), which a damage dealer's `curse` bonus reads
  (`tcCurseBonus`: Toshiya's The Other Prison, his own chance and the team's combined). On the real save:
  Bishamonten #35 to #18 for Queen (#7 with Chizuko), Sraosha #26 to #7 for Kasumi, Sahimochi #19 to #9
  for Wavecatcher Miyu, Pazuzu offered at all (+2.5% for Toshiya: his bonus adds into a large ⓑ). Thor,
  Zaou-Gongen and Orobas were right as entered: most of what they do is Wonder's own damage (Thor, the
  +29.1% ATK talents) or lifts a resistance the fight assumes is not there (Orobas's Fire Break).
- **Fuuka's backup is played out in the fight** (Nov 2026, the user asked; it had been averaged).
  From her Global text: Over Oracle stacks start at 3 (level 70+; +2 at A1, where the cap goes from
  4 to 8), +1 per Skill 1 or 3 she casts (+2 per Divine Prayer from A6); Oracle Shift spends 4 (3
  from A6), once a round. The fight swaps as soon as the stacks allow, during the damage dealer's
  turn just before they act ("swap the currently acting ally"): the backup takes one action — the
  skill whose lines alone do most for the damage dealer — then the damage dealer carries on.
  Fuuka's swap lines fire (`on: 'shift'`: Pros and Cons' +10% final damage at A2, 2 turns at A6;
  her weapon's crit damage for 3 turns), and from A2 the backup's Highlight or Theurgy fires free
  with the swap, at most once every 3 rounds, setting off every Highlight trigger. The backup's
  action fills the gauge and counts as a teammate acting (an assumption, said on the page). Its
  passives are off while it waits. Courtesy (her passive 2) adds 4.5% of the backup's ATK, crit,
  damage and Pierce to the party, like the Elucidator share. The seat names the swap rounds. The quick
  screen keeps the averaged backup (`tcMember(..., backup)`, `TC_SWAPS` swaps in six turns).
  **Checked against her full text and the real save (1 Nov 2026), and four things were added.**
  (1) *Her opening wait*: an Elucidator's skills wait her first turn (KIT_ROT `prep`, as Miku's), and
  Mitsuru's Pre-Navigator ("decrease any Elucidator's first cooldown time by 4 actions") cuts it by a
  turn when she is in the party (`tcPrepCut`, `tcKitRot`'s `team`; not as the backup, who arrives too
  late). lufel's second A0 option, acting on turn 1, is that Mitsuru case, so `tmRotPick` leaves it out
  elsewhere; before, the fit chose it everywhere. The wait happens once (`tcUnroll`): cycled as written,
  a 6-turn rotation opening with "-" also idled round 7. A swap also needs a round to have passed (the
  text's "once per round elapsed", JP 1ラウンド経過するごとに), so none is in round 1. Swaps now come on
  rounds 2, 6, 10 at A0 (2, 4, 8, 12 from A1; 2, 3, 5, 6, 9, 10 at A6), `tcFuukaPlan`, which also gives
  the quick screen its `TC_SWAPS` (it had 2 in six turns at A1, where the fight plays 4 in 12). Alone,
  this moves a Fuuka team's number by under 1%. (2) *The backup's start-of-battle effects fire on its
  first swap*, as her text says: TEAM_BUFFS lines tagged `start` (Koromaru's Assist, Mitsuru's A1
  Snowbound; always on for a party member) come on then (`sim.start`, `startEvs`), its battle-start
  Theurgy charge (TC_THEURGY: Yukari and Akihiko A1, Koromaru) is set and a full Theurgy fires at once,
  and a battle-start Highlight-gauge fill (TC_HL_START, `tcHlStart`) lands. (3) *A Highlight's
  permanent effect starts at the first Highlight* (`on: 'HL', dur: 99`): Kumi's DEF down, Pioneer Shun's
  and Starlight Morgana's A4 lines had been always on from round 1 for a teammate and never counted for
  a backup whose Highlight Fuuka's A2 fires. (4) *The backup is chosen by the fight*: the screen keeps
  its best `TC_BACKUP_SHORT` (6) per lineup and `tcFightBackup` re-fights them for the leading
  `TC_BACKUP_FIGHT` (4) lineups shown (0.1-0.2 s a render), at the fit the list is ranked on (`true`).
  Before, the screen's pick was kept: at her A1 it chose Kumi for Makoto Yuki where the fight gave Yukari
  7 points more. Until Nov 2026 the re-fight used the cheaper `'mates'` fit, which with an unrelated test
  line entered chose Tempest Riko for Tropical Motoha (17.7× to Kumi's 17.3×) where `true` and the full
  fit both give Kumi more (18.5× to 17.7×, 19.9× to 18.3×). Knockdowns, which lufel's
  Kumi entry rests on (four swaps to Down the boss, at Fuuka A6), are played out when the page is given
  the boss's Down Points (see "Knockdowns" below); by default a boss cannot be knocked down. On the
  real save (Fuuka A0, Kumi at 196 Speed) Kumi is the fight's best backup for all 17 damage dealers both
  before and after: her Skill 1 puts DEF −48.8% and +39% damage taken on every foe for 3 turns in one
  action, and none of the leading partners brings DEF down. At A2 her lead roughly doubles (her
  Highlight's DEF down now counts on the swap).
- **A render remembers what depends only on the save** (`tcMemo`, Oct 31 2026): the damage dealer's
  own side of every ratio (`tcEvalFor`), each member's vector (`tcMember`) and each search
  (`tcSearch`), keyed on `dataSignature()` plus the busy list, so a change made without `commit()`
  is still seen; an entry point checks the key once and runs `hot` (`tcHot`). Fuuka's backup is
  searched only for the leading `TC_BACKUP_TOP` (40) pairs, the rest of her lineups being priced
  without one (a chosen team with no backup gets its best by the fight, `tcBestBackup`; so does Fuuka
  offered as a replacement for another Elucidator; the leading lineups shown re-check theirs by the
  fight, `tcFightBackup`). On the real save a fresh render went from 0.9 s to
  about 0.1 s and a repeat (a pick, "Use") to 10 ms, with every team and part unchanged. The
  Thieves Den goes into both sides of the ratio (`damageFactors`' `extra.flat`, plus its crit);
  it was in the members' stats but not the damage dealer's.
- **The page leads with the number** (Nov 2026 pass): the team's multiplier as the panel's headline
  (`.tmHero`, lufel's team beside it for scale; on the lufel basis, how many of lufel's picks are
  fielded), then one card per seat (`.tmSeat`, striped in the member's element colour) with the
  member's share of the team as a number and a bar against the largest share (`.tmPart`), what they
  add, and the buttons; the seats were a five-column table that scrolled sideways on a phone. The
  rotation and "How this team works" members are cards too (`.tmMember`), the Rotation blurb is
  folded with `explainHtml`, and Wonder's Persona/card/weapon grid folds under "Wonder's setup" with
  a one-line summary of what is set (`tmWonderSumText`); his Speed stays in the top row. The turn
  order's step numbers are CSS counters, so a step's text is still "Wonder 250 Speed" (a test reads
  it), and the per-factor pills are inline-block for the same reason.
- **The page reads a per-factor summary per member first** ("ATK +126% · crit multiplier +112% ·
  Pierce +38%", `tcSumHtml`, each line at its share of turns), with the kit lines folded under
  "Where it comes from"; a skill not in the member's rotation is named, not quoted. The next teams
  and lufel's are shown against the chosen one in percent; a rotation shows one option open and
  folds the rest; a synergy sentence both pages carry (Fuuka's about Kumi and Kumi's about Fuuka)
  is listed once, keeping the Awareness note (`tmSynergyItems`). A damage dealer seated with an
  entered but empty kit reads "nothing to price", not "+0.0%".
- **"Include a medic"** (`#tmMedic`, a pref, off by default, greyed on the lufel basis; the user
  asked, Nov 2026): one of the two thief seats must hold a medic — lufel's Healer role (Morgana, Lufel,
  Minami, Seaside Tomoko, Yukari, Summer Ichigo) — unless the damage dealer is one. The search keeps
  only pairs with a medic (`tcHasMedic`, the search memo keyed on it), so the medic and the rest of the
  team are chosen together by the fight; healing is not priced, so the medic is the one adding most to
  the damage. Fuuka's backup never counts. The team's only medic is replaced by medics only, a busy
  medic by another, and a team chosen without one gives way. With no medic available the team is built
  without one and the headline says so. On the real save Yukari wins it for Ann, Makoto Yuki, Ryuji and
  Firecracker Rin, at a real cost (Rin 22.4× to 11.7×: Mio goes, Kotone Shiomi stays).
  **The twins are a medic in their Medic masks** (`TC_MEDIC_PAIR`, Nov 2026; the user found them never
  offered): Mischief & Innocence + Service & Admonition, whose Two Masks as One heals. A team whose only
  medic they are holds them to that pair (`tcMedicPairs`, read by `tcSim`'s pair loop), so with the box on
  any lineup priced that way — lufel's team for comparison included — wears it; beside a Healer they wear
  whichever masks do most, and the seat reads "Medic" only in the Medic masks. A damage dealer is a medic
  only by role (`tcIsHealer`), so the twins as damage dealer still get one. On the real save (Nov 1 2026),
  with the twins at Awareness 1, they take Kasumi's medic seat at 19.1× against Yukari's 16.6×; at
  Awareness 0 (the saved Setup) Yukari keeps it, 16.6× to 16.3×.
- A member's part on the page is the team's value with them over without them, so parts do not
  multiply to the total. Replacements are priced as the whole team with them swapped in, and
  lufel's recommended team is priced the same way for comparison in the header.
- **Extra turns for the whole party** (Miku's Virtual Concert: 2 every 6 Wonder actions) are a factor of their own, `turns`: 2 more actions in a six-turn cycle is ×8/6. Buffs that only run during those turns count as uptime.
- **What the fight plays out that used to be judged** (Nov 2026, the user's "do 1-5"):
  - *More foes* (`#tmFoes`, 1-5, a pref): the extra foes are copies of the boss. A damage dealer's
    area skill (`SKILL_DMG` `aoe`, from lufel's KR skill type "광역"), area Highlight, and `DPS_KIT`
    component (`aoe`, else "all foes" in its `why`) hits every foe; an enemy-side buff whose text
    names one foe (`tcOneFoe`: "the target", "a foe"; an entry may say `foes: 'one'|'all'`) is on the
    main target only — a cast's (`one` on the buff) and an always-on one's alike (`sim.constsOne`,
    `X0one`: the board's constants a foe other than the main target does not get).
  - *Round gates* on a `TEAM_BUFFS`/`WONDER_BUFFS` line (`tcGate`): `from` a round, or by Awareness
    `fromAw: [[aw, round], ...]`; `until` a round; `rampAt` the rounds its stacks arrive. They replace
    the judged `up` that stood for a ramp or a battle-start window (Mayumi's Torque Boost, Kotone
    Shiomi's Lunar Bond — counted in the fight since, `TC_LB` — Junpei's Competitive Heart — whose A1 delta lines went, A1 now moving the
    thresholds — Seaside Tomoko's Resonance stacks, Ayaka's Spirit of Rock, Leo's stacks, Wonder's
    Auto-Mataru, Koumokuten and Kushinada). The fight switches them on round by round
    (`sim.gated`); the quick screen and the page's uptime read their share of the fight's rounds,
    so they follow `#tmFight`.
  - *The damage dealer's own timed buffs*: a `KIT_STAT_BUFFS` line with `on`/`dur` (12 lines: Ann,
    YUI, Makoto Niijima, Kasumi ×2, Makoto Yuki, Akihiko's Guardian Fist on 'Punch', Shoki Notte,
    Aigis ×2 on 'TH', Starlight Ann, Summer Ichigo) is always on everywhere else, but the fight
    evaluates the damage dealer without them (`tcEvalFor(dps, true)`, `noTimed` on the setup, in
    `charBaseStat`'s and `damageBase`'s cache keys) and turns each on when the rotation casts its
    skill, before the hit (`tcTimedKit`), so the damage dealer's fit can no longer drop the skill
    that buffs them for free.
  - *Gauge*: Spotlight (Ayaka A4) fills the gauge to 60% on her Highlight (`hlGaugeTo`, fight only),
    Aran's A4 Highlight regains 15, and Prosperity's 4-piece starts the gauge at 25 once whoever of
    the thieves wears it. Mitsuru's Assist is a support-slot skill her lufel rotation never casts,
    so it stays unpriced.
- **The damage dealer's own damage bonuses** (`DPS_KIT_BONUS`, Nov 2026, the user asked): "+30%
  Resonance damage", "Highlight +20% per stack", a weapon's "follow-up damage +26-50%", "Skill 3 +10%
  per stack", an enemy's "damage taken" from their own skill. 222 entries for 29 damage dealers, from
  three hand-checked batches against one brief, each `why` saying what was judged (stack counts,
  chances, which turns of lufel's rotation a window covers). `to` names the hits (`'skill:N'`,
  `'skill'`, `'hl'`, a `DPS_KIT` kind with an optional `match` on the component's `why`, `'all'`);
  a bonus adds into ⓑ for those hits, or multiplies with `amp` ("amplification", "deals 120%"), with
  `after`/`dur` windows on the damage dealer's own skills, tokens, Highlight or Theurgy, `stacks`,
  `chance`, `aw`, `weapon`/`ladder`, and `fewer` (per foe fewer than N). `own()` in `tcSimRun` applies
  them; `tcKitBonusFor` resolves them at the Setup; the seat lists them. A `'skill:N'`/`'hl'` bonus
  does not reach a `DPS_KIT` `hit` of the same cast, so those carry their own `to: 'hit'` entry.
  Because they share ⓑ with the team's damage buffs, they dilute them: on the real save (16 owned
  damage dealers with entries) team multipliers fell 1-16% and the best team changed for Ryuji only.
  Crit, ATK and pierce lines the batches found missing from `KIT_STAT_BUFFS` were reported, not
  entered here. The batches also
  found lufel's "1 / 2" turn (Akechi's Awareness 0 rotation: alternate Skill 1 and Skill 2) read as
  Skill 1 every time; it is spelled out at load (the rotation doubled when needed).
- **The damage dealer's own party and enemy lines reach them** (Nov 2026, the user asked): until then
  only teammates', the Elucidator's and Wonder's `TEAM_BUFFS` lines did, so Mitsuru never had her own
  Frozen Tempest damage taken nor Runa her own DEF down. `tcMemberCalc` with the damage dealer as the
  member (`self`) returns only their `party` and `enemy` lines; `tcSimPrep` puts its events on the
  damage dealer's actor and its constants and gated lines on the board, in the team fight and the
  reference fight alike. Their buffs go on before their hit (like their timed `KIT_STAT_BUFFS`), their
  debuffs on the enemy after it (`castBy`'s filter), so their own 1-turn debuff never meets their own
  hit. `own: false` keeps a line from its own character: 25 that `KIT_STAT_BUFFS` already counts
  (found by stat and skill name, the rest checked by hand) and 3 written for "the other allies"
  (Koromaru's Loyal Dog, Starlight Ren's Upbeat, J&C's Execution of Rebirth); `ownAw: 6` holds Makoto
  Yuki's Cadenza lines until Awareness 6, as the damage dealer casting Ardhanari. The `DPS_KIT_BONUS`
  entries that had stood in for these lines went (Runa's Furrocious and A6, Akechi's Deduction,
  Ichigo's Mine Alone, Makoto Yuki's Cadenza; Translucent Blade kept only his own half), and
  Starlight Ren gained Rhythm's +12 for a Starlight character. The seat lists the lines. On the real
  save (33 owned characters) the best team changed for 3 (Pioneer Shun, Chizuko, Mayumi), and
  characters whose kits are mostly party buffs read much lower as damage dealers (Mayumi −36%, Yukari
  −31%, J&C −27%): their own buffs are now in both fights, so a teammate's add less on top. The
  only once-per-battle lines (`battle`) are Manaka's Da Capo, fired when she is the Elucidator; an
  Elucidator is never the damage dealer, so the damage dealer's own `battle` lines are never needed.
- **`KIT_STAT_BUFFS` lines the kit-bonus research found short or missing** (Nov 2026): Wavecatcher
  Miyu's Mermaid Dreamer is permanent and stacks to 5 (it was counted once), Aigis's Proof and
  Assigned Duty hold 3 stacks in Orgia Mode (once, timed on her Theurgy), Starlight Ann's Fever Step
  and Flickering Dance 4 of 6 (once), and Akihiko's Blitzkrieg crit damage was missing; the
  `DPS_KIT_BONUS` entries that had stood in for the extra stacks went. Lines the always-on rules
  leave out of stats because a Highlight or another ally sets them off are `fight: true`, counted in
  the Teams fight only (`kitStatBuffs(..., { fight: true })` from `tcTimedKit`): Yaoling's Highlight
  ATK (`durAw`: 4 turns from A4), Kasumi's Steps of Faith (`on: 'anyHL'`, `notSelf`) and Ichigo's A4
  ATK per Highlight (`stack: 5`, permanent). Calibration: mean 69.5 (69.6 before), median 71, range
  42-84, bands 8/53/7 unchanged. On the real save no Optimise pick moved; Akihiko's build score fell
  0.4 (the crit damage sits in his perfect build too).
- **The twins' mask pairs** (Nov 2026, the user asked): Justine & Caroline pick 2 of 4 masks before
  battle, and the pair sets their role (Medic, Strategist, Sweeper, Guardian, Saboteur, Assassin), their
  Skills 1 and 2, their passive and Two Masks as One. Only the Strategist pair was entered. `TC_PAIRS`
  now lists the three that help someone else's damage — Strategist (party ATK), Medic (party damage
  +24% passive, Two Masks +43.9% damage) and Saboteur (foes take +24% passive, Two Masks DEF −50.8%) —
  and a TEAM_BUFFS line with `pair` belongs to those pairs only. `tcSim` prices a lineup with a pair
  character under each pair (`tcPairCtx` forces one) and keeps the best, returning `pairs`;
  `tcLineupCalc` holds that pair for the members, their parts and Wonder's (`tcLineupAt`); the quick
  screen takes the pair whose lines alone add most for the damage dealer (`tcPairFor`); the member,
  rotation-fit and fight memos key on the pair. The seat says which masks to equip (`tmPairHtml`).
  On the real save Strategist wins with Ann, Makoto Yuki and Mitsuru, Medic with Frostgale Kotone and
  Tempest Riko, Saboteur nowhere (Kumi's DEF down is already there); the twins still make no top team
  on that save. A team with the twins renders in about 1.6 s (three fights a lineup). lufel's rotations
  are written for the Strategist pair and are read with the same turns for the others.
  **Kasumi's second Glow from the twins** (Nov 2026, the user asked; lufel's partner note): with the twins
  at Awareness 1+ as her Dance Partner, their automatic Two Masks as One is a second skill use in the
  same turn and sets off a second Cinderella Glow. A `DPS_KIT`/`DPS_KIT_BONUS` line with `mate: { n, aw }`
  counts only with that character in a thief seat at that Awareness (`tcMateOk`; `tcKitFor`/
  `tcKitBonusFor` take the lineup, and with none never count it); a `DPS_KIT` component with `byTok`
  fires on that teammate's action only when their turn carries the token ('3↺') and it is their
  `byTurn` [first, last] action since the damage dealer's `byAfter` skill (`mateActs` in `tcSimRun`), so
  the twins' fitted rotation decides how many Glows double. Below Kasumi's A1 it also adds the third
  Lead Step (Highlight +15%, judged like her other stacks; `awBelow` on `DPS_KIT_BONUS`). On the real
  save, twins at Awareness 1: their Kasumi team 17.8× to 19.7×, still under Mayumi / Kotone Shiomi /
  Fuuka's 21.3×. Not entered: Tempest Riko's A6 note (her automatic Storm of Petals fires when the main
  target uses a skill, once per Blossoming Season, and whether that falls in her Dance Partner turn is
  not settled). The twins' Skill Amplification is priced since (next bullet but one).
- **"An ally's skill" is counted per damaging skill** (Nov 2026, the user asked, after the twins' two-skill
  turn): a damage dealer's `DPS_KIT` line `on: 'allySkill'` fires once per skill use in a teammate's turn
  that deals damage by `SKILL_DMG` (`tcDmgSkills`: the twins' "3↺+1" is two, a buff-, heal- or shield-only
  skill none), `'allyAtk'` once per basic attack (`tcAtkCount`: Wonder's attack turn, a blank teammate's
  turn, a Gunshot/Melee token), `'ally'` once per action as before. Until then every teammate action fired
  `allySkill`, buff-only casts and the reference fight's blank teammates included. `allyElem` limits a line
  to teammates of those elements (`opts.by`, also passed on an ally's Highlight); Frostgale Kotone's Wind
  lines had it only in `cond` text. Toshiya's Sonnet of Fate ("every damage instance by an ally") gained
  `allyAtk` lines at 1 Verse. On the real save (Nov 1 2026, twins at Awareness 1): YUI's best team 21.1×
  to 59.3×, now led by the twins, and Mitsuru's 19.3× to 25.3× — mostly because the reference fight's
  blank teammates no longer set off their follow-ups, so "alone" is lower, which is why a number is never
  compared across damage dealers; Toshiya 28.0× to 29.2×; Frostgale Kotone 23.0× to 21.7× (non-Wind
  allies no longer feed her Edge); Kasumi and YUI [Prism] unchanged.
- **Kotone Shiomi's Lunar Phaseshift copies** (`TC_COPY`, Nov 2026; the user asked, "it matters which buffs she
  copies"). Her Skill 3 on another ally copies the buffs that ally has on the Arcana Link ally (the damage dealer,
  a Sweeper or Assassin) onto them again, at 30% for 1 turn (Global; ×1.25 from A2, which lufel's Korean and
  Chinese text give with no condition), and from A6 Wonder's buffs too when the target is not him. The fight
  (`tcSimRun`'s `copyCast`) reads what the teammate (or Wonder) has on the damage dealer at her cast — timed
  buffs as they stand, always-on and gated lines (`sim.ally`, `gated[].ally`) — picks the target whose copy adds
  most to a hit then, and puts one buff per stat on for one action; never the Elucidator (not on the field), a
  debuff on the foe, or a line marked `noCopy` (the game's "certain special buffs" are not named, so none is yet).
  The quick screen (`tcCopyQuick` in `tcMultiplier`) copies each member's averaged buffs (`vec.allyCopy`) at the
  share of turns her Skill 3 covers (`vec.copyBy`), so the sweep's shortlist sees the partner too. A teammate's
  part includes what she copies from them (the fight without them has nothing to copy); her seat lists the
  average copy, the copied seat how often. Fortune's longer durations are still not modelled. On the real save
  team numbers rose 0-8% and the best team changed for 3 of 16 damage dealers (Ann and Tropical Motoha to
  Mayumi, Ren to Beachflower Minami), at no measurable cost.
- **Summer Ichigo's Ram is played out** (`TC_RAM`, `tcRamFor`, Nov 2026; the user asked for the largest
  unpriced gaps to be measured, and this was the largest by far). Heart's Desire (her Skill 3) makes the damage
  dealer the Helmsman; at the end of their next turn they deal 48.3-56.2% of the Boat's max HP plus 173.7-202.2%
  of their ATK (347.4-404.3% when that cast spent a Seal) to all foes, +25% per foe fewer than 5, and step down;
  from A6 they keep the helm and ram every turn, +30% skill damage. The Boat is the field allies' max HP summed
  (+20% at A1; the Elucidator is not on it; Wonder's HP is not tracked, so he counts at the mean of the other
  three). The Korean text has it priced with the Helmsman's Pierce, damage, amp, crit, weakness and Down bonus,
  so the fight (`tcSimRun`, `gain('ram')`) prices the HP part with everything but ATK (`atkAt`: the hit's ⓐ is
  divided back out). Seals: Skill 1 with another Psy member, Skill 2 with another [Summer] one (`tcIsSummer`:
  lufel's "·여름" names). The quick screen prices it too (`vec.ram`, against the damage dealer's mean skill
  coefficient a turn, `tcTurnCoef`): without that the sweep never shortlisted her, and on the real save her team
  was missed for 7 of 16 damage dealers. Measured on the real save with her marked owned (no cards, 6-round
  fight): she leads 13 of 16 best teams, the Ram is 36-70% of the damage dealer's damage, and she falls short
  for Kasumi, Makoto Yuki and Mitsuru. The search costs the same. The DPS_KIT_SKIPS / TEAM_BUFF_SKIPS notes for
  it went; her [Summer] crit-damage Seal line is still a skip.
- **The twins' Skill Amplification is priced** (`skillAmp`, a TEAM_BUFFS key, Nov 2026; the second-largest
  measured gap). Two Masks as One on the Strategist masks gives the other allies 14.6-17% Skill
  Amplification for 2 turns — "increase the values of skills… calculated separately from other effects". The
  fight multiplies the damage dealer's numbered-skill hits and a Ram (a Persona skill) by it, and a skill line
  another ally casts while it is up (`TC_SKILL_SRC`: a thief's Skills 1-3, Wonder's cards and unique skills;
  not a passive, an Awareness, a weapon or a Highlight) lands that much stronger (`addBuff`'s `ampF`). The
  Elucidator is not on the field and gets none. Highlights, follow-ups, Resonance and damage over time are not
  raised: the text says skills. The quick screen raises each member's `vec.skillPart` and the damage dealer's
  skill part by the amp at its share of turns (`tcMultiplier`). On the real save (twins at A1) their team rose
  +1% to +29% (median +20%); they lead Ryuji's (24.9× over 24.6×) and no other. Not entered: Kotone Shiomi
  copying the amp (lufel's partner note: her Lunar Phaseshift can copy it; `TC_COPY.keys` leaves it out), and
  Kotone Shiomi copying her own. Miku's and Kotone's own are priced (below).
- **Yumi's Cocktails are played out** (`TC_CK`, `tcCkFor`, Nov 2026; Invigorating Blend had no line at all).
  As the Elucidator she gets a Mixer of each ally's element per damaging skill use, Highlight, Theurgy or
  Resonance hit (`ckMix`; Wonder's give none, his element being his Persona's); three make a Cocktail —
  Tailor-Made if all match, Standard if two do, Basic otherwise — held up to 3 (4 at A6), and Taking Orders
  starts her with one of the party's most common element. Invigorating Blend spends them all: damage +1% per
  230 of her ATK (capped) per 100% of strength spent (120/100/50%; A6 135/120/75%), ×1.2 on the target, and its
  crit damage only with 2+ Standard or better (TEAM_BUFFS `ck: 'all'`, `'std2'`). Tempting Build spends her best
  one for +120/100/50% of its own ATK buff (`ck: 'one'`; the Korean text says "when cast"), Enchanting Stir
  turns a Basic or Standard into a Tailor-Made; A1's upgrade and Mixer back, A2's +16% per Cocktail (now `on:
  'cocktail'`, `upQ` for the quick screen), A4's Tailor-Made per Highlight and A6's are played too. `ckCast`
  hands her lines their factors as she casts (`addBuff`); a Skill 3 with none spent lands nothing. The quick
  screen takes a typical cast (`TC_CK.quick`, measured on the real save). On save (56), Yumi at A0: her best
  team with each damage dealer rose 5-31% (median 13%), 2.65 strength a cast; at A6 about 5.2 (four
  Tailor-Mades), her teams much higher (Ann's 9.6× at A0, 13.8× at A6); she leads no best team at either.
  Tempting Build's "+120%" is read as ×2.2 (both texts say "increase by", where Skill 3's Korean says "at 120%
  strength"); at A0 it is a median 14% of her gain (−12% to 49%: where it is negative, the Cocktail it spends
  was worth more in Skill 3). Not priced:
  Moonlit Feather's random per-Cocktail buffs.
- **Tempest Riko's SP is played out for Blossoming Season** (`TC_RK`, `tcRkStep`, Nov 2026). Its tier
  effects (flat ATK from 50 SP spent, crit damage from 100 and 150) are granted at **1% strength per 2 SP
  spent**, so the printed values are at 200 SP (her A0 max) and 125% at A2's 250. The Japanese text says so
  outright (ＳＰ消費２ごとに１%分の効果量), the Korean and Chinese as "1% strength per 2 SP"; only the English
  "increase the effect by 1%" can be read as a bonus on top, which an earlier rough test did (+8% at 72 SP).
  Until then the 50 SP tier was entered at full strength always, the 100 SP tier only from A2, the 150 SP tier
  not at all. Her crit-rate line is not scaled. Her SP: full at the start of battle (assumed); each of her turns
  refills `TC_RK.turn` × SP Recovery — nothing publishes a refill, so it is lufel's note that casting it every
  turn needs 480.1% SP Recovery, i.e. 50 SP a turn (10.41 base); Storm of Petals +16 and Arrival of Spring +4
  +12 × SP Recovery (her A0); from A2 +50 after each cast. SP other allies give her is not counted. The fight
  steps her SP each turn (`a.rk`, her TEAM_BUFFS lines' `spT` read in `addBuff`), the quick screen walks her
  rotation (`tcRkQuick`, a floor of 0.001 keeps a tier lufel's rotation never reaches for the fight). On save
  (56), 498% SP Recovery: 189 SP a cast on 3 › 2, her teams +4% to +7% (median 5.5%), she leads none. The
  result rests on the refill: without one, 3 › 2 at 450% gives 72-80 SP a cast and her tiers at 36-40%.
- **A damage dealer's own bonus can be a stat on the hit** (DPS_KIT_BONUS `k`, Nov 2026): `own()` in `tcSimRun`
  collects them as `xs` and `spread` adds them to that hit's board (every foe an area hit reaches), instead of ⓑ
  or a multiplier. Ryuji's Fearless Charge (A2: a skill crit ignores 35% DEF; the Korean text puts it at A3) is
  `k: 'pierce'` 35 on his skills — lufel's defence calculator lists it as Pierce, and his skills always crit
  here; at A2 on save (56) his damage alone +30%, his best team's +33% (the twins / Kotone / Fuuka / Kumi,
  24.1×), nothing at his saved A0. Radiance Motoha's Twilight Radiance is `atkPct` +29.3% × 3 Light (Spear of
  Shadow copies Spear of Light, so the whole Highlight; Light is spent first, lufel never casts Unsetting Sun,
  and from A1 Flowing Light is both), `cm` +30% when both spears hit one foe (`fewer: 2`: only with one foe;
  the two-foe ×1.15 is not priced) and A4's +10% per Flowing Light; marked owned with no cards, her damage
  alone +28% (A4 +36%), her best team's +13% (+17%). An earlier rough test as a ×1.61 multiplier read +36%
  in her team: as a stat, her ATK adds to the team's ATK buffs.
- **The boss's HP** (`tcBossHp`, `tcHpF`, Nov 2026; the user chose it as the largest gap left). Nothing
  publishes how fast a boss falls and the fight length is how long such a fight lasts, so its HP falls evenly
  from full to nothing over the fight, read at the middle of each round (92, 75, 58, 42, 25, 8% at 6). A
  DPS_KIT_BONUS entry with `hp` reads it at the hit's round (`own()`): `{ above: 70 }`, `{ below: 50 }`, or
  `{ missing: true, fullAt }` growing with the HP lost. Entered from a scan of lufel's English text for foe-HP
  conditions: Ichigo's Vorpal Butterfly +200% above 70% (rounds 1-2 of 6), Ann's Trifire bonus hit (30% of its
  damage in La Vie en Rose below 50%, at her La Vie en Rose rate), and Kotone Montagne's missing-HP bonuses
  (Durandal of Ice and Blade Dancer up to 29.3-30.5%, the Highlight's 30% full below 20%, A2's Resonance up to
  50%; "based on missing HP" read as growing evenly). On save (56): Ichigo alone +4.8%, her best team +1.6%;
  Kotone Montagne (marked owned, no cards) alone +10.2%, team +2.4%, her rotation moving Durandal of Ice to the
  last rounds; Ann unchanged (her best rotation never casts Trifire); no best team changed; Ichigo's build
  score +0.05; calibration unchanged. Not entered: lines that depend on the damage dealer's own or an ally's
  HP (Ryuji, Shoki, Leo, Tropical Motoha), Ren's Will of Rebellion stacks per foe below 60% (they feed his
  extra actions, a KIT_ROT counter) and Merciless Pursuit (A6), Yaoling's Up to Chance (her own hit), and
  Belphegor's 40% below 50% (a Wonder on-cast line, which carries no round gate). Cutting the HP faster or
  slower than the fight is not a setting.
- **The damage dealer's own HP** (`TC_HP`, `TC_HP_LEO`, `tcSelfHpF`, Nov 2026; the user chose it next). Played
  only from what the kit text gives as numbers: HP their own skills spend or restore (Ryuji's Pirate Tactics 20%
  unless he has Rebound, Rebellious Spirit's 30% of his ATK with Rebound; Tropical Motoha's Skill 3 15%, Skill 1
  in Summer Hype 10%, Skill 2 and Highlight +20%, +40% Skill 2 at A6), and Leo's Justice Barrier on them (30% of
  their remaining HP spent, the shield — 80% of it plus his ATK part — returned as HP when it ends after 2 of
  their actions, whole, since boss damage is not played) and Highlight (back to 60%, at most 200% of his ATK).
  The boss's damage and other healers' amounts are published nowhere, so HP falls only by the kits' own costs.
  DPS_KIT_BONUS `selfHp` reads it at the hit: Ryuji's Rebound (+30% on Skills 2 and 3 when he began the action
  below 75%), Wounded Glory's +30% beyond its stats +10% (full at 20% HP), Adrenaline's +45% ATK while the
  boss's HP share is above his (KIT_STAT_BUFFS `needHp`: always on in stats, out of the fight's baseline),
  and Tropical Motoha's Highlight +25% above 50%. On save (56): Ryuji alone +21% (HP down to 57%, 2
  Rebounds), his best team unchanged (Kotone / Mitsuru / Fuuka / Kumi, 26.3×), Leo's teams for him +5%
  (4 Rebounds) and still far behind, since the quick screen prices no HP and Leo's value is mostly that;
  Tropical Motoha alone +2%; build scores Ryuji 77.3 to 77.1, Motoha 80.13 to 80.15; calibration unchanged.
  Not played: Leo's Power of Friendship and A6 lines (still judged), Grand Presser's low-HP growth, Shoki's
  Highlight (not owned), and any HP lost to the boss.
- **Kotone Shiomi's Lunar Bond is counted** (`TC_LB`, Nov 2026; the user asked which judged numbers the fight
  could count, and she is in all 16 best teams on the real save). On the Arcana Link ally (the damage dealer, when
  a Sweeper or Assassin): 0 at the start, 5 from A1, +1 per Persona skill they cast and per Lyre's Melody she casts
  on them (Korean 페르소나 스킬: Highlights, her Skill 2 and Skill 3 add none), at most 10. Her TEAM_BUFFS lines
  carry `lb` (the level they need: ATK +50% at 1, Pierce +15% at 5, crit damage +50% at 10) and read it in `curX`
  instead of their round gate; her weapon's amplification (TC_SELF_AMP `lb`) reads it through `ampAt`. The quick
  screen keeps round estimates, Lunar Bond 10 moved from round 5 to 6 (4 at A1) to match what the fight reaches.
  On save (56) it reaches 5 in round 2-4 and 10 in round 5-6 (never for Haru and Makoto Yuki), so every Kotone team
  fell 1-11% (Ren and Kasumi most). Two search changes came with it: the list's fit (`true`) fits Kotone's rotation
  in the fight (`timed`, one pass, as for Mio), since how often she casts Lyre's Melody now decides the team (her
  team for Kasumi was 7th on the list's fit and best fully fitted, 29.0×; in the first pass too it doubled the
  search's time for the same leads); and a Fuuka team's close runner-up backup (`alt`, within `TC_BACKUP_ALT` 3% on
  the list's fit) is fought fully too and takes the team's place if it wins (Kumi over Tempest Riko for Haru). Best
  teams unchanged for all 16; the search about 23% slower (2.0 to 2.4 s a damage dealer); calibration unchanged.
- **Ichigo's Lovesick is played** (`TC_LS`, `lsTick` in `tcSimRun`, Nov 2026). lufel's data never defines the
  status; the in-game tooltip does (the Mega Ten wiki's copy, which the user pasted): "Each turn, take Curse
  damage equal to 6%/12%/18% of Ichigo's Attack (at level 1/50/70). This effect lasts 4 turns, and stacks up to
  10 times." So 18% of her ATK per stack on each enemy turn. Vorpal Butterfly adds 2, Obsessive Rose 4, every
  skill 1 more from A1, cap 15 from A6. From Prydwen's guide: each skill that inflicts or refreshes it (My Beloved
  Prince resets its duration) takes a snapshot of her buffs and the foe's debuffs, all but her crit, dealt for
  the next 4 turns; it ignores her Pierce and counts DEF down; it crits only in the 3 turns after her Highlight,
  which sets it off 3 times at once (continuous damage once, Lovesick 2 more). Continuous-damage buffs reach it
  (DPS_KIT_BONUS `to: 'dot', match: 'Lovesick'`: her Melting Ichi-Go Butter and A0's 3 Chains of Love; the
  team's `dotDm`). Melting Ichi-Go Butter now also gives teammates +15% `dotDm` (`own: false`). On save (56):
  her damage alone +57%, Lovesick 37% of it (21% in her best team, whose Pierce it ignores), 12 ticks in 6
  rounds at the 10-stack cap; her best team unchanged (Beachflower Minami / Kotone / Fuuka / Kumi), its damage
  +18% though its multiplier falls 25.1× to 18.8× (her alone rises more); build score 83.08 to 83.05;
  calibration unchanged. My Beloved Prince reads the stacks on the boss as she casts it (the user asked): its
  per-stack part through DPS_KIT `ls` ([from, to]: the stacks counted in that range, the quick screen taking the
  cap), its bonus hit only at 10+ (`s3At`; it is 118.7 of SKILL_DMG's 373.5, the same share at every tier,
  `s3Share`). Her damage alone did not move (her rotation reaches 10 first), but her best team's fitted rotation
  had cast it at 8 stacks with the full bonus; it now waits for 10, and that team reads 18.1× (was 18.8×).
- **Makoto Niijima's Nuclear Finisher ATK** (Nov 2026): her 5★ weapon's +30-57% ATK "when attacking a foe with
  an elemental ailment" is a KIT_STAT_BUFFS line with `needAil: 'any'` (any elemental ailment, `ailOn` in
  `tcSimRun`): always on in her stats and build score, like Firecracker Rin's Burn lines, since her own skills
  keep one on the boss; in the fight only while the boss carries one. On save (56): her damage alone +8.1%,
  her best team +4.2% (Beachflower Minami / Kotone / Miku, unchanged); build score 75.87 to 75.53 (the
  perfect build gains it too, and ATK% rolls are worth a little less beside it); Optimise's pick unchanged;
  calibration unchanged.
- **Miku's own Skill Amplification** (`TC_SELF_AMP`, `tcSelfAmp`, Nov 2026): Hologram Screen (A1) gives her 15%,
  her 5★ weapon 10-19% while Virtual Concert is active. It raises the values her own skills grant (Korean 스킬
  효과 증폭), so `tcMemberCalc` multiplies each of her skill lines (TC_SKILL_SRC; caps included, as the twins'
  amp is read) by it, which the quick screen and the fight both read; never a count (Showstopper's extra turns),
  a passive, an Awareness or her weapon's own lines. The weapon part reaches only a line cast in Virtual Concert
  (`tcIsVc`: Showstopper's crit damage); Feel the Beat and Clear Sound are cast before it. On save (56), her
  saved A0 and R0 weapon: +0.1% (the weapon part alone). At A1 her teams +4% (median, 3-10%), and she leads
  Yusuke's best team too (she already led Makoto Niijima's), and Akihiko's (27.0× against 25.6×), which the
  search missed until each Elucidator's best team got the full fit (the bullet on fitting teammates above).
  **Kotone Shiomi's** 5★ weapon (Vetri Vel Muruga) gives her 10-19% once the Arcana Link ally reaches Lunar
  Bond 5 (`lb`: from round 3 at A0 and round 1 from A1, the rounds her Moment of Truth pierce line judges).
  That part comes on mid-fight, so her skill events carry `ampAt` (the factor at the cast's round, read in
  `addBuff`) and the quick screen takes its share of the fight's rounds. Not applied to Lunar Phaseshift's
  30% copy rate. On save (56) her teams +2.7% (median, −1.2% to +4.4%, with `TC_FIT_STEPS` at 2); she was
  already in all 16 best teams, and Ryuji's moves to Kotone / Mitsuru / Fuuka / Kumi (25.8×). The one that falls
  (Ryuji's twins team) rises 2-4% at every cheaper fit and falls only under the full fit, a local search that
  settles elsewhere from a different starting point; at one step a pass Ichigo's fell too.
- **Shoki's Improv states** (Nov 2026): he switches state each turn, and his Skill 3 gives the main
  target crit damage (Electrifying Performance, the only one entered before), pierce (Tempestuous
  Drama), damage over time (Blazing Passion) or Technical Precision (Chilling Intensity, with its +20%
  ATK for a damage dealer whose kit activates Technicals — see Technicals below). They are `TC_PAIRS` options like the twins' masks, and the seat names the state
  (`TC_PAIR_LABEL`). On the real save pierce wins for every damage dealer tried (Kira, Ann, Mitsuru,
  Makoto Yuki), 4-11% above the crit-damage state. A scan of lufel's English and Korean kit text for
  other set-up choices found none that changes a team's damage: Aran and Radiance Motoha choose
  targets, Akechi's partner and Fuuka's backup are already modelled, Pioneer Shun's Presser mode is
  in his rotation. `resDm` and `dotDm` are team-buff keys now (`TC_KEYS`); only Shoki's Blazing
  Passion uses one so far, so other kits' Resonance and damage-over-time buffs in `TEAM_BUFF_SKIPS`
  can be entered.
- **Beachflower Minami's medicines** (`TC_MEDS`, Nov 2026; the user asked which item her rotation uses).
  lufel's rotations write her medicine turns as ⓘA/ⓘB/ⓘC with no names; lufel's review of her lists eight:
  three free (ATK +30%, DEF +45%, damage +25%) and five bought (damage over time, Resonance, One More /
  All-Out Attack, Highlight / Theurgy +10% each as a multiplier of its own, Technical Precision +600). Each
  is 1 turn on one ally, 2 through Flower Basket Pharmacy (every ⓘ turn in her rotations) and 3 from A6;
  her medicine effect increases (A1 +20%, her 5★ weapon +20-38%, `tcMedBoost`) raise them all, and
  Blossoms by the Beach adds ATK +15% per kind held, so the three slots hold three different medicines.
  Until then none was priced and her medicine crit-damage lines had judged uptimes; all now fire on the
  ⓘ tokens (`tcTurnSkills` reads them as `iA`/`iB`/`iC`, `TC_MED_ON`). The choice is a `TC_PAIRS` option
  with one entry per damage dealer (`tcMedOpts`): each medicine held all fight in the damage dealer's
  own fight (`tcMedRank`), the best three into A, B, C. Other orders were tried in the fight and dropped:
  a composed rotation already picks which slot each medicine turn uses, so an order only relabels, and it
  doubled a search with her for +2% at most. The DEF and One More / All-Out Attack medicines are never
  priced and only fill a slot. The seat and the Rotation panel name them (`tmMedsHtml`, `tmMedCell`, and
  `tmTokenText`'s `meds`). Global's English names are not in lufel's data; they go by effect. On the real
  save: Wavecatcher Miyu ATK / damage / Resonance, Ichigo ATK / damage / damage over time, YUI [Prism]
  ATK / damage / Resonance (lufel's partner note says All-Out Attack, which is not priced), Yusuke (a DEF
  kit) damage / Resonance / Highlight, most others damage / ATK / Highlight. Her best team rose 5-10%
  (Wavecatcher Miyu 15.4× to 16.6×, Ann 18.8× to 20.3×, Ren 18.9× to 20.5×) and now leads for Miyu and
  Ann over Mayumi's; the search took no longer. The ranking is the damage dealer's fight alone; the team
  is the composer's to weigh: in Miyu's best team (Kotone adds +143% ATK) her rotation puts the Resonance
  medicine on most medicine turns and never uses the ATK one, which the list under it says. With composing
  off, lufel's ⓘA turns play the ranking's first.
  **Her Highlight strengthens her next medicine** (`tcMedHlBoost`, the user asked): +9.8-11.4% by tier, +5% more
  from A4, added to her other increases. lufel's Korean text says the next medicine (다음번 약품 사용 시) for both,
  where the English reads as every one; the fight spends it on her first medicine after each of her Highlights
  (`medNext` on her actor in `tcSimRun`, the medicine line's `fx`), the quick screen leaves it out. **Soothing
  Sunlight's Blessing stacks are permanent** (no duration printed; the user's reading): two a Summer Garden (its
  own "grant all allies 1 Blessing stack" plus the passive's, the user's reading) and one a Gentle Sea Breeze, up
  to 6 (+36%), from 0 at the start. A TEAM_BUFFS line with `build` is that shape — `true` for a stack a cast, or
  the stacks per skill (`{ '2': 2, '3': 1 }`, `tcBuildGain`); `stacks` is the cap and the line's value the whole.
  The fight lands a turn's stacks per cast, the quick screen reads the average over the fight (`tcBuildMean`),
  and the page shows the share of the whole held.
- **Kira's Bleed counts its Almighty part** (Nov 2026): 1% of the target's max HP per stack a turn,
  capped at 60% of his ATK (×1.5 from A1), entered at the cap since a boss always reaches it. Only
  lufel's Korean and Chinese text print the cap; the English and Japanese do not, so Global having it
  is an assumption the `why` and the seat's notes say. It takes his damage over time from about a
  quarter of his damage to about 60% on the real save's numbers, and moves his best team. Almighty
  takes no weakness bonus: a `DPS_KIT` component with `noWeak` and an Almighty skill or Highlight
  (`SKILL_DMG` `alm`, from lufel's Korean element 만능: Akechi's Skill 3 and Highlight, Starlight
  Ren's Skill 3, the twins' Highlight) skip the weakness factor in the fight; the same
  Korean text counts all his skill and Highlight damage as damage over time, which is not modelled.
- **Elemental ailments on the boss** (Nov 2026; the user: "the ailment thing is very important for Queen,
  this is why her best ally is Vino"). Queen's Chief Strategist (+15% ATK per kind of elemental ailment on
  foes) was priced nowhere, and her Thermonuclear Fury, Highlight and Nuclear Finisher read a judged two.
  The fight now tracks Burn, Freeze, Shock and Windswept on the main target, and Radiation, which counts
  only with Chizuko (Vino) in the team (her A0): `TC_AILMENTS` (58 sources for 31 characters, from one
  research pass over lufel's English and Korean skill, Awareness and weapon text, Nov 2026; Korean used
  where they disagree; durations lufel does not print taken as 2 turns) says what each kit inflicts,
  on which skill or token, how often, for how long. 'any' takes a kind the target lacks; a chance is a
  running tally, so it plays the same every time; ailments count down after the enemy's turn. Rare
  triggers are a judged share of turns (Ann's La Vie en Rose, Kotone Montagne's Blade Dancer, Kayo's
  Beat, Kiyoshi's Chosen One, Junpei's Center Stage); Frostgale Kotone is read in Spring mode. The boss's
  ailment resistance is not modelled. Readers: `TC_AIL_SELF` (Queen's Chief Strategist and A2 pierce),
  DPS_KIT `perAil`/`ailNone`/`notAfter` (Thermonuclear's Technicals, Nuclear Fury's on an ailing foe
  only), DPS_KIT_BONUS `perAil: [lo, hi]`/`perHeat` (her Highlight's Frenzied Voltage, Nuclear Finisher's
  Heat), and a TEAM_BUFFS/WONDER_BUFFS line's `ailMin`, `perAil` or `ailOfElem` (Chizuko's A0, Eagle Eye,
  A1, A6 and Gravitational Force; Bishamonten; Arc Knife). The quick screen reads lines at
  `TC_AIL_QUICK` (2) and a damage dealer's own at what the team's rotations supply (`ail`, `tcAilSupply`).
  The fight note gives the boss's average count. On the real save the boss carries 1.5 with Queen alone,
  3.3 with Chizuko at her saved Awareness 0 and 3.9 at Awareness 6, where Chizuko joins Queen's best
  team (16.7×); at Awareness 0 Minami and Kotone Shiomi still lead (16.5×). Her Setup there has no
  Awareness set, which is worth checking.
- **Technicals and Technical Precision** (Nov 2026; the user: Firecracker Rin's kit is built on them and Mio
  is made for her, yet Mio never appeared in Rin's teams). lufel's guide (`technical-master`, recorded in
  `docs/DATA-SOURCES.md`) gives the rules: a skill that "can activate a Technical" does so on a foe with an
  elemental ailment — Fire on a Burning foe is Fireburn (+2% that skill's damage; 20% for Rin's Yanhua
  Slash), Ice on a Burning foe Iceburn (Fire/Ice damage taken +5%; Mio's Skill 3 always gets it and makes it
  Cold Flames, up to 39-45% damage taken) — and Technical Precision scales them, linearly: Fireburn +10% of
  itself per 100 points, Iceburn and Cold Flames +5% (`tcTechScale`; the guide's own checks, 68.1% → 102.15%
  at 1000 and 113.9% at 1343, are a test). `tp` is a team key (Mio's Skill 1 +195-207, her Scald +1186-1381
  on a Burning foe, Shoki's Chilling Intensity +655-749); the fight scales a `tech: 'taken'` line or a `tech:
  'fire'` bonus by the points up at the hit. `needAil: 'Burn'` gates a line on the fight's ailment tracker
  (above): a TEAM_BUFFS cast line lands only if the foe Burns when cast (Scald, also `noRefresh`; Cold
  Flames; Iceburn; Mio's weapon), a DPS_KIT_BONUS or always-on line counts while it Burns at the hit (Rin's
  Fireburn and weapon, Ann's +30% and Fireburn, Kiyoshi's Fireburn). Mio's Scald entry in `TC_AILMENTS`
  renews a Burn only (`ifAil: 'Burn'`, now a name or any), so she is not her own Burn source. The quick
  screen puts `needAil` lines in `vec.need` at full value and `tcMultiplier` reads them at the share of turns
  the whole lineup keeps the foe Burning (`burn`, each member's `tcBurnSupply` combined as independent
  chances), so Mio beside Rin alone is priced without Burn and Mio + Koromaru with it; the damage dealer's
  own Burn bonuses enter through the share of their fight-alone damage they reach (`tcTechMix`).
  **Rin Burns for good only from Awareness 2**; below it her one Burn is Skill 2 (90%, 2 turns), which
  none of lufel's A0/A1 rotations cast, and lufel's own note on Mio says her Skill 1 needs a Burning foe.
  Three things make Mio work at A0 (the user: she was made for Rin at any Awareness): `TC_ROT_ADD` lets
  Rin's fitted rotation put Skill 2 on up to 2 of 6 turns in place of a plain Skill 1, below Awareness 2
  only; Prosperity in Red (and A2's Festival Colors) carry `needAil` in `KIT_STAT_BUFFS`, so stats and build
  scores keep them always on while the fight leaves them out of its baseline (`noTimed`) and counts them on
  a Burning foe (`ailSelf`), which is what makes the Burn worth a Skill 1 to her; and a lineup with a
  member whose lines need a Burning foe gets a one-pass fight fit of that member (and the damage dealer,
  and the reference fight alike) in the search's cheaper passes too (`tcSimFitTeam`'s `opt`), because the
  timing decides it — Mio (Speed 106) acts before Rin (98), so with lufel's 1 › 3 her Skill 1 never met
  Rin's Burn (it lands after Rin's hit and is gone by Mio's next Skill 1) and only 3 › 1 lines them up.
  On the real save at A0 Mio / Kotone Shiomi / Fuuka (backup Kumi) now leads at 18.5× against 16.0×
  (Rin: 2 › 3+Melee › 2 › 3+Melee › 1 › 3+Melee; alone she takes Skill 2 too, for Prosperity in Red); at
  A2 it leads at 20.5× against 18.1× with Mio in six of the ten. A fresh Rin render is about 2.7 s
  (from about 2). Runa's boss rotation (2 > 3) never casts the Skill 1 that Burns. **Fireburn is a multiplier of its own** (`amp` on its DPS_KIT_BONUS entries: ×1.2 on
  Rin's slash, ×1.4 at 1000 points), the user's choice on this evidence: lufel's damage article says only
  that a "damage increase" is ×1.2 for some kits and +20% for others, but a Taiwanese test write-up
  (Bahamut thread "P5X 傷害計算公式探討", 2024, and its linked study "P5X傷害計算公式及其詳細證明" v2.0, §4)
  measured a Technical's damage increase (Wonder's Cosmic Flare, +22% on an ailing foe) as an independent
  multiplier — predicted 880/924/836 as one, 853/895/810 as an addition, observed 880/923/837 — and Rin's
  Chinese text calls her 20% "the TECHNICAL effect". The same study names Ann's passive 熱忱 (her +30% on
  Fireburn) as additive, and damage taken (Cold Flames, Iceburn) is in ⓑ, so those stay additions; Rin's
  weapon (+34-64% "damage" on a Fire Technical) is untested and left additive. Read as an addition, the
  Technical Precision Mio adds to Rin's Fireburn was nearly all diluted by her other bonuses. Not priced: Windburn,
  Short Circuit, Deepfreeze, Freeze and Shock as Technical triggers for Mio's weapon, Happy New Year!'s
  51% (kept at 42%).
- **Knockdowns: the boss's Down gauge** (Nov 2026; the user asked, and answered the rules from play).
  `#tmDown` (a pref, in `tcAssumeKey`) is the boss's Down Points as its gauge shows them; 0, the default,
  is a boss that cannot be knocked down, since most cannot. The fight (`downAct`, `downHl`, `knock` in
  `tcSimRun`): every skill use that hits the boss's weakness removes 1 however many hits it has (the
  user: "1 per skill"); a damaging Highlight or Theurgy and Wonder's attack turn count the same (assumed);
  the reference fight's blank teammates remove nothing (with them attacking, the damage dealer alone was
  knocked down more often than with a team of buffers, which read against their own Down bonuses);
  follow-ups, Resonance and damage over time remove nothing. Kumi's Lightning Legs is a state
  (`TC_DOWN_STATE`): her Skill 3 knockdown opens it for her next 2 actions and her next Skill 1 or 2 uses
  it; lines, cuts and bonuses with `state` count only in it. A cut with `next` (Riko's Insight, Mayumi's
  Highlight) waits for the next ally hit that deals damage; `afterHl` holds a line until its owner's first
  Highlight (Kumi's A4); a teammate's turn tokens ("Special", "Punch") fire their lines as the damage
  dealer's do. A KIT_STAT_BUFFS line with `needDown` stays in the stats but out of the fight's baseline,
  where a knockdown-triggered line replaces it (Kumi's Role Model, a stack per knockdown she makes). `TC_DOWN_CUT` is a kit's
  cut "regardless of affinity" — that many in place of the 1 when larger, or on top with `extra`, `step`
  for one whole turn (Kotone Shiomi's Skill 2 in her Fortune burst), `maxCut` on 'knockSelf' for a lower
  maximum. At 0 the boss is knocked down until its own turn at the end of the round, **which it still
  takes** (the user), then gets up with its gauge full; so a knockdown helps only the hits after it in
  that round, plus what it sets off. TEAM_BUFFS lines with `down: true` count only while it is down (a
  constant one in `downX`, a cast one as a buff flagged `down`), `on: 'knock'` lines fire on any knockdown
  for members on the field and `'knockSelf'` for the knocker (with `stackMax`); DPS_KIT and DPS_KIT_BONUS
  entries take `down` and `after: 'knockSelf'`; the damage dealer's own stats against a downed foe are
  KIT_STAT_BUFFS lines with `down: true, fight: true` (`downSelf`), never in their stats. "Damage taken
  while knocked down" is a multiplier of its own (`downDm`, lufel's damage article ⓗ). The quick screen
  leaves every such line at 0 and the fight prices the leaders. The fight note gives the knockdown rounds.
  The kit lines came from one research pass over the 20 kits whose lufel text mentions Down (two batches,
  one brief, hand-reviewed); All-Out Attacks, Dizzy and Wonder's Personas are not entered.
- **Not priced, and the page says so**: other extra actions (Narumi's for Wonder, Mayumi's own) and
  Wonder's own damage, weakness creation, All-Out Attacks and Dizzy, Technicals (beyond the ailment readers and the Technicals above), Wonder's own
  ailments, the boss's ailment resistance, team and Persona lines that hang on the boss's HP (Ren's Will of
  Rebellion below 60%, Yaoling's Up to Chance, Belphegor's 40% below 50%; the damage dealer's own are priced, see
  "The boss's HP" below), HP lost to the boss and healers' amounts (the damage dealer's own HP is played from
  their kit's costs, "The damage dealer's own HP" below)
  or a specific teammate (what is left in `DPS_KIT_SKIPS`), always-crit and DEF-ignoring components,
  healing and survival, buffs copied from other buffs (other than Kotone Shiomi's Lunar Phaseshift), and a supporter's Theurgy gauge from teammates. The number ranks teams
  for one damage dealer; it is not a damage forecast and is never compared across damage dealers.
  Moving from averaged uptimes to the fight took most real-save numbers 5-15% down (the gauge cannot
  give every member a Highlight every 4 turns, and the first round has none) and moved a few teams
  (Mitsuru into short fights).
- **Rotations composed from the kits** (`KIT_ROT`, `tcCompose`, Nov 2026; the user asked the planner to
  write rotations itself rather than re-choose lufel's plain turns). "Compose them from the kits"
  (`#tmRotCompose`, a pref, on by default, greyed while "Fit rotations" is off) writes each member's
  rotation for the fight, as long as the fight plus two turns, from the kit's own moves:
  - **What a kit allows is `KIT_ROT`** (in `logic.js`, between `KIT_ROT begin/end` markers): per character
    the moves (lufel's turn strings, plus any skill it can cast as a turn) and the counters that gate them
    — `res` [start, cap], `turn`/`ally` gains, and per move `need`/`max`/`spend`/`gain`/`set`/`flip`,
    `cool`/`group`, `uses`, `next` (a forced Fatigue), `aw`, `mind` (a completed Mindscape) — with `aw`
    blocks per Awareness, a `cool` array replacing lufel's skill cooldowns, `spBudget: false` where a kit
    counts its own SP (Starlight Ann, Wavecatcher Miyu), and `caveats`. Researched for all 68 in four
    hand-checked batches against one brief, from lufel's English and Korean skill, passive and Awareness
    text (Korean where they disagree); each `why` says what was read and what judged (teammate-fed
    counters through `ally` are judged rates). **Rules say what is possible, never what is good.** A test
    holds every lufel rotation legal under them, each at its own Awareness; a lufel option that cannot be
    legal means the rule is wrong. `tcKitRot` merges the blocks, `tcRotWalk`/`tcRotStep` play a rotation.
    The one team-dependent rule is an Elucidator's opening wait (`prep`: Fuuka, Miku, Manaka), one turn
    shorter with Mitsuru in the party (`tcKitRot`'s `team`); an option legal only with her (Fuuka's second
    A0 option) is legal for the test with her, and `tmRotPick` offers it only in her teams. The wait is
    played once, not once per cycle of a rotation (`tcUnroll`).
  - **SP refill is not known** (nothing publishes it; the user did not know), so lufel's rotations stand in
    for it: no more SP per turn, by lufel's SP costs (`SKILL_DMG` `sp`, Korean where the English lacks one;
    none is an HP skill), than the costliest of lufel's options at that Awareness, nor further ahead of
    that pace than any of them runs (`tcSpRule`).
  - **The search** starts from lufel's options and the rotation the member has, changes one turn or swaps
    two at most `TC_COMPOSE_SWAP` (3) apart, re-chooses later turns the change made illegal
    (`tcComposeRepair`, lufel's most used moves first), keeps the best change while it gains
    `TC_COMPOSE_MIN`. Idle turns ("-", "·") are never offered (chosen freely they only delayed Fuuka's
    Oracle Shift, which the fight spends at once); Highlight/Theurgy turns only for a kit whose Highlight is
    free. It runs in full for the damage dealer alone (the reference fight) and in the teams fitted in
    full, one pass for the damage dealer in a lineup whose timing matters (a member needing a Burning foe:
    without it Mio's team for Rin was priced on rotations composed for other teams and never led), and
    once per member on the quick screen; every other fight chooses among lufel's options and what those
    found (`tcMemo.pool`, `tcMemo.rot`). A render is 2.5-4 s on the real save (1.8-2.7 s fitting lufel's).
  - **What it exposed.** A damage line whose uptime was judged from lufel's rotation but not tied to the
    skill that earns it is free credit once the rotation can drop that skill: Wavecatcher Miyu's Catch a
    Wave, Offshore and Surf stats, and Yusuke's taunt counters and shield stats, were. They now follow
    the skill (`after`/`on` with `dur`, so lufel's rotation prices exactly as before), with `alwaysAw` for
    an Awareness from which the state holds for good (Miyu's A6; her Surf is now played out instead, see
    `TC_SURF` below). Ryuji's charge/hit and Starlight
    Morgana's Waltz/Crash! alternate through a `flip` counter, which keeps their averaged Skill 3 price
    true. `tmRotPick` now drops lufel's "Mindscape Core" options for a character whose Mindscape is not
    complete (`tmMindDone`; the Setup has no Core field, so complete stat and skill paths stand in). The
    other judged lines found (YUI, Akechi A1, Tropical Motoha's weapon, Frostgale Kotone's A4) under-credit
    a composed rotation rather than over-credit it.
  - **Measured against lufel on the real save (Nov 2026)**: on one boss the composer moves Ann to Trifire
    (Skill 2) every turn, +25% — lufel's 3,1 is a multi-foe rotation, and at 3 foes the composer writes
    it back (+0.3%); Ryuji mixes Skill 1 between charge/hit pairs (+4.5%; Skill 3's low-HP growth is not
    priced); Wavecatcher Miyu cast Aerial Tide (0 SP) almost every turn (+21%; that was the judged Surf
    window, since replaced by the Surf engine below); Makoto Niijima at A3
    and Ann at A6, for which lufel writes only A0, gain 10-25%. Most others land within a few percent of
    lufel. Teams differ far more: lufel's parties were written at each character's launch (for 13 of 16
    damage dealers no party member is newer than the damage dealer), so Fuuka (#54, with Kumi as backup:
    Hard Knocks on every Oracle Shift is most of her value — 14.8 without, 21.2 with), Kotone Shiomi (#52,
    in no lufel party) and Beachflower Minami (#47) are missing; Leo's value for Ryuji (lowering his HP)
    and healers' survival are not priced; unowned picks (Kayo, Junpei) price without cards.
  - **The search also starts from lufel's options for other teams** (`tcComposeSetup`'s `others`, Nov 2026):
    every option lufel writes at the member's Awareness, including one labelled for a teammate who is not
    in this team ("with Manaka"). It is still a play of the kit; it is not shown as lufel's for this team.
    Wavecatcher Miyu's 3 › 1 › 1 › 1 › 1 › 2 is several changes away from her 3 › 2 › 3 › 2, each of
    which loses on its own, so the search never reached it. No measurable cost; the other damage dealers
    tried kept their rotations.
- **Wavecatcher Miyu's Surf is played out** (`TC_SURF`, Nov 2026; the user: 3 › 1 › 1 › 1 beats 3 › 2 › 3 › 2
  because Jellyfish Splash keeps Surf and Catch a Wave fires on far more of the teammates' turns). Until then
  Surf was judged as "Paddle Out's turn and the next", Catch a Wave as a fixed share of ally actions (0.5,
  0.75 from A1, 1.0 at A6) and the Offshore stacks as fixed counts, so 3 › 1 › 1 › 1 lost Surf on turn 3
  and the planner rated it 17% below 3 › 2 › 3 › 2. From lufel's text: only Aerial Tide or Paddle Out again
  ends Surf; the fight tracks her SP (15 at the start of each other ally's turn and 40 per Splash, times her
  SP Recovery; Splash up to twice the 200 max; Paddle Out 60), Surf and the stacks, and fires Catch a Wave
  at the end of another ally's turn when she has the SP (30 + 30 a stack, +5% a stack; A1 40% cheaper, cap
  6; A2's free 4th; A6's Surf for good, refilled SP). Her Surf lines (`KIT_STAT_BUFFS` `on: 'surf'`, `hold`)
  are on while Surf is, Surfing Mermaid's four buffs come at 100/200/300/400 SP recovered (`on: 'sp100'`…),
  Aerial Tide takes +10% a stack in Surf, the Highlight's second hit (a third of it) lands in Surf only, and
  her Highlight waits for Surf when her next turn enters it. On the real save (326.7% SP Recovery, with
  Mayumi, Kotone Shiomi, Fuuka and Kumi) 3 › 1 › 1 › 1 › 1 › 2 holds Surf all 12 turns for 20 catches and
  beats 3 › 2 › 3 › 2 (18) by 9%, and the fit chooses it. It depends on SP Recovery: at the test fixture's
  ~189% (no cards) Surf held through Splash catches less often than 3 › 2, whose Aerial Tide resets the
  stacks and so the cost; a test pins only the mechanics. Aerial Tide outside Surf is still allowed (lufel:
  0 SP, no cooldown).
- **Heals are played out for a kit that reads them** (`TC_HEALS`, Nov 2026; the user: Tropical Motoha
  performs better with a healer). Her kit turns on when healed (Energy Overload! +30% and Summer Starts Here!
  +25% damage for 2 turns, Stay Cool!'s crit damage at A2, Bubble Puff Star in Summer Hype), and 5 heals give
  a Tropical Heart, which lets Surf 'n' Shine skip its cooldown — lufel's partner notes give her healers for
  exactly that. Before, the healed bonuses were judged on at 0.9 from Awareness 1 and not counted at all
  below it, even with her own Skill 2 and Highlight healing her, and no teammate's heal counted anywhere.
  `TC_HEALS` lists who heals the damage dealer and when (skills, Highlights, Beachflower Minami's medicines,
  Ayaka's Chorus on any Highlight, Seaside Tomoko's Resonance after an ally acts, heals over time, Blessing),
  from lufel's English text; "the ally with the lowest HP" reaches her at `TC_HEAL_LOWEST` (0.5, judged), and
  Blessing is a heal at the start of her turn, once a turn (assumed: her text counts "healing received from
  Blessing" once per turn). The fight (`healDps`/`healFrom`/`healAll` in `tcSimRun`) fires her
  `KIT_STAT_BUFFS` lines `on: 'healed'`/`'healedHype'` (fight only, `upTo` for stacks) per heal: a heal
  during her own action lands after its count-down, so "2 turns" covers her next two actions. The quick screen
  prices a member's heals (`vec.heal`, `tcHealSupply`, `tcHealQuick`: a Poisson rate). Her `KIT_ROT` was
  rewritten: the old single counter capped at 4 let idle turns bank Surf's cooldown, so alone she could cast it
  three turns running; now `cd` is the 1-turn cooldown (never banked), `ht` the heals toward a Heart, and a
  cast pays with a Heart first (`alt`, a new rule primitive). In a known team `ally` is the heals its members
  give her a round on their lufel rotations (`allyHeal`, `tcTeamHeals`); with none, enough for lufel's
  rotations (whose 3, 3 opening needs a Heart by her second turn). `tmRotPick` drops a lufel option the team
  cannot heal for, and the fit then plays a composed one even if it prices lower (`tcSimFitDps`); her
  rotation is fitted in the search's cheaper passes too. The fight note says how often she was healed and
  by whom. On the real save at Awareness 0: lufel's Minami / Leo / Yumi team 2.81× to 3.18×, Seaside Tomoko /
  Ayaka / Futaba 5.59× to 6.16×; the best team (Beachflower Minami, Kotone Shiomi, Fuuka, Kumi) 17.70× to
  18.05×, and the best team without a healer (Mayumi, Kotone Shiomi, Fuuka, Kumi) 15.21× to 14.09×. Healing
  amounts are not read (every heal counts the same), nor Wonder's heal cards; what is left out is in
  `TC_HEALS`' comment.

### Lufel publishes an order, not magnitudes

`ov.w` is not hand-written. Lufel ranks each character's substats into three priority
tiers, and `gen-data-from-lufel.js` turns that ranking into numbers with a flat map —
tier 1 → 10, tier 2 → 8, tier 3 → 6, anything lufel weighed and left out capped at 4,
over the archetype floor. The ranking is lufel's and is trusted. **The magnitudes are the
generator's own invention**, and one falloff curve is shared by all 68 characters. The floor
is invented too, so it may raise a ranked stat but never to the weight of a stat lufel ranks
above it: where it would, the stat takes its plain tier value. Until Sep 2026 it could, on
three characters — a Healer's SP Recovery default of 8 tied Minami's and Seaside Tomoko's
tier-3 SP Recovery with a tier-2 stat, and an ST DPS's Crit Rate default of 9 put Ichigo's
tier-3 Crit Rate above her tier-2 ATK% and Damage Multiplier.

Lufel publishes no tiers at all for one character, Lufel (the healer), so she runs on the
Healer archetype, which is an HP-scaling healer's order. Her kit heals off ATK and lufel
names ATK% for her Star and Sky, so `WEIGHT_OVERRIDES` sets ATK% to 10: that is not
reordering lufel, because there is no lufel order for her to reorder.

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

A fix here reaches characters the user has edited too, because a saved target is a **diff**
over the data (`target()` applies only the sets, Space card, main lists and weights the user
changed; stat targets always come from the data). It used to be a full snapshot, and a
snapshot stops every later fix: Kiyoshi Kurotani and Yusuke Kitagawa kept an ATK% weight of
4 that the DEF/HP-kit override had set to 0, because a Space change — or only the Setup
fields, which share the Targets dialog — had once been saved there. Old snapshots are
converted on load by `migrateSavedTargets()`, which keeps differing sets, Space and mains as
the user's choice and hands differing weights back to the data with a load message naming
each (the old dialog saved the whole weight grid every time, so those were stale far more
often than meant). Saving the dialog with nothing changed stores `null`.

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

**An empty list is an open slot** — lufel's "-" (or a blank), where it names no main:
Chizuko's and Runa's Moon and Sky, Yaoling's Moon and Star, Tempest Riko's Moon, Aran's Moon
and Sky. No main earns the match bonus there, and the perfect card takes whichever legal main
scores best. Those slots used to inherit an archetype placeholder the generator filled in
(Chizuko's Damage Multiplier Moon and Speed Sky, Runa's HP% Moon), and a main the
character's own weights prefer beat it by 15-20% at equal substats, so "perfect" was not a
ceiling. The generator emits `[]` only for an explicit "-"; a stat it cannot map keeps the
fallback, since that is a vocabulary gap rather than an answer. The Targets dialog shows an
open slot as "any" and can set one. Loading an old full snapshot hands a saved main for a
now-open slot back to the data and says so, the way #8 treats weights: the old dialog wrote
every main box, so that main is almost always the placeholder.

That makes the choice between alternatives real, which is what `STAT_PRODUCTS` prices.
Damage is a **product** of separate factors: ATK total multiplies the damage multiplier,
crit rate multiplies crit multiplier. Stats in different factors of one product are
therefore complements — the deeper you are in one, the less another point of it buys and the
more its partner is worth. Take the Damage Multiplier main and you want ATK% in the
substats; take the ATK% main and you want the reverse.

`couplingFactors(t, slot, main)` returns the per-stat weight multipliers, memoised per
target in a `WeakMap` through `targetMemo`, which drops the memo when the character's saved
loadout object changes. That matters because `target()` returns the same object for as long
as a saved target exists while the coupling reads the weapon, Awakening and Awareness: keyed
on the target alone, a Setup change on 6 of the 8 real saved targets kept pricing cards
against the old setup until reload (`idealCardScore` had the same problem and uses the same
helper). Every loadout write assigns a fresh object, which is what makes identity a safe
version stamp — keep it that way. Supply is counted in **max-roll equivalents** — points held over
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
  target with no `n` (a hand-built one in a test). **Elucidators are not coupled at all**
  (`computeCoupling` returns nothing when `spreadApplies` is false): their stats are donated
  to allies at 20%, so the board that decides what a roll is worth is an ally's, and their
  own 0%/0% crit base says nothing about it. They used to fall back to the 5/150 guess,
  which is an *ungeared* ally, and priced a Crit Rate roll at 1.8-2.9 times a Crit
  Multiplier roll — Fuuka's Crit Multiplier Star, the stat her Spirit Wave turns into party
  crit damage, lost to a Crit Rate one by 11%. At a geared ally's board the two rolls are
  worth about the same, so their cards are priced on their weights alone (`seedBaseline`
  returns null for them). Seven Buff-element support units genuinely carry
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

Resistance Pierce is its own factor (ⓒ) and is absent from the coupling: what a point is worth
depends on the boss's DEF, which only the spread term models (against one reference boss).
Flat ATK feeds the ATK factor but is also absent — a max roll of it is worth well under half an ATK% roll, and how much
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

Two things about how that delta is taken, both fixed in Sep 2026 after measuring them on the
real inventory:

- **It subtracts `.raw`, never `.score`** — the same rule as the Upgrades gains below. The
  rounded score left 4035 cards on about thirty distinct Score values and moved 6% of the
  verdicts across the 35% / 70% lines, mostly in the Space slot, whose best card is worth
  about eight points.
- **An empty `others` is priced, not zeroed.** `buildScore` returns `null` for an empty
  board because there is nothing to display, but a board with no cards still earns what the
  stat-target and spread terms credit the character's base stats with (median 7, up to 15
  build points). Treating it as 0 handed that credit to the card, so a character wearing
  nothing won nearly every argmax — 21% of verdicts and 30% of best fits under "All
  characters", and on "Characters I own" the day a newly pulled character is marked owned
  before being dressed. Both ends go through `buildScoreOf(char, worn, …)`, which is
  `buildScore` without the empty-board `null`. Measure with it; display `buildScore`.

The **Score** column and the keep/hold/feed verdict use that marginal, maxed over whichever
*eligible* owned character values it most, **graded against the best card of the same slot**
(`topBySlot` in `runTriage`), never the best card in the inventory, and with the card's
**main priced at its level cap and its substats as rolled** (`atMaxLevel`) — the main's
growth is certain, an upgrade's landing spot is not, and 92% of the user's cards are level 0.
The Vault uses the same rule; the optimiser does not. A Sun card's main is
always flat HP and a Space card's flat ATK+DEF, so neither can ever carry a main a damage
dealer wants; with mains priced at nine rolls, ranking them against Star and Moon cards
marked essentially every Sun card feed, which is a fact about the slot, not the card — the
same reason the Vault ranks within slot. A test asserts every slot has a 100% card — the user plays almost exclusively in-set, so a
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

**A card the Upgrades tab tells someone to equip is never feed.** The marginal prices one
card at a time, and most of a set switch is the 4-piece bonus, which lands only with the
fourth card — so every card of a recommended switch can read as a loss on its own. On a
synthetic inventory 54 of the 340 unequipped cards in the optimiser's 4-piece plans came out
feed. `runTriage` therefore runs `upgradesFor` for every character in scope, at the Upgrades
tab's own current settings, and a card it names carries `rec`: kept whatever its share, and
named in the Best fit cell with an "upgrade" tag. `who` is still the eligibility argmax the
tests above pin. The real inventory had no such feed at the defaults (Sep 2026); it is a guard,
because the case is one set switch away and feeding cannot be undone. It is most of Triage's
cost now (below). The Optimise tab's other policies are deliberately not asked — see
`docs/SCORING.md` §6.

**The default order is the verdict's order.** With no column clicked, the "Show" control
sorts on `quality` — the verdict's tier (`trTier`: plain feed, Vault-held feed, Vault lock,
hold, keep, an Upgrades pick) and then the within-slot share — not on the raw Score. Raw
scores differ by slot, so "worst first" by Score interleaved them: on the real inventory the
first 800 rows, all the table draws, held 199 hold cards while 723 of the 1322 feed
candidates sat below them. A test pins the order.

**The same six tiers are the verdict chips over the table** (`TR_TIERS`, `trVerdictSel`, saved
in prefs as `trVerdict`): each counts the cards the other filters leave in its tier, and pressing
chips narrows the table to them. The counts used to be five numbers inside a sentence, and the
table could be sorted by verdict but never filtered by it. A test pins that a chip's count is
the rows it shows.

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
single call. `npm run triage-perf` benchmarks the worst case (4000 cards, all 68 characters)
in a real browser — check it after touching any of this. It read about 2.8 s after the
Upgrades guard (1.6 s before it); on 28 Sep 2026 the same code measured 9.0 s on this machine,
and 6.4 s after the optimiser's shortlist stopped iterating (see "One card price" above), so
compare against a run of the old code on the same day rather than against these figures. On 2 Nov
2026 the kit fights and ⓒ took it from 2.14 s to 2.35 s, about a third of that the 68 fights themselves.

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
delta wrong outright. Display `score`, measure with `raw`. The baseline is `buildScoreOf`,
so a character wearing nothing is measured from what their base stats already earn rather
than from 0 — the same rule as Triage's.

Split run/render like Triage and Vault: `runHeadroom()` does the scoring pass into
`hrRowsCache`, `renderHeadroomTable()` filters and sorts it. Only the "may take a card off
someone else" toggle changes what is in scope, so it is the one control that re-runs the
pass. Measured worst case (65 owned characters, 4000 cards, everything equipped): 301 ms
for the pass, 53 ms to redraw. Every change goes through `commit()`, which calls `runUpgradeViews()`,
which skips the headroom pass while its sub-tab is closed — the sub-tab's own handler runs
it on the way in, so it cannot be shown stale, and nobody pays 300 ms per equip for a table
they never opened. Since Sep 2026 it skips both passes while the Upgrades **tab** is not on
screen, sets `upViewsStale`, and `showTab('upgrades')` runs them on the way in: the Upgrades
pass was nearly all of every Equip click on any tab (about 0.47 s on the real inventory,
now 37 ms). A test pins the deferral.

### Custom card: the Cycle of Fate event

Upgrades' third sub-tab (`#up-pane-craft`, `ccRow`/`ccBest`/`ccSecond`, details in
`docs/SCORING.md` §6). It ranks characters by the build points one event-made card adds and
names the card: set, slot, main and four substats. Card type switches between a Heavens card
(Cycle of Fate) and a Space card (other events), whose rolls use the Space tables and whose
alternatives are the other Space sets — scored alike whenever they pair, so the preferred comes first. **The gain is over the best the inventory can already give them**, never over what
is worn, or the worst-dressed character wins for free swaps the Upgrades tab already lists.
The substat values are not the player's to pick, so the card is valued at level 25 on the
Rolls setting (typical: average tier, upgrades spread evenly). Because the card arrives at level
0, a Likely column simulates random levellings (`ccOutcomes`, seeded, so a range never wobbles
between redraws), and the check panel gives the chance a rolled card ends up better than a fresh
roll of the recommended one. Like Triage it runs on its
first visit, in 50 ms slices, and is then only marked stale (`ccSig` in `markStaleRuns`).
"Check a card" takes the rolled level-0 values and can add the card to the inventory (undoable).

### Ink card: Vicissitude, Elysian and Prophetic Ink

Upgrades' sub-tab after Custom card (`#up-pane-ink`, `ikRow`/`ikExpect`/`ikCheck`). The game's
permanent Customize screen makes a new 5★ level-0 card: one Vicissitude Ink buys a Sun, Moon, Star
or Sky card (never Space) in a chosen set and main; Elysian Ink picks substats, 1/2/4/8 in all for
one to four of them, and the game fills the rest of the four at random; Prophetic Ink rolls each
picked value from the ordinary five tiers, one apiece, and one more re-rolls a picked substat with
the new value **replacing** the old. The user confirmed all of it in-game (10 Oct 2026); the guide
sites had Sun excluded and a 5-ink cost for two picks, both wrong. The design is the Custom card
view's (`ccBest` at typical rolls), so four picks reproduce its gain exactly (a test holds it);
fewer picks are priced as the average over **every** fill of the unpicked substats (at most 495,
not sampled, so a run never wobbles), each worn in the better of the design's loadout and the
one already worn and floored at no gain. The "By substats picked" column and the summary's ladder
are what the Elysian Ink buys. "Check a roll" says which picked substat to re-roll: the one whose
re-roll gains most on average over the five tiers, or keep the card when none gains. About 2 s
for 37 characters on the real inventory.

### Fortune Revelation: which set to redeem

Upgrades' fourth sub-tab (`#up-pane-fortune`, `frCharData`/`frRateSet`/`runFortune`). A Fortune
Revelation becomes a 5★ Heavens card of a set the player chooses (an Orange one, a Space card);
slot, main, starting substats, values and upgrades are random. No source publishes those odds, so
`frDraws` takes them from the user's own inventory (Oct 2026, 4316 5★ cards): mains about even
within a slot, 40% of level-0 cards with four substats (`FR_FOUR_SUBS`), substats about equally
common, never HP on a Sun card nor flat ATK/DEF on a Space card (`frNoSub`). Every set is rated on
the **same** 400 draws, so sets differ only by their name, and `frClose` marks a set "about as good"
when its paired difference from the best is within two standard errors. A draw is worth its gain to
whichever counted character gains most (one card, one wearer), over the Custom card view's baseline
(the best the inventory already gives them), in build points; a set's value is the mean over draws,
zeros included. Each draw is priced in a few fixed loadouts per character (the best loadout with
the slot emptied, what is worn, and for their own sets the optimiser's pick with a good card of that
set) instead of re-running the optimiser per draw; `can[set][slot][main]` skips kinds of draw a
13-roll card could not improve, and a test holds that skipping changes no value. Counted characters
default to owned and not benched; `frChosen` stores only departures from that, saved in prefs.
About 1.3 s (Heavens) and 2.3 s (Space) for 37 characters on the real inventory.

### Retrograde Card: which levelled card to reset

Upgrades' sixth sub-tab (`#up-pane-retro`, `rgInfer`/`rgResets`/`rgPrice`/`runRetrograde`). A
Retrograde Card sets a card back to level 0: its drop substats keep their starting values, its
upgrades are undone, and levelling it again lands five new ones at random (the user, 10 Oct 2026;
Game8 agrees). A card that dropped with three substats loses the fourth its first upgrade minted;
whether it comes back the same is **not known** — Prydwen says the hidden fourth "can be changed"
— so the Fourth substat control (`rgFourth`) defaults to a random stat and offers "the same".

Nothing records where a card's upgrades went, so `rgInfer` reads it from the values: k rolls of a
stat print within k × its lowest to k × its highest `ROLL_TIERS` value (tolerance one display unit
per two rolls, the game keeping more precision than it prints), the rolls add to the drop plus the
upgrades, upgrades land on a uniformly random substat, and 40% of drops carry four (`FR_FOUR_SUBS`).
Totals of eight and nine rolls separate three- and four-substat drops, so on the real inventory
(345 levelled cards, Oct 2026) every card was explained, about 145 almost surely dropped with three
and 140 with four. Which substat was the late one is not readable (each of the four equally).

Each card is reset and re-levelled `RG_SAMPLES` (300) times, seeded per card, and priced through
`buildScoreOf` against keeping it (levelled on at random if under 25). A worn card is priced for its
wearer; a spare one for every in-scope character its set allows, screened on 40 outcomes, the best
three priced on all. Both sides are floored at what the character would wear in that slot without
the card (`rgFallback`: what they wear there, or their top `RG_ALT` spare cards by card score at full
level) — a spare card's reset that still loses to their own card is worth nothing, a worn card's
reset that comes out worse costs what it costs. Gains are build points. Only 5★ cards: the roll
tables are measured for 5★ only. About 2.5 s on the real inventory; runs on first visit and is then
only marked stale (`rgSig`). With "the same", three-substat drops gain more and the order changes
(the real top card moves from a spare Labor Moon to Minami's worn Love Moon).

### The Vault is the counterweight to that gate

The Vault is the Triage tab's second view, "Lock for later" (`#tr-pane-vault`, `showTrPane`); it
had a tab of its own until Sep 2026, and was folded in at the user's request so the two halves
of "what do I do with this card" sit together. Its ids and functions kept their names.

Once Triage refuses to name anyone, it will happily call a card junk that a future character
would want, and a fed card does not come back. `runVault()` answers the other question —
what deserves a lock in the game client — and answers it **without reference to the roster**,
so pulling a character cannot change a verdict. The two answers used to meet only if the user
cross-checked the tabs card by card; Triage now reads the Vault's scoring pass
(`vaultRate`, at the Vault view's own rarity floor) and marks a would-be feed the Vault rates
worth a lock **lock**, and one it rates worth holding with a "vault: hold" note that sorts
after the plain feeds (`trVerdict` / `trTier`). On the real inventory that was 76 locks and
266 notes among 1322 feed candidates (Sep 2026). The Vault itself is unchanged. Two reasons:

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

### The preferred set is the ceiling, by lufel's order

`bonus4Value`'s 55 / ×0.72 / ×0.22 are the tool's own stand-in for "how good is this
4-piece for this character", with lufel's ranking supplying the order; a 2-piece is priced
from its stat. For characters who weight a 2-piece's stat heavily those two pricings used to
disagree about lufel's order. At equal perfect cards, Power's 4-piece or two ATK 2-pieces
beat Labor for every Elucidator, Worry's +80% SP Recovery beat Love for Lufel, and 2+2
splits beat the preferred 4-piece for 18 characters, so 100 was not the ceiling. What the
flat number cannot see is the 4-piece's own effect (Labor's party-wide ATK/HP/DEF,
Prosperity's Highlight charge) and that the 2-piece's stat runs past the kit's cap.

`prefSetLift` holds lufel's order on the invented number, not the measured one. The
preferred 4-piece is lifted by exactly what it takes to match any other configuration of
perfect cards (another 4-piece, or any two 2-pieces). This is measured on whole loadouts
(stat targets and spread included, since a 2-piece stat feeds both) at the caller's P4. It
is zero for 50 of the 68 and non-zero for exactly the 18 whose ceiling was broken, mostly
Elucidators, healers and buffers; the largest is Seaside Tomoko's, at 19.1 (Lufel's was 35.6
until Love's healing 2-piece was priced like the healing main, and is 8.8 since). It is memoised per
character, dropped when their Setup or saved target changes, and only a character's own
target gets one. A preferred set whose 4-piece is dead for the character would get none:
Defeat's 4-piece raises Fire damage only (`elem4`), and lufel lists it as Curse Toshiya's
alternative for the ailment-accuracy 2-piece.

Only the preferred set is lifted. Holding each alternative above every unlisted
configuration was tried and dropped. It reads more into lufel's list than it says, the
alternatives' lifts ran to 40 points, and the preferred set had to clear them in turn,
which lifted 30 characters where only 18 had a broken ceiling.

Mains get no such lift: their magnitudes are measured and the coupling is exact, so where
the model and lufel disagree, the model is fixed. Of the ten slot cases found in Sep 2026,
nine were fixed that way (open slots, Elucidator coupling, Beachflower Minami's buff
sources and HP scaling, Kira's kit lines, Lufel's weights). The one left is Wavecatcher
Miyu's Crit Multiplier Star, which is right only in a party that supplies crit rate: lufel's
builds assume one, and the model does only once the team crit rate is set. A test names it as
the single exception at the default of 0, and another holds that at 20 nothing is left.

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
   generator now says so on stderr and tells you to record it in the table anyway. The
   generator writes `CHAR_STATS` too; a Global number that differs from lufel's (which
   follows JP) goes in its `GLB_STAT_OVERRIDES` table with the in-game evidence — today only
   Makoto Niijima's Resistance Pierce Mindscape node, which had been a hand edit that the
   next regeneration would have reverted, and Hatsune Miku's Awakening 7. Global Awareness
   text goes in `tools/gen-awareness.js`'s `GLB_AWARENESS_OVERRIDES` the same way.
2. **Main stat magnitudes are measured, not published.** No site lists them, lufel included;
   `MAIN_MAGNITUDE` comes from the user's own scan of 3947 5★ cards (every card of a stat
   shows the same value at the same level, linear in level). Other rarities have not been
   scanned and are assumed to sit on the same curve up to their level cap.
3. **Substat roll tables are verified against the client.** Prydwen's `maxRoll` figures were
   single-sourced; the same scan's level-0 cards (one roll per substat) reproduce every
   maximum exactly, for all 13 stats on both the Heavens and Space layouts, and show each
   roll has five tiers (ATK% 2.0/2.5/2.8/3.2/3.5).
4. **Six sets and two Space cards are `unreleased: true`** — lufel lists them, the game
   has not shipped them on Global. They stay in the tables so imports resolve, but a test
   asserts no character targets one, and names the eight so a release shows up on the next
   refresh (Satiety left the list in the 15 Oct 2026 refresh, and YUI [Prism] moved to it).
   Release is also **per pairing**, which no tag records: lufel's GLB schedule releases
   Space+Heavens combinations on their own (`rev_set`). Acuity shipped pairing with Satiety
   alone; since Oct 2026 lufel's English table also lists Acuity + Hindrance, ahead of the
   schedule's 4.16. The generator reads the English table, reports what only the Korean one
   has, and holds out a pairing whose halves are both released but which the schedule has
   not dated yet — never take a pairing early, from either table.
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
- Every change to state ends in `commit()`; an easy-to-regret one takes a `snapshotState()`
  first and offers `offerUndo()` after (see "The page's plumbing").
- Event bindings are scoped to their container (`#invTable [data-edit]`, not `[data-edit]`).
- One name per stat on screen — the canonical `SUBSTATS` names — and every substat is printed
  through `subVal`, with its unit.
- Add an assertion to `test/optimizer.test.js` for any invariant you rely on. The existing
  ones cover slot legality, set-plan integrity, off-element rejection, alias resolution and
  main-stat legality across the whole roster, and section 11 the page's safety net (unsaved
  state, undo, staleness, scoped bindings, chips, keyboard and label access, phone width).

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
  which column the grid's red selection frame is in (`detect_grid_cursor`, over the
  calibrated `grid` box) and presses A only from the right-hand column, re-reading
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
- **A tab can open with its selected card scrolled out of view.** On the Sep 27 full scan
  the Moon tab, and in the second part the Sky tab, came up with the selection back on the
  list's first card (the panel showed it) but the list still scrolled to its last rows,
  where the previous day's walk had left it: no frame in the grid, and W moved nothing
  because the selection was already at the top. The rewind gave up (`"lost"`), and it now
  keeps that screen (`<out>-lost-<slot>.png`), which is how this was seen. When the W presses
  moved nothing and no frame is visible, it sends S then W — off the first card and back — so
  the list scrolls to follow the selection into view, then reads the column as usual. The
  Star tab of the same run opened on the card it was left on, so which state a tab opens in
  is not predictable; the rewind handles both.
- **The grid is read by the frame's shape, not its colour.** Until Sep 2026
  `detect_grid_cursor` counted bright-red pixels, and card art can be that red: the Space
  set Departure's thumbnail is a rider in a red cape, ~500 such pixels a tile. With a few in
  view the count found "no cursor", or a column and row pulled toward the art, which the walk
  trusts over its keys; the model then filed new cards as already read, and two full Space
  runs stopped mid-list (49 of 194 cards — one right after the Departure Lv25 cards came into
  view, the other reading only the Departure-heavy end of the list). It now looks for the
  frame's top and bottom edges: horizontal red runs of 123-192 px at 1080p, where no card art
  measured ran past 18 px (`edge_frac` of a column's width). Over 251 real frames it agrees
  with the old read wherever that one saw the frame, row fraction within 0.031; on the 14
  frames of the Departure list the old read found nothing and the new one finds all 14. The
  same code had read all 191 Space cards on Sep 5; new Lv25 cards had since moved where the
  Departure tiles sit.
- **Every run writes `<out>.log`** (`RunLog`): everything printed, plus one trace line per
  key that only the file gets: what the grid showed, and the model position before and after.
  The two stalled Space runs left only their card files, and the key-by-key path of the
  second one (card 0, then straight to the end of the list) could not be reconstructed. The
  output name is fixed before anything is sent, so the log, the frames and a failed tab's
  screenshot share the numbered stem — the screenshot used `--out`'s own stem until Sep 2026,
  so each run of a session overwrote the last one's.
- **The game shows a "VIP Pack" popup that stops a run.** It covered the list at 22:00:22 in
  the Sep 26 session, the walk counted a cycle of dead keys and moved on, and its tab click
  closed the popup instead of switching (`"tab"`). It is a once-a-day popup — the user says
  it comes at 10 o'clock (they said 10 am; the one captured was 22:00:22 by the PC's clock,
  so the time zone or am/pm is unconfirmed). A full walk takes about an hour (0.87 s a card),
  so keep that hour clear of it rather than splitting the run.
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
  `mergeImport` already assumes; every 3-substat card in the scan is level 0. So does the
  level-0 panel's best case (`bestCaseUpgrades`): the new substat is the stat worth most
  that the card lacks, and only the upgrades after it are rolls. Until Sep 2026 it treated
  every upgrade as a roll on an existing substat, which is wrong both ways — and 60% of the
  real level-0 inventory is three-substat cards, so 763 card/character pairs were labelled
  "even maxed, not an upgrade" that could beat the recommended card.

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
