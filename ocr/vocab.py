"""Game-data vocabulary for the OCR pipeline.

Loads dist/tables.json — the export of src/data.js produced by
`npm run export-tables` — so this pipeline never hand-copies slot/set/substat
names and can't silently drift from the app it feeds. Regenerate that file
after any change to src/data.js and re-run the pipeline's tests.

The matching here deliberately goes further than the app's own normStat()/
normSet() (src/logic.js): those only resolve exact names and known aliases,
which is correct for typed/pasted text but too strict for OCR, which
introduces character-level noise a human typist wouldn't. So each resolver
here is exact/alias match first (confidence 1.0, identical to the app's own
logic), falling back to fuzzy matching only when that fails (lower
confidence, surfaced in the card's `conf` field for the review dialog).
"""
import json
import re
from pathlib import Path

from rapidfuzz import fuzz, process

TABLES_PATH = Path(__file__).resolve().parent.parent / "dist" / "tables.json"

FUZZY_ACCEPT_THRESHOLD = 80  # rapidfuzz token score, 0-100; below this we refuse to guess

# Lower than FUZZY_ACCEPT_THRESHOLD on purpose: this one only ever fires with
# restrict_to set, i.e. against a slot's ~5 legal main stats rather than the
# full ~30-name vocabulary, so a much weaker score is still a confident pick —
# see norm_stat's restrict_to branch.
MAIN_STAT_RESTRICTED_THRESHOLD = 65

# Minimum length, in characters, of the shared run that the unique-fragment
# fallback needs before it will name a stat — see _longest_run and norm_stat.
MAIN_STAT_FRAGMENT_MIN = 5


