// Generated from PokeAPI (https://pokeapi.co). Do not hand-edit the table.
//
// The roster is data, not behaviour: every rule about what a Pokemon is worth,
// how rarely it appears and what a catch pays out lives below in code, so the
// table only has to be right about identity.
'use strict';

/**
 * Wild Pokemon for the chat.
 *
 * A Pokemon spawns in a group every fifteen minutes as a picture, and the first
 * person to REPLY to that message with its name catches it. Replying rather than
 * typing a command is the whole point: the message it answers is the lock, so
 * two people cannot claim the same spawn, and the spawn's own message id is the
 * only thing that identifies which Pokemon is on the table right now.
 *
 * Images are the official artwork sprites from the PokeAPI sprite repository.
 * They are addressed by a URL, so the bot never downloads an image and never
 * has to care whether one is reachable — Facebook fetches it.
 */

const SPRITES = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork';

/** How often a group gets a new spawn, in milliseconds. */
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How long a spawn survives if nobody catches it.
 *
 * SHORTER THAN THE INTERVAL, on purpose. A spawn that outlives its own
 * interval holds the group's slot — `hasLiveSpawn` says there is still one on
 * the table — so a Pokemon nobody wanted used to push the next one out by five
 * minutes, and a chat that ignored one at 14:00 saw nothing again until 14:20.
 * The fifteen-minute promise is the one players are told about, so an ignored
 * spawn has to expire before it can break it.
 */
const DEFAULT_TTL_MS = 12 * 60 * 1000;

/** What each rarity is worth when caught. Rarer is fatter. */
const BOUNTY = {
  common: { coins: 1500, xp: 80 },
  uncommon: { coins: 4000, xp: 150 },
  rare: { coins: 12000, xp: 350 },
  epic: { coins: 35000, xp: 800 },
  legendary: { coins: 90000, xp: 1800 },
  mythic: { coins: 250000, xp: 4000 },
};

/**
 * How often each rarity is rolled, per spawn.
 *
 * Weighted, not flat: a flat roll over 151 entries puts Mewtwo in front of the
 * group about as often as Pidgey, and the rarity a Pokemon carries is the entire
 * reason anybody cares which one appeared.
 */
const WEIGHTS = {
  common: 520,
  uncommon: 300,
  rare: 110,
  epic: 55,
  legendary: 14,
  mythic: 3,
};

const TYPE_EMOJI = {
  normal: '⬜', fire: '🔥', water: '💧', electric: '⚡', grass: '🌿', ice: '❄️',
  fighting: '🥊', poison: '☠️', ground: '🟫', flying: '🕊️', psychic: '🔮', bug: '🐛',
  rock: '🪨', ghost: '👻', dragon: '🐉', dark: '🌑', steel: '⚙️', fairy: '✨',
};

/** Rarity label and symbol, bottom to top. */
const TIERS = [
  { key: 'common', label: 'Common', symbol: '⬜' },
  { key: 'uncommon', label: 'Uncommon', symbol: '🟩' },
  { key: 'rare', label: 'Rare', symbol: '🟦' },
  { key: 'epic', label: 'Epic', symbol: '🟪' },
  { key: 'legendary', label: 'Legendary', symbol: '🟧' },
  { key: 'mythic', label: 'Mythic', symbol: '🔴' },
];

const TIER_BY_KEY = new Map(TIERS.map((t) => [t.key, t]));

/**
 * The 151 original Pokemon.
 *
 * Rarity is derived, not invented: the five legendaries and the three-stage
 * dragon line are listed outright, twenty-six pseudo-legends are listed because
 * they are the ones a Gen 1 player remembers as endgame, and everything else
 * follows from its position in the evolution chain — base form, middle stage or
 * final evolution. `stage` is that position, taken from PokeAPI's evolution
 * chains rather than guessed.
 */
