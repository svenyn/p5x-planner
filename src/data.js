/* P5X Revelation Card data — extracted from community sources, Aug 2026.
   Slot names: Sun / Moon / Star / Sky (aka Planet) / Space (aka Universe). */

const SLOTS = ['Sun', 'Moon', 'Star', 'Sky', 'Space'];

const SLOT_INFO = {
  Sun:   { fixed: true,  mains: ['HP'],        note: 'Main stat is always flat HP.' },
  Moon:  { fixed: false, mains: ['ATK%', 'DEF%', 'HP%', 'HP Recovery', 'Damage Multiplier'] },
  Star:  { fixed: false, mains: ['ATK%', 'DEF%', 'HP%', 'Crit Rate', 'Crit Multiplier', 'Ailment Accuracy'] },
  Sky:   { fixed: false, mains: ['ATK%', 'DEF%', 'HP%', 'Speed', 'SP Recovery'] },
  Space: { fixed: true,  mains: ['ATK + DEF'], note: 'Main stat is always flat ATK + flat DEF.' }
};

/* Substat pool. maxRoll = highest single-roll magnitude at 5-star, used to convert
   a raw value into "roll value" so different stats are comparable. */
const SUBSTATS = {
  'ATK':                { flat: true,  maxRoll: 46,   maxRollSpace: 46   },
  'DEF':                { flat: true,  maxRoll: 46,   maxRollSpace: 46   },
  'HP':                 { flat: true,  maxRoll: 140,  maxRollSpace: 175  },
  'Speed':              { flat: true,  maxRoll: 2.2,  maxRollSpace: 2.8  },
  'ATK%':               { flat: false, maxRoll: 3.5,  maxRollSpace: 4.3  },
  'DEF%':               { flat: false, maxRoll: 5.2,  maxRollSpace: 6.4  },
  'HP%':                { flat: false, maxRoll: 3.6,  maxRollSpace: 4.4  },
  'Damage Multiplier':  { flat: false, maxRoll: 2.8,  maxRollSpace: 3.5  },
  'Crit Rate':          { flat: false, maxRoll: 2.0,  maxRollSpace: 2.6  },
  'Crit Multiplier':    { flat: false, maxRoll: 4.1,  maxRollSpace: 5.2  },
  'Ailment Accuracy':   { flat: false, maxRoll: 4.1,  maxRollSpace: 5.2  },
  'SP Recovery':        { flat: false, maxRoll: 10.0, maxRollSpace: 12.5 },
  'Resistance Pierce':  { flat: false, maxRoll: 2.1,  maxRollSpace: 2.7  }
};

/* Common aliases from other guide sites, so imported/pasted data still matches. */
const STAT_ALIASES = {
  'crit dmg': 'Crit Multiplier', 'crit damage': 'Crit Multiplier', 'cdmg': 'Crit Multiplier',
  'crit mult': 'Crit Multiplier', 'cm': 'Crit Multiplier',
  'cr': 'Crit Rate', 'critrate': 'Crit Rate', 'crit': 'Crit Rate',
  'effect hit rate': 'Ailment Accuracy', 'ehr': 'Ailment Accuracy', 'ail acc': 'Ailment Accuracy',
  'ailment acc': 'Ailment Accuracy', 'accuracy': 'Ailment Accuracy',
  'penetration': 'Resistance Pierce', 'pen': 'Resistance Pierce', 'pierce': 'Resistance Pierce',
  'resistance pierce rate': 'Resistance Pierce',
  'damage bonus': 'Damage Multiplier', 'dmg bonus': 'Damage Multiplier',
  'attack multiplier': 'Damage Multiplier', 'dmg mult': 'Damage Multiplier', 'dmg': 'Damage Multiplier',
  'sp regen': 'SP Recovery', 'sp rec': 'SP Recovery', 'spd': 'Speed',
  'atk': 'ATK', 'def': 'DEF', 'hp': 'HP', 'hp rec': 'HP Recovery', 'healing': 'HP Recovery'
};

const RARITY = {
  5: { name: 'Legendary', color: 'gold',   maxLevel: 25, subMin: 3, subMax: 4, upgrades: 5 },
  4: { name: 'Epic',      color: 'purple', maxLevel: 20, subMin: 3, subMax: 4, upgrades: 4 },
  3: { name: 'Rare',      color: 'blue',   maxLevel: 15, subMin: 3, subMax: 3, upgrades: 3 },
  2: { name: 'Common',    color: 'gray',   maxLevel: 10, subMin: 2, subMax: 2, upgrades: 2 }
};

const ELEMENTS = ['Physical','Gun','Fire','Ice','Electric','Wind','Psychokinesis','Nuclear','Bless','Curse','Almighty','None'];

