'use strict';

/**
 * Shared helpers: logging, replies (Messenger reply-to-message), reactions,
 * and the safe() wrapper that guarantees a broken command can never crash the bot.
 */

const STAMP = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** Timestamped console log. */
function log(...parts) {
  console.log(`[${STAMP()}]`, ...parts);
}

/** Timestamped error log. */
function error(...parts) {
  console.error(`[${STAMP()}]`, ...parts);
}

/**
 * Send a message, threading it under the triggering message when there is one.
 * Resolves with the api result, or null on failure (never throws).
 *
 * ws3-fca's signature is `sendMessage(msg, threadID, replyToMessage, isSingleUser)`.
 * Two things follow from that, and getting either wrong makes every reply
 * silently vanish while reactions keep working:
 *
 *   - the reply-to id is the THIRD positional argument, never a key on the
 *     payload. sendMessage whitelists payload keys and throws
 *     "Dissallowed props: `messageID`" on anything else.
 *   - a one-to-one thread must pass isSingleUser=true. Its threadID is a bare
 *     uid, not a `t_` thread_fbid, so without the flag the send is addressed
 *     to a thread that does not exist.
 *
 * @param {object} api ws3-fca client
 * @param {string|number} threadID conversation id
 * @param {object|string} msg body (string, or attachment descriptor)
 * @param {string} [messageID] message being replied to
 * @returns {Promise<object|null>}
 */
async function reply(api, threadID, msg, messageID = null) {
  if (!api || typeof api.sendMessage !== 'function') return null;
  if (threadID === undefined || threadID === null) return null;

  const payload = typeof msg === 'string' ? { body: msg } : { ...(msg || {}) };
  if (!payload.body && !payload.attachment) return null;

  // sendMessage only accepts a reply-to id that is a string.
  const replyTo = messageID === undefined || messageID === null ? null : String(messageID);

  try {
    return await api.sendMessage(payload, threadID, replyTo, !isGroupThread(threadID));
  } catch (err) {
    error(`[HELPER] sendMessage failed on thread ${threadID}: ${err.message}`);
    return null;
  }
}

/**
 * Attach a reaction to a message. Swallows every error — reactions are cosmetic.
 *
 * ws3-fca exposes this as `setMessageReaction(reaction, messageID)`, positional
 * arguments, not `api.react({ ... })`. The react() form is what fca-unofficial
 * used; against ws3-fca it does not exist and every reaction silently vanished.
 * Both are tried so the mocked api in the tests still works.
 *
 * @returns {Promise<boolean>} whether the reaction was sent
 */
async function react(api, messageID, emoji = '✅') {
  if (!api || !messageID || !emoji) return false;
  const e = String(emoji);
  try {
    if (typeof api.setMessageReaction === 'function') {
      await api.setMessageReaction(e, messageID);
      return true;
    }
    if (typeof api.react === 'function') {
      await api.react({ type: 'message', messageID, reaction: e });
      return true;
    }
    return false;
  } catch (err) {
    error(`[HELPER] react failed on message ${messageID}: ${err.message}`);
    return false;
  }
}

/**
 * Run a handler inside a try/catch so one broken command never kills the process.
 * Errors are logged with their command name and reported to the user.
 *
 * @param {Function} fn async (api, threadID, messageID) => any
 * @param {object} api
 * @param {string|number} threadID
 * @param {string|number} [messageID]
 * @param {string} [label] name used in log/error output
 * @returns {Promise<{ok:boolean,result?:any,error?:string}>}
 */
async function safe(fn, api, threadID, messageID, label = 'handler') {
  try {
    if (typeof fn !== 'function') throw new TypeError('safe() needs a function');
    const result = await fn(api, threadID, messageID);
    return { ok: true, result };
  } catch (err) {
    error(`[ERROR] ${label}: ${err && err.message ? err.message : err}`);
    if (err && err.stack) console.error(err.stack);
    // Best-effort user feedback; never let this throw either.
    await reply(api, threadID, `⚠️ ${label} failed: ${err && err.message ? err.message : 'unknown error'}`, messageID);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * True when a thread id is a group chat rather than a private message.
 * Messenger group threads are prefixed `t_`; a one-to-one chat is a bare uid.
 *
 * @param {string|number} threadID
 * @returns {boolean}
 */
function isGroupThread(threadID) {
  return String(threadID || '').startsWith('t_');
}

/** Small formatting helpers shared by commands. */
const fmt = {
  n: (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US') : String(v)),
  dur: (sec) => {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  },
};

module.exports = { log, error, reply, react, safe, isGroupThread, fmt };