const POKEMON = [
  {
    "id": 1,
    "slug": "bulbasaur",
    "name": "Bulbasaur",
    "key": "bulbasaur",
    "types": [
      "grass",
      "poison"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 2,
    "slug": "ivysaur",
    "name": "Ivysaur",
    "key": "ivysaur",
    "types": [
      "grass",
      "poison"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 3,
    "slug": "venusaur",
    "name": "Venusaur",
    "key": "venusaur",
    "types": [
      "grass",
      "poison"
    ],
    "rarity": "epic",
    "stage": 2
  },
  {
    "id": 4,
    "slug": "charmander",
    "name": "Charmander",
    "key": "charmander",
    "types": [
      "fire"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 5,
    "slug": "charmeleon",
    "name": "Charmeleon",
    "key": "charmeleon",
    "types": [
      "fire"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 6,
    "slug": "charizard",
    "name": "Charizard",
    "key": "charizard",
    "types": [
      "fire",
      "flying"
    ],
    "rarity": "rare",
    "stage": 2
  },
  {
    "id": 7,
    "slug": "squirtle",
    "name": "Squirtle",
    "key": "squirtle",
    "types": [
      "water"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 8,
    "slug": "wartortle",
    "name": "Wartortle",
    "key": "wartortle",
    "types": [
      "water"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 9,
    "slug": "blastoise",
    "name": "Blastoise",
    "key": "blastoise",
    "types": [
      "water"
    ],
    "rarity": "epic",
    "stage": 2
  },
  {
    "id": 10,
    "slug": "caterpie",
    "name": "Caterpie",
    "key": "caterpie",
    "types": [
      "bug"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 11,
    "slug": "metapod",
    "name": "Metapod",
    "key": "metapod",
    "types": [
      "bug"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 12,
    "slug": "butterfree",
    "name": "Butterfree",
    "key": "butterfree",
    "types": [
      "bug",
      "flying"
    ],
    "rarity": "rare",
    "stage": 2
  },
  {
    "id": 13,
    "slug": "weedle",
    "name": "Weedle",
    "key": "weedle",
    "types": [
      "bug",
      "poison"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 14,
    "slug": "kakuna",
    "name": "Kakuna",
    "key": "kakuna",
    "types": [
      "bug",
      "poison"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 15,
    "slug": "beedrill",
    "name": "Beedrill",
    "key": "beedrill",
    "types": [
      "bug",
      "poison"
    ],
    "rarity": "rare",
    "stage": 2
  },
  {
    "id": 16,
    "slug": "pidgey",
    "name": "Pidgey",
    "key": "pidgey",
    "types": [
      "normal",
      "flying"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 17,
    "slug": "pidgeotto",
    "name": "Pidgeotto",
    "key": "pidgeotto",
    "types": [
      "normal",
      "flying"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 18,
    "slug": "pidgeot",
    "name": "Pidgeot",
    "key": "pidgeot",
    "types": [
      "normal",
      "flying"
    ],
    "rarity": "rare",
    "stage": 2
  },
  {
    "id": 19,
    "slug": "rattata",
    "name": "Rattata",
    "key": "rattata",
    "types": [
      "normal"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 20,
    "slug": "raticate",
    "name": "Raticate",
    "key": "raticate",
    "types": [
      "normal"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 21,
    "slug": "spearow",
    "name": "Spearow",
    "key": "spearow",
    "types": [
      "normal",
      "flying"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 22,
    "slug": "fearow",
    "name": "Fearow",
    "key": "fearow",
    "types": [
      "normal",
      "flying"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 23,
    "slug": "ekans",
    "name": "Ekans",
    "key": "ekans",
    "types": [
      "poison"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 24,
    "slug": "arbok",
    "name": "Arbok",
    "key": "arbok",
    "types": [
      "poison"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 25,
    "slug": "pikachu",
    "name": "Pikachu",
    "key": "pikachu",
    "types": [
      "electric"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 26,
    "slug": "raichu",
    "name": "Raichu",
    "key": "raichu",
    "types": [
      "electric"
    ],
    "rarity": "rare",
    "stage": 2
  },
  {
    "id": 27,
    "slug": "sandshrew",
    "name": "Sandshrew",
    "key": "sandshrew",
    "types": [
      "ground"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 28,
    "slug": "sandslash",
    "name": "Sandslash",
    "key": "sandslash",
    "types": [
      "ground"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 29,
    "slug": "nidoran-f",
    "name": "Nidoran♀",
    "key": "nidoranf",
    "types": [
      "poison"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 30,
    "slug": "nidorina",
    "name": "Nidorina",
    "key": "nidorina",
    "types": [
      "poison"
    ],
    "rarity": "epic",
    "stage": 1
  },
  {
    "id": 31,
    "slug": "nidoqueen",
    "name": "Nidoqueen",
    "key": "nidoqueen",
    "types": [
      "poison",
      "ground"
    ],
    "rarity": "epic",
    "stage": 2
  },
  {
    "id": 32,
    "slug": "nidoran-m",
    "name": "Nidoran♂",
    "key": "nidoranm",
    "types": [
      "poison"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 33,
    "slug": "nidorino",
    "name": "Nidorino",
    "key": "nidorino",
    "types": [
      "poison"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 34,
    "slug": "nidoking",
    "name": "Nidoking",
    "key": "nidoking",
    "types": [
      "poison",
      "ground"
    ],
    "rarity": "rare",
    "stage": 2
  },
  {
    "id": 35,
    "slug": "clefairy",
    "name": "Clefairy",
    "key": "clefairy",
    "types": [
      "fairy"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 36,
    "slug": "clefable",
    "name": "Clefable",
    "key": "clefable",
    "types": [
      "fairy"
    ],
    "rarity": "rare",
    "stage": 2
  },
  {
    "id": 37,
    "slug": "vulpix",
    "name": "Vulpix",
    "key": "vulpix",
    "types": [
      "fire"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 38,
    "slug": "ninetales",
    "name": "Ninetales",
    "key": "ninetales",
    "types": [
      "fire"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 39,
    "slug": "jigglypuff",
    "name": "Jigglypuff",
    "key": "jigglypuff",
    "types": [
      "normal",
      "fairy"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 40,
    "slug": "wigglytuff",
    "name": "Wigglytuff",
    "key": "wigglytuff",
    "types": [
      "normal",
      "fairy"
    ],
    "rarity": "rare",
    "stage": 2
  },
  {
    "id": 41,
    "slug": "zubat",
    "name": "Zubat",
    "key": "zubat",
    "types": [
      "poison",
      "flying"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 42,
    "slug": "golbat",
    "name": "Golbat",
    "key": "golbat",
    "types": [
      "poison",
      "flying"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 43,
    "slug": "oddish",
    "name": "Oddish",
    "key": "oddish",
    "types": [
      "grass",
      "poison"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 44,
    "slug": "gloom",
    "name": "Gloom",
    "key": "gloom",
    "types": [
      "grass",
      "poison"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 45,
    "slug": "vileplume",
    "name": "Vileplume",
    "key": "vileplume",
    "types": [
      "grass",
      "poison"
    ],
    "rarity": "rare",
    "stage": 2
  },
  {
    "id": 46,
    "slug": "paras",
    "name": "Paras",
    "key": "paras",
    "types": [
      "bug",
      "grass"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 47,
    "slug": "parasect",
    "name": "Parasect",
    "key": "parasect",
    "types": [
      "bug",
      "grass"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 48,
    "slug": "venonat",
    "name": "Venonat",
    "key": "venonat",
    "types": [
      "bug",
      "poison"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 49,
    "slug": "venomoth",
    "name": "Venomoth",
    "key": "venomoth",
    "types": [
      "bug",
      "poison"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 50,
    "slug": "diglett",
    "name": "Diglett",
    "key": "diglett",
    "types": [
      "ground"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 51,
    "slug": "dugtrio",
    "name": "Dugtrio",
    "key": "dugtrio",
    "types": [
      "ground"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 52,
    "slug": "meowth",
    "name": "Meowth",
    "key": "meowth",
    "types": [
      "normal"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 53,
    "slug": "persian",
    "name": "Persian",
    "key": "persian",
    "types": [
      "normal"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 54,
    "slug": "psyduck",
    "name": "Psyduck",
    "key": "psyduck",
    "types": [
      "water"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 55,
    "slug": "golduck",
    "name": "Golduck",
    "key": "golduck",
    "types": [
      "water"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 56,
    "slug": "mankey",
    "name": "Mankey",
    "key": "mankey",
    "types": [
      "fighting"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 57,
    "slug": "primeape",
    "name": "Primeape",
    "key": "primeape",
    "types": [
      "fighting"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 58,
    "slug": "growlithe",
    "name": "Growlithe",
    "key": "growlithe",
    "types": [
      "fire"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 59,
    "slug": "arcanine",
    "name": "Arcanine",
    "key": "arcanine",
    "types": [
      "fire"
    ],
    "rarity": "epic",
    "stage": 1
  },
  {
    "id": 60,
    "slug": "poliwag",
    "name": "Poliwag",
    "key": "poliwag",
    "types": [
      "water"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 61,
    "slug": "poliwhirl",
    "name": "Poliwhirl",
    "key": "poliwhirl",
    "types": [
      "water"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 62,
    "slug": "poliwrath",
    "name": "Poliwrath",
    "key": "poliwrath",
    "types": [
      "water",
      "fighting"
    ],
    "rarity": "rare",
    "stage": 2
  },
  {
    "id": 63,
    "slug": "abra",
    "name": "Abra",
    "key": "abra",
    "types": [
      "psychic"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 64,
    "slug": "kadabra",
    "name": "Kadabra",
    "key": "kadabra",
    "types": [
      "psychic"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 65,
    "slug": "alakazam",
    "name": "Alakazam",
    "key": "alakazam",
    "types": [
      "psychic"
    ],
    "rarity": "epic",
    "stage": 2
  },
  {
    "id": 66,
    "slug": "machop",
    "name": "Machop",
    "key": "machop",
    "types": [
      "fighting"
    ],
    "rarity": "epic",
    "stage": 0
  },
  {
    "id": 67,
    "slug": "machoke",
    "name": "Machoke",
    "key": "machoke",
    "types": [
      "fighting"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 68,
    "slug": "machamp",
    "name": "Machamp",
    "key": "machamp",
    "types": [
      "fighting"
    ],
    "rarity": "epic",
    "stage": 2
  },
  {
    "id": 69,
    "slug": "bellsprout",
    "name": "Bellsprout",
    "key": "bellsprout",
    "types": [
      "grass",
      "poison"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 70,
    "slug": "weepinbell",
    "name": "Weepinbell",
    "key": "weepinbell",
    "types": [
      "grass",
      "poison"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 71,
    "slug": "victreebel",
    "name": "Victreebel",
    "key": "victreebel",
    "types": [
      "grass",
      "poison"
    ],
    "rarity": "rare",
    "stage": 2
  },
  {
    "id": 72,
    "slug": "tentacool",
    "name": "Tentacool",
    "key": "tentacool",
    "types": [
      "water",
      "poison"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 73,
    "slug": "tentacruel",
    "name": "Tentacruel",
    "key": "tentacruel",
    "types": [
      "water",
      "poison"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 74,
    "slug": "geodude",
    "name": "Geodude",
    "key": "geodude",
    "types": [
      "rock",
      "ground"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 75,
    "slug": "graveler",
    "name": "Graveler",
    "key": "graveler",
    "types": [
      "rock",
      "ground"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 76,
    "slug": "golem",
    "name": "Golem",
    "key": "golem",
    "types": [
      "rock",
      "ground"
    ],
    "rarity": "epic",
    "stage": 2
  },
  {
    "id": 77,
    "slug": "ponyta",
    "name": "Ponyta",
    "key": "ponyta",
    "types": [
      "fire"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 78,
    "slug": "rapidash",
    "name": "Rapidash",
    "key": "rapidash",
    "types": [
      "fire"
    ],
    "rarity": "epic",
    "stage": 1
  },
  {
    "id": 79,
    "slug": "slowpoke",
    "name": "Slowpoke",
    "key": "slowpoke",
    "types": [
      "water",
      "psychic"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 80,
    "slug": "slowbro",
    "name": "Slowbro",
    "key": "slowbro",
    "types": [
      "water",
      "psychic"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 81,
    "slug": "magnemite",
    "name": "Magnemite",
    "key": "magnemite",
    "types": [
      "electric",
      "steel"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 82,
    "slug": "magneton",
    "name": "Magneton",
    "key": "magneton",
    "types": [
      "electric",
      "steel"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 83,
    "slug": "farfetchd",
    "name": "Farfetch'd",
    "key": "farfetchd",
    "types": [
      "normal",
      "flying"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 84,
    "slug": "doduo",
    "name": "Doduo",
    "key": "doduo",
    "types": [
      "normal",
      "flying"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 85,
    "slug": "dodrio",
    "name": "Dodrio",
    "key": "dodrio",
    "types": [
      "normal",
      "flying"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 86,
    "slug": "seel",
    "name": "Seel",
    "key": "seel",
    "types": [
      "water"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 87,
    "slug": "dewgong",
    "name": "Dewgong",
    "key": "dewgong",
    "types": [
      "water",
      "ice"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 88,
    "slug": "grimer",
    "name": "Grimer",
    "key": "grimer",
    "types": [
      "poison"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 89,
    "slug": "muk",
    "name": "Muk",
    "key": "muk",
    "types": [
      "poison"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 90,
    "slug": "shellder",
    "name": "Shellder",
    "key": "shellder",
    "types": [
      "water"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 91,
    "slug": "cloyster",
    "name": "Cloyster",
    "key": "cloyster",
    "types": [
      "water",
      "ice"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 92,
    "slug": "gastly",
    "name": "Gastly",
    "key": "gastly",
    "types": [
      "ghost",
      "poison"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 93,
    "slug": "haunter",
    "name": "Haunter",
    "key": "haunter",
    "types": [
      "ghost",
      "poison"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 94,
    "slug": "gengar",
    "name": "Gengar",
    "key": "gengar",
    "types": [
      "ghost",
      "poison"
    ],
    "rarity": "epic",
    "stage": 2
  },
  {
    "id": 95,
    "slug": "onix",
    "name": "Onix",
    "key": "onix",
    "types": [
      "rock",
      "ground"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 96,
    "slug": "drowzee",
    "name": "Drowzee",
    "key": "drowzee",
    "types": [
      "psychic"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 97,
    "slug": "hypno",
    "name": "Hypno",
    "key": "hypno",
    "types": [
      "psychic"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 98,
    "slug": "krabby",
    "name": "Krabby",
    "key": "krabby",
    "types": [
      "water"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 99,
    "slug": "kingler",
    "name": "Kingler",
    "key": "kingler",
    "types": [
      "water"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 100,
    "slug": "voltorb",
    "name": "Voltorb",
    "key": "voltorb",
    "types": [
      "electric"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 101,
    "slug": "electrode",
    "name": "Electrode",
    "key": "electrode",
    "types": [
      "electric"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 102,
    "slug": "exeggcute",
    "name": "Exeggcute",
    "key": "exeggcute",
    "types": [
      "grass",
      "psychic"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 103,
    "slug": "exeggutor",
    "name": "Exeggutor",
    "key": "exeggutor",
    "types": [
      "grass",
      "psychic"
    ],
    "rarity": "epic",
    "stage": 1
  },
  {
    "id": 104,
    "slug": "cubone",
    "name": "Cubone",
    "key": "cubone",
    "types": [
      "ground"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 105,
    "slug": "marowak",
    "name": "Marowak",
    "key": "marowak",
    "types": [
      "ground"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 106,
    "slug": "hitmonlee",
    "name": "Hitmonlee",
    "key": "hitmonlee",
    "types": [
      "fighting"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 107,
    "slug": "hitmonchan",
    "name": "Hitmonchan",
    "key": "hitmonchan",
    "types": [
      "fighting"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 108,
    "slug": "lickitung",
    "name": "Lickitung",
    "key": "lickitung",
    "types": [
      "normal"
    ],
    "rarity": "epic",
    "stage": 0
  },
  {
    "id": 109,
    "slug": "koffing",
    "name": "Koffing",
    "key": "koffing",
    "types": [
      "poison"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 110,
    "slug": "weezing",
    "name": "Weezing",
    "key": "weezing",
    "types": [
      "poison"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 111,
    "slug": "rhyhorn",
    "name": "Rhyhorn",
    "key": "rhyhorn",
    "types": [
      "ground",
      "rock"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 112,
    "slug": "rhydon",
    "name": "Rhydon",
    "key": "rhydon",
    "types": [
      "ground",
      "rock"
    ],
    "rarity": "epic",
    "stage": 1
  },
  {
    "id": 113,
    "slug": "chansey",
    "name": "Chansey",
    "key": "chansey",
    "types": [
      "normal"
    ],
    "rarity": "epic",
    "stage": 1
  },
  {
    "id": 114,
    "slug": "tangela",
    "name": "Tangela",
    "key": "tangela",
    "types": [
      "grass"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 115,
    "slug": "kangaskhan",
    "name": "Kangaskhan",
    "key": "kangaskhan",
    "types": [
      "normal"
    ],
    "rarity": "epic",
    "stage": 0
  },
  {
    "id": 116,
    "slug": "horsea",
    "name": "Horsea",
    "key": "horsea",
    "types": [
      "water"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 117,
    "slug": "seadra",
    "name": "Seadra",
    "key": "seadra",
    "types": [
      "water"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 118,
    "slug": "goldeen",
    "name": "Goldeen",
    "key": "goldeen",
    "types": [
      "water"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 119,
    "slug": "seaking",
    "name": "Seaking",
    "key": "seaking",
    "types": [
      "water"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 120,
    "slug": "staryu",
    "name": "Staryu",
    "key": "staryu",
    "types": [
      "water"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 121,
    "slug": "starmie",
    "name": "Starmie",
    "key": "starmie",
    "types": [
      "water",
      "psychic"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 122,
    "slug": "mr-mime",
    "name": "Mr. Mime",
    "key": "mrmime",
    "types": [
      "psychic",
      "fairy"
    ],
    "rarity": "epic",
    "stage": 1
  },
  {
    "id": 123,
    "slug": "scyther",
    "name": "Scyther",
    "key": "scyther",
    "types": [
      "bug",
      "flying"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 124,
    "slug": "jynx",
    "name": "Jynx",
    "key": "jynx",
    "types": [
      "ice",
      "psychic"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 125,
    "slug": "electabuzz",
    "name": "Electabuzz",
    "key": "electabuzz",
    "types": [
      "electric"
    ],
    "rarity": "epic",
    "stage": 1
  },
  {
    "id": 126,
    "slug": "magmar",
    "name": "Magmar",
    "key": "magmar",
    "types": [
      "fire"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 127,
    "slug": "pinsir",
    "name": "Pinsir",
    "key": "pinsir",
    "types": [
      "bug"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 128,
    "slug": "tauros",
    "name": "Tauros",
    "key": "tauros",
    "types": [
      "normal"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 129,
    "slug": "magikarp",
    "name": "Magikarp",
    "key": "magikarp",
    "types": [
      "water"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 130,
    "slug": "gyarados",
    "name": "Gyarados",
    "key": "gyarados",
    "types": [
      "water",
      "flying"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 131,
    "slug": "lapras",
    "name": "Lapras",
    "key": "lapras",
    "types": [
      "water",
      "ice"
    ],
    "rarity": "epic",
    "stage": 0
  },
  {
    "id": 132,
    "slug": "ditto",
    "name": "Ditto",
    "key": "ditto",
    "types": [
      "normal"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 133,
    "slug": "eevee",
    "name": "Eevee",
    "key": "eevee",
    "types": [
      "normal"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 134,
    "slug": "vaporeon",
    "name": "Vaporeon",
    "key": "vaporeon",
    "types": [
      "water"
    ],
    "rarity": "epic",
    "stage": 1
  },
  {
    "id": 135,
    "slug": "jolteon",
    "name": "Jolteon",
    "key": "jolteon",
    "types": [
      "electric"
    ],
    "rarity": "epic",
    "stage": 1
  },
  {
    "id": 136,
    "slug": "flareon",
    "name": "Flareon",
    "key": "flareon",
    "types": [
      "fire"
    ],
    "rarity": "epic",
    "stage": 1
  },
  {
    "id": 137,
    "slug": "porygon",
    "name": "Porygon",
    "key": "porygon",
    "types": [
      "normal"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 138,
    "slug": "omanyte",
    "name": "Omanyte",
    "key": "omanyte",
    "types": [
      "rock",
      "water"
    ],
    "rarity": "common",
    "stage": 0
  },
  {
    "id": 139,
    "slug": "omastar",
    "name": "Omastar",
    "key": "omastar",
    "types": [
      "rock",
      "water"
    ],
    "rarity": "uncommon",
    "stage": 1
  },
  {
    "id": 140,
    "slug": "kabuto",
    "name": "Kabuto",
    "key": "kabuto",
    "types": [
      "rock",
      "water"
    ],
    "rarity": "epic",
    "stage": 0
  },
  {
    "id": 141,
    "slug": "kabutops",
    "name": "Kabutops",
    "key": "kabutops",
    "types": [
      "rock",
      "water"
    ],
    "rarity": "epic",
    "stage": 1
  },
  {
    "id": 142,
    "slug": "aerodactyl",
    "name": "Aerodactyl",
    "key": "aerodactyl",
    "types": [
      "rock",
      "flying"
    ],
    "rarity": "epic",
    "stage": 0
  },
  {
    "id": 143,
    "slug": "snorlax",
    "name": "Snorlax",
    "key": "snorlax",
    "types": [
      "normal"
    ],
    "rarity": "epic",
    "stage": 1
  },
  {
    "id": 144,
    "slug": "articuno",
    "name": "Articuno",
    "key": "articuno",
    "types": [
      "ice",
      "flying"
    ],
    "rarity": "legendary",
    "stage": 0
  },
  {
    "id": 145,
    "slug": "zapdos",
    "name": "Zapdos",
    "key": "zapdos",
    "types": [
      "electric",
      "flying"
    ],
    "rarity": "legendary",
    "stage": 0
  },
  {
    "id": 146,
    "slug": "moltres",
    "name": "Moltres",
    "key": "moltres",
    "types": [
      "fire",
      "flying"
    ],
    "rarity": "legendary",
    "stage": 0
  },
  {
    "id": 147,
    "slug": "dratini",
    "name": "Dratini",
    "key": "dratini",
    "types": [
      "dragon"
    ],
    "rarity": "legendary",
    "stage": 0
  },
  {
    "id": 148,
    "slug": "dragonair",
    "name": "Dragonair",
    "key": "dragonair",
    "types": [
      "dragon"
    ],
    "rarity": "legendary",
    "stage": 1
  },
  {
    "id": 149,
    "slug": "dragonite",
    "name": "Dragonite",
    "key": "dragonite",
    "types": [
      "dragon",
      "flying"
    ],
    "rarity": "legendary",
    "stage": 2
  },
  {
    "id": 150,
    "slug": "mewtwo",
    "name": "Mewtwo",
    "key": "mewtwo",
    "types": [
      "psychic"
    ],
    "rarity": "mythic",
    "stage": 0
  },
  {
    "id": 151,
    "slug": "mew",
    "name": "Mew",
    "key": "mew",
    "types": [
      "psychic"
    ],
    "rarity": "mythic",
    "stage": 0
  }
];

const BY_ID = new Map(POKEMON.map((p) => [p.id, p]));
const BY_KEY = new Map(POKEMON.map((p) => [p.key, p]));

/**
 * Collapse anything a person might type into the one token a name is stored as.
 *
 * PokeAPI calls it "mr-mime"; people write "Mr. Mime", "mr mime", "mrmime" and
 * occasionally "MR.MIME". The Nidorans carry a gender symbol that most keyboards
 * cannot produce, so `♀`/`♂` are folded into the f/m suffix people actually
 * type. Farfetch'd loses its apostrophe. Without all of this the catch works for
 * some people and silently does nothing for everybody else.
 *
 * @param {string} input
 * @returns {string} lowercase alphanumeric token, possibly empty
 */
function normalise(input) {
  return String(input == null ? '' : input)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u2640\u2642]/g, (m) => (m === '\u2640' ? 'f' : 'm'))
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Find a Pokemon by whatever the user typed.
 *
 * Exact match on the normalised key first, then a prefix match so that a
 * partial answer ("pika") still works. The prefix pass is deliberately
 * restricted to keys at least four characters long — with two characters, "ra"
 * matches Raichu, Rattata, Rapidash and every other r-word in the game.
 *
 * @param {string} input
 * @returns {object|null}
 */
function find(input) {
  const key = normalise(input);
  if (!key) return null;
  if (BY_KEY.has(key)) return BY_KEY.get(key);
  if (key.length < 4) return null;
  for (const p of POKEMON) {
    if (p.key.startsWith(key)) return p;
  }
  return null;
}

/** @param {number|string} id */
function byId(id) {
  return BY_ID.get(Number(id)) || null;
}

/** Official artwork for one Pokemon, as a URL Facebook can fetch. */
function sprite(id) {
  return `${SPRITES}/${Number(id)}.png`;
}

/** @param {object} p */
function tier(p) {
  return TIER_BY_KEY.get(p && p.rarity) || TIERS[0];
}

/** The type line, as the familiar icons. */
function types(p) {
  return (p.types || []).map((t) => `${TYPE_EMOJI[t] || '❔'} ${t}`).join(' · ');
}

/** @param {object} p */
function typeLabel(p) {
  return ((p.types || []).map((t) => t[0].toUpperCase() + t.slice(1))).join(' / ') || 'Unknown';
}

/**
 * Roll one Pokemon by rarity weight, then uniformly within that rarity.
 *
 * Two steps on purpose: rolling a tier and then a member means the weights are
 * one number per tier and cannot drift out of step with the table, whereas
 * weighting all 151 entries by hand would mean editing 151 numbers every time
 * the roster changed.
 *
 * @returns {object} a Pokemon from the table
 */
function random() {
  const total = TIERS.reduce((sum, t) => sum + (WEIGHTS[t.key] || 0), 0);
  let roll = Math.random() * total;
  let chosen = TIERS[0].key;
  for (const t of TIERS) {
    roll -= WEIGHTS[t.key] || 0;
    if (roll <= 0) { chosen = t.key; break; }
  }
  const pool = POKEMON.filter((p) => p.rarity === chosen);
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Coins and XP for catching this Pokemon. */
function bounty(p) {
  return BOUNTY[p && p.rarity] || BOUNTY.common;
}

/**
 * When this group's next spawn is due.
 *
 * One interval after the last attempt, exactly as `isDue` in bot/pokemonSpawn.js
 * measures it — the same two stamps, because a status line that disagrees with
 * the scheduler about when it will next post is worse than no status line.
 *
 * The important rule is that it never returns a moment in the past. A group whose
 * last spawn was yesterday is due *now*, and "next due: 1d 8h ago" is a countdown
 * to a moment that has already gone: it printed the same value on the "last
 * spawn" line and the "next due" line, and read as a scheduler that had run
 * backwards. An overdue group is reported as due, and how far behind it is comes
 * back in `overdueMs` so a caller can say so instead of pretending the clock
 * never slipped.
 *
 * @param {object} pokemon the `group.pokemon` subdocument
 * @param {number} [now] epoch ms, injectable for tests
 * @param {number} [intervalMs] override for the group's own interval
 * @returns {{dueAt:Date|null, isDue:boolean, overdueMs:number, intervalMs:number, lastAt:number}}
 */
function nextDue(pokemon, now = Date.now(), intervalMs = DEFAULT_INTERVAL_MS) {
  const poke = pokemon || {};
  const interval = Number(poke.intervalMs) || intervalMs;
  const stamps = [poke.lastSpawnAt, poke.lastAttemptAt]
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter(Number.isFinite);
  const lastAt = stamps.length ? Math.max(...stamps) : 0;
  // Never spawned: due on the next tick, not in fifteen minutes.
  if (!lastAt) return { dueAt: null, isDue: true, overdueMs: 0, intervalMs: interval, lastAt: 0 };

  const raw = lastAt + interval;
  if (raw <= now) {
    // Overdue. The next one is a fresh interval from now, and the shortfall is
    // handed back so a caller can say how far behind the group is instead of
    // pretending the clock never slipped. `isDue` covers the exact boundary as
    // well, where the shortfall is zero milliseconds but the spawn still belongs
    // on this tick rather than a quarter of an hour from now.
    return {
      dueAt: new Date(now + interval),
      isDue: true,
      overdueMs: now - raw,
      intervalMs: interval,
      lastAt,
    };
  }
  return { dueAt: new Date(raw), isDue: false, overdueMs: 0, intervalMs: interval, lastAt };
}

module.exports = {
  POKEMON, TIERS, TIER_BY_KEY, WEIGHTS, BOUNTY,
  DEFAULT_INTERVAL_MS, DEFAULT_TTL_MS, SPRITES,
  normalise, find, byId, sprite, tier, types, typeLabel, random, bounty,
  nextDue,
};
