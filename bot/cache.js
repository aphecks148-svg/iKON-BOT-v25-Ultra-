'use strict';

/**
 * Profile cache — Map with a 5 minute TTL.
 * Avoids a Mongo round-trip on every message.
 */

const config = require('../config');
const User = require('../models/User');
const mongo = require('./mongo');
const profile = require('./profile');
const { log, error } = require('./helpers');

const TTL = config.CACHE_TTL || 5 * 60 * 1000;

/**
 * Wallet a brand new hunter starts with.
 *
 * This is the value getOrCreateUser() writes when it has to invent a profile.
 * It is deliberately small: a fallback profile means the database is unreachable
 * or the create failed, and the right response to that is to let the command
 * answer and be honest about the state — not to hand out a full balance that
 * then evaporates on the next write.
 */
const STARTING_MONEY = 500;

/** uid -> { doc, name, expires } */
const store = new Map();

/**
 * Fetch the user's real display name from Facebook when possible.
 *
 * Returns null for anything the API invented rather than looked up. ws3-fca
 * falls back to createDefaultUser(), whose name is the literal string
 * "Facebook User"; storing that is how a profile ended up permanently named
 * "Facebook User" on a leaderboard. Callers substitute a short uid instead, so
 * a failed lookup degrades to an honest label rather than a fake name.
 *
 * Note ws3-fca returns `firstName`, not `first_name` — the snake_case key never
 * existed, so that fallback used to be dead code.
 */
async function fetchName(uid, api) {
  try {
    if (api && typeof api.getUserInfo === 'function') {
      const info = await api.getUserInfo(uid);
      const name = info && (info.name || info.firstName);
      if (name && !profile.isPlaceholderName(name)) return String(name).trim();
    }
  } catch (err) {
    error(`[CACHE] getUserInfo(${uid}) failed: ${err.message}`);
  }
  return null;
}

/**
 * A profile that lives only in memory.
 *
 * Used when there is no database, and when a lookup or a create failed. It is
 * NOT a degraded null: callers read userDoc.coins straight away and then call
 * userDoc.save(), so a stub without those is what turned "the database blinked"
 * into "could not load profile" in chat for everybody but the person whose
 * profile was already cached.
 *
 * `transient: true` is the flag every caller checks before trusting a write.
 * Nothing here is persisted, so a command that mutates this doc loses the
 * change on restart — which is honest, and better than a real write against a
 * document nobody can find.
 *
 * @param {string} id
 * @param {string|null} [name] a real Facebook name, when one could be fetched
 * @returns {object}
 */
function transientUser(id, name) {
  const doc = {
    uid: String(id),
    name: name || `User ${String(id).slice(-4)}`,
    level: 1,
    xp: 0,
    coins: STARTING_MONEY,
    money: STARTING_MONEY,
    bank: 0,
    reputation: 0,
    prestige: 0,
    isBanned: false,
    banReason: '',
    stats: { messages: 0, commandsUsed: 0 },
    gc: {},
    transient: true,
    // Callers adjust a resolved target and then save it without asking whether
    // it is real. Without this the offline path throws "target.save is not a
    // function" instead of quietly doing nothing, which is a worse failure than
    // the one being worked around.
    async save() { return doc; },
  };
  return doc;
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
    const stub = transientUser(id, await fetchName(id, api));
    store.set(id, { doc: stub, expires: Date.now() + TTL });
    return stub;
  }

  try {
    let user = await User.findOne({ uid: id });
    const liveName = await fetchName(id, api);

    if (!user) {
      try {
        user = await User.create({
          uid: id,
          // A distinct value here, not a default. See
          // models/User.js: a legacy non-sparse UNIQUE index on
          // facebookId indexes an absent field as null, so every
          // new account after the first collided with it.
          facebookId: id,
          name: liveName || `User ${id.slice(-4)}`,
          money: STARTING_MONEY,
        });
      } catch (dup) {
        // Two messages from the same brand-new account can land
        // together, and both miss the findOne above. The loser of
        // that race gets a duplicate key; the winner's document is
        // already there, so read it instead of failing.
        if (!/duplicate key/i.test(dup.message)) throw dup;
        user = await User.findOne({ uid: id });
        if (!user) throw dup;
      }
      log(`[CACHE] New user ${id} (${user.name})`);
    } else if (liveName && liveName !== user.name) {
      user.name = liveName;
      await user.save();
    } else if (!liveName && profile.isPlaceholderName(user.name)) {
      // A name the API invented, cached from an earlier failed lookup. Replace
      // it with an honest short id instead of leaving "Facebook User" on the
      // leaderboards until the next successful lookup happens to come along.
      user.name = `User ${id.slice(-4)}`;
      await user.save();
    }

    store.set(id, { doc: user, expires: Date.now() + TTL });
    return user;
  } catch (err) {
    error(`[CACHE] getUser(${id}) failed: ${err.message}`);
    return null;
  }
}

