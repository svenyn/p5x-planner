const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const PAGE = 'file://' + path.join(__dirname, '..', 'dist', 'p5x-planner.html');

/* Rebuilt 18 Sep 2026 from CLAUDE.md, docs/SCORING.md and the code, after the working copy
   of this file was reverted to a six-week-old commit by mistake. Every "a test asserts…"
   the docs make is pinned here again; the expected values were re-derived from the source
   and checked against the live page before being written down. Where the old file's exact
   wording is unknown the invariant is stated fresh — the point is what the code must keep
   doing, not what the old file said. */

/* WEIGHT_OVERRIDES lives in tools/gen-data-from-lufel.js — hand-tuned substat magnitudes
   that win over lufel's flat 10/8/6 tier map. src/data.js is generated FROM that table,
   so the two can only disagree if someone edited src/data.js by hand (which the next
   regeneration would silently revert) or edited the table without regenerating. Neither
   is visible from inside the page, so it is checked out here, where both files are
   readable. See "Lufel publishes an order, not magnitudes" in CLAUDE.md. */
function weightOverrideDrift() {
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const grab = (src, name) => {
    const at = src.indexOf(`const ${name} = {`);
    if (at < 0) return null;
    let i = src.indexOf('{', at), depth = 0, j = i;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) { j++; break; }
    }
    return src.slice(i, j);
  };
  const table = grab(read('tools/gen-data-from-lufel.js'), 'WEIGHT_OVERRIDES');
  if (!table) return ['tools/gen-data-from-lufel.js no longer defines WEIGHT_OVERRIDES'];
  const overrides = vm.runInContext('(' + table + ')', vm.createContext({}));
  const dataCtx = vm.createContext({});
  vm.runInContext(read('src/data.js').replace(/^(\s*)(?:const|let)\s+/gm, '$1var '), dataCtx);
  const out = [];
  for (const [name, spec] of Object.entries(overrides)) {
    const c = dataCtx.CHARACTERS.find(x => x.n === name);
    if (!c) { out.push(`WEIGHT_OVERRIDES names "${name}", who is not in CHARACTERS`); continue; }
    if (!spec.why) out.push(`WEIGHT_OVERRIDES["${name}"] has no \`why\` — every entry must say what it knows that lufel's tiers do not`);
    const w = (c.ov && c.ov.w) || {};
    for (const [st, val] of Object.entries(spec.w))
      if (w[st] !== val)
        out.push(`${name}: WEIGHT_OVERRIDES says ${st}=${val}, src/data.js has ${w[st] === undefined ? 'no override' : w[st]} — re-run tools/gen-data-from-lufel.js`);
  }
  return out;
}

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  p.on('console', m => {
    if (m.type() !== 'error') return;
    // Roster portraits are optional files in art/ next to the HTML; each <img>
    // removes itself on error so a missing one falls back to the initials
    // placeholder. With no art/ folder that is 65 expected 404s, which are the
    // feature working, not a fault — but only ignore that exact case.
    const loc = (m.location() && m.location().url) || '';
    if (/\/art\/[^/]+\.webp$/.test(loc)) return;
    errs.push('CONSOLE: ' + m.text());
  });
  await p.goto(PAGE);
  await p.waitForTimeout(400);

  const r = await p.evaluate(() => {
    // ---- build a synthetic inventory: 600 cards ----
    let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pickR = a => a[Math.floor(rnd() * a.length)];
    const heavens = ['Sun', 'Moon', 'Star', 'Sky'];
    const setNames = Object.keys(SETS), spaceNames = Object.keys(SPACE_SETS);
    const subPool = Object.keys(SUBSTATS);
    state.cards = [];
    for (let i = 0; i < 600; i++) {
      const slot = rnd() < 0.15 ? 'Space' : pickR(heavens);
      const set = slot === 'Space' ? pickR(spaceNames) : pickR(setNames);
      const rarity = pickR([5, 5, 5, 4, 4, 3, 2]);
      const info = SLOT_INFO[slot];
      const main = info.fixed ? info.mains[0] : pickR(info.mains);
      const subs = []; const used = new Set([main]);
      const n = rarity >= 4 ? 4 : rarity === 3 ? 3 : 2;
      while (subs.length < n) {
        const st = pickR(subPool);
        if (used.has(st)) continue; used.add(st);
        const mx = slot === 'Space' ? (SUBSTATS[st].maxRollSpace || SUBSTATS[st].maxRoll) : SUBSTATS[st].maxRoll;
        subs.push({ stat: st, value: +(mx * (0.5 + rnd() * 2.5)).toFixed(1) });
      }
      state.cards.push({ id: 'c' + i, slot, set, rarity, level: rarity * 5, main, subs, equipped: null });
    }
    state.nextId = 601;

    const out = { checks: [], plans: [] };
    const fail = (name, cond, detail) => out.checks.push({ name, pass: !!cond, detail: detail || '' });
    const J = x => JSON.stringify(x);
    const mk = (slot, set, main, subs, extra) => Object.assign({ slot, set, rarity: 5, level: 25, main,
      subs: subs.map(([stat, value]) => ({ stat, value })) }, extra || {});
    const lo = aw => Object.assign({}, DEFAULT_LOADOUT, { awareness: aw });
    const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-9 : eps);

    /* ================================================================================
       1. The optimiser over the whole roster — plan legality and integrity
       ================================================================================ */
    let planned = 0, incomplete = 0;
    const legality = [], policyBad = [], evalBad = [], spaceBad = [];
    for (const ch of CHARACTERS) {
      const t = target(ch);
      const pool = state.cards.filter(c => c.rarity >= 2);
      const res = bestPlan(ch, pool, { policy: 'pref' });
      if (!res.best) { incomplete++; continue; }
      planned++;
      for (const sl of heavens) {
        const pk = res.best.picks[sl];
        if (pk && pk.c.slot !== sl) legality.push(`${ch.n}: ${sl} got a ${pk.c.slot} card`);
      }
      if (res.best.kind === '4pc') {
        const S = res.best.sets[0];
        for (const sl of heavens) if (res.best.picks[sl].c.set !== S) legality.push(`${ch.n}: 4pc ${S} contains ${res.best.picks[sl].c.set}`);
      }
      if (res.best.kind === '2+2') {
        const counts = {};
        heavens.forEach(sl => { const s = res.best.picks[sl].c.set; counts[s] = (counts[s] || 0) + 1; });
        const vals = Object.values(counts).sort();
        if (vals.length !== 2 || vals[0] !== 2 || vals[1] !== 2) legality.push(`${ch.n}: 2+2 plan is actually ${J(counts)}`);
      }
      // within the same policy class, nothing may beat the chosen plan
      const sameClass = res.alternatives.filter(a => a.sets.some(s => t.sets.includes(s)));
      for (const alt of sameClass) if (alt.total > res.best.total + 1e-9) legality.push(`${ch.n}: alt "${alt.label}" (${alt.total}) beats best (${res.best.total})`);
      const keys = new Set([res.best, ...res.alternatives].map(pl => heavens.map(sl => pl.picks[sl].c.id).sort().join('|')));
      if (keys.size !== res.alternatives.length + 1) legality.push(`${ch.n}: duplicate loadouts in alternatives`);
      for (const S of res.best.sets) {
        const def = SETS[S];
        if (def && def.elem && def.elem !== ch.e && res.best.kind === '4pc')
          legality.push(`${ch.n} (${ch.e}): recommended off-element 4pc ${S}`);
      }
      if (!isFinite(res.best.total)) evalBad.push(`${ch.n}: best total ${res.best.total}`);
      // r.heavensTotal is the plan search's own evaluator; a plan's total must be what it says
      const ht = res.heavensTotal(heavens.map(sl => res.best.picks[sl].c));
      if (!near(ht.total, res.best.total, 1e-6)) evalBad.push(`${ch.n}: heavensTotal ${ht.total} vs best.total ${res.best.total}`);
      // Space: with a 4-piece active and a pairing card in the pool, the pick must pair
      if (res.best.kind === '4pc' && res.space) {
        const anyPairs = pool.some(c => c.slot === 'Space' && SPACE_SETS[c.set] && SPACE_SETS[c.set].pairs.includes(res.best.sets[0]));
        if (anyPairs && !res.space.pairs) spaceBad.push(`${ch.n}: 4pc ${res.best.sets[0]} but Space ${res.space.c.set} does not pair`);
      }
      // policies
      const f4 = bestPlan(ch, pool, { policy: 'force4' });
      if (f4.best && f4.best.kind !== '4pc' && f4.alternatives.some(a => a.kind === '4pc')) policyBad.push(`${ch.n}: force4 chose ${f4.best.kind}`);
      const st = bestPlan(ch, pool, { policy: 'stats' });
      if (st.best && st.statMax && st.best !== st.statMax) policyBad.push(`${ch.n}: stats policy did not pick statMax`);
      const a4 = bestPlan(ch, pool, { policy: 'any4' });
      if (a4.best && a4.best.kind !== '4pc' && a4.alternatives.some(a => a.kind === '4pc')) policyBad.push(`${ch.n}: any4 chose ${a4.best.kind}`);
      if (res.best.sets.length && !res.best.sets.some(s => t.sets.includes(s)) &&
        res.alternatives.some(a => a.sets.some(s => t.sets.includes(s)))) policyBad.push(`${ch.n}: pref ignored a preferred-set plan`);
      if (out.plans.length < 6) out.plans.push({
        char: ch.n, elem: ch.e, plan: res.best.label, total: +res.best.total.toFixed(1),
        space: res.space ? res.space.c.set + (res.space.pairs ? ' (pairs)' : ' (no synergy)') : 'none',
        mains: heavens.map(sl => `${sl}:${res.best.picks[sl].c.main}`).join(' ')
      });
    }
    fail('every character produced a plan', incomplete === 0, `${incomplete} without a plan`);
    fail('no slot/set legality violations', legality.length === 0, legality.slice(0, 5).join(' | '));
    fail('every plan total is finite and equals its own heavensTotal', evalBad.length === 0, evalBad.slice(0, 4).join(' | '));
    fail('the Space pick pairs with an active 4-piece whenever a pairing card exists', spaceBad.length === 0, spaceBad.slice(0, 4).join(' | '));
    fail('set policies pick what they say they pick (force4 / any4 / stats / pref)', policyBad.length === 0, policyBad.slice(0, 4).join(' | '));
    fail('poolFor("free") excludes cards worn by others and keeps the character\'s own', (() => {
      const a = state.cards[0], bb = state.cards[1], c = state.cards[2];
      a.equipped = 'Ren Amamiya'; bb.equipped = 'Morgana'; c.equipped = 'Morgana'; c.locked = true;
      const free = poolFor('free', 2, 'Ren Amamiya'), all = poolFor('all', 2, 'Ren Amamiya');
      const ok = free.includes(a) && !free.includes(bb) && !free.includes(c) && all.includes(bb) && !all.includes(c);
      a.equipped = null; bb.equipped = null; c.equipped = null; c.locked = false;
      return ok;
    })());

    /* ================================================================================
       2. Data integrity — CHARACTERS, SETS, SPACE_SETS, tables
       ================================================================================ */
    fail('the roster is the documented 65 characters in release order (not re-sorted by name)',
      CHARACTERS.length === 65 && CHARACTERS.slice().sort((a, b) => a.n.localeCompare(b.n)).some((c, i) => c !== CHARACTERS[i]));
    const names = CHARACTERS.map(c => c.n);
    fail('no duplicate character names', new Set(names).size === names.length, names.filter((n, i) => names.indexOf(n) !== i).join(', '));
    fail('every character has a known archetype and element',
      CHARACTERS.every(c => ARCHETYPES[c.arch] && ELEMENTS.includes(c.e)),
      CHARACTERS.filter(c => !ARCHETYPES[c.arch] || !ELEMENTS.includes(c.e)).map(c => c.n).join(', '));
    const badMain = [];
    for (const ch of CHARACTERS) {
      const t = target(ch);
      for (const sl of ['Moon', 'Star', 'Sky']) {
        const list = mainList(t, sl);
        if (!list.length) badMain.push(`${ch.n} ${sl} has no main`);
        list.forEach(m => { if (!SLOT_INFO[sl].mains.includes(m)) badMain.push(`${ch.n} ${sl}=${m}`); });
        if (new Set(list).size !== list.length) badMain.push(`${ch.n} ${sl} lists a main twice`);
      }
    }
    fail('all target main stats are legal for their slot, listed once, best first', badMain.length === 0, badMain.join(' | '));
    const badRef = [];
    for (const ch of CHARACTERS) {
      (ch.sets || []).forEach(s => { if (!SETS[s]) badRef.push(`${ch.n} set ${s}`); });
      if (ch.space && !SPACE_SETS[ch.space]) badRef.push(`${ch.n} space ${ch.space}`);
    }
    fail('all referenced sets exist', badRef.length === 0, badRef.join(' | '));
    const badPair = [];
    Object.entries(SPACE_SETS).forEach(([k, v]) => v.pairs.forEach(pp => { if (!SETS[pp]) badPair.push(`${k}->${pp}`); }));
    fail('all space pairings reference real sets', badPair.length === 0, badPair.join(' | '));
    fail('every Space card names at least one pairing and an effect for each (lufel lists one for Nativity)',
      Object.values(SPACE_SETS).every(v => v.pairs.length >= 1 && v.pairs.length <= 3 && v.pairs.every(pp => v.effects && v.effects[pp])) &&
      Object.values(SPACE_SETS).filter(v => v.pairs.length === 3).length >= 16);
    const deadOwnSets = [];
    for (const ch of CHARACTERS) (ch.sets || []).forEach(s => {
      const def = SETS[s];
      if (def && def.elem && def.elem !== ch.e) deadOwnSets.push(`${ch.n} (${ch.e}) lists off-element set ${s} (${def.elem})`);
    });
    fail('no character lists an off-element set among their own preferred sets', deadOwnSets.length === 0, deadOwnSets.join(' | '));
    /* Six Heavens sets and a few Space cards are lufel-listed but unshipped. They stay in
       the tables so an import resolves, but nobody may be built around one. */
    const unreleased = Object.keys(SETS).filter(s => SETS[s].unreleased);
    const unreleasedSpace = Object.keys(SPACE_SETS).filter(s => SPACE_SETS[s].unreleased);
    fail('the unreleased sets are still marked (6 Heavens, 3+ Space)', unreleased.length === 6 && unreleasedSpace.length >= 3,
      `${unreleased.length} / ${unreleasedSpace.length}`);
    fail('no character targets an unreleased set or Space card',
      CHARACTERS.every(c => !(c.sets || []).some(s => SETS[s] && SETS[s].unreleased) && !(c.space && SPACE_SETS[c.space] && SPACE_SETS[c.space].unreleased)),
      CHARACTERS.filter(c => (c.sets || []).some(s => SETS[s] && SETS[s].unreleased) || (c.space && SPACE_SETS[c.space] && SPACE_SETS[c.space].unreleased)).map(c => c.n).join(', '));
    fail('every set carries a 2-piece model on a real stat', Object.values(SETS).every(s => s.bonus2 && (SUBSTATS[s.bonus2.stat] || s.bonus2.stat === 'HP Recovery') && s.bonus2.amt > 0));
    fail('every element-locked set names a real element', Object.values(SETS).every(s => !s.elem || ELEMENTS.includes(s.elem)));
    fail('set aliases resolve to real sets and never shadow a real name',
      Object.entries(SET_ALIASES).every(([k, v]) => SETS[v] && !SETS[k] && !Object.keys(SETS).some(s => s.toLowerCase() === k)));
    fail('stat aliases resolve to real stats', Object.values(STAT_ALIASES).every(v => SUBSTATS[v] || v === 'HP Recovery'));
    fail('every archetype supplies a legal main for Moon/Star/Sky and a weight for every substat',
      Object.values(ARCHETYPES).every(A => ['Moon', 'Star', 'Sky'].every(sl => SLOT_INFO[sl].mains.includes(A.main[sl])) &&
        Object.keys(SUBSTATS).every(s => typeof A.w[s] === 'number')));
    const badW = [];
    CHARACTERS.forEach(c => Object.entries((c.ov && c.ov.w) || {}).forEach(([s, v]) => {
      if (!SUBSTATS[s]) badW.push(`${c.n}: unknown stat ${s}`);
      if (!(v >= 0 && v <= 10)) badW.push(`${c.n}: ${s}=${v}`);
    }));
    fail('every per-character weight names a substat and sits in 0-10', badW.length === 0, badW.join(' | '));
    const badT = [];
    CHARACTERS.forEach(c => ((c.ov && c.ov.targets) || []).forEach(x => {
      if (!SUBSTATS[x.sub]) badT.push(`${c.n}: target sub ${x.sub}`);
      if (!(x.sub === x.s || FLAT_TO_PERCENT[x.s] === x.sub)) badT.push(`${c.n}: ${x.s} scored through ${x.sub}`);
      const keys = Object.keys(x.tiers || {});
      if (!keys.length || !keys.every(k => /^LV\d+(\+5)?$/.test(k) && typeof x.tiers[k] === 'number')) badT.push(`${c.n}: tiers ${J(x.tiers)}`);
    }));
    fail('every stat target scores a real substat against its own stat and carries LV-keyed tiers', badT.length === 0, badT.join(' | '));
    fail('37 characters carry stat targets', CHARACTERS.filter(c => c.ov && c.ov.targets && c.ov.targets.length).length === 37);

    // ---- measured tables ----
    fail('ROLL_TIERS: five ascending tiers per stat on both layouts, top tier equal to maxRoll',
      Object.keys(SUBSTATS).every(s => {
        const rt = ROLL_TIERS[s]; if (!rt) return false;
        const asc = a => a.length === 5 && a.every((v, i) => i === 0 || v > a[i - 1]);
        return asc(rt.heavens) && asc(rt.space) && near(rt.heavens[4], SUBSTATS[s].maxRoll) && near(rt.space[4], SUBSTATS[s].maxRollSpace || SUBSTATS[s].maxRoll);
      }), Object.keys(SUBSTATS).filter(s => !ROLL_TIERS[s]).join(', '));
    fail('MAIN_MAGNITUDE covers every legal main and grows with level',
      SLOTS.every(sl => SLOT_INFO[sl].mains.every(m => MAIN_MAGNITUDE[m] && MAIN_MAGNITUDE[m][1] > MAIN_MAGNITUDE[m][0] && MAIN_MAGNITUDE[m][0] > 0)));
    fail('a max-level main is worth about nine max rolls for every stat with a substat (8.5-9.5)',
      ['Moon', 'Star', 'Sky'].every(sl => SLOT_INFO[sl].mains.every(m => { const v = mainRolls(m, sl, 25); return v >= 8.5 && v <= 9.5; })) &&
      near(mainRolls('HP Recovery', 'Moon', 25), MAIN_ROLLS_FALLBACK),
      ['Moon', 'Star', 'Sky'].map(sl => SLOT_INFO[sl].mains.map(m => m + '=' + mainRolls(m, sl, 25).toFixed(2)).join(' ')).join(' | '));
    fail('a level-0 main is worth well under two rolls (main growth is what levelling buys)', mainRolls('ATK%', 'Moon', 0) < 2 && mainRolls('ATK%', 'Moon', 0) > 1);
    fail('RARITY: 5★ Lv25 five upgrades, 4★ Lv20 four, 3★ Lv15 three, 2★ Lv10 two',
      RARITY[5].maxLevel === 25 && RARITY[5].upgrades === 5 && RARITY[4].maxLevel === 20 && RARITY[4].upgrades === 4 &&
      RARITY[3].maxLevel === 15 && RARITY[3].upgrades === 3 && RARITY[2].maxLevel === 10 && RARITY[2].upgrades === 2);
    fail('CHAR_STATS covers every character with a base triple, speed, crit and a 5★ weapon',
      CHARACTERS.every(c => { const cs = CHAR_STATS[c.n]; return cs && cs.l80 && cs.l80.length === 3 && typeof cs.spd === 'number' && typeof cs.cr === 'number' && typeof cs.cm === 'number' && cs.w5; }),
      CHARACTERS.filter(c => !CHAR_STATS[c.n]).map(c => c.n).join(', '));
    fail('the seven Buff-element supports with a 0% crit base are all Elucidators',
      (() => { const z = CHARACTERS.filter(c => CHAR_STATS[c.n] && CHAR_STATS[c.n].cr === 0); return z.length === 7 && z.every(c => c.arch === 'Navigator'); })());
    fail('eight Elucidators on the roster', CHARACTERS.filter(c => c.arch === 'Navigator').length === 8);

    /* A weapon's `extra` is the passive text the generator refused to count. It must never
       be a plain unconditional "Increase <stat> by <ladder>." — that would be a stat the
       character always has, silently dropped. Same vocabulary and regex as
       tools/gen-data-from-lufel.js's WEAPON_RE, ported here because the generator is not
       loadable from inside the page. */
    const VOC = ['attack', 'defense', 'max hp', 'hp', 'speed', 'critical rate', 'critical damage', 'ailment accuracy', 'penetration', 'pierce rate', 'sp recovery']
      .concat(['Physical', 'Gun', 'Fire', 'Ice', 'Electric', 'Wind', 'Psychokinesis', 'Nuclear', 'Bless', 'Curse', 'Almighty'].map(e => e.toLowerCase() + ' damage'));
    const WEAPON_RE = new RegExp('^Increases?\\s+(' + VOC.join('|') + ')\\s+by\\s+([\\d.]+(?:\\s*%?\\s*/\\s*[\\d.]+)*)\\s*(%?)\\s*\\.?$', 'i');
    const extras = [];
    Object.keys(CHAR_STATS).forEach(n => ['w4', 'w5'].forEach(k => {
      const w = CHAR_STATS[n][k];
      if (w && w.extra) extras.push({ n, k, first: String(w.extra).split(/\n/)[0].split(/(?<=\.)\s*(?=[A-Z[])/)[0].trim() });
    }));
    fail('no weapon `extra` is really a plain unconditional stat line', extras.every(x => !WEAPON_RE.test(x.first)),
      extras.filter(x => WEAPON_RE.test(x.first)).map(x => `${x.n} ${x.k}: ${x.first}`).join(' | '));
    fail('a weapon may carry both a counted ladder and an uncounted clause (Mermaid Dreamer)',
      Object.values(CHAR_STATS).some(cs => ['w4', 'w5'].some(k => cs[k] && cs[k].b && cs[k].extra)));
    fail('every counted weapon ladder has seven refinement steps on a real stat',
      Object.values(CHAR_STATS).every(cs => ['w4', 'w5'].every(k => !cs[k] || !cs[k].b || (cs[k].b.r.length === 7 && (SUBSTATS[cs[k].b.s] || cs[k].b.s === 'HP Recovery')))));

    // ---- the hand-kept judgement tables ----
    fail('KIT_STAT_BUFFS names real characters and every line carries a stat, a value and a reason',
      Object.entries(KIT_STAT_BUFFS).every(([n, lines]) => charDef(n) && lines.every(x =>
        (SUBSTATS[x.s] || x.s === 'HP Recovery') && x.why && (typeof x.v === 'number' || (x.tiers && x.tiers.length === 4) || (x.ladder && x.ladder.length === 7)))),
      Object.keys(KIT_STAT_BUFFS).filter(n => !charDef(n)).join(', '));
    fail('CONVERSIONS names real characters, real source and destination stats, and a reason',
      Object.entries(CONVERSIONS).every(([n, list]) => charDef(n) && list.every(cv =>
        (SUBSTATS[cv.from] || cv.from === 'HP Recovery') && ['ATK%', 'ATK', 'Crit Multiplier', 'Damage Multiplier', 'HP'].includes(cv.to) && cv.rate > 0 && cv.why)));
    fail('CRIT_PROFILE names real characters with a locked share in (0,1] or a no-crit share',
      Object.entries(CRIT_PROFILE).every(([n, pr]) => charDef(n) && ((pr.locked > 0 && pr.locked <= 1) || (pr.nocrit > 0 && pr.nocrit < 1))) &&
      CRIT_PROFILE['Ryuji Sakamoto'].locked === 1 && CRIT_PROFILE['Shun Kano [Pioneer]'].locked === 1);
    fail('DAMAGE_SCALE names the six DEF/HP-scaling kits, each weighting ATK% at zero',
      Object.keys(DAMAGE_SCALE).length === 6 && Object.entries(DAMAGE_SCALE).every(([n, s]) => charDef(n) && ['DEF', 'HP'].includes(s) && target(charDef(n)).w['ATK%'] === 0) &&
      !DAMAGE_SCALE['Yukimi Fujikawa'] && !DAMAGE_SCALE['Motoha Arai [Tropical]']);
    fail('TARGET_TIER_AWARENESS_5 names real characters', [...TARGET_TIER_AWARENESS_5].every(n => charDef(n)));

    /* ================================================================================
       3. Constants — docs/SCORING.md §7 in one place. Changing one changes every score;
          this makes the docs and the code disagree loudly instead of silently.
       ================================================================================ */
    fail('documented constants match docs/SCORING.md §7',
      MAIN_MATCH_BONUS === 10 && MAIN_ALT_DECAY === 0.85 && J(IDEAL_ROLLS) === '[3,2,2,2]' && SPACE_PAIR_VALUE === 9 &&
      BREAKPOINT_VALUE === 80 && SPREAD_VALUE === 80 && J(COUPLE_CLAMP) === '[0.4,2.5]' && VAULT_LOCK === 0.98 && VAULT_WATCH === 0.93 &&
      J(AWARENESS_STAT_PCT) === '[0,2,5,7,10,12,15]' && MAIN_CHOICES === 3 && MAIN_ROLLS_FALLBACK === 9 &&
      J(BUILD_BANDS.map(x => x.min)) === '[80,60,40,0]' && J([5, 4, 3, 2].map(rarityPenalty)) === '[1,0.82,0.6,0.4]' &&
      DEFAULT_LOADOUT.level === 80 && DEFAULT_LOADOUT.asc === 7 && DEFAULT_LOADOUT.weapon === '5' && DEFAULT_LOADOUT.refine === 1 && DEFAULT_LOADOUT.awareness === 0);
    fail('charLoadout forces Level 80 / Ascension 7 whatever a save says', (() => {
      state.chars['Morgana'].loadout = { level: 60, asc: 2, weapon: '4', refine: 3 };
      const L = charLoadout('Morgana'); state.chars['Morgana'].loadout = null;
      return L.level === 80 && L.asc === 7 && L.weapon === '4' && L.refine === 3;
    })());
    fail('a pre-Mindscape-paths save\'s `mind` boolean maps to both stat paths maxed', (() => {
      state.chars['Morgana'].loadout = { mind: true };
      const L = charLoadout('Morgana'); state.chars['Morgana'].loadout = null;
      return L.mindSkill === true && L.mind1 === 5 && L.mind2 === 5 && L.mind === undefined;
    })());

    /* ================================================================================
       4. Pricing one card — cardScore, the main, the coupling
       ================================================================================ */
    const joker = charDef('Ren Amamiya'), tj = target(joker), lj = charLoadout(joker.n);
    const good = mk('Star', 'Hindrance', 'Crit Rate', [['Crit Multiplier', 16.4], ['Resistance Pierce', 8.4], ['ATK%', 14], ['Speed', 6.6]]);
    const bad = mk('Star', 'Hindrance', 'DEF%', [['DEF', 184], ['HP', 560], ['HP%', 14.4], ['Speed', 6.6]]);
    fail('on-target card outscores junk', cardScore(good, tj) > cardScore(bad, tj) * 3, `${cardScore(good, tj).toFixed(1)} vs ${cardScore(bad, tj).toFixed(1)}`);
    fail('a wanted main with no substats beats a dead main with strong ones',
      cardScore(mk('Star', 'Hindrance', 'Crit Rate', []), tj) > cardScore(bad, tj));
    fail('rarity penalty orders the same card 5★ > 4★ > 3★ > 2★', (() => {
      const base = mk('Star', 'Hindrance', 'Crit Rate', [['Crit Multiplier', 4], ['ATK%', 3]], { level: 10 });
      const s = [5, 4, 3, 2].map(rr => cardScore(Object.assign({}, base, { rarity: rr }), tj));
      return s[0] > s[1] && s[1] > s[2] && s[2] > s[3] && near(s[1] / s[0], 0.82);
    })());
    fail('a Sun card\'s fixed HP main is priced at nothing (substats only)',
      near(cardScore(mk('Sun', 'Hindrance', 'HP', []), tj), 0) && cardScore(mk('Sun', 'Hindrance', 'HP', [['Crit Rate', 2]]), tj) > 0);
    fail('a Space card\'s fixed ATK + DEF main is priced at nothing', near(cardScore(mk('Space', 'Departure', 'ATK + DEF', []), tj), 0));
    /* Lufel's printed order is a tie-break and nothing more: with the coupling neutral
       (Speed and SP Recovery sit in no product) the second-ranked main loses exactly
       MAIN_MATCH_BONUS × (1 − MAIN_ALT_DECAY). */
    const tA = { sets: [], space: '', targets: [], main: { Sky: ['Speed'] }, w: { Speed: 5, 'SP Recovery': 5 } };
    const tB = { sets: [], space: '', targets: [], main: { Sky: ['SP Recovery', 'Speed'] }, w: { Speed: 5, 'SP Recovery': 5 } };
    const spdCard = mk('Sky', 'Power', 'Speed', []);
    fail('the alternative-main decay is exactly MAIN_MATCH_BONUS × (1 − MAIN_ALT_DECAY) when the coupling is neutral',
      near(cardScore(spdCard, tA) - cardScore(spdCard, tB), MAIN_MATCH_BONUS * (1 - MAIN_ALT_DECAY), 1e-9),
      (cardScore(spdCard, tA) - cardScore(spdCard, tB)).toFixed(4));
    fail('mainList/mainTop accept a bare string and a list alike',
      J(mainList({ main: { Moon: 'ATK%' } }, 'Moon')) === '["ATK%"]' && J(mainList({ main: { Moon: ['ATK%', 'HP%'] } }, 'Moon')) === '["ATK%","HP%"]' &&
      mainTop({ main: { Moon: ['DEF%', 'HP%'] } }, 'Moon') === 'DEF%' && mainList({ main: {} }, 'Moon').length === 0);
    fail('an unrecommended main earns no match bonus', (() => {
      const t1 = { sets: [], space: '', targets: [], main: { Sky: ['Speed'] }, w: { Speed: 5, 'SP Recovery': 5 } };
      const sp = mk('Sky', 'Power', 'SP Recovery', []);
      return near(cardScore(sp, t1), 5 * mainRolls('SP Recovery', 'Sky', 25));
    })());
    // HP Recovery, the one main-only stat
    const yukari = charDef('Yukari Takeba');
    fail('HP Recovery as a main is worth a character\'s top weight only where lufel lists it, else nothing',
      hpRecoveryMainWeight(target(yukari), 'Moon') === Math.max(...Object.values(target(yukari).w)) && hpRecoveryMainWeight(tj, 'Moon') === 0 &&
      hpRecoveryMainWeight({ w: { 'HP Recovery': 3 }, main: { Moon: ['ATK%'] } }, 'Moon') === 3);
    fail('an HP Recovery Moon never beats a wanted main for a damage dealer',
      cardScore(mk('Moon', 'Hindrance', 'HP Recovery', []), tj) < cardScore(mk('Moon', 'Hindrance', mainTop(tj, 'Moon'), []), tj));
    // Skull and Messa: kit facts the tiers cannot express
    const skull = charDef('Ryuji Sakamoto'), ts = target(skull);
    fail('Skull weights Crit Rate at 0', ts.w['Crit Rate'] === 0, 'w=' + ts.w['Crit Rate']);
    fail('Skull wants Crit Multiplier on Star', mainTop(ts, 'Star') === 'Crit Multiplier', J(mainList(ts, 'Star')));
    const messa = charDef('Kira Kitazato'), tm0 = target(messa);
    fail('Messa weights both crit stats at 0', tm0.w['Crit Rate'] === 0 && tm0.w['Crit Multiplier'] === 0);
    fail('no coupling where there is no trade-off (Messa\'s crit product has no live stat)',
      Object.keys(couplingFactors(tm0, 'Star', 'Crit Rate')).every(k => k !== 'Crit Rate' && k !== 'Crit Multiplier') &&
      Object.keys(couplingFactors(ts, 'Star', 'Crit Multiplier')).every(k => k !== 'Crit Rate' && k !== 'Crit Multiplier'));

    // ---- coupling: complements inside a product ----
    const ann = charDef('Ann Takamaki'), ta = target(ann);
    const fAtk = couplingFactors(ta, 'Moon', 'ATK%'), fDmg = couplingFactors(ta, 'Moon', 'Damage Multiplier');
    fail('taking the Damage Multiplier main makes ATK% substats worth more (Ann)', fDmg['ATK%'] > fAtk['ATK%'] && fAtk['Damage Multiplier'] > fDmg['Damage Multiplier'],
      `ATK% ${fAtk['ATK%'].toFixed(3)} -> ${fDmg['ATK%'].toFixed(3)}`);
    const fCR = couplingFactors(tj, 'Star', 'Crit Rate'), fCM = couplingFactors(tj, 'Star', 'Crit Multiplier');
    fail('taking a Crit Rate main makes Crit Multiplier substats worth more, and vice versa',
      fCR['Crit Multiplier'] > fCM['Crit Multiplier'] && fCM['Crit Rate'] > fCR['Crit Rate']);
    fail('coupling adjustments are scale-neutral (the live factors of a product multiply to 1 unless clamped)',
      CHARACTERS.every(c => {
        const t = target(c);
        return ['Moon', 'Star', 'Sky'].every(sl => mainList(t, sl).every(m => {
          const f = couplingFactors(t, sl, m);
          return statProducts(c).every(product => {
            const live = Object.keys(product).filter(s => f[s] != null);
            if (live.length < 2) return true;
            const prod = live.reduce((s, k) => s * f[k], 1);
            return Math.abs(Math.log(prod)) < 1e-6 || live.some(k => f[k] === COUPLE_CLAMP[0] || f[k] === COUPLE_CLAMP[1] || f[k] === 0);
          });
        }));
      }));
    fail('every coupling factor sits inside COUPLE_CLAMP or is the hard zero',
      CHARACTERS.every(c => { const t = target(c); return SLOTS.every(sl => SLOT_INFO[sl].mains.every(m => Object.values(couplingFactors(t, sl, m)).every(v => v === 0 || (v >= COUPLE_CLAMP[0] - 1e-12 && v <= COUPLE_CLAMP[1] + 1e-12)))); }));
    /* Seeded coupling: the pre-board baseline is the character's own. YUI starts above 50%
       crit with her weapon, so a Crit Multiplier roll is worth more than a Crit Rate roll to
       her before any card is placed; an Elucidator keeps the generic baseline because the
       stats are donated. */
    const yui = charDef('YUI');
    const fy = couplingFactors(target(yui), 'Moon', 'ATK%');
    fail('a high-crit character\'s baseline favours Crit Multiplier over Crit Rate', fy['Crit Multiplier'] > fy['Crit Rate'] && damageBase(yui).cr > 40,
      `CM ${fy['Crit Multiplier'].toFixed(2)} CR ${fy['Crit Rate'].toFixed(2)} at ${damageBase(yui).cr}% crit`);
    const navi = charDef('Hatsune Miku'), tn = target(navi);
    const generic = Object.assign({}, tn, { n: undefined });
    const fN = couplingFactors(tn, 'Moon', 'ATK%'), fG = couplingFactors(generic, 'Moon', 'ATK%');
    fail('an Elucidator\'s coupling uses the generic baseline, not their own 0/0 crit board',
      near(fN['Crit Rate'], fG['Crit Rate']) && near(fN['Crit Multiplier'], fG['Crit Multiplier']) && seedBaseline(tn) === null && seedBaseline(tj) !== null);
    fail('a DPS\'s seeded baseline reads their own weapon and Awakening (Joker above 100% ATK, real crit)',
      seedBaseline(tj)['ATK%'] > 100 && near(seedBaseline(tj)['Crit Rate'], damageBase(joker).cr));
    fail('target() stamps the owner\'s name on generated and saved targets alike', (() => {
      state.chars['Morgana'].targets = { sets: ['Love'], space: 'Acceptance', main: { Moon: ['ATK%'] }, w: { 'ATK%': 10 }, targets: [] };
      const ok = target(charDef('Morgana')).n === 'Morgana' && tj.n === 'Ren Amamiya';
      state.chars['Morgana'].targets = null; return ok;
    })());
    /* Capped Crit Rate: once the board holds 100 points, a Crit Rate roll is worth zero. */
    const morg = charDef('Morgana'), tm = target(morg);
    const capped = realCoupleContext(morg, [mk('Star', 'Love', 'Crit Rate', [['Crit Rate', 60]], { mainValue: 18.8 })], charLoadout(morg.n));
    fail('a board already at 100% crit rate prices a Crit Rate roll at zero',
      capped['Crit Rate'] >= 100 && couplingFactors(tm, 'Moon', 'ATK%', capped)['Crit Rate'] === 0 &&
      near(cardScore(mk('Moon', 'Love', 'ATK%', [['Crit Rate', 6]]), tm, capped), cardScore(mk('Moon', 'Love', 'ATK%', []), tm, capped)),
      `held ${capped['Crit Rate']}`);
    fail('below the cap the generic path leaves Crit Rate live', couplingFactors(target(yui), 'Star', 'Crit Rate')['Crit Rate'] > 0);
    fail('cf() treats a hard zero as an answer and only a missing factor as neutral', cf({ 'Crit Rate': 0 }, 'Crit Rate') === 0 && cf({}, 'Crit Rate') === 1);

    /* Scaling stat: Yusuke's ⓐ is DEF, so the coupling pairs DEF% with Damage Multiplier. */
    const yu = charDef('Yusuke Kitagawa'), yt = target(yu), ylo = charLoadout(yu.n);
    fail('the coupling pairs a DEF-scaling kit\'s DEF% with Damage Multiplier, and leaves ATK% out',
      couplingFactors(yt, 'Moon', 'DEF%')['DEF%'] != null && couplingFactors(yt, 'Moon', 'DEF%')['ATK%'] == null && scaleStat(yu) === 'DEF' && scalePctStat(charDef('Junpei Iori')) === 'HP%');

    /* ---- coupling arithmetic must always produce a number ------------------------
       A live bug (18 Sep 2026). realCoupleContext's 'Crit Multiplier' is a TOTAL MINUS 100
       and the seven Buff-element supports carry a 0% crit damage base, so on a board that has
       not made up the difference it came back NEGATIVE; computeCoupling took Math.log of it
       and the whole crit product went NaN. cardScore's `if (!ws) continue` then dropped every
       crit substat silently while a crit MAIN scored NaN outright, and bestPlan's sort on NaN
       left the slot in pool order — which is why Hatsune Miku's recommendation ignored the
       four Labor cards she wore. A supply of exactly zero is the same failure by another
       route (log 0 -> -Infinity -> 0/0), so the guard is on the supply, not the sign. */
    const nanSweep = [];
    CHARACTERS.forEach(c => {
      const tc = target(c), lc = charLoadout(c.n);
      const boards = [null, realCoupleContext(c, [], lc), realCoupleContext(c, idealLoadout(c, tc).cards, lc)];
      SLOTS.forEach(sl => SLOT_INFO[sl].mains.forEach(m => boards.forEach((rb, bi) => {
        const f = couplingFactors(tc, sl, m, rb);
        Object.keys(f).forEach(k => { if (!isFinite(f[k])) nanSweep.push(`${c.n} ${sl}/${m} board${bi}: ${k}=${f[k]}`); });
        const probe = mk(sl, 'Labor', m, [['Crit Rate', 6], ['Crit Multiplier', 8], ['ATK%', 10]]);
        if (!isFinite(cardScore(probe, tc, rb))) nanSweep.push(`${c.n} ${sl}/${m} board${bi}: cardScore NaN`);
      })));
    });
    fail('no coupling factor or card score is ever NaN, on any board', !nanSweep.length, nanSweep.slice(0, 4).join(' | '));
    fail('a sub-100% crit damage total floors at zero supply, never goes negative',
      CHARACTERS.every(c => realCoupleContext(c, [], charLoadout(c.n))['Crit Multiplier'] >= 0),
      CHARACTERS.filter(c => realCoupleContext(c, [], charLoadout(c.n))['Crit Multiplier'] < 0).map(c => c.n).join(', '));
    const mikuStar = mk('Star', 'Labor', 'Crit Rate', [['Crit Multiplier', 9.2], ['ATK%', 3.2], ['Damage Multiplier', 7.8]]);
    fail('an Elucidator\'s crit-main Star scores against a real board',
      isFinite(cardScore(mikuStar, tn, realCoupleContext(navi, [], charLoadout(navi.n)))) && cardScore(mikuStar, tn, realCoupleContext(navi, [], charLoadout(navi.n))) > 0);

    // ---- the ideal card, and the per-card percentage ----
    const idealBad = [];
    CHARACTERS.forEach(c => {
      const t = target(c);
      const idl = idealLoadout(c, t, 55);
      idl.cards.forEach(card => { const e = validateCard(card); if (e.length) idealBad.push(`${c.n} ${card.slot}: ${e[0]}`); });
      SLOTS.forEach(sl => {
        const ic = idealCard(sl, t, '');
        if (ic.subs.some(s => s.stat === ic.main)) idealBad.push(`${c.n} ${sl}: ideal duplicates its main`);
        if (ic.level !== RARITY[5].maxLevel || ic.rarity !== 5) idealBad.push(`${c.n} ${sl}: ideal not a max-level 5★`);
        mainList(t, sl).forEach(m => { if (cardScore(idealCardFor(sl, t, '', m), t) > cardScore(ic, t) + 1e-9) idealBad.push(`${c.n} ${sl}: ${m} beats the ideal's ${ic.main}`); });
        if (cardPct(cardScore(ic, t), sl, t) !== 100 || !near(cardHeadroom(cardScore(ic, t), sl, t), 0)) idealBad.push(`${c.n} ${sl}: ideal is not 100 / 0 headroom`);
      });
    });
    fail('every ideal card is a legal max-level 5★ that takes the best-scoring allowed main and reads 100%', idealBad.length === 0, idealBad.slice(0, 4).join(' | '));
    fail('idealSubs excludes the card\'s own main and fills the four best stats',
      !idealSubs(tj, 'Crit Rate').includes('Crit Rate') && idealSubs(tj, 'Crit Rate').length === IDEAL_ROLLS.length && idealSubs(tj).length === IDEAL_ROLLS.length);
    fail('a stat with a hard target goes into the ideal card whatever its weight',
      (() => { const kumi = charDef('Kumi Katayama'); return idealSubs(target(kumi)).includes('Speed'); })());
    fail('cardPct clamps to 0-100 and a wrong-main empty card reads low',
      cardPct(cardScore(bad, tj), 'Star', tj) < 30 && cardPct(1e9, 'Star', tj) === 100 && cardPct(-5, 'Star', tj) === 0);
    fail('potentialCardScore is a ceiling: above the score at level 0, equal at the cap, and grows the main',
      (() => { const c0 = mk('Star', 'Hindrance', 'Crit Rate', [['Crit Multiplier', 4.1], ['ATK%', 3.5], ['Speed', 2.2]], { level: 0 });
        const c25 = Object.assign({}, c0, { level: 25 });
        return potentialCardScore(c0, tj) > cardScore(c0, tj) && near(potentialCardScore(c25, tj), cardScore(c25, tj)) &&
          potentialCardScore(c0, tj) > cardScore(c0, tj) + remainingUpgrades(c0) * bestSubstats(c0, tj).w; })());
    fail('atMaxLevel lifts the level to the rarity cap and leaves the substats as rolled',
      (() => { const c0 = mk('Star', 'Hindrance', 'Crit Rate', [['Crit Multiplier', 4.1]], { level: 3, rarity: 4 }); const m = atMaxLevel(c0);
        return m.level === 20 && m.subs === c0.subs && c0.level === 3 && atMaxLevel(Object.assign({}, c0, { level: 20 })).level === 20; })());
    fail('upgradesUsed follows the rarity\'s cadence (5★: one per five levels)',
      upgradesUsed(5, 0) === 0 && upgradesUsed(5, 4) === 0 && upgradesUsed(5, 5) === 1 && upgradesUsed(5, 25) === 5 && upgradesUsed(4, 20) === 4 && upgradesUsed(2, 10) === 2);

    /* ================================================================================
       5. Pricing a loadout — sets, synergy, the build score
       ================================================================================ */
    const hind = 'Hindrance';
    fail('bonus2Value is zero off-element, for an unknown set, and for a stat weighted zero',
      bonus2Value('Strife', joker, tj) === 0 && bonus2Value('Nope', joker, tj) === 0 && bonus2Value(hind, joker, tj) > 0 &&
      bonus2Value('Love', joker, tj) === 0);
    fail('a 2-piece is worth its amount in max rolls times the stat\'s weight',
      near(bonus2Value(hind, joker, tj), tj.w[SETS[hind].bonus2.stat] * SETS[hind].bonus2.amt / maxRoll(SETS[hind].bonus2.stat, 'Sun')));
    fail('bonus4Value pays base for the preferred set, ×0.72 for the alternative, ×0.22 otherwise, 0 off-element',
      bonus4Value(tj.sets[0], joker, tj, 55) === 55 && near(bonus4Value(tj.sets[1], joker, tj, 55), 55 * 0.72) &&
      near(bonus4Value('Power', joker, tj, 55), 55 * 0.22) && bonus4Value('Strife', joker, tj, 55) === 0 && bonus4Value(tj.sets[0], joker, tj) === 55);
    const four = heavens.map(sl => mk(sl, hind, sl === 'Sun' ? 'HP' : mainTop(tj, sl), []));
    fail('loadoutSetBonus: four of a set pays the 4-piece plus its 2-piece and names the active set',
      (() => { const bon = loadoutSetBonus(four, joker, tj, 55); return bon.active4 === hind && near(bon.value, bonus4Value(hind, joker, tj, 55) + bonus2Value(hind, joker, tj)); })());
    fail('loadoutSetBonus: two pairs pay two 2-pieces and no 4-piece', (() => {
      const cards = [mk('Sun', hind, 'HP', []), mk('Moon', hind, 'ATK%', []), mk('Star', 'Power', 'Crit Rate', []), mk('Sky', 'Power', 'ATK%', [])];
      const bon = loadoutSetBonus(cards, joker, tj, 55);
      return bon.active4 === null && near(bon.value, bonus2Value(hind, joker, tj) + bonus2Value('Power', joker, tj));
    })());
    fail('an off-element 4-piece grants nothing at all', loadoutSetBonus(heavens.map(sl => mk(sl, 'Strife', sl === 'Sun' ? 'HP' : mainTop(tj, sl), [])), joker, tj, 55).value === 0);
    fail('scoreLoadout counts only the best card per slot', (() => {
      const s1 = mk('Star', hind, 'Crit Rate', [['Crit Multiplier', 10]]), s2 = mk('Star', hind, 'Crit Rate', [['Crit Multiplier', 2]]);
      return near(scoreLoadout([s1, s2], joker, tj, 55).cards, cardScore(s1, tj)) && scoreLoadout([s1, s2], joker, tj, 55).filled === 1;
    })());
    fail('a Space card pairing with the active 4-piece is worth SPACE_PAIR_VALUE, a non-pairing one nothing', (() => {
      const pairing = Object.keys(SPACE_SETS).find(s => SPACE_SETS[s].pairs.includes(hind));
      const other = Object.keys(SPACE_SETS).find(s => !SPACE_SETS[s].pairs.includes(hind));
      const a = scoreLoadout(four.concat([mk('Space', pairing, 'ATK + DEF', [])]), joker, tj, 55);
      const bb = scoreLoadout(four.concat([mk('Space', other, 'ATK + DEF', [])]), joker, tj, 55);
      return a.synergy === SPACE_PAIR_VALUE && a.pairs && bb.synergy === 0 && !bb.pairs;
    })());

    // ---- build score ----
    const notHundred = [];
    CHARACTERS.forEach(c => {
      const t = target(c), lc = charLoadout(c.n), idl = idealLoadout(c, t, 55);
      const bs = buildScore(c, idl.cards, 55, lc, idl, t);
      if (!bs || bs.score !== 100 || !near(bs.raw, 100, 1e-6)) notHundred.push(`${c.n}=${bs && bs.score}`);
    });
    fail('a perfect loadout scores exactly 100 for every character', notHundred.length === 0, notHundred.slice(0, 6).join(', '));
    fail('buildScore is null with nothing equipped, and reads 1-100 with something', buildScore(joker, [], 55) === null && (() => {
      const bs = buildScore(joker, [mk('Sun', hind, 'HP', [['DEF', 27]])], 55); return bs && bs.score >= 1 && bs.score <= 100 && bs.raw >= 0 && bs.raw <= 100 && bs.filled === 1; })());
    fail('buildScore breaks down into the documented parts', (() => {
      const bs = buildScore(joker, four, 55); const labels = bs.parts.map(x => x.label);
      return labels.includes('Card stats') && labels.includes('Set bonuses') && labels.includes('Space synergy') && labels.includes('Damage spread') &&
        bs.parts.every(x => x.got <= x.max + 1e-9);
    })());
    fail('p4value scales both halves of the build score: the perfect loadout is 100 whatever the 4-piece is worth',
      (() => { const idl = idealLoadout(joker, tj, 120); return buildScore(joker, idl.cards, 120, lj, idl, tj).score === 100 && buildScore(joker, idl.cards, 120, lj, idl, tj).raw > 100 - 1e-6; })());
    fail('`raw` is the unrounded ratio and `score` is round(raw) floored at 1', (() => {
      const bs = buildScore(joker, [mk('Sun', 'Power', 'HP', [['HP', 84]])], 55);
      return bs.raw !== bs.score && bs.score === Math.max(1, Math.min(100, Math.round(bs.raw))) && bs.raw > 0 && bs.raw < 10;
    })());

    /* ================================================================================
       6. The damage model — ⓐⓑⓓ, spread, share, gates
       ================================================================================ */
    const dbBad = [];
    CHARACTERS.forEach(c => {
      const lc = charLoadout(c.n), B = damageBase(c, lc);
      [['Crit Rate', B.cr], ['Crit Multiplier', B.cm], ['Damage Multiplier', B.dm]].forEach(([s, v]) => {
        const x = charBaseStat(c, s, lc); if (!near(x.flat + x.pct, v)) dbBad.push(`${c.n} ${s}: ${x.flat}+${x.pct} vs ${v}`);
      });
    });
    fail('damageBase reads flat + pct for Crit Rate, Crit Multiplier and Damage Multiplier (weapon ladders count)', dbBad.length === 0, dbBad.slice(0, 3).join(' | '));
    fail('Morgana with Golden Legacy: Awakening-7 crit replaces the base (22.4) and the weapon adds its 18 on top',
      near(charBaseStat(morg, 'Crit Rate').flat, 22.4) && near(charBaseStat(morg, 'Crit Rate').pct, 18) && near(damageBase(morg).cr, 40.4));
    const crCard = mk('Sun', 'Power', 'HP', [['Crit Rate', 10]]), cmCard = mk('Sun', 'Power', 'HP', [['Crit Multiplier', 20]]);
    const critDown = [];
    CHARACTERS.forEach(c => {
      const t = target(c), lc = charLoadout(c.n), d0 = damageFactors([], c, t, lc).value;
      if (damageFactors([crCard], c, t, lc).value < d0 - 1e-9) critDown.push(c.n + ' CR');
      if (damageFactors([cmCard], c, t, lc).value < d0 - 1e-9) critDown.push(c.n + ' CM');
    });
    fail('adding Crit Rate or Crit Multiplier never lowers modelled damage for anyone (ⓓ floored at 1)', critDown.length === 0, critDown.slice(0, 5).join(', '));
    fail('a 0%-crit-base support gains nothing from crit stats rather than losing (Miku)',
      (() => { const d0 = damageFactors([], navi, tn, charLoadout(navi.n)).value; return near(damageFactors([crCard], navi, tn, charLoadout(navi.n)).value, d0); })());
    fail('a DEF-scaling kit\'s damage moves with DEF% and not with ATK% (Yusuke)', (() => {
      const y0 = damageFactors([], yu, yt, ylo).value;
      return damageFactors([mk('Sun', 'Opulence', 'HP', [['DEF%', 15]])], yu, yt, ylo).value > y0 * 1.05 && near(damageFactors([mk('Sun', 'Opulence', 'HP', [['ATK%', 15]])], yu, yt, ylo).value, y0);
    })());
    fail('an HP-scaling kit books HP% as a damage stat (Junpei), a DEF-scaling one DEF% (Yusuke)',
      modelledStats(charDef('Junpei Iori')).includes('HP%') && !modelledStats(charDef('Junpei Iori')).includes('ATK%') && modelledStats(yu).includes('DEF%') && modelledStats(joker).includes('ATK%'));
    /* Locked crit: Skull's every hit crits, so Crit Rate moves nothing and Crit Multiplier is ⓓ. */
    const ls = charLoadout(skull.n);
    fail('a fully locked-crit kit ignores Crit Rate and scales with Crit Multiplier (Skull)',
      near(damageFactors([crCard], skull, ts, ls).value, damageFactors([], skull, ts, ls).value) && damageFactors([cmCard], skull, ts, ls).value > damageFactors([], skull, ts, ls).value * 1.05);
    fail('lockedCritSupply adds nothing for a fully locked or unlocked kit and locked/(1-locked) otherwise',
      lockedCritSupply({ locked: 1 }, 150) === 0 && lockedCritSupply(null, 150) === 0 && near(lockedCritSupply({ locked: 0.3 }, 150), 100 * 0.3 / 0.7) &&
      lockedCritSupply({ locked: 0.3, cmClamp: [250, 350] }, 150) === 0 && near(lockedCritSupply({ locked: 0.3, cmClamp: [250, 350] }, 300), 100 * 0.3 / 0.7));
    /* Kumi's Highlight cannot crit until Awareness 6, so a Crit Rate roll buys less before it. */
    const kumi = charDef('Kumi Katayama'), tk = target(kumi);
    fail('a no-crit share makes Crit Rate worth less until the Awareness node lifts it (Kumi)', (() => {
      const g = aw => damageFactors([crCard], kumi, tk, lo(aw)).value / damageFactors([], kumi, tk, lo(aw)).value;
      return g(0) < g(6) && nocritShare(CRIT_PROFILE[kumi.n], lo(0)) === 0.45 && nocritShare(CRIT_PROFILE[kumi.n], lo(6)) === 0;
    })());
    /* Stat conversions feed the damage model from the in-battle source total. */
    const runa = charDef('Runa Dogenzaka'), tr = target(runa), lr = charLoadout(runa.n);
    const aaCard = mk('Sun', 'Defeat', 'HP', [['Ailment Accuracy', 20]]);
    const r0 = damageFactors([], runa, tr, lr), r1 = damageFactors([aaCard], runa, tr, lr);
    fail('an accuracy roll raises Runa\'s ATK factor through her conversion',
      near(r1.atk / r0.atk, 1 + 0.6 * 20 / (100 + damageBase(runa, lr).atkPct + conversionBonus(runa, [], lr)['ATK%']), 1e-9), `${r0.atk.toFixed(0)} -> ${r1.atk.toFixed(0)}`);
    fail('a conversion source stat counts as modelled for its owner and nobody else',
      modelledStats(runa).includes('Ailment Accuracy') && !modelledStats(ann).includes('Ailment Accuracy'));
    fail('a conversion cap holds (Yaoling\'s ATK% from Speed stops at 90)',
      conversionBonus(charDef('Yaoling Li'), [mk('Sky', 'Power', 'Speed', [['Speed', 200]])], charLoadout('Yaoling Li'))['ATK%'] === 90);
    fail('conversionBonus is all zeros for a character without conversions', Object.values(conversionBonus(joker, [], lj)).every(v => v === 0));

    // ---- damageShare and the spread term ----
    fail('damageShare is high for a DPS, near zero for a shield Guardian, and in between for an HP-scaling tank',
      damageShare(tj, joker) > 0.6 && damageShare(target(charDef('Yukimi Fujikawa')), charDef('Yukimi Fujikawa')) < 0.1 &&
      (() => { const s = damageShare(target(charDef('Junpei Iori')), charDef('Junpei Iori')); return s > 0.3 && s < 0.75; })(),
      `joker ${damageShare(tj, joker).toFixed(2)} fujikawa ${damageShare(target(charDef('Yukimi Fujikawa')), charDef('Yukimi Fujikawa')).toFixed(2)}`);
    fail('Resistance Pierce is a damage stat by name but never counted as modelled', !MODELLED_STATS.includes('Resistance Pierce') && CHARACTERS.every(c => !modelledStats(c).includes('Resistance Pierce')));
    fail('spreadApplies is false for every Elucidator and true for everyone else', CHARACTERS.every(c => spreadApplies(c) === (c.arch !== 'Navigator')));
    fail('an Elucidator\'s build score carries no Damage spread part', CHARACTERS.filter(c => c.arch === 'Navigator').every(c => {
      const t = target(c), idl = idealLoadout(c, t, 55); const bs = buildScore(c, idl.cards, 55, charLoadout(c.n), idl, t);
      return spreadRow(idl.cards, idl.cards, c, t, charLoadout(c.n)).max === 0 && !bs.parts.some(x => x.label === 'Damage spread');
    }));
    fail('a DPS\'s spread term is worth SPREAD_VALUE × damageShare and saturates on the ideal',
      (() => { const idl = idealLoadout(joker, tj, 55); const sr = spreadRow(idl.cards, idl.cards, joker, tj, lj);
        return near(sr.max, SPREAD_VALUE * damageShare(tj, joker)) && near(sr.ratio, 1) && near(sr.got, sr.max); })());
    /* The spread term is what sees stat balance: on a board already saturated with Crit
       Rate, a Crit Multiplier Star earns more spread credit than a Crit Rate Star even though
       the Crit Rate Star's context-free cardScore is higher. It is a bounded correction, not
       an override — the card term can still carry the total — so the term itself is pinned. */
    fail('a card filling a starved damage factor earns more spread credit than one piling onto a saturated one, despite a lower cardScore', (() => {
      const set = tj.sets[0], ij = idealLoadout(joker, tj, 55);
      const board = [
        mk('Sun', set, 'HP', [['Crit Rate', 20], ['ATK%', 5], ['Damage Multiplier', 5], ['DEF', 92]]),
        mk('Moon', set, 'Damage Multiplier', [['Crit Rate', 20], ['ATK%', 5], ['HP', 280], ['DEF', 92]]),
        mk('Sky', set, 'ATK%', [['Crit Rate', 20], ['Damage Multiplier', 5], ['HP', 280], ['DEF', 92]])
      ];
      const A = mk('Star', set, 'Crit Rate', [['ATK', 92], ['HP', 280], ['DEF', 92], ['Speed', 2]]);
      const B = mk('Star', set, 'Crit Multiplier', [['ATK', 92], ['HP', 280], ['DEF', 92], ['Speed', 2]]);
      const sA = buildScore(joker, board.concat([A]), 55, lj, ij, tj).spread.got, sB = buildScore(joker, board.concat([B]), 55, lj, ij, tj).spread.got;
      return cardScore(A, tj) > cardScore(B, tj) && sB > sA;
    })());
    fail('damageFactors exposes ⓐ, ⓑ, ⓓ and their product', (() => { const d = damageFactors(four, joker, tj, lj); return d.atk > 0 && d.dmg >= 1 && d.crit >= 1 && near(d.value, d.atk * d.dmg * d.crit, 1e-6); })());

    /* ================================================================================
       7. Stat targets — totals, tiers, the breakpoint term
       ================================================================================ */
    const bpBad = [];
    CHARACTERS.forEach(c => {
      const t = target(c), lc = charLoadout(c.n), idl = idealLoadout(c, t, 55);
      breakpointRows(idl.cards, idl.cards, c, t, lc).forEach(row => {
        if (!near(row.ratio, 1)) bpBad.push(`${c.n} ${row.stat} ideal ratio ${row.ratio.toFixed(3)}`);
        if (row.effBar > row.bar + 1e-9) bpBad.push(`${c.n} ${row.stat} effBar above bar`);
      });
      breakpointRows([], idl.cards, c, t, lc).forEach(row => { if (!(row.ratio >= 0 && row.ratio <= 1)) bpBad.push(`${c.n} ${row.stat} empty ratio ${row.ratio}`); });
    });
    fail('every stat target is satisfied by the ideal loadout (bar capped at what a perfect build reaches)', bpBad.length === 0, bpBad.slice(0, 4).join(' | '));
    fail('a character with no targets has no breakpoint rows', breakpointRows([], idealLoadout(joker, tj).cards, joker, tj, lj).length === 0 && (tj.targets || []).length === 0);
    fail('the breakpoint block is worth BREAKPOINT_VALUE however many targets it holds', (() => {
      const two = CHARACTERS.find(c => c.ov && c.ov.targets && c.ov.targets.length >= 2);
      const t = target(two), idl = idealLoadout(two, t, 55); const bs = buildScore(two, idl.cards, 55, charLoadout(two.n), idl, t);
      const part = bs.parts.find(x => x.label === 'Stat targets'); return part && part.max === BREAKPOINT_VALUE;
    })());
    // tiers
    const aran = charDef('Aran Hirano'), tiersA = aran.ov.targets[0].tiers, tiersK = kumi.ov.targets[0].tiers;
    fail('pickTier: Awareness selects the family, Mindscape the +5, a single-family character always lands there (Aran)',
      pickTier(tiersA, lo(0), 3).key === 'LV10' && pickTier(tiersA, lo(3), 3).key === 'LV12' && pickTier(tiersA, Object.assign(lo(3), { mindSkill: true }), 3).key === 'LV12+5' &&
      pickTier(tiersA, lo(6), 3).key === 'LV12');
    fail('pickTier: the switch is Awareness 5 for TARGET_TIER_AWARENESS_5 characters (Kumi), 3 otherwise',
      TARGET_TIER_AWARENESS_5.has(kumi.n) && pickTier(tiersK, lo(3), 5).key === 'LV10' && pickTier(tiersK, lo(5), 5).key === 'LV13' && pickTier(tiersK, lo(3), 3).key === 'LV13');
    fail('a target\'s in-battle bar moves with weapon, refinement and Mindscape (Kumi\'s 180 Speed)', (() => {
      const lo4 = Object.assign({}, DEFAULT_LOADOUT, { weapon: '4', refine: 1 });
      const lo5 = Object.assign({}, DEFAULT_LOADOUT, { weapon: '5', refine: 7, mindSkill: true, mind1: 5, mind2: 5 });
      const a = totalStat(kumi, 'Speed', 'Speed', [], lo4).total, bb = totalStat(kumi, 'Speed', 'Speed', [], lo5).total;
      return bb > a + 20 && 180.2 - bb < 25 && 180.2 - a > 40;
    })());
    fail('totalStat is null for a character with no stat block', totalStat({ n: 'Nobody' }, 'ATK', 'ATK%', [], DEFAULT_LOADOUT) === null);
    fail('a Space card\'s ATK + DEF main counts toward both ATK and DEF totals at its real magnitude', (() => {
      const sp = mk('Space', 'Hope', 'ATK + DEF', []);
      return near(cardStatContribution([sp], joker, 'ATK', 'ATK%').flat, MAIN_MAGNITUDE['ATK + DEF'][1]) && near(cardStatContribution([sp], joker, 'DEF', 'DEF%').flat, MAIN_MAGNITUDE['ATK + DEF'][1]);
    })());
    fail('an unscanned non-5★ main is unknown (mainsMissing), a scanned mainValue wins, a 5★ falls on the measured curve', (() => {
      const four4 = mk('Space', 'Hope', 'ATK + DEF', [], { rarity: 4, level: 20 });
      const scanned = Object.assign({}, four4, { mainValue: 300 });
      const five = mk('Moon', 'Power', 'ATK%', [], { level: 14 });
      return cardStatContribution([four4], joker, 'ATK', 'ATK%').mainsMissing === 1 && near(cardStatContribution([scanned], joker, 'ATK', 'ATK%').flat, 300) &&
        near(mainMagnitudeFor(five), 4.6 + 14 * (31.4 - 4.6) / 25) && mainMagnitudeFor(four4) === null;
    })());
    fail('a target whose mains are unknown falls back to the relative measure rather than an undercount', (() => {
      const bad4 = mk('Sky', 'Power', 'Speed', [['Speed', 4]], { rarity: 4, level: 20 });
      const row = breakpointRows([bad4], idealLoadout(kumi, tk).cards, kumi, tk, charLoadout(kumi.n))[0];
      return row.mainsMissing === 1 && row.exact === false && near(row.ratio, row.relative);
    })());
    fail('totalStat scales ATK/HP/DEF by the percent bonus and adds flat after', (() => {
      const base = charBaseStat(joker, 'ATK', lj); const tot = totalStat(joker, 'ATK', 'ATK%', [mk('Sun', 'Power', 'HP', [['ATK%', 10], ['ATK', 100]])], lj);
      return near(tot.total, base.flat * (1 + (base.pct + 10) / 100) + 100);
    })());
    // the character's own side of the total
    fail('the Awareness curve adds 15% HP/ATK/DEF at level 6 and nothing to Speed (Morgana, no kit lines)',
      !KIT_STAT_BUFFS['Morgana'] && ['ATK', 'HP', 'DEF'].every(s => near(charBaseStat(morg, s, lo(6)).pct - charBaseStat(morg, s, lo(0)).pct, 15)) &&
      near(charBaseStat(morg, 'Speed', lo(6)).flat, charBaseStat(morg, 'Speed', lo(0)).flat));
    fail('a kit line gated on a weapon counts only while that weapon is held (Seiji\'s Venus Sunrise +12% crit damage)', (() => {
      const seiji = charDef('Seiji Shiratori');
      const w5 = charBaseStat(seiji, 'Crit Multiplier', Object.assign({}, DEFAULT_LOADOUT, { weapon: '5' })), w4 = charBaseStat(seiji, 'Crit Multiplier', Object.assign({}, DEFAULT_LOADOUT, { weapon: '4' }));
      return near(w5.pct - w4.pct, 12) && kitStatBuffs(seiji, Object.assign({}, DEFAULT_LOADOUT, { weapon: '4' })).every(x => x.weapon !== '5');
    })());
    fail('a kit line gated on Awareness counts only at or above it (Joker\'s Meditate at Awareness 2)', (() => {
      const has = aw => kitStatBuffs(joker, lo(aw)).some(x => /Meditate/.test(x.why));
      return !has(1) && has(2) && near(charBaseStat(joker, 'ATK', lo(2)).pct - charBaseStat(joker, 'ATK', lo(1)).pct, 50 + AWARENESS_STAT_PCT[2] - AWARENESS_STAT_PCT[1]);
    })());
    fail('per-stack kit lines multiply by the stacks held (Seiji\'s Right to Strike at 3)',
      kitStatBuffs(charDef('Seiji Shiratori'), lo(0)).some(x => x.s === 'ATK%' && x.stacks === 3 && x.v === 21));
    fail('kitTierIndex follows the target-tier rule (YUI: LV10 / LV12 / +5)',
      kitTierIndex(yui, lo(0)) === 0 && kitTierIndex(yui, lo(3)) === 2 && kitTierIndex(yui, Object.assign(lo(3), { mindSkill: true })) === 3 &&
      kitStatBuffs(yui, lo(0)).find(x => x.tiers).v === 39 && kitStatBuffs(yui, lo(3)).find(x => x.tiers).v === 41.4);
    fail('a weapon ladder is read at the refinement step held', (() => {
      const r1 = charBaseStat(morg, 'Crit Rate', Object.assign({}, DEFAULT_LOADOUT, { refine: 1 })).pct, r7 = charBaseStat(morg, 'Crit Rate', Object.assign({}, DEFAULT_LOADOUT, { refine: 7 })).pct;
      return near(r1, 18) && near(r7, 34.2);
    })());
    fail('Mindscape stat paths scale linearly to lufel\'s maxed value', (() => {
      const m = CHAR_STATS[morg.n].mind[1]; // ATK% 20 at level 5
      const at = l => charBaseStat(morg, 'ATK', Object.assign({}, DEFAULT_LOADOUT, { mind2: l })).pct;
      return m.s === 'ATK%' && near(at(5) - at(0), m.v) && near(at(2) - at(0), m.v * 2 / 5);
    })());

    /* ================================================================================
       8. Triage, Vault, Upgrades, Headroom on the synthetic inventory
       ================================================================================ */
    const own = ['Ren Amamiya', 'Ryuji Sakamoto', 'Morgana', 'Kira Kitazato', 'Yusuke Kitagawa', 'Makoto Yuki', 'Hatsune Miku'];
    own.forEach(n => { state.chars[n].owned = true; state.chars[n].benched = false; });
    /* Dress the owned characters from a deliberately narrow slice of the pool, so better
       cards of the same set are still available for Upgrades and Headroom to find. */
    own.forEach((n, k) => {
      const ch = charDef(n);
      const pool = state.cards.filter((c, i) => !c.equipped && c.rarity >= 4 && i < 260);
      const res = bestPlan(ch, pool, { policy: 'pref' });
      if (!res.best) return;
      heavens.forEach(sl => { const pk = res.best.picks[sl]; if (pk) pk.c.equipped = n; });
      if (res.space && k % 2 === 0) res.space.c.equipped = n;
    });
    fail('every owned character got dressed for the tab checks', own.every(n => state.cards.some(c => c.equipped === n)));
    fail('ownedChars honours the benched flag', (() => { state.chars['Morgana'].benched = true; const ok = !ownedChars().some(c => c.n === 'Morgana'); state.chars['Morgana'].benched = false; return ok && ownedChars().length === own.length; })());

    // ---- Triage ----
    $('#trScope').value = 'owned'; $('#trRar').value = '2';
    runTriage();
    const rated = trCache.rated;
    fail('Triage rates exactly the unequipped cards at or above the rarity floor', rated.length === state.cards.filter(c => c.rarity >= 2 && !c.equipped).length);
    fail('Triage: every slot has a 100% card (graded within the slot, never across)', (() => {
      const slots = new Set(rated.map(x => x.card.slot));
      return [...slots].every(sl => rated.some(x => x.card.slot === sl && x.pct === 1)) && rated.every(x => x.pct <= 1 && isFinite(x.best));
    })(), JSON.stringify(Object.fromEntries([...new Set(rated.map(x => x.card.slot))].map(sl => [sl, Math.max(...rated.filter(x => x.card.slot === sl).map(x => x.best))]))));
    /* A marginal can dip below zero: a 4★ card with no scanned main magnitude flips a stat
       target from its exact in-battle ratio to the relative fallback (unknown, never zero —
       see breakpointRows), and that fallback can sit below the exact figure it replaced. */
    fail('Triage: negative marginals are rare and small (the unknown-main fallback, not a scoring fault)',
      rated.filter(x => x.best < 0).length < rated.length * 0.05 && rated.every(x => x.best > -20), `${rated.filter(x => x.best < 0).length} negative, min ${Math.min(...rated.map(x => x.best))}`);
    fail('Triage: a named best fit always runs the card\'s set and is never off an element-locked set\'s element',
      rated.filter(x => x.who).every(x => {
        const t = target(charDef(x.who)), def = SETS[x.card.set];
        const runs = x.card.slot === 'Space' ? t.space === x.card.set : (t.sets || []).includes(x.card.set);
        return runs && (!def || !def.elem || def.elem === charDef(x.who).e);
      }));
    fail('Triage: a card nobody in scope runs reads "no one in scope" and is flagged when the element is on the roster',
      rated.filter(x => !x.who).every(x => x.noSetMatch === (!(SETS[x.card.set] && SETS[x.card.set].elem) || ownedChars().some(c => c.e === SETS[x.card.set].elem))) &&
      rated.filter(x => !x.who && x.noSetMatch).every(x => x.best === 0));
    fail('Triage: an element-locked set with nobody of that element owned still scores against the whole roster', (() => {
      const locked = rated.filter(x => !x.who && !x.noSetMatch);
      return locked.length === 0 || locked.some(x => x.best > 0);
    })());
    fail('Triage renders a verdict per row', $('#trTable').querySelectorAll('tbody tr').length > 0 && $('#trTable').innerHTML.indexOf('NaN') < 0);
    fail('Triage marks the main at its level cap: a level-0 card of a wanted main can grade as a keeper', (() => {
      const set = tj.sets[0];
      const c0 = mk('Star', set, mainTop(tj, 'Star'), [['Crit Multiplier', 4.1], ['ATK%', 3.5], ['Damage Multiplier', 2.8]], { level: 0, id: 'lv0probe', equipped: null });
      state.cards.push(c0); runTriage();
      const row = trCache.rated.find(x => x.card.id === 'lv0probe');
      state.cards.pop(); runTriage();
      return row && row.pct > 0.5 && row.who === 'Ren Amamiya';
    })());

    // ---- Vault ----
    $('#vaRar').value = '2';
    runVault();
    const va = vaCache.rated;
    fail('Vault: every slot present has a 100% card on both yardsticks', (() => {
      const slots = new Set(va.map(x => x.card.slot));
      return [...slots].every(sl => va.some(x => x.card.slot === sl && x.genPct === 1) && va.some(x => x.card.slot === sl && x.rolePct === 1));
    })());
    fail('Vault: verdicts follow the percentile thresholds', va.every(x => x.verdict === (x.rank >= VAULT_LOCK ? 'lock' : x.rank >= VAULT_WATCH ? 'watch' : '') && near(x.rank, Math.max(x.genPct, x.rolePct))));
    fail('Vault: a lock list is a small share of the inventory (top 2% per slot per role)', va.filter(x => x.verdict === 'lock').length < va.length * 0.2 && va.some(x => x.verdict === 'lock'));
    fail('Vault verdicts do not depend on who is owned', (() => {
      const before = va.map(x => x.card.id + ':' + x.verdict + ':' + x.role).join(',');
      const saved = own.map(n => state.chars[n].owned); own.forEach(n => state.chars[n].owned = false);
      runVault(); const after = vaCache.rated.map(x => x.card.id + ':' + x.verdict + ':' + x.role).join(',');
      own.forEach((n, i) => state.chars[n].owned = saved[i]); runVault();
      return before === after;
    })());
    fail('VAULT_TARGET weights support stats at zero and archTarget mirrors each archetype',
      ['Speed', 'SP Recovery', 'Ailment Accuracy', 'HP%', 'DEF%'].every(s => VAULT_TARGET.w[s] === 0) && Object.keys(ARCHETYPES).every(a => archTarget(a).w === ARCHETYPES[a].w && archTarget(a) === archTarget(a)));

    // ---- Upgrades ----
    const upBad = [];
    let anyRows = false;
    own.forEach(n => {
      const ch = charDef(n), t = target(ch);
      [[false, false], [true, false], [false, true], [true, true]].forEach(([same, ign]) => {
        const rows = upgradesFor(ch, 4, same, ign);
        if (rows.length) anyRows = true;
        const worn = heavens.map(sl => state.cards.find(c => c.equipped === n && c.slot === sl));
        const active = loadoutSetBonus(worn.filter(Boolean), ch, t, 55).active4;
        rows.forEach(row => {
          if (row.rec.slot !== row.slot) upBad.push(`${n}: ${row.slot} row proposes a ${row.rec.slot}`);
          if (!isFinite(row.delta) || (row.group != null && !isFinite(row.group))) upBad.push(`${n}: non-finite gain`);
          if (row.slot !== 'Space' && !(t.sets || []).includes(row.rec.set)) upBad.push(`${n}: proposes ${row.rec.set}, not one of ${J(t.sets)}`);
          if (row.slot !== 'Space' && same && active && row.rec.set !== active) upBad.push(`${n}: same-set switch into ${row.rec.set}`);
          if (ign && row.rec.equipped && row.rec.equipped !== n) upBad.push(`${n}: ignoreEquipped proposed a card on ${row.rec.equipped}`);
          if (row.rec.locked && row.rec.equipped !== n) upBad.push(`${n}: proposed a locked card`);
        });
        const grouped = rows.filter(x => x.group != null);
        if (grouped.length && (new Set(grouped.map(x => x.group)).size !== 1 || grouped.length < 2)) upBad.push(`${n}: grouped rows disagree on the group total`);
        if (grouped.length && !(grouped[0].group > UPGRADE_MIN_DELTA)) upBad.push(`${n}: group below the gate`);
        for (let i = 1; i < rows.length; i++) if (upGain(rows[i]) > upGain(rows[i - 1]) + 1e-9) upBad.push(`${n}: rows not sorted by upGain`);
      });
    });
    fail('Upgrades proposes only whole preferred-set 4-pieces, honours the same-set and ignore-equipped flags, and groups rows consistently', upBad.length === 0, upBad.slice(0, 4).join(' | '));
    fail('Upgrades found at least one better card on the narrowly-dressed roster', anyRows);
    fail('upGain reads the group total when there is one, else the row\'s own delta', upGain({ delta: 3, group: 28 }) === 28 && upGain({ delta: -2 }) === -2 && gainStr(-2.5) === '−2.5' && gainStr(3) === '+3.0');

    // ---- Headroom ----
    const hr = headroomRows(false);
    fail('Headroom: one row per owned character and slot', hr.length === ownedChars().length * SLOTS.length);
    fail('Headroom: gain is a non-negative build-score delta, headroom the raw distance to the ideal, empty slots the whole ideal',
      hr.every(row => row.gain >= 0 && isFinite(row.gain) && row.room >= 0 && (row.card || near(row.room, idealCardScore(row.slot, row.t)))));
    fail('Headroom: the available card is always the same slot and set, and only ever reported as a positive build gain',
      hr.every(row => !row.alt || (row.alt.slot === row.slot && row.alt.set === row.card.set && row.altGain > 0 && row.alt.id !== row.card.id && (!row.alt.equipped || row.alt.equipped === row.ch.n))));
    fail('Headroom: with takeEquipped the pool may name a card worn by someone else, never a locked one',
      headroomRows(true).every(row => !row.alt || !(row.alt.locked && row.alt.equipped !== row.ch.n)));
    fail('Headroom: shares of a character\'s room sum to one', own.every(n => { const rows = hr.filter(x => x.ch.n === n); const s = rows.reduce((a, x) => a + x.share, 0); return near(s, 1, 1e-9) || rows.every(x => x.share === 0); }));

    // ---- equip plumbing ----
    $('#optChar').value = 'Ren Amamiya';
    fail('swapCard moves a card onto the slot, unequips whoever wore either end, and clears a lock on the way out', (() => {
      const jStar = state.cards.find(c => c.equipped === 'Ren Amamiya' && c.slot === 'Star');
      const mStar = state.cards.find(c => c.equipped === 'Morgana' && c.slot === 'Star');
      if (!jStar || !mStar) return false;
      jStar.locked = true;
      swapCard('Ren Amamiya', 'Star', mStar.id);
      const ok = mStar.equipped === 'Ren Amamiya' && jStar.equipped === null && jStar.locked === false && !state.cards.some(c => c.equipped === 'Morgana' && c.slot === 'Star');
      swapCard('Morgana', 'Star', mStar.id); swapCard('Ren Amamiya', 'Star', jStar.id);
      return ok && jStar.equipped === 'Ren Amamiya' && mStar.equipped === 'Morgana';
    })());
    fail('toggleLoadoutLock locks every worn card and a locked card leaves every other character\'s pool', (() => {
      toggleLoadoutLock('Morgana');
      const worn = state.cards.filter(c => c.equipped === 'Morgana');
      const ok = worn.length > 0 && worn.every(c => c.locked) && !poolFor('all', 2, 'Ren Amamiya').some(c => c.equipped === 'Morgana') && poolFor('all', 2, 'Morgana').some(c => c.equipped === 'Morgana');
      toggleLoadoutLock('Morgana');
      return ok && worn.every(c => !c.locked);
    })());
    fail('unequipCard clears the wearer and the lock', (() => {
      const c = state.cards.find(x => x.equipped === 'Ryuji Sakamoto' && x.slot === 'Sun'); if (!c) return false;
      c.locked = true; unequipCard(c.id); const ok = c.equipped === null && !c.locked; swapCard('Ryuji Sakamoto', 'Sun', c.id); return ok && c.equipped === 'Ryuji Sakamoto';
    })());
    fail('equippedByChar groups the board by wearer', (() => { const m = equippedByChar(); return own.every(n => m[n] && m[n].every(c => c.equipped === n)) && Object.values(m).reduce((s, a) => s + a.length, 0) === state.cards.filter(c => c.equipped).length; })());

    /* ================================================================================
       9. Import — normalisation, validation, merge
       ================================================================================ */
    fail('alias CDMG resolves', normStat('CDMG') === 'Crit Multiplier');
    fail('alias EHR resolves', normStat('ehr') === 'Ailment Accuracy');
    fail('in-game label "Pierce Rate" resolves', normStat('Pierce Rate') === 'Resistance Pierce');
    fail('in-game label "Ailment Acc." resolves', normStat('Ailment Acc.') === 'Ailment Accuracy');
    fail('in-game label "Crit Mult." resolves', normStat('Crit Mult.') === 'Crit Multiplier');
    fail('in-game label "Damage Mult.+" resolves', normStat('Damage Mult.+') === 'Damage Multiplier');
    fail('bare "Attack" with no percent hint stays flat ATK', normStat('Attack') === 'ATK');
    fail('bare "Attack" with a percent hint resolves to ATK%', normStat('Attack', true) === 'ATK%');
    fail('bare "Defense" with a percent hint resolves to DEF%', normStat('Defense', true) === 'DEF%');
    fail('bare "HP" with a percent hint resolves to HP%', normStat('HP', true) === 'HP%');
    fail('a stat with no flat/percent pair ignores the percent hint', normStat('Speed', true) === 'Speed');
    fail('a canonical stat name resolves to itself, garbage to nothing', normStat('Crit Rate') === 'Crit Rate' && !normStat('banana'));
    fail('alias Strength -> Power', normSet('strength') === 'Power');
    fail('Ruin is its own set, not aliased away', normSet('Ruin') === 'Ruin' && !!SETS['Ruin']);
    fail('Prudence is its own set', normSet('prudence') === 'Prudence' && !!SETS['Prudence']);
    fail('a Space set resolves through normSet too', normSet('departure') === 'Departure' && !normSet('nonsense'));
    fail('Makoto Yuki prefers Ruin', target(charDef('Makoto Yuki')).sets[0] === 'Ruin');
    fail('normalizeCard resolves aliases, keeps a scanned mainValue and drops a lock on an unequipped card', (() => {
      const c = normalizeCard({ slot: 'Star', set: 'interference', rarity: '5', level: '25', main: 'crit', subs: [{ stat: 'cdmg', value: '16.4' }, { stat: 'Attack', value: 14 }], mainValue: '18.8', locked: true, src: 'x.png' });
      return c.set === 'Hindrance' && c.main === 'Crit Rate' && c.subs[0].stat === 'Crit Multiplier' && c.subs[0].value === 16.4 && c.subs[1].stat === 'ATK' &&
        c.mainValue === 18.8 && c.level === 25 && c.rarity === 5 && c.equipped === null && !c.locked && c.src === 'x.png';
    })());
    fail('normalizeCard forces the fixed main on Sun and Space', normalizeCard({ slot: 'Sun', set: 'Power', rarity: 5, level: 0, main: 'whatever', subs: [] }).main === 'HP' &&
      normalizeCard({ slot: 'Space', set: 'Hope', rarity: 5, level: 0, main: '', subs: [] }).main === 'ATK + DEF');

    // ---- validateCard ----
    const vGood = mk('Star', 'Hindrance', 'Crit Rate', [['Crit Multiplier', 16.4], ['Resistance Pierce', 8.4], ['ATK%', 14], ['Speed', 6.6]]);
    fail('validateCard accepts a well-formed card', validateCard(vGood).length === 0, validateCard(vGood).join('; '));
    fail('validateCard rejects an unknown slot, set or rarity',
      validateCard(Object.assign({}, vGood, { slot: 'Planet' })).length > 0 && validateCard(Object.assign({}, vGood, { set: 'Nonsense' })).length > 0 && validateCard(Object.assign({}, vGood, { rarity: 9 })).length > 0);
    fail('validateCard rejects a Heavens set on a Space card and vice versa',
      validateCard(mk('Space', 'Hindrance', 'ATK + DEF', [['Crit Rate', 1.6], ['ATK%', 2.6], ['Speed', 1.6]])).length > 0 && validateCard(mk('Star', 'Departure', 'Crit Rate', [['Crit Multiplier', 2.5], ['ATK%', 2], ['Speed', 1.3]])).length > 0);
    fail('validateCard rejects an illegal main stat for the slot', validateCard(Object.assign({}, vGood, { main: 'SP Recovery' })).length > 0);
    fail('validateCard rejects a substat that duplicates the main stat', validateCard(Object.assign({}, vGood, { subs: vGood.subs.slice(0, 3).concat([{ stat: 'Crit Rate', value: 5 }]) })).length > 0);
    fail('validateCard rejects a substat listed twice', validateCard(Object.assign({}, vGood, { subs: vGood.subs.slice(0, 3).concat([{ stat: 'ATK%', value: 5 }]) })).length > 0);
    fail('validateCard rejects too many substats for the rarity', validateCard(Object.assign({}, vGood, { rarity: 2 })).length > 0);
    fail('validateCard rejects too few substats for the rarity', validateCard(Object.assign({}, vGood, { subs: vGood.subs.slice(0, 2) })).length > 0);
    fail('validateCard rejects a level past the rarity cap', validateCard(Object.assign({}, vGood, { level: 26 })).length > 0 && validateCard(Object.assign({}, vGood, { rarity: 4, level: 21 })).length > 0);
    fail('validateCard rejects a substat value far above its roll ceiling', validateCard(Object.assign({}, vGood, { subs: [{ stat: 'Crit Multiplier', value: 500 }].concat(vGood.subs.slice(1)) })).length > 0);
    fail('validateCard bounds a substat by the rolls its level allows (a Lv0 Speed 4 is impossible, at Lv25 it is fine)',
      validateCard(mk('Star', 'Hindrance', 'Crit Rate', [['Speed', 4], ['ATK%', 2], ['DEF', 27]], { level: 0 })).length > 0 &&
      validateCard(mk('Star', 'Hindrance', 'Crit Rate', [['Speed', 4], ['ATK%', 2], ['DEF', 27]], { level: 25 })).length === 0);
    fail('validateCard allows one display unit of OCR slack', validateCard(mk('Star', 'Hindrance', 'Crit Rate', [['Speed', 2.2], ['ATK%', 3.5], ['DEF', 46]], { level: 0 })).length === 0);

    // ---- mergeImport ----
    const cardA = { id: 'a1', slot: 'Star', set: 'Hindrance', rarity: 5, level: 15, main: 'Crit Rate', equipped: null,
      subs: [{ stat: 'Crit Multiplier', value: 10 }, { stat: 'ATK%', value: 8 }, { stat: 'Speed', value: 4 }] };
    const leveledUp = Object.assign({}, cardA, { level: 25,   // two upgrades: one CM roll, one minted fourth substat
      subs: [{ stat: 'Crit Multiplier', value: 13.5 }, { stat: 'ATK%', value: 8 }, { stat: 'Speed', value: 4 }, { stat: 'Resistance Pierce', value: 1.7 }] });
    const sum = x => J({ add: x.toAdd.length, upd: x.toUpdate.length, dup: x.duplicates.length, amb: x.ambiguous.length, unm: x.unmatched.length, twins: x.unmatchedTwins.length, near: x.unmatchedNear.length });
    const m1 = mergeImport([cardA], [leveledUp]);
    fail('mergeImport treats an affordable monotonic level-up as an update, not a duplicate or a new card', m1.toUpdate.length === 1 && m1.toAdd.length === 0 && m1.ambiguous.length === 0 && m1.toUpdate[0].existingId === 'a1', sum(m1));
    const cardB = Object.assign({}, cardA, { id: 'b1' });
    const exactDup = { slot: 'Star', set: 'Hindrance', rarity: 5, level: 15, main: 'Crit Rate', equipped: null, subs: cardB.subs.map(s => Object.assign({}, s)) };
    const m2 = mergeImport([cardB], [exactDup]);
    fail('mergeImport skips an exact resubmission as a duplicate', m2.duplicates.length === 1 && m2.toAdd.length === 0 && m2.toUpdate.length === 0 && m2.unmatched.length === 0, sum(m2));
    const cardC = Object.assign({}, cardA, { id: 'c1' });
    const shrunk = { slot: 'Star', set: 'Hindrance', rarity: 5, level: 20, main: 'Crit Rate', equipped: null, subs: [{ stat: 'Crit Multiplier', value: 2 }, { stat: 'ATK%', value: 1 }, { stat: 'Speed', value: 0.5 }] };
    const m3 = mergeImport([cardC], [shrunk]);
    fail('mergeImport flags a higher-level read whose values went DOWN as ambiguous instead of silently overwriting', m3.ambiguous.length === 1 && m3.toUpdate.length === 0 && m3.duplicates.length === 0, sum(m3));
    const brandNew = { slot: 'Sky', set: 'Departure', rarity: 5, level: 25, main: 'Speed', equipped: null, subs: [{ stat: 'ATK%', value: 10 }, { stat: 'DEF%', value: 5 }, { stat: 'HP', value: 80 }] };
    const m4 = mergeImport([cardA], [brandNew]);
    fail('mergeImport adds a card with no fingerprint match as new and reports the existing card as unmatched', m4.toAdd.length === 1 && m4.unmatched.length === 1, sum(m4));
    /* Growth has to be affordable: k whole rolls within k×min..k×max per stat, Σk ≤ upgrades
       gained, minting the fourth substat costing one. */
    const ex0 = { id: 'e1', slot: 'Star', set: 'Hindrance', rarity: 5, level: 0, main: 'Crit Rate', equipped: null, subs: [{ stat: 'Crit Multiplier', value: 2.5 }, { stat: 'ATK%', value: 2.0 }, { stat: 'Speed', value: 1.3 }] };
    const okUp = { slot: 'Star', set: 'Hindrance', rarity: 5, level: 25, main: 'Crit Rate', equipped: null, subs: [{ stat: 'Crit Multiplier', value: 14.8 }, { stat: 'ATK%', value: 5.5 }, { stat: 'Speed', value: 1.3 }, { stat: 'Resistance Pierce', value: 1.7 }] };
    const tooRich = { slot: 'Star', set: 'Hindrance', rarity: 5, level: 25, main: 'Crit Rate', equipped: null, subs: [{ stat: 'Crit Multiplier', value: 27.1 }, { stat: 'ATK%', value: 16 }, { stat: 'Speed', value: 8 }, { stat: 'Resistance Pierce', value: 8 }] };
    fail('a Lv0 -> Lv25 read that spends its five upgrades exactly (three rolls, one roll, a minted fourth) is a level-up', (() => { const x = mergeImport([ex0], [okUp]); return x.toUpdate.length === 1 && x.toAdd.length === 0; })());
    fail('a same-fingerprint read whose growth no upgrade budget can explain is a NEW card, never an update or a decision', (() => { const x = mergeImport([ex0], [tooRich]); return x.toAdd.length === 1 && x.toUpdate.length === 0 && x.ambiguous.length === 0 && x.unmatched.length === 1; })());
    fail('rollBudgetFits agrees: strict passes the affordable pair, both refuse the impossible one', rollBudgetFits(ex0, okUp, true) && !rollBudgetFits(ex0, tooRich, true) && !rollBudgetFits(ex0, tooRich, false));
    /* Same level means same card or a different card, never a decision — and a one-value
       difference is reported side by side, since a misread digit looks exactly like this. */
    const sameLvOff = { slot: 'Star', set: 'Hindrance', rarity: 5, level: 0, main: 'Crit Rate', equipped: null, subs: [{ stat: 'Crit Multiplier', value: 2.5 }, { stat: 'ATK%', value: 2.0 }, { stat: 'Speed', value: 4.0 }] };
    fail('a same-level read one value off is added as new, kept alongside the original, and reported as a near pair', (() => {
      const x = mergeImport([ex0], [sameLvOff]); return x.toAdd.length === 1 && x.ambiguous.length === 0 && x.unmatched.length === 0 && x.unmatchedNear.length === 1 && x.unmatchedNear[0].existing === ex0;
    })());
    fail('a lower-level read of a same-fingerprint card is new, never a level-down', (() => { const x = mergeImport([Object.assign({}, cardA, { id: 'd1' })], [Object.assign({}, ex0, { id: undefined })]); return x.toAdd.length === 1 && x.ambiguous.length === 0; })());
    /* Identical twins: two identical cards in the save, one read in the scan — the scanner
       reads adjacent identical panels as one, so the other is a twin, not a feed. */
    fail('an unmatched card whose exact twin the scan did read is listed as a twin, not offered for removal', (() => {
      const twin = Object.assign({}, ex0, { id: 'e2' }); const x = mergeImport([ex0, twin], [Object.assign({}, ex0, { id: undefined })]);
      return x.duplicates.length === 1 && x.unmatchedTwins.length === 1 && x.unmatched.length === 0;
    })());
    fail('the merge matches the closest pair across a pool, not in arrival order', (() => {
      const far = Object.assign({}, cardA, { id: 'f1', subs: [{ stat: 'Crit Multiplier', value: 3 }, { stat: 'ATK%', value: 3 }, { stat: 'Speed', value: 1.5 }] });
      const x = mergeImport([far, Object.assign({}, cardA, { id: 'f2' })], [leveledUp]);
      return x.toUpdate.length === 1 && x.toUpdate[0].existingId === 'f2';
    })());
    fail('cardFingerprint and exactKey behave as the scanner\'s KnownIndex expects', cardFingerprint(cardA) === 'Star|Hindrance|5|Crit Rate' && exactKey(cardA) === exactKey(Object.assign({}, cardA, { id: 'zz' })) && exactKey(cardA) !== exactKey(leveledUp));

    out.charCount = CHARACTERS.length;
    out.planned = planned;
    out.owned = own;
    return out;
  });

  /* ================================================================================
     10. The real UI — tabs, buttons, dialogs, save/load
     ================================================================================ */
  const ui = [];
  const check = (name, cond, detail) => ui.push({ name, pass: !!cond, detail: detail || '' });

  // Roster: an owned, dressed character shows a build chip; the owned toggle is wired
  await p.click('nav button[data-tab="roster"]');
  await p.evaluate(() => { document.getElementById('rsHideUnowned').checked = false; renderRoster(); });
  const chip = await p.evaluate(() => { const g = document.getElementById('rsGrid').innerHTML; return { build: /build <b>\d+<\/b>/.test(g), cards: document.querySelectorAll('#rsGrid [data-own]').length }; });
  check('the roster renders a build chip for a dressed character and an owned toggle per card', chip.build && chip.cards >= 65, JSON.stringify(chip));
  const toggled = await p.evaluate(() => { const before = state.chars['Ann Takamaki'].owned; document.querySelector('[data-own="Ann Takamaki"]').click(); const after = state.chars['Ann Takamaki'].owned; document.querySelector('[data-own="Ann Takamaki"]').click(); return before === false && after === true && state.chars['Ann Takamaki'].owned === false; });
  check('clicking "Mark owned" toggles ownership', toggled);

  // Optimise: run, equip the recommendation, per-slot buttons
  await p.click('nav button[data-tab="opt"]');
  await p.selectOption('#optChar', 'Makoto Yuki');
  await p.click('#optRun'); await p.waitForTimeout(200);
  const optText = await p.textContent('#optOut');
  check('Optimise renders a recommended loadout', /Recommended loadout/.test(optText) && optText.indexOf('NaN') < 0);
  await p.evaluate(() => state.cards.forEach(c => { if (c.equipped === 'Makoto Yuki') clearEquip(c); }));
  await p.click('#optRun'); await p.waitForTimeout(150);
  await p.click('#equipBtn'); await p.waitForTimeout(200);
  const equippedCount = await p.evaluate(() => state.cards.filter(c => c.equipped === 'Makoto Yuki').length);
  check('"Mark these as equipped" dresses the character in the whole recommendation', equippedCount >= 4, `${equippedCount} equipped`);
  const slotBtn = await p.evaluate(() => { const b = document.querySelector('#optOut .slotEquip'); if (!b) return null; const id = b.dataset.card, slot = b.dataset.slot; b.click(); return { ok: state.cards.find(c => c.id === id).equipped === 'Makoto Yuki', slot, one: state.cards.filter(c => c.equipped === 'Makoto Yuki' && c.slot === slot).length }; });
  check('a per-slot Equip button swaps that one card in and leaves one card in the slot', slotBtn && slotBtn.ok && slotBtn.one === 1, JSON.stringify(slotBtn));

  // Triage and Vault through their buttons
  await p.click('nav button[data-tab="triage"]');
  await p.click('#trRun'); await p.waitForTimeout(300);
  const trRows = await p.evaluate(() => document.querySelectorAll('#trTable tbody tr').length);
  check('Triage renders rows from its Run button', trRows > 0);
  await p.click('nav button[data-tab="vault"]');
  await p.click('#vaRun'); await p.waitForTimeout(300);
  const vaRows = await p.evaluate(() => document.querySelectorAll('#vaTable tbody tr').length);
  check('Vault renders rows from its Run button', vaRows > 0);

  // Upgrades: both sub-tabs
  await p.click('nav button[data-tab="upgrades"]');
  await p.click('#upRun'); await p.waitForTimeout(300);
  const upState = await p.evaluate(() => ({ panels: document.querySelectorAll('#upList .panel').length, hidden: document.getElementById('upPanel').classList.contains('hide'), nan: document.getElementById('upList').innerHTML.indexOf('NaN') >= 0 }));
  check('Upgrades renders a panel per character with a better card, without NaN', !upState.nan && (upState.panels > 0 || upState.hidden), JSON.stringify(upState));
  await p.click('#upSubtabs button[data-uptab="headroom"]'); await p.waitForTimeout(400);
  const hrState = await p.evaluate(() => ({ rows: document.querySelectorAll('#hrTable tbody tr').length, cache: hrRowsCache.length, owned: ownedChars().length, nan: document.getElementById('hrTable').innerHTML.indexOf('NaN') >= 0 }));
  check('the Weakest slots sub-tab runs its pass on the way in (five rows per owned character)', hrState.cache === hrState.owned * 5 && hrState.rows > 0 && !hrState.nan, JSON.stringify(hrState));

  // Targets dialog: open, save, reset
  await p.click('nav button[data-tab="roster"]');
  await p.evaluate(() => editTargets('Hatsune Miku'));   // has stat targets, so the Setup editor is in the dialog
  await p.waitForTimeout(150);
  const dlgOpen = await p.evaluate(() => document.getElementById('dlg').open && !!document.getElementById('tSave') && !!document.getElementById('lWeapon'));
  check('the Targets dialog opens with the loadout editor inside it', dlgOpen);
  await p.evaluate(() => { document.getElementById('tMMoon2').value = 'HP%'; document.getElementById('lRefine').value = '5'; document.getElementById('tSave').click(); });
  await p.waitForTimeout(150);
  const savedT = await p.evaluate(() => { const t = state.chars['Hatsune Miku'].targets, L = charLoadout('Hatsune Miku'); return { moon: t && t.main.Moon, refine: L.refine, closed: !document.getElementById('dlg').open, stamped: target(charDef('Hatsune Miku')).n }; });
  check('saving targets stores a best-first main list and the Setup fields', savedT.moon && savedT.moon.length === 3 && savedT.moon[2] === 'HP%' && savedT.refine === 5 && savedT.closed && savedT.stamped === 'Hatsune Miku', JSON.stringify(savedT));
  await p.evaluate(() => { editTargets('Hatsune Miku'); document.getElementById('tReset').click(); });
  await p.waitForTimeout(100);
  check('"Reset to default" clears the saved target', await p.evaluate(() => state.chars['Hatsune Miku'].targets === null && state.chars['Hatsune Miku'].loadout && state.chars['Hatsune Miku'].loadout.refine === 5 && !document.getElementById('dlg').open));

  // Inventory: the add-card form
  await p.click('nav button[data-tab="inv"]');
  const before = await p.evaluate(() => state.cards.length);
  await p.selectOption('#fSlot', 'Star');
  await p.evaluate(() => { document.getElementById('fSlot').dispatchEvent(new Event('change')); });
  await p.selectOption('#fSet', 'Hindrance');
  await p.selectOption('#fRar', '5');
  await p.fill('#fLvl', '0');
  await p.selectOption('#fMain', 'Crit Rate');
  await p.selectOption('.subStat[data-i="1"]', 'Speed'); await p.fill('.subVal[data-i="1"]', '4');
  await p.selectOption('.subStat[data-i="2"]', 'ATK%'); await p.fill('.subVal[data-i="2"]', '2');
  await p.selectOption('.subStat[data-i="3"]', 'DEF'); await p.fill('.subVal[data-i="3"]', '27');
  await p.click('#fAdd'); await p.waitForTimeout(100);
  const rejected = await p.evaluate(() => ({ n: state.cards.length, msg: document.getElementById('fMsg').textContent }));
  check('the add-card form refuses an impossible card and says why', rejected.n === before && /Speed/.test(rejected.msg), rejected.msg);
  await p.fill('.subVal[data-i="1"]', '2');
  await p.click('#fAdd'); await p.waitForTimeout(100);
  const added = await p.evaluate(() => ({ n: state.cards.length, last: state.cards[state.cards.length - 1], rows: document.querySelectorAll('#invTable tbody tr').length }));
  check('the add-card form adds a legal card and redraws the inventory', added.n === before + 1 && added.last.slot === 'Star' && added.last.main === 'Crit Rate' && added.last.subs.length === 3 && added.rows > 0, JSON.stringify({ n: added.n, before }));

  // Import review dialog: renders ambiguous rows, applies decisions, offers removal of unseen cards
  await p.click('nav button[data-tab="data"]');
  const importCheck = await p.evaluate(() => {
    const ix1 = { id: 'ix1', slot: 'Moon', set: 'Power', rarity: 5, level: 15, main: 'ATK%', equipped: null, subs: [{ stat: 'Speed', value: 2 }, { stat: 'HP', value: 84 }, { stat: 'DEF', value: 27 }] };
    const ix2 = { id: 'ix2', slot: 'Star', set: 'Opulence', rarity: 5, level: 15, main: 'Crit Rate', equipped: null, subs: [{ stat: 'Crit Multiplier', value: 8 }, { stat: 'ATK%', value: 6 }, { stat: 'DEF', value: 27 }] };
    state.cards.push(ix1, ix2);
    const incomingUpdate = { slot: 'Moon', set: 'Power', rarity: 5, level: 25, main: 'ATK%', equipped: null, subs: [{ stat: 'Speed', value: 4 }, { stat: 'HP', value: 84 }, { stat: 'DEF', value: 27 }, { stat: 'ATK', value: 27 }] };
    // a fingerprint the synthetic inventory does not hold, so this is new outright
    const freshSet = Object.keys(SETS).find(s => !state.cards.some(c => c.slot === 'Sky' && c.set === s && c.rarity === 4 && c.main === 'DEF%'));
    const incomingNew = { slot: 'Sky', set: freshSet, rarity: 4, level: 20, main: 'DEF%', equipped: null, subs: [{ stat: 'HP%', value: 2.1 }, { stat: 'DEF', value: 27 }, { stat: 'ATK', value: 27 }] };
    const incomingAmbiguous = { slot: 'Star', set: 'Opulence', rarity: 5, level: 20, main: 'Crit Rate', equipped: null, subs: [{ stat: 'Crit Multiplier', value: 1 }, { stat: 'ATK%', value: 1 }, { stat: 'DEF', value: 27 }] };
    const result = mergeImport(state.cards, [incomingUpdate, incomingNew, incomingAmbiguous]);
    renderImportReview(result, ['card 9: made up']);
    return {
      ambiguousShown: document.querySelectorAll('[data-amb]').length, dlgOpen: document.getElementById('dlg').open,
      toAdd: result.toAdd.length, toUpdate: result.toUpdate.length, unmatched: result.unmatched.length,
      removeBox: !!document.getElementById('impRemoveUnseen'), invalidShown: /made up/.test(document.getElementById('dlgBody').innerHTML),
      total: state.cards.length
    };
  });
  check('the import review classifies 1 new / 1 level-up / 1 decision and lists the rest as unmatched', importCheck.toAdd === 1 && importCheck.toUpdate === 1 && importCheck.ambiguousShown === 1 && importCheck.unmatched > 0, JSON.stringify(importCheck));
  check('the import review opens, shows the invalid list and offers unseen-card removal behind an unchecked box', importCheck.dlgOpen && importCheck.invalidShown && importCheck.removeBox);
  await p.evaluate(() => { document.getElementById('applyImport').click(); });
  await p.waitForTimeout(150);
  const afterImport = await p.evaluate(t => ({
    ix1Level: (state.cards.find(c => c.id === 'ix1') || {}).level,
    ix2StillAtOldLevel: (state.cards.find(c => c.id === 'ix2') || {}).level === 15,
    totalCards: state.cards.length, expected: t + 1, msg: document.getElementById('dataMsg').textContent
  }), importCheck.total);
  check('applying the review updates the level-up in place, adds the new card, and skips the ambiguous one by default',
    afterImport.ix1Level === 25 && afterImport.ix2StillAtOldLevel && afterImport.totalCards === afterImport.expected && /applied/i.test(afterImport.msg), JSON.stringify(afterImport));
  check('applying without the removal box ticked removes nothing', afterImport.totalCards === afterImport.expected);
  const decided = await p.evaluate(() => {
    const ix3 = { id: 'ix3', slot: 'Star', set: 'Opulence', rarity: 5, level: 15, main: 'Crit Rate', equipped: null, subs: [{ stat: 'Crit Multiplier', value: 8 }, { stat: 'ATK%', value: 6 }, { stat: 'DEF', value: 27 }] };
    state.cards.push(ix3);
    const inc = { slot: 'Star', set: 'Opulence', rarity: 5, level: 20, main: 'Crit Rate', equipped: null, subs: [{ stat: 'Crit Multiplier', value: 1 }, { stat: 'ATK%', value: 1 }, { stat: 'DEF', value: 27 }] };
    const result = mergeImport([ix3], [inc]);
    renderImportReview(result, []);
    const sel = document.querySelector('[data-amb]'); sel.value = 'replace';
    const n = state.cards.length;
    document.getElementById('applyImport').click();
    return { replaced: state.cards.find(c => c.id === 'ix3').level === 20, same: state.cards.length === n };
  });
  check('an ambiguous row set to "Replace existing" overwrites in place under the same id', decided.replaced && decided.same);

  // Save / load round trip through the real load() path, with an in-page File
  const roundTrip = await p.evaluate(() => new Promise(res => {
    const prefsBefore = collectPrefs();
    document.getElementById('trRar').value = '4';
    const payload = { version: 1, savedAt: 'x', nextId: state.nextId, cards: state.cards, characters: state.chars, prefs: collectPrefs() };
    const json = JSON.stringify(payload);
    const n = state.cards.length, worn = state.cards.filter(c => c.equipped).length;
    state.cards = []; state.chars['Ren Amamiya'].owned = false; document.getElementById('trRar').value = '2';
    load(new File([json], 'p5x-planner-save.json', { type: 'application/json' }));
    setTimeout(() => {
      res({ n, worn, after: state.cards.length, wornAfter: state.cards.filter(c => c.equipped).length, owned: state.chars['Ren Amamiya'].owned,
        trRar: document.getElementById('trRar').value, msg: document.getElementById('dataMsg').textContent, ids: new Set(state.cards.map(c => c.id)).size, saveShape: Object.keys(payload).join(',') });
      document.getElementById('trRar').value = prefsBefore.trRar;
    }, 400);
  }));
  check('a save file round-trips through load(): cards, equips, ownership and view prefs all come back',
    roundTrip.after === roundTrip.n && roundTrip.wornAfter === roundTrip.worn && roundTrip.owned === true && roundTrip.trRar === '4' && /Loaded/.test(roundTrip.msg) && roundTrip.ids === roundTrip.after,
    JSON.stringify(roundTrip));
  check('the save payload has the documented shape', roundTrip.saveShape === 'version,savedAt,nextId,cards,characters,prefs');
  const badLoad = await p.evaluate(() => new Promise(res => {
    const n = state.cards.length;
    load(new File(['{not json'], 'x.json', { type: 'application/json' }));
    setTimeout(() => res({ kept: state.cards.length === n, msg: document.getElementById('dataMsg').textContent }), 300);
  }));
  check('an unreadable save file is refused with a message and the inventory is left alone', badLoad.kept && /Could not read/.test(badLoad.msg), badLoad.msg);
  const skipLoad = await p.evaluate(() => new Promise(res => {
    const cards = state.cards.slice();
    const payload = { version: 1, nextId: 5, cards: [{ slot: 'Sun', set: 'Power', rarity: 5, level: 0, main: 'HP', subs: [{ stat: 'ATK%', value: 2 }] }, { slot: 'Sun', set: 'Power', rarity: 5, level: 0, main: 'HP', subs: [{ stat: 'ATK%', value: 2 }, { stat: 'DEF', value: 27 }, { stat: 'HP%', value: 2.1 }] }], characters: {} };
    load(new File([JSON.stringify(payload)], 'x.json'));
    setTimeout(() => { const r = { n: state.cards.length, msg: document.getElementById('dataMsg').textContent }; state.cards = cards; renderInv(); res(r); }, 300);
  }));
  check('load() skips an invalid card and says so rather than refusing the file', skipLoad.n === 1 && /1 skipped/.test(skipLoad.msg), skipLoad.msg);

  // Tabs: the scanning guide is reached from an in-prose link, not the nav
  await p.click('nav button[data-tab="data"]');
  await p.click('[data-goto="howto"]'); await p.waitForTimeout(100);
  check('the in-prose link opens the scanning guide tab', await p.evaluate(() => !document.getElementById('tab-howto').classList.contains('hide') && document.getElementById('tab-data').classList.contains('hide')));
  check('no browser storage is touched (Cowork artifact constraint)', await p.evaluate(() => { try { return localStorage.length === 0 && sessionStorage.length === 0; } catch (e) { return true; } }));

  // Outside the page: the generator's hand-tuned table must match src/data.js
  const drift = weightOverrideDrift();
  check('WEIGHT_OVERRIDES in the generator matches src/data.js', drift.length === 0, drift.join(' | '));

  const failures = r.checks.filter(c => !c.pass).concat(ui.filter(c => !c.pass));
  console.log(JSON.stringify({ charCount: r.charCount, planned: r.planned, plans: r.plans, checks: r.checks.length + ui.length, errs }, null, 2));
  await b.close();
  if (failures.length || errs.length) {
    console.error(`\n${failures.length} check(s) failed, ${errs.length} page error(s).`);
    failures.forEach(f => console.error(` - ${f.name}${f.detail ? '  [' + f.detail + ']' : ''}`));
    process.exit(1);
  }
  console.log(`\nAll ${r.checks.length + ui.length} checks passed.`);
})();
