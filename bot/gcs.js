'use strict';

/**
 * Group chat management — every chat the bot is in.
 *
 * THREE THINGS LIVE HERE, and they are the same concern: the bot is in more than
 * ten group chats now, and each of them used to be a manual chore.
 *
 * 1. LISTING. `api.getThreadList('gchat', 10)` was the only listing anyone wrote,
 *    and ten is fewer chats than the bot is actually in — so "I only see 10
 *    groups" was the list being right and the expectation being wrong. The limit
 *    here is 100, which is above the ceiling anybody actually runs at.
 *
 * 2. APPROVAL. There is no approved list any more. A chat the bot is in is a
 *    chat it serves; requiring an owner to approve each one meant a new group
 *    looked broken until somebody noticed. approveAll() marks every known thread
 *    approved on boot, and getGroup() in bot/toggles.js creates unknown threads
 *    already approved.
 *
 * 3. CLEANUP. Dead accounts accumulate in group chats permanently. A dead
 *    account is one whose profile the API cannot resolve any more: ws3-fca falls
 *    back to the literal string "Facebook User" and a stock avatar. Those are
 *    banned or deactivated accounts, they never post again, and they make every
 *    member count wrong. `cleanup()` finds them and removes them.
 */

const permissions = require('./permissions');
const { log, error } = require('./helpers');

/**
 * Removals this bot performed, waiting for Facebook to echo them back.
 *
 * A `gcmember('remove')` arrives at the event listener as the same
 * log:unsubscribe a person leaving produces, and the listener cannot tell them
 * apart from the payload alone: both carry a `leftParticipantFbId` and nothing
 * saying who asked. So the decision is recorded here, at the only place the bot
 * knows it, and read back by the goodbye path.
 *
 * Short-lived on purpose. The event lands in seconds, and a marker that outlived
 * it would silence the goodbye for somebody who genuinely left later.
 */
const kicked = new Map();

/** How long a bot removal is remembered, in milliseconds. */
const KICK_TTL_MS = 60 * 1000;

/**
 * Record that this bot removed somebody from this chat.
 *
 * @param {string|number} threadID
 * @param {string|number} uid
 */
function markKicked(threadID, uid) {
  const t = String(threadID || '');
  const u = String(uid || '');
  if (!t || !u) return;
  pruneKicks();
  kicked.set(`${t}::${u}`, Date.now() + KICK_TTL_MS);
}

/**
 * Did this bot just remove that person from that chat?
 *
 * @param {string|number} threadID
 * @param {string|number} uid
 * @returns {boolean}
 */
function wasKicked(threadID, uid) {
  const key = `${String(threadID || '')}::${String(uid || '')}`;
  const expiry = kicked.get(key);
  if (!expiry) return false;
  if (Date.now() >= expiry) {
    kicked.delete(key);
    return false;
  }
  return true;
}

/** Drop expired markers so the Map cannot grow forever. */
function pruneKicks() {
  const now = Date.now();
  for (const [key, expiry] of kicked) if (now >= expiry) kicked.delete(key);
}

/** Forget every marker. Exposed for tests. */
function clearKicks() {
  kicked.clear();
}

/**
 * How many chats to ask Facebook for.
 *
 * 100, not 10. The old call asked for ten and the bot was in more than ten, so
 * the tail was invisible: a spawner announced into a chat and cleanup never saw
 * it, and both looked like the feature was broken on specific groups.
 */
const THREAD_LIMIT = 100;

/**
 * Is this account dead?
 *
 * Two independent signals, because each alone lies:
 *   - the API invented a name ("Facebook User" is what ws3-fca's
 *     createDefaultUser() returns when it cannot resolve a profile)
 *   - the avatar is a stock one. Facebook serves those from paths containing
 *     "default", "no_pic" and friends.
 *
 * A MISSING avatar is not one of the signals. Plenty of live people have no
 * profile picture, and Facebook answers with an empty thumbSrc for a chat member
 * it simply will not resolve — throwing those out would empty a group of real
 * members. Only a name that cannot belong to a person, or an avatar that is
 * demonstrably the stock one, counts.
 *
 * @param {{id?:string,uid?:string,name?:string,thumbSrc?:string}} member
 * @returns {boolean}
 */
