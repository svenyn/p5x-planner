#!/usr/bin/env python3
"""Downloads roster portraits from lufel.net into dist/art/.

These are Sega/Atlus game assets hosted on a fan site — fine to keep locally
for your own copy of the planner, not something to redistribute. dist/art/ is
gitignored for that reason; re-run this script rather than committing images.

    python tools/fetch-art.py            # download everything missing
    python tools/fetch-art.py --dry-run  # just show the name matching

Lufelnet identifies characters by slug ("joker", "puppet-wavecatcher"); this
project uses real names ("Ren Amamiya", "Miyu Sahara [Wavecatcher]"). The two
are matched on the alias and name fields exported to dist/tables.json, with
costume suffixes resolved off the base character. Anything that cannot be
matched with confidence is reported and skipped — a wrong portrait is worse
than none.

The slug list below comes from the site's own `__CHARACTER_SLUG_MAP` global
rather than the rendered character index: the index only paints 49 cards, but
the map holds all 66, including every alternate costume and the whole
Persona 3 collab. Its keys are the Korean names the image files are named
after, so the portrait path falls straight out of it.
"""
import argparse
import json
import re
import sys
import urllib.request
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lufel_slugs import SLUGS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TABLES = ROOT / "dist" / "tables.json"
OUT_DIR = ROOT / "dist" / "art"
BASE = "https://lufel.net"
MAX_WIDTH = 430  # 2x the ~215px roster card width, for hi-dpi screens


# Slugs no alias or name lookup can resolve — mostly the Persona 3 collab,
# whose characters carry no alias in src/data.js, plus a few lufel spellings.
EXPLICIT = {
    "j-c": "Justine & Caroline",
    "navi": "Futaba Sakura",       # "ORACLE" on screen, "navi" in the URL
    "makoto": "Makoto Yuki",       # the P3 lead; "queen" is Makoto Niijima
    "akihiko": "Akihiko Sanada",
    "yukari": "Yukari Takeba",
    "kirijo": "Mitsuru Kirijo",
    "fuka": "Fuuka Yamagishi",
    "aegis": "Aigis",
    "junpei": "Junpei Iori",
}


def slug(name):
    """Mirrors artSlug() in src/logic.js — keep the two in step."""
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", name.lower()))


def match_character(lufel_slug, chars):
    if lufel_slug in EXPLICIT:
        want = EXPLICIT[lufel_slug]
        return next((c["n"] for c in chars if c["n"] == want), None)

    def find(part):
        """A base character (no costume) whose alias or name reduces to `part`."""
        for c in chars:
            if "[" in c["n"]:
                continue
            if slug(c["a"] or "") == part or slug(c["n"]) == part:
                return c["n"]
        return None

    direct = find(lufel_slug)
    if direct:
        return direct

    # Costume variants are "<base slug>-<costume>" on lufel and
    # "<base name> [Costume]" here. Resolving them off the base character
    # rather than their own alias matters: alt-costume aliases don't reliably
    # contain the base codename (Beachflower Marian's alias is "S. Minami").
    base, _, costume = lufel_slug.partition("-")
    if not costume:
        return None
    base_name = find(base)
    if not base_name:
        return None
    want = f"{base_name} [{costume.replace('-', ' ')}]".lower()
    return next((c["n"] for c in chars if c["n"].lower() == want), None)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="show matching, download nothing")
    ap.add_argument("--force", action="store_true", help="re-download files that already exist")
    args = ap.parse_args()

    if not TABLES.exists():
        sys.exit("dist/tables.json missing — run `npm run export-tables` first")
    chars = json.loads(TABLES.read_text(encoding="utf-8"))["characterMeta"]

    matched, unmatched = [], []
    for codename, path in SLUGS:
        name = match_character(codename, chars)
        (matched if name else unmatched).append((codename, path, name))

    for codename, _, name in matched:
        print(f"  {codename:22s} -> {name}")
    if unmatched:
        print(f"\n{len(unmatched)} lufel entr{'y' if len(unmatched) == 1 else 'ies'} not in this roster (skipped):")
        print("  " + ", ".join(c for c, _, _ in unmatched))

    covered = {n for _, _, n in matched}
    missing = [c["n"] for c in chars if c["n"] not in covered]
    if missing:
        print(f"\n{len(missing)} character(s) will keep the placeholder (no portrait on lufel.net):")
        for n in missing:
            print(f"  {n}")

    if args.dry_run:
        return

    try:
        from PIL import Image
    except ImportError:
        sys.exit("Pillow is required to convert .webp portraits — pip install Pillow")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    saved = skipped = failed = 0
    for codename, path, name in matched:
        dest = OUT_DIR / f"{slug(name)}.webp"
        if dest.exists() and not args.force:
            skipped += 1
            continue
        url = BASE + path  # LUFEL paths are already percent-encoded
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "p5x-planner/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
            im = Image.open(BytesIO(data))
            # Roster cards are ~215px wide, so the full-size art is far larger
            # than anything that gets displayed — downscale to 2x the card width
            # for sharpness on hi-dpi screens and nothing beyond. Left at source
            # size the folder runs to tens of MB and the roster tab crawls.
            if im.width > MAX_WIDTH:
                h = round(im.height * MAX_WIDTH / im.width)
                im = im.resize((MAX_WIDTH, h), Image.LANCZOS)
            # WebP, matching artPath() in src/logic.js — this is painted art, so
            # PNG is a poor fit (~28 MB across the set versus a couple of MB here)
            im.save(dest, "WEBP", quality=86, method=6)
            saved += 1
        except Exception as e:
            print(f"  FAILED {codename}: {e}")
            failed += 1

    print(f"\nsaved {saved}, already present {skipped}, failed {failed} -> {OUT_DIR}")


if __name__ == "__main__":
    main()