/**
 * Get a user profile, creating it when it is missing, and NEVER returning null.
 *
 * This replaces the bare getUser() at every call site that was going to
 * complain if it came back empty. Three things used to be conflated into that
 * one null and all three are now separated:
 *
 *   - "this person has never used the bot"   -> create a real profile
 *   - "the database is asleep"                -> transient profile from memory
 *   - "the lookup itself blew up"             -> transient profile from memory
 *
 * Only the middle and last are degraded, and neither throws. A command must
 * answer when Mongo is having a bad minute; the alternative is a wall of
 * "could not load your profile" for everybody except whoever was cached first.
 *
 * @param {string|number} uid
 * @param {object} [api] ws3-fca client, used for the name lookup
 * @returns {Promise<object>} a User document, or an in-memory stub. Always truthy.
 */
async function getOrCreateUser(uid, api) {
  if (!uid) return transientUser('unknown', null);
  const id = String(uid);

  // Only keep a fallback once it is already cached; a failed lookup should not
  // pin a stub in front of the real profile for the whole TTL.
  const hit = store.get(id);
  if (hit && Date.now() < hit.expires && hit.doc && hit.doc.transient) return hit.doc;

  try {
    const doc = await getUser(id, api);
    if (doc) return doc;
  } catch (err) {
    error(`[CACHE] getOrCreateUser(${id}) failed: ${err.message}`);
  }

  error(`[CACHE] no database for ${id} — serving a temporary in-memory profile.`);
  const stub = transientUser(id, await fetchName(id, api));
  store.set(id, { doc: stub, expires: Date.now() + TTL });
  return stub;
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

// ─────────────────────────────────────────────────────────────
// MODULE 5 — GAME STATE
//
// Three short-lived maps so the games do not need their own tables:
//   pendingGames : duel challenges waiting on an accept
//   gameState    : an in-progress puzzle/board per hunter
//   gameBans     : temporary gambling bans (russian roulette)
// ─────────────────────────────────────────────────────────────

/** `${game}:${threadID}:${challengedUid}` -> challenge payload */
const pendingGames = new Map();

function gameKey(game, threadID, uid) {
  return `${game}:${threadID}:${uid}`;
}

/** Park a challenge. @returns {boolean} false when one already exists */
function setPendingGame(game, threadID, uid, payload) {
  const key = gameKey(game, threadID, uid);
  if (pendingGames.has(key)) return false;
  pendingGames.set(key, { ...payload, expires: Date.now() + 2 * 60 * 1000 });
  return true;
}

/**
 * Park a challenge, overwriting any existing one.
 *
 * Used when a fresh game is genuinely starting and must not inherit a stale
 * board. setPendingGame() deliberately refuses to overwrite, so a leftover
 * entry would otherwise attach the new duel to somebody else's old board.
 */
function putPendingGame(game, threadID, uid, payload) {
  const key = gameKey(game, threadID, uid);
  pendingGames.set(key, { ...payload, expires: Date.now() + 2 * 60 * 1000 });
  return true;
}

function getPendingGame(game, threadID, uid) {
  return pendingGames.get(gameKey(game, threadID, uid)) || null;
}

function takePendingGame(game, threadID, uid) {
  const key = gameKey(game, threadID, uid);
  const found = pendingGames.get(key) || null;
  pendingGames.delete(key);
  return found;
}

/** Any unexpired challenge aimed at this hunter, across all games. */
function pendingGameFor(threadID, uid) {
  const suffix = `:${threadID}:${uid}`;
  for (const [k, v] of pendingGames) {
    if (k.endsWith(suffix) && Date.now() < v.expires) return { key: k, ...v };
  }
  return null;
}

/** uid -> { game, payload, expires } — an unfinished puzzle or board. */
const gameState = new Map();

function setGameState(uid, game, payload, ttlMs = 10 * 60 * 1000) {
  gameState.set(String(uid), { game, payload, expires: Date.now() + ttlMs });
}

function getGameState(uid) {
  const hit = gameState.get(String(uid));
  if (!hit) return null;
  if (Date.now() >= hit.expires) {
    gameState.delete(String(uid));
    return null;
  }
  return hit;
}

function clearGameState(uid) {
  gameState.delete(String(uid));
}

/** uid -> expiry ms — a hunter locked out of the games for a while. */
const gameBans = new Map();

function banFromGames(uid, ms) {
  gameBans.set(String(uid), Date.now() + ms);
}

/** Remaining ban in ms (0 when not banned). */
function gameBanLeft(uid) {
  const until = gameBans.get(String(uid));
  if (!until) return 0;
  if (Date.now() >= until) {
    gameBans.delete(String(uid));
    return 0;
  }
  return until - Date.now();
}

function sweepGames() {
  const now = Date.now();
  for (const [k, v] of pendingGames) if (!v || now >= v.expires) pendingGames.delete(k);
  for (const [k, v] of gameState) if (now >= v.expires) gameState.delete(k);
  for (const [k, v] of gameBans) if (now >= v) gameBans.delete(k);
}

const size = () => store.size;
const clear = () => store.clear();

module.exports = {
  getUser, getOrCreateUser, invalidate, touch, sweep, size, clear, TTL, STARTING_MONEY,
  // module 4 — pet challenges and reply-to targeting
  setPendingBattle, getPendingBattle, takePendingBattle, clearPendingBattle,
  sweepBattles, battleCount,
  rememberMessage, ownerOfMessage, sweepMessages,
  // module 5 — game state
  setPendingGame, putPendingGame, getPendingGame, takePendingGame, pendingGameFor,
  setGameState, getGameState, clearGameState,
  banFromGames, gameBanLeft, sweepGames,
};
