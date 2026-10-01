'use strict';

/**
 * Profile cache — Map with a 5 minute TTL.
 * Avoids a Mongo round-trip on every message.
 */

const config = require('../config');
const User = require('../models/User');
const mongo = require('./mongo');
const { log, error } = require('./helpers');

const TTL = config.CACHE_TTL || 5 * 60 * 1000;

/** uid -> { doc, name, expires } */
const store = new Map();

/** Fetch the user's display name from Facebook when possible. */
async function fetchName(uid, api) {
  try {
    if (api && typeof api.getUserInfo === 'function') {
      const info = await api.getUserInfo(uid);
      const name = info && (info.name || info.first_name);
      if (name) return name;
    }
  } catch (err) {
    error(`[CACHE] getUserInfo(${uid}) failed: ${err.message}`);
  }
  return null;
}

/**
 * Get (and cache) a user document, creating it on first sight.
 * Refreshes the stored name when Facebook reports a change.
 *
 * @param {string} uid
 * @param {object} [api] ws3-fca client, used for name lookup
 * @returns {Promise<object|null>} the Mongoose user document
 */
async function getUser(uid, api) {
  if (!uid) return null;
  const id = String(uid);

  const hit = store.get(id);
  if (hit && Date.now() < hit.expires) return hit.doc;

  // No database: hand back an in-memory profile so non-DB commands still work.
  if (!mongo.isReady()) {
    const stub = {
      uid: id,
      name: (await fetchName(id, api)) || `User ${id.slice(-4)}`,
      level: 1, xp: 0, coins: 1000, bank: 0, reputation: 0, prestige: 0,
      stats: { messages: 0, commandsUsed: 0 },
      transient: true,
    };
    store.set(id, { doc: stub, expires: Date.now() + TTL });
    return stub;
  }

  try {
    let user = await User.findOne({ uid: id });

    if (!user) {
      const name = (await fetchName(id, api)) || `User ${id.slice(-4)}`;
      user = await User.create({ uid: id, name });
      log(`[CACHE] New user ${id} (${user.name})`);
    } else {
      const liveName = await fetchName(id, api);
      if (liveName && liveName !== user.name) {
        user.name = liveName;
        await user.save();
      }
    }

    store.set(id, { doc: user, expires: Date.now() + TTL });
    return user;
  } catch (err) {
    error(`[CACHE] getUser(${id}) failed: ${err.message}`);
    return null;
  }
}

/** Invalidate one user (after a save from elsewhere). */
function invalidate(uid) {
  store.delete(String(uid));
}

/** Refresh a cached doc after in-place mutation. */
function touch(uid, doc) {
  const id = String(uid);
  const existing = store.get(id);
  store.set(id, { doc: doc || (existing && existing.doc), expires: Date.now() + TTL });
}

/** Drop expired entries. */
function sweep() {
  const now = Date.now();
  for (const [k, v] of store) if (now >= v.expires) store.delete(k);
}

const size = () => store.size;
const clear = () => store.clear();

module.exports = { getUser, invalidate, touch, sweep, size, clear, TTL };
