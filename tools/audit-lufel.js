#!/usr/bin/env node
/* Compares src/data.js against lufel.net's own data files.
 *
 *     node tools/fetch-lufel-data.js lufel.json    # first, grab the source data
 *     node tools/audit-lufel.js lufel.json         # then diff it against ours
 *
 * lufel.net is the reference for build information (see docs/DATA-SOURCES.md), so
 * anything this reports is a bug in src/data.js until proven otherwise. It reports
 * rather than rewrites — several fields here are deliberate modelling choices, not
 * transcriptions, and a blind overwrite would flatten them.
 *
 * Lufel's data is Korean-first. Set and Space-card names come with an official
 * English mapping (`mapping_en`); stat names do not, so STAT_KR below carries them.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* Stat vocabulary used by the per-character build recommendations. Lufel writes
   alternatives as "a/b" or "a, b" and uses a bare "-" or "" for "no preference". */
const STAT_KR = {
  '공격력': 'ATK%', '생명': 'HP%', '방어력': 'DEF%', '방어': 'DEF%',
  '대미지보너스': 'Damage Multiplier', '대미지 보너스': 'Damage Multiplier',
  '크리티컬 확률': 'Crit Rate', '크리티컬 효과': 'Crit Multiplier',
  '효과명중': 'Ailment Accuracy', '효과 명중': 'Ailment Accuracy',
  '속도': 'Speed', '관통': 'Resistance Pierce',
  'SP회복': 'SP Recovery', 'SP 회복': 'SP Recovery',
  '치료효과': 'HP Recovery', '치료 효과': 'HP Recovery'
};

/* Element names. 버프 ("buff") is what lufel calls the Navigator/Elucidator units
   that have no attack element at all — src/data.js calls that 'None'. */
const ELEM_KR = {
  '물리': 'Physical', '총격': 'Gun', '화염': 'Fire', '빙결': 'Ice', '전격': 'Electric',
  '질풍': 'Wind', '염동': 'Psychokinesis', '핵열': 'Nuclear', '축복': 'Bless',
  '주원': 'Curse', '만능': 'Almighty', '버프': 'None', '질풍빙결': 'Wind'
};

/* lufel spells this one without the second 'i'; ours matches the in-game English.
   Bridging it here keeps every character that runs the set out of the diff. */
const SET_RENAME = { Reconcilation: 'Reconciliation' };
const canonSet = n => SET_RENAME[n] || n;

const splitStats = s => String(s == null ? '' : s)
  .split(/[\/,]/).map(x => x.trim()).filter(x => x && x !== '-')
  .map(x => STAT_KR[x] || `?${x}`);

function loadOurData() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'data.js'), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(src.replace(/^(\s*)(?:const|let)\s+/gm, '$1var '), ctx);
  return ctx;
}

function loadLufel(file) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const en = d.revelations_en.enRevelationData;
  const roster = d.character_info.characterData;
  // settings.js nests as { characterSetting: { "<kr name>": {...} } }
  const settings = {};
  for (const [kr, mod] of Object.entries(d.settings)) {
    const bag = mod.characterSetting || mod[Object.keys(mod)[0]];
    const v = bag && (bag[kr] || bag[Object.keys(bag)[0]]);
    if (v) settings[kr] = v;
  }
  return { en, roster, settings, mapEn: en.mapping_en };
}

/* A settings file can exist and still recommend nothing. Wonder has one — he is built
   through the Persona system rather than the gacha, so lufel publishes stats for him but
   no Revelation build, and he is deliberately absent from src/data.js. Same test the
   generator uses, so the two agree on who counts as having a build. */
const hasBuild = s => !!(s && (s.sub_revelation || s.sub_option1 || s.sub_revel2));

const out = [];
const say = s => out.push(s);
const H = t => say(`\n\n## ${t}\n`);

