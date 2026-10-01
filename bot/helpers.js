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
 * Send a message, replying to the original when possible.
 * Resolves with the api result, or null on failure (never throws).
 *
 * @param {object} api ws3-fca client
 * @param {string|number} threadID conversation id
 * @param {object|string} msg body (string, or attachment descriptor)
 * @param {string|number} [messageID] message being replied to
 */
async function reply(api, threadID, msg, messageID = null) {
  if (!api || typeof api.sendMessage !== 'function') return null;
  if (threadID === undefined || threadID === null) return null;

  const payload = typeof msg === 'string' ? { body: msg } : { ...(msg || {}) };
  if (!payload.body && !payload.attachment) return null;

  // Reply-to semantics: Messenger renders it threaded under the trigger.
  if (messageID !== undefined && messageID !== null) payload.messageID = messageID;

  try {
    return await api.sendMessage(payload, threadID);
  } catch (err) {
    error(`[HELPER] sendMessage failed on thread ${threadID}: ${err.message}`);
    return null;
  }
}

/**
 * Attach a reaction to a message. Swallows every error — reactions are cosmetic.
 * @returns {Promise<boolean>} whether the reaction was sent
 */
async function react(api, messageID, emoji = '✅') {
  if (!api || typeof api.react !== 'function') return false;
  if (!messageID || !emoji) return false;
  try {
    await api.react({ type: 'message', messageID, reaction: String(emoji) });
    return true;
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

module.exports = { log, error, reply, react, safe, fmt };
