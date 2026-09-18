const { chromium } = require('playwright');
const path = require('path');
const PAGE = 'file://' + path.join(__dirname, '..', 'dist', 'p5x-planner.html');

(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(PAGE); await p.waitForTimeout(300);
  const r = await p.evaluate(() => {
    let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pk = a => a[Math.floor(rnd() * a.length)];
    const H = ['Sun', 'Moon', 'Star', 'Sky'], S = Object.keys(SETS), SP = Object.keys(SPACE_SETS), SU = Object.keys(SUBSTATS);
    state.cards = [];
    for (let i = 0; i < 4000; i++) {
      const slot = rnd() < 0.12 ? 'Space' : pk(H), set = slot === 'Space' ? pk(SP) : pk(S), rarity = pk([5, 5, 4, 4, 4, 3, 3, 2, 2, 2]);
      const info = SLOT_INFO[slot], main = info.fixed ? info.mains[0] : pk(info.mains);
      const s = [], u = new Set([main]), n = rarity >= 4 ? 4 : rarity === 3 ? 3 : 2;
      while (s.length < n) { const st = pk(SU); if (u.has(st)) continue; u.add(st);
        const mx = slot === 'Space' ? (SUBSTATS[st].maxRollSpace || SUBSTATS[st].maxRoll) : SUBSTATS[st].maxRoll;
        s.push({ stat: st, value: +(mx * (0.5 + rnd() * 2.5)).toFixed(1) }); }
      state.cards.push({ id: 'c' + i, slot, set, rarity, level: rarity * 5, main, subs: s, equipped: null });
    }
    // equip a plausible loadout on every character so baseScore/others reflect a real,
    // non-empty build for most of the roster — the worst case for the marginal computation
    // is characters with SOMETHING equipped, since an empty build short-circuits to null.
    CHARACTERS.forEach(ch => { state.chars[ch.n].owned = true; });
    const bySlot = { Sun: [], Moon: [], Star: [], Sky: [], Space: [] };
    state.cards.forEach(c => bySlot[c.slot].push(c));
    CHARACTERS.forEach(ch => {
      ['Sun', 'Moon', 'Star', 'Sky', 'Space'].forEach(sl => {
        const c = bySlot[sl].pop();
        if (c) c.equipped = ch.n;
      });
    });

    $('#trScope').value = 'all';
    $('#trRar').value = '2';
    $('#trShow').value = 'best';

    const t0 = performance.now();
    runTriage();
    const ms = Math.round(performance.now() - t0);
    return { ms, trRows: document.querySelectorAll('#trTable tbody tr').length, cards: state.cards.length };
  });
  console.log(JSON.stringify({ ...r, errs }, null, 1));
  await b.close();
})();
