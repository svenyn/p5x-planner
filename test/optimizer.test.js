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
const readRepo = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
/* A generator's `const NAME = {...}` table as source text (braces inside its strings would
   miscount; none of the tables read here has any). */
const grabTable = (src, name) => {
  const at = src.indexOf(`const ${name} = {`);
  if (at < 0) return null;
  let i = src.indexOf('{', at), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) { j++; break; }
  }
  return src.slice(i, j);
};

function weightOverrideDrift() {
  const read = readRepo, grab = grabTable;
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

/* GLB_AWARENESS_OVERRIDES in tools/gen-awareness.js holds Global Awareness text that differs
   from lufel's (Fuuka's 4.12 buff). Same reasoning as above: src/data.js is written from it,
   so a hand edit or an un-rerun generator shows up here. */
function awarenessOverrideDrift() {
  const table = grabTable(readRepo('tools/gen-awareness.js'), 'GLB_AWARENESS_OVERRIDES');
  if (!table) return ['tools/gen-awareness.js no longer defines GLB_AWARENESS_OVERRIDES'];
  const overrides = vm.runInContext('(' + table + ')', vm.createContext({}));
  const dataCtx = vm.createContext({});
  vm.runInContext(readRepo('src/data.js').replace(/^(\s*)(?:const|let)\s+/gm, '$1var '), dataCtx);
  const out = [];
  for (const [name, spec] of Object.entries(overrides)) {
    const cs = dataCtx.CHAR_STATS[name];
    if (!cs) { out.push(`GLB_AWARENESS_OVERRIDES names "${name}", who is not in CHAR_STATS`); continue; }
    if (!spec.why) out.push(`GLB_AWARENESS_OVERRIDES["${name}"] has no \`why\``);
    for (const [lvl, text] of Object.entries(spec)) {
      if (lvl === 'why') continue;
      const node = (cs.awareness || [])[+lvl];
      if (!node || node.d !== text) out.push(`${name}: Awareness ${lvl} in src/data.js is not the override's text — re-run tools/gen-awareness.js`);
    }
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
    // placeholder. With no art/ folder that is 68 expected 404s, which are the
    // feature working, not a fault — but only ignore that exact case.
    const loc = (m.location() && m.location().url) || '';
    if (/\/art\/[^/]+\.webp$/.test(loc)) return;
    // The GitHub sync checks answer 404 (no save yet) and 409 (a newer save) on purpose; the
    // browser logs each as a failed resource.
    if (/^https:\/\/api\.github\.com\//.test(loc)) return;
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
      /* r.loadoutTotal is the plan search's own evaluator: a plan's total must be what it
         says over the five cards it puts on, and exactly the build score's numerator — the
         optimiser maximises the number the Roster reports, not a look-alike of its own. */
      const worn = heavens.map(sl => res.best.picks[sl].c).concat(res.space ? [res.space.c] : []);
      const ht = res.loadoutTotal(worn), idlCh = idealLoadout(ch, t, 55);
      if (!near(ht.total, res.best.total, 1e-6)) evalBad.push(`${ch.n}: loadoutTotal ${ht.total} vs best.total ${res.best.total}`);
      const bsBest = buildScoreOf(ch, worn, 55, charLoadout(ch.n), idlCh, t);
      if (!near(bsBest.total, res.best.total, 1e-6)) evalBad.push(`${ch.n}: plan total ${res.best.total} vs build-score numerator ${bsBest.total}`);
      // ...so among the plans it considered and its policy allows, none scores higher once worn
      for (const alt of sameClass) {
        const aw = heavens.map(sl => alt.picks[sl].c).concat(alt.space ? [alt.space.c] : []);
        if (buildScoreOf(ch, aw, 55, charLoadout(ch.n), idlCh, t).raw > bsBest.raw + 1e-9) evalBad.push(`${ch.n}: "${alt.label}" builds higher than the pick`);
      }
      // ...nor does any of the next POLISH_DEPTH cards of the same set in any slot, Space included —
      // what Weakest slots' "Available now" prices; the per-card ranking alone let one build 1.25
      // points higher (Kotone Shiomi), and until the polish covered Space it never tried one
      const sameSet = sl => sl === 'Space'
        ? pool.filter(c => c.slot === 'Space' && res.space && c.set === res.space.c.set).map(c => ({ c, s: cardScore(c, t) })).sort((a, b) => b.s - a.s)
        : ((res.idx[sl] || {})[res.best.picks[sl].c.set] || []);
      SLOTS.forEach(sl => {
        const cur = sl === 'Space' ? res.space && res.space.c : res.best.picks[sl].c;
        if (!cur) return;
        sameSet(sl).slice(0, POLISH_DEPTH).forEach(o => {
          if (o.c === cur) return;
          const sw = worn.map(c => (c === cur ? o.c : c));
          if (buildScoreOf(ch, sw, 55, charLoadout(ch.n), idlCh, t).raw > bsBest.raw + 1e-9) evalBad.push(`${ch.n}: swapping in ${o.c.set} ${sl} builds higher than the pick`);
        });
      });
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
    fail('every plan total is finite, equals its own loadoutTotal and the build score\'s numerator, and no allowed alternative builds higher',
      evalBad.length === 0, evalBad.slice(0, 4).join(' | '));
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
    fail('the roster is the documented 68 characters in release order (not re-sorted by name)',
      CHARACTERS.length === 68 && CHARACTERS.slice().sort((a, b) => a.n.localeCompare(b.n)).some((c, i) => c !== CHARACTERS[i]));
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
        list.forEach(m => { if (!SLOT_INFO[sl].mains.includes(m)) badMain.push(`${ch.n} ${sl}=${m}`); });
        if (new Set(list).size !== list.length) badMain.push(`${ch.n} ${sl} lists a main twice`);
      }
    }
    fail('all target main stats are legal for their slot, listed once, best first', badMain.length === 0, badMain.join(' | '));
    /* An open slot (lufel's "-") recommends nothing: the perfect card takes whichever legal
       main scores best, not the slot's first entry or an archetype placeholder. */
    const openSlots = [];
    CHARACTERS.forEach(ch => { const t = target(ch); ['Moon', 'Star', 'Sky'].forEach(sl => { if (!mainList(t, sl).length) openSlots.push([ch, t, sl]); }); });
    const openBest = ([ch, t, sl]) => near(cardScore(idealCard(sl, t, ''), t), Math.max(...SLOT_INFO[sl].mains.map(m => cardScore(idealCardFor(sl, t, '', m), t))), 1e-9);
    fail('lufel\'s "-" slots are open, Chizuko\'s and Runa\'s Moon and Sky among them',
      ['Chizuko Nagao|Moon', 'Chizuko Nagao|Sky', 'Runa Dogenzaka|Moon', 'Runa Dogenzaka|Sky', 'Aran Hirano|Moon'].every(k => openSlots.some(([c, , sl]) => `${c.n}|${sl}` === k)),
      openSlots.map(([c, , sl]) => c.n + ' ' + sl).join(', '));
    fail('an open slot\'s perfect card takes the best-scoring legal main', openSlots.every(openBest),
      openSlots.filter(o => !openBest(o)).map(([c, , sl]) => c.n + ' ' + sl).join(', '));
    const badRef = [];
    for (const ch of CHARACTERS) {
      (ch.sets || []).forEach(s => { if (!SETS[s]) badRef.push(`${ch.n} set ${s}`); });
      if (ch.space && !SPACE_SETS[ch.space]) badRef.push(`${ch.n} space ${ch.space}`);
    }
    fail('all referenced sets exist', badRef.length === 0, badRef.join(' | '));
    const badPair = [];
    Object.entries(SPACE_SETS).forEach(([k, v]) => v.pairs.forEach(pp => { if (!SETS[pp]) badPair.push(`${k}->${pp}`); }));
    fail('all space pairings reference real sets', badPair.length === 0, badPair.join(' | '));
    /* Most cards pair with three sets. Acuity has one on Global (its Wealth and Hindrance
       pairings are later releases of their own), Nativity and Ego two, Perseverance four. */
    fail('every Space card names at least one pairing and an effect for each',
      Object.values(SPACE_SETS).every(v => v.pairs.length >= 1 && v.pairs.length <= 4 && v.pairs.every(pp => v.effects && v.effects[pp])) &&
      Object.values(SPACE_SETS).filter(v => v.pairs.length >= 3).length >= 16,
      Object.entries(SPACE_SETS).map(([k, v]) => `${k} ${v.pairs.length}`).join(', '));
    /* Pairings are Global's: lufel's English table, less any pairing the GLB schedule has not
       dated yet. Since Oct 2026 the English table lists Acuity + Hindrance ahead of 4.16, and
       the generator holds it back. Update this when a refresh dates the pairing — never by
       taking it early, which would hand Koromaru and Aran an effect their server does not have.
       Wealth is listed because its set is itself unreleased, so nobody can target it. */
    fail('Acuity pairs as it does on Global (Satiety; Wealth unreleased; Hindrance not until 4.16)',
      SPACE_SETS.Acuity && SPACE_SETS.Acuity.pairs.join() === 'Wealth,Satiety' &&
      ['Koromaru', 'Aran Hirano'].every(n => CHARACTERS.find(c => c.n === n).space !== 'Acuity'),
      SPACE_SETS.Acuity && SPACE_SETS.Acuity.pairs.join());
    const deadOwnSets = [];
    for (const ch of CHARACTERS) (ch.sets || []).forEach(s => {
      const def = SETS[s];
      if (def && def.elem && def.elem !== ch.e) deadOwnSets.push(`${ch.n} (${ch.e}) lists off-element set ${s} (${def.elem})`);
    });
    fail('no character lists an off-element set among their own preferred sets', deadOwnSets.length === 0, deadOwnSets.join(' | '));
    /* Six Heavens sets and two Space cards are lufel-listed but unshipped on Global. They
       stay in the tables so an import resolves, but nobody may be built around one. Named,
       not counted, so a release that moves one is a line to review on the next refresh
       rather than a number that silently still adds up. */
    const unreleased = Object.keys(SETS).filter(s => SETS[s].unreleased).sort();
    const unreleasedSpace = Object.keys(SPACE_SETS).filter(s => SPACE_SETS[s].unreleased).sort();
    fail('the unreleased sets are still marked',
      unreleased.join() === 'Cruelty,Debauch,Failure,Happiness,Tenacity,Wealth' && unreleasedSpace.join() === 'Ego,Purity',
      `${unreleased.join(', ')} / ${unreleasedSpace.join(', ')}`);
    fail('no character targets an unreleased set or Space card',
      CHARACTERS.every(c => !(c.sets || []).some(s => SETS[s] && SETS[s].unreleased) && !(c.space && SPACE_SETS[c.space] && SPACE_SETS[c.space].unreleased)),
      CHARACTERS.filter(c => (c.sets || []).some(s => SETS[s] && SETS[s].unreleased) || (c.space && SPACE_SETS[c.space] && SPACE_SETS[c.space].unreleased)).map(c => c.n).join(', '));
    fail('every set carries a 2-piece model on a real stat', Object.values(SETS).every(s => s.bonus2 && (SUBSTATS[s.bonus2.stat] || s.bonus2.stat === 'HP Recovery') && s.bonus2.amt > 0));
    fail('a 2-piece\'s further terms name real stats with a signed, non-zero amount (only Prudence\'s Speed cost today)',
      Object.values(SETS).every(s => !s.bonus2Also || (Array.isArray(s.bonus2Also) && s.bonus2Also.every(x => SUBSTATS[x.stat] && isFinite(x.amt) && x.amt !== 0))) &&
      J(SETS.Prudence.bonus2Also) === J([{ stat: 'Speed', amt: -3 }]) && Object.values(SETS).filter(s => s.bonus2Also).length === 1);
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
    fail('39 characters carry stat targets', CHARACTERS.filter(c => c.ov && c.ov.targets && c.ov.targets.length).length === 39);

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
    fail('CRIT_PROFILE names real characters with a locked share in (0,1], a no-crit share, or an extra-crit share on a weapon ladder',
      Object.entries(CRIT_PROFILE).every(([n, pr]) => charDef(n) && ((pr.locked > 0 && pr.locked <= 1) || (pr.nocrit > 0 && pr.nocrit < 1) ||
        (pr.extraCr && pr.extraCr.share > 0 && pr.extraCr.share < 1 && (pr.extraCr.v > 0 || (Array.isArray(pr.extraCr.ladder) && pr.extraCr.ladder.length === 7))))) &&
      CRIT_PROFILE['Ryuji Sakamoto'].locked === 1 && CRIT_PROFILE['Shun Kano [Pioneer]'].locked === 1);
    fail('DAMAGE_SCALE names the eight DEF/HP-scaling kits, each weighting ATK% at zero',
      Object.keys(DAMAGE_SCALE).length === 8 && Object.entries(DAMAGE_SCALE).every(([n, s]) => charDef(n) && ['DEF', 'HP'].includes(s) && target(charDef(n)).w['ATK%'] === 0) &&
      DAMAGE_SCALE['Minami Miyashita [Beachflower]'] === 'HP' && !DAMAGE_SCALE['Yukimi Fujikawa'] && !DAMAGE_SCALE['Motoha Arai [Tropical]']);
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
    /* Healing has one price wherever it lands. Love's +9% 2-piece used to be a flat 1.5 x the
       HP% weight (6-15 points) where the same 9% as a Moon main was 36, which is how Worry, a
       set neither lists, beat Love for Morgana and Lufel. */
    const morgH = charDef('Morgana'), tMorgH = target(morgH), yuki = charDef('Yukimi Fujikawa'), tYuki = target(yuki);
    const healPct = SETS.Love.bonus2.amt, perPct = mainRolls('HP Recovery', 'Moon', 25) / MAIN_MAGNITUDE['HP Recovery'][1];
    fail('Love\'s healing 2-piece is priced exactly as the same healing on an HP Recovery main',
      SETS.Love.bonus2.stat === 'HP Recovery' && near(bonus2Value('Love', morgH, tMorgH), hpRecoveryMainWeight(tMorgH, 'Moon') * healPct * perPct) &&
      near(bonus2Value('Love', yukari, target(yukari)), hpRecoveryMainWeight(target(yukari), 'Moon') * healPct * perPct));
    fail('Love\'s 2-piece is worth nothing to a character lufel lists no healing main for, whatever their HP% weight',
      !mainList(tYuki, 'Moon').includes('HP Recovery') && (tYuki.w['HP%'] || 0) > 0 && bonus2Value('Love', yuki, tYuki) === 0);
    const lufelH = charDef('Lufel'), tLufelH = target(lufelH);
    fail('Lufel\'s and Morgana\'s own Love beats Worry on set bonuses alone (Lufel\'s Worry used to win, 85 to 73)',
      [[lufelH, tLufelH], [morgH, tMorgH]].every(([c, tt]) => tt.sets[0] === 'Love' &&
        55 + bonus2Value('Love', c, tt) > 55 * 0.22 + bonus2Value('Worry', c, tt)) && bonus4Value('Love', morgH, tMorgH, 55) === 55);
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
       her before any card is placed. An Elucidator is not coupled at all: the stats are
       donated, so what a roll is worth is decided by an ally's board, not theirs. */
    const yui = charDef('YUI');
    const fy = couplingFactors(target(yui), 'Moon', 'ATK%');
    fail('a high-crit character\'s baseline favours Crit Multiplier over Crit Rate', fy['Crit Multiplier'] > fy['Crit Rate'] && damageBase(yui).cr > 40,
      `CM ${fy['Crit Multiplier'].toFixed(2)} CR ${fy['Crit Rate'].toFixed(2)} at ${damageBase(yui).cr}% crit`);
    const navi = charDef('Hatsune Miku'), tn = target(navi);
    const generic = Object.assign({}, tn, { n: undefined });
    const fN = couplingFactors(tn, 'Moon', 'ATK%'), fG = couplingFactors(generic, 'Moon', 'ATK%');
    fail('an Elucidator\'s cards are priced on their weights alone: no coupling for any slot or main',
      CHARACTERS.filter(c => !spreadApplies(c)).every(c => { const t = target(c); return SLOTS.every(sl => SLOT_INFO[sl].mains.every(m => Object.keys(couplingFactors(t, sl, m)).length === 0)); }) &&
      Object.keys(fN).length === 0 && Object.keys(fG).length > 0 && seedBaseline(tn) === null && seedBaseline(tj) !== null);
    fail('Fuuka\'s perfect Star is lufel\'s Crit Multiplier, not a Crit Rate the generic board over-priced',
      idealCard('Star', target(charDef('Fuuka Yamagishi')), '').main === 'Crit Multiplier');
    fail('a DPS\'s seeded baseline reads their own weapon and Awakening (Joker above 100% ATK, real crit)',
      seedBaseline(tj)['ATK%'] > 100 && near(seedBaseline(tj)['Crit Rate'], damageBase(joker).cr));
    fail('target() stamps the owner\'s name on generated and saved targets alike', (() => {
      state.chars['Morgana'].targets = { sets: ['Love'], space: 'Acceptance', main: { Moon: ['ATK%'] }, w: { 'ATK%': 10 }, targets: [] };
      const ok = target(charDef('Morgana')).n === 'Morgana' && tj.n === 'Ren Amamiya';
      state.chars['Morgana'].targets = null; return ok;
    })());
    /* Saved targets are a diff over the data, so a data fix still reaches every field the
       user did not change — a full snapshot froze Kiyoshi's and Yusuke's ATK% at a 4 the
       DEF/HP-kit override had since set to 0. */
    fail('a saved target applies only its own edits; every other field, and the stat targets, follow the data', (() => {
      const kumiT = defaultTarget(charDef('Kumi Katayama'));
      state.chars['Kumi Katayama'].targets = { v: 2, space: 'Hope', w: { 'Speed': 3 } };
      const t = target(charDef('Kumi Katayama'));
      const ok = t.space === 'Hope' && t.w.Speed === 3 && J(t.sets) === J(kumiT.sets) && t.w['ATK%'] === kumiT.w['ATK%'] &&
        J(t.main) === J(kumiT.main) && J(t.targets) === J(kumiT.targets) && target(charDef('Kumi Katayama')) === t;
      state.chars['Kumi Katayama'].targets = null;
      return ok && target(charDef('Kumi Katayama')) !== t && target(charDef('Kumi Katayama')).space === kumiT.space;
    })());
    fail('targetEdits stores only what differs from the data, and nothing when nothing does', (() => {
      const base = defaultTarget(joker), mine = JSON.parse(JSON.stringify(base));
      if (targetEdits(base, mine) !== null) return false;
      mine.w['Speed'] = (base.w.Speed || 0) + 1; mine.main.Star = ['Crit Multiplier']; mine.space = 'Hope';
      const e = targetEdits(base, mine);
      return e && e.v === 2 && J(Object.keys(e).sort()) === J(['main', 'space', 'v', 'w']) && J(Object.keys(e.w)) === '["Speed"]' &&
        J(e.main) === J({ Star: ['Crit Multiplier'] }) && e.space === 'Hope';
    })());
    fail('an old full snapshot converts to a diff: set/Space/main changes kept, a differing weight handed back and reported, stat targets from the data', (() => {
      const yk = charDef('Yusuke Kitagawa'), yd = defaultTarget(yk);
      const legacy = JSON.parse(JSON.stringify(yd));
      legacy.space = 'Growth'; legacy.w['ATK%'] = 4; legacy.targets = [{ s: 'Speed', sub: 'Speed', pct: false, tiers: { LV10: 999 } }];
      state.chars[yk.n].targets = legacy;
      const dropped = migrateSavedTargets(), e = state.chars[yk.n].targets;
      const ok = J(e) === J({ v: 2, space: 'Growth' }) && dropped.length === 1 && dropped[0].n === yk.n && dropped[0].stat === 'ATK%' &&
        dropped[0].saved === 4 && dropped[0].data === 0 && target(yk).w['ATK%'] === 0 && J(target(yk).targets) === J(yd.targets) &&
        migrateSavedTargets().length === 0 && J(state.chars[yk.n].targets) === J(e);
      state.chars[yk.n].targets = null;
      return ok;
    })());
    fail('an old snapshot\'s main for a slot the data now leaves open is handed back and reported, its other edits kept', (() => {
      const cz = charDef('Chizuko Nagao'), legacy = JSON.parse(JSON.stringify(defaultTarget(cz)));
      legacy.main.Moon = ['Damage Multiplier']; legacy.main.Sky = ['Speed']; legacy.sets = ['Truth']; legacy.space = 'Harmony';
      state.chars[cz.n].targets = legacy;
      const dropped = migrateSavedTargets(), e = state.chars[cz.n].targets;
      const ok = J(e) === J({ v: 2, sets: ['Truth'], space: 'Harmony' }) && dropped.length === 2 &&
        dropped.every(d => d.n === cz.n && / main$/.test(d.stat) && d.data === 'any') && mainList(target(cz), 'Moon').length === 0;
      state.chars[cz.n].targets = null;
      return ok;
    })());
    /* Capped Crit Rate: once what is held reaches 100 points, a Crit Rate roll is worth zero.
       A team crit rate of 100 puts anyone there before a card is worn. */
    const morg = charDef('Morgana'), tm = target(morg);
    const cappedOk = (() => {
      const was = state.teamCrit; state.teamCrit = 100;
      const ok = heldCritRate(tm, 'ATK%') >= 100 && couplingFactors(tm, 'Moon', 'ATK%')['Crit Rate'] === 0 &&
        near(cardScore(mk('Moon', 'Love', 'ATK%', [['Crit Rate', 6]]), tm), cardScore(mk('Moon', 'Love', 'ATK%', []), tm));
      state.teamCrit = was;
      return ok;
    })();
    fail('a crit rate already at 100% prices a Crit Rate roll at zero', cappedOk);
    fail('below the cap the generic path leaves Crit Rate live', couplingFactors(target(yui), 'Star', 'Crit Rate')['Crit Rate'] > 0);
    fail('cf() treats a hard zero as an answer and only a missing factor as neutral', cf({ 'Crit Rate': 0 }, 'Crit Rate') === 0 && cf({}, 'Crit Rate') === 1);
    /* A saved target is the same object for as long as it exists, and the coupling and the
       perfect-card score memoised on it depend on the loadout too (seedBaseline reads the
       weapon and Awareness). A Setup change must reach them without a reload (targetMemo). */
    fail('a Setup change reaches a saved target\'s coupling and perfect-card score without a reload', (() => {
      state.chars[morg.n].targets = JSON.parse(JSON.stringify(target(morg)));
      const t = target(morg), probe = tt => J(couplingFactors(tt, 'Moon', mainTop(tt, 'Moon'))) + '|' + idealCardScore('Star', tt);
      const before = probe(t);
      state.chars[morg.n].loadout = Object.assign({}, DEFAULT_LOADOUT, { refine: 7, awareness: 6 });
      const after = probe(t), fresh = probe(Object.assign(JSON.parse(JSON.stringify(t)), { n: morg.n }));
      const same = target(morg) === t;
      state.chars[morg.n].targets = null; state.chars[morg.n].loadout = null;
      return same && after === fresh && after !== before;
    })());

    /* Scaling stat: Yusuke's ⓐ is DEF, so the coupling pairs DEF% with Damage Multiplier. */
    const yu = charDef('Yusuke Kitagawa'), yt = target(yu), ylo = charLoadout(yu.n);
    fail('the coupling pairs a DEF-scaling kit\'s DEF% with Damage Multiplier, and leaves ATK% out',
      couplingFactors(yt, 'Moon', 'DEF%')['DEF%'] != null && couplingFactors(yt, 'Moon', 'DEF%')['ATK%'] == null && scaleStat(yu) === 'DEF' && scalePctStat(charDef('Junpei Iori')) === 'HP%');

    /* ---- coupling arithmetic must always produce a number ------------------------
       A live bug (18 Sep 2026). A board's 'Crit Multiplier' supply is a TOTAL MINUS 100
       and the seven Buff-element supports carry a 0% crit damage base, so on a board that has
       not made up the difference it came back NEGATIVE; computeCoupling took Math.log of it
       and the whole crit product went NaN. cardScore's `if (!ws) continue` then dropped every
       crit substat silently while a crit MAIN scored NaN outright, and bestPlan's sort on NaN
       left the slot in pool order — which is why Hatsune Miku's recommendation ignored the
       four Labor cards she wore. A supply of exactly zero is the same failure by another
       route (log 0 -> -Infinity -> 0/0), so the guard is on the supply, not the sign. */
    const nanSweep = [];
    CHARACTERS.forEach(c => {
      const tc = target(c);
      SLOTS.forEach(sl => SLOT_INFO[sl].mains.forEach(m => {
        const f = couplingFactors(tc, sl, m);
        Object.keys(f).forEach(k => { if (!isFinite(f[k])) nanSweep.push(`${c.n} ${sl}/${m}: ${k}=${f[k]}`); });
        const probe = mk(sl, 'Labor', m, [['Crit Rate', 6], ['Crit Multiplier', 8], ['ATK%', 10]]);
        if (!isFinite(cardScore(probe, tc))) nanSweep.push(`${c.n} ${sl}/${m}: cardScore NaN`);
      }));
    });
    fail('no coupling factor or card score is ever NaN', !nanSweep.length, nanSweep.slice(0, 4).join(' | '));
    fail('a sub-100% crit damage total floors at zero supply, never goes negative',
      CHARACTERS.every(c => { const sb = seedBaseline(target(c)); return !sb || sb['Crit Multiplier'] >= 0; }),
      CHARACTERS.filter(c => { const sb = seedBaseline(target(c)); return sb && sb['Crit Multiplier'] < 0; }).map(c => c.n).join(', '));
    /* An Elucidator's stats are donated, so they have no baseline of their own and every
       per-card price is the uncoupled one (see computeCoupling). */
    fail('an Elucidator gets no baseline of their own, and everyone else with a stat block does',
      CHARACTERS.every(c => !CHAR_STATS[c.n] || (seedBaseline(target(c)) === null) === !spreadApplies(c)));
    /* The optimiser shortlists on the build score's own card price — for everyone, since the
       ranking against the plan's other cards went (Sep 2026). */
    fail('the optimiser ranks each slot by the build score\'s own card price', [navi, charDef('Kotone Shiomi'), yui].every(ch => {
      const r = bestPlan(ch, state.cards.filter(c => c.rarity >= 2), { policy: 'pref' }), tt = target(ch);
      return r.scored.length > 0 && r.scored.every(o => near(o.s, cardScore(o.c, tt), 1e-9));
    }));
    const mikuStar = mk('Star', 'Labor', 'Crit Rate', [['Crit Multiplier', 9.2], ['ATK%', 3.2], ['Damage Multiplier', 7.8]]);
    fail('an Elucidator\'s crit-main Star prices finite and positive', isFinite(cardScore(mikuStar, tn)) && cardScore(mikuStar, tn) > 0);

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
        const up = bestCaseUpgrades(c0, tj), subGrowth = up.mint.reduce((s, x) => s + x.w, 0) + up.rolls * up.w;
        return potentialCardScore(c0, tj) > cardScore(c0, tj) && near(potentialCardScore(c25, tj), cardScore(c25, tj)) &&
          potentialCardScore(c0, tj) > cardScore(c0, tj) + subGrowth; })());
    /* A card minted with three substats gains a fourth on its first upgrade (the accounting
       validateCard and mergeImport use). The best case must mint the most valuable stat the
       card lacks and spend only the REMAINING upgrades as rolls — 60% of the real level-0
       inventory is three-substat cards, and the old rule (every upgrade a roll on an existing
       substat) labelled 763 card/character pairs "even maxed, not an upgrade" wrongly. */
    fail('a three-substat card mints the most valuable stat it lacks (never its main) at one roll, then rolls the rest',
      (() => { const c0 = mk('Star', 'Hindrance', 'Crit Rate', [['Crit Multiplier', 4.1], ['ATK%', 3.5], ['Speed', 2.2]], { level: 0 });
        const up = bestCaseUpgrades(c0, tj), f = couplingFactors(tj, 'Star', 'Crit Rate'), w = s => (tj.w[s] || 0) * cf(f, s);
        const lacking = Object.keys(SUBSTATS).filter(s => !['Crit Multiplier', 'ATK%', 'Speed', 'Crit Rate'].includes(s));
        const top = Math.max(...lacking.map(w));
        return up.mint.length === 1 && lacking.includes(up.mint[0].stat) && near(up.mint[0].w, top) &&
          up.rolls === remainingUpgrades(c0) - 1 && near(up.w, Math.max(top, ...['Crit Multiplier', 'ATK%', 'Speed'].map(w))); })());
    fail('a four-substat card mints nothing and rolls every remaining upgrade onto its best substat', (() => {
      const c4 = mk('Star', 'Hindrance', 'Crit Rate', [['Crit Multiplier', 4.1], ['ATK%', 3.5], ['Speed', 2.2], ['DEF', 27]], { level: 0 });
      const up = bestCaseUpgrades(c4, tj);
      return up.mint.length === 0 && up.rolls === remainingUpgrades(c4) && up.onto.length >= 1 &&
        near(potentialCardScore(c4, tj), cardScore(c4, tj) + up.rolls * up.w + mainWeightFor(c4, tj) * (mainRolls('Crit Rate', 'Star', 25) - mainRolls('Crit Rate', 'Star', 0)));
    })());
    fail('a three-substat card of junk can still reach a keeper through its fourth substat', (() => {
      const junk = mk('Sun', 'Hindrance', 'HP', [['DEF', 27], ['HP%', 2.1], ['SP Recovery', 5.9]], { level: 0 });
      const up = bestCaseUpgrades(junk, tj), existingBest = Math.max(...junk.subs.map(s => (tj.w[s.stat] || 0) * cf(couplingFactors(tj, 'Sun', 'HP'), s.stat)));
      return up.mint.length === 1 && up.w > existingBest && up.onto.includes(up.mint[0].stat) &&
        potentialCardScore(junk, tj) > cardScore(junk, tj) + remainingUpgrades(junk) * existingBest;
    })());
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

    /* ---- perfect is a ceiling: lufel's order holds against every other configuration ----
       Whole loadouts of perfect cards, stat targets and the damage-spread term included, since
       a 2-piece's stat and a main's feed both. The 4-piece value is this tool's invention and
       yields to lufel's set order (setLift); mains are left to the model, which gets them right
       everywhere but one documented case. */
    const spacesR = Object.keys(SPACE_SETS).filter(x => !SPACE_SETS[x].unreleased);
    const ceilingBreaks = () => {
    const liftBad = [], lifted = [], mainBad = [];
    CHARACTERS.forEach(c => {
      const t = target(c), lc = charLoadout(c.n), idl = idealLoadout(c, t, 55);
      const heav = idl.cards.filter(x => x.slot !== 'Space'), sp = idl.cards.filter(x => x.slot === 'Space')[0];
      const tot = (sets, space) => buildScoreOf(c, heav.map((x, i) => Object.assign({}, x, { set: sets[i] })).concat([Object.assign({}, sp, { set: space })]), 55, lc, idl, t).total;
      const base = buildScoreOf(c, idl.cards, 55, lc, idl, t).total;
      const usable = Object.keys(SETS).filter(x => !SETS[x].unreleased && !(SETS[x].elem && SETS[x].elem !== c.e));
      const pairFor = x => spacesR.filter(y => SPACE_SETS[y].pairs.includes(x))[0] || sp.set;
      const four = {}; usable.forEach(x => four[x] = tot([x, x, x, x], pairFor(x)));
      const listed = t.sets.filter(x => usable.includes(x));
      usable.forEach(x => { if (x !== listed[0] && four[x] > base + 1e-6) liftBad.push(`${c.n}: 4pc ${x}`); });
      for (let i = 0; i < usable.length; i++) for (let j = i + 1; j < usable.length; j++) {
        if (tot([usable[i], usable[i], usable[j], usable[j]], sp.set) > base + 1e-6) liftBad.push(`${c.n}: ${usable[i]} 2 + ${usable[j]} 2`);
      }
      if (listed[0] && bonus4Value(listed[0], c, t, 55) > 55 + 1e-9) lifted.push(c.n);
      ['Moon', 'Star', 'Sky'].forEach(sl => SLOT_INFO[sl].mains.forEach(m => {
        if (buildScoreOf(c, idl.cards.map(x => x.slot === sl ? idealCardFor(sl, t, x.set, m) : x), 55, lc, idl, t).total > base * (1 + 1e-4)) mainBad.push(`${c.n} ${sl}: ${m}`);
      }));
    });
    return { liftBad, lifted, mainBad };
    };
    const { liftBad, lifted, mainBad } = ceilingBreaks();
    fail('no other 4-piece and no two 2-pieces of perfect cards beat the preferred 4-piece, targets and spread counted', liftBad.length === 0, liftBad.slice(0, 5).join(' | '));
    fail('the preferred set is lifted only where the flat 4-piece value contradicted lufel: Elucidators and healers, never a DPS like Joker',
      lifted.length > 0 && lifted.length <= 18 && lifted.includes('Futaba Sakura') && lifted.includes('Lufel') && !lifted.includes('Ren Amamiya') && !lifted.includes('Ann Takamaki') &&
      CHARACTERS.every(c => { const t = target(c); return t.sets.slice(1).every(a => !SETS[a] || bonus4Value(a, c, t, 55) === 0 || near(bonus4Value(a, c, t, 55), 55 * 0.72)); }),
      lifted.join(', '));
    /* The one known exception: lufel lists only Crit Multiplier for Wavecatcher Miyu's Star, the
       right call in a party that supplies crit rate — which lufel's builds assume, and which the
       team crit rate models only when the user sets it. On her own board a Crit Rate Star is
       ahead (docs/SCORING.md, known gaps). */
    fail('no main outscores the perfect card\'s own, loadout-wide, but Wavecatcher Miyu\'s Star',
      mainBad.every(x => x === 'Miyu Sahara [Wavecatcher] Star: Crit Rate'), mainBad.join(' | '));

    /* ---- the team crit rate (Roster) ----
       The crit rate the user's supports add, in points: into every damage dealer's crit rate in
       the damage model and both coupling baselines, never an Elucidator's, never an on-screen
       total or a stat target. Every memo that reads it has to drop when it changes. */
    const annC = charDef('Ann Takamaki'), tAnn = target(annC), futabaC = charDef('Futaba Sakura');
    const critAt = () => ({ cr: damageBase(annC).cr, crF: damageBase(futabaC).cr,
      tot: totalStat(annC, 'Crit Rate', 'Crit Rate', [], charLoadout(annC.n)).total,
      f: Object.assign({}, couplingFactors(tAnn, 'Star', 'Crit Multiplier')), v: Object.assign({}, couplingFactors(VAULT_TARGET, 'Star', 'Crit Multiplier')),
      ideal: idealCardScore('Star', tAnn) });
    const c0 = critAt();
    state.teamCrit = 20;
    const c20 = critAt(), ceil20 = ceilingBreaks();
    state.teamCrit = 0;
    const cBack = critAt();
    fail('the team crit rate adds to a damage dealer\'s crit rate in the damage model, never an Elucidator\'s or an on-screen total',
      state.teamCrit === 0 && near(c20.cr, c0.cr + 20) && near(c20.crF, c0.crF) && near(c20.tot, c0.tot), JSON.stringify({ c0: c0.cr, c20: c20.cr }));
    fail('a new team crit rate reprices the coupling at once — Crit Multiplier up, Crit Rate down, the Vault\'s generic board too — and 0 restores it exactly',
      c20.f['Crit Multiplier'] > c0.f['Crit Multiplier'] && c20.f['Crit Rate'] < c0.f['Crit Rate'] && c20.v['Crit Multiplier'] > c0.v['Crit Multiplier'] &&
      c20.ideal !== c0.ideal && near(cBack.f['Crit Multiplier'], c0.f['Crit Multiplier']) && near(cBack.f['Crit Rate'], c0.f['Crit Rate']) && near(cBack.ideal, c0.ideal));
    fail('at a 20% team crit rate perfect is a ceiling for everyone, Wavecatcher Miyu\'s Crit Multiplier Star included',
      ceil20.mainBad.length === 0 && ceil20.liftBad.length === 0, ceil20.mainBad.concat(ceil20.liftBad).slice(0, 5).join(' | '));
    const toshiya = charDef('Toshiya Sumi'), runaD = charDef('Runa Dogenzaka');
    fail('Defeat\'s 4-piece works for Fire only, its ailment-accuracy 2-piece for anyone',
      SETS.Defeat.elem4 === 'Fire' && !SETS.Defeat.elem && bonus4Value('Defeat', toshiya, target(toshiya), 55) === 0 &&
      bonus4Value('Defeat', runaD, target(runaD), 55) > 0 && bonus2Value('Defeat', toshiya, target(toshiya)) > 0);
    const bm = charDef('Minami Miyashita [Beachflower]'), tbm = target(bm);
    const wsum = (tt, list) => list.reduce((acc, x) => acc + (tt.w[x] || 0), 0);
    fail('Beachflower Minami scales off HP, and her crit multiplier and HP buff allies: uncoupled, not booked as her damage, lufel\'s Crit Multiplier Star her ideal',
      scaleStat(bm) === 'HP' && tbm.w['ATK%'] === 0 && SLOT_INFO.Star.mains.every(m => Object.keys(couplingFactors(tbm, 'Star', m)).length === 0) &&
      idealCard('Star', tbm, '').main === 'Crit Multiplier' &&
      near(damageShare(tbm, bm), wsum(tbm, ['HP', 'Damage Multiplier', 'Crit Rate']) / wsum(tbm, Object.keys(tbm.w))));
    const lufelC = charDef('Lufel'), tlu = target(lufelC);
    fail('Lufel\'s heal-scaling ATK% is her top weight, and lufel\'s ATK% Star and Sky are her ideal',
      tlu.w['ATK%'] === Math.max(...Object.values(tlu.w)) && idealCard('Star', tlu, '').main === 'ATK%' && idealCard('Sky', tlu, '').main === 'ATK%');
    const kira = charDef('Kira Kitazato');
    const kiraAA = wpn => { const b = charBaseStat(kira, 'Ailment Accuracy', Object.assign({}, charLoadout(kira.n), { weapon: wpn })); return b.flat + b.pct; };
    fail('Kira: Doctor mode and Bloodletter\'s unconditional line count toward his ailment accuracy, and lufel\'s ATK% Star is his ideal',
      near(kiraAA('4'), 36) && near(kiraAA('5'), 51) && idealCard('Star', target(kira), '').main === 'ATK%');
    fail('Wavecatcher Miyu\'s Resonance crit rate lifts her crit factor for its share, and only with Mermaid Dreamer', (() => {
      const wm = charDef('Miyu Sahara [Wavecatcher]'), twm = target(wm), L5 = Object.assign({}, charLoadout(wm.n), { weapon: '5' }), L4 = Object.assign({}, L5, { weapon: '4' });
      const board = idealLoadout(wm, twm, 55).cards, prof = CRIT_PROFILE[wm.n];
      const with5 = damageFactors(board, wm, twm, L5).crit, with4 = damageFactors(board, wm, twm, L4).crit;
      delete CRIT_PROFILE[wm.n];
      const plain5 = damageFactors(board, wm, twm, L5).crit, plain4 = damageFactors(board, wm, twm, L4).crit;
      CRIT_PROFILE[wm.n] = prof;
      return with5 > plain5 && near(with4, plain4) && extraCritFor(prof, L4) === null && extraCritFor(prof, L5).cr === prof.extraCr.ladder[L5.refine - 1];
    })());
    fail('the archetype floor never lifts a stat to one lufel ranks above it (Minami, Seaside Tomoko, Ichigo)',
      target(charDef('Minami Miyashita')).w['SP Recovery'] < target(charDef('Minami Miyashita')).w['DEF%'] &&
      target(charDef('Ichigo Shikano')).w['Crit Rate'] < target(charDef('Ichigo Shikano')).w['ATK%'] &&
      target(charDef('Tomoko Noge [Seaside]')).w['SP Recovery'] === 6);

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
    /* The fixed mains are flat stat added after the percentage, at their real magnitude for
       the card's level: a Space card's ATK + DEF for ATK and DEF kits, a Sun card's HP for HP
       kits. They used to be left out as "cancelling", which a flat term in a ratio does not. */
    fail('the fixed mains feed ⓐ as flat stat at their level\'s magnitude, for the kits whose scaling stat they are', (() => {
      const sp = mk('Space', 'Hope', 'ATK + DEF', []), sun = mk('Sun', 'Opulence', 'HP', []), sun0 = mk('Sun', 'Opulence', 'HP', [], { level: 0 });
      const jun = charDef('Junpei Iori'), tjun = target(jun), ljun = charLoadout(jun.n);
      const dA = (cards, c, t, l) => damageFactors(cards, c, t, l).atk - damageFactors([], c, t, l).atk;
      return near(dA([sp], joker, tj, lj), MAIN_MAGNITUDE['ATK + DEF'][1], 1e-6) && near(dA([sp], yu, yt, ylo), MAIN_MAGNITUDE['ATK + DEF'][1], 1e-6) &&
        near(dA([sun], jun, tjun, ljun), MAIN_MAGNITUDE.HP[1], 1e-6) && near(dA([sun0], jun, tjun, ljun), MAIN_MAGNITUDE.HP[0], 1e-6) &&
        near(dA([sun], joker, tj, lj), 0, 1e-9) && near(dA([sp], jun, tjun, ljun), 0, 1e-9);
    })());

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
    /* A target already met with no cards cannot be earned by any loadout, so it is shown but
       left out of the block. Fuuka's Crit Multiplier target (lufel's 64-78%, the crit damage
       at which her party buff caps) sits under her 150% base; Mitsuru's LV10 ATK under her
       no-card ATK — until a Setup whose tier her base does not clear. Each setup gets its own
       idealLoadout, since breakpointRows caches the ideal side per idealCards array. */
    fail('a target met with no cards is shown but not scored (Fuuka\'s Crit Multiplier; Mitsuru\'s ATK until her tier outgrows her base)', (() => {
      const fu = charDef('Fuuka Yamagishi'), tf = target(fu), lf = charLoadout(fu.n), idf = idealLoadout(fu, tf, 55);
      const card = mk('Sun', 'Labor', 'HP', [['ATK%', 3.5]]);
      const bs = buildScoreOf(fu, [card], 55, lf, idf, tf), part = bs.parts.find(x => x.label === 'Stat targets');
      const cm = bs.targets.find(r => r.stat === 'Crit Multiplier'), atk = bs.targets.find(r => r.stat === 'ATK');
      const mi = charDef('Mitsuru Kirijo'), tmi = target(mi);
      const lm0 = Object.assign({}, DEFAULT_LOADOUT), lm5 = Object.assign({}, DEFAULT_LOADOUT, { mindSkill: true });
      const bm0 = buildScoreOf(mi, [card], 55, lm0, idealLoadout(mi, tmi, 55), tmi), bm5 = buildScoreOf(mi, [card], 55, lm5, idealLoadout(mi, tmi, 55), tmi);
      return bs.targets.length === 2 && cm.metBare && cm.bare > cm.bar && !atk.metBare && part && part.max === BREAKPOINT_VALUE &&
        near(part.got, BREAKPOINT_VALUE * atk.ratio) &&
        bm0.targets[0].metBare && !bm0.parts.some(x => x.label === 'Stat targets') &&
        !bm5.targets[0].metBare && bm5.parts.some(x => x.label === 'Stat targets');
    })());
    /* Progress toward a target is measured from the character's no-card total, so base stats
       earn none of the block and the cards earn all of it. Measured from zero, the median target
       was 64% met before a card was worn and a naked character took about 49 of its 80 points. */
    fail('an unmet target reads 0 with no cards and fills linearly from the no-card total to the bar', (() => {
      const bad = [];
      CHARACTERS.forEach(c => {
        const t = target(c); if (!(t.targets || []).length) return;
        const lc = charLoadout(c.n), idl = idealLoadout(c, t, 55);
        breakpointRows([], idl.cards, c, t, lc).forEach(r => { if (r.exact && !r.metBare && r.ratio !== 0) bad.push(`${c.n} ${r.stat} ${r.ratio}`); });
      });
      const y = charDef('Yaoling Li'), ty = target(y), ly = charLoadout(y.n), idy = idealLoadout(y, ty, 55);
      const r0 = breakpointRows([], idy.cards, y, ty, ly)[0], need = r0.effBar - r0.bare;
      const half = mk('Sun', 'Control', 'HP', [['Speed', need / 2]]);
      const r1 = breakpointRows([half], idy.cards, y, ty, ly)[0];
      const html = targetHtml(buildScoreOf(y, [half], 55, ly, idy, ty));
      return bad.length === 0 && r0.stat === 'Speed' && need > 0 && near(r1.ratio, 0.5, 1e-9) &&
        /close this share of the gap from/.test(html) && /no-card total and the target/.test(html);
    })());
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
    /* Ailment Accuracy reads 0% on the in-game panel with no cards (the user, 25 Sep 2026);
       it was modelled at 100%. At 0, Awakening 7's `ailment_accuracy` is unambiguous and read. */
    fail('Ailment Accuracy starts at 0% and Awakening 7\'s ailment_accuracy is read (Ann none, Runa 34.9)',
      charBaseStat(ann, 'Ailment Accuracy', charLoadout(ann.n)).flat === 0 && !(CHAR_STATS[ann.n].aw || {}).ailment_accuracy &&
      near(charBaseStat(runa, 'Ailment Accuracy', lr).flat, CHAR_STATS[runa.n].aw.ailment_accuracy) && near(CHAR_STATS[runa.n].aw.ailment_accuracy, 34.9));
    fail('Haru\'s 150 and Shoki\'s 100 Ailment Accuracy are not met with no cards (nor their conversions capped), and a perfect build reaches both', (() => {
      return ['Haru Okumura', 'Shoki Ikenami'].every(n => {
        const c = charDef(n), t = target(c), l = charLoadout(n), idl = idealLoadout(c, t, 55);
        const row = rs => rs.find(x => x.stat === 'Ailment Accuracy');
        const bare = row(breakpointRows([], idl.cards, c, t, l)), full = row(breakpointRows(idl.cards, idl.cards, c, t, l));
        // any AA conversion at its cap — Shoki's ATK% caps at 100 AA, Haru's crit stacks at 150
        const anyCapped = cards => CONVERSIONS[n].some(cv => cv.from === 'Ailment Accuracy' && cv.cap != null &&
          conversionBonus(c, cards, l)[cv.to] >= cv.cap - 1e-9);
        return bare.exact && bare.ratio < 0.7 && full.reach >= full.bar && !anyCapped([]) && anyCapped(idl.cards);
      });
    })());
    fail('Prudence\'s 2-piece costs 3 Speed, in the in-battle total and in what the 2-piece is worth', (() => {
      const pair = [mk('Moon', 'Prudence', 'ATK%', []), mk('Star', 'Prudence', 'Crit Rate', [])];
      const plain = [mk('Moon', 'Power', 'ATK%', []), mk('Star', 'Sorrow', 'Crit Rate', [])];
      const lk = charLoadout(kumi.n), tw = { sets: [], space: '', targets: [], main: {}, w: { 'ATK%': 6, 'Speed': 10 } };
      return near(totalStat(kumi, 'Speed', 'Speed', pair, lk).total, totalStat(kumi, 'Speed', 'Speed', plain, lk).total - 3) &&
        near(bonus2Value('Prudence', kumi, tw), 6 * 18 / maxRoll('ATK%', 'Sun') - 10 * 3 / maxRoll('Speed', 'Sun')) &&
        near(statSupply(pair, kumi, 'ATK%'), 18);
    })());
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
    fail('a 5★ mainValue off its level\'s curve (scanned at Lv0, levelled up after) reads the level, as cardScore does; one display unit of rounding still counts', (() => {
      const stale = mk('Sky', 'Strife', 'ATK%', [], { mainValue: 4.6 });            // Lv25, Lv0 value
      const hp = mk('Sun', 'Strife', 'HP', [], { level: 20, mainValue: 897 });       // real panel, line gives 896.4
      return near(mainMagnitudeFor(stale), 31.4) && !mainValueFitsLevel(stale) &&
        mainMagnitudeFor(hp) === 897 && mainValueFitsLevel(hp) &&
        near(cardStatContribution([stale], joker, 'ATK', 'ATK%').pct, cardStatContribution([mk('Sky', 'Strife', 'ATK%', [])], joker, 'ATK', 'ATK%').pct);
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

    /* The user's own Miku, card for card (26 Sep 2026): Awareness 0, 5★ weapon at R0, both
       Mindscape paths at 5. Her character screen read ATK 4627, HP 9358, DEF 1790, crit rate 38,
       crit multiplier 58.5; in battle, with the Thieves Den, ATK 4746, HP 9831, crit 39, crit
       multiplier 60.5. Pins her Awakening 7 (+19% on Global), her Labor 4-piece's +8% on her own
       stats, the weapon's party crit damage staying out of them, and the Den being flat. */
    {
      const miku = charDef('Hatsune Miku');
      const mc = (slot, set, main, mainValue, subs) => ({ slot, set, rarity: 5, level: 25, main, mainValue, subs: subs.map(([stat, value]) => ({ stat, value })) });
      const cards = [
        mc('Sun', 'Labor', 'HP', 1080, [['DEF%', 5.2], ['Crit Rate', 3.3], ['Crit Multiplier', 13.9], ['Damage Multiplier', 5.3]]),
        mc('Moon', 'Labor', 'Damage Multiplier', 25.1, [['DEF%', 8.9], ['ATK%', 7.7], ['Crit Rate', 1.7], ['Crit Multiplier', 11.2]]),
        mc('Star', 'Labor', 'Crit Rate', 18.8, [['Ailment Accuracy', 7.1], ['Crit Multiplier', 9.2], ['ATK%', 3.2], ['Damage Multiplier', 7.8]]),
        mc('Sky', 'Labor', 'ATK%', 31.4, [['Damage Multiplier', 5], ['Crit Rate', 2], ['Resistance Pierce', 4.6], ['Crit Multiplier', 10.9]]),
        mc('Space', 'Hope', 'ATK + DEF', 359, [['DEF%', 10.9], ['SP Recovery', 7.5], ['HP%', 12.8], ['Crit Multiplier', 13.1]])
      ];
      const lo = Object.assign({}, DEFAULT_LOADOUT, { weapon: '5', refine: 1, awareness: 0, mind1: 5, mind2: 5, mindSkill: true });
      const tot = (st, sub) => totalStat(miku, st, sub, cards, lo).total;
      const screen = { ATK: tot('ATK', 'ATK%'), HP: tot('HP', 'HP%'), DEF: tot('DEF', 'DEF%'), CR: tot('Crit Rate', null), CM: tot('Crit Multiplier', null) };
      const within = (v, want, rel) => Math.abs(v - want) <= want * rel;
      fail('the planner reproduces Miku\'s character screen card for card (ATK/HP/DEF within 1.2%, crit exact to the display)',
        within(screen.ATK, 4627, 0.012) && within(screen.HP, 9358, 0.012) && within(screen.DEF, 1790, 0.012) &&
        Math.abs(screen.CR - 38) <= 0.5 && Math.abs(screen.CM - 58.5) <= 0.5, JSON.stringify(screen));
      const noLabor = Object.assign({}, miku, { arch: 'ST DPS' });
      fail('a Labor 4-piece adds its +8% HP/ATK/DEF only when an Elucidator wears it',
        near(set4StatLines(cards, miku)['ATK%'], 8) && Object.keys(set4StatLines(cards, noLabor)).length === 0 &&
        Object.keys(set4StatLines(cards.slice(1), miku)).length === 0);
      const was = state.den;
      state.den = { ATK: 119, HP: 473, 'Crit Rate': 1, 'Crit Multiplier': 2 };
      const row = breakpointRows(cards, idealLoadout(miku, target(miku), 55).cards, miku, target(miku), lo).find(r => r.stat === 'ATK');
      const summary = statsSummaryHtml(miku, cards, lo, false, null);
      state.den = was;
      fail('the Thieves Den is added to the in-battle totals a stat target reads (Miku in battle: ATK 4746)',
        row && within(row.total, 4746, 0.012) && near(row.den, 119) && /Thieves Den is counted/.test(summary),
        JSON.stringify(row && { total: row.total, den: row.den }));
      fail('refinement reads as the game counts it: R0 for a weapon with no extra copies, R6 at the top',
        refineLabel(1) === 'R0' && refineLabel(7) === 'R6' && refineLabel(undefined) === 'R0');
    }

    /* The user's Kotone Shiomi (28 Sep 2026): the damage model's ⓐ read 5316 beside her ATK tile's
       5603, exactly Strife's +15% of her 1910 base, because a 4-piece's stat line was counted in the
       in-battle totals and not in ⓐⓑⓓ. Both must see the same ATK, on her cards and on the perfect
       build alike, and a broken 4-piece must lose the line in both. */
    {
      const kot = charDef('Kotone Shiomi'), kt = target(kot);
      const kc = (slot, set, main, subs) => ({ slot, set, rarity: 5, level: 25, main, subs: subs.map(([stat, value]) => ({ stat, value })) });
      const cards = [
        kc('Sun', 'Strife', 'HP', [['ATK%', 6.3], ['Crit Multiplier', 6.7], ['Resistance Pierce', 3.5], ['HP%', 6.1]]),
        kc('Moon', 'Strife', 'ATK%', [['Damage Multiplier', 3.7], ['HP', 321], ['Crit Rate', 1.7], ['Resistance Pierce', 2.6]]),
        kc('Star', 'Strife', 'ATK%', [['HP%', 6.1], ['Crit Rate', 3.8], ['SP Recovery', 15.9], ['Damage Multiplier', 3.9]]),
        kc('Sky', 'Strife', 'ATK%', [['DEF%', 8.3], ['Crit Rate', 4.7], ['HP%', 5.4], ['SP Recovery', 15]]),
        kc('Space', 'Nativity', 'ATK + DEF', [['Resistance Pierce', 4.3], ['Crit Rate', 5.8], ['HP', 245], ['Speed', 4.2]])
      ];
      const lo = Object.assign({}, DEFAULT_LOADOUT);
      const same = cs => { const a = damageFactors(cs, kot, kt, lo).atk, b = totalStat(kot, 'ATK', 'ATK%', cs, lo).total; return { a, b, ok: Math.abs(a - b) < 0.5 }; };
      const worn = same(cards), ideal = same(idealLoadout(kot, kt, 55).cards);
      const broken = same(cards.map(c => c.slot === 'Moon' ? Object.assign({}, c, { set: 'Ruin' }) : c));
      fail('ⓐ counts a 4-piece\'s stat line exactly as the ATK tile does (Kotone\'s Strife: 5603 on both, perfect build too, and neither once the 4-piece breaks)',
        worn.ok && ideal.ok && broken.ok && Math.abs(worn.a - 5603) < 1 && broken.a < worn.a - 280,
        JSON.stringify({ worn, ideal, broken }));
    }

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
    fail('the Roster flags an owned character still on the default Setup, and stops once one is saved', (() => {
      const n = own[0], was = state.chars[n].loadout;
      const card = () => document.querySelector(`#rsGrid .cc[data-ch="${n}"]`);
      state.chars[n].loadout = null; renderRoster();
      const flagged = !!card() && /default setup/.test(card().textContent) && /on the default setup/.test($('#rsCount').textContent);
      state.chars[n].loadout = Object.assign({}, DEFAULT_LOADOUT); renderRoster();
      const cleared = !!card() && !/default setup/.test(card().textContent);
      state.chars[n].loadout = was; renderRoster();
      return flagged && cleared;
    })());

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
    /* A card the Upgrades tab tells someone to equip is never feed: Triage prices one card
       at a time, and a set switch pays off only with the fourth card. */
    {
      const upR = +$('#upRar').value, same = $('#upSameSet').checked, free = $('#upIgnoreEquipped').checked;
      const byId = new Map(rated.map(x => [x.card.id, x]));
      const want = new Map();
      ownedChars().forEach(c => upgradesFor(c, upR, same, free).forEach(row => {
        const card = row.rec, prev = card && want.get(card.id);
        if (card && !card.equipped && card.rarity >= 2 && (!prev || upPts(row) > prev.pts)) want.set(card.id, { n: c.n, pts: upPts(row) });
      }));
      const bad = [...want].filter(([id, w]) => !byId.get(id) || byId.get(id).rec !== w.n);
      const low = [...want.keys()].filter(id => byId.get(id) && byId.get(id).pct < 0.35).length;
      fail('Triage keeps every card the Upgrades tab recommends, for the character it recommends it to',
        want.size > 0 && bad.length === 0 && rated.filter(x => x.rec).length === want.size,
        `${want.size} recommended, ${bad.length} not kept, ${low} would have read feed on their own swap score`);
    }
    fail('Triage\'s default "worst first" order is the verdict\'s: feed, then Vault-held feed, lock, hold, keep', (() => {
      const was = trSort.key; trSort.key = null; $('#trShow').value = 'worst';
      const rank = x => x.rec ? 5 : { keep: 4, hold: 3, lock: 2, feed: x.vault === 'watch' ? 1 : 0 }[trVerdict(x)];
      const order = sortTrRows(rated).map(rank);
      trSort.key = was;
      return order.every((v, i) => i === 0 || v >= order[i - 1]);
    })());
    /* Triage is relative to the owned roster and the Vault is not; a fed card does not come
       back, so a would-be feed the Vault rates worth a lock is marked lock. */
    fail('Triage marks lock, never feed, a card the Vault rates worth a lock (at the Vault tab\'s own floor)', (() => {
      const va = new Map(vaultRate(state.cards.filter(c => c.rarity >= +$('#vaRar').value)).rated.map(v => [v.card.id, v]));
      const vOf = x => (va.get(x.card.id) || {}).verdict || '';
      const low = rated.filter(x => !x.rec && x.pct < 0.35);
      return rated.every(x => x.vault === vOf(x)) && low.every(x => trVerdict(x) === (vOf(x) === 'lock' ? 'lock' : 'feed')) &&
        rated.filter(x => trVerdict(x) === 'lock').every(x => vOf(x) === 'lock' && x.pct < 0.35);
    })(), `${rated.filter(x => trVerdict(x) === 'lock').length} marked lock of ${rated.filter(x => !x.rec && x.pct < 0.35).length} below 35%`);
    fail('Triage marks the main at its level cap: a level-0 card of a wanted main can grade as a keeper', (() => {
      const set = tj.sets[0];
      const c0 = mk('Star', set, mainTop(tj, 'Star'), [['Crit Multiplier', 4.1], ['ATK%', 3.5], ['Damage Multiplier', 2.8]], { level: 0, id: 'lv0probe', equipped: null });
      state.cards.push(c0); runTriage();
      const row = trCache.rated.find(x => x.card.id === 'lv0probe');
      state.cards.pop(); runTriage();
      return row && row.pct > 0.5 && row.who === 'Ren Amamiya';
    })());
    /* Triage subtracts buildScore RAW values: the rounded `score` left the real inventory on
       about thirty distinct Score values and moved 6% of its verdicts across the 35% / 70%
       lines. And an empty board is not worth 0 — see buildScoreOf. */
    fail('Triage marginals are unrounded build-score deltas', rated.some(x => Math.abs(x.best - Math.round(x.best)) > 1e-6),
      `${new Set(rated.map(x => x.best.toFixed(6))).size} distinct values`);
    fail('an empty board is worth what its base stats earn (buildScoreOf), while buildScore still reads it as nothing', (() => {
      const lk = charLoadout(kumi.n), ik = idealLoadout(kumi, tk, 55), e = buildScoreOf(kumi, [], 55, lk, ik, tk);
      return buildScore(kumi, [], 55, lk, ik, tk) === null && e && e.raw > 0 && e.filled === 0 &&
        near(e.raw, 100 * e.parts.reduce((s, x) => s + x.got, 0) / e.parts.reduce((s, x) => s + x.max, 0), 1e-9);
    })());
    fail('Triage prices a card for a bare character against their bare board, not against zero', (() => {
      const was = Object.assign({}, state.chars[kumi.n]);
      state.chars[kumi.n].owned = true; state.chars[kumi.n].benched = false;
      runTriage();
      const lk = charLoadout(kumi.n), ik = idealLoadout(kumi, tk, 55), empty = buildScoreOf(kumi, [], 55, lk, ik, tk).raw;
      const hers = trCache.rated.filter(x => x.who === kumi.n);
      const ok = hers.length > 0 && hers.every(x => near(x.best, buildScoreOf(kumi, [atMaxLevel(x.card)], 55, lk, ik, tk).raw - empty, 1e-9));
      state.chars[kumi.n].owned = was.owned; state.chars[kumi.n].benched = was.benched; runTriage();
      return ok;
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
        if (grouped.length && !(grouped[0].groupPts >= UPGRADE_MIN_GAIN)) upBad.push(`${n}: group below the gate`);
        // the gate reads the receiver's own gain; a trade's net (upPts) may fall below it and is shown, not hidden
        rows.forEach(row => { if (!(row.pts >= UPGRADE_MIN_GAIN - 1e-9) && row.group == null) upBad.push(`${n}: ${row.slot} row below the gate`); });
        for (let i = 1; i < rows.length; i++) if (upGain(rows[i]) > upGain(rows[i - 1]) + 1e-9) upBad.push(`${n}: rows not sorted by upGain`);
      });
    });
    fail('Upgrades proposes only whole preferred-set 4-pieces, honours the same-set and ignore-equipped flags, and groups rows consistently', upBad.length === 0, upBad.slice(0, 4).join(' | '));
    fail('Upgrades found at least one better card on the narrowly-dressed roster', anyRows);
    fail('upGain reads the group total when there is one, else the row\'s own delta', upGain({ delta: 3, group: 28 }) === 28 && upGain({ delta: -2 }) === -2 && gainStr(-2.5) === '−2.5' && gainStr(3) === '+3.0');
    /* A raw gain is in the character's own units, so across characters it measures the size of
       their yardstick as much as the upgrade. Each row carries its gain in build points too —
       exactly the build score it adds — and that is what orders characters and fills the column. */
    fail('an Upgrades row\'s build points are exactly the build score its swap adds', (() => {
      let checked = 0;
      const ok = own.every(n => {
        const ch = charDef(n), t = target(ch), lo = charLoadout(n), idl = idealLoadout(ch, t, 55);
        const worn = SLOTS.map(sl => state.cards.find(c => c.equipped === n && c.slot === sl)).filter(Boolean);
        const base = buildScoreOf(ch, worn, 55, lo, idl, t);
        return upgradesFor(ch, 4, false, false).every(row => {
          const after = worn.filter(c => c.slot !== row.slot).concat([row.rec]);
          const b1 = buildScoreOf(ch, after, 55, lo, idl, t);
          checked++;
          // a Space row is priced against the Heavens as they will be once the rows above are on
          return (row.slot === 'Space' || near(row.pts, 100 * (b1.total - base.total) / base.idealTotal, 1e-6)) && near(row.pts, row.delta * 100 / base.idealTotal, 1e-6);
        });
      });
      return ok && checked > 0;
    })());
    fail('Upgrades orders characters by build points, not raw gains', (() => {
      runUpgrades();
      const names = [...document.querySelectorAll('#upList .panel h3')].map(h => h.firstChild.textContent.trim());
      const best = names.map(n => Math.max(...upgradesFor(charDef(n), +document.getElementById('upRar').value,
        document.getElementById('upSameSet').checked, document.getElementById('upIgnoreEquipped').checked).map(upPts)));
      return names.length >= 2 && best.every((v, i) => i === 0 || v <= best[i - 1] + 1e-9);
    })());
    /* A trade is priced on both sides: a card taken off someone else carries what it costs
       them (giverLoss: build points lost after they put back their best free card of the slot),
       and upPts nets it off. If the synthetic roster offers no trade, one is made by putting a
       character's best free upgrade on someone else first. */
    const tradeCheck = (() => {
      const find = () => {
        for (const n of own) { const rows = upgradesFor(charDef(n), 4, false, false); const row = rows.find(x => x.rec.equipped && x.rec.equipped !== n); if (row) return { n, rows, row }; }
        return null;
      };
      let hit = find(), undo = null;
      if (!hit) for (const n of own) {
        const r = upgradesFor(charDef(n), 4, false, true).find(x => !x.rec.equipped);
        if (!r) continue;
        const other = own.find(m => m !== n), prev = state.cards.find(c => c.equipped === other && c.slot === r.rec.slot);
        undo = () => { r.rec.equipped = null; if (prev) prev.equipped = other; };
        if (prev) prev.equipped = null;
        r.rec.equipped = other;
        hit = find();
        break;
      }
      let ok = false, why = 'no trade found or made';
      if (hit) {
        const { n, rows, row } = hit, giver = charDef(row.rec.equipped);
        const own1 = giverLoss(giver, [row.rec], new Set(rows.map(x => x.rec.id)), 4);
        const grouped = rows.filter(x => x.group != null);
        ok = near(row.giverPts, own1, 1e-9) &&
          (row.group == null ? near(row.lossPts, row.giverPts, 1e-9) && near(upPts(row), row.pts - row.lossPts, 1e-9)
            : grouped.every(x => near(x.lossPts, row.lossPts, 1e-12)) && near(upPts(row), row.groupPts - row.lossPts, 1e-9)) &&
          upgradesFor(charDef(n), 4, false, true).every(x => !x.lossPts && x.giverPts == null);
        why = `${n} takes ${row.rec.slot} ${row.rec.set} from ${giver.n}: gain ${upPts(row) + row.lossPts}, giver loss ${row.giverPts}, net ${upPts(row)}`;
      }
      if (undo) undo();
      return { ok, why };
    })();
    fail('Upgrades prices a trade on both sides: the giver\'s loss is charged, and upPts is net of it', tradeCheck.ok, tradeCheck.why);
    fail('Optimise says what a loadout that takes cards off someone else costs them, and nets it', (() => {
      const n = own[0], other = own[1];
      const r0 = bestPlan(charDef(n), poolFor('free', 2, n), { policy: 'force4', p4value: 55 });
      const c = r0.best && heavens.map(sl => r0.best.picks[sl] && r0.best.picks[sl].c).find(x => x && !x.equipped);
      if (!c) return false;
      const prev = state.cards.find(x => x.equipped === other && x.slot === c.slot);
      const was = { pool: $('#optPool').value, rar: $('#optRarity').value, ch: $('#optChar').value };
      if (prev) prev.equipped = null;
      c.equipped = other;
      renderOpt(n); $('#optChar').value = n; $('#optPool').value = 'all'; $('#optRarity').value = '2';
      runOpt();
      const html = $('#optOut').innerHTML;
      c.equipped = null; if (prev) prev.equipped = other;
      $('#optPool').value = was.pool; $('#optRarity').value = was.rar; renderOpt(); $('#optChar').value = was.ch;
      return /It takes \d+ cards? off /.test(html) && /net <b>[−+]\d/.test(html) && /on [^<]+ · [−+]\d/.test(html);
    })());
    // The user's choice (Oct 2026). The select is not in the prefs, so its markup default is
    // what every session opens on.
    fail('Optimise\'s Card pool opens on "Only unequipped cards"',
      [...$('#optPool').options].filter(o => o.defaultSelected).map(o => o.value).join() === 'free');

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
    fail('Headroom measures a bare character\'s gains from their bare board, not from zero', (() => {
      const was = Object.assign({}, state.chars[kumi.n]);
      state.chars[kumi.n].owned = true; state.chars[kumi.n].benched = false;
      const rows = headroomRows(false).filter(x => x.ch.n === kumi.n);
      state.chars[kumi.n].owned = was.owned; state.chars[kumi.n].benched = was.benched;
      const lk = charLoadout(kumi.n), ik = idealLoadout(kumi, tk, HR_P4), empty = buildScoreOf(kumi, [], HR_P4, lk, ik, tk).raw;
      return rows.length === SLOTS.length && rows.every(x => x.card === null && x.build === null &&
        near(x.gain, buildScoreOf(kumi, [idealCard(x.slot, tk, hrSetFor(x.slot, [], tk))], HR_P4, lk, ik, tk).raw - empty, 1e-9));
    })());

    // ---- Custom card (the Cycle of Fate event) ----
    {
      const o = { free: true, policy: 'pref', mode: 'typical', scope: 'owned' };
      const chars = own.slice(0, 4).map(charDef);
      const rows = chars.map(ch => ccRow(ch, o));
      const bad = [];
      rows.forEach(r => {
        const b = r.best, n = r.ch.n;
        if (!b) { bad.push(n + ': no card'); return; }
        const c = b.card, S = SETS[c.set];
        if (HEAVENS.indexOf(c.slot) < 0) bad.push(n + ': not a Heavens slot (the event cannot make Space)');
        if (!S || S.unreleased || (S.elem && S.elem !== r.ch.e)) bad.push(n + ': set ' + c.set + ' is unreleased or off-element');
        if (c.rarity !== 5 || c.level !== RARITY[5].maxLevel) bad.push(n + ': not a level-25 5★');
        if (SLOT_INFO[c.slot].mains.indexOf(c.main) < 0) bad.push(n + ': main ' + c.main + ' is not legal on ' + c.slot);
        const st = c.subs.map(x => x.stat);
        if (st.length !== 4 || new Set(st).size !== 4 || st.indexOf(c.main) >= 0) bad.push(n + ': substats ' + st.join(','));
        if (validateCard(c).length) bad.push(n + ': ' + validateCard(c)[0]);
        if (b.cards.indexOf(c) < 0 || new Set(b.cards.map(x => x.slot)).size !== b.cards.length) bad.push(n + ': its loadout does not hold it once per slot');
        if (!(r.gain >= 0 && isFinite(r.gain)) || !near(r.after, Math.min(100, r.inv + r.gain), 1e-6) || r.after > 100) bad.push(n + ': gain/after inconsistent');
        if (r.ctx.base.total + 1e-9 < r.ctx.ev(r.ctx.worn).total) bad.push(n + ': baseline is below what is worn');
        if (!near(r.ctx.ev(b.cards).total, b.total, 1e-6)) bad.push(n + ': total is not the build score numerator');
      });
      fail('Custom card: a legal level-25 5★ Heavens card in a released, on-element set, priced as the build score of a legal loadout over the best already wearable', !bad.length);
      if (bad.length) out.customCardBad = bad;
      const per = mode => chars.map(ch => ccRow(ch, Object.assign({}, o, { mode })).gain);
      const lo = per('low'), pf = per('perfect');
      fail('Custom card: poor rolls never beat typical ones, and typical never beats perfect',
        rows.every((r, i) => lo[i] <= r.gain + 0.05 && r.gain <= pf[i] + 0.05));
      rows.sort((a, b) => b.gain - a.gain);
      const sec = ccSecond(rows, o);
      fail('Custom card: the second card is another character\'s best, or a second one for the first priced after the first',
        !!sec && isFinite(sec.gain) && sec.gain >= 0 && (sec.same ? sec.ch === rows[0].ch : sec.ch !== rows[0].ch && near(sec.gain, rows.filter(r => r !== rows[0])[0].gain, 1e-9)));
      fail('Custom card: the likely range is ordered, holds the typical gain near its average, and reads the same every run',
        rows.every(r => {
          const g = r.range;
          return g && g.min <= g.lo && g.lo <= g.mean + 1e-9 && g.mean <= g.hi + 1e-9 && g.hi <= g.max && Math.abs(g.mean - r.gain) < 0.6 &&
            JSON.stringify(ccRange(ccOptionOutcomes(r.ctx, r.best))) === JSON.stringify(g);
        }));
      {
        const r = rows[0], b = r.best, rest = b.cards.filter(c => c !== b.card);
        const fresh = ccOptionOutcomes(r.ctx, b, 600);
        const tierAt = k => b.card.subs.map(s => ccTiers(s.stat, b.slot)[k]);
        const low = ccOutcomes(r.ctx, b.card, rest, tierAt(0), 600), high = ccOutcomes(r.ctx, b.card, rest, tierAt(4), 600);
        const pLow = ccChanceBetter(low, fresh), pHigh = ccChanceBetter(high, fresh), pSelf = ccChanceBetter(fresh, fresh);
        fail('Custom card: a card that started on its lowest rolls is less likely than a fresh roll to end up better, one on its highest more likely, and a card against itself is even',
          pLow < 0.5 && pHigh > 0.5 && near(pSelf, 0.5, 1e-9) && near(ccChanceBetter([1, 2], [1.5]), 0.5, 1e-9));
      }
      const spaceBad = [];
      chars.forEach(ch => {
        const r = ccRow(ch, Object.assign({}, o, { kind: 'space' })), c = r.best && r.best.card;
        if (!c) { spaceBad.push(ch.n + ': no card'); return; }
        if (c.slot !== 'Space' || c.main !== 'ATK + DEF' || !SPACE_SETS[c.set] || SPACE_SETS[c.set].unreleased) spaceBad.push(ch.n + ': ' + c.slot + ' ' + c.set + ' ' + c.main);
        if (validateCard(c).length) spaceBad.push(ch.n + ': ' + validateCard(c)[0]);
        if (c.subs.some(x => x.value > maxRoll(x.stat, 'Space') * 3 + 0.05)) spaceBad.push(ch.n + ': rolled past the Space table');
        if (r.slots.some(x => x.slot !== 'Space') || !(r.gain >= 0) || r.after > 100) spaceBad.push(ch.n + ': options or gain');
      });
      fail('Custom card, Space: a legal level-25 Space card in a released Space set, rolled on the Space table, with the other Space sets as its alternatives', !spaceBad.length);
      if (spaceBad.length) out.customCardSpaceBad = spaceBad;
      fail('Custom card: the pool cut gives the optimiser the same answer as the whole inventory', chars.every(ch => {
        const t = target(ch), full = bestPlan(ch, poolFor('free', 2, ch.n), { policy: 'pref', p4value: CC_P4 });
        const cut = bestPlan(ch, ccContext(ch, o).pool, { policy: 'pref', p4value: CC_P4 });
        return (!full.best && !cut.best) || (full.best && cut.best && near(full.best.total, cut.best.total, 1e-6));
      }));
    }

    // ---- Ink card (Vicissitude / Elysian / Prophetic Ink: pick some substats, the rest is random) ----
    {
      const o = { free: true, policy: 'pref', scope: 'owned', pick: 2 };
      const chars = own.slice(0, 4).map(charDef);
      const rows = chars.map(ch => ikRow(ch, o));
      const bad = [];
      fail('Ink card: every fill is counted once — 495 for none picked, 165 for one, 45 for two, 9 for three, 1 for four — and a Sun card is never filled with HP',
        [495, 165, 45, 9, 1].every((n, k) => ikCombos(ikLeft('Moon', 'ATK%', ['Crit Rate', 'Crit Multiplier', 'Speed', 'HP%'].slice(0, k)), 4 - k).length === n) &&
        ikLeft('Sun', 'HP', []).indexOf('HP') < 0 && ikLeft('Sun', 'HP', []).length === Object.keys(SUBSTATS).length - 1);
      rows.forEach(r => {
        const n = r.ch.n, cc = ccRow(r.ch, Object.assign({}, o, { mode: 'typical', kind: 'heavens' }));
        if (r.byK.some(x => !x)) { bad.push(n + ': a pick count has no card'); return; }
        r.byK.forEach((x, k) => {
          const stats = x.opt.card.subs.map(s => s.stat);
          if (x.picked.length !== k || x.picked.some(s => stats.indexOf(s) < 0)) bad.push(n + ' k=' + k + ': picks ' + x.picked.join(',') + ' are not the design\'s');
          if (HEAVENS.indexOf(x.opt.slot) < 0) bad.push(n + ' k=' + k + ': slot ' + x.opt.slot);
          const fill = ikLeft(x.opt.slot, x.opt.card.main, x.picked).slice(0, 4 - k);
          const c = ccCard(x.opt.slot, x.opt.set, x.opt.card.main, x.picked.concat(fill), 'typical');
          if (validateCard(c).length) bad.push(n + ' k=' + k + ': ' + validateCard(c)[0]);
          if (!(x.gain >= 0 && isFinite(x.gain))) bad.push(n + ' k=' + k + ': gain ' + x.gain);
          if (k && x.gain + 0.02 < r.byK[k - 1].gain) bad.push(n + ': picking ' + k + ' is worth less than ' + (k - 1));
        });
        if (!near(r.byK[4].gain, cc.gain, 1e-6)) bad.push(n + ': four picked ' + r.byK[4].gain + ' is not the Custom card view\'s ' + cc.gain);
        if (r.best !== r.byK[o.pick] || !near(r.after, Math.min(100, r.inv + r.gain), 1e-6)) bad.push(n + ': row gain/after');
        const g = r.range;
        if (!g || !(g.min <= g.lo && g.lo <= g.hi && g.hi <= g.max) || Math.abs(g.mean - r.gain) > 0.6 ||
          JSON.stringify(ccRange(ikOutcomes(r.ctx, r.best, null, IK_SAMPLES))) !== JSON.stringify(g)) bad.push(n + ': likely range');
      });
      fail('Ink card: each pick count gets a legal card whose picks are the Custom card design\'s, picking more is never worth less, all four picked is the Custom card view\'s gain, and the likely range sits around the gain and reads the same every run', !bad.length);
      if (bad.length) out.inkCardBad = bad.slice(0, 8);
    }

    // ---- Retrograde Card (reset a levelled card to level 0, keep its starting values, level it again) ----
    {
      const bad = [];
      // Every roll count is forced: one roll is the most each of the first three can hold, and the
      // ATK% total only fits six rolls (21.0: nine in all, dropped with four) or five (10.5: eight, dropped with three).
      const four = mk('Moon', 'Power', 'Damage Multiplier', [['Crit Rate', 2.0], ['Crit Multiplier', 4.1], ['Speed', 2.2], ['ATK%', 21.0]], { id: 'rg4' });
      const three = mk('Moon', 'Power', 'Damage Multiplier', [['Crit Rate', 2.0], ['Crit Multiplier', 4.1], ['Speed', 2.2], ['ATK%', 10.5]], { id: 'rg3' });
      const i4 = rgInfer(four), i3 = rgInfer(three);
      fail('Retrograde: a card\'s roll counts and whether it dropped with three or four substats are read from its values',
        i4.states.length && J(i4.states[0].k) === J([1, 1, 1, 6]) && i4.pLate < 1e-9 &&
        i3.states.length && i3.states.every(s => J(s.k) === J([1, 1, 1, 5])) && i3.pLate > 1 - 1e-9 && near(i4.states.reduce((a, s) => a + s.p, 0), 1, 1e-9),
        J({ i4: i4.states.slice(0, 2), i3: i3.states.slice(0, 2) }));
      const r4 = rgResets(four, i4, 200, 'random'), r3 = rgResets(three, i3, 200, 'random'), r3s = rgResets(three, i3, 200, 'same');
      [r4, r3, r3s].forEach(list => list.forEach(c => { const e = validateCard(c); if (e.length) bad.push(c.id + ': ' + e[0]); if (c.level !== 25) bad.push(c.id + ': level ' + c.level); }));
      // A card that dropped with four keeps all four, each starting from the one drop roll its value allows.
      if (!r4.every(c => J(c.subs.map(s => s.stat)) === J(four.subs.map(s => s.stat)) && c.subs.every((s, i) => s.value >= four.subs[i].value - 1e-9 || i === 3)))
        bad.push('dropped with four: a substat changed or fell below its drop roll');
      // 21.0 is six top rolls give or take the display rounding, so its drop roll is one of the top two tiers
      if (!r4.every(c => c.subs[3].value >= 3.2 - 1e-9)) bad.push('dropped with four: ATK% fell below a 3.2 drop roll');
      const names = list => new Set(list.map(c => c.subs.map(s => s.stat).sort().join(','))).size;
      if (!(names(r3) > 1)) bad.push('dropped with three: the fourth substat never changed with "random"');
      if (names(r3s) !== 1) bad.push('dropped with three: the substats changed with "same"');
      if (J(rgResets(four, i4, 200, 'random')) !== J(r4)) bad.push('resets differ between runs');
      if (rgKeeps(four, 50).length !== 1 || rgKeeps(Object.assign({}, four, { level: 15 }), 50).some(c => c.level !== 25)) bad.push('keeping a card levels it on to 25');
      if (rgCandidates().some(c => c.rarity !== 5 || upgradesUsed(5, c.level) < 1)) bad.push('a level-0 or non-5★ card is a candidate');
      // Upgrades piled on a stat the character ignores: a reset should pay off. All five on their best
      // stat at maximum: it should not.
      const ch = charDef(own[0]), t = target(ch), cx = Object.assign(rgCharCtx(ch, []), { worn: [] });   // nothing worn, nothing spare to fall back on
      const main = mainTop(t, 'Moon') || 'ATK%', f = couplingFactors(t, 'Moon', main);
      const ranked = Object.keys(SUBSTATS).filter(s => s !== main).sort((a, b) => (t.w[b] || 0) * cf(f, b) - (t.w[a] || 0) * cf(f, a));
      const top = ranked.slice(0, 3), dead = ranked[ranked.length - 1];
      const tier = (s, i) => ROLL_TIERS[s].heavens[i];
      const wasted = mk('Moon', t.sets[0], main, top.map(s => [s, tier(s, 4)]).concat([[dead, +(6 * tier(dead, 4)).toFixed(1)]]), { id: 'rgW' });
      const lucky = mk('Moon', t.sets[0], main, [[top[0], +(6 * tier(top[0], 4)).toFixed(1)]].concat(top.slice(1).concat([dead]).map(s => [s, tier(s, 0)])), { id: 'rgL' });
      const price = card => { const inf = rgInfer(card); return rgPrice(cx, card, rgKeeps(card, RG_SAMPLES), rgResets(card, inf, RG_SAMPLES, 'random')); };
      const pw = price(wasted), pl = price(lucky);
      if (!(pw.mean > 0 && pw.better > 0.5)) bad.push(`upgrades on ${dead}: average ${pw.mean.toFixed(2)}, better ${pw.better}`);
      if (!(pl.mean < 0 && pl.worse > 0.5)) bad.push(`upgrades on ${top[0]}: average ${pl.mean.toFixed(2)}, worse ${pl.worse}`);
      if (!pw.gains.every((g, i, a) => !i || a[i - 1] <= g) || !near(pw.mean, pw.gains.reduce((a, x) => a + x, 0) / pw.gains.length, 1e-9)) bad.push('gains not sorted or mean off');
      fail('Retrograde: resets are legal level-25 cards that keep the drop substats (re-rolling the fourth only on a three-substat drop, and only when asked), read the same every run, and pay off for wasted upgrades but not for lucky ones', !bad.length, J(bad.slice(0, 8)));
      if (bad.length) out.retroBad = bad.slice(0, 8);
    }

    // ---- Fortune Revelation (choose the set, the rest is random) ----
    {
      const drawBad = [];
      ['heavens', 'space'].forEach(kind => {
        const dr = frDraws(kind, 300), again = frDraws(kind, 300);
        if (JSON.stringify(dr) !== JSON.stringify(again)) drawBad.push(kind + ': draws differ between runs');
        dr.forEach((x, k) => {
          const card = { slot: x.slot, set: frSets(kind)[0], rarity: 5, level: RARITY[5].maxLevel, main: x.main, subs: x.subs };
          const st = x.subs.map(s => s.stat);
          if (frSlots(kind).indexOf(x.slot) < 0) drawBad.push(kind + ' #' + k + ': slot ' + x.slot);
          if (st.length !== 4 || new Set(st).size !== 4 || st.some(s => frNoSub(x.slot, x.main).indexOf(s) >= 0)) drawBad.push(kind + ' #' + k + ': substats ' + st.join(','));
          if (validateCard(card).length) drawBad.push(kind + ' #' + k + ': ' + validateCard(card)[0]);
        });
        if (frSets(kind).some(s => frSetTable(kind)[s].unreleased)) drawBad.push(kind + ': an unreleased set is offered');
      });
      const heav = frDraws('heavens', 2000);
      HEAVENS.forEach(sl => { const n = heav.filter(x => x.slot === sl).length; if (n < 400 || n > 600) drawBad.push(sl + ' drawn ' + n + ' of 2000'); });
      fail('Fortune Revelation: every draw is a legal level-25 5★ card of the item\'s slots, with four substats the slot can carry, the same every run, slots evenly spread', !drawBad.length);
      if (drawBad.length) out.fortuneDrawBad = drawBad.slice(0, 8);

      const o = { kind: 'heavens', policy: 'pref', free: true };
      const chars = own.slice(0, 5).map(charDef), draws = frDraws('heavens', 160);
      const datas = chars.map(ch => frCharData(ch, o));
      const rated = frSets('heavens').map(s => frRateSet(s, draws, datas)).sort((a, b) => b.value - a.value);
      const rateBad = [];
      rated.forEach(r => {
        const mean = r.vals.reduce((a, x) => a + x, 0) / r.vals.length;
        if (!near(mean, r.value, 1e-9) || r.vals.some(v => !(v >= 0) || !isFinite(v))) rateBad.push(r.set + ': value is not the mean of its draws');
        if (!near(r.who.reduce((a, w) => a + w.gets, 0), r.useful, 1e-9)) rateBad.push(r.set + ': who it goes to does not add up to how often it is useful');
        if (r.who.some(w => w.gets > w.helps + 1e-9 || !(w.avg >= UPGRADE_MIN_GAIN))) rateBad.push(r.set + ': goes to someone it does not help');
      });
      // A draw's gain to a character is the best of its loadouts, never below wearing it in the best they have now.
      const d0 = datas[0], probe = draws.map(x => ({ id: 'fortune', slot: x.slot, set: rated[0].set, rarity: 5, level: RARITY[5].maxLevel, main: x.main, subs: x.subs }));
      if (probe.some(c => d0.can[c.set][c.slot][c.main] && frGain(d0, c) + 1e-9 <
        Math.max(0, 100 * (d0.ctx.ev(d0.ctx.base.cards.filter(x => x.slot !== c.slot).concat([c])).total - d0.ctx.base.total) / d0.ctx.idealTotal))) rateBad.push('a gain is below a plain swap into the best loadout');
      fail('Fortune Revelation: a set\'s value is the average over its draws of the best gain, and who it goes to adds up to how often it is useful', !rateBad.length);
      if (rateBad.length) out.fortuneRateBad = rateBad.slice(0, 8);
      // Skipping draws no card of their kind could improve changes nothing.
      const always = new Proxy({}, { get: () => new Proxy({}, { get: () => new Proxy({}, { get: () => true }) }) });
      const loose = datas.map(d => Object.assign({}, d, { can: always }));
      fail('Fortune Revelation: skipping hopeless draws gives the same values as pricing every one',
        rated.slice(0, 6).every(r => near(frRateSet(r.set, draws, loose).value, r.value, 1e-9)));
      fail('Fortune Revelation: a set is as good as itself, and the best is not called close to a set worth nothing',
        frClose(rated[0], rated[0]) && (rated[0].value <= 0 || !frClose(rated[0], Object.assign({}, rated[0], { vals: rated[0].vals.map(() => 0) }))));

      const saved = Object.assign({}, frChosen);
      frChosen = {};
      const def = frChars().map(c => c.n).join('|') === ownedChars().map(c => c.n).join('|');
      const someone = ownedChars()[0], stranger = CHARACTERS.filter(c => !state.chars[c.n].owned)[0];
      frSetIncluded(someone.n, false); if (stranger) frSetIncluded(stranger.n, true);
      const changed = !frIncluded(someone) && (!stranger || frIncluded(stranger)) && Object.keys(frChosen).length === (stranger ? 2 : 1);
      const p = collectPrefs(); frChosen = {}; applyPrefs(p);
      const roundTrip = !frIncluded(someone) && (!stranger || frIncluded(stranger));
      frSetIncluded(someone.n, true);
      const backToDefault = !Object.prototype.hasOwnProperty.call(frChosen, someone.n);
      frChosen = saved;
      fail('Fortune Revelation: everyone owned and not benched counts by default, a tick or untick is kept only where it departs from that, and it survives a save',
        def && changed && backToDefault && roundTrip);
    }

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
    fail('an equip made while the Upgrades tab is hidden defers its pass, and opening the tab runs it', (() => {
      showTab('roster');
      const c = state.cards.find(x => x.equipped === 'Ren Amamiya');
      upViewsStale = false;
      const before = document.getElementById('upList').innerHTML;
      unequipCard(c.id);
      const deferred = upViewsStale === true && document.getElementById('upList').innerHTML === before;
      swapCard('Ren Amamiya', c.slot, c.id);
      showTab('upgrades');
      const ran = upViewsStale === false;
      showTab('roster');
      return deferred && ran && c.equipped === 'Ren Amamiya';
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
  await p.evaluate(() => { document.getElementById('rsFilter').value = 'all'; renderRoster(); });
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

  // Triage and Vault through their buttons. A run already exists, so opening the tab starts none
  // (the first-visit run has its own check below) and the click here is the button's own.
  await p.evaluate(() => { if (!trCache) runTriage(); });
  await p.click('nav button[data-tab="triage"]');
  // the button says so first and runs on the next frame; click and read in one task, or the
  // run can finish before a separate read arrives — then wait for the fresh summary, not a fixed delay
  const trBusy = await p.evaluate(() => { const b = document.getElementById('trRun'); const idle = !b.disabled; b.click();
    return idle && /Rating the inventory/.test(document.getElementById('trSummary').textContent) && b.disabled; });
  await p.waitForFunction(() => /Rated \d+/.test(document.getElementById('trSummary').textContent), null, { timeout: 20000 }).catch(() => {});
  const trRows = await p.evaluate(() => document.querySelectorAll('#trTable tbody tr').length);
  const trDone = await p.evaluate(() => !document.getElementById('trRun').disabled);
  check('Triage renders rows from its Run button, saying it is working first', trRows > 0 && trBusy && trDone, JSON.stringify({ trRows, trBusy, trDone }));
  // The Vault is Triage's second view now
  await p.click('#trSubtabs button[data-trtab="vault"]');
  await p.click('#vaRun'); await p.waitForTimeout(300);
  const vaRows = await p.evaluate(() => document.querySelectorAll('#vaTable tbody tr').length);
  check('Vault renders rows from its Run button, inside the Triage tab', vaRows > 0 &&
    await p.evaluate(() => !document.getElementById('tab-triage').classList.contains('hide') && !document.getElementById('tr-pane-vault').classList.contains('hide')));
  check('showTab("vault") still lands on the Vault, now Triage\'s "Lock for later" view', await p.evaluate(() => {
    showTab('roster'); showTab('vault');
    const ok = !document.getElementById('tab-triage').classList.contains('hide') && !document.getElementById('tr-pane-vault').classList.contains('hide') &&
      document.getElementById('tr-pane-feed').classList.contains('hide') && !document.querySelector('nav button[data-tab="vault"]');
    showTrPane('feed'); return ok;
  }));

  // Upgrades: both sub-tabs
  await p.click('nav button[data-tab="upgrades"]');
  await p.click('#upRun'); await p.waitForTimeout(300);
  const upState = await p.evaluate(() => ({ panels: document.querySelectorAll('#upList .panel').length, hidden: document.getElementById('upPanel').classList.contains('hide'), nan: document.getElementById('upList').innerHTML.indexOf('NaN') >= 0 }));
  check('Upgrades renders a panel per character with a better card, without NaN', !upState.nan && (upState.panels > 0 || upState.hidden), JSON.stringify(upState));
  await p.click('#upSubtabs button[data-uptab="headroom"]'); await p.waitForTimeout(400);
  const hrState = await p.evaluate(() => ({ rows: document.querySelectorAll('#hrTable tbody tr').length, cache: hrRowsCache.length, owned: ownedChars().length, nan: document.getElementById('hrTable').innerHTML.indexOf('NaN') >= 0 }));
  check('the Weakest slots sub-tab runs its pass on the way in (five rows per owned character)', hrState.cache === hrState.owned * 5 && hrState.rows > 0 && !hrState.nan, JSON.stringify(hrState));
  await p.click('#upSubtabs button[data-uptab="craft"]');
  await p.waitForFunction(() => ccCache, null, { timeout: 60000 });
  const ccState = await p.evaluate(() => ({ rows: document.querySelectorAll('#ccTable tbody tr').length, owned: ownedChars().length,
    first: /First card/.test(document.getElementById('ccSummary').innerHTML) && /likely \+\d/.test(document.getElementById('ccSummary').innerHTML),
    likely: document.querySelectorAll('#ccTable tbody tr').length === document.querySelectorAll('#ccTable td span[title^="8 in 10"]').length,
    chance: /^Chance this card ends up better than .*: \d{1,3}%/.test((document.querySelector('#ccCheckOut .ccChance') || {}).textContent.trim().replace(/\s+/g, ' ') || ''),
    checkRows: document.querySelectorAll('#ccCheckOut tbody tr').length,
    nan: /NaN|undefined/.test(document.getElementById('ccTable').innerHTML + document.getElementById('ccCheckOut').innerHTML + document.getElementById('ccSummary').innerHTML),
    sorted: ccCache.rows.every((r, i, a) => !i || a[i - 1].gain >= r.gain) }));
  check('the Custom card sub-tab ranks every owned character on the way in, largest gain first, names two cards and prices the check panel',
    ccState.rows === ccState.owned && ccState.first && ccState.likely && ccState.chance && ccState.checkRows === 3 && !ccState.nan && ccState.sorted, JSON.stringify(ccState));
  const ccFlow = await p.evaluate(() => {
    const r = { n: state.cards.length };
    document.querySelector('#ccTable .ccTry').click();
    r.filled = document.getElementById('ccChar').value === ccCache.rows[0].ch.n && document.getElementById('ccSlot').value === ccCache.rows[0].best.slot;
    document.getElementById('ccAdd').click();
    const added = state.cards[state.cards.length - 1];
    r.added = state.cards.length === r.n + 1 && added.level === 0 && added.rarity === 5 && !added.equipped && validateCard(added).length === 0;
    r.stale = !!document.querySelector('#ccSummary .stale-run');
    undo();
    r.undone = state.cards.length === r.n;
    r.fresh = !document.querySelector('#ccSummary .stale-run');
    document.getElementById('ccElement').value = ccCache.rows[0].ch.e; renderCustomCard();
    r.filtered = Array.from(document.querySelectorAll('#ccTable tbody tr')).length === ccCache.rows.filter(x => x.ch.e === ccCache.rows[0].ch.e).length;
    document.getElementById('ccElement').value = ''; renderCustomCard();
    return r;
  });
  const ccSpace = await p.evaluate(async () => {
    const k = document.getElementById('ccKind');
    k.value = 'space'; k.dispatchEvent(new Event('change'));
    while (!ccCache || ccCache.o.kind !== 'space') await new Promise(res => setTimeout(res, 50));
    const r = { allSpace: ccCache.rows.every(x => !x.best || x.best.slot === 'Space'), header: /Other Space sets/.test(document.getElementById('ccTable').innerHTML),
      checkSlot: document.getElementById('ccSlot').value, checkSet: !!SPACE_SETS[document.getElementById('ccSet').value],
      checkRows: document.querySelectorAll('#ccCheckOut tbody tr').length, nan: /NaN|undefined/.test(document.getElementById('ccTable').innerHTML + document.getElementById('ccCheckOut').innerHTML) };
    k.value = 'heavens'; k.dispatchEvent(new Event('change'));
    while (!ccCache || ccCache.o.kind !== 'heavens') await new Promise(res => setTimeout(res, 50));
    r.back = document.getElementById('ccSlot').value !== 'Space';
    return r;
  });
  check('Custom card: the card type switches the ranking and the check panel to Space cards and back',
    ccSpace.allSpace && ccSpace.header && ccSpace.checkSlot === 'Space' && ccSpace.checkSet && ccSpace.checkRows === 3 && !ccSpace.nan && ccSpace.back, JSON.stringify(ccSpace));
  check('Custom card: "Check a roll" fills the check panel, "Add to inventory" adds a level-0 card and marks the ranking stale, undo takes both back, and the element filter narrows the table',
    ccFlow.filled && ccFlow.added && ccFlow.stale && ccFlow.undone && ccFlow.fresh && ccFlow.filtered, JSON.stringify(ccFlow));
  await p.click('#upSubtabs button[data-uptab="ink"]');
  await p.waitForFunction(() => ikCache, null, { timeout: 60000 });
  const ikState = await p.evaluate(() => {
    const html = () => document.getElementById('ikSummary').innerHTML + document.getElementById('ikTable').innerHTML + document.getElementById('ikCheckOut').innerHTML;
    const r = { rows: document.querySelectorAll('#ikTable tbody tr').length, owned: ownedChars().length,
      ladder: document.querySelectorAll('#ikSummary tbody tr').length, sorted: ikCache.rows.every((x, i, a) => !i || a[i - 1].gain >= x.gain),
      likely: document.querySelectorAll('#ikTable tbody tr').length === document.querySelectorAll('#ikTable td span[title^="8 in 10"]').length,
      needsAll: /Enter all four substats/.test(document.getElementById('ikCheckOut').textContent), nan: /NaN|undefined/.test(html()) };
    // A click on another row puts that character in the table above; its buttons do not, and Enter does.
    const focusName = () => (document.querySelector('#ikFocusBox b') || {}).textContent;
    const rowsEl = [...document.querySelectorAll('#ikTable tr.ikRow')];
    r.focusTop = focusName() === ikCache.rows[0].ch.n && rowsEl[0].classList.contains('on');
    if (rowsEl.length > 2) {
      rowsEl[1].querySelector('td').click();
      const second = rowsEl[1].dataset.char;
      r.focusClick = focusName() === second && rowsEl[1].classList.contains('on') && !rowsEl[0].classList.contains('on') &&
        document.querySelectorAll('#ikFocusBox tbody tr').length === 5 &&
        document.querySelector('#ikFocusBox').innerHTML.indexOf('+' + ikCache.rows.find(x => x.ch.n === second).byK[4].gain.toFixed(1)) >= 0;
      rowsEl[2].querySelector('.ikOpt').onclick = () => {};   // keep the popup shut; the row must still ignore the click
      rowsEl[2].querySelector('.ikOpt').click();
      r.focusButton = focusName() === second;
      rowsEl[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      r.focusKey = focusName() === rowsEl[2].dataset.char;
      renderInkCard();
      r.focusKept = focusName() === rowsEl[2].dataset.char && document.querySelector('#ikTable tr.ikRow.on').dataset.char === rowsEl[2].dataset.char;
      rowsEl[0].click();
    } else Object.assign(r, { focusClick: true, focusButton: true, focusKey: true, focusKept: true });
    // Fill the two random substats in, then put the first picked one on its lowest roll and the other on its highest.
    const first = ikCache.rows[0], picked = first.best.picked, slot = first.best.opt.slot;
    const free = ikLeft(slot, first.best.opt.card.main, picked);
    const subs = [0, 1, 2, 3].map(i => i < picked.length
      ? { stat: picked[i], value: ccTiers(picked[i], slot)[i === 0 ? 0 : 4], picked: true }
      : { stat: free[i - picked.length], value: ccTiers(free[i - picked.length], slot)[2], picked: false });
    ikRenderSubs(subs); ikCheck();
    const advice = (document.querySelector('#ikCheckOut .ikAdvice') || {}).textContent || '';
    r.lowRerolled = picked.length > 0 && new RegExp('Re-roll ' + picked[0].replace(/[%]/g, '.')).test(advice);
    r.checkRows = document.querySelectorAll('#ikCheckOut tbody tr').length === picked.length;
    ikRenderSubs(subs.map(s => s.picked ? Object.assign({}, s, { value: ccTiers(s.stat, slot)[4] }) : s)); ikCheck();
    r.keepTop = /Keep it/.test((document.querySelector('#ikCheckOut .ikAdvice') || {}).textContent || '');
    const n = state.cards.length;
    document.getElementById('ikAdd').click();
    r.added = state.cards.length === n + 1 && state.cards[n].level === 0 && validateCard(state.cards[n]).length === 0;
    r.stale = !!document.querySelector('#ikSummary .stale-run');
    undo();
    r.undone = state.cards.length === n && !document.querySelector('#ikSummary .stale-run');
    r.nan = r.nan || /NaN|undefined/.test(html());
    return r;
  });
  check('Ink card: the sub-tab ranks every owned character on the way in, shows what each extra pick adds, and the check panel re-rolls a picked substat on its lowest roll and keeps one on its highest; adding the card marks the ranking stale and undo takes it back',
    ikState.rows === ikState.owned && ikState.ladder === 5 && ikState.sorted && ikState.likely && ikState.needsAll && ikState.lowRerolled && ikState.checkRows &&
    ikState.keepTop && ikState.added && ikState.stale && ikState.undone && !ikState.nan, JSON.stringify(ikState));
  check('Ink card: the table of what more or fewer picks add follows the clicked row (or Enter on it), not its buttons, and survives a redraw',
    ikState.focusTop && ikState.focusClick && ikState.focusButton && ikState.focusKey && ikState.focusKept, JSON.stringify(ikState));
  await p.click('#upSubtabs button[data-uptab="fortune"]');
  await p.waitForFunction(() => frCache, null, { timeout: 60000 });
  const frState = await p.evaluate(async () => {
    const html = () => document.getElementById('frSummary').innerHTML + document.getElementById('frTable').innerHTML;
    const r = { rows: document.querySelectorAll('#frTable > tbody > tr').length, sets: frSets('heavens').length,
      counted: frCache.chars.length === ownedChars().length, boxes: document.querySelectorAll('#frCharList input[data-fr]').length === CHARACTERS.length,
      ticked: document.querySelectorAll('#frCharList input[data-fr]:checked').length === ownedChars().length,
      pick: /Pick this set/.test(document.getElementById('frSummary').innerHTML) || /No set/.test(document.getElementById('frSummary').innerHTML),
      sorted: frCache.rated.every((x, i, a) => !i || a[i - 1].value >= x.value), nan: /NaN|undefined/.test(html()) };
    const box = document.querySelector('#frCharList input[data-fr]:checked');
    box.checked = false; box.dispatchEvent(new Event('change'));
    r.stale = !!document.querySelector('#frSummary .stale-run');
    box.checked = true; box.dispatchEvent(new Event('change'));
    r.fresh = !document.querySelector('#frSummary .stale-run');
    const k = document.getElementById('frKind');
    k.value = 'space'; k.dispatchEvent(new Event('change'));
    while (!frCache || frCache.o.kind !== 'space') await new Promise(res => setTimeout(res, 50));
    r.space = document.querySelectorAll('#frTable > tbody > tr').length === frSets('space').length && !/By slot/.test(document.getElementById('frTable').innerHTML) && !/NaN|undefined/.test(html());
    k.value = 'heavens'; k.dispatchEvent(new Event('change'));
    while (!frCache || frCache.o.kind !== 'heavens') await new Promise(res => setTimeout(res, 50));
    return r;
  });
  check('Fortune Revelation: the sub-tab ranks every released set on the way in for everyone owned and not benched, best first; unticking a character marks it stale, and Orange switches to Space sets',
    frState.rows === frState.sets && frState.counted && frState.boxes && frState.ticked && frState.pick && frState.sorted && !frState.nan &&
    frState.stale && frState.fresh && frState.space, JSON.stringify(frState));
  // Retrograde Card: a levelled spare card whose five upgrades all went to flat HP is added first,
  // since the synthetic inventory's values are not drawn from the roll tables.
  await p.evaluate(() => {
    state.cards.push({ id: 'rgTest', slot: 'Moon', set: Object.keys(SETS).filter(s => !SETS[s].elem)[0], rarity: 5, level: 25, main: 'ATK%', equipped: null,
      subs: [{ stat: 'Crit Rate', value: 2.0 }, { stat: 'Crit Multiplier', value: 4.1 }, { stat: 'Speed', value: 2.2 }, { stat: 'HP', value: 840 }] });
    commit();
  });
  await p.click('#upSubtabs button[data-uptab="retro"]');
  await p.waitForFunction(() => rgCache, null, { timeout: 60000 });
  const rgState = await p.evaluate(async () => {
    const html = () => document.getElementById('rgSummary').innerHTML + document.getElementById('rgTable').innerHTML;
    const drawn = () => document.querySelectorAll('#rgTable > tbody > tr').length;
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change')); };
    const r = { rated: rgCache.rows.length, test: rgCache.rows.some(x => x.card.id === 'rgTest'),
      sorted: rgCache.rows.every((x, i, a) => !i || a[i - 1].p.mean >= x.p.mean),
      gainRows: drawn() === rgCache.rows.filter(x => x.p.mean >= UPGRADE_MIN_GAIN).length, nan: /NaN|undefined/.test(html()) };
    set('rgShow', 'all');
    r.allRows = drawn() === rgCache.rows.length;
    set('rgSlot', 'Moon');
    r.slot = drawn() === rgCache.rows.filter(x => x.card.slot === 'Moon').length && drawn() > 0;
    set('rgSlot', ''); set('rgShow', 'gain');
    const card = state.cards.find(c => c.id === 'rgTest');
    card.level = 20; commit();
    r.stale = !!document.querySelector('#rgSummary .stale-run');
    card.level = 25; commit();
    r.fresh = !document.querySelector('#rgSummary .stale-run');
    set('rgFourth', 'same');
    while (!rgCache || rgCache.o.fourth !== 'same') await new Promise(res => setTimeout(res, 50));
    r.same = rgCache.rows.some(x => x.card.id === 'rgTest') && !/NaN|undefined/.test(html());
    set('rgFourth', 'random');
    while (!rgCache || rgCache.o.fourth !== 'random') await new Promise(res => setTimeout(res, 50));
    state.cards = state.cards.filter(c => c.id !== 'rgTest'); commit();
    return r;
  });
  check('Retrograde Card: the sub-tab rates every levelled 5★ card on the way in, largest average gain first; Show, Slot and the staleness banner work, and the fourth-substat rule re-runs it',
    rgState.rated > 0 && rgState.test && rgState.sorted && rgState.gainRows && !rgState.nan && rgState.allRows && rgState.slot &&
    rgState.stale && rgState.fresh && rgState.same, JSON.stringify(rgState));

  // Targets dialog: open, save, reset. The Setup is edited in one place, the Loadout popup; the
  // Targets dialog used to carry a second copy that saved on its own button.
  await p.click('nav button[data-tab="roster"]');
  await p.evaluate(() => editTargets('Hatsune Miku'));   // has stat targets, so the dialog shows her Setup line
  await p.waitForTimeout(150);
  const dlgOpen = await p.evaluate(() => document.getElementById('dlg').open && !!document.getElementById('tSave') &&
    !document.getElementById('lWeapon') && !!document.getElementById('tOpenSetup'));
  check('the Targets dialog opens without a second Setup editor, and links to the Loadout popup for it', dlgOpen);
  await p.evaluate(() => { document.getElementById('tMMoon2').value = 'HP%'; document.getElementById('tSave').click(); });
  await p.waitForTimeout(150);
  const savedT = await p.evaluate(() => { const t = state.chars['Hatsune Miku'].targets; return { moon: t && t.main.Moon, closed: !document.getElementById('dlg').open, stamped: target(charDef('Hatsune Miku')).n }; });
  check('saving targets stores a best-first main list', savedT.moon && savedT.moon.length === 3 && savedT.moon[2] === 'HP%' && savedT.closed && savedT.stamped === 'Hatsune Miku', JSON.stringify(savedT));
  const setupSaved = await p.evaluate(() => {
    editTargets('Hatsune Miku'); document.getElementById('tOpenSetup').click();
    const body = document.getElementById('dlgBody');
    const r = { inPopup: body.dataset.view === 'loadout' && body.dataset.name === 'Hatsune Miku' && !!document.getElementById('lRefine') };
    const sel = document.getElementById('lRefine'); sel.value = '5'; sel.dispatchEvent(new Event('change'));
    Object.assign(r, { refine: charLoadout('Hatsune Miku').refine, stillOpen: document.getElementById('dlg').open,
      setupKeptOpen: !!document.querySelector('#dlgBody details.sect[data-k="setup"][open]'), targetsKept: !!state.chars['Hatsune Miku'].targets });
    document.getElementById('dlg').close(); return r;
  });
  check('the Setup link opens the Loadout popup, whose fields save on change, keep the popup and its open section, and leave the target alone',
    setupSaved.inPopup && setupSaved.refine === 5 && setupSaved.stillOpen && setupSaved.setupKeptOpen && setupSaved.targetsKept, JSON.stringify(setupSaved));
  const editedOnly = await p.evaluate(() => { const t = state.chars['Hatsune Miku'].targets; editTargets('Hatsune Miku');
    const r = { keys: Object.keys(t).sort().join(','), slots: Object.keys(t.main).join(','), hint: /data: ATK% \/ Damage Multiplier/.test(document.getElementById('dlgBody').innerHTML) };
    document.getElementById('dlg').close(); return r; });
  check('the save keeps only the edit (the Moon list) and the dialog shows the data\'s value beside it', editedOnly.keys === 'main,v' && editedOnly.slots === 'Moon' && editedOnly.hint, JSON.stringify(editedOnly));
  await p.evaluate(() => { editTargets('Hatsune Miku'); document.getElementById('tReset').click(); });
  await p.waitForTimeout(100);
  check('"Reset to default" clears the saved target, keeps the Setup, and offers undo', await p.evaluate(() => state.chars['Hatsune Miku'].targets === null &&
    state.chars['Hatsune Miku'].loadout && state.chars['Hatsune Miku'].loadout.refine === 5 && !document.getElementById('dlg').open &&
    !document.getElementById('toast').classList.contains('hide') && !!undoSnap));
  check('undo brings the reset target back, and a second undo has nothing left to take', await p.evaluate(() => {
    document.getElementById('toastUndo').click();
    const t = state.chars['Hatsune Miku'].targets;
    const back = !!t && t.main.Moon.length === 3 && document.getElementById('toast').classList.contains('hide') && undoSnap === null;
    undo();   // nothing to undo: a no-op
    const still = !!state.chars['Hatsune Miku'].targets;
    editTargets('Hatsune Miku'); document.getElementById('tReset').click(); hideToast();
    return back && still && state.chars['Hatsune Miku'].targets === null;
  }));
  check('a Setup change in the Loadout popup stores no target, so the character keeps following the data',
    await p.evaluate(() => {
      openLoadout('Hatsune Miku');
      const sel = document.getElementById('lRefine'); sel.value = '3'; sel.dispatchEvent(new Event('change'));
      document.getElementById('dlg').close();
      return state.chars['Hatsune Miku'].targets === null && charLoadout('Hatsune Miku').refine === 3;
    }));
  const teamCritUi = await p.evaluate(() => {
    const input = document.getElementById('rsTeamCrit'), ren = charDef('Ren Amamiya');
    const r = { field: input.value, before: buildScoreOf(ren, state.cards.filter(c => c.equipped === ren.n)).raw };
    runTriage();
    input.value = '25'; input.dispatchEvent(new Event('change'));
    r.state = state.teamCrit; r.after = buildScoreOf(ren, state.cards.filter(c => c.equipped === ren.n)).raw;
    r.stale = !!document.querySelector('#trSummary .stale-tc');
    input.value = '250'; input.dispatchEvent(new Event('change')); r.clamped = state.teamCrit;
    input.value = '0'; input.dispatchEvent(new Event('change'));
    r.backToZero = state.teamCrit === 0 && !document.querySelector('#trSummary .stale-tc');
    return r;
  });
  check('the Roster\'s team crit rate starts at 0, reprices a build when changed, clamps to 100 and flags a Triage run scored at the old value',
    teamCritUi.field === '0' && teamCritUi.state === 25 && Math.abs(teamCritUi.after - teamCritUi.before) > 1e-9 && teamCritUi.stale && teamCritUi.clamped === 100 && teamCritUi.backToZero,
    JSON.stringify(teamCritUi));
  const anyMain = await p.evaluate(() => { editTargets('Chizuko Nagao'); const sel = document.getElementById('tMMoon0');
    const r = { v: sel.value, label: sel.options[sel.selectedIndex].text }; document.getElementById('tSave').click();
    return Object.assign(r, { saved: state.chars['Chizuko Nagao'].targets }); });
  check('an open slot reads "any" in the Targets dialog, and saving it unchanged stores no target', anyMain.v === '' && anyMain.label === 'any' && anyMain.saved === null, JSON.stringify(anyMain));

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

  /* ================================================================================
     11. The page's safety net and layout (the Sep 2026 UI pass). Each of these was a real
         defect on the user's 4000-card save, or is the invariant a fix rests on.
     ================================================================================ */
  const noCjk = await p.evaluate(() => {
    const re = /[가-힣ᄀ-ᇿ㄰-㆏぀-ヿ一-鿿]/, bad = [];
    const walk = (v, where) => {
      if (typeof v === 'string') { if (re.test(v)) bad.push(where); }
      else if (v && typeof v === 'object') Object.keys(v).forEach(k => walk(v[k], where + '.' + k));
    };
    walk(CHARACTERS, 'CHARACTERS'); walk(SETS, 'SETS'); walk(SPACE_SETS, 'SPACE_SETS'); walk(CHAR_STATS, 'CHAR_STATS');
    return bad;
  });
  check('no character, set, Space card or stat text the page shows carries Korean or Japanese script', noCjk.length === 0, noCjk.slice(0, 3).join(' | '));
  const tiles = await p.evaluate(() => {
    let nulls = 0, notNeeded = 0;
    CHARACTERS.forEach(c => {
      const t = target(c), h = statsSummaryHtml(c, [], charLoadout(c.n), false, idealLoadout(c, t, 55).cards);
      if (/width:null/.test(h)) nulls++;
      if (/not in the perfect build/.test(h)) notNeeded++;
    });
    return { nulls, notNeeded };
  });
  check('a stat the perfect build carries none of reads "not in the perfect build", never a full bar from width:null%', tiles.nulls === 0 && tiles.notNeeded > 0, JSON.stringify(tiles));

  const saveUi = await p.evaluate(() => {
    markSaved();
    const st = () => document.getElementById('saveState').textContent;
    const r = { clean0: !isDirty() && !/Unsaved/.test(st()) };
    toggleOwned('Aigis');
    r.dirty = isDirty() && /Unsaved changes/.test(st()) && document.getElementById('hdrSave').classList.contains('primary');
    r.toast = !document.getElementById('toast').classList.contains('hide');
    undo();
    r.cleanAgain = !isDirty() && !/Unsaved/.test(st()) && state.chars['Aigis'].owned === false;
    return r;
  });
  check('the header says when there are unsaved changes, and an undo back to the saved state clears it', saveUi.clean0 && saveUi.dirty && saveUi.toast && saveUi.cleanAgain, JSON.stringify(saveUi));

  const delUi = await p.evaluate(() => {
    showTab('inv');
    const n0 = state.cards.length, c = state.cards.find(x => x.equipped === 'Ren Amamiya');
    document.getElementById('flQ').value = 'Ren Amamiya'; renderInv();
    const chip = () => document.querySelector('#rsGrid .cc[data-ch="Ren Amamiya"] .tag.bs').getAttribute('title');
    const before = chip();
    document.querySelector(`#invTable [data-del="${c.id}"]`).click();
    const r = { gone: !state.cards.some(x => x.id === c.id) && state.cards.length === n0 - 1, rosterRedrawn: chip() !== before,
      toast: /Deleted/.test(document.getElementById('toastMsg').textContent) && !document.getElementById('toast').classList.contains('hide') };
    document.getElementById('toastUndo').click();
    const back = state.cards.find(x => x.id === c.id);
    r.restored = !!back && back.equipped === 'Ren Amamiya' && state.cards.length === n0 && chip() === before;
    document.getElementById('flQ').value = ''; renderInv();
    return r;
  });
  check('deleting a card from the Inventory redraws the Roster too, and offers an undo that brings it back where it was', delUi.gone && delUi.rosterRedrawn && delUi.toast && delUi.restored, JSON.stringify(delUi));

  const staleUi = await p.evaluate(() => {
    runTriage();
    const r = { fresh: !document.querySelector('#trSummary .stale-run') };
    const c = state.cards.find(x => x.equipped === 'Morgana' && x.slot === 'Sun' && !x.locked);
    unequipCard(c.id);
    r.stale = !!document.querySelector('#trSummary .stale-run') && !document.querySelector('#trSummary .stale-tc');
    swapCard('Morgana', 'Sun', c.id);
    r.freshAgain = !document.querySelector('#trSummary .stale-run');
    return r;
  });
  check('a Triage run says it is stale after any change it read (an unequip), and not once the change is put back', staleUi.fresh && staleUi.stale && staleUi.freshAgain, JSON.stringify(staleUi));

  const vaultStale = await p.evaluate(() => {
    runVault();
    const banner = () => !!document.querySelector('#vaSummary .stale-run');
    const worn = state.cards.find(x => x.equipped && !x.locked), who = worn.equipped;
    unequipCard(worn.id);
    const r = { afterUnequip: banner() };     // the Vault never reads who wears a card
    swapCard(who, worn.slot, worn.id);
    const c = state.cards.find(x => x.subs && x.subs.length);
    c.subs[0].value = +(c.subs[0].value + 0.1).toFixed(1); commit();
    r.afterRoll = banner();                    // ...but it does read the card itself
    c.subs[0].value = +(c.subs[0].value - 0.1).toFixed(1); commit();
    r.afterRevert = banner();
    return r;
  });
  check('the Vault is not marked stale by an equip it never reads, and is by a change to a card', !vaultStale.afterUnequip && vaultStale.afterRoll && !vaultStale.afterRevert, JSON.stringify(vaultStale));

  const undoExpiry = await p.evaluate(() => {
    const before = snapshotState();
    const c = state.cards.find(x => !x.equipped);
    deleteCard(c.id);
    const r = { offered: !!undoSnap };
    // a later change that offers no undo of its own: the delete's undo must not survive it, or
    // pressing it would silently revert this change too
    openLoadout('Ren Amamiya');
    const sel = document.getElementById('lRefine'); sel.value = sel.value === '7' ? '6' : '7'; sel.dispatchEvent(new Event('change'));
    document.getElementById('dlg').close();
    r.expired = undoSnap === null && document.getElementById('toast').classList.contains('hide');
    undoSnap = before; undo();                 // put everything back for the checks below
    r.restored = state.cards.some(x => x.id === c.id);
    return r;
  });
  check('an undo is only offered until the next change, so it can never revert a later edit', undoExpiry.offered && undoExpiry.expired && undoExpiry.restored, JSON.stringify(undoExpiry));

  const optPick = await p.evaluate(() => {
    const sel = () => document.getElementById('optChar').value;
    openCharacterDetail('Aigis');                                      // not owned: a roster click-through
    const c = state.cards.find(x => x.equipped && !x.locked), who = c.equipped;
    unequipCard(c.id); swapCard(who, c.slot, c.id);                    // two commits
    const r = { forcedHolds: sel() === 'Aigis' };
    const opt = document.getElementById('optChar'); opt.value = 'Ren Amamiya'; opt.dispatchEvent(new Event('change'));
    toggleBenched('Ren Amamiya');                                      // benching the one being looked at
    r.benchedLeaves = sel() !== 'Ren Amamiya' && !/not owned/.test(opt.options[opt.selectedIndex].text);
    toggleBenched('Ren Amamiya'); hideToast(); showTab('roster');
    return r;
  });
  check('Optimise holds a character it was sent to, but an ordinary pick follows the owned list', optPick.forcedHolds && optPick.benchedLeaves, JSON.stringify(optPick));

  const loSect = await p.evaluate(() => {
    const secOpen = k => !!document.querySelector(`#dlgBody details.sect[data-k="${k}"][open]`);
    openLoadout('Ren Amamiya');
    document.querySelector('#dlgBody details.sect[data-k="stats"]').open = true;
    document.querySelector('#dlgBody [data-pick-slot]').click();      // to the card picker...
    document.getElementById('cpBack').click();                        // ...and back
    const r = { statsKept: secOpen('stats') };
    // a character whose Setup was saved, with the section collapsed: the Setup link still opens it
    openLoadout('Hatsune Miku');
    document.querySelector('#dlgBody details.sect[data-k="setup"]').open = false;
    document.getElementById('dlg').close();
    editTargets('Hatsune Miku'); document.getElementById('tOpenSetup').click();
    r.linkOpensSetup = !setupIsDefault('Hatsune Miku') && secOpen('setup');
    document.getElementById('dlg').close();
    return r;
  });
  check('the Loadout popup keeps its open sections through the card picker, and a Setup link opens the Setup', loSect.statsKept && loSect.linkOpensSetup, JSON.stringify(loSect));

  const sameScore = await p.evaluate(() => {
    openLoadout('Ren Amamiya');
    const block = [...document.querySelectorAll('#dlgBody .loadout .lo')].find(b => b.querySelector('[data-edit-slot]'));
    const sl = block.querySelector('[data-edit-slot]').dataset.editSlot;
    const popup = block.querySelector('h4 .score').textContent.trim();
    openCardPicker('Ren Amamiya', sl);
    const picker = document.querySelector('#dlgBody .pick tr.cur td.score').textContent.trim();
    document.getElementById('dlg').close();
    return { sl, popup, picker };
  });
  check('an equipped card reads the same score in the Loadout popup and in the card picker it opens', sameScore.popup === sameScore.picker, JSON.stringify(sameScore));

  /* confirm() answers an instant false in a sandboxed frame without allow-modals, which would
     make Load do nothing whenever there is unsaved work, so the question is asked in the toast. */
  const askUi = await p.evaluate(() => {
    const snap = snapshotState();
    toggleBenched('Ren Amamiya');                                    // something unsaved
    const fi = document.getElementById('fileIn'); let picked = 0; fi.click = () => { picked++; };
    requestLoad();
    const r = { asked: !document.getElementById('toast').classList.contains('hide') &&
      document.getElementById('toastUndo').textContent === 'Load anyway' && picked === 0 };
    document.getElementById('toastUndo').click();
    r.yesOpensPicker = picked === 1;
    markSaved(); requestLoad(); r.noQuestionWhenSaved = picked === 2;
    delete fi.click; undoSnap = snap; undo();
    return r;
  });
  check('Load over unsaved changes asks in the toast, and its button opens the file picker; with nothing unsaved it just opens',
    askUi.asked && askUi.yesOpensPicker && askUi.noQuestionWhenSaved, JSON.stringify(askUi));

  const bindUi = await p.evaluate(() => {
    showTab('inv'); renderInv(); renderRoster();   // the Roster drawn last used to capture Inventory's Edit buttons
    document.querySelector('#invTable [data-edit]').click();
    const view = () => document.getElementById('dlg').open && document.getElementById('dlgBody').dataset.view;
    const r = { invEdit: view() === 'card' };
    document.getElementById('dlg').close();
    renderRoster(); renderInv();                     // ...and the Inventory drawn last, the Roster's Targets buttons
    document.querySelector('#rsGrid [data-edit]').click();
    r.rosterTargets = view() === 'targets';
    document.getElementById('dlg').close();
    const was = { tr: trSort.key, trDir: trSort.dir, inv: invSort.key };
    document.querySelector('#trTable th.sortH[data-sort="set"] button').click();
    r.triageSorted = trSort.key === 'set' && invSort.key === was.inv;
    trSort.key = was.tr; trSort.dir = was.trDir; renderTriageTable();
    return r;
  });
  check('every table and grid binds its own buttons: Inventory Edit, Roster Targets and a Triage column header each do their own job', bindUi.invEdit && bindUi.rosterTargets && bindUi.triageSorted, JSON.stringify(bindUi));

  const chipUi = await p.evaluate(() => {
    trVerdictSel = []; renderTriageTable();
    const chip = [...document.querySelectorAll('#trChips [data-tier]')].find(b => !b.disabled);
    const tier = +chip.dataset.tier, count = +chip.querySelector('b').textContent;
    chip.click();
    const shown = parseInt(document.getElementById('trFlCount').textContent, 10);
    const want = trCache.rated.filter(x => trTier(x) === tier).length;
    const r = { tier, count, shown, want, pressed: document.querySelector(`#trChips [data-tier="${tier}"]`).getAttribute('aria-pressed') === 'true' };
    document.querySelector(`#trChips [data-tier="${tier}"]`).click();
    r.cleared = trVerdictSel.length === 0;
    return r;
  });
  check('a Triage verdict chip counts its verdict and narrows the table to it', chipUi.count === chipUi.want && chipUi.shown === chipUi.want && chipUi.pressed && chipUi.cleared, JSON.stringify(chipUi));

  await p.evaluate(() => { showTab('roster'); trCache = null; vaCache = null; document.getElementById('trPanel').classList.add('hide'); document.getElementById('trSummary').innerHTML = ''; });
  await p.click('nav button[data-tab="triage"]');
  await p.waitForFunction(() => /Rated \d+/.test(document.getElementById('trSummary').textContent), null, { timeout: 20000 }).catch(() => {});
  check('Triage runs by itself the first time it is opened, and so does its Lock for later view', await p.evaluate(() => {
    const ran = !!trCache && document.querySelectorAll('#trTable tbody tr').length > 0;
    showTrPane('vault'); const vault = !!vaCache && document.querySelectorAll('#vaTable tbody tr').length > 0;
    showTrPane('feed'); return ran && vault;
  }));

  const dlgClick = await p.evaluate(() => {
    editCard(state.cards[0].id);
    const d = document.getElementById('dlg'), rc = d.getBoundingClientRect();
    d.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rc.left + 6, clientY: rc.top + 6 }));   // its own padding
    const stays = d.open;
    d.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 }));                       // the backdrop
    return { stays, closes: !d.open };
  });
  check('a click in the dialog\'s own padding leaves it open; a click on the backdrop closes it', dlgClick.stays && dlgClick.closes, JSON.stringify(dlgClick));

  const a11y = await p.evaluate(() => {
    showTab('roster'); renderRoster();
    const fields = [...document.querySelectorAll('main .field')].filter(f => f.querySelector('input, select, textarea'));
    const unlinked = fields.filter(f => { const l = f.querySelector('label'); return !l || !l.htmlFor || !document.getElementById(l.htmlFor); });
    const heads = [...document.querySelectorAll('th.sortH')];
    const cards = document.querySelectorAll('#rsGrid .cc');
    return { fields: fields.length, unlinked: unlinked.length, heads: heads.length,
      buttons: heads.filter(h => h.querySelector('button.thBtn') && h.hasAttribute('aria-sort')).length,
      cardsFocusable: cards.length > 0 && [...cards].every(c => c.tabIndex === 0 && c.getAttribute('role') === 'button') };
  });
  check('every field has a linked label, every sortable header is a button with aria-sort, and roster cards are focusable buttons',
    a11y.fields > 20 && a11y.unlinked === 0 && a11y.heads > 0 && a11y.buttons === a11y.heads && a11y.cardsFocusable, JSON.stringify(a11y));

  const kb = await p.evaluate(() => {
    const card = document.querySelector('#rsGrid .cc[data-ch]');
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const body = document.getElementById('dlgBody');
    const r = { opened: document.getElementById('dlg').open && body.dataset.view === 'loadout' && body.dataset.name === card.dataset.ch };
    const lo = body.querySelector('.loadout'), setup = body.querySelector('details.sect[data-k="setup"]');
    r.cardsFirst = !!lo && !!setup && !!(lo.compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING);
    document.getElementById('dlg').close();
    return r;
  });
  check('Enter on a roster card opens its Loadout popup, which shows the five cards before the Setup', kb.opened && kb.cardsFirst, JSON.stringify(kb));

  const listUi = await p.evaluate(() => {
    rosterView = 'list'; renderRoster();
    const r = { rows: document.querySelectorAll('#rsList tr.rrow').length, shown: parseInt(document.getElementById('rsCount').textContent, 10),
      gridEmpty: document.getElementById('rsGrid').children.length === 0, panel: !document.getElementById('rsListPanel').classList.contains('hide') };
    document.querySelector('#rsList tr.rrow').click();
    r.opens = document.getElementById('dlg').open; document.getElementById('dlg').close();
    rosterView = 'cards'; renderRoster();
    return r;
  });
  check('the Roster\'s list view draws one row per character shown, and a row opens the Loadout popup', listUi.rows === listUi.shown && listUi.gridEmpty && listUi.panel && listUi.opens, JSON.stringify(listUi));
  check('a save that ticked the old "Hide not owned" box opens the Roster on owned characters', await p.evaluate(() => {
    const was = document.getElementById('rsFilter').value;
    document.getElementById('rsFilter').value = 'all'; applyPrefs({ rsHideUnowned: true });
    const ok = document.getElementById('rsFilter').value === 'owned';
    document.getElementById('rsFilter').value = was; renderRoster(); return ok;
  }));

  const optUi = await p.evaluate(() => {
    const n = 'Makoto Yuki';
    renderOpt(n); optStale = false; showTab('opt'); runOpt();
    const panels = [...document.querySelectorAll('#optOut > .panel')];
    const plans = panels.filter(pn => /Other set plans considered/.test(pn.textContent))
      .flatMap(pn => [...pn.querySelectorAll('tbody td.score')].map(td => parseFloat(td.textContent)));
    // the first alternative's figure is the build score its own five cards would earn
    const ch = charDef(n), t = target(ch), P4 = +document.getElementById('optP4').value;
    const rr = bestPlan(ch, poolFor(document.getElementById('optPool').value, +document.getElementById('optRarity').value, n),
      { policy: document.getElementById('optPolicy').value, p4value: P4 });
    const a0 = rr.alternatives[0];
    const a0cards = a0 ? ['Sun', 'Moon', 'Star', 'Sky'].map(sl => a0.picks[sl].c).concat(a0.space ? [a0.space.c] : []) : [];
    const want = a0 ? buildScoreOf(ch, a0cards, P4, charLoadout(n), idealLoadout(ch, t, P4), t).raw : NaN;
    const r = { recFirst: panels.length > 1 && /Recommended loadout/.test(panels[0].querySelector('h2').textContent) && /Build score/.test(panels[0].textContent),
      plans: plans.length, onScale: plans.length > 0 && plans.every(v => v > 0 && v <= 100.5) && Math.abs(plans[0] - want) < 0.051, first: plans[0], want };
    // "Mark these as equipped" can be taken back
    const worn = () => state.cards.filter(c => c.equipped === 'Makoto Yuki').map(c => c.id).sort().join();
    const one = state.cards.find(c => c.equipped === 'Makoto Yuki');
    unequipCard(one.id);
    const stripped = worn();
    document.getElementById('equipBtn').click();
    r.equipped = worn() !== stripped;
    document.getElementById('toastUndo').click();
    r.undone = worn() === stripped;
    swapCard('Makoto Yuki', one.slot, one.id); hideToast();
    return r;
  });
  check('Optimise leads with the recommendation, scores other plans on the 0-100 build scale, and "Mark these as equipped" can be undone',
    optUi.recFirst && optUi.onScale && optUi.equipped && optUi.undone, JSON.stringify(optUi));

  /* The alternatives table is ordered by what the pick was made on (build score with the card in
     the pick's place), not by the per-card Score: bestPlan's same-set swap can pick a card that
     scores lower on its own, and sorted on the Score the table put the passed-over card first,
     under a loadout that recommended the other (Kotone Shiomi, 28 Sep 2026). */
  const altUi = await p.evaluate(() => {
    const bad = [];
    const was = $('#optChar').value;
    ownedChars().slice(0, 8).forEach(ch => {
      renderOpt(ch.n); $('#optChar').value = ch.n; runOpt();
      const panel = [...document.querySelectorAll('#optOut > .panel')].find(pn => /Best alternatives per slot/.test(pn.textContent));
      if (!panel) { bad.push(ch.n + ': no table'); return; }
      const r = bestPlan(ch, poolFor($('#optPool').value, +$('#optRarity').value, ch.n), { policy: $('#optPolicy').value, p4value: +$('#optP4').value });
      SLOTS.forEach(sl => {
        const cells = [...panel.querySelectorAll('tr.slotrow-' + sl)].map(tr => tr.children[6].textContent.trim());
        if (!cells.length) return;
        const vals = cells.map(s => s === 'picked' ? 0 : parseFloat(s.replace('−', '-')));
        if (cells.filter(s => s === 'picked').length !== 1) bad.push(`${ch.n} ${sl}: ${cells.join('/')}`);
        if (vals.some((v, i) => i && v > vals[i - 1] + 0.05)) bad.push(`${ch.n} ${sl} out of order: ${cells.join('/')}`);
        if (r.best.kind === '4pc' && sl !== 'Space' && cells[0] !== 'picked') bad.push(`${ch.n} ${sl}: pick not first (${cells.join('/')})`);
      });
    });
    renderOpt(); $('#optChar').value = was;
    return bad;
  });
  check('Optimise\'s alternatives are ordered by "vs pick", and in a 4-piece plan the pick heads every Heavens slot', altUi.length === 0, altUi.join('; '));

  /* Each alternatives row can open its card in the editor ready for a level-up (the user, Oct
     2026: level a card in the game, enter it from where it was suggested). Saving re-runs the
     recommendation on the new values. */
  const altEdit = await p.evaluate(() => {
    const bad = [];
    const was = $('#optChar').value;
    const ch = ownedChars()[0];
    renderOpt(ch.n); $('#optChar').value = ch.n; runOpt();
    const panel = [...document.querySelectorAll('#optOut > .panel')].find(pn => /Best alternatives per slot/.test(pn.textContent));
    const rows = panel ? [...panel.querySelectorAll('tbody tr')] : [];
    if (!rows.length) bad.push('no rows');
    if (rows.some(tr => !tr.querySelector('[data-edit-lvl]'))) bad.push('a row has no edit button');
    const btn = rows.map(tr => tr.querySelector('[data-edit-lvl]')).find(b => b && state.cards.find(c => c.id === b.dataset.editLvl).level < 25);
    if (btn) {
      const card = state.cards.find(c => c.id === btn.dataset.editLvl), lvl = card.level;
      const before = JSON.parse(JSON.stringify(card));
      btn.click();
      if (!document.getElementById('dlg').open || document.activeElement !== $('#eLvl')) bad.push('editor did not open on the level');
      if (+$('#eLvl').value !== lvl) bad.push('editor shows another card');
      $('#eLvl').value = lvl + 1;   // a same-card edit; substats stay valid at any level
      $('#eSave').click();
      if (card.level !== lvl + 1) bad.push('level not saved: ' + $('#eErr').textContent);
      if (document.getElementById('dlg').open) document.getElementById('dlg').close();
      Object.keys(card).forEach(k => delete card[k]); Object.assign(card, before); commit();
    }
    renderOpt(); $('#optChar').value = was;
    return bad;
  });
  check('Every row of Optimise\'s alternatives opens its card in the editor on the level field, and saving it sticks', altEdit.length === 0, altEdit.join('; '));

  /* Every place that proposes a single swap chooses it on the build score, not on the card's own
     score (they disagree where the stat targets or the damage balance have a say): the card
     picker's default order, Weakest slots' "Available now", and each Optimise card's own gain. */
  const swapUi = await p.evaluate(() => {
    const bad = [];
    const parse = s => parseFloat(s.replace('−', '-'));
    const chars = ownedChars().filter(ch => state.cards.some(c => c.equipped === ch.n)).slice(0, 4);
    chars.forEach(ch => {
      const t = target(ch), lo = charLoadout(ch.n), idl = idealLoadout(ch, t, 55);
      const worn = state.cards.filter(c => c.equipped === ch.n);
      const base = buildScoreOf(ch, worn, 55, lo, idl, t).raw;
      const gainOf = (sl, c) => buildScoreOf(ch, worn.filter(x => x.slot !== sl).concat([c]), 55, lo, idl, t).raw - base;
      // the picker: default order is the Build column, which is that marginal
      const sl = worn[0].slot;
      openCardPicker(ch.n, sl);
      const trs = [...document.querySelectorAll('#dlgBody .pick tbody tr')].filter(tr => !tr.classList.contains('cur'));
      const vals = trs.map(tr => parse(tr.querySelector('.pickGain').textContent));
      if (vals.some((v, i) => i && v > vals[i - 1] + 1e-9)) bad.push(`${ch.n} picker out of order`);
      const btn = trs[0] && trs[0].querySelector('[data-equip-card]');
      if (btn) { const c = state.cards.find(x => x.id === btn.dataset.equipCard); if (Math.abs(gainOf(sl, c) - vals[0]) > 0.051) bad.push(`${ch.n} picker gain ${vals[0]} vs ${gainOf(sl, c)}`); }
      document.getElementById('dlg').close();
      // Optimise: "equip only this" is the same marginal
      renderOpt(ch.n); $('#optChar').value = ch.n; runOpt();
      const r = bestPlan(ch, poolFor($('#optPool').value, +$('#optRarity').value, ch.n), { policy: $('#optPolicy').value, p4value: +$('#optP4').value });
      const blocks = [...document.querySelectorAll('#optOut .loadout .lo')];
      ['Sun', 'Moon', 'Star', 'Sky'].forEach((s, i) => {
        const c = r.best.picks[s].c, m = (blocks[i].textContent.match(/equip only this: ([−+][\d.]+)/) || [])[1];
        if (c.equipped === ch.n ? m : (!m || Math.abs(parse(m) - gainOf(s, c)) > 0.051)) bad.push(`${ch.n} ${s} alone ${m} vs ${c.equipped === ch.n ? 'worn' : gainOf(s, c)}`);
      });
    });
    // Weakest slots: the offered card is the best build gain among same-slot, same-set cards
    headroomRows(false).filter(row => row.card).slice(0, 40).forEach(row => {
      const ch = row.ch, t = row.t, lo = charLoadout(ch.n), idl = idealLoadout(ch, t, HR_P4);
      const worn = state.cards.filter(c => c.equipped === ch.n), others = worn.filter(c => c.slot !== row.slot);
      const base = buildScoreOf(ch, worn, HR_P4, lo, idl, t).raw;
      let best = 0;
      state.cards.forEach(c => {
        if (c.slot !== row.slot || c.set !== row.card.set || c === row.card || c.locked && c.equipped !== ch.n || c.equipped && c.equipped !== ch.n) return;
        best = Math.max(best, buildScoreOf(ch, others.concat([c]), HR_P4, lo, idl, t).raw - base);
      });
      if (best >= 0.05 ? Math.abs(row.altGain - best) > 1e-9 : row.alt) bad.push(`${ch.n} ${row.slot} available ${row.altGain} vs best ${best}`);
    });
    return bad;
  });
  check('the card picker, Weakest slots and Optimise\'s per-card gain all choose a swap on the build score', swapUi.length === 0, swapUi.join('; '));

  const dropUi = await p.evaluate(() => new Promise(res => {
    const drop = files => { const dt = new DataTransfer(); files.forEach(f => dt.items.add(f));
      document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); };
    const n = state.cards.length;
    drop([new File([JSON.stringify({ cards: [state.cards[0]] })], 'cards.json', { type: 'application/json' })]);
    setTimeout(() => {
      const r = { scanToReview: document.getElementById('dlg').open && document.getElementById('dlgBody').dataset.view === 'import' && state.cards.length === n };
      document.getElementById('dlg').close();
      markSaved();
      drop([new File([JSON.stringify(savePayload())], 'p5x-planner-save.json', { type: 'application/json' })]);
      setTimeout(() => { r.saveLoaded = /Loaded/.test(document.getElementById('dataMsg').textContent) && state.cards.length === n && !isDirty(); res(r); }, 400);
    }, 300);
  }));
  check('a dropped scan file goes to the import review, a dropped save file loads', dropUi.scanToReview && dropUi.saveLoaded, JSON.stringify(dropUi));

  await p.setViewportSize({ width: 390, height: 844 });
  const phone = await p.evaluate(() => { showTab('opt'); runOpt(); const w = document.documentElement.scrollWidth; showTab('roster'); return w; });
  await p.setViewportSize({ width: 1280, height: 720 });
  check('on a phone-width screen the Optimise tab does not scroll sideways (its tables scroll inside themselves)', phone <= 390, `${phone}px wide`);

  // Save / load round trip through the real load() path, with an in-page File
  const roundTrip = await p.evaluate(() => new Promise(res => {
    const prefsBefore = collectPrefs();
    document.getElementById('trRar').value = '4';
    state.teamCrit = 12.5; state.den = { ATK: 119, HP: 473 };
    trVerdictSel = [0, 2]; rosterView = 'list';
    const payload = savePayload();
    const json = JSON.stringify(payload);
    const n = state.cards.length, worn = state.cards.filter(c => c.equipped).length;
    state.cards = []; state.chars['Ren Amamiya'].owned = false; document.getElementById('trRar').value = '2'; state.teamCrit = 0; state.den = {};
    trVerdictSel = []; rosterView = 'cards';
    load(new File([json], 'p5x-planner-save.json', { type: 'application/json' }));
    setTimeout(() => {
      res({ n, worn, after: state.cards.length, wornAfter: state.cards.filter(c => c.equipped).length, owned: state.chars['Ren Amamiya'].owned,
        trRar: document.getElementById('trRar').value, msg: document.getElementById('dataMsg').textContent, ids: new Set(state.cards.map(c => c.id)).size, saveShape: Object.keys(payload).join(','),
        teamCrit: state.teamCrit, teamCritField: document.getElementById('rsTeamCrit').value,
        den: JSON.stringify(state.den), denField: document.querySelector('.denIn[data-stat="ATK"]').value,
        verdicts: trVerdictSel.join(','), view: rosterView, listShown: !document.getElementById('rsListPanel').classList.contains('hide') });
      document.getElementById('trRar').value = prefsBefore.trRar;
      state.teamCrit = 0; document.getElementById('rsTeamCrit').value = 0; state.den = {}; syncTeamCritField();
      trVerdictSel = []; rosterView = 'cards'; renderRoster();
    }, 400);
  }));
  check('a save file round-trips through load(): cards, equips, ownership, the team crit rate, the Thieves Den and view prefs (verdict chips, roster view) all come back',
    roundTrip.after === roundTrip.n && roundTrip.wornAfter === roundTrip.worn && roundTrip.owned === true && roundTrip.trRar === '4' && /Loaded/.test(roundTrip.msg) && roundTrip.ids === roundTrip.after &&
    roundTrip.teamCrit === 12.5 && roundTrip.teamCritField === '12.5' && roundTrip.den === JSON.stringify({ ATK: 119, HP: 473 }) && roundTrip.denField === '119' && roundTrip.verdicts === '0,2' && roundTrip.view === 'list' && roundTrip.listShown,
    JSON.stringify(roundTrip));
  check('the save payload has the documented shape', roundTrip.saveShape === 'version,savedAt,nextId,cards,characters,settings,prefs');
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
    state.teamCrit = 7;
    setTimeout(() => { const r = { n: state.cards.length, msg: document.getElementById('dataMsg').textContent, teamCrit: state.teamCrit }; state.cards = cards; renderInv(); res(r); }, 300);
  }));
  check('load() skips an invalid card and says so rather than refusing the file', skipLoad.n === 1 && /1 skipped/.test(skipLoad.msg), skipLoad.msg);
  check('a save from before the team crit rate existed loads it as 0', skipLoad.teamCrit === 0, String(skipLoad.teamCrit));

  // Tabs: the scanning guide is reached from an in-prose link, not the nav
  await p.click('nav button[data-tab="data"]');
  await p.click('#tab-data [data-goto="howto"] >> nth=0'); await p.waitForTimeout(100);
  check('the in-prose link opens the scanning guide tab', await p.evaluate(() => !document.getElementById('tab-howto').classList.contains('hide') && document.getElementById('tab-data').classList.contains('hide')));
  // GitHub sync, against a fake of the contents API: one file, versioned by sha, refusing a write
  // that names the wrong version — the rule the conflict question rests on.
  const gh = { private: true, file: null, puts: [], n: 0 };
  await p.route('https://api.github.com/**', async route => {
    const req = route.request(), u = new URL(req.url()), m = req.method();
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (req.headers().authorization !== 'Bearer test-token') return json(401, { message: 'Bad credentials' });
    if (u.pathname === '/repos/me/save') return json(200, { private: gh.private });
    if (u.pathname === '/repos/me/save/commits') return json(200, [{ commit: { message: 'Save from phone: 3 cards', committer: { date: '2026-10-23T10:00:00Z' } } }]);
    if (u.pathname !== '/repos/me/save/contents/p5x-planner-save.json') return json(404, { message: 'Not Found' });
    if (m === 'GET') return gh.file ? json(200, { type: 'file', sha: gh.file.sha, encoding: 'base64', content: Buffer.from(gh.file.text).toString('base64') }) : json(404, { message: 'Not Found' });
    const body = JSON.parse(req.postData());
    if (gh.file && !body.sha) return json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
    if (gh.file && body.sha !== gh.file.sha) return json(409, { message: 'does not match' });
    gh.file = { sha: 'v' + (++gh.n), text: Buffer.from(body.content, 'base64').toString('utf8') };
    gh.puts.push(body.message);
    return json(gh.n === 1 ? 201 : 200, { content: { sha: gh.file.sha } });
  });
  const syncWait = () => p.waitForFunction(() => !document.getElementById('hdrSave').disabled, null, { timeout: 5000 }).catch(() => {});
  await p.click('nav button[data-tab="data"]');
  const syncBefore = await p.evaluate(() => ({ cards: state.cards.length, text: JSON.stringify(savePayload()) }));
  await p.fill('#syncRepo', 'https://github.com/me/save'); await p.fill('#syncToken', 'test-token');
  await p.uncheck('#syncRemember');
  gh.private = false;
  await p.click('#syncConnect'); await syncWait();
  const pub = await p.evaluate(() => ({ on: syncOn(), msg: document.getElementById('syncMsg').textContent }));
  check('GitHub sync refuses a public repository', !pub.on && /public/.test(pub.msg), JSON.stringify(pub));
  gh.private = true;
  await p.click('#syncConnect'); await syncWait();
  const conn = await p.evaluate(() => ({ on: syncOn(), repo: sync.repo, n: state.cards.length, msg: document.getElementById('syncMsg').textContent }));
  check('GitHub sync connects to a private repository (pasting its address is fine) and keeps the inventory', conn.on && conn.repo === 'me/save' && conn.n === syncBefore.cards && /Connected/.test(conn.msg), JSON.stringify(conn));
  await p.evaluate(() => { state.teamCrit = 3; commit(); });
  await p.click('#hdrSave'); await syncWait();
  const first = await p.evaluate(() => ({ dirty: isDirty(), sha: syncSha }));
  const firstFile = gh.file && JSON.parse(gh.file.text);
  check('the header Save writes the save to GitHub and clears "unsaved changes"',
    firstFile && firstFile.cards.length === syncBefore.cards && firstFile.settings.teamCritRate === 3 && !first.dirty && first.sha === 'v1' && /^Save from computer: \d+ cards$/.test(gh.puts[0]),
    JSON.stringify({ first, puts: gh.puts }));
  // another device saves; this one, not having loaded that, is asked before replacing it
  gh.file = { sha: 'other', text: JSON.stringify(Object.assign(JSON.parse(syncBefore.text), { cards: [] })) };
  await p.evaluate(() => { state.teamCrit = 4; commit(); });
  await p.click('#hdrSave'); await syncWait();
  const asked = await p.evaluate(() => ({ toast: document.getElementById('toastMsg').textContent, btn: document.getElementById('toastUndo').textContent, dirty: isDirty() }));
  check('a save over a newer one from another device is asked first, naming it, and nothing is replaced',
    /changed somewhere else/.test(asked.toast) && /phone/.test(asked.toast) && asked.btn === 'Save over it' && asked.dirty && gh.file.sha === 'other', JSON.stringify(asked));
  await p.click('#toastUndo'); await syncWait();
  check('"Save over it" replaces it', gh.file.sha !== 'other' && JSON.parse(gh.file.text).settings.teamCritRate === 4 && !(await p.evaluate(() => isDirty())));
  // a later load fetches what is there
  gh.file = { sha: 'v9', text: syncBefore.text };
  await p.click('#hdrLoad'); await syncWait();
  const pulled = await p.evaluate(() => ({ n: state.cards.length, tc: state.teamCrit, sha: syncSha, dirty: isDirty() }));
  check('the header Load replaces everything with the save on GitHub', pulled.n === syncBefore.cards && pulled.sha === 'v9' && !pulled.dirty, JSON.stringify(pulled));
  check('the save survives the trip as UTF-8 through base64', await p.evaluate(() => b64ToUtf8(utf8ToB64('Kumi ★ — Ailment Acc. 5.7%')) === 'Kumi ★ — Ailment Acc. 5.7%'));
  await p.click('#syncDisconnect');
  check('Disconnect hands the header back to files', await p.evaluate(() => !syncOn() && /Download/.test(document.getElementById('hdrSave').title)));
  await p.unroute('https://api.github.com/**');

  // ---- Teams tab: lufel's parties filled from what is owned, rotations, Fuuka's backup ----
  const tmData = await p.evaluate(() => {
    const bad = [];
    const known = n => n === 'Wonder' || !!charDef(n);
    const hangul = /[ㄱ-힝]/;
    for (const [owner, T] of Object.entries(TEAMS)) {
      if (!charDef(owner)) bad.push('owner ' + owner);
      for (const pt of T.parties || []) {
        if (!pt.f.includes(owner) && pt.e !== owner && pt.b !== owner) bad.push(owner + ': a party without its own character');
        pt.f.forEach(n => { if (n && !known(n)) bad.push(owner + ': ' + n); });
        if (pt.e && charDef(pt.e).arch !== 'Navigator') bad.push(owner + ': Elucidator seat holds ' + pt.e);
        if (pt.f.some(n => n && charDef(n) && charDef(n).arch === 'Navigator')) bad.push(owner + ': an Elucidator in a thief seat');
        if (pt.b && pt.e !== 'Fuuka Yamagishi') bad.push(owner + ': a backup without Fuuka');
      }
      (T.partners || []).forEach(x => { if (!known(x.n)) bad.push(owner + ' partner ' + x.n); if (hangul.test(x.why || '')) bad.push(owner + ' partner text'); });
      (T.rot || []).forEach(r => { if (!r.seq.length || hangul.test(r.label + r.seq.join(''))) bad.push(owner + ' rotation ' + r.label); });
      (T.notes || []).forEach(x => { if (hangul.test(x)) bad.push(owner + ' note'); });
    }
    return { bad, n: Object.keys(TEAMS).length, fuukaBackups: (TEAMS['Fuuka Yamagishi'].partners || []).length };
  });
  check('TEAMS (tools/gen-teams.js) names only roster characters, seats Elucidators only as Elucidators, a backup only beside Fuuka, all in English',
    tmData.bad.length === 0 && tmData.n > 60 && tmData.fuukaBackups > 3, JSON.stringify(tmData).slice(0, 600));

  const tmKeep = await p.evaluate(() => ({ chars: JSON.stringify(state.chars), busy: [...tmBusy], pick: JSON.stringify(tmPick) }));
  await p.evaluate(() => {
    CHARACTERS.forEach(c => { state.chars[c.n] = { owned: false, benched: false, targets: null, loadout: null }; });
    ['Yusuke Kitagawa', 'Justine & Caroline', 'Miyu Sahara [Wavecatcher]', 'Fuuka Yamagishi', 'Minami Miyashita [Beachflower]']
      .forEach(n => { state.chars[n].owned = true; });
    tmBusy = new Set(); tmPick = {};
    $('#tmBasis').value = 'lufel';   // these checks are about lufel's lists; the calculated basis has its own below
    commit(); showTab('teams');
  });
  await p.selectOption('#tmChar', 'Yusuke Kitagawa');
  const tm1 = await p.evaluate(() => {
    const t = tmTeams('Yusuke Kitagawa').team;
    return { seats: t.seats.map(s => [s.role, s.name, s.orig]), text: $('#tmOut').innerText };
  });
  const seat = (t, role) => (t.seats.find(s => s[0] === role) || [])[1];
  check('Teams keeps lufel\'s own party where it is owned: Fuuka as Elucidator, and her backup seat stays empty when no backup lufel names is available',
    seat(tm1, 'Elucidator') === 'Fuuka Yamagishi' && tm1.seats.some(s => s[0] === 'Backup (Oracle Shift)' && s[1] == null && s[2] === 'Koromaru') &&
    /Oracle Shift/.test(tm1.text) && /none of the characters lufel recommends as Fuuka's backup/i.test(tm1.text), JSON.stringify(tm1.seats));

  await p.evaluate(() => { state.chars['Mio Natsukawa'].owned = true; commit(); });
  const tm2 = await p.evaluate(() => {
    const t = tmTeams('Yusuke Kitagawa').team;
    const b = t.seats.find(s => s.seat === 'b');
    return { name: b && b.name, why: b && b.pickWhy, text: $('#tmOut').innerText };
  });
  check('an unowned backup is replaced by one lufel recommends for Fuuka, with lufel\'s reason, and the page redraws on the ownership change',
    tm2.name === 'Mio Natsukawa' && (tm2.why || []).some(w => /Fuuka's backup/.test(w)) && /replaces Koromaru/.test(tm2.text), JSON.stringify(tm2));

  // "Busy elsewhere", clicked in the table: the thief is replaced and listed as busy
  await p.click('#tmOut [data-tm-busy="Justine & Caroline"]');
  const tm3 = await p.evaluate(() => ({ seats: tmTeams('Yusuke Kitagawa').team.seats.map(s => s.name), busy: $('#tmBusy').innerText, text: $('#tmOut').innerText }));
  check('"Busy elsewhere" rebuilds the team without them and says whom they replace',
    !tm3.seats.includes('Justine & Caroline') && /Justine & Caroline/.test(tm3.busy) && /replaces Justine & Caroline/.test(tm3.text), JSON.stringify(tm3.seats));
  const tmPrefs = await p.evaluate(() => { const pr = collectPrefs(); tmBusy = new Set(); applyPrefs(pr); return [...tmBusy]; });
  check('the busy list is kept in the prefs', tmPrefs.length === 1 && tmPrefs[0] === 'Justine & Caroline', JSON.stringify(tmPrefs));
  await p.click('#tmBusy [data-tm-unbusy="*"]');

  // Wonder's Speed: the user's entry, an account setting saved beside the team crit rate
  const wsBefore = await p.evaluate(() => ({ spd: tmSpeed('Wonder'), order: $('#tmOut .tmOrder').innerText }));
  await p.evaluate(() => markSaved());
  await p.fill('#tmWonderSpd', '250');
  await p.dispatchEvent('#tmWonderSpd', 'change');
  const ws = await p.evaluate(() => ({
    first: $('#tmOut .tmOrder .tmStep').innerText, dirty: isDirty(), saved: savePayload().settings.wonderSpeed,
    restored: (() => { const t = JSON.stringify(savePayload()); state.wonderSpd = 0; applySave(t, ''); return wonderSpeed(); })()
  }));
  await p.evaluate(() => { hideToast(); showTab('teams'); $('#tmChar').value = 'Yusuke Kitagawa'; renderTeams(); });
  check('Wonder\'s Speed is unset until entered; entered, it places him in the turn order, counts as unsaved, and goes through the save file',
    wsBefore.spd === null && /Wonder Speed not set/.test(wsBefore.order) && /^Wonder 250/.test(ws.first) && ws.dirty && ws.saved === 250 && ws.restored === 250,
    JSON.stringify({ wsBefore, ws }));
  await p.evaluate(() => { state.wonderSpd = 0; commit(); });

  // a replacement chosen from the table's list sticks, and the reset brings back the recommended team
  const altName = await p.evaluate(() => { const b = $('#tmOut [data-tm-use]'); return b && b.dataset.name; });
  if (altName) {
    // its seat's Replacements are folded: open that list, as a click on its summary would
    await p.evaluate(() => { $('#tmOut [data-tm-use]').closest('details').open = true; });
    // a DOM click: after a load Playwright's own scroll parks the button under the sticky header
    await p.dispatchEvent('#tmOut [data-tm-use]', 'click');
  }
  const tm4 = await p.evaluate(() => ({ text: $('#tmOut').innerText, seats: tmTeams('Yusuke Kitagawa').team.seats.map(s => s.name) }));
  check('"Use" seats the chosen replacement, marked as your choice', !!altName && tm4.seats.includes(altName) && /your choice/.test(tm4.text), altName + ' ' + JSON.stringify(tm4.seats));
  await p.dispatchEvent('#tmOut [data-tm-reset]', 'click');
  check('"Back to the recommended team" undoes it', await p.evaluate(n => !tmTeams('Yusuke Kitagawa').team.seats.some(s => s.chosen) && !$('#tmOut [data-tm-reset]'), altName));

  // rotations: the Setup's Awareness picks lufel's level; a rotation written for a teammate needs that teammate
  const tmRot = await p.evaluate(() => {
    const k = 'Kotone Shiomi';
    state.chars[k].loadout = Object.assign({}, DEFAULT_LOADOUT, { awareness: 3 });
    const without = tmRotPick(k, new Set([k]));
    const withMiku = tmRotPick(k, new Set([k, 'Hatsune Miku']));
    state.chars[k].loadout = null;
    const low = tmRotPick('Ann Takamaki [Starlight]', new Set());
    return {
      lvl: without.lvl, noMiku: without.pick.every(r => !/Miku/.test(r.label)) && without.pick.length > 0,
      mikuOnly: withMiku.pick.length > 0 && withMiku.pick.every(r => /Miku/.test(r.label) && r.aw === 2),
      lowLvl: low && low.lvl, lowBelow: low && low.below
    };
  });
  check('a rotation is lufel\'s at the highest Awareness the Setup reaches, and one written for Miku is chosen only with Miku in the team',
    tmRot.lvl === 2 && tmRot.noMiku && tmRot.mikuOnly && tmRot.lowLvl === 0 && tmRot.lowBelow === false, JSON.stringify(tmRot));
  check('the tokens of a rotation are spelled out on hover', await p.evaluate(() =>
    tmTokenText('HL+3') === 'Highlight, then Skill 3' && tmTokenText('1↺+2') === 'Skill 1 (automatic), then Skill 2' && /not ready/.test(tmTokenText('-'))));

  // ---- the calculated basis: team damage from the kits (TEAM_BUFFS) ----
  const tc = await p.evaluate(() => {
    const set = n => new Set(tcTurnSkills(n));
    const eq = (a, b) => a.size === b.length && b.every(x => a.has(x));
    // lufel's worked example (damage-calc): DEF 400, +158.3%, 10% Pierce, 80% DEF down; without Windswept's 0.88
    const keep = Object.assign({}, TC_BOSS);
    Object.assign(TC_BOSS, { def: 400, coef: 1.583 });
    const def = tcDefence(10, 80);
    Object.assign(TC_BOSS, keep);
    const ann = charDef('Ann Takamaki'), yus = charDef('Yusuke Kitagawa');
    const atk = { atkPct: 30 };
    const bad = [];
    for (const [n, list] of Object.entries(TEAM_BUFFS)) {
      if (!charDef(n)) bad.push('unknown ' + n);
      list.forEach(e => { if (!TC_FROM_K[e.k] || !['party', 'ally', 'enemy'].includes(e.to) || !e.why) bad.push(n + ' ' + e.k); });
    }
    return {
      turns: eq(set('2×4+1'), ['2', '1']) && eq(set('1111'), ['1']) && eq(set('HL(2)+3'), ['HL', '3']) && eq(set('W+3+TH↺'), ['3', 'TH']) && eq(set('-'), []),
      cover: [tcCover(['1', '3', '1', '3'], '3', 2), tcCover(['1', '2', '3', '1', '2', '3'], '3', 1), tcCover(['1', '2', '3', '1', '2', '3'], '3', 3), tcCover(['1', '2'], '3', 2)],
      def,
      empty: tcMultiplier(ann, []),
      annAtk: tcMultiplier(ann, [atk]), yusAtk: tcMultiplier(yus, [atk]), yusDmg: tcMultiplier(yus, [{ dm: 20 }]),
      defdown: tcMultiplier(ann, [{ defdown: 40 }]) > tcMultiplier(ann, [{ defdown: 20 }]),
      turns: tcMultiplier(ann, [{ turns: 2 }]),
      n: Object.keys(TEAM_BUFFS).length, bad
    };
  });
  check('the team calculator reads rotations, uptimes and lufel\'s defence formula as written, and a team adds nothing it does not supply',
    tc.turns && tc.cover[0] === 1 && Math.abs(tc.cover[1] - 1 / 3) < 1e-9 && tc.cover[2] === 1 && tc.cover[3] === null &&
    Math.abs(tc.def - 0.6966) < 0.001 && Math.abs(tc.empty - 1) < 1e-9 && tc.annAtk > 1.05 && Math.abs(tc.yusAtk - 1) < 1e-9 && tc.yusDmg > 1.1 && tc.defdown && Math.abs(tc.turns - 8 / 6) < 1e-9,
    JSON.stringify(tc));
  check('TEAM_BUFFS names roster characters and only priceable effects, each with its reason', tc.n >= 20 && tc.bad.length === 0, JSON.stringify(tc.bad));

  // ---- Highlights, Theurgies, turn order and the fight (Nov 2026) ----
  const th = await p.evaluate(() => {
    const out = {};
    const setF = f => { $('#tmFight').value = String(f); tcMemo.key = ''; };
    setF(12);
    out.count = [tcKindCount('HL×2+3', 'HL'), tcKindCount('2HL+3', 'HL'), tcKindCount('3+HL+HL', 'HL'), tcKindCount('HL(2)+3', 'HL'), tcKindCount('W+3+TH↺', 'TH'), tcKindCount('1+3', 'HL')];
    out.uses = [tcSkillUses('2×4+1'), tcSkillUses('1111'), tcSkillUses('HL+1+3'), tcSkillUses('2HL+3')].map(x => x.join(''));
    const six = ['1', '3', '1', '3', '1', '3'], withHl = ['1', 'HL+3', '1', '3', '1', '3'];
    // the quick screen's cadence: a Highlight every 5 turns (84% of gauge a round shared four ways)
    const ov = tcSeqHL(six, 'Haruna Nishimori');
    out.overlay = { len: ov.length, at: ov.map((s, i) => /HL/.test(s) ? i + 1 : 0).filter(Boolean), kept: tcSeqHL(withHl, 'Haruna Nishimori') === withHl, elu: tcSeqHL(six, 'Fuuka Yamagishi') === six };
    out.cool = [tcBreaksCooldown(['3', '3', '1'], 'Ayaka Sakai'), tcBreaksCooldown(['3', '1', '3', '1'], 'Ayaka Sakai'), tcBreaksCooldown(['3', '1'], 'Kotone Shiomi')];
    const ann = charDef('Ann Takamaki');
    const keepT = TEAMS['Ryuji Sakamoto'], keepB = TEAM_BUFFS['Ryuji Sakamoto'], keepSpeed = tmSpeed;
    TEAMS['Ryuji Sakamoto'] = { rot: [{ aw: 0, label: 'Test', seq: six }] };
    TEAM_BUFFS['Ryuji Sakamoto'] = [
      { k: 'dmg', v: 20, to: 'party', src: 'HL', on: 'HL', dur: 2, why: 'test: a 2-turn Highlight buff' },
      { k: 'atk%', v: 30, to: 'ally', src: 'passive', on: 'dpsHL', dur: 2, why: 'test: on the damage dealer\'s Highlight' },
      { k: 'cm', v: 30, to: 'party', src: 'passive', on: 'anyHL', dur: 2, why: 'test: on any ally\'s Highlight' }];
    tcMemo.key = '';
    out.screen = tcMember(ann, 'Ryuji Sakamoto', null, null, false).lines.map(l => [l.k, +l.up.toFixed(4), !!l.offRot]);
    // the damage dealer's own Highlight, from lufel's skill numbers: Ann's 3-1 rotation against her Highlight
    const H = tcEvalFor(ann).hl, S0 = SKILL_DMG['Ann Takamaki'];
    out.ann = { q: H.q, qExp: S0.d[3] / ((S0.d[0] + S0.d[2]) / 2), r0: H.r0, share: H.share };
    out.m = {
      hlDm: tcMultiplier(ann, [{ hlDm: 50 }]), dm: tcMultiplier(ann, [{ dm: 50 }]), hlx: tcMultiplier(ann, [{ hlx: 0.25 }]),
      gauge: tcMultiplier(ann, [{ hlGauge: 50 }]), cd: tcMultiplier(ann, [{ hlCdRate: 0.25 }]),
      xturns: tcMultiplier(ann, [{ xturns: 1 / 6 }]), xDmAlone: tcMultiplier(ann, [{ xDm: 45 }]), xBoth: tcMultiplier(ann, [{ xturns: 1 / 6, xDm: 45 }])
    };
    // the fight: the damage dealer alone gets a Highlight in rounds 2, 6, 10 (cooldown 4 actions, gauge empty at the start)
    out.base = [12, 6].map(f => { setF(f); return tcSim(ann, ['Ryuji Sakamoto', null, null], false).base.hl['Ann Takamaki']; });
    setF(12);
    // turn order: a 1-turn debuff from a teammate who acts before the damage dealer meets this round's hit; after it, it expires first
    TEAM_BUFFS['Ryuji Sakamoto'] = [{ k: 'defdown', v: 40, to: 'enemy', src: '1', on: '1', dur: 1, why: 'test: a 1-turn DEF down' }];
    TEAMS['Ryuji Sakamoto'] = { rot: [{ aw: 0, label: 'Test', seq: ['1'] }] };
    tmSpeed = n => n === 'Ryuji Sakamoto' ? 200 : n === 'Ann Takamaki' ? 100 : 50;
    tcMemo.key = '';
    const fast = tcSim(ann, ['Ryuji Sakamoto', null, null], false);
    tmSpeed = n => n === 'Ryuji Sakamoto' ? 50 : n === 'Ann Takamaki' ? 100 : 40;
    tcMemo.key = '';
    const slow = tcSim(ann, ['Ryuji Sakamoto', null, null], false);
    out.order = { fast: fast.mult, slow: slow.mult, fastUp: fast.cover.get('Ryuji Sakamoto') && fast.cover.get('Ryuji Sakamoto').get(0), slowUp: slow.cover.get('Ryuji Sakamoto') ? slow.cover.get('Ryuji Sakamoto').get(0) || 0 : 0 };
    tmSpeed = keepSpeed;
    TEAMS['Ryuji Sakamoto'] = keepT; TEAM_BUFFS['Ryuji Sakamoto'] = keepB; tcMemo.key = '';
    // the shared gauge: four thieves charge 84% a round, so a 12-round fight holds at most 10 Highlights in all
    const team = tcSim(ann, ['Minami Miyashita [Beachflower]', 'Kotone Shiomi', 'Fuuka Yamagishi'], false);
    out.shared = Object.values(team.hl).reduce((a, b) => a + b, 0) - (team.hl['Kotone Shiomi'] && tmAw('Kotone Shiomi') >= 1 ? 1 : 0);
    // Catchy Hook fires the damage dealer's Highlight outside its cooldown and the gauge
    const hook = tcSim(ann, ['Ayaka Sakai', null, null], false);
    out.hook = { with: hook.hl['Ann Takamaki'], base: hook.base.hl['Ann Takamaki'] };
    // Summer Ayaka's Concerto of Time: one ally Highlight free each of her turns, cooldown 3
    const keepSA = state.chars['Ayaka Sakai [Summer]'].owned;
    const conc = tcSim(ann, ['Ayaka Sakai [Summer]', null, null], false);
    out.concerto = { ann: conc.hl['Ann Takamaki'], base: conc.base.hl['Ann Takamaki'] };
    // Theurgy: Yukari's A1 starts her at 70, so a 3-round fight has two where Awareness 0 has one
    const yuk = charDef('Yukari Takeba'), keepY = state.chars[yuk.n].loadout;
    setF(3);
    state.chars[yuk.n].loadout = Object.assign({}, DEFAULT_LOADOUT, { awareness: 0 }); tcMemo.key = '';
    const y0 = tcSim(yuk, [null, null, null], false).base.hl[yuk.n];
    state.chars[yuk.n].loadout = Object.assign({}, DEFAULT_LOADOUT, { awareness: 1 }); tcMemo.key = '';
    const y1 = tcSim(yuk, [null, null, null], false).base.hl[yuk.n];
    state.chars[yuk.n].loadout = keepY; setF(12);
    out.theurgy = [y0, y1];
    // Kotone Shiomi's Echoing Strings (A1): entering Fortune fires her Highlight without gauge
    const ks = 'Kotone Shiomi', keepK = state.chars[ks].loadout;
    const kc = aw => { state.chars[ks].loadout = Object.assign({}, DEFAULT_LOADOUT, { awareness: aw }); tcMemo.key = ''; return tcSim(ann, [ks, null, null], false).hl[ks]; };
    out.fortune = [kc(0), kc(1)];
    state.chars[ks].loadout = keepK; tcMemo.key = '';
    // a damage dealer's Resonance, set off by teammates' actions (Wavecatcher Miyu's Catch a Wave)
    const miyu = charDef('Miyu Sahara [Wavecatcher]');
    const mr = tcSim(miyu, [null, null, null], false).base;
    out.res = (mr.parts.res || 0) / mr.total;
    // Da Capo: extra actions over the fight
    const manaka = F => { setF(F); return tcMember(ann, 'Manaka Nagao', null, null, false).vec.xturns; };
    out.dacapo = [manaka(12), manaka(6)];
    setF(12);
    // Wonder's Highlight: from his Persona whose Highlight does most
    const real = WONDER_BUFFS, keepW = state.wonder;
    Object.assign(WONDER_BUFFS, { personas: { P: [{ k: 'dmg', v: 30, to: 'party', src: 'HL', dur: 2, why: 'p' }], Q: [{ k: 'dmg', v: 10, to: 'party', src: 'HL', dur: 2, why: 'q' }] }, cards: {}, weapons: {} });
    const slot = n => ({ name: n, cards: ['', '', ''] });
    const w = tcWonder(ann, { personas: [slot('Q'), slot('P'), slot('')], weapon: '', refine: 1 });
    Object.assign(WONDER_BUFFS, real); state.wonder = keepW; tcMemo.key = '';
    out.wonder = { lines: w.lines.map(l => l.v), idle: w.idle.length, events: w.sim.events.length };
    // Fuuka's Pros and Cons (A2): the backup also fires their Highlight on the swap
    const keepF = state.chars['Fuuka Yamagishi'].loadout;
    const bk = aw => { state.chars['Fuuka Yamagishi'].loadout = Object.assign({}, DEFAULT_LOADOUT, { awareness: aw }); tcMemo.key = '';
      return tcMember(ann, 'Leo Kamiyama', null, { swaps: 2 }, false).lines.filter(l => /Pros and Cons/.test(l.why)).length; };
    out.backup = [bk(0), bk(2)];
    // Oracle Shift in the fight: her first lufel rotation ('-', 1, 3, 1, 2+3, 1) and 3 starting stacks
    // reach 4 on rounds 2, 6 and 11; at A6 (cost 3, +2 per Divine Prayer, 5 to start) more often; from A2
    // the backup's Highlight comes with the swap (once every 3 rounds)
    const lineup = [null, null, 'Fuuka Yamagishi', 'Leo Kamiyama'];
    const shiftAt = aw => { state.chars['Fuuka Yamagishi'].loadout = Object.assign({}, DEFAULT_LOADOUT, { awareness: aw }); tcMemo.key = '';
      const S = tcSim(ann, lineup, false);
      return { shifts: S.shifts, leoHl: S.hl['Leo Kamiyama'] || 0, mult: S.mult, without: tcSim(ann, lineup.slice(0, 3), false).mult,
        courtesy: tcMember(ann, 'Fuuka Yamagishi', tcTeamSet(ann.n, lineup), null, false).lines.filter(l => /Courtesy/.test(l.why)).length,
        seat: JSON.stringify(tcLineup(ann, lineup).members[3].shifts) === JSON.stringify(tcSim(ann, lineup, tmFitOn()).shifts) };
    };
    out.oracle = [shiftAt(0), shiftAt(2), shiftAt(6)];
    state.chars['Fuuka Yamagishi'].loadout = keepF; tcMemo.key = '';
    // skill numbers at the tier the Setup reaches
    const keepAnn = state.chars[ann.n].loadout;
    state.chars[ann.n].loadout = Object.assign({}, DEFAULT_LOADOUT, { awareness: 0 });
    const t0 = tcSkillD(ann.n)[0];
    state.chars[ann.n].loadout = Object.assign({}, DEFAULT_LOADOUT, { awareness: 6, mind: true });
    const t3 = tcSkillD(ann.n)[0];
    state.chars[ann.n].loadout = keepAnn; tcMemo.key = '';
    out.tiers = { t0, t3, base: SKILL_DMG[ann.n].d[0] };
    // a Highlight cannot crit (except the kits whose text says it can): a crit buff leaves Ann's Highlight damage alone
    const keepT2 = TEAMS['Ryuji Sakamoto'], keepB2 = TEAM_BUFFS['Ryuji Sakamoto'];
    TEAMS['Ryuji Sakamoto'] = { rot: [{ aw: 0, label: 'Test', seq: ['1'] }] };
    TEAM_BUFFS['Ryuji Sakamoto'] = [{ k: 'cm', v: 100, to: 'party', src: 'passive', why: 'test: crit damage, always on' }];
    tcMemo.key = '';
    const cs = tcSim(ann, ['Ryuji Sakamoto', null, null], false);
    out.hlCrit = { hl: cs.parts.hl / cs.base.parts.hl, skill: cs.parts.skill / cs.base.parts.skill, flags: Object.keys(SKILL_DMG).filter(n => SKILL_DMG[n].hlCrit).sort() };
    TEAMS['Ryuji Sakamoto'] = keepT2; TEAM_BUFFS['Ryuji Sakamoto'] = keepB2; tcMemo.key = '';
    // the gauge: 21% for an action that hits, 17% for one that does not
    out.hits = [tcStepHits('Ann Takamaki', '1'), tcStepHits('Ayaka Sakai', '2'), tcStepHits('Haru Okumura', 'Gunshot'), tcStepHits('Wonder', '-'), tcStepHits('Wonder', 'w0')];
    // Wonder casts turn by turn: a 2-turn card he casts every other turn, attacks between
    const real2 = WONDER_BUFFS, keepW2 = state.wonder;
    Object.assign(WONDER_BUFFS, { personas: { P: [] }, cards: { A: [{ k: 'atk%', v: 30, to: 'party', src: 'card', dur: 2, why: 'a' }] }, weapons: {} });
    const ws = tcWonder(ann, { personas: [{ name: 'P', cards: ['A', '', ''] }, { name: '', cards: ['', '', ''] }, { name: '', cards: ['', '', ''] }], weapon: '', refine: 1 });
    Object.assign(WONDER_BUFFS, real2); state.wonder = keepW2; tcMemo.key = '';
    out.wsched = { seq: ws.sim.cast.seq.join(' '), events: ws.sim.cast.events.length, constAtk: ws.sim.consts.atkPct };
    // the damage dealer's own rotation is fitted in the fight: a faster teammate debuffs the boss every
    // other round, so Ann's much stronger Skill 3 moves onto those rounds
    const keepS = SKILL_DMG[ann.n], keepAT = TEAMS[ann.n], keepRT = TEAMS['Ryuji Sakamoto'], keepRB = TEAM_BUFFS['Ryuji Sakamoto'], keepSp = tmSpeed;
    SKILL_DMG[ann.n] = { hl: 'HL', cd: 4, d: [50, 0, 200, 195.2] };
    TEAMS[ann.n] = { rot: [{ aw: 0, label: 'Test', seq: ['1', '3', '1', '3', '1', '3'] }] };
    TEAMS['Ryuji Sakamoto'] = { rot: [{ aw: 0, label: 'Test', seq: ['1', '2'] }] };
    TEAM_BUFFS['Ryuji Sakamoto'] = [{ k: 'dmg', v: 100, to: 'enemy', src: '1', on: '1', dur: 1, why: 'test: a 1-turn debuff' }];
    tmSpeed = n => n === 'Ryuji Sakamoto' ? 200 : n === ann.n ? 100 : 50;
    tcMemo.key = '';
    const on = tcSim(ann, ['Ryuji Sakamoto', null, null], true), offF = tcSim(ann, ['Ryuji Sakamoto', null, null], false);
    out.dpsFit = { seq: on.dpsRot && on.dpsRot.seq.join(' '), gain: on.dpsRot && on.dpsRot.gain, changed: on.dpsRot && on.dpsRot.changed,
      off: offF.dpsRot, better: on.total > offF.total, counts: on.dpsRot && ['1', '3'].map(t => on.dpsRot.seq.filter(x => x === t).length) };
    // a teammate's rotation is fitted in the fight too: Ann's is pinned (one plain skill, bursts between),
    // and Ryuji's lufel rotation puts his 1-turn debuff on the wrong rounds; the quick model sees the same
    // uptime either way, the fight moves it onto Ann's Skill 3 rounds
    TEAMS[ann.n] = { rot: [{ aw: 0, label: 'Test', seq: ['3', '1+1', '3', '1+1', '3', '1+1'] }] };
    TEAMS['Ryuji Sakamoto'] = { rot: [{ aw: 0, label: 'Test', seq: ['2', '1', '2', '1', '2', '1'] }] };
    tcMemo.key = '';
    const quick = tcMember(ann, 'Ryuji Sakamoto', tcTeamSet(ann.n, ['Ryuji Sakamoto', null, null]), null, true).rot;
    const full = tcSim(ann, ['Ryuji Sakamoto', null, null], 'full'), cheap = tcSim(ann, ['Ryuji Sakamoto', null, null], true);
    out.mateFit = { quick: quick ? quick.seq.join(' ') : 'as written', full: full.fits['Ryuji Sakamoto'] && full.fits['Ryuji Sakamoto'].seq.join(' '),
      gain: full.fits['Ryuji Sakamoto'] && full.fits['Ryuji Sakamoto'].gain, better: full.mult > cheap.mult * 1.001 };
    SKILL_DMG[ann.n] = keepS; TEAMS[ann.n] = keepAT; TEAMS['Ryuji Sakamoto'] = keepRT; TEAM_BUFFS['Ryuji Sakamoto'] = keepRB; tmSpeed = keepSp; tcMemo.key = '';
    out.skillBad = Object.entries(SKILL_DMG).filter(([n, s]) => !charDef(n) || !['HL', 'TH'].includes(s.hl) || !Array.isArray(s.d) || s.d.length !== 4 || s.d.some(x => !(x >= 0)) || (s.hl === 'TH' && !(s.th > 0))).map(([n]) => n);
    out.skillN = Object.keys(SKILL_DMG).length;
    const ON = /^(self|self:[123]|tok:.+|selfHL|ally|allySkill|allyHL|anyHL|turnEnd|turnStart|round)$/;
    out.kitBad = [];
    Object.entries(DPS_KIT).forEach(([n, list]) => { if (!charDef(n)) out.kitBad.push(n); list.forEach((c, i) => { if (!['res', 'fu', 'dot', 'hit'].includes(c.kind) || !ON.test(c.on) || !c.why || (c.v == null && !c.ladder)) out.kitBad.push(n + ' #' + i); }); });
    out.kitN = Object.keys(DPS_KIT).length;
    out.prefs = 'tmFight' in collectPrefs() && !$('#tmHlEvery');
    return out;
  });
  const near = (a, b, e) => Math.abs(a - b) < (e || 1e-9);
  check('a rotation step counts its Highlights and skill uses; the quick screen adds a Highlight every 5 turns where lufel writes none (thieves only); a re-chosen rotation may not break a cooldown',
    JSON.stringify(th.count) === '[2,2,2,1,1,0]' && JSON.stringify(th.uses) === '["140","400","101","001"]' &&
    th.overlay.len === 30 && JSON.stringify(th.overlay.at) === '[5,10,15,20,25,30]' && th.overlay.kept && th.overlay.elu &&
    JSON.stringify(th.cool) === '[true,false,true]', JSON.stringify({ c: th.count, u: th.uses, o: th.overlay, cool: th.cool }));
  const upOf = (rows, k) => (rows.find(r => r[0] === k) || []);
  check('in the quick screen a Highlight buff counts at the cadence, and "on the damage dealer\'s / any ally\'s Highlight" at their rates',
    near(upOf(th.screen, 'dm')[1], 0.4) && near(upOf(th.screen, 'atkPct')[1], 0.4) && near(upOf(th.screen, 'cm')[1], 1), JSON.stringify(th.screen));
  check('the damage dealer\'s own Highlight is its share of their damage from lufel\'s skill numbers',
    near(th.ann.q, th.ann.qExp, 1e-6) && near(th.ann.r0, 0.2) && th.ann.share > 0.1 && th.ann.share < 0.6, JSON.stringify(th.ann));
  check('quick screen: Highlight damage reaches only the Highlight part; an extra Highlight adds one; the shared gauge, not the cooldown, holds Highlights back',
    th.m.hlDm > 1.001 && th.m.hlDm < th.m.dm && th.m.hlx > 1.01 && th.m.gauge > 1.001 && near(th.m.cd, 1) &&
    th.m.xturns > 1.05 && near(th.m.xDmAlone, 1) && th.m.xBoth > th.m.xturns, JSON.stringify(th.m));
  check('the fight: alone, a damage dealer\'s Highlight comes in rounds 2, 6 and 10 (empty gauge, 4-action cooldown); four thieves\' 84% a round caps the team\'s Highlights',
    JSON.stringify(th.base) === '[3,2]' && th.shared <= 10, JSON.stringify({ base: th.base, shared: th.shared }));
  check('the fight plays turn order: a 1-turn debuff from a teammate faster than the damage dealer meets the hit, from a slower one it has expired',
    th.order.fast > th.order.slow + 0.01 && th.order.fastUp > 0.9 && th.order.slowUp < 0.1, JSON.stringify(th.order));
  check('Catchy Hook adds Highlights outside the cooldown, and Summer Ayaka\'s Concerto of Time gives the damage dealer one every 3 actions for free',
    th.hook.with >= th.hook.base + 2 && th.concerto.ann >= th.concerto.base + 1, JSON.stringify({ hook: th.hook, concerto: th.concerto }));
  check('starting Theurgy gauge counts (Yukari\'s A1: two Theurgies in 3 rounds where Awareness 0 has one), and Kotone Shiomi\'s Fortune fires a free Highlight from A1',
    JSON.stringify(th.theurgy) === '[1,2]' && th.fortune[1] >= th.fortune[0] + 1, JSON.stringify({ t: th.theurgy, f: th.fortune }));
  check('a damage dealer\'s own Resonance counts, set off by teammates\' actions (Wavecatcher Miyu)', th.res > 0.05, String(th.res));
  check('Da Capo is extra actions over the fight; Wonder\'s Highlight is his best Persona\'s, fired from the gauge',
    near(th.dacapo[0], 2 / 12) && near(th.dacapo[1], 1 / 6) && JSON.stringify(th.wonder) === '{"lines":[30],"idle":1,"events":1}', JSON.stringify({ d: th.dacapo, w: th.wonder }));
  check('Fuuka\'s backup fires their Highlight on the swap from her Awareness 2', th.backup[0] === 0 && th.backup[1] > 0, JSON.stringify(th.backup));
  check('skill numbers are read at the skill-level tier the Setup reaches',
    th.tiers.t0 === th.tiers.base && th.tiers.t3 > th.tiers.t0, JSON.stringify(th.tiers));
  check('a Highlight does not crit unless its kit says it can (J&C, Kasumi, Radiance Motoha): a crit buff raises the skills, not the Highlight',
    Math.abs(th.hlCrit.hl - 1) < 1e-6 && th.hlCrit.skill > 1.01 &&
    JSON.stringify(th.hlCrit.flags) === JSON.stringify(['Justine & Caroline', 'Kasumi Yoshizawa', 'Motoha Arai [Radiance]']), JSON.stringify(th.hlCrit));
  check('the gauge fills 21% for an action that hits and 17% for one that does not (a buff skill, Wonder casting a card)',
    JSON.stringify(th.hits) === '[true,false,true,true,false]', JSON.stringify(th.hits));
  check('Wonder casts his skills turn by turn: a 2-turn card every other turn, attacks between, its line a cast in the fight',
    th.wsched.seq === 'w0 - w0 - w0 -' && th.wsched.events === 1 && th.wsched.constAtk === 0, JSON.stringify(th.wsched));
  check('the damage dealer\'s own rotation is fitted to the team in the fight: their strongest skill moves onto the rounds a teammate\'s debuff is up, with lufel\'s skill counts; off, it is lufel\'s',
    th.dpsFit.seq === '3 1 3 1 3 1' && th.dpsFit.gain > 0.001 && th.dpsFit.better && th.dpsFit.off === null &&
    JSON.stringify(th.dpsFit.counts) === '[3,3]', JSON.stringify(th.dpsFit));
  check('a teammate\'s rotation is fitted in the fight: the quick model sees no difference, the fight moves a 1-turn debuff onto the damage dealer\'s strong rounds',
    (th.mateFit.quick === 'as written' || th.mateFit.quick === '2 1 2 1 2 1') && th.mateFit.full === '1 2 1 2 1 2' && th.mateFit.gain > 0.001 && th.mateFit.better,
    JSON.stringify(th.mateFit));
  const [o0, o2, o6] = th.oracle;
  check('the fight plays Oracle Shift: swaps when Fuuka\'s stacks reach the cost (rounds 2, 6, 11 at A0), more often from A6, the backup\'s Highlight with them from A2, Courtesy from the backup\'s stats, and the backup adds damage',
    JSON.stringify(o0.shifts) === '[2,6,11]' && o0.leoHl === 0 && o2.leoHl >= 2 && o6.shifts.length > o0.shifts.length &&
    o0.courtesy > 0 && o0.mult > o0.without && o0.seat === true, JSON.stringify(th.oracle));
  check('SKILL_DMG and DPS_KIT name roster characters in their formats (a Theurgy with its gauge need); the fight length is a saved pref and the old cadence selects are gone',
    th.skillN >= 50 && th.skillBad.length === 0 && th.kitN >= 25 && th.kitBad.length === 0 && th.prefs, JSON.stringify({ s: th.skillBad, k: th.kitBad, n: th.kitN, p: th.prefs }));

  // Wonder: one action a turn shared among his active skills; his setup is saved with the account
  const tw = await p.evaluate(() => {
    const ann = charDef('Ann Takamaki');
    const keep = state.wonder;
    const fake = { personas: {}, cards: {}, weapons: {} };
    const real = WONDER_BUFFS;
    const out = {};
    // three 2-turn cards ask for 9 actions in 6: each is up two-thirds of the time
    const card = (k, v) => [{ k, v, to: 'party', src: 'card', dur: 2, why: 't' }];
    Object.assign(WONDER_BUFFS, { cards: { A: card('atk%', 30), B: card('dmg', 30), C: card('cr', 30) }, personas: { P: [{ k: 'dmg', v: [10, 20, 30], to: 'party', src: 'passive', why: 'p' }], Q: [{ k: 'cm', v: 40, to: 'party', src: 'passive', why: 'q' }] }, weapons: { W: [{ k: 'defdown', ladder: [1, 2, 3, 4, 5, 6, 7], to: 'enemy', src: 'weapon', why: 'w' }] } });
    const slot = (name, cards) => ({ name, cards: cards || ['', '', ''] }), none = slot('');
    const r = tcWonder(ann, { personas: [slot('P', ['A', 'B', 'C']), none, none], weapon: 'W', refine: 3 });
    // a Persona's passive counts only for the turns it is in use: Q casts A (2 of 6 turns... 3 actions), P takes the idle rest
    const r2 = tcWonder(ann, { personas: [slot('P'), slot('Q', ['A', '', '']), none], weapon: '', refine: 1 });
    out.split = r2.lines.map(l => [l.k, +l.up.toFixed(4)]);
    out.cardless = tcWonder(ann, { personas: [none, { name: '', cards: ['A', '', ''] }, none], weapon: '', refine: 1 }).lines.length;
    out.ups = r.lines.map(l => [l.k, +l.up.toFixed(4), l.v]);
    out.busy = r.busy;
    out.none = tcWonder(ann, { personas: [none, none, none], weapon: '', refine: 1 }).lines.length;
    Object.assign(WONDER_BUFFS, real);
    state.wonder = { persona: 'nope', cards: ['x'], weapon: 'y', refine: 99 };
    out.clean = JSON.stringify(wonderSetup());
    // a real setup goes through the save file and back
    const pn = Object.keys(WONDER_BUFFS.personas)[0], cn = Object.keys(WONDER_BUFFS.cards)[0], wn = Object.keys(WONDER_BUFFS.weapons)[0];
    state.wonder = { persona: pn, cards: [cn, '', ''], weapon: wn, refine: 4 };
    const saved = JSON.stringify(savePayload());
    state.wonder = {};
    applySave(saved, '');
    const e3 = { name: '', cards: ['', '', ''] };
    out.trip = JSON.stringify(wonderSetup()) === JSON.stringify({ personas: [{ name: pn, cards: [cn, '', ''] }, e3, e3], weapon: wn, refine: 4 }) && !!pn && !!cn && !!wn;   // an old one-Persona setup becomes slot 1
    hideToast();
    state.wonder = keep;
    return out;
  });
  const up = (k) => (tw.ups.find(x => x[0] === k) || [])[1];
  // three 2-turn cards ask for 9 of his 6 actions: the two worth most are kept up, the third gets none
  const cardUps = ['atkPct', 'cr'].map(up).concat(tw.ups.filter(x => x[0] === 'dm' && x[2] === 30).map(x => x[1]).slice(0, 1));
  check('Wonder\'s actions go to his most valuable skills first, a Persona\'s passives count only while it is in use, cards need their Persona, and an unknown or old setup is read right',
    tw.busy && cardUps.filter(u => u === 1).length === 2 && cardUps.filter(u => u === undefined).length === 1 &&
    tw.ups.some(x => x[0] === 'defdown' && x[2] === 3 && x[1] === 1) && tw.none === 0 &&
    tw.clean === JSON.stringify({ personas: [0, 1, 2].map(() => ({ name: '', cards: ['', '', ''] })), weapon: '', refine: 7 }) && tw.trip &&
    JSON.stringify(tw.split.slice().sort()) === JSON.stringify([['atkPct', 1], ['cm', 0.5], ['dm', 0.5]]) && tw.cardless === 0, JSON.stringify(tw));

  await p.evaluate(() => { tmPick = {}; $('#tmBasis').value = 'calc'; $('#tmChar').value = 'Yusuke Kitagawa'; renderTeams(); });
  const tcPage = await p.evaluate(() => {
    const r = tcTeams('Yusuke Kitagawa'), s = r.team.seats;
    const avail = s.filter(x => x.name).every(x => !tmWhyOut(x.name));
    const roles = s.map(x => x.seat).join('');
    const fuukaOk = (s[3].name === 'Fuuka Yamagishi') === s.some(x => x.seat === 'b');
    const sorted = r.list.every((t, i) => !i || t.calc.mult <= r.list[i - 1].calc.mult + 1e-9);
    return { avail, roles, fuukaOk, sorted, best: r.team.calc.mult, top: r.list[0].calc.mult, text: $('#tmOut').innerText.slice(0, 400), lufel: r.team.calc.lufel };
  });
  check('the calculated basis seats the best-valued team of available characters, a backup only beside Fuuka, and prices lufel\'s team for comparison',
    tcPage.avail && /^fffe(b)?w$/.test(tcPage.roles) && tcPage.fuukaOk && tcPage.sorted && Math.abs(tcPage.best - tcPage.top) < 1e-9 &&
    /Calculated from the kits/.test(tcPage.text) && !!tcPage.lufel, JSON.stringify(tcPage).slice(0, 700));

  // the page: a per-factor summary line per member with the kit lines folded under it, the next
  // teams and lufel's priced against the shown one, synergies named once, rotation options folded
  const tcView = await p.evaluate(() => {
    const out = $('#tmOut');
    const sums = [...out.querySelectorAll('.tmSeat:not(.fixed) .tcSum')].map(x => x.innerText);
    // the damage dealer's own seat: what their damage in the fight was made of, in shares
    const own = (out.querySelector('.tmSeat.fixed .tcSum') || {}).innerText || '';
    const note = (out.querySelector('.tmHlNote') || {}).innerText || '';
    const seatRows = [...out.querySelectorAll('.tmSeats .tmSeat')].slice(1);
    const folded = seatRows.filter(tr => tr.querySelector('.tcSum')).every(tr => /Where it comes from \(\d+ lines?\)/.test(tr.innerText));
    const rel = [...out.querySelectorAll('.tmParty')].map(x => x.innerText);
    const rotOpen = [...out.querySelectorAll('.tmMember')].map(m => [...m.querySelectorAll('.tmRot')].filter(g => !g.closest('details')).length);
    // a sentence both pages carry (Fuuka's about Kumi, Kumi's about Fuuka) is one synergy
    const items = tmSynergyItems(new Set(['Fuuka Yamagishi', 'Kumi Katayama', 'Yusuke Kitagawa']), 'Kumi Katayama');
    return { sums, own, note, folded, rel, rotOpen, items, lufelRel: /comes to ×[\d.]+ \([+−]\d+\.\d%\)/.test(out.innerText) };
  });
  check('each calculated member reads a per-factor summary first, with the kit lines folded under it',
    tcView.sums.length >= 2 && tcView.sums.every(s => /(ATK|damage|crit|Pierce|DEF) [+−]\d/.test(s)) && tcView.folded, JSON.stringify(tcView.sums).slice(0, 300));
  check('the damage dealer\'s seat shows what their own damage in the fight was made of, and the headline says how the fight went',
    /skills \d+%/.test(tcView.own) && /\d+-round fight/.test(tcView.note) && /Highlights and Theurgies used/.test(tcView.note), JSON.stringify({ own: tcView.own, note: tcView.note }).slice(0, 400));
  check('the next teams and lufel\'s team are shown against the chosen one, in percent',
    tcView.rel.length > 0 && tcView.rel.every(r => /\([+−]\d+\.\d%\)/.test(r)) && tcView.lufelRel, JSON.stringify(tcView.rel).slice(0, 300) + ' ' + tcView.lufelRel);
  check('a member\'s rotation shows one option open and folds the others', tcView.rotOpen.length > 0 && tcView.rotOpen.every(n => n <= 1), JSON.stringify(tcView.rotOpen));
  check('a synergy both pages carry the same sentence for is listed once, keeping the Awareness note',
    tcView.items.length === 1 && /needs Awareness 6/.test(tcView.items[0]), JSON.stringify(tcView.items));

  // ---- fitting a rotation to the team (tcRotFit): lufel's skeleton, plain turns re-chosen ----
  const tcFit = await p.evaluate(() => {
    const plain = /^[1-3]$/;
    const dpsOf = e => CHARACTERS.find(c => c.e === e && TM_DPS.includes(c.arch));
    const fire = dpsOf('Fire'), elec = dpsOf('Electric'), ice = dpsOf('Ice');
    $('#tmRotFit').checked = true;
    // Koromaru writes one rotation per element: the fit takes the damage dealer's
    const koro = [fire, elec, ice].map(d => {
      const m = tcMember(d, 'Koromaru', tcTeamSet(d.n, ['Koromaru', null, null]), null, true);
      return { e: d.e, seq: m.rot ? m.rot.seq.join(' ') : null, off: m.lines.filter(l => l.offRot).length, shared: m.lines.filter(l => /Skills 1-3/.test(l.why)).map(l => l.up) };
    });
    // invariants over every priced member for one damage dealer: structural turns kept, plain
    // counts within lufel's per-turn frequencies, never worse than lufel's first option
    const bad = [];
    const d = charDef('Yusuke Kitagawa');
    let fitted = 0;
    for (const n of Object.keys(TEAM_BUFFS)) {
      if (n === d.n || !(TEAMS[n] || {}).rot) continue;
      const team = tcTeamSet(d.n, [n, null, null]);
      const m = tcMember(d, n, team, null, true), r = tmRotPick(n, team);
      if (!m.rot) continue;
      fitted++;
      const F = m.rot, base = r.pick[F.base.index];
      if (F.seq.length !== base.seq.length) bad.push(n + ' length');
      base.seq.forEach((t, i) => { if (!plain.test(t) && F.seq[i] !== t) bad.push(n + ' structural turn ' + (i + 1)); });
      F.changed.forEach(i => { if (F.seq[i] === base.seq[i] || !plain.test(F.seq[i])) bad.push(n + ' change ' + (i + 1)); });
      const toks = [...new Set(r.pick.flatMap(b => b.seq.filter(t => plain.test(t))))];
      for (const t of toks) {
        const f = F.seq.filter(x => x === t).length / F.seq.length;
        const fs = r.pick.map(b => b.seq.filter(x => x === t).length / b.seq.length);
        if (f < Math.min(...fs) - 1e-9 - 1 / F.seq.length || f > Math.max(...fs) + 1e-9 + 1 / F.seq.length) bad.push(n + ' frequency of ' + t);
      }
      if (F.seq.some(t => plain.test(t) && !toks.includes(t))) bad.push(n + ' a skill lufel never writes');
      if (F.gain < -1e-9) bad.push(n + ' worse than lufel');
      if (F.same && F.gain !== 0) bad.push(n + ' same but gains');
    }
    // a rotation that wastes a 2-turn buff by casting it on consecutive turns is re-ordered
    const keepT = TEAMS['Ryuji Sakamoto'], keepB = TEAM_BUFFS['Ryuji Sakamoto'];
    TEAMS['Ryuji Sakamoto'] = { rot: [{ aw: 0, label: 'Test', seq: ['3', '3', '1', '1', '3', '1'] }] };
    TEAM_BUFFS['Ryuji Sakamoto'] = [{ k: 'dmg', v: 20, to: 'enemy', src: '3', on: '3', dur: 2, why: 'test: a 2-turn debuff from Skill 3' }];
    tcMemo.key = '';
    const team = tcTeamSet(d.n, ['Ryuji Sakamoto', null, null]);
    const on = tcMember(d, 'Ryuji Sakamoto', team, null, true), off = tcMember(d, 'Ryuji Sakamoto', team, null, false);
    const re = { seq: on.rot && on.rot.seq.join(' '), gain: on.rot && on.rot.gain, changed: on.rot && on.rot.changed,
      upOn: on.lines[0].up, upOff: off.lines[0].up, offRot: off.rot, counts: on.rot && ['1', '3'].map(t => on.rot.seq.filter(x => x === t).length) };
    // the lineup prices the fitted rotation, and the pref switches it off
    const withFit = tcLineup(d, ['Ryuji Sakamoto', null, null]).mult;
    $('#tmRotFit').checked = false;
    const noFit = tcLineup(d, ['Ryuji Sakamoto', null, null]).mult;
    const noRot = tcLineup(d, ['Ryuji Sakamoto', null, null]).members[0].rot;
    $('#tmRotFit').checked = true;
    const prefOn = collectPrefs().tmRotFit;
    applyPrefs({ tmRotFit: false }); const prefOff = $('#tmRotFit').checked;
    $('#tmRotFit').checked = true;
    TEAMS['Ryuji Sakamoto'] = keepT; TEAM_BUFFS['Ryuji Sakamoto'] = keepB; tcMemo.key = '';
    return { koro, bad, fitted, re, withFit, noFit, noRot, prefOn, prefOff };
  });
  check('Koromaru\'s rotation follows the damage dealer\'s element, and his shared damage line counts whichever skill it is',
    tcFit.koro[0].seq === 'TH+1 1 TH+1 1 TH+1 1' && tcFit.koro[1].seq === 'TH+2 2 TH+2 2 TH+2 2' && tcFit.koro[2].seq === 'TH+3 3 TH+3 3 TH+3 3' &&
    tcFit.koro.every(k => k.shared.length === 1 && k.shared[0] === 1), JSON.stringify(tcFit.koro));
  check('a fitted rotation keeps lufel\'s structural turns, stays within lufel\'s skill frequencies, introduces no skill lufel never writes, and is never worse than lufel\'s first option',
    tcFit.bad.length === 0 && tcFit.fitted >= 5, JSON.stringify(tcFit.bad).slice(0, 400) + ' fitted ' + tcFit.fitted);
  check('a 2-turn buff cast on consecutive turns is re-ordered to lapse first, with the same skill counts; the lineup prices it, and the pref turns it off',
    tcFit.re.seq === '3 1 3 1 3 1' && tcFit.re.gain > 0 && tcFit.re.changed.length === 2 && Math.abs(tcFit.re.upOn - 1) < 1e-9 && Math.abs(tcFit.re.upOff - 5 / 6) < 1e-9 &&
    tcFit.re.offRot === null && JSON.stringify(tcFit.re.counts) === '[3,3]' && tcFit.withFit > tcFit.noFit && tcFit.noRot === null && tcFit.prefOn === true && tcFit.prefOff === false,
    JSON.stringify(tcFit.re) + ' ' + tcFit.withFit + ' ' + tcFit.noFit + ' ' + tcFit.prefOn + ' ' + tcFit.prefOff);
  // the page: a changed turn is highlighted and the panel says what was fitted; off, lufel's as written
  const tcFitPage = await p.evaluate(() => {
    const d = 'Yusuke Kitagawa';
    const keepT = TEAMS['Ryuji Sakamoto'], keepB = TEAM_BUFFS['Ryuji Sakamoto'], keepOwned = state.chars['Ryuji Sakamoto'].owned;
    TEAMS['Ryuji Sakamoto'] = { rot: [{ aw: 0, label: 'Test', seq: ['3', '3', '1', '1', '3', '1'] }] };
    TEAM_BUFFS['Ryuji Sakamoto'] = [{ k: 'dmg', v: 20, to: 'enemy', src: '3', on: '3', dur: 2, why: 'test: a 2-turn debuff from Skill 3' }];
    state.chars['Ryuji Sakamoto'].owned = true;
    tcMemo.key = ''; tmPick = {};
    const elu = tcTeams(d).team.seats.find(s => s.seat === 'e').name;
    tmPick[d] = { key: 'calc:Ryuji Sakamoto||' + elu, seats: {} };
    $('#tmBasis').value = 'calc'; $('#tmChar').value = d; $('#tmRotFit').checked = true;
    renderTeams();
    const panel = () => [...$$('#tmOut .panel')].find(x => /^rotation$/i.test((x.querySelector('h2') || {}).innerText || ''));
    const on = { hot: panel().querySelectorAll('.tmRot .t.fit').length, text: panel().innerText };
    $('#tmRotFit').checked = false; renderTeams();
    const off = { hot: panel().querySelectorAll('.tmRot .t.fit').length, text: panel().innerText };
    $('#tmRotFit').checked = true; tmPick = {};
    TEAMS['Ryuji Sakamoto'] = keepT; TEAM_BUFFS['Ryuji Sakamoto'] = keepB; state.chars['Ryuji Sakamoto'].owned = keepOwned; tcMemo.key = '';
    renderTeams();
    return { on, off };
  });
  check('the Rotation panel highlights the changed turns and names the gain; with the fit off it shows lufel\'s as written',
    tcFitPage.on.hot === 2 && /Fitted to this team/.test(tcFitPage.on.text) && /\+\d+\.\d% team damage/.test(tcFitPage.on.text) && /turns 2, 3 re-chosen/.test(tcFitPage.on.text) &&
    tcFitPage.off.hot === 0 && !/Fitted to this team/.test(tcFitPage.off.text) && /as written/.test(tcFitPage.off.text),
    JSON.stringify({ on: tcFitPage.on.hot, off: tcFitPage.off.hot, t: tcFitPage.on.text.slice(0, 300) }));

  // the memo: what a render remembers is keyed on the save, so a change made without commit()
  // (as these tests make them) is still seen, and a plain repeat is served from memory
  const tcMemoT = await p.evaluate(() => {
    const d = charDef('Ann Takamaki'), atk = { atkPct: 50 };   // an ATK kit: an ATK buff reaches her ⓐ
    const a = tcMultiplier(d, [atk]);
    const keepLo = state.chars[d.n].loadout;   // Awareness 6 adds 15% ATK to her base, so the same buff is worth a different ratio
    state.chars[d.n].loadout = Object.assign({}, DEFAULT_LOADOUT, { weapon: '4', awareness: 6 });
    const b = tcMultiplier(d, [atk]);
    state.chars[d.n].loadout = keepLo;
    const c = tcMultiplier(d, [atk]);
    const t0 = performance.now(); tcTeams(d.n); const fresh = performance.now() - t0;
    const t1 = performance.now(); tcTeams(d.n); const again = performance.now() - t1;
    return { a, b, c, fresh, again, hot: tcMemo.hot };
  });
  check('the team memo follows the save: a card changed without commit() re-prices, a repeat is served from memory',
    Math.abs(tcMemoT.a - tcMemoT.c) < 1e-12 && tcMemoT.a !== tcMemoT.b && tcMemoT.again < tcMemoT.fresh && !tcMemoT.hot, JSON.stringify(tcMemoT));

  // marking a member busy: with no choice the whole team is searched again; a chosen team keeps
  // the user's other picks and refills the emptied seat, never leaving it empty
  const tcBusy = await p.evaluate(() => {
    const d = 'Yusuke Kitagawa', seatNames = r => r.team.seats.filter(s => !s.fixed && s.seat !== 'w').map(s => s.name);
    tmPick = {}; tmBusy = new Set();
    const before = seatNames(tcTeams(d));
    tmBusy.add(before[0]);                       // a thief
    const after = seatNames(tcTeams(d));
    tmBusy = new Set();
    const chosen = tcTeams(d).list[1].calc;      // the runner-up, chosen by the user
    tmPick[d] = { key: chosen.key, seats: {} };
    tmBusy.add(chosen.names[0]);
    const kept = seatNames(tcTeams(d));
    tmBusy = new Set(); tmPick = {};
    return { before, after, chosen: chosen.names, kept };
  });
  check('marking a member busy re-runs the search, and a chosen team refills the busy seat around the rest',
    !tcBusy.after.includes(tcBusy.before[0]) && tcBusy.after.slice(0, 3).every(Boolean) &&
    !!tcBusy.kept[0] && tcBusy.kept[0] !== tcBusy.chosen[0] && tcBusy.kept[1] === tcBusy.chosen[1] && tcBusy.kept[2] === tcBusy.chosen[2],
    JSON.stringify(tcBusy));

  await p.evaluate(k => { state.chars = JSON.parse(k.chars); tmBusy = new Set(k.busy); tmPick = JSON.parse(k.pick); commit(); showTab('roster'); }, tmKeep);

  check('no browser storage is touched (Cowork artifact constraint)', await p.evaluate(() => { try { return localStorage.length === 0 && sessionStorage.length === 0; } catch (e) { return true; } }));

  // Outside the page: the generator's hand-tuned table must match src/data.js
  const drift = weightOverrideDrift();
  check('WEIGHT_OVERRIDES in the generator matches src/data.js', drift.length === 0, drift.join(' | '));
  const awDrift = awarenessOverrideDrift();
  check('GLB_AWARENESS_OVERRIDES in tools/gen-awareness.js matches src/data.js', awDrift.length === 0, awDrift.join(' | '));

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
