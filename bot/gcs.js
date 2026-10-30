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
const mongo = require('./mongo');
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
 * How many accounts one cleanup run may remove, and how long it waits between
 * removals.
 *
 * This is an account-safety limit, not a performance one. A cleanup run scans
 * up to a hundred chats, and each of those can hold a handful of dead accounts,
 * so an unbounded run can produce several hundred `gcmember remove` calls in
 * one tight loop. A bot that bulk-edits membership across dozens of groups in
 * seconds is doing exactly what the platform's abuse systems look for, and the
 * account pays for it — not the dead accounts.
 *
 * So the run is capped, and the removals are paced. The cap is what makes the
 * feature usable day to day: a chat with three dead accounts is cleared in one
 * run, and a chat with thirty is cleared over a few days. That is the right
 * trade for something nobody notices.
 */
const REMOVE_LIMIT_PER_RUN = 25;
const REMOVE_DELAY_MS = 1500;
const REMOVE_JITTER_MS = 1500;

/**
 * How many members of ONE chat may be asked about by name.
 *
 * A chat with four hundred members would otherwise spend four hundred
 * requests on itself, which is the same runaway the run cap exists to stop —
 * only on the reading side instead of the writing side.
 */
const LOOKUP_BUDGET_PER_CHAT = 40;

/**
 * The names Facebook invents instead of resolving a profile.
 *
 * ws3-fca's createDefaultUser() returns "Facebook User" when it cannot resolve
 * somebody, and a few builds answer with the bare username instead.
 */
const PLACEHOLDER_NAME = /^(facebook user|facebookuser|unknown|messenger user)$/i;

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
  if (PLACEHOLDER_NAME.test(name)) return true;

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
  // A caller may hand us anything; the API only takes a positive
  // integer, so fall back rather than throw on every chat.
  const ask = Number.isInteger(limit) && limit > 0 ? limit : THREAD_LIMIT;
  try {
    // ws3-fca's signature is getThreadList(limit, timestamp, tags):
    // the FIRST argument is the count, not a chat type. Passing
    // 'gchat' there made every call throw "limit must be a positive
    // integer", so the boot sweep, !gclist and !gccleanup each read
    // an empty list and reported nothing — silently, because the
    // failure was caught and logged where only a deploy log looks.
    const list = await api.getThreadList(ask, null, ['INBOX']);
    // The API returns every inbox thread, direct messages included.
    // This module is the group-chat sweep, so keep the groups: the
    // 'gchat' that used to be passed as the type was asking for
    // exactly this filter.
    return (Array.isArray(list) ? list : []).filter((t) => t && t.isGroup);
  } catch (err) {
    error(`[GCS] getThreadList failed: ${err.message}`);
    // Facebook is the source of truth for "which chats is the bot in",
    // and it is the source that goes down. A bot whose group list is
    // only ever live can report an empty list forever the moment the
    // call throws — which is exactly what happened: every !gclist,
    // !gccleanup and boot sweep read [] and said "no groups", with no
    // trace of the error visible to the person asking.
    //
    // The Group collection is written on every join and on every
    // approval, so it is the durable copy. Fall back to it rather than
    // returning nothing, and say so in the caller's reply.
    return listThreadsFromDB();
  }
}

/**
 * The group list from the database, used when Facebook will not answer.
 *
 * @returns {Promise<object[]>} rows shaped like getThreadList entries,
 *   with tid, isGroup:true and whatever threadName the record holds
 */