/* The 20 four-slot ("Heavens") sets.
   bonus2 describes the 2-piece effect numerically where it maps to a stat, so the
   optimiser can value it. elem = only useful to characters of that element. */
const SETS = {
  'Power':          { p2: 'ATK +12%',                 bonus2: { stat: 'ATK%', amt: 12 },
                      p4: 'ATK +10% every 6 turns, stacks 3x' },
  'Control':        { p2: 'Max HP +12%',              bonus2: { stat: 'HP%', amt: 12 },
                      p4: 'Skill attacks deal bonus damage equal to 8% of own HP' },
  'Labor':          { p2: 'Max HP +12%',              bonus2: { stat: 'HP%', amt: 12 },
                      p4: 'Party max HP, ATK and DEF +8%' },
  'Peace':          { p2: 'DEF +20%',                 bonus2: { stat: 'DEF%', amt: 20 },
                      p4: 'Shield strength +18%' },
  'Prosperity':     { p2: 'Damage taken -8%',         bonus2: { stat: 'DEF%', amt: 10 },
                      p4: 'Battle start: fill Highlight gauge 25%' },
  'Worry':          { p2: 'SP recovery +80%',         bonus2: { stat: 'SP Recovery', amt: 80 },
                      p4: 'Battle start: fill Highlight gauge 25%' },
  'Reconciliation': { p2: 'Speed +6',                 bonus2: { stat: 'Speed', amt: 6 },
                      p4: 'In battle: own max HP, ATK and DEF +15%' },
  'Triumph':        { p2: 'Crit Rate +7.5%',          bonus2: { stat: 'Crit Rate', amt: 7.5 },
                      p4: 'Resonance damage +40%' },
  'Love':           { p2: 'Healing +9%',              bonus2: { stat: 'HP Recovery', amt: 9 },
                      p4: 'Healing to allies below 50% HP +23%' },
  'Courage':        { p2: 'Physical damage +10%',     bonus2: { stat: 'Damage Multiplier', amt: 10 }, elem: 'Physical',
                      p4: 'Crit Multiplier +30% for 2 turns' },
  'Oppression':     { p2: 'Physical damage +10%',     bonus2: { stat: 'Damage Multiplier', amt: 10 }, elem: 'Physical',
                      p4: 'Gain Malice: ATK +5% for 2 turns, stacks 6x' },
  'Strife':         { p2: 'Fire damage +10%',         bonus2: { stat: 'Damage Multiplier', amt: 10 }, elem: 'Fire',
                      p4: 'ATK +15% if target is weak to Fire' },
  'Defeat':         { p2: 'Ailment accuracy +15%',    bonus2: { stat: 'Ailment Accuracy', amt: 15 },
                      p4: 'Fire damage to debuffed foes +20%' },
  'Opulence':       { p2: 'Ice damage +10%',          bonus2: { stat: 'Damage Multiplier', amt: 10 }, elem: 'Ice',
                      p4: 'Resonance damage +40%' },
  'Renewal':        { p2: 'Electric damage +10%',     bonus2: { stat: 'Damage Multiplier', amt: 10 }, elem: 'Electric',
                      p4: 'Own Electric damage +9% after allies use Electric skills' },
  'Victory':        { p2: 'Wind damage +10%',         bonus2: { stat: 'Damage Multiplier', amt: 10 }, elem: 'Wind',
                      p4: '25% chance to deal bonus damage equal to 20% of ATK' },
  'Pleasure':       { p2: 'Psychokinesis damage +10%',bonus2: { stat: 'Damage Multiplier', amt: 10 }, elem: 'Psychokinesis',
                      p4: 'ATK +15% when dealing Psychokinesis damage' },
  'Truth':          { p2: 'Nuclear damage +10%',      bonus2: { stat: 'Damage Multiplier', amt: 10 }, elem: 'Nuclear',
                      p4: 'Deal 30% of ATK as damage to targets with elemental ailments' },
  'Virtue':         { p2: 'Bless damage +10%',        bonus2: { stat: 'Damage Multiplier', amt: 10 }, elem: 'Bless',
                      p4: 'Bless skill crit rate +12% while HP >= 50%' },
  'Hindrance':      { p2: 'Curse damage +10%',        bonus2: { stat: 'Damage Multiplier', amt: 10 }, elem: 'Curse',
                      p4: 'Curse damage to debuffed foes +20%' },

  /* --- Sets that appear in build guides but not in the set list I could verify.
     Their 2-piece effects are unknown, so the optimiser values them at 0 and the
     tool flags them. Correct these against the game and the maths follows. --- */
  'Ruin':           { p2: 'Unverified', bonus2: null, unverified: true,
                      p4: 'ATK +25% for 3 turns; triggers again after using a Theurgy' },
  'Prudence':       { p2: 'Unverified', bonus2: null, unverified: true,
                      p4: 'Unverified — appears on Wind single-target builds' }
};

