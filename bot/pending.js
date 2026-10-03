'use strict';

/**
 * Pending approval: the door between "someone added the bot" and "the bot
 * works here".
 *
 * When the bot's own uid lands in a chat that has no Group document, that chat
 * is locked. It answers three commands and nothing else until an owner says
 * otherwise.
 *
 * Mongo is the truth; `pendingLocks` is a cache of it. Every read in the hot
 * path is a Set lookup, because a locked chat must be refused the instant the
 * event arrives and cannot wait on a round trip to decide whether it is
 * allowed to talk. `hydrate()` rebuilds the cache from the database at boot,
 * which is what makes the lock survive a restart — and why nothing here writes
 * a JSON file. A file would be erased by the next deploy, which is precisely
 * the moment a lock that matters most would evaporate.
 */

/** Locked thread ids. Membership is the whole state machine. */
const pendingLocks = new Set();

/** thread id -> human label, for `!pending`. Not security relevant. */
const labels = new Map();

/**
 * Commands a locked chat may still run.
 *
 * `pending` so the person who added the bot can see the chat is merely
 * pending rather than broken. `approve` and `deny` so an owner can end it from
 * inside the chat instead of editing the database by hand.
 */
const ALWAYS_ALLOWED = new Set(['pending', 'approve', 'deny']);

/**
 * Is this chat waiting for a decision?
 *
 * @param {string|number|null|undefined} threadID
 * @returns {boolean}
 */
function isPending(threadID) {
  if (threadID === null || threadID === undefined) return false;
  return pendingLocks.has(String(threadID));
}

/**
 * Every locked chat, oldest request first.
 *
 * @returns {Array<{tid:string,name:string,addedBy:string,requestedAt:Date|null,age:number}>}
 */
function snapshot() {
  return [...pendingLocks]
    .map((tid) => {
      const label = labels.get(tid) || {};
      return {
        tid,
        name: label.name || '(unknown chat)',
        addedBy: label.addedBy || 'someone',
        requestedAt: label.requestedAt || null,
        age: label.requestedAt ? Date.now() - new Date(label.requestedAt).getTime() : 0,
      };
    })
    // Oldest request first, which is the order an owner works through them in.
    // Rows with no recorded time sort last rather than comparing as NaN: `null -
    // <number>` is NaN, and a NaN comparator leaves the order up to the engine,
    // so the chat with no timestamp appeared at an arbitrary position.
    .sort((a, b) => {
      if (!a.requestedAt && !b.requestedAt) return 0;
      if (!a.requestedAt) return 1;
      if (!b.requestedAt) return -1;
      return a.requestedAt - b.requestedAt;
    });
}

/**
 * The name to show a locked chat in the log.
 *
 * @param {string} threadID
 * @returns {string}
 */
function labelOf(threadID) {
  const label = labels.get(String(threadID));
  return (label && label.name) || String(threadID);
}

/**
 * Lock a chat and, best effort, record why in the database.
 *
 * The write is allowed to fail. The cache is already locked by then, so the
 * chat is refused either way; a lost row only means the lock does not survive
 * a restart.
 *
 * @param {string|number} threadID
 * @param {object} [meta]
 * @param {string} [meta.name]
 * @param {string} [meta.addedBy]
 * @returns {Promise<boolean>} true when the chat is now locked
 */
async function lock(threadID, meta = {}) {
  const tid = String(threadID);
  pendingLocks.add(tid);
  labels.set(tid, {
    name: meta.name || '',
    addedBy: meta.addedBy || '',
    requestedAt: meta.requestedAt ? new Date(meta.requestedAt) : new Date(),
  });

  try {
    const Group = require('../models/Group');
    const doc = await Group.findOne({ tid });
    if (doc) {
      doc.pendingApproval = true;
      doc.isApproved = false;
      if (meta.name) doc.threadName = meta.name;
      if (doc.approval) {
        doc.approval.requestedAt = labels.get(tid).requestedAt;
        if (meta.addedBy) doc.approval.addedBy = String(meta.addedBy);
      }
      await doc.save();
    }
  } catch (err) {
    console.error(`[PENDING] could not record lock for ${tid}: ${err.message}`);
  }
  return true;
}

/**
 * Forget a chat without touching its approval flags.
 *
 * Used when a chat is deleted, and when a hydrate finds a row whose chat is
 * already gone.
 *
 * @param {string|number} threadID
 */
function forget(threadID) {
  const tid = String(threadID);
  pendingLocks.delete(tid);
  labels.delete(tid);
}

/**
 * Lift the lock and write the decision down, so the next boot agrees.
 *
 * @param {string|number} threadID
 * @param {string} operator the uid that made the call
 * @returns {Promise<boolean>} false when there was no Group document to write to
 */
