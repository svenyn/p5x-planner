#!/usr/bin/env node
/* Regenerates the SETS, SPACE_SETS and CHARACTERS blocks of src/data.js from
 * lufel.net's own data files.
 *
 *     node tools/fetch-lufel-data.js lufel.json
 *     node tools/gen-data-from-lufel.js lufel.json > blocks.js
 *
 * Emits source text rather than patching src/data.js in place, so the result can
 * be read before it is pasted in. Three things are deliberately NOT taken from
 * lufel and are carried over from the current src/data.js instead:
 *
 *   - `arch`, because lufel's role strings are free-form Korean prose and our
 *     archetypes drive the substat fallback for stats lufel never mentions;
 *   - `bonus2` (and `bonus2Also`, a second stat the same line moves), which is a
 *     scoring model ("+12% ATK is worth N max ATK% rolls"), not a transcription —
 *     lufel supplies the effect text, we choose the number;
 *   - hand-written `note` prose, which explains things lufel states only implicitly.
 *
 * Unreleased content (lufel tags it 미출시) is emitted with `unreleased: true` so
 * imports recognise the names, but is kept out of character build targets — a
 * set with no obtainable cards must not displace the best set the user can farm.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const UNRELEASED = '미출시';

/* lufel spells this one without the second 'i'; ours matches the in-game English. */
const SET_RENAME = { Reconcilation: 'Reconciliation' };

const STAT_KR = {
  '공격력': 'ATK%', '생명': 'HP%', '방어력': 'DEF%', '방어': 'DEF%',
  '대미지보너스': 'Damage Multiplier', '대미지 보너스': 'Damage Multiplier',
  '크리티컬 확률': 'Crit Rate', '크리티컬 효과': 'Crit Multiplier',
  '효과명중': 'Ailment Accuracy', '효과 명중': 'Ailment Accuracy',
  '속도': 'Speed', '관통': 'Resistance Pierce',
  'SP회복': 'SP Recovery', 'SP 회복': 'SP Recovery',
  '치료효과': 'HP Recovery', '치료 효과': 'HP Recovery'
};
/* Every stat lufel's build recommendations can name. A stat in this list that a
   character's tiers omit was considered and passed over, so it may be demoted;
   a stat outside it (flat ATK/DEF/HP) simply has no lufel opinion. */
const LUFEL_VOCAB = new Set(Object.values(STAT_KR));

/* Breakpoint targets are absolute in-battle totals ("공격력 4600" is 4600 Attack, not
   4600%), so they take the flat stat name rather than the %-substat name STAT_KR would
   resolve to. Only 37 of the 65 characters have any. */
const BP_KR = {
  '공격력': 'ATK', '생명': 'HP', '방어력': 'DEF', '속도': 'Speed', '관통': 'Resistance Pierce',
  '효과명중': 'Ailment Accuracy', '효과 명중': 'Ailment Accuracy', '크리티컬 확률': 'Crit Rate',
  '크리티컬 효과': 'Crit Multiplier', 'SP회복': 'SP Recovery', 'SP 회복': 'SP Recovery',
  '치료효과': 'HP Recovery', '효과저항': 'Ailment Resistance', '대미지보너스': 'Damage Multiplier',
  '대미지 보너스': 'Damage Multiplier'
};

/* The substat a target is actually chased with. A "4600 ATK" target is met by stacking
   ATK% (and flat ATK); "180 Speed" by flat Speed. Percentage-of-a-stat targets map to the
   %-substat, absolute-number targets to the flat one, and the rest are their own substat. */
const BP_SUBSTAT = { ATK: 'ATK%', HP: 'HP%', DEF: 'DEF%' };

const BP_TIERS = ['LV10', 'LV10+5', 'LV12', 'LV12+5', 'LV13', 'LV13+5'];

/* ---- everything outside the revelation cards that moves a stat -------------------
   A target like "180 Speed" is an in-battle total, so whether a build needs 73 Speed
   from cards or 14 depends on the character's level and ascension, which weapon they
   hold and at what refinement, and whether their Mindscape is unlocked. All three are
   on lufel; none of it was being read. */

/* Weapon passives are prose. Only a bare, unconditional "Increase <stat> by <ladder>."
   at the very start of the description is counted — anything with a condition, a
   duration or a target other than the wearer is left for the reader, because a
   conditional buff is not something a build can be assumed to have up.

   A *second* unconditional stat in the same sentence is not a condition, though, and
   refusing the whole line over it loses a stat the character always has. Mermaid
   Dreamer reads "Increase critical damage by 36.3%/… and Resonance critical rate by
   16.4%/…": two independent always-on buffs, of which the first is a plain Crit
   Multiplier ladder. Dropping it cost Miyu Sahara [Wavecatcher] 36.3% Crit Multiplier
   against her real in-game panel. So a leading clause is read even when an "and" joins
   it to another, on the same principle the sentence split below already uses — take
   the part that parses, leave the rest in `extra`. It is deliberately narrow: the tail
   must itself be a "<something> by <ladder>" clause, so "increase attack by 20% and
   30% for 2 turns" stays one conditional buff and stays uncounted. Measured over all
   130 weapons lufel publishes, this reads exactly one more passive than before. */
const WEAPON_STAT_EN = {
  'attack': 'ATK%', 'defense': 'DEF%', 'max hp': 'HP%', 'hp': 'HP%',
  'speed': 'Speed', 'critical rate': 'Crit Rate', 'critical damage': 'Crit Multiplier',
  'ailment accuracy': 'Ailment Accuracy', 'penetration': 'Resistance Pierce',
  'pierce rate': 'Resistance Pierce', 'sp recovery': 'SP Recovery'
};
/* "Increase <Element> damage by <ladder>." (Rosethorn/Fire, Quasar/Electric, Nuclear
   Finisher/Nuclear, Colorful Coast/Bless, Victory Beam/Almighty) is exactly as
   unconditional as any other bare weapon ladder, but was never in WEAPON_STAT_EN, so
   it always fell to `extra` as unparsed text and charBaseStat/damageBase counted it as
   0 — a 24-46% damage term missing from every character whose weapon carries one.
   It is priced as the same 'Damage Multiplier' stat a set's own elemental 2-piece
   (e.g. Truth's "Nuclear damage +10%", src/data.js bonus2) already maps onto: ⓑ sums
   generic Damage Multiplier and elemental damage bonus as separate terms (see
   CLAUDE.md), so which bucket a contributor lands in cannot change the total, only
   the label — and this tool has no per-element bucket to put it in anyway. */
// Same element vocabulary as ELEM_KR/ELEM_EN below, inlined because both are declared
// later in this file and WEAPON_STAT_EN must be complete before WEAPON_RE is built.
['Physical', 'Gun', 'Fire', 'Ice', 'Electric', 'Wind', 'Psychokinesis', 'Nuclear', 'Bless', 'Curse', 'Almighty']
  .forEach(e => { WEAPON_STAT_EN[`${e.toLowerCase()} damage`] = 'Damage Multiplier'; });
const WEAPON_RE = new RegExp('^Increases?\\s+(' + Object.keys(WEAPON_STAT_EN).join('|') +
  ')\\s+by\\s+([\\d.]+(?:\\s*%?\\s*/\\s*[\\d.]+)*)\\s*(%?)\\s*\\.?$', 'i');
/* The tail after an "and" only counts as an independent second buff if it is itself a
   "<something> by <ladder>" clause — see the note above. */
const WEAPON_PARALLEL_RE = /^[A-Za-z][A-Za-z\s]*\s+by\s+[\d.]/i;

/* Returns the counted ladder plus `rest`, the same-sentence clause split off and left
   uncounted, so the caller can carry it into `extra` rather than drop it silently. */
