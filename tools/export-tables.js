#!/usr/bin/env node
/* Exports the game-data vocabulary from src/data.js as dist/tables.json — the seam
   the future OCR pipeline reads from instead of hand-copying slot/set/stat names.
   Loads the built app in a headless browser (same pattern as test/*.js) rather than
   requiring src/data.js directly, since it is a plain browser script with no
   module.exports. Run `npm run build` first (or use `npm run export-tables`). */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const PAGE = 'file://' + path.join(__dirname, '..', 'dist', 'p5x-planner.html');

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto(PAGE);
  await p.waitForTimeout(200);
  const tables = await p.evaluate(() => ({
    slots: SLOTS,
    slotInfo: Object.fromEntries(Object.entries(SLOT_INFO).map(([k, v]) => [k, { fixed: v.fixed, mains: v.mains }])),
    substats: Object.fromEntries(Object.entries(SUBSTATS).map(([k, v]) =>
      [k, { maxRoll: v.maxRoll, maxRollSpace: v.maxRollSpace || v.maxRoll, flat: v.flat }])),
    statAliases: STAT_ALIASES,
    flatToPercent: FLAT_TO_PERCENT,
    rarity: Object.fromEntries(Object.entries(RARITY).map(([k, v]) =>
      [k, { maxLevel: v.maxLevel, subMin: v.subMin, subMax: v.subMax }])),
    sets: Object.keys(SETS),
    setAliases: SET_ALIASES,
    spaceSets: Object.keys(SPACE_SETS),
    characters: CHARACTERS.map(c => c.n),
    // richer per-character view; `characters` above stays a plain name list so
    // vocab.py's norm_character keeps working unchanged
    characterMeta: CHARACTERS.map(c => ({ n: c.n, a: c.a || '', r: c.r, e: c.e }))
  }));
  await b.close();

  const outPath = path.join(__dirname, '..', 'dist', 'tables.json');
  fs.writeFileSync(outPath, JSON.stringify(tables, null, 2));
  console.log(`wrote ${path.relative(process.cwd(), outPath)} — ` +
    `${tables.sets.length} sets, ${tables.spaceSets.length} space sets, ` +
    `${Object.keys(tables.substats).length} substats, ${tables.characters.length} characters`);
})();
