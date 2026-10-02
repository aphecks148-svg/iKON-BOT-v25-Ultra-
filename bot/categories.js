'use strict';

/**
 * What each category is actually called.
 *
 * A command's `category` is a machine key: it is stored in group settings,
 * compared against `disabledModules`, and used to turn whole modules off. Those
 * strings are load-bearing and are never renamed — `economy` has to stay
 * `economy` or every group that disabled it silently stops being disabled.
 *
 * What the *user* sees is a different thing. `rpg` and `gta` are module
 * shorthand, not words anybody would search for, and an index that lists ten
 * lowercase abbreviations teaches the user nothing about what is in them. So
 * the key stays and the display name lives here, in one table, next to the
 * emoji, the symbol, the one-line blurb, and the hint.
 *
 * Adding a category means adding a row here. Nothing else needs to know.
 */

/**
 * @typedef {Object} Category
 * @property {string} key    machine key, matches Command.category (never change)
 * @property {string} label  the name shown to users
 * @property {string} emoji  heading icon
 * @property {string} symbol accent glyph used in headers and the index
 * @property {string} blurb  one line: what lives in here
 * @property {string} hint   a real tip, not a restatement of the blurb
 * @property {string[]} lookfor words that should find this category
 */

/** @type {Category[]} */
const CATEGORIES = [
  {
    key: 'system',
    label: 'System Core',
    emoji: '⚙️',
    symbol: '❖',
    blurb: 'Health, settings, and the switches that run the bot.',
    hint: '`!adminon` lets admins restrict commands to admins — turn it on if the group gets noisy.',
    lookfor: ['system', 'core', 'settings', 'admin', 'moderation'],
  },
  {
    key: 'economy',
    label: 'Economy & Treasury',
    emoji: '💰',
    symbol: '◈',
    blurb: 'Coins, the bank, the shop, and the daily claims that pay for it.',
    hint: 'Claim `!daily` first — every economy command assumes you have.',
    lookfor: ['economy', 'money', 'coins', 'bank', 'treasury', 'economy & treasury'],
  },
  {
    key: 'rpg',
    label: 'Hunter Academy',
    emoji: '🏹',
    symbol: '✦',
    blurb: 'Your hunter: class, stats, ranks, duels and the profile card.',
    hint: 'Start with `!profile` to see your hunter card, then `!top` for the leaderboard.',
    lookfor: ['rpg', 'hunter', 'academy', 'rank', 'class', 'hunter academy'],
  },
  {
    key: 'pets',
    label: 'Dangerous Pets',
    emoji: '🐾',
    symbol: '❖',
    blurb: 'Adopt, feed, breed and battle with pets that bite back.',
    hint: 'A pet that is hungry loses fights — feed it before a battle, not after.',
    lookfor: ['pets', 'pet', 'dangerous pets', 'adopt'],
  },
  {
    key: 'games',
    label: 'Games & Arena',
    emoji: '🎲',
    symbol: '◈',
    blurb: 'RPS, chess, dice, trivia — and the arena that keeps score.',
    hint: 'Games wager coins by default; `!pass` skips a round without losing anything.',
    lookfor: ['games', 'game', 'arena', 'gambling', 'games & arena'],
  },
  {
    key: 'group',
    label: 'Group Administration',
    emoji: '🛡️',
    symbol: '✦',
    blurb: 'Kick, promote, mute, and the read-only rules that keep a chat civil.',
    hint: 'Tag people to use these — `!kick @Alice` beats typing a name the bot has to guess.',
    lookfor: ['group', 'admin', 'administration', 'moderation', 'kick', 'mute', 'group administration'],
  },
  {
    key: 'gta',
    label: 'Street Life',
    emoji: '🚗',
    symbol: '❖',
    blurb: 'Cars, crime, turf and the crew system — GTA with a wallet.',
    hint: 'Steal a car before anything else; most of Street Life needs one.',
    lookfor: ['gta', 'street', 'street life', 'cars', 'crime', 'crew'],
  },
  {
    key: 'downloader',
    label: 'Media & AI',
    emoji: '📥',
    symbol: '✦',
    blurb: 'Download media from a link, and let Groq caption and describe it.',
    hint: 'Only this category costs AI credit — everything else here is free.',
    lookfor: ['downloader', 'download', 'media', 'ai', 'groq', 'media & ai'],
  },
  {
    key: 'fun',
    label: 'Fun & Social',
    emoji: '💫',
    symbol: '◈',
    blurb: 'Reactions, hugs, ships, marriages and the boards they end up on.',
    hint: 'Reactions need a recent message to land on — reply to one, then use them.',
    lookfor: ['fun', 'social', 'fun & social', 'hug', 'ship', 'marry'],
  },
  {
    key: 'farming',
    label: 'Farm & Hunt',
    emoji: '🌾',
    symbol: '❖',
    blurb: 'Plots, crops, livestock, mines, rivers and the hunt that feeds them.',
    hint: 'Farm first, hunt second — hunting costs energy that farming earns back.',
    lookfor: ['farming', 'farm', 'hunt', 'mine', 'fish', 'farm & hunt'],
  },
];