/* Alternate localisations. Guide sites do not agree on set names: Game8 uses one set
   of translations, Prydwen another, Fragster and Samurai Gamers a third. Only mappings
   with solid evidence are listed here — a wrong alias would silently corrupt imports.
   'Strength' -> 'Power' is confirmed by their Space-card pairings both being
   Harmony / Trust / Growth. */
const SET_ALIASES = {
  'abundance': 'Prosperity', 'science': 'Truth', 'completion': 'Renewal', 'dominion': 'Control',
  'valor': 'Courage', 'luxury': 'Opulence', 'interference': 'Hindrance', 'strength': 'Power'
};

/* Space (Universe) cards — one slot only. Each has conditional effects that key off
   whichever 4-piece Heavens set is active. `pairs` lists the Heavens sets it works with. */
const SPACE_SETS = {
  'Creation':   { pairs: ['Worry','Reconciliation'],            note: 'SP thresholds grant Crit Multiplier; or buffs the slowest ally.' },
  'Freedom':    { pairs: ['Triumph','Defeat'],                  note: 'Glory stacks raise pierce rate; or party damage vs debuffed foes.' },
  'Acceptance': { pairs: ['Love','Strife','Peace'],             note: 'ATK after healing; ATK per foe; or DEF after taking damage.' },
  'Awareness':  { pairs: ['Truth','Control','Hindrance'],       note: 'Bonus damage vs ailment-afflicted foes; Fire party buff; ATK stacking.' },
  'Departure':  { pairs: ['Control','Prosperity','Hindrance'],  note: 'DEF shred on skill; party damage after attacking; ATK after a kill.' },
  'Faith':      { pairs: ['Love','Peace'],                      note: 'Healing scales with max HP; or shields grant DEF.' },
  'Growth':     { pairs: ['Opulence','Renewal','Power'],        note: 'Ice stacking; Resonance crit damage; or raises Power ATK stack cap.' },
  'Harmony':    { pairs: ['Victory','Power','Truth'],           note: 'Vulnerability on set proc; same-attribute party damage; Nuclear stacking.' },
  'Integrity':  { pairs: ['Pleasure','Labor'],                  note: 'Damage scales off healing; or Elucidator party stat boost.' },
  'Meditation': { pairs: ['Love','Courage','Opulence'],         note: 'Healing after crit; Physical/Electric damage; Resonance crit damage.' },
  'Nativity':   { pairs: ['Power'],                             note: 'Justine & Caroline only — Desire Level +5%.' },
  'Resolve':    { pairs: ['Virtue','Labor'],                    note: 'HP thresholds grant damage; or Elucidator DEF shred.' },
  'Trust':      { pairs: ['Renewal','Power','Prosperity'],      note: 'Electric party buff; ATK to allies at battle start; party damage after supporting.' },
  'Wisdom':     { pairs: ['Oppression','Pleasure','Virtue'],    note: 'Malice thresholds; damage from ailment accuracy; ATK after Highlight.' },
  'Hope':       { pairs: ['Hindrance'],                         note: 'Used on Makoto Yuki builds.' }
};