function parseWeaponBonus(desc) {
  if (!desc) return null;
  let first = String(desc).split(/\n/)[0].split(/(?<=\.)\s*(?=[A-Z[])/)[0].trim();
  let rest = '';
  const at = first.search(/\s+and\s+/i);
  if (at >= 0) {
    const tail = first.slice(at).replace(/^\s+and\s+/i, '');
    if (WEAPON_PARALLEL_RE.test(tail)) { rest = tail; first = first.slice(0, at).trim(); }
  }
  const m = first.match(WEAPON_RE);
  if (!m) return null;
  const r = m[2].split('/').map(x => parseFloat(x));
  if (r.length !== 7 || r.some(isNaN)) return null;
  return { s: WEAPON_STAT_EN[m[1].toLowerCase()], pct: m[3] === '%' || /%/.test(m[2]), r, rest };
}

/* Mindscape nodes, e.g. "속도 10!" or "효과명중 24%×". The trailing marks are lufel's
   own emphasis (! worth taking, × skip it) and are kept as a tag for the UI. */
function parseMind(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t || t === 'nan') return null;
  const m = t.match(/^([가-힣A-Za-z][가-힣A-Za-z\s]*?)\s*([\d.]+)\s*(%?)\s*([!×xX]?)$/);
  if (!m) return null;
  const stat = BP_KR[m[1].trim()];
  if (!stat || stat === 'Ailment Resistance') return null;   // not a stat this tool models
  const pct = m[3] === '%';
  return { s: pct && BP_SUBSTAT[stat] ? BP_SUBSTAT[stat] : stat, v: parseFloat(m[2]), pct, tag: m[4] || '' };
}

/* "효과명중 171.5%" -> { stat, value, pct }. lufel separates several targets in one tier
   with a comma, and sometimes trails a parenthetical ("속도 176 (180)", "관통 31.5% (A6)")
   which is commentary, not part of the number. */
function parseTargets(minimumStats) {
  const byStat = {};
  for (const tier of BP_TIERS) {
    const raw = minimumStats && minimumStats[tier];
    if (!raw || raw === true) continue;
    for (const piece of String(raw).split(',')) {
      const m = piece.trim().match(/^([가-힣A-Za-z][가-힣A-Za-z\s]*?)\s*([\d.]+)\s*(%?)/);
      if (!m) continue;
      const stat = BP_KR[m[1].trim()];
      if (!stat) { console.error(`  ! unmapped target stat "${m[1].trim()}" in "${piece.trim()}"`); continue; }
      const key = stat;
      byStat[key] = byStat[key] || { s: stat, pct: m[3] === '%', sub: BP_SUBSTAT[stat] || stat, tiers: {} };
      byStat[key].tiers[tier] = parseFloat(m[2]);
    }
  }
  return Object.keys(byStat).map(k => byStat[k]);
}

const ELEM_KR = {
  '물리': 'Physical', '총격': 'Gun', '화염': 'Fire', '빙결': 'Ice', '전격': 'Electric',
  '질풍': 'Wind', '염동': 'Psychokinesis', '핵열': 'Nuclear', '축복': 'Bless',
  '주원': 'Curse', '만능': 'Almighty', '버프': 'None', '질풍빙결': 'Wind'
};
/* Element carried by an elemental 2-piece ("Ice DMG increased by 10%"). */
const ELEM_EN = ['Physical', 'Gun', 'Fire', 'Ice', 'Electric', 'Wind', 'Psy', 'Nuke', 'Bless', 'Curse'];
const ELEM_CANON = { Psy: 'Psychokinesis', Nuke: 'Nuclear' };

/* Hand-written prose in src/data.js that only existed because the guide sources
   disagreed or went quiet. lufel answers all of these directly, so the caveat is
   now noise — the sentence is dropped and the data it hedged about is replaced.
   Prose describing kit mechanics is kept; only source-uncertainty is stripped. */
const SUPERSEDED = {
  'Ann Takamaki': ['Source slot list appeared shifted by one — verify main stats in game.'],
  'Chizuko Nagao': ['Sources were vague on Moon/Sky — HP or offensive both viable.'],
  'Runa Dogenzaka': ['One source assigned Ailment Accuracy to both Star and Sky — Sky cannot roll it, so Star only.'],
  'Motoha Arai [Tropical]': ['Prydwen says Resolve space card, dbltap says Wisdom. '],
  'Minami Miyashita': ['Base Speed is only 94 — she needs Speed substats. Target 80%+ SP Recovery.'],
  'Makoto Yuki': ['Prydwen names his set "Ruin" with a 4-piece ATK buff. That set is not in the set list I could verify, so its 2-piece effect is unknown — check it in game.']
};

/* Hand-tuned substat weights, applied on top of lufel's tiers.

   Lufel publishes an ORDER — three priority tiers — and the tier mapping below turns
   that order into magnitudes, 10/8/6. That conversion assumes every character's
   priorities fall off at the same rate, and they do not. A DPS whose whole job is one
   damage number wants its tier-2 stats nearly as much as its tier-1 ones; a support
   who contributes a little chip damage on the side does not, even when lufel correctly
   lists that damage stat first. Sharing one falloff across all 65 characters reads the
   ordering right and the magnitudes wrong.

   So this table is where a measured, per-character judgement about MAGNITUDE lives. It
   is not a place to disagree with lufel's ordering — reorder by fixing the source data.
   Two things qualify an entry:

     - a kit fact the three tiers cannot express (Skull always crits, so Crit Rate is
       dead rather than merely low), or
     - a character whose weight VECTOR is broader than their actual contribution, where
       the flat falloff overstates a genuine-but-minor stat.

   Every entry carries a `why` and is reported on stderr when applied, so a regeneration
   always says out loud where it is not simply echoing lufel. This lives in the generator
   rather than in src/data.js because a hand edit to src/data.js is lost on the next run
   — see the note at the top of this file. */
