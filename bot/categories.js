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
 * Categories that have been folded into another one.
 *
 * Two decks did not earn their own place. `kingdom` was twelve commands about
 * a treasury and a war, which is the same game `gta` already plays with a
 * wallet; `football` was ten commands about scores, which is the same thing
 * `games` already does with dice and chess. Eleven decks is a worse index than
 * ten, and a deck with one page of nothing in it is worse than no deck.
 *
 * The command's own `category` string is NOT changed. That string is stored in
 * group settings and compared against `disabledModules`, so a group that
 * switched the kingdom commands off must keep doing so after the deck is
 * folded away. The commands still live under `kingdom`; the deck just sits in
 * the same drawer as the rest of the empire games.
 *
 * @type {Record<string,string>}
 */
const MERGED_INTO = {
  kingdom: 'gta',
  football: 'games',
};

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
    label: 'Games & Sports',
    emoji: '🎲',
    symbol: '◈',
    blurb: 'RPS, chess, dice, trivia — and live football for the matches on today.',
    hint: 'Games wager coins by default; `!pass` skips a round without losing anything. `!football` is free to read.',
    lookfor: ['games', 'game', 'arena', 'gambling', 'games & arena', 'games & sports', 'football', 'soccer', 'premier', 'fixture', 'match', 'goal', 'league'],
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
    label: 'Empire & Street',
    emoji: '🚗',
    symbol: '❖',
    blurb: 'Cars, crime, turf and crews — and the kingdoms that outgrow them.',
    hint: 'Steal a car before anything else; most of Street Life needs one. `!kingdom create <name>` starts an empire.',
    lookfor: ['gta', 'street', 'street life', 'cars', 'crime', 'crew', 'empire', 'empire & street', 'kingdom', 'kingdoms', 'guild', 'war', 'monarch'],
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

// The folded-away keys point at the deck that swallowed them, so `!help
// kingdom` opens the empire deck and `!help football` opens the games deck
// instead of answering "unknown topic".
for (const [old, parent] of Object.entries(MERGED_INTO)) {
  const cat = BY_KEY.get(parent);
  if (cat) BY_LOOKFOR.set(old.toLowerCase(), cat);
}

/** Presentation order. Deliberate: what a new user needs comes first. */
const ORDER = CATEGORIES.map((c) => c.key);

/**
 * The deck a category key belongs to.
 *
 * A folded-away key resolves to the deck that took it; everything else
 * resolves to itself.
 *
 * @param {string} key
 * @returns {string}
 */
function resolve(key) {
  const k = String(key || '').toLowerCase();
  return MERGED_INTO[k] || k;
}

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
  const k = resolve(key);
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
  // A folded-away key is an exact name too — `!help kingdom` opens the empire
  // deck, which is where the kingdom commands now live.
  if (MERGED_INTO[q] && BY_KEY.has(MERGED_INTO[q])) return BY_KEY.get(MERGED_INTO[q]);
  const tight = q.replace(/[^a-z0-9]/g, '');
  return CATEGORIES.find((c) => c.label.toLowerCase().replace(/[^a-z0-9]/g, '') === tight) || null;
}

/**
 * Every key that is not in the table. `!check` uses this so a new category
 * cannot be added without deciding what to call it.
 *
 * A folded-away key is not unknown — it is a key that used to have a deck of
 * its own and now shares one, so it must not be reported as a typo.
 *
 * @param {Iterable<string>} keys
 * @returns {string[]}
 */
function unknownKeys(keys) {
  return [...new Set(keys)].filter((k) => {
    const key = String(k).toLowerCase();
    return !BY_KEY.has(key) && !MERGED_INTO[key];
  });
}

/**
 * Group commands by category, in presentation order.
 *
 * A command whose category has been folded away is filed under the deck that
 * took it, so the index counts it in the right place and `!help games` opens a
 * page that includes the football commands.
 *
 * @param {object[]} commands
 * @returns {Map<string,object[]>}
 */
function group(commands) {
  const out = new Map();
  for (const key of ORDER) out.set(key, []);
  for (const cmd of commands) {
    const key = resolve(cmd.category);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(cmd);
  }
  return out;
}

module.exports = {
  CATEGORIES, ORDER, MERGED_INTO, get, find, findExact, group, unknownKeys, resolve,
};