/* ---- Archetype defaults: main stats and substat weights (0-10) ---------------- */
const ARCHETYPES = {
  'ST DPS': {
    label: 'Single-target DPS',
    main: { Moon: 'Damage Multiplier', Star: 'Crit Rate', Sky: 'ATK%' },
    w: { 'Crit Rate': 9, 'Crit Multiplier': 9, 'Damage Multiplier': 7, 'ATK%': 6, 'Resistance Pierce': 6,
         'Speed': 3, 'ATK': 2, 'SP Recovery': 1, 'Ailment Accuracy': 1, 'HP%': 0, 'DEF%': 0, 'HP': 0, 'DEF': 0 }
  },
  'AoE DPS': {
    label: 'AoE sweeper',
    main: { Moon: 'Damage Multiplier', Star: 'Crit Rate', Sky: 'ATK%' },
    w: { 'Crit Rate': 9, 'Crit Multiplier': 9, 'Damage Multiplier': 7, 'ATK%': 6, 'Resistance Pierce': 6,
         'Speed': 4, 'ATK': 2, 'SP Recovery': 1, 'Ailment Accuracy': 1, 'HP%': 0, 'DEF%': 0, 'HP': 0, 'DEF': 0 }
  },
  'Healer': {
    label: 'Healer',
    main: { Moon: 'HP Recovery', Star: 'HP%', Sky: 'ATK%' },
    w: { 'SP Recovery': 8, 'HP%': 6, 'ATK%': 5, 'Speed': 5, 'HP': 3, 'Crit Rate': 2, 'Crit Multiplier': 2,
         'DEF%': 1, 'Damage Multiplier': 1, 'ATK': 1, 'DEF': 0, 'Ailment Accuracy': 0, 'Resistance Pierce': 0 }
  },
  'Guardian': {
    label: 'Guardian / tank',
    main: { Moon: 'DEF%', Star: 'DEF%', Sky: 'DEF%' },
    w: { 'DEF%': 8, 'HP%': 8, 'SP Recovery': 7, 'Speed': 5, 'HP': 4, 'DEF': 4, 'ATK%': 1,
         'Ailment Accuracy': 1, 'Crit Rate': 0, 'Crit Multiplier': 0, 'Damage Multiplier': 0, 'ATK': 0, 'Resistance Pierce': 0 }
  },
  'Strategist': {
    label: 'Strategist / buffer',
    main: { Moon: 'ATK%', Star: 'ATK%', Sky: 'ATK%' },
    w: { 'ATK%': 8, 'Speed': 6, 'HP%': 5, 'SP Recovery': 5, 'ATK': 3, 'Crit Rate': 2, 'Crit Multiplier': 2,
         'Ailment Accuracy': 2, 'Damage Multiplier': 2, 'DEF%': 1, 'HP': 1, 'DEF': 0, 'Resistance Pierce': 0 }
  },
  'Saboteur': {
    label: 'Saboteur / debuffer',
    main: { Moon: 'Damage Multiplier', Star: 'Ailment Accuracy', Sky: 'Speed' },
    w: { 'Ailment Accuracy': 9, 'Speed': 7, 'ATK%': 5, 'HP%': 4, 'Damage Multiplier': 4, 'Crit Rate': 3,
         'Crit Multiplier': 3, 'Resistance Pierce': 3, 'SP Recovery': 3, 'ATK': 1, 'DEF%': 1, 'HP': 1, 'DEF': 0 }
  },
  'Navigator': {
    label: 'Navigator / Elucidator',
    main: { Moon: 'ATK%', Star: 'Crit Rate', Sky: 'ATK%' },
    w: { 'Crit Rate': 8, 'Crit Multiplier': 8, 'ATK%': 7, 'Resistance Pierce': 5, 'Damage Multiplier': 4,
         'ATK': 3, 'Speed': 3, 'SP Recovery': 2, 'HP%': 1, 'Ailment Accuracy': 1, 'DEF%': 0, 'HP': 0, 'DEF': 0 }
  },
  'Virtuoso': {
    label: 'Virtuoso / flex',
    main: { Moon: 'Damage Multiplier', Star: 'Crit Multiplier', Sky: 'ATK%' },
    w: { 'Crit Multiplier': 8, 'Crit Rate': 8, 'Damage Multiplier': 6, 'ATK%': 6, 'Resistance Pierce': 5,
         'Speed': 4, 'ATK': 2, 'HP%': 1, 'SP Recovery': 1, 'Ailment Accuracy': 1, 'DEF%': 0, 'HP': 0, 'DEF': 0 }
  }
};

