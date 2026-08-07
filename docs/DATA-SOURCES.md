# Data sources and what to verify

Everything in `src/data.js` was assembled from community guides in August 2026. None of it
was read out of the game client. This document records where each part came from and how
much to trust it, so that whoever corrects it later knows what they are overwriting.

## Confidence by section

### Slots and main stat pools — high

Four slots named Sun, Moon, Star and Sky, plus a fifth Space slot that unlocks around
account level 40. Sun's main stat is always flat HP and Space's is always flat ATK plus flat
DEF; the other three roll from a pool. Prydwen and SetsunaEpic agree on this independently.

Three constraints are load-bearing for the optimiser and worth re-checking first: Ailment
Accuracy only appears as a **Star** main stat, Speed only on **Sky**, and HP Recovery only
on **Moon**. Several character build guides violate one of these, which is how the errors in
those guides were spotted.

### Rarity, levels and substat counts — high

5★ caps at level 25, 4★ at 20, 3★ at 15, 2★ at 10. A card gains or upgrades a substat every
five levels. The cap is **four** substats, not five — guides saying "five stats" are counting
the main stat. 5★ and 4★ cards start with three or four substats; 3★ always three; 2★ always
two.

### Substat roll values — medium, single-sourced

The `maxRoll` figures in `SUBSTATS` come from one source (Prydwen) and were never checked
against the client. They are also assumed to be 5★ values with no rarity scaling, which may
be wrong. One published Space-card figure (DEF% third-tier roll) breaks monotonicity and is
almost certainly a typo in the source.

These numbers matter more than they look: every substat is scored as `value / maxRoll`, so a
wrong `maxRoll` systematically over- or under-values that stat for every character.

### Main stat magnitudes — **missing entirely**

No source publishes what a main stat is worth at level 25, nor the drop-rate weighting for
which main stat rolls on Moon, Star and Sky. This is the largest hole in the data. The
optimiser works around it by weighting main stats by *priority* rather than magnitude
(`weight * 3.0`, plus 10 for an exact target match), which is a reasonable ordering but not
a real quantity.

### Four-slot sets — medium, plus four confirmed directly from screenshots

Twenty sets with 2-piece and 4-piece effects, taken from Game8's current English list, plus
four more — **Futility**, **Sorrow**, **Disappointment**, **Change** — added from the user's
own in-game screenshots (Aug 2026) after their account turned out to own real cards in sets
no guide listed. These four are higher-confidence than the guide-sourced twenty: the main
stat and Set Effect text were read straight off the card detail panel, not transcribed by a
third party. `Change` is Electric-elemental like `Renewal` — the game has more than one set
per element, so this is not a naming collision.

The problem is naming. Game8, Prydwen and Fragster each use different translations of the
same sets, and Samurai Gamers uses a fourth scheme covering the Chinese, Taiwanese and
Korean clients. `SET_ALIASES` contains only mappings backed by evidence:

| Alias | Canonical | Evidence |
|---|---|---|
| `strength` | `Power` | Both list Harmony, Trust and Growth as their Space-card pairings |
| `abundance` | `Prosperity` | Effect text matches |
| `science` | `Truth` | Effect text matches |
| `completion` | `Renewal` | Effect text matches |
| `dominion` | `Control` | Effect text matches |
| `valor` | `Courage` | Effect text matches |
| `luxury` | `Opulence` | Effect text matches |
| `interference` | `Hindrance` | Effect text matches |

**Do not add speculative aliases.** A wrong mapping silently rewrites the user's imported
cards to the wrong set, which is worse than failing the import.

Two names could not be matched to anything and are carried as separate `SETS` entries with
`unverified: true` and `bonus2: null`, so the optimiser scores their 2-piece at zero and the
UI flags them:

- **Ruin** — Prydwen gives Makoto Yuki this set with a 4-piece of "ATK +25% for 3 turns,
  triggering again after a Theurgy". An earlier source described Ruin as a Curse set
  identical to Hindrance. The two descriptions are incompatible, so one source is wrong.
- **Prudence** — appears on Wind single-target builds (Seiji Shiratori, Frostgale Kotone).
  Plausibly the Wind set under another name, but the pairing evidence that settled
  `strength = Power` does not exist here.

### Space cards — medium

Sixteen Space cards. Each grants a conditional effect that keys off whichever 4-piece set is
active, so a Space card does nothing without a full 4-piece. Game8 lists fourteen with 34
documented pairings; Fragster lists only eight, so the list may still be incomplete.
**Hope** is a fifteenth, added from Makoto Yuki's build page, and its pairing with Ruin is
inferred rather than documented. **Perseverance** is a sixteenth, confirmed directly from a
user screenshot of its own Set Effect panel — that panel listed pairings with `Change` and
`Sorrow`, but since only two fit on screen there may be more that aren't recorded yet.

### Characters — mixed, flagged per entry

Sixty-three entries, each carrying a `conf` field the UI displays:

- **`high`** (about 35) — a full published build exists, usually a Prydwen character page.
- **`med`** (5) — published, but sources conflicted or were vague. Panther's slot list
  appeared shifted by one; Vino's Moon and Sky were "HP or offensive"; Tropical Closer's
  Space card differs between Prydwen and dbltap; Howler's build assigned Ailment Accuracy to
  a slot that cannot roll it; Justine and Caroline have six selectable roles with no
  per-role builds published.
- **`low`** (25) — no published build. These carry archetype defaults generated from the
  character's role, and the interface says so in an orange banner on the Optimise tab.
  Most of the Persona 3 collaboration units and every alternate costume fall here.

One further caution: Prydwen's roster listing page and its individual character pages
disagree on rarity for at least six characters. The character pages were treated as
authoritative.

## Sources

- Prydwen — [Arcana Cards guide](https://www.prydwen.gg/persona-5x/guides/arcana-cards),
  [character list](https://www.prydwen.gg/persona-5x/characters), and individual pages at
  `prydwen.gg/persona-5x/characters/<slug>`
- Game8 — [all Revelation Cards](https://game8.co/games/Persona-5-Phantom-X/archives/532937),
  [stats guide](https://game8.co/games/Persona-5-Phantom-X/archives/537907),
  [all characters](https://game8.co/games/Persona-5-Phantom-X/archives/530627)
- [TheGamer](https://www.thegamer.com/persona-5-the-phantom-x-revelation-cards-gear-artifacts-guide/),
  [DBLTap](https://www.dbltap.com/guides/p5x-best-revelation-cards-every-character),
  [SetsunaEpic](https://setsunaepic.com/persona-5-the-phantom-x-revelation-cards-guide/),
  [Fragster](https://www.fragster.com/persona-5-the-phantom-x-revelation-cards-complete-list-and-effects/)
- Steam community build guides for the archetype fallback rules

Lufelnet (`lufel.net`) is likely the best source for the missing main-stat magnitudes, but
it renders client-side and returns an empty template to fetchers. It needs a real browser.

## Priority order for corrections

1. Main stat magnitudes at max level — the only completely missing piece.
2. Whether `Ruin` and `Prudence` are real distinct sets, and their 2-piece effects.
3. Substat `maxRoll` values, spot-checked against a few real cards.
4. Builds for the 25 `low`-confidence characters.

Correcting the data beats tuning the scoring constants. The engine is only as good as the
numbers behind it.
