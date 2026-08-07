#!/usr/bin/env python3
"""Downloads roster portraits from lufel.net into dist/art/.

These are Sega/Atlus game assets hosted on a fan site — fine to keep locally
for your own copy of the planner, not something to redistribute. dist/art/ is
gitignored for that reason; re-run this script rather than committing images.

    python tools/fetch-art.py            # download everything missing
    python tools/fetch-art.py --dry-run  # just show the name matching

Lufelnet identifies characters by codename ("JOKER", "PUPPET·Wavecatcher");
this project uses real names ("Ren Amamiya", "Miyu Sahara [Wavecatcher]").
The two are matched via the alias field exported to dist/tables.json, with
costume suffixes lined up separately. Anything that cannot be matched with
confidence is reported and skipped — a wrong portrait is worse than none.
"""
import argparse
import json
import re
import sys
import urllib.request
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TABLES = ROOT / "dist" / "tables.json"
OUT_DIR = ROOT / "dist" / "art"
BASE = "https://lufel.net"
MAX_WIDTH = 430  # 2x the ~215px roster card width, for hi-dpi screens

# Scraped from lufel.net's /en/character/ index (Aug 2026): codename -> portrait.
# Refresh by re-reading `a[href*="/character/"] img.character-img` off that page.
# Paths are kept percent-encoded (the originals are Korean filenames) so this
# file stays pure ASCII and no transcription step can corrupt them.
_D = "/assets/img/character-cards/"
LUFEL = [
    ("PUPPET·Wavecatcher", _D + "%EB%AF%B8%EC%9C%A0%C2%B7%EC%97%AC%EB%A6%84.webp"),
    ("MARIAN·Beachflower", _D + "%EB%AF%B8%EB%82%98%EB%AF%B8%C2%B7%EC%97%AC%EB%A6%84.webp"),
    ("MIKU", _D + "%EB%AF%B8%EC%BF%A0.webp"),
    ("AKIHIKO", _D + "%EC%82%AC%EB%82%98%EB%8B%A4.webp"),
    ("YUKARI", _D + "%EC%9C%A0%EC%B9%B4%EB%A6%AC.webp"),
    ("MAKOTO", _D + "%EC%9C%A0%ED%82%A4%20%EB%A7%88%EC%BD%94%ED%86%A0.webp"),
    ("ANGE", _D + "%EB%A7%88%EB%82%98%EC%B9%B4.webp"),
    ("LUCE", _D + "%EC%87%BC%ED%82%A4.webp"),
    ("CROW", _D + "%EC%95%84%EC%BC%80%EC%B9%98.webp"),
    ("TURBO", _D + "%EB%A7%88%EC%9C%A0%EB%AF%B8.webp"),
    ("VIOLET", _D + "%EC%B9%B4%EC%8A%A4%EB%AF%B8.webp"),
    ("RIN·Firecracker", _D + "%EC%95%BC%EC%98%A4%EB%A7%81%C2%B7%EC%82%AC%EC%9E%90%EB%AC%B4.webp"),
    ("MATOI", _D + "%EB%AF%B8%EC%98%A4.webp"),
    ("WIND·Tempest", _D + "%EB%A6%AC%EC%BD%94%C2%B7%EB%A7%A4%ED%99%94.webp"),
    ("HOWLER", _D + "%EB%A3%A8%EC%9A%B0%EB%82%98.webp"),
    ("MONT·Frostgale", _D + "%EB%AA%BD%ED%83%80%EB%89%B4%C2%B7%EB%B0%B1%EC%A1%B0.webp"),
    ("J&C", _D + "J&C.webp"),
    ("NOIR", _D + "%ED%95%98%EB%A3%A8.webp"),
    ("CHERISH", _D + "%EB%A7%88%EC%82%AC%ED%82%A4.webp"),
    ("ORACLE", _D + "%ED%9B%84%ED%83%80%EB%B0%94.webp"),
    ("MESSA", _D + "%ED%82%A4%EB%9D%BC.webp"),
    ("MOKO·Seaside", _D + "%ED%86%A0%EB%AA%A8%EC%BD%94%C2%B7%EC%97%AC%EB%A6%84.webp"),
    ("CLOSER·Tropical", _D + "%EB%AA%A8%ED%86%A0%ED%95%98%C2%B7%EC%97%AC%EB%A6%84.webp"),
    ("CHORD", _D + "%EC%95%84%EC%95%BC%EC%B9%B4.webp"),
    ("WIND", _D + "%EB%A6%AC%EC%BD%94.webp"),
    ("PHOEBE", _D + "%EC%9C%A0%EC%9A%B0%EB%AF%B8.webp"),
    ("QUEEN", _D + "%EB%A7%88%EC%BD%94%ED%86%A0.webp"),
    ("VINO", _D + "%EC%B9%98%EC%A6%88%EC%BD%94.webp"),
    ("FOX", _D + "%EC%9C%A0%EC%8A%A4%EC%BC%80.webp"),
    ("BUI", _D + "YUI.webp"),
    ("MARIAN", _D + "%EB%AF%B8%EB%82%98%EB%AF%B8.webp"),
    ("JOKER", _D + "%EB%A0%8C.webp"),
    ("SKULL", _D + "%EB%A5%98%EC%A7%80.webp"),
    ("MONA", _D + "%EB%AA%A8%EB%A5%B4%EA%B0%80%EB%82%98.webp"),
    ("PANTHER", _D + "%EC%95%88.webp"),
    ("RIN", _D + "%EC%95%BC%EC%98%A4%EB%A7%81.webp"),
    ("RIDDLE", _D + "%ED%95%98%EB%A3%A8%EB%82%98.webp"),
    ("CATTLE", _D + "%EB%A3%A8%ED%8E%98%EB%A5%B4.webp"),
    ("LEON", _D + "%EB%A0%88%EC%98%A4.webp"),
    ("CLOSER", _D + "%EB%AA%A8%ED%86%A0%ED%95%98.webp"),
    ("MONT", _D + "%EB%AA%BD%ED%83%80%EB%89%B4.webp"),
    ("SOY", _D + "%EC%8A%8C.webp"),
    ("FLEURET", _D + "%EC%84%B8%EC%9D%B4%EC%A7%80.webp"),
    ("YUKI", _D + "%EC%9C%A0%ED%82%A4%EB%AF%B8.webp"),
    ("KEY", _D + "%ED%82%A4%EC%9A%94%EC%8B%9C.webp"),
    ("MOKO", _D + "%ED%86%A0%EB%AA%A8%EC%BD%94.webp"),
    ("SEPIA", _D + "%ED%86%A0%EC%8B%9C%EC%95%BC.webp"),
    ("PUPPET", _D + "%EB%AF%B8%EC%9C%A0.webp"),
    ("OKYANN", _D + "%EC%B9%B4%EC%9A%94.webp"),
]