/* ---- Roster --------------------------------------------------------------------
   conf: 'high'   = full published build (Prydwen character page)
         'med'    = published but sources conflicted or were vague
         'low'    = no published build; archetype defaults applied, treat as a guess
   sets: preferred 4-piece Heavens sets, best first.  space: preferred Space card.
   ov:   overrides — main (per-slot main stat), w (weight tweaks), bp (breakpoints), note
--------------------------------------------------------------------------------- */
const CHARACTERS = [
  // --- Phantom Thieves core ---
  { n:'Ren Amamiya', a:'Joker', r:5, e:'Curse', arch:'AoE DPS', conf:'high',
    sets:['Hindrance'], space:'Departure',
    ov:{ main:{Moon:'Damage Multiplier',Star:'Crit Rate',Sky:'ATK%'}, w:{'Resistance Pierce':9} } },
  { n:'Ren Amamiya [Starlight]', a:'Starlight Joker', r:5, e:'Curse', arch:'Virtuoso', conf:'low', sets:['Hindrance'], space:'Departure' },
  { n:'Morgana', a:'Mona', r:5, e:'Wind', arch:'Healer', conf:'high',
    sets:['Love'], space:'Meditation',
    ov:{ main:{Moon:'HP Recovery',Star:'Crit Rate',Sky:'ATK%'}, w:{'Crit Rate':7,'SP Recovery':8,'ATK%':6},
         bp:'Love 4pc boosts healing to allies below 50% HP; Morgana heals from 70%, so the 4pc is partly wasted.' } },
  { n:'Morgana [Starlight]', a:'Starlight Mona', r:5, e:'Wind', arch:'Saboteur', conf:'low', sets:['Victory'], space:'Harmony' },
  { n:'Ann Takamaki', a:'Panther', r:5, e:'Fire', arch:'AoE DPS', conf:'med',
    sets:['Strife'], space:'Acceptance',
    ov:{ note:'Source slot list appeared shifted by one — verify main stats in game.' } },
  { n:'Ann Takamaki [Starlight]', a:'Starlight Panther', r:5, e:'Fire', arch:'ST DPS', conf:'low', sets:['Strife'], space:'Acceptance' },
  { n:'Ryuji Sakamoto', a:'Skull', r:5, e:'Physical', arch:'ST DPS', conf:'high',
    sets:['Courage','Oppression'], space:'Meditation',
    ov:{ main:{Star:'Crit Multiplier'}, w:{'Crit Rate':0,'Crit Multiplier':10,'Resistance Pierce':8},
         bp:'Skull always crits — Crit Rate is dead weight. Go Crit Multiplier on Star and ignore CR substats entirely.' } },
  { n:'Yusuke Kitagawa', a:'Fox', r:5, e:'Ice', arch:'AoE DPS', conf:'high',
    sets:['Opulence'], space:'Meditation',
    ov:{ main:{Moon:'DEF%',Star:'Crit Rate',Sky:'DEF%'}, w:{'DEF%':9,'Speed':9,'ATK%':1,'DEF':4},
         bp:'Scales off DEF, not ATK. Target 106+ Speed to act before your supports.' } },
  { n:'Makoto Niijima', a:'Queen', r:5, e:'Nuclear', arch:'ST DPS', conf:'high',
    sets:['Truth'], space:'Awareness',
    ov:{ main:{Moon:'ATK%'}, bp:'Truth 4pc only fires on foes already under an elemental ailment — pair with a Saboteur.' } },
  { n:'Haru Okumura', a:'Noir', r:5, e:'Psychokinesis', arch:'AoE DPS', conf:'high',
    sets:['Pleasure'], space:'Wisdom',
    ov:{ main:{Star:'Crit Multiplier'}, w:{'Crit Multiplier':10,'Ailment Accuracy':7,'Resistance Pierce':7},
         bp:'Target 150 Ailment Accuracy in battle — her passive converts it into damage.' } },
  { n:'Goro Akechi', a:'Crow', r:5, e:'Almighty', arch:'AoE DPS', conf:'low', sets:['Power'], space:'Harmony' },
  { n:'Kasumi Yoshizawa', a:'Violet', r:5, e:'Bless', arch:'ST DPS', conf:'med',
    sets:['Virtue'], space:'Wisdom',
    ov:{ bp:'No stat breakpoints — she self-buffs ATK heavily, so prioritise crit.' } },
  { n:'Futaba Sakura', a:'Oracle', r:5, e:'None', arch:'Navigator', conf:'high',
    sets:['Labor'], space:'Resolve',
    ov:{ main:{Moon:'ATK%',Star:'Crit Rate',Sky:'ATK%'}, w:{'Crit Rate':9,'Crit Multiplier':9},
         bp:'Target 4600 ATK in battle. At A1 shift priority toward Crit Multiplier.' } },

  // --- Original cast ---
  { n:'Wonder', a:'Nagisa Kamishiro', r:5, e:'Almighty', arch:'Virtuoso', conf:'low',
    ov:{ note:'The protagonist — built through the Persona system, not the gacha. No published Revelation build.' },
    sets:['Power'], space:'Harmony' },
  { n:'Ayaka Sakai', a:'Chord', r:5, e:'Electric', arch:'Strategist', conf:'high',
    sets:['Prosperity'], space:'Trust',
    ov:{ main:{Moon:'HP Recovery',Star:'HP%',Sky:'HP%'}, w:{'ATK%':8,'HP%':7,'Speed':7},
         bp:'105-106 Speed. If you are not capping her skills, aim for 5083+ ATK.' } },
  { n:'Chizuko Nagao', a:'Vino', r:4, e:'Nuclear', arch:'Saboteur', conf:'med',
    sets:['Control','Truth'], space:'Departure',
    ov:{ main:{Star:'Ailment Accuracy'}, note:'Sources were vague on Moon/Sky — HP or offensive both viable.' } },
  { n:'Leo Kamiyama', a:'Leon', r:4, e:'Nuclear', arch:'Strategist', conf:'high', sets:['Prosperity'], space:'Trust' },
  { n:'Lufel', a:'Cattle', r:4, e:'Fire', arch:'Healer', conf:'high',
    sets:['Love','Prosperity'], space:'Acceptance',
    ov:{ main:{Moon:'HP Recovery',Star:'ATK%',Sky:'ATK%'}, w:{'SP Recovery':9,'ATK%':7,'HP%':5} } },
  { n:'Masaki Ashiya', a:'Cherish', r:5, e:'Ice', arch:'Guardian', conf:'high',
    sets:['Peace','Prosperity'], space:'Faith',
    ov:{ w:{'SP Recovery':9,'DEF%':9} } },
  { n:'Minami Miyashita', a:'Marian', r:5, e:'Bless', arch:'Healer', conf:'high',
    sets:['Prosperity'], space:'Trust',
    ov:{ main:{Moon:'HP%',Star:'HP%',Sky:'HP%'}, w:{'SP Recovery':10,'HP%':7,'Speed':7},
         bp:'Base Speed is only 94 — she needs Speed substats. Target 80%+ SP Recovery.' } },
  { n:'Minami Miyashita [Beachflower]', a:'S. Minami', r:5, e:'Bless', arch:'Strategist', conf:'low', sets:['Prosperity'], space:'Trust' },
  { n:'Miyu Sahara', a:'Puppet', r:4, e:'None', arch:'Navigator', conf:'high',
    sets:['Labor','Peace'], space:'Integrity',
    ov:{ main:{Moon:'DEF%',Star:'Crit Rate',Sky:'DEF%'}, w:{'DEF%':7,'Resistance Pierce':7} } },
  { n:'Miyu Sahara [Wavecatcher]', a:'Wave Puppet', r:5, e:'Ice', arch:'AoE DPS', conf:'low', sets:['Opulence'], space:'Meditation' },
  { n:'Motoha Arai', a:'Closer', r:4, e:'Electric', arch:'AoE DPS', conf:'high',
    sets:['Renewal'], space:'Trust',
    ov:{ main:{Moon:'ATK%'}, bp:'Wants enemies Shocked — pair with an Electric applier.' } },
  { n:'Motoha Arai [Radiance]', a:'Radiance Closer', r:5, e:'Electric', arch:'ST DPS', conf:'low', sets:['Renewal'], space:'Growth' },
  { n:'Motoha Arai [Tropical]', a:'Summer Closer', r:5, e:'Bless', arch:'AoE DPS', conf:'med',
    sets:['Virtue'], space:'Resolve',
    ov:{ main:{Moon:'ATK%'}, w:{'Resistance Pierce':10},
         note:'Prydwen says Resolve space card, dbltap says Wisdom. HP-cost kit — pair with Marian or Chord.',
         bp:'At A1+ switch Star from Crit Rate to Crit Multiplier.' } },
  { n:'Narumi Nashimoto', a:'PINKY', r:5, e:'Psychokinesis', arch:'ST DPS', conf:'low', sets:['Pleasure'], space:'Wisdom' },
  { n:'Riko Tanemura', a:'Wind', r:4, e:'None', arch:'Navigator', conf:'high',
    sets:['Labor'], space:'Resolve',
    ov:{ main:{Moon:'ATK%',Star:'Crit Rate',Sky:'Speed'}, w:{'Speed':10,'Crit Rate':9,'Crit Multiplier':8},
         bp:'160 Speed caps her first Talent. Speed is the priority stat, above crit.' } },
  { n:'Riko Tanemura [Tempest]', a:'Wind Vast', r:5, e:'Wind', arch:'Strategist', conf:'low', sets:['Prosperity'], space:'Trust' },
  { n:'Runa Dogenzaka', a:'Howler', r:5, e:'Fire', arch:'Saboteur', conf:'med',
    sets:['Reconciliation','Defeat'], space:'Creation',
    ov:{ main:{Moon:'HP%',Star:'Ailment Accuracy',Sky:'Speed'},
         note:'One source assigned Ailment Accuracy to both Star and Sky — Sky cannot roll it, so Star only.' } },
  { n:'Seiji Shiratori', a:'Fleuret', r:4, e:'Wind', arch:'ST DPS', conf:'high',
    sets:['Prudence','Victory'], space:'Resolve',
    ov:{ main:{Star:'Crit Multiplier'}, w:{'Crit Multiplier':10},
         bp:'Needs an ally to apply Windswept before his payoff skill.' } },
  { n:'Shoki Ikenami', a:'Luce', r:4, e:'Bless', arch:'Strategist', conf:'low', sets:['Prosperity'], space:'Trust' },
  { n:'Shoki Ikenami [Notte]', a:'Luce Notte', r:5, e:'Bless', arch:'AoE DPS', conf:'low', sets:['Virtue'], space:'Wisdom' },
  { n:'Shun Kano', a:'Soy', r:4, e:'Ice', arch:'Guardian', conf:'high',
    sets:['Control','Prosperity'], space:'Departure',
    ov:{ main:{Moon:'HP%',Star:'HP%',Sky:'HP%'}, w:{'HP%':9,'Crit Rate':4,'DEF%':4},
         note:'Classed as a Guardian but plays as a debuffer. His gun attack triggers All-Out Attacks.' } },
  { n:'Shun Kano [Pioneer]', a:'Soy Pioneer', r:5, e:'Gun', arch:'Guardian', conf:'low', sets:['Peace'], space:'Faith' },
  { n:'Tomoko Noge', a:'Moko', r:4, e:'Psychokinesis', arch:'Strategist', conf:'high',
    sets:['Prosperity','Power'], space:'Trust', ov:{ w:{'ATK%':9,'HP%':5,'Ailment Accuracy':3} } },
  { n:'Tomoko Noge [Seaside]', a:'Summer Moko', r:5, e:'Psychokinesis', arch:'Healer', conf:'high',
    sets:['Prosperity','Victory'], space:'Trust',
    ov:{ main:{Moon:'HP Recovery',Star:'Crit Rate',Sky:'ATK%'}, w:{'Crit Rate':8,'ATK%':8,'SP Recovery':7},
         note:'Buffs party Ailment Accuracy. ATK main on Star is also viable — it boosts her healing.' } },
  { n:'Toshiya Sumi', a:'Sepia', r:4, e:'Curse', arch:'ST DPS', conf:'high',
    sets:['Hindrance'], space:'Awareness',
    ov:{ main:{Star:'Ailment Accuracy'}, w:{'Ailment Accuracy':10,'Damage Multiplier':8,'Crit Rate':4},
         bp:'Wants external Ailment Accuracy support on top of his own.' } },
  { n:'YUI', a:'BUI', r:5, e:'Electric', arch:'ST DPS', conf:'high',
    sets:['Renewal'], space:'Growth',
    ov:{ main:{Moon:'ATK%'}, w:{'Crit Multiplier':10,'Resistance Pierce':9,'Crit Rate':6},
         bp:'At A1, switch Star to Crit Multiplier and stop building Crit Rate.' } },
  { n:'YUI [Prism]', a:'BUI Prism', r:5, e:'Nuclear', arch:'ST DPS', conf:'low', sets:['Truth'], space:'Awareness' },
  { n:'Yaoling Li', a:'Rin', r:5, e:'Curse', arch:'Saboteur', conf:'high',
    sets:['Prosperity','Control'], space:'Departure',
    ov:{ main:{Moon:'Damage Multiplier',Star:'Crit Rate',Sky:'Speed'}, w:{'Speed':10,'Crit Rate':8,'Ailment Accuracy':6},
         bp:'Speed IS her scaling: -3% enemy DEF per 10 Speed, capping at -49.7% around 166 Speed.' } },
  { n:'Yaoling Li [Firecracker]', a:'Rin Lion Dance', r:5, e:'Fire', arch:'AoE DPS', conf:'low', sets:['Strife'], space:'Acceptance' },
  { n:'Kotone Montagne', a:'Mont', r:4, e:'Ice', arch:'ST DPS', conf:'high',
    sets:['Opulence'], space:'Meditation',
    ov:{ main:{Star:'Crit Multiplier'}, w:{'Crit Multiplier':10} } },
  { n:'Kotone Montagne [Frostgale]', a:'Frostgale Mont', r:5, e:'Wind', arch:'ST DPS', conf:'high',
    sets:['Prudence','Victory'], space:'Resolve',
    ov:{ main:{Star:'Crit Multiplier'}, note:'Dual Wind/Ice — Wind mode is the one people play.' } },
  { n:'Kira Kitazato', a:'Messa', r:5, e:'Physical', arch:'ST DPS', conf:'high',
    sets:['Oppression','Pleasure'], space:'Wisdom',
    ov:{ main:{Moon:'Damage Multiplier',Star:'ATK%',Sky:'ATK%'},
         w:{'Crit Rate':0,'Crit Multiplier':0,'Damage Multiplier':10,'Ailment Accuracy':8,'ATK%':8},
         bp:'His Rending damage CANNOT crit — skip crit entirely. Target 90% Ailment Accuracy.' } },
  { n:'Kiyoshi Kurotani', a:'Key', r:4, e:'Fire', arch:'Saboteur', conf:'high',
    sets:['Control','Prosperity'], space:'Awareness',
    ov:{ main:{Moon:'HP%',Star:'HP%',Sky:'HP%'}, w:{'HP%':9,'Ailment Accuracy':7},
         note:'Fire-team only — built around enabling Panther.' } },
  { n:'Kayo Tomiyama', a:'Okyann', r:4, e:'None', arch:'Navigator', conf:'high',
    sets:['Labor','Prosperity'], space:'Integrity' },
  { n:'Haruna Nishimori', a:'Riddle', r:5, e:'Psychokinesis', arch:'Strategist', conf:'high',
    sets:['Prosperity','Power'], space:'Trust',
    ov:{ w:{'ATK%':9,'HP%':5}, note:'Her buff proc is 40% RNG (60% at A2). Rated poorly on the CN server.' } },
  { n:'Justine & Caroline', a:'Twins', r:5, e:'Almighty', arch:'Virtuoso', conf:'med',
    sets:['Reconciliation','Power'], space:'Nativity',
    ov:{ main:{Star:'Crit Multiplier'}, note:'Six selectable roles; per-role builds are not published. This is one generic setup.' } },

  // --- Persona 3 collaboration ---
  { n:'Makoto Yuki', a:'', r:5, e:'Fire', arch:'ST DPS', conf:'high',
    sets:['Ruin','Strife'], space:'Hope',
    ov:{ main:{Moon:'Damage Multiplier',Star:'Crit Rate',Sky:'ATK%'},
         w:{'Crit Rate':10,'Crit Multiplier':9,'Resistance Pierce':8,'Damage Multiplier':6},
         note:'Prydwen names his set "Ruin" with a 4-piece ATK buff. That set is not in the set list I could verify, so its 2-piece effect is unknown — check it in game.' } },
  { n:'Aigis', a:'', r:5, e:'Gun', arch:'AoE DPS', conf:'low', sets:['Power'], space:'Harmony' },
  { n:'Akihiko Sanada', a:'', r:5, e:'Electric', arch:'AoE DPS', conf:'low', sets:['Renewal'], space:'Trust' },
  { n:'Junpei Iori', a:'', r:5, e:'Fire', arch:'Guardian', conf:'low', sets:['Peace','Control'], space:'Faith',
    ov:{ main:{Moon:'HP%',Star:'HP%',Sky:'HP%'}, note:'His 5-star weapon gives +57% max HP, so an HP build is the likely direction.' } },
  { n:'Mitsuru Kirijo', a:'', r:5, e:'Ice', arch:'ST DPS', conf:'low', sets:['Opulence'], space:'Meditation' },
  { n:'Yukari Takeba', a:'', r:5, e:'Wind', arch:'Healer', conf:'low', sets:['Love'], space:'Acceptance' },
  { n:'Fuuka Yamagishi', a:'', r:5, e:'None', arch:'Navigator', conf:'low', sets:['Labor'], space:'Integrity' },
  { n:'Koromaru', a:'', r:5, e:'Curse', arch:'Saboteur', conf:'low', sets:['Hindrance'], space:'Awareness',
    ov:{ note:'His 5-star weapon is ailment-accuracy focused.' } },

  // --- Newer units with no published build ---
  { n:'Mio Natsukawa', a:'Matoi', r:5, e:'Ice', arch:'Saboteur', conf:'low', sets:['Opulence','Defeat'], space:'Awareness',
    ov:{ note:'Kit is Ice Technical / ailment focused, so Ailment Accuracy is the likely priority.' } },
  { n:'Mayumi Hashimoto', a:'Turbo', r:5, e:'Physical', arch:'Strategist', conf:'low', sets:['Prosperity'], space:'Trust',
    ov:{ main:{Sky:'Speed'}, w:{'Speed':9}, note:'Her 5-star weapon scales with Speed.' } },
  { n:'Kumi Katayama', a:'Blitz', r:5, e:'Electric', arch:'Saboteur', conf:'low', sets:['Renewal','Defeat'], space:'Trust',
    ov:{ main:{Sky:'Speed'}, note:'Her 5-star weapon grants Speed.' } },
  { n:'Ichigo Shikano', a:'Berry', r:5, e:'Curse', arch:'ST DPS', conf:'low', sets:['Hindrance'], space:'Departure' },
  { n:'Aran Hirano', a:'Anri', r:4, e:'Curse', arch:'Saboteur', conf:'low', sets:['Hindrance','Defeat'], space:'Awareness',
    ov:{ note:'Kit revolves around Ailment Accuracy and Sin transfer.' } },
  { n:'Manaka Nagao', a:'Ange', r:5, e:'None', arch:'Navigator', conf:'low', sets:['Labor'], space:'Integrity' }
];