const WEIGHT_OVERRIDES = {
  'Ryuji Sakamoto': {
    w: { 'Crit Rate': 0 },
    why: 'his damage always crits, so Crit Rate is dead weight, not a low priority'
  },
  'Kira Kitazato': {
    w: { 'Crit Rate': 0, 'Crit Multiplier': 0 },
    why: 'his Rending damage cannot crit at all'
  },
  /* Kits with no ATK scaling at all. Lufel lists ATK% for none of them, and the tier map's
     rule for an unlisted stat is a cap at 4 over the archetype floor — but 4 is a third of a
     real weight for a stat these kits never read: every damage, shield and buff line is a
     fraction of DEF (Yusuke, Ashiya, Fujikawa) or max HP (Junpei, both Shuns, Kiyoshi, Summer
     Ichigo, Beachflower Minami), with no Attack coefficient anywhere in lufel's skill data.
     The eight damage dealers among them are also DAMAGE_SCALE in logic.js, which puts DEF/HP
     in the ATK factor's seat. */
  'Yusuke Kitagawa':   { w: { 'ATK%': 0 }, why: 'every damage line is a fraction of DEF; no ATK coefficient in the kit' },
  'Masaki Ashiya':     { w: { 'ATK%': 0 }, why: 'every damage and shield line is a fraction of DEF; no ATK coefficient in the kit' },
  'Yukimi Fujikawa':   { w: { 'ATK%': 0 }, why: 'shields and the Oath buff scale off DEF; no ATK coefficient in the kit' },
  'Junpei Iori':       { w: { 'ATK%': 0 }, why: 'damage, shield and party buffs are fractions of max HP; no ATK coefficient in the kit' },
  'Shun Kano':         { w: { 'ATK%': 0 }, why: 'damage is a fraction of max HP; no ATK coefficient in the kit' },
  'Shun Kano [Pioneer]': { w: { 'ATK%': 0 }, why: 'damage and party buffs are fractions of max HP; no ATK coefficient in the kit' },
  'Kiyoshi Kurotani':  { w: { 'ATK%': 0 }, why: 'Fire damage scales off max HP; no ATK coefficient in the kit' },
  'Ichigo Shikano [Summer]': { w: { 'ATK%': 0 }, why: 'damage, party buffs and heals are fractions of max HP; the one ATK line (the boat ram) reads the Helmsman\'s ATK, not hers' },
  'Minami Miyashita [Beachflower]': { w: { 'ATK%': 0 }, why: 'Beach Basket, her only damage line, is a fraction of max HP, and her buffs scale off max HP and crit multiplier; no ATK coefficient in the kit' },
  /* Lufel publishes no substat tiers for her, so the Healer archetype applied as it stands —
     and that is an HP-scaling healer's order, HP% (6) and SP Recovery (8) above ATK% (5).
     There is no lufel order here to disagree with: this sets the one her kit states. */
  'Lufel': {
    w: { 'ATK%': 10 },
    why: 'every heal in her kit is a fraction of her ATK (Owl Green 67.4%, Healing Satellite '
       + '42.1%, Highlight 59.7%), and lufel names ATK% for both her Star and her Sky; under '
       + 'the archetype order an HP% Star and an SP Recovery Sky both outscored those at equal '
       + 'substats. HP% keeps its archetype weight — Sparks of Support turns max HP into '
       + 'healing, up to 12000'
  },
  'Tomoko Noge [Seaside]': {
    w: { 'Damage Multiplier': 5, 'Crit Rate': 3, 'Crit Multiplier': 3 },
    why: 'a healer whose Resonance chips for 19% of ATK — real damage, but a small share '
       + 'of a team total, so lufel ranking Damage Multiplier alongside ATK% overstates it. '
       + 'ATK% stays at 10 because it drives her healing as well as that damage. Measured: '
       + 'at lufel\'s own 10/8/8 a FLAWLESS heal build cannot score above 82, since the '
       + 'weights also set damageShare (0.649, the highest of any healer) and the ideal '
       + 'card the build score divides by. At 5/3/3 that build scores 96, a crit build '
       + 'still scores 83, and damageShare lands at 0.524 — beside Yukari 0.511 and '
       + 'Morgana 0.529.'
  }
};

/* Where the Global client's numbers differ from lufel's, which follows the JP data, and the
   user has confirmed the Global value in game. Applied over what lufel publishes on every
   run, reported on stderr, and written into src/data.js with its reason beside the line —
   the same contract as WEIGHT_OVERRIDES, for CHAR_STATS. Until Sep 2026 the one there was
   was a hand edit in src/data.js, which the next regeneration would have reverted. */
const GLB_STAT_OVERRIDES = {
  'Makoto Niijima': {
    mind: [{ s: 'ATK%', v: 20, pct: true }, { s: 'Resistance Pierce', v: 7.5, pct: true, tag: '!' }],
    why: "GLB Mindscape reads Resistance Pierce, not lufel's (JP) Crit Rate - confirmed in-game by the user"
  },
  /* Settled from the user's own panels (26 Sep 2026), every other ATK% source pinned: at
     Awareness 0, weapon R0 and both Mindscape paths at 5, her character screen reads ATK 4627,
     which needs 47% from Awakening 7 + Mindscape + her Labor 4-piece; Mindscape is +20% (read
     off the game's Mindscape screen) and Labor +8% (her HP and DEF carry it too), leaving 19. */
  'Hatsune Miku': {
    aw: { attack_per: 19 },
    why: "GLB Awakening 7 is ATK +19%, not lufel's 29 - solved from the user's character screen with every other ATK% source confirmed"
  }
};

/* Remove any number of copies of the generator's own appended sentences (see `note`
   below, where they are written). Anchored on both ends so a partial match cannot eat
   neighbouring hand-written prose. */
const GENERATED_NOTE_RE = [
  /\s*Lufelnet also recommends [\s\S]*?left out of the target above\./g,
  /\s*Lufelnet's top build for this unit is [\s\S]*?best obtainable alternative\./g
];
const stripGenerated = t =>
  GENERATED_NOTE_RE.reduce((acc, re) => acc.replace(re, ''), t || '').trim();

const canonSet = n => SET_RENAME[n] || n;
/* Lufel's effect text is lifted from the client and now and then keeps its colour markup —
   Nativity's Strife line reads "increase party's critical damage by <color=%s>10%</color>" —
   which is noise in a tooltip. */
const plain = t => String(t == null ? '' : t).replace(/<\/?color[^>]*>/gi, '').replace(/\s+/g, ' ').trim();
const splitStats = s => String(s == null ? '' : s)
  .split(/[\/,]/).map(x => x.trim()).filter(x => x && x !== '-')
  .map(x => STAT_KR[x]).filter(Boolean);

function loadOurs() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'data.js'), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(src.replace(/^(\s*)(?:const|let)\s+/gm, '$1var '), ctx);
  return ctx;
}

function loadLufel(file) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const settings = {};
  for (const [kr, mod] of Object.entries(d.settings)) {
    const bag = mod.characterSetting || mod[Object.keys(mod)[0]];
    const v = bag && (bag[kr] || bag[Object.keys(bag)[0]]);
    if (v) settings[kr] = v;
  }
  // base_stats.js and weapon.js each nest one level under the Korean name
  const unwrap = bag => {
    const out = {};
    for (const [kr, mod] of Object.entries(bag || {})) {
      for (const v of Object.values(mod)) {
        if (v && typeof v === 'object' && v[kr]) { out[kr] = v[kr]; break; }
      }
    }
    return out;
  };
  const weaponsEn = {};
  for (const [kr, mod] of Object.entries(d.weapons || {})) {
    const en = mod.enCharacterWeaponData || {};
    if (en[kr]) weaponsEn[kr] = en[kr];
  }
  return { en: d.revelations_en.enRevelationData, map: d.revelations_en.mapping_en || {},
           kr: (d.revelations_kr && d.revelations_kr.revelationData) || null,
           roster: d.character_info.characterData, settings,
           base: unwrap(d.base_stats), weapons: weaponsEn,
           schedule: (d.schedule && d.schedule.ReleaseScheduleData) || null };
}

/* Korean name -> position in lufel's GLB/JP release schedule, in the order its page
   paints them: every confirmed version first, then the ones whose date is only
   projected. This is what the roster is sorted by; `release_order` in
   character_info.js is too coarse to use on its own — the entire launch roster shares
   one value, Wonder has none at all, and on the pairs that ship together (Manaka
   with Shoki, Radiance Motoha with Anri) the two disagree about which came first. */
function scheduleOrder(sched) {
  const pos = new Map();
  if (!sched) return pos;
  for (const v of [...(sched.manualReleases || []), ...(sched.autoGenerateCharacters || [])]) {
    for (const kr of v.characters || []) if (!pos.has(kr)) pos.set(kr, pos.size);
  }
  return pos;
}

/* 'Space+Set' -> { version, date } for every pairing lufel's GLB schedule releases on its
   own (`rev_set`, Korean names, the Space card first in every entry so far — found by name
   rather than trusted by position). `date` is null for a version not yet dated. */
function revSetSchedule(sched, map, spaceNames) {
  const out = {};
  if (!sched) return out;
  for (const v of [...(sched.manualReleases || []), ...(sched.autoGenerateCharacters || [])]) {
    const names = (v.rev_set || []).map(x => map[x] || x);
    const sp = names.find(n => spaceNames.has(n));
    for (const st of names) if (st !== sp && sp) out[`${sp}+${canonSet(st)}`] = { version: v.version, date: v.date || null };
  }
  return out;
}