const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

/** A lookup table over every word that should find a category. */
const BY_LOOKFOR = new Map();
for (const cat of CATEGORIES) {
  BY_LOOKFOR.set(cat.key.toLowerCase(), cat);
  for (const word of cat.lookfor) BY_LOOKFOR.set(word.toLowerCase(), cat);
}

/** Presentation order. Deliberate: what a new user needs comes first. */
const ORDER = CATEGORIES.map((c) => c.key);

/**
 * The display metadata for a category key.
 *
 * Unknown keys still render. A typo in a category should show up as an
 * untitled section, not crash help for everybody — but `!check` reports it.
 *
 * @param {string} key
 * @returns {Category}
 */
function get(key) {
  const k = String(key || '').toLowerCase();
  return BY_KEY.get(k) || {
    key: k || 'unknown',
    label: String(key || 'Unknown'),
    emoji: '❓',
    symbol: '•',
    blurb: 'No description for this category yet.',
    hint: '',
    lookfor: [],
  };
}

/**
 * Find a category from what the user typed.
 *
 * Matches the key, the display label, and the extra words — so `gta`, `street`
 * and `Street Life` all land on the same category.
 *
 * @param {string} query
 * @returns {Category|null}
 */
function find(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  if (BY_LOOKFOR.has(q)) return BY_LOOKFOR.get(q);
  // "hunter academy" typed as "hunteracademy"
  const tight = q.replace(/[^a-z0-9]/g, '');
  for (const cat of CATEGORIES) {
    if (cat.label.toLowerCase().replace(/[^a-z0-9]/g, '') === tight) return cat;
  }
  return null;
}

/**
 * Find a category by its own name only — key or display label, no loose words.
 *
 * This exists because the loose list is too eager. `kick` is in Group's
 * lookfor words, so a loose match made `!help kick` open all 34 commands in the
 * deck instead of the one command the person asked about. An exact deck name has
 * to be checked first, and only then do the loose words get a say — that way
 * `!help economy` still opens the deck (its key is exactly "economy", and the
 * index advertises it that way) while `!help kick` opens the command.
 *
 * @param {string} query
 * @returns {Category|null}
 */
function findExact(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  if (BY_KEY.has(q)) return BY_KEY.get(q);
  const tight = q.replace(/[^a-z0-9]/g, '');
  return CATEGORIES.find((c) => c.label.toLowerCase().replace(/[^a-z0-9]/g, '') === tight) || null;
}

/**
 * Every key that is not in the table. `!check` uses this so a new category
 * cannot be added without deciding what to call it.
 *
 * @param {Iterable<string>} keys
 * @returns {string[]}
 */
function unknownKeys(keys) {
  return [...new Set(keys)].filter((k) => !BY_KEY.has(String(k).toLowerCase()));
}

/** Group commands by category, in presentation order. */
function group(commands) {
  const out = new Map();
  for (const key of ORDER) out.set(key, []);
  for (const cmd of commands) {
    const key = String(cmd.category || '').toLowerCase();
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(cmd);
  }
  return out;
}

module.exports = { CATEGORIES, ORDER, get, find, findExact, group, unknownKeys };