# Codenames that no alias lookup can resolve.
EXPLICIT = {
    "J&C": "Justine & Caroline",
    "MAKOTO": "Makoto Yuki",       # the P3 lead; "QUEEN" is Makoto Niijima
    "AKIHIKO": "Akihiko Sanada",
    "YUKARI": "Yukari Takeba",
    "ORACLE": "Futaba Sakura",
}


def slug(name):
    """Mirrors artSlug() in src/logic.js — keep the two in step."""
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", name.lower()))


def match_character(codename, chars):
    if codename in EXPLICIT:
        want = EXPLICIT[codename]
        return next((c["n"] for c in chars if c["n"] == want), None)

    base, _, costume = codename.partition("·")
    base = base.strip().lower()
    costume = costume.strip().lower()

    # the plain codename always names the base character, whose alias is the
    # canonical one ("MARIAN" -> Minami Miyashita)
    base_name = next((c["n"] for c in chars
                      if (c["a"] or "").lower() == base and "[" not in c["n"]), None)

    if not costume:
        return base_name

    # Costume variants are "<base name> [Costume]". Resolving them off the base
    # character rather than their own alias matters: alt-costume aliases don't
    # reliably contain the codename (Beachflower Marian's alias is "S. Minami").
    if base_name:
        want = f"{base_name} [{costume}]".lower()
        hit = next((c["n"] for c in chars if c["n"].lower() == want), None)
        if hit:
            return hit
    return None


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
    for codename, path in LUFEL:
        name = match_character(codename, chars)
        (matched if name else unmatched).append((codename, path, name))

    for codename, _, name in matched:
        print(f"  {codename:24s} -> {name}")
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
