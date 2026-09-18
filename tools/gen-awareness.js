#!/usr/bin/env node
/* Adds the `awareness` field to every CHAR_STATS entry in src/data.js, sourced from
 * lufel.net's per-character ritual.js files (the site's English UI calls this ladder
 * "Awareness" — 7 levels, r0..r6, unlocked with Cognitite; lufel's own field name is
 * "ritual", unrelated to Ascension/Mindscape/Awakening-7 which are already modelled).
 *
 *     node tools/fetch-lufel-data.js lufel.json   # must include ritual.js (see that tool)
 *     node tools/gen-awareness.js lufel.json      # patches src/data.js in place
 *
 * Unlike gen-data-from-lufel.js this does NOT regenerate CHAR_STATS wholesale — it
 * only inserts one new field per entry, via a brace-depth scan, so every other figure
 * in the file (which may have drifted from a newer lufel snapshot, or carry hand
 * corrections) is left untouched byte-for-byte.
 *
 * A scan of all 462 Awareness descriptions across the 67-character dump this was
 * written against found zero that are a bare, unconditional "Increase <stat> by <N>%."
 * — every one is gated on a trigger (start of battle, on-crit, on-Theurgy, stacks,
 * duration) or is a skill-level-up, neither of which this planner models (the same
 * rule already applied to conditional weapon passives). `parseRitualBonus` is kept
 * so a future patch that does add a plain stat line is picked up automatically, but
 * in practice every character's `awareness` array today carries names/descriptions
 * for the UI and no `s`/`v`/`pct` at all.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'src', 'data.js');

const q = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  .replace(/\r\n|\r|\n/g, '\\n') + "'";

/* Same conservative rule as parseWeaponBonus in gen-data-from-lufel.js: only a bare
   "Increase <stat> by <N>%." at the very start of the description counts. Anything
   with a duration, a trigger or a target other than a flat percentage is left as
   text only. No ladder here (rituals do not scale by weapon refinement), just one
   number per level. */
const STAT_EN = {
  'attack': 'ATK%', 'defense': 'DEF%', 'max hp': 'HP%', 'hp': 'HP%',
  'speed': 'Speed', 'critical rate': 'Crit Rate', 'critical damage': 'Crit Multiplier',
  'ailment accuracy': 'Ailment Accuracy', 'penetration': 'Resistance Pierce',
  'pierce rate': 'Resistance Pierce', 'sp recovery': 'SP Recovery'
};
const RITUAL_RE = new RegExp('^Increases?\\s+(' + Object.keys(STAT_EN).join('|') + ')\\s+by\\s+([\\d.]+)\\s*(%?)\\.?$', 'i');