async function approve(threadID, operator) {
  const tid = String(threadID);
  forget(tid);
  try {
    const Group = require('../models/Group');
    const doc = await Group.findOne({ tid });
    if (!doc) return false;
    doc.pendingApproval = false;
    doc.isApproved = true;
    if (doc.approval) {
      doc.approval.approvedBy = String(operator || '');
      doc.approval.approvedAt = new Date();
    }
    await doc.save();
    return true;
  } catch (err) {
    console.error(`[PENDING] could not record approval for ${tid}: ${err.message}`);
    return false;
  }
}

/**
 * Record a denial and drop the lock.
 *
 * The lock is dropped here even though the chat stays unusable, because "denied"
 * and "still waiting" are different answers and a chat must not sit in both.
 * The bot is expected to be removed from the chat by the caller.
 *
 * @param {string|number} threadID
 * @param {string} operator
 * @returns {Promise<boolean>}
 */
async function deny(threadID, operator) {
  const tid = String(threadID);
  const wasLocked = isPending(tid);
  forget(tid);
  try {
    const Group = require('../models/Group');
    const doc = await Group.findOne({ tid });
    if (!doc) return wasLocked;
    doc.pendingApproval = false;
    doc.isApproved = false;
    if (doc.approval) {
      doc.approval.deniedAt = new Date();
      doc.approval.deniedBy = String(operator || '');
    }
    await doc.save();
    return true;
  } catch (err) {
    console.error(`[PENDING] could not record denial for ${tid}: ${err.message}`);
    return wasLocked;
  }
}

/**
 * May this command run, given that the chat is locked?
 *
 * Owners are allowed everything. Not as a convenience: an owner standing in a
 * locked chat is often the person who needs to run a command to work out what
 * is going on, and an approval system nobody can inspect is one nobody can
 * trust.
 *
 * @param {object|null} cmd the resolved command, or null if unknown
 * @param {object} event
 * @returns {boolean}
 */
function mayRun(cmd, event) {
  if (cmd && ALWAYS_ALLOWED.has(cmd.name)) return true;
  const uid = (event && (event.senderID || event.sender_id)) || '';
  try {
    const permissions = require('./permissions');
    if (permissions.isOwner(uid)) return true;
  } catch {
    // An unloadable permissions module never widens access.
  }
  return false;
}

/**
 * The refusal to send, or null when the chat may speak.
 *
 * Kept separate from `mayRun` so the dispatch path asks one question and gets
 * one answer, rather than deciding and then remembering what it decided.
 *
 * @param {string|number} threadID
 * @param {object|null} cmd
 * @param {object} event
 * @returns {string|null}
 */
function refusal(threadID, cmd, event) {
  if (!isPending(threadID)) return null;
  if (mayRun(cmd, event)) return null;
  return '🔒 This group is pending approval. Contact bot admins.';
}

/**
 * Rebuild the cache from the database.
 *
 * Called at boot, before the client starts taking events. Until this resolves
 * a restarted bot would treat every pending chat as ordinary, which is the one
 * failure mode the whole feature exists to prevent — so callers await it.
 *
 * @returns {Promise<number>} how many chats came back locked
 */
async function hydrate() {
  try {
    const Group = require('../models/Group');
    const rows = await Group.find({ pendingApproval: true }).lean();
    pendingLocks.clear();
    labels.clear();
    for (const row of rows || []) {
      const tid = String(row.tid);
      pendingLocks.add(tid);
      labels.set(tid, {
        name: row.threadName || '',
        addedBy: (row.approval && row.approval.addedBy) || '',
        requestedAt: (row.approval && row.approval.requestedAt) || null,
      });
    }
    console.log(`[PENDING] ${pendingLocks.size} chat(s) waiting for approval`);
    return pendingLocks.size;
  } catch (err) {
    // Leave whatever is already cached alone. Wiping it would unlock chats
    // that were locked a moment ago.
    console.error(`[PENDING] hydrate failed: ${err.message}`);
    return pendingLocks.size;
  }
}

/**
 * Load the cache from rows shaped like Group documents.
 *
 * Separate from `hydrate` so tests can drive the cache without a database.
 *
 * @param {Array<{tid:string,threadName?:string,approval?:object}>} rows
 * @returns {number}
 */
function seed(rows) {
  pendingLocks.clear();
  labels.clear();
  for (const row of rows || []) {
    const tid = String(row.tid);
    pendingLocks.add(tid);
    labels.set(tid, {
      name: row.threadName || '',
      addedBy: (row.approval && row.approval.addedBy) || '',
      requestedAt: (row.approval && row.approval.requestedAt) || null,
    });
  }
  return pendingLocks.size;
}

/**
 * Empty the cache. Test-only.
 */
function reset() {
  pendingLocks.clear();
  labels.clear();
}

module.exports = {
  ALWAYS_ALLOWED,
  approve,
  deny,
  forget,
  hydrate,
  isPending,
  labelOf,
  lock,
  mayRun,
  pendingLocks,
  refusal,
  reset,
  seed,
  snapshot,
};