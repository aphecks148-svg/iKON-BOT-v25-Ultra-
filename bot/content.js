'use strict';

/**
 * Rarity, and the gates that guard the expensive end of it.
 *
 * WHY THIS IS SHARED
 *
 * Ten modules grew their own idea of what "rare" meant, and several of them
 * derived it from a table's position — `table.indexOf(row)`, so "rarity 7"
 * meant "the eighth thing in the list". That works right up until the list
 * grows: append four more fish and every rarity tier silently shifts up, and a
 * tournament starts scoring a sardine as rare. Rarity is now a stated property
 * of the item, and this file is the single place it is defined, so growing a
 * list cannot change what any other list means.
 *
 * THE LADDER
 *
 * Seven rungs, bottom to top. Divine is deliberately unreachable-by-money: the
 * three divine items are not sold, they are found, and two of them are one-of-one.
 */

/** Bottom to top. Index is the rank, so `rank` is cheap and total. */
const LADDER = [
  { key: 'common', label: 'Common', symbol: '⬜', rank: 0 },
  { key: 'uncommon', label: 'Uncommon', symbol: '🟩', rank: 1 },
  { key: 'rare', label: 'Rare', symbol: '🟦', rank: 2 },
  { key: 'epic', label: 'Epic', symbol: '🟪', rank: 3 },
  { key: 'legendary', label: 'Legendary', symbol: '🟧', rank: 4 },
  { key: 'mythic', label: 'Mythic', symbol: '🔴', rank: 5 },
  { key: 'divine', label: 'Divine', symbol: '🟡', rank: 6 },
];

const BY_KEY = new Map(LADDER.map((r) => [r.key, r]));

/** The highest rung. Used by tests and by the pet table's own guard. */
const TOP = LADDER[LADDER.length - 1];

const COMMON = LADDER[0];

/**
 * Full metadata for a rarity key. Unknown keys get the bottom rung rather than
 * crashing: a typo in a data table should show a plain item, not break a shop.
 *
 * @param {string} key
 * @returns {{key:string,label:string,symbol:string,rank:number}}
 */
function get(key) {
  const k = String(key || '').toLowerCase();
  return BY_KEY.get(k) || COMMON;
}

/**
 * Numeric rank, bottom to top. -1 for anything unknown, which sorts below
 * everything — so a table with a typo degrades to "least valuable" instead of
 * accidentally reading as the rarest thing in the game.
 *
 * @param {string} key
 * @returns {number}
 */
function rank(key) {
  const r = BY_KEY.get(String(key || '').toLowerCase());
  return r ? r.rank : -1;
}

/** "🟪 Epic" — for a listing line. */
function label(key) {
  const r = get(key);
  return `${r.symbol} ${r.label}`;
}

/** Emoji only, for tight columns. */
function symbol(key) {
  return get(key).symbol;
}

/**
 * Did this item get rarer as the economy grew?
 *
 * Not used at runtime — it exists so a test can prove a table was written in
 * ascending rarity order. Data tables that go cheap-to-expensive read correctly
 * to a human, and a table that does not is nearly impossible to maintain at 50
 * rows.
 *
 * @param {object[]} items each must have a `rarity` key
 * @returns {string|null} the id of the first row that breaks the order
 */
function firstOutOfOrder(items) {
  for (let i = 1; i < items.length; i += 1) {
    const prev = items[i - 1];
    const cur = items[i];
    if (rank(cur.rarity) < rank(prev.rarity)) return cur.id || cur.name || String(i);
    if (prev.price !== undefined && cur.price !== undefined && cur.price < prev.price) {
      return cur.id || cur.name || String(i);
    }
  }
  return null;
}

/**
 * The economy is 10x.
 *
 * Prices and payouts are authored at the old 1x numbers and read through `k()`,
 * rather than being written out multiplied. That matters for two reasons:
 * tuning the whole economy is then one number instead of four hundred edits,
 * and a reader can still see what something actually costs — `k(50000)` says
 * "half a million" without anyone having to remember the multiplier.
 *
 * The reason for 10x is that the collectible tables grew. A shop of four items
 * and a garage of twelve could be priced against a 10,000-coin daily; a garage
 * of twenty-two with divine pets at twelve million cannot, and everything
 * expensive ends up purchasable on day one, which removes the reason to play.
 */
const ECONOMY_SCALE = 10;

/**
 * Author money at 1x, read it at ECONOMY_SCALE.
 *
 * @param {number} n
 * @returns {number}
 */
function k(n) {
  return Math.round((Number(n) || 0) * ECONOMY_SCALE);
}

