/* ============================ state ============================ */
const state = { cards: [], chars: {}, nextId: 1 };
const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

CHARACTERS.forEach(c => { state.chars[c.n] = { owned: false, targets: null }; });

/* Merge archetype defaults + per-character overrides + user edits. */
function target(charDef) {
  const A = ARCHETYPES[charDef.arch];
  const saved = state.chars[charDef.n] && state.chars[charDef.n].targets;
  if (saved) return saved;
  const ov = charDef.ov || {};
  return {
    sets:  (charDef.sets || []).slice(),
    space: charDef.space || '',
    main:  Object.assign({}, A.main, ov.main || {}),
    w:     Object.assign({}, A.w, ov.w || {}),
    bp:    ov.bp || '',
    note:  ov.note || ''
  };
}
const charDef = name => CHARACTERS.find(c => c.n === name);
const maxRoll = (stat, slot) =>
  slot === 'Space' ? (SUBSTATS[stat].maxRollSpace || SUBSTATS[stat].maxRoll) : SUBSTATS[stat].maxRoll;

function normStat(raw) {
  if (!raw) return null;
  const t = String(raw).trim();
  if (SUBSTATS[t] || t === 'HP Recovery' || t === 'ATK + DEF') return t;
  // The in-game filter UI abbreviates with a trailing period ("Ailment Acc.", "Crit
  // Mult.", "Damage Mult.+") — strip that punctuation before alias lookup so those
  // exact in-game labels resolve without needing a separate alias per variant.
  const k = t.toLowerCase().replace(/\s+/g, ' ').replace(/[%+.]+$/, '').trim();
  for (const s of Object.keys(SUBSTATS)) if (s.toLowerCase() === k) return s;
  if (STAT_ALIASES[k]) return STAT_ALIASES[k];
  const pk = k + '%';
  for (const s of Object.keys(SUBSTATS)) if (s.toLowerCase() === pk) return s;
  return null;
}
function normSet(raw) {
  if (!raw) return null;
  const t = String(raw).trim();
  if (SETS[t] || SPACE_SETS[t]) return t;
  const k = t.toLowerCase();
  for (const s of Object.keys(SETS)) if (s.toLowerCase() === k) return s;
  for (const s of Object.keys(SPACE_SETS)) if (s.toLowerCase() === k) return s;
  if (SET_ALIASES[k]) return SET_ALIASES[k];
  return null;
}

/* ======================== validation ========================
   Single source of truth for "is this card legal" — used by the bulk paste
   parser, the single-card form, JSON load, and the merge importer below.
   A card that fails here never reaches state.cards; the caller decides what
   to do with the error list. */
function validateCard(c) {
  const errs = [];
  if (!SLOTS.includes(c.slot)) { errs.push(`unknown slot "${c.slot}"`); return errs; }
  const info = SLOT_INFO[c.slot];
  const setTable = c.slot === 'Space' ? SPACE_SETS : SETS;
  if (!setTable[c.set]) errs.push(`"${c.set}" is not a legal set for ${c.slot}`);
  if (!RARITY[c.rarity]) { errs.push(`bad rarity "${c.rarity}"`); return errs; }
  const R = RARITY[c.rarity];
  if (!(Number.isInteger(c.level) && c.level >= 0 && c.level <= R.maxLevel))
    errs.push(`level must be 0-${R.maxLevel} for ${c.rarity}★`);
  if (!info.mains.includes(c.main)) errs.push(`"${c.main}" is not a legal main stat for ${c.slot}`);
  const subs = c.subs || [];
  if (subs.length < R.subMin || subs.length > R.subMax)
    errs.push(`${c.rarity}★ cards have ${R.subMin === R.subMax ? R.subMin : R.subMin + '-' + R.subMax} substats, got ${subs.length}`);
  const seen = new Set();
  subs.forEach(s => {
    if (!SUBSTATS[s.stat]) { errs.push(`unknown substat "${s.stat}"`); return; }
    if (s.stat === c.main) errs.push(`substat "${s.stat}" duplicates the main stat`);
    if (seen.has(s.stat)) errs.push(`substat "${s.stat}" appears twice`);
    seen.add(s.stat);
    const mx = maxRoll(s.stat, c.slot) * 5;
    if (!(typeof s.value === 'number' && isFinite(s.value) && s.value > 0 && s.value <= mx))
      errs.push(`${s.stat} value ${s.value} is out of range (max ~${mx.toFixed(1)})`);
  });
  return errs;
}

/* Re-resolve a raw (possibly hand-typed or OCR'd) card object against the
   canonical tables, the same way the bulk parser does — so JSON coming from
   outside this app still matches on set/stat aliases. Does not validate. */
function normalizeCard(rc) {
  const slot = SLOTS.find(s => s === rc.slot) || rc.slot;
  const set = normSet(rc.set) || rc.set;
  const rarity = +rc.rarity;
  const level = parseInt(rc.level, 10) || 0;
  const info = SLOT_INFO[slot];
  const main = (info && info.fixed) ? info.mains[0] : (normStat(rc.main) || rc.main);
  const subs = (rc.subs || []).map(s => ({ stat: normStat(s.stat) || s.stat, value: +s.value }));
  const card = { slot, set, rarity, level, main, subs, equipped: rc.equipped || null };
  if (rc.conf) card.conf = rc.conf;
  if (rc.src) card.src = rc.src;
  return card;
}

/* ======================== import merge ========================
   Cards have no in-game serial number, so "the same physical card, scanned
   again" has to be inferred: same slot/set/rarity/main groups candidates,
   then the nearest existing card by level+substat distance decides whether
   an incoming card is a duplicate, a level-up, or ambiguous. Ambiguous means
   a human should look at it — never silently overwritten. */
function cardFingerprint(c) { return [c.slot, c.set, c.rarity, c.main].join('|'); }

function subFingerprint(subs) { return (subs || []).map(s => s.stat).slice().sort().join('+'); }

function subsClose(a, b, eps) {
  if (subFingerprint(a) !== subFingerprint(b)) return false;
  const mapB = {}; b.forEach(s => mapB[s.stat] = s.value);
  return a.every(s => Math.abs((mapB[s.stat] != null ? mapB[s.stat] : 0) - s.value) <= eps);
}

/* Every substat the existing card has must still be present, at the same
   value or higher — upgrades only add roll value, never remove it. The
   incoming card may have additional substats the old one hadn't rolled yet. */
function subsMonotonic(oldSubs, newSubs) {
  const mapNew = {}; (newSubs || []).forEach(s => mapNew[s.stat] = s.value);
  return (oldSubs || []).every(s => mapNew[s.stat] != null && mapNew[s.stat] >= s.value - 0.05);
}

