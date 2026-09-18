#!/usr/bin/env node
/* Downloads lufel.net's raw data files and dumps them as one JSON blob.
 *
 *     node tools/fetch-lufel-data.js [outfile]
 *
 * lufel.net renders client-side, so the rendered pages are useless to a plain
 * fetcher — but the data behind them is plain static JS under /data/, and that
 * IS fetchable. Three groups matter here:
 *
 *   /data/character_info.js              roster: element, rarity, codename, names
 *   /data/{kr,en}/revelations/*.js       sets, set effects, substat roll tables,
 *                                        Space-card pairings, KR->EN name mapping
 *   /data/characters/<KR name>/setting.js  per-character recommended build
 *   /data/characters/<KR name>/ritual.js   per-character Awareness ladder (lufel's own
 *                                         field name is "ritual"; the site's English UI
 *                                         calls it "Awareness" — 7 levels, r0..r6)
 *   /apps/schedule/data.js               GLB/JP release timeline, version by version
 *
 * The schedule is the only place lufel states the order characters actually shipped
 * in. `release_order` in character_info.js is coarser — the whole launch roster shares
 * a value, and it disagrees with the schedule on a few pairs — so the roster order in
 * src/data.js comes from the schedule and falls back to release_order.
 *
 * Each file is a script of top-level `const NAME = {...}` declarations. They are
 * evaluated in a vm sandbox with const/let rewritten to var so the declarations
 * land on the context object and can be read back by name.
 */
const vm = require('vm');
const fs = require('fs');

const BASE = 'https://lufel.net';
const V = '?v=5.0.0';

async function get(path) {
  const r = await fetch(BASE + path, { headers: { 'User-Agent': 'p5x-planner/1.0' } });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.text();
}

/* Evaluate a lufel data script and return every top-level binding it declared.
   Files use both styles — some declare `const NAME = ...`, others assign
   `window.NAME = window.NAME || ...` — so collect from both places. `var` lands
   on the vm context object but `const`/`let` do not, hence the keyword rewrite;
   it only fires at line starts, leaving declarations inside strings and nested
   scopes alone. */
function evalScript(src, label) {
  const win = {};
  const ctx = vm.createContext({ window: win, document: {}, console: { log() {}, warn() {}, error() {} } });
  const rewritten = src.replace(/^(\s*)(?:const|let)\s+/gm, '$1var ');
  try {
    vm.runInContext(rewritten, ctx, { timeout: 20000 });
  } catch (e) {
    console.error(`  ! ${label}: ${e.message}`);
    return null;
  }
  const out = {};
  for (const src2 of [ctx, win]) {
    for (const k of Object.getOwnPropertyNames(src2)) {
      if (k === 'window' || k === 'document' || k === 'console') continue;
      const v = src2[k];
      if (typeof v === 'function' || typeof v === 'undefined') continue;
      out[k] = v;
    }
  }
  return out;
}

async function grab(path, label) {
  process.stderr.write(`  ${label}\n`);
  return evalScript(await get(path + V), label);
}

async function main() {
  const outfile = process.argv[2] || 'lufel-data.json';
  const dump = {};

  console.error('core files:');
  dump.character_info = await grab('/data/character_info.js', 'character_info');
  dump.character_info_glb = await grab('/data/character_info_glb.js', 'character_info_glb');
  dump.revelations_kr = await grab('/data/kr/revelations/revelations.js', 'revelations (kr)');
  dump.revelations_en = await grab('/data/en/revelations/revelations.js', 'revelations (en)');
  dump.schedule = await grab('/apps/schedule/data.js', 'release schedule');

  // The roster lives under whichever variable character_info.js declared; it is
  // keyed by Korean name, and those keys are the /data/characters/<name>/ paths.
  const info = dump.character_info || {};
  const rosterVar = Object.keys(info).find(k => {
    const v = info[k];
    return v && typeof v === 'object' && !Array.isArray(v) &&
           Object.values(v).some(e => e && typeof e === 'object' && 'rarity' in e && 'element' in e);
  });
  if (!rosterVar) throw new Error('could not locate the roster object in character_info.js');
  const roster = info[rosterVar];
  const names = Object.keys(roster);
  console.error(`\nroster: ${names.length} characters (var "${rosterVar}")`);

  dump.settings = {};
  dump.base_stats = {};
  dump.weapons = {};
  dump.rituals = {};
  dump.skills = {};
  const failed = [];
  const kinds = [['setting', dump.settings], ['base_stats', dump.base_stats], ['weapon', dump.weapons],
                 ['ritual', dump.rituals], ['skill', dump.skills]];
  for (const name of names) {
    const enc = encodeURIComponent(name);
    for (const [kind, bag] of kinds) {
      try {
        const got = evalScript(await get(`/data/characters/${enc}/${kind}.js${V}`), `${name}/${kind}`);
        if (got) bag[name] = got;
      } catch (e) {
        failed.push(`${name}/${kind}: ${e.message}`);
      }
    }
  }
  console.error(`\nsettings: ${Object.keys(dump.settings).length}, base_stats: ${Object.keys(dump.base_stats).length},` +
    ` weapons: ${Object.keys(dump.weapons).length}, rituals: ${Object.keys(dump.rituals).length}, skills: ${Object.keys(dump.skills).length}`);
  if (failed.length) console.error(`missing (${failed.length}): ${failed.join(', ')}`);

  fs.writeFileSync(outfile, JSON.stringify(dump, null, 1), 'utf8');
  console.error(`\nwrote ${outfile} (${(fs.statSync(outfile).size / 1048576).toFixed(1)} MB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