function main() {
  const file = process.argv[2] || 'lufel.json';
  const ours = loadOurData();
  const L = loadLufel(file);
  const enName = kr => canonSet(L.mapEn[kr] || kr);
  const unreleased = o => ((o && o.type) || []).includes('미출시');

  /* ---- 1. Heavens sets ------------------------------------------------- */
  H('Heavens sets');
  const lufSets = L.en.sub_effects;
  const ourSets = ours.SETS;
  const aliasTargets = new Set(Object.values(ours.SET_ALIASES));
  const norm = n => n.replace(/[^a-z]/gi, '').toLowerCase();
  const ourByNorm = {};
  for (const k of Object.keys(ourSets)) ourByNorm[norm(k)] = k;

  say(`lufel: ${Object.keys(lufSets).length} sets   ours: ${Object.keys(ourSets).length}`);
  const missing = [], extra = [];
  for (const [rawName, v] of Object.entries(lufSets)) {
    const name = canonSet(rawName);
    const mine = ourByNorm[norm(name)];
    if (!mine) { missing.push([name, v]); continue; }
    if (mine !== name) say(`  SPELLING  ours "${mine}" vs lufel "${name}"`);
    const o = ourSets[mine];
    if (o.unverified) say(`  RESOLVED  ${mine} is real — 2pc: ${v.set2}`);
    // 4-piece text is prose on both sides; flag only clear mismatches by keyword
    const p4o = (o.p4 || '').toLowerCase(), p4l = (v.set4 || '').toLowerCase();
    const nums = s => (s.match(/\d+(?:\.\d+)?%/g) || []).sort().join(',');
    if (nums(p4o) !== nums(p4l)) say(`  4PC NUM   ${mine}\n              ours:  ${o.p4}\n              lufel: ${v.set4}`);
    else if (p4l.length > p4o.length * 1.45) say(`  4PC MORE  ${mine}\n              ours:  ${o.p4}\n              lufel: ${v.set4}`);
  }
  const lufCanon = new Set(Object.keys(lufSets).map(canonSet));
  for (const k of Object.keys(ourSets)) if (!lufCanon.has(k)) extra.push(k);
  if (missing.length) {
    say(`\n  ${missing.length} set(s) lufel has and we do not:`);
    for (const [n, v] of missing)
      say(`    ${n}${unreleased(v) ? '  [UNRELEASED]' : ''}\n      2pc: ${v.set2}\n      4pc: ${v.set4}`);
  }
  if (extra.length) say(`\n  set(s) we have that lufel does not: ${extra.join(', ')}`);

  /* ---- 2. Space cards -------------------------------------------------- */
  H('Space cards and their set pairings');
  const lufSpace = L.en.main, ourSpace = ours.SPACE_SETS;
  say(`lufel: ${Object.keys(lufSpace).length} cards   ours: ${Object.keys(ourSpace).length}`);
  for (const [name, pairs] of Object.entries(lufSpace)) {
    const mine = ourSpace[name];
    if (!mine) {
      say(`  NEW       ${name}${unreleased(L.en.set_effects[name]) ? '  [UNRELEASED]' : ''} -> ${pairs.join(', ')}`);
      continue;
    }
    const canon = p => (ourByNorm[norm(canonSet(p))] || canonSet(p));
    const want = pairs.map(canon).sort(), have = mine.pairs.slice().sort();
    if (want.join('|') !== have.join('|'))
      say(`  PAIRS     ${name}\n              ours:  ${have.join(', ')}\n              lufel: ${want.join(', ')}`);
  }
  for (const k of Object.keys(ourSpace)) if (!lufSpace[k]) say(`  ORPHAN    ${k} — not a Space card on lufel`);

  /* ---- 3. Roster ------------------------------------------------------- */
  H('Roster');
  // Match lufel entries to ours by codename/alias first, then by English name.
  const chars = ours.CHARACTERS;
  const byAlias = {}, byName = {};
  for (const c of chars) {
    if (c.a) byAlias[norm(c.a)] = c;
    byName[norm(c.n)] = c;
  }
  const EXPLICIT = {   // lufel spellings that no normalisation reaches
    'NAVI': 'Futaba Sakura', 'MAKOTO': 'Makoto Yuki', 'QUEEN': 'Makoto Niijima',
    'AEGIS': 'Aigis', 'FUKA': 'Fuuka Yamagishi', 'KIRIJO': 'Mitsuru Kirijo',
    'AKIHIKO': 'Akihiko Sanada', 'YUKARI': 'Yukari Takeba', 'JUNPEI': 'Junpei Iori',
    'KOROMARU': 'Koromaru', 'J&C': 'Justine & Caroline', 'BUI': 'YUI',
    'MONT': 'Kotone Montagne', 'MONT·Frostgale': 'Kotone Montagne [Frostgale]',
    'BUI·Prism': 'YUI [Prism]', 'CLOSER·Tropical': 'Motoha Arai [Tropical]',
    'CLOSER·Radiance': 'Motoha Arai [Radiance]', 'MOKO·Seaside': 'Tomoko Noge [Seaside]',
    'MARIAN·Beachflower': 'Minami Miyashita [Beachflower]',
    'PUPPET·Wavecatcher': 'Miyu Sahara [Wavecatcher]', 'WIND·Tempest': 'Riko Tanemura [Tempest]',
    'RIN·Firecracker': 'Yaoling Li [Firecracker]', 'LUCE·Notte': 'Shoki Ikenami [Notte]',
    'SOY·Pioneer': 'Shun Kano [Pioneer]', 'JOKER·Starlight': 'Ren Amamiya [Starlight]',
    'MONA·Starlight': 'Morgana [Starlight]', 'PANTHER·Starlight': 'Ann Takamaki [Starlight]'
  };
  const match = (kr, info) => {
    const cn = info.codename || '';
    if (EXPLICIT[cn]) return chars.find(c => c.n === EXPLICIT[cn]) || null;
    return byAlias[norm(cn)] || byName[norm(info.name_en || '')] || null;
  };

  const pairsFor = {};   // our-name -> matched lufel record
  const absent = [];
  for (const [kr, info] of Object.entries(L.roster)) {
    const c = match(kr, info);
    if (c) pairsFor[c.n] = { kr, info, set: L.settings[kr] };
    else absent.push({
      kr, info,
      why: L.settings[kr] ? (hasBuild(L.settings[kr]) ? '' : 'NO REVELATION BUILD — excluded on purpose, see docs/DATA-SOURCES.md')
                          : 'UNRELEASED — no build page'
    });
  }
  const covered = new Set(Object.keys(pairsFor));
  const ourOnly = chars.filter(c => !covered.has(c.n)).map(c => c.n);

  say(`lufel: ${Object.keys(L.roster).length} characters ` +
      `(${Object.values(L.settings).filter(hasBuild).length} with builds)   ours: ${chars.length}`);
  if (absent.length) {
    say(`\n  ${absent.length} on lufel, not in src/data.js:`);
    for (const a of absent)
      say(`    ${a.info.name_en} (${a.info.codename || '—'}, ${ELEM_KR[a.info.element] || a.info.element || '?'}, ${a.info.rarity || '?'}*)` +
          `${a.why ? `  [${a.why}]` : '  <-- has a lufel build and is not carried: add it'}`);
  }
  if (ourOnly.length) say(`\n  in src/data.js, unmatched on lufel: ${ourOnly.join(', ')}`);

  /* ---- 4. Element and rarity ------------------------------------------- */
  H('Element / rarity mismatches');
  let clean = true;
  for (const c of chars) {
    const p = pairsFor[c.n]; if (!p) continue;
    const el = ELEM_KR[p.info.element] || p.info.element;
    if (el && el !== c.e) { say(`  ELEMENT   ${c.n}: ours ${c.e}, lufel ${el} (${p.info.element})`); clean = false; }
    if (p.info.rarity && p.info.rarity !== c.r) { say(`  RARITY    ${c.n}: ours ${c.r}*, lufel ${p.info.rarity}*`); clean = false; }
  }
  if (clean) say('  none.');

  /* ---- 5. Per-character builds ----------------------------------------- */
  H('Build recommendations');
  say('lufel lists up to three ranked Space+Heavens combos, one or more recommended main stats');
  say('for each of Moon/Star/Sky (they are alternatives, best first, and ours must match in order),');
  say('and substats in three priority tiers. "ours" is src/data.js after archetype defaults');
  say('and `ov` overrides are applied.\n');

  const SLOTKEY = { sub_revel2: 'Moon', sub_revel3: 'Star', sub_revel4: 'Sky' };
  let issues = 0;
  for (const c of chars) {
    const p = pairsFor[c.n]; if (!p || !p.set) continue;
    const s = p.set;
    const lines = [];

    const lufSetList = (s.sub_revelation || []).map(enName).filter(Boolean);
    const lufSpaceList = (s.main_revelation || []).map(enName).filter(Boolean);
    const canon = n => ourByNorm[norm(canonSet(n))] || canonSet(n);

    // Top recommendation is the pairing at index 0.
    const topSet = canon(lufSetList[0] || ''), topSpace = lufSpaceList[0] || '';
    if (topSet && c.sets[0] !== topSet)
      lines.push(`    SET     ours [${c.sets.join(', ')}]  lufel [${lufSetList.map(canon).join(', ')}]`);
    if (topSpace && c.space !== topSpace)
      lines.push(`    SPACE   ours ${c.space}  lufel [${lufSpaceList.join(', ')}]`);

    // Main stats: archetype default, overridden per character.
    const arch = ours.ARCHETYPES[c.arch];
    const mine = Object.assign({}, arch.main, (c.ov && c.ov.main) || {});
    /* lufel names alternatives, not one answer, and so do we — so compare the whole
       list against the legal part of lufel's, in order. Only lufel's stats that are
       legal for the slot are expected to appear on our side. */
    const asList = v => Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []);
    for (const [field, slot] of Object.entries(SLOTKEY)) {
      const legal = (ours.SLOT_INFO[slot].mains || []);
      const want = splitStats(s[field]).filter(st => legal.includes(st));
      if (!want.length) continue;
      const got = asList(mine[slot]);
      if (got.join(' / ') !== want.join(' / '))
        lines.push(`    ${slot.padEnd(6)}  ours ${got.join(' / ') || '—'}  lufel ${want.join(' / ')}`);
    }

    // Substat priority: lufel's tier 1 should be at or near the top of our weights.
    const w = Object.assign({}, arch.w, (c.ov && c.ov.w) || {});
    const t1 = splitStats(s.sub_option1);
    if (t1.length) {
      const ranked = Object.keys(w).sort((a, b) => w[b] - w[a]);
      const topN = ranked.slice(0, Math.max(2, t1.length));
      const stray = t1.filter(x => !topN.includes(x) && w[x] !== undefined && w[x] < (w[topN[topN.length - 1]] || 0));
      if (stray.length)
        lines.push(`    SUBS    lufel rates [${t1.join(', ')}] top; ours ranks ${stray.map(x => `${x}=${w[x]}`).join(', ')} below [${topN.join(', ')}]`);
    }

    if (lines.length) {
      issues++;
      say(`  ${c.n}  (${s.role || '?'})`);
      say(lines.join('\n'));
    }
  }
  const withBuilds = chars.filter(c => pairsFor[c.n] && pairsFor[c.n].set).length;
  say(`\n  ${issues} of ${withBuilds} matched characters differ.`);

  console.log(out.join('\n'));
}

main();