function cardDistance(a, b) {
  let d = Math.abs((a.level || 0) - (b.level || 0)) * 2;
  const mapA = {}; (a.subs || []).forEach(s => mapA[s.stat] = s.value);
  const mapB = {}; (b.subs || []).forEach(s => mapB[s.stat] = s.value);
  const keys = new Set([...Object.keys(mapA), ...Object.keys(mapB)]);
  keys.forEach(k => { d += Math.abs((mapA[k] || 0) - (mapB[k] || 0)); });
  return d;
}

function mergeImport(existingCards, incomingCards) {
  const pools = new Map();
  existingCards.forEach(c => {
    const fp = cardFingerprint(c);
    if (!pools.has(fp)) pools.set(fp, []);
    pools.get(fp).push(c);
  });
  const toAdd = [], toUpdate = [], duplicates = [], ambiguous = [];
  incomingCards.forEach(inc => {
    const pool = pools.get(cardFingerprint(inc));
    if (!pool || !pool.length) { toAdd.push(inc); return; }
    let bestIdx = 0, bestD = Infinity;
    pool.forEach((cand, i) => { const d = cardDistance(cand, inc); if (d < bestD) { bestD = d; bestIdx = i; } });
    const cand = pool[bestIdx];
    if ((cand.level || 0) === (inc.level || 0) && subsClose(cand.subs || [], inc.subs || [], 0.05)) {
      duplicates.push({ existing: cand, incoming: inc });
    } else if (subsMonotonic(cand.subs || [], inc.subs || []) && (inc.level || 0) >= (cand.level || 0)) {
      toUpdate.push({ existingId: cand.id, card: inc });
    } else {
      ambiguous.push({ existing: cand, incoming: inc });
    }
    pool.splice(bestIdx, 1);
  });
  return { toAdd, toUpdate, duplicates, ambiguous };
}

/* ======================== scoring engine ======================== */

/* Raw quality of one card for one character: weighted roll value of its substats,
   plus the main stat (weighted heavier, since a main stat is worth several rolls). */
function cardScore(card, t) {
  let s = 0;
  for (const sub of card.subs || []) {
    const w = t.w[sub.stat] || 0;
    if (!w) continue;
    s += (sub.value / maxRoll(sub.stat, card.slot)) * w;
  }
  // The main stat is roughly a third of a card's value, so it is weighted heavily
  // and gets an extra bump for exactly matching the character's target.
  let mainPart = 0;
  if (card.slot !== 'Sun' && card.slot !== 'Space') {
    const wanted = t.main[card.slot];
    const mw = t.w[card.main] || 0;
    mainPart = mw * 3.0 + (card.main === wanted ? 10 : 0);
  }
  const lvlPenalty = card.rarity === 5 ? 1 : card.rarity === 4 ? 0.82 : card.rarity === 3 ? 0.6 : 0.4;
  return (s + mainPart) * lvlPenalty;
}

/* Value of a 2-piece bonus, on the same scale as card scores: a flat "+12% ATK"
   is simply worth however many maximum ATK% rolls that is, times the stat's weight. */
function bonus2Value(setName, char, t) {
  const S = SETS[setName];
  if (!S || !S.bonus2) return 0;
  if (S.elem && S.elem !== char.e) return 0;
  const st = S.bonus2.stat;
  if (st === 'HP Recovery') return (t.w['HP%'] || 0) * 1.5;   // healing has no substat equivalent
  const w = t.w[st] || 0;
  if (!w) return 0;
  return w * (S.bonus2.amt / maxRoll(st, 'Sun'));
}

/* Value of a 4-piece bonus. These are typically worth 20-40% more damage or
   survivability, which lands around one whole card's worth of stats. Element sets
   are worthless to off-element characters. */
function bonus4Value(setName, char, t, base) {
  const S = SETS[setName];
  if (!S) return 0;
  if (S.elem && S.elem !== char.e) return 0;
  const B = base == null ? 55 : base;
  const i = (t.sets || []).indexOf(setName);
  if (i === 0) return B;
  if (i > 0) return B * 0.72;
  return B * 0.22;
}