async function listThreadsFromDB() {
  if (!mongo.isReady()) return [];
  try {
    // eslint-disable-next-line global-require
    const Group = require('../models/Group');
    const rows = await Group.find({}).sort({ _id: 1 }).lean().catch(() => null);
    if (!rows) return [];
    return rows.map((g) => ({
      threadID: String(g.tid),
      tid: String(g.tid),
      isGroup: true,
      name: g.threadName || '',
    }));
  } catch (err) {
    error(`[GCS] database fallback for thread list failed: ${err.message}`);
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

  // Only a member whose NAME is missing or is a known placeholder is worth a
  // second question.
  //
  // A member with a real name is not doubtful just because Facebook sent no
  // picture — and it usually sent no picture: `big_image_src` is null for most
  // members of a group, which is precisely why this repo ships an install
  // patch for the thread formatters reading that field unguarded. Asking about
  // every one of them anyway was one request per member of every group: five
  // thousand calls for a hundred chats, every one of them Facebook noticing.
  //
  // The comment further down says it: only a NAME can rescue a doubtful
  // member, a thumbnail cannot. So the doubtful ones are the ones without a
  // name in the first place.
  const doubtful = members.filter((m) => !m.name || PLACEHOLDER_NAME.test(m.name));
  if (!doubtful.length || typeof api.getUserInfo !== 'function') return members;

  // And the budget is per chat, so one enormous group cannot spend the whole
  // run on itself.
  const ask = doubtful.slice(0, LOOKUP_BUDGET_PER_CHAT);
  for (const m of ask) {
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
 * The bot leaves a group chat.
 *
 * There is no `api.leaveThread()` in this build of ws3-fca — the method does
 * not exist, so a command that called it could only ever answer "this build
 * cannot leave". What the build DOES have is `api.gcmember('remove', uid,
 * threadID)`, which is how the bot already clears dead accounts out of a
 * chat. A member removing itself from a group is a member leaving, and
 * Facebook treats it the same way: the same log:unsubscribe event arrives
 * moments later.
 *
 * @param {object} api ws3-fca client
 * @param {string} threadID the chat to leave
 * @returns {Promise<{left:boolean, reason:string}>}
 */
async function leave(api, threadID) {
  const tid = String(threadID || '').trim();
  if (!tid) return { left: false, reason: 'no chat id' };
  if (!api) return { left: false, reason: 'no client' };

  // A build that grows a real leaveThread() gets to use it.
  if (typeof api.leaveThread === 'function') {
    try {
      const ok = await api.leaveThread(tid);
      return { left: Boolean(ok), reason: ok ? '' : 'Facebook refused the request' };
    } catch (err) {
      return { left: false, reason: (err && err.message) || String(err) };
    }
  }

  if (typeof api.gcmember !== 'function') {
    return { left: false, reason: 'this build of ws3-fca has neither leaveThread() nor gcmember()' };
  }

  // The bot's own id. `api.getCurrentUserID()` returns a PROMISE, so it has to
  // be awaited — stringifying it would give the literal text
  // "[object Promise]", which is not a member of anything.
  let me = '';
  try {
    if (typeof api.getCurrentUserID === 'function') {
      const id = await api.getCurrentUserID();
      if (typeof id === 'string' || typeof id === 'number') {
        const s = String(id);
        if (/^\d+$/.test(s)) me = s;
      }
    }
  } catch { /* fall through to the error below */ }
  if (!me) return { left: false, reason: 'the bot does not know its own id' };

  try {
    await api.gcmember('remove', me, tid);
    return { left: true, reason: '' };
  } catch (err) {
    return { left: false, reason: (err && err.message) || String(err) };
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
  // The run is capped, and the removals are paced. Both are about the account
  // rather than the feature: a bot that bulk-removes members across dozens of
  // groups in a tight loop is doing what the platform's abuse systems look
  // for. The leftovers are reported, so nothing is silently skipped — the next
  // run picks them up.
  //
  // `maxRemovals` is its own option because `limit` already means "how many
  // chats to scan" in this function.
  const budget = Number.isInteger(opts.maxRemovals) && opts.maxRemovals > 0
    ? Math.min(opts.maxRemovals, REMOVE_LIMIT_PER_RUN)
    : REMOVE_LIMIT_PER_RUN;
  let skipped = 0;
  for (const entry of dead) {
    if (dryRun) continue;
    if (removed.length + stuck.length >= budget) {
      skipped += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, REMOVE_DELAY_MS + Math.floor(Math.random() * REMOVE_JITTER_MS)));
    // eslint-disable-next-line no-await-in-loop
    if (await kick(api, entry.uid, entry.threadID)) removed.push(entry);
    else stuck.push(entry);
  }

  const report = { scanned: threads.length, dead, removed, stuck, skipped };
  log(`[GCS] cleanup: ${threads.length} chat(s), ${dead.length} dead account(s), ${removed.length} removed, ${stuck.length} could not be removed${skipped ? `, ${skipped} left for the next run` : ''}.`);
  return report;
}

/**
 * Make sure every chat the bot is in is enabled, without touching approval.
 *
 * Called on boot. This used to approve every chat it found, which is precisely
 * how the old approval list failed: the sweep ran on every restart, so any
 * lock was undone by the next deploy. A pending chat is now skipped, because
 * the one moment a lock must hold is the moment the process comes back up.
 *
 * @param {object} api ws3-fca client
 * @returns {Promise<number>} how many chats were enabled
 */
async function approveAll(api) {
  const threads = await listThreads(api);
  let approved = 0;
  let held = 0;
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
      // The flag is read, never written. A chat that is waiting for a decision
      // keeps waiting, and is left locked and un-enabled.
      if (group.pendingApproval === true) {
        held += 1;
        continue;
      }
      group.isApproved = true;
      group.isEnabled = true;
      // eslint-disable-next-line no-await-in-loop
      await group.save();
      approved += 1;
    } catch (err) {
      error(`[GCS] enable-sweep of ${tid} failed: ${err.message}`);
    }
  }
  if (approved) log(`[GCS] Enabled ${approved} group chat(s).`);
  if (held) log(`[GCS] Left ${held} group chat(s) locked, pending approval.`);
  return approved;
}

/**
 * Turn wild Pokemon spawns off in every group the bot already knows about.
 *
 * Runs on every boot so a deploy flips every existing chat to off, not just
 * groups added from now on. New groups already default to `enabled: false` in
 * the schema; this sweeps the ones written before that default existed, or
 * that an admin previously turned on with `!pokemon on`. It is idempotent:
 * setting false on a chat that is already false is a no-op.
 *
 * @returns {Promise<number>} how many chats were flipped
 */
async function disablePokemonEverywhere() {
  try {
    // Imported here rather than at the top: models/Group is required by
    // bot/toggles.js, which the engine requires — a top-level require here
    // would create a circular dependency.
    // eslint-disable-next-line global-require
    const Group = require('../models/Group');
    const result = await Group.updateMany(
      { 'pokemon.enabled': true },
      { 'pokemon.enabled': false }
    );
    if (result.modifiedCount) {
      log(`[GCS] Disabled Pokemon spawns in ${result.modifiedCount} group chat(s).`);
    }
    return result.modifiedCount;
  } catch (err) {
    error(`[GCS] disable-pokemon sweep failed: ${err.message}`);
    return 0;
  }
}

/**
 * Write every thread Facebook hands back, so the group list survives.
 *
 * `!gclist` and the boot sweep ask Facebook for the chats the bot is in, and
 * Facebook is the one source that goes down — an expired appstate, a
 * restriction, a network blip. When that call throws the live list is empty,
 * and a bot whose roster is only ever live reports "no groups" forever.
 *
 * The Group collection is the durable copy. This runs once, right after login,
 * and records every thread id the account can see. Later writes (approvals,
 * joins) keep it current; the fallback in listThreads() reads it when the live
 * call fails. A thread that has since left is simply not re-listed, which is
 * the right answer — it is not a chat the bot is in any more.
 *
 * Best effort and best-effort-only: it never throws, and a database that is
 * not yet up is skipped rather than blocking login.
 *
 * @param {object} api ws3-fca client
 * @returns {Promise<number>} how many thread ids were recorded
 */
async function cacheThreadsOnLogin(api) {
  if (!api || typeof api.getThreadList !== 'function' || !mongo.isReady()) return 0;
  let recorded = 0;
  try {
    // eslint-disable-next-line global-require
    const Group = require('../models/Group');
    // eslint-disable-next-line global-require
    const toggles = require('./toggles');
    const list = await api.getThreadList(THREAD_LIMIT, null, ['INBOX']);
    const rows = Array.isArray(list) ? list : [];
    for (const t of rows) {
      const tid = tidOf(t);
      if (!tid) continue;
      try {
        // getGroup creates the document approved and enabled, which is the
        // normal state for a chat the bot is already in. It does NOT touch a
        // chat that is pending approval — that decision belongs to pending.js.
        const group = await toggles.getGroup(tid);
        if (!group) continue;
        if (group.threadName && group.threadName !== String(tid)) continue; // already labelled
        const name = (t && (t.name || t.threadName)) || '';
        if (name && group.threadName !== name) {
          group.threadName = String(name);
          // eslint-disable-next-line no-await-in-loop
          await group.save();
        }
        recorded += 1;
      } catch (err) {
        // One bad thread must not cost the rest of the roster.
        error(`[GCS] could not record ${tid} at login: ${err.message}`);
      }
    }
  } catch (err) {
    error(`[GCS] thread cache at login failed: ${err.message}`);
  }
  return recorded;
}

module.exports = {
  THREAD_LIMIT,
  KICK_TTL_MS,
  PLACEHOLDER_NAME,
  isDeadAccount,
  listThreads,
  tidOf,
  membersOf,
  exemptIds,
  kick,
  leave,
  markKicked,
  wasKicked,
  clearKicks,
  cleanup,
  approveAll,
  cacheThreadsOnLogin,
  disablePokemonEverywhere,
};