/* ---- 2-piece effect -> {stat, amt} ------------------------------------------
   Reads the numeric part off lufel's effect text. The mapping from an effect to
   a substat is our model: "reduces incoming damage" has no substat equivalent,
   so it is scored as the DEF% that buys a comparable amount of mitigation. */
function parseBonus2(text) {
  const t = text || '';
  const num = re => { const m = t.match(re); return m ? parseFloat(m[1]) : null; };
  let n;
  if ((n = num(/Increases? (?:the )?Crit Rate by (\d+(?:\.\d+)?)%/i)) != null) return { stat: 'Crit Rate', amt: n };
  if ((n = num(/Increases? SP Recovery by (\d+(?:\.\d+)?)%/i)) != null) return { stat: 'SP Recovery', amt: n };
  if ((n = num(/Increases? Ailment Accuracy Rate by (\d+(?:\.\d+)?)%/i)) != null) return { stat: 'Ailment Accuracy', amt: n };
  // "The healing effect is increased by 9%" (Love) and "Increase Healing Effect by 9%" (Happiness)
  if ((n = num(/healing effect (?:is increased )?by (\d+(?:\.\d+)?)%/i)) != null) return { stat: 'HP Recovery', amt: n };
  if ((n = num(/Increases? Speed by (\d+(?:\.\d+)?)/i)) != null) return { stat: 'Speed', amt: n };
  if ((n = num(/Reduces incoming DMG by (\d+(?:\.\d+)?)%/i)) != null) return { stat: 'DEF%', amt: n + 2 };
  for (const e of ELEM_EN) {
    const re = new RegExp(`(?:Increase )?${e} (?:DMG|damage) (?:increased by |by )?(\\d+(?:\\.\\d+)?)%`, 'i');
    if ((n = num(re)) != null) return { stat: 'Damage Multiplier', amt: n, elem: ELEM_CANON[e] || e };
  }
  if ((n = num(/Increase DMG Dealt by (\d+(?:\.\d+)?)%/i)) != null) return { stat: 'Damage Multiplier', amt: n };
  if ((n = num(/(?:Defense|DEF) increased by (\d+(?:\.\d+)?)%/i)) != null) return { stat: 'DEF%', amt: n };
  if ((n = num(/(?:HP|Max HP) increased by (\d+(?:\.\d+)?)%/i)) != null) return { stat: 'HP%', amt: n };
  if ((n = num(/Increase HP by (\d+(?:\.\d+)?)%/i)) != null) return { stat: 'HP%', amt: n };
  // Prudence reads "Decrease Speed by 3, but increase Attack by 18%" — the ATK is the
  // modelled bonus here; the Speed cost is parseBonus2Also's.
  if ((n = num(/(?:increase|Increase) Att?ack by (\d+(?:\.\d+)?)%/i)) != null) return { stat: 'ATK%', amt: n };
  if ((n = num(/Own attack increased by (\d+(?:\.\d+)?)%/i)) != null) return { stat: 'ATK%', amt: n };
  if ((n = num(/Increase ATK by (\d+(?:\.\d+)?)%/i)) != null) return { stat: 'ATK%', amt: n };
  return null;
}

/* The element a 4-piece is bound to on a set whose 2-piece is not ("Increases fire damage
   to enemies affected by ailments by 20%"), for `elem4`. Only Defeat has one: its
   ailment-accuracy 2-piece works for anyone, so the set cannot carry `elem`. */
function parseElem4(text4, b2) {
  if (b2 && b2.elem) return null;
  for (const e of ELEM_EN)
    if (new RegExp(`\\b${e}\\s+(?:DMG|damage)\\b`, 'i').test(text4 || '')) return ELEM_CANON[e] || e;
  return null;
}

/* Any further stat the same 2-piece line moves, as signed terms for `bonus2Also`. Only
   Prudence has one: its Speed cost used to be left in the p2 text, which let a Speed
   breakpoint read 3 higher than the character's real total under a Prudence 2-piece. */
function parseBonus2Also(text) {
  const m = String(text || '').match(/Decrease Speed by (\d+(?:\.\d+)?)/i);
  return m ? [{ stat: 'Speed', amt: -parseFloat(m[1]) }] : null;
}

/* A short label for the 2-piece, for the set table in the UI. */
function terse2(b2, text) {
  if (!b2) return text;
  if (b2.elem) return `${b2.elem} damage +${b2.amt}%`;
  const label = { 'ATK%': 'ATK', 'HP%': 'Max HP', 'DEF%': 'DEF', 'Crit Rate': 'Crit Rate',
                  'SP Recovery': 'SP recovery', 'Ailment Accuracy': 'Ailment accuracy',
                  'HP Recovery': 'Healing', 'Speed': 'Speed',
                  'Damage Multiplier': 'Damage dealt' }[b2.stat] || b2.stat;
  if (b2.stat === 'Speed') return `Speed +${b2.amt}`;
  if (/Reduces incoming/i.test(text)) return 'Damage taken -8%';
  if (/Decrease Speed/i.test(text)) return `Speed -3, ATK +${b2.amt}%`;
  return `${label} +${b2.amt}%`;
}

const q = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