function parseRitualBonus(desc) {
  if (!desc) return null;
  const first = String(desc).split(/\n/)[0].split(/(?<=\.)\s*(?=[A-Z[])/)[0].trim();
  const m = first.match(RITUAL_RE);
  if (!m) return null;
  return { s: STAT_EN[m[1].toLowerCase()], v: parseFloat(m[2]), pct: m[3] === '%' || /%/.test(m[2]) };
}

function loadOurs() {
  const src = fs.readFileSync(DATA_FILE, 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(src.replace(/^(\s*)(?:const|let)\s+/gm, '$1var '), ctx);
  return ctx;
}

/* Same alias/name matching gen-data-from-lufel.js uses to line up lufel's Korean-keyed
   roster with our English-named CHARACTERS. Duplicated rather than imported so this
   tool has no effect on the main generator. */
const EXPLICIT = {
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
const norm = n => String(n).replace(/[^a-z]/gi, '').toLowerCase();

/* Finds the index of the bracket/brace/paren matching the one at `openIdx`, skipping
   over quoted strings so a stray '{' or '}' inside prose text is never counted. */
function matchClose(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) { if (text[i] === '\\') i++; i++; }
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced braces from ' + openIdx);
}

/* Walks the CHAR_STATS object's top-level `'Name': { ... }` entries and returns each
   one's key plus the exact source-text span of its value object, so it can be edited
   in place without touching anything else in the file. */
function parseCharStatsEntries(text) {
  const startMarker = 'const CHAR_STATS = {';
  const blockStart = text.indexOf(startMarker);
  if (blockStart < 0) throw new Error('CHAR_STATS block not found in src/data.js');
  const objStart = blockStart + startMarker.length - 1; // index of the opening '{'
  const objEnd = matchClose(text, objStart);
  const entries = [];
  let i = objStart + 1;
  while (i < objEnd) {
    while (i < objEnd && /[\s,]/.test(text[i])) i++;
    if (i >= objEnd) break;
    if (text[i] !== "'") throw new Error('expected quoted CHAR_STATS key at index ' + i);
    let j = i + 1, key = '';
    while (text[j] !== "'") { if (text[j] === '\\') { key += text[j + 1]; j += 2; } else { key += text[j]; j++; } }
    j++;
    while (text[j] !== ':') j++;
    j++;
    while (/\s/.test(text[j])) j++;
    if (text[j] !== '{') throw new Error(`expected '{' after key ${key} at index ${j}`);
    const valStart = j;
    const valEnd = matchClose(text, valStart);
    entries.push({ key, valStart, valEnd });
    i = valEnd + 1;
  }
  return entries;
}

function main() {
  const lufelFile = process.argv[2] || 'lufel.json';
  const d = JSON.parse(fs.readFileSync(lufelFile, 'utf8'));
  if (!d.rituals) throw new Error('lufel dump has no `rituals` — re-run tools/fetch-lufel-data.js after the ritual.js fetch was added');

  const ours = loadOurs();
  const chars = ours.CHARACTERS;
  const byAlias = {}, byName = {};
  for (const c of chars) { if (c.a) byAlias[norm(c.a)] = c; byName[norm(c.n)] = c; }
  const match = info => {
    const cn = info.codename || '';
    if (EXPLICIT[cn]) return chars.find(c => c.n === EXPLICIT[cn]) || null;
    return byAlias[norm(cn)] || byName[norm(info.name_en || '')] || null;
  };

  const info = d.character_info || {};
  const rosterVar = Object.keys(info).find(k => {
    const v = info[k];
    return v && typeof v === 'object' && !Array.isArray(v) &&
           Object.values(v).some(e => e && typeof e === 'object' && 'rarity' in e && 'element' in e);
  });
  const roster = info[rosterVar] || {};

  // English-name -> Korean-name, via the same matching the main generator uses.
  const enToKr = {};
  for (const [kr, rinfo] of Object.entries(roster)) {
    const c = match(rinfo);
    if (c) enToKr[c.n] = kr;
  }

  let statLevels = 0, statHits = 0;
  const buildAwareness = enName => {
    const kr = enToKr[enName];
    const mod = kr && d.rituals[kr];
    const en = mod && mod.enCharacterRitualData && mod.enCharacterRitualData[kr];
    if (!en) return null;
    const nodes = [];
    for (let lvl = 0; lvl <= 6; lvl++) {
      const name = en[`r${lvl}`];
      const detail = en[`r${lvl}_detail`];
      if (!name && !detail) continue;
      statLevels++;
      const bonus = parseRitualBonus(detail);
      if (bonus) statHits++;
      const bits = [`n:${q(name || '')}`, `d:${q(detail || '')}`];
      if (bonus) bits.push(`s:${q(bonus.s)}`, `v:${bonus.v}`, `pct:${bonus.pct}`);
      nodes.push(`{${bits.join(',')}}`);
    }
    return nodes.length ? nodes : null;
  };

  const text = fs.readFileSync(DATA_FILE, 'utf8');
  const entries = parseCharStatsEntries(text);

  let out = '';
  let cursor = 0;
  let patched = 0, skipped = [];
  const INDENT = ' '.repeat(38);
  for (const { key, valEnd } of entries) {
    const nodes = buildAwareness(key);
    out += text.slice(cursor, valEnd);
    if (nodes) {
      out = out.replace(/\s+$/, '');
      out += `,\n${INDENT}awareness:[${nodes.join(',\n' + INDENT + '           ')}] `;
      patched++;
    } else {
      skipped.push(key);
    }
    cursor = valEnd;
  }
  out += text.slice(cursor);

  fs.writeFileSync(DATA_FILE, out, 'utf8');
  console.error(`patched ${patched}/${entries.length} CHAR_STATS entries with awareness data`);
  if (skipped.length) console.error(`no ritual data found for: ${skipped.join(', ')}`);
  console.error(`${statLevels} Awareness levels read, ${statHits} parsed as an unconditional flat stat`);
}

main();
