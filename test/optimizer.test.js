const { chromium } = require('playwright');
const path = require('path');
const PAGE = 'file://' + path.join(__dirname, '..', 'dist', 'p5x-planner.html');

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  p.on('console', m => {
    if (m.type() !== 'error') return;
    // Roster portraits are optional files in art/ next to the HTML; each <img>
    // removes itself on error so a missing one falls back to the initials
    // placeholder. With no art/ folder that is 63 expected 404s, which are the
    // feature working, not a fault — but only ignore that exact case.
    const loc = (m.location() && m.location().url) || '';
    if (/\/art\/[^/]+\.png$/.test(loc)) return;
    errs.push('CONSOLE: ' + m.text());
  });
  await p.goto(PAGE);
  await p.waitForTimeout(400);

  const r = await p.evaluate(() => {
    // ---- build a synthetic inventory: 600 cards ----
    let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pickR = a => a[Math.floor(rnd() * a.length)];
    const heavens = ['Sun','Moon','Star','Sky'];
    const setNames = Object.keys(SETS), spaceNames = Object.keys(SPACE_SETS);
    const subPool = Object.keys(SUBSTATS);
    state.cards = [];
    for (let i = 0; i < 600; i++) {
      const slot = rnd() < 0.15 ? 'Space' : pickR(heavens);
      const set = slot === 'Space' ? pickR(spaceNames) : pickR(setNames);
      const rarity = pickR([5,5,5,4,4,3,2]);
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

    // exercise every character
    let planned = 0, incomplete = 0;
    const legality = [];
    for (const ch of CHARACTERS) {
      const t = target(ch);
      const res = bestPlan(ch, state.cards.filter(c => c.rarity >= 2), {policy:'pref'});
      if (!res.best) { incomplete++; continue; }
      planned++;
      // slot legality: every picked card must sit in the slot it was picked for
      for (const sl of heavens) {
        const pk = res.best.picks[sl];
        if (pk && pk.c.slot !== sl) legality.push(`${ch.n}: ${sl} got a ${pk.c.slot} card`);
      }
      // set-plan integrity
      if (res.best.kind === '4pc') {
        const S = res.best.sets[0];
        for (const sl of heavens) if (res.best.picks[sl].c.set !== S) legality.push(`${ch.n}: 4pc ${S} contains ${res.best.picks[sl].c.set}`);
      }
      if (res.best.kind === '2+2') {
        const counts = {};
        heavens.forEach(sl => { const s = res.best.picks[sl].c.set; counts[s] = (counts[s]||0)+1; });
        const vals = Object.values(counts).sort();
        if (vals.length !== 2 || vals[0] !== 2 || vals[1] !== 2) legality.push(`${ch.n}: 2+2 plan is actually ${JSON.stringify(counts)}`);
      }
      // best plan must beat every alternative
      // within the same policy class, nothing may beat the chosen plan
      const sameClass = res.alternatives.filter(a => a.sets.some(s => t.sets.includes(s)));
      for (const alt of sameClass) if (alt.total > res.best.total + 1e-9) legality.push(`${ch.n}: alt "${alt.label}" (${alt.total}) beats best (${res.best.total})`);
      // no duplicate loadouts in the alternatives list
      const keys = new Set([res.best, ...res.alternatives].map(p => heavens.map(sl => p.picks[sl].c.id).sort().join('|')));
      if (keys.size !== res.alternatives.length + 1) legality.push(`${ch.n}: duplicate loadouts in alternatives`);
      // element sets must never be recommended off-element as a 4pc
      for (const S of res.best.sets) {
        const def = SETS[S];
        if (def && def.elem && def.elem !== ch.e && res.best.kind === '4pc')
          legality.push(`${ch.n} (${ch.e}): recommended off-element 4pc ${S}`);
      }
      if (out.plans.length < 6) out.plans.push({
        char: ch.n, elem: ch.e, plan: res.best.label, total: +res.best.total.toFixed(1),
        space: res.space ? res.space.c.set + (res.space.pairs ? ' (pairs)' : ' (no synergy)') : 'none',
        mains: heavens.map(sl => `${sl}:${res.best.picks[sl].c.main}`).join(' ')
      });
    }
    fail('every character produced a plan', incomplete === 0, `${incomplete} without a plan`);
    fail('no slot/set legality violations', legality.length === 0, legality.slice(0,5).join(' | '));

    // scoring sanity: a perfect on-target card must outscore a junk card
    const joker = charDef('Ren Amamiya'), tj = target(joker);
    const good = { slot:'Star', set:'Hindrance', rarity:5, level:25, main:'Crit Rate',
      subs:[{stat:'Crit Multiplier',value:16.4},{stat:'Resistance Pierce',value:8.4},{stat:'ATK%',value:14},{stat:'Crit Rate',value:8}] };
    const bad = { slot:'Star', set:'Hindrance', rarity:5, level:25, main:'DEF%',
      subs:[{stat:'DEF',value:184},{stat:'HP',value:560},{stat:'DEF%',value:20.8},{stat:'HP%',value:14.4}] };
    fail('on-target card outscores junk', cardScore(good,tj) > cardScore(bad,tj)*3,
      `${cardScore(good,tj).toFixed(1)} vs ${cardScore(bad,tj).toFixed(1)}`);

    // Skull ignores crit rate entirely
    const skull = charDef('Ryuji Sakamoto'), ts = target(skull);
    fail('Skull weights Crit Rate at 0', ts.w['Crit Rate'] === 0, 'w=' + ts.w['Crit Rate']);
    fail('Skull wants Crit Multiplier on Star', ts.main.Star === 'Crit Multiplier', ts.main.Star);

    // Messa ignores crit entirely
    const messa = charDef('Kira Kitazato'), tm = target(messa);
    fail('Messa weights both crit stats at 0', tm.w['Crit Rate'] === 0 && tm.w['Crit Multiplier'] === 0);

    // main stat legality across the whole roster
    const badMain = [];
    for (const ch of CHARACTERS) {
      const t = target(ch);
      for (const sl of ['Moon','Star','Sky'])
        if (!SLOT_INFO[sl].mains.includes(t.main[sl])) badMain.push(`${ch.n} ${sl}=${t.main[sl]}`);
    }
    fail('all target main stats are legal for their slot', badMain.length === 0, badMain.join(' | '));

    // every referenced set / space set exists
    const badRef = [];
    for (const ch of CHARACTERS) {
      (ch.sets||[]).forEach(s => { if (!SETS[s]) badRef.push(`${ch.n} set ${s}`); });
      if (ch.space && !SPACE_SETS[ch.space]) badRef.push(`${ch.n} space ${ch.space}`);
    }
    fail('all referenced sets exist', badRef.length === 0, badRef.join(' | '));

    // space pairings reference real heavens sets
    const badPair = [];
    Object.entries(SPACE_SETS).forEach(([k,v]) => v.pairs.forEach(p => { if (!SETS[p]) badPair.push(`${k}->${p}`); }));
    fail('all space pairings reference real sets', badPair.length === 0, badPair.join(' | '));

    // a character's own preferred sets must be able to give them a live 2-piece bonus —
    // an elemental set that doesn't match the character's element is dead weight and
    // should never be listed (caught a real data bug: Kira Kitazato listed Pleasure,
    // which is Psychokinesis-elemental, despite being Physical himself)
    const deadOwnSets = [];
    for (const ch of CHARACTERS) {
      (ch.sets || []).forEach(s => {
        const def = SETS[s];
        if (def && def.elem && def.elem !== ch.e) deadOwnSets.push(`${ch.n} (${ch.e}) lists off-element set ${s} (${def.elem})`);
      });
    }
    fail('no character lists an off-element set among their own preferred sets',
      deadOwnSets.length === 0, deadOwnSets.join(' | '));

    // aliases resolve
    fail('alias CDMG resolves', normStat('CDMG') === 'Crit Multiplier');
    fail('alias EHR resolves', normStat('ehr') === 'Ailment Accuracy');
    // literal in-game filter-menu labels (confirmed from screenshots, Aug 2026) —
    // trailing-period abbreviations and "Pierce Rate" specifically
    fail('in-game label "Pierce Rate" resolves', normStat('Pierce Rate') === 'Resistance Pierce');
    fail('in-game label "Ailment Acc." resolves', normStat('Ailment Acc.') === 'Ailment Accuracy');
    fail('in-game label "Crit Mult." resolves', normStat('Crit Mult.') === 'Crit Multiplier');
    fail('in-game label "Damage Mult.+" resolves', normStat('Damage Mult.+') === 'Damage Multiplier');
    // ATK/DEF/HP share one on-screen label ("Attack"/"Defense"/"HP") for both their flat
    // and %-of-stat forms — only the value's trailing % says which. normStat's 2nd arg
    // carries that signal; default (no arg) must keep resolving to the flat form so
    // nothing that already worked changes behaviour.
    fail('bare "Attack" with no percent hint stays flat ATK', normStat('Attack') === 'ATK');
    fail('bare "Attack" with a percent hint resolves to ATK%', normStat('Attack', true) === 'ATK%');
    fail('bare "Defense" with a percent hint resolves to DEF%', normStat('Defense', true) === 'DEF%');
    fail('bare "HP" with a percent hint resolves to HP%', normStat('HP', true) === 'HP%');
    fail('a stat with no flat/percent pair ignores the percent hint', normStat('Speed', true) === 'Speed');
    fail('alias Strength -> Power', normSet('strength') === 'Power');
    fail('Ruin is its own set, not aliased away', normSet('Ruin') === 'Ruin' && !!SETS['Ruin']);
    fail('Prudence is its own set', normSet('prudence') === 'Prudence' && !!SETS['Prudence']);
    fail('unverified sets score 0 for their 2-piece',
      bonus2Value('Ruin', charDef('Makoto Yuki'), target(charDef('Makoto Yuki'))) === 0);
    fail('Makoto Yuki prefers Ruin', target(charDef('Makoto Yuki')).sets[0] === 'Ruin');

    // duplicate character names?
    const names = CHARACTERS.map(c => c.n);
    fail('no duplicate character names', new Set(names).size === names.length,
      names.filter((n,i)=>names.indexOf(n)!==i).join(', '));

    // ---- validateCard ----
    const vGood = { slot:'Star', set:'Hindrance', rarity:5, level:25, main:'Crit Rate',
      subs:[{stat:'Crit Multiplier',value:16.4},{stat:'Resistance Pierce',value:8.4},{stat:'ATK%',value:14},{stat:'Speed',value:6.6}] };
    fail('validateCard accepts a well-formed card', validateCard(vGood).length === 0, validateCard(vGood).join('; '));
    fail('validateCard rejects an illegal main stat for the slot',
      validateCard(Object.assign({}, vGood, { main: 'SP Recovery' })).length > 0);
    fail('validateCard rejects a substat that duplicates the main stat',
      validateCard(Object.assign({}, vGood, { subs: vGood.subs.concat([{ stat: 'Crit Rate', value: 5 }]) })).length > 0);
    fail('validateCard rejects too many substats for the rarity',
      validateCard(Object.assign({}, vGood, { rarity: 2 })).length > 0);
    fail('validateCard rejects a substat value far above its roll ceiling',
      validateCard(Object.assign({}, vGood, { subs: [{ stat: 'Crit Multiplier', value: 500 }, vGood.subs[1], vGood.subs[2], vGood.subs[3]] })).length > 0);

    // ---- mergeImport ----
    const cardA = { id:'a1', slot:'Star', set:'Hindrance', rarity:5, level:15, main:'Crit Rate', equipped:null,
      subs:[{stat:'Crit Multiplier',value:10},{stat:'ATK%',value:8},{stat:'Speed',value:4}] };
    const leveledUp = Object.assign({}, cardA, { level:25,
      subs:[{stat:'Crit Multiplier',value:16.4},{stat:'ATK%',value:14},{stat:'Speed',value:6.6},{stat:'Resistance Pierce',value:8.4}] });
    const r1 = mergeImport([cardA], [leveledUp]);
    fail('mergeImport treats a monotonic level-up as an update, not a duplicate or a new card',
      r1.toUpdate.length === 1 && r1.toAdd.length === 0 && r1.ambiguous.length === 0);

    const cardB = Object.assign({}, cardA, { id:'b1' });
    const exactDup = { slot:'Star', set:'Hindrance', rarity:5, level:15, main:'Crit Rate', equipped:null,
      subs: cardB.subs.map(s => Object.assign({}, s)) };
    const r2 = mergeImport([cardB], [exactDup]);
    fail('mergeImport skips an exact resubmission as a duplicate',
      r2.duplicates.length === 1 && r2.toAdd.length === 0 && r2.toUpdate.length === 0);

    const cardC = Object.assign({}, cardA, { id:'c1' });
    const shrunk = { slot:'Star', set:'Hindrance', rarity:5, level:15, main:'Crit Rate', equipped:null,
      subs:[{stat:'Crit Multiplier',value:2},{stat:'ATK%',value:1},{stat:'Speed',value:0.5}] };
    const r3 = mergeImport([cardC], [shrunk]);
    fail('mergeImport flags a value decrease as ambiguous instead of silently overwriting',
      r3.ambiguous.length === 1 && r3.toUpdate.length === 0 && r3.duplicates.length === 0);

    const brandNew = { slot:'Sky', set:'Departure', rarity:5, level:25, main:'Speed', equipped:null,
      subs:[{stat:'ATK%',value:10},{stat:'DEF%',value:5},{stat:'HP',value:80}] };
    const r4 = mergeImport([cardA], [brandNew]);
    fail('mergeImport adds a card with no fingerprint match as new', r4.toAdd.length === 1);

    out.charCount = CHARACTERS.length;
    out.planned = planned;
    return out;
  });

  // bulk paste round-trip through the real UI
  await p.click('nav button[data-tab="inv"]');
  await p.fill('#bulk', [
    'Star | Hindrance | 5 | 25 | Crit Rate | CDMG 16.4, Pen 8.4, ATK% 14, SPD 6.6',
    'Planet | Ruin | 5 | 25 | Speed | EHR 12.3, crit rate 7.9, atk% 10.5, hp% 7.2',
    'Sun | Strength | 4 | 20 | HP | dmg bonus 8.4, sp regen 30, def% 15.6, atk 138',
    'Universe | Departure | 5 | 25 | ATK + DEF | CDMG 20.8, CR 10.4, ATK% 17.2, SPD 8.4',
    // real in-game labels (screenshot-confirmed): bare "Damage Mult.+"/"HP"/"Defense"/
    // "Pierce Rate" — HP and Defense here must resolve to the % variant, not flat
    'Star | Futility | 5 | 25 | Crit Rate | Damage Mult.+ 2.1%, HP 2.9%, Defense 4.1%, Pierce Rate 1.4%',
    'Bogus | Nonsense | 9 | 3 | Whatever | nope 1'
  ].join('\n'));
  await p.click('#bulkAdd');
  await p.waitForTimeout(200);
  const bulkMsg = await p.textContent('#bulkMsg');
  const parsed = await p.evaluate(() => state.cards.slice(-5).map(c => `${c.slot}/${c.set}/${c.main}/${c.subs.map(s=>s.stat).join('+')}`));
  const futilityCard = await p.evaluate(() => state.cards.slice(-5).find(c => c.set === 'Futility'));

  // full UI walk: own a character, run optimiser, equip, triage, save
  await p.evaluate(() => { ['Ren Amamiya','Ryuji Sakamoto','Morgana','Kira Kitazato','Yusuke Kitagawa'].forEach(n => state.chars[n].owned = true); renderOpt(); renderRoster(); });
  await p.click('nav button[data-tab="opt"]');
  await p.click('#optRun'); await p.waitForTimeout(200);
  const optText = await p.textContent('#optOut');
  await p.click('#equipBtn'); await p.waitForTimeout(200);
  const equippedCount = await p.evaluate(() => state.cards.filter(c => c.equipped === 'Ren Amamiya').length);
  await p.click('nav button[data-tab="triage"]');
  await p.click('#trRun'); await p.waitForTimeout(300);
  const trRows = await p.evaluate(() => document.querySelectorAll('#trTable tbody tr').length);
  await p.click('nav button[data-tab="roster"]');
  await p.evaluate(() => editTargets('Ren Amamiya'));
  await p.waitForTimeout(150);
  const dlgOpen = await p.evaluate(() => document.getElementById('dlg').open);
  await p.evaluate(() => { document.getElementById('tSave').click(); });
  await p.waitForTimeout(150);

  // import review dialog: renders ambiguous rows and applies decisions on click
  await p.click('nav button[data-tab="data"]');
  const importCheck = await p.evaluate(() => {
    const ix1 = { id:'ix1', slot:'Moon', set:'Power', rarity:5, level:15, main:'ATK%', equipped:null,
      subs:[{stat:'Speed',value:2},{stat:'HP',value:60}] };
    const ix2 = { id:'ix2', slot:'Star', set:'Opulence', rarity:5, level:15, main:'Crit Rate', equipped:null,
      subs:[{stat:'Crit Multiplier',value:8},{stat:'ATK%',value:6}] };
    state.cards.push(ix1, ix2);
    const incomingUpdate = { slot:'Moon', set:'Power', rarity:5, level:25, main:'ATK%', equipped:null,
      subs:[{stat:'Speed',value:4},{stat:'HP',value:120},{stat:'ATK',value:20}] };
    const incomingNew = { slot:'Sky', set:'Trust', rarity:4, level:20, main:'DEF%', equipped:null,
      subs:[{stat:'HP%',value:2},{stat:'DEF',value:20}] };
    const incomingAmbiguous = { slot:'Star', set:'Opulence', rarity:5, level:15, main:'Crit Rate', equipped:null,
      subs:[{stat:'Crit Multiplier',value:1},{stat:'ATK%',value:1}] };
    const result = mergeImport(state.cards, [incomingUpdate, incomingNew, incomingAmbiguous]);
    renderImportReview(result, []);
    return {
      ambiguousShown: document.querySelectorAll('[data-amb]').length,
      dlgOpen: document.getElementById('dlg').open,
      toAdd: result.toAdd.length, toUpdate: result.toUpdate.length
    };
  });
  await p.waitForTimeout(150);
  await p.evaluate(() => { document.getElementById('applyImport').click(); });
  await p.waitForTimeout(150);
  const afterImport = await p.evaluate(() => ({
    ix1Level: (state.cards.find(c => c.id === 'ix1') || {}).level,
    ix2StillAtOldLevel: (state.cards.find(c => c.id === 'ix2') || {}).level === 15,
    totalCards: state.cards.length
  }));

  const extraFailures = [];
  if (importCheck.toAdd !== 1 || importCheck.toUpdate !== 1 || importCheck.ambiguousShown !== 1)
    extraFailures.push(`import review classified toAdd=${importCheck.toAdd} toUpdate=${importCheck.toUpdate} ambiguous=${importCheck.ambiguousShown}, expected 1/1/1`);
  if (!importCheck.dlgOpen) extraFailures.push('import review dialog did not open');
  if (afterImport.ix1Level !== 25) extraFailures.push(`expected leveled-up card to update to Lv25, got Lv${afterImport.ix1Level}`);
  if (!afterImport.ix2StillAtOldLevel) extraFailures.push('ambiguous row was applied even though the decision defaults to "skip"');
  if (afterImport.totalCards !== 608) extraFailures.push(`expected 608 cards after import review (605 + 2 pushed + 1 added), got ${afterImport.totalCards}`);
  if (!futilityCard) extraFailures.push('bulk-pasted Futility card (real in-game labels) did not import at all');
  else {
    const subStats = futilityCard.subs.map(s => s.stat).sort().join(',');
    const expected = ['Damage Multiplier', 'DEF%', 'HP%', 'Resistance Pierce'].sort().join(',');
    if (subStats !== expected) extraFailures.push(`Futility card resolved substats as "${subStats}", expected "${expected}" (bare "HP"/"Defense" with a % value must resolve to HP%/DEF%, not flat)`);
  }

  const failures = r.checks.filter(c => !c.pass);
  console.log(JSON.stringify({ ...r, bulkMsg, parsed, equippedCount, trRows, dlgOpen,
    optHasLoadout: /Recommended loadout/.test(optText), importCheck, afterImport, errs }, null, 2));
  await b.close();
  if (failures.length || errs.length || extraFailures.length) {
    console.error(`\n${failures.length} check(s) failed, ${errs.length} page error(s), ${extraFailures.length} import-review issue(s).`);
    extraFailures.forEach(f => console.error(' - ' + f));
    process.exit(1);
  }
  console.log(`\nAll ${r.checks.length} checks passed.`);
})();
