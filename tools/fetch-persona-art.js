#!/usr/bin/env node
/* Downloads Wonder's Persona pictures from lufel.net into dist/art/, for the Personas tab's cards.

       node tools/fetch-persona-art.js            # download every one missing
       node tools/fetch-persona-art.js --force    # download them all again

   The same rules as tools/fetch-art.py and the roster portraits: these are Sega/Atlus game assets on a
   fan site — fine for your own copy of the planner, not for redistribution. dist/art/ is gitignored for
   that reason, `npm run site` leaves art out unless given --with-art, and the page shows initials when a
   picture is missing. lufel names each picture after the Persona's Korean name
   (/assets/img/persona/<Korean name>.webp, a full-body cut-out about 480 x 800); it is saved as
   persona-<slug>.webp, the slug of the English name by artSlug() in src/logic.js — keep the two in step.
   lufel's pictures are already a sensible size (60-110 KB), so they are saved as they come. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'art');
const BASE = 'https://lufel.net/';
const slug = n => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const get = async u => {
  const r = await fetch(u, { headers: { 'User-Agent': 'p5x-planner/1.0' } });
  if (!r.ok) throw new Error(r.status + ' ' + u);
  return Buffer.from(await r.arrayBuffer());
};

async function main() {
  const force = process.argv.includes('--force');
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext((await get(BASE + 'data/persona/index.js')).toString('utf8'), ctx);
  const index = ctx.window.personaIndex;
  if (!index) throw new Error('no personaIndex in lufel index.js');
  fs.mkdirSync(OUT, { recursive: true });
  let saved = 0, kept = 0;
  const failed = [];
  for (const [kr, e] of Object.entries(index)) {
    const en = String(e.name_en || '').trim();
    if (!en) continue;
    const dest = path.join(OUT, `persona-${slug(en)}.webp`);
    if (fs.existsSync(dest) && !force) { kept++; continue; }
    try {
      const img = await get(`${BASE}assets/img/persona/${encodeURIComponent(kr)}.webp`);
      if (img.slice(0, 4).toString() !== 'RIFF' || img.slice(8, 12).toString() !== 'WEBP') throw new Error('not a WebP image');
      fs.writeFileSync(dest, img);
      saved++;
    } catch (err) { failed.push(`${en}: ${err.message}`); }
  }
  console.error(`Persona art: ${saved} saved, ${kept} already there, ${failed.length} failed -> ${path.relative(ROOT, OUT)}`);
  if (failed.length) console.error('  ' + failed.join('\n  '));
}

main();