function main() {
  const ours = loadOurs();
  const notes = [];     // printed to stderr at the end: everywhere this run is not simply echoing lufel
  const L = loadLufel(process.argv[2] || 'lufel.json');
  const isUnrel = o => ((o && o.type) || []).includes(UNRELEASED);

  /* ---------------- SETS ---------------- */
  const setLines = [];
  const setMeta = {};
  const entries = Object.entries(L.en.sub_effects)
    .map(([n, v]) => [canonSet(n), v])
    .sort((a, b) => (isUnrel(a[1]) - isUnrel(b[1])) || a[0].localeCompare(b[0]));
  for (const [name, v] of entries) {
    const b2 = parseBonus2(v.set2);
    const prev = ours.SETS[name];
    // bonus2 is a scoring model; keep the existing number where we already had one.
    const model = prev && prev.bonus2 && !prev.unverified ? prev.bonus2 : (b2 && { stat: b2.stat, amt: b2.amt });
    const also = prev && prev.bonus2Also ? prev.bonus2Also : parseBonus2Also(v.set2);
    setMeta[name] = { unreleased: isUnrel(v), elem: b2 && b2.elem };
    const bits = [
      `p2: ${q(terse2(b2, v.set2))}`,
      `bonus2: ${model ? `{ stat: ${q(model.stat)}, amt: ${model.amt} }` : 'null'}`
    ];
    if (also && also.length) bits.push(`bonus2Also: [${also.map(x => `{ stat: ${q(x.stat)}, amt: ${x.amt} }`).join(', ')}]`);
    if (b2 && b2.elem) bits.push(`elem: ${q(b2.elem)}`);
    const e4 = parseElem4(v.set4, b2);
    if (e4) bits.push(`elem4: ${q(e4)}`);
    if (isUnrel(v)) bits.push('unreleased: true');
    bits.push(`p4: ${q(plain(v.set4))}`);
    setLines.push(`  ${(q(name) + ':').padEnd(20)} { ${bits.join(',\n' + ' '.repeat(24))} },`);
  }

  /* ---------------- SPACE_SETS ---------------- */
  const spaceLines = [];
  const globalPairs = {};   // Space card -> the pairings Global has, read by every character pick below
  const spaceEntries = Object.entries(L.en.main)
    .sort((a, b) => (isUnrel(L.en.set_effects[a[0]]) - isUnrel(L.en.set_effects[b[0]])) || a[0].localeCompare(b[0]));
  /* A Space card's pairings are released one at a time, not with the card, and it is the
     English table that tracks the Global client. Lufel's GLB schedule lists pairings as
     releases of their own (`rev_set`): Acuity shipped in 4.9 (2026-09-09) pairing with
     Satiety alone, and Acuity + Hindrance is 4.16's, with Koromaru. Lufel's Korean table
     already carries all three of Acuity's pairings, so reading it would hand Koromaru and
     Aran a pairing that does not exist on their server yet. A pairing only the Korean table
     has is reported, never used. So is the reverse, an English pairing the schedule has not
     released yet, because nothing else would catch it: `unreleased` is per card, not per
     pairing. Since the 15 Oct 2026 refresh the English table no longer waits for the
     schedule — it lists Acuity + Hindrance ahead of 4.16 — so such a pairing is held out
     of `pairs` and of every character's pick (`globalPairs`), not only reported. One whose
     Heavens set is itself unreleased stays listed, as it always has: nobody may target that
     set anyway. */
  const pairRelease = revSetSchedule(L.schedule, L.map, new Set(Object.keys(L.en.main)));
  const today = new Date().toISOString().slice(0, 10);
  const when = r => r ? ` (lufel's GLB schedule: ${r.version}, ${r.date || 'undated'})` : '';
  const krName = {};
  for (const [k, v] of Object.entries(L.map)) if (!(v in krName)) krName[v] = k;
  for (const [name, pairs] of spaceEntries) {
    const eff = L.en.set_effects[name] || {};
    const listed = pairs.map(canonSet);
    const kr = (L.kr && L.kr.main && L.kr.main[krName[name]]) || [];
    const onlyKr = kr.map(x => canonSet(L.map[x] || x)).filter(p => !listed.includes(p));
    if (onlyKr.length)
      notes.push(`${name}: lufel's Korean table also pairs it with ${onlyKr.map(p => p + when(pairRelease[`${name}+${p}`])).join('; ')} — not in the English table, so not used`);
    const canon = listed.filter(p => {
      const r = pairRelease[`${name}+${p}`];
      if (r && !(r.date && r.date <= today) && !isUnrel(eff) && !(setMeta[p] && setMeta[p].unreleased)) {
        notes.push(`${name} + ${p}: both halves are tagged released, but the pairing is not out yet${when(r)} — held out until the schedule dates it`);
        return false;
      }
      return true;
    });
    globalPairs[name] = canon;
    // One effect string per pairing — a Space card does something different depending
    // on which 4-piece is live, so the UI shows only the clause that is actually firing.
    const effects = canon.map(p => {
      const txt = (Object.entries(eff).find(([k]) => canonSet(k) === p) || [])[1];
      return txt ? [p, plain(txt)] : null;
    }).filter(Boolean);
    const bits = [`pairs: [${canon.map(q).join(', ')}]`];
    if (isUnrel(eff)) bits.push('unreleased: true');
    bits.push(`effects: {\n${' '.repeat(22)}` +
      effects.map(([p, t]) => `${q(p)}: ${q(t)}`).join(`,\n${' '.repeat(22)}`) + ` }`);
    spaceLines.push(`  ${(q(name) + ':').padEnd(16)} { ${bits.join(',\n' + ' '.repeat(20))} },`);
  }

  /* ---------------- CHARACTERS ---------------- */
  const norm = n => String(n).replace(/[^a-z]/gi, '').toLowerCase();
  const chars = ours.CHARACTERS;
  const byAlias = {}, byName = {};
  for (const c of chars) { if (c.a) byAlias[norm(c.a)] = c; byName[norm(c.n)] = c; }
  const EXPLICIT = {
    'NAVI': 'Futaba Sakura', 'MAKOTO': 'Makoto Yuki', 'QUEEN': 'Makoto Niijima',
    'AEGIS': 'Aigis', 'FUKA': 'Fuuka Yamagishi', 'KIRIJO': 'Mitsuru Kirijo',
    'AKIHIKO': 'Akihiko Sanada', 'YUKARI': 'Yukari Takeba', 'JUNPEI': 'Junpei Iori',
    'KOROMARU': 'Koromaru', 'J&C': 'Justine & Caroline', 'BUI': 'YUI',
    'MONT': 'Kotone Montagne', 'MONT·Frostgale': 'Kotone Montagne [Frostgale]',
    'BUI·Prism': 'YUI [Prism]', 'BUI·Cosmic': 'YUI [Prism]',
    'CHORD·Summer': 'Ayaka Sakai [Summer]', 'BERRY·Summer': 'Ichigo Shikano [Summer]', 'CLOSER·Tropical': 'Motoha Arai [Tropical]',
    'CLOSER·Radiance': 'Motoha Arai [Radiance]', 'MOKO·Seaside': 'Tomoko Noge [Seaside]',
    'MARIAN·Beachflower': 'Minami Miyashita [Beachflower]',
    'PUPPET·Wavecatcher': 'Miyu Sahara [Wavecatcher]', 'WIND·Tempest': 'Riko Tanemura [Tempest]',
    'RIN·Firecracker': 'Yaoling Li [Firecracker]', 'LUCE·Notte': 'Shoki Ikenami [Notte]',
    'SOY·Pioneer': 'Shun Kano [Pioneer]', 'JOKER·Starlight': 'Ren Amamiya [Starlight]',
    'MONA·Starlight': 'Morgana [Starlight]', 'PANTHER·Starlight': 'Ann Takamaki [Starlight]'
  };
  const match = info => {
    const cn = info.codename || '';
    if (EXPLICIT[cn]) return chars.find(c => c.n === EXPLICIT[cn]) || null;
    return byAlias[norm(cn)] || byName[norm(info.name_en || '')] || null;
  };

  /* Archetype for characters we do not already carry, inferred from lufel's role. */
  /* character_info's `position` is lufel's STRUCTURED role field, and it maps 1:1 onto
     our eight archetypes — checked across the whole roster, 65 of 65 agree with no
     value ever landing on two archetypes. Prefer it over the prose below. */
  const ARCH_BY_POSITION = {
    '반항': 'ST DPS', '지배': 'AoE DPS', '해명': 'Navigator', '굴복': 'Saboteur',
    '우월': 'Strategist', '방위': 'Guardian', '구원': 'Healer', '자율': 'Virtuoso'
  };

  /* Fallback for a character carrying no `position`. This reads the settings file's
     free-form `role` prose, which describes what the unit DOES rather than what it is,
     so a phrase can match the wrong test before the right one is reached: five of the
     eight Elucidators describe themselves as a "서포터" (supporter) and would come back
     Strategist, and Miyu Sahara's "실드/방어력 서포터" would come back Guardian. That is
     how Yumi Shiina entered src/data.js as a Strategist. Kept only for characters
     `position` cannot answer for, and 해명 is tested before the supporter catch-all. */
  const archFromRole = r => {
    const s = String(r || '');
    if (/해명/.test(s)) return 'Navigator';
    if (/힐러/.test(s)) return 'Healer';
    if (/탱커|실드/.test(s)) return 'Guardian';
    if (/디버퍼/.test(s)) return 'Saboteur';
    if (/버퍼|서포터/.test(s)) return 'Strategist';
    if (/광역/.test(s)) return 'AoE DPS';
    if (/단일/.test(s)) return 'ST DPS';
    return 'Virtuoso';
  };
  const archFor = (info, setting) =>
    ARCH_BY_POSITION[info && info.position] || archFromRole(setting && setting.role);

  /* Roster order = order of release, as lufel's schedule page lists it. Anything the
     schedule does not mention (it drops Wonder, who never had a banner) sorts after
     everything it does, by release_order, so a new unit is never silently hidden. */
  const schedPos = scheduleOrder(L.schedule);
  const rank = kr => schedPos.has(kr) ? schedPos.get(kr) : schedPos.size;
  const rows = Object.entries(L.roster)
    .sort((a, b) => (rank(a[0]) - rank(b[0])) ||
                    ((a[1].release_order || 0) - (b[1].release_order || 0)));

  const outChars = [];
  const statsFor = [];   // (korean name, our name) for the CHAR_STATS block below
  if (!schedPos.size) notes.push('no release schedule in the dump — roster ordered by release_order alone; re-run tools/fetch-lufel-data.js');
  for (const [kr, info] of rows) {
    // A settings file exists for some units that carry no build at all (Wonder is
    // built through the Persona system, not the gacha). Treat those as unpublished.
    // With Wonder now out of src/data.js as well, this is what keeps him out: no
    // build on lufel and no previous entry means skipped, not carried forward.
    const raw = L.settings[kr];
    const s = raw && (raw.sub_revelation || raw.sub_option1 || raw.sub_revel2) ? raw : null;
    const prev = match(info);
    if (!s && !prev) { notes.push(`skipped (no build, not in src/data.js): ${info.name_en}`); continue; }
    const name = prev ? prev.n : info.name_en;
    const elem = ELEM_KR[info.element] || (prev && prev.e) || 'None';
    const rarity = info.rarity || (prev && prev.r) || 5;
    /* `arch` is carried from src/data.js rather than regenerated (see the header note),
       so a stale one is invisible unless it is checked — which is exactly how Yumi
       Shiina's Strategist survived. Report a stored archetype that disagrees with
       lufel's own `position` instead of silently keeping it. */
    const lufelArch = archFor(info, s);
    const arch = prev ? prev.arch : lufelArch;
    if (prev && ARCH_BY_POSITION[info.position] && arch !== lufelArch)
      notes.push(`${name}: src/data.js says arch "${arch}", lufel's position "${info.position}" says "${lufelArch}" — verify, then fix src/data.js by hand (arch is never regenerated)`);
    // lufel writes codenames in caps; src/data.js aliases are title case.
    const alias = prev ? prev.a
      : String(info.codename || '').replace(/[A-Z]+/g, m => m[0] + m.slice(1).toLowerCase());

    // Ranked Space+Heavens pairs, unreleased ones held back.
    const rawSets = ((s && s.sub_revelation) || []).map(x => canonSet(L.en.mapping_en[x] || x));
    const rawSpace = ((s && s.main_revelation) || []).map(x => L.en.mapping_en[x] || x);
    /* The two halves of a pairing are held back independently. A Heavens set whose
       recommended Space card is not out yet is still perfectly farmable — Koromaru's
       best set is Hindrance, ranked with Acuity (unreleased until Sep 2026, and its
       Hindrance pairing still not on Global), and dropping Hindrance along with Acuity
       would have cost him his own element's set for no reason. */
    const pairsRanked = rawSets.map((st, i) => ({ st, sp: rawSpace[i] }));
    const setOk = st => st && !(setMeta[st] && setMeta[st].unreleased);
    const spaceOk = sp => sp && !isUnrel(L.en.set_effects[sp]);

    let sets = [];
    for (const p of pairsRanked) if (setOk(p.st) && !sets.includes(p.st)) sets.push(p.st);
    const spacesRanked = pairsRanked.map(p => p.sp).filter(spaceOk);

    /* lufel sometimes recommends an off-element set — Messa is Physical but is told to
       run Pleasure, which is Psychokinesis. That is not a mistake: the value is in the
       Space-card pairing (Wisdom + Pleasure converts Ailment Accuracy into damage, and
       Messa stacks Ailment Accuracy), with the set's own elemental 2- and 4-piece simply
       written off. Our scoring has no way to express "take a dead 4-piece to unlock a
       Space effect" — bonus2Value and bonus4Value both return 0 off-element — so listing
       it would show a 4-piece plan worth nothing. Drop it from the target and record the
       recommendation as prose instead. */
    const offElem = sets.filter(st => setMeta[st] && setMeta[st].elem && setMeta[st].elem !== elem);
    if (offElem.length) sets = sets.filter(st => !offElem.includes(st));
    sets = sets.slice(0, 2);            // the target editor exposes two

    /* Prefer a Space card that actually pairs with a set we ended up recommending — a
       Space card does nothing at all without a matching 4-piece, so lufel's top-ranked
       card is the wrong pick when the set it was ranked alongside got dropped. Sets are
       tried in preference order, and only then does the ranking break the tie. */
    const pairsWith = (sp, st) => (globalPairs[sp] || []).includes(st);
    let space = '';
    for (const st of sets) {
      space = spacesRanked.find(sp => pairsWith(sp, st));
      if (space) break;
    }
    space = space || spacesRanked[0] || '';
    /* Nothing lufel ranks is obtainable, so the sets are src/data.js's hand-picked fallback.
       The Space card chosen above was ranked alongside sets that got dropped, so it only
       survives if it pairs with the fallback; otherwise keep the card chosen with it. */
    if (!sets.length && prev) {
      sets = prev.sets.slice();
      space = spacesRanked.find(sp => sets.some(st => pairsWith(sp, st))) || prev.space || space;
    }
    if (!space && prev) space = prev.space;

    /* Only the top-ranked pairing being unavailable is worth telling the user about. Both
       halves can be out and the pairing still not be (see pairRelease): Koromaru's and
       Aran's top build is Hindrance + Acuity, which Global does not have yet. Every other
       one of lufel's 132 ranked combos is a pairing the English table has. */
    const top = pairsRanked[0];
    const unpaired = p => !!(p && p.st && p.sp && setOk(p.st) && spaceOk(p.sp) && !pairsWith(p.sp, p.st));
    const held = top && (!setOk(top.st) || !spaceOk(top.sp) || unpaired(top)) ? [top] : [];

    /* Main stats: every legal choice lufel lists for the slot, best-first, not just
       the first. Lufel names alternatives — Ann's Moon is Damage Multiplier or ATK%,
       most DPS Stars are either crit stat, Yukari's Moon is three deep — and 87 of the
       roster's 195 slot recommendations list more than one. Keeping only the head made
       every card carrying another of them read as off-target. MAIN_CHOICES is what the
       target editor exposes; lufel has never listed more than that. */
    const MAIN_CHOICES = 3;
    const legal = (slot, st) => (ours.SLOT_INFO[slot].mains || []).includes(st);
    const A = ours.ARCHETYPES[arch];
    const asList = v => Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []);
    const baseMain = Object.assign({}, A.main, (prev && prev.ov && prev.ov.main) || {});
    const main = Object.assign({}, baseMain);
    const SLOTF = { Moon: 'sub_revel2', Star: 'sub_revel3', Sky: 'sub_revel4' };
    /* A slot lufel fills with "-" (or leaves blank) recommends nothing, which is an answer:
       any main will do. That is an open slot, [], not the archetype placeholder it used to
       inherit — Chizuko's and Runa's Moon and Sky, Yaoling's Moon and Star, Tempest Riko's
       Moon and Aran's Moon and Sky, where the placeholder was beaten by 15-20% by a main the
       character's own weights prefer. A stat this tool cannot map is NOT a "-": that is a
       vocabulary gap, and keeps the fallback. */
    const openField = v => (Array.isArray(v) ? v : [v]).every(x => x == null || !String(x).trim() || String(x).trim() === '-');
    for (const [slot, field] of Object.entries(SLOTF)) {
      const want = splitStats(s && s[field]).filter(st => legal(slot, st));
      if (want.length) main[slot] = want.slice(0, MAIN_CHOICES);
      else if (s && s[field] != null && openField(s[field])) main[slot] = [];
    }

    // Substat weights from lufel's three priority tiers, over the archetype floor.
    const w = Object.assign({}, A.w);
    const tiers = [splitStats(s && s.sub_option1), splitStats(s && s.sub_option2), splitStats(s && s.sub_option3)];
    const listed = new Set([].concat(...tiers));
    if (listed.size) {
      /* A ranked stat takes its tier's value, or the archetype's own default where that is
         higher — but never so high that it reaches a stat lufel ranks above it. The floor
         is the archetype's guess and the order is lufel's, and only the order is trusted:
         left unchecked, a Healer's SP Recovery default of 8 tied Minami's tier-3 SP
         Recovery with her tier-2 DEF, and an ST DPS's Crit Rate default of 9 put Ichigo's
         tier-3 Crit Rate above her tier-2 ATK% and Damage Multiplier. Where the floor would
         get there, the stat takes its plain tier value. */
      let above = Infinity;          // the lowest weight given to the tier above
      const ranked = new Set();
      tiers.forEach((tier, i) => {
        const v = [10, 8, 6][i];
        let low = Infinity;
        tier.forEach(st => {
          if (ranked.has(st)) return;  // listed in a higher tier too: that one stands
          ranked.add(st);
          let x = Math.max(v, w[st] === undefined ? 0 : w[st]);
          if (x >= above) x = v;
          w[st] = x;
          low = Math.min(low, x);
        });
        if (low < Infinity) above = low;
      });
      // A stat lufel weighed and left out of all three tiers is not a priority,
      // whatever the archetype default says. Flat ATK/DEF/HP are outside lufel's
      // vocabulary, so no opinion is inferred for them.
      for (const st of Object.keys(w))
        if (LUFEL_VOCAB.has(st) && !listed.has(st) && w[st] > 4) w[st] = 4;
    }
    /* Hand-tuned magnitudes win over the tier map — see WEIGHT_OVERRIDES above for what
       earns an entry. Always reported, so a regeneration says out loud every place it is
       not simply echoing lufel. */
    const tierOf = st => tiers.findIndex(t => t.includes(st)) + 1;
    const hand = WEIGHT_OVERRIDES[name];
    if (hand) {
      for (const [st, val] of Object.entries(hand.w)) {
        if (w[st] === val) continue;
        const was = w[st];
        w[st] = val;
        const rank = tierOf(st) ? `lufel tier ${tierOf(st)}` : 'unlisted by lufel';
        notes.push(`${name}: ${st} ${was} -> ${val} (${rank}) — ${hand.why}`);
      }
    }

    /* Safety net for a hand edit made in src/data.js rather than in the table above. A 0
       is the one value the tier map provably never emits for a stat lufel ranks, so it can
       be told apart from a generated value and carried over; anything else cannot, and is
       overwritten. Carrying it over silently would hide the edit from the next reader, so
       say where it belongs. */
    const prevW = (prev && prev.ov && prev.ov.w) || {};
    for (const [st, val] of Object.entries(prevW)) {
      if (val !== 0 || w[st] === 0) continue;
      w[st] = 0;
      notes.push(`${prev.n}: kept ${st} at 0 from src/data.js (${tierOf(st) ? `lufel tier ${tierOf(st)}` : 'unlisted by lufel'}) `
        + `— not recorded in WEIGHT_OVERRIDES; add it there with a reason or the next hand edit to this weight will be lost`);
    }
    const wDiff = {};
    for (const k of Object.keys(w)) if (w[k] !== A.w[k]) wDiff[k] = w[k];
    // Compared by value, not identity — both sides can now be lists.
    const mainDiff = {};
    for (const k of Object.keys(main))
      if (asList(main[k]).join('|') !== asList(A.main[k]).join('|')) mainDiff[k] = main[k];

    /* Stat targets. These used to be flattened into the `bp` prose, which meant nothing
       could read them — they are structured now so the build score can weigh them, and
       the UI renders the ladder itself rather than a pre-baked sentence. `bp` goes back
       to carrying only hand-written mechanical prose. */
    const targets = parseTargets(s && s.minimum_stats);
    const strip = t => (SUPERSEDED[name] || []).reduce((acc, frag) => acc.split(frag).join(''), t || '').trim();

    /* Stage targets used to be appended to `bp` as prose and are structured data now.
       They were always appended last, so cut from the marker to the end. An earlier
       pass cut only to the next full stop, which lands inside the first decimal number
       and leaves a tail like "2 · LV10+5 Speed 194.0 · ..." behind — so also strip any
       trailing run of "LV<stage> ..." fragments, with whatever partial number precedes it. */
    let bp = strip(prev && prev.ov && prev.ov.bp)
      .replace(/\s*Lufelnet stage targets —[\s\S]*$/, '')
      .replace(/\s*\S*\s*·?\s*(?:LV\d+(?:\+5)?\s[\s\S]*)$/, '')
      // ...and the orphan decimal tail the old cut left glued to the last word, where
      // the sentence ended in a number: "Target 90% Ailment Accuracy.5%" -> "...Accuracy."
      .replace(/([A-Za-z])\.\d[\d.]*%?\s*$/, '$1.')
      .trim();

    /* `note` is carried over from src/data.js and then has the two sentences below
       appended. Both are GENERATED prose, so a re-run has to remove last run's copy
       before adding this run's — otherwise every regeneration appends another one, which
       is how Seaside Moko and Messa ended up carrying six identical copies of the
       off-element paragraph. Only the generator's own sentences are stripped, matched
       from their fixed opening to their fixed closing; hand-written prose is untouched. */
    let note = stripGenerated(strip(prev && prev.ov && prev.ov.note));
    if (offElem.length) {
      const pairedWith = offElem.map(st => {
        const k = pairsRanked.find(x => x.st === st);
        return `${st}${k && k.sp ? ` with ${k.sp}` : ''}`;
      }).join(' and ');
      note = (note ? note + ' ' : '') +
        `Lufelnet also recommends ${pairedWith} — an off-element set taken purely for the ` +
        `Space-card pairing, since its own 2- and 4-piece do nothing for ` +
        `${/^[AEIOU]/.test(elem) ? 'an' : 'a'} ${elem} unit. ` +
        `The optimiser cannot score that, so it is left out of the target above.`;
    }
    if (held.length) {
      const { st, sp } = held[0];
      const gone = [!setOk(st) ? st : null, !spaceOk(sp) ? sp : null].filter(Boolean).join(' and ');
      const r = pairRelease[`${sp}+${st}`];
      const why = gone ? `${gone} ${gone.includes(' and ') ? 'are' : 'is'} not released yet`
        : `${sp} does not pair with ${st} on Global yet` +
          (r ? ` (Lufelnet's release schedule lists that pairing for version ${String(r.version).replace(/\s*\(.*\)\s*$/, '')}${r.date ? ', ' + r.date : ''})` : '');
      note = (note ? note + ' ' : '') +
        `Lufelnet's top build for this unit is ${st} + ${sp}; ${why}, so the target above is the ` +
        `best obtainable alternative.`;
    }
    const ov = {};
    if (Object.keys(mainDiff).length) ov.main = mainDiff;
    if (Object.keys(wDiff).length) ov.w = wDiff;
    if (targets.length) ov.targets = targets;
    if (bp) ov.bp = bp;
    if (note) ov.note = note;

    const parts = [`n:${q(name)}`, `a:${q(alias)}`, `r:${rarity}`, `e:${q(elem)}`,
                   `arch:${q(arch)}`];
    let line = `  { ${parts.join(', ')},\n    sets:[${sets.map(q).join(',')}], space:${q(space)}`;
    if (Object.keys(ov).length) {
      const ovBits = [];
      // A slot with one answer stays a bare string; alternatives become a list, and an
      // open slot (lufel's "-") the empty one.
      if (ov.main) ovBits.push(`main:{${Object.entries(ov.main).map(([k, v]) => {
        const l = asList(v);
        return `${k}:${l.length !== 1 ? '[' + l.map(q).join(',') + ']' : q(l[0])}`;
      }).join(',')}}`);
      if (ov.w) ovBits.push(`w:{${Object.entries(ov.w).map(([k, v]) => `${q(k)}:${v}`).join(',')}}`);
      if (ov.targets) ovBits.push('targets:[' + ov.targets.map(t =>
        `{s:${q(t.s)},sub:${q(t.sub)},pct:${t.pct},tiers:{` +
        Object.entries(t.tiers).map(([k, v]) => `${q(k)}:${v}`).join(',') + '}}').join(',\n                  ') + ']');
      if (ov.bp) ovBits.push(`bp:${q(ov.bp)}`);
      if (ov.note) ovBits.push(`note:${q(ov.note)}`);
      line += `,\n    ov:{ ${ovBits.join(',\n         ')} }`;
    }
    outChars.push(line + ' },');
    statsFor.push([kr, name]);
  }

  /* ---------------- CHAR_STATS ---------------- */
  const statLines = [];
  const n1 = v => Math.round(v * 10) / 10;
  for (const [krName, ourName] of statsFor) {
    const base = L.base[krName], w = L.weapons[krName], s = L.settings[krName];
    if (!base) continue;
    const trip = k => base[k] ? `[${n1(base[k].HP)},${n1(base[k].attack)},${n1(base[k].defense)}]` : null;
    const bits = [];
    const l1 = base.a0_lv1 || {};
    // `||` would treat a legitimate 0 (seven Buff-element support units genuinely have
    // 0% innate Crit Rate and Crit Multiplier — no crit stat at all) as missing and
    // silently substitute the 5/150 most characters carry. `??` only falls back when
    // lufel omits the field entirely.
    /* ...but a Speed of 0 is lufel's gap, not a stat: every character acts, and Fuuka's page
       reads Speed 0 and SP 0 where hers is 100. Keep the value src/data.js has. */
    const prevCS = (ours.CHAR_STATS || {})[ourName] || {};
    const spd = l1.speed > 0 ? l1.speed : (prevCS.spd || 100);
    if (!(l1.speed > 0)) notes.push(`${ourName}: lufel gives no Speed, kept ${spd}`);
    bits.push(`spd:${spd}, cr:${l1.crit_rate ?? 5}, cm:${l1.crit_mult ?? 150}`);
    for (const [key, src] of [['l80', 'a0_lv80'], ['l80a6', 'a6_lv80'], ['l100', 'a0_lv100'], ['l100a6', 'a6_lv100']])
      if (trip(src)) bits.push(`${key}:${trip(src)}`);
    /* One Awakening-7 ATK bonus is filed under `attack` (Hatsune Miku's 29) where the other 34
       read `attack_per`, all 29 at 5 stars; charBaseStat reads only `attack_per`, so it would
       be dropped. */
    const glbAw = GLB_STAT_OVERRIDES[ourName] && GLB_STAT_OVERRIDES[ourName].aw;
    const aw7 = glbAw ? Object.entries(glbAw)
      : Object.entries(base.awake7 || {}).map(([k, v]) => [k === 'attack' ? 'attack_per' : k, v]);
    if (glbAw) notes.push(`${ourName}: Awakening 7 from GLB_STAT_OVERRIDES — ${GLB_STAT_OVERRIDES[ourName].why}`);
    if (aw7.length) bits.push(`aw:{${aw7.map(([k, v]) => `${q(k)}:${n1(v)}`).join(',')}}` +
      (glbAw ? ` /* ${GLB_STAT_OVERRIDES[ourName].why} */` : ''));

    const glb = GLB_STAT_OVERRIDES[ourName];
    const mind = glb && glb.mind ? glb.mind : [parseMind(s && s.mind_stats1), parseMind(s && s.mind_stats2)].filter(Boolean);
    if (glb && glb.mind) notes.push(`${ourName}: Mindscape from GLB_STAT_OVERRIDES — ${glb.why}`);
    if (mind.length) bits.push('mind:[' + mind.map(m =>
      `{s:${q(m.s)},v:${m.v},pct:${m.pct}${m.tag ? `,tag:${q(m.tag)}` : ''}}`).join(',') + ']' + (glb && glb.mind ? ` /* ${glb.why} */` : ''));

    for (const [key, wk] of [['w4', 'weapon4-1'], ['w5', 'weapon5-1']]) {
      const e = w && w[wk];
      if (!e) continue;
      const b = parseWeaponBonus(e.description);
      const wb = [`n:${q(e.name || '')}`, `hp:${n1(e.health || 0)}`, `atk:${n1(e.attack || 0)}`, `def:${n1(e.defense || 0)}`];
      if (b) wb.push(`b:{s:${q(b.s)},pct:${b.pct},r:[${b.r.join(',')}]}`);
      // `extra` is what was read and not counted: the whole line when nothing parsed,
      // or the clause split off an "and" when the leading half did.
      const uncounted = b ? b.rest : (e.description ? String(e.description).split(/\n/)[0].trim() : '');
      if (uncounted) wb.push(`extra:${q(uncounted.slice(0, 160))}`);
      bits.push(`${key}:{ ${wb.join(', ')} }`);
    }
    statLines.push(`  ${(q(ourName) + ':').padEnd(34)} { ${bits.join(',\n' + (' '.repeat(38)))} },`);
  }

  const STATS_HEADER = `/* ---- Everything outside the revelation cards that moves a stat -------------------
   Lufelnet's stat targets are in-battle TOTALS, so what a build needs from its cards
   depends on the rest of the character: level and ascension, which weapon at which
   refinement, and whether the Mindscape is unlocked. Kumi Katayama needs 180 Speed —
   on a 4-star weapon at A0 with no Mindscape that is 73 Speed from cards, and on a
   5-star R7 at A7 with Mindscape it is 14. Without this block the planner cannot tell
   those two players apart.

     spd / cr / cm  base Speed, Crit Rate and Crit Multiplier (these do not scale with level)
     l80 / l100     [HP, ATK, DEF] at A0; l80a6 / l100a6 the same at A6. Ranks in between
                    are interpolated — lufel's own steps are near-even, so the error is
                    under half a point, far below the My Palace contribution nobody models.
     aw             the Awakening-7 bonus, whose stat differs per character
     mind           Mindscape nodes; \`tag\` is lufel's own emphasis (! take it, x skip it)
     w4 / w5        the 4- and 5-star weapon: flat HP/ATK/DEF plus, where the passive is a
                    plain unconditional stat line, its 7-step refinement ladder in \`b\`.
                    \`extra\` holds the passive text when it is conditional and therefore
                    NOT counted — a buff you only have some of the time is not a stat.
----------------------------------------------------------------------------------- */
const CHAR_STATS = {
`;

  console.log('const SETS = {\n' + setLines.join('\n') + '\n};\n');
  console.log('const SPACE_SETS = {\n' + spaceLines.join('\n') + '\n};\n');
  console.log(STATS_HEADER + statLines.join('\n') + '\n};\n');
  console.log('const CHARACTERS = [\n' + outChars.join('\n') + '\n];');
  if (notes.length) console.error(notes.join('\n'));
}

main();