function isDeadAccount(member) {
  // Accepts both shapes on purpose: raw `userInfo` rows from getThreadInfo carry
  // `id`, and the normalised rows membersOf() returns carry `uid`. Checking only
  // `id` here silently reported zero dead accounts, because every caller feeds
  // this function the normalised rows.
  if (!member || !(member.id || member.uid)) return false;

  const name = String(member.name || '').trim().toLowerCase();
  if (!name) return true; // nothing to call them, and nothing to appeal with
  if (name === 'facebook user' || name === 'unknown' || name === 'facebookuser') return true;

  const thumb = String(member.thumbSrc || member.profilePicUrl || '').trim();
  return /default|no[._-]?pic|blank|silhouette|unrecognized/i.test(thumb);
}

/**
 * Every group chat, up to THREAD_LIMIT.
 *
 * @param {object} api ws3-fca client
 * @param {number} [limit]
 * @returns {Promise<object[]>} [] when the client cannot list
 */
async function listThreads(api, limit = THREAD_LIMIT) {
  if (!api || typeof api.getThreadList !== 'function') return [];
  try {
    const list = await api.getThreadList('gchat', limit, {});
    return Array.isArray(list) ? list : [];
  } catch (err) {
    error(`[GCS] getThreadList failed: ${err.message}`);
    return [];
  }
}

/** The thread id of a getThreadList entry, whichever field it arrived in. */
const tidOf = (thread) => String((thread && (thread.threadID || thread.tid || thread.id)) || '');

/**
 * The members of one chat, with their real name and avatar.
 *
 * getThreadInfo answers with `userInfo`, which already carries a name and a
 * thumbSrc for everybody in the chat — one request for the whole membership.
 *
 * That answer is not always complete. A member Facebook will not resolve comes
 * back as "Facebook User", and some thread listings arrive with no name at all.
 * Those two cases — and only those two — are re-asked about individually with
 * getUserInfo, because it is a different endpoint and it is the only thing that
 * can tell a placeholder from a real person. Asking it for everybody would be
 * one request per member of every group, which is how cleanup turns into a
 * timeout.
 *
 * @param {object} api
 * @param {string|number} threadID
 * @returns {Promise<{uid:string, name:string, thumbSrc:string}[]>}
 */
async function membersOf(api, threadID) {
  if (!api || typeof api.getThreadInfo !== 'function' || !threadID) return [];

  let list = [];
  try {
    const info = await api.getThreadInfo(threadID);
    list = (info && info.userInfo) || [];
  } catch (err) {
    error(`[GCS] getThreadInfo(${threadID}) failed: ${err.message}`);
    return [];
  }
  if (!list.length) return [];

  const members = list.map((u) => ({
    uid: String(u.id),
    name: String(u.name || u.firstName || '').trim(),
    thumbSrc: String(u.thumbSrc || '').trim(),
  }));

  const doubtful = members.filter((m) => !m.name || !m.thumbSrc);
  if (!doubtful.length || typeof api.getUserInfo !== 'function') return members;

  for (const m of doubtful) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const one = await api.getUserInfo(m.uid);
      if (!one) continue;
      const name = String(one.name || one.firstName || '').trim();
      // Only a name can rescue a doubtful member. A thumbnail cannot: the whole
      // point of asking was that we had none, and getUserInfo answers the same
      // way for a dead account.
      if (name && name.toLowerCase() !== 'facebook user') m.name = name;
      const thumb = String(one.thumbSrc || one.profilePicUrl || '').trim();
      if (thumb) m.thumbSrc = thumb;
    } catch {
      // A failed lookup leaves the member as the thread described them, which is
      // what isDeadAccount then judges.
    }
  }

  return members;
}

/** Ids that must never be removed: the bot itself and the bot admins. */
async function exemptIds(api, threadID) {
  const set = new Set(permissions.ownerIds());
  try {
    if (typeof api.getCurrentUserID === 'function') {
      const me = await api.getCurrentUserID();
      if (me) set.add(String(me));
    }
  } catch { /* keep the env admins */ }
  try {
    // A chat's own admins are protected here as well: removing a moderator with
    // one command is not what "clean up dead accounts" should ever do.
    if (typeof api.getThreadInfo === 'function') {
      const info = await api.getThreadInfo(threadID);
      for (const id of (info && info.adminIDs) || []) set.add(String(id));
    }
  } catch { /* keep the env admins */ }
  return set;
}