function bestPlan(char, pool, opts) {
  const t = target(char);
  const heavens = ['Sun', 'Moon', 'Star', 'Sky'];

  // index: slot -> set -> cards sorted by score desc
  const idx = {}; const counts = {};
  heavens.forEach(sl => idx[sl] = {});
  const scored = pool
    .filter(c => c.slot !== 'Space')
    .map(c => ({ c, s: cardScore(c, t) }));
  scored.forEach(o => {
    const sl = o.c.slot, st = o.c.set;
    (idx[sl][st] = idx[sl][st] || []).push(o);
    counts[st] = (counts[st] || 0) + 1;
  });
  heavens.forEach(sl => Object.values(idx[sl]).forEach(a => a.sort((x, y) => y.s - x.s)));
  const bestAny = {};
  heavens.forEach(sl => {
    const all = scored.filter(o => o.c.slot === sl).sort((x, y) => y.s - x.s);
    bestAny[sl] = all[0] || null;
  });

  // candidate sets: the character's preferred sets, plus anything we hold >= 2 of
  const cand = new Set(t.sets.filter(s => SETS[s]));
  Object.keys(counts).forEach(s => { if (counts[s] >= 2 && SETS[s]) cand.add(s); });
  const candArr = Array.from(cand);

  const P4 = (opts && opts.p4value != null) ? +opts.p4value : 55;
  const plans = [];
  const pick = (sl, st) => (idx[sl][st] && idx[sl][st][0]) || null;

  // 4-piece plans
  for (const S of candArr) {
    const picks = {}; let ok = true, sum = 0;
    for (const sl of heavens) {
      const p = pick(sl, S);
      if (!p) { ok = false; picks[sl] = null; continue; }
      picks[sl] = p; sum += p.s;
    }
    const missing = heavens.filter(sl => !picks[sl]);
    const bon = bonus4Value(S, char, t, P4) + bonus2Value(S, char, t);
    plans.push({
      kind: '4pc', label: `4-piece ${S}`, sets: [S], picks,
      complete: ok, missing, bonus: ok ? bon : 0, total: ok ? sum + bon : -1
    });
  }

  const subsets = [['Sun','Moon'],['Sun','Star'],['Sun','Sky'],['Moon','Star'],['Moon','Sky'],['Star','Sky']];

  // 2+2 plans, and 2-piece + two free-choice cards
  for (let i = 0; i < candArr.length; i++) {
    const A = candArr[i], bA = bonus2Value(A, char, t);
    if (bA <= 0) continue;
    for (const slotsA of subsets) {
      const slotsB = heavens.filter(s => !slotsA.includes(s));
      const baseP = {}; let okA = true, sumA = 0;
      for (const sl of slotsA) { const p = pick(sl, A); if (!p) { okA = false; break; } baseP[sl] = p; sumA += p.s; }
      if (!okA) continue;

      // pair with a second 2-piece that actually does something
      for (let j = 0; j < candArr.length; j++) {
        if (i === j) continue;
        const B = candArr[j], bB = bonus2Value(B, char, t);
        if (bB <= 0) continue;
        const picks = Object.assign({}, baseP); let ok = true, sum = sumA;
        for (const sl of slotsB) { const p = pick(sl, B); if (!p) { ok = false; break; } picks[sl] = p; sum += p.s; }
        if (!ok) continue;
        plans.push({ kind: '2+2', label: `2-piece ${A} + 2-piece ${B}`, sets: [A, B], picks,
          complete: true, missing: [], bonus: bA + bB, total: sum + bA + bB });
      }

      // ...or leave the other two slots free for the strongest cards available
      const picks = Object.assign({}, baseP); let ok = true, sum = sumA;
      for (const sl of slotsB) { if (!bestAny[sl]) { ok = false; break; } picks[sl] = bestAny[sl]; sum += bestAny[sl].s; }
      if (ok) plans.push({ kind: '2+free', label: `2-piece ${A} + best available`, sets: [A], picks,
        complete: true, missing: [], bonus: bA, total: sum + bA });
    }
  }

  // no-set fallback: strongest four cards regardless of set
  {
    const picks = {}; let sum = 0, ok = true;
    for (const sl of heavens) { if (!bestAny[sl]) { ok = false; break; } picks[sl] = bestAny[sl]; sum += bestAny[sl].s; }
    if (ok) plans.push({ kind: 'raw', label: 'Best raw stats (no set bonus)', sets: [], picks,
      complete: true, missing: [], bonus: 0, total: sum });
  }

  // A 2+2 plan is generated once per set ordering, so collapse identical loadouts.
  const seen = new Set();
  const complete = plans.filter(p => p.complete).sort((a, b) => b.total - a.total).filter(p => {
    const key = heavens.map(sl => p.picks[sl].c.id).sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  /* Set policy. Left to pure stat maximisation the optimiser will nearly always
     drop set bonuses, because an unconstrained pick from the whole inventory beats
     one restricted to a single set. That is rarely how anyone actually plays, so by
     default we honour the character's preferred sets and show what it costs. */
  const policy = (opts && opts.policy) || 'pref';
  let allowed = complete;
  if (policy === 'force4') {
    const p0 = complete.filter(p => p.kind === '4pc' && t.sets.includes(p.sets[0]));
    allowed = p0.length ? p0 : complete.filter(p => p.kind === '4pc');
    if (!allowed.length) allowed = complete;
  } else if (policy === 'pref') {
    const p1 = complete.filter(p => p.sets.some(s => t.sets.includes(s)));
    const p2 = complete.filter(p => p.kind === '4pc');
    allowed = p1.length ? p1 : (p2.length ? p2 : complete);
  } else if (policy === 'any4') {
    const p2 = complete.filter(p => p.kind === '4pc');
    allowed = p2.length ? p2 : complete;
  }
  const best = allowed[0] || null;
  const statMax = complete[0] || null;

  // Space card: prefer one that pairs with the chosen 4-piece set
  const spacePool = pool.filter(c => c.slot === 'Space').map(c => ({ c, s: cardScore(c, t) }));
  const active4 = best && best.kind === '4pc' ? best.sets[0] : null;
  spacePool.forEach(o => {
    const sp = SPACE_SETS[o.c.set];
    const pairs = sp && active4 && sp.pairs.includes(active4);
    o.pairs = !!pairs;
    o.pref  = o.c.set === t.space;
    o.total = o.s + (pairs ? 9 : 0) + (o.pref && pairs ? 4 : 0);
  });
  spacePool.sort((a, b) => b.total - a.total);

  return {
    t, best, statMax,
    alternatives: complete.filter(p => p !== best).slice(0, 4),
    incomplete: plans.filter(p => !p.complete && t.sets.includes(p.sets[0])),
    space: spacePool[0] || null, spaceAlts: spacePool.slice(1, 3), idx, scored
  };
}

/* ============================ ui ============================ */
function ownedChars() { return CHARACTERS.filter(c => state.chars[c.n].owned); }
function poolFor(mode, rar, exclude) {
  return state.cards.filter(c =>
    c.rarity >= rar && (mode === 'all' || !c.equipped || c.equipped === exclude));
}

function renderOpt() {
  const sel = $('#optChar');
  const keep = sel.value;
  const owned = ownedChars();
  const list = owned.length ? owned : CHARACTERS;
  sel.innerHTML = (owned.length ? '' : '<option disabled>— you have not marked any characters as owned —</option>') +
    list.map(c => `<option value="${esc(c.n)}">${esc(c.n)}${c.a ? ' (' + esc(c.a) + ')' : ''}</option>`).join('');
  if (keep && list.some(c => c.n === keep)) sel.value = keep;
}

function planCardHtml(slot, o, t) {
  if (!o) return `<div class="lo empty"><h4><span class="slot ${slot}">${slot.slice(0,3)}</span> ${slot}</h4>
    <div class="tiny muted">Nothing in inventory for this slot.</div></div>`;
  const c = o.c;
  const wantMain = t.main[c.slot];
  const fixed = SLOT_INFO[c.slot].fixed;
  const mainOk = fixed || c.main === wantMain;
  const subs = (c.subs || []).map(s => {
    const w = t.w[s.stat] || 0;
    const rv = s.value / maxRoll(s.stat, c.slot);
    return `<div class="sub ${w >= 6 ? 'good' : w <= 1 ? 'bad' : ''}">
      <span>${esc(s.stat)}</span><b>${s.value}${SUBSTATS[s.stat].flat ? '' : '%'}
      <span class="muted tiny">(${rv.toFixed(1)}r)</span></b></div>`;
  }).join('');
  return `<div class="lo">
    <h4><span class="slot ${c.slot}">${c.slot.slice(0,3)}</span> ${esc(c.set)}
      <span class="tag r${c.rarity}">${c.rarity}★</span>
      <span class="score" style="margin-left:auto">${o.s.toFixed(1)}</span></h4>
    <div style="border-bottom:1px solid #33333d;padding-bottom:6px;margin-bottom:5px">
      <div class="sub" style="border:none;padding:0"><span class="muted">Main</span><b>${esc(c.main)}</b></div>
      ${fixed ? '' : `<div style="margin-top:3px">${mainOk ? '<span class="tag hit">on target</span>'
        : '<span class="tag miss">wants ' + esc(wantMain) + '</span>'}</div>`}
    </div>
    ${subs || '<div class="tiny muted">No substats recorded.</div>'}
    <div class="tiny muted" style="margin-top:6px">Lv ${c.level}${c.equipped ? ' · on ' + esc(c.equipped) : ''}</div>
  </div>`;
}

function runOpt() {
  const name = $('#optChar').value;
  const char = charDef(name);
  if (!char) return;
  const t = target(char);
  const pool = poolFor($('#optPool').value, +$('#optRarity').value, name);
  const r = bestPlan(char, pool, { policy: $('#optPolicy').value, p4value: +$('#optP4').value });
  const out = $('#optOut');

  const notes = [];
  if (char.conf === 'low') notes.push(`<div class="notice"><b>Unverified build.</b> No published guide exists for ${esc(char.n)}.
    These targets are ${esc(ARCHETYPES[char.arch].label)} defaults I generated — sanity-check them against her kit before committing resources.</div>`);
  if (t.bp) notes.push(`<div class="notice info"><b>Breakpoints.</b> ${esc(t.bp)}</div>`);
  if (t.note) notes.push(`<div class="notice info"><b>Note.</b> ${esc(t.note)}</div>`);
  const unver = (t.sets || []).filter(s => SETS[s] && SETS[s].unverified);
  if (unver.length) notes.push(`<div class="notice"><b>Unverified set data.</b>
    ${esc(unver.join(' and '))} appears in build guides but was not in any set list I could confirm,
    so its 2-piece effect is unknown and the optimiser scores that part as zero.
    Check it in game and correct it, or the recommendation will undervalue this set.</div>`);
  $('#optNotes').innerHTML = notes.join('');

  if (!r.best) {
    out.innerHTML = `<div class="panel"><p class="muted">Not enough cards in the pool to build a full loadout.
      You need at least one card in each of Sun, Moon, Star and Sky.</p></div>`;
    return;
  }

  const maxT = r.best.total;
  const planSlots = p => p.kind === '4pc' || p.kind === 'raw' ? '' :
    ' <span class="muted tiny">(' + ['Sun','Moon','Star','Sky']
      .filter(sl => p.picks[sl].c.set === p.sets[0]).join('+') + ' carry ' + esc(p.sets[0]) + ')</span>';
  const alt = r.alternatives.map(p =>
    `<tr><td>${esc(p.label)}${planSlots(p)}</td><td class="right score">${p.total.toFixed(1)}</td>
     <td class="right muted tiny">${(p.total - maxT).toFixed(1)}</td></tr>`).join('');
  const cost = (r.statMax && r.statMax !== r.best)
    ? `<p class="tiny muted" style="margin-top:8px">Ignoring set bonuses entirely would score
       <b>${r.statMax.total.toFixed(1)}</b> (${(r.statMax.total - maxT >= 0 ? '+' : '')}${(r.statMax.total - maxT).toFixed(1)})
       using ${esc(r.statMax.label.toLowerCase())}. Switch <b>Set policy</b> to compare.</p>` : '';
  const missing = r.incomplete.map(p =>
    `<tr><td>${esc(p.label)}</td><td colspan="2" class="tiny" style="color:#e87a5c">missing ${p.missing.join(', ')}</td></tr>`).join('');

  const sp = r.space;
  const spHtml = sp ? `<div class="lo">
      <h4><span class="slot Space">Spa</span> ${esc(sp.c.set)}
        <span class="tag r${sp.c.rarity}">${sp.c.rarity}★</span>
        <span class="score" style="margin-left:auto">${sp.s.toFixed(1)}</span></h4>
      <div class="tiny ${sp.pairs ? '' : 'muted'}" style="margin-bottom:5px">
        ${sp.pairs ? '<span class="tag hit">pairs with your 4-piece</span>' : '<span class="tag miss">no synergy with this 4-piece</span>'}
      </div>
      ${(sp.c.subs || []).map(s => `<div class="sub ${(t.w[s.stat] || 0) >= 6 ? 'good' : ''}">
        <span>${esc(s.stat)}</span><b>${s.value}${SUBSTATS[s.stat].flat ? '' : '%'}</b></div>`).join('')}
      <div class="tiny muted" style="margin-top:6px">${esc((SPACE_SETS[sp.c.set] || {}).note || '')}</div>
    </div>` : `<div class="lo empty"><h4><span class="slot Space">Spa</span> Space</h4>
      <div class="tiny muted">No Space cards in inventory. Preferred: <b>${esc(t.space || '—')}</b>.</div></div>`;

  out.innerHTML = `
  <div class="panel">
    <h2>Recommended loadout — ${esc(r.best.label)}</h2>
    <div class="loadout">
      ${['Sun','Moon','Star','Sky'].map(sl => planCardHtml(sl, r.best.picks[sl], t)).join('')}
      ${spHtml}
    </div>
    <div class="row" style="margin-top:14px">
      <div class="stat-tile"><span class="muted tiny">Total score</span><br><span class="score" style="font-size:22px">${r.best.total.toFixed(1)}</span></div>
      <div class="stat-tile"><span class="muted tiny">From set bonuses</span><br><span class="score" style="font-size:22px">${r.best.bonus.toFixed(1)}</span></div>
      <div style="flex:1"></div>
      <button id="equipBtn" class="primary">Mark these as equipped on ${esc(char.n)}</button>
    </div>
    <p class="tiny muted" style="margin-top:10px">
      Scores are relative, not absolute — they only mean anything when comparing options for the same character.
      <b>(n r)</b> next to a substat is its roll value: how many maximum rolls that number is worth.
    </p>
    ${cost}
  </div>
  ${(alt || missing) ? `<div class="panel"><h2>Other set plans considered</h2>
    <table><thead><tr><th>Plan</th><th class="right">Score</th><th class="right">vs best</th></tr></thead>
    <tbody>${alt}${missing}</tbody></table></div>` : ''}
  <div class="panel"><h2>Best alternatives per slot</h2>
    <table><thead><tr><th>Slot</th><th>Set</th><th>Main</th><th>Substats</th><th class="right">Score</th></tr></thead>
    <tbody>${['Sun','Moon','Star','Sky','Space'].flatMap(sl => {
      const rows = (sl === 'Space' ? [r.space, ...r.spaceAlts].filter(Boolean)
        : r.scored.filter(o => o.c.slot === sl).sort((a, b) => b.s - a.s).slice(0, 3));
      return rows.map((o, i) => `<tr><td>${i === 0 ? `<span class="slot ${sl}">${sl.slice(0,3)}</span>` : ''}</td>
        <td>${esc(o.c.set)} <span class="tag r${o.c.rarity}">${o.c.rarity}★</span></td>
        <td class="tiny">${esc(o.c.main)}</td>
        <td class="tiny muted">${(o.c.subs || []).map(s => esc(s.stat) + ' ' + s.value).join(' · ')}</td>
        <td class="right score">${o.s.toFixed(1)}</td></tr>`);
    }).join('')}</tbody></table></div>`;

  const eq = $('#equipBtn');
  if (eq) eq.onclick = () => {
    state.cards.forEach(c => { if (c.equipped === name) c.equipped = null; });
    ['Sun','Moon','Star','Sky'].forEach(sl => { const p = r.best.picks[sl]; if (p) p.c.equipped = name; });
    if (r.space) r.space.c.equipped = name;
    renderInv(); runOpt();
  };
}

/* ---------------------------- inventory ---------------------------- */
function fillSelects() {
  $('#fSlot').innerHTML = SLOTS.map(s => `<option>${s}</option>`).join('');
  $('#flSlot').innerHTML = '<option value="">Any</option>' + SLOTS.map(s => `<option>${s}</option>`).join('');
  const setOpts = Object.keys(SETS).sort().map(s => `<option>${s}</option>`).join('');
  const spOpts  = Object.keys(SPACE_SETS).sort().map(s => `<option>${s}</option>`).join('');
  $('#flSet').innerHTML = '<option value="">Any</option>' + setOpts + spOpts;
  syncSetOptions(); syncMainOptions(); renderSubInputs();
}
function syncSetOptions() {
  const slot = $('#fSlot').value;
  const src = slot === 'Space' ? SPACE_SETS : SETS;
  $('#fSet').innerHTML = Object.keys(src).sort().map(s => `<option>${s}</option>`).join('');
}
function syncMainOptions() {
  const slot = $('#fSlot').value;
  const info = SLOT_INFO[slot];
  $('#fMain').innerHTML = info.mains.map(s => `<option>${s}</option>`).join('');
  $('#fMain').disabled = info.fixed;
}
function renderSubInputs() {
  const opts = '<option value="">—</option>' + Object.keys(SUBSTATS).map(s => `<option>${s}</option>`).join('');
  $('#fSubs').innerHTML = [1,2,3,4].map(i => `
    <div class="field"><label>Substat ${i}</label>
      <div style="display:flex;gap:5px">
        <select class="subStat" data-i="${i}">${opts}</select>
        <input class="subVal" data-i="${i}" type="number" step="0.1" style="width:78px" placeholder="0">
      </div></div>`).join('');
  $$('.subVal').forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') addCard(); }));
}
function addCard() {
  const slot = $('#fSlot').value;
  const subs = [];
  $$('.subStat').forEach(sel => {
    const i = sel.dataset.i;
    const v = parseFloat($(`.subVal[data-i="${i}"]`).value);
    if (sel.value && !isNaN(v)) subs.push({ stat: sel.value, value: v });
  });
  const candidate = { slot, set: $('#fSet').value, rarity: +$('#fRar').value,
    level: +$('#fLvl').value || 0, main: $('#fMain').value, subs };
  const errs = validateCard(candidate);
  if (errs.length) { $('#fMsg').innerHTML = `<span style="color:#e87a5c">${esc(errs[0])}</span>`; return; }
  $('#fMsg').textContent = '';
  candidate.id = 'c' + (state.nextId++);
  candidate.equipped = null;
  state.cards.push(candidate);
  $$('.subVal').forEach(el => el.value = '');
  $('.subVal').focus();
  renderInv();
}
function parseLine(line) {
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 5) return { err: 'needs at least 5 fields separated by |' };
  const slot = SLOTS.find(s => s.toLowerCase() === parts[0].toLowerCase()
    || (s === 'Sky' && /^planet$/i.test(parts[0])) || (s === 'Space' && /^universe$/i.test(parts[0])));
  if (!slot) return { err: `unknown slot "${parts[0]}"` };
  const set = normSet(parts[1]);
  if (!set) return { err: `unknown set "${parts[1]}"` };
  const rarity = parseInt(parts[2], 10);
  if (!RARITY[rarity]) return { err: `bad rarity "${parts[2]}"` };
  const level = parseInt(parts[3], 10) || 0;
  const main = SLOT_INFO[slot].fixed ? SLOT_INFO[slot].mains[0] : normStat(parts[4]);
  if (!main) return { err: `unknown main stat "${parts[4]}"` };
  const subs = [];
  if (parts[5]) {
    for (const chunk of parts[5].split(',')) {
      const m = chunk.trim().match(/^(.*?)\s*([\d.]+)\s*%?$/);
      if (!m) continue;
      const st = normStat(m[1]);
      if (!st) return { err: `unknown substat "${m[1].trim()}"` };
      subs.push({ stat: st, value: parseFloat(m[2]) });
    }
  }
  const candidate = { slot, set, rarity, level, main, subs, equipped: null };
  const errs = validateCard(candidate);
  if (errs.length) return { err: errs[0] };
  candidate.id = 'c' + (state.nextId++);
  return { card: candidate };
}
function bulkImport() {
  const lines = $('#bulk').value.split('\n').map(s => s.trim()).filter(Boolean);
  let ok = 0; const errs = [];
  lines.forEach((l, i) => {
    const r = parseLine(l);
    if (r.err) errs.push(`line ${i + 1}: ${r.err}`); else { state.cards.push(r.card); ok++; }
  });
  $('#bulkMsg').innerHTML = `Imported <b>${ok}</b> card${ok === 1 ? '' : 's'}.` +
    (errs.length ? ` <span style="color:#e87a5c">${errs.length} skipped</span> — ${esc(errs.slice(0, 3).join('; '))}${errs.length > 3 ? ' …' : ''}` : '');
  if (ok) $('#bulk').value = '';
  renderInv();
}
function filteredCards() {
  const sl = $('#flSlot').value, st = $('#flSet').value, r = $('#flRar').value;
  const q = $('#flQ').value.trim().toLowerCase();
  return state.cards.filter(c => {
    if (sl && c.slot !== sl) return false;
    if (st && c.set !== st) return false;
    if (r && c.rarity !== +r) return false;
    if (q) {
      const hay = [c.set, c.main, c.equipped || '', ...(c.subs || []).map(s => s.stat)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
function renderInv() {
  const rows = filteredCards();
  $('#invCount').textContent = `— ${rows.length} shown of ${state.cards.length}`;
  $('#nodata').classList.toggle('hide', state.cards.length > 0);
  $('#invTable').innerHTML = `<thead><tr>
      <th>Slot</th><th>Set</th><th>★</th><th>Lv</th><th>Main</th><th>Substats</th><th>Equipped</th><th></th>
    </tr></thead><tbody>` +
    rows.slice(0, 600).map(c => `<tr>
      <td><span class="slot ${c.slot}">${c.slot.slice(0,3)}</span></td>
      <td>${esc(c.set)}</td>
      <td><span class="tag r${c.rarity}">${c.rarity}★</span></td>
      <td class="muted">${c.level}</td>
      <td class="tiny">${esc(c.main)}</td>
      <td class="tiny muted">${(c.subs || []).map(s => esc(s.stat) + ' ' + s.value).join(' · ')}</td>
      <td class="tiny">${c.equipped ? esc(c.equipped) : '<span class="muted">—</span>'}</td>
      <td class="right nowrap"><button class="sm ghost" data-edit="${c.id}">Edit</button>
        <button class="sm ghost" data-del="${c.id}">✕</button></td>
    </tr>`).join('') + '</tbody>';
  if (rows.length > 600) $('#invTable').insertAdjacentHTML('beforeend',
    `<tfoot><tr><td colspan="8" class="tiny muted">Showing the first 600 rows — narrow the filters to see more.</td></tr></tfoot>`);
  $$('[data-edit]').forEach(b => b.onclick = () => editCard(b.dataset.edit));
  $$('[data-del]').forEach(b => b.onclick = () => {
    state.cards = state.cards.filter(c => c.id !== b.dataset.del); renderInv();
  });
}

/* Reuses the shared dialog (see editTargets) to edit slot/set/rarity/level/
   main/substats of an existing card in place, running it through the same
   validateCard() the importers use so a hand-edit can't introduce a card
   the rest of the app doesn't recognise as legal. */
function editCard(id) {
  const c = state.cards.find(x => x.id === id);
  if (!c) return;
  const subOpts = '<option value="">—</option>' + Object.keys(SUBSTATS).map(s => `<option>${s}</option>`).join('');
  $('#dlgBody').innerHTML = `
    <h2>Edit card</h2>
    <div class="row">
      <div class="field"><label>Slot</label><select id="eSlot">${SLOTS.map(s => `<option ${s === c.slot ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div class="field"><label>Set</label><select id="eSet"></select></div>
      <div class="field"><label>Rarity</label><select id="eRar">
        <option value="5">5★</option><option value="4">4★</option>
        <option value="3">3★</option><option value="2">2★</option></select></div>
      <div class="field"><label>Level</label><input id="eLvl" type="number" min="0" max="25" style="width:70px"></div>
      <div class="field"><label>Main stat</label><select id="eMain"></select></div>
    </div>
    <div class="row" style="margin-top:10px" id="eSubs">${[0,1,2,3].map(i => `
      <div class="field"><label>Substat ${i + 1}</label>
        <div style="display:flex;gap:5px">
          <select class="eSubStat" data-i="${i}">${subOpts}</select>
          <input class="eSubVal" data-i="${i}" type="number" step="0.1" style="width:78px" value="${(c.subs[i] || {}).value != null ? c.subs[i].value : ''}">
        </div></div>`).join('')}</div>
    <div id="eErr" class="tiny" style="color:#e87a5c;margin-top:10px"></div>
    <div class="row" style="margin-top:12px">
      <button class="primary" id="eSave">Save changes</button>
      <button class="ghost" id="eDelete">Delete card</button>
    </div>`;
  const syncE = () => {
    const slot = $('#eSlot').value;
    const src = slot === 'Space' ? SPACE_SETS : SETS;
    $('#eSet').innerHTML = Object.keys(src).sort().map(s => `<option ${s === c.set ? 'selected' : ''}>${s}</option>`).join('');
    const info = SLOT_INFO[slot];
    $('#eMain').innerHTML = info.mains.map(m => `<option ${m === c.main ? 'selected' : ''}>${m}</option>`).join('');
    $('#eMain').disabled = info.fixed;
  };
  $('#eSlot').onchange = syncE; syncE();
  $('#eRar').value = c.rarity; $('#eLvl').value = c.level;
  $$('.eSubStat').forEach(sel => { const s = c.subs[+sel.dataset.i]; if (s) sel.value = s.stat; });
  $('#dlg').showModal();
  $('#eSave').onclick = () => {
    const subs = [];
    $$('.eSubStat').forEach(sel => {
      const i = sel.dataset.i;
      const v = parseFloat($(`.eSubVal[data-i="${i}"]`).value);
      if (sel.value && !isNaN(v)) subs.push({ stat: sel.value, value: v });
    });
    const candidate = { slot: $('#eSlot').value, set: $('#eSet').value, rarity: +$('#eRar').value,
      level: +$('#eLvl').value || 0, main: $('#eMain').value, subs };
    const errs = validateCard(candidate);
    if (errs.length) { $('#eErr').textContent = errs[0]; return; }
    Object.assign(c, candidate);
    $('#dlg').close(); renderInv(); renderOpt();
  };
  $('#eDelete').onclick = () => {
    state.cards = state.cards.filter(x => x.id !== id);
    $('#dlg').close(); renderInv(); renderOpt();
  };
}

/* ------------------------------ triage ------------------------------ */
function runTriage() {
  const scope = $('#trScope').value;
  const minR = +$('#trRar').value;
  const chars = scope === 'owned' ? ownedChars() : CHARACTERS;
  if (!chars.length) { $('#trSummary').innerHTML = '<p class="muted">Mark some characters as owned on the Roster tab first.</p>'; return; }
  const targets = chars.map(c => ({ c, t: target(c) }));
  const cards = state.cards.filter(c => c.rarity >= minR);
  const rated = cards.map(card => {
    let best = -1, who = '';
    for (const { c, t } of targets) {
      const s = cardScore(card, t);
      if (s > best) { best = s; who = c.n; }
    }
    return { card, best, who };
  });
  const sorted = rated.slice().sort((a, b) => b.best - a.best);
  const top = sorted.length ? sorted[0].best : 1;
  rated.forEach(r => r.pct = top > 0 ? r.best / top : 0);
  const order = $('#trShow').value === 'worst' ? rated.slice().sort((a, b) => a.best - b.best) : sorted;

  const junk = rated.filter(r => r.pct < 0.35 && !r.card.equipped).length;
  $('#trSummary').innerHTML = `<div class="notice info">
    Rated <b>${rated.length}</b> cards against <b>${chars.length}</b> characters.
    <b>${junk}</b> score below 35% of your best card and are not currently equipped — those are your safest feed candidates.
    Always double-check before feeding: this only knows the characters you have marked as owned.</div>`;
  $('#trPanel').classList.remove('hide');
  $('#trTable').innerHTML = `<thead><tr>
      <th>Slot</th><th>Set</th><th>★</th><th>Main</th><th>Substats</th>
      <th>Best fit</th><th class="right">Score</th><th style="width:110px">Quality</th><th>Verdict</th>
    </tr></thead><tbody>` +
    order.slice(0, 800).map(r => {
      const p = Math.round(r.pct * 100);
      const verdict = r.card.equipped ? '<span class="tag hit">equipped</span>'
        : r.pct >= 0.7 ? '<span class="tag hit">keep</span>'
        : r.pct >= 0.35 ? '<span class="tag">hold</span>'
        : '<span class="tag miss">feed</span>';
      return `<tr>
        <td><span class="slot ${r.card.slot}">${r.card.slot.slice(0,3)}</span></td>
        <td>${esc(r.card.set)}</td>
        <td><span class="tag r${r.card.rarity}">${r.card.rarity}★</span></td>
        <td class="tiny">${esc(r.card.main)}</td>
        <td class="tiny muted">${(r.card.subs || []).map(s => esc(s.stat) + ' ' + s.value).join(' · ')}</td>
        <td class="tiny">${esc(r.who)}</td>
        <td class="right score">${r.best.toFixed(1)}</td>
        <td><div class="bar"><i style="width:${p}%"></i></div></td>
        <td>${verdict}</td></tr>`;
    }).join('') + '</tbody>';
}

/* ------------------------------ roster ------------------------------ */
function renderRoster() {
  const f = $('#rsFilter').value, q = $('#rsQ').value.trim().toLowerCase();
  const list = CHARACTERS.filter(c => {
    if (f === 'owned' && !state.chars[c.n].owned) return false;
    if (f === 'low' && c.conf !== 'low') return false;
    if (q && !(c.n + ' ' + (c.a || '') + ' ' + c.e + ' ' + c.arch).toLowerCase().includes(q)) return false;
    return true;
  });
  $('#rsCount').textContent = `${list.length} shown · ${ownedChars().length} owned`;
  $('#rsGrid').innerHTML = list.map(c => {
    const t = target(c);
    const o = state.chars[c.n].owned;
    return `<div class="cc ${o ? 'owned' : ''}" data-ch="${esc(c.n)}">
      <div class="nm">${esc(c.n)}</div>
      ${c.a ? `<div class="al">${esc(c.a)}</div>` : '<div class="al">&nbsp;</div>'}
      <div class="mt">
        <span class="tag r${c.r}">${c.r}★</span>
        <span class="tag">${esc(c.e)}</span>
        <span class="tag">${esc(c.arch)}</span>
        <span class="tag conf-${c.conf}">${c.conf}</span>
      </div>
      <div class="tiny muted" style="margin-top:7px">${esc((t.sets[0] || '—'))} 4pc · ${esc(t.space || '—')}</div>
      <div class="row" style="margin-top:9px;gap:6px">
        <button class="sm ${o ? 'primary' : ''}" data-own="${esc(c.n)}">${o ? 'Owned' : 'Mark owned'}</button>
        <button class="sm ghost" data-edit="${esc(c.n)}">Targets</button>
      </div></div>`;
  }).join('');
  $$('[data-own]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const n = b.dataset.own;
    state.chars[n].owned = !state.chars[n].owned;
    renderRoster(); renderOpt();
  });
  $$('[data-edit]').forEach(b => b.onclick = e => { e.stopPropagation(); editTargets(b.dataset.edit); });
}

function editTargets(name) {
  const c = charDef(name), t = JSON.parse(JSON.stringify(target(c)));
  const setOpts = sel => Object.keys(SETS).sort()
    .map(s => `<option ${s === sel ? 'selected' : ''}>${s}</option>`).join('');
  const body = `
    <h2 style="margin-bottom:4px">${esc(c.n)}${c.a ? ' · ' + esc(c.a) : ''}</h2>
    <p class="tiny muted" style="margin:0 0 14px">${esc(c.e)} · ${esc(ARCHETYPES[c.arch].label)} ·
      confidence <span class="tag conf-${c.conf}">${c.conf}</span></p>
    ${t.note ? `<div class="notice info tiny">${esc(t.note)}</div>` : ''}
    ${t.bp ? `<div class="notice tiny"><b>Breakpoints.</b> ${esc(t.bp)}</div>` : ''}
    <div class="row">
      <div class="field"><label>Preferred 4-piece</label><select id="tSet0"><option value="">—</option>${setOpts(t.sets[0])}</select></div>
      <div class="field"><label>Alternative 4-piece</label><select id="tSet1"><option value="">—</option>${setOpts(t.sets[1])}</select></div>
      <div class="field"><label>Space card</label><select id="tSpace"><option value="">—</option>
        ${Object.keys(SPACE_SETS).sort().map(s => `<option ${s === t.space ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    </div>
    <h3 style="margin:16px 0 8px;font-size:13px">Main stats</h3>
    <div class="row">
      ${['Moon','Star','Sky'].map(sl => `<div class="field"><label>${sl}</label>
        <select id="tM${sl}">${SLOT_INFO[sl].mains.map(m =>
          `<option ${m === t.main[sl] ? 'selected' : ''}>${m}</option>`).join('')}</select></div>`).join('')}
      <span class="tiny muted" style="padding-bottom:8px">Sun and Space have fixed main stats.</span>
    </div>
    <h3 style="margin:16px 0 8px;font-size:13px">Substat weights <span class="muted tiny">0 = ignore, 10 = top priority</span></h3>
    <div class="wgrid">${Object.keys(SUBSTATS).map(s =>
      `<div class="wrow"><span>${s}</span><input type="number" min="0" max="10" step="1"
        data-w="${s}" value="${t.w[s] != null ? t.w[s] : 0}"></div>`).join('')}</div>
    <div class="row" style="margin-top:16px">
      <button class="primary" id="tSave">Save targets</button>
      <button id="tReset">Reset to default</button>
    </div>`;
  $('#dlgBody').innerHTML = body;
  $('#dlg').showModal();
  $('#tSave').onclick = () => {
    const w = {}; $$('[data-w]').forEach(i => w[i.dataset.w] = +i.value || 0);
    state.chars[name].targets = {
      sets: [$('#tSet0').value, $('#tSet1').value].filter(Boolean),
      space: $('#tSpace').value,
      main: { Moon: $('#tMMoon').value, Star: $('#tMStar').value, Sky: $('#tMSky').value },
      w, bp: t.bp, note: t.note
    };
    $('#dlg').close(); renderRoster(); runOpt();
  };
  $('#tReset').onclick = () => { state.chars[name].targets = null; $('#dlg').close(); renderRoster(); };
}

/* ------------------------------ data io ------------------------------ */
function save() {
  const payload = { version: 1, savedAt: new Date().toISOString(), nextId: state.nextId,
    cards: state.cards, characters: state.chars };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'p5x-planner-save.json';
  a.click(); URL.revokeObjectURL(a.href);
  $('#dataMsg').textContent = 'Saved.';
}
function load(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const d = JSON.parse(fr.result);
      const good = [], bad = [];
      (d.cards || []).forEach((rc, i) => {
        const c = normalizeCard(rc);
        const errs = validateCard(c);
        if (errs.length) bad.push(`card ${i + 1}: ${errs[0]}`); else good.push(c);
      });
      state.cards = good.map((c, i) => Object.assign({ id: 'c' + i }, c));
      state.nextId = d.nextId || state.cards.length + 1;
      CHARACTERS.forEach(c => { state.chars[c.n] = (d.characters && d.characters[c.n]) || { owned: false, targets: null }; });
      renderInv(); renderRoster(); renderOpt();
      $('#dataMsg').innerHTML = `Loaded <b>${state.cards.length}</b> cards.` +
        (bad.length ? ` <span style="color:#e87a5c">${bad.length} skipped</span> — ${esc(bad.slice(0, 3).join('; '))}${bad.length > 3 ? ' …' : ''}` : '');
    } catch (e) { $('#dataMsg').innerHTML = `<span style="color:#e87a5c">Could not read that file: ${esc(e.message)}</span>`; }
  };
  fr.readAsText(file);
}

/* ------------------------------ import merge (rescans) ------------------------------
   Unlike load(), which replaces the whole save file, this merges an incremental scan
   into the current inventory: new cards are added, cards that leveled up since the
   last scan are updated in place, exact resubmissions are skipped, and anything
   ambiguous is left for the review dialog rather than silently applied. */
function importScan(file) {
  const fr = new FileReader();
  fr.onload = () => {
    let raw;
    try { raw = JSON.parse(fr.result); }
    catch (e) { $('#dataMsg').innerHTML = `<span style="color:#e87a5c">Could not read that file: ${esc(e.message)}</span>`; return; }
    const list = Array.isArray(raw) ? raw : (raw.cards || []);
    const valid = [], invalid = [];
    list.forEach((rc, i) => {
      const c = normalizeCard(rc);
      const errs = validateCard(c);
      if (errs.length) invalid.push(`card ${i + 1}: ${errs[0]}`); else valid.push(c);
    });
    renderImportReview(mergeImport(state.cards, valid), invalid);
  };
  fr.readAsText(file);
}

function renderImportReview(result, invalid) {
  const cardLine = c => `${esc(c.slot)}/${esc(c.set)} ${c.rarity}★ Lv${c.level} ${esc(c.main)} — ` +
    (c.subs || []).map(s => esc(s.stat) + ' ' + s.value).join(', ');
  $('#dlgBody').innerHTML = `
    <h2>Import review</h2>
    <p class="tiny muted">
      <b>${result.toAdd.length}</b> new · <b>${result.toUpdate.length}</b> leveled up ·
      <b>${result.duplicates.length}</b> already in inventory (skipped) ·
      <b>${result.ambiguous.length}</b> need a decision · <b>${invalid.length}</b> invalid (skipped)
    </p>
    ${invalid.length ? `<div class="notice tiny"><b>Skipped as invalid:</b><br>${invalid.slice(0, 8).map(esc).join('<br>')}${invalid.length > 8 ? ' …' : ''}</div>` : ''}
    ${result.ambiguous.length ? `
      <h3 style="margin:14px 0 8px;font-size:13px">Needs a decision</h3>
      <p class="tiny muted" style="margin:0 0 8px">Same slot/set/rarity/main as a card you already have, but the
        numbers do not line up as a clean level-up — could be OCR noise on either scan, or a second copy of the
        same roll. Defaults to skipping the incoming card.</p>
      <table><thead><tr><th>Existing</th><th>Incoming</th><th>Decision</th></tr></thead><tbody>
        ${result.ambiguous.map((a, i) => `<tr>
          <td class="tiny">${cardLine(a.existing)}</td>
          <td class="tiny">${cardLine(a.incoming)}</td>
          <td><select class="tiny" data-amb="${i}">
            <option value="skip">Skip incoming</option>
            <option value="add">Add as new card</option>
            <option value="replace">Replace existing</option>
          </select></td>
        </tr>`).join('')}
      </tbody></table>` : ''}
    <div class="row" style="margin-top:16px">
      <button class="primary" id="applyImport">Apply</button>
    </div>`;
  $('#dlg').showModal();
  $('#applyImport').onclick = () => {
    result.toAdd.forEach(c => { c.id = 'c' + (state.nextId++); if (c.equipped === undefined) c.equipped = null; state.cards.push(c); });
    result.toUpdate.forEach(({ existingId, card }) => {
      const idx = state.cards.findIndex(x => x.id === existingId);
      if (idx >= 0) state.cards[idx] = Object.assign({}, state.cards[idx], card, { id: existingId, equipped: state.cards[idx].equipped });
    });
    $$('[data-amb]').forEach(sel => {
      const a = result.ambiguous[+sel.dataset.amb];
      if (sel.value === 'add') { a.incoming.id = 'c' + (state.nextId++); a.incoming.equipped = null; state.cards.push(a.incoming); }
      else if (sel.value === 'replace') {
        const idx = state.cards.findIndex(x => x.id === a.existing.id);
        if (idx >= 0) state.cards[idx] = Object.assign({}, state.cards[idx], a.incoming, { id: a.existing.id, equipped: state.cards[idx].equipped });
      }
    });
    $('#dlg').close(); renderInv(); renderOpt();
    $('#dataMsg').textContent = 'Import applied.';
  };
}
function csv() {
  const head = 'slot,set,rarity,level,main,sub1,val1,sub2,val2,sub3,val3,sub4,val4,equipped';
  const rows = state.cards.map(c => {
    const s = [0,1,2,3].flatMap(i => [(c.subs[i] || {}).stat || '', (c.subs[i] || {}).value != null ? c.subs[i].value : '']);
    return [c.slot, c.set, c.rarity, c.level, c.main, ...s, c.equipped || ''].map(v => `"${String(v).replace(/"/g,'""')}"`).join(',');
  });
  const blob = new Blob([head + '\n' + rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'p5x-cards.csv'; a.click(); URL.revokeObjectURL(a.href);
}

/* ------------------------------ wiring ------------------------------ */
$$('nav button').forEach(b => b.onclick = () => {
  $$('nav button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  ['opt','inv','triage','roster','data'].forEach(t =>
    $('#tab-' + t).classList.toggle('hide', t !== b.dataset.tab));
});
$('#fSlot').onchange = () => { syncSetOptions(); syncMainOptions(); };
$('#fAdd').onclick = addCard;
$('#bulkAdd').onclick = bulkImport;
['#flSlot','#flSet','#flRar'].forEach(s => $(s).onchange = renderInv);
$('#flQ').oninput = renderInv;
$('#flClear').onclick = () => { $('#flSlot').value = ''; $('#flSet').value = ''; $('#flRar').value = ''; $('#flQ').value = ''; renderInv(); };
$('#optRun').onclick = runOpt;
$('#optChar').onchange = runOpt;
$('#trRun').onclick = runTriage;
$('#rsFilter').onchange = renderRoster;
$('#rsQ').oninput = renderRoster;
$('#dlSave').onclick = save;
$('#dlCsv').onclick = csv;
$('#upSave').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = e => { if (e.target.files[0]) load(e.target.files[0]); e.target.value = ''; };
$('#upImport').onclick = () => $('#fileImport').click();
$('#fileImport').onchange = e => { if (e.target.files[0]) importScan(e.target.files[0]); e.target.value = ''; };
$('#wipe').onclick = () => {
  if (!confirm('Clear all cards and character settings? Download a save file first if you want to keep them.')) return;
  state.cards = []; state.nextId = 1;
  CHARACTERS.forEach(c => state.chars[c.n] = { owned: false, targets: null });
  renderInv(); renderRoster(); renderOpt();
};

$('#stamp').textContent = `${CHARACTERS.length} characters · ${Object.keys(SETS).length} sets · ${Object.keys(SPACE_SETS).length} space cards`;
fillSelects(); renderInv(); renderRoster(); renderOpt();
