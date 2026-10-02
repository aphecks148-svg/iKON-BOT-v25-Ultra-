'use strict';

/**
 * Who did you mean?
 *
 * Every command that acts on a person needs the same thing: turn what the user
 * typed — a tag, a name, a bare id — into a uid, and ideally into the name that
 * person actually goes by on Facebook. This module is the one place that does
 * it, because eight modules each grew their own copy and every copy had the
 * same bug: `event.mentions` is { uid: name }, so reading the VALUES hands back
 * the display name, and looking somebody up by uid "Alice" never matches. The
 * result was that tagging somebody — the one case that is supposed to be
 * certain — failed with "nobody called Alice is here".
 *
 * THE THREAD IS THE ANSWER
 * `api.getThreadInfo(threadID)` returns a `userInfo` array carrying the real
 * Facebook name, the username, and the profile picture for every member of the
 * chat, in ONE request. That is what makes a name typed from memory resolve,
 * and it is why a command knows a person's real name instead of whatever half
 * of it was cached the first time we met.
 *
 * Order of attempts, cheapest first:
 *   1. a bare numeric id                       (no lookup at all)
 *   2. the uid key of a tag in the message     (no lookup at all)
 *   3. the name of a tag in the message        (no lookup at all)
 *   4. the chat's own member list              (one request)
 *   5. a name we have seen before              (one query)
 */

const User = require('../models/User');
const cache = require('./cache');
const mongo = require('./mongo');

/** Escape a user-supplied name before it goes inside a RegExp. */
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * The chat's member list, briefly cached.
 *
 * A moderation command resolves a target and then usually renders a card with
 * a picture, and the picture path asks the same question again. Without this,
 * one `!kick` costs several identical thread lookups. Short TTL because a group
 * changes hands and a stale member list means kicking somebody who already left.
 *
 * @param {object} event
 * @param {object} api ws3-fca client
 * @param {number} [ttlMs]
 * @returns {Promise<object|null>}
 */
const THREAD_TTL = 20000;
const threadCache = new Map();

async function threadInfo(event, api, ttlMs = THREAD_TTL) {
  if (!event || !api || typeof api.getThreadInfo !== 'function') return null;
  if (!event.threadID) return null;
  const key = String(event.threadID);
  const hit = threadCache.get(key);
  if (hit && Date.now() < hit.expires) return hit.info;

  try {
    const info = await api.getThreadInfo(key);
    if (info) threadCache.set(key, { info, expires: Date.now() + ttlMs });
    return info || null;
  } catch {
    return null;
  }
}

/** Forget cached thread info. Used after a membership change and by !reload. */
function clear() {
  threadCache.clear();
}

/**
 * The real Facebook identity of one chat member, straight from the thread.
 *
 * @param {string|number} uid
 * @param {object} event
 * @param {object} api
 * @returns {Promise<{uid:string,name:string,picture:string}|null>}
 */
async function threadMember(uid, event, api) {
  const info = await threadInfo(event, api);
  const wanted = String(uid || '');
  const hit = (info && info.userInfo ? info.userInfo : [])
    .find((u) => String(u && u.id) === wanted);
  if (!hit) return null;
  return {
    uid: wanted,
    // `name` is the display name, `firstName` the short one, and a nickname set
    // in this chat wins over both — it is what the user last chose to be called.
    name: String(hit.name || hit.firstName || '').trim() || wanted,
    picture: String(hit.thumbSrc || '').trim(),
  };
}

/**
 * The half of `resolve` that costs nothing: bare uid, tag key, tag name.
 *
 * Split out so `resolveArgs` can try every word-count with no network or
 * database access before it pays for a thread lookup.
 *
 * @param {string|number} ref
 * @param {object} event
 * @returns {{uid:string}|null}
 */
function resolveFast(ref, event) {
  const clean = String(ref == null ? '' : ref).replace(/^@/, '').trim();
  if (!clean) return null;

  const mentions = (event && event.mentions) || {};

  // 1. A bare uid. No network, no database.
  if (/^\d+$/.test(clean)) return { uid: clean };

  // 2. The uid behind a tag, when the user pasted the id as the argument.
  if (mentions[clean]) return { uid: String(mentions[clean]) };

  // 3. A tagged display name. THE KEY IS THE UID.
  const hit = Object.entries(mentions).find(([, n]) => same(n, clean));
  if (hit) return { uid: String(hit[0]) };

  return null;
}

/**
 * Resolve what the user typed into a member of this chat.
 *
 * @param {string|number} ref a tag, a name, or a bare uid
 * @param {object} event needs threadID, isGroup and mentions
 * @param {object} api ws3-fca client
 * @returns {Promise<{uid:string,name:string,doc:object}|null>} null when nobody matches
 */
async function resolve(ref, event, api) {
  const clean = String(ref == null ? '' : ref).replace(/^@/, '').trim();
  if (!clean) return null;

  const cheap = resolveFast(clean, event);
  if (cheap) return finish(cheap.uid, event, api);

  // 4. Ask the chat who is in it, and match on the name Facebook gives us.
  //    One request covers every member, unlike a getUserInfo per candidate.
  const info = await threadInfo(event, api);
  const members = (info && info.userInfo) ? info.userInfo : [];
  const byName = members.find((u) => same(u && u.name, clean) || same(u && u.firstName, clean));
  if (byName) return finish(String(byName.id), event, api);

  // A nickname somebody set in this chat is how they are addressed here, and it
  // is not in userInfo — it is a per-thread customization.
  const nick = info && info.nicknames ? info.nicknames : {};
  const byNick = Object.entries(nick).find(([, n]) => same(n, clean));
  if (byNick) return finish(String(byNick[0]), event, api);

  // 5. Last resort: a name this bot has met before.
  //
  // The isReady() guard is not decoration. A Mongoose query on a disconnected
  // connection does not fail, it buffers for ten seconds and then fails, so an
  // unguarded lookup here would make a mistyped name hang the command for ten
  // seconds and still report "nobody by that name".
  if (mongo.isReady()) {
    const doc = await User.findOne({ name: new RegExp(`^${reEsc(clean)}$`, 'i') }).catch(() => null);
    if (doc) return { uid: String(doc.uid), name: doc.name, doc };
  }

  return null;
}

