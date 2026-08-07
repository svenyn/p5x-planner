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
    def norm_stat(self, raw, value_has_percent=False):
        if not raw:
            return None, 0.0

        def with_percent(s):
            return self.flat_to_percent.get(s, s) if value_has_percent else s

        t = str(raw).strip()
        if t in self.substats or t in ("HP Recovery", "ATK + DEF"):
            return with_percent(t), 1.0
        # strip trailing %, +, . the same way src/logic.js's normStat does, so an
        # in-game abbreviation like "Ailment Acc." resolves the same way it would
        # if a human typed it into the bulk-paste box.
        k = re.sub(r"\s+", " ", t.lower()).strip()
        k = re.sub(r"[%+.]+$", "", k).strip()
        if k in self._stat_names_lower:
            return with_percent(self._stat_names_lower[k]), 1.0
        if k in self.stat_aliases:
            return with_percent(self.stat_aliases[k]), 1.0
        pk = k + "%"
        if pk in self._stat_names_lower:
            return self._stat_names_lower[pk], 1.0
        # OCR-noise fallback: fuzzy match against canonical names + alias keys,
        # all lowercased (rapidfuzz scorers are case-sensitive)
        candidates = list(self._stat_names_lower.keys()) + list(self.stat_aliases.keys())
        match = process.extractOne(k, candidates, scorer=fuzz.ratio)
        if match and match[1] >= FUZZY_ACCEPT_THRESHOLD:
            matched = match[0]
            resolved = self.stat_aliases.get(matched) or self._stat_names_lower.get(matched) or matched
            return with_percent(resolved), match[1] / 100.0
        return None, 0.0

    # ---- set names ----
    def norm_set(self, raw):
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
