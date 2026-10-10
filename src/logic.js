/* ============================ state ============================ */
const state = { cards: [], chars: {}, nextId: 1, teamCrit: 0, den: {} };
const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

CHARACTERS.forEach(c => { state.chars[c.n] = { owned: false, benched: false, targets: null, loadout: null }; });

/* What the data says a character wants: archetype defaults under lufel's per-character
   overrides. A fresh object every call. `n` is who it belongs to — couplingFactors reads
   the character's own base stats (weapon, Awakening) through it. */
function defaultTarget(charDef) {
  const A = ARCHETYPES[charDef.arch];
  const ov = charDef.ov || {};
  return {
    n:     charDef.n,
    sets:  (charDef.sets || []).slice(),
    space: charDef.space || '',
    main:  Object.assign({}, A.main, ov.main || {}),
    w:     Object.assign({}, A.w, ov.w || {}),
    targets: (ov.targets || []).slice(),
    bp:    ov.bp || '',
    note:  ov.note || ''
  };
}

/* The data, with the user's own edits from the Targets dialog on top.

   Those edits are a DIFF — `{ v: 2, sets?, space?, main?: {slot: list}, w?: {stat: n} }`,
   holding only what the user changed — and never a copy of the whole target. A copy froze
   everything it held: until Sep 2026 saving the dialog stored the entire weight grid, the
   main lists and even the stat targets, so every later fix to the data stopped at that
   character — Kiyoshi Kurotani and Yusuke Kitagawa kept an ATK% weight of 4 the DEF/HP-kit
   override had set to 0, because a set or Space change (or only the Setup fields, which
   live in the same dialog) had once been saved there. Stat targets, `bp` and `note` are not
   editable and always come from the data.

   A saved object without `v` is a pre-diff snapshot; migrateSavedTargets() converts those
   on load, and until then this applies whatever fields it carries, which is the old
   behaviour. Memoised per saved object, so an edited character's target is one stable
   object the coupling caches can key on, and a fresh save (a new object) starts afresh. */
const editedTargetCache = new WeakMap();
function target(charDef) {
  const saved = state.chars[charDef.n] && state.chars[charDef.n].targets;
  if (!saved) return defaultTarget(charDef);
  let t = editedTargetCache.get(saved);
  if (!t || t.n !== charDef.n) editedTargetCache.set(saved, t = applyTargetEdits(defaultTarget(charDef), saved));
  return t;
}
function applyTargetEdits(t, e) {
  if (Array.isArray(e.sets)) t.sets = e.sets.slice();
  if (typeof e.space === 'string') t.space = e.space;
  if (e.main) ['Moon', 'Star', 'Sky'].forEach(sl => { if (e.main[sl] != null) t.main[sl] = mainList(e, sl); });
  if (e.w) Object.keys(e.w).forEach(s => { if (typeof e.w[s] === 'number') t.w[s] = e.w[s]; });
  return t;
}

/* The edits that turn `base` into `mine`, in the saved diff's shape — null when there are
   none, so saving the dialog unchanged (or with only its Setup fields touched) stores no
   target at all and the character keeps following the data. */
function targetEdits(base, mine) {
  const e = { v: 2 };
  if (JSON.stringify(mine.sets || []) !== JSON.stringify(base.sets || [])) e.sets = (mine.sets || []).slice();
  if ((mine.space || '') !== (base.space || '')) e.space = mine.space || '';
  ['Moon', 'Star', 'Sky'].forEach(sl => {
    const a = mainList(mine, sl);
    if (JSON.stringify(a) !== JSON.stringify(mainList(base, sl))) (e.main = e.main || {})[sl] = a;
  });
  Object.keys(SUBSTATS).forEach(s => {
    const a = (mine.w && mine.w[s]) || 0;
    if (a !== ((base.w && base.w[s]) || 0)) (e.w = e.w || {})[s] = a;
  });
  return Object.keys(e).length > 1 ? e : null;
}

/* Converts every pre-diff snapshot in state.chars to a diff over today's data. Sets, the
   Space card and main lists that differ are kept as the user's choice — those are what the
   dialog was used for — and anything equal to the data is dropped so it follows the data
   from now on. A WEIGHT that differs is dropped too, and reported: the old dialog wrote the
   whole weight grid on every save, so a saved weight that no longer matches the data is far
   more likely a value the data has since corrected than a deliberate one (both on the real
   inventory were exactly that), and a dropped weight the user did mean is one field to
   re-enter, where a kept stale one is a fix that silently never arrives.

   A main saved for a slot the data now leaves OPEN (lufel's "-") is handed back the same
   way. The old dialog wrote every main box too, and the data used to fill those slots with
   an archetype placeholder — Chizuko's Damage Multiplier Moon and Speed Sky on the real
   inventory — so a snapshot's main there is almost always that placeholder, and keeping it
   as a choice would pin exactly what the open slot corrects. */
function migrateSavedTargets() {
  const dropped = [];
  CHARACTERS.forEach(c => {
    const s = state.chars[c.n] && state.chars[c.n].targets;
    if (!s || s.v === 2) return;
    const base = defaultTarget(c);
    let e = targetEdits(base, applyTargetEdits(defaultTarget(c), Object.assign({}, s, { w: null })));
    ['Moon', 'Star', 'Sky'].forEach(sl => {
      if (!e || !e.main || !e.main[sl] || mainList(base, sl).length) return;
      dropped.push({ n: c.n, stat: `${sl} main`, saved: e.main[sl].join(' / ') || 'any', data: 'any' });
      delete e.main[sl];
      if (!Object.keys(e.main).length) delete e.main;
    });
    if (e && Object.keys(e).length === 1) e = null;   // only the version stamp left
    Object.keys(SUBSTATS).forEach(st => {
      if (!s.w || typeof s.w[st] !== 'number') return;
      if (s.w[st] !== (base.w[st] || 0)) dropped.push({ n: c.n, stat: st, saved: s.w[st], data: base.w[st] || 0 });
    });
    state.chars[c.n].targets = e;
  });
  return dropped;
}
const charDef = name => CHARACTERS.find(c => c.n === name);

/* ---- recommended main stats, in preference order ---------------------------------
   Lufel names alternatives for a slot, not a single answer: Ann's Moon is "Damage
   Multiplier or ATK%", most DPS Stars are "Crit Multiplier or Crit Rate", and two
   healers get three choices. 87 of the roster's 195 slot recommendations list more
   than one. Keeping only the first made every card carrying the other main read as
   off-target, which cost it the whole main-stat match bonus and kept genuinely
   correct cards out of the recommendation.

   So `t.main[slot]` is a LIST, best-first. A bare string is still valid everywhere
   — archetype defaults are single, and so is every target saved before this change
   — so nothing reads it directly; everything goes through these two. An EMPTY list is an
   open slot: lufel's "-", where it names no main. No main earns the match bonus there,
   and the perfect card takes whichever legal main scores best (idealCard). */
function mainList(t, slot) {
  const v = t && t.main ? t.main[slot] : null;
  if (Array.isArray(v)) return v.filter(Boolean);
  return v ? [v] : [];
}
const mainTop = (t, slot) => mainList(t, slot)[0] || null;

/* How many alternatives per slot the target editor exposes. Lufel never lists more. */
const MAIN_CHOICES = 3;

/* ---- roster card art -------------------------------------------------------
   Portraits are optional and loaded from an `art/` folder sitting next to the
   built HTML — art/<slug>.webp, e.g. art/ren-amamiya-starlight.webp. WebP
   rather than PNG because this is painted artwork: the same images run to
   ~28 MB as PNG and well under a tenth of that as WebP. The <img>
   removes itself on error, so a missing file (or the Cowork artifact build,
   where relative fetches are blocked outright) silently falls back to the
   element-tinted initials placeholder underneath. Nothing is bundled: game art
   is not ours to redistribute, and 65 embedded portraits would bloat the
   single-file build well past the point of being openable from file://. */
const artSlug = name => String(name).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const artPath = name => `art/${artSlug(name)}.webp`;

function initials(name) {
  // strip the [Costume] suffix so alternate arts don't all read the same
  const base = String(name).replace(/\[.*?\]/g, ' ').trim();
  const words = base.split(/[\s&]+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
const maxRoll = (stat, slot) =>
  slot === 'Space' ? (SUBSTATS[stat].maxRollSpace || SUBSTATS[stat].maxRoll) : SUBSTATS[stat].maxRoll;

function normStat(raw, hasPercent) {
  if (!raw) return null;
  const t = String(raw).trim();
  const withPercent = s => (hasPercent && FLAT_TO_PERCENT[s]) ? FLAT_TO_PERCENT[s] : s;
  if (SUBSTATS[t] || t === 'HP Recovery' || t === 'ATK + DEF') return withPercent(t);
  // The in-game filter UI abbreviates with a trailing period ("Ailment Acc.", "Crit
  // Mult.", "Damage Mult.+") — strip that punctuation before alias lookup so those
  // exact in-game labels resolve without needing a separate alias per variant.
  const k = t.toLowerCase().replace(/\s+/g, ' ').replace(/[%+.]+$/, '').trim();
  for (const s of Object.keys(SUBSTATS)) if (s.toLowerCase() === k) return withPercent(s);
  if (STAT_ALIASES[k]) return withPercent(STAT_ALIASES[k]);
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
   Single source of truth for "is this card legal" — used by the single-card
   form, JSON load, and the merge importer below. A card that fails here
   never reaches state.cards; the caller decides what to do with the error
   list. */
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
  // A substat carries one roll from the card being minted, plus one for every upgrade
  // that has landed on it since — and upgrades arrive on a fixed cadence, so the card's
  // level bounds how many rolls any one substat can be holding. A Lv0 card cannot carry
  // more than a single maximum roll of anything. Ignoring level cost real accuracy: an
  // OCR misread of "Speed 2" as "Speed 4" imports cleanly against a flat rarity-wide
  // ceiling, because 4 is under five max Speed rolls — but Speed maxes at 2.2 a roll, so
  // on an unlevelled card it is impossible on its face.
  // The ceiling stays deliberately generous: a card that gained its last substat late
  // spent an upgrade doing so and cannot really reach this, and the roll table itself is
  // single-sourced and unverified (see docs/DATA-SOURCES.md). Rejecting a card the user
  // genuinely owns is the expensive mistake, so only reject what is impossible outright.
  const lvl = Number.isFinite(c.level) && c.level >= 0 ? c.level : R.maxLevel;  // bad level already reported
  const rolls = 1 + upgradesUsed(c.rarity, lvl);
  const seen = new Set();
  subs.forEach(s => {
    if (!SUBSTATS[s.stat]) { errs.push(`unknown substat "${s.stat}"`); return; }
    if (s.stat === c.main) errs.push(`substat "${s.stat}" duplicates the main stat`);
    if (seen.has(s.stat)) errs.push(`substat "${s.stat}" appears twice`);
    seen.add(s.stat);
    const mx = maxRoll(s.stat, c.slot) * rolls + 0.05;   // 0.05 for the OCR's one decimal
    if (!(typeof s.value === 'number' && isFinite(s.value) && s.value > 0 && s.value <= mx))
      errs.push(`${s.stat} value ${s.value} is out of range for a Lv${lvl} ${c.rarity}★ ` +
        `(${rolls} roll${rolls === 1 ? '' : 's'} at most, so ~${(mx - 0.05).toFixed(1)})`);
  });
  return errs;
}

/* Re-resolve a raw (possibly hand-typed or OCR'd) card object against the
   canonical tables — so JSON coming from outside this app still matches on
   set/stat aliases. Does not validate. */
function normalizeCard(rc) {
  const slot = SLOTS.find(s => s === rc.slot) || rc.slot;
  const set = normSet(rc.set) || rc.set;
  const rarity = +rc.rarity;
  const level = parseInt(rc.level, 10) || 0;
  const info = SLOT_INFO[slot];
  const main = (info && info.fixed) ? info.mains[0] : (normStat(rc.main) || rc.main);
  const subs = (rc.subs || []).map(s => ({ stat: normStat(s.stat) || s.stat, value: +s.value }));
  const card = { slot, set, rarity, level, main, subs, equipped: rc.equipped || null };
  if (rc.locked && card.equipped) card.locked = true;
  // Optional: the main stat's magnitude off the card panel. cardScore() never reads it —
  // scoring only cares which stat it is — but it is the one number that lets a build be
  // totalled against a stat target, and no guide site publishes it. Absent on every card
  // saved before it existed, so everything downstream has to cope with it missing.
  const mv = parseFloat(rc.mainValue);
  if (isFinite(mv) && mv > 0) card.mainValue = mv;
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

/* Level and substats verbatim — two cards sharing this and a fingerprint read
   identically, which is what an unchanged card looks like on a second scan. */
function exactKey(c) {
  return (c.level || 0) + '|' + (c.subs || []).map(s => s.stat + ':' + s.value).sort().join('+');
}

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

/* Can the growth from `ex` to `inc` have been paid for by the upgrades between their
   levels? subsMonotonic only asks that nothing went DOWN, and that is not enough: in
   a pool of several hundred same-fingerprint cards (Sun/Power 5★ HP is a sixth of this
   inventory) a fed-away Lv0 card with three low rolls will find some unrelated Lv25
   card carrying those three names among its four at higher values, and "values only
   went up" then reported a level-up that never happened — the existing record was
   silently overwritten with a stranger. The game's own accounting rules it out:
   upgrades land on a fixed cadence (upgradesUsed), each lands one roll on one substat
   or mints the missing fourth, and every roll sits inside that stat's ROLL_TIERS
   range. So the rolls needed to explain the growth cannot exceed the upgrades gained.

   `strict` (the update pass) requires each substat's gain to be k whole rolls, k*min
   to k*max, with a tolerance for the one display unit each printed value can hide —
   the game keeps more precision than it prints (a real Lv25 DEF 130 is not a sum of
   the printed tiers), so it is a range check per stat, never a sum-of-tiers match.
   Loose (the ambiguous pass) only asks that the FEWEST rolls that could explain the
   growth fit in the budget, so an OCR misread on either scan still reaches a human
   while a pair no upgrade path can connect is proven to be two cards. */
function rollBudgetFits(ex, inc, strict) {
  const R = RARITY[inc.rarity] || RARITY[ex.rarity];
  if (!R) return true;
  const budget = upgradesUsed(inc.rarity, inc.level || 0) - upgradesUsed(ex.rarity, ex.level || 0);
  if (budget < 0) return false;
  const layout = inc.slot === 'Space' ? 'space' : 'heavens';
  const mapOld = {}; (ex.subs || []).forEach(s => mapOld[s.stat] = s.value);
  let used = 0;
  for (const s of (inc.subs || [])) {
    const tiers = ROLL_TIERS[s.stat] && ROLL_TIERS[s.stat][layout];
    if (!tiers) continue;
    const unit = SUBSTATS[s.stat] && SUBSTATS[s.stat].flat ? 1 : 0.1;
    const gain = s.value - (mapOld[s.stat] != null ? mapOld[s.stat] : 0);
    const lo = tiers[0], hi = tiers[tiers.length - 1];
    if (!strict) {
      if (gain > 3 * unit) used += Math.ceil((gain - 3 * unit) / hi);
      continue;
    }
    if (Math.abs(gain) <= unit) { if (mapOld[s.stat] == null) return false; continue; }  // a new substat is at least one roll
    if (gain < 0) return false;
    let k = 1;
    for (; k <= budget - used; k++) {
      const tol = unit * (k + 1) / 2;
      if (gain >= k * lo - tol && gain <= k * hi + tol) break;
    }
    if (k > budget - used) return false;
    used += k;
  }
  return used <= budget;
}

/* A card's substat NAMES can only grow toward that rarity's subMax (a mint at
   subMin, e.g. 3 of 4 for a 5-star, gaining exactly one more on a later
   upgrade) — never lose one, never swap one for a different stat. So two
   reads of the same physical card must have substat name-sets in a subset
   relationship: whichever read has fewer substats, every one of its names
   must appear in the other's. A single shared name is not enough — two
   independently-rolled cards sharing one of ~10 possible substats by chance
   is unremarkable and proves nothing. */
function subsNamesCompatible(a, b) {
  const namesA = new Set((a || []).map(s => s.stat));
  const namesB = new Set((b || []).map(s => s.stat));
  const [small, big] = namesA.size <= namesB.size ? [namesA, namesB] : [namesB, namesA];
  for (const n of small) if (!big.has(n)) return false;
  return true;
}

/* How many substats two reads disagree on — a value off by more than OCR rounding, or
   a stat present on one side only. Zero is subsClose; one is the shape of a single
   misread digit, and also of two real cards one roll apart. */
function subsDiffering(a, b) {
  const mapA = {}; a.forEach(s => mapA[s.stat] = s.value);
  const mapB = {}; b.forEach(s => mapB[s.stat] = s.value);
  let n = 0;
  new Set([...Object.keys(mapA), ...Object.keys(mapB)]).forEach(k => {
    if (mapA[k] == null || mapB[k] == null || Math.abs(mapA[k] - mapB[k]) > 0.05) n++;
  });
  return n;
}

function cardDistance(a, b) {
  let d = Math.abs((a.level || 0) - (b.level || 0)) * 2;
  const mapA = {}; (a.subs || []).forEach(s => mapA[s.stat] = s.value);
  const mapB = {}; (b.subs || []).forEach(s => mapB[s.stat] = s.value);
  const keys = new Set([...Object.keys(mapA), ...Object.keys(mapB)]);
  keys.forEach(k => { d += Math.abs((mapA[k] || 0) - (mapB[k] || 0)); });
  return d;
}

/* Matching a rescan against the inventory is an assignment problem over the whole
   fingerprint pool, not a lookup per card, and it must not be resolved in arrival
   order. A card that is genuinely new claims the nearest existing card first, and
   that is often the one the *next* incoming card is an exact rescan of — so the
   whole run shifts by one and every card after it is reported ambiguous against
   somebody else's twin. A 265-card rescan produced 17 such rows where the honest
   answer was "already have it".

   So match by confidence rather than by arrival, in three passes over each pool:
   exact rescans claim their counterparts, then clean level-ups claim theirs, and
   only what is still unclaimed on both sides is paired up for a human to look at.
   Within a pass the closest pair wins across the whole pool, so an incoming card
   cannot take a candidate that fits some other incoming card better. */
function mergeImport(existingCards, incomingCards) {
  const pools = new Map();
  existingCards.forEach(c => {
    const fp = cardFingerprint(c);
    if (!pools.has(fp)) pools.set(fp, []);
    pools.get(fp).push(c);
  });
  // Incoming cards grouped by fingerprint. Anything whose fingerprint the inventory
  // has never seen is new outright and never enters the matching.
  const groups = new Map();
  incomingCards.forEach((inc, i) => {
    const fp = cardFingerprint(inc);
    if (!pools.has(fp)) return;
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(i);
  });
  const verdict = new Array(incomingCards.length).fill(null);
  groups.forEach((idxs, fp) => {
    const pool = pools.get(fp), taken = new Set();
    // Most of a rescan is cards that did not change since the last one, and an
    // unchanged card matches its counterpart exactly. Claim those by hash before
    // any pairwise work: the passes below are a cross product per fingerprint, and
    // one fingerprint really does run to hundreds of cards — Sun/Power 5★ HP is a
    // sixth of this user's inventory on its own. Cards sharing this key are
    // interchangeable, so which one is claimed cannot matter, and every pair it
    // takes is one the duplicate pass below would have taken anyway.
    const byExact = new Map();
    pool.forEach((ex, j) => {
      const k = exactKey(ex);
      if (!byExact.has(k)) byExact.set(k, []);
      byExact.get(k).push(j);
    });
    idxs.forEach(i => {
      const q = byExact.get(exactKey(incomingCards[i]));
      if (!q || !q.length) return;
      const j = q.shift();
      taken.add(j);
      verdict[i] = { kind: 'duplicate', existing: pool[j] };
    });
    const pass = (kind, fits) => {
      const pairs = [];
      idxs.forEach(i => {
        if (verdict[i]) return;
        pool.forEach((ex, j) => {
          if (taken.has(j) || !fits(ex, incomingCards[i])) return;
          pairs.push({ i, j, d: cardDistance(ex, incomingCards[i]) });
        });
      });
      pairs.sort((a, b) => a.d - b.d);
      pairs.forEach(({ i, j }) => {
        if (verdict[i] || taken.has(j)) return;
        taken.add(j);
        verdict[i] = { kind, existing: pool[j] };
      });
    };
    pass('duplicate', (ex, inc) =>
      (ex.level || 0) === (inc.level || 0) && subsClose(ex.subs || [], inc.subs || [], 0.05));
    // A real level-up needs the level to have actually moved: upgradesUsed() ties every
    // substat increase to crossing a level threshold (RARITY[r].maxLevel / upgrades), so
    // at an unchanged level no upgrade could have landed and no substat could have grown.
    // inc.level > ex.level, strictly — two cards read at the same level are only ever the
    // same card if the duplicate pass above already caught them within its OCR-noise
    // tolerance; equal levels can never reach here as a legitimate update.
    // ...and the growth has to be affordable: no more rolls than the upgrades between
    // the two levels can have landed, each inside its stat's roll range (rollBudgetFits).
    pass('update', (ex, inc) =>
      (inc.level || 0) > (ex.level || 0) && subsMonotonic(ex.subs || [], inc.subs || []) &&
      rollBudgetFits(ex, inc, true));
    // Catch-all for "same fingerprint, but the numbers don't line up as a clean
    // level-up" — could be OCR noise on either scan, or a genuine second copy of the
    // same roll. Two conditions gate it, both load-bearing:
    //
    // - The incoming level must be strictly higher than the existing one, same
    //   direction as the update pass and for the same reason: a card's level only
    //   ever goes up. At an unchanged level nothing could have changed — the
    //   duplicate pass already claimed every pair that is the same card within its
    //   OCR-noise tolerance, so anything left at ex.level === inc.level is proven to
    //   be a different physical card. And ex.level > inc.level is worse than merely
    //   unproven: the existing record shows a level this incoming read cannot have
    //   come from without the card un-leveling, which the game never does. Two
    //   level-0 cards that differ at all can never be the same card; there is
    //   nothing to ask a human about.
    // - The substat NAMES must be a plausible read of the same card: substats are only
    //   ever gained, never lost or swapped (see subsNamesCompatible), so a level 0
    //   5-star's 3 substats must all reappear in any later read of the same card, in
    //   full — not merely one of them by coincidence. Two cards that share only one of
    //   three substats (e.g. one rolled HP/Crit Rate/DEF%/Crit Multiplier, the other
    //   DEF/ATK%/ATK) cannot be the same card misread, no matter how large the
    //   same-fingerprint pool is.
    //
    // Without these guards the pass ran unconditionally and forced a pairing on whatever
    // was left over once the plausible matches were claimed — reporting a "decision" for
    // pairs that were provably, not just probably, two unrelated cards.
    // - The growth must be affordable at all (rollBudgetFits, loose): if even the fewest
    //   rolls that could explain it outnumber the upgrades gained between the two levels,
    //   no misread connects the pair and the incoming card is simply new.
    pass('ambiguous', (ex, inc) =>
      (inc.level || 0) > (ex.level || 0) && subsNamesCompatible(ex.subs || [], inc.subs || []) &&
      rollBudgetFits(ex, inc, false));
  });
  // Existing cards no incoming read was matched to — duplicate, level-up or ambiguous.
  // On a partial scan this is just everything not scanned; on a scan of the whole
  // inventory it is the cards fed away since the last one, which no per-card verdict
  // can ever say. Reported, never acted on here: the review dialog offers the removal
  // and the user says whether the scan really was complete.
  const claimed = new Set();
  verdict.forEach(v => { if (v) claimed.add(v.existing); });
  // ...except that an unmatched card whose exact twin the scan DID read is not evidence
  // of a feed. Identical cards sit next to each other in the game's list, and autowalk
  // reads two adjacent pixel-identical panels as one card (its documented blind spot):
  // the Sep 2026 full scan came back with zero identical pairs against twenty in the
  // inventory, and every one of the twenty was two Steam screenshots a second apart
  // with the grid cursor moved and the panel unchanged — two cards, read once. Those
  // are kept, listed separately, and never offered for removal: a phantom card is
  // cheaper than deleting a real one.
  const claimedKeys = new Set();
  claimed.forEach(c => claimedKeys.add(cardFingerprint(c) + '#' + exactKey(c)));
  const isTwin = c => claimedKeys.has(cardFingerprint(c) + '#' + exactKey(c));
  const unmatchedTwins = existingCards.filter(c => !claimed.has(c) && isTwin(c));
  // Reported in the order they were scanned, whatever order they were matched in.
  const toAdd = [], toUpdate = [], duplicates = [], ambiguous = [];
  incomingCards.forEach((inc, i) => {
    const v = verdict[i];
    if (!v) toAdd.push(inc);
    else if (v.kind === 'duplicate') duplicates.push({ existing: v.existing, incoming: inc });
    else if (v.kind === 'update') toUpdate.push({ existingId: v.existing.id, card: inc });
    else ambiguous.push({ existing: v.existing, incoming: inc });
  });
  // Nor is an unmatched card whose same-level near-twin this scan is ADDING. A same-level
  // read that differs in one value is either two real cards one roll apart or one card
  // misread on one of the two scans, and nothing here can tell which: on the Sep 2026
  // full scan a Lv25 Moon read "Speed 4.0" where its Aug screenshot and its own frame
  // both print 2 — the new read was wrong and the old record right. So both stay, the
  // pair is reported side by side, and neither is offered for removal; the user settles
  // it from the frame named in the card's `src`.
  const unmatchedNear = [];
  const nearOf = c => toAdd.find(inc => inc.rarity === c.rarity && (inc.level || 0) === (c.level || 0) &&
    cardFingerprint(inc) === cardFingerprint(c) && subsNamesCompatible(c.subs || [], inc.subs || []) &&
    subsDiffering(c.subs || [], inc.subs || []) <= 1);
  const unmatched = existingCards.filter(c => {
    if (claimed.has(c) || isTwin(c)) return false;
    const inc = nearOf(c);
    if (inc) { unmatchedNear.push({ existing: c, incoming: inc }); return false; }
    return true;
  });
  return { toAdd, toUpdate, duplicates, ambiguous, unmatched, unmatchedTwins, unmatchedNear };
}

/* ======================== scoring engine ======================== */

/* Bump a card's main stat gets for being one the character actually wants. Later
   alternatives decay: lufel prints them in an order, and honouring it as a tie-break
   costs nothing, while the weights and the coupling below decide anything real. */
const MAIN_MATCH_BONUS = 10;
const MAIN_ALT_DECAY = 0.85;

/* HP Recovery never rolls as a substat (it's main-only, the sole exception among
   every legal main across all slots), so no archetype's weight table prices it
   directly the way it prices every other main. It gets one rule of its own, used
   wherever healing lands:

   - As a MAIN STAT it is worth something only to a character lufel actually lists it
     for (healers' Moons, and a few supports): to them it is a first-class main and is
     priced at their top weight, so it competes evenly with the slot's other choices.
     To everyone else it is worth nothing. An earlier version priced it at "the best
     of the slot's OTHER mains" as an opportunity-cost anchor — which made it never
     worse than the best main for ANY character, and the optimiser duly handed HP
     Recovery Moons to damage dealers once mains were priced at their real magnitude.
     An explicit `t.w['HP Recovery']` (a hand-edited target) wins over both rules.
   - As a 2-PIECE SET BONUS (Love's +9%, bonus2Value below) the same healing is worth the
     same: this weight, read for the Moon — the one slot HP Recovery is a legal main in —
     times `healingRolls` of it, the main's own scale. It used to be a flat 1.5 × the HP%
     weight whatever the amount, on the reasoning that a 2-piece spends no slot; but that
     is an argument about opportunity cost, not about what the healing is worth. Love's
     2-piece came to 6-15 points where the same 9% as a Moon main was 36, and Worry's
     SP Recovery 2-piece beat Love for Morgana and Lufel, whose own set it is. A character
     lufel lists no healing main for gets nothing from it: "healing effect" is the healing
     they cast, and HP% had been standing in for a stat of theirs it never touches. */
function hpRecoveryMainWeight(t, slot) {
  if (t.w['HP Recovery'] != null) return t.w['HP Recovery'];
  if (!mainList(t, slot).includes('HP Recovery')) return 0;
  return Object.keys(t.w).reduce((best, m) => Math.max(best, t.w[m] || 0), 0);
}

/* Rarity penalty applied to a card's whole score. Its own function because the
   level-0 potential estimate below has to apply it to a hypothetical extra roll
   the same way cardScore applies it to the rolls the card already has. */
const rarityPenalty = rarity => rarity === 5 ? 1 : rarity === 4 ? 0.82 : rarity === 3 ? 0.6 : 0.4;

/* Raw quality of one card for one character: weighted roll value of its substats,
   plus the main stat (weighted heavier, since a main stat is worth several rolls).

   Weights are not read straight off the target — they pass through couplingFactors()
   first, which is what makes a card's own main stat change what its substats are worth
   to this character. See STAT_PRODUCTS below for why.

   It is context-free — it never looks at the other cards worn — because it is the build
   score's card part, the one number every screen shows for a card and the one the
   optimiser shortlists on. What a card does with the other four (stat targets, damage
   balance) is the build score's other terms. A variant priced against the other worn cards
   (realCoupleContext) existed until Sep 2026 and was removed: it was a second yardstick the
   build score never used, so screens and the optimiser disagreed about which card was better. */
function cardScore(card, t) {
  const f = couplingFactors(t, card.slot, card.main);
  const w = stat => (t.w[stat] || 0) * cf(f, stat);
  let s = 0;
  for (const sub of card.subs || []) {
    const ws = w(sub.stat);
    if (!ws) continue;
    s += (sub.value / maxRoll(sub.stat, card.slot)) * ws;
  }
  /* The main stat, at its real magnitude for this card's level (MAIN_MAGNITUDE). At max
     level that is about nine maximum rolls — as much as all four substats of a perfect
     card together — so a card with the right main and ordinary substats beats one with a
     dead main and excellent substats, which is how the game actually values them. The
     match bonus is a tie-break on lufel's printed order and nothing more. */
  let mainPart = 0;
  if (card.slot !== 'Sun' && card.slot !== 'Space') {
    const rank = mainList(t, card.slot).indexOf(card.main);
    mainPart = mainWeightFor(card, t) * mainRolls(card.main, card.slot, card.level) +
      (rank >= 0 ? MAIN_MATCH_BONUS * Math.pow(MAIN_ALT_DECAY, rank) : 0);
  }
  return (s + mainPart) * rarityPenalty(card.rarity);
}

/* The coupled weight a card's main stat is priced at — HP Recovery has no substat
   weight to couple, so it takes its own rule. Shared by cardScore and the level-0
   potential estimate, which has to grow the main the same way it grows the substats. */
function mainWeightFor(card, t) {
  if (card.main === 'HP Recovery') return hpRecoveryMainWeight(t, card.slot);
  const f = couplingFactors(t, card.slot, card.main);
  return (t.w[card.main] || 0) * cf(f, card.main);
}

/* How many of a card's rarity-limited upgrade rolls have not landed yet. A substat
   carries one roll from the mint plus one per upgrade that has landed on it since,
   and upgrades arrive on a fixed cadence — the same accounting validateCard uses to
   bound what an OCR'd value is allowed to be. */
function upgradesUsed(rarity, level) {
  const R = RARITY[rarity];
  const perUpgrade = R.maxLevel / R.upgrades;
  return Math.min(R.upgrades, Math.floor((level || 0) / perUpgrade));
}
function remainingUpgrades(card) {
  return RARITY[card.rarity].upgrades - upgradesUsed(card.rarity, card.level);
}

/* Where a card's remaining upgrades land in the best case for this character — the rule
   potentialCardScore prices, and the answer to "why did this card make the level-0 list".

   A card minted below its rarity's subMax gains the missing substat on its FIRST upgrade
   (the accounting validateCard and mergeImport's roll budget already use), and 60% of the
   user's level-0 cards were minted with three. In the best case that new substat is the
   stat worth most to this character that the card does not already carry (never its main
   — the game will not mint a duplicate), at one maximum roll; every upgrade after it lands
   on whichever substat is then worth the most. Treating all the upgrades as rolls on the
   existing substats got this wrong both ways: it could not see a fourth substat better than
   anything the card has, and it let the first upgrade land on an existing one, which it
   cannot.

   `mint` is what the upgrades add, each { stat, w } at one roll; `rolls` how many upgrades
   are left after minting and `w` the coupled weight each is priced at; `onto` the substat
   those rolls pile onto (ties all come back, since an upgrade could land on any of them).
   `mint` and `onto` are empty when nothing the card could reach is worth anything here. */
function bestCaseUpgrades(card, t) {
  const f = couplingFactors(t, card.slot, card.main);
  const w = stat => (t.w[stat] || 0) * cf(f, stat);
  const have = (card.subs || []).map(s => s.stat);
  const R = RARITY[card.rarity];
  const remaining = remainingUpgrades(card);
  const mints = Math.min(remaining, R ? Math.max(0, R.subMax - have.length) : 0);
  const mint = Object.keys(SUBSTATS).filter(s => have.indexOf(s) < 0 && s !== card.main)
    .map(stat => ({ stat, w: w(stat) })).filter(x => x.w > 0)
    .sort((a, b) => b.w - a.w).slice(0, mints);
  const pool = have.map(stat => ({ stat, w: w(stat) })).concat(mint);
  let best = 0;
  pool.forEach(x => { if (x.w > best) best = x.w; });
  return { mint, rolls: remaining - mints, w: best, onto: best > 0 ? pool.filter(x => x.w === best).map(x => x.stat) : [] };
}

/* Best case score for a card that has not finished levelling: a missing substat minted at
   one maximum roll of the best stat it could be, then every remaining upgrade at maximum
   magnitude on whichever substat is worth the most to this character (bestCaseUpgrades).
   Past the mint, upgrades only amplify a substat the card already has — so a full card with
   nothing this character wants stays at its current score no matter how many rolls are left.

   This is a ceiling, not a forecast: the game picks which substat a new one is and which an
   upgrade lands on, not the player. It answers "is this worth levelling to find out", not
   "here is what it will score". */
function potentialCardScore(card, t) {
  const remaining = remainingUpgrades(card);
  const base = cardScore(card, t);
  if (!remaining) return base;
  // Levelling also grows the main stat along MAIN_MAGNITUDE's curve; unlike the
  // substats that part is a certainty, not a ceiling.
  const maxLv = RARITY[card.rarity].maxLevel;
  const mainGrowth = (card.slot === 'Sun' || card.slot === 'Space') ? 0
    : mainWeightFor(card, t) * (mainRolls(card.main, card.slot, maxLv) - mainRolls(card.main, card.slot, card.level));
  const up = bestCaseUpgrades(card, t);
  const subGrowth = up.mint.reduce((s, x) => s + x.w, 0) + up.rolls * up.w;
  return base + (subGrowth + mainGrowth) * rarityPenalty(card.rarity);
}

/* The card as it will be at its rarity's level cap, for the main stat only: substats are
   left exactly as rolled. Triage and the Vault ask "is this worth keeping", and a main
   stat's growth with level is a certainty (MAIN_MAGNITUDE is linear in level) while an
   upgrade landing on the right substat is not — so the main is priced at its final
   magnitude and the substats at their current one. Without this an unlevelled card's main
   counts at its Lv0 value (about 1.3 max rolls against 9 at Lv25), and in an inventory
   that is mostly unlevelled — the user's is 92% level 0 — no level-0 Moon, Star or Sky card
   could ever grade as a keeper against the slot's best max-level card. The optimiser does
   NOT use this: it dresses the character in what exists now, and the level-0 panel
   (potentialCardScore) is where "worth levelling" is answered there. */
function atMaxLevel(card) {
  const cap = RARITY[card.rarity] ? RARITY[card.rarity].maxLevel : card.level;
  return card.level >= cap ? card : Object.assign({}, card, { level: cap });
}

/* A 2-piece's stat terms: its modelled bonus, then any further stat the same line moves
   (`bonus2Also`, signed — Prudence's "Speed -3" beside its +18% ATK). Both readers of a
   2-piece go through this, so a cost is never charged in the score and forgotten in the
   in-battle totals, or the other way round. Memoised per set: bonus2Value runs inside
   bestPlan's 2+2 enumeration millions of times per `npm run scale`, and building a fresh
   array on every call cost that benchmark about 15%. */
const bonus2PartsMemo = new WeakMap();
function bonus2Parts(S) {
  if (!S || !S.bonus2) return [];
  let p = bonus2PartsMemo.get(S);
  if (!p) bonus2PartsMemo.set(S, p = [S.bonus2].concat(S.bonus2Also || []));
  return p;
}

/* Value of a 2-piece bonus, on the same scale as card scores: a flat "+12% ATK"
   is simply worth however many maximum ATK% rolls that is, times the stat's weight.
   A cost term subtracts the same way, so a 2-piece can be worth less than nothing to a
   character who wants the stat it takes away. */
function bonus2Value(setName, char, t) {
  const S = SETS[setName];
  if (!S || !S.bonus2) return 0;
  if (S.elem && S.elem !== char.e) return 0;
  const parts = bonus2Parts(S);
  let v = 0;
  for (let i = 0; i < parts.length; i++) {
    const b = parts[i];
    // healing has no substat, so it is priced the way the HP Recovery main is (see there)
    v += b.stat === 'HP Recovery' ? hpRecoveryMainWeight(t, 'Moon') * healingRolls(b.amt)
      : (t.w[b.stat] || 0) * (b.amt / maxRoll(b.stat, 'Sun'));
  }
  return v;
}
/* Healing effect % in "rolls", on the HP Recovery main's own scale — a max-level main
   (MAIN_MAGNITUDE, 22.6%) is MAIN_ROLLS_FALLBACK rolls, as mainRolls() counts it. */
const healingRolls = pct => MAIN_ROLLS_FALLBACK * pct / MAIN_MAGNITUDE['HP Recovery'][1];

/* Value of a 4-piece bonus. These are typically worth 20-40% more damage or
   survivability, which lands around one whole card's worth of stats. Element sets
   are worthless to off-element characters, and so is a 4-piece that names an element
   (`elem4`) on a set whose 2-piece does not: Defeat's +15% ailment accuracy works for
   anyone, but its 4-piece raises Fire damage only, so Toshiya — Curse, lufel's Defeat
   pick for the accuracy — was being paid the alternative's 4-piece for nothing. */
function bonus4Value(setName, char, t, base) {
  const S = SETS[setName];
  if (!S) return 0;
  if (S.elem && S.elem !== char.e) return 0;
  if (S.elem4 && S.elem4 !== char.e) return 0;
  const B = base == null ? 55 : base;
  const i = (t.sets || []).indexOf(setName);
  if (i === 0) return B + prefSetLift(char, t, B);
  if (i > 0) return B * 0.72;
  return B * 0.22;
}

/* ---- the preferred set is the ceiling, by lufel's order ------------------------------
   The 55 / ×0.72 / ×0.22 above are this tool's invention: a stand-in for "how good is this
   4-piece for this character", with lufel's ranking supplying the order. A 2-piece is priced
   from its stat. Where a 2-piece's stat is worth a lot to someone — an ATK% 2-piece to a buffer
   weighting ATK% at 10, Worry's +80% SP Recovery to a healer — the two pricings disagreed about
   lufel's order, and at equal perfect cards another configuration beat the preferred 4-piece:
   Power's 4-piece or two ATK 2-pieces outscored Labor for every Elucidator, Worry's 2-piece
   beat Love for Lufel, and a 2+2 split beat the preferred 4-piece for 18 characters. Perfect
   was then not a ceiling. What the flat number cannot see is the 4-piece's own effect (Labor's
   ATK/HP/DEF for the whole party, Prosperity's Highlight charge, Reconciliation's in-combat
   stats) and that the 2-piece's stat runs past the kit's cap (an Elucidator's ATK buffs stop
   growing at their ATK target). The order is lufel's and is trusted; the number is ours, so the
   number yields: the preferred 4-piece is lifted by exactly what it takes to be worth as much as
   any other configuration of perfect cards — any other 4-piece, any two 2-pieces. Measured on
   the whole loadout (stat targets and damage spread included, because a 2-piece stat feeds
   both) at the P4 the caller prices with; zero for most of the roster.

   Only the preferred set. Lufel's list is also an order among its alternatives, but reading it
   as "each alternative beats every unlisted configuration" says more than lufel does, and it
   was tried: the alternatives' lifts ran to 40 points and dragged the preferred set up after
   them, lifting 30 characters rather than the 18 whose ceiling was actually broken.

   Memoised per character, dropped when their Setup or saved target changes — not per target
   object, since target() hands out a fresh one per call to characters on the data's defaults,
   and the roster rebuilds every build score on each keystroke in its search box. Only the
   character's own target gets a lift: a hand-built or archetype target (the Vault's) has no
   lufel order of its own to hold, and neither does a preferred set whose 4-piece is dead for
   the character (elem4). */
const SET_LIFT_PAIRS = 8;   // two-plus-two configurations are searched among this many best 2-pieces
const setLiftMemo = {};
let setLiftsOff = 0;
function prefSetLift(char, t, B) {
  if (setLiftsOff || !char || !t || !t.n || t.n !== char.n) return 0;
  /* Callers pass the character's own target(), which is a function of the data, the saved
     edits and nothing else — so those two identities (and the Setup's) are the version stamp,
     with the team crit rate, which the damage-spread term reads. The preferred set is checked
     too, as a cheap guard against a caller handing in some other target with the same name. */
  const who = state.chars[char.n] || {}, pref = (t.sets || [])[0], tc = teamCritRate(), den = denSig();
  let m = setLiftMemo[char.n];
  if (!m || m.lo !== who.loadout || m.saved !== who.targets || m.pref !== pref || m.tc !== tc || m.den !== den)
    m = setLiftMemo[char.n] = { lo: who.loadout, saved: who.targets, pref, tc, den, byBase: {} };
  if (m.byBase[B] == null) m.byBase[B] = computePrefSetLift(char, t, B);
  return m.byBase[B];
}
function computePrefSetLift(char, t, P4) {
  setLiftsOff++;
  try {
    const usable = s => SETS[s] && !SETS[s].unreleased && !(SETS[s].elem && SETS[s].elem !== char.e);
    const pref = (t.sets || [])[0];   // the set bonus4Value lifts, whatever it is
    if (!pref || !usable(pref) || (SETS[pref].elem4 && SETS[pref].elem4 !== char.e)) return 0;
    const lo = charLoadout(char.n), idl = idealLoadout(char, t, P4);
    const heav = idl.cards.filter(c => c.slot !== 'Space'), sp0 = idl.cards.filter(c => c.slot === 'Space')[0];
    if (heav.length !== 4 || !sp0) return 0;
    const spaces = Object.keys(SPACE_SETS).filter(s => !SPACE_SETS[s].unreleased);
    const total = (sets, space) => {
      const b = buildScoreOf(char, heav.map((c, i) => Object.assign({}, c, { set: sets[i] }))
        .concat([Object.assign({}, sp0, { set: space })]), P4, lo, idl, t);
      return b ? b.total : -Infinity;
    };
    const four = s => total([s, s, s, s], spaces.filter(sp => SPACE_SETS[sp].pairs.indexOf(s) >= 0)[0] || sp0.set);
    const all = Object.keys(SETS).filter(usable);
    let rival = -Infinity;
    all.forEach(s => { if (s !== pref) rival = Math.max(rival, four(s)); });
    const byTwo = all.slice().sort((a, b) => bonus2Value(b, char, t) - bonus2Value(a, char, t)).slice(0, SET_LIFT_PAIRS);
    for (let i = 0; i < byTwo.length; i++) for (let j = i + 1; j < byTwo.length; j++)
      rival = Math.max(rival, total([byTwo[i], byTwo[i], byTwo[j], byTwo[j]], sp0.set));
    return Math.max(0, rival - four(pref));
  } finally { setLiftsOff--; }
}

/* A Space card does nothing at all unless a 4-piece it pairs with is active, so the
   pairing is worth real build quality rather than being only a tie-breaker. Shared
   between the optimiser's Space pick and the build score so the two cannot drift. */
const SPACE_PAIR_VALUE = 9;

/* ========================= build score =========================
   How well a character is actually geared, on a 1-100 scale.

   Plan scores elsewhere in this file are ordinal — they compare loadouts for one
   character and nothing more. This one is a ratio of two numbers built from the same
   weights, so the units cancel and the result IS comparable across characters.

   100 is a perfect loadout for that character: five 5-star cards at max level, all
   four Heavens cards in the preferred set, the target main stat in every slot, a
   Space card that pairs with the 4-piece, and every substat roll landing at maximum
   magnitude on one of the character's four best stats other than that card's main. */

/* A max-level 5-star holds nine substat rolls — four substats plus five upgrades.
   The ideal spreads them 3/2/2/2 over the four best stats, best first. Funnelling all
   five upgrades into one substat would score higher, but that outcome is vanishingly
   rare, and using it as the denominator would squash every real build into the low
   thirties. A card that does beat this simply clamps the total at 100. */
const IDEAL_ROLLS = [3, 2, 2, 2];

/* Substats the perfect card carries: the stats this character has a hard target for,
   then the highest-weighted stats, four in all. Targets go in unconditionally — a build
   that has to reach 180 Speed spends substats on Speed whether or not the generic
   weighting rates it, and a denominator that ignored that would let a build score 100
   while missing the one number the character actually needs.

   `exclude` is the card's own main: the game never mints a substat that duplicates the
   main (validateCard rejects it), so a perfect Crit Rate Star carries the four best stats
   OTHER than Crit Rate. It used to carry Crit Rate twice, which made every Moon/Star/Sky
   ceiling a card that cannot exist — two or three max rolls too high — and since that
   ceiling is the denominator of the build score and of every per-card percentage, both
   read low for everyone. Without `exclude` this is the generic all-slot list the
   coupling baseline seeds from, where no single main applies. */
function idealSubs(t, exclude) {
  const targeted = (t.targets || []).map(x => x.sub).filter(s => SUBSTATS[s]);
  const byWeight = Object.keys(t.w).filter(s => SUBSTATS[s] && t.w[s] > 0);
  const seen = {}, out = [];
  targeted.concat(byWeight).forEach(s => { if (!seen[s] && s !== exclude) { seen[s] = 1; out.push(s); } });
  return out.sort((a, b) => (t.w[b] || 0) - (t.w[a] || 0)).slice(0, IDEAL_ROLLS.length);
}

/* The perfect card for `slot` given a specific main: max-level 5★, IDEAL_ROLLS spread over
   the best substats the main leaves available. */
function idealCardFor(slot, t, setName, main) {
  return {
    slot, set: setName, rarity: 5, level: RARITY[5].maxLevel, main,
    subs: idealSubs(t, main).map((stat, i) => ({ stat, value: maxRoll(stat, slot) * IDEAL_ROLLS[i] }))
  };
}

function idealCard(slot, t, setName) {
  const mk = main => idealCardFor(slot, t, setName, main);
  if (slot === 'Sun') return mk('HP');
  if (slot === 'Space') return mk('ATK + DEF');
  /* With alternatives on offer the perfect card takes whichever of them actually
     scores best, not simply the first. The coupling below means that is a real
     question — a Crit Multiplier main pulls its own weight down and Crit Rate's up —
     and a denominator that ignored it could be beaten by a card the user owns. */
  /* An open slot — lufel's "-", no main recommended — takes the best of every legal main,
     so its ceiling is the best card the slot can hold. It used to take the slot's first
     legal main (ATK%), and before that an archetype placeholder stood in for the "-":
     Chizuko's Damage Multiplier Moon and Speed Sky, and Runa's HP% Moon, were each beaten
     by 15-20% by a main her own weights prefer. */
  const opts = mainList(t, slot);
  return (opts.length ? opts : SLOT_INFO[slot].mains).map(mk).reduce((a, b) => cardScore(b, t) > cardScore(a, t) ? b : a);
}

/* A card score on a 0-100 scale: what share of a PERFECT card for this slot and this
   character the card is worth, where perfect is the same `idealCard` that anchors the
   build score (max-level 5★, best recommended main, every roll maxed on the four best
   stats). Raw cardScores are unbounded and differ by slot by construction — a Moon or
   Star card carries a main worth ~nine rolls, a Sun or Space card never can — so two raw
   numbers side by side say which SLOT is valuable, not which card needs replacing. Dividing
   each by its own slot's ceiling takes that out, and the displayed number reads the same
   way in every slot: how far this card is from the best one that can exist there.

   Anything beating the ideal clamps at 100, as `buildScore` does: `IDEAL_ROLLS` spreads
   the upgrades [3,2,2,2], so a card that funnelled all five into one top stat can edge it.
   Numerator and denominator are both the context-free `cardScore`, the one `scoreLoadout`
   prices the build score's card part with, on both its sides. Every screen shows that one
   number for a card (Sep 2026): some used to show it priced against the other four worn
   cards (`realCoupleContext`), so one card read two numbers and ranked differently on two
   screens — Kotone Shiomi's worn ATK% Star 110.1 in the Loadout popup and 107.9 on Weakest
   slots, the Crit Rate one beside it 101.5 and 110.6. What a card does with the other four
   (stat targets, damage balance) is the build score's other terms, shown as a Build gain.
   This is a DISPLAY conversion: nothing ranks or optimises on it, and it says nothing about
   how good a card is for a different character. Memoised per target like `couplingFactors`. */
const idealCardScoreCache = new WeakMap();
function idealCardScore(slot, t) {
  const m = targetMemo(idealCardScoreCache, t);
  if (m[slot] === undefined) m[slot] = cardScore(idealCard(slot, t, ''), t);
  return m[slot];
}

/* A memo hung off a target object that is dropped when the character's Setup changes.
   Everything memoised per target also depends on the loadout — the coupling's baseline
   reads the weapon, Awakening and Awareness (seedBaseline, lockedCritSupply), and the ideal
   card is chosen through that coupling — while target() returns the SAME object for as
   long as a saved target exists. Keyed on the target alone, a weapon, refinement or
   Awareness change on any of those characters kept pricing cards against the old setup
   until the page was reloaded (6 of the 8 saved targets on the real inventory, up to 7% on
   a perfect card). Every write to a loadout assigns a fresh object and charLoadout never
   hands the saved one out, so that object's identity is a sufficient version stamp. The
   Roster's team crit rate is the one input from outside the character, and is checked
   beside it — for the Vault's archetype targets, which have no loadout, it is the only one. */
function targetMemo(cache, t) {
  const who = t && t.n ? state.chars[t.n] : null;
  const lo = who ? who.loadout : undefined, tc = teamCritRate();   // the coupling reads the party's crit rate too
  let m = cache.get(t);
  if (!m || m.lo !== lo || m.tc !== tc) { m = { lo, tc, v: {} }; cache.set(t, m); }
  return m.v;
}
function cardPct(score, slot, t) {
  const ideal = idealCardScore(slot, t);
  if (!(ideal > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round(100 * score / ideal)));
}
/* The raw points between this card and the perfect one for its slot — the other half of
   the picture. The percentage is scaled per slot, so 30 points on a Sun card and 30 on a
   Star card are the same distance from perfect but not the same raw gain: a Moon/Star/Sky
   ceiling is roughly twice a Sun/Space one, because its main is worth ~nine rolls and a
   fixed HP or ATK+DEF main is worth nothing to anyone. Headroom is in the raw score's
   units, so across this one character's five slots the largest headroom is the largest
   gain a perfect replacement could bring. Still not comparable across characters. */
function cardHeadroom(score, slot, t) {
  return Math.max(0, idealCardScore(slot, t) - score);
}
/* The `<span class="score">` every per-card number on screen is drawn with: the
   percentage, then the headroom in raw points, muted. */
function cardPctHtml(score, slot, t) {
  const pct = cardPct(score, slot, t), room = cardHeadroom(score, slot, t);
  return `<span class="score" title="${pct} of 100: how close this card is to a perfect ${esc(slot)} card for this character">${pct}</span>` +
    `<span class="tiny muted" style="margin-left:5px" title="Raw points a perfect ${esc(slot)} card would add over this one. Comparable across this character's five slots, so the largest headroom is the biggest gain available.">${room.toFixed(1)} left</span>`;
}

/* ---- complementary stats: what the main stat you took does to your substats -------
   Damage is a product of separate factors, not a sum. Your ATK total multiplies your
   damage multiplier; your crit rate multiplies your crit multiplier. Two stats sitting
   in different factors of the same product are therefore complements: the more of one
   you hold, the less another point of it buys and the more a point of its partner
   does. That is exactly why lufel offers ATK% and Damage Multiplier as interchangeable
   Moon mains — and it means the choice is not free. Take the Damage Multiplier main
   and you want ATK% in the substats; take the ATK% main and you want the reverse.

   Each factor's supply is measured in **max-roll equivalents** — points held divided
   by points one max roll is worth — because that is the unit `cardScore` prices
   substats in, and because it makes the factors comparable to each other. Marginal
   value of a factor is then simply 1 / its supply, so a stat's weight is scaled by
   (reference / supply) with the reference the geometric mean over the factors of the
   same product. That normalisation makes the adjustments multiply to 1, so nothing
   here moves the overall scale of a card score, only the balance inside it. There is
   no tuning constant: the exponent is 1 because 1 is the true marginal ratio.

   The baselines are what a typical character holds for free — a character with no
   bonuses at all still deals 100% of base ATK for 100% damage, so both damage factors
   start at 100, and STAT_PRODUCTS' 5/150 crit pair is what 58 of the 65 in CHAR_STATS
   actually carry. The crit factor counts the multiplier as its bonus above 100 (150%
   crit damage is +50), since that is the part crit rate multiplies. These numbers are only
   the fallback for a target that names no character (a hand-built one in a test): every
   real character seeds from their own damageBase (seedBaseline), and an Elucidator is not
   coupled at all (see computeCoupling).

   Two stats are deliberately absent. Resistance Pierce is its own factor, but how much
   a point is worth depends on the enemy's resistance, which nothing here models.
   Flat ATK feeds the ATK factor, but a max roll of it is worth well under half an ATK%
   roll and how much depends on a base ATK this function is not given.

   The first product's scaling stat is per character: a kit that deals damage off DEF or
   max HP (DAMAGE_SCALE below) has DEF% or HP% in the ATK factor's seat, not ATK%. */
const STAT_PRODUCTS = [
  { 'ATK%': 100, 'Damage Multiplier': 100 },
  { 'Crit Rate': 5, 'Crit Multiplier': 50 }
];
function statProducts(char) {
  const pct = scalePctStat(char);
  if (pct === 'ATK%') return STAT_PRODUCTS;
  const first = {}; first[pct] = 100; first['Damage Multiplier'] = 100;
  return [first, STAT_PRODUCTS[1]];
}

/* A main stat in max rolls of its own substat, at a given card level, from the measured
   MAIN_MAGNITUDE curve. About 9 at max level for every stat with a substat. HP Recovery
   has no substat to roll against, so it borrows that 9 and scales it by level; anything
   not in the table (there is nothing today) falls back to the same figure. Other
   rarities are assumed to sit on the 5-star curve up to their own level cap — only
   5-star cards have been scanned. */
const MAIN_ROLLS_FALLBACK = 9;
function mainMagnitudeAt(stat, level) {
  const m = MAIN_MAGNITUDE[stat];
  if (!m) return null;
  const cap = RARITY[5].maxLevel;
  const lv = Math.max(0, Math.min(cap, level == null ? cap : level));
  return m[0] + (m[1] - m[0]) * lv / cap;
}
/* Whether a card's scanned `mainValue` is what the game prints at the card's level. A 5★
   main is a function of level alone (MAIN_MAGNITUDE, to within one display unit — the
   OCR's check_main_value uses the same tolerance), so a value off that line is stale or
   misread, and the level wins: cardScore already prices the main from the level, and the
   totals must read the same card. The standing case (Sep 2026): cards scanned at Lv0, then
   levelled in the game and set to Lv25 in the card editor, which kept the Lv0 value —
   Kotone Shiomi wore four, every ATK% main counted at 4.6% instead of 31.4%, so her ATK
   target read 75% and Weakest slots offered a card Optimise (pricing by level) did not.
   Other rarities have no measured curve, so their scanned value is all there is. */
function mainValueFitsLevel(card) {
  if (card.mainValue == null || card.rarity !== 5) return true;
  const m = MAIN_MAGNITUDE[card.main];
  if (!m) return true;
  const unit = Number.isInteger(m[0]) && Number.isInteger(m[1]) ? 1 : 0.1;
  return Math.abs(card.mainValue - mainMagnitudeAt(card.main, card.level)) <= unit + 1e-6;
}
function mainRolls(stat, slot, level) {
  const m = mainMagnitudeAt(stat, level);
  if (m == null) return MAIN_ROLLS_FALLBACK;
  if (!SUBSTATS[stat]) return MAIN_ROLLS_FALLBACK * m / MAIN_MAGNITUDE[stat][1];
  return m / maxRoll(stat, slot || 'Sun');
}

/* A guard against pathological weights, not a tuning knob — real targets land inside
   0.8-1.25 for the damage pair and 0.85-1.2 for crit once a build is half-geared. An
   ungeared crit build genuinely does sit near the wide end: at the innate 5% crit rate
   a crit multiplier roll really is worth a fraction of a crit rate roll. */
const COUPLE_CLAMP = [0.4, 2.5];

/* Supply of each stat in `product`, in max-roll equivalents, for the build this
   character is aiming at — with `slot` pinned to the main stat `main`, so a card is
   priced against the rest of the build rather than against itself. */
function productSupply(product, t, slot, main) {
  const R = {};
  /* The baseline is THIS character's, not the roster-wide
     guess: base crit, Awakening-7 crit and the weapon's unconditional ladder are all in
     CHAR_STATS, and they move the balance a lot — a DPS with a +30% ATK weapon and
     Awakening 7 starts at 159% ATK, so the Damage Multiplier Moon is the better
     complement to an ATK% Sky, exactly what lufel lists as the alternative. Elucidators
     never reach this: computeCoupling does not couple them at all. */
  const seed = seedBaseline(t);
  Object.keys(product).forEach(st =>
    R[st] = (seed && seed[st] != null ? seed[st] : genericSupply(product, st, t)) / maxRoll(st, 'Sun'));
  const add = (stat, rolls) => { if (R[stat] != null) R[stat] += rolls; };
  /* A kit whose damage partly always crits (CRIT_PROFILE) buys Crit Rate for only the
     rolled share; see lockedCritSupply for the algebra. Evaluated on the crit damage the
     board already holds, so Akihiko below his Theurgy's 250% floor gets no Crit
     Multiplier credit from the locked share until he clears it. */
  if (R['Crit Rate'] != null && R['Crit Multiplier'] != null && t && t.n) {
    const prof = critProfile(charDef(t.n)), L = charLoadout(t.n);
    if (prof) add('Crit Rate', lockedCritSupply(prof, 100 + R['Crit Multiplier'] * maxRoll('Crit Multiplier', 'Sun'),
      L) / maxRoll('Crit Rate', 'Sun'));
    /* A share critting at a higher rate (`extraCr`) makes a Crit Multiplier point worth
       cr + share × extra instead of cr, while a Crit Rate point stays worth the crit bonus —
       so, as with the locked share, the Crit Rate supply reads share × extra higher. Held
       under the 100% cap, since a share already at 100% gains nothing more. */
    const ex = extraCritFor(prof, L);
    if (ex) add('Crit Rate', ex.share * Math.min(ex.cr, Math.max(0, 100 - R['Crit Rate'] * maxRoll('Crit Rate', 'Sun')))
      / maxRoll('Crit Rate', 'Sun'));
  }
  ['Moon', 'Star', 'Sky'].forEach(sl => {
    if (sl === slot) { if (main) add(main, mainRolls(main, slot)); return; }
    /* The other slots are not decided yet, so spread their main across the
       alternatives on offer instead of betting on the first one. */
    const list = mainList(t, sl);
    list.forEach(st => add(st, mainRolls(st, sl) / list.length));
  });
  /* Substats come from the build being aimed at — the same ideal allocation the build
     score measures against, over all five slots. It reads the raw weights, not the
     coupled ones, which is what keeps this from chasing its own tail. */
  idealSubs(t).forEach((st, i) => add(st, SLOTS.length * IDEAL_ROLLS[i]));
  return R;
}

/* The character's own supply of the coupled stats before any card (see productSupply). */
function seedBaseline(t) {
  const ch = t && t.n ? charDef(t.n) : null;
  if (!ch || !CHAR_STATS[ch.n] || !spreadApplies(ch)) return null;
  const B = damageBase(ch), cv = conversionBonus(ch, [], charLoadout(ch.n));
  const out = { 'Damage Multiplier': 100 + B.dm + cv['Damage Multiplier'], 'Crit Rate': B.cr, 'Crit Multiplier': Math.max(0, B.cm - 100 + cv['Crit Multiplier']) };
  out[scalePctStat(ch)] = 100 + B.atkPct + (scaleStat(ch) === 'ATK' ? cv['ATK%'] + (B.atk > 0 ? 100 * cv.ATK / B.atk : 0) : 0);
  return out;
}
/* Per-stat weight multipliers for a card in `slot` whose main stat is `main`, against the
   character's own baseline and the build being aimed at. */
function computeCoupling(t, slot, main) {
  const f = {};
  const ch = t && t.n ? charDef(t.n) : null;
  /* An Elucidator's stats are donated — every one of the eight passes each ally 20% of
     their own (15% at 4-star) — so what a Crit Rate or ATK% roll on their card is worth
     is decided by the RECEIVING ally's balance, which nothing here knows. Their own board
     says nothing about it: seven of the eight carry a 0% / 0% crit base. The coupling used
     to fall back to the generic 5% / 150% guess for them, which is an ungeared ally, and
     priced a Crit Rate roll at 1.8-2.9 times a Crit Multiplier roll — so every
     Elucidator's cards were priced for a crit balance no teammate they buff has.
     Fuuka was the visible case: lufel's Crit Multiplier Star, the stat her Spirit Wave
     turns into party crit damage, lost to a Crit Rate Star by 11% at equal substats. At a
     geared ally's board the two rolls are worth about the same, so the neutral answer is
     no coupling at all: their cards are priced on their weights, which is lufel's own
     order for them. */
  if (ch && !spreadApplies(ch)) return f;
  const own = buffSourceStats(ch);
  for (const product of statProducts(ch)) {
    /* A product with only one stat the character cares about has nothing to trade off. A
       stat the kit turns into an ally buff (BUFF_SOURCE_STATS) is not traded off against
       the character's own damage either: its worth is the buff. */
    const live = Object.keys(product).filter(st => (t.w[st] || 0) > 0 && own.indexOf(st) < 0);
    if (live.length < 2) continue;
    const R = productSupply(product, t, slot, main);
    /* The marginal-value ratio below is 1/supply, which is only defined while every
       factor of the product actually holds something. A supply of zero is reachable
       and real, not a bug to paper over: an Elucidator with a 0% crit base and no crit
       substats on the board holds literally no crit damage, and the geometric mean of
       a set containing 0 is 0, so `ref / R[st]` is 0/0. Skipping leaves these stats
       uncoupled (factor 1 via `cf`) — the neutral answer, and the one consistent with
       damageFactors, which floors their ⓓ at 1 and so prices a crit roll at no damage
       rather than guessing what an unreachable crit would be worth. */
    if (!live.every(st => R[st] > 0)) continue;
    const ref = Math.exp(live.reduce((s, st) => s + Math.log(R[st]), 0) / live.length);
    live.forEach(st => f[st] = Math.max(COUPLE_CLAMP[0], Math.min(COUPLE_CLAMP[1], ref / R[st])));
    /* Crit Rate past 100% does nothing, so once what is actually HELD reaches 100 points a
       further roll is worth exactly nothing — a hard zero, not the clamp's floor. "Held"
       is the character's own baseline (the team crit rate included) plus this card's main
       when it is Crit Rate; the idealised substat allocation is not counted, since it is a
       guess about cards not yet placed. Morgana with Golden Legacy at refine 7 on a Crit
       Rate Star is the live case. */
    if (f['Crit Rate'] != null && heldCritRate(t, main) >= 100) f['Crit Rate'] = 0;
  }
  return f;
}
function heldCritRate(t, main) {
  const base = (seedBaseline(t) || {})['Crit Rate'];
  return (base != null ? base : genericSupply(STAT_PRODUCTS[1], 'Crit Rate', t)) + (main === 'Crit Rate' ? MAIN_MAGNITUDE['Crit Rate'][1] : 0);
}
/* STAT_PRODUCTS' fallback baseline for a target with no board of its own (no character, or
   one without CHAR_STATS) — the Vault's archetype targets among them — with the party's crit
   rate on top, as every character's own baseline carries it through damageBase. */
function genericSupply(product, st, t) {
  return product[st] + (st === 'Crit Rate' ? teamCritFor(t && t.n ? charDef(t.n) : null) : 0);
}
/* A coupling factor of 0 is a real answer (capped Crit Rate); only a missing one means "no coupling". */
const cf = (f, stat) => (f[stat] != null ? f[stat] : 1);
const couplingCache = new WeakMap();
/* Memoised per target: cardScore runs over the whole inventory for every plan, and there
   are only a handful of distinct slot/main pairs. Dropped when the character's Setup
   changes — see targetMemo. */
function couplingFactors(t, slot, main) {
  const byKey = targetMemo(couplingCache, t);
  const key = slot + '|' + main;
  return byKey[key] || (byKey[key] = computeCoupling(t, slot, main));
}

/* ---- stat targets ("recommended stats" on lufel) ---------------------------------
   39 of the 68 characters carry hard numbers — 180 Speed for Rin, 171% Ailment Accuracy
   for Howler, 4600 ATK for Oracle. Generic substat weights cannot express these: weights
   make stats fungible (Ailment Accuracy 10 and Speed 10 trade freely), whereas a target
   says "this specific stat, and being good elsewhere does not substitute".

   What lufel publishes is the **in-battle total**: base stat, weapon, Mindscape, Awareness
   and the cards, mains included — which totalStat() adds up from CHAR_STATS and
   MAIN_MAGNITUDE — plus My Palace and party buffs, which are not modelled, so every total
   here is a floor. breakpointRows scores that total against the published number, capped at
   what a perfect build on the same setup reaches. Only when a card that could carry the
   stat has no main magnitude (an unscanned non-5★ main) does it fall back to the cards'
   substats and 2-piece bonuses against a perfect build's, rather than report an undercount
   as fact. */
const BREAKPOINT_VALUE = 80;

/* Substat totals plus whatever the live 2-piece bonuses add, for several stats in one
   pass over the cards. The optimiser asks for four or five stats at a time inside its
   refinement loop, and walking the loadout once per stat was the whole of its cost. */
function supplyOf(cards, char, stats) {
  const out = {};
  stats.forEach(s => out[s] = 0);
  const counts = {};
  (cards || []).forEach(c => {
    if (!c) return;
    (c.subs || []).forEach(s => { if (out[s.stat] !== undefined) out[s.stat] += s.value; });
    if (c.slot !== 'Space') counts[c.set] = (counts[c.set] || 0) + 1;
  });
  Object.keys(counts).forEach(set => {
    if (counts[set] < 2) return;
    const S = SETS[set];
    if (!S || !S.bonus2) return;
    if (S.elem && S.elem !== char.e) return;     // off-element 2-pieces grant nothing
    const parts = bonus2Parts(S);
    for (let i = 0; i < parts.length; i++) if (out[parts[i].stat] !== undefined) out[parts[i].stat] += parts[i].amt;
  });
  return out;
}
function statSupply(cards, char, stat) { return supplyOf(cards, char, [stat])[stat]; }

/* ---- the rest of the character ---------------------------------------------------
   A target is an in-battle total, so the cards are only ever part of the answer. What
   the character brings on their own — level, ascension, weapon, Mindscape — moves the
   bar enough to change the build completely: Kumi Katayama needs 180 Speed, and that is
   73 Speed from cards on a 4-star weapon at A0 with no Mindscape, or 14 on a 5-star R7
   at A7 with it. CHAR_STATS carries all of that; `loadout` says which of it applies.

   Level and Ascension are not user-editable — every character is assumed Level 80,
   Ascension 7 (Ascension 6 plus Awakening), since that is the only level-80 configuration
   the game allows and an under-levelled account is not a build worth optimising for. An
   A0 default here once read as 1986 ATK for a real 2733 zero-card Kasumi; the account
   that number described does not exist. `charLoadout` forces both fields regardless of
   what a loaded save file carries, so there is no path back to a lower value.

   `awareness` (0-6) is a fourth, separate progression axis lufel's site calls
   "Awareness" (its own data field is named `ritual`) — a ladder of named passives
   unlocked with Cognitite, distinct from Ascension, Mindscape and the Awakening-7
   bonus already modelled above. It defaults to 0 rather than maxed like Ascension
   and weapon do, the same reasoning as `mind1`/`mind2` below: it is a per-character
   grind, not something a well-progressed account has finished on everyone. It does
   move HP/ATK/DEF — see AWARENESS_STAT_PCT below, a universal 102-115% curve
   confirmed in-game — even though the named ability at a given level almost never
   does; see CHAR_STATS' `awareness` field and charBaseStat for that half.

   Mindscape is actually 4 paths, not one lock. Two (`cs.mind[0]`/`cs.mind[1]`, lufel's
   own `mind_stats1`/`mind_stats2`) grant a flat/percent stat that scales linearly over
   5 levels — `mind1`/`mind2` here, each 0-5, confirmed by the user against real play;
   lufel only ever publishes the level-5 (max) value, so `charBaseStat` scales it by
   `level / 5`. The other two paths raise a skill's level cap instead of granting a
   stat — unrelated to `cs.mind`'s stat nodes — and are modelled as the single
   `mindSkill` toggle that drives pickTier's "+5" tier bump, same as the old unified
   `mind` boolean did. */
const DEFAULT_LOADOUT = { level: 80, asc: 7, weapon: '5', refine: 1, mindSkill: false, mind1: 0, mind2: 0, awareness: 0 };
/* `refine` is 1-7, an index into a weapon's seven-step ladder. The game counts refinements from
   0 (a weapon with no extra copies is R0), so the label is one lower than the value; saves and
   the ladders keep the 1-7 index. */
function refineLabel(r) { return 'R' + (Math.max(1, Math.min(7, +r || 1)) - 1); }

/* A character whose Setup was never saved is scored on DEFAULT_LOADOUT, and nothing said so:
   on the real inventory (Sep 2026) that was 21 of the 36 active characters. The default's one
   generous assumption is the 5★ signature weapon (Kumi's grants +15-30 Speed where her 4★
   grants none); Mindscape off and Awareness 0 err the other way. The Roster, the Loadout
   popup and Optimise say which characters rest on it. */
function setupIsDefault(name) { return !(state.chars[name] && state.chars[name].loadout); }
const DEFAULT_SETUP_NOTE = 'Scored on the default Setup — the 5★ weapon at refinement 1, no Mindscape, Awareness 0 — because none was ever saved for this character. The weapon alone can move a stat target a long way.';

function charLoadout(name) {
  const saved = state.chars[name] && state.chars[name].loadout;
  const L = Object.assign({}, DEFAULT_LOADOUT, saved || {});
  // Back-compat: files saved before Mindscape had per-level stat paths stored a single
  // `mind` boolean covering all 4 paths at once. Map it forward rather than losing it —
  // "unlocked" becomes both stat paths maxed and the skill paths done, "locked" is all-zero.
  if (saved && typeof saved.mind === 'boolean' && saved.mind1 == null && saved.mind2 == null && saved.mindSkill == null) {
    L.mindSkill = saved.mind; L.mind1 = saved.mind ? 5 : 0; L.mind2 = saved.mind ? 5 : 0;
  }
  delete L.mind;
  // Level and Ascension are not editable — see the comment above DEFAULT_LOADOUT — so
  // force them here rather than trusting a saved value that predates this being locked down.
  L.level = 80;
  L.asc = 7;
  return L;
}

/* Base HP/ATK/DEF at a level and ascension rank. lufel publishes A0 and A6 per level and
   its own steps between them are near-even, so ranks in between are interpolated — the
   error is under half a point, orders of magnitude below the My Palace contribution that
   nothing here models anyway. */
function baseTriple(cs, lo) {
  // lufel publishes Lv100 figures for only 15 of the 68 characters. For the rest a
  // Lv100 request falls back to the Lv80 table rather than dropping the base stat
  // entirely — an undercount, but a stated one; `approx` carries it to the UI.
  const want100 = lo.level >= 100;
  const approx = want100 && !cs.l100;
  const lo0 = (want100 && cs.l100) ? cs.l100 : cs.l80;
  const lo6 = (want100 && cs.l100a6) ? cs.l100a6 : cs.l80a6;
  if (!lo0) return null;
  const f = Math.max(0, Math.min(6, lo.asc)) / 6;
  const v = lo6 ? lo0.map((x, i) => x + (lo6[i] - x) * f) : lo0.slice();
  v.approx = approx;
  return v;
}

/* Every character's Awareness screen carries the same universal HP/ATK/DEF growth
   curve as levels are unlocked, confirmed against the in-game screen (Makoto Niijima
   [Queen]): 102/105/107/110/112/115% of base at levels 1-6, identical for all three
   stats and, per the user, the same for every character — unlike Awakening-7's `aw`,
   which differs per character and per stat. Index 0 (no Awareness unlocked) is the
   100% baseline, i.e. +0. This is a separate mechanic from the named ability ladder in
   CHAR_STATS' `awareness` array (which is almost never a stat at all, see above) — the
   percentage here applies unconditionally at every level regardless of what that
   level's ability text says. It adds into the same `pct` accumulator as Awakening-7's
   own attack_per/defense_per/hp_per rather than compounding as a separate stage, since
   lufel's damage-calc article states stats in the same group add rather than multiply
   (docs/DATA-SOURCES.md). */
const AWARENESS_STAT_PCT = [0, 2, 5, 7, 10, 12, 15];

/* Conditional kit lines judged to be effectively always on in the character's real
   rotation, counted into their in-battle totals and the damage baseline. The general rule
   stands — only an unconditional weapon or Awareness line is parsed from lufel (see
   CHAR_STATS' `b` vs `extra`) — and this is the hand-kept exception list, one entry per
   line with the reason, gated the same way the rest of the setup is: an Awareness node
   counts only when the character's Awareness level is at or above it (`aw`), a weapon
   line only while that weapon is held (`weapon`, at the current refine step of its
   `ladder`), and `stacks` multiplies a per-stack effect by the stacks assumed held. Anything
   not gated is a kit passive or a rotation skill that is simply always active.

   What earns an entry, judged kit by kit against lufel's skill text (Sep 2026):
   - a self buff (or a party buff that includes the character) with a duration of 2+ turns
     that is refreshed by something the character does every turn or every other turn;
   - a stack or mode the kit is built around and reaches within its first turns, counted at
     the stack level the kit sustains (the number is in the reason), never at a cap it
     rarely holds;
   - "permanently" and "at the start of battle ... for the battle" lines.
   What does not: one-turn or next-skill buffs, Highlight-gated lines, anything conditional
   on the character's HP, the team's elements or a specific ally, skill-specific multipliers
   ("increase this skill's damage"), and stat CONVERSIONS ("Attack +1% per 2 Speed") — those
   scale with a stat the cards move and are already why that stat is the character's top
   weight, so pricing them here would count them twice. Skill-level ladders take the
   first (LV10) value.

   Stat vocabulary: 'Damage Multiplier' is any "increase damage / damage dealt" that applies
   to all of the character's damage (ⓑ), 'Resistance Pierce' is "pierce rate". */
const KIT_STAT_BUFFS = {
  'Ann Takamaki': [
    { s: 'ATK%', v: 20, pct: true, why: 'Crimson Rose: +20% ATK for 2 turns; it is in every rotation' }
  ],
  'Ryuji Sakamoto': [
    { s: 'ATK%', v: 45, pct: true, why: 'Adrenaline: +45% ATK while the target has more HP than Ryuji, i.e. against any boss' },
    { s: 'ATK%', v: 10, pct: true, aw: 0, why: 'Wounded Glory: at least +10% ATK from missing HP at any HP' }
  ],
  'Haruna Nishimori': [
    { s: 'ATK%', v: 20, pct: true, aw: 1, why: "Let's Go, Everyone!: +20% ATK whenever an ally deals skill damage" }
  ],
  'Leo Kamiyama': [
    { s: 'ATK%', v: 25, pct: true, aw: 2, why: 'Undying Justice: +25% ATK after using a skill on an ally, which is every turn' }
  ],
  'Seiji Shiratori': [
    { s: 'ATK%', v: 7, pct: true, stacks: 3, aw: 0, why: 'Attaque au Fer: +7% ATK per Right to Strike stack, held at 3' },
    { s: 'Speed', v: 4, pct: false, stacks: 3, aw: 0, why: 'Attaque au Fer: +4 Speed per Right to Strike stack, held at 3' },
    { s: 'Crit Rate', v: 4, pct: true, stacks: 3, aw: 1, why: 'Pression: +4% crit rate per Right to Strike stack, held at 3' },
    { s: 'Crit Multiplier', v: 12, pct: true, weapon: '5', why: 'Venus Sunrise: +12% crit damage from the start of battle' }
  ],
  'Miyu Sahara': [
    { s: 'DEF%', v: 40, pct: true, aw: 0, why: 'Guardian of the Sea: +16% DEF at 2 and +24% at 6 Seashell stacks (Lv70), which her shields keep up' },
    { s: 'ATK%', v: 16, pct: true, aw: 0, why: 'Guardian of the Sea: +16% ATK at 4 Seashell stacks (Lv70)' }
  ],
  'Ren Amamiya': [
    { s: 'ATK%', v: 50, pct: true, aw: 2, why: 'Meditate: +50% ATK while SP is above 60%, his normal state' }
  ],
  'YUI': [
    { s: 'ATK%', tiers: [39, 43, 41.4, 45.4], pct: true, why: 'Sparky Surprise: +39% ATK for 2 turns; it is used every other turn to keep Player 2 up' },
    { s: 'ATK%', v: 12, pct: true, why: "Let's Go Together: +12% ATK while an ally has Player 2" },
    { s: 'Crit Rate', v: 12, pct: true, why: "Let's Go Together: +12% crit rate while an ally has Player 2" },
    { s: 'Crit Rate', v: 20, pct: true, aw: 1, why: 'Payappa: +20% crit rate on follow-up attacks, which are her damage' }
  ],
  'Yusuke Kitagawa': [
    { s: 'Damage Multiplier', v: 7.5, pct: true, stacks: 4, why: "Painter's Focus: +7.5% damage per shield gained (2 turns, up to 6); Keen Eye and Inspiration keep about 4 up" },
    { s: 'Resistance Pierce', v: 20, pct: true, why: "Artist's Intuition: +20% pierce for a turn each time a skill grants a shield; Keen Eye does every other turn" }
  ],
  'Makoto Niijima': [
    { s: 'ATK%', tiers: [48.8, 53.8, 51.8, 56.8], pct: true, why: "President's Prowess: +48.8% ATK for 2 turns; used every other turn" },
    { s: 'ATK%', v: 50, pct: true, aw: 1, why: 'Execution of Justice: +50% ATK while Crash Out is active, which 5 starting Tenacity stacks make her normal state' },
    { s: 'Damage Multiplier', v: 35, pct: true, aw: 1, why: 'Execution of Justice: +35% damage while Crash Out is active' }
  ],
  'Chizuko Nagao': [
    { s: 'Ailment Accuracy', v: 10, pct: true, stacks: 3, aw: 2, why: "From Now On: +10% ailment accuracy for 2 turns per ally elemental ailment, 3 stacks; lufel's own target note counts it" }
  ],
  'Ayaka Sakai': [
    { s: 'ATK%', v: 40, pct: true, aw: 0, why: 'Opening Act: +20% ATK per Catchy Hook for the battle, up to 40%' },
    { s: 'ATK%', pct: true, weapon: '4', ladder: [28, 36, 36, 44, 44, 52, 52], why: "Rock 'n' Roller: +ATK for 2 turns after Catchy Hook, her every-turn skill" }
  ],
  'Motoha Arai [Tropical]': [
    { s: 'Crit Rate', tiers: [9.8, 9.8, 10.4, 10.4], pct: true, why: "Surf 'n' Shine: Summer Hype +9.8% crit rate, the state her rotation keeps up" },
    { s: 'Damage Multiplier', tiers: [29.3, 29.3, 31.1, 31.1], pct: true, why: "Surf 'n' Shine: Summer Hype +29.3% damage" },
    { s: 'Crit Rate', v: 10, pct: true, aw: 1, why: 'Exciting Summer!: +10% crit rate while Summer Hype is active' },
    { s: 'Crit Multiplier', v: 25, pct: true, aw: 1, why: 'Exciting Summer!: +25% crit damage while Summer Hype is active' },
    { s: 'HP', v: 1200, pct: false, aw: 2, why: 'Stay Cool!: +1200 max HP during battle' },
    { s: 'Crit Multiplier', pct: true, weapon: '5', ladder: [26, 34, 34, 42, 42, 50, 50], why: 'Colorful Coast: +crit damage while Summer Hype is active' }
  ],
  'Tomoko Noge [Seaside]': [
    { s: 'Crit Rate', v: 35, pct: true, aw: 6, why: 'Heartfelt Days: +35% crit rate on Summer Reminiscence damage, which is all the damage she deals' }
  ],
  /* Ripper mode's +21% pierce is left out: Nightfall holds that mode for the rest of one
     turn, so it is the exception in his rotation, where Doctor mode is the default. */
  'Kira Kitazato': [
    { s: 'Ailment Accuracy', v: 36, pct: true, why: 'Drawn Blade: +36% ailment accuracy in Doctor mode — the mode he starts in, returns to at the end of every Ripper turn, and deals Bleed damage in' },
    { s: 'Ailment Accuracy', v: 15, pct: true, weapon: '5', why: "Bloodletter: +15% ailment accuracy, unconditional — the weapon parser keeps one stat line and took the ATK ladder" },
    { s: 'Damage Multiplier', pct: true, weapon: '5', ladder: [25, 32.5, 32.5, 40, 40, 47.5, 47.5], why: 'Bloodletter: +damage to foes with Bleed, which his Doctor-mode hits keep on the target' },
    { s: 'ATK%', pct: true, weapon: '4', ladder: [1.8, 2.4, 2.4, 3, 3, 3.6, 3.6], stacks: 10, why: 'Undying Embers: permanent +ATK per Bleed inflicted, 10 stacks — a 70% chance on every Doctor-mode hit, so the cap comes in the first turns' }
  ],
  'Masaki Ashiya': [
    { s: 'DEF%', v: 24, pct: true, why: "Flower Knight's Shield: +24% DEF while shielded by his own Knight's Protection, granted to all allies at battle start" },
    { s: 'Resistance Pierce', v: 20, pct: true, aw: 1, why: 'Floriography: Freesia: party +20% pierce' },
    { s: 'DEF%', v: 15, pct: true, aw: 2, why: "Floriography: Gerbera: +15% DEF per Knight's Protection shield, counted at 1" },
    { s: 'Damage Multiplier', v: 15, pct: true, aw: 2, why: "Floriography: Gerbera: +15% damage per Knight's Protection shield, counted at 1" },
    { s: 'Crit Multiplier', v: 10, pct: true, aw: 2, why: "Floriography: Gerbera: +10% crit damage per Knight's Protection shield, counted at 1" },
    { s: 'Crit Rate', v: 15, pct: true, aw: 6, why: 'True-Hearted Friendship: Poise, party +15% crit rate' }
  ],
  'Haru Okumura': [
    { s: 'Ailment Accuracy', v: 18, pct: true, why: 'Helping Others: +18% ailment accuracy at 1 Area to Improve stack' },
    { s: 'ATK%', v: 18, pct: true, why: 'Helping Others: +18% ATK at 2 Area to Improve stacks' },
    { s: 'Crit Multiplier', v: 18, pct: true, why: 'Helping Others: +18% crit damage at 3 Area to Improve stacks' },
    { s: 'ATK%', v: 25, pct: true, aw: 0, why: 'My Name Is Beauty Thief: +25% ATK at 2+ Thoughtful Round stacks' },
    { s: 'ATK%', v: 24, pct: true, aw: 1, why: 'Expressing Emotions: +8% ATK per Target Audience stack, at 3' },
    { s: 'Crit Rate', v: 18, pct: true, aw: 1, why: 'Expressing Emotions: +6% ranged crit rate per Target Audience stack, at 3; all her attacks are ranged' },
    { s: 'Damage Multiplier', v: 60, pct: true, aw: 2, why: 'Unwavering Faith: +60% Psy damage at 3+ Target Audience stacks' },
    { s: 'Damage Multiplier', pct: true, weapon: '5', ladder: [24, 31, 31, 38, 38, 45, 45], why: 'Last Quarter: +Psy damage while she has Target Audience' }
  ],
  'Kotone Montagne [Frostgale]': [
    { s: 'ATK%', v: 5, pct: true, stacks: 7, aw: 0, why: 'Swan on the Ice: permanent +5% ATK per Vestige stack gained, up to 7, reached in the first turns' }
  ],
  'Runa Dogenzaka': [
    { s: 'ATK%', v: 33, pct: true, why: 'Faithful Dog: +33% ATK for a turn when a skill inflicts a debuff, which every skill of hers does' },
    { s: 'Ailment Accuracy', pct: true, weapon: '5', ladder: [23, 28, 28, 33, 33, 38, 38], why: 'Cerberus Claws: +ailment accuracy for 2 turns whenever an ally uses an elemental skill' }
  ],
  'Riko Tanemura [Tempest]': [
    { s: 'SP Recovery', v: 60, pct: true, aw: 0, why: 'Fragrant Gale: +60% SP Recovery, unconditional but written in the same sentence as the max-SP change' }
  ],
  'Mio Natsukawa': [
    { s: 'ATK%', v: 20, pct: true, aw: 2, why: 'Frozen Gateway: party +20% ATK for 2 turns whenever Extinguish stacks are spent, which her rotation does' },
    { s: 'DEF%', v: 30, pct: true, aw: 2, why: 'Frozen Gateway: party +30% DEF for 2 turns' },
    { s: 'Damage Multiplier', v: 15, pct: true, aw: 2, why: 'Frozen Gateway: party +15% damage for 2 turns' }
  ],
  'Yaoling Li [Firecracker]': [
    { s: 'Crit Rate', v: 10, pct: true, why: 'Scarlet Surprise: +10% crit rate for 2 turns, in every rotation (permanent at Awareness 6)' },
    { s: 'Damage Multiplier', tiers: [34.3, 37.8, 36.4, 39.9], pct: true, why: 'Orange Blossom Blade: Flaming Sword Dance +34.3% damage, the state she fights in' },
    { s: 'Damage Multiplier', v: 36, pct: true, why: 'Prosperity in Red: +36% damage to Burning foes; her kit burns everything it hits' },
    { s: 'ATK%', v: 42, pct: true, why: 'Happy New Year!: +42% ATK from the start of battle, extended by every Fire Technical' },
    { s: 'Crit Rate', v: 10, pct: true, aw: 2, why: 'Festival Colors: +10% crit rate while a foe is Burning' },
    { s: 'Crit Rate', pct: true, weapon: '5', ladder: [16, 21, 21, 26, 26, 31, 31], why: "New Year's Light: +crit rate while Flaming Sword Dance is active" }
  ],
  'Kasumi Yoshizawa': [
    { s: 'ATK%', tiers: [32.4, 35.7, 34.4, 37.7], pct: true, why: 'Invitation: +32.4% ATK for 3 turns, used every rotation' },
    { s: 'Damage Multiplier', v: 15, pct: true, stacks: 3, why: 'Rhythm Count: +15% Bless damage per Step stack, at 3' },
    { s: 'ATK%', v: 10, pct: true, stacks: 3, aw: 0, why: 'Masked Ball: +10% ATK per Step gained in Masquerade, at 3' },
    { s: 'Crit Rate', v: 4, pct: true, stacks: 3, aw: 0, why: 'Masked Ball: +4% crit rate per Step gained in Masquerade, at 3' },
    { s: 'Crit Rate', v: 15, pct: true, aw: 1, why: 'Charming Invite: +15% crit rate for 3 turns when using Invitation' },
    { s: 'ATK%', v: 33, pct: true, aw: 2, why: 'Blossoming Dance Floor: +33% ATK with 2 Step stacks' },
    { s: 'Crit Multiplier', v: 33, pct: true, aw: 2, why: 'Blossoming Dance Floor: +33% crit damage with 3+ Step stacks' },
    { s: 'Damage Multiplier', pct: true, weapon: '4', ladder: [24, 31, 31, 38, 38, 45, 45], why: 'Divine Sword of Sinai: +damage with 2+ Step stacks' },
    { s: 'ATK%', pct: true, weapon: '5', ladder: [21, 27, 27, 33, 33, 39, 39], why: 'Royal Étoile: +ATK for 2 turns whenever a Step stack is gained' }
  ],
  'Goro Akechi': [
    { s: 'Crit Rate', v: 16, pct: true, aw: 1, why: 'Detective Profile: +16% crit rate while Deduction and Stratagem are both active, his normal loop' },
    { s: 'ATK%', v: 25, pct: true, aw: 2, why: 'Detective Advice: +25% ATK when alternating skill attributes, which his Almighty kit does by design' },
    { s: 'Crit Multiplier', v: 30, pct: true, aw: 2, why: 'Detective Advice: +30% crit damage when alternating skill attributes' },
    { s: 'ATK%', pct: true, weapon: '5', ladder: [21, 27.3, 27.3, 33.7, 33.7, 40, 40], why: 'Gordian Kopis: party +ATK for 2 turns on entering Deduction or Stratagem' },
    { s: 'Crit Multiplier', pct: true, weapon: '5', ladder: [15, 19.5, 19.5, 24, 24, 28.5, 28.5], why: 'Gordian Kopis: +crit damage for 2 turns whenever a Mastermind ally acts' }
  ],
  'Manaka Nagao': [
    { s: 'ATK%', pct: true, weapon: '4', ladder: [11, 14.5, 14.5, 18, 18, 21.5, 21.5], why: 'Divine Muse: permanent +ATK after using a skill' },
    { s: 'Damage Multiplier', pct: true, weapon: '5', stacks: 12, ladder: [0.7, 0.9, 0.9, 1.1, 1.1, 1.3, 1.3], why: "Angel's Hymn: Angelic Chorus, permanent +damage per stack, at the 12-stack cap" },
    { s: 'Crit Multiplier', pct: true, weapon: '5', ladder: [15.3, 19.9, 19.9, 24.5, 24.5, 29.1, 29.1], why: "Angel's Hymn: +crit damage at 12 Angelic Chorus stacks" }
  ],
  'Shoki Ikenami': [
    { s: 'ATK%', pct: true, weapon: '5', stacks: 2, ladder: [14, 18, 18, 22, 22, 26, 26], why: 'Ribalta: permanent +ATK per Improv state used, counted at 2' }
  ],
  'Makoto Yuki': [
    { s: 'ATK%', tiers: [19.5, 21.5, 20.7, 22.7], pct: true, why: 'Nocturne of Battle: +19.5% ATK for 2 turns, used every other turn' },
    { s: 'Resistance Pierce', v: 12, pct: true, aw: 0, why: 'Pathfinder: +12% pierce while he has Moon Phase (Lv70), which ally buffs grant every turn' },
    { s: 'Crit Rate', pct: true, weapon: '5', ladder: [16.3, 21.2, 21.2, 26.1, 26.1, 31, 31], why: 'Deus Xiphos: +crit rate for 2 turns per 3 Moon Phase stacks gained; ally buffs feed a stack a turn' }
  ],
  'Akihiko Sanada': [
    { s: 'Crit Rate', v: 20, pct: true, aw: 1, why: 'Boxing Team Captain: +20% crit rate when gaining Grit; every skill gains Grit' },
    { s: 'Crit Rate', pct: true, weapon: '5', stacks: 2, ladder: [8.2, 10.7, 10.7, 13.2, 13.2, 15.7, 15.7],
      why: 'Sabazios: crit rate per Mettle stack gained, 2 stacks, refreshed every action' },
    { s: 'ATK%', v: 13.5, pct: true, stacks: 3, why: 'Rough Combo: +13.5% ATK per critical for 3 turns, up to 3; at his crit rate all three are up' },
    { s: 'Resistance Pierce', v: 4, pct: true, stacks: 3, aw: 0, why: 'Reason to Fight: Grit +4% pierce per stack, held at 3' },
    { s: 'Damage Multiplier', v: 30, pct: true, aw: 2, why: 'Guardian Fist: +30% damage for 3 turns after Flash Blow, which fires every 3 turns' },
    { s: 'ATK%', pct: true, weapon: '4', ladder: [22, 29, 29, 36, 36, 43, 43], why: 'Wicked Cestus: +ATK while Grit is at 2+ stacks' }
  ],
  /* Hatsune Miku had Light Up Your World's "Increase party's critical damage by 18.1%" here.
     Her own stat screen does not carry it: in battle it reads Crit Mult 60.5, which is her
     cards' 58.3 plus the Thieves Den's 2 (the user's panels, 26 Sep 2026). It is a party
     buff, not a stat of hers, so it is not listed. */
  'Miyu Sahara [Wavecatcher]': [
    { s: 'Damage Multiplier', v: 30, pct: true, why: 'Ride it Out!: +30% damage while Surf is active, the state her rotation keeps' },
    { s: 'ATK%', v: 25, pct: true, aw: 0, why: 'Surfing Mermaid: +25% ATK at 100 SP recovered, reached in the first turns' },
    { s: 'Damage Multiplier', v: 25, pct: true, aw: 0, why: 'Surfing Mermaid: +25% damage at 200 SP recovered' },
    { s: 'Crit Rate', v: 12, pct: true, aw: 0, why: 'Surfing Mermaid: +12% crit rate at 300 SP recovered' },
    { s: 'Crit Multiplier', v: 24, pct: true, aw: 0, why: 'Surfing Mermaid: +24% crit damage at 400 SP recovered' },
    { s: 'Crit Multiplier', v: 20, pct: true, aw: 2, why: 'Roaring Surf Line: +20% crit damage while Surf is active' },
    { s: 'ATK%', pct: true, weapon: '4', ladder: [22, 29, 29, 36, 36, 43, 43], why: 'Jellie Voyager: +ATK while Surf is active' },
    { s: 'Damage Multiplier', pct: true, weapon: '5', ladder: [6.8, 8.8, 8.8, 10.8, 10.8, 12.8, 12.8], why: 'Mermaid Dreamer: +damage when spending SP on a skill or Resonance, i.e. every action' }
  ],
  'Ichigo Shikano': [
    { s: 'ATK%', v: 15, pct: true, stacks: 3, why: 'Overflowing Love: +15% ATK per Chains of Love stack, held at 3' },
    { s: 'Crit Rate', v: 15, pct: true, aw: 0, why: 'Mine Alone: +15% crit rate at 2 Chains of Love stacks' },
    { s: 'Crit Multiplier', v: 36, pct: true, aw: 2, why: 'Power of Love: +36% crit damage at 4 Chains of Love stacks (cap raised to 5)' },
    { s: 'Damage Multiplier', pct: true, weapon: '5', ladder: [34, 44, 44, 54, 54, 64, 64], why: 'My Destiny: +damage at 3 Chains of Love stacks' }
  ],
  'Kumi Katayama': [
    { s: 'ATK%', v: 10, pct: true, stacks: 3, aw: 2, why: 'Role Model: permanent party +10% ATK, stacks to 3 over the first turns' },
    { s: 'ATK%', v: 50, pct: true, aw: 6, why: 'Unconditional Love: +50% ATK' },
    { s: 'Crit Rate', v: 10, pct: true, aw: 6, why: 'Unconditional Love: +10% crit rate' },
    { s: 'Crit Multiplier', v: 30, pct: true, aw: 6, why: 'Unconditional Love: +30% crit damage' },
    { s: 'Crit Rate', pct: true, weapon: '5', ladder: [9, 11.7, 11.7, 14.3, 14.3, 17, 17], why: 'Lightning Riders: +crit rate for 2 turns after Lightning Legs, her every-other-turn skill' }
  ],
  'YUI [Prism]': [
    { s: 'ATK%', tiers: [19.5, 21.5, 20.7, 22.7], pct: true, why: 'Veggie Knights, Go!: +19.5% ATK, kept up by the rotation (KR text; lufel EN and JP read +29.3%)' },
    { s: 'Crit Rate', tiers: [11.7, 12.9, 12.4, 13.6], pct: true, why: 'Veggie Knights, Go!: +11.7% crit rate' },
    { s: 'Damage Multiplier', v: 8.1, pct: true, stacks: 4, why: 'Veggie Satellite: +8.1% damage per Veggie Knight, at the 4 she summons' },
    { s: 'Crit Multiplier', v: 8, pct: true, stacks: 5, aw: 1, why: 'Veggie Knight Rounds: +8% crit damage per Veggie Knight, at 5 (4 summoned at battle start plus one more)' }
  ],
  'Kotone Shiomi': [
    { s: 'ATK%', pct: true, weapon: '4', stacks: 3, ladder: [7.3, 9.6, 9.6, 11.9, 11.9, 14.2, 14.2], why: 'Ame-no-Nuboko: +ATK for 3 turns after granting a buff, held at 3; every skill she casts grants one' }
  ],
  'Mitsuru Kirijo': [
    { s: 'ATK%', v: 7, pct: true, stacks: 5, aw: 0, why: "President's Duty: +7% ATK per Frost stack on the target when attacking it, at 5" }
  ],
  'Shoki Ikenami [Notte]': [
    { s: 'Crit Multiplier', tiers: [48.8, 53.8, 51.8, 56.8], pct: true, why: "Spada dell'Alba: +48.8% crit damage for 2 turns, used every other turn" },
    { s: 'Damage Multiplier', tiers: [9.8, 10.8, 10.4, 11.4], pct: true, why: "Giuramento Incrollabile: Night's Contract +9.8% damage, his shield-skill state" },
    { s: 'ATK%', v: 6, pct: true, stacks: 5, why: "Grace: +6% ATK per Night's Blessing stack, held at 5" },
    { s: 'Resistance Pierce', v: 15, pct: true, why: 'Nirvana: up to +15% pierce at 40% HP; the kit is played at low HP by design' },
    { s: 'Crit Rate', v: 5, pct: true, stacks: 3, aw: 1, why: "Shooting Star's Guidance: +5% crit rate per Night's Contract gained, 3 stacks" },
    { s: 'Damage Multiplier', v: 30, pct: true, aw: 6, why: "Illuminating Passion for Life: Night's Monarch +30% damage while HP is negative" },
    { s: 'Crit Multiplier', v: 30, pct: true, aw: 6, why: "Illuminating Passion for Life: Night's Monarch +30% crit damage while HP is negative" }
  ],
  'Shun Kano [Pioneer]': [
    { s: 'Crit Multiplier', v: 30, pct: true, aw: 1, why: 'Generous Support: party +30% crit damage while an ally has Sheriff Badge, his every-turn skill' }
  ],
  'Junpei Iori': [
    { s: 'Damage Multiplier', v: 20, pct: true, aw: 0, why: 'Wannabe Hero: party +20% Fire damage at 10 Competitive Heart stacks, reached early' },
    { s: 'Crit Multiplier', v: 20, pct: true, aw: 1, why: 'Mood Maker: party +20% crit damage at 25 Competitive Heart stacks' }
  ],
  'Narumi Nashimoto': [
    { s: 'Crit Rate', tiers: [14.6, 16.1, 15.5, 17.0], pct: true, why: '100% Sugar: Idol Business +14.6% crit rate, the 2-turn mode her rotation re-enters' },
    { s: 'Damage Multiplier', tiers: [29.3, 32.3, 31.1, 34.1], pct: true, why: '100% Sugar: Idol Business +29.3% damage' },
    { s: 'Crit Multiplier', pct: true, weapon: '5', ladder: [32.8, 42.8, 42.8, 52.8, 52.8, 62.8, 62.8], why: 'Sugar Encore: +crit damage for 2 turns when gaining Naruru' },
    { s: 'Damage Multiplier', pct: true, weapon: '4', ladder: [8.8, 10.2, 10.2, 11.6, 11.6, 13, 13], why: 'Shining Rhythm: +damage for 2 turns when gaining Shiny Points' }
  ],
  'Koromaru': [
    { s: 'ATK%', v: 15, pct: true, aw: 0, why: "City's Top Dog: Loyal Howl, party +15% ATK after his Attribute Downgrade" },
    { s: 'Damage Multiplier', v: 15, pct: true, aw: 0, why: "City's Top Dog: Loyal Howl, party +15% damage" },
    { s: 'Crit Multiplier', v: 25, pct: true, aw: 1, why: 'Woof!: permanent party +25% crit damage after his first Persona skill' },
    { s: 'ATK%', v: 60, pct: true, aw: 2, why: 'Lasting Wait: Loyal Howl +60% ATK more' },
    { s: 'DEF%', v: 30, pct: true, aw: 2, why: 'Lasting Wait: Loyal Howl +30% DEF' }
  ],
  'Motoha Arai [Radiance]': [
    { s: 'Resistance Pierce', v: 15, pct: true, why: 'Gilding: +15% pierce while Resolute Maiden is active, her damage state' },
    { s: 'ATK%', v: 42, pct: true, why: 'Unyielding: +42% ATK against foes with Flashover, which her kit applies' },
    { s: 'Crit Rate', v: 15, pct: true, aw: 1, why: 'Solar Procession: +15% crit rate while Resolute Maiden is active' }
  ],
  'Aigis': [
    { s: 'ATK%', tiers: [39, 43, 41.4, 45.4], pct: true, why: 'Gear Boost: +39% ATK, her buff skill' },
    { s: 'Resistance Pierce', tiers: [14.6, 16.1, 15.5, 17.0], pct: true, why: 'Gear Boost: +14.6% pierce' },
    { s: 'Damage Multiplier', v: 12, pct: true, why: 'Proof: +12% damage for 2 turns after a Theurgy; her kit auto-fires Theurgy' },
    { s: 'Crit Rate', v: 15, pct: true, aw: 1, why: 'Her Precious: permanent +15% crit rate after the first Gear Boost' },
    { s: 'Crit Multiplier', v: 30, pct: true, aw: 2, why: 'Full Power!: +30% crit damage while Orgia Mode is active' },
    { s: 'Damage Multiplier', v: 10, pct: true, aw: 4, why: 'Assigned Duty: +10% damage for 2 turns after a Theurgy' },
    { s: 'Crit Rate', pct: true, weapon: '5', ladder: [18.1, 23.5, 23.5, 28.9, 28.9, 34.3, 34.3], why: 'Pandemonium: +crit rate while Orgia Mode is active' },
    { s: 'Damage Multiplier', pct: true, weapon: '4', ladder: [8.8, 11.6, 11.6, 14.4, 14.4, 17.2, 17.2], why: 'Nucleus Rifle: +damage for 2 turns after Wild Barrage or Flash Strike, her every-turn skills' }
  ],
  'Ren Amamiya [Starlight]': [
    { s: 'ATK%', v: 42, pct: true, why: 'Upbeat: +42% ATK while in Phantom Form, his damage state' },
    { s: 'Crit Rate', v: 20, pct: true, aw: 1, why: 'Picaro: +20% crit rate after Fever Time' },
    { s: 'Damage Multiplier', pct: true, weapon: '4', ladder: [17.6, 23.2, 23.2, 28.8, 28.8, 34.4, 34.4], why: 'Baselard: +damage when spending Rhapsodic Beat, which his Coordinated Strike does' },
    { s: 'Damage Multiplier', pct: true, weapon: '5', ladder: [12, 15.6, 15.6, 19.2, 19.2, 22.8, 22.8], why: 'Jazz Blade: +All-Out Attack damage in Phantom Form; his Coordinated Strike counts as one' }
  ],
  'Morgana [Starlight]': [
    { s: 'ATK%', v: 17.6, pct: true, why: 'Roving Rave: permanent party +17.6% ATK on Wind damage (more at high ATK)' },
    { s: 'Crit Multiplier', v: 30, pct: true, aw: 1, why: 'Grand Entrance: permanent party +30% crit damage from his first turn' },
    { s: 'ATK%', pct: true, weapon: '5', ladder: [22.6, 29.4, 29.4, 36.2, 36.2, 43, 43], why: 'Candy Reveler: permanent party +ATK on entering Meowtor Charge' }
  ],
  'Ann Takamaki [Starlight]': [
    { s: 'Damage Multiplier', tiers: [15, 16.5, 16.8, 18.3], pct: true, why: 'Fever Step: +15% damage for 3 turns, in every rotation' },
    { s: 'Damage Multiplier', v: 10, pct: true, aw: 2, why: "Flickering Dance: Fever Step's damage buff +10%" },
    { s: 'ATK%', v: 42, pct: true, why: 'Ignite: +42% ATK for 3 turns on each Heat Score' },
    { s: 'Resistance Pierce', v: 15, pct: true, why: 'Flaming Finale: +15% pierce when activating Heat Score, her core loop' },
    { s: 'Damage Multiplier', pct: true, weapon: '5', stacks: 3, ladder: [8.5, 11, 11, 13.5, 13.5, 16, 16], why: 'Fatal Finish: permanent +damage per 100 SP gained; she gains 100 a turn, counted at 3' },
    { s: 'Crit Multiplier', pct: true, weapon: '5', stacks: 3, ladder: [16.4, 21.4, 21.4, 26.4, 26.4, 31.4, 31.4], why: 'Fatal Finish: permanent +crit damage per 100 SP spent, counted at 3' }
  ],
  'Ayaka Sakai [Summer]': [
    { s: 'Damage Multiplier', tiers: [39, 43, 41.4, 45.4], pct: true, why: 'Celestial Concerto: permanent +39% damage once Summer Starscape opens, her first cast' },
    { s: 'Crit Multiplier', pct: true, weapon: '5', ladder: [32.8, 42.8, 42.8, 52.8, 52.8, 62.8, 62.8], why: 'Ocean Echoes: permanent +crit damage once Summer Starscape opens' },
    { s: 'Crit Multiplier', v: 5, pct: true, stacks: 4, aw: 1, why: "That Day's Ocean Blue: +5% crit damage for 2 turns per Summer Starscape; it fires at the end of her turn and after the ally Highlight she drives each turn, so 4 are up" }
  ],
  'Ichigo Shikano [Summer]': [
    { s: 'Crit Rate', tiers: [14.6, 16.1, 15.5, 17], pct: true, why: "Heart's Desire: party +14.6% crit rate for 2 turns, her top skill on a 1-turn cooldown" }
  ]
};
/* The entries that apply to a given setup, with the value resolved. */
function kitStatBuffs(char, lo) {
  const L = lo || charLoadout(char.n);
  return (KIT_STAT_BUFFS[char.n] || []).filter(b =>
    (b.aw == null || (L.awareness || 0) >= b.aw) && (!b.weapon || L.weapon === b.weapon)
  ).map(b => Object.assign({}, b, {
    v: (b.ladder ? b.ladder[Math.max(1, Math.min(7, L.refine)) - 1] : b.tiers ? b.tiers[kitTierIndex(char, L)] : b.v) * (b.stacks || 1)
  }));
}
/* Which of a skill line's four printed values applies — lufel prints them LV10 / LV10+5 /
   LV12 / LV12+5, the same families pickTier() resolves for the stat targets, so the same
   rule is used: the higher family once the character's Awareness has unlocked the node
   that raises this kit's primary skill (3, or 5 for TARGET_TIER_AWARENESS_5), the +5
   variant when the Mindscape skill paths are done. */
function kitTierIndex(char, lo) {
  const L = lo || charLoadout(char.n);
  const high = (L.awareness || 0) >= (TARGET_TIER_AWARENESS_5.has(char.n) ? 5 : 3);
  return (high ? 2 : 0) + (L.mindSkill ? 1 : 0);
}

/* Everything that is not a revelation card, split into a flat part and a percent part.
   Percent stats (ATK%, DEF%, HP%) multiply the base; everything else is additive. */
const charBaseStatCache = {};
function charBaseStat(char, stat, lo) {
  const cs = CHAR_STATS[char.n];
  if (!cs) return null;
  const L = lo || charLoadout(char.n);
  /* Pure in (character, stat, setup), and now on the hot path: conversionBonus() asks for a
     source total inside damageFactors, which the optimiser and Triage call thousands of
     times per character. Memoised the same way damageBase is; callers only read the result. */
  const key = `${char.n}|${stat}|${L.level}|${L.asc}|${L.weapon}|${L.refine}|${L.mindSkill ? 1 : 0}|${L.mind1 || 0}|${L.mind2 || 0}|${L.awareness || 0}`;
  if (charBaseStatCache[key]) return charBaseStatCache[key];
  const r = charBaseStatUncached(char, cs, L, stat);
  charBaseStatCache[key] = r;
  return r;
}
function charBaseStatUncached(char, cs, L, stat) {
  const base = baseTriple(cs, L);
  const approx = !!(base && base.approx);
  const aw = (L.asc >= 7 && cs.aw) || {};
  let flat = 0, pct = 0;
  const add = b => {
    if (!b || b.s !== stat) return;
    if (b.pct) pct += b.v != null ? b.v : 0; else flat += b.v != null ? b.v : 0;
  };

  // the stat's own starting point
  if (stat === 'ATK' && base) flat += base[1];
  else if (stat === 'HP' && base) flat += base[0];
  else if (stat === 'DEF' && base) flat += base[2];
  else if (stat === 'Speed') flat += (aw.speed != null ? aw.speed : cs.spd);
  // Awakening 7 replaces the Crit Rate baseline outright, the way it replaces Speed and
  // SP Recovery, rather than adding to it. Lufel's own Hidden Ability tooltip spells this
  // out — "CRIT Rate 22.4% means base 5% plus an additional 17.4%" — the 22.4 it publishes
  // under `crit_rate` is the final total, confirmed against Akihiko Sanada's real in-game
  // panel reading higher Crit Rate than this tool reported before `aw.crit_rate` was read.
  else if (stat === 'Crit Rate') flat += (aw.crit_rate != null ? aw.crit_rate : cs.cr);
  else if (stat === 'Crit Multiplier') flat += cs.cm;
  // SP Recovery, Ailment Accuracy, Damage Multiplier and Resistance Pierce start at the
  // game's own baseline of 100%, 0%, 0% and 0% respectively. Awakening 7 replaces
  // the SP Recovery baseline outright the way it replaces Speed, rather than adding to
  // it: Miyu Sahara [Wavecatcher]'s `sp_recover: 188.5` read as an addition would put
  // her 188.5 above the baseline, and her real panel is 88.5 above it.
  else if (stat === 'SP Recovery') flat += (aw.sp_recover != null ? aw.sp_recover : 100);
  /* Ailment Accuracy reads 0% on the in-game stat screen with no cards (the user, 25 Sep
     2026). It was modelled at 100%, which put every total 100 high: Haru (target 150) and
     Shoki (target 100) met their targets with no cards, and their AA conversions sat at
     their caps before a single card was worn. At a 0 base the evidence lines up — Shoki's
     "+0.72% ATK per 1% AA, up to 72%" caps exactly at his target of 100, and Haru's "crit
     damage +20% per 50% AA, 3 stacks" at hers of 150. It also settles Awakening 7's
     `ailment_accuracy` (7 characters): against 0, a total and a bonus are the same number,
     so it is read here, as Speed's and SP Recovery's are. */
  else if (stat === 'Ailment Accuracy') flat += (aw.ailment_accuracy != null ? aw.ailment_accuracy : 0);

  /* Awakening 7 sometimes lands as a percentage of a base stat instead. The HP key is
     read under both spellings lufel uses — it ships `hp_per` on one character and
     `HP_per` on seven, and this used to look for `health_per`, which is neither, so
     every HP awakening on the roster was silently dropped. Two further keys lufel
     publishes — `crit_mult` (2 characters) and a lone `HP_recover` — are still not read,
     because lufel is not consistent about whether an awakening value is the stat's new
     total or the bonus on top: `crit_mult: 184.9` against a 150 baseline can only be a
     total. `speed`, `sp_recover` and `crit_rate` are read as totals because each was
     checked against a real in-game panel, and `ailment_accuracy` because its 0 baseline
     (checked on the panel too) makes the question moot. Do not read the rest until one
     is. */
  if (L.asc >= 7 && cs.aw) {
    if (stat === 'ATK' && cs.aw.attack_per) pct += cs.aw.attack_per;
    if (stat === 'DEF' && cs.aw.defense_per) pct += cs.aw.defense_per;
    if (stat === 'HP') pct += cs.aw.hp_per || cs.aw.HP_per || 0;
  }

  if (stat === 'ATK' || stat === 'HP' || stat === 'DEF')
    pct += AWARENESS_STAT_PCT[Math.max(0, Math.min(6, L.awareness || 0))];

  const w = L.weapon === '4' ? cs.w4 : L.weapon === '5' ? cs.w5 : null;
  if (w) {
    if (stat === 'ATK') flat += w.atk || 0;
    if (stat === 'HP') flat += w.hp || 0;
    if (stat === 'DEF') flat += w.def || 0;
    if (w.b) {
      const step = Math.max(1, Math.min(7, L.refine)) - 1;
      add({ s: w.b.s === 'ATK%' ? 'ATK' : w.b.s === 'DEF%' ? 'DEF' : w.b.s === 'HP%' ? 'HP' : w.b.s,
            v: w.b.r[step], pct: w.b.pct });
    }
  }
  // Each stat Mindscape path scales linearly from 0 at level 0 to lufel's published
  // (level-5, max) value at level 5 — confirmed by the user, since lufel only ever
  // publishes the maxed number. cs.mind[0] is path 1 (`mind1`), cs.mind[1] is path 2.
  (cs.mind || []).forEach((m, i) => {
    const lvl = Math.max(0, Math.min(5, (i === 0 ? L.mind1 : L.mind2) || 0));
    if (!lvl) return;
    add({ s: m.s === 'ATK%' ? 'ATK' : m.s === 'DEF%' ? 'DEF' : m.s === 'HP%' ? 'HP' : m.s,
          v: m.v * lvl / 5, pct: m.pct });
  });

  // The named ability ladder's own nodes, as opposed to the universal percentage above.
  // Levels at or below the one set under Setup are "unlocked". Almost every node is a
  // conditional kit passive (stacks, on-crit, on-Theurgy, a skill-level-up) — out of 455
  // levels read across the whole roster, none parsed as a bare unconditional stat line,
  // the same bar conditional weapon passives are held to. `s` is only ever present on a
  // node where one genuinely did, so this loop is a no-op today for everyone and picks
  // up automatically if a future patch adds one.
  (cs.awareness || []).forEach((node, i) => {
    if (i > (L.awareness || 0) || node.s == null) return;
    add({ s: node.s === 'ATK%' ? 'ATK' : node.s === 'DEF%' ? 'DEF' : node.s === 'HP%' ? 'HP' : node.s,
          v: node.v, pct: node.pct });
  });

  // Hand-judged always-on kit lines (KIT_STAT_BUFFS), gated on this setup's Awareness and weapon.
  kitStatBuffs(char, L).forEach(b =>
    add({ s: b.s === 'ATK%' ? 'ATK' : b.s === 'DEF%' ? 'DEF' : b.s === 'HP%' ? 'HP' : b.s, v: b.v, pct: b.pct }));

  return { flat, pct, approx };
}

/* What a main stat is worth, learned from the user's own inventory.

   No guide site publishes this, but the game prints it on every card panel, so once
   cards carry a scanned `mainValue` the answer is sitting in the inventory. A main
   stat is deterministic at a given slot/stat/rarity/level — it is not a random roll —
   so one scanned max-level card settles it for every card like it, and taking the
   largest observed value simply guards against an OCR undercount. Returns null when
   nothing has been scanned yet, and every caller treats that as "unknown", never 0. */
/* A card's main-stat magnitude: the scanned value if the OCR read one, else the measured
   5-star curve at the card's level, else whatever the inventory has taught us about
   that slot/stat (other rarities), else null — unknown, never zero. */
function mainMagnitudeFor(card, model) {
  if (card.mainValue != null && mainValueFitsLevel(card)) return card.mainValue;
  /* The damage model (`model`) prices every rarity on the 5-star curve — the same
     assumption cardScore's mainRolls() already makes — so it never has to consult the
     inventory; totalStat keeps the stricter rule, where an unscanned non-5-star main is
     unknown rather than assumed. */
  if (card.rarity === 5 || model) { const m = mainMagnitudeAt(card.main, card.level); if (m != null) return m; }
  return mainMagnitude(card.slot, card.main);
}
/* Best scanned max-level 5-star value per slot/stat. It walks the whole inventory, so the
   answer is memoised against the inventory array and its length — imports and loads replace
   or grow `state.cards`, which is what invalidates it. */
let mainMagnitudeMemo = { cards: null, len: -1, by: {} };
function mainMagnitude(slot, stat) {
  if (mainMagnitudeMemo.cards !== state.cards || mainMagnitudeMemo.len !== state.cards.length)
    mainMagnitudeMemo = { cards: state.cards, len: state.cards.length, by: {} };
  const key = slot + '|' + stat;
  if (key in mainMagnitudeMemo.by) return mainMagnitudeMemo.by[key];
  let best = null;
  for (const c of state.cards) {
    if (c.slot !== slot || c.main !== stat || c.mainValue == null) continue;
    if (c.rarity !== 5 || c.level < RARITY[5].maxLevel) continue;
    if (best == null || c.mainValue > best) best = c.mainValue;
  }
  return (mainMagnitudeMemo.by[key] = best);
}

/* A 4-piece's unconditional stat lines, counted in a character's totals while that 4-piece is
   worn — the rule a weapon's unconditional passive already follows. Until Sep 2026 no 4-piece
   line was counted anywhere, and a character screen showed the gap: Hatsune Miku's HP, ATK and
   DEF all carry her Labor 4-piece's +8% (ATK 4627 / HP 9358 / DEF 1790 on her screen, which the
   planner matches only with it). Only a set's plain stat clause is here; one that needs a turn,
   a trigger or an enemy state stays out, the same bar as KIT_STAT_BUFFS. `arch` is a wearer
   condition the set states. bonus4Value still prices the set as a whole; this is its stat line
   in the in-battle totals the stat targets read. */
const SET4_STATS = {
  Labor:          { arch: 'Navigator', stats: { 'HP%': 8, 'ATK%': 8, 'DEF%': 8 },
                    why: "When equipped by an Elucidator: all allies' HP, ATK and DEF +8%, the wearer's own screen included" },
  Reconciliation: { stats: { 'HP%': 15, 'ATK%': 15, 'DEF%': 15 }, why: 'During combat: HP, ATK and DEF +15%' },
  Strife:         { stats: { 'ATK%': 15 }, why: 'Attack +15%; the second +15% needs a Fire-weak enemy and is not counted' },
  Cruelty:        { stats: { 'ATK%': 15 }, why: 'Attack +15%; the crit damage needs Rhapsody Beat and is not counted' }
};
/* The stat lines of whichever 4-piece `cards` complete, for `char` — {} when none applies. A set
   off the character's element grants nothing, as bonus4Value has it. */
const NO_SET4_LINES = Object.freeze({});
function set4StatLines(cards, char) {
  // Called inside every stat total, so it only looks for the few sets that have a line, and
  // allocates nothing on the way.
  if (!cards || cards.length < 4) return NO_SET4_LINES;
  for (const set in SET4_STATS) {
    let k = 0;
    for (let i = 0; i < cards.length; i++) { const c = cards[i]; if (c && c.set === set && c.slot !== 'Space') k++; }
    if (k < 4) continue;
    const line = SET4_STATS[set], def = SETS[set];
    if ((line.arch && char.arch !== line.arch) || (def && def.elem && def.elem !== char.e)) return NO_SET4_LINES;
    return line.stats;
  }
  return NO_SET4_LINES;
}

/* What the equipped cards add to one target stat, in real game units. Substats and
   2-piece bonuses are exact, and so are a 4-piece's unconditional stat lines (SET4_STATS).
   The main stat is counted from the card's own scanned
   `mainValue`, or failing that from `mainMagnitude` — and when neither is available
   `mainsMissing` records it so the caller can fall back rather than under-report. */
function cardStatContribution(cards, char, stat, sub) {
  let flat = 0, pct = 0, mainsMissing = 0;
  const pctSub = { ATK: 'ATK%', HP: 'HP%', DEF: 'DEF%' }[stat] || null;
  (cards || []).forEach(c => {
    if (!c) return;
    (c.subs || []).forEach(s => {
      if (s.stat === stat) flat += s.value;
      else if (pctSub && s.stat === pctSub) pct += s.value;
    });
    // A Space card's main is the single string 'ATK + DEF' — one shared flat magnitude
    // that legitimately counts toward both stats (docs/SCHEMA.md), not a sum split
    // between them. It never matches `stat`/`pctSub` by equality, so it needs its own
    // clause here or it silently contributes nothing to either real total.
    const isSpaceMain = c.main === 'ATK + DEF' && (stat === 'ATK' || stat === 'DEF');
    if (c.main === stat || (pctSub && c.main === pctSub) || isSpaceMain) {
      const v = mainMagnitudeFor(c);
      if (v == null) mainsMissing++;
      else if (c.main === stat || isSpaceMain) flat += v; else pct += v;
    }
  });
  const bonus = statSupply(cards, char, sub || stat);
  // statSupply already counted the substats for `sub`; only the set part is new here
  const subOnly = (cards || []).reduce((s, c) =>
    s + ((c && c.subs) || []).reduce((t, x) => t + (x.stat === (sub || stat) ? x.value : 0), 0), 0);
  const setPart = bonus - subOnly;
  if (pctSub && (sub || stat) === pctSub) pct += setPart; else flat += setPart;
  const four = set4StatLines(cards, char);
  if (pctSub && four[pctSub]) pct += four[pctSub];
  else if (!pctSub && four[stat]) flat += four[stat];
  return { flat, pct, mainsMissing };
}

/* The in-battle total for a target stat, or null when the character has no stat block.
   My Palace and team buffs are not modelled — lufel lists My Palace as its own separate
   requirement — so this is always a floor, never an exact figure. */
function totalStat(char, stat, sub, cards, lo) {
  const base = charBaseStat(char, stat, lo);
  if (!base) return null;
  const card = cardStatContribution(cards, char, stat, sub);
  const flat = base.flat + card.flat;
  const pct = base.pct + card.pct;
  const scales = stat === 'ATK' || stat === 'HP' || stat === 'DEF';
  return {
    total: scales ? base.flat * (1 + pct / 100) + card.flat : flat + pct,
    base: base.flat, pct, cardFlat: card.flat, cardPct: card.pct,
    mainsMissing: card.mainsMissing, approx: base.approx
  };
}

/* The five numbers worth watching on any build, regardless of whether lufel publishes a
   target for this character: ATK, Crit Rate, Crit Multiplier and Damage Multiplier feed the
   damage formula's ⓐⓑⓓ (see damageFactors below), and Resistance Pierce is the one damage
   stat the formula leaves unmodelled but the user still wants to see.
   [stat, label, sub, pct] — `stat`/`sub` are totalStat's own args; `sub` differs from
   `stat` only for ATK, whose card contribution comes in as ATK%. The labels are the canonical
   stat names every other screen uses: they read "Crit Damage", "Pierce Rate" and "Damage
   Mult" until Sep 2026, so one number went by two names on one screen (the targets table
   right below says Crit Multiplier). */
const STATS_SUMMARY_ROWS = [
  ['ATK', 'ATK', 'ATK%', false],
  ['Crit Rate', 'Crit Rate', 'Crit Rate', true],
  ['Crit Multiplier', 'Crit Multiplier', 'Crit Multiplier', true],
  ['Resistance Pierce', 'Resistance Pierce', 'Resistance Pierce', true],
  ['Damage Multiplier', 'Damage Multiplier', 'Damage Multiplier', true]
];

/* Renders those five as a row of tiles for the given cards and setup — the character's
   real in-battle numbers with this loadout, not a ratio against anyone else's build.
   Returns '' for a character with no CHAR_STATS entry, same as every other block here
   that has nothing honest to show. `idealCards` is optional — when supplied (a perfect
   loadout's five cards, e.g. from idealLoadout()), each tile also shows that same stat
   totalled against the perfect build for this character, on the same footing as the
   build score itself: same base stats, weapon and Mindscape, only the cards differ. */
function statsSummaryHtml(char, cards, lo, hypothetical, idealCards) {
  // the Thieves Den's battle effects are in-battle totals too (see denBonus), on both sides
  const plus = (t0, stat) => t0 && denBonus(stat) ? Object.assign({}, t0, { total: t0.total + denBonus(stat) }) : t0;
  const rows = STATS_SUMMARY_ROWS.map(([stat, label, sub, pct]) => ({
    label, pct, tot: plus(totalStat(char, stat, sub, cards, lo), stat),
    idealTot: idealCards ? plus(totalStat(char, stat, sub, idealCards, lo), stat) : null
  }));
  const denOn = DEN_STATS.some(st => denBonus(st) > 0);
  if (!rows.some(r => r.tot)) return '';
  const anyMissing = rows.some(r => (r.tot && r.tot.mainsMissing > 0) || (r.idealTot && r.idealTot.mainsMissing > 0));
  const tiles = rows.map(r => {
    const v = r.tot ? (r.pct ? r.tot.total.toFixed(1) + '%' : Math.round(r.tot.total).toLocaleString()) : '—';
    const flag = r.tot && r.tot.mainsMissing > 0
      ? ' <span class="tiny muted" title="A main stat magnitude is missing on a card that could contribute here — this number is an undercount">*</span>' : '';
    const iv = r.idealTot ? (r.pct ? r.idealTot.total.toFixed(1) + '%' : Math.round(r.idealTot.total).toLocaleString()) : null;
    /* A perfect build that carries none of the stat has no "share of perfect" to draw. It
       used to come out as width:null% — invalid CSS, so the bar rendered full, and "Resistance
       Pierce 1.9% of 0.0% perfect" read as a stat maxed out rather than one nobody asks for. */
    const noIdeal = !!r.idealTot && !(r.idealTot.total > 0);
    const pctOfIdeal = (r.tot && r.idealTot && r.idealTot.total > 0)
      ? Math.min(100, Math.round(100 * r.tot.total / r.idealTot.total)) : 0;
    return `<div class="p"><div class="tiny muted">${esc(r.label)}</div>
      <div><span class="score">${v}</span>${flag}</div>
      ${noIdeal ? '<div class="tiny muted" title="The perfect build for this character carries none of this stat">not in the perfect build</div>'
        : iv != null ? `<div class="tiny muted">of ${iv} perfect${r.idealTot.mainsMissing > 0 ? '*' : ''}</div>
        <div class="bar"><i style="width:${pctOfIdeal}%"></i></div>` : ''}</div>`;
  }).join('');
  const kit = kitStatBuffs(char, lo);
  return `<div class="targets">
    <h3>Your stats <span class="tiny muted">— in-battle totals${hypothetical ? ' with the recommended cards' : ''}</span></h3>
    <div class="bparts" style="margin-bottom:6px">${tiles}</div>
    ${explainHtml(`In-battle totals at this Setup, and a floor: ${denOn ? 'the Thieves Den is counted as entered in the header settings, but party buffs are not' : 'the Thieves Den (enter it in the header settings) and party buffs are not counted'}.${anyMissing ? ' <b>*</b> undercounted where a card\'s main stat magnitude has not been scanned yet.' : ''}`,
      `Base stats, weapon, ascension, Mindscape and Awareness at this setup, plus ${hypothetical ? 'the recommended' : 'these'} cards' main stats,
      substats, 2-piece bonuses and any 4-piece's unconditional stat line (Labor's +8% on an Elucidator, Strife's +15% ATK, Reconciliation's +15%).
      ${kit.length ? 'Also counted, as always-on in this kit\'s rotation: ' +
        kit.map(b => esc(`${b.s} +${b.v}${b.pct ? '%' : ''} (${b.why.split(':')[0]})`)).join(', ') + '. ' : ''}
      ${idealCards ? '<b>Perfect</b> is the same setup with a flawless five-card loadout for this character — five max-level 5★ cards, the preferred 4-piece, a recommended main in every slot, every substat roll maxed on the four best stats the main leaves free.' : ''}`)}
  </div>`;
}

/* lufel's stat-target tiers are the character's own skill-level cap, not a difficulty
   stage or an Ascension check — an earlier pass wrongly attributed the family switch to
   Ascension 6; the user corrected this from firsthand play. "LV10" is the base cap every
   skill reaches through plain investment; "LV12"/"LV13" is that same cap after the
   Awareness node whose skill-level-up applies to this character's primary skill —
   Awareness's own r3 and r5 nodes each bump two specific skills by 2 or 3 levels (see
   CHAR_STATS' `awareness` array), and which one is relevant is a property of the kit,
   not a fixed level: cross-referencing all 37 targeted characters' `skill_priority`
   against which of their own r3/r5 text names that top skill, the switch is Awareness 5
   for the 7 in TARGET_TIER_AWARENESS_5 below and Awareness 3 (the default) for the rest.
   Two of the 3s, Mitsuru Kirijo and Koromaru, lead with a Highlight/Theurgy skill that
   neither node ever names, so the check falls through to their next-priority regular
   skill instead — both land on 3 that way. One character, Justine & Caroline, could not
   be resolved this way at all — her r3/r5 text names a "Selected Skill 1/2" slot rather
   than a real skill, because which skill sits there depends on which twin is active —
   so she defaults to 3 unverified; worth checking by hand. A few characters (e.g. Aran
   Hirano) only ever publish one family — for them the switch is moot and this always
   lands on that single family. The Mindscape *skill* paths (`mindSkill`, distinct from
   the stat paths `mind1`/`mind2` above) add their own further skill-level bump, lufel's
   "+5" variant, within whichever family the Awareness check picked — that part of the
   original model was right. Falls back to the toughest tier on file if the current
   loadout's family/variant was not actually published (should not happen with real
   lufel data, but a target hand-edited in the Targets dialog could omit one). */
const TARGET_TIER_AWARENESS_5 = new Set([
  'Leo Kamiyama', 'Kayo Tomiyama', 'Minami Miyashita', 'Riko Tanemura',
  'Kira Kitazato', 'Shoki Ikenami', 'Kumi Katayama'
]);
function pickTier(tiers, lo, awThreshold) {
  const keys = Object.keys(tiers);
  const families = [...new Set(keys.map(k => k.replace('+5', '')))]
    .sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10));
  const family = (lo.awareness || 0) >= (awThreshold || 3) ? families[families.length - 1] : families[0];
  const key = lo.mindSkill ? `${family}+5` : family;
  if (tiers[key] != null) return { key, value: tiers[key] };
  if (tiers[family] != null) return { key: family, value: tiers[family] };
  const fallback = keys.reduce((best, k) => tiers[k] > tiers[best] ? k : best, keys[0]);
  return { key: fallback, value: tiers[fallback] };
}

/* Per-target progress, comparing the cards' contribution against a perfect build's. The
   ideal side (`want`/`idealTot`) never depends on `cards`, only on `idealCards`, so it is
   memoised per idealCards array — a fresh one only ever comes from one idealLoadout()
   call, so the reference is a safe cache key. Triage's marginal pricing calls this twice
   (before/after) per candidate card against the SAME idealCards for that character, and
   without this every one of those recomputed the ideal side from scratch for nothing.
   Saturates at 1: clearing a breakpoint is the whole point, overshooting is not better. */
const idealBreakpointCache = new WeakMap();
function breakpointRows(cards, idealCards, char, t, lo) {
  let idealCache = idealBreakpointCache.get(idealCards);
  if (!idealCache) { idealCache = {}; idealBreakpointCache.set(idealCards, idealCache); }
  return (t.targets || []).map(x => {
    const got = statSupply(cards, char, x.sub);
    const key = x.sub + '@' + x.s;
    let ic = idealCache[key];
    if (!ic) ic = idealCache[key] = {
      want: statSupply(idealCards, char, x.sub),
      idealTot: totalStat(char, x.s, x.sub, idealCards, lo),
      bareTot: totalStat(char, x.s, x.sub, [], lo)          // the character with no cards at all
    };
    const want = ic.want, idealTot = ic.idealTot;
    const relative = want > 0 ? Math.min(1, got / want) : (got > 0 ? 1 : 0);

    /* Prefer the real in-battle number when it can be had — that is the whole point of
       knowing the weapon, ascension and Mindscape. It can only be had once every card
       carrying this stat as its main has a magnitude to go with it; otherwise the total
       is an undercount that would punish a data gap rather than a build, so fall back to
       the relative measure and let the UI say why. */
    const tot = totalStat(char, x.s, x.sub, cards, lo);
    const tier = pickTier(x.tiers, lo, TARGET_TIER_AWARENESS_5.has(char.n) ? 5 : 3);
    const bar = tier.value;

    /* Some targets are simply not reachable from the character plus perfect cards —
       Starlight Morgana wants 50% Crit Rate and a flawless build with her recommended
       main stats gets to 26. The rest has to come from party buffs or My Palace, neither
       of which is modelled. Scoring against the raw bar would make 100 unreachable for
       her no matter what the user does, so the bar the SCORE uses is capped at what a
       perfect build achieves. The UI still shows the real number and flags the shortfall. */
    /* The Thieves Den's battle effects are in-battle only, as lufel's targets are, so they are
       added here — to the worn, perfect and no-card totals alike — and never inside totalStat,
       whose conversions and callers read the character's own stats. Added after the ideal
       side's memo, so a changed setting is never served a stale total. */
    const den = denBonus(x.s);
    const reach = idealTot ? idealTot.total + den : null;
    const effBar = reach != null && reach < bar ? reach : bar;
    const exact = !!(tot && tot.mainsMissing === 0 && effBar > 0);
    const totalNow = tot ? tot.total + den : null;
    /* A target the character already meets with NO cards — base stats, weapon, Awareness
       and kit lines alone — is not something cards can earn. buildScoreOf leaves it out of
       the stat-target block (the UI still shows it): scored, it handed every loadout the
       same free points and watered down the targets the cards can move. Fuuka's Crit
       Multiplier target is the standing case — lufel's 64-78% is the crit damage at which
       her party crit-damage buff stops growing (its cap over 0.625% per 1%), and kit text
       means the total there, as Starlight Ren's "up to … at 197.6% critical damage" does,
       so her 150% base clears it before a card is worn; it was half her block, and her
       ATK target, the one gear moves, got the other half. Mitsuru's LV10 ATK target sits
       under her no-card ATK the same way. */
    const bare = ic.bareTot;
    const bareNow = bare ? bare.total + den : null;
    const metBare = !!(bare && bare.mainsMissing === 0 && effBar > 0 && bareNow >= effBar - 1e-9);
    /* Progress is measured from where the character stands with no cards, not from zero:
       the share of the gap between that and the bar the cards close. Measured from zero,
       base stats alone earned the median target 64% of its points (61% on average, across
       the 45 scored), so a naked character took about 49 of the block's 80 and every
       loadout differed only in the rest — which blunted the one term that exists to say
       "reach this number". The relative fallback already counts cards only. */
    const floor = bare ? bareNow : 0;
    const ratio = !exact ? relative : metBare ? 1
      : Math.max(0, Math.min(1, (totalNow - floor) / (effBar - floor)));
    return {
      stat: x.s, sub: x.sub, pct: x.pct, tiers: x.tiers, tierKey: tier.key, got, want, bar, effBar,
      total: totalNow, reach, shortOfBar: reach != null && reach < bar,
      mainsMissing: tot ? tot.mainsMissing : 0, approx: !!(tot && tot.approx), exact, relative,
      bare: bareNow, den, metBare, ratio
    };
  });
}

/* ==================== the damage model, and why spread matters ====================
   Lufel publishes the damage formula (lufel.net/article/damage-calc, mirrored below).
   Damage is a product of nine factors:

     ⓐ ATK  ×  ⓑ damage bonus  ×  ⓒ enemy defence  ×  ⓓ crit  ×  ⓔ skill coefficient
       ×  ⓕ weakness  ×  ⓖ final damage bonus  ×  ⓗ other  ×  ⓘ random 0.95-1.05

   and three of those are what the revelation cards move:

     ⓐ = (character ATK + weapon ATK) × ATK%  +  flat ATK
     ⓑ = 100% + Damage Mult + elemental damage bonus + increased damage taken
     ⓓ = 100% + Crit Rate × (Crit Mult − 100%)

   "Values within the same group are calculated through addition" — so stats inside one
   factor are substitutes and the factors multiply. That is the whole reason spread
   matters, and why a weighted sum of substats cannot express it: a sum says nine Crit
   Multiplier rolls are worth nine rolls, while the formula says they multiply an ⓓ that
   a 5% crit rate has already pinned near 1, and are worth almost nothing. `cardScore`'s
   coupling handles this to first order, per card; this handles it exactly, per loadout.

   Everything outside ⓐⓑⓓ is enemy, skill, party or dice — identical for every loadout
   the same character could wear, so it cancels in a ratio and is left out rather than
   guessed at. One card stat is left out with it: **Resistance Pierce** lives in ⓒ, whose
   enemy defence value lufel says cannot be found in the game at all and has to be read
   out of the client. Its weight still prices it; the damage model does not.

   The two FIXED mains do feed ⓐ, as flat stat added after the percentage: a Space card's
   ATK + DEF (flat ATK for an ATK kit, flat DEF for a DEF one) and a Sun card's HP (for
   the HP kits). They used to be left out on the grounds that their magnitude was
   unpublished and that both sides of every ratio carry one of each, so they cancel —
   but MAIN_MAGNITUDE has measured both, and a flat term added to both sides of a ratio
   does not cancel; nor does a Lv0 card against a Lv25 one. For the seven DEF/HP kits the
   omission was 5-7% of a perfect build's ⓐ. cardScore still prices neither — every card
   of the slot carries the same main — so this is the one place their level counts.

   Lufel's own caveat applies and is worth repeating: the article is reconstructed from
   early Chinese Q&A, "over 100 different stats" feed damage, and it says outright not to
   chase exact numbers. This uses the formula for its **shape** — which stats multiply
   and which merely add — not to predict damage. Nothing here is reported as a damage
   figure, only as a ratio against a perfect build for the same character.

   Main stat magnitudes come from MAIN_MAGNITUDE (measured off the user's own scanned
   cards), at each card's level — the same figure cardScore prices a main at.
   `totalStat()` remains the place that reports absolute in-battle numbers. */

/* Which stat a kit's damage scales off. Everyone scales off ATK except the kits whose
   skill text reads "damage equal to N% of <name>'s Defense / Max HP" throughout —
   checked against lufel's skill data for all 65: Yusuke and Ashiya have no Attack
   coefficient anywhere in their kits, and the HP kits' damage (and party buffs) are
   written as fractions of max HP. For these the ATK factor is their DEF or HP, and
   DEF% / HP% sits where ATK% sits for everyone else — in ⓐ, in the coupling's first
   product, and in damageShare. Beachflower Minami joined in Sep 2026: Beach Basket (64.4%
   of max HP) is her only damage line, and nothing in her kit reads her ATK. Two
   deliberate omissions: Yukimi Fujikawa's DEF feeds shields and an ally buff, never a
   damage line, so listing her would book her whole DEF% weight as damage; and Tropical
   Motoha's damage is ATK-scaled, with HP converted into ATK by her passive — a conversion
   the weights already capture (HP% is her top weight), not a scaling stat. */
const DAMAGE_SCALE = {
  'Yusuke Kitagawa': 'DEF', 'Masaki Ashiya': 'DEF',
  'Junpei Iori': 'HP', 'Shun Kano': 'HP', 'Shun Kano [Pioneer]': 'HP', 'Kiyoshi Kurotani': 'HP',
  'Ichigo Shikano [Summer]': 'HP', 'Minami Miyashita [Beachflower]': 'HP'
};

/* Stats a kit turns into an ally buff, for a character whose own damage is a side line.
   What such a stat is worth is the buff — linear up to the cap that lufel's stat target
   records — not what it adds to the character's own damage product, so it is left out
   of the coupling (computeCoupling) and out of the damage share of their weights
   (damageShare). The damage model itself still counts it, since their own hits do use it.

   Only kits where the distinction changes an answer are listed. Most buffers' ATK% feeds
   an ATK-scaling buff and their own damage alike, and booking it as damage is harmless
   while the same weights build the ideal (docs/SCORING.md, known gaps); an Elucidator is
   not coupled at all.

   - Beachflower Minami: Gentle Sea Breeze, her Highlight and her medicine hand an ally
     33.33% / 16.66% of her crit multiplier over 100%, up to 213.4% — lufel's target is that
     cap — and Summer Garden and Bewitching Blossoms scale party damage and ATK with her max
     HP up to 11712, the other target. Coupled as her own damage, her 5% crit rate put a
     Crit Multiplier roll at 0.63 of its weight, and lufel's Crit Multiplier Star lost to an
     HP% Star (and a Crit Rate one) at equal substats. */
const BUFF_SOURCE_STATS = {
  'Minami Miyashita [Beachflower]': ['HP%', 'Crit Multiplier']
};
const buffSourceStats = char => (char && BUFF_SOURCE_STATS[char.n]) || [];
const scaleStat = char => (char && DAMAGE_SCALE[char.n]) || 'ATK';
const scalePctStat = char => FLAT_TO_PERCENT[scaleStat(char)];

/* Stat conversions: kits that turn a non-damage stat into ATK, crit damage or damage
   bonus, always on. The weights already rank the source stat first for every one of these
   (that is why lufel lists it first), but the damage model did not see the conversion: for
   Runa, a perfect build's 199% Ailment Accuracy (5★ weapon at R1, no Mindscape) is +119%
   ATK, and an accuracy roll is also 2.5% ATK. So here the converted amount is added to the ATK factor (or crit damage,
   or damage bonus) from the character's in-battle total of the source stat — base, weapon,
   kit buffs and the cards — in damageFactors, and to the corresponding supply in the
   coupling, so ATK% and the source stat are priced against each other correctly. The source
   stat also counts as a modelled stat for damageShare where it feeds a damage factor.

   `rate` is per point of the source stat (or per point above `over`), capped at `cap`.
   Party-buff conversions that scale an ally's stat off the character's (Miku, Manaka,
   Fuuka, Yumi, Kayo, Haruna, Leo, Fujikawa) are not here: they are not the character's own
   damage. Skill-specific ones (Kira's Bleed) are not either. Lufel's own target notes count
   these — Tempest Riko's "패시브(활기): 84%" is exactly Sun-kissed Blooms below. */
const CONVERSIONS = {
  'Runa Dogenzaka':            [{ from: 'Ailment Accuracy', to: 'ATK%', rate: 0.6, why: 'Peppy Guard Dog: ATK +60% of ailment accuracy' }],
  'Koromaru':                  [{ from: 'Ailment Accuracy', to: 'ATK%', rate: 0.36, why: 'Loyal Dog: ATK +36% of ailment accuracy' }],
  'Chizuko Nagao':             [{ from: 'Ailment Accuracy', to: 'ATK%', rate: 0.45, why: 'Perfect Timing: ATK +45% of ailment accuracy' }],
  'Haru Okumura':              [{ from: 'Ailment Accuracy', to: 'ATK%', rate: 1 / 1.45, cap: 165, why: "Heiress's Leadership: ATK +1% per 1.45% ailment accuracy, up to 165%" },
                                { from: 'Ailment Accuracy', to: 'Crit Multiplier', rate: 0.4, cap: 60, why: "Heiress's Leadership: crit damage +20% per 50% ailment accuracy, 3 stacks" }],
  'Shoki Ikenami':             [{ from: 'Ailment Accuracy', to: 'ATK%', rate: 0.72, cap: 72, why: 'Method Acting: ATK +0.72% per 1% ailment accuracy, up to 72%' }],
  'Yaoling Li':                [{ from: 'Speed', to: 'ATK%', rate: 0.5, cap: 90, why: 'Kung Fu Mastery: ATK +1% per 2 Speed, up to 90%' }],
  'Kumi Katayama':             [{ from: 'Speed', to: 'ATK', rate: 24, over: 100, cap: 1920, why: 'High-Speed Vector: +24 ATK per Speed above 100, up to 1920' }],
  'Miyu Sahara [Wavecatcher]': [{ from: 'SP Recovery', to: 'ATK%', rate: 98 / 280, cap: 98, why: 'Hang Ten!: ATK up to +98% at 280% SP Recovery' }],
  'Riko Tanemura [Tempest]':   [{ from: 'SP Recovery', to: 'Crit Multiplier', rate: 84 / 450, cap: 84, why: 'Sun-kissed Blooms: crit damage up to +84% at 450% SP Recovery' },
                                { from: 'SP Recovery', to: 'HP', rate: 4, cap: 1800, why: 'Sun-kissed Blooms: HP up to +1800 at 450% SP Recovery' },
                                { from: 'Crit Multiplier', to: 'ATK%', rate: 0.08, over: 100, why: 'Vernal Splendor: ATK +8% of crit multiplier above 100% after 5 Blossom stacks' }],
  'Motoha Arai [Tropical]':    [{ from: 'HP', to: 'ATK', rate: 0.24, over: 8000, cap: 1920, why: 'Outshine the Sun!: +24 ATK per 100 max HP above 8000, up to 1920' }],
  'Kiyoshi Kurotani':          [{ from: 'HP', to: 'Damage Multiplier', rate: 1 / 300, cap: 30, why: 'Hot to the Touch: Fire damage +1% per 300 max HP, up to 9000 HP' }],
  'Tomoko Noge [Seaside]':     [{ from: 'HP Recovery', to: 'Damage Multiplier', rate: 70 / 42, cap: 70, why: 'Power of Memories: Psy damage up to +70% at 42% HP recovery' },
                                { from: 'HP Recovery', to: 'HP', rate: 50, cap: 2100, why: 'Power of Memories: max HP up to +2100 at 42% HP recovery' }],
  'Yukari Takeba':             [{ from: 'ATK', to: 'HP', rate: 0.6, cap: 2700, why: "Archer's Courage: +60 max HP per 100 ATK, up to 2700" }],
  'Masaki Ashiya':             [{ from: 'DEF', to: 'Damage Multiplier', rate: 2.9 / 300, cap: 56.6, why: "Winter Fortress: party damage +2.9% per 300 DEF, up to 56.6%" }],
  'Riko Tanemura':             [{ from: 'Speed', to: 'ATK', rate: 2, over: 100, cap: 120, why: 'Springtime Tempest: party +2 ATK per Speed above 100, up to 120' }]
};
const CONV_SUB = { HP: 'HP%', DEF: 'DEF%', ATK: 'ATK%' };
/* What the conversions add for this loadout, from in-battle source totals (cards included
   when given). Sources are read before any conversion is applied, so a chain such as Tempest
   Riko's SP Recovery -> crit damage -> ATK is evaluated on the pre-conversion crit damage —
   an undercount, stated here rather than hidden. */
function conversionBonus(char, cards, lo) {
  const out = { 'ATK%': 0, ATK: 0, 'Crit Multiplier': 0, 'Damage Multiplier': 0, HP: 0 };
  const list = CONVERSIONS[char.n];
  if (!list) return out;
  const L = lo || charLoadout(char.n);
  for (const cv of list) {
    if (cv.aw != null && (L.awareness || 0) < cv.aw) continue;
    const src = totalStat(char, cv.from, CONV_SUB[cv.from] || cv.from, cards || [], L);
    if (!src) continue;
    let v = cv.rate * Math.max(0, src.total - (cv.over || 0));
    if (cv.cap != null) v = Math.min(cv.cap, v);
    out[cv.to] = (out[cv.to] || 0) + v;
  }
  return out;
}
/* Source stats that feed a damage factor for this character, for damageShare. */
function conversionSources(char) {
  return (CONVERSIONS[char && char.n] || []).filter(cv => cv.to !== 'HP').map(cv => CONV_SUB[cv.from] || cv.from);
}

/* Kits where some or all of the damage always crits — or cannot (`nocrit`), or crits at a
   higher rate than the rest (`extraCr`). `locked` is the share of the kit's
   damage that is a guaranteed critical; ⓓ is then a mixture — that share at 100% crit
   rate, the rest at the rolled rate — and the coupling values a Crit Rate roll only for
   the rolled share (see lockedCritSupply). `cmClamp` bounds the crit damage the locked
   share is dealt at, where the kit says so.

   - Skull and Pioneer Shun: every damage line is a guaranteed critical (`locked: 1`).
     Skull's Crit Rate weight is already 0 for this reason; this is the other half of the
     same fact. Without it the spread term valued a Crit Multiplier roll on him at his 5%
     base rate, a twentieth of its worth.
   - Akihiko: Lightning Spike (Theurgy) and Finishing Blow (Awareness 6) always crit, with
     the Theurgy's crit damage clamped to 250-350% (300-400% at Awareness 4). Blitzkrieg,
     Spark Impact and Lightning Fist — his top-priority skill — roll. Sized from the kit's
     own coefficients over a representative window (one Lightning Fist spending three
     Grit at 159 + 3 × 57 = 329% ATK, one Blitzkrieg 143%, one Spark Impact 107%, one
     Flash Blow 56%, and a 297% Theurgy roughly every fourth turn): the guaranteed share
     is 26% without Awareness 6 and 29% with, so 0.3. The clamp is why his Crit
     Multiplier reads oddly on the Theurgy: below 250% total it is floored up, so extra
     Crit Multiplier does nothing there until he clears the floor.
   Junpei's Power Swing and Mayumi's extra-action hit are guaranteed too, but are single
   skills without a stated share of the kit, so they stay on their rate. */
const CRIT_PROFILE = {
  'Ryuji Sakamoto':      { locked: 1 },
  'Shun Kano [Pioneer]': { locked: 1 },
  'Akihiko Sanada':      { locked: 0.3, cmClamp: [250, 350], cmClampAw4: [300, 400] },
  /* Junpei: Sunder Strike (42% HP, guaranteed when it detonates Fever Pitch) and Power
     Swing (42% HP, guaranteed, fired when he is hit while holding a Charge he gains every
     two turns, and taunting through Hero Focus he is hit constantly) against Blazing
     Strike (77 + 39% HP) and a 138% Theurgy about every fourth turn: about a third of his
     damage over a three-turn window, more once Awareness 6 makes Power Swing his free
     melee every turn. */
  'Junpei Iori':         { locked: 0.35 },
  /* Kumi: her Highlight (318% ATK, every four turns) cannot crit at all — Awareness 6 has
     to grant "allow her Highlight to activate critical hits" — against three skills at
     102-142% in between, so close to half her damage ignores crit stats until then. */
  'Kumi Katayama':       { nocrit: 0.45, nocritUntilAw: 6 },
  /* Wavecatcher Miyu: Mermaid Dreamer's "Resonance critical rate +16.4-31.4%" crits only her
     Resonance — Catch a Wave, fired off her SP at the end of ally turns while she Surfs, and
     Aerial Tide, which cashes the Offshore stacks in. Over a representative Awareness-0 window
     at her 287% SP Recovery target (Paddle Out; a round of ally turns firing Catch a Wave at
     30 and 60 SP, 50.2% and 52.7% ATK; Aerial Tide on two stacks, 214% ATK; a Jellyfish Splash
     every other cycle and a 494% Highlight about every fourth turn) Resonance is about half
     her damage. Awareness 1 (cheaper waves, two more stacks) and 6 (Surf kept through Aerial
     Tide) push it towards three quarters; that is not modelled. `extraCr` is the share and
     the rate it gets on top of everything else. */
  'Miyu Sahara [Wavecatcher]': { extraCr: { share: 0.5, weapon: '5', ladder: [16.4, 21.4, 21.4, 26.4, 26.4, 31.4, 31.4] } }
};
/* The extra crit rate a share of the kit's damage carries (CRIT_PROFILE `extraCr`) on this
   setup, as { share, cr } with `cr` in points, or null when the setup does not carry it. */
function extraCritFor(prof, lo) {
  const x = prof && prof.extraCr;
  if (!x || (x.weapon && (!lo || lo.weapon !== x.weapon))) return null;
  return { share: x.share, cr: x.ladder ? x.ladder[Math.max(1, Math.min(7, lo.refine)) - 1] : x.v };
}
/* The no-crit share for a setup: gone once the Awareness node that lifts it is unlocked. */
const nocritShare = (prof, lo) => (prof && prof.nocrit && !(prof.nocritUntilAw != null && lo && (lo.awareness || 0) >= prof.nocritUntilAw)) ? prof.nocrit : 0;
const critProfile = char => (char && CRIT_PROFILE[char.n]) || null;
const critClamp = (prof, lo) => prof && prof.cmClamp
  ? ((lo && (lo.awareness || 0) >= 4 && prof.cmClampAw4) || prof.cmClamp) : null;

/* Extra Crit Rate supply, in points, that makes the coupling see a partially locked kit
   correctly. With a locked share f the marginal worth of a point of Crit Rate is
   (1 − f) × cmBonus and of a point of Crit Multiplier is f × I + (1 − f) × cr, where I is 1
   when the locked share's crit damage is inside its clamp (so a Crit Multiplier point
   reaches it) and 0 when it is floored or capped away. The coupling prices a stat at
   1 / supply, so the ratio comes out right when the Crit Rate supply is read as
   cr + f × I / (1 − f), i.e. this many points added on top of what is really there. A
   fully locked kit needs nothing here — its Crit Rate weight is 0 and the crit product
   has only one live stat. */
function lockedCritSupply(prof, cmTotal, lo) {
  if (!prof || !(prof.locked > 0) || prof.locked >= 1) return 0;
  const clamp = critClamp(prof, lo);
  const inRange = !clamp || (cmTotal >= clamp[0] && cmTotal < clamp[1]);
  return inRange ? 100 * prof.locked / (1 - prof.locked) : 0;
}

/* The card stats that appear in ⓐ, ⓑ or ⓓ for this character, and are therefore the ones
   this model prices: the scaling stat's % and flat forms, then the two crit stats and
   Damage Multiplier. */
const MODELLED_STATS = ['ATK%', 'ATK', 'Damage Multiplier', 'Crit Rate', 'Crit Multiplier'];
const modelledStatsCache = {};
function modelledStats(char) {
  const k = char ? char.n : '';
  if (modelledStatsCache[k]) return modelledStatsCache[k];
  const S = scaleStat(char);
  const base = S === 'ATK' ? MODELLED_STATS : [FLAT_TO_PERCENT[S], S, 'Damage Multiplier', 'Crit Rate', 'Crit Multiplier'];
  const conv = conversionSources(char).filter(s => base.indexOf(s) < 0 && SUBSTATS[s]);
  return (modelledStatsCache[k] = conv.length ? base.concat(conv) : base);
}

/* Points of each modelled stat a loadout supplies: substats and 2-piece bonuses exactly,
   plus each card's main at its real magnitude for its level — the fixed mains included (see
   the damage-model note above). A Space card's single 'ATK + DEF' value counts toward both
   flat stats, the same way cardStatContribution counts it for the in-battle totals.

   A completed 4-piece's unconditional stat line (SET4_STATS — Strife's +15% ATK) counts too,
   as it does in the in-battle totals. Until Sep 2026 it did not: Kotone Shiomi's ⓐ read 5316
   beside her ATK tile's 5603, exactly Strife's 15% of her 1910 base, and the perfect build
   lost the same 287. bonus4Value still prices the set as a whole; the 2-piece's stat has
   always been in the product beside bonus2Value in the same way, so this is the rule the
   2-piece already followed, not a second charge for the set. */
function damagePoints(cards, char) {
  const out = supplyOf(cards, char, modelledStats(char));
  (cards || []).forEach(c => {
    if (!c) return;
    if (c.main === 'ATK + DEF') {
      if (out.ATK === undefined && out.DEF === undefined) return;
      const v = mainMagnitudeFor(c, true) || 0;
      if (out.ATK !== undefined) out.ATK += v;
      if (out.DEF !== undefined) out.DEF += v;
    } else if (out[c.main] !== undefined) out[c.main] += mainMagnitudeFor(c, true) || 0;
  });
  const four = set4StatLines(cards, char);
  for (const s in four) if (out[s] !== undefined) out[s] += four[s];
  return out;
}

/* The part of ⓐⓑⓓ that is the character rather than the cards — base and weapon ATK, the
   character's own innate crit rate and crit multiplier from CHAR_STATS (5%/150% for most
   of the roster, 0%/0% for the seven Buff-element support units), and any unconditional
   weapon or Mindscape line. Independent of the loadout, and the optimiser evaluates
   thousands of loadouts per character, so it is computed once per character and setup. */
/* ---- the party's crit rate: a user assumption (Roster tab, "Team crit rate") ----------
   Every crit rate the model knows is the character's own — base, Awakening, weapon,
   Mindscape, the kit lines in KIT_STAT_BUFFS. A real team adds more: an Elucidator's 20%
   share, and a crit support's buff (Summer Ichigo's Heart's Desire +14.6%, Starlight Ren's
   +15.6%, Beachflower Minami's +15.6% on one ally, Futaba's and Manaka's +12%). Lufel's crit
   advice assumes one: 35 of the 62 who weight both crit stats put Crit Multiplier first on
   the Star, which only pays once crit rate is covered. Without it the engine reads crit
   rate as scarce for everyone, and prefers Crit Rate Stars and Triumph's +7.5% crit-rate
   2-piece where lufel says Crit Multiplier.

   `state.teamCrit` is that extra, in points, one number for the whole roster. It is added
   wherever the damage model reads a crit rate — ⓓ (damageFactors), both coupling baselines
   (seedBaseline, via damageBase) and the 100% cap (heldCritRate) — for
   every character who deals their own damage, and on the generic board the Vault's
   archetypes are priced on. Not for an Elucidator, whose stats are donated and who is not
   coupled. It never enters totalStat: on-screen totals and stat targets stay what the
   character has alone, as lufel's own crit-rate targets do (Starlight Morgana's 50% counts
   the Elucidator share and My Palace, not another party member's buff). 0, the default, is
   the model without it. */
function teamCritRate() { const v = +state.teamCrit; return v > 0 ? Math.min(100, v) : 0; }

/* ---- the Thieves Den's battle effects: a user entry (header settings, "Thieves Den") -----
   The Thieves Den — its level's collection items and its rating (Qualia, which follows the
   roster's overall power) — adds flat stats to every character, in combat only: lufel's guide
   says they never show on the character screen before a battle, only on the stat screen once
   in one, and lufel's own stat targets count them ("Thieves Den 50LV 65 / 70LV 110 (or higher)
   / Thieves Den Rating"). Measured on the user's account (26 Sep 2026, Thieves Den 56, Qualia
   355): Miku's stat screen reads ATK +119, HP +473, crit rate +1 and crit multiplier +2 in
   battle over her character screen. Nothing here can derive those from a level, so the user
   enters what the game shows. They are added only where a stat target is checked
   (breakpointRows) and to the in-battle totals on screen — never inside totalStat, whose
   conversions feed the damage model — so builds and recommendations move only through the
   stat targets. Flat points for every stat, as the game adds them; 0 is not counted. */
const DEN_STATS = ['ATK', 'HP', 'DEF', 'Speed', 'Crit Rate', 'Crit Multiplier', 'Ailment Accuracy', 'SP Recovery'];
function denBonus(stat) { const v = +((state.den || {})[stat]); return v > 0 ? v : 0; }
function denSig() { return DEN_STATS.map(s => denBonus(s)).join(','); }
// What the save file keeps (only the stats with a value) and what a loaded one may set (numbers only).
function denSaved() { const o = {}; DEN_STATS.forEach(s => { const v = denBonus(s); if (v) o[s] = v; }); return o; }
function denFrom(o) {
  const d = {};
  DEN_STATS.forEach(s => { const v = +((o || {})[s]); if (v > 0 && isFinite(v)) d[s] = Math.min(v, 100000); });
  return d;
}
function teamCritFor(char) { return char && !spreadApplies(char) ? 0 : teamCritRate(); }

const damageBaseCache = {};
function damageBase(char, lo) {
  const L = lo || charLoadout(char.n);
  const tc = teamCritFor(char);
  const key = `${char.n}|${L.level}|${L.asc}|${L.weapon}|${L.refine}|${L.mindSkill ? 1 : 0}|${L.mind1 || 0}|${L.mind2 || 0}|${L.awareness}|${tc}`;
  if (damageBaseCache[key]) return damageBaseCache[key];
  const b = charBaseStat(char, scaleStat(char), L);
  /* Crit Rate, Crit Multiplier and Damage Multiplier are percentage-UNIT stats: a weapon's
     "+18% critical rate" is 18 points added, and charBaseStat files it under `pct` the way
     totalStat wants (which sums flat + pct for these). Reading `.flat` alone here dropped
     every crit/damage weapon ladder and Mindscape node from the damage model — Morgana was
     modelled at 22.4% crit with Golden Legacy's +18% equipped. */
  const at = (s, dflt) => { const x = charBaseStat(char, s, L); return x ? x.flat + x.pct : dflt; };
  const v = {
    atk: b ? b.flat : 1000, atkPct: b ? b.pct : 0,
    cr: at('Crit Rate', 5) + tc, cm: at('Crit Multiplier', 150), dm: at('Damage Multiplier', 0)
  };
  damageBaseCache[key] = v;
  return v;
}

/* ⓐ, ⓑ and ⓓ for one loadout, and their product. Absolute-looking but only ever used as
   a ratio; the character's own base ATK matters because the marginal value of ATK% is not
   the same for everyone — an ATK% roll on a 4000-ATK unit buys more than on a 1200-ATK
   one, and flat ATK is added AFTER the ATK% multiplication, so it does not compound. */
function damageFactors(cards, char, t, lo) {
  const B = damageBase(char, lo);
  const p = damagePoints(cards, char);
  const S = scaleStat(char), pct = FLAT_TO_PERCENT[S];
  const cv = conversionBonus(char, cards, lo);
  const atk = B.atk * (1 + (B.atkPct + p[pct] + (S === 'ATK' ? cv['ATK%'] : 0)) / 100) + p[S] + (S === 'ATK' ? cv.ATK : 0);
  const dmg = 1 + (B.dm + p['Damage Multiplier'] + cv['Damage Multiplier']) / 100;
  /* Crit rate caps at 100%: a roll past it does nothing in the game either. */
  const cr = Math.min(1, (B.cr + p['Crit Rate']) / 100);
  /* A crit deals `cm`% of a normal hit, so the factor is (1-cr)*1 + cr*(cm/100), i.e.
     1 + cr*cmBonus. That is only sane while cm >= 100. Seven Buff-element supports
     (Miku, Futaba, Manaka, Riko, Yumi Shiina, Miyu, Kayo) carry a real, panel-confirmed
     0% / 0% crit base, which drives cmBonus to -1 and made every Crit Rate roll read as
     an 8% damage LOSS — the optimiser was being told a crit is worse than a normal hit.
     Whatever cm: 0 means for those units (they may simply be unable to crit, or the
     panel may be reporting a bonus rather than a total), it cannot mean that, so the
     floor refuses to model crits as damage-reducing rather than guessing a real value.
     The effect is that crit stats are worth nothing to them here, not less than nothing.
     `cr` needs no floor of its own — neither the base nor a card can contribute a
     negative crit rate — but it is clamped alongside so the factor can never dip
     below 1 from either side. */
  const cmTotal = B.cm + p['Crit Multiplier'] + cv['Crit Multiplier'];
  const cmBonus = (cmTotal - 100) / 100;
  let crit = 1 + Math.max(0, cr) * Math.max(0, cmBonus);
  const prof = critProfile(char), L2 = lo || charLoadout(char.n);
  /* A share of the damage that crits at a higher rate (CRIT_PROFILE `extraCr`): Wavecatcher
     Miyu's Resonance, with her weapon's Resonance crit rate on top of the rest. */
  const ex = extraCritFor(prof, L2);
  if (ex) crit = (1 - ex.share) * crit + ex.share * (1 + Math.min(1, Math.max(0, cr) + ex.cr / 100) * Math.max(0, cmBonus));
  /* A kit that partly or wholly always crits (CRIT_PROFILE): that share of the damage is
     dealt at 100% crit rate — at its clamped crit damage where the kit clamps it — and
     only the rest rolls. Skull is the `locked: 1` case: his factor is simply cm / 100. */
  if (prof && prof.locked > 0) {
    const clamp = critClamp(prof, L2);
    const cmLocked = clamp ? Math.min(clamp[1], Math.max(clamp[0], cmTotal)) : cmTotal;
    crit = prof.locked * Math.max(1, cmLocked / 100) + (1 - prof.locked) * crit;
  }
  // ...and a share that cannot crit at all is dealt at exactly 1x, whatever the crit stats.
  const nc = nocritShare(prof, L2);
  if (nc > 0) crit = nc * 1 + (1 - nc) * crit;
  return { atk, dmg, crit, value: atk * dmg * crit };
}

/* How much of what this character wants the damage model actually captures. A DPS lands
   near 0.7, a tank near 0.05, so the term below is worth what damage is worth to them
   without needing an archetype whitelist. Resistance Pierce is deliberately NOT counted
   as captured — it is a damage stat, but ⓒ is not modelled, and a term should not claim
   credit for a factor it left out. */
function damageShare(t, char) {
  const who = char || (t && t.n ? charDef(t.n) : null);
  const modelled = modelledStats(who), buff = buffSourceStats(who);
  let all = 0, mine = 0;
  Object.keys(t.w || {}).forEach(s => {
    const w = t.w[s] || 0;
    all += w;
    // a stat bought for the buff it hands allies is not this character's damage
    if (modelled.indexOf(s) >= 0 && buff.indexOf(s) < 0) mine += w;
  });
  return all > 0 ? mine / all : 0;
}

/* Worth of getting the spread right, on the same footing as BREAKPOINT_VALUE: a fixed
   budget scaled by how much of the character is damage, awarded in proportion to how
   close the loadout's ⓐⓑⓓ product comes to a perfect build's. Saturates at 1 — beating
   the perfect build is not a thing to reward, and the build score clamps at 100 anyway. */
const SPREAD_VALUE = 80;

/* The ideal side never depends on `cards`, only on `idealCards`, so — same reasoning as
   breakpointRows above — it is memoised per idealCards array rather than recomputed on
   every call sharing one, which is exactly what bestPlan's plan search and Triage's
   marginal pricing both do many times over for a single character. */
const idealDamageCache = new WeakMap();
/* An Elucidator does not spend their stats on their own damage. Every Elucidator's kit
   passive reads "increase all deployed allies' corresponding stat by 20% of the Elucidator
   Thief's" (15% at 4-star) — checked against all eight, it is a property of the role, not a
   per-character quirk — and seven of the eight carry a 0% / 0% crit base besides. So the
   ⓐⓑⓓ product computed from their own board is a number the game never evaluates: their
   Crit Rate is bought to be donated, and what a donated point is worth depends on the
   ALLY's balance, which nothing here models.

   damageShare cannot see this, because it classifies a weight by the stat's name and their
   weights are genuinely damage stats — which is exactly why the term was worth 48-58 points
   of every Elucidator's build score for a product they never compute.

   This is a game mechanic tied to a role, not the archetype whitelist damageShare is
   careful to avoid: it says "these stats serve someone else's damage", not "this archetype
   does not deal damage". Two things it deliberately is NOT built on, both tried first and
   rejected: lufel's role prose (it misclassifies five of the eight — see
   docs/DATA-SOURCES.md), and a damage coefficient scraped from skill text (it reads DEF-
   scaling kits like Yusuke's as zero damage and counts Miku's party-ATK buff as damage,
   so gating a score on it would break real DPS units). */
const spreadApplies = char => !char || char.arch !== 'Navigator';

function spreadRow(cards, idealCards, char, t, lo) {
  const share = spreadApplies(char) ? damageShare(t, char) : 0;
  const max = SPREAD_VALUE * share;
  if (!(max > 0)) return { max: 0, got: 0, ratio: 1, share: 0 };
  const a = damageFactors(cards, char, t, lo);
  let i = idealDamageCache.get(idealCards);
  if (!i) { i = damageFactors(idealCards, char, t, lo); idealDamageCache.set(idealCards, i); }
  const ratio = i.value > 0 ? Math.min(1, a.value / i.value) : 1;
  return { max, got: max * ratio, ratio, share, actual: a, ideal: i };
}

/* What four Heavens cards actually grant: four of one set gives that set's 2- and
   4-piece, two pairs give both 2-pieces, a lone pair gives one. Anything else is
   nothing, which is exactly why an unplanned inventory scores badly here. */
function loadoutSetBonus(heavensCards, char, t, p4value) {
  const counts = {};
  heavensCards.forEach(c => { if (c) counts[c.set] = (counts[c.set] || 0) + 1; });
  let value = 0, active4 = null;
  Object.keys(counts).forEach(set => {
    if (counts[set] >= 4) {
      value += bonus4Value(set, char, t, p4value) + bonus2Value(set, char, t);
      active4 = set;
    } else if (counts[set] >= 2) {
      value += bonus2Value(set, char, t);
    }
  });
  return { value, active4 };
}

/* Score one whole five-slot loadout. Used for both halves of the build score, so the
   numerator and denominator can never be computed by different rules. */
function scoreLoadout(cards, char, t, p4value) {
  const bySlot = {};
  (cards || []).forEach(c => {
    if (!c || !SLOTS.includes(c.slot)) return;
    if (!bySlot[c.slot] || cardScore(c, t) > cardScore(bySlot[c.slot], t)) bySlot[c.slot] = c;
  });
  const cardPart = SLOTS.reduce((s, sl) => s + (bySlot[sl] ? cardScore(bySlot[sl], t) : 0), 0);
  const bon = loadoutSetBonus(['Sun', 'Moon', 'Star', 'Sky'].map(sl => bySlot[sl]), char, t, p4value);
  const sp = bySlot.Space, spDef = sp ? SPACE_SETS[sp.set] : null;
  const pairs = !!(spDef && bon.active4 && spDef.pairs.indexOf(bon.active4) >= 0);
  return {
    cards: cardPart, sets: bon.value, synergy: pairs ? SPACE_PAIR_VALUE : 0,
    active4: bon.active4, pairs, filled: SLOTS.filter(sl => bySlot[sl]).length,
    total: cardPart + bon.value + (pairs ? SPACE_PAIR_VALUE : 0)
  };
}

function idealLoadout(char, t, p4value) {
  const set = (t.sets || []).filter(s => SETS[s])[0] || Object.keys(SETS)[0];
  // The perfect build's Space card pairs with the 4-piece by definition; fall back to
  // the character's preferred card if nothing pairs with that set at all.
  const spaceSet = (SPACE_SETS[t.space] && SPACE_SETS[t.space].pairs.indexOf(set) >= 0) ? t.space
    : (Object.keys(SPACE_SETS).filter(s => SPACE_SETS[s].pairs.indexOf(set) >= 0)[0] || t.space);
  const cards = SLOTS.map(sl => idealCard(sl, t, sl === 'Space' ? spaceSet : set));
  return { cards, score: scoreLoadout(cards, char, t, p4value) };
}

/* 1-100 for the cards currently equipped on `char`, or null if nothing is equipped.
   Pass `cards` to score a hypothetical loadout instead of what is equipped.

   `p4value` is deliberately NOT wired to the optimiser's 4-piece slider. That slider
   changes which loadout the optimiser picks; it must not change what a finished build is
   worth, or the same character would read one score on the roster and another on the
   Optimise tab, and two characters would only be comparable while the slider sat still.

   `idl` lets a caller pass an already-computed idealLoadout() instead of having this
   recompute one, and `t` an already-computed target() — Triage calls this once per
   (card, character) pair to price a swap against the character's real other equipped
   cards, and both only depend on the character (and P4 for idl), not on the hypothetical
   cards being scored, so recomputing them per card would be pure waste at that call
   volume. `t` matters for more than the obvious reason: `couplingFactors` memoises on
   the identity of the target object via a WeakMap, and target() hands back a fresh
   object every call for the ~28 characters running on generated archetype defaults
   (only a saved override is a stable reference) — recomputing it here would silently
   defeat that cache on every single call instead of hitting it. */
function buildScore(char, cards, p4value, lo, idl, t0) {
  const worn = cards || state.cards.filter(c => c.equipped === char.n);
  if (!worn.length) return null;
  return buildScoreOf(char, worn, p4value, lo, idl, t0);
}

/* The same score for exactly `worn`, an empty list included — this is what a marginal
   must subtract from. buildScore reports an empty board as null because there is no build
   to show, but a board with no cards is not worth zero: the stat-target and spread terms
   still credit the character's own base stats with what they reach unaided (median 7, up
   to 15 build points across the roster). A card priced against an empty board as "its
   score minus 0" was handed all of that, so whoever wore the least won every argmax —
   under Triage's "All characters", 21% of verdicts and 30% of best fits on the real
   inventory. Measure with this; display buildScore. */
function buildScoreOf(char, worn, p4value, lo, idl, t0) {
  const t = t0 || target(char);
  const P4 = p4value == null ? 55 : +p4value;
  const L = lo || charLoadout(char.n);
  const actual = scoreLoadout(worn, char, t, P4);
  const idealLo = idl || idealLoadout(char, t, P4);
  const ideal = idealLo.score;

  /* Stat targets, for the 37 characters that have them. The whole block is worth a fixed
     budget however many stats it decomposes into — "does this build satisfy what the
     character needs" is one question, and a unit with three targets should not be scored
     out of three times as much as a unit with one. Characters with no targets keep the
     three-part score unchanged. */
  const rows = breakpointRows(worn, idealLo.cards, char, t, L);
  // a target met with no cards at all is shown but not scored (see breakpointRows)
  const scored = rows.filter(r => !r.metBare);
  const bpMax = scored.length ? BREAKPOINT_VALUE : 0;
  const bpGot = scored.length
    ? BREAKPOINT_VALUE * scored.reduce((s, r) => s + r.ratio, 0) / scored.length : 0;

  /* Stat spread, through lufel's damage formula. The card-stats term above is a weighted
     sum, which treats stats as substitutes; the formula says ⓐ ATK, ⓑ damage bonus and
     ⓓ crit MULTIPLY, so a loadout that pours everything into one of them and starves
     another is worth far less than the sum suggests. This is the term that knows that. */
  const spread = spreadRow(worn, idealLo.cards, char, t, L);

  const total = actual.total + bpGot + spread.got;
  const idealTotal = ideal.total + bpMax + spread.max;
  if (!(idealTotal > 0)) return null;
  const parts = [
    { label: 'Card stats', got: actual.cards, max: ideal.cards },
    { label: 'Set bonuses', got: actual.sets, max: ideal.sets },
    { label: 'Space synergy', got: actual.synergy, max: ideal.synergy }
  ];
  if (scored.length) parts.push({ label: 'Stat targets', got: bpGot, max: bpMax });
  if (spread.max > 0) parts.push({ label: 'Damage spread', got: spread.got, max: spread.max });
  /* `score` is what everything displays: rounded, and floored at 1 so a geared character
     never reads as zero. `raw` is the same ratio before either, for callers that subtract
     two build scores from each other — a single slot is often worth only a few points, and
     rounding both ends first quantises a real difference away (and the floor at 1 makes a
     near-empty loadout's delta wrong outright). Display `score`; measure with `raw`.
     `total` is the numerator itself, unclamped — what bestPlan ranks plans by, since for
     one character the denominator is the same for every loadout. */
  return {
    score: Math.max(1, Math.min(100, Math.round(100 * total / idealTotal))),
    raw: Math.max(0, Math.min(100, 100 * total / idealTotal)),
    total, idealTotal, bpGot,
    actual, ideal, filled: actual.filled, targets: rows, spread, parts
  };
}

/* Cut so that an optimally-equipped 4000-card synthetic account (npm run scale) lands
   with the same shape it had before mains were priced at their real magnitude: about
   a tenth excellent, most good, a handful workable. Pricing mains at ~9 rolls instead
   of 3 lifted every score by about 5 points (mean 64 -> 70), so each cut moved by 5. */
const BUILD_BANDS = [
  { min: 80, label: 'excellent', cls: 'bs-hi' },
  { min: 60, label: 'good', cls: 'bs-ok' },
  { min: 40, label: 'workable', cls: 'bs-mid' },
  { min: 0, label: 'needs work', cls: 'bs-lo' }
];
const buildBand = n => BUILD_BANDS.filter(b => n >= b.min)[0];

/* bestPlan's polish (see there): plans within this many build points of the allowed leader
   try each slot's next POLISH_DEPTH same-set cards. Both measured, not tuned: 2 points already
   gives the pick that polishing every plan gives, 8 deep catches the Sky card a 4-deep pass
   missed on the synthetic account. */
const POLISH_WINDOW = 2;
const POLISH_DEPTH = 8;

function bestPlan(char, pool, opts) {
  const t = target(char);
  const heavens = ['Sun', 'Moon', 'Star', 'Sky'];
  const lo = charLoadout(char.n);
  const P4 = (opts && opts.p4value != null) ? +opts.p4value : 55;
  const policy = (opts && opts.policy) || 'pref';

  // candidate sets: the character's preferred sets, plus anything we hold >= 2 of.
  // Pool membership only, so unlike scores this never changes between iterations below.
  const counts = {};
  pool.forEach(c => { if (c.slot !== 'Space') counts[c.set] = (counts[c.set] || 0) + 1; });
  const cand = new Set(t.sets.filter(s => SETS[s]));
  Object.keys(counts).forEach(s => { if (counts[s] >= 2 && SETS[s]) cand.add(s); });
  const candArr = Array.from(cand);

  /* The objective: a plan is worth exactly what the build score will say it is worth once
     it is worn. Its total is buildScoreOf(...).total — the build score's own numerator, over
     the five cards the plan puts on, against the same perfect loadout — so cards, set
     bonuses, Space synergy, the stat targets and the damage spread are all priced by the one
     function the Roster, Triage and Headroom read, and cannot drift from it.

     Weights alone cannot express a stat target — they make stats fungible, so without that
     term a plan trades away the one stat the character must reach for generic quality — and
     the per-card sum cannot see that ⓐ ATK, ⓑ damage bonus and ⓓ crit multiply, which is
     what the spread term is for. Both terms were in here before, but on rules of their own:
     the stat target as the four Heavens cards' substats and 2-piece bonuses against a
     perfect four-card set, ignoring the base stats, weapon and mains that make up most of
     the real in-battle total, and the spread against a four-card ideal. On the real
     inventory that read Justine & Caroline's Damage Multiplier target at 29% while it was
     met in battle, kept buying Speed for Mayumi and Ailment Accuracy for Haru past their
     bars, and ranked plans the build score rated 2-3 points better below the one it picked
     (Yukari's Reconciliation 4-piece, Shun Kano's Control 4-piece, whose Space pairing it
     could not see either).

     `evalCards` takes raw cards rather than a plan's `picks`, so it prices a hypothetical
     plan and whatever is actually equipped by the same rule — Upgrades is the other caller.
     The set bonus comes from the cards, not from any plan's intent: a free slot can
     complete a pair the plan never planned for. Generic (no real-gear context), like the
     per-slot ranking below — it is what compares one finished plan against another, and
     both sides must be priced alike. The 4-piece value is the
     optimiser's slider, so at its default of 55 this is the build score exactly. */
  const idl = idealLoadout(char, t, P4);
  const evalCards = worn => {
    const b = buildScoreOf(char, (worn || []).filter(Boolean), P4, lo, idl, t);
    if (!b) return { total: 0, idealTotal: 0, bonus: 0, synergy: 0, bpBonus: 0, spreadBonus: 0 };
    return { total: b.total, idealTotal: b.idealTotal, bonus: b.actual.sets, synergy: b.actual.synergy, bpBonus: b.bpGot, spreadBonus: b.spread.got };
  };

  /* Each slot's candidates are ranked on cardScore, the build score's own card part — the
     same price every screen shows. Until Sep 2026 they were ranked against the other cards
     of the plan (realCoupleContext, iterated up to five times until the anchor stopped
     moving), a second yardstick the build score does not use: a card it rated best could
     miss the shortlist, which is how Kotone Shiomi's Star and Sky contradicted the loadout
     they sat under. Measured over the real inventory (37 characters, both pools, 'pref' and
     'force4') and the scale.js account (68, three policies), together with the polish below:
     never worse on the real inventory, up to +2.6, mean +0.01 to +0.22 per scenario; one
     loss on the synthetic account (Runa, 'stats', −0.23); and 0.7-0.9 s a roster against
     1.1-1.7 s, since the iteration went with it. The scale.js calibration moved 69.5 → 69.6,
     median and bands unchanged. */
  const runOnce = () => {

    // index: slot -> set -> cards sorted by score desc
    const idx = {}; heavens.forEach(sl => idx[sl] = {});
    const scored = pool
      .filter(c => c.slot !== 'Space')
      .map(c => ({ c, s: cardScore(c, t) }));
    scored.forEach(o => (idx[o.c.slot][o.c.set] = idx[o.c.slot][o.c.set] || []).push(o));
    heavens.forEach(sl => Object.values(idx[sl]).forEach(a => a.sort((x, y) => y.s - x.s)));
    const bestAny = {};
    heavens.forEach(sl => {
      const all = scored.filter(o => o.c.slot === sl).sort((x, y) => y.s - x.s);
      bestAny[sl] = all[0] || null;
    });

    /* The Space card a plan would wear, chosen before the plan is priced so the plan's total
       includes it — a Space card's pairing is worth SPACE_PAIR_VALUE and its substats feed the
       stat targets and the spread, and a plan priced without them could not tell a 4-piece
       with a pairing card in the pool from a 2+2 without one (Shun Kano's Control 4-piece lost
       to a 2+2 that way). The rule is the one the final pick always used:
       - Once a 4-piece is active, only Space sets that pair with it — a raw-score card from a
         set that does not pair would drop the pairing bonus the moment it is equipped. Falls
         back to the whole pool only if none pair, so the table is never empty.
       - Under 'pref'/'force4' the Heavens 4-piece is held to the character's literal
         preferred set(s) (see the policy branch below), and the Space slot honours the same
         rule for its own preferred set, so a lower-rolled Trust card is not passed over for a
         higher-rolled Growth card just because it scores better. 'any4'/'stats' force
         neither. Falls back to any pairing set if no preferred card pairs.
       Memoised per active 4-piece: every plan without one shares a single answer. */
    const spaceScored = pool.filter(c => c.slot === 'Space')
      .map(c => ({ c, s: cardScore(c, t), pref: c.set === t.space, pairs: false }))
      .sort((a, b) => b.s - a.s);
    spaceScored.forEach(o => { o.total = o.s; });
    const spaceMemo = new Map();
    const spaceChoice = active4 => {
      if (spaceMemo.has(active4)) return spaceMemo.get(active4);
      const paired = !active4 ? [] : spaceScored
        .filter(o => SPACE_SETS[o.c.set] && SPACE_SETS[o.c.set].pairs.includes(active4))
        .map(o => Object.assign({}, o, { pairs: true, total: o.s + SPACE_PAIR_VALUE + (o.pref ? 4 : 0) }))
        .sort((a, b) => b.total - a.total);
      const preferSpace = (policy === 'pref' || policy === 'force4') ? paired.filter(o => o.pref) : [];
      const list = preferSpace.length ? preferSpace : paired.length ? paired : spaceScored;
      spaceMemo.set(active4, list);
      return list;
    };

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

    /* A 2+2 plan is generated once per set ordering, and a free pick can land on a loadout
       already listed, so identical loadouts are collapsed BEFORE pricing, keeping the first
       generated — which is the one the stable sort used to keep when this ran after — so
       each distinct loadout is priced once. */
    const seen = new Set();
    let complete = plans.filter(p => {
      if (!p.complete) return false;
      const key = heavens.map(sl => p.picks[sl].c.id).sort().join('|');
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    complete.forEach(p => {
      const cards = heavens.map(sl => p.picks[sl].c);
      p.active4 = loadoutSetBonus(cards, char, t, P4).active4;
      p.space = spaceChoice(p.active4)[0] || null;
      Object.assign(p, evalCards(p.space ? cards.concat([p.space.c]) : cards));
    });

    complete.sort((a, b) => b.total - a.total);

    /* Set policy. Left to pure stat maximisation the optimiser will nearly always
       drop set bonuses, because an unconstrained pick from the whole inventory beats
       one restricted to a single set. That is rarely how anyone actually plays, so by
       default we honour the character's preferred sets and show what it costs. */
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

    /* Polish. A plan takes each set's top card per slot, and a card's own score cannot see the
       stat targets or whether ATK, damage bonus and crit stay balanced across the five cards —
       the build score can, so the next card of the same set sometimes builds higher (Kotone
       Shiomi's Sky, Sep 2026: 1.25 points). So every allowed plan within POLISH_WINDOW build
       points of the leader tries each slot's next POLISH_DEPTH same-set cards, its Space card
       included, keeping any swap that raises the build score; then the plans are re-ranked. A
       same-set swap changes no set count, so a plan's set bonus and Space pairing stand.

       Measured before it shipped (Sep 2026), against the real inventory and the scale.js
       account: polishing every plan instead gives the same pick in every scenario at 15-20x
       the cost; the winner alone (the pass this replaced, 4 deep, Heavens only) missed Space
       cards — Starlight Ren's and Aran's losses — and plans that win only once polished, as
       Tropical Motoha's Virtue 4-piece. The window is measured on the ALLOWED leader: taken on
       the overall one, a 'force4' run whose 4-pieces all sat 2 points under a 2+2 polished none
       of them. Brute-forcing every combination of each slot's top six (an older experiment)
       found at most 1 point beyond a single same-set swap, so one pass is enough. */
    const bar = allowed.length ? allowed[0].total - POLISH_WINDOW * allowed[0].idealTotal / 100 : Infinity;
    allowed.filter(p => p.total >= bar).forEach(p => {
      const wornWith = over => heavens.map(sl => (over[sl] || p.picks[sl]).c)
        .concat((over.Space || p.space) ? [(over.Space || p.space).c] : []);
      heavens.forEach(sl => {
        ((idx[sl] || {})[p.picks[sl].c.set] || []).slice(0, POLISH_DEPTH).forEach(o => {
          if (o.c === p.picks[sl].c) return;
          const e = evalCards(wornWith({ [sl]: o }));
          if (e.total > p.total + 1e-9) { p.picks = Object.assign({}, p.picks, { [sl]: o }); Object.assign(p, e); }
        });
      });
      if (p.space) spaceScored.filter(o => o.c.set === p.space.c.set).slice(0, POLISH_DEPTH).forEach(o => {
        if (o.c === p.space.c) return;
        const e = evalCards(wornWith({ Space: o }));
        // a copy: spaceChoice's entries are shared between plans
        if (e.total > p.total + 1e-9) { p.space = Object.assign({}, p.space, { c: o.c, s: o.s }); Object.assign(p, e); }
      });
    });
    // Re-rank, and collapse any two plans the polish turned into the same four cards.
    const kept = new Set();
    const firstOf = list => list.sort((a, b) => b.total - a.total).filter(p => {
      const key = heavens.map(sl => p.picks[sl].c.id).sort().join('|');
      if (kept.has(key)) return false;
      kept.add(key); return true;
    });
    const unique = new Set(firstOf(complete.slice()));
    complete = complete.filter(p => unique.has(p)).sort((a, b) => b.total - a.total);
    allowed = allowed.filter(p => unique.has(p)).sort((a, b) => b.total - a.total);

    const best = allowed[0] || null;
    const statMax = complete[0] || null;

    // The Space card is the one the winning plan was priced with (see spaceChoice above).
    const spacePool = spaceChoice(best ? best.active4 : null);
    const space = best ? best.space : (spacePool[0] || null);

    return {
      best, statMax,
      alternatives: complete.filter(p => p !== best).slice(0, 4),
      incomplete: plans.filter(p => !p.complete && t.sets.includes(p.sets[0])),
      // the polish can pick a Space card from further down the list, so skip it by identity
      space, spaceAlts: spacePool.filter(o => !space || o.c !== space.c).slice(0, 2), idx, scored
    };
  };

  /* Nothing a plan is ranked on depends on the cards worn, so one run is the answer. The
     per-slot ranking used to read the plan's other cards, and was iterated up to five times
     against its own recommendation until it stopped moving (equip plan A, watch it recommend
     B); with the ranking context-free there is nothing to iterate. */
  return Object.assign({ t, loadoutTotal: evalCards }, runOnce());
}

/* ============================ ui ============================ */
/* Benched means "I own it but am not building it" — everywhere that reads ownedChars()
   should treat a benched character exactly like an unowned one (optimiser dropdown,
   Triage's owned scope, Upgrades). It stays flagged `owned` underneath so un-benching
   does not lose targets or loadout, only `benched` toggles what counts. */
function ownedChars() { return CHARACTERS.filter(c => state.chars[c.n].owned && !state.chars[c.n].benched); }
function poolFor(mode, rar, exclude) {
  return state.cards.filter(c =>
    c.rarity >= rar && (mode === 'all' || !c.equipped || c.equipped === exclude) &&
    (!c.locked || c.equipped === exclude));
}

/* A section's how-to-read notes, folded: `gist` stays visible as the summary line and `body`
   opens on click. The notes are the tool's honesty about what a number means, so none is
   deleted — but a repeat reader should see the answer, not a page of prose above it (the
   Optimise tab carried 816 words of it, the Loadout popup 328 of its 578). Native <details>,
   so it needs no script and works from the keyboard. Both arguments are HTML the caller has
   already escaped, like every other template here. */
function explainHtml(gist, body) {
  return `<details class="explain"><summary>${gist}</summary><div class="body">${body}</div></details>`;
}

/* A substat's value with its unit — "%" unless the stat is flat or its name already carries
   the sign: ATK% 3.5, Crit Rate 7.9%, Speed 5.6, HP 307. One rule for every table and card;
   the tables used to print bare numbers, so "Crit Rate 7.9" and "Speed 7.9" looked alike. */
function subVal(s) {
  const def = SUBSTATS[s.stat] || {};
  return s.value + (def.flat || /%$/.test(s.stat) ? '' : '%');
}

/* A card's substats on one line, the way every table prints them. With a character's target
   `t`, each is coloured by what it is worth to them — the coupled weight cardScore prices it
   at, so the colour agrees with the score beside it: 6 and up reads good, 1 or less faded.
   `hi` names stats to highlight instead (the Level 0 table's best-case upgrade target). */
/* Each substat is kept whole (nowrap) and the line may break after a separator (<wbr>); with
   no break point at all the line was one unbreakable run, and a table holding two of them
   (Weakest slots: Equipped and Available now) came out wider than the page. */
function subsInlineHtml(card, t, hi) {
  const f = t ? couplingFactors(t, card.slot, card.main) : null;
  return `<span class="subs">${(card.subs || []).map(s => {
    const w = f ? (t.w[s.stat] || 0) * cf(f, s.stat) : null;
    const cls = hi && hi.includes(s.stat) ? 'hi' : w == null ? '' : w >= 6 ? 'good' : w <= 1 ? 'bad' : '';
    return `<span class="s${cls ? ' ' + cls : ''}">${esc(s.stat)} ${esc(subVal(s))}</span>`;
  }).join('<span class="sep">·</span><wbr>')}</span>`;
}

/* One card drawn as a block. The Optimise plan, its Space pick and the Loadout popup's five
   slots all use it, so a card looks the same wherever it appears: slot, set and rarity, the
   out-of-100 figure and headroom when `o.score` (its cardScore for `t`) is given, the main
   with its level, then the substats coloured as subsInlineHtml colours them. `o.tags` go in the
   header, `o.mainTag` under the main, `o.body` after the substats and `o.foot` at the bottom;
   `o.rolls` adds each substat's roll value. */
function cardBlockHtml(card, t, o) {
  o = o || {};
  const slot = card.slot;
  const f = t ? couplingFactors(t, slot, card.main) : null;
  const subs = (card.subs || []).map(s => {
    const w = f ? (t.w[s.stat] || 0) * cf(f, s.stat) : null;   // cf: a capped Crit Rate's 0 is an answer, not "no coupling"
    const cls = w == null ? '' : w >= 6 ? 'good' : w <= 1 ? 'bad' : '';
    const rv = o.rolls ? ` <span class="muted tiny">(${(s.value / maxRoll(s.stat, slot)).toFixed(1)}r)</span>` : '';
    return `<div class="sub ${cls}"><span>${esc(s.stat)}</span><b>${esc(subVal(s))}${rv}</b></div>`;
  }).join('');
  return `<div class="lo${o.cls ? ' ' + o.cls : ''}">
    <h4><span class="slot ${slot}">${slot.slice(0, 3)}</span> ${esc(card.set)}
      <span class="tag r${card.rarity}">${card.rarity}★</span>${o.tags || ''}
      ${o.score != null && t ? `<span style="margin-left:auto;white-space:nowrap">${cardPctHtml(o.score, slot, t)}</span>` : ''}</h4>
    <div class="lo-mainrow">
      <div class="sub" style="border:none;padding:0"><span class="muted">Main · Lv${card.level}</span><b>${esc(card.main)}</b></div>
      ${o.mainTag != null ? `<div class="lo-tagrow">${o.mainTag || '&nbsp;'}</div>` : ''}
    </div>
    ${subs || '<div class="tiny muted">No substats recorded.</div>'}
    ${o.body || ''}
    ${o.foot ? `<div style="margin-top:8px">${o.foot}</div>` : ''}
  </div>`;
}

/* The dropdown normally lists owned characters only — the tab exists to gear
   characters you actually have. `forceSelect` lets a caller (the roster card
   click-through) land on an unowned character anyway, without changing what
   everyone else sees the rest of the time: it is spliced in as one extra option
   rather than switching the whole list to "all characters", and only fires on an
   explicit request — a bare renderOpt() must keep behaving exactly as before, or
   every other caller's "leave the previous selection where the browser puts it"
   fallback silently starts forcing a stale, possibly-unowned name back in. */
function renderOpt(forceSelect) {
  const sel = $('#optChar');
  const keep = sel.value;
  const owned = ownedChars();
  const list = owned.length ? owned : CHARACTERS;
  const extra = forceSelect && !list.some(c => c.n === forceSelect) ? CHARACTERS.filter(c => c.n === forceSelect) : [];
  sel.innerHTML = (owned.length ? '' : '<option disabled>— you have not marked any characters as owned —</option>') +
    extra.map(c => `<option value="${esc(c.n)}">${esc(c.n)}${c.a ? ' (' + esc(c.a) + ')' : ''} — not owned</option>`).join('') +
    list.map(c => `<option value="${esc(c.n)}">${esc(c.n)}${c.a ? ' (' + esc(c.a) + ')' : ''}</option>`).join('');
  if (forceSelect) sel.value = forceSelect;
  else if (keep && list.some(c => c.n === keep)) sel.value = keep;
}

/* Roster card click-through: land on the Optimiser tab with this character loaded,
   which is where the stat bars, recommended loadout and slot alternatives already
   live — no separate detail view to keep in sync with that one. The selection is made
   before the tab opens, and the deferred run showTab would do is claimed here, so the
   optimiser runs once, for this character. */
function openCharacterDetail(name) {
  optForced = name;
  renderOpt(name);
  optStale = false;
  showTab('opt');
  runOpt();
}

/* Equip one card into one slot on one character, reusing the same swapCard the Upgrades
   tab uses — it already handles unequipping whoever had either end of the trade. Renders
   an "Unequip" button, same size as Equip/Take it but green, when the card is already
   there, so the slot can be cleared without leaving the tab. */
function slotEquipHtml(charName, slotName, card) {
  if (card.equipped === charName) {
    return `<button class="unequip tiny slotUnequip" data-card="${esc(card.id)}">Unequip</button>`;
  }
  return `<button class="ghost tiny slotEquip" data-char="${esc(charName)}" data-slot="${esc(slotName)}"
    data-card="${esc(card.id)}">${card.equipped ? 'Take it' : 'Equip'}</button>`;
}

/* The "on X" tag for a card worn by someone else, carrying what taking it costs X — giverLoss,
   the same pricing as the Upgrades tab's trades — so a recommendation that is really a trade
   does not read as free. `used` is the plan's own cards (none of them can refill X's slot). */
function onTagHtml(card, charName, used, minR) {
  const by = card.equipped && card.equipped !== charName ? card.equipped : null;
  if (!by) return '';
  const loss = giverLoss(charDef(by), [card], used, minR);
  return `<span class="tag" title="Currently equipped on ${esc(by)} — swapping unequips it from them, which costs them ${esc(loss.toFixed(1))} build points even after they put back their best free card of this slot (same set first; a full Optimise run may find them better)">on ${esc(by)} · ${esc(gainStr(-loss))}</span>`;
}

/* "Equip only this: +1.3" on a recommended card not yet worn — the build score change of that one
   Equip click, everything else worn left as it is, the same marginal as an Upgrades row. The
   headline is the whole loadout, which is not the sum of these: a set switch is mostly the 4-piece
   bonus, which lands only with the fourth card, so one card of it can read negative on its own. */
function aloneGainHtml(gain) {
  if (gain == null) return '';
  return `<span title="Build score change from equipping only this card, the rest of what is worn as it is. The headline gain is the whole loadout and is not the sum of these: a 4-piece bonus lands only with its fourth card.">equip only this: <b class="${gain >= UPGRADE_MIN_GAIN ? 'gainpos' : ''}">${esc(gainStr(gain))}</b></span>`;
}

function planCardHtml(slot, o, t, charName, trade, alone) {
  if (!o) return `<div class="lo empty"><h4><span class="slot ${slot}">${slot.slice(0,3)}</span> ${slot}</h4>
    <div class="tiny muted">Nothing in inventory for this slot.</div></div>`;
  const c = o.c;
  const ownedBy = c.equipped && c.equipped !== charName ? c.equipped : null;
  const wanted = mainList(t, c.slot);
  const fixed = SLOT_INFO[c.slot].fixed;
  const rank = wanted.indexOf(c.main);
  /* Every listed main is on target — lufel names alternatives, not a single answer —
     but say which one was taken when there was a choice, because that is what shifts
     the substats the character then wants. (Which alternative a card took decides what its
     substats are worth, which is why cardBlockHtml colours them by the coupled weights —
     the same numbers that scored it.) */
  const mainTag = fixed ? ''
    : !wanted.length ? '<span class="tag hit" title="Lufelnet recommends no particular main for this slot">any main</span>'
    : rank === 0 ? '<span class="tag hit">on target</span>'
    : rank > 0 ? `<span class="tag hit">on target</span> <span class="tiny muted">alternative to ${esc(wanted[0])}</span>`
    : `<span class="tag miss">wants ${esc(wanted.join(' or ')) || '—'}</span>`;
  const where = [c.equipped === charName ? 'already equipped here' : aloneGainHtml(alone),
    ownedBy ? (trade ? onTagHtml(c, charName, trade.used, trade.minR)
      : `<span class="tag" title="Currently equipped on ${esc(ownedBy)} — swapping unequips it from them">on ${esc(ownedBy)}</span>`) : ''].filter(Boolean).join(' · ');
  return cardBlockHtml(c, t, { score: cardScore(c, t), rolls: true, mainTag,
    body: where ? `<div class="tiny muted" style="margin-top:6px">${where}</div>` : '',
    foot: slotEquipHtml(charName, c.slot, c) });
}

/* Level-0 cards worth a look before spending resources levelling them: their potential
   score if every remaining upgrade roll landed, in the best case, on their strongest
   already-rolled substat for this character. Gated to the same set the recommended plan
   is actually banking on, per slot — same reasoning as the alternatives table above, a
   pick outside that set would cost the set bonus the moment it's equipped, and the user
   plays almost exclusively in-set anyway. `r` is the bestPlan result so this can reuse
   its per-slot required-set logic instead of re-deriving it. */
function level0Html(t, r, pool) {
  const heavens = ['Sun', 'Moon', 'Star', 'Sky'];
  const rowsFor = (sl, cands, curScore) => cands
    .map(c => ({ c, now: cardScore(c, t), pot: potentialCardScore(c, t) }))
    .sort((a, b) => b.pot - a.pot)
    .slice(0, 3)
    .map((o, i) => ({ sl, first: i === 0, curScore, ...o }));

  const heavenRows = heavens.flatMap(sl => {
    const reqSet = r.best && r.best.picks[sl] && r.best.sets.includes(r.best.picks[sl].c.set)
      ? r.best.picks[sl].c.set : null;
    const cands = pool.filter(c => c.slot === sl && c.level === 0 && (!reqSet || c.set === reqSet));
    return rowsFor(sl, cands, r.best.picks[sl] ? cardScore(r.best.picks[sl].c, t) : 0);
  });
  const spaceReq = r.space && r.space.pairs ? r.space.c.set : null;
  const spaceCands = pool.filter(c => c.slot === 'Space' && c.level === 0 && (!spaceReq || c.set === spaceReq));
  const rows = heavenRows.concat(rowsFor('Space', spaceCands, r.space ? cardScore(r.space.c, t) : 0));
  if (!rows.length) return '';

  const body = rows.map(o => {
    const worthIt = o.pot > o.curScore;
    // Whichever substat(s) the "Potential" column assumes every remaining upgrade
    // piles onto — the reason this card, and not some other level-0 card, made the
    // list. Highlighted in the substat list too, rather than only named separately,
    // so it reads against the card's actual rolled values instead of in isolation. A
    // substat the card does not have yet is the fourth its first upgrade would mint.
    const up = bestCaseUpgrades(o.c, t), best = up.onto;
    const minted = up.mint.map(x => x.stat);
    const subs = subsInlineHtml(o.c, null, best);
    const bestCell = best.length
      ? `<b style="color:var(--ok)">${best.map(s => esc(s) + (minted.includes(s) ? ' (new 4th substat)' : '')).join(' / ')}</b>` +
        minted.filter(s => !best.includes(s)).map(s => ` <span class="muted">· first upgrade adds ${esc(s)}</span>`).join('')
      : '<span class="muted">nothing this character wants</span>';
    return `<tr><td>${o.first ? `<span class="slot ${o.sl}">${o.sl.slice(0,3)}</span>` : ''}</td>
      <td>${esc(o.c.set)} <span class="tag r${o.c.rarity}">${o.c.rarity}★</span></td>
      <td class="tiny">${esc(o.c.main)}</td>
      <td class="tiny muted">${subs}</td>
      <td class="tiny">${bestCell}</td>
      <td class="right score muted">${cardPct(o.now, o.sl, t)}</td>
      <td class="right tiny muted">${cardHeadroom(o.now, o.sl, t).toFixed(1)}</td>
      <td class="right score">${cardPct(o.pot, o.sl, t)}</td>
      <td class="tiny">${worthIt ? '<span class="tag hit">could beat what\'s recommended</span>'
        : '<span class="muted">even maxed, not an upgrade</span>'}</td>
      <td><button class="sm ghost" data-edit-l0="${o.c.id}">Edit</button></td></tr>`;
  }).join('');
  return `<div class="panel"><h2>Level 0 cards worth checking before you level anything</h2>
    ${explainHtml(`<b>Potential</b> is the best case: every upgrade this card has left landing at maximum on the substat worth
      most here. <b>could beat what's recommended</b> means that ceiling clears the card picked above — worth levelling to find out.`,
      `<p>It is the best case the card could possibly reach, not a prediction of what it will roll. A card minted with three
      substats gains a fourth on its first upgrade, and the best case takes that to be the most valuable stat the card does not
      already carry; after that, upgrades only make an existing substat bigger, so a card with all four substats and nothing
      this character wants stays put no matter how many rolls are left.</p>
      <p>Restricted to the set the recommendation above is actually using per slot, so a candidate here never costs that set
      bonus the moment it's equipped. <b>Now</b> is what the card scores today, out of 100 for a perfect card in that slot, and
      <b>Headroom</b> the raw points that perfect card would add over it. Anything short of "could beat" is safe to feed even in
      the best case. <b>Best substat</b> is highlighted in the substats and is whichever substat those future upgrades are assumed
      to land on — a fourth the card does not have yet is marked as new, and tied stats both show, since an upgrade could land
      on either.</p>`)}
    <div style="margin-top:10px"></div>
    <table><thead><tr><th>Slot</th><th>Set</th><th>Main</th><th>Substats</th><th>Best substat</th>
      <th class="right">Now</th><th class="right" title="Raw points a perfect card for this slot would add over this one today">Headroom</th><th class="right">Potential (best case)</th><th></th><th></th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

/* Which of lufel's damage factors is starved. The Damage spread tile above says a build
   is unbalanced; this says which way, which is the part the user can act on. Shown as
   each factor against what a perfect build for the same character reaches — the factors
   multiply, so the smallest percentage here is where the next roll is worth the most.
   Shared by the Optimiser tab and the roster's Loadout popup — both score a `buildScore`
   result and this is the part of it that knows the numbers behind the spread term. */
function spreadHtml(b) {
  if (!b || !b.spread || !(b.spread.max > 0) || !b.spread.actual) return '';
  const a = b.spread.actual, i = b.spread.ideal;
  const rows = [
    ['ⓐ ATK', a.atk, i.atk, 'base and weapon ATK scaled by ATK%, plus flat ATK'],
    ['ⓑ Damage bonus', a.dmg, i.dmg, '100% + Damage Multiplier'],
    ['ⓓ Crit', a.crit, i.crit, '100% + Crit Rate × (Crit Multiplier − 100%)']
  ].map(([label, got, max, note]) => {
    // A single factor can exceed the reference build's — the ideal spends its rolls on
    // the four best stats, and a real card can carry more of one than that. The raw
    // numbers still show it; the percentage caps so nothing reads as "over 100% geared".
    const pct = Math.min(100, max > 0 ? Math.round(100 * got / max) : 100);
    const fmt = v => v >= 100 ? Math.round(v) : v.toFixed(3);
    return `<tr><td><b>${label}</b> <span class="tiny muted">${esc(note)}</span></td>
      <td class="right mono tiny">${fmt(got)}</td>
      <td class="right mono tiny muted">of ${fmt(max)}</td>
      <td style="min-width:120px"><span class="tag ${buildBand(pct).cls}">${pct}%</span>
        <div class="bar"><i style="width:${Math.min(100, pct)}%"></i></div></td></tr>`;
  }).join('');
  return `<div class="targets">
    <h3>Damage factors <span class="tiny muted">— Lufelnet's damage formula</span></h3>
    <table><thead><tr><th>Factor</th><th class="right">Yours</th>
      <th class="right">Perfect build</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    ${explainHtml('Damage is these <b>multiplied together</b>, so the lowest one is where your next good roll is worth the most.',
      `That is also why stacking a stat you are already deep in scores worse than filling the gap. Only the three
      factors your cards move are shown; enemy defence, skill, weakness and party buffs are the same whatever you
      equip. A main stat counts at its real magnitude for the card's level (about nine maximum rolls at max level) —
      these are ratios for comparing loadouts, not damage predictions.`)}
  </div>`;
}

/* Lufelnet's recommended stats, for the characters that have them. Two different
   numbers sit side by side here and conflating them would be misleading, so they are
   labelled apart: the target is an in-battle TOTAL (base stat + weapon + My Palace +
   cards), which this tool cannot compute; the progress bar is the part the cards
   supply through substats and 2-piece bonuses, against what a perfect build supplies.
   Shared by the Optimiser tab and the roster's Loadout popup — see spreadHtml above. */
function targetHtml(b, other, hypothetical) {
  if (!b || !b.targets || !b.targets.length) return '';
  const tierOrder = ['LV10', 'LV10+5', 'LV12', 'LV12+5', 'LV13', 'LV13+5'];
  const fmt = (v, pct) => v == null ? '—' : (pct ? v + '%' : String(v));
  const tiers = tierOrder.filter(k => b.targets.some(r => r.tiers[k] != null));
  const rows = b.targets.map(r => {
    const band = buildBand(Math.round(100 * r.ratio));
    const alt = other && (other.targets || []).filter(o => o.sub === r.sub)[0];
    const num = v => v.toFixed(r.pct ? 1 : 0) + (r.pct ? '%' : '');
    const why = r.metBare ? 'Met with no cards'
      : r.exact ? `Your cards close this share of the gap from ${num(r.bare)} with no cards to ${num(r.effBar)}${r.shortOfBar ? ', the most a perfect build reaches' : ''}`
      : "This share of a perfect build's card supply of the stat";
    return `<tr>
      <td><b>${esc(r.stat)}</b></td>
      ${tiers.map(k => `<td class="right mono tiny" ${k === r.tierKey ? 'style="color:var(--ok);font-weight:700"' : ''}>${fmt(r.tiers[k], r.pct)}</td>`).join('')}
      <td style="min-width:190px">
        <div class="tiny"><span class="tag ${band.cls}" title="${esc(why)}">${Math.round(100 * r.ratio)}%</span>
          ${r.exact
            ? `<b class="mono">${r.total.toFixed(r.pct ? 1 : 0)}</b>
               <span class="muted">of ${r.bar}${r.pct ? '%' : ''}</span>
               ${r.total >= r.bar ? '<span class="tag hit">met</span>'
                 : `<span class="muted">— short ${(r.bar - r.total).toFixed(r.pct ? 1 : 0)}</span>`}`
            : `<span class="muted">${r.got.toFixed(1)} of ${r.want.toFixed(1)} from cards</span>`}
          ${r.metBare ? `<span class="tag" title="Met with no cards at all (${r.bare.toFixed(r.pct ? 1 : 0)}${r.pct ? '%' : ''} on this setup), so it is not scored">met without cards</span>` : ''}
        </div>
        <div class="bar"><i style="width:${Math.round(100 * r.ratio)}%"></i></div></td>
      <td class="right tiny muted">${alt ? Math.round(100 * alt.ratio) + '%' : ''}</td>
    </tr>`;
  }).join('');
  const anyExact = b.targets.some(r => r.exact);
  const anyShort = b.targets.some(r => r.exact && r.shortOfBar);
  const anyMissing = b.targets.some(r => !r.exact);
  const approx = b.targets.some(r => r.approx);
  return `<div class="targets">
    <h3>Recommended stats <span class="tiny muted">— Lufelnet, by skill-level tier</span></h3>
    <table><thead><tr><th>Stat</th>${tiers.map(k => `<th class="right">${k}</th>`).join('')}
      <th>${anyExact ? 'Your in-battle total' : 'From your cards'}</th>
      <th class="right">${other ? 'If you swap' : ''}</th></tr></thead>
    <tbody>${rows}</tbody></table>
    ${explainHtml(`The <span style="color:var(--ok);font-weight:700">highlighted</span> column is the tier scored now.${anyExact
        ? ' The percentage is how much of the gap between your no-card total and the target your cards close.' : ''}`,
      `<p>Reaching this character's Awareness threshold (usually 3, sometimes 5) unlocks the higher skill-level cap over
      the lower one, and Mindscape unlocked adds its own further "+5" bump on top; a character who only ever publishes
      one family (no low/high split) always uses that one. Both are set from this character's <b>Setup</b> (Awareness,
      Mindscape). These are <b>in-battle totals</b>${anyExact ? ', so base stats earn nothing on their own' : ''}.</p>
      <p>${anyExact
        ? `Yours counts base stats at the level and ascension set under <b>Setup</b>, the weapon
           at its refinement, Mindscape nodes, Awareness's universal HP/ATK/DEF percentage plus any
           level that grants a further flat stat, and your ${hypothetical ? 'recommended ' : ''}cards'
           substats, main stats and 2-piece bonuses.
           <b>My Palace and party buffs are not counted</b>, so the figure is a floor — you may already
           be clearing a target this says you miss.`
        : `Yours shows only what the cards supply, because ${anyMissing
            ? 'some equipped cards have no scanned main stat value yet'
            : 'this character has no stat block'}.`}</p>
      ${anyShort ? `<p><b>Marked short of the stage number:</b> even a flawless build on this setup
        cannot reach it, so the rest has to come from party buffs or My Palace. The score is measured
        against what is actually reachable, not against a number nothing can hit.</p>` : ''}
      ${b.targets.some(r => r.metBare) ? `<p><b>Met without cards:</b> this character clears that target on this
        setup before any card is worn, so no loadout can earn or lose it, and the build score leaves it out
        rather than hand every loadout the same free points.</p>` : ''}
      ${approx ? '<p>Lufelnet does not publish Lv100 figures for this character, so Lv80 numbers are used.</p>' : ''}`)}
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

  /* Plans on the build score's own 0-100 scale. A plan's total is the build score's numerator
     (see bestPlan), so dividing it by the perfect total the build score divides by is exactly
     the build score the plan would earn at the default 4-piece value of 55; at another value
     it is that setting's version, still one character's plans on one scale. They used to show
     raw (643.6, "598.5 / -45.2") beside the /100 score, a second scale for the same thing. */
  const pts = p => p.idealTotal > 0 ? 100 * p.total / p.idealTotal : 0;
  const bestPts = pts(r.best);
  const planSlots = p => p.kind === '4pc' || p.kind === 'raw' ? '' :
    ' <span class="muted tiny">(' + ['Sun','Moon','Star','Sky']
      .filter(sl => p.picks[sl].c.set === p.sets[0]).join('+') + ' carry ' + esc(p.sets[0]) + ')</span>';
  const alt = r.alternatives.map(p =>
    `<tr><td>${esc(p.label)}${planSlots(p)}</td><td class="right score">${pts(p).toFixed(1)}</td>
     <td class="right muted tiny">${gainStr(pts(p) - bestPts)}</td></tr>`).join('');
  const cost = (r.statMax && r.statMax !== r.best)
    ? `<p class="tiny muted" style="margin-top:8px">Ignoring set bonuses entirely would score
       <b>${pts(r.statMax).toFixed(1)}</b> (${gainStr(pts(r.statMax) - bestPts)})
       using ${esc(r.statMax.label.toLowerCase())}. Switch <b>Set policy</b> to compare.</p>` : '';
  const missing = r.incomplete.map(p =>
    `<tr><td>${esc(p.label)}</td><td colspan="2" class="tiny" style="color:#e87a5c">missing ${p.missing.join(', ')}</td></tr>`).join('');

  /* A Space card grants a different effect per active 4-piece set, so quote only the
     clause that is actually firing. With no 4-piece live nothing fires at all, and the
     full list is the useful thing to show — it says what this card is waiting for. */
  function spaceEffectText(spaceName, plan) {
    const eff = (SPACE_SETS[spaceName] || {}).effects || {};
    const active = plan && plan.kind === '4pc' ? plan.sets[0] : null;
    if (active && eff[active]) return `With ${active} 4-piece: ${eff[active]}`;
    const all = Object.keys(eff);
    if (!all.length) return '';
    return `Needs a 4-piece to do anything. ${all.map(s => `${s}: ${eff[s]}`).join('  ')}`;
  }

  /* Build score: where this character currently stands, and where the recommendation
     below would put them. Both sides run through buildScore, so the comparison is a
     like-for-like percentage of the same perfect loadout. */
  const recCards = ['Sun', 'Moon', 'Star', 'Sky'].map(sl => r.best.picks[sl].c)
    .concat(r.space ? [r.space.c] : []);
  const worn = state.cards.filter(cd => cd.equipped === name);
  const lo = charLoadout(name);
  const idealLo = idealLoadout(char, t, 55);
  const now = buildScore(char, worn, 55, lo, idealLo, t);
  const rec = buildScore(char, recCards, 55, lo, idealLo, t);
  const partHtml = b => b.parts.map(p => {
    const pct = p.max > 0 ? Math.round(100 * p.got / p.max) : 100;
    return `<div class="p ${buildBand(pct).cls}"><div class="tiny muted">${esc(p.label)}</div>
      <div><span class="score">${p.got.toFixed(0)}</span>
        <span class="tiny muted">of ${p.max.toFixed(0)} · ${pct}%</span></div>
      <div class="bar"><i style="width:${Math.min(100, pct)}%"></i></div></div>`;
  }).join('');
  const nowBand = now ? buildBand(now.score) : null;
  /* Unrounded, as every other gain on the page: from the two rounded scores 76.1 → 77.6 read "+2". */
  const delta = now && rec ? rec.raw - now.raw : null;
  // Build points one recommended card adds on its own, worn in place of whatever is in its slot now.
  const nowRaw = (buildScoreOf(char, worn, 55, lo, idealLo, t) || { raw: 0 }).raw;
  const aloneGain = card => card.equipped === name ? null
    : (buildScoreOf(char, worn.filter(x => x.slot !== card.slot).concat([card]), 55, lo, idealLo, t) || { raw: 0 }).raw - nowRaw;
  // Build points a card would move the recommendation by in place of its slot's pick (the table below).
  const recEval = r.loadoutTotal(recCards);
  const vsPick = (sl, card) => {
    const e = r.loadoutTotal(recCards.map(c => c.slot === sl ? card : c));
    return e.idealTotal > 0 ? 100 * (e.total - recEval.total) / e.idealTotal : 0;
  };

  /* Cards this loadout would take off someone else, and what that costs them (giverLoss, as
     on the Upgrades tab: after each puts back their best free card of the slot). On "All
     cards" a recommendation can be a trade, and "(+5)" alone reads as free. Priced per giver,
     jointly over everything taken from them. */
  const trade = { used: new Set(recCards.map(c => c.id)), minR: +$('#optRarity').value };
  const takenFrom = {};
  recCards.forEach(c => { if (c.equipped && c.equipped !== name) (takenFrom[c.equipped] = takenFrom[c.equipped] || []).push(c); });
  const givers = Object.keys(takenFrom);
  const tradeLoss = givers.reduce((s, g) => s + giverLoss(charDef(g), takenFrom[g], trade.used, trade.minR), 0);
  /* The pool defaults to "Only unequipped cards" (the user's choice, Oct 2026; it was "All
     cards" before), but on "All cards" the trade is said up front, beside the headline, rather than in small print under a green "+3": on the real inventory
     Kumi's recommendation read +3 while taking three cards off two characters, net -25.1. */
  const net = now && rec && givers.length ? rec.raw - now.raw - tradeLoss : null;
  const losing = net != null && net < 0;
  const tradeHtml = givers.length ? `<div class="notice trade ${losing ? 'bad' : 'info'}">
      ${losing ? '<b>This trade loses build points overall.</b> ' : ''}It takes ${givers.map(g => `${takenFrom[g].length} card${takenFrom[g].length > 1 ? 's' : ''} off ${esc(g)}`).join(' and ')},
      which costs them <b>${esc(tradeLoss.toFixed(1))}</b> build points
      after they put back their best free cards${net != null ? ` — net <b>${esc(gainStr(net))}</b> for your account` : ''}.
      ${$('#optPool').value !== 'free' ? '<button class="sm" id="optNoTrade" style="margin-left:6px">Show a loadout that takes nothing</button>' : ''}</div>` : '';
  const setupNote = setupIsDefault(name) ? `<p class="tiny muted" style="margin:0 0 12px">${esc(DEFAULT_SETUP_NOTE)}
      <button class="linky" id="optSetup">Set ${esc(char.n)}'s setup</button></p>` : '';
  const headline = !rec ? '' : now
    ? `Build score <span class="big">${now.score}</span><span class="arrow">→</span><span class="big">${rec.score}</span>
       ${delta >= 0.05 ? `<span class="${losing ? 'muted' : 'gainpos'}">(${esc(gainStr(delta))})</span>`
         : delta <= -0.05 ? `<span class="muted">(${esc(gainStr(delta))})</span>` : '<span class="muted">(no change)</span>'}`
    : `Would score <span class="big">${rec.score}</span><span class="muted">/100</span>
       <span class="tiny muted">— nothing is equipped on ${esc(char.n)} yet</span>`;

  /* What the character has now, broken down. Below the recommendation rather than above it:
     it is the diagnosis, and the recommendation is the answer the tab is named for, which used
     to start 976 px down a 900 px screen. */
  const bsHtml = `<div class="panel">
    <h2>${now ? 'Build score now' : 'The recommendation, broken down'}</h2>
    ${now ? `<div class="bscore">
        <div><span class="big">${now.score}<small>/100</small></span></div>
        <div><span class="tag ${nowBand.cls}">${esc(nowBand.label)}</span>
          <div class="tiny muted" style="margin-top:4px">
            ${now.filled} of ${SLOTS.length} slots equipped${now.actual.active4 ? ' · ' + esc(now.actual.active4) + ' 4-piece' : ' · no 4-piece'}</div></div>
      </div>
      <div class="bparts">${partHtml(now)}</div>
      ${statsSummaryHtml(char, worn, lo, false, idealLo.cards)}
      ${targetHtml(now, rec)}
      ${spreadHtml(now)}`
    : `<p class="muted" style="margin:0">Nothing is equipped on ${esc(char.n)} yet, so these are the recommended loadout's numbers.</p>
       ${statsSummaryHtml(char, recCards, lo, true, idealLo.cards)}
       ${targetHtml(rec, null, true)}
       ${spreadHtml(rec)}`}
    ${explainHtml('100 is a perfect loadout <i>for this character</i>; nobody reaches it, so treat around 70 as a finished build.',
      `A perfect loadout is five max-level 5★ cards, the preferred 4-piece, a recommended main stat in every slot, a Space
      card that pairs with it, and every substat roll landing at maximum value on one of their four best stats that the
      card's main does not already carry, spread so no damage factor is starved. The build score <b>is</b> comparable
      between characters, and the plan scores on this tab are on the same scale: at the default <b>4-piece value</b> of 55
      they are exactly the build score each plan would earn. That setting changes which loadout gets recommended, not
      what a finished build is worth, which is why it never moves the score above.`)}
  </div>`;

  const sp = r.space;
  const spOwnedBy = sp && sp.c.equipped && sp.c.equipped !== name ? sp.c.equipped : null;
  const spWhere = sp ? [sp.c.equipped === name ? 'already equipped here' : aloneGainHtml(aloneGain(sp.c)),
    spOwnedBy ? onTagHtml(sp.c, name, trade.used, trade.minR) : ''].filter(Boolean).join(' · ') : '';
  const spHtml = sp ? cardBlockHtml(sp.c, t, { score: cardScore(sp.c, t),
      mainTag: sp.pairs ? '<span class="tag hit">pairs with your 4-piece</span>' : '<span class="tag miss">no synergy with this 4-piece</span>',
      body: `<div class="tiny muted" style="margin-top:6px">${esc(spaceEffectText(sp.c.set, r.best))}</div>` +
        (spWhere ? `<div class="tiny muted" style="margin-top:4px">${spWhere}</div>` : ''),
      foot: slotEquipHtml(name, 'Space', sp.c) })
    : `<div class="lo empty"><h4><span class="slot Space">Spa</span> Space</h4>
      <div class="tiny muted">No Space cards in inventory. Preferred: <b>${esc(t.space || '—')}</b>.</div></div>`;

  out.innerHTML = `
  <div class="panel">
    <div class="rechead">
      <div><h2>Recommended loadout — ${esc(r.best.label)}</h2>
        <div class="headline">${headline}</div></div>
      <div class="acts"><button id="equipBtn" class="primary">Mark these as equipped on ${esc(char.n)}</button></div>
    </div>
    ${tradeHtml}
    ${setupNote}
    <div class="loadout">
      ${['Sun','Moon','Star','Sky'].map(sl => planCardHtml(sl, r.best.picks[sl], t, name, trade,
        r.best.picks[sl] ? aloneGain(r.best.picks[sl].c) : null)).join('')}
      ${spHtml}
    </div>
    ${explainHtml(`The number on each card is out of <b>100</b> for a perfect card in that slot on this character;
      <b>n left</b> is the raw headroom to it, on one scale across this character's five slots.`,
      `<p>A perfect card is max-level 5★, the best recommended main, every roll at maximum on the four best stats that main
      leaves free. The figure is scaled per slot, so a 60 Sun card and a 60 Star card are equally far from perfect even though
      a Star's main stat is worth far more in raw terms — a Moon, Star or Sky card with the right main is about half way to
      perfect before its substats count, while a Sun or Space card is all substats, which is why those two usually read lower.</p>
      <p><b>n left</b> is the <b>headroom</b>: the raw points a perfect card for that slot would add over this one. Those raw
      points are on one scale across this character's five slots, so the biggest headroom is the biggest gain a replacement
      could bring. Neither figure says anything about how good the card would be for anyone else.
      <b>(n r)</b> next to a substat is its roll value: how many maximum rolls that number is worth.</p>
      <p>Where a slot has more than one recommended main stat, every one of them counts as on target — and the one a card
      carries changes what its substats are worth, because ATK total multiplies your damage multiplier and crit rate
      multiplies crit multiplier. Take the Damage Multiplier main and ATK% substats are worth more; take the ATK% main and
      the reverse. That is why two cards with the same substats can score differently here.</p>`)}
    ${cost}
  </div>
  ${bsHtml}
  <div class="panel"><h2>Best alternatives per slot</h2>
    <table><thead><tr><th>Slot</th><th>Set</th><th>Main</th><th>Substats</th><th class="right">Score</th><th class="right" title="Raw points a perfect card for this slot would add over this one">Headroom</th><th class="right" title="Build score change if this card replaced the recommended one, with the other four recommended cards as they are">vs pick</th><th></th></tr></thead>
    <tbody>${['Sun','Moon','Star','Sky','Space'].flatMap(sl => {
      /* A slot's alternatives must not break the set bonus the recommended plan is
         actually banking on: offering a raw-score card from another set here (with a
         one-click equip button) would silently drop that bonus the moment the user
         clicks it, no matter which policy chose the plan. Only slots the plan itself
         left free (a '2+free' or 'raw' pick with no set attached) fall back to raw
         score across every set. */
      const reqSet = r.best && r.best.picks[sl] && r.best.sets.includes(r.best.picks[sl].c.set)
        ? r.best.picks[sl].c.set : null;
      const pick = sl === 'Space' ? r.space : r.best.picks[sl];
      let rows = sl === 'Space' ? [r.space, ...r.spaceAlts].filter(Boolean)
        : reqSet ? (r.idx[sl][reqSet] || []).slice(0, 3)
        : r.scored.filter(o => o.c.slot === sl).sort((a, b) => b.s - a.s).slice(0, 3);
      if (pick && !rows.some(o => o.c === pick.c)) rows = [pick].concat(rows.slice(0, 2));
      /* Ordered by what the recommendation was chosen on, not by the per-card Score: bestPlan's
         last step swaps in a same-set card whenever the whole loadout builds higher with it
         (stat targets and damage spread see the other four cards; a card's own score does not),
         so a pick can sit beside a card of its slot that scores higher on its own. Sorted on the
         Score, the table put the passed-over card first and read as a contradiction of the
         loadout above it (Kotone Shiomi, 28 Sep 2026: Star 72 worn, 67 picked, +0.1 built).
         "vs pick" is the build score with this card in place of the pick, the other four as
         recommended — the same r.loadoutTotal the pick was made with. */
      rows = rows.map(o => ({ o, d: vsPick(sl, o.c) })).sort((a, b) => b.d - a.d).map(x => Object.assign({ d: x.d }, x.o));
      return rows.map((o, i) => {
        const ownedBy = o.c.equipped && o.c.equipped !== name ? o.c.equipped : null;
        return `<tr class="slotrow-${sl}${i === 0 ? ' grp-start' : ''}">
        <td>${i === 0 ? `<span class="slot ${sl}">${sl.slice(0,3)}</span>` : ''}</td>
        <td>${esc(o.c.set)} <span class="tag r${o.c.rarity}">${o.c.rarity}★</span>
          ${ownedBy ? ` ${onTagHtml(o.c, name, trade.used, trade.minR)}` : ''}</td>
        <td class="tiny">${esc(o.c.main)}</td>
        <td class="tiny muted">${subsInlineHtml(o.c, t)}</td>
        <td class="right score">${cardPct(cardScore(o.c, t), sl, t)}</td>
        <td class="right tiny muted">${cardHeadroom(cardScore(o.c, t), sl, t).toFixed(1)}</td>
        <td class="right tiny">${pick && o.c === pick.c ? '<span class="tag hit">picked</span>' : `<span class="muted">${esc(gainStr(o.d))}</span>`}</td>
        <td>${slotEquipHtml(name, sl, o.c)}</td></tr>`;
      });
    }).join('')}</tbody></table>
    ${explainHtml(`<b>Score</b> is the card on its own; <b>vs pick</b> is the build score with it in place of the recommended card,
      the other four as recommended. The pick is chosen on the second, so it can score lower on its own than a card below it.`,
      `<p>A card's own Score weighs its main stat and substats. The build score also asks whether the whole loadout reaches the
      character's recommended stats and keeps ATK, damage bonus and crit in balance — they multiply, so a card that fills the
      weakest of them can be worth more than one with better rolls on a stat the other four cards already carry.
      Differences of a few tenths are a near tie.</p>`)}</div>
  ${level0Html(t, r, pool)}
  ${(alt || missing) ? `<div class="panel"><h2>Other set plans considered</h2>
    <table><thead><tr><th>Plan</th><th class="right" title="The build score this plan would earn, on the same 0-100 scale as the one above">Build score</th><th class="right">vs best</th></tr></thead>
    <tbody>${alt}${missing}</tbody></table></div>` : ''}`;

  /* The whole loadout in one go, replacing what is worn — a real trade when it takes cards off
     someone else — so it can be taken back. */
  const eq = $('#equipBtn');
  if (eq) eq.onclick = () => {
    const snap = snapshotState();
    state.cards.forEach(c => { if (c.equipped === name) clearEquip(c); });
    ['Sun','Moon','Star','Sky'].forEach(sl => { const p = r.best.picks[sl]; if (p) p.c.equipped = name; });
    if (r.space) r.space.c.equipped = name;
    commit();
    offerUndo(`Equipped the recommended loadout on ${name}.`, snap);
  };
  const noTrade = $('#optNoTrade');
  if (noTrade) noTrade.onclick = () => { $('#optPool').value = 'free'; runOpt(); };
  const setupBtn = $('#optSetup');
  if (setupBtn) setupBtn.onclick = () => openLoadout(name, ['setup']);
  // swapCard/unequipCard commit, which re-runs the optimiser.
  $$('#optOut .slotEquip').forEach(b => b.onclick = () => swapCard(b.dataset.char, b.dataset.slot, b.dataset.card));
  $$('#optOut .slotUnequip').forEach(b => b.onclick = () => unequipCard(b.dataset.card));
  // editCard() commits on save, which redraws this whole panel (including the Level 0
  // table) with the card's new stats — no onDone needed, unlike the Loadout popup which
  // has to reopen itself.
  $$('#optOut [data-edit-l0]').forEach(b => b.onclick = () => editCard(b.dataset.editL0));
}

/* Options for a set <select>. Sets lufel.net lists but the game has not shipped yet
   stay selectable — the data is already correct for the day they land — but are marked
   so nobody wonders why they own none, and they sort to the bottom. The option's value
   is always the bare set name; only the label carries the marker. */
/* Who a card can be equipped on. Owned characters only, since those are the ones you can
   actually gear — but a name the card already carries always stays in the list, because an
   imported save can flag a card as worn by someone not yet marked owned, and reopening the
   dialog must not silently unequip it. */
function equipOptionList(selected) {
  const owned = ownedChars();
  const names = (owned.length ? owned : CHARACTERS).map(c => c.n);
  if (selected && names.indexOf(selected) < 0) names.push(selected);
  return '<option value="">— not equipped —</option>' +
    names.map(n => `<option value="${esc(n)}" ${n === selected ? 'selected' : ''}>${esc(n)}</option>`).join('');
}

function setOptionList(src, selected) {
  const names = Object.keys(src).sort((a, b) =>
    (!!src[a].unreleased - !!src[b].unreleased) || a.localeCompare(b));
  return names.map(s => `<option value="${esc(s)}" ${s === selected ? 'selected' : ''}>` +
    `${esc(s)}${src[s].unreleased ? ' (unreleased)' : ''}</option>`).join('');
}

/* ---------------------------- inventory ---------------------------- */
function fillSelects() {
  $('#fSlot').innerHTML = SLOTS.map(s => `<option>${s}</option>`).join('');
  $('#flSlot').innerHTML = '<option value="">Any</option>' + SLOTS.map(s => `<option>${s}</option>`).join('');
  syncFlSetOptions();
  const allMains = [...new Set(Object.values(SLOT_INFO).flatMap(i => i.mains))].sort();
  $('#flMain').innerHTML = '<option value="">Any</option>' + allMains.map(s => `<option>${s}</option>`).join('');
  renderFlSub();
  const rsElements = [...new Set(CHARACTERS.map(c => c.e))].sort();
  ['#rsElement', '#hrElement', '#ccElement', '#ikElement'].forEach(id => {
    $(id).innerHTML = '<option value="">Any</option>' + rsElements.map(e => `<option>${e}</option>`).join('');
  });
  // Upgrades' "Weakest slots" filters equipped slots, not the card list, so it takes a
  // plain slot dropdown rather than the shared slot/set/main/substat widget below.
  $('#hrSlot').innerHTML = '<option value="">Any</option>' + SLOTS.map(s => `<option>${s}</option>`).join('');
  syncSetOptions(); syncMainOptions(); renderSubInputs();

  // Triage and Vault get the same slot/set/main/substat filter widget as Inventory, on
  // their own results table rather than the raw card list — see cardMatchesFilter above.
  ['trFl', 'vaFl'].forEach(p => {
    $('#' + p + 'Slot').innerHTML = '<option value="">Any</option>' + SLOTS.map(s => `<option>${s}</option>`).join('');
    syncFilterSetOptions(p);
    $('#' + p + 'Main').innerHTML = '<option value="">Any</option>' + allMains.map(s => `<option>${s}</option>`).join('');
  });
  renderTrFlSub(); renderVaFlSub();
  ccFillCheckSelects();
  ikFillCheckChars(); ikSyncMain(); ikRenderSubs();
}
// Set options depend on the selected slot (Space vs Heavens), same as syncFlSetOptions,
// generalised over the id prefix so Triage ("trFl") and Vault ("vaFl") can share it.
function syncFilterSetOptions(p) {
  const slot = $('#' + p + 'Slot').value;
  const src = slot === 'Space' ? SPACE_SETS : slot ? SETS : Object.assign({}, SETS, SPACE_SETS);
  $('#' + p + 'Set').innerHTML = '<option value="">Any</option>' + setOptionList(src, $('#' + p + 'Set').value);
}
function syncSetOptions() {
  const slot = $('#fSlot').value;
  $('#fSet').innerHTML = setOptionList(slot === 'Space' ? SPACE_SETS : SETS);
}
// Unlike #fSet above (always a specific slot, so always a specific set table), the
// inventory filter's Slot can be "Any" — the one case that still needs both tables.
function syncFlSetOptions() {
  const slot = $('#flSlot').value;
  const src = slot === 'Space' ? SPACE_SETS : slot ? SETS : Object.assign({}, SETS, SPACE_SETS);
  $('#flSet').innerHTML = '<option value="">Any</option>' + setOptionList(src, $('#flSet').value);
}
function syncMainOptions() {
  const slot = $('#fSlot').value;
  const info = SLOT_INFO[slot];
  $('#fMain').innerHTML = info.mains.map(s => `<option>${s}</option>`).join('');
  $('#fMain').disabled = info.fixed;
}
// The inventory substat filter is a dropdown-plus-pills widget rather than a native
// multi-select: picking a substat that isn't selected yet adds it, picking one that
// already has a checkmark removes it, and each pill's × does the same. `flSubSelected`
// is the source of truth; the <select>'s own value is reset to the placeholder after
// every pick so it always reads as "add another" rather than showing the last choice.
let flSubSelected = [];
function renderFlSub() {
  const stats = Object.keys(SUBSTATS).sort();
  $('#flSub').innerHTML = '<option value="">+ Add substat…</option>' +
    stats.map(s => `<option value="${esc(s)}">${flSubSelected.includes(s) ? '✓ ' : ''}${esc(s)}</option>`).join('');
  $('#flSubPills').innerHTML = flSubSelected.map(s =>
    `<span class="subpill">${esc(s)}<button type="button" data-stat="${esc(s)}" title="Remove">×</button></span>`).join('');
  $$('#flSubPills button').forEach(b => b.onclick = () => toggleFlSub(b.dataset.stat));
}
function toggleFlSub(stat) {
  const i = flSubSelected.indexOf(stat);
  if (i === -1) flSubSelected.push(stat); else flSubSelected.splice(i, 1);
  renderFlSub();
  renderInv();
}
// Same dropdown-plus-pills widget as flSub above, one instance each for the Triage and
// Vault results tables. `selected` is the backing array, `onChange` the cheap re-render
// (filter/sort only — never the expensive per-character rating pass) to run after a pick.
function renderFlSubGeneric(p, selected) {
  const stats = Object.keys(SUBSTATS).sort();
  $('#' + p + 'Sub').innerHTML = '<option value="">+ Add substat…</option>' +
    stats.map(s => `<option value="${esc(s)}">${selected.includes(s) ? '✓ ' : ''}${esc(s)}</option>`).join('');
  $('#' + p + 'SubPills').innerHTML = selected.map(s =>
    `<span class="subpill">${esc(s)}<button type="button" data-stat="${esc(s)}" title="Remove">×</button></span>`).join('');
}
let trFlSubSelected = [];
function renderTrFlSub() {
  renderFlSubGeneric('trFl', trFlSubSelected);
  $$('#trFlSubPills button').forEach(b => b.onclick = () => toggleTrFlSub(b.dataset.stat));
}
function toggleTrFlSub(stat) {
  const i = trFlSubSelected.indexOf(stat);
  if (i === -1) trFlSubSelected.push(stat); else trFlSubSelected.splice(i, 1);
  renderTrFlSub();
  renderTriageTable();
}
let vaFlSubSelected = [];
function renderVaFlSub() {
  renderFlSubGeneric('vaFl', vaFlSubSelected);
  $$('#vaFlSubPills button').forEach(b => b.onclick = () => toggleVaFlSub(b.dataset.stat));
}
function toggleVaFlSub(stat) {
  const i = vaFlSubSelected.indexOf(stat);
  if (i === -1) vaFlSubSelected.push(stat); else vaFlSubSelected.splice(i, 1);
  renderVaFlSub();
  renderVaultTable();
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
  commit();
}

/* One click, so it offers undo like every other easy-to-regret action here. `after` runs once
   the change is committed and before the undo toast is placed — it is how the Loadout popup
   redraws itself around the gap, or the edit dialog closes. */
function deleteCard(id, after) {
  const c = state.cards.find(x => x.id === id);
  if (!c) return;
  const snap = snapshotState();
  state.cards = state.cards.filter(x => x.id !== id);
  commit();
  if (after) after();
  offerUndo(`Deleted a ${c.rarity}★ ${c.slot} card (${c.set}${c.equipped ? `, worn by ${c.equipped}` : ''}).`, snap);
}
// Shared by the Inventory, Triage and Vault tabs, each of which filters a list of cards
// (or, for Triage/Vault, rated rows wrapping a card) on the same slot/set/rarity/main/
// substat/search fields. `f` = { sl, st, r, mn, subSel, subAny, q }.
function cardMatchesFilter(c, f) {
  if (f.sl && c.slot !== f.sl) return false;
  if (f.st && c.set !== f.st) return false;
  if (f.r && c.rarity !== +f.r) return false;
  if (f.mn && c.main !== f.mn) return false;
  if (f.subSel && f.subSel.length) {
    const have = (c.subs || []).map(s => s.stat);
    const match = f.subAny ? f.subSel.some(s => have.includes(s)) : f.subSel.every(s => have.includes(s));
    if (!match) return false;
  }
  if (f.q) {
    const hay = [c.set, c.main, c.equipped || '', ...(c.subs || []).map(s => s.stat)].join(' ').toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}
function filteredCards() {
  const f = { sl: $('#flSlot').value, st: $('#flSet').value, r: $('#flRar').value,
    mn: $('#flMain').value, subSel: flSubSelected, subAny: $('#flSubMode').value === 'any',
    q: $('#flQ').value.trim().toLowerCase() };
  return state.cards.filter(c => cardMatchesFilter(c, f));
}
/* One row per set, sorted by how many the user owns — bar width is relative
   to that group's own best-stocked set, not shared across Heavens/Space,
   since the two pools are different sizes and not comparable. */
function renderSetGroup(src, counts) {
  const max = Math.max(1, ...Object.keys(src).map(s => counts[s] || 0));
  const names = Object.keys(src).sort((a, b) =>
    (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b));
  return names.map(s => `<div class="setRow">
      <span class="tiny">${esc(s)}${src[s].unreleased ? ' <span class="muted">(unreleased)</span>' : ''}</span>
      <div class="bar"><i style="width:${Math.round(100 * (counts[s] || 0) / max)}%"></i></div>
      <span class="tiny cnt">${counts[s] || 0}</span>
    </div>`).join('');
}
function renderSetOverview() {
  const heavens = {}, space = {};
  state.cards.forEach(c => {
    const bucket = c.slot === 'Space' ? space : heavens;
    bucket[c.set] = (bucket[c.set] || 0) + 1;
  });
  const setsOwned = Object.keys(heavens).length + Object.keys(space).length;
  $('#invSetTotal').textContent = state.cards.length ?
    `— ${state.cards.length} cards across ${setsOwned} of ${Object.keys(SETS).length + Object.keys(SPACE_SETS).length} sets` : '';
  $('#invSetOverview').innerHTML = `<div class="setgrid">
      <div><h3 class="tiny muted" style="margin:0 0 4px">Heavens</h3>${renderSetGroup(SETS, heavens)}</div>
      <div><h3 class="tiny muted" style="margin:0 0 4px">Space</h3>${renderSetGroup(SPACE_SETS, space)}</div>
    </div>`;
}
const invSort = { key: null, dir: 1 };
const INV_SORT_COLS = { level: c => c.level, main: c => c.main || '', equipped: c => c.equipped || '' };
function sortInvRows(rows) {
  const getter = INV_SORT_COLS[invSort.key];
  if (!getter) return rows;
  return rows.slice().sort((a, b) => {
    const av = getter(a), bv = getter(b);
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return cmp * invSort.dir;
  });
}
/* A sortable column header, shared by every sortable table. The label is a real <button>, so
   the header is reachable and operable from the keyboard (none of the 15 was, before Sep
   2026); the click bubbles to the <th>, which owns the handler, and aria-sort says which way
   the column is sorted. `sort` is the table's { key, dir }. */
function sortThHtml(key, label, sort, title, style, cls) {
  const active = sort.key === key;
  const arrow = active ? `<span class="arrow" aria-hidden="true">${sort.dir > 0 ? '▲' : '▼'}</span>` : '';
  return `<th class="sortH${cls ? ' ' + cls : ''}" aria-sort="${active ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"` +
    `${title ? ` title="${esc(title)}"` : ''}${style ? ` style="${style}"` : ''} data-sort="${key}">` +
    `<button type="button" class="thBtn">${label}${arrow}</button></th>`;
}
function invSortHeader(key, label) { return sortThHtml(key, label, invSort); }
function renderInv() {
  renderSetOverview();
  const rows = sortInvRows(filteredCards());
  $('#invCount').textContent = `— ${rows.length} shown of ${state.cards.length}`;
  $('#nodata').classList.toggle('hide', state.cards.length > 0);
  $('#invTable').innerHTML = `<thead><tr>
      <th>Slot</th><th>Set</th><th>★</th>${invSortHeader('level', 'Lv')}${invSortHeader('main', 'Main')}<th>Substats</th>${invSortHeader('equipped', 'Equipped')}<th></th>
    </tr></thead><tbody>` +
    rows.slice(0, 600).map(c => `<tr>
      <td><span class="slot ${c.slot}">${c.slot.slice(0,3)}</span></td>
      <td>${esc(c.set)}</td>
      <td><span class="tag r${c.rarity}">${c.rarity}★</span></td>
      <td class="muted">${c.level}</td>
      <td class="tiny">${esc(c.main)}</td>
      <td class="tiny muted">${subsInlineHtml(c)}</td>
      <td class="tiny">${c.equipped ? esc(c.equipped) : '<span class="muted">—</span>'}${c.locked
        ? ' <span class="tag hit" title="Excluded from every recommendation for anyone else">locked</span>' : ''}</td>
      <td class="right nowrap"><button class="sm ghost" data-edit="${c.id}">Edit</button>
        <button class="sm ghost" data-del="${c.id}" aria-label="Delete this card" title="Delete this card">✕</button></td>
    </tr>`).join('') + '</tbody>';
  if (rows.length > 600) $('#invTable').insertAdjacentHTML('beforeend',
    `<tfoot><tr><td colspan="8" class="tiny muted">Showing the first 600 rows — narrow the filters to see more.</td></tr></tfoot>`);
  /* Every binding here is scoped to this table. They used to be page-wide — `[data-edit]` and
     `.sortH` — and the Roster binds `[data-edit]` too, so whichever drew last won: after a Roster
     redraw (the last thing a load does) Inventory's Edit called editTargets with a card id and
     threw, after an Inventory redraw the Roster's Targets buttons did nothing, and a click on a
     Triage, Vault or Weakest slots header re-sorted the Inventory instead. */
  $$('#invTable [data-edit]').forEach(b => b.onclick = () => editCard(b.dataset.edit));
  $$('#invTable [data-del]').forEach(b => b.onclick = () => deleteCard(b.dataset.del));
  $$('#invTable .sortH').forEach(th => th.onclick = () => {
    const key = th.dataset.sort;
    invSort.dir = invSort.key === key ? -invSort.dir : 1;
    invSort.key = key;
    renderInv();
    refocus(`#invTable th.sortH[data-sort="${key}"] .thBtn`);
  });
}
/* A redraw replaces the control that was just used; put the keyboard back on its successor,
   or it falls to the page and a keyboard user starts again from the top. */
function refocus(sel) { const el = $(sel); if (el) el.focus(); }

/* Reuses the shared dialog (see editTargets) to edit slot/set/rarity/level/
   main/substats of an existing card in place, running it through the same
   validateCard() the importers use so a hand-edit can't introduce a card
   the rest of the app doesn't recognise as legal. Called from the inventory
   table with no `onDone` (closes #dlg when finished) and from the roster's
   Loadout popup with `onDone` set to reopen it, since that popup is already
   showing #dlg and needs to redraw itself rather than lose the screen. */
function editCard(id, onDone) {
  const c = state.cards.find(x => x.id === id);
  if (!c) return;
  rememberLoSections();   // opened from the Loadout popup, it goes back there (onDone)
  const subOpts = '<option value="">—</option>' + Object.keys(SUBSTATS).map(s => `<option>${s}</option>`).join('');
  setDlgView('card', id);
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
    <div class="row" style="margin-top:10px">
      <div class="field" style="flex:1;min-width:220px"><label>Equipped on</label>
        <select id="eEquip">${equipOptionList(c.equipped)}</select>
        <span class="tiny muted">The card panel never shows this, so it cannot be scanned —
          set it here or from the Optimise tab.</span></div>
    </div>
    <div id="eErr" class="tiny" style="color:#e87a5c;margin-top:10px"></div>
    <div class="row" style="margin-top:12px">
      <button class="primary" id="eSave">Save changes</button>
      <button class="ghost" id="eDelete">Delete card</button>
    </div>`;
  const syncE = () => {
    const slot = $('#eSlot').value;
    $('#eSet').innerHTML = setOptionList(slot === 'Space' ? SPACE_SETS : SETS, c.set);
    const info = SLOT_INFO[slot];
    $('#eMain').innerHTML = info.mains.map(m => `<option ${m === c.main ? 'selected' : ''}>${m}</option>`).join('');
    $('#eMain').disabled = info.fixed;
  };
  $('#eSlot').onchange = syncE; syncE();
  $('#eRar').value = c.rarity; $('#eLvl').value = c.level;
  $$('.eSubStat').forEach(sel => { const s = c.subs[+sel.dataset.i]; if (s) sel.value = s.stat; });
  showDlg();
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
    // The scanned main value belongs to the card as scanned; a new level, main or rarity
    // makes it stale (see mainValueFitsLevel), so the level's curve takes over.
    if (['slot', 'rarity', 'level', 'main'].some(k => candidate[k] !== c[k])) delete c.mainValue;
    Object.assign(c, candidate);
    // Nobody wears two cards in one slot, so claiming this slot frees whoever held it —
    // the same wholesale unequip the Optimise tab's button does, narrowed to one slot.
    const wearer = $('#eEquip').value || null;
    if (wearer) state.cards.forEach(x => {
      if (x !== c && x.equipped === wearer && x.slot === c.slot) clearEquip(x);
    });
    if (!wearer) c.locked = false;
    c.equipped = wearer;
    // Bypasses swapCard/unequipCard (it can reassign rarity/subs in the same edit, not just
    // who wears it), so it commits itself — which redraws everything that reads the card.
    commit();
    if (onDone) onDone(); else $('#dlg').close();
  };
  $('#eDelete').onclick = () => deleteCard(id, onDone || (() => $('#dlg').close()));
}

/* ------------------------------ triage ------------------------------ */

// Column sort for the rendered results table, independent of the (expensive) rating
// pass itself — mirrors invSort/sortInvRows/invSortHeader on the Inventory tab, but over
// `rated` rows ({ card, best, who, pct, ... }) rather than raw cards. Persists across
// filter changes and across a fresh "Rate inventory" run, same as invSort does.
const trSort = { key: null, dir: 1 };
/* Triage's verdict, in one place. A card the Upgrades tab recommends is kept whatever its
   share; otherwise the within-slot share decides (70% keep, 35% hold), except that a would-be
   feed the Vault rates worth a lock is marked lock. */
function trVerdict(r) {
  if (r.rec || r.pct >= 0.7) return 'keep';
  if (r.pct >= 0.35) return 'hold';
  return r.vault === 'lock' ? 'lock' : 'feed';
}
/* The order "worst first" walks: plain feed, feed the Vault would hold, Vault lock, hold,
   keep, an Upgrades pick — so the top of the list is the safest to feed. */
function trTier(r) {
  if (r.rec) return 5;
  const v = trVerdict(r);
  return v === 'keep' ? 4 : v === 'hold' ? 3 : v === 'lock' ? 2 : r.vault === 'watch' ? 1 : 0;
}
/* `quality` is what the verdict reads: the tier above, then the card's share of the best card
   in its own slot. The default order sorts on it, not on the raw Score. Raw scores differ by
   slot — a Space card's best is worth about eight points, a Moon card's several times that —
   so "worst first" by Score mixed slots: on the real inventory (Sep 2026) the first 800 rows,
   all the table shows, held 199 hold cards while 723 of the 1322 feed candidates sat below
   them. */
const TR_SORT_COLS = { slot: r => r.card.slot, set: r => r.card.set, rarity: r => r.card.rarity,
  fit: r => r.rec || r.who || '', score: r => r.best, quality: r => [trTier(r), r.pct] };
function sortTrRows(rows) {
  // No explicit column clicked yet: fall back to the existing "Show" control, which is a
  // sort by quality in one direction or the other, so the table isn't left in creation order.
  const key = trSort.key || 'quality';
  const dir = trSort.key ? trSort.dir : ($('#trShow').value === 'worst' ? 1 : -1);
  const getter = TR_SORT_COLS[key];
  return rows.slice().sort((a, b) => {
    const av = getter(a), bv = getter(b);
    const cmp = Array.isArray(av) ? (av[0] - bv[0]) || (av[1] - bv[1])
      : typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return cmp * dir;
  });
}
function trSortHeader(key, label, title, style) { return sortThHtml(key, label, trSort, title, style); }

/* The verdict's six tiers (trTier's numbers), as the chips over the Triage table. Each shows
   how many cards the other filters leave in it, and pressing chips narrows the table to those
   tiers. Until Sep 2026 the counts were five numbers inside a sentence and the table could only
   be sorted by verdict, never filtered — on the real inventory the 980 safest feeds were only
   reachable by scrolling past everything else. */
const TR_TIERS = [
  { t: 0, cls: 'feed', label: 'Feed', title: 'Below 35% of your best card in the same slot, and the Vault does not rate it either: your safest feed candidates.' },
  { t: 1, cls: 'soft', label: 'Feed · Vault would hold', title: 'Below 35%, but the Vault rates it in the top 7% of its slot for some role. Feed these after the rest.' },
  { t: 2, cls: 'lock', label: 'Lock', title: 'Nobody you own gains much from it, but the Vault rates it in the top 2% of its slot for some role: worth a lock in the game client.' },
  { t: 3, cls: 'hold', label: 'Hold', title: '35% to 70% of your best card in the same slot.' },
  { t: 4, cls: 'keep', label: 'Keep', title: '70% or more of your best card in the same slot.' },
  { t: 5, cls: 'rec', label: 'Upgrade pick', title: 'Part of an upgrade the Upgrades tab recommends, so kept whatever its own score.' }
];
let trVerdictSel = [];   // tiers the table is narrowed to; empty shows every verdict

// The last full rating pass, kept around so changing a filter or a sort column redraws
// the table instantly instead of re-running the per-character buildScore sweep above.
let trCache = null;
function runTriage() {
  const scope = $('#trScope').value;
  const minR = +$('#trRar').value;
  const chars = scope === 'owned' ? ownedChars() : CHARACTERS;
  if (!chars.length) { $('#trSummary').innerHTML = '<p class="muted">Mark some characters as owned on the Roster tab first.</p>'; return; }

  /* Per character: the real cards they actually have equipped right now, minus whichever
     slot a candidate would occupy, and the buildScore baseline for that — computed once
     per character rather than once per (card, character) pair, since idealLoadout only
     depends on the character and P4, not on the candidate being priced.

     This is what lets the per-card loop below price a card against what this character's
     build ACTUALLY looks like — real other cards, real weapon, real ascension via
     charLoadout — rather than against generic stat weights alone. A card that is mostly
     Crit Rate does not automatically win just because Crit Rate is heavily weighted; if
     the character is already carrying plenty of it from what's really equipped, buildScore's
     own damage-spread term prices the marginal roll the same way the game's damage formula
     does, at a fraction of a fresh Crit Rate roll's worth. */
  const targets = chars.map(c => {
    const t = target(c);
    const lo = charLoadout(c.n);
    const idl = idealLoadout(c, t, 55);
    const real = state.cards.filter(x => x.equipped === c.n);
    const others = {}, baseRaw = {};
    SLOTS.forEach(sl => {
      others[sl] = real.filter(x => x.slot !== sl);
      // buildScoreOf, not buildScore: `others` is often empty, and an empty board is worth
      // what its base stats earn, not 0 (see buildScoreOf)
      const b = buildScoreOf(c, others[sl], 55, lo, idl, t);
      baseRaw[sl] = b ? b.raw : 0;
    });
    return { c, t, lo, idl, others, baseRaw };
  });

  /* A card the Upgrades tab tells someone to equip is never feed. The marginal below prices
     one card at a time against what is worn now, and a card whose worth is a set switch —
     most of a new 4-piece is its bonus, which lands only with the fourth card — reads as a
     loss on its own: on a synthetic inventory 54 of the 340 unequipped cards the optimiser's
     4-piece plans put on someone came out feed. So Triage asks the Upgrades tab, at that
     tab's own current settings, about every character in scope, and a card it names is kept
     for that character (`rec`, the one whose upgrade is worth most if two want it) whatever
     its own swap score. The real inventory had no such card at the defaults (Sep 2026); the
     case is one set switch away, and a fed card does not come back. */
  const upR = +$('#upRar').value, upSame = $('#upSameSet').checked, upFree = $('#upIgnoreEquipped').checked;
  const recFor = new Map();
  chars.forEach(c => upgradesFor(c, upR, upSame, upFree).forEach(row => {
    const card = row.rec, pts = upPts(row), prev = card && recFor.get(card.id);
    if (card && !card.equipped && (!prev || pts > prev.pts)) recFor.set(card.id, { n: c.n, pts });
  }));

  /* Marginal buildScore points from equipping `card` into its slot, given everything else
     this character actually wears. Comparable across characters (buildScore already is —
     see the doc on why), so it doubles as both the ranking value and the "who fits best"
     argmax below. Measured on `raw`: the rounded `score` left the whole inventory on about
     thirty distinct values, and moved 6% of verdicts across the 35% / 70% lines on the real
     inventory — most in the Space slot, whose best card is worth about eight points. */
  const marginal = (o, card) => {
    const after = buildScoreOf(o.c, o.others[card.slot].concat([atMaxLevel(card)]), 55, o.lo, o.idl, o.t);
    return (after ? after.raw : 0) - o.baseRaw[card.slot];
  };

  // Equipped cards are not candidates for anything — they are already doing their job —
  // so Triage only ever rates cards that are actually available to move.
  const cards = state.cards.filter(c => c.rarity >= minR && !c.equipped);
  const rated = cards.map(card => {
    // Every character's marginal value for this card, computed once and sliced two ways
    // below — recomputing per slice would double the cost of the whole tab for nothing.
    const vals = targets.map(o => ({ o, m: marginal(o, card) }));
    let rawBest = -Infinity;
    vals.forEach(v => { if (v.m > rawBest) rawBest = v.m; });

    // `who` is who would actually equip the card, so eligibility has to see the set — and
    // seeing it has to mean more than "not off-element". buildScore's own set-bonus term
    // still lets an off-preferred-set card post a positive marginal from raw stats alone
    // (a 0.22x consolation value plus whatever the substats are worth on their own), and a
    // character with a broad weight vector (Motoha Arai [Tropical]'s HP/ATK/crit spread is
    // the standing example) can out-score everyone who actually runs the set just on that
    // raw value. So eligibility here is a hard requirement that this exact set is one of
    // the character's own designated sets — `t.sets` for Heavens slots, `t.space` for the
    // Space slot — not merely a set they could technically wear.
    const def = SETS[card.set] || SPACE_SETS[card.set];
    const wantsSet = v => card.slot === 'Space' ? v.o.t.space === card.set : (v.o.t.sets || []).includes(card.set);
    const elig = vals.filter(wantsSet);

    let bestFit = -Infinity, who = '';
    elig.forEach(v => { if (v.m > bestFit) { bestFit = v.m; who = v.o.c.n; } });

    // No one in scope actually runs this set. Two different reasons look the same here:
    // nobody of the right element is owned yet (the card might be for a future pull, so
    // still fall back to the best raw marginal rather than call it junk), versus the right
    // element is on the roster but nobody has chosen this set (which is a real "nobody
    // wants this" answer against the current roster, so score it as such rather than
    // crediting whichever off-set character has the broadest raw stat weights).
    const elemOwned = !(def && def.elem) || vals.some(v => v.o.c.e === def.elem);
    const best = elig.length ? bestFit : (elemOwned ? 0 : rawBest);
    const rec = recFor.get(card.id);
    return { card, best, who, rec: rec ? rec.n : '', noSetMatch: !elig.length && elemOwned };
  });
  /* Grade each card against the best card OF ITS SLOT, not the best card in the inventory.
     A Sun card's main is always flat HP and a Space card's is flat ATK+DEF, so neither can
     ever carry a main a damage dealer wants; ranked against Star and Moon cards — whose
     main alone is worth about nine max rolls — every Sun card reads as feed, which is a
     fact about the slot, not the card. Same reasoning as the Vault tab's per-slot
     percentiles, applied to the marginal instead. */
  const topBySlot = {};
  rated.forEach(r => { if (!(r.card.slot in topBySlot) || r.best > topBySlot[r.card.slot]) topBySlot[r.card.slot] = r.best; });
  rated.forEach(r => { const top = topBySlot[r.card.slot]; r.pct = top > 0 ? r.best / top : 0; });

  /* The Vault's answer, beside Triage's. Triage is relative to the characters you own, so it
     calls feed a card nobody you own gains from now, and a fed card does not come back; the
     Vault prices the same card against every role, blind to the roster. A would-be feed the
     Vault rates worth a lock is marked lock instead (`trVerdict`), and one it rates worth
     holding keeps its feed verdict with a note and sorts after the rest. On the real
     inventory (Sep 2026) 76 of the 1322 feed candidates were Vault locks and 266 Vault holds,
     which only a card-by-card cross-check of the two tabs would have caught. Rated at the
     Vault tab's own rarity floor, so the two tabs say the same about the same card (its
     percentiles depend on the population); about 30 ms. */
  const vault = new Map(vaultRate(state.cards.filter(c => c.rarity >= +$('#vaRar').value)).rated.map(v => [v.card.id, v]));
  rated.forEach(r => { const v = vault.get(r.card.id); r.vault = v ? v.verdict : ''; r.vaultRole = v ? v.role : ''; });

  const junk = rated.filter(r => trTier(r) === 0).length;
  $('#trSummary').innerHTML = `<div class="notice info">
    Rated <b>${rated.length}</b> unequipped cards against <b>${chars.length}</b> characters: <b>${junk}</b> are safe feed
    candidates. The chips over the table count each verdict and narrow the table to it.
    Always double-check before feeding: this only knows the characters you have marked as owned.</div>`;
  $('#trPanel').classList.remove('hide');
  // `sig` is what the run read (triageSig), so markStaleRuns can say when it no longer holds
  trCache = { rated, tc: teamCritRate(), sig: triageSig() };
  renderTriageTable();
}
// Filters and sorts trCache.rated and draws #trTable — the cheap part, split out of
// runTriage() so a filter/sort change doesn't re-run the per-character buildScore sweep.
function renderTriageTable() {
  if (!trCache) return;
  const f = { sl: $('#trFlSlot').value, st: $('#trFlSet').value, r: $('#trFlRar').value,
    mn: $('#trFlMain').value, subSel: trFlSubSelected, subAny: $('#trFlSubMode').value === 'any',
    q: $('#trFlQ').value.trim().toLowerCase() };
  const filtered = trCache.rated.filter(r => cardMatchesFilter(r.card, f));
  const counts = TR_TIERS.map(() => 0);
  filtered.forEach(r => counts[trTier(r)]++);
  $('#trChips').innerHTML = TR_TIERS.map(x => {
    const on = trVerdictSel.includes(x.t);
    return `<button type="button" class="vchip ${x.cls}" data-tier="${x.t}" aria-pressed="${on}" title="${esc(x.title)}"${counts[x.t] || on ? '' : ' disabled'}>` +
      `${esc(x.label)} <b>${counts[x.t]}</b></button>`;
  }).join('') + (trVerdictSel.length ? ' <button type="button" class="linky tiny" id="trChipsAll">Show every verdict</button>' : '');
  $$('#trChips [data-tier]').forEach(b => b.onclick = () => {
    const k = +b.dataset.tier, i = trVerdictSel.indexOf(k);
    if (i < 0) trVerdictSel.push(k); else trVerdictSel.splice(i, 1);
    renderTriageTable();
    refocus(`#trChips [data-tier="${k}"]`);
  });
  if ($('#trChipsAll')) $('#trChipsAll').onclick = () => { trVerdictSel = []; renderTriageTable(); refocus('#trChips [data-tier]:not(:disabled)'); };
  const shown = trVerdictSel.length ? filtered.filter(r => trVerdictSel.includes(trTier(r))) : filtered;
  const rows = sortTrRows(shown);
  $('#trFlCount').textContent = `${rows.length} shown of ${trCache.rated.length}`;
  $('#trTable').innerHTML = `<thead><tr>
      ${trSortHeader('slot', 'Slot')}${trSortHeader('set', 'Set')}${trSortHeader('rarity', '★')}<th>Main</th><th>Substats</th>
      ${trSortHeader('fit', 'Best fit', 'Who would actually equip this — whoever\'s real build gains the most buildScore points from swapping it in, restricted to characters who actually list this set as one of their own (t.sets for Heavens, t.space for Space). An element-locked set also rules out everyone off that element. A card the Upgrades tab tells someone to equip names that character instead, tagged upgrade.')}
      ${trSortHeader('score', 'Score', 'How many buildScore points equipping this actually adds for whoever\'s eligible to wear it, given what they already have equipped — stats, set fit AND stat spread against their real weapon and ascension, so a card that just piles onto a stat their build already has plenty of scores low even if its raw stats look strong. If nobody owned is of the right element yet, this ranges over everyone instead, so a strong card is not marked feed just because you haven\'t pulled that element — but if the element is on the roster and nobody there actually runs this set, the score reflects that nobody wants it rather than crediting an off-set character\'s raw stats.')}
      ${trSortHeader('quality', 'Quality', 'This card\'s Score as a share of the best card in the same slot — what the verdict reads: 70% and up keep, 35% and up hold, below that feed, unless the Vault rates the card worth a lock (marked lock). A card the Upgrades tab recommends is kept whatever its share.', 'width:110px')}<th>Verdict</th>
    </tr></thead><tbody>` +
    rows.slice(0, 800).map(r => {
      const p = Math.round(r.pct * 100);
      const v = trVerdict(r);
      const role = esc((ARCHETYPES[r.vaultRole] || {}).label || r.vaultRole || '');
      const verdict = r.rec ? `<span class="tag hit" title="Part of ${esc(r.rec)}'s upgrade on the Upgrades tab. Its own swap score can be low, because most of a set switch is the 4-piece bonus, which lands only with the fourth card.">keep</span>`
        : v === 'keep' ? '<span class="tag hit">keep</span>'
        : v === 'hold' ? '<span class="tag">hold</span>'
        : v === 'lock' ? `<span class="tag hit" title="The Vault rates this in the top 2% of ${esc(r.card.slot)} cards for the ${role} role: worth a lock in the game client, though nobody you own gains much from it now.">lock</span>`
        : `<span class="tag miss">feed</span>${r.vault === 'watch' ? ` <span class="tiny muted" title="The Vault rates this in the top 7% of ${esc(r.card.slot)} cards for the ${role} role, worth holding. Feed it after the rest.">vault: hold</span>` : ''}`;
      const setElem = (SETS[r.card.set] || {}).elem;
      const noOneTitle = (r.noSetMatch
        ? `${setElem ? `Someone owned is ${esc(setElem)}, but n` : 'N'}obody in scope has ${esc(r.card.set)} as one of their own sets.`
        : `${esc(r.card.set)} only works on ${esc(setElem || '')} characters, and none are in scope.`) +
        ' The verdict already counts the Vault\'s view: a card it rates worth a lock reads lock, not feed.';
      return `<tr>
        <td><span class="slot ${r.card.slot}">${r.card.slot.slice(0,3)}</span></td>
        <td>${esc(r.card.set)}</td>
        <td><span class="tag r${r.card.rarity}">${r.card.rarity}★</span></td>
        <td class="tiny">${esc(r.card.main)}</td>
        <td class="tiny muted">${subsInlineHtml(r.card)}</td>
        <td class="tiny">${r.rec ? `${esc(r.rec)} <span class="tag" title="The Upgrades tab recommends equipping this on ${esc(r.rec)}.">upgrade</span>`
          : r.who ? esc(r.who)
          : `<span class="muted" title="${noOneTitle}">— no one in scope</span>`}</td>
        <td class="right score">${r.best.toFixed(1)}</td>
        <td><div class="bar"><i style="width:${p}%"></i></div></td>
        <td>${verdict}</td></tr>`;
    }).join('') + '</tbody>' + (rows.length > 800
      ? `<tfoot><tr><td colspan="9" class="tiny muted">Showing the first 800 rows — narrow the filters to see more.</td></tr></tfoot>` : '');
  $$('#trTable .sortH').forEach(th => th.onclick = () => {
    const key = th.dataset.sort;
    trSort.dir = trSort.key === key ? -trSort.dir : 1;
    trSort.key = key;
    renderTriageTable();
    refocus(`#trTable th.sortH[data-sort="${key}"] .thBtn`);
  });
}

/* ------------------------------ vault ------------------------------ */
/* Triage answers "who on my roster can wear this", and since the element gate went in it
   will honestly answer "no one" for a Strife card when no Fire character is owned. That
   is the right answer to that question and a terrible basis for feeding the card away —
   the inventory outlives the roster, and a fed card does not come back.

   This tab answers the other question: what deserves a lock in the game client because it
   will still be good after the next banner. Two independent reasons, scored separately so
   the reason can be shown rather than hidden inside one number:

   1. Generic damage. Crit Rate, Crit Multiplier, Damage Multiplier, Resistance Pierce and
      ATK% are wanted by essentially every damage dealer the game has shipped, so a card
      loaded with them is a keeper whoever is on the roster. Measured against a synthetic
      target rather than any real character, so pulling or not pulling someone cannot move
      it.
   2. A role you cannot field yet. Near the top of the inventory for one of the eight
      archetypes, which is the whole space of stat profiles the game asks for. This is what
      catches the cards reason 1 refuses on principle — a 3-roll Ailment Accuracy Star is
      junk to a DPS and near-BiS to a Saboteur.

   Every card score in this file is ordinal — comparable only within one character — so
   neither reason can use a raw score. Both normalise, and *how* they normalise is the
   whole design:

   - Per slot, never across slots. A Sun card's main stat is always flat HP, which the
     damage yardstick weights at zero, so Sun cards score structurally below Stars.
     Ranking them in one pool would mark every Sun card feedable and every Star card a
     keeper, which says something about the slots and nothing about the cards.
   - Against archetypes, not characters. Two earlier versions of reason 2 ranked against
     the 65 individual characters and both failed, for the same underlying reason. Scoring
     raw and taking the best over all 65 measures roster size, not card quality, and the
     winner is always one of the two or three characters with the broadest weight vectors
     (Motoha Arai [Tropical] and Junpei Iori); it flagged 28% of a synthetic inventory.
     Normalising per character and *then* taking the best over the ~59 unowned ones is
     worse, not better: a maximum over 59 near-independent percentiles is an extreme-value
     statistic, and with a few hundred cards per slot almost every card is somebody's
     best-in-slot — it reported 100% fit for essentially the entire inventory.
     Eight archetypes, of which about five are genuinely distinct (ST and AoE DPS share a
     weight vector, Navigator and Virtuoso are close to it), is a small enough maximum to
     be stable, and it is the honest unit anyway: what a future character will want from a
     card is their archetype's stat profile, not their name. */

/* The generic-damage yardstick. Spelled out rather than borrowed from ARCHETYPES so a
   later balance tweak to an archetype cannot silently redefine what "lock this" means.
   Support stats are 0 on purpose: a card is only a *generic* keeper if it needs no
   particular character to be worth something, and Speed / SP Recovery / Ailment Accuracy
   are only ever good for the specific units built around them. Those cards are still
   caught, by reason 2. */
const VAULT_TARGET = {
  sets: [], space: '', targets: [],
  main: { Moon: ['Damage Multiplier', 'ATK%'], Star: ['Crit Rate', 'Crit Multiplier'], Sky: ['ATK%'] },
  w: { 'Crit Rate': 9, 'Crit Multiplier': 9, 'Damage Multiplier': 8, 'Resistance Pierce': 7, 'ATK%': 7,
       'ATK': 2, 'Speed': 0, 'SP Recovery': 0, 'Ailment Accuracy': 0, 'HP%': 0, 'DEF%': 0, 'HP': 0, 'DEF': 0 }
};
const VAULT_STATS = ['Crit Rate', 'Crit Multiplier', 'Damage Multiplier', 'Resistance Pierce', 'ATK%'];

const aOrAn = s => (/^[AEIOU]/.test(s) ? 'an ' : 'a ') + esc(s);

/* How much of a card is actually pointed at damage — main plus substats, counted as
   whole lines rather than roll value, because this is the plain-language reason shown
   next to the verdict, not part of the score. */
function damageLines(card) {
  const subs = (card.subs || []).filter(s => VAULT_STATS.indexOf(s.stat) >= 0).length;
  const mainHit = VAULT_STATS.indexOf(card.main) >= 0 ? 1 : 0;
  return { subs, main: !!mainHit, total: subs + mainHit, of: (card.subs || []).length + (card.slot === 'Sun' || card.slot === 'Space' ? 0 : 1) };
}

/* Archetype weights as a target, so cardScore can price a card for a role rather than a
   person. No sets and no stat targets: those belong to individual characters, and the
   point of this tab is to be right about cards for characters that are not on the roster
   yet. Memoised because couplingFactors keys its WeakMap on target identity. */
const archTargetCache = {};
function archTarget(name) {
  if (archTargetCache[name]) return archTargetCache[name];
  const A = ARCHETYPES[name];
  return (archTargetCache[name] = { sets: [], space: '', targets: [], main: A.main, w: A.w });
}

/* Ranks, not shares of the best card. A share-of-best threshold sounds equivalent and is
   not: it depends on how good the single best card happens to be, so the same cutoff
   flagged 59% of one synthetic inventory. A percentile says what it means — "top 2% of my
   Star cards for at least one role" — and the size of the list scales with the inventory
   the way a lock list should. */
const VAULT_LOCK = 0.98;    // top 2% of that slot, for its best role
const VAULT_WATCH = 0.93;   // top 7%: worth holding, not worth a lock

// Column sort for the rendered results table — see trSort above for why this is split
// from the (expensive) scoring pass. Rows are { card, genPct, rolePct, role, rank, ... }.
const vaSort = { key: null, dir: 1 };
const VA_SORT_COLS = { slot: r => r.card.slot, set: r => r.card.set, rarity: r => r.card.rarity,
  damage: r => r.genPct, role: r => r.role, fit: r => r.rolePct };
function sortVaRows(rows) {
  if (!vaSort.key) {
    // Every slot's top card for every role ties at exactly 1, so rank alone leaves ~40
    // rows in arbitrary order at the head of the list. Break on the other measure, then
    // rarity — the same default order runVault always used before a column was clicked.
    return rows.slice().sort((a, b) => b.rank - a.rank
      || (b.genPct + b.rolePct) - (a.genPct + a.rolePct)
      || b.card.rarity - a.card.rarity);
  }
  const getter = VA_SORT_COLS[vaSort.key];
  return rows.slice().sort((a, b) => {
    const av = getter(a), bv = getter(b);
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return cmp * vaSort.dir;
  });
}
function vaSortHeader(key, label, title) { return sortThHtml(key, label, vaSort, title); }

// The last full scoring pass, kept around so changing a filter, "Show" or a sort column
// redraws instantly instead of re-scoring every card against every archetype.
let vaCache = null;
function runVault() {
  const minR = +$('#vaRar').value;
  const cards = state.cards.filter(c => c.rarity >= minR);
  if (!cards.length) { $('#vaSummary').innerHTML = '<p class="muted">No cards at that rarity yet — add some on the Inventory tab.</p>'; $('#vaPanel').classList.add('hide'); return; }
  const { rated, roles, haveRole, rosterRole } = vaultRate(cards);

  const locks = rated.filter(r => r.verdict === 'lock').length;
  const watch = rated.filter(r => r.verdict === 'watch').length;
  const unfielded = rated.filter(r => r.unfielded).length;
  const missing = roles.filter(r => !haveRole[r]);

  $('#vaSummary').innerHTML = `<div class="notice info">
    Of <b>${rated.length}</b> cards, <b>${locks}</b> are worth locking in the game client and
    <b>${watch}</b> more are worth holding.
    <b>${unfielded}</b> of those are for a role you cannot field yet${missing.length
      ? ` — you own no ${missing.map(m => esc(ARCHETYPES[m].label) + ' (' + rosterRole[m] + ' on the roster)').join(', no ')}`
      : ''}.
    Feeding those is the expensive kind of mistake, because Keep or feed will happily call them junk
    until the day you pull the character.</div>`;
  $('#vaPanel').classList.remove('hide');
  vaCache = { rated, tc: teamCritRate(), sig: vaultSig() };
  renderVaultTable();
}

/* The Vault's scoring pass, without the DOM: every card in `cards` against the damage
   yardstick and every archetype, turned into within-slot percentiles over `cards` itself.
   runVault renders it; runTriage reads it to mark a would-be feed the Vault rates worth a
   lock. The percentiles depend on the population, so a caller that wants the Vault tab's
   own verdicts passes the Vault tab's own card set. */
function vaultRate(cards) {
  const roles = Object.keys(ARCHETYPES);
  // Which roles the current roster can already field. Not part of any score — it is the
  // difference between "good card" and "good card you cannot use yet", which is the whole
  // reason this tab exists, so it is reported rather than scored.
  const haveRole = {}, rosterRole = {};
  CHARACTERS.forEach(c => {
    rosterRole[c.arch] = (rosterRole[c.arch] || 0) + 1;
    if (state.chars[c.n].owned && !state.chars[c.n].benched) haveRole[c.arch] = (haveRole[c.arch] || 0) + 1;
  });

  /* Score every card for every role and for the damage yardstick, keeping the results,
     because the normaliser is a per-slot maximum that is only known once the whole
     inventory has been scored. Eight roles plus one yardstick over 4000 cards is well
     under what Triage already does against 65 characters. */
  const N = cards.length, R = roles.length;
  const grid = new Float64Array(N * R);
  const gen = new Float64Array(N);
  cards.forEach((card, i) => {
    const c = atMaxLevel(card);   // main at its final magnitude, substats as rolled — see atMaxLevel
    gen[i] = cardScore(c, VAULT_TARGET);
    for (let j = 0; j < R; j++) grid[i * R + j] = cardScore(c, archTarget(roles[j]));
  });

  /* Raw scores become within-slot percentiles in place. Ranking across slots instead
     would say something about the slots and nothing about the cards: a Sun card's main
     stat is always flat HP, which the damage yardstick weights at zero, so every Sun card
     would read as feedable and every Star card as a keeper. */
  const slotIdx = {};
  cards.forEach((c, i) => (slotIdx[c.slot] = slotIdx[c.slot] || []).push(i));
  const ranked = (read, write) => {
    for (const slot in slotIdx) {
      const ord = slotIdx[slot].slice().sort((a, b) => read(a) - read(b));
      ord.forEach((i, k) => write(i, ord.length > 1 ? k / (ord.length - 1) : 1));
    }
  };
  const genP = new Float64Array(N);
  ranked(i => gen[i], (i, v) => genP[i] = v);
  for (let j = 0; j < R; j++) {
    const col = new Float64Array(N);
    ranked(i => grid[i * R + j], (i, v) => col[i] = v);
    for (let i = 0; i < N; i++) grid[i * R + j] = col[i];
  }

  const rated = cards.map((card, i) => {
    let rolePct = 0, role = roles[0];
    for (let j = 0; j < R; j++) {
      const rel = grid[i * R + j];
      if (rel > rolePct) { rolePct = rel; role = roles[j]; }
    }
    const best = Math.max(genP[i], rolePct);
    const verdict = best >= VAULT_LOCK ? 'lock' : best >= VAULT_WATCH ? 'watch' : '';
    return { card, genPct: genP[i], rolePct, role, verdict, unfielded: !!verdict && !haveRole[role],
      lines: damageLines(card), rank: best };
  });
  return { rated, roles, haveRole, rosterRole };
}

/* What a Triage run read, and nothing it did not, or the banner cries wolf: every card and who
   wears it; who is owned; the targets and setups of the characters it rated and of anyone
   wearing a card (Upgrades' trade pricing, which Triage reads for the cards it keeps, prices
   what taking a card costs its wearer); the team crit rate; and the controls that shape the
   run — its own scope and rarity floor, the Upgrades settings and the Vault's floor. */
function triageSig() {
  const detail = new Set(($('#trScope').value === 'owned' ? ownedChars() : CHARACTERS).map(c => c.n));
  state.cards.forEach(c => { if (c.equipped) detail.add(c.equipped); });
  return cardsSig(true) + ':' + charsSig(detail) + ':' + teamCritRate() + ':' + denSig() + '|' + [$('#trScope').value, $('#trRar').value,
    $('#upRar').value, $('#upSameSet').checked, $('#upIgnoreEquipped').checked, $('#vaRar').value].join(',');
}
/* The Vault prices the cards' own contents against archetypes: not who wears them, not their
   locks, not targets or setups. Ownership only decides which roles it reports as unfielded.
   Hashing wearers flagged it stale after every equip, on the screen meant to stop a keeper
   being fed, until the warning meant nothing. */
function vaultSig() { return cardsSig(false) + ':' + charsSig(null) + ':' + teamCritRate() + '|' + $('#vaRar').value; }

/* Triage and the Vault score on their Run buttons and keep the result; neither re-runs a sweep
   of a second or two on every edit. So each result says when what it read has changed since —
   an import, an equip, a newly owned character, a Setup or target edit, the team crit rate, or
   its own controls — with a Re-run beside it. Until Sep 2026 only the team crit rate was
   checked, and a Triage run went on showing its old verdicts after an import without a word,
   on the one screen whose "feed" cannot be undone. The check is a comparison of fingerprints
   (see dataSignature), so an undo, or a value set back, reads as current again. */
function markStaleRuns() {
  [['#trSummary', trCache, triageSig, '#trRun'], ['#vaSummary', vaCache, vaultSig, '#vaRun'], ['#ccSummary', ccCache, ccSig, '#ccRun'], ['#ikSummary', ikCache, ikSig, '#ikRun'], ['#frSummary', frCache, frSig, '#frRun'], ['#rgSummary', rgCache, rgSig, '#rgRun']].forEach(([id, cache, sig, btn]) => {
    const box = $(id);
    if (!box || !cache) return;
    const old = box.querySelector('.stale-run');
    if (old) old.remove();
    if (cache.sig === sig()) return;
    const tc = cache.tc !== teamCritRate();
    box.insertAdjacentHTML('afterbegin', `<div class="notice stale-run${tc ? ' stale-tc' : ''}"><span>Scored before your latest
      changes${tc ? `, with a team crit rate of ${esc(String(cache.tc))}% (now ${esc(String(teamCritRate()))}%)` : ''}. The verdicts
      below may be out of date.</span><button class="sm" type="button">Re-run</button></div>`);
    box.querySelector('.stale-run button').onclick = () => $(btn).click();
  });
}
// Filters (Show + slot/set/rarity/main/substat/search) and sorts vaCache.rated and draws
// #vaTable — split out of runVault() so none of that redraw re-scores the inventory.
function renderVaultTable() {
  if (!vaCache) return;
  const show = $('#vaShow').value;
  const f = { sl: $('#vaFlSlot').value, st: $('#vaFlSet').value, r: $('#vaFlRar').value,
    mn: $('#vaFlMain').value, subSel: vaFlSubSelected, subAny: $('#vaFlSubMode').value === 'any',
    q: $('#vaFlQ').value.trim().toLowerCase() };
  const filtered = vaCache.rated
    .filter(r => show === 'all' ? true : show === 'watch' ? r.verdict : r.verdict === 'lock')
    .filter(r => cardMatchesFilter(r.card, f));
  const list = sortVaRows(filtered);
  $('#vaFlCount').textContent = `${list.length} shown of ${vaCache.rated.length}`;
  $('#vaTable').innerHTML = `<thead><tr>
      ${vaSortHeader('slot', 'Slot')}${vaSortHeader('set', 'Set')}${vaSortHeader('rarity', '★')}<th>Main</th><th>Substats</th>
      ${vaSortHeader('damage', 'Damage', 'Value against a generic damage dealer, as a share of the best card you own in this same slot. No real character is involved, so pulling someone cannot change it.')}
      ${vaSortHeader('role', 'Best role', 'The archetype this card suits best, out of all eight. What a future character wants from a card is their role\'s stat profile, not their name.')}
      ${vaSortHeader('fit', 'Fit', 'How close this card is to the best card you own in this slot for that role.')}
      <th>Why</th><th>Verdict</th>
    </tr></thead><tbody>` +
    list.slice(0, 800).map(r => {
      // Only name the damage stats when the damage yardstick is actually what flagged the
      // card. On a Saboteur pick "1/5 damage stats" is a true number and the wrong reason.
      const why = [];
      if (r.genPct >= VAULT_WATCH) why.push(`${r.lines.total}/${r.lines.of} damage stats`);
      if (r.rolePct >= VAULT_WATCH) why.push(`top ${Math.max(1, Math.round((1 - r.rolePct) * 100))}% of your ${esc(r.card.slot)} cards for ${aOrAn(ARCHETYPES[r.role].label)}`);
      if (r.unfielded) why.push(`you own no ${esc(ARCHETYPES[r.role].label)}`);
      const verdict = r.verdict === 'lock' ? '<span class="tag hit">lock</span>'
        : r.verdict === 'watch' ? '<span class="tag">hold</span>' : '<span class="tag miss">—</span>';
      return `<tr>
        <td><span class="slot ${r.card.slot}">${r.card.slot.slice(0,3)}</span></td>
        <td>${esc(r.card.set)}</td>
        <td><span class="tag r${r.card.rarity}">${r.card.rarity}★</span></td>
        <td class="tiny">${esc(r.card.main)}</td>
        <td class="tiny muted">${subsInlineHtml(r.card)}</td>
        <td class="right score">${Math.round(r.genPct * 100)}%</td>
        <td class="tiny">${esc(ARCHETYPES[r.role].label)}${r.unfielded ? ' <span class="tag miss">none owned</span>' : ''}</td>
        <td class="right score">${Math.round(r.rolePct * 100)}%</td>
        <td class="tiny muted">${why.join(' · ') || '—'}</td>
        <td>${verdict}</td></tr>`;
    }).join('') + '</tbody>' + (list.length > 800
      ? `<tfoot><tr><td colspan="10" class="tiny muted">Showing the first 800 rows — narrow the filters to see more.</td></tr></tfoot>` : '');
  $$('#vaTable .sortH').forEach(th => th.onclick = () => {
    const key = th.dataset.sort;
    vaSort.dir = vaSort.key === key ? -vaSort.dir : 1;
    vaSort.key = key;
    renderVaultTable();
    refocus(`#vaTable th.sortH[data-sort="${key}"] .thBtn`);
  });
}

/* ------------------------------ upgrades ------------------------------ */
/* Optimise answers "what should this one character wear" if you go pick them and run it.
   This tab is the sweep across everyone owned at once, diffed against what is actually
   equipped right now — reusing bestPlan rather than re-deriving its picks, so a change to
   set policy or the spread/breakpoint terms cannot make this tab disagree with Optimise.

   With "Ignore cards equipped on someone else" unticked, the pool is every card in the
   inventory, whoever is currently wearing it — Optimise's "All cards" mode — so a suggestion
   can point at a card equipped on someone else. That has to stay visible rather than silently resolved: reassigning it
   is a real trade against another character's build, not a free upgrade, so the owner's
   name is shown next to it and the swap is one click, not automatic. */
/* The smallest suggestion worth listing, in build points — the Gain column's own precision.
   It used to be one RAW point, and a raw point is a different amount for everyone (0.12 of a
   build point for a character with a large yardstick, 0.19 for a small one), so the same
   swap could be listed for one character and dropped for another. */
const UPGRADE_MIN_GAIN = 0.1;
const HEAVENS = ['Sun', 'Moon', 'Star', 'Sky'];

/* What a suggestion is worth as an action: the bundle's total for a row that is part of a
   multi-slot 4-piece swap, its own marginal otherwise. Ordering has to use this rather than
   `delta`, or a character whose one real move is a 30-point set switch made of four small
   individual marginals sorts below one with a single 8-point card swap.

   `upGain` is in the character's raw units — fine for ordering one character's rows, which
   share a yardstick — and `upPts` in build points, the build score's own 0-100 scale, which
   is what orders characters against each other and what the Gain column shows. The two
   differ by the character's perfect total: one raw point was 0.10 of a build point for
   Tropical Motoha and 0.17 for Kiyoshi, so ranking characters on raw gains put whoever has
   the largest yardstick first. `upPts` is net of what a trade costs the character it takes a
   card from (`lossPts`, set only when cards on someone else are allowed): build points are one
   scale for everyone, so the two sides of a trade subtract. */
function upGain(row) { return row.group != null ? row.group : row.delta; }
function upPts(row) { return (row.groupPts != null ? row.groupPts : row.pts) - (row.lossPts || 0); }

/* Signed, because a per-slot marginal genuinely can be negative — one card out of a
   complete 4-piece is a set bonus lost for a stat gain that rarely covers it, and printing
   that as "+" would be a lie about the direction of the change, not just its size. */
function gainStr(v) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1); }

/* Per-card cardScore comparisons used to compare Heavens slots one at a time, which is
   how a card from "a different set" than the one actually equipped could get recommended:
   a single higher-scoring card can beat what is worn in that slot while breaking the
   4-piece bonus the other three slots depend on, without ever completing a replacement
   set. So this only ever proposes a FULL 4-piece from the character's configured
   preferred or alternative set (`t.sets` — never a 2+2, and never a third set the
   optimiser only picked because nothing preferred was complete), and only when that whole
   loadout's total beats what is actually equipped now — through `r.loadoutTotal`, the
   objective bestPlan picked r.best by, which is the build score's own numerator, so a swap
   that only helps stat spread or a stat target (or only hurts it) is never missed or
   over-credited by comparing on a cards-and-sets-only basis instead. Every row is priced
   as a whole loadout with whatever it does not change left exactly as worn — the Space
   card included, so a Heavens switch that costs the worn Space card its pairing is charged
   for it here, and the Space row below says what fixing that is worth.

   `sameSetOnly` narrows that further, to just whichever single set is actually active on
   the character right now (`activeSet`) instead of the whole `t.sets` list — so a character
   with two configured sets (e.g. a preferred and an alternative) never gets a proposed
   switch away from the one they are already built around, only better cards within it.
   With nothing currently active there is no set to stay in, so it falls back to the normal
   `t.sets` behaviour rather than suppressing every full-set suggestion. The Space pick below
   honours the same flag against the Space card's own set, not the Heavens one — otherwise
   "stay in set" would hold the Heavens 4-piece still while letting Space wander to whichever
   other Space set scores highest.

   `ignoreEquipped` narrows the pool further, to cards this character could take without
   touching anyone else's build — unequipped cards plus whatever this character already
   wears. Every suggestion becomes a free reshuffle rather than a trade against another
   character, at the cost of missing upgrades that would require taking a card off someone
   else. */
function upgradesFor(char, minR, sameSetOnly, ignoreEquipped) {
  const t = target(char);
  const pool = state.cards.filter(c => c.rarity >= minR && (!c.locked || c.equipped === char.n)
    && (!ignoreEquipped || !c.equipped || c.equipped === char.n));
  const P4 = 55;
  const targetSets = (t.sets || []).filter(s => SETS[s]);

  const r = bestPlan(char, pool, { policy: 'force4', p4value: P4 });
  if (!r.best) return [];

  const curHeavens = HEAVENS.map(sl => state.cards.find(c => c.equipped === char.n && c.slot === sl));
  const curSpace = state.cards.find(c => c.equipped === char.n && c.slot === 'Space');
  const totalOf = (heav, space) => r.loadoutTotal(heav.concat([space])).total;
  const now = r.loadoutTotal(curHeavens.concat([curSpace]));
  const curTotal = now.total;
  // build points per raw point: the build score divides every loadout by this same perfect total
  const perPt = now.idealTotal > 0 ? 100 / now.idealTotal : 0;
  let heavensAfter = curHeavens;   // what the Heavens will be once the rows below are equipped

  const rows = [];
  let activeSet = loadoutSetBonus(curHeavens.filter(Boolean), char, t, P4).active4;
  const allowedSets = (sameSetOnly && activeSet) ? [activeSet] : targetSets;

  /* Two different numbers, and conflating them is a real reading error: `group` is what
     the whole proposed 4-piece is worth over what is worn, `delta` is what THIS row's one
     Equip click is worth on its own — that card swapped in with the other three slots left
     exactly as they are. They are not the same and they do not sum, because the plan's
     value is mostly the set bonus, which only lands once all four are in place: a single
     swap out of a complete set can even be negative while the group is strongly positive.
     Every row used to carry `group`, so a three-row suggestion read as three separate +28s
     when there was one +28 on the table. The gate stays on `group` — the plan is judged as
     a plan — but the per-row marginal is what the button beside it actually does. */
  if (r.best.kind === '4pc' && allowedSets.includes(r.best.sets[0])) {
    const recHeavens = HEAVENS.map(sl => r.best.picks[sl].c);
    const group = totalOf(recHeavens, curSpace) - curTotal;
    if (group * perPt >= UPGRADE_MIN_GAIN) {
      const changed = [];
      HEAVENS.forEach((sl, i) => {
        const cur = curHeavens[i], rec = r.best.picks[sl];
        if (cur && cur.id === rec.c.id) return;
        const one = curHeavens.slice();
        one[i] = rec.c;
        const delta = totalOf(one, curSpace) - curTotal;
        changed.push({ slot: sl, cur, curScore: cur ? cardScore(cur, t) : 0, rec: rec.c, recScore: cardScore(rec.c, t), delta, pts: delta * perPt });
      });
      /* With one row the marginal IS the group, so there is nothing extra to report.
         `groupSwitch` separates the two cases the footer has to describe differently:
         moving the character into a set they are not wearing (where the 4-piece bonus is
         most of the number, and equipping three of the four buys none of it) from swapping
         better cards inside the set they already wear (where the shortfall against the sum
         of the parts is only the spread and breakpoint terms not being additive). */
      const switching = r.best.sets[0] !== activeSet;
      if (changed.length > 1) changed.forEach(row => {
        row.group = group;
        row.groupPts = group * perPt;
        row.groupSet = r.best.sets[0];
        row.groupSwitch = switching;
      });
      rows.push(...changed);
      activeSet = r.best.sets[0];
      heavensAfter = recHeavens;
    }
  }

  /* Space is judged against whichever 4-piece is actually active once the Heavens rows
     above are decided — the new target set if a swap was just proposed, otherwise
     whatever the character is already wearing — so a Space pick never assumes a Heavens
     switch that was rejected for mixing sets. The candidate is chosen by the pairing/pref
     rule bestPlan uses for its own Space pick (see spaceChoice there), recomputed locally
     because that pool is scored against bestPlan's own (possibly off-target) active4 — but
     its Gain is priced like the Heavens rows', as the whole loadout with this one card
     swapped in, so it counts what the card's substats do for the stat targets and the
     spread and sits on the same scale as the rows beside it. It used to be cardScore plus
     the pairing bonus, comparable only to other Space candidates. */
  const spaceScore = c => {
    const sp = SPACE_SETS[c.set];
    const pairs = !!(sp && activeSet && sp.pairs.includes(activeSet));
    return cardScore(c, t) + (pairs ? SPACE_PAIR_VALUE : 0) + (c.set === t.space && pairs ? 4 : 0);
  };
  // Same reasoning as allowedSets above, applied to the Space card's own set rather than
  // the Heavens 4-piece: with the checkbox on and a Space card already equipped, a full
  // switch to a different Space set is suppressed, only better cards within it are offered.
  const spacePool = pool.filter(c => c.slot === 'Space'
    && (!sameSetOnly || !curSpace || c.set === curSpace.set));
  let bestSpace = null;
  spacePool.forEach(c => {
    const s = spaceScore(c);
    if (!bestSpace || s > bestSpace.s) bestSpace = { c, s };
  });
  if (bestSpace && !(curSpace && curSpace.id === bestSpace.c.id)) {
    const delta = totalOf(heavensAfter, bestSpace.c) - totalOf(heavensAfter, curSpace);
    if (delta * perPt >= UPGRADE_MIN_GAIN) rows.push({ slot: 'Space', cur: curSpace, curScore: curSpace ? cardScore(curSpace, t) : 0,
      rec: bestSpace.c, recScore: cardScore(bestSpace.c, t), delta, pts: delta * perPt });
  }

  /* A card taken off someone else is a trade, and every Gain above counts only this side of
     it. On the real inventory (Sep 2026, with this box unticked) 62 rows took a card from
     another character, and for 39 of them the giver lost more than the receiver gained, even
     after putting back their best free card of that slot: six characters were each told to
     take Futaba's Resolve Space card, worth 0.8-3.3 to them and 4.3 to her. So each trade
     carries what it costs the giver (`lossPts`, build points, see giverLoss) — for a 4-piece
     switch, everything the switch takes, from everyone — and upPts nets it off, which is what
     orders the characters. Nothing is hidden: the user may value one character over another,
     and build points cannot know that. */
  if (!ignoreEquipped) {
    const isTrade = x => x.rec.equipped && x.rec.equipped !== char.n;
    const used = new Set(rows.map(x => x.rec.id));
    const lossOf = subset => {
      const byGiver = {};
      subset.filter(isTrade).forEach(x => (byGiver[x.rec.equipped] = byGiver[x.rec.equipped] || []).push(x.rec));
      return Object.keys(byGiver).reduce((s, n) => s + giverLoss(charDef(n), byGiver[n], used, minR), 0);
    };
    const grouped = rows.filter(x => x.group != null);
    const groupLoss = grouped.some(isTrade) ? lossOf(grouped) : 0;
    rows.forEach(x => {
      x.lossPts = x.group != null ? groupLoss : isTrade(x) ? lossOf([x]) : 0;
      if (isTrade(x)) x.giverPts = lossOf([x]);
    });
  }

  /* Grouped rows rank by what the bundle is worth, so a 4-piece swap stays contiguous and
     above/below the Space row as one block rather than being interleaved by its members'
     individual marginals — some of which are small or negative precisely because the value
     is in the set. Within the block the biggest single win comes first. */
  return rows.sort((a, b) => upGain(b) - upGain(a) || b.delta - a.delta);
}

/* What `giver` loses, in build points, when the cards in `taken` (all worn by them) go to
   someone else and each vacated slot gets the giver's best free card of that slot — the same
   set first, so a like-for-like replacement keeps their set bonus — from cards nobody in this
   plan is about to take (`used`). That is the immediate cost, not a re-plan: a full Optimise
   run for the giver may find them better, so read it as an upper bound on the damage.

   It is measured against the giver keeping, per slot, the better of the card they wear and
   that free one — never against what they wear now. A free card that beats the worn one is
   an upgrade the giver can make anyway, trade or no trade, so crediting it to the trade made a
   loss negative: on the real inventory Yaoling "lost" -9.6 giving up a Prosperity Sky whose
   free replacement was better, and the receiver's net read 12.1 on a 4.4 gain. So a loss is
   never below 0, and a net never above the receiver's own gain. */
function giverLoss(giver, taken, used, minR) {
  const t = target(giver), lo = charLoadout(giver.n), idl = idealLoadout(giver, t, 55);
  const score = cards => { const b = buildScoreOf(giver, cards, 55, lo, idl, t); return b ? b.raw : 0; };
  const worn = state.cards.filter(c => c.equipped === giver.n);
  const refill = new Map();
  taken.forEach(c => {
    const free = state.cards.filter(x => !x.equipped && !x.locked && !used.has(x.id) && x.slot === c.slot && x.rarity >= minR);
    const same = free.filter(x => x.set === c.set);
    let best = null;
    (same.length ? same : free).forEach(x => { const s = cardScore(x, t); if (!best || s > best.s) best = { x, s }; });
    if (best) refill.set(c.id, best.x);
  });
  let keep = worn;
  taken.forEach(c => {
    const alt = refill.get(c.id);
    if (!alt) return;
    const tried = keep.map(x => x.id === c.id ? alt : x);
    if (score(tried) > score(keep)) keep = tried;
  });
  const gone = new Set(taken.map(c => c.id));
  const lose = worn.filter(c => !gone.has(c.id)).concat(taken.map(c => refill.get(c.id)).filter(Boolean));
  return Math.max(0, score(keep) - score(lose));
}

function runUpgrades() {
  const minR = +$('#upRar').value;
  const sameSetOnly = $('#upSameSet').checked;
  const ignoreEquipped = $('#upIgnoreEquipped').checked;
  const chars = ownedChars();
  if (!chars.length) {
    $('#upSummary').innerHTML = '<p class="muted">Mark some characters as owned on the Roster tab first.</p>';
    $('#upPanel').classList.add('hide');
    return;
  }
  // characters against each other on the build score's own scale — see upPts
  const results = chars.map(c => ({ c, rows: upgradesFor(c, minR, sameSetOnly, ignoreEquipped) })).filter(r => r.rows.length)
    .sort((a, b) => Math.max(...b.rows.map(upPts)) - Math.max(...a.rows.map(upPts)));

  $('#upSummary').innerHTML = `<div class="notice info">
    <b>${results.length}</b> of <b>${chars.length}</b> owned characters have a better card sitting
    somewhere in the inventory than what they currently wear. ${ignoreEquipped
      ? 'Only unequipped cards are proposed, plus whatever each character already wears — nothing here takes a card off someone else.'
      : 'Cards equipped on someone else are proposed too, tagged with what taking the card costs that character (their build points lost after they put back their best free card of the slot); each move shows its <b>net</b>, which is how the characters are ordered.'}
    ${sameSetOnly ? ' Each character stays in the Heavens set and Space set they wear now.' : ''}
    Open Optimise for a character to see the other set plans it considered.</div>`;
  $('#upPanel').classList.toggle('hide', !results.length);
  if (!results.length) return;

  $('#upList').innerHTML = results.map(({ c, rows }) => { const t = target(c); return `
    <div class="panel">
      <h3 style="margin-top:0">${esc(c.n)}${c.a ? ` <span class="tiny muted">(${esc(c.a)})</span>` : ''}</h3>
      <table><thead><tr>
        <th>Slot</th><th>Currently wearing</th><th></th><th>Better card</th>
        <th class="right">Gain</th><th></th>
      </tr></thead><tbody>${rows.map((row, i) => {
        const ownedBy = row.rec.equipped && row.rec.equipped !== c.n ? row.rec.equipped : null;
        const subsHtml = card => subsInlineHtml(card, t);
        /* A grouped row's own Gain is only part of the story — the set bonus lands once,
           when the last of them is equipped — so the block gets one footer carrying the
           bundle's total and a button that equips all of it at once. Rendered after the
           block's last row; upgradesFor keeps grouped rows contiguous. */
        const groupEnd = row.group != null && (i === rows.length - 1 || rows[i + 1].group == null);
        const groupRows = groupEnd ? rows.filter(x => x.group != null) : [];
        const foot = groupEnd ? `<tr class="upGroup">
          <td></td>
          <td class="tiny muted" colspan="3">All ${groupRows.length} together${row.groupSwitch
            ? ` — the move into ${esc(row.groupSet)}. Most of this is the 4-piece bonus, and that lands
                only once every one of them is worn, so equipping some of them is worth the small
                numbers above, not a share of this one.`
            : ` — one plan, inside the set already worn. The parts do not quite add up to it, because
                stat spread and the stat targets are not additive across slots.`}</td>
          <td class="right score">${gainStr(row.groupPts)}${row.lossPts
            ? `<div class="tiny muted" title="What the whole switch adds here, minus what the cards it takes cost the characters wearing them now">net ${gainStr(upPts(row))}</div>` : ''}</td>
          <td><button class="ghost tiny upSwapAll" data-char="${esc(c.n)}"
            data-swaps="${esc(groupRows.map(x => x.slot + ':' + x.rec.id).join(','))}">Equip all</button></td>
        </tr>` : '';
        return `<tr>
          <td><span class="slot ${row.slot}">${row.slot.slice(0,3)}</span></td>
          <td class="tiny">${row.cur
            ? `${esc(row.cur.set)} · ${esc(row.cur.main)} <span class="muted">(${cardPct(row.curScore, row.slot, t)})</span>
               <div class="tiny muted">${subsHtml(row.cur)}</div>`
            : '<span class="muted">empty</span>'}</td>
          <td class="tiny muted">&rarr;</td>
          <td class="tiny">${esc(row.rec.set)} <span class="tag r${row.rec.rarity}">${row.rec.rarity}★</span> ·
            ${esc(row.rec.main)} <span class="muted">(${cardPct(row.recScore, row.slot, t)})</span>
            ${ownedBy ? ` <span class="tag" title="Currently equipped on ${esc(ownedBy)} — swapping unequips it from them${row.giverPts != null
              ? `, and costs them ${esc(row.giverPts.toFixed(1))} build points even after they put back their best free card of this slot (same set first; a full Optimise run may find them better)` : ''}">on ${esc(ownedBy)}${row.giverPts != null ? ` · ${esc(gainStr(-row.giverPts))}` : ''}</span>` : ''}
            <div class="tiny muted">${subsHtml(row.rec)}</div></td>
          <td class="right score${row.delta > 0 ? '' : ' muted'}"
            title="${row.group != null
              ? 'Build points this one card adds on its own, with the other slots left as they are — see the total below'
              : 'Build points this card adds, with the character\'s other slots left as they are'}">${gainStr(row.pts)}${row.group == null && row.lossPts
              ? `<div class="tiny muted" title="What this card adds here, minus what taking it costs the character wearing it now">net ${gainStr(upPts(row))}</div>` : ''}</td>
          <td><button class="ghost tiny upSwap" data-char="${esc(c.n)}" data-slot="${esc(row.slot)}" data-card="${esc(row.rec.id)}">
            ${ownedBy ? 'Take it' : 'Equip'}</button></td>
        </tr>${foot}`;
      }).join('')}</tbody></table>
    </div>`; }).join('');

  $$('#upList .upSwap').forEach(b => b.onclick = () => swapCard(b.dataset.char, b.dataset.slot, b.dataset.card));
  $$('#upList .upSwapAll').forEach(b => b.onclick = () => {
    const swaps = b.dataset.swaps.split(',').map(s => ({ slot: s.slice(0, s.indexOf(':')), id: s.slice(s.indexOf(':') + 1) }));
    const snap = snapshotState();
    swapCards(b.dataset.char, swaps);
    offerUndo(`Equipped ${swaps.length} cards on ${b.dataset.char}.`, snap);
  });
}

/* --------------------- weakest slots (headroom) ---------------------
   The other view asks "what can I equip right now"; this one asks "where is each
   character furthest from the best card that could exist in the slot", which is a
   different question with a different answer. A slot can hold the best card you own and
   still be the weakest thing on the character — exactly the case the swap list cannot
   show, because there is nothing to swap to.

   The measure is `cardHeadroom` (see cardPct/cardHeadroom above): the raw points between
   the equipped card and `idealCard` for that slot and character. Its documented scope is
   one character's five slots — raw scores are in that character's own weight units, and a
   character with a fatter ideal has more headroom everywhere without being worse geared —
   so a roster-wide list sorted by it would partly be ranking characters by the size of
   their own yardstick. That is what `gain` is for: the same question run through
   buildScore, which divides by the character's own perfect loadout and is therefore the
   one number here that compares across characters. Both columns are shown, the table
   sorts on `gain` by default, and the blurb says which is which. Nothing in this view
   scores or optimises anything — it is a reading of what is already equipped. */
const HR_P4 = 55;

/* Which set a hypothetical perfect card for an EMPTY slot should carry. A filled slot
   uses the set of the card already in it, so the perfect-card comparison changes the card
   and nothing else — no set bonus appears or vanishes underneath the delta. An empty slot
   has no such anchor, so it takes whatever set the rest of the loadout is already built
   around (a Space card the preferred one, or any that pairs with the active 4-piece),
   which is the set a real replacement would actually carry. */
function hrSetFor(slot, worn, t) {
  const counts = {};
  worn.forEach(c => { if (c.slot !== 'Space' && SETS[c.set]) counts[c.set] = (counts[c.set] || 0) + 1; });
  const ranked = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (slot !== 'Space') return ranked[0] || (t.sets || []).filter(x => SETS[x])[0] || '';
  const active = ranked.filter(s => counts[s] >= 4)[0] || null;
  if (!active) return t.space || '';
  if (t.space && SPACE_SETS[t.space] && SPACE_SETS[t.space].pairs.indexOf(active) >= 0) return t.space;
  return Object.keys(SPACE_SETS).filter(s => SPACE_SETS[s].pairs.indexOf(active) >= 0)[0] || t.space || '';
}

/* One row per (owned character, slot). `alt` is the best card of the SAME slot AND SAME
   set sitting in the inventory — same set is not a convenience, it is what makes the
   number honest: a within-set swap cannot change how many pieces of any set are worn, so
   the set bonus is identical either side of it and the delta really is the card. Offering
   the best card of the slot regardless of set is the mistake upgradesFor's header comment
   describes — it breaks a 4-piece for a stat gain that rarely covers it — and the other
   view already runs the full plan search that can weigh that trade properly.

   The winner is picked and reported on the buildScore delta, so both gain columns carry the
   same unit and it agrees with Optimise and the card picker (see the loop below). */
function headroomRows(takeEquipped) {
  const wornBy = equippedByChar();
  const bySlotSet = {};
  state.cards.forEach(c => {
    const k = c.slot + ' ' + c.set;
    (bySlotSet[k] = bySlotSet[k] || []).push(c);
  });
  const rows = [];
  ownedChars().forEach(ch => {
    const t = target(ch), lo = charLoadout(ch.n), idl = idealLoadout(ch, t, HR_P4);
    const mine = wornBy[ch.n] || [];
    /* Both gains subtract from this, so a bare character is measured from what their base
       stats already earn rather than from 0 (see buildScoreOf); `base` is only for display. */
    const now = buildScoreOf(ch, mine, HR_P4, lo, idl, t);
    const base = mine.length ? now : null;
    const baseRaw = now ? now.raw : 0;
    /* Headroom shares split this character's own total, so they are computed over all five
       slots before any filter narrows the table — otherwise "38% of the work left on this
       character" would change meaning the moment a slot filter was applied. */
    const per = SLOTS.map(slot => {
      const card = mine.filter(c => c.slot === slot)[0] || null;
      const score = card ? cardScore(card, t) : 0;
      return { slot, card, score, room: cardHeadroom(score, slot, t), pct: cardPct(score, slot, t) };
    });
    const totalRoom = per.reduce((a, x) => a + x.room, 0);
    per.forEach(x => {
      const others = mine.filter(c => c.slot !== x.slot);
      const perfectSet = x.card ? x.card.set : hrSetFor(x.slot, others, t);
      const perfect = buildScore(ch, others.concat([idealCard(x.slot, t, perfectSet)]), HR_P4, lo, idl, t);
      /* Every same-set candidate is priced by the build score it would give, and the best of
         those wins. It used to be picked on cardScore and only then priced, and only among
         cards scoring higher than the worn one, so a card the build score rates higher but
         whose own score is lower was never offered — the case the whole-loadout terms (stat
         targets, damage spread) exist for, and the one Optimise's same-set swap pass picks:
         Kotone Shiomi's Crit Rate Star, 28 Sep 2026, 67 against a worn 72 and 0.1 higher built.
         A pick that still comes out flat or negative is dropped rather than printed as an
         upgrade, which would misdescribe what the button does. */
      let alt = null, altGain = 0;
      if (x.card) {
        (bySlotSet[x.slot + ' ' + x.card.set] || []).forEach(c => {
          if (c.id === x.card.id) return;
          if (c.locked && c.equipped !== ch.n) return;                  // locked to its current wearer
          if (!takeEquipped && c.equipped && c.equipped !== ch.n) return;
          const after = buildScoreOf(ch, others.concat([c]), HR_P4, lo, idl, t);
          const g = (after ? after.raw : 0) - baseRaw;
          if (g > altGain) { alt = c; altGain = g; }
        });
        if (altGain < 0.05) { alt = null; altGain = 0; }
      }
      rows.push({ ch, t, slot: x.slot, card: x.card, score: x.score, pct: x.pct, room: x.room,
        share: totalRoom > 0 ? x.room / totalRoom : 0,
        build: base ? base.score : null,
        gain: Math.max(0, (perfect ? perfect.raw : 0) - baseRaw),
        alt, altGain });
    });
  });
  return rows;
}

const hrSort = { key: null, dir: 1 };
const HR_SORT_COLS = {
  char: r => r.ch.n, slot: r => SLOTS.indexOf(r.slot), card: r => r.pct,
  room: r => r.room, share: r => r.share, gain: r => r.gain, avail: r => r.altGain
};
function hrSortHeader(key, label, title) { return sortThHtml(key, label, hrSort, title); }
function sortHrRows(rows) {
  /* Default: biggest cross-character opportunity first, with the character's own headroom
     as the tie-break so their five slots stay in a sensible order among themselves. */
  if (!hrSort.key) return rows.slice().sort((a, b) => b.gain - a.gain || b.room - a.room);
  const get = HR_SORT_COLS[hrSort.key];
  return rows.slice().sort((a, b) => {
    const av = get(a), bv = get(b);
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return (cmp || a.ch.n.localeCompare(b.ch.n) || SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot)) * hrSort.dir;
  });
}

/* Split the same way Triage and Vault are: the scoring pass above walks every owned
   character's loadout through buildScore, so a filter or a sort column must not re-run it. */
let hrRowsCache = [];
function runHeadroom() {
  if (!$('#hrTable')) return;
  const chars = ownedChars();
  if (!chars.length) {
    $('#hrSummary').innerHTML = '<p class="muted">Mark some characters as owned on the Roster tab first.</p>';
    $('#hrPanel').classList.add('hide');
    hrRowsCache = [];
    return;
  }
  hrRowsCache = headroomRows($('#hrTakeEquipped').checked);
  renderHeadroomTable();
}

function renderHeadroomTable() {
  if (!hrRowsCache.length) return;
  const show = $('#hrShow').value, el = $('#hrElement').value, slot = $('#hrSlot').value;
  const rar = $('#hrRar').value, min = parseFloat($('#hrMin').value);
  const q = $('#hrQ').value.trim().toLowerCase();

  /* "Worst slot" is picked over the character's whole loadout and only then filtered like
     any other row, so the option keeps meaning "this character's weakest slot" rather than
     quietly becoming "the weakest of whatever the other filters left standing". */
  let rows = hrRowsCache;
  if (show === 'worst') {
    const best = {};
    rows.forEach(r => { if (!best[r.ch.n] || r.room > best[r.ch.n].room) best[r.ch.n] = r; });
    rows = Object.keys(best).map(k => best[k]);
  }
  rows = rows.filter(r => {
    if (show === 'empty' && r.card) return false;
    if (show === 'fixable' && !r.alt) return false;
    if (el && r.ch.e !== el) return false;
    if (slot && r.slot !== slot) return false;
    if (rar && (!r.card || r.card.rarity !== +rar)) return false;
    if (min > 0 && r.room < min) return false;
    if (q) {
      const hay = [r.ch.n, r.ch.a || '', r.slot, r.card ? r.card.set : 'empty',
        r.card ? r.card.main : ''].join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });

  const list = sortHrRows(rows);
  const totalGain = hrRowsCache.reduce((a, r) => a + r.gain, 0);
  const nowGain = hrRowsCache.reduce((a, r) => a + r.altGain, 0);
  const empties = hrRowsCache.filter(r => !r.card).length;
  const owned = ownedChars().length;
  $('#hrSummary').innerHTML = `<div class="notice info">
    Across <b>${owned}</b> owned character${owned === 1 ? '' : 's'}, a perfect card in every slot would be worth
    <b>${totalGain.toFixed(0)}</b> build-score points in total, of which <b>${nowGain.toFixed(0)}</b> are already
    sitting in your inventory as a same-set swap${empties ? `, and <b>${empties}</b> slot${empties === 1 ? ' is' : 's are'} empty` : ''}.
    <b>Available now</b> is always a card of the same set as the one worn, so equipping it cannot break a 4-piece;
    for switches that change the set, use <b>Better cards available</b>.
    Showing <b>${list.length}</b> of ${hrRowsCache.length} slots.</div>`;
  $('#hrPanel').classList.toggle('hide', !list.length);
  if (!list.length) return;

  const maxRoom = Math.max.apply(null, list.map(r => r.room).concat([1]));
  $('#hrTable').innerHTML = `<thead><tr>
      ${hrSortHeader('char', 'Character')}
      ${hrSortHeader('slot', 'Slot')}
      <th>Equipped</th>
      ${hrSortHeader('card', 'Card', 'How close the equipped card is to a perfect one for this slot and this character, out of 100.')}
      ${hrSortHeader('room', 'Headroom', 'Raw score a perfect card for this slot would add over the one worn. Comparable across this one character\'s five slots, not across characters.')}
      ${hrSortHeader('share', 'Share', 'This slot\'s share of all the headroom left on this character.')}
      ${hrSortHeader('gain', 'Build&nbsp;+', 'Build-score points a perfect card in this slot would add. Divided by the character\'s own perfect loadout, so this column does compare across characters.')}
      ${hrSortHeader('avail', 'Available now', 'The card of the same slot and the same set you own that raises the build score most, and by how much. Chosen on the build score, not on the card\'s own score.')}
      <th></th>
    </tr></thead><tbody>` +
    list.slice(0, 600).map(r => {
      const band = r.build == null ? 'bs-none' : buildBand(r.build).cls;
      return `<tr>
        <td class="tiny"><b>${esc(r.ch.n)}</b>
          <div class="tiny muted">${esc(r.ch.e)} · <span class="tag bs ${band}">build ${r.build == null ? '—' : `<b>${r.build}</b>`}</span></div></td>
        <td><span class="slot ${r.slot}">${r.slot.slice(0, 3)}</span></td>
        <td class="tiny">${r.card
          ? `${esc(r.card.set)} <span class="tag r${r.card.rarity}">${r.card.rarity}★</span> · ${esc(r.card.main)}
             <span class="muted">Lv${r.card.level}</span>
             <div class="tiny muted">${subsInlineHtml(r.card, r.t)}</div>`
          : '<span class="tag miss">empty</span>'}</td>
        <td class="right score${r.card ? '' : ' muted'}">${r.card ? r.pct : '—'}</td>
        <td class="right">${r.room.toFixed(1)}
          <div class="bar" style="width:64px;margin-left:auto"><i style="width:${(100 * r.room / maxRoom).toFixed(1)}%"></i></div></td>
        <td class="right tiny muted">${Math.round(r.share * 100)}%</td>
        <td class="right score">+${r.gain.toFixed(1)}</td>
        <td class="tiny">${r.alt
          ? `${esc(r.alt.set)} <span class="tag r${r.alt.rarity}">${r.alt.rarity}★</span> · ${esc(r.alt.main)}
             <span class="score">+${r.altGain.toFixed(1)}</span>
             ${r.alt.equipped && r.alt.equipped !== r.ch.n ? ` ${onTagHtml(r.alt, r.ch.n, new Set([r.alt.id]), 2)}` : ''}
             <div class="tiny muted">${subsInlineHtml(r.alt, r.t)}</div>`
          : '<span class="muted">nothing better in set</span>'}</td>
        <td>${r.alt
          ? `<button class="ghost tiny hrSwap" data-char="${esc(r.ch.n)}" data-slot="${esc(r.slot)}" data-card="${esc(r.alt.id)}">${r.alt.equipped ? 'Take it' : 'Equip'}</button>`
          : `<button class="ghost tiny hrOpt" data-char="${esc(r.ch.n)}">Optimise</button>`}</td>
      </tr>`;
    }).join('') + '</tbody>' + (list.length > 600
      ? '<tfoot><tr><td colspan="9" class="tiny muted">Showing the first 600 rows — narrow the filters to see more.</td></tr></tfoot>' : '');

  $$('#hrTable .hrSwap').forEach(b => b.onclick = () => swapCard(b.dataset.char, b.dataset.slot, b.dataset.card));
  $$('#hrTable .hrOpt').forEach(b => b.onclick = () => openCharacterDetail(b.dataset.char));
  $$('#hrTable .sortH').forEach(th => th.onclick = () => {
    const key = th.dataset.sort;
    hrSort.dir = hrSort.key === key ? -hrSort.dir : 1;
    hrSort.key = key;
    renderHeadroomTable();
    refocus(`#hrTable th.sortH[data-sort="${key}"] .thBtn`);
  });
}

/* ======================== custom card (the Cycle of Fate event) ========================
   The game's Cycle of Fate event makes a 5★ Heavens card — Sun, Moon, Star or Sky, never Space
   — whose set, slot, main stat and four substats the player picks; other events make a Space card
   the same way, so the view has a card-type switch (`o.kind`, 'heavens' or 'space'). The substats' VALUES are not
   picked: each is a random roll (it can be re-rolled for more ink), and the card's five upgrades
   land at random like any other card's. This view answers who gains most from one such card and
   which card to make for them.

   A character's gain is measured against the best they can ALREADY wear, not against what they
   wear now: equipping a better card already in the inventory costs nothing, so crediting that to
   the crafted card would rank whoever is worst dressed first. "Already" is the better of what is
   worn and the optimiser's own pick from the pool, and "with the card" is the best loadout that
   holds it — the optimiser re-run with the card added (a crafted card can complete a 4-piece the
   inventory is one card short of), or the card dropped into either of those two loadouts. Every
   one of them is priced by bestPlan's own evaluator, the build score's numerator, so the gain is
   in build points, the one scale that compares characters.

   The substat values are an assumption the user picks (CC_ROLLS): typical is each substat at its
   average roll tier and the five upgrades spread evenly (1.25 each, which is what random landing
   averages to), perfect is the build score's own perfect card (every roll at maximum, IDEAL_ROLLS
   3/2/2/2), poor is every roll at its lowest tier. The card is priced at level 25, since the main
   stat's growth to it is certain. */
const CC_P4 = 55;
const CC_SUB_POOL = 6;                // a design's substats are chosen among this many best stats, plus any with a target
const CC_MAIN_POOL = 3;               // and its main among this many of the slot's recommended (or, when open, legal) mains
const CC_KEEP = POLISH_DEPTH + 1;     // per slot and set: every card bestPlan can reach (its pick, then POLISH_DEPTH more)
const CC_UPS = RARITY[5].upgrades;
// A Space card rolls on its own, larger table (ROLL_TIERS' `space` layout, SUBSTATS' maxRollSpace).
const ccTiers = (stat, slot) => ROLL_TIERS[stat][slot === 'Space' ? 'space' : 'heavens'];
const ccTierMean = (stat, slot) => { const a = ccTiers(stat, slot); return a.reduce((s, x) => s + x, 0) / a.length; };
// Shown at the panel's precision: flat ATK/DEF/HP in whole points, everything else to one decimal.
const ccRound = (stat, v) => /^(ATK|DEF|HP)$/.test(stat) ? Math.round(v) : Math.round(v * 10) / 10;
const CC_ROLLS = {
  typical: { label: 'typical rolls', v: (stat, i, slot) => ccTierMean(stat, slot) * (1 + CC_UPS / 4) },
  perfect: { label: 'perfect rolls', v: (stat, i, slot) => maxRoll(stat, slot) * IDEAL_ROLLS[i] },
  low:     { label: 'poor rolls', v: (stat, i, slot) => ccTiers(stat, slot)[0] * (1 + CC_UPS / 4) }
};

/* A crafted card at level 25. `stats` is best first, which only matters for perfect rolls: the
   first substat carries IDEAL_ROLLS' three. */
function ccCard(slot, set, main, stats, mode, id) {
  const R = CC_ROLLS[mode] || CC_ROLLS.typical;
  return { id: id || 'craft', crafted: true, slot, set, rarity: 5, level: RARITY[5].maxLevel, main,
    subs: stats.map((stat, i) => ({ stat, value: ccRound(stat, R.v(stat, i, slot)) })) };
}

/* Everything one character's search reads. The pool is cut to the cards bestPlan can actually
   reach — each slot and set's top CC_KEEP by card score, the same for Space — which gives bestPlan
   the identical answer at a fraction of the cost, since it takes each set's best card per slot and
   polishes from the next POLISH_DEPTH. `extra` adds cards (an earlier crafted card, for the second
   of the event's two); `wear` stands in for what is worn (the loadout after that first card). */
function ccContext(ch, o, extra, wear) {
  const t = target(ch);
  const full = poolFor(o.free ? 'free' : 'all', 2, ch.n).concat(extra || []);
  const buckets = {};
  full.forEach(c => { const k = c.slot + '|' + c.set; (buckets[k] = buckets[k] || []).push({ c, s: cardScore(c, t) }); });
  const pool = [];
  Object.keys(buckets).forEach(k => buckets[k].sort((a, b) => b.s - a.s).slice(0, CC_KEEP).forEach(x => pool.push(x.c)));
  const worn = wear || state.cards.filter(c => c.equipped === ch.n);
  const r0 = bestPlan(ch, pool, { policy: o.policy, p4value: CC_P4 });
  const ev = cards => r0.loadoutTotal(cards);
  const planCards = r0.best ? HEAVENS.map(sl => r0.best.picks[sl].c).concat(r0.best.space ? [r0.best.space.c] : []) : [];
  const wornTotal = ev(worn).total, planTotal = planCards.length ? ev(planCards).total : -Infinity;
  const base = planTotal > wornTotal + 1e-9 ? { cards: planCards, total: planTotal, from: 'plan' } : { cards: worn, total: wornTotal, from: 'worn' };
  const ctx = { ch, t, o, pool, worn, ev, base, idealTotal: ev([]).idealTotal };
  /* The pool the re-runs with a crafted card in it read (ccPlace): the sets that card can be made
     in, every Space card, and each slot's best cards of any set, for the free picks. A set outside
     those can only enter a winning plan as the other half of a new 2+2, and the re-run is a dozen
     per character, so leaving them out is most of this view's speed. */
  const sets = ccSets(ctx), byScore = {};
  pool.forEach(c => { if (c.slot !== 'Space') (byScore[c.slot] = byScore[c.slot] || []).push({ c, s: cardScore(c, t) }); });
  const free = new Set();
  Object.keys(byScore).forEach(sl => byScore[sl].sort((a, b) => b.s - a.s).slice(0, CC_KEEP).forEach(x => free.add(x.c)));
  ctx.placePool = pool.filter(c => c.slot === 'Space' || sets.indexOf(c.set) >= 0 || free.has(c));
  return ctx;
}

/* The sets a crafted card is tried in: the character's own list (lufel's preferred set first,
   then its alternatives) and any set already in the loadouts it could join. Unreleased sets and
   off-element sets are out — an off-element set's bonuses are worth nothing to this character. */
function ccSets(ctx) {
  const ok = s => SETS[s] && !SETS[s].unreleased && !(SETS[s].elem && SETS[s].elem !== ctx.ch.e);
  const out = (ctx.t.sets || []).filter(ok);
  ctx.base.cards.concat(ctx.worn).forEach(c => { if (c.slot !== 'Space' && ok(c.set) && out.indexOf(c.set) < 0) out.push(c.set); });
  return out;
}

/* The Space sets a crafted Space card is tried in: the character's own Space card, any Space card
   in the loadouts it could join, and every released one that pairs with a Heavens set ccSets offers
   — a Space card does nothing unless the 4-piece it pairs with is worn. */
function ccSpaceSets(ctx) {
  const ok = s => SPACE_SETS[s] && !SPACE_SETS[s].unreleased;
  const out = [ctx.t.space].filter(ok);
  ctx.base.cards.concat(ctx.worn).forEach(c => { if (c.slot === 'Space' && ok(c.set) && out.indexOf(c.set) < 0) out.push(c.set); });
  const heav = ccSets(ctx);
  Object.keys(SPACE_SETS).forEach(s => { if (ok(s) && out.indexOf(s) < 0 && SPACE_SETS[s].pairs.some(x => heav.indexOf(x) >= 0)) out.push(s); });
  return out;
}

/* The best main and four substats for `slot` in `set`, worn with `around` (the other slots), at
   the assumed rolls. Mains are the slot's recommended ones (every legal main where lufel leaves
   it open), best CC_MAIN_POOL by what a perfect card of each scores; substats every four of the
   best CC_SUB_POOL stats by coupled weight for that main, plus any stat with a target, since the
   stat-target term can want a stat its weight undersells. Each is priced as the whole loadout. */
function ccDesign(ctx, slot, set, around, mode) {
  const t = ctx.t;
  let mains = SLOT_INFO[slot].fixed ? SLOT_INFO[slot].mains : (mainList(t, slot).length ? mainList(t, slot) : SLOT_INFO[slot].mains);
  mains = mains.map(m => ({ m, s: cardScore(idealCardFor(slot, t, set, m), t) }))
    .sort((a, b) => b.s - a.s).slice(0, CC_MAIN_POOL).map(x => x.m);
  const targeted = (t.targets || []).map(x => x.sub).filter(s => SUBSTATS[s]);
  let best = null;
  mains.forEach(main => {
    const f = couplingFactors(t, slot, main);
    const ranked = Object.keys(SUBSTATS).filter(s => s !== main)
      .map(s => ({ s, w: (t.w[s] || 0) * cf(f, s) })).sort((a, b) => b.w - a.w);
    const cand = ranked.filter((x, i) => (i < CC_SUB_POOL && x.w > 0) || targeted.indexOf(x.s) >= 0);
    ranked.forEach(x => { if (cand.length < 4 && cand.indexOf(x) < 0) cand.push(x); });
    cand.sort((a, b) => b.w - a.w);
    const n = cand.length;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) for (let l = k + 1; l < n; l++) {
      const stats = [cand[i].s, cand[j].s, cand[k].s, cand[l].s];
      const card = ccCard(slot, set, main, stats, mode);
      const total = ctx.ev(around.concat([card])).total;
      if (!best || total > best.total + 1e-9) best = { main, stats, card, total };
    }
  });
  return best;
}

/* The best loadout holding `card`: the optimiser re-run with it in the pool, or the card dropped
   into the loadout the character already has or the optimiser's pick without it. */
function ccPlace(ctx, card) {
  let best = { total: -Infinity, cards: null };
  const tryCards = cards => { const total = ctx.ev(cards).total; if (total > best.total + 1e-9) best = { total, cards }; };
  const swapIn = list => list.filter(c => c.slot !== card.slot).concat([card]);
  tryCards(swapIn(ctx.base.cards));
  if (ctx.worn !== ctx.base.cards) tryCards(swapIn(ctx.worn));
  const r = bestPlan(ctx.ch, ctx.placePool.concat([card]), { policy: ctx.o.policy, p4value: CC_P4 });
  if (r.best) {
    const cards = HEAVENS.map(sl => r.best.picks[sl].c).concat(r.best.space ? [r.best.space.c] : []);
    if (cards.indexOf(card) >= 0) tryCards(cards);
  }
  return best;
}

/* One character's answer: every Heavens slot (or the Space slot), in every set ccSets (ccSpaceSets)
   offers, designed first against the loadout they already have, then placed (ccPlace), and the
   winner of each slot designed again against the loadout it actually ends up in. `slots` is the
   best option per slot, best first — for a Space card, one slot, so it is the best option per Space
   set instead, which is the choice left to make. */
function ccBest(ctx, mode) {
  const space = ctx.o.kind === 'space';
  const sets = space ? ccSpaceSets(ctx) : ccSets(ctx);
  if (!sets.length) return { slots: [], best: null };
  const slots = [];
  (space ? ['Space'] : HEAVENS).forEach(slot => {
    const around = ctx.base.cards.filter(c => c.slot !== slot);
    const cur = ctx.base.cards.filter(c => c.slot === slot)[0];
    const d = ccDesign(ctx, slot, cur && sets.indexOf(cur.set) >= 0 ? cur.set : sets[0], around, mode);
    const opts = [];
    sets.forEach(set => {
      const card = ccCard(slot, set, d.main, d.stats, mode);
      const p = ccPlace(ctx, card);
      if (p.cards) opts.push({ slot, set, card, total: p.total, cards: p.cards });
    });
    if (!opts.length) return;
    opts.sort((a, b) => b.total - a.total);
    const top = opts[0];
    const rest = top.cards.filter(c => c.slot !== slot);
    const d2 = ccDesign(ctx, slot, top.set, rest, mode);
    if (d2.total > top.total + 1e-9) Object.assign(top, { card: d2.card, total: d2.total, cards: rest.concat([d2.card]) });
    (space ? opts : [top]).forEach(x => { x.gain = Math.max(0, 100 * (x.total - ctx.base.total) / ctx.idealTotal); slots.push(x); });
  });
  slots.sort((a, b) => b.total - a.total);
  return { slots, best: slots[0] || null };
}

/* ---- what luck does to it ----
   The card arrives at level 0: each substat's starting value is a random roll tier, and each of
   the five upgrades lands on a random substat at a random tier. The Rolls setting prices one
   outcome; this simulates the rest — `n` levellings of the card, every tier and every substat
   equally likely, priced in the loadout the card goes into with everything else held as it is.
   `start` fixes the starting values (a card already rolled, in the check panel); without it they
   are random too. The generator is seeded from the character and the card, so the same card
   always reads the same range. Gains are floored at 0: a card that comes out worse than what
   they already have would simply not be worn.

   Measured on the real inventory (6 Oct 2026, 4000 outcomes each, top twelve): the typical-rolls
   gain sat within 0.15 of the simulated average for all twelve and the order did not change, but
   the middle 80% spanned 1.2-2.5 build points, enough for neighbours to overlap — a lucky third
   pick can beat an average first. */
const CC_SAMPLES = 400;          // per character in the ranking: about 12 ms each
const CC_CHECK_SAMPLES = 2000;   // for the one card in the check panel
function ccRng(seed) {
  let x = (seed >>> 0) || 1;
  return () => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return x / 4294967296; };
}
function ccOutcomes(ctx, card, rest, start, n) {
  const stats = card.subs.map(s => s.stat), tiers = stats.map(st => ccTiers(st, card.slot));
  const rnd = ccRng(hashStr(2166136261, [ctx.ch.n, card.slot, card.set, card.main, stats.join(), (start || []).join()].join('|')));
  const pick = a => a[Math.min(a.length - 1, Math.floor(rnd() * a.length))];
  const out = [];
  for (let k = 0; k < n; k++) {
    const v = stats.map((st, i) => start ? start[i] : pick(tiers[i]));
    for (let u = 0; u < CC_UPS; u++) { const i = Math.min(stats.length - 1, Math.floor(rnd() * stats.length)); v[i] += pick(tiers[i]); }
    const c = Object.assign({}, card, { level: RARITY[5].maxLevel, subs: stats.map((st, i) => ({ stat: st, value: ccRound(st, v[i]) })) });
    out.push(Math.max(0, 100 * (ctx.ev(rest.concat([c])).total - ctx.base.total) / ctx.idealTotal));
  }
  return out.sort((a, b) => a - b);
}
// The middle 80% of outcomes (8 in 10 land inside), the extremes seen and the average.
function ccRange(g) {
  const q = f => g[Math.round(f * (g.length - 1))];
  return { lo: q(0.1), hi: q(0.9), min: g[0], max: g[g.length - 1], mean: g.reduce((a, x) => a + x, 0) / g.length };
}
// A ranked option's outcomes: its card levelled at random in the loadout it was placed in.
function ccOptionOutcomes(ctx, opt, n) {
  return ccOutcomes(ctx, opt.card, opt.cards.filter(c => c !== opt.card), null, n || CC_SAMPLES);
}
// Chance one random outcome of `a` beats one of `b` (both sorted ascending), ties counted half.
function ccChanceBetter(a, b) {
  let j = 0, k = 0, wins = 0;
  for (let i = 0; i < a.length; i++) {
    while (j < b.length && b[j] < a[i] - 1e-9) j++;
    while (k < b.length && b[k] <= a[i] + 1e-9) k++;
    wins += j + (k - j) / 2;
  }
  return wins / (a.length * b.length);
}

/* A row of the ranking. `inv` is the build score of the best they can already wear, `after` with
   the card; both on the 0-100 scale, unrounded. `range` is what luck does to the gain. */
function ccRow(ch, o) {
  const ctx = ccContext(ch, o);
  const r = ccBest(ctx, o.mode);
  const pct = total => Math.max(0, Math.min(100, 100 * total / ctx.idealTotal));
  const now = buildScore(ch, ctx.worn, CC_P4, null, null, ctx.t);
  return { ch, t: ctx.t, ctx, now: now ? now.raw : null, inv: pct(ctx.base.total), baseFrom: ctx.base.from,
    after: pct(Math.max(r.best ? r.best.total : -Infinity, ctx.base.total)), gain: r.best ? r.best.gain : 0, best: r.best, slots: r.slots,
    range: r.best ? ccRange(ccOptionOutcomes(ctx, r.best)) : null };
}

/* The event makes two cards. The first is the ranking's top row; the second is the better of the
   next character's card and a second card for the same character, priced as if the first were
   already made and worn (its pool holds it, and its loadout is the one the first card goes into). */
function ccSecond(rows, o) {
  const first = rows[0];
  if (!first || !first.best) return null;
  const card1 = Object.assign({}, first.best.card, { id: 'craft1' });
  const cards1 = first.best.cards.map(c => c === first.best.card ? card1 : c);
  const ctx2 = ccContext(first.ch, o, [card1], cards1);
  const again = ccBest(ctx2, o.mode).best;
  const other = rows.filter(r => r !== first && r.best)[0] || null;
  if (again && again.gain > (other ? other.gain : 0))
    return { ch: first.ch, t: first.t, best: again, gain: again.gain, same: true, range: ccRange(ccOptionOutcomes(ctx2, again)) };
  return other ? { ch: other.ch, t: other.t, best: other.best, gain: other.gain, same: false, range: other.range } : null;
}

/* ---- the Custom card view: run, draw, check ----
   Run and draw are split like Triage's: the run prices every character in scope (about 50 ms
   each on the real inventory) in slices of 50 ms so the page keeps drawing its progress, and the
   element and search filters only redraw. A later run, or a load, abandons an unfinished one. Like
   Triage it runs on its first visit and is then only marked stale (markStaleRuns). */
function ccOpts() {
  return { scope: $('#ccScope').value, kind: $('#ccKind').value, mode: $('#ccRolls').value, policy: $('#ccPolicy').value, free: $('#ccFree').checked };
}
const ccScopeChars = o => o.scope === 'all' ? CHARACTERS.slice() : ownedChars();
/* What a run read: every card with its wearer and lock (the pool, and what is worn), who is owned,
   the targets and setups of the characters it rated, the team crit rate, the Den and its own
   controls. The element and search filters only narrow the drawn table. */
function ccSig() {
  const o = ccOpts();
  return cardsSig(true) + ':' + charsSig(new Set(ccScopeChars(o).map(c => c.n))) + ':' + teamCritRate() + ':' + denSig() +
    '|' + [o.scope, o.kind, o.mode, o.policy, o.free].join(',');
}
let ccCache = null, ccJob = 0;
function runCustomCard() {
  const job = ++ccJob, o = ccOpts(), chars = ccScopeChars(o), sig = ccSig();
  if (!chars.length) {
    ccCache = null;
    $('#ccSummary').innerHTML = '<p class="muted">Mark some characters as owned on the Roster tab first, or choose "All characters".</p>';
    $('#ccPanel').classList.add('hide');
    ccFillCheckChars();
    return Promise.resolve(false);
  }
  const rows = [];
  let i = 0;
  const progress = () => {
    $('#ccSummary').innerHTML = `<div class="notice info">Pricing a custom card for each character… <b>${i}</b> of ${chars.length}</div>`;
  };
  progress();
  return new Promise(resolve => {
    const step = () => {
      if (job !== ccJob) return resolve(false);
      const t0 = performance.now();
      while (i < chars.length && performance.now() - t0 < 50) rows.push(ccRow(chars[i++], o));
      if (i < chars.length) { progress(); setTimeout(step, 0); return; }
      rows.sort((a, b) => b.gain - a.gain || a.ch.n.localeCompare(b.ch.n));
      rows.forEach((r, k) => { r.rank = k + 1; });
      ccCache = { sig, o, rows, second: ccSecond(rows, o), tc: teamCritRate() };
      renderCustomCard();
      ccFillCheckChars();
      if (!ccCheckFilled && rows[0] && rows[0].best) ccFillRecommended(rows[0].ch.n); else ccCheck();
      markStaleRuns();
      resolve(true);
    };
    setTimeout(step, 0);
  });
}

const ccSort = { key: null, dir: 1 };
const CC_SORT_COLS = { rank: r => r.rank, char: r => r.ch.n, gain: r => r.gain, range: r => r.range ? r.range.lo : -1, now: r => r.now == null ? -1 : r.now, inv: r => r.inv, after: r => r.after };
function ccSortHeader(key, label, title) { return sortThHtml(key, label, ccSort, title); }
function sortCcRows(rows) {
  if (!ccSort.key) return rows.slice();   // the run's own order: largest gain first
  const get = CC_SORT_COLS[ccSort.key];
  return rows.slice().sort((a, b) => {
    const av = get(a), bv = get(b);
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return (cmp || a.rank - b.rank) * ccSort.dir;
  });
}
/* A card in one line: slot, set, main, then its substats coloured by what they are worth to `t`. */
function ccCardLineHtml(card, t) {
  return `<span class="slot ${card.slot}">${card.slot.slice(0, 3)}</span> <b>${esc(card.set)}</b> · ${esc(card.main)}
    <div class="tiny muted">${subsInlineHtml(card, t)}</div>`;
}
/* The other cards of the loadout a custom card goes into that the character does not wear now. */
function ccAlsoEquip(row, best) {
  return best.cards.filter(c => c !== best.card && c.equipped !== row.ch.n)
    .sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
}
function ccAlsoHtml(row, best) {
  const also = ccAlsoEquip(row, best);
  if (!also.length) return '';
  return `<div class="tiny muted" style="margin-top:4px">with ${also.map(c =>
    `<span title="${esc(`${c.rarity}★ ${c.slot} ${c.set}, ${c.main} Lv${c.level}: ${(c.subs || []).map(subVal).map((v, i) => c.subs[i].stat + ' ' + v).join(', ')}${c.equipped ? ' — on ' + c.equipped : ''}`)}">` +
    `<span class="slot ${c.slot}">${c.slot.slice(0, 3)}</span> ${esc(c.set)}${c.equipped ? ` <span class="tag">on ${esc(c.equipped)}</span>` : ''}</span>`).join(' ')}</div>`;
}

/* "+7.7 to +9.1": the middle 80% of random levellings, with the average and extremes on hover. */
function ccRangeHtml(rg, long) {
  if (!rg) return '<span class="muted">—</span>';
  const tip = `8 in 10 random levellings land between +${rg.lo.toFixed(1)} and +${rg.hi.toFixed(1)} (average +${rg.mean.toFixed(1)}; ` +
    `worst seen +${rg.min.toFixed(1)}, best +${rg.max.toFixed(1)}). Luck decides the starting values, which substats the five upgrades land on, and how big each one is.`;
  return `<span title="${esc(tip)}" style="white-space:nowrap">${long ? 'likely ' : ''}+${rg.lo.toFixed(1)} to +${rg.hi.toFixed(1)}</span>`;
}
function renderCustomCard() {
  if (!ccCache) return;
  const { rows, o, second } = ccCache;
  const el = $('#ccElement').value, q = $('#ccQ').value.trim().toLowerCase();
  const list = sortCcRows(rows.filter(r => {
    if (el && r.ch.e !== el) return false;
    if (q) {
      const b = r.best;
      const hay = [r.ch.n, r.ch.a || '', b ? b.set : '', b ? b.slot : '', b ? b.card.main : '',
        b ? b.card.subs.map(s => s.stat).join(' ') : ''].join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }));
  const first = rows[0] && rows[0].best ? rows[0] : null;
  const rollLabel = (CC_ROLLS[o.mode] || CC_ROLLS.typical).label;
  const pick = (n, who, best, gain, note, rg) => `<div>
      <div class="tiny muted" style="margin-bottom:4px">${n}</div>
      <div style="margin-bottom:6px"><b>${esc(who.n)}</b> <span class="gainpos score">+${gain.toFixed(1)}</span>
        <span class="tiny muted">build points · ${ccRangeHtml(rg, true)}${note ? ' · ' + note : ''}</span></div>
      ${cardBlockHtml(best.card, target(who), { tags: ' <span class="tag">custom</span>' })}
    </div>`;
  $('#ccSummary').innerHTML = !first
    ? '<div class="notice info">No character in scope gains anything from a custom card over what your inventory already gives them.</div>'
    : `<div class="notice info">Ranked <b>${rows.length}</b> character${rows.length === 1 ? '' : 's'} by what one custom card adds to
        their build score, valued at level 25 with <b>${esc(rollLabel)}</b>, over the best your inventory already gives them.
        ${o.kind === 'space' ? 'If the event makes two, these are the two worth most.' : 'The Cycle of Fate event makes two cards; these are the two worth most.'}</div>
      <div class="loadout" style="margin-top:12px;max-width:760px">
        ${pick('First card', first.ch, first.best, first.best.gain, '', first.range)}
        ${second ? pick('Second card', second.ch, second.best, second.gain, second.same ? 'after the first card, still worth more than any other character\'s' : '', second.range) : ''}
      </div>`;
  $('#ccPanel').classList.toggle('hide', !list.length);
  if (!list.length) return;
  const maxGain = Math.max.apply(null, rows.map(r => r.gain).concat([0.1]));
  const num = v => v == null ? '<span class="muted">—</span>' : Math.round(v);
  $('#ccTable').innerHTML = `<thead><tr>
      ${ccSortHeader('rank', '#', 'Rank by gain')}
      ${ccSortHeader('char', 'Character')}
      <th>Card to make</th>
      ${ccSortHeader('gain', 'Gain', 'Build-score points the card adds over the best loadout your inventory already gives this character. Compares across characters.')}
      ${ccSortHeader('range', 'Likely', 'Where the gain lands in 8 of 10 random levellings: the card arrives at level 0, and its starting values, which substats the upgrades hit and how big each is are all luck. Sorts on the low end.')}
      ${ccSortHeader('now', 'Now', 'Build score of what is worn now')}
      ${ccSortHeader('inv', 'Without', 'Build score of the best loadout your inventory can already give them, without the new card')}
      ${ccSortHeader('after', 'With', 'Build score of the best loadout with the new card')}
      ${o.kind === 'space' ? '<th title="The same card in another Space set, and what it would add instead">Other Space sets</th>'
        : '<th title="The best card for each other slot, and what it would add instead">Other slots</th>'}
      <th></th>
    </tr></thead><tbody>` +
    list.map(r => {
      const b = r.best, after = Math.round(r.after);
      return `<tr>
        <td class="tiny muted right">${r.rank}</td>
        <td class="tiny"><b>${esc(r.ch.n)}</b>
          <div class="tiny muted">${esc(r.ch.e)}${!state.chars[r.ch.n].owned ? ' · not owned' : state.chars[r.ch.n].benched ? ' · benched' : ''}</div></td>
        <td class="tiny">${b ? ccCardLineHtml(b.card, r.t) + ccAlsoHtml(r, b) : '<span class="muted">no set to make it in</span>'}</td>
        <td class="right"><span class="score${r.gain >= UPGRADE_MIN_GAIN ? ' gainpos' : ''}">+${r.gain.toFixed(1)}</span>
          <div class="bar" style="width:64px;margin-left:auto"><i style="width:${(100 * r.gain / maxGain).toFixed(1)}%"></i></div></td>
        <td class="right tiny">${ccRangeHtml(r.range)}</td>
        <td class="right">${num(r.now)}</td>
        <td class="right${r.baseFrom === 'plan' ? '' : ' muted'}" title="${r.baseFrom === 'plan' ? 'A better loadout than the one worn is already in your inventory — the Upgrades tab lists it' : 'Already the best your inventory gives them'}">${num(r.inv)}</td>
        <td class="right"><span class="tag bs ${buildBand(after).cls}"><b>${after}</b></span></td>
        <td class="tiny">${r.slots.slice(1, 4).map(s => `<div><span class="slot ${s.slot}">${s.slot.slice(0, 3)}</span> ${esc(s.set)}${s.slot === 'Space' ? '' : ' · ' + esc(s.card.main)} <b>+${s.gain.toFixed(1)}</b></div>`).join('') || '<span class="muted">—</span>'}</td>
        <td style="white-space:nowrap">${b ? `<button class="ghost tiny ccTry" data-char="${esc(r.ch.n)}">Check a roll</button>` : ''}
          <button class="ghost tiny ccOpt" data-char="${esc(r.ch.n)}">Optimise</button></td>
      </tr>`;
    }).join('') + '</tbody>';
  $$('#ccTable .ccTry').forEach(btn => btn.onclick = () => {
    ccFillRecommended(btn.dataset.char);
    $('#ccCheckPanel').scrollIntoView({ block: 'start' });
  });
  $$('#ccTable .ccOpt').forEach(btn => btn.onclick = () => openCharacterDetail(btn.dataset.char));
  $$('#ccTable .sortH').forEach(th => th.onclick = () => {
    const key = th.dataset.sort;
    ccSort.dir = ccSort.key === key ? -ccSort.dir : 1;
    ccSort.key = key;
    renderCustomCard();
    refocus(`#ccTable th.sortH[data-sort="${key}"] .thBtn`);
  });
}

/* "Check a card": the card as the event shows it — set, slot, main and four substats at their
   level-0 roll — priced once levelled, three ways (every upgrade at the lowest roll, at the average,
   or all five at the top roll on its most valuable substat), against the recommended card at
   average rolls, and for everyone else the last run rated. */
let ccCheckFilled = false;   // the user (or a Check a roll button) has filled it in; a run no longer overwrites it
function ccFillCheckSelects() {
  ccFillCheckChars();
  ccSyncMain();
  ccRenderSubs();
}
function ccFillCheckChars() {
  const cur = $('#ccChar').value;
  let list = ccScopeChars(ccOpts());
  if (!list.length) list = CHARACTERS.slice();
  $('#ccChar').innerHTML = list.map(c => `<option value="${esc(c.n)}">${esc(c.n)}</option>`).join('');
  if (cur && list.some(c => c.n === cur)) $('#ccChar').value = cur;
}
// The set and main lists follow the slot: a Space card takes a Space set and its fixed ATK + DEF main.
function ccSyncMain() {
  const slot = $('#ccSlot').value, table = slot === 'Space' ? SPACE_SETS : SETS;
  const curSet = $('#ccSet').value, sets = Object.keys(table).filter(x => !table[x].unreleased).sort();
  $('#ccSet').innerHTML = sets.map(x => `<option>${esc(x)}</option>`).join('');
  if (sets.indexOf(curSet) >= 0) $('#ccSet').value = curSet;
  const cur = $('#ccMain').value, mains = SLOT_INFO[slot].mains;
  $('#ccMain').innerHTML = mains.map(m => `<option>${esc(m)}</option>`).join('');
  if (mains.indexOf(cur) >= 0) $('#ccMain').value = cur;
}
function ccReadSubs() {
  return [0, 1, 2, 3].map(i => {
    const st = $(`#ccSubs .ccSubStat[data-i="${i}"]`), v = $(`#ccSubs .ccSubVal[data-i="${i}"]`);
    return { stat: st ? st.value : '', value: v ? parseFloat(v.value) : NaN };
  });
}
function ccRenderSubs(preset) {
  const cur = preset || ccReadSubs(), main = $('#ccMain').value;
  const stats = Object.keys(SUBSTATS).filter(x => x !== main);
  $('#ccSubs').innerHTML = [0, 1, 2, 3].map(i => {
    const s = cur[i] && cur[i].stat !== main ? cur[i] : { stat: '' };
    const tiers = s.stat && ROLL_TIERS[s.stat] ? ccTiers(s.stat, $('#ccSlot').value) : [];
    const val = tiers.indexOf(s.value) >= 0 ? s.value : tiers[2];
    return `<div class="field"><label for="ccSub${i}">Substat ${i + 1}</label><div style="display:flex;gap:4px">
      <select id="ccSub${i}" class="ccSubStat" data-i="${i}"><option value="">—</option>${stats.map(x =>
        `<option${x === s.stat ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>
      <select class="ccSubVal" data-i="${i}" aria-label="Substat ${i + 1} roll at level 0"${tiers.length ? '' : ' disabled'}>${tiers.map(v =>
        `<option value="${v}"${v === val ? ' selected' : ''}>${esc(subVal({ stat: s.stat, value: v }))}</option>`).join('')}</select>
    </div></div>`;
  }).join('');
  $$('#ccSubs .ccSubStat').forEach(sel => sel.onchange = () => { ccCheckFilled = true; ccRenderSubs(); ccCheck(); });
  $$('#ccSubs .ccSubVal').forEach(sel => sel.onchange = () => { ccCheckFilled = true; ccCheck(); });
}
function ccReadCard() {
  return { slot: $('#ccSlot').value, set: $('#ccSet').value, rarity: 5, level: 0, main: $('#ccMain').value,
    subs: ccReadSubs().filter(s => s.stat && !isNaN(s.value)) };
}
function ccCardErrors(card) {
  const errs = card.subs.length < 4 ? ['Pick all four substats.'] : [];
  if (new Set(card.subs.map(s => s.stat)).size < card.subs.length) errs.push('Each substat can only appear once.');
  return errs.concat(validateCard(card));
}
function ccFillRecommended(name) {
  const row = ccCache && ccCache.rows.filter(r => r.ch.n === name)[0];
  if (!row || !row.best) return;
  ccCheckFilled = true;
  $('#ccChar').value = name;
  const c = row.best.card;
  $('#ccSlot').value = c.slot; ccSyncMain(); $('#ccSet').value = c.set; $('#ccMain').value = c.main;
  ccRenderSubs(c.subs.map(s => ({ stat: s.stat, value: ccTiers(s.stat, c.slot)[2] })));
  ccCheck();
}
// The context a check is priced in: the last run's for a character it rated, else built now.
function ccContextFor(ch) {
  const row = ccCache && ccCache.rows.filter(r => r.ch === ch)[0];
  return row ? { ctx: row.ctx, row } : { ctx: ccContext(ch, ccCache ? ccCache.o : ccOpts()), row: null };
}
function ccCheck() {
  const out = $('#ccCheckOut');
  const ch = charDef($('#ccChar').value);
  if (!out || !ch) { if (out) out.innerHTML = ''; return; }
  const card = ccReadCard(), errs = ccCardErrors(card);
  if (errs.length) { out.innerHTML = `<p class="tiny muted">${esc(errs[0])}</p>`; return; }
  const { ctx, row } = ccContextFor(ch), t = ctx.t;
  const f = couplingFactors(t, card.slot, card.main), wOf = s => (t.w[s] || 0) * cf(f, s);
  const top = card.subs.slice().sort((a, b) => wOf(b.stat) - wOf(a.stat))[0];
  const levelled = add => Object.assign({}, card, { id: 'craft', crafted: true, level: RARITY[5].maxLevel,
    subs: card.subs.map(s => ({ stat: s.stat, value: ccRound(s.stat, s.value + add(s)) })) });
  const gainOf = (c, cx) => {
    const p = ccPlace(cx, c);
    return { gain: Math.max(0, 100 * (p.total - cx.base.total) / cx.idealTotal), after: 100 * p.total / cx.idealTotal, p };
  };
  const cases = [
    { label: 'Poor upgrades', note: 'every upgrade at the lowest roll, spread evenly', card: levelled(s => CC_UPS / 4 * ccTiers(s.stat, card.slot)[0]) },
    { label: 'Typical upgrades', note: 'every upgrade at the average roll, spread evenly', card: levelled(s => CC_UPS / 4 * ccTierMean(s.stat, card.slot)) },
    { label: 'Best case', note: `all five upgrades at the top roll on ${top.stat}`, card: levelled(s => s === top ? CC_UPS * maxRoll(s.stat, card.slot) : 0) }
  ];
  cases.forEach(c => Object.assign(c, gainOf(c.card, ctx)));
  const typical = cases[1];

  /* Luck from here: the starting values are known (they are on screen), the five upgrades are not.
     Simulated in the loadout the typical case lands in, everything else held as it is. */
  const restOf = (p, c) => p.cards ? p.cards.filter(x => x !== c) : ctx.base.cards.filter(x => x.slot !== c.slot);
  const mine = ccOutcomes(ctx, typical.card, restOf(typical.p, typical.card), card.subs.map(s => s.value), CC_CHECK_SAMPLES);
  const myRange = ccRange(mine);
  const rangeLine = `<p class="tiny" style="margin:10px 0 0">With random upgrades, 8 in 10 outcomes land between
    <b>+${myRange.lo.toFixed(1)}</b> and <b>+${myRange.hi.toFixed(1)}</b> (average +${myRange.mean.toFixed(1)},
    worst +${myRange.min.toFixed(1)}, best +${myRange.max.toFixed(1)}).</p>`;

  /* Against the recommended card made fresh — its starting values are luck too, which is the choice
     a re-roll offers: keep this card, or roll the recommended one's values again. */
  const rec = row && row.best ? row.best : ccBest(ctx, 'typical').best;
  let recLine = '';
  if (rec) {
    const recCard = ccCard(rec.slot, rec.set, rec.card.main, rec.card.subs.map(s => s.stat), 'typical');
    const recPlaced = gainOf(recCard, ctx), recGain = recPlaced.gain;
    const theirs = ccOutcomes(ctx, recCard, restOf(recPlaced.p, recCard), null, CC_CHECK_SAMPLES);
    const chance = Math.round(100 * ccChanceBetter(mine, theirs));
    const same = rec.slot === card.slot && rec.set === card.set && rec.card.main === card.main &&
      rec.card.subs.map(s => s.stat).sort().join() === card.subs.map(s => s.stat).sort().join();
    const share = recGain > 0 ? Math.round(100 * typical.gain / recGain) : null;
    recLine = `<p class="tiny" style="margin:6px 0 0">${same
      ? `This is the card recommended for ${esc(ch.n)}; at average rolls it adds <b>+${recGain.toFixed(1)}</b>.`
      : `The card recommended for ${esc(ch.n)} — ${esc(rec.slot)} ${esc(rec.set)}, ${esc(rec.card.main)} with
         ${esc(rec.card.subs.map(s => s.stat).join(', '))} — adds <b>+${recGain.toFixed(1)}</b> at average rolls.`}
      ${share != null ? ` Levelled with typical upgrades, this one is worth <b>${share}%</b> of that.` : ''}</p>
      <p class="ccChance" style="margin:6px 0 0">Chance this card ends up better than ${same ? 're-rolling its values' : 'a fresh roll of the recommended card'}:
        <b class="${chance >= 50 ? 'gainpos' : ''}">${chance}%</b>
        <span class="tiny muted">— both levelled with random upgrades; above 50% means keeping it is the better bet.</span></p>`;
  }

  // Everyone else the last run rated, for this card with typical upgrades.
  let others = '';
  if (ccCache) {
    const rated = ccCache.rows.filter(r => r.ch !== ch).map(r => ({ r, g: gainOf(typical.card, r.ctx).gain }))
      .filter(x => x.g >= UPGRADE_MIN_GAIN).sort((a, b) => b.g - a.g).slice(0, 6);
    others = `<p class="tiny" style="margin:6px 0 0">Who else gains from this card with typical upgrades: ${rated.length
      ? rated.map(x => `<b>${esc(x.r.ch.n)}</b> <span class="gainpos">+${x.g.toFixed(1)}</span>`).join(' · ')
      : '<span class="muted">nobody else in the ranking</span>'}.</p>`;
  }
  out.innerHTML = `<div class="flowTable" style="margin-bottom:0"><table>
      <thead><tr><th>Once levelled to 25</th><th>Substats</th><th class="right">Gain</th><th class="right">Build with it</th></tr></thead>
      <tbody>${cases.map(c => `<tr>
        <td class="tiny"><b>${esc(c.label)}</b><div class="tiny muted">${esc(c.note)}</div></td>
        <td class="tiny">${subsInlineHtml(c.card, t)}</td>
        <td class="right"><span class="score${c.gain >= UPGRADE_MIN_GAIN ? ' gainpos' : ''}">+${c.gain.toFixed(1)}</span></td>
        <td class="right"><span class="tag bs ${buildBand(Math.round(c.after)).cls}"><b>${Math.round(Math.min(100, c.after))}</b></span></td>
      </tr>`).join('')}</tbody></table></div>
    ${ccAlsoHtml({ ch }, { card: typical.card, cards: typical.p.cards || [] })}
    ${rangeLine}${recLine}${others}`;
}
function ccAddCard() {
  const card = ccReadCard(), errs = ccCardErrors(card);
  if (errs.length) { notify(errs[0]); return; }
  const snap = snapshotState();
  card.id = 'c' + (state.nextId++);
  card.equipped = null;
  state.cards.push(card);
  commit();
  offerUndo(`Added a 5★ ${card.slot} ${card.set} card (${card.main}) at level 0 to the inventory.`, snap);
}

/* ======================== Ink card (Vicissitude, Elysian and Prophetic Ink) ========================
   The game's permanent Customize screen (top right of the revelation select screen) makes a new 5★
   level-0 card. One Vicissitude Ink buys a Sun, Moon, Star or Sky card in a set and with a main stat
   the player picks. Elysian Ink picks substats, 1, 2, 4 or 8 of it in all for one to four of them,
   and the game fills the rest of the card's four at random. Prophetic Ink rolls each picked
   substat's value, one apiece, from the same five tiers as any card's; one more re-rolls one picked
   substat, and the new value replaces the old even when it is lower. The five upgrades land at
   random like any other card's. All of it confirmed by the user in-game, 10 Oct 2026.

   So the questions are the Custom card view's (who gains most, and which card), plus how many
   substats are worth the Elysian Ink, and, in the check panel, which picked substat to re-roll.

   A card is designed as the Custom card view designs one: ccBest at typical rolls gives each slot's
   best set, main and four substats, placed in the best loadout that holds it. Picking k of them
   leaves the rest to luck, so every k of the design's four is tried and priced as the average over
   every possible fill of the other 4 − k (all equally likely, never a stat the slot cannot carry:
   frNoSub), each fill at typical values and worn in the better of the design's loadout and the one
   the character already has. A fill worse than what they have counts as no gain, since they would
   not wear it. Every fill is priced, not a sample (at most 495), so a run always reads the same. */
const IK_ELYSIAN = [0, 1, 2, 4, 8];   // Elysian Ink spent on 0-4 picked substats, in all
const IK_SAMPLES = 400;               // random levellings behind a row's Likely range

function ikCombos(list, k) {
  const out = [];
  const go = (from, acc) => {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let i = from; i < list.length; i++) { acc.push(list[i]); go(i + 1, acc); acc.pop(); }
  };
  go(0, []);
  return out;
}
// The substats the game can fill in: every one the slot and main allow, less the picked ones.
const ikLeft = (slot, main, picked) => { const no = frNoSub(slot, main); return Object.keys(SUBSTATS).filter(s => no.indexOf(s) < 0 && picked.indexOf(s) < 0); };
// The other slots the card can be worn with: the design's loadout, and the one they already have.
function ikRests(ctx, opt) {
  const a = opt.cards.filter(c => c !== opt.card), b = ctx.base.cards.filter(c => c.slot !== opt.slot);
  return a.length === b.length && a.every(c => b.indexOf(c) >= 0) ? [a] : [a, b];
}
// The best total wearing `card` with any of `rests`, never below what they already have.
function ikTotal(ctx, card, rests) {
  let best = ctx.base.total;
  rests.forEach(r => { const t = ctx.ev(r.concat([card])).total; if (t > best) best = t; });
  return best;
}
// The average of that over every fill of the substats not picked.
function ikExpect(ctx, opt, picked, rests) {
  const fills = ikCombos(ikLeft(opt.slot, opt.card.main, picked), 4 - picked.length);
  let sum = 0;
  fills.forEach(f => { sum += ikTotal(ctx, ccCard(opt.slot, opt.set, opt.card.main, picked.concat(f), 'typical'), rests); });
  return sum / fills.length;
}

/* One character: for each number of picked substats (0-4), the best slot and pick. `byK[k]` holds the
   design it came from (`opt`), the picked substats best first, and the gain in build points. */
function ikRow(ch, o) {
  const ctx = ccContext(ch, Object.assign({}, o, { kind: 'heavens' }));
  const r = ccBest(ctx, 'typical');
  const byK = [null, null, null, null, null];
  r.slots.forEach(opt => {
    const rests = ikRests(ctx, opt), stats = opt.card.subs.map(s => s.stat);
    for (let k = 0; k <= 4; k++) ikCombos(stats, k).forEach(picked => {
      const total = ikExpect(ctx, opt, picked, rests);
      if (!byK[k] || total > byK[k].total + 1e-9) byK[k] = { k, opt, picked, total, rests };
    });
  });
  byK.forEach(x => { if (x) x.gain = Math.max(0, 100 * (x.total - ctx.base.total) / ctx.idealTotal); });
  const pct = total => Math.max(0, Math.min(100, 100 * total / ctx.idealTotal));
  const now = buildScore(ch, ctx.worn, CC_P4, null, null, ctx.t);
  const best = byK[o.pick] || null;
  return { ch, t: ctx.t, ctx, byK, best, now: now ? now.raw : null, inv: pct(ctx.base.total), baseFrom: ctx.base.from,
    gain: best ? best.gain : 0, after: pct(best ? Math.max(best.total, ctx.base.total) : ctx.base.total),
    range: best ? ccRange(ikOutcomes(ctx, best, null, IK_SAMPLES)) : null };
}

/* What luck does to a pick: `n` cards made and levelled at random. The substats not picked, every
   starting value and the five upgrades are random; `start` fixes the four substats and their
   starting values instead (a card already made, in the check panel). Seeded from the character
   and the pick, so a row's range never wobbles between redraws. Gains are floored at 0. */
function ikOutcomes(ctx, x, start, n) {
  const { opt, picked } = x, slot = opt.slot, main = opt.card.main;
  const rnd = ccRng(hashStr(2166136261, ['ink', ctx.ch.n, slot, opt.set, main, picked.join(), JSON.stringify(start || [])].join('|')));
  const pick = a => a[Math.min(a.length - 1, Math.floor(rnd() * a.length))];
  const out = [];
  for (let k = 0; k < n; k++) {
    let stats, v;
    if (start) { stats = start.map(s => s.stat); v = start.map(s => s.value); }
    else {
      const left = ikLeft(slot, main, picked);
      stats = picked.slice();
      while (stats.length < 4) stats.push(left.splice(Math.min(left.length - 1, Math.floor(rnd() * left.length)), 1)[0]);
      v = stats.map(st => pick(ccTiers(st, slot)));
    }
    for (let u = 0; u < CC_UPS; u++) { const i = Math.min(3, Math.floor(rnd() * 4)); v[i] += pick(ccTiers(stats[i], slot)); }
    const c = { id: 'craft', crafted: true, slot, set: opt.set, rarity: 5, level: RARITY[5].maxLevel, main,
      subs: stats.map((st, i) => ({ stat: st, value: ccRound(st, v[i]) })) };
    out.push(Math.max(0, 100 * (ikTotal(ctx, c, x.rests) - ctx.base.total) / ctx.idealTotal));
  }
  return out.sort((a, b) => a - b);
}

/* ---- the Ink card view: run, draw, check ----
   Split like the Custom card view's: the run prices every character in scope in 50 ms slices,
   element and search only redraw, and it runs on its first visit and is then only marked stale. */
function ikOpts() {
  return { scope: $('#ikScope').value, pick: +$('#ikPick').value, policy: $('#ikPolicy').value, free: $('#ikFree').checked };
}
// What a run read: the same as the Custom card view's, with its own controls.
function ikSig() {
  const o = ikOpts();
  return cardsSig(true) + ':' + charsSig(new Set(ccScopeChars(o).map(c => c.n))) + ':' + teamCritRate() + ':' + denSig() +
    '|' + [o.scope, o.pick, o.policy, o.free].join(',');
}
let ikCache = null, ikJob = 0;
function runInkCard() {
  const job = ++ikJob, o = ikOpts(), chars = ccScopeChars(o), sig = ikSig();
  if (!chars.length) {
    ikCache = null;
    $('#ikSummary').innerHTML = '<p class="muted">Mark some characters as owned on the Roster tab first, or choose "All characters".</p>';
    $('#ikPanel').classList.add('hide');
    ikFillCheckChars();
    return Promise.resolve(false);
  }
  const rows = [];
  let i = 0;
  const progress = () => {
    $('#ikSummary').innerHTML = `<div class="notice info">Pricing an ink card for each character… <b>${i}</b> of ${chars.length}</div>`;
  };
  progress();
  return new Promise(resolve => {
    const step = () => {
      if (job !== ikJob) return resolve(false);
      const t0 = performance.now();
      while (i < chars.length && performance.now() - t0 < 50) rows.push(ikRow(chars[i++], o));
      if (i < chars.length) { progress(); setTimeout(step, 0); return; }
      rows.sort((a, b) => b.gain - a.gain || a.ch.n.localeCompare(b.ch.n));
      rows.forEach((r, k) => { r.rank = k + 1; });
      ikCache = { sig, o, rows, tc: teamCritRate() };
      renderInkCard();
      ikFillCheckChars();
      if (!ikCheckFilled && rows[0] && rows[0].best) ikFillRecommended(rows[0].ch.n); else ikCheck();
      markStaleRuns();
      resolve(true);
    };
    setTimeout(step, 0);
  });
}

const ikSort = { key: null, dir: 1 };
const IK_SORT_COLS = { rank: r => r.rank, char: r => r.ch.n, gain: r => r.gain, range: r => r.range ? r.range.lo : -1, now: r => r.now == null ? -1 : r.now, inv: r => r.inv, after: r => r.after };
function sortIkRows(rows) {
  if (!ikSort.key) return rows.slice();   // the run's own order: largest gain first
  const get = IK_SORT_COLS[ikSort.key];
  return rows.slice().sort((a, b) => {
    const av = get(a), bv = get(b);
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return (cmp || a.rank - b.rank) * ikSort.dir;
  });
}
const ikPickLabel = k => k === 0 ? 'no substats' : k === 1 ? '1 substat' : k + ' substats';
const ikInkLabel = k => `${IK_ELYSIAN[k]} Elysian Ink, ${k} Prophetic Ink`;
// The card to make: slot, set and main, then the substats to pick, best first, coloured by worth.
function ikPickHtml(x, t) {
  const { opt, picked } = x, f = couplingFactors(t, opt.slot, opt.card.main);
  const names = picked.map(s => {
    const w = (t.w[s] || 0) * cf(f, s);
    return `<span class="s${w >= 6 ? ' good' : w <= 1 ? ' bad' : ''}">${esc(s)}</span>`;
  }).join('<span class="sep">·</span><wbr>');
  const rnd = 4 - picked.length;
  return `<span class="slot ${opt.slot}">${opt.slot.slice(0, 3)}</span> <b>${esc(opt.set)}</b> · ${esc(opt.card.main)}
    <div class="tiny muted">${picked.length ? `pick <span class="subs">${names}</span>${rnd ? `; ${rnd} more at random` : ''}` : 'all four substats at random'}</div>`;
}
/* The character the table over the ranking is about: the one whose row was last clicked, else the
   top of the ranking. Kept by name, so it survives a re-run that still rates them. */
let ikFocus = null;
function ikFocusRow() {
  if (!ikCache) return null;
  const rows = ikCache.rows.filter(r => r.best);
  return rows.filter(r => r.ch.n === ikFocus)[0] || rows[0] || null;
}
function ikSetFocus(name) {
  ikFocus = name;
  renderIkFocus();
  $$('#ikTable tr.ikRow').forEach(tr => {
    const on = tr.dataset.char === name;
    tr.classList.toggle('on', on);
    tr.setAttribute('aria-current', String(on));
  });
  const box = $('#ikFocusBox');
  if (box) box.scrollIntoView({ block: 'nearest' });
}
// How much each extra pick is worth for the focused character: the decision the Elysian Ink buys.
function renderIkFocus() {
  const box = $('#ikFocusBox'), r = ikFocusRow();
  if (!box || !r) return;
  const o = ikCache.o;
  const ladder = `<div class="flowTable" style="margin:8px 0 0"><table>
      <thead><tr><th>Substats you pick</th><th>Ink it takes</th><th>Card to make</th><th class="right">Gain</th></tr></thead>
      <tbody>${r.byK.map((x, k) => x ? `<tr${k === o.pick ? ' class="on"' : ''}>
        <td class="tiny"><b>${k}</b></td>
        <td class="tiny">${esc(ikInkLabel(k))}</td>
        <td class="tiny">${ikPickHtml(x, r.t)}</td>
        <td class="right"><span class="score${x.gain >= UPGRADE_MIN_GAIN ? ' gainpos' : ''}">+${x.gain.toFixed(1)}</span></td>
      </tr>` : '').join('')}</tbody></table></div>`;
  box.innerHTML = `<span class="tiny muted">#${r.rank}</span> <b>${esc(r.ch.n)}</b> <span class="gainpos score">+${r.gain.toFixed(1)}</span>
      <span class="tiny muted">build points · ${ccRangeHtml(r.range, true)}</span>
      <div style="margin-top:4px">${ikPickHtml(r.best, r.t)}</div>
      ${ccAlsoHtml(r, { card: r.best.opt.card, cards: r.best.opt.cards })}
      <div class="tiny muted" style="margin-top:8px">What picking more or fewer substats would add for ${esc(r.ch.n)}
        <span class="ikFocusHint">· click a row in the ranking below to see another character</span>:</div>
      ${ladder}`;
}
function renderInkCard() {
  if (!ikCache) return;
  const { rows, o } = ikCache;
  const el = $('#ikElement').value, q = $('#ikQ').value.trim().toLowerCase();
  const list = sortIkRows(rows.filter(r => {
    if (el && r.ch.e !== el) return false;
    if (q) {
      const b = r.best;
      const hay = [r.ch.n, r.ch.a || '', b ? b.opt.set : '', b ? b.opt.slot : '', b ? b.opt.card.main : '', b ? b.picked.join(' ') : ''].join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }));
  const first = rows[0] && rows[0].best ? rows[0] : null;
  $('#ikSummary').innerHTML = !first
    ? '<div class="notice info">No character in scope gains anything from an ink card over what your inventory already gives them.</div>'
    : `<div class="notice info">Ranked <b>${rows.length}</b> character${rows.length === 1 ? '' : 's'} by what one ink card with
        <b>${esc(ikPickLabel(o.pick))}</b> picked adds to their build score, averaged over what luck fills in, over the best your
        inventory already gives them.</div>
      <div id="ikFocusBox" style="margin-top:12px"></div>`;
  if (first) renderIkFocus();
  $('#ikPanel').classList.toggle('hide', !list.length);
  if (!list.length) return;
  const maxGain = Math.max.apply(null, rows.map(r => r.gain).concat([0.1]));
  const num = v => v == null ? '<span class="muted">—</span>' : Math.round(v);
  const th = (key, label, title) => sortThHtml(key, label, ikSort, title);
  $('#ikTable').innerHTML = `<thead><tr>
      ${th('rank', '#', 'Rank by gain')}
      ${th('char', 'Character')}
      <th>Card to make</th>
      ${th('gain', 'Gain', 'Build-score points the card adds over the best loadout your inventory already gives this character, averaged over the substats and values luck decides. Compares across characters.')}
      ${th('range', 'Likely', 'Where the gain lands in 8 of 10 cards made and levelled at random. Sorts on the low end.')}
      <th title="The gain with 0, 1, 2, 3 or 4 substats picked (0, 1, 2, 4 or 8 Elysian Ink); the one you chose is in bold">By substats picked</th>
      ${th('now', 'Now', 'Build score of what is worn now')}
      ${th('inv', 'Without', 'Build score of the best loadout your inventory can already give them, without the new card')}
      ${th('after', 'With', 'Build score with the new card, on average')}
      <th></th>
    </tr></thead><tbody>` +
    list.map(r => {
      const b = r.best, after = Math.round(r.after), on = b && r === ikFocusRow();
      return `<tr${b ? ` class="ikRow${on ? ' on' : ''}" data-char="${esc(r.ch.n)}" tabindex="0" aria-current="${on}" title="Show what picking more or fewer substats adds for ${esc(r.ch.n)}"` : ''}>
        <td class="tiny muted right">${r.rank}</td>
        <td class="tiny"><b>${esc(r.ch.n)}</b>
          <div class="tiny muted">${esc(r.ch.e)}${!state.chars[r.ch.n].owned ? ' · not owned' : state.chars[r.ch.n].benched ? ' · benched' : ''}</div></td>
        <td class="tiny">${b ? ikPickHtml(b, r.t) + ccAlsoHtml(r, { card: b.opt.card, cards: b.opt.cards }) : '<span class="muted">no set to make it in</span>'}</td>
        <td class="right"><span class="score${r.gain >= UPGRADE_MIN_GAIN ? ' gainpos' : ''}">+${r.gain.toFixed(1)}</span>
          <div class="bar" style="width:64px;margin-left:auto"><i style="width:${(100 * r.gain / maxGain).toFixed(1)}%"></i></div></td>
        <td class="right tiny">${ccRangeHtml(r.range)}</td>
        <td class="tiny" style="white-space:nowrap">${r.byK.map((x, k) => {
          const g = x ? x.gain.toFixed(1) : '—';
          return k === o.pick ? `<b>${g}</b>` : `<span class="muted">${g}</span>`;
        }).join(' / ')}</td>
        <td class="right">${num(r.now)}</td>
        <td class="right${r.baseFrom === 'plan' ? '' : ' muted'}" title="${r.baseFrom === 'plan' ? 'A better loadout than the one worn is already in your inventory — the Upgrades tab lists it' : 'Already the best your inventory gives them'}">${num(r.inv)}</td>
        <td class="right"><span class="tag bs ${buildBand(after).cls}"><b>${after}</b></span></td>
        <td style="white-space:nowrap">${b ? `<button class="ghost tiny ikTry" data-char="${esc(r.ch.n)}">Check a roll</button>` : ''}
          <button class="ghost tiny ikOpt" data-char="${esc(r.ch.n)}">Optimise</button></td>
      </tr>`;
    }).join('') + '</tbody>';
  $$('#ikTable .ikTry').forEach(btn => btn.onclick = () => {
    ikFillRecommended(btn.dataset.char);
    $('#ikCheckPanel').scrollIntoView({ block: 'start' });
  });
  $$('#ikTable .ikOpt').forEach(btn => btn.onclick = () => openCharacterDetail(btn.dataset.char));
  // A row (anywhere but its buttons) puts that character in the table above.
  $$('#ikTable tr.ikRow').forEach(tr => {
    tr.onclick = e => { if (!e.target.closest('button, a, input, select')) ikSetFocus(tr.dataset.char); };
    tr.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === tr) { e.preventDefault(); ikSetFocus(tr.dataset.char); } };
  });
  $$('#ikTable .sortH').forEach(th => th.onclick = () => {
    const key = th.dataset.sort;
    ikSort.dir = ikSort.key === key ? -ikSort.dir : 1;
    ikSort.key = key;
    renderInkCard();
    refocus(`#ikTable th.sortH[data-sort="${key}"] .thBtn`);
  });
}

/* "Check a roll": the card as the Customize screen shows it — its four substats with their level-0
   values, the picked ones ticked — priced once levelled with typical upgrades, and for each picked
   substat what one re-roll is worth on average. The re-roll replaces the value, so it is a gamble
   on the five tiers; the advice is the substat whose re-roll gains most on average, or to keep the
   card when none gains anything. Each value is priced in the loadout the card itself lands in. */
let ikCheckFilled = false;
function ikFillCheckChars() {
  const cur = $('#ikChar').value;
  let list = ccScopeChars(ikOpts());
  if (!list.length) list = CHARACTERS.slice();
  $('#ikChar').innerHTML = list.map(c => `<option value="${esc(c.n)}">${esc(c.n)}</option>`).join('');
  if (cur && list.some(c => c.n === cur)) $('#ikChar').value = cur;
}
function ikSyncMain() {
  const curSet = $('#ikSet').value, sets = Object.keys(SETS).filter(x => !SETS[x].unreleased).sort();
  $('#ikSet').innerHTML = sets.map(x => `<option>${esc(x)}</option>`).join('');
  if (sets.indexOf(curSet) >= 0) $('#ikSet').value = curSet;
  const cur = $('#ikMain').value, mains = SLOT_INFO[$('#ikSlot').value].mains;
  $('#ikMain').innerHTML = mains.map(m => `<option>${esc(m)}</option>`).join('');
  if (mains.indexOf(cur) >= 0) $('#ikMain').value = cur;
}
function ikReadSubs() {
  return [0, 1, 2, 3].map(i => {
    const st = $(`#ikSubs .ikSubStat[data-i="${i}"]`), v = $(`#ikSubs .ikSubVal[data-i="${i}"]`), p = $(`#ikSubs .ikSubPick[data-i="${i}"]`);
    return { stat: st ? st.value : '', value: v ? parseFloat(v.value) : NaN, picked: !!(p && p.checked) };
  });
}
function ikRenderSubs(preset) {
  const cur = preset || ikReadSubs(), slot = $('#ikSlot').value, main = $('#ikMain').value;
  const no = frNoSub(slot, main), stats = Object.keys(SUBSTATS).filter(x => no.indexOf(x) < 0);
  $('#ikSubs').innerHTML = [0, 1, 2, 3].map(i => {
    const s = cur[i] && stats.indexOf(cur[i].stat) >= 0 ? cur[i] : { stat: '', picked: cur[i] && cur[i].picked };
    const tiers = s.stat ? ccTiers(s.stat, slot) : [];
    const val = tiers.indexOf(s.value) >= 0 ? s.value : tiers[2];
    return `<div class="field"><label for="ikSub${i}">Substat ${i + 1}</label><div style="display:flex;gap:4px;align-items:center">
      <select id="ikSub${i}" class="ikSubStat" data-i="${i}"><option value="">—</option>${stats.map(x =>
        `<option${x === s.stat ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>
      <select class="ikSubVal" data-i="${i}" aria-label="Substat ${i + 1} value at level 0"${tiers.length ? '' : ' disabled'}>${tiers.map(v =>
        `<option value="${v}"${v === val ? ' selected' : ''}>${esc(subVal({ stat: s.stat, value: v }))}</option>`).join('')}</select>
      <label class="check tiny" title="Picked with Elysian Ink, so Prophetic Ink can re-roll it"><input type="checkbox" class="ikSubPick" data-i="${i}"${s.picked ? ' checked' : ''}> picked</label>
    </div></div>`;
  }).join('');
  $$('#ikSubs .ikSubStat').forEach(sel => sel.onchange = () => { ikCheckFilled = true; ikRenderSubs(); ikCheck(); });
  $$('#ikSubs .ikSubVal, #ikSubs .ikSubPick').forEach(sel => sel.onchange = () => { ikCheckFilled = true; ikCheck(); });
}
function ikReadCard() {
  return { slot: $('#ikSlot').value, set: $('#ikSet').value, rarity: 5, level: 0, main: $('#ikMain').value,
    subs: ikReadSubs().filter(s => s.stat && !isNaN(s.value)).map(s => ({ stat: s.stat, value: s.value })) };
}
function ikCardErrors(card) {
  const errs = card.subs.length < 4 ? ['Enter all four substats: the game fills in the ones you did not pick.'] : [];
  if (new Set(card.subs.map(s => s.stat)).size < card.subs.length) errs.push('Each substat can only appear once.');
  return errs.concat(validateCard(card));
}
// The recommended card: its picked substats at a middling value, the random ones left for the user.
function ikFillRecommended(name) {
  const row = ikCache && ikCache.rows.filter(r => r.ch.n === name)[0];
  if (!row || !row.best) return;
  ikCheckFilled = true;
  $('#ikChar').value = name;
  const { opt, picked } = row.best;
  $('#ikSlot').value = opt.slot; ikSyncMain(); $('#ikSet').value = opt.set; $('#ikMain').value = opt.card.main;
  ikRenderSubs([0, 1, 2, 3].map(i => picked[i] ? { stat: picked[i], value: ccTiers(picked[i], opt.slot)[2], picked: true } : { stat: '', picked: false }));
  ikCheck();
}
function ikCheck() {
  const out = $('#ikCheckOut');
  const ch = charDef($('#ikChar').value);
  if (!out || !ch) { if (out) out.innerHTML = ''; return; }
  const card = ikReadCard(), errs = ikCardErrors(card);
  if (errs.length) { out.innerHTML = `<p class="tiny muted">${esc(errs[0])}</p>`; return; }
  const row = ikCache && ikCache.rows.filter(r => r.ch === ch)[0];
  const ctx = row ? row.ctx : ccContext(ch, Object.assign({}, ikCache ? ikCache.o : ikOpts(), { kind: 'heavens' })), t = ctx.t;
  const picks = ikReadSubs().filter(s => s.stat && !isNaN(s.value)).map(s => s.picked);
  // Levelled with typical upgrades: each substat gains a quarter of the five average rolls.
  const levelled = vals => Object.assign({}, card, { id: 'craft', crafted: true, level: RARITY[5].maxLevel,
    subs: card.subs.map((s, i) => ({ stat: s.stat, value: ccRound(s.stat, vals[i] + CC_UPS / 4 * ccTierMean(s.stat, card.slot)) })) });
  const start = card.subs.map(s => s.value);
  const now = levelled(start), placed = ccPlace(ctx, now);
  const rests = [placed.cards ? placed.cards.filter(c => c !== now) : ctx.base.cards.filter(c => c.slot !== card.slot)];
  const gainOf = vals => Math.max(0, 100 * (ikTotal(ctx, levelled(vals), rests) - ctx.base.total) / ctx.idealTotal);
  const g0 = Math.max(0, 100 * (Math.max(placed.total, ctx.base.total) - ctx.base.total) / ctx.idealTotal);
  const mine = ccRange(ikOutcomes(ctx, { opt: { slot: card.slot, set: card.set, card: { main: card.main } }, picked: [], rests }, card.subs, CC_CHECK_SAMPLES));
  const rerolls = card.subs.map((s, i) => {
    if (!picks[i]) return null;
    const tiers = ccTiers(s.stat, card.slot);
    const gains = tiers.map(v => gainOf(start.map((x, j) => j === i ? v : x)));
    const g = gainOf(start);
    const avg = gains.reduce((a, x) => a + x, 0) / gains.length;
    return { i, s, delta: avg - g, up: tiers.filter(v => v > s.value + 1e-9).length, down: tiers.filter(v => v < s.value - 1e-9).length, n: tiers.length };
  }).filter(Boolean);
  const best = rerolls.slice().sort((a, b) => b.delta - a.delta)[0];
  const advice = !rerolls.length
    ? '<p class="tiny muted" style="margin:6px 0 0">Tick the substats you picked with Elysian Ink to see which one is worth a re-roll.</p>'
    : best.delta > 0.005
      ? `<p class="ikAdvice" style="margin:8px 0 0">Re-roll <b>${esc(best.s.stat)}</b>: on average it adds <b class="gainpos">+${best.delta.toFixed(2)}</b> build points.
          ${best.up} of the ${best.n} possible values are higher than now, ${best.down} lower; the new value replaces the old one either way.
          <span class="tiny muted">After each re-roll, enter the new value and check again.</span></p>`
      : `<p class="ikAdvice" style="margin:8px 0 0"><b>Keep it.</b> No re-roll of a picked substat is expected to add anything: each is already at or above its average value.</p>`;
  out.innerHTML = `<p style="margin:0">Levelled to 25 with typical upgrades, this card adds <b class="${g0 >= UPGRADE_MIN_GAIN ? 'gainpos' : ''}">+${g0.toFixed(1)}</b>
      build points for ${esc(ch.n)}. <span class="tiny muted">With random upgrades, 8 in 10 outcomes land between +${mine.lo.toFixed(1)} and +${mine.hi.toFixed(1)}.</span></p>
    ${ccAlsoHtml({ ch }, { card: now, cards: placed.cards || [] })}
    ${rerolls.length ? `<div class="flowTable" style="margin:10px 0 0"><table>
      <thead><tr><th>Picked substat</th><th class="right">Now</th><th class="right" title="Build points one re-roll adds on average; negative means it is expected to cost">One re-roll, on average</th><th>Higher / lower</th></tr></thead>
      <tbody>${rerolls.map(x => `<tr${x === best && best.delta > 0.005 ? ' class="on"' : ''}>
        <td class="tiny"><b>${esc(x.s.stat)}</b></td>
        <td class="right tiny">${esc(subVal(x.s))}</td>
        <td class="right"><span class="score${x.delta > 0.005 ? ' gainpos' : ''}">${x.delta >= 0 ? '+' : '−'}${Math.abs(x.delta).toFixed(2)}</span></td>
        <td class="tiny">${x.up} higher · ${x.down} lower</td>
      </tr>`).join('')}</tbody></table></div>` : ''}
    ${advice}`;
}
function ikAddCard() {
  const card = ikReadCard(), errs = ikCardErrors(card);
  if (errs.length) { notify(errs[0]); return; }
  const snap = snapshotState();
  card.id = 'c' + (state.nextId++);
  card.equipped = null;
  state.cards.push(card);
  commit();
  offerUndo(`Added a 5★ ${card.slot} ${card.set} card (${card.main}) at level 0 to the inventory.`, snap);
}

/* ======================== Retrograde Card: which levelled card to reset ========================
   A Retrograde Card resets a revelation card to level 0: the upgrades it has had are undone, the
   substats it dropped with keep their starting values, and levelling it again lands five new
   upgrades at random (the user, 10 Oct 2026; Game8: "only resets the substats gained through
   upgrading"). A card that dropped with three substats gained its fourth at its first upgrade, so
   a reset takes that one off too. Whether it comes back the same is not known: Prydwen says the
   hidden fourth "can be changed" by a Retrograde Card, so by default it is minted again as a random
   stat, and the Fourth substat control switches to "comes back the same".

   So the cards worth a reset are the ones with substats the character wants and upgrades that went
   elsewhere. Nothing records where a card's upgrades went, but its values do: k rolls of a stat can
   only print within k × its lowest to k × its highest tier, the rolls must add up to the drop plus
   the upgrades, and the game lands upgrades on random substats (rgInfer). On the real inventory
   that pins every levelled card's roll counts, and whether it dropped with three or four (their
   totals differ by one), with no card left unexplained.

   Each card is then reset and re-levelled RG_SAMPLES times at random (rgResets) and every outcome
   priced as a whole loadout through the build score's own numerator (buildScoreOf), against keeping
   the card as it is (levelled on at random, when not yet at 25). A worn card is priced for its
   wearer, a spare one for the character in scope it helps most. Neither side is counted below what
   the character would wear in that slot without the card — what they wear there, or their best few
   spare cards by card score at full level (rgFallback) — so a spare card's reset that still does
   not beat their own card is worth nothing, while a worn card's reset that comes out worse costs
   what it costs, since the old card is gone. Gains are build points, which compare across
   characters. */
const RG_P4 = 55;
const RG_SAMPLES = 300;   // random re-levellings per card
const RG_ALT = 6;         // a character's fallback cards per slot
const RG_CANDS = 3;       // characters a spare card is simulated for, after a cheap screen

const rgUnit = stat => /^(ATK|DEF|HP)$/.test(stat) ? 1 : 0.1;
const rgTol = (stat, k) => rgUnit(stat) * (k + 1) / 2 + 1e-6;

// Every sum k rolls of a stat can make, with how many of the 5^k equally likely tier tuples make it.
const rgSumMemo = {};
function rgSums(stat, slot, k) {
  const key = stat + '|' + (slot === 'Space' ? 's' : 'h') + '|' + k;
  if (rgSumMemo[key]) return rgSumMemo[key];
  const tiers = ccTiers(stat, slot);
  let dist = new Map([[0, 1]]);
  for (let i = 0; i < k; i++) {
    const nx = new Map();
    dist.forEach((n, s) => tiers.forEach(t => { const v = Math.round((s + t) * 100) / 100; nx.set(v, (nx.get(v) || 0) + n); }));
    dist = nx;
  }
  return (rgSumMemo[key] = Array.from(dist, ([s, n]) => ({ s, n })));
}
// Chance k rolls of `stat` print as `v`.
function rgLike(stat, slot, k, v, tolMul) {
  const tol = rgTol(stat, k) * (tolMul || 1);
  let n = 0;
  rgSums(stat, slot, k).forEach(x => { if (Math.abs(x.s - v) <= tol) n += x.n; });
  return n / Math.pow(5, k);
}
// Weights over the stat's five tiers for its first (drop) roll, given k rolls printing as `v`.
function rgMintWeights(stat, slot, k, v, tolMul) {
  const tol = rgTol(stat, k) * (tolMul || 1), tiers = ccTiers(stat, slot);
  if (k === 1) return tiers.map(t => Math.abs(t - v) <= tol ? 1 : 0);
  const rest = rgSums(stat, slot, k - 1);
  return tiers.map(t => { let n = 0; rest.forEach(x => { if (Math.abs(t + x.s - v) <= tol) n += x.n; }); return n; });
}
function rgCompositions(total, parts) {
  const out = [];
  const go = (i, left, acc) => {
    if (i === parts - 1) { out.push(acc.concat([left])); return; }
    for (let x = 0; x <= left; x++) go(i + 1, left - x, acc.concat([x]));
  };
  go(0, total, []);
  return out;
}
const rgFact = n => n <= 1 ? 1 : n * rgFact(n - 1);
const rgMultinomial = c => rgFact(c.reduce((a, x) => a + x, 0)) / c.reduce((a, x) => a * rgFact(x), 1);

/* The explanations of a levelled card: how many rolls each substat holds, and whether the card
   dropped with all its substats or gained the last one at its first upgrade (`late`, the index of
   that substat, -1 for none). Each weighted by how likely the game is to make it — upgrades land
   on a random substat, 40% of drops carry four substats (FR_FOUR_SUBS) — times the chance its
   rolls print as the values on the card. */
function rgInfer(card) {
  const R = RARITY[card.rarity], subs = card.subs || [], n = subs.length;
  const u = upgradesUsed(card.rarity, card.level);
  const run = tolMul => {
    const states = [];
    const add = (k, late, prior) => {
      let p = prior;
      for (let i = 0; i < n && p > 0; i++) p *= rgLike(subs[i].stat, card.slot, k[i], subs[i].value, tolMul);
      if (p > 0) states.push({ k, late, p });
    };
    if (n >= R.subMin && (n === R.subMax || u === 0))
      rgCompositions(u, n).forEach(c => add(c.map(x => x + 1), -1, FR_FOUR_SUBS * rgMultinomial(c) / Math.pow(n, u)));
    if (n === R.subMax && R.subMin < R.subMax && u >= 1)
      for (let j = 0; j < n; j++)
        rgCompositions(u - 1, n).forEach(c => add(c.map(x => x + 1), j, (1 - FR_FOUR_SUBS) / n * rgMultinomial(c) / Math.pow(n, u - 1)));
    return states;
  };
  let tolMul = 1, states = run(1);
  if (!states.length) { tolMul = 2; states = run(2); }
  const tot = states.reduce((a, s) => a + s.p, 0);
  states.forEach(s => { s.p /= tot; });
  states.sort((a, b) => b.p - a.p);
  return { states, tolMul, u, pLate: states.filter(s => s.late >= 0).reduce((a, s) => a + s.p, 0) };
}

/* `n` outcomes of resetting the card and levelling it to the cap again: a drop state picked by its
   chance, each kept substat back to a drop roll consistent with its value, the late substat (if any)
   gone and minted again at the first upgrade — as another random stat when `fourth` is 'random',
   the same one when 'same' — and the upgrades landing on random substats at random tiers. */
function rgResets(card, inf, n, fourth) {
  const rnd = ccRng(hashStr(2166136261, ['retro', card.id, card.slot, card.set, card.main, JSON.stringify(card.subs), fourth].join('|')));
  const pickW = (items, w) => { const tot = w.reduce((a, x) => a + x, 0); let r = rnd() * tot; for (let i = 0; i < items.length; i++) { r -= w[i]; if (r < 0) return items[i]; } return items[items.length - 1]; };
  const pick = a => a[Math.min(a.length - 1, Math.floor(rnd() * a.length))];
  const R = RARITY[card.rarity], cap = R.maxLevel, subs = card.subs;
  const no = frNoSub(card.slot, card.main);
  const out = [];
  for (let m = 0; m < n; m++) {
    const st = pickW(inf.states, inf.states.map(s => s.p));
    const stats = [], vals = [];
    subs.forEach((s, i) => {
      if (i === st.late) return;
      stats.push(s.stat);
      vals.push(pickW(ccTiers(s.stat, card.slot), rgMintWeights(s.stat, card.slot, st.k[i], s.value, inf.tolMul)));
    });
    let ups = R.upgrades;
    if (stats.length < R.subMax) {
      let add;
      if (fourth === 'same' && st.late >= 0) add = subs[st.late].stat;
      else { const left = Object.keys(SUBSTATS).filter(x => no.indexOf(x) < 0 && stats.indexOf(x) < 0); add = pick(left); }
      stats.push(add); vals.push(pick(ccTiers(add, card.slot))); ups--;
    }
    for (let k = 0; k < ups; k++) { const i = Math.min(stats.length - 1, Math.floor(rnd() * stats.length)); vals[i] += pick(ccTiers(stats[i], card.slot)); }
    out.push(Object.assign({}, card, { level: cap, subs: stats.map((s, i) => ({ stat: s, value: ccRound(s, vals[i]) })) }));
  }
  return out;
}
// The card as it is, levelled to the cap without a reset: its remaining upgrades land at random.
function rgKeeps(card, n) {
  const R = RARITY[card.rarity], left = remainingUpgrades(card);
  if (!left) return [card];
  const rnd = ccRng(hashStr(2166136261, ['keep', card.id, JSON.stringify(card.subs)].join('|')));
  const pick = a => a[Math.min(a.length - 1, Math.floor(rnd() * a.length))];
  const out = [];
  for (let m = 0; m < n; m++) {
    const vals = card.subs.map(s => s.value);
    for (let k = 0; k < left; k++) { const i = Math.min(vals.length - 1, Math.floor(rnd() * vals.length)); vals[i] += pick(ccTiers(card.subs[i].stat, card.slot)); }
    out.push(Object.assign({}, card, { level: R.maxLevel, subs: card.subs.map((s, i) => ({ stat: s.stat, value: ccRound(s.stat, vals[i]) })) }));
  }
  return out;
}

// Everything pricing a card for one character reads, built once per run.
function rgCharCtx(ch, free) {
  const t = target(ch), lo = charLoadout(ch.n), idl = idealLoadout(ch, t, RG_P4);
  const worn = state.cards.filter(c => c.equipped === ch.n);
  const ev = cards => { const b = buildScoreOf(ch, cards, RG_P4, lo, idl, t); return b ? b.raw : 0; };
  const alts = {};
  SLOTS.forEach(sl => {
    alts[sl] = free.filter(c => c.slot === sl).map(c => ({ c, s: cardScore(atMaxLevel(c), t) }))
      .sort((a, b) => b.s - a.s).slice(0, RG_ALT + 1).map(x => x.c);
  });
  return { ch, t, worn, ev, alts, fall: {} };
}
// What the character would wear in that slot without this card: what they wear, or a spare card.
function rgFallback(cx, card) {
  const others = cx.worn.filter(c => c.slot !== card.slot);
  let best = cx.ev(others);
  const wear = cx.worn.filter(c => c.slot === card.slot)[0];
  if (wear && wear !== card) best = Math.max(best, cx.ev(others.concat([atMaxLevel(wear)])));
  cx.alts[card.slot].forEach(a => { if (a !== card) best = Math.max(best, cx.ev(others.concat([atMaxLevel(a)]))); });
  return { others, fall: best };
}
/* One card for one character: the build points with the card kept (levelled on as it is) against
   with it reset, never below what they would wear without it — each outcome priced as the whole
   loadout. `gains` is sorted, so ccRange reads it directly. */
function rgPrice(cx, card, keeps, resets) {
  const { others, fall } = rgFallback(cx, card);
  const val = c => Math.max(fall, cx.ev(others.concat([c])));
  const before = keeps.reduce((a, c) => a + val(c), 0) / keeps.length;
  const gains = resets.map(c => val(c) - before).sort((a, b) => a - b);
  return { cx, before, fall, gains, mean: gains.reduce((a, x) => a + x, 0) / gains.length,
    better: gains.filter(g => g > 0.05).length / gains.length, worse: gains.filter(g => g < -0.05).length / gains.length };
}

/* ---- the Retrograde view: run, draw ----
   Split like the Custom card view's: the run prices every levelled card in 50 ms slices (about 2 s
   for the real inventory's 345), the filters only redraw, and it runs on its first visit and is
   then only marked stale. */
function rgOpts() { return { scope: $('#rgScope').value, fourth: $('#rgFourth').value }; }
const rgScopeChars = o => o.scope === 'all' ? CHARACTERS.slice() : ownedChars();
// The cards a reset can change: levelled 5★ cards (the roll tables are measured for 5★ only).
const rgCandidates = () => state.cards.filter(c => c.rarity === 5 && upgradesUsed(c.rarity, c.level) > 0);
/* What a run read: every card with its wearer and lock (the candidates, the fallbacks, what is
   worn), who is owned, the targets and setups of the characters in scope, the team crit rate, the
   Den and its own controls. Show, slot, wearer and search only narrow the drawn table. */
function rgSig() {
  const o = rgOpts();
  return cardsSig(true) + ':' + charsSig(new Set(rgScopeChars(o).map(c => c.n))) + ':' + teamCritRate() + ':' + denSig() +
    '|' + [o.scope, o.fourth].join(',');
}
/* One card's row: worn, it is priced for the wearer (if in scope); spare, for every character in
   scope its set does not lock out, screened on the first 40 outcomes and the best RG_CANDS priced
   on all of them, the one gaining most on average kept. */
function rgRow(card, o, ctxs) {
  const inf = rgInfer(card);
  if (!inf.states.length) return null;
  const resets = rgResets(card, inf, RG_SAMPLES, o.fourth), keeps = rgKeeps(card, RG_SAMPLES);
  let cands;
  if (card.equipped) cands = ctxs.has(card.equipped) ? [ctxs.get(card.equipped)] : [];
  else {
    const S = card.slot === 'Space' ? SPACE_SETS[card.set] : SETS[card.set];
    cands = Array.from(ctxs.values()).filter(cx => !(S && S.elem && S.elem !== cx.ch.e))
      .map(cx => ({ cx, m: rgPrice(cx, card, keeps.slice(0, 40), resets.slice(0, 40)).mean }))
      .sort((a, b) => b.m - a.m).slice(0, RG_CANDS).map(x => x.cx);
  }
  let best = null;
  cands.forEach(cx => { const p = rgPrice(cx, card, keeps, resets); if (!best || p.mean > best.mean + 1e-9) best = p; });
  if (!best) return null;
  // Rolls per substat, averaged over the explanations; `sure` when one roll count holds 80% or more.
  const rolls = card.subs.map((s, i) => {
    const by = {};
    inf.states.forEach(st => { by[st.k[i]] = (by[st.k[i]] || 0) + st.p; });
    const top = Object.keys(by).sort((a, b) => by[b] - by[a])[0];
    return { k: +top, sure: by[top] >= 0.8 };
  });
  return { card, inf, p: best, ch: best.cx.ch, rolls, worn: !!card.equipped, range: ccRange(best.gains) };
}
let rgCache = null, rgJob = 0;
function runRetrograde() {
  const job = ++rgJob, o = rgOpts(), chars = rgScopeChars(o), sig = rgSig();
  if (!chars.length) {
    rgCache = null;
    $('#rgSummary').innerHTML = '<p class="muted">Mark some characters as owned on the Roster tab first, or choose "All characters".</p>';
    $('#rgPanel').classList.add('hide');
    return Promise.resolve(false);
  }
  const cards = rgCandidates();
  const free = poolFor('free', 5, null);
  const ctxs = new Map();
  const rows = [];
  let i = 0, c = 0;
  const progress = () => {
    $('#rgSummary').innerHTML = `<div class="notice info">Re-levelling each levelled card at random… <b>${i}</b> of ${cards.length}</div>`;
  };
  progress();
  return new Promise(resolve => {
    const step = () => {
      if (job !== rgJob) return resolve(false);
      const t0 = performance.now();
      while (c < chars.length && performance.now() - t0 < 50) { ctxs.set(chars[c].n, rgCharCtx(chars[c], free)); c++; }
      while (c >= chars.length && i < cards.length && performance.now() - t0 < 50) { const r = rgRow(cards[i++], o, ctxs); if (r) rows.push(r); }
      if (i < cards.length || c < chars.length) { progress(); setTimeout(step, 0); return; }
      rows.sort((a, b) => b.p.mean - a.p.mean || a.ch.n.localeCompare(b.ch.n));
      rows.forEach((r, k) => { r.rank = k + 1; });
      rgCache = { sig, o, rows, n: cards.length, tc: teamCritRate() };
      renderRetrograde();
      markStaleRuns();
      resolve(true);
    };
    setTimeout(step, 0);
  });
}

const rgSort = { key: null, dir: 1 };
const RG_SORT_COLS = { rank: r => r.rank, char: r => r.ch.n, gain: r => r.p.mean, range: r => r.range.lo, better: r => r.p.better,
  slot: r => SLOTS.indexOf(r.card.slot) };
function sortRgRows(rows) {
  if (!rgSort.key) return rows.slice();   // the run's own order: largest average gain first
  const get = RG_SORT_COLS[rgSort.key];
  return rows.slice().sort((a, b) => {
    const av = get(a), bv = get(b);
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return (cmp || a.rank - b.rank) * rgSort.dir;
  });
}
const rgSigned = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1);
// "−0.4 to +1.8": the middle 80% of resets, with the average and extremes on hover.
function rgRangeHtml(rg) {
  const tip = `8 in 10 resets land between ${rgSigned(rg.lo)} and ${rgSigned(rg.hi)} build points (average ${rgSigned(rg.mean)}; ` +
    `worst seen ${rgSigned(rg.min)}, best ${rgSigned(rg.max)}).`;
  return `<span title="${esc(tip)}" style="white-space:nowrap">${rgSigned(rg.lo)} to ${rgSigned(rg.hi)}</span>`;
}
// How sure it is the card dropped with three substats, whose fourth a reset may change.
function rgDropHtml(r) {
  const p = r.inf.pLate;
  if (p >= 0.8) return `<span class="tag" title="${esc(`About ${Math.round(p * 100)}% sure, from how many rolls its values hold. A reset takes the fourth substat off again; with the setting above it comes back ${r.fourthSame ? 'the same' : 'as a random stat at the first upgrade'}.`)}">dropped with 3</span>`;
  if (p <= 0.2) return `<span class="tag" title="${esc(`About ${Math.round((1 - p) * 100)}% sure, from how many rolls its values hold. A reset keeps all four substats.`)}">dropped with 4</span>`;
  return `<span class="tag" title="${esc(`${Math.round(p * 100)}% likely it dropped with three substats, from how many rolls its values hold.`)}">dropped with 3 or 4</span>`;
}
/* The card with each substat's roll count: its starting roll plus the upgrades that landed on it,
   read from the values. Coloured, like every card, by what each substat is worth to the character
   it is priced for — a reset is worth most when the many-roll substats are the faded ones. */
function rgCardHtml(r) {
  const c = r.card, t = r.p.cx.t, f = couplingFactors(t, c.slot, c.main);
  const subs = c.subs.map((s, i) => {
    const w = (t.w[s.stat] || 0) * cf(f, s.stat), cls = w >= 6 ? ' good' : w <= 1 ? ' bad' : '';
    const k = r.rolls[i];
    return `<span class="s${cls}" title="${esc(`${k.sure ? '' : 'Probably '}${k.k} roll${k.k === 1 ? '' : 's'}: its starting roll${k.k > 1 ? ` plus ${k.k - 1} upgrade${k.k === 2 ? '' : 's'}` : ' and no upgrade'}`)}">${esc(s.stat)} ${esc(subVal(s))}` +
      ` <span class="muted">×${k.sure ? '' : '~'}${k.k}</span></span>`;
  }).join('<span class="sep">·</span><wbr>');
  return `<span class="slot ${c.slot}">${c.slot.slice(0, 3)}</span> <b>${esc(c.set)}</b> · ${esc(c.main)} <span class="muted">Lv${c.level}</span>
    <div class="tiny"><span class="subs">${subs}</span></div>`;
}
function renderRetrograde() {
  if (!rgCache) return;
  const { rows, o } = rgCache;
  const show = $('#rgShow').value, sl = $('#rgSlot').value, wh = $('#rgWho').value, q = $('#rgQ').value.trim().toLowerCase();
  rows.forEach(r => { r.fourthSame = o.fourth === 'same'; });
  const list = sortRgRows(rows.filter(r => {
    if (show === 'gain' && !(r.p.mean >= UPGRADE_MIN_GAIN)) return false;
    if (sl && r.card.slot !== sl) return false;
    if (wh === 'worn' && !r.worn) return false;
    if (wh === 'spare' && r.worn) return false;
    if (q) {
      const hay = [r.ch.n, r.ch.a || '', r.card.set, r.card.slot, r.card.main, r.card.subs.map(s => s.stat).join(' ')].join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }));
  const good = rows.filter(r => r.p.mean >= UPGRADE_MIN_GAIN), top = good[0];
  $('#rgSummary').innerHTML = !rows.length
    ? '<div class="notice info">No levelled 5★ card to reset: a reset only changes a card that has had at least one upgrade.</div>'
    : !top
      ? `<div class="notice info">Re-levelled each of your <b>${rows.length}</b> levelled cards ${RG_SAMPLES} times at random. None is expected to come out
          better on average: their upgrades already landed on substats that matter.</div>`
      : `<div class="notice info">Re-levelled each of your <b>${rows.length}</b> levelled cards ${RG_SAMPLES} times at random. <b>${good.length}</b>
          ${good.length === 1 ? 'is' : 'are'} expected to come out better on average.</div>
        <div style="margin-top:12px">Best use of a Retrograde Card: <b>${esc(top.card.set)} ${esc(top.card.slot)}</b> (${esc(top.card.main)})
          ${top.worn ? `worn by <b>${esc(top.ch.n)}</b>` : `for <b>${esc(top.ch.n)}</b>, who gains most from it`}:
          <span class="gainpos score">${rgSigned(top.p.mean)}</span> <span class="tiny muted">build points on average ·
          ${Math.round(top.p.better * 100)}% of resets come out better, ${Math.round(top.p.worse * 100)}% worse</span>
          <div style="margin-top:4px">${rgCardHtml(top)}</div></div>`;
  $('#rgPanel').classList.toggle('hide', !list.length);
  $('#rgCount').textContent = `${list.length} shown of ${rows.length}`;
  if (!list.length) return;
  const maxGain = Math.max.apply(null, rows.map(r => r.p.mean).concat([0.1]));
  const th = (key, label, title) => sortThHtml(key, label, rgSort, title);
  $('#rgTable').innerHTML = `<thead><tr>
      ${th('rank', '#', 'Rank by average gain')}
      ${th('slot', 'Card', 'The card, each substat with its roll count (×3: its starting roll plus two upgrades), coloured by what it is worth to the character beside it')}
      ${th('char', 'For', 'Who wears it, or for a spare card the character it would help most')}
      ${th('gain', 'Gain', 'Build-score points a reset and re-levelling to 25 adds on average, against keeping the card as it is. Never counted below what the character would wear without the card. Compares across characters.')}
      ${th('range', 'Likely', 'Where the gain lands in 8 of 10 resets. Sorts on the low end.')}
      ${th('better', 'Better / worse', 'Share of resets that come out better, and worse, than keeping the card')}
      <th>Dropped with</th>
      <th></th>
    </tr></thead><tbody>` +
    list.map(r => `<tr>
        <td class="tiny muted right">${r.rank}</td>
        <td class="tiny">${rgCardHtml(r)}</td>
        <td class="tiny"><b>${esc(r.ch.n)}</b>
          <div class="tiny muted">${r.worn ? 'wears it' : 'spare card'}${!state.chars[r.ch.n].owned ? ' · not owned' : ''}</div></td>
        <td class="right"><span class="score${r.p.mean >= UPGRADE_MIN_GAIN ? ' gainpos' : ''}">${rgSigned(r.p.mean)}</span>
          <div class="bar" style="width:64px;margin-left:auto"><i style="width:${Math.max(0, 100 * r.p.mean / maxGain).toFixed(1)}%"></i></div></td>
        <td class="right tiny">${rgRangeHtml(r.range)}</td>
        <td class="tiny" style="white-space:nowrap">${Math.round(r.p.better * 100)}% · <span class="muted">${Math.round(r.p.worse * 100)}%</span></td>
        <td class="tiny">${rgDropHtml(r)}</td>
        <td><button class="ghost tiny rgOpt" data-char="${esc(r.ch.n)}">Optimise</button></td>
      </tr>`).join('') + '</tbody>';
  $$('#rgTable .rgOpt').forEach(btn => btn.onclick = () => openCharacterDetail(btn.dataset.char));
  $$('#rgTable .sortH').forEach(th => th.onclick = () => {
    const key = th.dataset.sort;
    rgSort.dir = rgSort.key === key ? -rgSort.dir : 1;
    rgSort.key = key;
    renderRetrograde();
    refocus(`#rgTable th.sortH[data-sort="${key}"] .thBtn`);
  });
}

/* ======================== Fortune Revelations: which set to redeem ========================
   A Fortune Revelation turns into a 5★ Heavens card of the set the player chooses; an Orange
   Fortune Revelation into a 5★ Space card the same way. Everything else about the card is luck:
   the slot, the main stat, which three or four substats it starts with, their values, and where
   its five upgrades land. So the question is not "which card" but "which set gives the best odds",
   and this answers it by drawing many random cards of each set and pricing every one against
   the characters the user chose to count.

   A card is worth what it adds to whichever counted character gains most from it — one card, one
   wearer — measured, like the Custom card view's gain, over the best loadout the inventory already
   gives that character (ccContext), in build points. A set's value is the average of that over its
   draws; most draws of most sets help nobody, and that zero is part of the average, which is what
   makes a set that helps one character often beat one that helps five rarely.

   The draws are the same for every set (the same slot, main and rolls, only the set name differs),
   so two sets are compared on identical luck; the gap between them is the set's doing, and the
   "about as good" mark beside a set uses the spread of those paired differences.

   What a draw looks like is measured, not published: no source documents the odds. The user's own
   inventory (4316 5★ cards, Oct 2026) has main stats close to evenly spread within each slot, 39%
   of level-0 Heavens cards and 44% of level-0 Space cards with four substats, every substat about
   equally common, never an HP substat on a Sun card and never a flat ATK or DEF substat on a Space
   card. Those are the odds used. The card is priced at level 25 with its upgrades rolled: a
   three-substat card gains its fourth on the first upgrade, the rest are rolls. */
const FR_SAMPLES = 400;        // draws per set; with the draws shared, enough to order the sets
const FR_FOUR_SUBS = 0.4;      // share of level-0 cards minted with four substats
const FR_P4 = CC_P4;
// The substats a card of this slot can never carry: its own main, and the flat stat a fixed main holds.
const frNoSub = (slot, main) => slot === 'Sun' ? ['HP'] : slot === 'Space' ? ['ATK', 'DEF'] : [main];
const frSetTable = kind => kind === 'space' ? SPACE_SETS : SETS;
const frSets = kind => Object.keys(frSetTable(kind)).filter(s => !frSetTable(kind)[s].unreleased).sort();
const frSlots = kind => kind === 'space' ? ['Space'] : HEAVENS;

/* The random cards, levelled to 25. Seeded by the card type alone, so a run is repeatable and every
   set gets the same draws. */
function frDraws(kind, n) {
  const rnd = ccRng(hashStr(2166136261, 'fortune|' + kind));
  const pick = a => a[Math.min(a.length - 1, Math.floor(rnd() * a.length))];
  const out = [];
  for (let k = 0; k < n; k++) {
    const slot = pick(frSlots(kind)), main = pick(SLOT_INFO[slot].mains), no = frNoSub(slot, main);
    const left = Object.keys(SUBSTATS).filter(s => no.indexOf(s) < 0);
    const take = () => left.splice(Math.min(left.length - 1, Math.floor(rnd() * left.length)), 1)[0];
    const four = rnd() < FR_FOUR_SUBS;
    const stats = [take(), take(), take()];
    if (four) stats.push(take());
    const v = stats.map(st => pick(ccTiers(st, slot)));
    let ups = RARITY[5].upgrades;
    if (!four) { const st = take(); stats.push(st); v.push(pick(ccTiers(st, slot))); ups--; }
    for (let u = 0; u < ups; u++) { const i = Math.min(3, Math.floor(rnd() * 4)); v[i] += pick(ccTiers(stats[i], slot)); }
    out.push({ slot, main, subs: stats.map((st, i) => ({ stat: st, value: ccRound(st, v[i]) })) });
  }
  return out;
}

/* Which characters count. By default everyone owned and not benched; `frChosen` holds only the
   user's departures from that (name → true or false), so a character pulled later is counted
   without anyone remembering to tick them, and one benched later drops out. Saved in the prefs. */
let frChosen = {};
const frDefault = ch => !!(state.chars[ch.n].owned && !state.chars[ch.n].benched);
const frIncluded = ch => Object.prototype.hasOwnProperty.call(frChosen, ch.n) ? !!frChosen[ch.n] : frDefault(ch);
const frChars = () => CHARACTERS.filter(frIncluded);
function frSetIncluded(name, on) {
  const ch = charDef(name);
  if (!ch) return;
  if (!!on === frDefault(ch)) delete frChosen[name]; else frChosen[name] = !!on;
}

/* One character, read once per run. The loadouts a drawn card may go into are the best one they
   can already wear with that slot emptied (and what they wear, if different), plus — for the sets
   they would build around (ccSets / ccSpaceSets: their own list and what they wear) — the loadout
   the optimiser picks when a good card of that set is in the pool, which is how a card that
   completes a 4-piece they are one short of gets its due. A draw is priced in each and keeps the
   best, the same as the Custom card view's ccPlace but without re-running the optimiser per draw.

   `can[set][slot][main]` says whether a generous card of that kind (more rolls than any card can
   hold, on their best stats) would add anything at all; when it would not, no draw of that kind
   can, and it is skipped. That is most of them — off-set cards that break a 4-piece, mains nobody
   wants — and it is most of this view's speed. */
const FR_BOUND_ROLLS = [4, 3, 3, 3];   // 13 maximum rolls; a real card holds 9
function frCharData(ch, o) {
  const ctx = ccContext(ch, o), t = ctx.t, kind = o.kind, slots = frSlots(kind);
  const key = cards => cards.map(c => c.id).sort().join(',');
  const around = {}, can = {};
  const common = {};
  slots.forEach(sl => {
    common[sl] = [ctx.base.cards.filter(c => c.slot !== sl)];
    if (ctx.worn !== ctx.base.cards) common[sl].push(ctx.worn.filter(c => c.slot !== sl));
  });
  const plan = kind === 'space' ? ccSpaceSets(ctx) : ccSets(ctx);
  frSets(kind).forEach(set => {
    can[set] = {};
    slots.forEach(sl => {
      const list = common[sl].slice();
      if (plan.indexOf(set) >= 0) {
        const ideal = idealCard(sl, t, set);
        const card = ccCard(sl, set, ideal.main, idealSubs(t, ideal.main), 'typical', 'fortune-probe');
        const p = ccPlace(ctx, card);
        if (p.cards && p.cards.indexOf(card) >= 0) {
          const rest = p.cards.filter(c => c !== card);
          if (!list.some(a => key(a) === key(rest))) list.push(rest);
        }
      }
      around[set + '|' + sl] = list;
      can[set][sl] = {};
      SLOT_INFO[sl].mains.forEach(m => {
        const subs = idealSubs(t, m).filter(s => frNoSub(sl, m).indexOf(s) < 0);
        const big = { id: 'fortune-bound', slot: sl, set, rarity: 5, level: RARITY[5].maxLevel, main: m,
          subs: subs.map((s, i) => ({ stat: s, value: maxRoll(s, sl) * FR_BOUND_ROLLS[i] })) };
        can[set][sl][m] = list.some(a => ctx.ev(a.concat([big])).total > ctx.base.total + 1e-9);
      });
    });
  });
  return { ch, t, ctx, around, can, pieces: set => ctx.base.cards.filter(c => c.set === set).length };
}

/* A drawn card's gain for one character, in build points, floored at 0 (a card that would make
   them worse is simply not worn). */
function frGain(d, card) {
  if (!d.can[card.set][card.slot][card.main]) return 0;
  let best = -Infinity;
  d.around[card.set + '|' + card.slot].forEach(a => { const v = d.ctx.ev(a.concat([card])).total; if (v > best) best = v; });
  return Math.max(0, 100 * (best - d.ctx.base.total) / d.ctx.idealTotal);
}

/* One set over every draw: per draw, the gain to whoever gains most (`vals`, kept for the paired
   comparison); per character, how often it helps them, how often they are the one it goes to, and
   which slots and mains do it. */
function frRateSet(set, draws, datas) {
  const per = datas.map(d => ({ d, hits: 0, sum: 0, top: 0, topSum: 0, combo: {} }));
  const slotN = {}, slotHit = {}, comboN = {};
  const vals = new Array(draws.length);
  draws.forEach((dr, k) => {
    const card = { id: 'fortune', slot: dr.slot, set, rarity: 5, level: RARITY[5].maxLevel, main: dr.main, subs: dr.subs };
    const ck = dr.slot + '|' + dr.main;
    slotN[dr.slot] = (slotN[dr.slot] || 0) + 1;
    comboN[ck] = (comboN[ck] || 0) + 1;
    let bi = -1, bg = 0;
    per.forEach((p, i) => {
      const g = frGain(p.d, card);
      if (g < UPGRADE_MIN_GAIN) return;
      p.hits++; p.sum += g; p.combo[ck] = (p.combo[ck] || 0) + 1;
      if (g > bg + 1e-12) { bg = g; bi = i; }
    });
    vals[k] = bg;
    if (bi >= 0) { per[bi].top++; per[bi].topSum += bg; slotHit[dr.slot] = (slotHit[dr.slot] || 0) + 1; }
  });
  const n = draws.length;
  const who = per.filter(p => p.hits).map(p => ({
    ch: p.d.ch, t: p.d.t, d: p.d,
    helps: p.hits / n, avg: p.sum / p.hits, gets: p.top / n, share: p.topSum / n,
    rolls: Object.keys(p.combo).map(k => ({ slot: k.split('|')[0], main: k.split('|')[1], rate: p.combo[k] / comboN[k] }))
      .filter(x => x.rate >= 0.25).sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot) || b.rate - a.rate)
  })).sort((a, b) => b.share - a.share || b.helps - a.helps);
  return { set, vals, value: vals.reduce((a, x) => a + x, 0) / n, useful: vals.filter(x => x > 0).length / n,
    bySlot: Object.keys(slotN).map(sl => ({ slot: sl, rate: (slotHit[sl] || 0) / slotN[sl] })).sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot)),
    who };
}

/* Is set `b` as good as `a`, given that both were rated on the same draws? Within two standard
   errors of the paired difference. */
function frClose(a, b) {
  const n = a.vals.length, diffs = a.vals.map((v, i) => v - b.vals[i]);
  const m = diffs.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(diffs.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(1, n - 1));
  return m <= 2 * sd / Math.sqrt(n) + 1e-9;
}

function frOpts() { return { kind: $('#frKind').value, policy: $('#frPolicy').value, free: $('#frFree').checked }; }
// What a run read: as the Custom card view's, for the characters counted, plus which ones they are.
function frSig() {
  const o = frOpts(), names = frChars().map(c => c.n);
  return cardsSig(true) + ':' + charsSig(new Set(names)) + ':' + teamCritRate() + ':' + denSig() +
    '|' + [o.kind, o.policy, o.free].join(',') + '|' + (hashStr(2166136261, names.join('|')) >>> 0).toString(36);
}
let frCache = null, frJob = 0;
/* In 50 ms slices, like the Custom card view: first each counted character is read (about as long
   as a Custom card row), then each set's draws are priced. A later run, or a load, abandons it. */
function runFortune() {
  const job = ++frJob, o = frOpts(), chars = frChars(), sig = frSig();
  renderFrChars();
  if (!chars.length) {
    frCache = null;
    $('#frSummary').innerHTML = '<p class="muted">No characters are counted. Tick some under "Characters counted" above, or mark the ones you own on the Roster tab.</p>';
    $('#frPanel').classList.add('hide');
    return Promise.resolve(false);
  }
  const sets = frSets(o.kind), draws = frDraws(o.kind, FR_SAMPLES), datas = [], rated = [];
  let i = 0, j = 0;
  const progress = () => {
    $('#frSummary').innerHTML = `<div class="notice info">${i < chars.length
      ? `Reading each character's best loadout… <b>${i}</b> of ${chars.length}`
      : `Drawing ${FR_SAMPLES} random cards from each set… <b>${j}</b> of ${sets.length} sets`}</div>`;
    $('#frPanel').classList.add('hide');
  };
  progress();
  return new Promise(resolve => {
    const step = () => {
      if (job !== frJob) return resolve(false);
      const t0 = performance.now();
      while (i < chars.length && performance.now() - t0 < 50) datas.push(frCharData(chars[i++], o));
      while (i >= chars.length && j < sets.length && performance.now() - t0 < 50) rated.push(frRateSet(sets[j++], draws, datas));
      if (j < sets.length) { progress(); setTimeout(step, 0); return; }
      rated.sort((a, b) => b.value - a.value || b.useful - a.useful || a.set.localeCompare(b.set));
      rated.forEach((r, k) => { r.rank = k + 1; r.close = k > 0 && frClose(rated[0], r); });
      frCache = { sig, o, rated, chars, tc: teamCritRate() };
      renderFortune();
      markStaleRuns();
      resolve(true);
    };
    setTimeout(step, 0);
  });
}

/* How a character stands with a set, in words: the reason it helps them. */
function frRelation(w, set, kind) {
  const t = w.t, out = [];
  if (kind === 'space') {
    if (t.space === set) out.push('their Space card');
    const worn = w.d.ctx.base.cards.filter(c => c.slot === 'Space')[0];
    if (worn && worn.set === set) out.push('worn now');
  } else {
    const k = (t.sets || []).indexOf(set);
    if (k === 0) out.push('their preferred set');
    else if (k > 0) out.push('on their set list');
    const n = w.d.pieces(set);
    if (n) out.push(`${n} piece${n === 1 ? '' : 's'} in their best loadout`);
    if (SETS[set].elem && SETS[set].elem !== w.ch.e) out.push('off-element: stats only');
  }
  return out.join(' · ') || 'stats only';
}
/* A slot where every main works reads "any main" with the lowest rate, rather than five entries. */
function frRollsHtml(w) {
  if (!w.rolls.length) return '<span class="muted">only lucky rolls</span>';
  const items = [];
  SLOTS.forEach(sl => {
    const xs = w.rolls.filter(x => x.slot === sl);
    if (!xs.length) return;
    if (!SLOT_INFO[sl].fixed && xs.length === SLOT_INFO[sl].mains.length)
      items.push({ slot: sl, main: 'any main', rate: Math.min.apply(null, xs.map(x => x.rate)), any: true });
    else xs.forEach(x => items.push(x));
  });
  return items.slice(0, 6).map(x => `<span class="nowrap"><span class="slot ${x.slot}">${x.slot.slice(0, 3)}</span>${SLOT_INFO[x.slot].fixed ? '' : ' ' + esc(x.main)}` +
    ` <span class="muted">${x.any ? 'at least ' : ''}${Math.round(100 * x.rate)}%</span></span>`).join(' · ') + (items.length > 6 ? ` <span class="muted">+${items.length - 6} more</span>` : '');
}
const frPct = x => x > 0 && x < 0.005 ? '<1%' : Math.round(100 * x) + '%';
function frWhoTableHtml(r, kind) {
  if (!r.who.length) return '<p class="tiny muted">No counted character gains from any draw of this set.</p>';
  return `<div class="flowTable" style="margin:6px 0 0"><table class="frWho">
    <thead><tr><th>Character</th><th>Why this set</th>
      <th class="right" title="How often a card from this set ends up with this character: they gain more from it than anyone else counted">Goes to them</th>
      <th class="right" title="How often a card from this set is an upgrade for this character at all, whether or not someone else gains more">Upgrade for them</th>
      <th class="right" title="Build points it adds to them, on average, when it is an upgrade">Avg gain</th>
      <th title="The slot and main stat combinations that are an upgrade for them at least a quarter of the time, and how often">Rolls that work for them</th></tr></thead>
    <tbody>${r.who.map(w => `<tr>
      <td class="tiny"><b>${esc(w.ch.n)}</b>${frDefault(w.ch) ? '' : ` <span class="tag">${state.chars[w.ch.n].owned ? 'benched' : 'not owned'}</span>`}</td>
      <td class="tiny muted">${esc(frRelation(w, r.set, kind))}</td>
      <td class="right">${frPct(w.gets)}</td>
      <td class="right">${frPct(w.helps)}</td>
      <td class="right"><span class="gainpos">+${w.avg.toFixed(1)}</span></td>
      <td class="tiny">${frRollsHtml(w)}</td></tr>`).join('')}</tbody></table></div>`;
}
function frNamesHtml(r, n) {
  const top = r.who.filter(w => w.gets > 0).slice(0, n);
  if (!top.length) return '<span class="muted">nobody counted</span>';
  const more = r.who.length - top.length;
  return top.map(w => `<b>${esc(w.ch.n)}</b> <span class="muted">${frPct(w.gets)}</span>`).join(', ') +
    (more > 0 ? ` <span class="muted">+${more} more</span>` : '');
}
function renderFortune() {
  if (!frCache) return;
  const { rated, o, chars } = frCache, kind = o.kind;
  const item = kind === 'space' ? 'Orange Fortune Revelation' : 'Fortune Revelation';
  const best = rated[0];
  const maxV = Math.max.apply(null, rated.map(r => r.value).concat([0.01]));
  const close = rated.filter(r => r.close);
  const elemTag = set => kind !== 'space' && SETS[set].elem ? ` <span class="tag">${esc(SETS[set].elem)} only</span>` : '';
  if (!best || best.value <= 0) {
    $('#frSummary').innerHTML = `<div class="notice info">No set's random card is an upgrade for any of the ${chars.length} counted characters over what your inventory already gives them.</div>`;
  } else {
    const top3 = best.who.filter(w => w.gets > 0).slice(0, 3);
    $('#frSummary').innerHTML = `<div class="notice info">Drew ${FR_SAMPLES} random cards from each of ${rated.length} sets and priced every one
        for the <b>${chars.length}</b> counted character${chars.length === 1 ? '' : 's'}, against the best loadout your inventory already gives them.</div>
      <div class="frPick">
        <div class="tiny muted">Pick this set</div>
        <div class="frPickSet">${esc(best.set)}${elemTag(best.set)}</div>
        <p>A random ${esc(kind === 'space' ? 'Space card' : 'card')} from it adds <b class="gainpos">+${best.value.toFixed(2)}</b> build points on average,
          counting the draws that help nobody as zero. <b>${frPct(best.useful)}</b> of draws are an upgrade for at least one counted character.</p>
        <p>Where it would most likely go: ${top3.map(w => `<b>${esc(w.ch.n)}</b> (${frPct(w.gets)} of draws, +${w.avg.toFixed(1)} when it helps them; ${esc(frRelation(w, best.set, kind))})`).join('; ')}.</p>
        ${kind === 'space' ? '' : `<p class="tiny muted">Which slot it rolls matters: ${best.bySlot.map(s => `${esc(s.slot)} helps someone ${frPct(s.rate)} of the time`).join(', ')}.</p>`}
        ${close.length ? `<p class="tiny">Within the margin of luck: ${close.map(r => `<b>${esc(r.set)}</b> (+${r.value.toFixed(2)})`).join(', ')}
          — on these odds the difference is too small to call, so pick by who you would rather improve.</p>` : rated[1] ? `<p class="tiny muted">Next best: ${esc(rated[1].set)} (+${rated[1].value.toFixed(2)}), a clear step down.</p>` : ''}
        <details class="frWhy"><summary>Everyone it could help</summary>${frWhoTableHtml(best, kind)}</details>
      </div>`;
  }
  $('#frPanel').classList.remove('hide');
  $('#frTable').innerHTML = `<thead><tr>
      <th class="right">#</th><th>Set</th>
      <th class="right" title="Build points a random card from this set adds, on average, to whichever counted character gains most from it. Draws that help nobody count as zero.">Avg value</th>
      <th class="right" title="How often a random card from this set is an upgrade for at least one counted character">Useful</th>
      ${kind === 'space' ? '' : '<th title="How often a card of each slot from this set helps someone">By slot</th>'}
      <th title="Who a card from this set most often goes to, and how often. Open the row for everyone it could help and why.">Most often goes to</th>
    </tr></thead><tbody>` + rated.map(r => `<tr class="frRow" data-set="${esc(r.set)}">
      <td class="tiny muted right">${r.rank}</td>
      <td><b>${esc(r.set)}</b>${elemTag(r.set)}${r === best ? ' <span class="tag hit">best</span>' : r.close ? ' <span class="tag" title="Within the margin of luck of the best set">about as good</span>' : ''}</td>
      <td class="right"><span class="score${r.value >= 0.005 ? ' gainpos' : ''}">+${r.value.toFixed(2)}</span>
        <div class="bar" style="width:64px;margin-left:auto"><i style="width:${(100 * r.value / maxV).toFixed(1)}%"></i></div></td>
      <td class="right">${frPct(r.useful)}</td>
      ${kind === 'space' ? '' : `<td class="tiny nowrap">${r.bySlot.map(s => `<span class="slot ${s.slot}">${s.slot.slice(0, 3)}</span> ${frPct(s.rate)}`).join(' ')}</td>`}
      <td class="tiny">${r.who.length ? `<details class="frWhy"><summary>${frNamesHtml(r, 3)}</summary>${frWhoTableHtml(r, kind)}</details>` : '<span class="muted">nobody counted</span>'}</td>
    </tr>`).join('') + '</tbody>';
}

/* The character picker: every character, the counted ones ticked, owned first. */
function renderFrChars() {
  const box = $('#frCharList');
  if (!box) return;
  const all = CHARACTERS.slice().sort((a, b) => (frDefault(b) - frDefault(a)) || (state.chars[b.n].owned - state.chars[a.n].owned));
  box.innerHTML = all.map(c => {
    const cs = state.chars[c.n];
    const note = !cs.owned ? 'not owned' : cs.benched ? 'benched' : '';
    return `<label class="check"><input type="checkbox" data-fr="${esc(c.n)}"${frIncluded(c) ? ' checked' : ''}>
      ${esc(c.n)}${note ? ` <span class="tiny muted">${note}</span>` : ''}</label>`;
  }).join('');
  $$('#frCharList input[data-fr]').forEach(i => i.onchange = () => { frSetIncluded(i.dataset.fr, i.checked); frCharsSummary(); markStaleRuns(); });
  frCharsSummary();
}
function frCharsSummary() {
  const n = frChars().length, def = CHARACTERS.filter(frDefault).length;
  const added = CHARACTERS.filter(c => frIncluded(c) && !frDefault(c)).length, dropped = CHARACTERS.filter(c => !frIncluded(c) && frDefault(c)).length;
  $('#frCharsSum').innerHTML = `Characters counted: <b>${n}</b> ${added || dropped
    ? `<span class="muted">(your ${def} owned, not benched${added ? `, ${added} added` : ''}${dropped ? `, ${dropped} left out` : ''})</span>`
    : '<span class="muted">— everyone you own and are not benching</span>'}`;
}

/* Both Upgrades views read what is equipped, so every equip/unequip path refreshes both.
   The headroom pass is skipped while its sub-tab is closed — the sub-tab's own handler
   runs it on the way in, so it cannot be shown stale, and a user who never opens it does
   not pay 300ms per equip (65 owned characters over 4000 cards) for a table nobody is
   looking at. The hidden flag tracks the SUB-tab, not the Upgrades tab, so equipping from
   Optimise while this view is the selected one still refreshes it. */
let upViewsStale = false;
function runUpgradeViews() {
  /* Nor does anyone pay for the Upgrades pass while the Upgrades tab is not on screen: it
     runs the plan search for every owned character, and was nearly all of every Equip click on
     any tab — about 0.47 s on the real inventory (Sep 2026, 36 characters). It is marked
     stale instead, and showTab runs it on the way in, so it cannot be shown stale either. */
  if ($('#tab-upgrades').classList.contains('hide')) { upViewsStale = true; return; }
  upViewsStale = false;
  runUpgrades();
  if (!$('#up-pane-headroom').classList.contains('hide')) runHeadroom();
}

/* Clears a card's wearer. A lock says "keep this on whoever currently wears it" — there
   is no separate field for who it was locked to, so the moment nobody wears it the lock
   stops meaning anything and would otherwise strand the card, unrecommendable to anyone.
   Every path that can send a card's `equipped` back to null goes through this. */
function clearEquip(card) { card.equipped = null; card.locked = false; }

/* Moves one card onto one character's one slot, unequipping whoever had either end of the
   trade. Deliberately narrower than the "Mark these as equipped" button in Optimise, which
   replaces a whole loadout — this only ever touches the one slot the suggestion was about. */
/* Every equip/unequip path funnels through swapCard or unequipCard, and both commit, so the
   refresh happens everywhere — including the card picker and Upgrades' swap button, neither
   of which otherwise touches the Optimise tab. runOpt() re-derives `real` from whatever is
   equipped now (see bestPlan), so this is also what keeps the coupling-against-real-gear
   numbers live rather than frozen at whatever the board looked like when Optimise last ran.
   A card taken off someone else is a trade against their build, so that move offers undo. */
function swapCard(charName, slot, cardId) {
  const card = state.cards.find(c => c.id === cardId);
  if (!card) return;
  const from = card.equipped && card.equipped !== charName ? card.equipped : null;
  const snap = from ? snapshotState() : null;
  state.cards.forEach(c => { if (c.equipped === charName && c.slot === slot) clearEquip(c); });
  card.equipped = charName;
  commit();
  if (from) offerUndo(`Moved ${from}'s ${slot} card to ${charName}.`, snap);
}

/* Several slots on one character in one action — Upgrades' "Equip all". Not a loop over
   swapCard: that re-renders (and re-runs the optimiser and this whole tab) per card, and
   the intermediate boards are half-swapped loadouts nobody asked to see. Everything moves,
   then the page is redrawn once. */
function swapCards(charName, swaps) {
  const moved = swaps.map(s => ({ slot: s.slot, card: state.cards.find(c => c.id === s.id) })).filter(s => s.card);
  if (!moved.length) return;
  moved.forEach(({ slot }) => state.cards.forEach(c => { if (c.equipped === charName && c.slot === slot) clearEquip(c); }));
  moved.forEach(({ card }) => { card.equipped = charName; });
  commit();
}

function unequipCard(cardId) {
  const card = state.cards.find(c => c.id === cardId);
  if (!card) return;
  clearEquip(card);
  commit();
}

/* Locks or unlocks every card currently worn by `charName` in one action — the roster
   Loadout popup's button. A locked card is excluded from every recommendation surface
   (poolFor, the card picker, Upgrades' cross-character pool, Triage's best-fit) for
   anyone but its current wearer; see clearEquip for how it comes back off automatically
   the moment the card is unequipped. */
function toggleLoadoutLock(charName) {
  const worn = state.cards.filter(c => c.equipped === charName);
  if (!worn.length) return;
  const lock = !worn.every(c => c.locked);
  worn.forEach(c => { c.locked = lock; });
  commit();
}

/* ------------------------------ roster ------------------------------ */
/* Every equipped card, grouped by the character wearing it. The roster needs this for
   all 65 characters at once, and scanning a 4000-card inventory once beats scanning it
   once per character. */
function equippedByChar() {
  const m = {};
  state.cards.forEach(c => { if (c.equipped) (m[c.equipped] = m[c.equipped] || []).push(c); });
  return m;
}

/* Compact build-score chip for the roster grid. Deliberately does not run the
   optimiser — the roster re-renders on every keystroke in the search box, and this
   only has to read the five cards already equipped. */
function buildScoreTag(char, worn) {
  const b = buildScore(char, (worn && worn[char.n]) || []);
  if (!b) return `<span class="tag bs bs-none" title="No cards are equipped on ${esc(char.n)} yet">build —</span>`;
  const band = buildBand(b.score);
  const partial = b.filled < SLOTS.length ? ` · ${b.filled}/${SLOTS.length} slots filled` : '';
  return `<span class="tag bs ${band.cls}" title="Build score ${b.score}/100 — ${band.label}${partial}">` +
         `build <b>${b.score}</b></span>`;
}

// Sort comparators for the roster grid. These all sort a filtered *copy* of CHARACTERS
// for display only — per the data-provenance rule the array itself is never re-sorted in
// place, so the optimiser picker and Triage keep iterating the untouched release order.
const ROSTER_SORTERS = {
  'release-asc': (a, b) => CHARACTERS.indexOf(a) - CHARACTERS.indexOf(b),
  'release-desc': (a, b) => CHARACTERS.indexOf(b) - CHARACTERS.indexOf(a),
  name: (a, b) => a.n.localeCompare(b.n),
  element: (a, b) => a.e.localeCompare(b.e) || a.n.localeCompare(b.n),
  rarity: (a, b) => b.r - a.r || a.n.localeCompare(b.n),
  build: (a, b, worn) => {
    const ba = buildScore(a, worn[a.n] || []), bb = buildScore(b, worn[b.n] || []);
    const sa = ba ? ba.score : -1, sb = bb ? bb.score : -1;
    return sb - sa || a.n.localeCompare(b.n);
  },
  owned: (a, b) => (state.chars[b.n].owned - state.chars[a.n].owned) ||
    CHARACTERS.indexOf(a) - CHARACTERS.indexOf(b),
};
/* The Roster's view: the portrait cards, or a dense list with one row per character — 36 owned
   characters as cards need about 2,600 px of scrolling on a laptop, and fit one screen as rows.
   Kept in the save's prefs like the filters. */
let rosterView = 'cards';

/* Ownership and benching are one click each from the roster, and un-owning a character also
   clears their bench flag, so both toggles offer undo. */
function toggleOwned(n) {
  const snap = snapshotState(), cs = state.chars[n];
  cs.owned = !cs.owned;
  if (!cs.owned) cs.benched = false; // benched is meaningless once unowned
  commit();
  offerUndo(`${n} marked ${cs.owned ? 'owned' : 'not owned'}.`, snap);
}
function toggleBenched(n) {
  const snap = snapshotState(), cs = state.chars[n];
  cs.benched = !cs.benched;
  commit();
  offerUndo(`${n} ${cs.benched ? 'benched' : 'back from the bench'}.`, snap);
}

function renderRoster() {
  const f = $('#rsFilter').value, q = $('#rsQ').value.trim().toLowerCase();
  const elFilter = $('#rsElement').value, sortBy = $('#rsSort').value;
  const hideBenched = $('#rsHideBenched').checked;
  const worn = equippedByChar();
  /* One ownership control. There used to be two — "Show: Owned only" and a "Hide not owned"
     checkbox that did the same thing — and a save that ticked the box keeps meaning it: see
     applyPrefs, which maps the old checkbox onto this select. "Hide benched" stays its own
     toggle, since benched is a state of an owned character, not an ownership filter. */
  const list = CHARACTERS.filter(c => {
    const cs = state.chars[c.n];
    if (f === 'owned' && !cs.owned) return false;
    if (f === 'unowned' && cs.owned) return false;
    if (hideBenched && cs.owned && cs.benched) return false;
    if (elFilter && c.e !== elFilter) return false;
    if (q && !(c.n + ' ' + (c.a || '') + ' ' + c.e + ' ' + c.arch).toLowerCase().includes(q)) return false;
    return true;
  });
  if (ROSTER_SORTERS[sortBy]) list.sort((a, b) => ROSTER_SORTERS[sortBy](a, b, worn));
  const onDefault = ownedChars().filter(c => setupIsDefault(c.n)).length;
  $('#rsCount').textContent = `${list.length} shown · ${ownedChars().length} owned` +
    (onDefault ? ` · ${onDefault} on the default setup` : '');
  $$('#rsView button').forEach(b => { const on = b.dataset.view === rosterView; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  $('#rsGrid').classList.toggle('hide', rosterView !== 'cards');
  $('#rsListPanel').classList.toggle('hide', rosterView !== 'list');
  const defaultTag = c => `<span class="tag" title="${esc(DEFAULT_SETUP_NOTE)} Open the character to set yours.">default setup</span>`;
  if (rosterView === 'list') {
    $('#rsGrid').innerHTML = '';
    $('#rsList').innerHTML = `<thead><tr><th>Character</th><th>Role</th><th>Build</th><th class="right">Slots</th>
        <th>Sets</th><th>Setup</th><th></th></tr></thead><tbody>` + list.map(c => {
      const t = target(c), cs = state.chars[c.n];
      const o = cs.owned, b = o && cs.benched;
      const el = ELEMENT_COLORS[c.e] || ELEMENT_COLORS['None'];
      return `<tr class="rrow${b ? ' benched' : ''}" data-ch="${esc(c.n)}" tabindex="0" aria-label="Open ${esc(c.n)}'s loadout">
        <td style="--el:${esc(el)}"><i class="el-dot" title="${esc(c.e)}"></i> <span class="nm">${esc(c.n)}</span>
          ${c.a ? `<span class="tiny muted">${esc(c.a)}</span>` : ''} <span class="tag r${c.r}">${c.r}★</span></td>
        <td class="tiny">${esc(c.arch)}${b ? ' <span class="tag benched">benched</span>' : ''}${o ? '' : ' <span class="tag">not owned</span>'}</td>
        <td>${buildScoreTag(c, worn)}</td>
        <td class="right tiny">${(worn[c.n] || []).length}/${SLOTS.length}</td>
        <td class="tiny muted">${esc(t.sets[0] || '—')} 4pc · ${esc(t.space || '—')}</td>
        <td class="tiny">${o && !b ? (setupIsDefault(c.n) ? defaultTag(c) : '<span class="muted">yours</span>') : ''}</td>
        <td class="acts">
          <button class="sm ghost" data-own="${esc(c.n)}" aria-pressed="${o}">${o ? '✓ Owned' : 'Mark owned'}</button>
          ${o ? `<button class="sm ghost" data-bench="${esc(c.n)}" aria-pressed="${b}">${b ? '✓ Benched' : 'Bench'}</button>` : ''}
          <button class="sm ghost" data-edit="${esc(c.n)}">Targets</button>
          <button class="sm ghost" data-optimize="${esc(c.n)}">Optimize</button></td>
      </tr>`;
    }).join('') + '</tbody>';
  } else {
    $('#rsList').innerHTML = '';
    $('#rsGrid').innerHTML = list.map(c => {
      const t = target(c);
      const cs = state.chars[c.n];
      const o = cs.owned, b = o && cs.benched;
      const el = ELEMENT_COLORS[c.e] || ELEMENT_COLORS['None'];
      return `<div class="cc ${o ? 'owned' : ''} ${b ? 'benched' : ''}" data-ch="${esc(c.n)}" style="--el:${esc(el)}"
          tabindex="0" role="button" aria-label="Open ${esc(c.n)}'s loadout">
        <div class="portrait">
          <div class="initials">${esc(initials(c.n))}</div>
          <img src="${esc(artPath(c.n))}" alt="" loading="lazy" onerror="this.remove()">
          <div class="veil"></div>
          <div class="corner l"><span class="tag r${c.r}">${c.r}★</span></div>
          <div class="corner r"><span class="tag el"><i class="el-dot"></i>${esc(c.e)}</span></div>
          <div class="corner more">
            <button class="sm ghost moreBtn" data-more="${esc(c.n)}" title="Owned and benched" aria-label="Owned and benched"
              aria-haspopup="menu" aria-expanded="false">&#8943;</button>
            <div class="moreMenu hide" data-more-menu="${esc(c.n)}" role="menu">
              <button class="sm ghost" role="menuitemcheckbox" aria-checked="${o}" data-own="${esc(c.n)}"
                title="${o ? 'Click to mark as not owned' : 'Click to mark as owned'}"><span class="ck">${o ? '✓' : ''}</span>Owned</button>
              ${o ? `<button class="sm ghost" role="menuitemcheckbox" aria-checked="${b}" data-bench="${esc(c.n)}"
                title="Benched characters are treated like unowned everywhere except the roster: hidden from the optimiser, Triage's owned scope and Upgrades."><span class="ck">${b ? '✓' : ''}</span>Benched</button>` : ''}
            </div>
          </div>
          <div class="cap">
            <div class="nm">${esc(c.n)}</div>
            ${c.a ? `<div class="al">${esc(c.a)}</div>` : ''}
          </div>
        </div>
        <div class="body">
          <div class="mt">
            ${buildScoreTag(c, worn)}
            <span class="tag">${esc(c.arch)}</span>
            ${b ? '<span class="tag benched">benched</span>' : ''}
            ${o && !b && setupIsDefault(c.n) ? defaultTag(c) : ''}
          </div>
          <div class="tiny muted" style="margin-top:7px">${esc((t.sets[0] || '—'))} 4pc · ${esc(t.space || '—')}</div>
          <div class="row acts">
            <button class="sm ghost" data-edit="${esc(c.n)}">Targets</button>
            <button class="sm ghost" data-optimize="${esc(c.n)}">Optimize</button>
          </div>
        </div></div>`;
    }).join('');
  }
  // Scoped to the roster: Inventory's rows carry `data-edit` too (see renderInv).
  const R = '#rsGrid, #rsList';
  const within = sel => R.split(', ').map(r => `${r} ${sel}`).join(', ');
  $$(within('[data-own]')).forEach(b => b.onclick = e => { e.stopPropagation(); toggleOwned(b.dataset.own); });
  $$(within('[data-bench]')).forEach(b => b.onclick = e => { e.stopPropagation(); toggleBenched(b.dataset.bench); });
  $$(within('[data-edit]')).forEach(b => b.onclick = e => { e.stopPropagation(); editTargets(b.dataset.edit); });
  $$(within('[data-optimize]')).forEach(b => b.onclick = e => { e.stopPropagation(); openCharacterDetail(b.dataset.optimize); });
  $$('#rsGrid [data-more]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const menu = $(`[data-more-menu="${CSS.escape(b.dataset.more)}"]`);
    const wasOpen = menu && !menu.classList.contains('hide');
    closeMoreMenus();
    if (menu && !wasOpen) { menu.classList.remove('hide'); b.setAttribute('aria-expanded', 'true'); }
  });
  /* The card (or row) itself opens the Loadout popup, from the mouse or — as a focusable
     button — from the keyboard. Keys pressed on a button inside it belong to that button. */
  $$(within('[data-ch]')).forEach(el => {
    el.onclick = () => openLoadout(el.dataset.ch);
    el.onkeydown = e => {
      if (e.target !== el || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault(); openLoadout(el.dataset.ch);
    };
  });
}
function closeMoreMenus() {
  $$('.moreMenu').forEach(m => m.classList.add('hide'));
  $$('#rsGrid [data-more]').forEach(b => b.setAttribute('aria-expanded', 'false'));
}
document.addEventListener('click', closeMoreMenus);

/* The weapon / refinement / Mindscape / Awareness selects: the Loadout popup's Setup section.
   This is not just flavour: it feeds charBaseStat -> damageBase -> damageFactors, so it moves
   every character's build-score spread term, not only the 37 with a published `ov.targets`.
   Returns the current loadout alongside the markup so a caller does not have to call
   charLoadout(c.n) again. The Targets dialog used to carry a second copy of these fields that
   saved on its own Save button while this one saved on every change; it links here instead. */
function loadoutFieldsHtml(c) {
  const cs = CHAR_STATS[c.n];
  const L = charLoadout(c.n);
  const opt = (v, sel, label) => `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(label == null ? v : label)}</option>`;
  const wName = k => cs[k] ? `${k === 'w4' ? '4★' : '5★'} · ${cs[k].n}` : (k === 'w4' ? '4★' : '5★');
  const bonusText = k => {
    const w = cs[k];
    if (!w) return '';
    // A passive can be counted *and* still have an uncounted clause: Mermaid Dreamer
    // grants crit damage and Resonance crit rate in one sentence, and only the first
    // is a stat this tool models. Say so, rather than implying the whole line landed.
    if (w.b) return `${w.b.s} +${w.b.r[Math.max(1, Math.min(7, L.refine)) - 1]}${w.b.pct ? '%' : ''} at ${refineLabel(L.refine)}`
      + (w.extra ? ' · rest of the passive not counted' : '');
    return w.extra ? 'conditional passive — not counted' : 'no flat stat passive';
  };
  // Each stat Mindscape node scales linearly from level 0 to lufel's published (level-5,
  // max) value — see the DEFAULT_LOADOUT comment. Report both the max and what the
  // currently-selected level actually grants, since they usually differ.
  const mind = (cs.mind || []).map((m, i) => {
    const lvl = Math.max(0, Math.min(5, (i === 0 ? L.mind1 : L.mind2) || 0));
    const eff = m.v * lvl / 5;
    const skip = m.tag === '×' || m.tag === 'x' ? ' (lufel says skip)' : '';
    return `${m.s} +${m.v}${m.pct ? '%' : ''} at Lv5, +${eff.toFixed(1)}${m.pct ? '%' : ''} at Lv${lvl}${skip}`;
  }).join('; ');
  const awNodes = cs.awareness || [];
  // Ability names unlocked at the selected level, each with its full effect text as a
  // hover tooltip — same "hover for the rest" pattern the weapon/Mindscape lines use.
  // `s` is only ever set on a node that parsed as an unconditional stat (see
  // charBaseStat); across the whole roster today none do, so the names themselves are
  // purely a kit reference. The level itself still moves the total below, though — see
  // the universal-curve note in the info paragraph.
  const awUnlocked = awNodes.slice(0, L.awareness + 1)
    .map(n => `<span title="${esc(n.d)}">${esc(n.n)}${n.s ? ` (+${n.v}${n.pct ? '%' : ''} ${n.s})` : ''}</span>`).join(', ');
  const awPct = AWARENESS_STAT_PCT[Math.max(0, Math.min(6, L.awareness))];
  const fields = `
    <div class="row">
      <div class="field"><label>Weapon</label><select id="lWeapon">
        ${opt('', L.weapon, 'none')}${cs.w4 ? opt('4', L.weapon, wName('w4')) : ''}${cs.w5 ? opt('5', L.weapon, wName('w5')) : ''}</select></div>
      <div class="field"><label>Refinement</label><select id="lRefine">
        ${[1,2,3,4,5,6,7].map(a => opt(a, L.refine, refineLabel(a))).join('')}</select></div>
      <div class="field"><label>Mindscape (skill paths)</label><select id="lMindSkill">
        ${opt('no', L.mindSkill ? 'yes' : 'no', 'locked')}${opt('yes', L.mindSkill ? 'yes' : 'no', 'unlocked')}</select></div>
      ${cs.mind && cs.mind[0] ? `<div class="field"><label title="${esc(cs.mind[0].s)}">Mindscape: ${esc(cs.mind[0].s)}</label><select id="lMind1">
        ${[0,1,2,3,4,5].map(a => opt(a, L.mind1, 'Lv ' + a)).join('')}</select></div>` : ''}
      ${cs.mind && cs.mind[1] ? `<div class="field"><label title="${esc(cs.mind[1].s)}">Mindscape: ${esc(cs.mind[1].s)}</label><select id="lMind2">
        ${[0,1,2,3,4,5].map(a => opt(a, L.mind2, 'Lv ' + a)).join('')}</select></div>` : ''}
      ${awNodes.length ? `<div class="field"><label>Awareness</label><select id="lAwareness">
        ${[0,1,2,3,4,5,6].map(a => opt(a, L.awareness, 'Lv ' + a)).join('')}</select></div>` : ''}
    </div>
    ${explainHtml(`<b>Level 80, Ascension 7</b> assumed for every character.${L.weapon ? ` Weapon: <b>${esc(bonusText(L.weapon === '4' ? 'w4' : 'w5'))}</b>.` : ''}${awNodes.length ? ` Awareness adds <b>+${awPct || 0}% HP/ATK/DEF</b>.` : ''}`,
      `<p>Level 80 at Ascension 7 is the only level-80 configuration the game allows.
      ${mind ? `Mindscape: ${esc(mind)}. ` : ''}
      Mindscape has 4 paths — the two above grant these stats (scaling linearly to their
      max at Lv5); the other two raise a skill's level cap instead, tracked by the
      "skill paths" toggle.
      Only unconditional passives count — a buff that needs a trigger is not a stat you always have.
      My Palace is not modelled at all, so totals are a floor.</p>
      ${awUnlocked ? `<p>Awareness unlocked at this level: ${awUnlocked}
        (hover a name for its full effect — almost all of these are conditional kit passives on top of that flat percentage, not additional stats).</p>` : ''}`)}`;
  return { L, fields };
}

/* The Setup in one line — the Loadout popup's section summary and the Targets dialog's link. */
function setupSummary(c, L) {
  const cs = CHAR_STATS[c.n] || {};
  const w = L.weapon === '4' ? cs.w4 : L.weapon === '5' ? cs.w5 : null;
  const mindStats = (cs.mind || []).length ? `, stat paths Lv${L.mind1 || 0}/${L.mind2 || 0}` : '';
  return [w ? `${L.weapon}★ ${w.n} ${refineLabel(L.refine)}` : 'no weapon',
    `Mindscape ${L.mindSkill ? 'unlocked' : 'locked'}${mindStats}`,
    `Awareness ${L.awareness || 0}`].join(' · ');
}

/* Ties each `.field`'s label to its control. The markup here puts a <label> beside its
   <select> or <input> rather than around it or with `for`, so 58 of the page's 63 controls had
   no accessible name and a click on a label focused nothing. Run over the page once and over
   every dialog as it opens. */
let labelSeq = 0;
function linkLabels(root) {
  $$('.field', root || document).forEach(f => {
    const label = $('label', f), ctl = $('input, select, textarea', f);
    if (!label || !ctl || label.htmlFor) return;
    if (!ctl.id) ctl.id = 'fld' + (++labelSeq);
    label.htmlFor = ctl.id;
  });
}

/* Opens `#dlg` if it is not already open — every screen in this file that redraws
   itself in place (openLoadout, openCardPicker) calls this rather than showModal()
   directly, since showModal() throws InvalidStateError on a dialog that is already
   open, and this whole popup family works by re-rendering #dlgBody while staying
   open across a run of onchange handlers. It also ties the new content's labels to their
   controls (linkLabels). */
function showDlg() {
  linkLabels($('#dlgBody'));
  if (!$('#dlg').open) $('#dlg').showModal();
  /* A message already on screen would sit under the dialog's backdrop, so the dialog takes it
     in. A pending undo stays out: pressed from inside a dialog it was not offered from, it would
     close that dialog (see undo) and lose whatever was being edited there. */
  if (!$('#toast').classList.contains('hide') && !undoSnap) placeToast();
}
/* Which screen the dialog is showing and for whom, so an undo can redraw the Loadout popup it
   was offered from, and a redraw of that popup knows it is the same one (see openLoadout). */
function setDlgView(view, name) { const b = $('#dlgBody'); b.dataset.view = view; b.dataset.name = name || ''; }

/* Roster "Loadout" popup: which card fills each of the five slots, then the Setup, then the
   numbers behind the build score, for any character regardless of whether they carry a
   published stat target. The cards come first because they are what the popup is opened for;
   until Sep 2026 they started 849 px down a dialog that shows about 790, under the Setup
   fields and every stats table. The Setup section opens by itself while the character is still
   on the defaults, since that is the one thing to fix first.

   Card choices are immediate (swapCard/unequipCard already handle the unequip-the-other-end
   bookkeeping); the dialog redraws itself after each change, keeping whichever sections the
   reader had open. Picking a different card for a slot goes through openCardPicker rather than
   a plain <select> — a 4000-card inventory can hold hundreds of cards in one slot, spread
   across sets the character can't even use, and a flat dropdown had no way to search or
   filter that down. */
/* The Loadout popup's sections as the reader last left them, per character — read off the DOM
   whenever the popup is about to be replaced (its own redraw, the card picker, the card editor,
   closing), so an Equip in the picker, or an Edit and Save, comes back with Stats still open.
   Keyed on the popup's own view: until this, only a redraw of the popup itself kept them. */
let loSections = null;   // { name, open: Set of section keys }
function rememberLoSections() {
  const b = $('#dlgBody');
  if (b.dataset.view !== 'loadout' || !$('details.sect[data-k]', b)) return;
  loSections = { name: b.dataset.name, open: new Set($$('details.sect[data-k]', b).filter(d => d.open).map(d => d.dataset.k)) };
}
/* `openKeys` names sections to open whatever was remembered: the Targets dialog's and
   Optimise's Setup links send ['setup'], since that is what they were clicked for. */
function openLoadout(name, openKeys) {
  const c = charDef(name);
  const body = $('#dlgBody');
  rememberLoSections();
  const kept = loSections && loSections.name === name ? loSections.open : null;
  const open = (k, dflt) => ((openKeys && openKeys.includes(k)) || (kept ? kept.has(k) : dflt) ? ' open' : '');
  const worn = state.cards.filter(cd => cd.equipped === name);
  const { L, fields } = loadoutFieldsHtml(c);
  const t = target(c);
  const idealLo = idealLoadout(c, t, 55);
  const bs = buildScore(c, worn, 55, L, idealLo, t);
  const isDefault = setupIsDefault(name);

  const slotBlock = sl => {
    const cur = worn.find(cd => cd.slot === sl);
    const btns = `<div class="row" style="gap:6px">
        <button class="ghost tiny" data-pick-slot="${esc(sl)}">${cur ? 'Swap' : 'Equip a card'}</button>
        ${cur ? `<button class="ghost tiny" data-edit-slot="${esc(sl)}">Edit</button>
        <button class="ghost tiny" data-unequip-slot="${esc(sl)}">Unequip</button>` : ''}</div>`;
    if (!cur) return `<div class="lo empty"><h4><span class="slot ${sl}">${sl.slice(0, 3)}</span> ${sl}</h4>
      <div class="tiny muted">Nothing equipped.</div><div style="margin-top:8px">${btns}</div></div>`;
    /* The card's own score, the build score's card part for it (see cardScore), as on every
       other screen — so it reads one number here, in the card picker this opens, on Optimise
       and on Weakest slots. */
    return cardBlockHtml(cur, t, { score: cardScore(cur, t),
      tags: cur.locked ? ` <span class="tag hit" title="Locked to ${esc(name)} — excluded from every recommendation for anyone else">locked</span>` : '',
      foot: btns });
  };

  const wornLocked = worn.length > 0 && worn.every(cd => cd.locked);
  const statsHtml = statsSummaryHtml(c, worn, L, false, idealLo.cards) + targetHtml(bs) + spreadHtml(bs);

  setDlgView('loadout', name);
  body.innerHTML = `
    <h2 style="margin-bottom:4px">${esc(c.n)}${c.a ? ' · ' + esc(c.a) : ''}</h2>
    <p class="tiny muted" style="margin:0 0 14px">${esc(c.e)} · ${esc(ARCHETYPES[c.arch].label)} ·
      ${buildScoreTag(c, { [c.n]: worn })}</p>
    <div class="row" style="margin:0 0 10px;align-items:center">
      <h3 style="margin:0;font-size:13px">Cards</h3>
      <button class="ghost sm ${wornLocked ? 'gold' : ''}" id="loLock" ${worn.length ? '' : 'disabled'}
        title="${wornLocked
          ? `Stop reserving ${esc(name)}'s equipped cards — they become eligible for other characters' recommendations again.`
          : `Reserve ${esc(name)}'s equipped cards so they never show up as a suggestion for anyone else, in the Optimiser, Upgrades or Triage.`}">
        ${wornLocked ? 'Unlock these cards' : 'Lock these cards to ' + esc(c.n)}</button>
      <span style="flex:1"></span>
      <button class="ghost sm" id="loOpenOpt">Open in Optimiser for full recommendations →</button>
    </div>
    <div class="loadout">${SLOTS.map(slotBlock).join('')}</div>
    <details class="sect" data-k="setup"${open('setup', isDefault)}>
      <summary>Setup <span class="tiny muted">${esc(setupSummary(c, L))}${isDefault ? ' — the defaults, never saved' : ''}</span></summary>
      <div class="inner">
        ${isDefault ? `<p class="tiny muted" style="margin:0 0 8px">These are the defaults, and ${esc(c.n)} is scored on them until you change one — check the weapon first.</p>` : ''}
        ${fields}
      </div>
    </details>
    ${statsHtml ? `<details class="sect" data-k="stats"${open('stats', false)}>
      <summary>Stats, stat targets and damage factors <span class="tiny muted">— what the build score is made of</span></summary>
      <div class="inner">${statsHtml}</div>
    </details>` : ''}`;
  showDlg();

  const applyLoadout = () => {
    // Level and Ascension are forced in charLoadout, not read from the DOM — there is no
    // longer a control for either.
    state.chars[name].loadout = {
      level: 80, asc: 7, weapon: $('#lWeapon').value,
      refine: +$('#lRefine').value, mindSkill: $('#lMindSkill').value === 'yes',
      mind1: $('#lMind1') ? +$('#lMind1').value : 0, mind2: $('#lMind2') ? +$('#lMind2').value : 0,
      awareness: $('#lAwareness') ? +$('#lAwareness').value : 0
    };
    commit(); openLoadout(name);
  };
  ['#lWeapon', '#lRefine', '#lMindSkill', '#lMind1', '#lMind2', '#lAwareness']
    .forEach(sel => { if ($(sel)) $(sel).onchange = applyLoadout; });
  const lockBtn = $('#loLock');
  if (lockBtn) lockBtn.onclick = () => { toggleLoadoutLock(name); openLoadout(name); };
  $$('#dlgBody [data-pick-slot]').forEach(b => b.onclick = () => openCardPicker(name, b.dataset.pickSlot));
  $$('#dlgBody [data-edit-slot]').forEach(b => b.onclick = () => {
    const cur = worn.find(cd => cd.slot === b.dataset.editSlot);
    if (cur) editCard(cur.id, () => openLoadout(name));
  });
  $$('#dlgBody [data-unequip-slot]').forEach(b => b.onclick = () => {
    const cur = worn.find(cd => cd.slot === b.dataset.unequipSlot);
    if (cur) unequipCard(cur.id);
    openLoadout(name);
  });
  $('#loOpenOpt').onclick = () => { $('#dlg').close(); openCharacterDetail(name); };
}

/* Full-inventory card picker for one character's one slot, opened from the Loadout
   popup's "Swap" / "Equip a card" buttons. Replaces a flat <select> that had no way to
   search a 4000-card inventory or see anything past set/rarity/main/score. One compact row
   per candidate — every substat, coloured by what it is worth to this character — so a
   screen holds a dozen to compare, where the old card blocks showed two of forty; sortable
   by score, headroom, level or set. The set filter defaults to whatever is already equipped
   in that slot (or the character's preferred set, if the slot is empty) since the user plays
   almost exclusively in-set and starting from "every set" buries that one under the rest. */
function openCardPicker(charName, slot) {
  rememberLoSections();   // the popup's open sections, for the way back
  const c = charDef(charName);
  const t = target(c);
  const cur = state.cards.find(cd => cd.equipped === charName && cd.slot === slot);
  const setTable = slot === 'Space' ? SPACE_SETS : SETS;
  const preferredSet = slot === 'Space' ? t.space : (t.sets || [])[0];
  const f = { set: (cur ? cur.set : preferredSet) || '', main: '', rarity: '', q: '' };
  // null key: best build gain first. The equipped card is pinned to the top whatever the order.
  const sort = { key: null, dir: -1 };

  const lo = charLoadout(charName);
  const otherCards = state.cards.filter(cd => cd.equipped === charName && cd.slot !== slot);
  /* What equipping each card would do to the build score, the other four slots as they are —
     the number the pick should be made on. The Score column is the card on its own, and the
     two can disagree: the build score also sees the stat targets and whether ATK, damage bonus
     and crit stay in balance across the five cards (Kotone Shiomi's Star, 28 Sep 2026: the worn
     ATK% card scored 72 to a Crit Rate card's 67, and the Crit Rate card built 0.1 higher).
     Sorted on the Score, the picker put a worse build first. Memoised per card for the life of
     the picker: it depends on nothing a filter or a sort changes. */
  const idl = idealLoadout(c, t, 55);
  const worn = state.cards.filter(cd => cd.equipped === charName);
  const base = buildScoreOf(c, worn, 55, lo, idl, t);
  const baseRaw = base ? base.raw : 0;
  const gains = new Map();
  const gainOf = cd => {
    if (cd === cur) return 0;
    if (!gains.has(cd.id)) { const b = buildScoreOf(c, otherCards.concat([cd]), 55, lo, idl, t); gains.set(cd.id, (b ? b.raw : 0) - baseRaw); }
    return gains.get(cd.id);
  };
  /* A card worn by someone else says what taking it costs them (giverLoss, as on Optimise and
     Upgrades), so a "+2.0" that is really a trade does not read as free. Memoised: it is a few
     build-score evaluations for the giver, and the table redraws on every keystroke. */
  const used = new Set(otherCards.map(x => x.id));
  const tags = new Map();
  const onTag = cd => {
    if (!tags.has(cd.id)) tags.set(cd.id, onTagHtml(cd, charName, new Set([...used, cd.id]), 1));
    return tags.get(cd.id);
  };
  const SORTS = { gain: o => o.g, score: o => o.s, left: o => cardHeadroom(o.s, slot, t), level: o => o.cd.level, set: o => o.cd.set };
  const FIRST_DIR = { gain: -1, score: -1, left: 1, level: -1, set: 1 };

  const rowHtml = (card, score, gain) => {
    const isCur = card === cur;
    const by = card.equipped && card.equipped !== charName ? card.equipped : null;
    return `<tr class="${isCur ? 'cur' : ''}">
      <td>${esc(card.set)} <span class="tag r${card.rarity}">${card.rarity}★</span></td>
      <td class="right tiny muted">${card.level}</td>
      <td class="tiny">${esc(card.main)}</td>
      <td class="tiny">${subsInlineHtml(card, t)}</td>
      <td class="right score" title="Out of 100 for a perfect ${esc(slot)} card for ${esc(c.n)}: the card on its own">${cardPct(score, slot, t)}</td>
      <td class="right tiny muted">${cardHeadroom(score, slot, t).toFixed(1)}</td>
      <td class="right tiny pickGain" title="Build score change if this card is equipped here, the other four slots as they are">${isCur ? '<span class="muted">—</span>'
        : `<span class="${gain >= UPGRADE_MIN_GAIN ? 'gainpos' : 'muted'}">${esc(gainStr(gain))}</span>`}</td>
      <td class="tiny">${isCur ? '<span class="tag hit">equipped here</span>'
        : by ? onTag(card) : ''}</td>
      <td class="right">${isCur ? '' : `<button class="ghost tiny" data-equip-card="${esc(card.id)}">${by ? 'Take it' : 'Equip'}</button>`}</td>
    </tr>`;
  };

  const render = () => {
    const q = f.q.trim().toLowerCase();
    const rows = state.cards.filter(cd => cd.slot === slot && (!cd.locked || cd.equipped === charName)).filter(cd => {
      if (f.set && cd.set !== f.set) return false;
      if (f.main && cd.main !== f.main) return false;
      if (f.rarity && cd.rarity !== +f.rarity) return false;
      if (q) {
        const hay = [cd.set, cd.main, cd.equipped || '', ...(cd.subs || []).map(s => s.stat)].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).map(cd => ({ cd, s: cardScore(cd, t), g: gainOf(cd) }));
    const key = sort.key || 'gain', get = SORTS[key], dir = sort.key ? sort.dir : -1;
    rows.sort((a, b) => {
      const pin = (b.cd === cur) - (a.cd === cur);
      if (pin) return pin;
      const av = get(a), bv = get(b);
      const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return cmp * dir || b.g - a.g || b.s - a.s;
    });
    const CAP = 150;

    // Filtering re-renders #dlgBody wholesale — including the search box the user may
    // still be typing into — so its focus and caret would otherwise reset to the start
    // on every keystroke. Snapshot before replacing, restore after.
    const active = document.activeElement;
    const focusId = active && active.id;
    const selStart = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;

    setDlgView('picker', charName);
    $('#dlgBody').innerHTML = `
      <h2 style="margin-bottom:4px">Equip ${esc(slot)} on ${esc(c.n)}</h2>
      <p class="tiny muted" style="margin:0 0 14px">
        ${rows.length} matching card${rows.length === 1 ? '' : 's'}${cur ? ` — currently ${esc(cur.set)} ${cur.rarity}★` : ' — nothing equipped yet'}.
        Substats in green are ones ${esc(c.n)} wants most, faded ones barely count.
        <b>Build</b> is what equipping the card does to ${esc(c.n)}'s build score with the other four slots as they are,
        and the list is in that order; <b>Score</b> is the card on its own, so a lower Score can build higher.</p>
      <div class="row">
        <div class="field"><label>Set</label><select id="cpSet"><option value="">Any</option>${setOptionList(setTable, f.set)}</select></div>
        <div class="field"><label>Main stat</label><select id="cpMain"><option value="">Any</option>
          ${SLOT_INFO[slot].mains.map(m => `<option ${m === f.main ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></div>
        <div class="field"><label>Rarity</label><select id="cpRar"><option value="">Any</option>
          ${[5, 4, 3, 2].map(r => `<option value="${r}" ${String(r) === f.rarity ? 'selected' : ''}>${r}★</option>`).join('')}</select></div>
        <div class="field" style="flex:1;min-width:180px"><label>Search</label>
          <input id="cpQ" placeholder="set, main, substat…" value="${esc(f.q)}"></div>
      </div>
      <div class="scroll" style="max-height:58vh;margin-top:12px">
        ${rows.length ? `<table class="pick"><thead><tr>
            ${sortThHtml('set', 'Set', sort)}${sortThHtml('level', 'Lv', sort, '', '', 'right')}<th>Main</th><th>Substats</th>
            ${sortThHtml('score', 'Score', sort, 'Out of 100 for a perfect card in this slot', '', 'right')}
            ${sortThHtml('left', 'Left', sort, 'Headroom: raw points a perfect card for this slot would add over this one', '', 'right')}
            ${sortThHtml('gain', 'Build', sort, 'Build score change if this card is equipped here, the other four slots as they are. The default order.', '', 'right')}
            <th></th><th></th></tr></thead>
          <tbody>${rows.slice(0, CAP).map(o => rowHtml(o.cd, o.s, o.g)).join('')}</tbody></table>`
          : '<p class="tiny muted" style="padding:10px">No cards match these filters.</p>'}
        ${rows.length > CAP ? `<p class="tiny muted" style="padding:0 10px">Showing the first ${CAP} — narrow the filters to see the rest.</p>` : ''}
      </div>
      <div class="row" style="margin-top:14px">
        <button class="ghost sm" id="cpBack">← Back to loadout</button>
      </div>`;
    showDlg();

    $('#cpSet').onchange = () => { f.set = $('#cpSet').value; render(); };
    $('#cpMain').onchange = () => { f.main = $('#cpMain').value; render(); };
    $('#cpRar').onchange = () => { f.rarity = $('#cpRar').value; render(); };
    $('#cpQ').oninput = () => { f.q = $('#cpQ').value; render(); };
    $('#cpBack').onclick = () => openLoadout(charName);
    $$('#dlgBody .pick .sortH').forEach(th => th.onclick = () => {
      const k = th.dataset.sort;
      sort.dir = sort.key === k ? -sort.dir : FIRST_DIR[k];
      sort.key = k;
      render();
      refocus(`#dlgBody .pick th.sortH[data-sort="${k}"] .thBtn`);
    });
    $$('#dlgBody [data-equip-card]').forEach(b => b.onclick = () => {
      swapCard(charName, slot, b.dataset.equipCard);
      openLoadout(charName);
    });

    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus();
        if (selStart != null && typeof el.setSelectionRange === 'function') el.setSelectionRange(selStart, selStart);
      }
    }
  };
  render();
}

function editTargets(name) {
  const c = charDef(name), t = JSON.parse(JSON.stringify(target(c)));
  /* The data's own values: shown beside anything this character overrides, and what the
     save below diffs against — only the fields that end up different are stored (see
     target()), so everything else keeps following the data and its later fixes. */
  const d = defaultTarget(c);
  const hint = (differs, data) => differs
    ? `<div class="tiny" style="color:var(--gold)" title="Your own choice — everything you have not changed follows the data">data: ${esc(data || '—')}</div>` : '';
  const setOpts = sel => setOptionList(SETS, sel);
  const body = `
    <h2 style="margin-bottom:4px">${esc(c.n)}${c.a ? ' · ' + esc(c.a) : ''}</h2>
    <p class="tiny muted" style="margin:0 0 14px">${esc(c.e)} · ${esc(ARCHETYPES[c.arch].label)}</p>
    ${t.note ? `<div class="notice info tiny">${esc(t.note)}</div>` : ''}
    ${t.bp ? `<div class="notice info tiny"><b>Breakpoints.</b> ${esc(t.bp)}</div>` : ''}
    ${CHAR_STATS[c.n] ? `<p class="tiny muted" style="margin:0 0 12px">Setup: ${esc(setupSummary(c, charLoadout(c.n)))}${setupIsDefault(c.n) ? ' (the defaults)' : ''} —
      <button class="linky" id="tOpenSetup">change it in the Loadout popup</button>, where the stat targets it feeds update as you go.
      Unsaved edits here are left behind.</p>` : ''}
    <div class="row">
      <div class="field"><label>Preferred 4-piece</label><select id="tSet0"><option value="">—</option>${setOpts(t.sets[0])}</select>
        ${hint(JSON.stringify(t.sets) !== JSON.stringify(d.sets), d.sets.join(' / '))}</div>
      <div class="field"><label>Alternative 4-piece</label><select id="tSet1"><option value="">—</option>${setOpts(t.sets[1])}</select></div>
      <div class="field"><label>Space card</label><select id="tSpace"><option value="">—</option>
        ${setOptionList(SPACE_SETS, t.space)}</select>${hint((t.space || '') !== (d.space || ''), d.space)}</div>
    </div>
    <h3 style="margin:16px 0 8px;font-size:13px">Main stats
      <span class="muted tiny">best first — leave the lower boxes blank if there is only one answer, and "any" leaves the slot open</span></h3>
    <div class="row">
      ${['Moon','Star','Sky'].map(sl => {
        const cur = mainList(t, sl), dat = mainList(d, sl);
        return `<div class="field"><label>${sl}</label>
          ${Array.from({ length: MAIN_CHOICES }, (_, i) => `<select id="tM${sl}${i}">
            <option value="" ${cur[i] ? '' : 'selected'}>${i ? '— or —' : 'any'}</option>
            ${SLOT_INFO[sl].mains.map(m =>
              `<option ${m === cur[i] ? 'selected' : ''}>${m}</option>`).join('')}</select>`).join('')}
          ${hint(JSON.stringify(cur) !== JSON.stringify(dat), dat.join(' / ') || 'any')}
        </div>`;
      }).join('')}
      <span class="tiny muted" style="padding-bottom:8px;max-width:220px">Sun and Space have fixed main stats.
        Every stat listed counts as on target, and which one a card carries shifts what its
        substats are worth.</span>
    </div>
    <h3 style="margin:16px 0 8px;font-size:13px">Substat weights <span class="muted tiny">0 = ignore, 10 = top priority</span></h3>
    <div class="wgrid">${Object.keys(SUBSTATS).map(s => {
      const mine = t.w[s] != null ? t.w[s] : 0, dat = d.w[s] != null ? d.w[s] : 0;
      return `<div class="wrow"><span>${s}${mine !== dat
        ? ` <span class="tiny" style="color:var(--gold)" title="Your own weight — the data has ${dat}">(data ${dat})</span>` : ''}</span><input type="number" min="0" max="10" step="1"
        data-w="${s}" value="${mine}"></div>`;
    }).join('')}</div>
    <p class="tiny muted" style="margin:12px 0 0">Only what you change here is saved. Everything else keeps
      following the data, so corrections to it still reach this character; a field you have changed shows
      the data's value in <span style="color:var(--gold)">gold</span>, and setting it back to that value
      hands it back to the data.</p>
    <div class="row" style="margin-top:16px">
      <button class="primary" id="tSave">Save targets</button>
      <button id="tReset">Reset to default</button>
    </div>`;
  setDlgView('targets', name);
  $('#dlgBody').innerHTML = body;
  showDlg();
  if ($('#tOpenSetup')) $('#tOpenSetup').onclick = () => openLoadout(name, ['setup']);
  $('#tSave').onclick = () => {
    const w = {}; $$('[data-w]').forEach(i => w[i.dataset.w] = +i.value || 0);
    state.chars[name].targets = targetEdits(d, {
      sets: [$('#tSet0').value, $('#tSet1').value].filter(Boolean),
      space: $('#tSpace').value,
      // best-first, blanks dropped, and a stat named twice counted once
      main: ['Moon', 'Star', 'Sky'].reduce((m, sl) => {
        const picked = [];
        for (let i = 0; i < MAIN_CHOICES; i++) {
          const v = $(`#tM${sl}${i}`).value;
          if (v && !picked.includes(v)) picked.push(v);
        }
        m[sl] = picked;
        return m;
      }, {}),
      w
    });
    $('#dlg').close(); commit();
  };
  /* Reset throws away every edit at once, so it can be taken back. It used to redraw only the
     Roster, leaving Optimise and Upgrades on the old target until something else re-ran them. */
  $('#tReset').onclick = () => {
    const snap = snapshotState();
    state.chars[name].targets = null;
    $('#dlg').close(); commit();
    offerUndo(`Reset ${name}'s targets to the data.`, snap);
  };
}

/* ------------------------ changes, saving and undo ------------------------
   Every change to what the tool holds — the cards, who wears them, who is owned or benched,
   targets, setups, the team crit rate — goes through commit(). Before it existed each action
   redrew its own pick of views and forgot others: deleting a card on the Inventory tab redrew
   only the Inventory, so the Roster and Optimise went on showing it; resetting a target never
   re-ran Optimise; "Mark these as equipped" left the Roster's build chip stale; and nothing but
   a team crit change ever told a Triage or Vault result it was out of date. */

/* A fingerprint of everything a score reads, so "has this changed" is a comparison of two
   strings rather than a counter: an undo, or a value set back, reads as unchanged again — for
   the save indicator and for a Triage run's staleness alike. A few ms over 4000 cards. */
function hashStr(h, s) {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h;
}
/* The cards; `withWearers` adds who wears each and its lock, which the Vault never reads. */
function cardsSig(withWearers) {
  let h = 2166136261;
  state.cards.forEach(c => {
    h = hashStr(h, `${c.id}|${c.slot}|${c.set}|${c.rarity}|${c.level}|${c.main}|${c.mainValue == null ? '' : c.mainValue}|` +
      (withWearers ? `${c.equipped || ''}|${c.locked ? 1 : 0}|` : ''));
    (c.subs || []).forEach(s => { h = hashStr(h, s.stat + ':' + s.value + ','); });
  });
  return (h >>> 0).toString(36) + '.' + state.cards.length;
}
/* Who is owned and benched, plus the saved targets and setups of `detail`: 'all' for everyone,
   a Set of names for just those, anything else for none. */
function charsSig(detail) {
  let h = 2166136261;
  CHARACTERS.forEach(c => {
    const cs = state.chars[c.n] || {};
    h = hashStr(h, `${c.n}|${cs.owned ? 1 : 0}${cs.benched ? 1 : 0}|`);
    if (detail === 'all' || (detail instanceof Set && detail.has(c.n)))
      h = hashStr(h, JSON.stringify(cs.targets || null) + JSON.stringify(cs.loadout || null));
  });
  return (h >>> 0).toString(36);
}
function dataSignature() { return cardsSig(true) + ':' + charsSig('all') + ':' + teamCritRate() + ':' + denSig(); }

/* The save file is the only persistence (no browser storage — see CLAUDE.md), so the header
   says when there is something it does not have yet, and the page asks before it is closed on
   unsaved work. `savedSig` is the fingerprint at the last load or save; a download cannot be
   confirmed, so "saved" means a save was started. */
let savedSig = '';
function isDirty() { return dataSignature() !== savedSig; }
function markSaved() { savedSig = dataSignature(); updateSaveState(); }
function updateSaveState() {
  const box = $('#saveState');
  if (!box) return;
  const dirty = isDirty(), has = state.cards.length > 0;
  box.classList.toggle('dirty', dirty);
  box.innerHTML = dirty ? '<span class="dot"></span>Unsaved changes' : '';
  box.title = dirty ? 'Changed since you last loaded or saved a file. This tool keeps nothing between sessions on its own.' : '';
  $('#hdrSave').classList.toggle('primary', dirty);
  $('#hdrLoad').classList.toggle('primary', !has && !dirty);
}
window.addEventListener('beforeunload', e => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

/* A table that scrolls with the page (.flowTable) pins its header under the sticky page header,
   whose height changes as it wraps; --hdrH carries that height to the CSS. */
(function trackHeaderHeight() {
  const h = document.querySelector('header');
  if (!h) return;
  const set = () => document.documentElement.style.setProperty('--hdrH',
    getComputedStyle(h).position === 'sticky' ? h.offsetHeight + 'px' : '0px');
  set();
  if (window.ResizeObserver) new ResizeObserver(set).observe(h);
  window.addEventListener('resize', set);
})();

/* Optimise's plan search takes about a tenth of a second; like the Upgrades pass
   (runUpgradeViews) it is only paid while its tab is on screen, and showTab runs it on the way
   in, so it is never shown stale. */
let optStale = false;
function runOptIfShown() {
  if ($('#tab-opt').classList.contains('hide')) { optStale = true; return; }
  optStale = false;
  runOpt();
}
/* The one character the Optimise tab was explicitly sent to (a roster click-through), who stays
   selected through a redraw even when not owned. Anything else is the ordinary picker, which
   follows the owned list — forcing whatever happened to be selected kept an unowned default
   selected over the first character marked owned, and a benched one labelled "not owned". */
let optForced = null;

function commit() {
  /* An undo restores a whole snapshot, so it is only offered until the next change: taken after
     one, it would silently revert that change too. Each undoable action commits and then offers
     its own. */
  if (undoSnap) hideToast();
  renderInv(); renderRoster(); renderOpt(optForced || undefined); runOptIfShown(); runUpgradeViews();
  markStaleRuns(); updateSaveState();
}

/* One level of undo for the actions that are easy to regret — deleting a card, un-owning or
   benching, resetting a target, taking a card off someone, equipping a whole loadout, applying
   an import, clearing everything — offered in a toast for 15 seconds, or by Ctrl+Z outside a
   text field. In memory only. A snapshot is the card list and character state as JSON, some
   tens of ms on a 4000-card inventory, paid only by the actions that offer it. Restoring keeps
   the card objects that survived, so anything still holding one points at the live card. */
let undoSnap = null, toastTimer = 0;
function snapshotState() {
  return { cards: JSON.stringify(state.cards), chars: JSON.stringify(state.chars), nextId: state.nextId, teamCrit: state.teamCrit, den: JSON.stringify(state.den || {}) };
}
function showToast(text, button) {
  $('#toastMsg').textContent = text;
  const b = $('#toastUndo');
  b.classList.toggle('hide', !button);
  if (button) { b.textContent = button.label; b.onclick = button.run; }
  placeToast();
  $('#toast').classList.remove('hide');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 15000);
}
function offerUndo(label, snap) { undoSnap = snap; showToast(label, { label: 'Undo', run: undo }); }
/* The same toast without an undo: what a load did, said wherever the load was started from. */
function notify(text, button) { undoSnap = null; showToast(text, button); }
/* A yes/no question in the toast instead of confirm(). A sandboxed artifact frame without
   `allow-modals` answers confirm() with an instant false, which would make Load and "Clear
   everything" silently do nothing whenever there is unsaved work; and the toast's button is a
   real click, so it may open the file picker itself. Ignoring the question is "no". */
function askToast(text, label, run) { notify(text, { label, run: () => { hideToast(); run(); } }); }
function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').classList.add('hide');
  undoSnap = null;
}
/* A modal dialog sits in the browser's top layer, above anything a z-index can reach, so while
   one is open the toast lives inside it (and goes back to the page when it closes). */
function placeToast() {
  const t = $('#toast'), d = $('#dlg');
  const host = d.open ? d : document.body;
  if (t.parentNode !== host) host.appendChild(t);
}
function undo() {
  const s = undoSnap;
  if (!s) return;
  hideToast();
  const live = new Map(state.cards.map(c => [c.id, c]));
  state.cards = JSON.parse(s.cards).map(sc => {
    const cur = live.get(sc.id);
    if (!cur) return sc;
    Object.keys(cur).forEach(k => { if (!(k in sc)) delete cur[k]; });
    return Object.assign(cur, sc);
  });
  const chars = JSON.parse(s.chars);
  CHARACTERS.forEach(c => { state.chars[c.n] = chars[c.n] || { owned: false, benched: false, targets: null, loadout: null }; });
  state.nextId = s.nextId;
  state.teamCrit = s.teamCrit;
  state.den = JSON.parse(s.den || '{}');
  syncTeamCritField();
  commit();
  /* Redraw the Loadout popup (or its card picker) the undo was offered from; any other dialog
     may now show a card or a target that no longer exists, so it closes. An undo toast is only
     ever inside a dialog it was offered from — showDlg does not adopt one — so this never throws
     away an unrelated dialog, such as a Targets edit in progress. */
  const d = $('#dlg'), b = $('#dlgBody');
  if (d.open) {
    if ((b.dataset.view === 'loadout' || b.dataset.view === 'picker') && charDef(b.dataset.name)) openLoadout(b.dataset.name);
    else d.close();
  }
}
/* The team crit rate lives in the header's settings popover; its chip shows the value in use. */
function syncTeamCritField() {
  $('#rsTeamCrit').value = state.teamCrit;
  // the popover's other setting rides along, and the chip says when any of it is in use
  $$('.denIn').forEach(i => { i.value = denBonus(i.dataset.stat); });
  $('#setTc').textContent = teamCritRate() + '%' + (denSig().split(',').some(v => +v > 0) ? ' · Den' : '');
}

/* ------------------------------ data io ------------------------------ */
// View state that lives in the DOM (filters, sort, hide toggles) rather than in `state`.
// Saved alongside cards/characters so reloading a save restores how the tool was left,
// not just what it holds.
const PREF_SELECTS = ['rsFilter', 'rsElement', 'rsSort', 'flSlot', 'flSet', 'flRar', 'flMain',
  'flSubMode', 'trScope', 'trShow', 'trRar', 'vaRar', 'vaShow', 'upRar',
  'hrShow', 'hrElement', 'hrSlot', 'hrRar', 'ccScope', 'ccKind', 'ccRolls', 'ccPolicy', 'ccElement', 'ikScope', 'ikPick', 'ikPolicy', 'ikElement', 'frKind', 'frPolicy', 'rgScope', 'rgFourth', 'rgShow', 'rgSlot', 'rgWho',
  'trFlSlot', 'trFlSet', 'trFlRar', 'trFlMain', 'trFlSubMode',
  'vaFlSlot', 'vaFlSet', 'vaFlRar', 'vaFlMain', 'vaFlSubMode'];
const PREF_CHECKS = ['rsHideBenched', 'upSameSet', 'upIgnoreEquipped', 'hrTakeEquipped', 'ccFree', 'ikFree', 'frFree'];
const PREF_TEXT = ['rsQ', 'flQ', 'trFlQ', 'vaFlQ', 'hrMin', 'hrQ', 'ccQ', 'ikQ', 'rgQ'];
function collectPrefs() {
  const p = { invSort: { key: invSort.key, dir: invSort.dir },
    trSort: { key: trSort.key, dir: trSort.dir }, vaSort: { key: vaSort.key, dir: vaSort.dir },
    hrSort: { key: hrSort.key, dir: hrSort.dir }, ccSort: { key: ccSort.key, dir: ccSort.dir }, ikSort: { key: ikSort.key, dir: ikSort.dir },
    rgSort: { key: rgSort.key, dir: rgSort.dir } };
  PREF_SELECTS.forEach(id => { p[id] = $('#' + id).value; });
  PREF_CHECKS.forEach(id => { p[id] = $('#' + id).checked; });
  PREF_TEXT.forEach(id => { p[id] = $('#' + id).value; });
  p.flSub = flSubSelected.slice();
  p.trFlSub = trFlSubSelected.slice();
  p.vaFlSub = vaFlSubSelected.slice();
  p.trVerdict = trVerdictSel.slice();
  p.rsView = rosterView;
  p.frChosen = Object.assign({}, frChosen);
  return p;
}
// Every field is applied defensively: a select id absent from an older save, or holding a
// value this build no longer offers (a renamed set, a dropped filter option), just leaves
// that control at its HTML default rather than throwing.
function applyPrefs(p) {
  if (!p) return;
  PREF_SELECTS.forEach(id => {
    if (p[id] === undefined || !$('#' + id)) return;
    $('#' + id).value = p[id];
    if (id === 'flSlot') syncFlSetOptions();
    if (id === 'trFlSlot') syncFilterSetOptions('trFl');
    if (id === 'vaFlSlot') syncFilterSetOptions('vaFl');
  });
  PREF_CHECKS.forEach(id => { if (p[id] !== undefined && $('#' + id)) $('#' + id).checked = !!p[id]; });
  PREF_TEXT.forEach(id => { if (p[id] !== undefined && $('#' + id)) $('#' + id).value = p[id]; });
  // The Roster's "Hide not owned" checkbox was folded into its Show select; a save that ticked
  // it still opens on owned characters only.
  if (p.rsHideUnowned && $('#rsFilter').value === 'all') $('#rsFilter').value = 'owned';
  if (p.rsView === 'cards' || p.rsView === 'list') rosterView = p.rsView;
  frChosen = {};
  if (p.frChosen && typeof p.frChosen === 'object') Object.keys(p.frChosen).forEach(n => { if (charDef(n)) frSetIncluded(n, !!p.frChosen[n]); });
  if (Array.isArray(p.trVerdict)) trVerdictSel = p.trVerdict.filter(k => TR_TIERS.some(x => x.t === k));
  if (Array.isArray(p.flSub) && $('#flSub')) {
    flSubSelected = p.flSub.slice();
    renderFlSub();
  }
  if (Array.isArray(p.trFlSub) && $('#trFlSub')) {
    trFlSubSelected = p.trFlSub.slice();
    renderTrFlSub();
  }
  if (Array.isArray(p.vaFlSub) && $('#vaFlSub')) {
    vaFlSubSelected = p.vaFlSub.slice();
    renderVaFlSub();
  }
  if (p.invSort) { invSort.key = p.invSort.key || null; invSort.dir = p.invSort.dir || 1; }
  if (p.trSort) { trSort.key = p.trSort.key || null; trSort.dir = p.trSort.dir || 1; }
  if (p.vaSort) { vaSort.key = p.vaSort.key || null; vaSort.dir = p.vaSort.dir || 1; }
  if (p.hrSort) { hrSort.key = p.hrSort.key || null; hrSort.dir = p.hrSort.dir || 1; }
  if (p.ccSort) { ccSort.key = p.ccSort.key || null; ccSort.dir = p.ccSort.dir || 1; }
  if (p.ikSort) { ikSort.key = p.ikSort.key || null; ikSort.dir = p.ikSort.dir || 1; }
  if (p.rgSort) { rgSort.key = p.rgSort.key || null; rgSort.dir = p.rgSort.dir || 1; }
}
// What save() writes — split out so the round trip in the tests reads the real shape.
function savePayload() {
  return { version: 1, savedAt: new Date().toISOString(), nextId: state.nextId,
    cards: state.cards, characters: state.chars, settings: { teamCritRate: state.teamCrit, thievesDen: denSaved() }, prefs: collectPrefs() };
}
function save() {
  const payload = savePayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'p5x-planner-save.json';
  a.click(); URL.revokeObjectURL(a.href);
  $('#dataMsg').textContent = 'Saved.';
  markSaved();
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
      // A main value from an older scan than the card's level (see mainValueFitsLevel) is
      // already ignored by the scoring; dropping it here keeps it out of the next save.
      const staleMain = state.cards.filter(c => !mainValueFitsLevel(c));
      staleMain.forEach(c => { delete c.mainValue; });
      state.nextId = d.nextId || state.cards.length + 1;
      CHARACTERS.forEach(c => { state.chars[c.n] = (d.characters && d.characters[c.n]) || { owned: false, benched: false, targets: null }; });
      // Saves from before edits were stored as a diff carry whole snapshots; see target().
      const dropped = migrateSavedTargets();
      const tc = +(d.settings && d.settings.teamCritRate);
      state.teamCrit = tc > 0 ? Math.min(100, tc) : 0;   // absent on files saved before it existed
      state.den = denFrom(d.settings && d.settings.thievesDen);   // likewise
      syncTeamCritField();
      applyPrefs(d.prefs);
      /* A different file is a different session: last run's Triage and Vault results were for
         another inventory, so they go, and the tabs run afresh on the next visit. An undo
         offered before the load would restore that other inventory over this one. */
      hideToast();
      /* A dialog open over the old data (a file can be dropped on one) would act through closures
         holding the old cards — and ids are reassigned by position on load, so its buttons could
         reach whichever new card now has that id. The same goes for a forced Optimise pick. */
      if ($('#dlg').open) $('#dlg').close();
      optForced = null;
      trCache = null; vaCache = null; ccCache = null; ccJob++; ccCheckFilled = false; ikCache = null; ikJob++; ikCheckFilled = false; ikFocus = null; frCache = null; frJob++; rgCache = null; rgJob++;
      ['#trSummary', '#vaSummary', '#ccSummary', '#ccCheckOut', '#ikSummary', '#ikCheckOut', '#frSummary', '#rgSummary'].forEach(id => { $(id).innerHTML = ''; });
      ['#trPanel', '#vaPanel', '#ccPanel', '#ikPanel', '#frPanel', '#rgPanel'].forEach(id => $(id).classList.add('hide'));
      ccFillCheckChars(); ikFillCheckChars();
      commit(); markSaved();
      if (!$('#tab-triage').classList.contains('hide')) autoRunTriage();
      if (!$('#tab-upgrades').classList.contains('hide') && !$('#up-pane-craft').classList.contains('hide')) runCustomCard();
      if (!$('#tab-upgrades').classList.contains('hide') && !$('#up-pane-ink').classList.contains('hide')) runInkCard();
      renderFrChars();
      if (!$('#tab-upgrades').classList.contains('hide') && !$('#up-pane-fortune').classList.contains('hide')) runFortune();
      if (!$('#tab-upgrades').classList.contains('hide') && !$('#up-pane-retro').classList.contains('hide')) runRetrograde();
      $('#dataMsg').innerHTML = `Loaded <b>${state.cards.length}</b> cards.` +
        (bad.length ? ` <span style="color:#e87a5c">${bad.length} skipped</span> — ${esc(bad.slice(0, 3).join('; '))}${bad.length > 3 ? ' …' : ''}` : '') +
        (staleMain.length ? `<br><span class="tiny">${staleMain.length} card${staleMain.length === 1 ? '' : 's'} carried a scanned main
          value from a lower level than ${staleMain.length === 1 ? 'its' : 'their'} own (levelled up after the scan); ${staleMain.length === 1 ? 'it now reads' : 'they now read'}
          the value for the level: ${esc(staleMain.slice(0, 6).map(c => `${c.set} ${c.slot} ${c.main} Lv${c.level}${c.equipped ? ' on ' + c.equipped : ''}`).join('; '))}${staleMain.length > 6 ? ' …' : ''}.</span>` : '') +
        (dropped.length ? `<br><span class="tiny">Saved targets now keep only what you changed, so later data fixes reach
          everything else. ${dropped.length} saved value${dropped.length === 1 ? '' : 's'} that no longer matched the
          data ${dropped.length === 1 ? 'was' : 'were'} handed back to it — re-enter any you meant under Targets:
          ${esc(dropped.map(x => `${x.n} ${x.stat} ${x.saved} → ${x.data}`).join('; '))}.</span>` : '');
      // Said wherever the load was started from, not only on the Data tab.
      if ($('#tab-data').classList.contains('hide'))
        notify(`Loaded ${state.cards.length} cards${bad.length ? `, ${bad.length} skipped` : ''}${dropped.length ? `; ${dropped.length} saved value${dropped.length === 1 ? '' : 's'} handed back to the data` : ''}.`,
          bad.length || dropped.length ? { label: 'Details', run: () => { hideToast(); showTab('data'); } } : null);
    } catch (e) {
      $('#dataMsg').innerHTML = `<span style="color:#e87a5c">Could not read that file: ${esc(e.message)}</span>`;
      if ($('#tab-data').classList.contains('hide')) notify(`Could not read that file: ${e.message}`, null);
    }
  };
  fr.readAsText(file);
}

/* ------------------------------ import merge (rescans) ------------------------------
   Unlike load(), which replaces the whole save file, this merges an incremental scan
   into the current inventory: new cards are added, cards that leveled up since the
   last scan are updated in place, exact resubmissions are skipped, and anything
   ambiguous is left for the review dialog rather than silently applied. */
/* Takes already-parsed JSON — either a bare array of cards or any object with a
   `cards` array (the save-file shape, the pipeline's cards.json) — normalises and
   validates every entry, and opens the merge review. Returns how many cards were
   read, or null if the JSON held no card list at all. Used by the file picker. */
function importCardList(raw) { return importCardDocs([{ name: '', raw }]); }

/* The same, over several documents at once, resolved into ONE merge review.
   A scanning session produces a cards.json per rarity tier and there are forty
   of them sitting in ocr/ — importing those one at a time is not just forty
   trips through the dialog, it is forty *different* merges, because each one
   commits before the next is matched. Cards that should have been compared
   against each other are instead compared against an inventory the previous
   file already changed. Reading them together and merging once removes that.
   A document that would not parse, or that holds no card list, becomes a line
   in the review's skipped list rather than sinking the whole import — one bad
   file out of forty should cost you that file, not the batch. */
function importCardDocs(docs) {
  const valid = [], invalid = [];
  let read = 0, sawList = false;
  docs.forEach(d => {
    const where = docs.length > 1 ? esc(d.name) + ' ' : '';
    if (d.error) { invalid.push(`${esc(d.name)}: ${d.error}`); return; }
    const list = Array.isArray(d.raw) ? d.raw : (d.raw && Array.isArray(d.raw.cards) ? d.raw.cards : null);
    if (!list) { invalid.push(`${esc(d.name)}: no cards array`); return; }
    sawList = true;
    read += list.length;
    list.forEach((rc, i) => {
      const c = normalizeCard(rc);
      const errs = validateCard(c);
      if (errs.length) invalid.push(`${where}card ${i + 1}: ${errs[0]}`); else valid.push(c);
    });
  });
  // Nothing at all resembled a card list, so there is no merge to review — the
  // caller says so in its own words rather than opening an empty dialog.
  if (!sawList) return null;
  renderImportReview(mergeImport(state.cards, valid), invalid);
  return read;
}

/* FileReader is per-file and asynchronous, so a multi-file pick has to be
   collected before any of it can be merged. Results are stored by index rather
   than pushed, because they do not come back in the order they were started
   and the review's "cards-7 card 12" lines should match the order you picked. */
function importScan(files) {
  const picked = Array.from(files.length != null ? files : [files]);
  if (!picked.length) return;
  const docs = new Array(picked.length);
  let remaining = picked.length;

  const settle = (i, doc) => {
    docs[i] = doc;
    if (--remaining) return;
    if (importCardDocs(docs) == null) {
      const where = picked.length > 1 ? 'any of those files' : 'that file';
      $('#dataMsg').innerHTML = `<span style="color:#e87a5c">No <code>cards</code> array in ${where}.</span>`;
      if ($('#tab-data').classList.contains('hide')) notify(`No cards array in ${where}.`, null);
    }
  };

  picked.forEach((file, i) => {
    const fr = new FileReader();
    fr.onload = () => {
      try { settle(i, { name: file.name, raw: JSON.parse(fr.result) }); }
      catch (e) { settle(i, { name: file.name, error: esc(e.message) }); }
    };
    fr.onerror = () => settle(i, { name: file.name, error: 'could not be read' });
    fr.readAsText(file);
  });
}

function renderImportReview(result, invalid) {
  const unmatched = result.unmatched || [];
  const twins = result.unmatchedTwins || [];
  const near = result.unmatchedNear || [];
  const unmatchedWorn = unmatched.filter(c => c.equipped).length;
  const cardLine = c => `${esc(c.slot)}/${esc(c.set)} ${c.rarity}★ Lv${c.level} ${esc(c.main)} — ` +
    (c.subs || []).map(s => esc(s.stat) + ' ' + esc(subVal(s))).join(', ');
  setDlgView('import');
  $('#dlgBody').innerHTML = `
    <h2>Import review</h2>
    <p class="tiny muted">
      <b>${result.toAdd.length}</b> new · <b>${result.toUpdate.length}</b> leveled up ·
      <b>${result.duplicates.length}</b> already in inventory (skipped) ·
      <b>${result.ambiguous.length}</b> need a decision · <b>${invalid.length}</b> invalid (skipped) ·
      <b>${unmatched.length}</b> in inventory but not in this scan${twins.length ? ` ·
      <b>${twins.length}</b> identical twins the scan read once` : ''}${near.length ? ` ·
      <b>${near.length}</b> read differently by this scan` : ''}
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
    ${unmatched.length ? `
      <h3 style="margin:14px 0 8px;font-size:13px">In inventory, not in this scan</h3>
      <p class="tiny muted" style="margin:0 0 8px">${unmatched.length} card${unmatched.length === 1 ? '' : 's'} already in
        the inventory matched nothing in what you imported${unmatchedWorn ? `, <b>${unmatchedWorn}</b> of them currently
        equipped` : ''}. On a partial scan that is expected. If this scan was your <b>complete</b> inventory, these are the
        cards fed away since the last one and can be removed here. Applying can be undone for 15 seconds afterwards,
        and not after that — save first if in doubt.</p>
      <label class="tiny"><input type="checkbox" id="impRemoveUnseen"> Remove these ${unmatched.length} cards — this scan was
        my whole inventory</label>
      <details style="margin-top:6px"><summary class="tiny muted">Show them</summary>
        <div class="tiny" style="max-height:180px;overflow:auto;margin-top:4px">
          ${unmatched.slice(0, 60).map(c => `${cardLine(c)}${c.equipped ? ` <b>(on ${esc(c.equipped)})</b>` : ''}`).join('<br>')}
          ${unmatched.length > 60 ? `<br>… and ${unmatched.length - 60} more` : ''}
        </div></details>` : ''}
    ${twins.length ? `
      <h3 style="margin:14px 0 8px;font-size:13px">Identical twins the scan read once</h3>
      <p class="tiny muted" style="margin:0 0 8px">${twins.length} card${twins.length === 1 ? ' is' : 's are'} an exact copy of a card
        this scan did read. Identical cards sit next to each other in the game's list and the scanner reads two identical
        adjacent cards as one, so these are kept and are <b>not</b> removed by the box above — if you really fed one of a pair,
        take it off by hand on the Inventory tab.</p>
      <details><summary class="tiny muted">Show them</summary>
        <div class="tiny" style="max-height:180px;overflow:auto;margin-top:4px">
          ${twins.slice(0, 60).map(c => `${cardLine(c)}${c.equipped ? ` <b>(on ${esc(c.equipped)})</b>` : ''}`).join('<br>')}
          ${twins.length > 60 ? `<br>… and ${twins.length - 60} more` : ''}
        </div></details>` : ''}
    ${near.length ? `
      <h3 style="margin:14px 0 8px;font-size:13px">Read differently by this scan</h3>
      <p class="tiny muted" style="margin:0 0 8px">For ${near.length === 1 ? 'this card' : 'these ' + near.length + ' cards'} the scan read
        a card at the same level that differs in a single value, and it is being added as new. That is either two real cards
        one roll apart or one card misread on one of the two scans — nothing here can tell which, so <b>both are kept</b> and
        the box above does not remove either. Check the screenshot named in the card's source and delete the wrong one on the
        Inventory tab.</p>
      <table><thead><tr><th>Existing</th><th>Incoming (added as new)</th></tr></thead><tbody>
        ${near.slice(0, 40).map(a => `<tr><td class="tiny">${cardLine(a.existing)}${a.existing.equipped ? ` <b>(on ${esc(a.existing.equipped)})</b>` : ''}</td>
          <td class="tiny">${cardLine(a.incoming)}</td></tr>`).join('')}
      </tbody></table>${near.length > 40 ? `<p class="tiny muted">… and ${near.length - 40} more</p>` : ''}` : ''}
    <div class="row" style="margin-top:16px">
      <button class="primary" id="applyImport">Apply</button>
    </div>`;
  showDlg();
  $('#applyImport').onclick = () => {
    const snap = snapshotState();
    const removeUnseen = !!($('#impRemoveUnseen') && $('#impRemoveUnseen').checked);
    if (removeUnseen) {
      const gone = new Set(unmatched.map(c => c.id));
      state.cards = state.cards.filter(c => !gone.has(c.id));
    }
    result.toAdd.forEach(c => { c.id = 'c' + (state.nextId++); if (c.equipped === undefined) c.equipped = null; state.cards.push(c); });
    /* The new read replaces the old one. A field the new read lacks is not carried over when
       it describes the card as it was: an old scan's mainValue on a levelled-up card is the
       old level's value (see mainValueFitsLevel). */
    const reread = (old, inc) => {
      const next = Object.assign({}, old, inc, { id: old.id, equipped: old.equipped });
      if (inc.mainValue == null) delete next.mainValue;
      return next;
    };
    result.toUpdate.forEach(({ existingId, card }) => {
      const idx = state.cards.findIndex(x => x.id === existingId);
      if (idx >= 0) state.cards[idx] = reread(state.cards[idx], card);
    });
    $$('[data-amb]').forEach(sel => {
      const a = result.ambiguous[+sel.dataset.amb];
      if (sel.value === 'add') { a.incoming.id = 'c' + (state.nextId++); a.incoming.equipped = null; state.cards.push(a.incoming); }
      else if (sel.value === 'replace') {
        const idx = state.cards.findIndex(x => x.id === a.existing.id);
        if (idx >= 0) state.cards[idx] = reread(state.cards[idx], a.incoming);
      }
    });
    $('#dlg').close(); commit();
    $('#dataMsg').textContent = 'Import applied.' +
      (removeUnseen ? ` Removed ${unmatched.length} card${unmatched.length === 1 ? '' : 's'} not in the scan.` : '');
    offerUndo(`Import applied: ${result.toAdd.length} added, ${result.toUpdate.length} levelled up` +
      (removeUnseen ? `, ${unmatched.length} removed` : '') + '.', snap);
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
/* The Vault is the second view of the Triage tab now ("Lock for later"); 'vault' stays a name
   showTab accepts, so an old link or a hand-typed call still lands on it. */
const TABS = ['opt','inv','triage','upgrades','roster','data','howto'];
function showTab(tab) {
  // pane first, so the tab's first-visit run is the Vault's, not a Triage run on the way past
  if (tab === 'vault') { showTrPane('vault'); showTab('triage'); return; }
  $$('nav button').forEach(x => {
    const on = x.dataset.tab === tab;
    x.classList.toggle('on', on);
    if (on) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current');
  });
  TABS.forEach(t => $('#tab-' + t).classList.toggle('hide', t !== tab));
  window.scrollTo(0, 0);
  if (tab === 'opt' && optStale) { optStale = false; runOpt(); }   // deferred while hidden — see runOptIfShown
  if (tab === 'upgrades' && upViewsStale) runUpgradeViews();       // deferred while hidden — see runUpgradeViews
  if (tab === 'upgrades' && !$('#up-pane-craft').classList.contains('hide')) { if (!ccCache) runCustomCard(); else markStaleRuns(); }
  if (tab === 'upgrades' && !$('#up-pane-ink').classList.contains('hide')) { if (!ikCache) runInkCard(); else markStaleRuns(); }
  if (tab === 'upgrades' && !$('#up-pane-retro').classList.contains('hide')) { if (!rgCache) runRetrograde(); else markStaleRuns(); }
  if (tab === 'upgrades' && !$('#up-pane-fortune').classList.contains('hide')) { if (!frCache) runFortune(); else { renderFrChars(); markStaleRuns(); } }
  if (tab === 'triage') { autoRunTriage(); markStaleRuns(); }
}
$$('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

/* Triage's two views, the same pattern as Upgrades': only the panes toggle. */
function trPane() { return $('#tr-pane-vault').classList.contains('hide') ? 'feed' : 'vault'; }
function showTrPane(p) {
  $$('#trSubtabs button').forEach(b => { const on = b.dataset.trtab === p; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  $('#tr-pane-feed').classList.toggle('hide', p !== 'feed');
  $('#tr-pane-vault').classList.toggle('hide', p !== 'vault');
  if (!$('#tab-triage').classList.contains('hide')) { autoRunTriage(); markStaleRuns(); }
}
$$('#trSubtabs button').forEach(b => b.onclick = () => showTrPane(b.dataset.trtab));

/* The first visit of a session runs the view's pass: nothing is kept between sessions, and an
   empty tab behind a Run button was one more click every time. After that a result is only ever
   marked stale (markStaleRuns), never re-run on its own — a sweep of a second or two on every
   edit is what the Run buttons exist to avoid. */
function autoRunTriage() {
  if (!state.cards.length) return;
  if (trPane() === 'feed') {
    if (!trCache && !$('#trRun').disabled && ($('#trScope').value === 'all' || ownedChars().length)) $('#trRun').click();
  } else if (!vaCache) runVault();
}

/* Closes the dialog on a click outside its box, on the backdrop. The test is the box's own
   rectangle, not the event target: the dialog element is also the target of a click in its own
   20 px of padding, which used to close it — and throw away a Targets edit with it. */
$('#dlg').addEventListener('click', e => {
  if (e.target !== e.currentTarget) return;
  const r = e.currentTarget.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) $('#dlg').close();
});
$('#dlg').addEventListener('close', () => {
  rememberLoSections();
  const t = $('#toast'); if (t.parentNode !== document.body) document.body.appendChild(t);
});
// in-prose cross-links, e.g. the scanning guide pointing at the Data tab
$$('[data-goto]').forEach(b => b.onclick = () => showTab(b.dataset.goto));
$('#fSlot').onchange = () => { syncSetOptions(); syncMainOptions(); };
$('#fAdd').onclick = addCard;
$('#flSlot').onchange = () => { syncFlSetOptions(); renderInv(); };
['#flSet','#flRar','#flMain','#flSubMode'].forEach(s => $(s).onchange = renderInv);
$('#flSub').onchange = () => { if ($('#flSub').value) toggleFlSub($('#flSub').value); };
$('#flQ').oninput = renderInv;
$('#flClear').onclick = () => {
  $('#flSlot').value = ''; syncFlSetOptions(); $('#flRar').value = '';
  $('#flMain').value = ''; flSubSelected = []; renderFlSub();
  $('#flSubMode').value = 'all'; $('#flQ').value = ''; renderInv();
};
$('#optRun').onclick = runOpt;
$('#optChar').onchange = () => { optForced = null; runOpt(); };   // a pick from the list is the ordinary picker again
/* Triage takes a second or two on a full inventory (it runs the Upgrades search for everyone
   in scope), and the page cannot paint while it works, so the button looked dead. Say so
   first, give the browser a frame to show it, then run; the button is off meanwhile. */
$('#trRun').onclick = () => {
  const b = $('#trRun');
  b.disabled = true;
  $('#trSummary').innerHTML = '<p class="muted">Rating the inventory…</p>';
  requestAnimationFrame(() => setTimeout(() => { try { runTriage(); } finally { b.disabled = false; } }, 0));
};
$('#trShow').onchange = () => { if (trCache) renderTriageTable(); };
$('#trFlSlot').onchange = () => { syncFilterSetOptions('trFl'); renderTriageTable(); };
['#trFlSet','#trFlRar','#trFlMain','#trFlSubMode'].forEach(s => $(s).onchange = renderTriageTable);
$('#trFlSub').onchange = () => { if ($('#trFlSub').value) toggleTrFlSub($('#trFlSub').value); };
$('#trFlQ').oninput = renderTriageTable;
$('#trFlClear').onclick = () => {
  $('#trFlSlot').value = ''; syncFilterSetOptions('trFl'); $('#trFlRar').value = '';
  $('#trFlMain').value = ''; trFlSubSelected = []; renderTrFlSub();
  $('#trFlSubMode').value = 'all'; $('#trFlQ').value = ''; renderTriageTable();
};
$('#vaRun').onclick = runVault;
$('#vaShow').onchange = () => { if (vaCache) renderVaultTable(); };
$('#vaFlSlot').onchange = () => { syncFilterSetOptions('vaFl'); renderVaultTable(); };
['#vaFlSet','#vaFlRar','#vaFlMain','#vaFlSubMode'].forEach(s => $(s).onchange = renderVaultTable);
$('#vaFlSub').onchange = () => { if ($('#vaFlSub').value) toggleVaFlSub($('#vaFlSub').value); };
$('#vaFlQ').oninput = renderVaultTable;
$('#vaFlClear').onclick = () => {
  $('#vaFlSlot').value = ''; syncFilterSetOptions('vaFl'); $('#vaFlRar').value = '';
  $('#vaFlMain').value = ''; vaFlSubSelected = []; renderVaFlSub();
  $('#vaFlSubMode').value = 'all'; $('#vaFlQ').value = ''; renderVaultTable();
};
// The controls a Triage or Vault run reads: changing one leaves the result on screen and says so.
['#trScope', '#trRar', '#vaRar'].forEach(id => $(id).addEventListener('change', markStaleRuns));
$('#upRun').onclick = runUpgrades;
/* The Upgrades settings re-run its pass as soon as they change — it is on screen and takes under
   a second — and Triage keeps the cards that pass recommends, so a Triage run is checked too. */
['#upRar', '#upSameSet', '#upIgnoreEquipped'].forEach(id => $(id).addEventListener('change', () => { runUpgradeViews(); markStaleRuns(); }));

/* Upgrades' two in-page views. Only the panes toggle — the tab itself, and everything
   that refreshes it, stays one thing. The headroom pass is cheap next to the plan search
   the other pane runs, so switching to it just renders rather than waiting for a button. */
$$('#upSubtabs button').forEach(b => b.onclick = () => {
  $$('#upSubtabs button').forEach(x => x.classList.toggle('on', x === b));
  $('#up-pane-better').classList.toggle('hide', b.dataset.uptab !== 'better');
  $('#up-pane-headroom').classList.toggle('hide', b.dataset.uptab !== 'headroom');
  $('#up-pane-craft').classList.toggle('hide', b.dataset.uptab !== 'craft');
  $('#up-pane-ink').classList.toggle('hide', b.dataset.uptab !== 'ink');
  $('#up-pane-fortune').classList.toggle('hide', b.dataset.uptab !== 'fortune');
  $('#up-pane-retro').classList.toggle('hide', b.dataset.uptab !== 'retro');
  if (b.dataset.uptab === 'headroom') runHeadroom();
  if (b.dataset.uptab === 'craft') { if (!ccCache) runCustomCard(); else markStaleRuns(); }
  if (b.dataset.uptab === 'ink') { if (!ikCache) runInkCard(); else markStaleRuns(); }
  if (b.dataset.uptab === 'fortune') { if (!frCache) runFortune(); else { renderFrChars(); markStaleRuns(); } }
  if (b.dataset.uptab === 'retro') { if (!rgCache) runRetrograde(); else markStaleRuns(); }
});
/* Fortune Revelation: the item and the two settings re-run the ranking; the character picker only
   marks it stale, since ticking a dozen boxes should not start a dozen runs. */
['#frKind', '#frPolicy', '#frFree'].forEach(id => $(id).addEventListener('change', () => runFortune()));
$('#frRun').onclick = () => runFortune();
$('#frAllOwned').onclick = () => { CHARACTERS.forEach(c => frSetIncluded(c.n, !!state.chars[c.n].owned)); renderFrChars(); markStaleRuns(); };
$('#frNone').onclick = () => { CHARACTERS.forEach(c => frSetIncluded(c.n, false)); renderFrChars(); markStaleRuns(); };
$('#frDefault').onclick = () => { frChosen = {}; renderFrChars(); markStaleRuns(); };
// Custom card: the settings re-run the ranking (a couple of seconds, with its progress shown);
// element and search only redraw it. The check panel re-prices on every change.
['#ccScope', '#ccRolls', '#ccPolicy', '#ccFree'].forEach(id => $(id).addEventListener('change', () => runCustomCard()));
// Switching between Heavens and Space cards also moves the check panel to a slot of that kind.
$('#ccKind').addEventListener('change', () => {
  const space = $('#ccKind').value === 'space';
  if (space !== ($('#ccSlot').value === 'Space')) { $('#ccSlot').value = space ? 'Space' : 'Sun'; ccSyncMain(); ccRenderSubs(); ccCheckFilled = false; }
  runCustomCard();
});
$('#ccRun').onclick = () => runCustomCard();
$('#ccElement').onchange = renderCustomCard;
$('#ccQ').oninput = renderCustomCard;
$('#ccChar').onchange = () => { ccCheckFilled = true; ccCheck(); };
$('#ccSlot').onchange = () => { ccCheckFilled = true; ccSyncMain(); ccRenderSubs(); ccCheck(); };
$('#ccSet').onchange = () => { ccCheckFilled = true; ccCheck(); };
$('#ccMain').onchange = () => { ccCheckFilled = true; ccRenderSubs(); ccCheck(); };
$('#ccFillRec').onclick = () => {
  const name = $('#ccChar').value;
  if (ccCache && ccCache.rows.some(r => r.ch.n === name && r.best)) ccFillRecommended(name);
  else notify(`${name} is not in the last ranking — rank characters with them in scope first.`);
};
$('#ccAdd').onclick = ccAddCard;
// Ink card: wired like the Custom card view.
['#ikScope', '#ikPick', '#ikPolicy', '#ikFree'].forEach(id => $(id).addEventListener('change', () => runInkCard()));
$('#ikRun').onclick = () => runInkCard();
$('#ikElement').onchange = renderInkCard;
$('#ikQ').oninput = renderInkCard;
// Retrograde: who is counted and the fourth-substat rule re-run it; the rest only redraw.
['#rgScope', '#rgFourth'].forEach(id => $(id).addEventListener('change', () => runRetrograde()));
$('#rgRun').onclick = () => runRetrograde();
['#rgShow', '#rgSlot', '#rgWho'].forEach(id => { $(id).onchange = renderRetrograde; });
$('#rgQ').oninput = renderRetrograde;
$('#ikChar').onchange = () => { ikCheckFilled = true; ikCheck(); };
$('#ikSlot').onchange = () => { ikCheckFilled = true; ikSyncMain(); ikRenderSubs(); ikCheck(); };
$('#ikSet').onchange = () => { ikCheckFilled = true; ikCheck(); };
$('#ikMain').onchange = () => { ikCheckFilled = true; ikRenderSubs(); ikCheck(); };
$('#ikFillRec').onclick = () => {
  const name = $('#ikChar').value;
  if (ikCache && ikCache.rows.some(r => r.ch.n === name && r.best)) ikFillRecommended(name);
  else notify(`${name} is not in the last ranking — rank characters with them in scope first.`);
};
$('#ikAdd').onclick = ikAddCard;
// Only the "take a card off someone else" toggle changes which cards are in scope, so it
// is the one control that has to re-run the scoring pass rather than redraw the cache.
$('#hrTakeEquipped').onchange = runHeadroom;
['#hrShow', '#hrElement', '#hrSlot', '#hrRar'].forEach(id => $(id).onchange = renderHeadroomTable);
$('#hrMin').oninput = renderHeadroomTable;
$('#hrQ').oninput = renderHeadroomTable;
$('#hrClear').onclick = () => {
  $('#hrShow').value = 'all'; $('#hrElement').value = ''; $('#hrSlot').value = '';
  $('#hrRar').value = ''; $('#hrMin').value = ''; $('#hrQ').value = '';
  renderHeadroomTable();
};
$('#rsFilter').onchange = renderRoster;
$('#rsElement').onchange = renderRoster;
$('#rsSort').onchange = renderRoster;
$('#rsQ').oninput = renderRoster;
$('#rsHideBenched').onchange = renderRoster;
$$('#rsView button').forEach(b => b.onclick = () => { rosterView = b.dataset.view; renderRoster(); });

/* The team crit rate reprices every character (see teamCritRate). It lives in the header's
   scoring-settings popover, since every tab reads it, and the chip there shows the value in use.
   A change commits like any other: what is scored live is redrawn, and a Triage or Vault run
   scored at the old value says so. */
$('#rsTeamCrit').onchange = () => {
  const v = Math.max(0, Math.min(100, Math.round((+$('#rsTeamCrit').value || 0) * 10) / 10));
  $('#rsTeamCrit').value = v;
  if (v === state.teamCrit) return;
  state.teamCrit = v;
  syncTeamCritField();
  commit();
};
/* The Thieves Den fields (see denBonus): flat points, 0 or more, one per stat. */
$$('.denIn').forEach(inp => inp.onchange = () => {
  const s = inp.dataset.stat;
  const v = Math.max(0, Math.round((+inp.value || 0) * 10) / 10);
  if (v === denBonus(s)) { inp.value = v; return; }
  state.den = Object.assign({}, state.den, { [s]: v });
  if (!v) delete state.den[s];
  syncTeamCritField();
  commit();
});
function setPopOpen(open) {
  $('#setPop').classList.toggle('hide', !open);
  $('#setBtn').setAttribute('aria-expanded', open);
  if (open) $('#rsTeamCrit').focus();
}
$('#setBtn').onclick = e => { e.stopPropagation(); setPopOpen($('#setPop').classList.contains('hide')); };
$('#setPop').addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', () => { if (!$('#setPop').classList.contains('hide')) setPopOpen(false); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#setPop').classList.contains('hide')) { setPopOpen(false); $('#setBtn').focus(); return; }
  // Ctrl+Z takes back the last undoable action, except in a text field, which has its own undo.
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z' || !undoSnap) return;
  const a = document.activeElement;
  if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
  e.preventDefault(); undo();
});
$('#toastClose').onclick = hideToast;

/* Loading replaces everything here, so it asks first when that would drop unsaved changes.
   Asked before the file picker opens rather than inside load(), which the drop handler (after
   its own question) and the tests call directly. */
const LOAD_OVER_UNSAVED = 'Loading a save file replaces everything here, including changes you have not saved.';
function requestLoad() {
  if (isDirty()) { askToast(LOAD_OVER_UNSAVED, 'Load anyway', () => $('#fileIn').click()); return; }
  $('#fileIn').click();
}
$('#dlSave').onclick = save;
$('#hdrSave').onclick = save;
$('#dlCsv').onclick = csv;
$('#upSave').onclick = requestLoad;
$('#hdrLoad').onclick = requestLoad;
$('#emptyLoad').onclick = requestLoad;
$('#fileIn').onchange = e => { if (e.target.files[0]) load(e.target.files[0]); e.target.value = ''; };
$('#upImport').onclick = () => $('#fileImport').click();
$('#hdrImport').onclick = () => $('#fileImport').click();
$('#fileImport').onchange = e => { if (e.target.files.length) importScan(e.target.files); e.target.value = ''; };

/* Drop a file anywhere to load it. A save file — it carries `characters` — replaces everything,
   like Load. Files that are only a card list, the OCR pipeline's cards.json (one or several),
   go to the import review, like Import scan: replacing an inventory with a partial scan is never
   what dropping one means. */
let dragDepth = 0;
const dragHasFiles = e => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
document.addEventListener('dragenter', e => {
  if (!dragHasFiles(e)) return;
  e.preventDefault(); dragDepth++; $('#dropzone').classList.remove('hide');
});
document.addEventListener('dragover', e => { if (dragHasFiles(e)) e.preventDefault(); });
document.addEventListener('dragleave', e => {
  if (!dragHasFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; $('#dropzone').classList.add('hide'); }
});
document.addEventListener('drop', e => {
  if (!dragHasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('#dropzone').classList.add('hide');
  const files = Array.from(e.dataTransfer.files || []).filter(f => /\.json$/i.test(f.name) || f.type === 'application/json');
  if (!files.length) { notify('Only .json files can be dropped here: a save file, or scan files from the OCR pipeline.', null); return; }
  if (files.length > 1) { importScan(files); return; }
  files[0].text().then(txt => {
    let d = null;
    try { d = JSON.parse(txt); } catch (err) { load(files[0]); return; }   // load() says what is wrong with it
    if (d && !Array.isArray(d) && d.characters) {
      if (isDirty()) askToast(`${LOAD_OVER_UNSAVED} Load ${files[0].name}?`, 'Load it', () => load(files[0]));
      else load(files[0]);
    } else importScan(files);
  });
});

$('#wipe').onclick = () => askToast('Clear every card and character setting? You can undo it for 15 seconds afterwards.', 'Clear everything', () => {
  const snap = snapshotState();
  state.cards = []; state.nextId = 1; state.teamCrit = 0; state.den = {}; syncTeamCritField();
  CHARACTERS.forEach(c => state.chars[c.n] = { owned: false, benched: false, targets: null, loadout: null });
  commit();
  offerUndo('Cleared every card and character setting.', snap);
});

$('#stamp').textContent = `This build knows ${CHARACTERS.length} characters, ${Object.keys(SETS).length} sets and ${Object.keys(SPACE_SETS).length} Space cards.`;
fillSelects(); linkLabels(); syncTeamCritField(); renderInv(); renderRoster(); renderOpt();
upViewsStale = true;   // nothing has run yet: the first visit to Upgrades runs its pass,
optStale = true;       // and the first visit to Optimise its plan for the selected character
markSaved();           // an empty page has nothing unsaved
