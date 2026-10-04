'use strict';

/**
 * Pending approval: the door between "someone added the bot" and "the bot
 * works here".
 *
 * When the bot's own uid lands in a chat that has no Group document, that chat
 * is locked. It answers three commands and nothing else until an owner says
 * otherwise.
 *
 * The lock is held in three places, on purpose.
 *
 *   1. `pendingLocks` — the hot path. Every read in dispatch is a Set lookup,
 *      because a locked chat must be refused the instant the event arrives and
 *      cannot wait on a round trip to decide whether it is allowed to talk.
 *   2. The Group document — the database record. Written on lock and on the
 *      decision, so `!pending` has a name to show and a restart has something to
 *      read back.
 *   3. `database/pending.json` — the durable sidecar. One flat file an owner can
 *      open, and the copy that survives a database write that failed. A pending
 *      chat that exists only here is still locked after the next boot, because
 *      `hydrate()` reads both and takes the union.
 *
 * A lock that lives only in memory is a lock that a restart erases, which is
 * precisely the moment a lock that matters most would evaporate. A lock that
 * lives only in the database is a lock that a failed write erases, which is how
 * a stranger's group ends up running an unrestricted bot.
 */

const fs = require('fs');
const path = require('path');

/**
 * Where the pending records live on disk.
 *
 * Overridable through PENDING_FILE so tests can point it at a temporary file
 * instead of writing into the repository.
 */
const PENDING_FILE = process.env.PENDING_FILE
  || path.join(__dirname, '..', 'database', 'pending.json');

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

// ── the on-disk record ─────────────────────────────────────────────

/**
 * Every pending record on disk, as an object keyed by thread id.
 *
 * A missing file, an unreadable file and a file holding something that is not a
 * record all read as "no pending chats". A pending system that refuses to start
 * because its own log file is malformed is a pending system that silently lets
 * every locked chat through.
 *
 * @returns {Record<string, {threadID:string,threadName:string,addedByID:string,addedByName:string,time:string,isApproved:boolean,pending:boolean}>}
 */
function readFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [tid, row] of Object.entries(parsed)) {
      if (!tid || !row || typeof row !== 'object') continue;
      if (row.isApproved === true || row.pending === false) continue;
      out[String(tid)] = { ...row, threadID: String(row.threadID || tid) };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Write the whole file back. Best effort: a full disk must not stop a chat being
 * locked, because the in-memory lock and the Group document are already written
 * by the time this is called.
 *
 * @param {Record<string,object>} records
 * @returns {boolean} whether it reached the disk
 */
function writeFile(records) {
  try {
    fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
    fs.writeFileSync(PENDING_FILE, `${JSON.stringify(records || {}, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Put one chat into the file, or take it out when `row` is null. */
function fileSet(tid, row) {
  const records = readFile();
  if (row) records[tid] = row; else delete records[tid];
  return writeFile(records);
}

/**
 * Is this chat waiting for a decision?
 *
 * The Set only. This is called on every inbound message, so it cannot touch the
 * disk; `hydrate()` is what puts the file's contents into the Set at boot, and
 * `lock()` is what keeps them in step afterwards.
 *
 * @param {string|number|null|undefined} threadID
 * @returns {boolean}
 */
function isPending(threadID) {
  if (threadID === null || threadID === undefined) return false;
  return pendingLocks.has(String(threadID));
}

/**
 * The same question, asked against the durable record rather than the cache.
 *
 * For an owner-only command that may be the first thing to run after a restart,
 * where the cache has not been asked yet. Cheap enough there and nowhere else.
 *
 * @param {string|number|null|undefined} threadID
 * @returns {boolean}
 */
function isPendingDurably(threadID) {
  if (threadID === null || threadID === undefined) return false;
  const tid = String(threadID);
  return pendingLocks.has(tid) || Boolean(readFile()[tid]);
}

/**
 * Every locked chat, oldest request first.
 *
 * @returns {Array<{tid:string,name:string,addedBy:string,addedByName:string,requestedAt:Date|null,age:number}>}
 */
function snapshot() {
  const onDisk = readFile();
  return [...pendingLocks]
    .map((tid) => {
      const label = labels.get(tid) || {};
      const row = onDisk[tid] || {};
      // A label is a label. When the name never made it to the database it is
      // still better to say "Unknown" than to print the bookkeeping placeholder
      // this used to print, which read like the database had a chat called
      // "(unknown chat)".
      const addedByName = label.addedByName || row.addedByName || '';
      const addedBy = label.addedBy || row.addedByID || row.addedBy || '';
      const requestedAt = label.requestedAt
        || (row.time ? new Date(row.time) : null)
        || null;
      return {
        tid,
        name: label.name || row.threadName || 'Unknown',
        addedBy,
        addedByName,
        requestedAt: requestedAt && !Number.isNaN(new Date(requestedAt).getTime())
          ? new Date(requestedAt)
          : null,
        age: requestedAt ? Date.now() - new Date(requestedAt).getTime() : 0,
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
 * Read one Group document, distinguishing "there is none" from "the database
 * did not answer".
 *
 * The two look identical from a bare `null`, and conflating them is expensive:
 * `null` invites a create, which means a database that is merely unreachable
 * gets waited on a second time before the same timeout, turning a five second
 * lock into a twenty second one.
 *
 * @param {string} tid
 * @returns {Promise<object|null|undefined>} the document, null when there is
 *   none, undefined when the database could not be asked
 */
async function findGroup(tid) {
  try {
    const Group = require('../models/Group');
    return await Group.findOne({ tid });
  } catch (err) {
    console.error(`[PENDING] database did not answer for ${tid}: ${err.message}`);
    return undefined;
  }
}

/**
 * Lock a chat and write down why, everywhere.
 *
 * All three stores are best effort and all three are attempted: the chat is
 * refused the moment it is in the Set, and every later store only decides how
 * much survives a restart. The Group document is created when it does not exist
 * — that is the normal case, because a chat with no document is the definition
 * of the lock — and that create is what makes `!approve <tid>` able to find
 * something to approve instead of answering "not waiting for approval".
 *
 * @param {string|number} threadID
 * @param {object} [meta]
 * @param {string} [meta.name] the chat's real name
 * @param {string} [meta.addedBy] the uid that added the bot
 * @param {string} [meta.addedByName] that person's real name
 * @param {string|number|Date} [meta.requestedAt] ISO string, epoch or Date
 * @returns {Promise<boolean>} true when the chat is now locked
 */
async function lock(threadID, meta = {}) {
  const tid = String(threadID);
  const requestedAt = meta.requestedAt ? new Date(meta.requestedAt) : new Date();
  const threadName = meta.name || 'Unknown';
  const addedByID = meta.addedBy ? String(meta.addedBy) : '';
  const addedByName = meta.addedByName || '';

  pendingLocks.add(tid);
  labels.set(tid, { name: threadName, addedBy: addedByID, addedByName, requestedAt });

  // The file first: it is synchronous, it cannot fail on a database timeout, and
  // it is the copy that survives the restart nobody planned for.
  fileSet(tid, {
    threadID: tid,
    threadName,
    addedByID,
    addedByName,
    time: requestedAt.toISOString(),
    isApproved: false,
    pending: true,
  });

  const doc = await findGroup(tid);
  if (doc === undefined) return true;
  try {
    const Group = require('../models/Group');
    const target = doc || new Group({ tid });
    target.pendingApproval = true;
    target.isApproved = false;
    if (meta.name) target.threadName = threadName;
    if (target.approval) {
      target.approval.requestedAt = requestedAt;
      if (addedByID) target.approval.addedBy = addedByID;
      if (addedByName) target.approval.addedByName = addedByName;
    }
    await target.save();
  } catch (err) {
    console.error(`[PENDING] could not record lock for ${tid}: ${err.message}`);
  }
  return true;
}

/**
 * Forget a chat without touching its approval flags.
 *
 * Used when a chat is deleted. The record on disk goes with it, because a chat
 * that no longer exists must not sit in `!pending` waiting for a decision that
 * can never come.
 *
 * @param {string|number} threadID
 */
function forget(threadID) {
  const tid = String(threadID);
  pendingLocks.delete(tid);
  labels.delete(tid);
  fileSet(tid, null);
}

/**
 * Lift the lock and write the decision down, so the next boot agrees.
 *
 * The order matters. The record comes off the disk and the flags go into the
 * database before the cache is emptied, so a chat is never unlocked in memory
 * while still marked pending in either store.
 *
 * @param {string|number} threadID
 * @param {string} operator the uid that made the call
 * @returns {Promise<boolean>} false when the database could not be written to
 */
async function approve(threadID, operator) {
  const tid = String(threadID);
  fileSet(tid, null);
  const doc = await findGroup(tid);
  let written = false;
  if (doc !== undefined) {
    try {
      const Group = require('../models/Group');
      // Created when missing, and it has to be: a locked chat is one with no
      // document, so refusing to write anything is how "approve" ended up
      // approving nothing.
      const target = doc || new Group({ tid });
      target.pendingApproval = false;
      target.isApproved = true;
      if (target.approval) {
        target.approval.approvedBy = String(operator || '');
        target.approval.approvedAt = new Date();
      }
      await target.save();
      written = true;
    } catch (err) {
      console.error(`[PENDING] could not record approval for ${tid}: ${err.message}`);
    }
  }
  pendingLocks.delete(tid);
  labels.delete(tid);
  return written;
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
  fileSet(tid, null);
  const doc = await findGroup(tid);
  let written = false;
  if (doc) {
    try {
      doc.pendingApproval = false;
      doc.isApproved = false;
      if (doc.approval) {
        doc.approval.deniedAt = new Date();
        doc.approval.deniedBy = String(operator || '');
      }
      await doc.save();
      written = true;
    } catch (err) {
      console.error(`[PENDING] could not record denial for ${tid}: ${err.message}`);
    }
  }
  pendingLocks.delete(tid);
  labels.delete(tid);
  return written || wasLocked;
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
 * Rebuild the cache from the database and from the file.
 *
 * Called at boot, before the client starts taking events. Until this resolves
 * a restarted bot would treat every pending chat as ordinary, which is the one
 * failure mode the whole feature exists to prevent — so callers await it.
 *
 * The union matters. A chat whose document write failed is in the file and
 * nowhere else; a chat locked before the file existed is in the database and
 * nowhere else. Taking only one of them unlocks half of whatever was waiting.
 *
 * @returns {Promise<number>} how many chats came back locked
 */
async function hydrate() {
  const onDisk = readFile();
  try {
    const Group = require('../models/Group');
    const rows = await Group.find({ pendingApproval: true }).lean().catch(() => null);
    if (rows === null) throw new Error('database did not answer');
    pendingLocks.clear();
    labels.clear();
    const adopt = (tid, name, addedBy, addedByName, requestedAt) => {
      pendingLocks.add(tid);
      labels.set(tid, {
        name: name || '',
        addedBy: addedBy || '',
        addedByName: addedByName || '',
        requestedAt: requestedAt || null,
      });
    };
    for (const row of rows || []) {
      adopt(
        String(row.tid),
        row.threadName,
        (row.approval && row.approval.addedBy) || '',
        (row.approval && row.approval.addedByName) || '',
        (row.approval && row.approval.requestedAt) || null,
      );
    }
    // Whatever the database did not know about. The file's name and owner are
    // only used where the document had none, so a richer database row is never
    // overwritten by an older copy of the same fact.
    for (const [tid, rec] of Object.entries(onDisk)) {
      if (pendingLocks.has(tid)) continue;
      adopt(tid, rec.threadName, rec.addedByID, rec.addedByName, rec.time ? new Date(rec.time) : null);
    }
    console.log(`[PENDING] ${pendingLocks.size} chat(s) waiting for approval`);
    return pendingLocks.size;
  } catch (err) {
    // A database that will not answer must not cost us the file's records, but
    // it must also not wipe a cache that was built a moment ago.
    for (const [tid, rec] of Object.entries(onDisk)) {
      if (pendingLocks.has(tid)) continue;
      pendingLocks.add(tid);
      labels.set(tid, {
        name: rec.threadName || '',
        addedBy: rec.addedByID || '',
        addedByName: rec.addedByName || '',
        requestedAt: rec.time ? new Date(rec.time) : null,
      });
    }
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
      addedByName: (row.approval && row.approval.addedByName) || '',
      requestedAt: (row.approval && row.approval.requestedAt) || null,
    });
  }
  return pendingLocks.size;
}

/**
 * Empty the cache. Test-only. Deliberately does not touch the file: a test that
 * wipes the lock list must not also delete an operator's pending records.
 */
function reset() {
  pendingLocks.clear();
  labels.clear();
}

module.exports = {
  ALWAYS_ALLOWED,
  PENDING_FILE,
  approve,
  deny,
  forget,
  hydrate,
  isPending,
  isPendingDurably,
  labelOf,
  lock,
  mayRun,
  pendingLocks,
  readFile,
  refusal,
  reset,
  seed,
  snapshot,
};