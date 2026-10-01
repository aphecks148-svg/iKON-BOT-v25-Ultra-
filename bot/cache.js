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

// ─────────────────────────────────────────────────────────────
// PENDING PET CHALLENGES (module 4)
// `!petbattle @user` parks a challenge here; the target answers with
// `!petaccept` / `!petdeny` before it expires.
// ─────────────────────────────────────────────────────────────

/** key: `${threadID}::${challengedUid}` -> { fromUid, fromName, petId, expires } */
const pendingBattles = new Map();

const battleKey = (threadID, uid) => `${threadID}::${uid}`;

/** Park a challenge for `uid`. Returns false when one is already pending. */
function setPendingBattle(threadID, uid, payload) {
  const key = battleKey(threadID, uid);
  if (pendingBattles.has(key)) return false;
  pendingBattles.set(key, payload);
  return true;
}

/** Read a pending challenge without removing it. */
function getPendingBattle(threadID, uid) {
  return pendingBattles.get(battleKey(threadID, uid)) || null;
}

/** Take a pending challenge, dropping it. @returns {object|null} */
function takePendingBattle(threadID, uid) {
  const key = battleKey(threadID, uid);
  const found = pendingBattles.get(key) || null;
  pendingBattles.delete(key);
  return found;
}

/** Cancel a pending challenge (used when the challenger goes away). */
function clearPendingBattle(threadID, uid) {
  pendingBattles.delete(battleKey(threadID, uid));
}

/** Drop expired challenges. */
function sweepBattles() {
  const now = Date.now();
  for (const [k, v] of pendingBattles) {
    if (!v || now >= v.expires) pendingBattles.delete(k);
  }
}

const battleCount = () => pendingBattles.size;

// ─────────────────────────────────────────────────────────────
// MESSAGE OWNERS — needed for reply-to targeting.
// `!petfight` works by replying to somebody's message, so we must be able to
// map a replied-to messageID back to the person who sent it.
// ─────────────────────────────────────────────────────────────

/** messageID -> { uid, expires }. Bounded so a long uptime cannot leak. */
const messageOwners = new Map();
const OWNER_TTL = 6 * 60 * 60 * 1000; // 6 hours
const OWNER_CAP = 5000;

/** Remember who sent a message so a reply can be traced back to them. */
function rememberMessage(messageID, uid) {
  if (!messageID || !uid) return;
  messageOwners.set(String(messageID), { uid: String(uid), expires: Date.now() + OWNER_TTL });
  if (messageOwners.size > OWNER_CAP) {
    const oldest = [...messageOwners.entries()].sort((a, b) => a[1].expires - b[1].expires);
    for (let i = 0; i < Math.floor(OWNER_CAP / 4); i += 1) messageOwners.delete(oldest[i][0]);
  }
}

/** Resolve a replied-to messageID back to its sender. */
function ownerOfMessage(messageID) {
  if (!messageID) return null;
  const hit = messageOwners.get(String(messageID));
  if (!hit) return null;
  if (Date.now() >= hit.expires) {
    messageOwners.delete(String(messageID));
    return null;
  }
  return hit.uid;
}

function sweepMessages() {
  const now = Date.now();
  for (const [k, v] of messageOwners) if (now >= v.expires) messageOwners.delete(k);
}

const size = () => store.size;
const clear = () => store.clear();

module.exports = {
  getUser, invalidate, touch, sweep, size, clear, TTL,
  // module 4 — pet challenges and reply-to targeting
  setPendingBattle, getPendingBattle, takePendingBattle, clearPendingBattle,
  sweepBattles, battleCount,
  rememberMessage, ownerOfMessage, sweepMessages,
};