class Vocab:
    def __init__(self, tables_path=TABLES_PATH):
        with open(tables_path, "r", encoding="utf-8") as f:
            self.tables = json.load(f)

        self.slots = self.tables["slots"]
        self.slot_info = self.tables["slotInfo"]
        self.substats = self.tables["substats"]
        self.stat_aliases = {k.lower(): v for k, v in self.tables["statAliases"].items()}
        self.flat_to_percent = self.tables["flatToPercent"]
        self.rarity = {int(k): v for k, v in self.tables["rarity"].items()}
        self.sets = self.tables["sets"]
        self.set_aliases = {k.lower(): v for k, v in self.tables["setAliases"].items()}
        self.space_sets = self.tables["spaceSets"]
        self.characters = self.tables["characters"]
        # Measured 5-star tables read by plausibility.py. Both are optional: a
        # dist/tables.json exported before they existed simply disables those
        # checks rather than failing to load.
        self.roll_tiers = self.tables.get("rollTiers", {})
        self.main_magnitude = self.tables.get("mainMagnitude", {})

        self._stat_names_lower = {s.lower(): s for s in self.substats}
        self._set_names_lower = {s.lower(): s for s in self.sets}
        self._space_set_names_lower = {s.lower(): s for s in self.space_sets}
        self._char_names_lower = {c.lower(): c for c in self.characters}
        self._slot_names_lower = {s.lower(): s for s in self.slots}

    def slot_for_set(self, set_name):
        """'Space' if set_name is a Space set, 'Heavens' if a 4-slot set, else None."""
        if set_name in self.space_sets:
            return "Space"
        if set_name in self.sets:
            return "Heavens"
        return None

    # ---- slot ----
    def norm_slot(self, raw):
        if not raw:
            return None, 0.0
        t = str(raw).strip()
        for s in self.slots:
            if s.lower() == t.lower():
                return s, 1.0
        if re.match(r"^planet$", t, re.I):
            return "Sky", 1.0
        if re.match(r"^universe$", t, re.I):
            return "Space", 1.0
        # rapidfuzz's scorers are case-sensitive, so candidates must be lowercased
        # too — comparing raw OCR text against Title Case canonical names tanks
        # the score even for a clean match (e.g. "star" vs "Star").
        match = process.extractOne(t.lower(), list(self._slot_names_lower.keys()), scorer=fuzz.ratio)
        if match and match[1] >= FUZZY_ACCEPT_THRESHOLD:
            return self._slot_names_lower[match[0]], match[1] / 100.0
        return None, 0.0

    # ---- substat / main stat names ----
    # ATK, DEF and HP each exist as a flat AND a %-of-stat substat, and the game shows
    # the SAME label ("Attack", "Defense", "HP") for either — only the value carries a
    # '%' to say which. `flat_to_percent` (loaded above from tables.json, sourced from
    # FLAT_TO_PERCENT in src/data.js) is the same map normStat's hasPercent parameter
    # uses in src/logic.js; keep both in sync.
    def norm_stat(self, raw, value_has_percent=False, restrict_to=None):
        """`restrict_to`, when given, is a list of canonical stat names (e.g. a
        slot's legal main stats from SLOT_INFO) — both the exact match and the
        fuzzy fallback are limited to it. This is for the main stat specifically:
        the substat vocabulary that the unrestricted path fuzzy-matches against
        includes near-neighbours a slot can never legally show (e.g. "SP Recovery"
        is one bad OCR guess away from "HP Recovery", but Moon cards can never
        legally roll SP Recovery), and those false attractors are usually a
        *closer* fuzzy match than the real, clipped label. Restricting the
        candidate pool to what the slot can actually show removes them instead of
        outscoring them."""
        if not raw:
            return None, 0.0

        def with_percent(s):
            return self.flat_to_percent.get(s, s) if value_has_percent else s

        def in_scope(s):
            return restrict_to is None or s in restrict_to

        t = str(raw).strip()
        # Exact/alias matching runs unconditionally, restrict_to or not — an in-game
        # abbreviation like "Attack" or "Ailment Acc." must still resolve via
        # stat_aliases/self._stat_names_lower even when restricted, it's just that
        # the *result* now also has to clear in_scope before being accepted. Skip
        # rather than return None here: falling through lets the restricted fuzzy
        # step below have a try, instead of a legal alias match that happens to
        # resolve outside the current slot's mains dead-ending the whole lookup.
        if (t in self.substats or t in ("HP Recovery", "ATK + DEF")) and in_scope(with_percent(t)):
            return with_percent(t), 1.0
        # strip trailing %, +, . the same way src/logic.js's normStat does, so an
        # in-game abbreviation like "Ailment Acc." resolves the same way it would
        # if a human typed it into the bulk-paste box.
        k = re.sub(r"\s+", " ", t.lower()).strip()
        k = re.sub(r"[%+.]+$", "", k).strip()
        if k in self._stat_names_lower and in_scope(with_percent(self._stat_names_lower[k])):
            return with_percent(self._stat_names_lower[k]), 1.0
        if k in self.stat_aliases and in_scope(with_percent(self.stat_aliases[k])):
            return with_percent(self.stat_aliases[k]), 1.0
        pk = k + "%"
        if pk in self._stat_names_lower and in_scope(self._stat_names_lower[pk]):
            return self._stat_names_lower[pk], 1.0

        if restrict_to is not None:
            names_lower = {s.lower(): s for s in restrict_to}
            # Aliases whose *resolved* form is in scope join the fuzzy candidate
            # pool too, keyed by the alias text itself — e.g. "ailment acc" is a
            # far closer match to a clipped "\\ilment Acc." than the canonical
            # "Ailment Accuracy" is, and skipping aliases here (unlike the
            # unrestricted path below, which already searches both) was silently
            # turning legal-and-correctly-guessable cards into unresolved ones.
            in_scope_aliases = {
                alias_k: with_percent(alias_v)
                for alias_k, alias_v in self.stat_aliases.items()
                if with_percent(alias_v) in restrict_to
            }
            # But drop any alias key that is itself a strict substring of another
            # in-scope key (candidate or alias) — confirmed against the batch: "hp"
            # is a substring of the sibling candidate "hp recovery", so
            # token_set_ratio scores "hp" at/near 100 against ANY text containing
            # that token anywhere, including a clipped "...overy HP" that's really
            # HP Recovery, silently handing back the wrong (but legal, so
            # unflagged) "HP%". A key with no such sibling collision — "attack" is
            # nobody's substring here — stays in no matter how short, since exact
            # hits on it already returned above via self.stat_aliases and this
            # fuzzy step is its only shot at surviving OCR noise around it (e.g.
            # a trailing stray "|").
            all_keys = set(names_lower) | set(in_scope_aliases)
            for alias_k, resolved in in_scope_aliases.items():
                if any(other != alias_k and alias_k in other for other in all_keys):
                    continue
                names_lower.setdefault(alias_k, resolved)
            if k in names_lower:
                return names_lower[k], 1.0
            # token_set_ratio, not ratio: a clipped label reads back with its own
            # words reordered or a prefix missing ("overy HP" for "HP Recovery",
            # "Recovery :" for "SP Recovery") and plain character-alignment ratio
            # scores that low regardless of slot restriction — see norm_stat's
            # docstring. Restricting to a handful of legal, well-separated
            # candidates first is what makes the lower threshold safe here: the
            # correct candidate's margin over the runner-up ran 25-60+ points on
            # every real batch case checked, never a close call.
            match = process.extractOne(k, list(names_lower.keys()), scorer=fuzz.token_set_ratio)
            if match and match[1] >= MAIN_STAT_RESTRICTED_THRESHOLD:
                return names_lower[match[0]], match[1] / 100.0
            return self._unique_fragment(k, names_lower)

        # OCR-noise fallback: fuzzy match against canonical names + alias keys,
        # all lowercased (rapidfuzz scorers are case-sensitive)
        candidates = list(self._stat_names_lower.keys()) + list(self.stat_aliases.keys())
        match = process.extractOne(k, candidates, scorer=fuzz.ratio)
        if match and match[1] >= FUZZY_ACCEPT_THRESHOLD:
            matched = match[0]
            resolved = self.stat_aliases.get(matched) or self._stat_names_lower.get(matched) or matched
            return with_percent(resolved), match[1] / 100.0
        return None, 0.0

    @staticmethod
    def _longest_run(a, b):
        """Length of the longest run of characters `a` and `b` share, contiguous
        in both. Classic LCS-substring DP, over strings never more than ~20
        characters here."""
        if not a or not b:
            return 0
        prev = [0] * (len(b) + 1)
        best = 0
        for i in range(1, len(a) + 1):
            cur = [0] * (len(b) + 1)
            for j in range(1, len(b) + 1):
                if a[i - 1] == b[j - 1]:
                    cur[j] = prev[j - 1] + 1
                    best = max(best, cur[j])
            prev = cur
        return best

    def _unique_fragment(self, k, names_lower):
        """Last resort under restrict_to: name the one legal stat that contains a
        long run of the OCR text, or refuse.

        The panel's stat label animates into place when a card is selected, so a
        frame caught mid-animation holds a real but scrambled label — "ntAcc. A"
        and "G Ailmen", both really "Ailment Acc.", in the Aug 2026 batch. Those
        defeat the token scorer above for a reason that is about the scorer, not
        the evidence: token_set_ratio divides by the whole string, so the orphan
        "A" alone drops "nt Acc." from 67 to 40.

        Two things make a bare fragment safe to act on here. Both sides are
        squashed to alphanumerics first, which is what turns the OCR's dropped
        space into a hit — "ntacca" contains "ntacc", a literal 5-character
        substring of "ailmentaccuracy". And the answer has to be *unique*: the
        winning run must be strictly longer than the best run of every candidate
        resolving to a different stat, so a fragment like "rit", which Crit Rate
        and Crit Multiplier share, stays refused rather than guessing between
        them. That is the "it cannot be any other main stat" argument, made
        checkable.

        MAIN_STAT_FRAGMENT_MIN is 5 because that is where the two real cases
        still clear (runs of 5 and 6, against a best rival run of 1) and false
        positives collapse: measured over the batch's whole label corpus plus 216
        junk strings scored against all three label-bearing slots, minlen 4 fired
        on 4 of 648 junk trials and minlen 5 on 1 — versus ~95 for any
        ratio-and-margin rule loose enough to catch "ntAcc. A" at all. Do not
        lower it.

        The confidence returned is the fraction of the matched candidate that the
        run covers, always well below MAIN_STAT_RESTRICTED_THRESHOLD / 100, which
        is what parse_panel keys its review note off."""
        squashed = re.sub(r"[^a-z0-9]", "", k)
        if len(squashed) < MAIN_STAT_FRAGMENT_MIN:
            return None, 0.0
        best = {}
        for key, stat in names_lower.items():
            cand = re.sub(r"[^a-z0-9]", "", key)
            run = self._longest_run(squashed, cand)
            if run > best.get(stat, (0, 0))[0]:
                best[stat] = (run, len(cand))
        ranked = sorted(((run, length, stat) for stat, (run, length) in best.items()), reverse=True)
        if not ranked or ranked[0][0] < MAIN_STAT_FRAGMENT_MIN:
            return None, 0.0
        if len(ranked) > 1 and ranked[0][0] == ranked[1][0]:
            return None, 0.0
        run, length, stat = ranked[0]
        return stat, run / length

    # ---- set names ----
    # No set name contains an "&", so one in the title is not noise — it means the
    # Set Effect box is showing a PAIR of names. Splitting on it must therefore come
    # before any fuzzy match of the whole string, which would otherwise get a shot at
    # scoring "Acceptance & Strife" against some unrelated single name.
    _PAIRED_TITLE_RE = re.compile(r"\s*[&+]\s*|\s+and\s+", re.I)

    def norm_set(self, raw):
        """A Space card's Set Effect box names TWO sets — its own, then the Heavens
        set it combines with, e.g. "Acceptance & Strife" (confirmed on all 52 Space
        frames of the Aug 2026 batches; a Heavens card shows a single name). So the
        whole string matches nothing and the card was landing in review with an
        unresolved set. Split it and resolve the parts.

        The Space set is listed first, but this picks it by table membership rather
        than by position: "first token" would also be right, and is what it comes
        down to in practice, but a set that is *in SPACE_SETS* is the one a Space
        panel is describing whatever order OCR hands the two names over in."""
        if not raw:
            return None, 0.0
        t = str(raw).strip()
        parts = [p for p in self._PAIRED_TITLE_RE.split(t) if p.strip()]
        if len(parts) > 1:
            resolved = [self._resolve_set(p) for p in parts]
            for name, conf in resolved:
                if name in self.space_sets:
                    return name, conf
            for name, conf in resolved:
                if name is not None:
                    return name, conf
            return None, 0.0
        return self._resolve_set(t)

    def _resolve_set(self, raw):
        """One set name: exact, then alias, then fuzzy. norm_set is the entry point."""
        if not raw:
            return None, 0.0
        t = str(raw).strip()
        if t in self.sets or t in self.space_sets:
            return t, 1.0
        # the Set Effect panel shows the set name wrapped in brackets with a small
        # icon glyph before it, e.g. "[Futility]" — strip that bracket punctuation
        # before matching so this resolves as a clean match, not a fuzzy guess.
        k = re.sub(r"^[^\w]*[\[({]|[\])}][^\w]*$", "", t.lower()).strip()
        if k in self._set_names_lower:
            return self._set_names_lower[k], 1.0
        if k in self._space_set_names_lower:
            return self._space_set_names_lower[k], 1.0
        if k in self.set_aliases:
            return self.set_aliases[k], 1.0
        # OCR-noise fallback: fuzzy match against canonical names + alias keys,
        # all lowercased (rapidfuzz scorers are case-sensitive)
        candidates = list(self._set_names_lower.keys()) + list(self._space_set_names_lower.keys()) + list(self.set_aliases.keys())
        match = process.extractOne(k, candidates, scorer=fuzz.ratio)
        if match and match[1] >= FUZZY_ACCEPT_THRESHOLD:
            matched = match[0]
            resolved = (self.set_aliases.get(matched) or self._set_names_lower.get(matched)
                        or self._space_set_names_lower.get(matched) or matched)
            return resolved, match[1] / 100.0
        return None, 0.0

    # ---- character names ----
    def norm_character(self, raw):
        if not raw:
            return None, 0.0
        t = str(raw).strip()
        if t in self.characters:
            return t, 1.0
        k = t.lower()
        if k in self._char_names_lower:
            return self._char_names_lower[k], 1.0
        match = process.extractOne(k, list(self._char_names_lower.keys()), scorer=fuzz.ratio)
        if match and match[1] >= FUZZY_ACCEPT_THRESHOLD:
            return self._char_names_lower[match[0]], match[1] / 100.0
        return None, 0.0

    def max_roll(self, stat, slot):
        info = self.substats.get(stat)
        if not info:
            return None
        return info["maxRollSpace"] if slot == "Space" else info["maxRoll"]
