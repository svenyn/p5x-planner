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

/* Global Awareness text that differs from lufel's, which follows JP. The whole level's text
   is replaced, so a refresh keeps it; applying one prints to stderr, and once lufel's English
   table carries the same change the entry should go. The wording is ours, written from the
   change list over lufel's own sentences, not the official Global text. */
const GLB_AWARENESS_OVERRIDES = {
  'Fuuka Yamagishi': {
    1: 'At the start of battle, Fuuka gains 2 bonus [Wish Listener] stacks. Increase max stacks of [Wish Listener] to 8.\nAfter using a skill, increase party\'s critical rate by 6% and critical damage by 15% for 2 turns. Stacks up to 2 times.',
    2: 'After using [Oracle Shift], the [Backup Character] immediately use their Theurgy or HIGHLIGHT once. This effect has a 3 [Combat Turns] cooldown.\nAfter using [Oracle Shift], increase party\'s total damage amp by 10% for 1 turn.\nWhen any ally is below 40% max HP, immediately restore HP equal to 20% of that ally\'s max HP, and restore HP equal to 15% of  that ally\'s max HP for 2 turns. This effect can be activated once per battle.',
    6: 'Decrease [Wish Listener] cost of [Oracle Shift] to 3 stacks.\nWhen using [Holy Prayer], gain 2 bonus [Wish Listener] stacks.\nThe party damage amp from Strengths and Weaknesses lasts 2 turns and stacks up to 2 times.',
    why: 'Global 4.12 buff (the user, 29 Oct 2026): Awareness 1 adds party +15% crit damage, Awareness 2\'s damage amp is 10% (was 6%), Awareness 6 makes it last 2 turns and stack twice'
  }
};

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
  'BUI·Prism': 'YUI [Prism]', 'BUI·Cosmic': 'YUI [Prism]',
  'CHORD·Summer': 'Ayaka Sakai [Summer]', 'BERRY·Summer': 'Ichigo Shikano [Summer]', 'CLOSER·Tropical': 'Motoha Arai [Tropical]',
  'CLOSER·Radiance': 'Motoha Arai [Radiance]', 'MOKO·Seaside': 'Tomoko Noge [Seaside]',
  'MARIAN·Beachflower': 'Minami Miyashita [Beachflower]',
  'PUPPET·Wavecatcher': 'Miyu Sahara [Wavecatcher]', 'WIND·Tempest': 'Riko Tanemura [Tempest]',
  'RIN·Firecracker': 'Yaoling Li [Firecracker]', 'LUCE·Notte': 'Shoki Ikenami [Notte]',
  'SOY·Pioneer': 'Shun Kano [Pioneer]', 'JOKER·Starlight': 'Ren Amamiya [Starlight]',
  'MONA·Starlight': 'Morgana [Starlight]', 'PANTHER·Starlight': 'Ann Takamaki [Starlight]'
};
const norm = n => String(n).replace(/[^a-z]/gi, '').toLowerCase();

/* If a // or /* comment starts at `i`, returns the index just past it; otherwise `i`. */
function skipComment(text, i) {
  if (text[i] !== '/') return i;
  if (text[i + 1] === '/') { const e = text.indexOf('\n', i); return e < 0 ? text.length : e; }
  if (text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); return e < 0 ? text.length : e + 2; }
  return i;
}

/* Finds the index of the bracket/brace/paren matching the one at `openIdx`, skipping
   over quoted strings so a stray '{' or '}' inside prose text is never counted, and over
   comments, whose apostrophes ("lufel's") would otherwise open a string that never closes. */
function matchClose(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const past = skipComment(text, i);
    if (past !== i) { i = past - 1; continue; }
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
    for (let was = -1; was !== i;) { was = i; while (i < objEnd && /[\s,]/.test(text[i])) i++; i = skipComment(text, i); }
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
    const glb = GLB_AWARENESS_OVERRIDES[enName] || {};
    const nodes = [];
    for (let lvl = 0; lvl <= 6; lvl++) {
      const name = en[`r${lvl}`];
      let detail = en[`r${lvl}_detail`];
      if (glb[lvl] != null) {
        console.error(`${enName}: Awareness ${lvl} from GLB_AWARENESS_OVERRIDES — ${glb.why}` +
          (glb[lvl] === detail ? ' (lufel now has the same text: remove the entry)' : ''));
        detail = glb[lvl];
      }
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
  /* src/data.js is CRLF; joining the nodes with a bare \n left it with mixed line
     endings (476 of them, 68 entries x 7 nodes, on the Sep 2026 refresh). */
  const EOL = text.includes('\r\n') ? '\r\n' : '\n';

  let out = '';
  let cursor = 0;
  let patched = 0, skipped = [];
  const INDENT = ' '.repeat(38);
  for (const { key, valStart, valEnd } of entries) {
    const nodes = buildAwareness(key);
    /* Replace an existing awareness field rather than appending a second one, so a
       re-run after a game patch refreshes the ladder instead of duplicating it. */
    const at = nodes ? text.slice(valStart, valEnd).indexOf('awareness:[') : -1;
    if (at >= 0) {
      const fieldStart = text.lastIndexOf(',', valStart + at);
      out += text.slice(cursor, fieldStart);
      cursor = matchClose(text, valStart + at + 'awareness:'.length) + 1;
    }
    out += text.slice(cursor, valEnd);
    if (nodes) {
      out = out.replace(/\s+$/, '');
      out += `,${EOL}${INDENT}awareness:[${nodes.join(',' + EOL + INDENT + '           ')}] `;
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