// ───────────────────────────────────────────────────────────
// REQUIREMENTS
// ───────────────────────────────────────────────────────────

/**
 * Why a hunter cannot use a thing yet.
 *
 * A price is not a requirement: somebody with 50 million coins and level 1 can
 * buy the divine car, and should not. Levels are the gate that makes progression
 * visible — the expensive tier is expensive AND out of reach until you have
 * actually played, so there is a reason to come back tomorrow.
 *
 * @param {object} userDoc hunter profile
 * @param {object} item anything with `level` and/or `requires` fields
 * @returns {string|null} a sentence to show, or null when nothing is missing
 */
function missing(userDoc, item) {
  if (!item) return 'That does not exist.';
  const level = Number(userDoc && userDoc.level) || 1;

  const needLevel = Number(item.level) || 0;
  if (needLevel > level) {
    return `🔒 **${item.name || 'This'}** needs hunter **Level ${needLevel}** — you are Level ${level}.`;
  }

  const needs = Array.isArray(item.requires) ? item.requires : [];
  for (const req of needs) {
    if (!req) continue;
    const why = missingOne(userDoc, req, level);
    if (why) return why;
  }
  return null;
}

/**
 * One requirement. All of these are things a profile already tracks, so a gate
 * never needs a new database field to be enforceable.
 *
 * @param {object} userDoc
 * @param {object|string} req
 * @param {number} level
 * @returns {string|null}
 */
function missingOne(userDoc, req, level) {
  if (typeof req === 'string') {
    // Bare strings are item ids: "you must already own a sword".
    const has = owns(userDoc, req);
    return has ? null : `🔒 You need a **${labelFor(req)}** first.`;
  }

  const count = Number(req.count) || 1;
  const have = Number(req.have) || 0;
  if (have < count) {
    return `🔒 Needs **${count}× ${labelFor(req.id)}** — you have ${have}.`;
  }
  void level;
  return null;
}

/** Does this profile already own something with that id? */
function owns(userDoc, id) {
  if (!userDoc || !id) return false;
  // Pets live in gta/pet territory; check the shapes that actually exist across
  // the modules rather than assuming one inventory layout.
  const bag = userDoc.items || userDoc.inventory || [];
  if (Array.isArray(bag) && bag.some((i) => i && (i.itemId === id || i.id === id))) return true;
  const pets = (userDoc.gta && userDoc.gta.pets) || userDoc.pets || [];
  if (Array.isArray(pets) && pets.some((p) => p && (p.type === id || p.id === id))) return true;
  const cars = (userDoc.gta && userDoc.gta.cars) || [];
  if (Array.isArray(cars) && cars.some((c) => c && c.id === id)) return true;
  return false;
}

/** A readable name for an id we may not have a table for. */
const LABELS = new Map();
function labelFor(id) {
  return LABELS.get(id) || String(id);
}

/**
 * Register a display name for an item id, so a requirement can be shown as
 * "iKON Sword" rather than "sword". Modules call this once at load.
 *
 * @param {string} id
 * @param {string} name
 */
function registerLabel(id, name) {
  if (id && name) LABELS.set(String(id), String(name));
}

/**
 * The odds that a random draw lands on a given rarity.
 *
 * Every collectible table uses this so rarity is actually rare. A flat one-in-N
 * per row means adding rows quietly makes the good ones more common; weighting
 * by rank keeps "divine stays divine" true as the tables grow.
 *
 * @param {number} rank_ rarity rank, bottom to top
 * @returns {number} relative weight
 */
function weightFor(rank_) {
  // Halves at every rung. Seven rungs means the top is 1/64th of a common drop.
  return Math.max(1, Math.round(100 / (2 ** Math.max(0, rank_))));
}

/**
 * Pick one entry, weighted by rarity.
 *
 * @template T
 * @param {T[]} items each needs a `rarity` key
 * @param {() => number} rand a 0..1 source, injectable for tests
 * @returns {T|null}
 */
function weightedPick(items, rand = Math.random) {
  if (!Array.isArray(items) || !items.length) return null;
  const weights = items.map((it) => weightFor(rank(it && it.rarity)));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rand() * total;
  for (let i = 0; i < items.length; i += 1) {
    roll -= weights[i];
    if (roll < 0) return items[i];
  }
  return items[items.length - 1];
}

module.exports = {
  LADDER, TOP, COMMON, BY_KEY,
  ECONOMY_SCALE, k,
  get, rank, label, symbol, firstOutOfOrder,
  missing, owns, registerLabel,
  weightFor, weightedPick,
};