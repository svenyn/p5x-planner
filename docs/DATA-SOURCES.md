# Data sources and what to verify

`src/data.js` was originally assembled from English community guides in August 2026. In
August 2026 the sets, Space cards and the whole roster were re-derived from **lufel.net**,
which the user (who plays the game) rates above Prydwen, Game8 and Fragster. This document
records where each part comes from and how much to trust it, so that whoever corrects it
later knows what they are overwriting.

## Where lufel.net's data actually lives

Lufelnet renders client-side and returns an empty template to plain fetchers, which is why
earlier passes had to read it through a browser. That is no longer necessary: the data
behind the pages is plain static JavaScript under `/data/`, and it fetches fine.

| Path | Contents |
|---|---|
| `/data/character_info.js` | Roster — element, rarity, codename, names in ko/en/ja/zh, `release_order` |
| `/apps/schedule/data.js` | GLB/JP release timeline — version, date and characters per patch |
| `/data/en/revelations/revelations.js` | Sets, 2- and 4-piece effects, Space cards, all pairings, Korean→English name mapping |
| `/data/kr/revelations/revelations.js` | The same, Korean |
| `/data/characters/<Korean name>/setting.js` | Per-character build: ranked Space+Heavens pairings, one or more recommended main stats per slot, three tiers of substat priority, per-stage stat targets |
| `/data/characters/<Korean name>/base_stats.js` | Base HP/ATK/DEF/Speed by level and ascension |
| `/data/characters/<Korean name>/weapon.js` | Both weapons: flat HP/ATK/DEF plus the passive text, with its 7-step refinement ladder |
| `/data/characters/<Korean name>/ritual.js` | The "Awareness" ladder — 7 named passives (levels 0-6). Lufel's own field name is `ritual`; the site's English UI calls it "Awareness". Unrelated to Ascension, Mindscape or the Awakening-7 bonus, despite the similar name |
| `/data/characters/<Korean name>/party.js` | Recommended teams (3 thieves + Elucidator; Fuuka's carry a 5th, her Oracle Shift backup) and "friends": synergy partners, each with a one-line English reason and sometimes the Awareness it needs. Missing for a few characters, which lufel's own page treats as normal |
| `/data/characters/<Korean name>/operation.js` | Skill rotations per Awareness level and situation ("with Miku", single target, 2-turn cycle), as a line or a turn grid, with English notes for 38 characters (the rest have none, in any language) |
| `/data/characters/<Korean name>/skill.js` | Skills 1-3, Highlight (or Theurgy) and passives, in four languages: description with the four skill-level values, SP cost, and `cool` — the Highlight's cooldown is 4 turns for every thief; a Theurgy has none and needs 70 gauge. Source of `SKILL_DMG` |
| `/data/persona/index.js`, `/data/persona/<Korean name>.js` | 155 Personas: unique skill, passives, innate skills, Highlight, each in English with rank values. Read once (Oct 2026) into `WONDER_BUFFS.personas` by hand-checked batches. `tools/gen-wonder-innate.js` fetches them (each file sits at the folder the index's `__path` names, `data/persona` or `data/persona/nonorder`) for the innate skills only, into `WONDER_INNATE`; `tools/gen-wonder-damage.js` reads them with the skill list below for Wonder's own hits, into `WONDER_DMG` (Nov 2026): every "Deal <element> damage to <1 foe / all foes> equal to a/b/c% of Attack (N hits)" clause of a unique skill, Highlight or attack skill, 116 Personas and 134 attack skills; two cards print no number (Mada's Skill 1, Horn of Judgment) and are left out |
| `/data/kr/wonder/skills.js` | 459 skill cards (`personaSkillList`), English descriptions. Source of `WONDER_BUFFS.cards`. `tools/gen-wonder-skills.js` reads it into `WONDER_SKILLS` (Nov 2026): every skill's English name and kind, and an active skill's values at skill levels 6/7/8 from the Korean "a/b/c"; 33 rank summaries ("Attack Boost" beside Attack Boost I-V) left out, 422 skills kept |
| `/data/kr/wonder/weapons.js` | Wonder's 18 weapons (`matchWeapons`), English effect text with 7 refinement steps. Source of `WONDER_BUFFS.weapons` |
| `/data/kr/calc/defense-data.js` | lufel's own defence calculator: DEF-down (`defenseCalcData`) and Pierce (`penetrateData`) sources per character and for Wonder, as numbers. Used to cross-check the hand-entered DEF-down values (all seven Wonder ones match) |
| `/data/kr/calc/boss.js` | 35 bosses with base DEF and DEF coefficient (e.g. 855 / +163.2%, Vishnu 821). `tools/gen-bosses.js` writes all of them, with their element resistances (약 weak, 내 resist), into `BOSSES` at the end of `src/data.js`; the Teams tab fights the one the page picks; by default (Auto) lufel's single-boss example (1280, +158.4%), or its area-boss example (821, +158.4%) for an area damage dealer. The non-Sea bosses are Nightmare's Gateway's (Game8's guide lists the same names); boss.js's `description` fields (Korean) say which bring linked helpers (Vishnu's 4 Avatars, Nidhoggr's serpents) |
| `/apps/guides/data/posts/damage-calc.json` | The damage formula — which stats multiply and which merely add. Not fetched by the tools; read once and encoded in `damageFactors()` |
| `/apps/guides/data/posts/HIGHLIGHT.json` | How the Highlight gauge fills: one gauge for the team, 17% per thief action (21% on a weakness hit), never above 100%, not charged by Highlights, All-Out Attacks or Elucidator actions; a user waits 4 of their own actions between Highlights. Read once (Nov 2026) into the Teams tab's fight (`TC_GAUGE_ACT`, `TC_HL_COOL`) |
| `/apps/guides/data/posts/theurgy.json` | Theurgy: a gauge per character, +35 at the start of their turn, capped at what their Theurgy needs (Makoto Yuki 100, Yukari 70, Akihiko 140, Mitsuru 70), usable outside their turn; not fired by Ayaka's Catchy Hook (`TC_TH_TURN`) |
| `/apps/guides/data/posts/speed-order.json` | Turn order by Speed (ties left to right in the lineup), and that a buff counts down after its holder's action — why damage dealers are placed last. The fight plays this out |
| `/apps/guides/data/posts/technical-master.json` | Technicals and Technical Precision (Feb 2026, written around Firecracker Rin and Mio): which element on which ailment gives Fireburn, Iceburn, Windburn, Short Circuit, Deepfreeze; Technical Precision raises Fireburn and Short Circuit by 10% of themselves per 100 points and Iceburn (and Mio's Cold Flames) by 5%, in proportion below 100; Rin's Fireburn is 20%. Read once and encoded as `tcTechScale` and the `tp` / `needAil` / `tech` lines in `logic.js` |
| `/apps/guides/data/posts/eternal-dreamland.json` | Down (knockdown) rules, but only for one Nightmare's Gateway mode not yet on Global (Down Points 24 / 18, +2 back after the enemy acts, a weakness skill removes 1 more, multi-hit skills checked inconsistently, +20% final damage once down). Read Nov 2026 to see whether Fuuka/Kumi's Down plan could be priced: nothing in it gives a normal boss's Down Points or how long a knockdown lasts. The normal rules came from the user instead (1 per weakness skill; down until the boss's next turn, which it still takes, then a full refill; only some bosses can be downed), and the Down Points are a Teams-tab setting |
| `/apps/guides/data/guides-list.json` | The guide index (ids for the posts above) |

Three tools wrap this:

```
node tools/fetch-lufel-data.js lufel.json    # download and flatten every file above
node tools/audit-lufel.js lufel.json         # diff it against src/data.js, report only
node tools/gen-data-from-lufel.js lufel.json # emit replacement SETS/SPACE_SETS/CHARACTERS
node tools/gen-awareness.js lufel.json       # patch CHAR_STATS[*].awareness into src/data.js in place
node tools/gen-teams.js lufel.json           # replace the TEAMS block (parties, partners, rotations) in place
node tools/gen-skill-damage.js lufel.json    # replace the SKILL_DMG block (damage per skill and Highlight) in place
```

`gen-skill-damage.js` reads each skill's English text for its damage — every "equal to X% of
Attack/Defense/max HP" in a sentence that deals damage, at the base skill level, times its hits —
for skills 1-3 and the Highlight or Theurgy. The Teams tab uses only the ratio: what share of a
damage dealer's own damage lands on their Highlight. **Medium confidence, an estimate of one ratio
per character.** Conditional clauses count in full on both sides; damage that is not a numbered
skill (Resonance, follow-ups, summons, Gunshot/Melee turns, damage over time) is not counted at all,
so for kits built on those — Wavecatcher Miyu's Resonance is about half her damage — the Highlight's
share reads high. A text the parser gets wrong goes in its `FIXES` table with the reason: 24 entries (Nov 2026),
mostly two modes or two Highlight versions added together (Kira, J&C, Frostgale Kotone, Makoto
Niijima, Runa), later hits on the same target worth a fraction of the first (Motoha, Yusuke,
Seaside Tomoko), and a recurring effect the skill's text defines that was added to its one cast
(Summer Ayaka's Summer Starscape, YUI's follow-ups). What those kits deal besides their numbered
skills — Resonance, follow-ups, summons, damage over time, token turns — is `DPS_KIT` in
`src/logic.js`, entered by hand from the same English text with each component's trigger (their own
actions, a teammate's, a Highlight, the enemy's turn); `DPS_KIT_SKIPS` lists what could not be
expressed (mostly "+X% damage" on a component, always-crit and DEF-ignoring hits, and Burn and
Lovesick ticks, for which lufel publishes no number). **Medium confidence**: several trigger rates
are judged (each `why` says how).

Which kits put elemental ailments (Burn, Freeze, Shock, Windswept, and Chizuko's Radiation) on a foe
is `TC_AILMENTS` in `src/logic.js`: one hand-checked pass over the same English text and the Korean
(`characterSkillsData`), every Awareness and weapon line included (Nov 2026). Where they disagree
the Korean is used and the `why` says so (Ryuji's Rebound chance, Makoto Niijima's A2, Koromaru's
passive, Starlight Ann's Heat Score). **Medium confidence**: most Burn, Freeze and Shock lines print
no duration and are taken as 2 turns, a few rare triggers are entered as a share of turns, and
whether a multi-hit skill rolls its chance per hit is not printed (read as once a cast).

`gen-teams.js` writes everything in English: lufel's English labels and notes where they exist,
its own small tables for the Korean rotation labels and skill tokens otherwise ("의식 N" is
Awareness N, 감기 Fatigue, 총격 Gunshot, Miku's song marks), and it prints anything those
tables do not cover rather than dropping it. lufel's long character reviews are not copied in;
the Teams tab links to each character's page for them, and the one mechanic it explains itself
(Fuuka's Oracle Shift, `TEAM_MECHANICS` in `logic.js`) is in our own words.

`audit-lufel.js` is the one to run first when something looks wrong — it reports and never
writes. Re-run it after any hand-edit to `src/data.js` to see what you have diverged on.

## Confidence by section

### Sets, Space cards, pairings — high, from lufel

Thirty-four Heavens sets and nineteen Space cards, with the pairing table as Global has it.
Six sets (`Cruelty`, `Debauch`, `Failure`, `Happiness`, `Tenacity`, `Wealth`)
and two Space cards (`Ego`, `Purity`) are tagged `unreleased: true` — lufel lists them but
the game has not shipped them on Global. They stay in the tables so names resolve on import
and so the data is right the day they land, but a test asserts no character targets one.

**Names follow lufel, and lufel moves to the official Global name when a card ships.** The
25 Sep 2026 refresh brought four renames and two new sets: `Obtain` → `Gain` and `Agility` →
`Acuity`, both released in 4.9 (2026-09-09) with YUI [Prism]; `Depravity` → `Debauch`,
`Determination` → `Cruelty` and `Flourishing` → `Wealth`, all still unreleased; and `Failure`
and `Happiness`, new and unreleased. None of the old names is on any card in the user's save
or in the 9720 scanned cards, so nothing needed a `SET_ALIASES` entry — and a speculative
one is exactly what not to add.

**Pairings are released one at a time, and no tag says so.** A Space card does not ship with
every pairing it will eventually have. Lufel's GLB schedule lists pairing releases of their
own (`rev_set`: Hope + Change in 4.8, Nativity + Strife in 4.10, Acuity + Hindrance in 4.16
with Koromaru). Acuity is the live case: it shipped pairing with Satiety alone. Until Oct
2026 lufel's English table tracked that and only the Korean one listed Wealth and Hindrance;
the 15 Oct 2026 refresh brought both into the English table too, ahead of the schedule.
Taken as they stand, Koromaru and Aran Hirano — whose top build is Hindrance + Acuity — would
have been handed a pairing that does not exist on their server. So `gen-data-from-lufel.js`
reads the English table, reports on stderr what only the Korean one has, and **holds out** a
pairing whose two halves are released but which the schedule has not dated yet (Acuity +
Hindrance today), from the Space card's `pairs` and from every character's pick. A pairing
whose Heavens set is itself unreleased (Acuity + Wealth) stays listed, as such pairings always
have: nobody can target the set. Those two characters keep Creation, and their notes say why.

**Satiety is released.** It was tagged unreleased while the schedule listed it in 4.9 beside
Acuity and Gain; lufel corrected the tag in the 15 Oct 2026 refresh, and YUI [Prism]'s target
moved from the Truth + Awareness fallback to lufel's Satiety + Acuity, as planned.

`Ruin` and `Prudence` were previously carried as `unverified: true` with no 2-piece,
because no English source listed them. Both are real and now fully specified:

- **Ruin** — 2-piece ATK +12%; 4-piece ATK +25% for 3 turns, refreshing after a Theurgy.
  It is not a Curse set and is not a duplicate of Hindrance; the earlier source was wrong.
- **Prudence** — 2-piece **Speed −3, ATK +18%**; 4-piece damage +16%. It is not elemental
  and has nothing to do with Wind. The ATK term is its `bonus2`; the Speed cost is
  `bonus2Also: [{ stat: 'Speed', amt: -3 }]` (Sep 2026 — until then it was only stated in
  the `p2` text, so a Speed breakpoint read 3 high under a Prudence 2-piece).

`bonus2` remains a **scoring model, not a transcription**. Effects like Prosperity's
"reduces incoming damage by 8%" have no substat equivalent, so the number there is the DEF%
that buys comparable mitigation. `gen-data-from-lufel.js` preserves existing `bonus2` and
`bonus2Also` values rather than re-deriving them, so tuning them by hand survives a
regeneration; for a set that has none yet, it reads a "Decrease Speed by N" clause into
`bonus2Also`.

One set's 4-piece is bound to an element its 2-piece is not: **Defeat** — 2-piece ailment
accuracy +15% for anyone, 4-piece "Fire damage to debuffed foes +20%" (lufel's Korean text
says the same). It carries `elem4: 'Fire'` rather than `elem`, so its 4-piece is worth
nothing off Fire while its 2-piece keeps working; the generator reads `elem4` off a 4-piece
that names an element when the 2-piece does not, and Defeat is the only such set. Until Sep
2026 Curse Toshiya, whom lufel sends to Defeat for the accuracy, was paid the alternative's
4-piece for a Fire bonus he cannot use.

### Slots and main stat pools — high

Four slots named Sun, Moon, Star and Sky, plus a fifth Space slot that unlocks around
account level 40. Sun's main stat is always flat HP and Space's is always flat ATK plus flat
DEF; the other three roll from a pool. Prydwen and SetsunaEpic agree on this independently,
and every one of lufel's 65 per-character build recommendations is consistent with it.

Three constraints are load-bearing for the optimiser: Ailment Accuracy only appears as a
**Star** main stat, Speed only on **Sky**, and HP Recovery only on **Moon**.

### Rarity, levels and substat counts — high

5★ caps at level 25, 4★ at 20, 3★ at 15, 2★ at 10. A card gains or upgrades a substat every
five levels. The cap is **four** substats, not five — guides saying "five stats" are counting
the main stat. 5★ and 4★ cards start with three or four substats; 3★ always three; 2★ always
two.

### Substat roll values — high, verified against the client

The `maxRoll` figures in `SUBSTATS` came from Prydwen alone. **Lufel does not publish them**,
but the user's own OCR scan does the job: on a level-0 card every substat is exactly one
roll, and across 3947 scanned 5★ cards (Sep 2026) the set of distinct level-0 values per
stat is five tiers whose top matches Prydwen's `maxRoll` exactly — for all 13 stats, on both
the Heavens and the Space layout (ATK% 2.0 / 2.5 / 2.8 / 3.2 / 3.5 on Heavens, 2.6 / 3.1 /
3.5 / 3.9 / 4.3 on Space; Crit Rate 1.3 / 1.4 / 1.7 / 1.8 / 2.0; and so on). The lowest tier
is about 57% of the highest, so an average roll is roughly 80% of a max roll.

These numbers matter more than they look: every substat is scored as `value / maxRoll`, so a
wrong `maxRoll` would systematically over- or under-value that stat for every character.
Only 5★ cards have been scanned; other rarities are assumed to use the same rolls.

The five tiers themselves are now recorded as `ROLL_TIERS` in `src/data.js` (3865 level-0
cards, Sep 2026; both layouts; a test asserts the top tier equals `maxRoll`) and exported to
`dist/tables.json` alongside `MAIN_MAGNITUDE`, so `ocr/plausibility.py` can flag a level-0
substat that is none of them and a main value that is not its level's. Sums of several
rolls do **not** reproduce the displayed tiers (a real Lv25 DEF 130 is unreachable from
27/32/37/41/46), so the game keeps more precision than it prints; levelled cards are not
checked against tier sums for that reason.

### Rarity — not on the screen, and what was measured looking for it

The card detail screen prints nothing that names rarity. The bottom-right `ID:` is the
player's UID (identical on all 60 frames sampled), not a card serial. The gold of the card
tile is the same on all five tabs, so it is a rarity colour rather than a slot colour, and it
is stable — RGB (216, 183, 27) ±25 across 150 Heavens frames — but Space card art swamps the
thumbnail's median, and no 4★ frame has ever been captured to validate a threshold against.
So `--rarity` stays a per-run stamp. A single probe of a real 4★ card would settle whether
its level-0 main value and roll tiers differ from the 5★ tables (in which case rarity is
readable from the numbers alone) and whether its tile is a different colour.

### Stat targets — high, from lufel, but not absolutely checkable

`minimum_stats` in each character's `setting.js` is lufel's "recommended stats" panel: the
number a unit needs at each skill-level-cap milestone (LV10, LV10+5, LV12, LV12+5, LV13,
LV13+5) — not a difficulty/content stage, despite the naming; see the "Stat targets" and
"Awareness" sections of `CLAUDE.md` for what actually switches `LV10` to `LV12`/`LV13`
(the character's own Awareness investment, verified per character against `skill_priority`
and the Awareness ladder text, not Ascension as an earlier pass here wrongly assumed). 37 of
the 65 characters have one; the rest genuinely have no threshold. They are parsed into
`ov.targets` as structured data — stat, whether it is a percentage, and the value per stage
— rather than prose, so the scoring engine can read them.

Ten stats appear: ATK, HP, DEF, Speed, Crit Rate, Crit Multiplier, Ailment Accuracy,
Damage Multiplier, Resistance Pierce and SP Recovery. Each maps to the substat it is
actually chased with (an ATK target is met by stacking ATK%).

**The numbers are in-battle totals.** They include the character's base stat, their weapon
and their My Palace nodes — lufel says so itself in the adjacent `battle_plus_stats` field,
which lists things like "My Palace 50LV 65 / signature weapon". Everything but My Palace is
now modelled, from these lufel files:

| Path | Gives |
|---|---|
| `/data/characters/<name>/base_stats.js` | HP/ATK/DEF at A0 and A6 for Lv80 (and Lv100 for 15 characters), base Speed / Crit Rate / Crit Multiplier, and the Awakening-7 bonus |

| `/data/characters/<name>/weapon.js` | Both weapons: flat HP/ATK/DEF plus the passive with its 7-step refinement ladder |
| `mind_stats1` / `mind_stats2` in `setting.js` | Mindscape nodes (59 of 65 characters) |

**The `awake7` block is not one shape.** Lufel writes some of its keys as the stat's new
*total* and others as the *bonus* on top, and nothing in the file distinguishes them:
`crit_mult: 184.9` against a 150 baseline can only be a total. `speed`, `sp_recover` and
`crit_rate` are read as totals because each has been checked against a real in-game panel —
Miyu Sahara [Wavecatcher]'s `sp_recover: 188.5` shows up as exactly 88.5 above the baseline
in game, and Akihiko's panel confirmed `crit_rate`. `ailment_accuracy` (7 characters) is read
too: Ailment Accuracy's in-game baseline is **0%** (the user's panel, 25 Sep 2026 — it had
been modelled at 100%), and against 0 a total and a bonus are the same number. `crit_mult`
and a lone `HP_recover` are still **not read at all**, and should stay that way until someone
checks one the same way. The HP key is read under both
`hp_per` and `HP_per`, which is lufel's own inconsistency across characters; the planner
previously looked for `health_per`, which is neither, so every HP awakening on the roster
was silently dropped. The generator writes Hatsune Miku's ATK awakening, which lufel files
under `attack`, as `attack_per` — every other 5★ ATK awakening is `attack_per: 29`, and
`charBaseStat` reads only that key. Her value also changed in the Sep 2026 refresh, from
`{hp_per: 20, crit_rate: 12}` (the only two-stat awakening lufel has ever listed) to that
`attack: 29`. The user's own panels settled it (26 Sep 2026): both of lufel's values are
wrong for Global, which is **ATK +19%**. The old one cannot be right — with +20% HP her HP could
not read below about 9470 whatever the rest of her Setup, and her screen reads 9358 — and with
every other ATK% source pinned (weapon R0 30, cards 42.3, Mindscape ATK path 5 = 20% read off the
game's own Mindscape screen, her Labor 4-piece 8%) her screen's ATK 4627 leaves 19 for the
awakening. It is in `GLB_STAT_OVERRIDES`, and a test reproduces her whole screen card for card.
The old value's `crit_rate: 12` was her Mindscape crit node (+12% at level 5), which the screen
does show.

Two more corrections live in the generator rather than in `src/data.js`, so a regeneration
keeps them. Lufel gives Fuuka Speed 0 (and SP 0) where every character acts at 100, so a
Speed of 0 keeps the value `src/data.js` already has and says so on stderr. And
`GLB_STAT_OVERRIDES` holds Global numbers that differ from lufel's JP ones, with the in-game
evidence beside each. Two today: Makoto Niijima's second Mindscape node, which reads
Resistance Pierce 7.5% on Global where lufel has Crit Rate 12% — the user's own panel, and a hand
edit until the generator carried it — and Hatsune Miku's Awakening 7 (ATK +19%, above). Either
field (`mind`, `aw`) can be overridden.

Awareness text has its own table, `GLB_AWARENESS_OVERRIDES` in `tools/gen-awareness.js`. One
entry today: Fuuka's Global 4.12 buff (the user's change list, 29 Oct 2026; lufel, Prydwen and
the official 4.12 notes still showed the old kit that day). Awareness 1 adds party +15% crit
damage beside the 6% crit rate, Awareness 2's damage amp after Oracle Shift is 10% (was 6%),
and Awareness 6 makes that amp last 2 turns and stack twice. The texts are our wording over
lufel's sentences, not the official Global text. The same buff raised her three skills —
Radiant Power ATK 10% + 1.143% per 100 ATK up to 40% → 12% + 1.371% up to 48%, Holy Prayer
6% + 0.686% up to 24% → 8% + 0.914% up to 32%, Spirit Wave crit damage 10% + 0.625% per 1% up to
40% → 12% + 0.75% up to 48% — but every number in a line grew by the same factor, so lufel's
targets (each cap over its rate: 3502 ATK, 64% crit damage at LV10) are unchanged and nothing
was edited for them.

**What the game's own screens showed about the stat model** (Miku, 26 Sep 2026): a 4-piece's
unconditional line is part of the wearer's stats (her Labor +8% is on her character screen, so
`SET4_STATS` counts such lines); a weapon's *party* buff is not (her "+18.1% party crit damage"
is on neither screen, so it left `KIT_STAT_BUFFS`); the Thieves Den adds only in battle, as
lufel's guide says; and the game counts weapon refinement from R0.

**Awakening 7 is live on Global**, contrary to an earlier reading of this file. It is worth
a great deal — Kasumi Yoshizawa's `attack_per: 29` moves her zero-card ATK from 1986 to
2677 against a real panel of 2733 — so a character's Ascension setting is the first thing
to check when a total looks far too low.

Only **unconditional** weapon passives are counted automatically; `KIT_STAT_BUFFS` in
`logic.js` is the hand-kept list of conditional lines judged always-on in rotation, each
gated on the Awareness level or weapon it comes from and carrying its reason. "Increase Speed by 15/…/30." is a stat
you always have; "After user uses [Secret Art: Lightning Legs], increase critical rate by …"
is not, and is carried as `extra` text rather than a number. 116 of 130 weapons yield an
unconditional line; every one of the 14 that does not grants something this tool has no
concept of (shield strength, healing, elemental damage, Theurgy amplification).

A **second unconditional stat in the same sentence is not a condition**, and the parser used
to refuse the whole line over one. Mermaid Dreamer reads "Increase critical damage by
36.3%/… and Resonance critical rate by 16.4%/…" — two always-on effects, the first a plain
Crit Multiplier ladder — so Miyu Sahara [Wavecatcher] was scored 36.3% Crit Multiplier below
her real in-game panel, which is how this was found. A leading clause is now read even when
an "and" joins it to another, and the leftover is kept in `extra` beside the `b` it was split
from, so a weapon can carry both. The rule is narrow on purpose: the tail must itself be a
"<something> by <ladder>" clause, so "increase attack by 20% and 30% for 2 turns" stays one
conditional buff and stays uncounted. Measured over all 130 weapons, it reads exactly one
more passive than before.

The parser still keeps **one stat line per weapon**, and a second unconditional *sentence*
is dropped without leaving an `extra` behind. A scan of every weapon's text (Sep 2026) found
one: Kira's Bloodletter, whose "Increase ailment accuracy by 15%." follows its ATK ladder.
It is counted through `KIT_STAT_BUFFS` (weapon `'5'`) beside his Doctor-mode accuracy and
Bloodletter's damage against Bleed.

This matters more than it sounds. Kumi Katayama's 180 Speed target needs **73 Speed from
cards** on a 4★ weapon at A0 with no Mindscape, and **14** on a 5★ R7 at A7 with it — her
5★ *Lightning Riders* grants +15→30 Speed where her 4★ grants none, Awakening 7 moves her
base from 107 to 125.8, and her Mindscape adds another 10.

**Main stat magnitudes** are the one piece lufel does not have — but the game prints them on
the card detail panel, so `ocr/panel_ocr.py` reads them into an optional `mainValue`. A main
stat is deterministic at a given slot/stat/rarity/level, so one scanned max-level card
settles it for every card like it, and the user's scan has now settled all of them for 5★:
`MAIN_MAGNITUDE` in `src/data.js` (see the section below). The planner uses a scanned
`mainValue` first, that table for a 5★, and the inventory's own examples for other rarities.

**My Palace and party buffs remain unmodelled**, so every total the planner shows is a
floor, never an exact figure — a target it reports as missed may already be met in game.

**What lufel's numbers assume** is spelled out in each character's `battle_plus_stats` note,
read for all 37 targeted characters (Sep 2026). Every note lists My Palace and, where it
applies, the Elucidator donation ("해명의힘") and a role bonus ("직책 8%") — none of which
this tool models. The notes also name kit lines: Ashiya's "패시브 24%" (his own DEF passive),
Runa's and Koromaru's "전용무기: 효과명중" (the signature weapon's conditional accuracy line),
Chizuko's "의식3: … 10% (3중첩)" (her Awareness-2 accuracy stacks), Tempest Riko's
"의식 0: 60%" and "패시브(활기): 84%" (her SP Recovery node and her SP-Recovery-to-crit-damage
conversion), Shoki's "4성 무기: 효과 명중 40%" (his second 4★ weapon, Sipario, which
`CHAR_STATS` does not carry). So the lines `KIT_STAT_BUFFS` and `CONVERSIONS` count are the
ones lufel counts; what remains outside is My Palace, the role bonus, allies' passives and
set effects such as Mio's Futility 4-piece.

### Awareness — high confidence for the ladder text, user-verified for the stat curve

`ritual.js` (lufel's field name; the site's English UI labels it "Awareness") gives all
455 level-0-through-6 ability descriptions across the 65-character roster directly, so
there is nothing to infer for the text itself. What that data actually contains is the
finding worth recording: run through the same "bare, unconditional stat line" test the
weapon passives use, **zero** of the 455 qualify. Every one is gated on a trigger — start
of battle, on-crit, on-Theurgy, a stack mechanic, a duration — or is a skill-level-up. So
`CHAR_STATS[name].awareness` carries the name and full text of every level for reference,
and a `s`/`v`/`pct` stat only on whichever (currently none) genuinely parses as one. If a
future patch adds a character whose Awareness kit does include a plain stat line,
re-running `tools/gen-awareness.js` against a fresh `lufel.json` will pick it up on its
own — no code change needed, since `charBaseStat()` already applies whatever it finds.

**Separately, lufel does not publish a universal stat curve — the user confirmed one
directly from the in-game Awareness screen.** Every character gets the same flat
HP/ATK/DEF percentage as Awareness levels unlock: 102/105/107/110/112/115% of base at
levels 1-6, identical across the whole roster and across all three stats, checked against
Makoto Niijima [Queen]'s own panel. This is `AWARENESS_STAT_PCT` in `logic.js` — a plain
constant, not sourced from any `lufel.json` field, since it sits entirely outside the
`ritual.js` ability text. If a future ascension/awareness rebalance changes these numbers,
they need updating by hand the same way; there is no generator for this one.

### Main stat magnitudes — high for 5★, measured from the user's own cards

No source, lufel included, publishes what a main stat is worth, nor the drop-rate weighting
for which main stat rolls on Moon, Star and Sky. The magnitudes are now measured: across
3947 scanned 5★ cards every card of a given stat shows the same value at the same level,
and the growth is linear in level (a Lv14 ATK% main reads 19.6 = 4.6 + 14 × 1.072; Lv16/20/22
Sun HP cards read 750/897/970 on a 162 → 1080 line). `MAIN_MAGNITUDE` in `src/data.js`
carries the Lv0 and Lv25 value of every main:

| Main | Lv0 | Lv25 | In max rolls of its substat |
|---|---|---|---|
| ATK% / HP% / DEF% | 4.6 / 4.7 / 7.1 | 31.4 / 31.5 / 47.1 | 9.0 / 8.8 / 9.1 |
| Damage Multiplier | 3.7 | 25.1 | 9.0 |
| Crit Rate / Crit Multiplier | 2.8 / 5.7 | 18.8 / 37.6 | 9.4 / 9.2 |
| Ailment Accuracy / Speed / SP Recovery | 5.7 / 3.1 / 13.6 | 37.6 / 20.3 / 90.4 | 9.2 / 9.2 / 9.0 |
| HP Recovery | 3.4 | 22.6 | (no substat) |
| Sun: flat HP | 162 | 1080 | 7.7 |
| Space: ATK + DEF | 54 | 359 | 7.8 each |

So a max-level main is worth about **nine** maximum rolls of its own substat — as much as all
four substats of a perfect card together — and that is what `cardScore`, the coupling and the
damage model now price it at (`mainRolls()` in `logic.js`). The earlier `MAIN_ROLLS = 3`
estimate undervalued mains threefold, which is why the optimiser used to pick cards with a
dead main and strong substats over the reverse. Only 5★ cards have been scanned; other
rarities are assumed to sit on the same curve up to their own level cap, and a scanned
`mainValue` always wins over the table.

### The damage formula — medium confidence, and used only for its shape

`lufel.net/article/damage-calc` publishes the formula. Damage is a product of nine factors:

```
ⓐ ATK × ⓑ damage bonus × ⓒ enemy defence × ⓓ crit × ⓔ skill coefficient
      × ⓕ weakness × ⓖ final damage bonus × ⓗ other × ⓘ random 0.95-1.05
```

with the three the revelation cards move being

```
ⓐ = (character ATK + weapon ATK) × ATK%  +  flat ATK
ⓑ = 100% + Damage Mult + elemental damage bonus + increased damage taken
ⓓ = 100% + Crit Rate × (Crit Mult − 100%)
```

and the load-bearing line: *"Values within the same group are calculated through addition."*
Stats inside one factor are substitutes; the factors multiply. Lufel's own worked example
pins ⓓ — 40% crit rate at 220% crit multiplier gives `1 + 0.4 × 1.2 = 1.48` — and the
article states the resulting rule of thumb directly: *"If you increase critical rate by
10%, increasing Critical DMG(Mult) by twice that amount (20%) is most efficient."* That
factor of two is the ratio of the two stats' `maxRoll` (4.1 / 2.0), which is a real
independent check on the substat roll table in `src/data.js`.

**One factor the article leaves open, settled by a player test.** lufel says a skill's "+20% damage"
is ×1.2 for some kits and +20% for others. A Taiwanese research thread (Bahamut, "P5X 傷害計算公式探討",
Oct 2024, forum.gamer.com.tw bsn=71034 snA=1779) and its linked study ("P5X傷害計算公式及其詳細證明" v2.0,
OneDrive) find damage dealt, element damage and damage taken all in one sum, and one independent multiplier
they call the "Tech" multiplier: a damage increase written into an active skill ("under a condition, damage
+x%"), shown with a Technical mark. Their Cosmic Flare test (+22% on an ailing foe, ATK 2846, Shocked dummy
DEF 3374) predicts 853/895/810 as an addition and 880/924/836 as a multiplier; the hit read 880/923/837. They
list Joker's Skill 3 and Awareness 1, YUI's Skills 1 and 2 and her passive 靈動, 神山's Skill 1 and two Persona
uniques, and say several Tech multipliers multiply each other; Persona passives with near-identical text,
Joker's 吞噬 and Ann's 熱忱 (her Fireburn +30%) tested as additions. The Teams fight reads Fireburn (Rin's
"TECHNICAL effect rises to 20%") as such a multiplier (`amp`); it predates Rin and Mio and never tests
Technical Precision.

**Confidence is medium and the article says so itself**: it is reconstructed from early
Chinese Q&A, "over 100 different stats" feed damage, boss defence values cannot be found
in the game at all, and it advises against chasing exact numbers. So the formula is used
for its **structure** — which stats multiply, which add, where flat ATK lands — and never
to predict damage. `damageFactors()` computes ⓐⓑⓓ and only ever reports the ratio against
a perfect build for the same character. Three things it deliberately leaves out:

- **ⓒ, ⓔ, ⓕ, ⓖ, ⓗ, ⓘ** are enemy, skill, party or dice — the same for every loadout the
  character could wear, so they cancel in the ratio. (The Teams tab, which compares teams rather
  than loadouts, does price ⓒ and ⓕ, against the boss it picks from `BOSSES`: ⓕ is the article's 1.2 on a
  weakness, raised by weakness-damage buffs; a resisted hit's 0.5 is the same with or without the
  team, so it cancels.)
- **Resistance Pierce** sits inside ⓒ, so pricing it needs the enemy defence value lufel
  says has to be read out of the client. Its substat weight still prices it; the model does
  not, and `damageShare()` deliberately does not count it as captured.
- **Flat ATK** is the "Attack Constant", added *after* the ATK% multiplication, so it never
  compounds. That is why it is excluded from `cardScore`'s coupling, where no base ATK is
  available — but it *is* counted in `damageFactors`, which has `CHAR_STATS`.

### Which main stat per slot — high, and lufel lists more than one

`sub_revel2` / `sub_revel3` / `sub_revel4` in `setting.js` are the recommended Moon, Star
and Sky mains, and they are **arrays**: 94 of the roster's 195 slot recommendations name
two or more (Ann's Moon is ATK% or Damage Multiplier, most DPS Stars are either crit stat,
Yukari's and Ayaka's Moons are three deep). `ov.main` carries the whole legal list in
lufel's order, capped at `MAIN_CHOICES` (3, which lufel has never exceeded) since that is
what the target editor exposes.

Keeping only the head of each list — which the generator did until this was modelled — cost
every card carrying another of the alternatives the whole main-stat match bonus, which was
enough to keep genuinely correct cards out of the recommendation. Stats lufel lists that
are not legal for the slot are still dropped; `tools/audit-lufel.js` reports any list that
differs from lufel's legal part, in order.

A slot lufel fills with **"-"** (or leaves blank) names no main at all, and is stored as an
**open slot**, `[]`: Chizuko's and Runa's Moon and Sky, Yaoling's Moon and Star, Tempest
Riko's Moon, Aran's Moon and Sky (Sep 2026). The generator used to leave those slots on
whatever it had before — an archetype placeholder, or an old hand pick like Runa's HP% Moon
— which the scoring then treated as lufel's answer. A stat the generator cannot map is not a
"-", and keeps the fallback.

### Characters — high for 57 of 68

Sixty-eight entries. For 57 of them lufel publishes a build outright; for the other 11,
lufel's top build is built on a set or Space card that is not released yet — or, for
Koromaru and Aran Hirano, on a pairing Global does not have yet (Hindrance + Acuity) — so
the stored target is the best obtainable alternative and the character's note says what the
intended build will be. Every character currently carried has a published build — the generator
used to track this distinction in a `conf` field the Roster tab displayed as a tag, which
has since been removed as a feature; the underlying note text on affected characters is
unaffected.

Three characters were missing entirely and have been added: **Yukimi Fujikawa** (Yuki, 4★
Bless), **Yumi Shiina** (Phoebe, 5★), and **Hatsune Miku** (5★ collaboration). Three
further lufel entries are unreleased and carry no build, so they are deliberately not
imported: Ryuji·Starlight, Ken Amada and Shinjiro Aragaki (as of the 25 Sep 2026 refresh).
Ayaka·Summer, Ichigo·Summer and Kotone Shiomi were on this list and now carry a lufel build,
so they are imported; Kotone shipped on Global in 4.10 (2026-09-24), the two Summer units are
still undated there and sort last in the roster.

**Wonder is deliberately absent.** He is the protagonist, built through the Persona system
rather than the gacha, and has no Revelation build anywhere — lufel included, which is why
he is the one roster entry missing from its release schedule and its build index. He was
carried for a while on archetype defaults, which meant the planner invented a target it had
no basis for. Removing him is what keeps the generator from re-adding him: with no lufel
build and no previous entry to carry over, `gen-data-from-lufel.js` skips him and logs it.

### Elucidators donate a share of every stat — 20% at 5-star, 15% at 4-star

Every character whose `position` is `해명` carries the same kit passive, on `skill_highlight`:

> 해명 괴도 각 속성의 20%만큼 출전 중인 모든 동료의 상응하는 속성 수치가 증가한다.
> *("Increase all deployed allies' corresponding stats by 20% of the Elucidator Thief's
> respective stats.")*

Checked against all eight. The three 4★ Elucidators (Riko Tanemura, Miyu Sahara, Kayo
Tomiyama) read **15%** where the five 5★ ones read **20%** — the only difference, so this
is a property of the role rather than a per-character effect.

This is why an Elucidator legitimately wants crit stats while being unable to crit: seven
of the eight have a 0% / 0% crit base, and the stats are bought to be given away. The
scoring consequence is in `docs/SCORING.md` §5 — the damage-spread term is gated off for
them, because the ⓐⓑⓓ product computed from their own board is never evaluated by the game.

Not modelled: what a donated point is actually worth, which depends on the receiving ally's
own balance.

### Archetype — from `position`, not the role prose, and never regenerated

`arch` drives the substat fallback for every stat lufel never mentions, plus the default
main stat per slot, so a wrong one quietly changes a character's whole recommendation.

lufel carries the answer twice. `character_info.characterData[*].position` is a
**structured** field with eight values, and it maps 1:1 onto our eight archetypes —
checked across the whole roster, 65 of 65 agree, with no value ever landing on two
archetypes:

| `position` | Archetype | n |
|---|---|---|
| 반항 | ST DPS | 16 |
| 지배 | AoE DPS | 12 |
| 굴복 | Saboteur | 9 |
| 해명 | Navigator (Elucidator) | 8 |
| 우월 | Strategist | 8 |
| 방위 | Guardian | 5 |
| 구원 | Healer | 5 |
| 자율 | Virtuoso | 2 |

The settings file's `role` is **free-form prose** describing what a unit does, not what it
is, so a phrase can match the wrong test before the right one is reached. The generator
used to read only that, and **5 of the 8 Elucidators came back wrong**: Futaba, Riko,
Kayo and Yumi Shiina all describe themselves as a "서포터" (supporter) and resolved to
Strategist, while Miyu Sahara's "실드/방어력 서포터" resolved to Guardian.

Only Yumi Shiina actually reached `src/data.js` wrong, because `arch` is carried from the
previous `src/data.js` rather than regenerated (see the header note in the generator) and
the other four predate the bug. She was a new entry, so she got the fallback — and stored
`Strategist` against lufel's `해명`. Her own build gave it away: both her preferred set
(Labor's 4-piece) and her Space pairing (Integrity + Labor) read *"when equipped by
Navigator Thieves"*, so a non-Navigator archetype makes her recommended build inert.

`archFor()` now prefers `position` and keeps the prose only as a fallback, with 해명 tested
before the supporter catch-all. Because `arch` is still never regenerated, the generator
**reports** any stored archetype that disagrees with `position` instead of silently keeping
it — a regeneration will name it, but the fix is still a hand edit to `src/data.js`.

A test asserts every Buff-element character running a Navigator-gated set is a Navigator.

### Roster order — release order, from the schedule not `release_order`

`CHARACTERS` is ordered the way lufel's Release Schedule page lists it, v0.0 forward, and
the array order is what the UI renders. `release_order` in `character_info.js` looks like
the field for this but is not usable alone: all seventeen launch characters share a value,
Wonder has none, and on the two patches that shipped a pair it disagrees with the schedule
about which came first (it puts Shoki before Manaka and Anri before Radiance Motoha; the
schedule, and the site's own rendering of v4.0 and v5.0.1, put them the other way). The
schedule is also explicitly the **GLB/JP** timeline, which is the server the user plays; it
warns on the page that the order derives from Asia-server history and may still move.

The schedule splits into `manualReleases` (confirmed dates, through v3.2.1) and
`autoGenerateCharacters` (order fixed, dates partly projected from the release cadence).
Both are read, in that order, so a projected date never reorders a shipped character. The
four entries with no date at all (`schedulePending`) sit at the end and carry no build, so
they are not imported.

### Wonder's stats — measured on the user's panel (6 Nov 2026), built as `wonderCalc`

No site publishes how Wonder's panel is built. lufel has no Persona or dagger base stats; Prydwen
has none either; the Megami Tensei Wiki's P5X Persona table has level-1 and max-level fields, but
its own example leaves the max-level row blank, and the site blocks every automated read
(Cloudflare, API and REST alike). Samurai Gamers lists max stats for eight daggers (CN/TW/KR
versions; it does not say at which level). So the formula is being read off the user's own
character screen (outside battle, so no Thieves Den), one change at a time.

Setup: Starry Compass Lv 80, R6 (its own screen: HP 2051, ATK 654, DEF 356, "Increase Attack by
56.0%"). Persona screens: Kohryu Lv 99 836/295/197, Janosik Lv 99 1152/320/213, Belphegor Lv 60
500/138/121, Ippon-Datara Lv 1 155/34/28, Mandrake Lv 1 155/34/28 (HP/ATK/DEF).

| Reading | Slot 1 / 2 / 3 | ATK | DEF | HP |
|---|---|---|---|---|
| A1 | Kohryu / Janosik / Belphegor | 4439 | 2469 | 11580 |
| A2 | Kohryu / Ippon-Datara / Mandrake | 3639 | 2108 | 9789 |
| A3 | Kohryu / Janosik / Mandrake | 4225 | 2348 | 11120 |

The other panel stats did not move between them: SP 100, Speed 100, crit rate 31.5%, crit damage
190%, ailment accuracy 80%, damage multiplier 10.8%.

Schema (Phantom Thieves menu), as the user read it: HP +1200, HP +20%, ATK +300, ATK +20%,
DEF +300, DEF +20%, crit rate +20%, crit damage +40%, ailment accuracy +80%, ailment resistance
+40%, HP recovery +48%, shields granted +48%. Ego level 84: HP +3360, ATK +840, DEF +840 (40 HP and
10 ATK/DEF a level). Also: the equipped Persona's base and learned active skills +5 levels, and
the effect of 1 More, Highlight, melee and ranged attacks raised.

What the three readings settle:

- **All three slots add their Persona's base stats, equally.** Each panel stat is a straight line
  in the sum of the three Personas' stats, with the same slope in every reading: ×2.051 for ATK,
  ×1.30 for DEF, ×1.334 for HP (every reading reproduced to within 1).
- **Only the slot-1 Persona's talent shows.** ATK's slope is 1 + 56% (dagger) + 20% (Schema) +
  29.1% (Kohryu's Auspicious Sign: "Increase Attack by 29.1%"). Janosik's talent carries the same
  29.1% and did not count from slot 2. This matches the Teams tab's rule that a Persona's passives
  work only while it is in use.
- With the Schema and Ego flats added after the percentage, Wonder's own base reads about
  201 ATK, 136 DEF, 725 HP. With them inside it, his base would be negative, so at least the
  Ego flats sit outside.

A fourth reading, A4, put Belphegor (talent: ailment resistance +17%; no ATK line) in slot 1 with Kohryu and
Janosik behind it: ATK 3971 (predicted 3971), DEF 2469, HP 10870, crit rate 25%, crit damage 190%, damage
multiplier 0%. So **slot 1 also brings its Persona's passive skills**, and only slot 1's: Kohryu's skills (the
user's list: Spirit Strike, Thief Tactics, Battle Acumen IV, Life Aid IV, Marakukaja, Energy Drop, Apt Pupil III,
HP Boost IV) are HP Boost IV (+13.5% HP), Apt Pupil III (+6.5% crit rate) and Battle Acumen IV (+10.8% damage),
exactly what left the panel with him. Janosik's Attack Boost I (+5.8% ATK) never counted from slot 2; Belphegor's
Attack Master II ("at the start of battle") is not on the panel from slot 1 either.

The panel as measured, every reading reproduced:

```
HP/ATK/DEF = (Wonder's own + dagger flat + all three Personas' stat)
             × (1 + dagger % + Schema % + slot-1 talent % + slot-1 passive skills %)
             + Schema flat + Ego flat (40 HP, 10 ATK, 10 DEF per Ego level)
crit rate  = 5 + Schema 20 + slot-1 passive skills;  crit damage = 150 + Schema 40
damage multiplier = slot-1 passive skills;           ailment accuracy = Schema 80
```

Wonder's own part, solved from the readings: ATK 201.5 (A1 and A4 agree to 0.1), HP 719, DEF 135. Whether it
grows with his level is not known.

Schema's DEF bonus is +30%, not the +20% first read (the user's correction), which makes DEF's 30% whole: every
panel number is now accounted for.

**Speed** (the user, from play): Wonder's Speed is the slot-1 Persona's Speed, changed by that Persona's skills
(Agility Master I-IV +6/+9/+12/+15, which also cost 0/4/8/12% DEF; Ironclad Resolve I-IV −6/−9/−12/−15 with
+15/22/29/36% HP). That is why a fast Persona is put in slot 1: Wonder then acts before the damage dealer. Not yet
read off a Persona screen.

### Places where lufel and the stored data deliberately disagree

All are recorded here because a future regeneration will surface them again. Items 2-5
live in `gen-data-from-lufel.js`'s `WEIGHT_OVERRIDES` table, which is applied on every run
and reports itself on stderr.

1. **Off-element sets.** Lufel recommends an off-element 4-piece for five characters —
   Messa (Physical) is told to run Pleasure (Psychokinesis), Frostgale Kotone (Wind) to run
   Opulence (Ice), and so on. This is not a transcription error: the value sits entirely in
   the Space-card pairing (Wisdom + Pleasure converts Ailment Accuracy into damage, which is
   exactly what Messa stacks), with the set's own elemental 2- and 4-piece written off. The
   scoring engine returns 0 for both off-element bonuses and has no way to express "take a
   dead 4-piece to unlock a Space effect", so these are dropped from the target and stated in
   the character's note instead.

2. **Messa's crit.** The stored build has `Crit Rate: 0` and `Crit Multiplier: 0` for Kira
   Kitazato, from a guide claiming his Rending damage cannot crit at all. Lufel ranks both
   in its third and lowest priority tier — low, but not dead. The zeros are kept because a
   hard "cannot crit" is a mechanical claim the three-tier system cannot express either way,
   and `gen-data-from-lufel.js` reports the disagreement on every run. **Worth checking in
   game**, since it changes his substat targets materially.

3. **ATK% on the DEF- and HP-scaling kits.** Yusuke, Ashiya, Fujikawa, Junpei, both Shuns,
   Kiyoshi Kurotani, Summer Ichigo and Beachflower Minami carry `ATK%: 0`. Lufel does not list ATK% for any of them, and the
   generator's rule for an unlisted stat is a cap at 4 over the archetype floor — but 4 is a
   third of a real weight for a stat their kits never read: every damage, shield and buff
   line in those kits is a fraction of DEF or max HP, with no Attack coefficient
   anywhere (checked in lufel's skill data). The eight that deal damage are also
   `DAMAGE_SCALE` in `logic.js`, which puts DEF/HP in the ATK factor's seat for them.
   Beachflower Minami joined in Sep 2026: Beach Basket (64.4% of max HP) is her only damage
   line, and her buffs scale off her max HP and crit multiplier.

4. **Seaside Moko's Damage Multiplier.** Lufel puts Damage Multiplier in her first
   priority tier, level with ATK%. Her kit backs that up as far as it goes — her Resonance
   deals Psy damage equal to 19% of ATK, up to five times — so this is not a transcription
   error either. It is stored at 5 rather than 10 because lufel is ranking *which* stats a
   unit uses, not how much less the second one is worth, and her damage is a small share of
   a team total next to her healing (which scales off ATK, so ATK% stays at 10 and covers
   both). The crit stats drop from 8 to 3 for the same reason, compounded by her innate
   5% / 150% crit base leaving the crit factor near 1.

   The magnitude matters more than a ranking wobble because the weights also feed
   `damageShare` and the ideal loadout the build score divides by — at lufel's own numbers
   a flawless heal build could not score above 82. **Worth revisiting** if her Resonance
   damage turns out to carry a real share of a team's total, or if a future patch scales
   it up.

5. **Lufel's ATK%.** Lufel publishes no substat tiers for Lufel the healer, so she ran on
   the Healer archetype, which is an HP-scaling healer's order (SP Recovery 8, HP% 6, ATK%
   5). Every heal in her kit is a fraction of her ATK and lufel names ATK% for her Star and
   Sky, so `WEIGHT_OVERRIDES` sets it to 10. This is not a disagreement with lufel's order —
   there is none for her — but it is a judgement, and is recorded as one.

Not a disagreement, but a generator rule worth knowing: the archetype floor may raise a stat
lufel ranks, never to the weight of a stat lufel ranks above it. It used to, for three
characters — SP Recovery (tier 3) on Minami and Seaside Tomoko at the Healer floor of 8, level
with a tier-2 stat, and Crit Rate (tier 3) on Ichigo at the ST DPS floor of 9, above her tier-2
ATK% and Damage Multiplier. Those now take the tier-3 value, 6.

## Sources

- **Lufelnet — `lufel.net`** — the reference for builds, sets and pairings. Confirmed by the
  user in preference to the sites below; prefer it wherever they disagree.
- Prydwen — [Arcana Cards guide](https://www.prydwen.gg/persona-5x/guides/arcana-cards),
  [character list](https://www.prydwen.gg/persona-5x/characters)
- Game8 — [all Revelation Cards](https://game8.co/games/Persona-5-Phantom-X/archives/532937),
  [stats guide](https://game8.co/games/Persona-5-Phantom-X/archives/537907)
- [TheGamer](https://www.thegamer.com/persona-5-the-phantom-x-revelation-cards-gear-artifacts-guide/),
  [DBLTap](https://www.dbltap.com/guides/p5x-best-revelation-cards-every-character),
  [SetsunaEpic](https://setsunaepic.com/persona-5-the-phantom-x-revelation-cards-guide/),
  [Fragster](https://www.fragster.com/persona-5-the-phantom-x-revelation-cards-complete-list-and-effects/)
- The user's own in-game screenshots (Aug 2026), which is where `Futility`, `Sorrow`,
  `Disappointment`, `Change` and `Perseverance` were first found

## Priority order for corrections

1. Main stat magnitudes for 4★ and 3★ cards — 5★ is measured; the rest is assumed to follow
   the same curve.
2. Whether Messa's Rending damage can crit (see above).
3. Re-run `tools/audit-lufel.js` after each game patch; lufel updates promptly.

Correcting the data beats tuning the scoring constants. The engine is only as good as the
numbers behind it.
