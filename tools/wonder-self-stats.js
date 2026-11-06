/* The stat lines on Wonder's own panel that a Persona's talent, a passive skill or a dagger always gives: a whole
 * sentence of lufel's English text that is nothing but "Increase <stat> by N%." (or "Decrease ..."), with no
 * trigger, duration or target around it. Measured on the user's panel (Nov 2026, docs/DATA-SOURCES.md): Kohryu's
 * "Increase Attack by 29.1%." and his HP Boost IV, Apt Pupil III and Battle Acumen IV all show there from slot 1;
 * "At the start of battle, increase Attack by 12.1% for 2 turns." (Attack Master II) does not.
 *
 * Shared by gen-wonder-innate.js (talents), gen-wonder-skills.js (passive skills) and gen-wonder-weapons.js.
 * Returns [[key, value], ...]; a value is a number, or an array where the text prints a ladder ("28.0%/32.7%/...").
 * Keys: hp%, atk%, def% (percent of the stat), spd (flat Speed), cr, cm, dm, aa (points of crit rate, crit damage,
 * damage multiplier, ailment accuracy). A stat not on this list (an element's damage, healing, a resistance) is
 * left out: it is not one of the panel numbers the Teams tab reads. */
const STATS = [
  [/^(?:max )?HP$/i, 'hp%', true], [/^Attack$/i, 'atk%', true], [/^Defense$/i, 'def%', true],
  [/^Speed$/i, 'spd', false], [/^critical rate$/i, 'cr', true], [/^critical damage$/i, 'cm', true],
  [/^damage$/i, 'dm', true], [/^ailment accuracy$/i, 'aa', true]
];
const NUMS = '\\d+(?:\\.\\d+)?%?(?:\\/\\d+(?:\\.\\d+)?%?)*';
const PART = new RegExp(`^(Increase|Decrease) (.+?) by (${NUMS})\\.?$`, 'i');

function selfStats(text) {
  const out = [];
  // a sentence ends at a full stop followed by a space (a decimal point never is: "Increase Speed by 9. Decrease
  // Defense by 4%." is two); "A, and increase B" is two parts
  String(text || '').split(/\n|(?<=\.)\s+/).forEach(sent => {
    sent.trim().split(/,? and (?=(?:increase|decrease) )/i).forEach(part => {
      const m = part.trim().match(PART);
      if (!m) return;
      const st = STATS.find(([re]) => re.test(m[2].trim()));
      if (!st) return;
      const pct = /%/.test(m[3]);
      if (pct !== st[2]) return;   // "Increase Speed by 6" is flat; "Increase Attack by 300" would be a flat ATK, not on this list
      const sign = /^decrease/i.test(m[1]) ? -1 : 1;
      const vals = m[3].split('/').map(x => sign * parseFloat(x));
      out.push([st[1], vals.length === 1 ? vals[0] : vals]);
    });
  });
  return out;
}

// as JavaScript source: [['atk%', 29.1], ['spd', -6]]
const selfSrc = l => '[' + l.map(([k, v]) => `['${k}', ${Array.isArray(v) ? '[' + v.join(', ') + ']' : v}]`).join(', ') + ']';

module.exports = { selfStats, selfSrc };