/**
 * Resolve the FIRST argument of a command when that argument is a person whose
 * name may contain spaces.
 *
 * The parser splits on whitespace, so `!pay @Dyro Urano 10` arrives as three
 * tokens. Handing `args[0]` to `resolve` looks for somebody called "Dyro" and
 * finds nobody, which is why a tagged name with a space in it was unreadable —
 * the one input that is supposed to be certain. Facebook's real mention is a
 * single numeric token, but a name typed by hand is not, and both must work.
 *
 * Tries the longest join first and reports how many tokens the name ate, so the
 * caller can read the arguments after it:
 *
 *   const { target, consumed } = await resolveArgs(args, event, api);
 *   const amount = amountArg(args.slice(consumed), 0);
 *
 * Cheapest wins: every word-count is tried against tags and bare ids first, so
 * the common `@123456 10` costs no requests at all. Only if none of those land
 * do we pay for thread lookups, longest join first, and those are cached.
 *
 * @param {string[]} args
 * @param {object} event
 * @param {object} api
 * @param {{max?:number, doc?:boolean}} [opts] max caps how many tokens may join;
 *   doc hands back a User document (the shape `userDoc` returns) instead of
 *   the lightweight `{uid,name,picture}` record
 * @returns {Promise<{target:object|null, consumed:number}>} consumed is 0 when nothing matched
 */
async function resolveArgs(args, event, api, opts = {}) {
  const list = (Array.isArray(args) ? args : []).map((a) => String(a));
  if (!list.length) return { target: null, consumed: 0 };

  const cap = Math.max(1, Math.min(list.length, opts.max || list.length));

  // Cheap pass: bare ids and tags, no requests. These resolve the common case
  // (`!pay @123456 10`) and they resolve it without touching the network.
  for (let n = cap; n >= 1; n--) {
    const cheap = resolveFast(list.slice(0, n).join(' '), event);
    if (!cheap) continue;
    const target = opts.doc
      ? await userDoc(cheap.uid, event, api)
      : await finish(cheap.uid, event, api);
    return { target, consumed: n };
  }

  // Expensive pass: the chat's own member list, then names met before.
  for (let n = cap; n >= 1; n--) {
    const found = await resolve(list.slice(0, n).join(' '), event, api);
    if (!found) continue;
    return { target: opts.doc ? (found.doc || await userDoc(found.uid, event, api)) : found, consumed: n };
  }

  return { target: null, consumed: 0 };
}

/**
 * Resolve to a User document, which is what most commands want.
 *
 * Drop-in for the eight private resolvers this replaces. Returns null when
 * nobody matches, so callers keep their existing "nobody found" branch.
 *
 * @param {string|number} ref a tag, a name, or a bare uid
 * @param {object} event needs threadID, isGroup and mentions
 * @param {object} api ws3-fca client
 * @returns {Promise<object|null>} a User document, or a stub if the database is down
 */
async function userDoc(ref, event, api) {
  const found = await resolve(ref, event, api);
  if (!found) return null;

  if (found.doc) return found.doc;

  // Resolvable from the message, but the database is asleep. Hand back an
  // in-memory profile so a tag still works offline instead of every
  // !kick failing with a connection error.
  return {
    uid: found.uid,
    name: found.name,
    coins: 0,
    bank: 0,
    reputation: 0,
    level: 1,
    xp: 0,
    transient: true,
    async save() {},
  };
}

/**
 * Attach the real Facebook name (and the profile document) to a uid.
 *
 * @param {string|number} uid
 * @param {object} event
 * @param {object} api
 * @returns {Promise<{uid:string,name:string,doc:object}>}
 */
async function finish(uid, event, api) {
  const id = String(uid);
  // The thread already carries this person's real name and picture, so no extra
  // HTTP request is needed for either.
  const member = await threadMember(id, event, api);
  // getUser creates the profile if it is missing and refreshes the name itself.
  const doc = await cache.getUser(id, api);
  const name = (member && member.name) || (doc && doc.name) || `Hunter ${id.slice(-4)}`;

  // The thread name is better than anything getUser had to work with: getUser
  // has to invent a name when getUserInfo fails, and a name the thread just
  // handed us beats an invention. A stub is only in memory, so correcting it is
  // free — but it must not be saved, because there is nothing to save it to.
  if (doc && doc.name !== name) {
    doc.name = name;
    if (!doc.transient) await doc.save().catch(() => {});
  }

  return { uid: id, name, doc, picture: (member && member.picture) || '' };
}

/**
 * Look somebody up by uid alone — for commands that were handed an id rather
 * than a name.
 *
 * @param {string|number} uid
 * @param {object} [event]
 * @param {object} [api]
 * @returns {Promise<{uid:string,name:string,doc:object}>}
 */
async function byId(uid, event, api) {
  return finish(uid, event, api);
}

module.exports = { resolve, resolveArgs, resolveFast, userDoc, byId, threadMember, threadInfo, clear };