/**
 * Remove one member from a chat.
 *
 * @returns {Promise<boolean>} whether Facebook accepted it
 */
async function kick(api, uid, threadID) {
  if (!api || typeof api.gcmember !== 'function') return false;
  try {
    await api.gcmember('remove', String(uid), String(threadID));
    // Facebook answers this with the same log:unsubscribe event a human leaving
    // produces, moments later. Marked here so the goodbye card knows the
    // difference between somebody who walked out and a dead account the bot
    // cleared out of the roster — the second is not a loss to mourn.
    markKicked(threadID, uid);
    return true;
  } catch (err) {
    error(`[GCS] gcmember remove ${uid} from ${threadID} failed: ${err.message}`);
    return false;
  }
}

/**
 * Find dead accounts across every chat, and try to remove them.
 *
 * NEVER removes the bot or a bot admin. When Facebook refuses the removal the
 * member is still REPORTED — a cleanup that silently drops half its work is how
 * you end up re-running it every day wondering why the count never falls.
 *
 * @param {object} api ws3-fca client
 * @param {{dryRun?:boolean, limit?:number}} [opts] dryRun lists without removing
 * @returns {Promise<{scanned:number, dead:Array, removed:Array, stuck:Array}>}
 */
async function cleanup(api, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const threads = await listThreads(api, opts.limit || THREAD_LIMIT);
  const dead = [];

  for (const thread of threads) {
    const tid = tidOf(thread);
    if (!tid) continue;
    // eslint-disable-next-line no-await-in-loop
    const members = await membersOf(api, tid);
    const exempt = await exemptIds(api, tid);

    for (const m of members) {
      if (!m.uid || exempt.has(m.uid)) continue;
      if (!isDeadAccount(m)) continue;
      dead.push({ threadID: tid, uid: m.uid, name: m.name || '(no name)', thumbSrc: m.thumbSrc });
    }
  }

  const removed = [];
  const stuck = [];
  for (const entry of dead) {
    if (dryRun) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await kick(api, entry.uid, entry.threadID)) removed.push(entry);
    else stuck.push(entry);
  }

  const report = { scanned: threads.length, dead, removed, stuck };
  log(`[GCS] cleanup: ${threads.length} chat(s), ${dead.length} dead account(s), ${removed.length} removed, ${stuck.length} could not be removed.`);
  return report;
}

/**
 * Mark every chat the bot is in as approved and enabled.
 *
 * Called on boot. The approved list was the reason a freshly added group sat
 * there refusing commands until an owner noticed it existed — with more than
 * ten groups that check was never going to be maintained by hand.
 *
 * @param {object} api ws3-fca client
 * @returns {Promise<number>} how many chats were approved
 */
async function approveAll(api) {
  const threads = await listThreads(api);
  let approved = 0;
  for (const thread of threads) {
    const tid = tidOf(thread);
    if (!tid) continue;
    try {
      // Imported here rather than at the top: bot/toggles.js requires
      // models/Group, and a cycle through the engine would be circular.
      // eslint-disable-next-line global-require
      const toggles = require('./toggles');
      // eslint-disable-next-line no-await-in-loop
      const group = await toggles.getGroup(tid);
      group.isApproved = true;
      group.pendingApproval = false;
      group.isEnabled = true;
      // eslint-disable-next-line no-await-in-loop
      await group.save();
      approved += 1;
    } catch (err) {
      error(`[GCS] auto-approve of ${tid} failed: ${err.message}`);
    }
  }
  if (approved) log(`[GCS] Auto-approved ${approved} group chat(s).`);
  return approved;
}

module.exports = {
  THREAD_LIMIT,
  KICK_TTL_MS,
  isDeadAccount,
  listThreads,
  tidOf,
  membersOf,
  exemptIds,
  kick,
  markKicked,
  wasKicked,
  clearKicks,
  cleanup,
  approveAll,
};