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
 * @param {boolean} [isGroup] the event's isGroup flag — required for groups whose
 *   id has no `t_` prefix, see isGroupThread
 * @returns {Promise<object|null>}
 */
async function reply(api, threadID, msg, messageID = null, isGroup = undefined) {
  if (!api || typeof api.sendMessage !== 'function') return null;
  if (threadID === undefined || threadID === null) return null;

  const payload = typeof msg === 'string' ? { body: msg } : { ...(msg || {}) };
  if (!payload.body && !payload.attachment) return null;

  // sendMessage only accepts a reply-to id that is a string.
  const replyTo = messageID === undefined || messageID === null ? null : String(messageID);

  try {
    lastSendError = '';
    const res = await api.sendMessage(payload, threadID, replyTo, !isGroupThread(threadID, isGroup));
    // Remember what we just sent so !unsend has a target. Facebook only lets a
    // bot unsend its own messages, and the id of the user's command (which is
    // what event.messageID holds) is not one of them.
    if (res && res.messageID) rememberLastSent(threadID, String(res.messageID));
    return res;
  } catch (err) {
    lastSendError = describeSendError(err);
    error(`[HELPER] sendMessage failed on thread ${threadID}: ${lastSendError}`);
    // Facebook rejects every send once the session is gone, so the session is
    // the thing worth acting on rather than the individual message.
    if (isSessionLost(err)) noteSessionLost(api);
    return null;
  }
}

/**
 * Has the Facebook session expired?
 *
 * The thrown value cannot answer this on its own: ws3-fca wraps the failure in
 * `new Error(resData)`, and `new Error({...})` discards the object entirely —
 * including the `error: "Not logged in."` string ws3-fca sets for exactly this
 * case. So the text is read from the fcaDiag tap instead, which captured the raw
 * response body before the wrapper threw it away.
 *
 * @param {*} err the thrown value
 * @returns {boolean}
 */
function isSessionLost(err) {
  const haystacks = [
    lastSendError,
    typeof err === 'string' ? err : (err && err.error) || '',
    err && err.message ? String(err.message) : '',
  ];
  try {
    // eslint-disable-next-line global-require
    haystacks.push(require('./fcaDiag').lastRawSummary());
  } catch { /* the tap is optional */ }

  return haystacks.some((s) => typeof s === 'string' && /not logged in/i.test(s));
}

/**
 * Called when a send is rejected because the session is no longer valid.
 *
 * Dumps the current cookies to appstate.json so a manual redeploy has fresh
 * credentials to work from, then asks the engine to reboot — ws3-fca cannot
 * re-authenticate in place, and Render restarts the process on exit anyway.
 *
 * Deliberately fires ONCE per process. Without the latch this runs on every
 * failed send, and a dead session produces a failed send per command, so a
 * busy group would rewrite the file and reboot in a tight loop.
 *
 * @param {object} api ws3-fca client
 */
let sessionLossHandled = false;
function noteSessionLost(api) {
  if (sessionLossHandled) return;
  sessionLossHandled = true;

  error('[SESSION] Facebook reports "Not logged in" — the appstate is stale.');

  try {
    if (api && typeof api.getAppState === 'function') {
      const appState = api.getAppState();
      if (Array.isArray(appState) && appState.length) {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        require('fs').writeFileSync('appstate.json', JSON.stringify(appState, null, 2));
        log(`[SESSION] wrote ${appState.length} cookies to appstate.json`);
      }
    }
  } catch (err) {
    error(`[SESSION] could not write appstate.json: ${err.message}`);
  }

  // Give the write a moment to flush, then exit non-zero so Render restarts us.
  setTimeout(() => process.exit(1), 1500);
}

/**
 * Last message the bot sent in each thread, newest first.
 *
 * `!unsend` needs this: a user replying to a bot message gives the id directly,
 * but a bare `!unsend` does not, and `event.messageID` is the user's own
 * command rather than something the bot is allowed to delete.
 *
 * Bounded on both sides — at most MAX_SENT_TRACKED threads, each holding a few
 * ids — so a long-running bot cannot grow this without limit.
 */
const LAST_SENT = new Map();
const MAX_SENT_TRACKED = 500;
const SENT_HISTORY = 3;

/** @param {string|number} threadID @param {string} messageID */
function rememberLastSent(threadID, messageID) {
  const key = String(threadID);
  const list = LAST_SENT.get(key) || [];
  list.unshift(messageID);
  LAST_SENT.set(key, list.slice(0, SENT_HISTORY));
  // Map preserves insertion order, so the first key is the least recently used.
  while (LAST_SENT.size > MAX_SENT_TRACKED) {
    LAST_SENT.delete(LAST_SENT.keys().next().value);
  }
}

/**
 * The bot's most recent message id in a thread, or '' if nothing was sent.
 * @param {string|number} threadID
 * @returns {string}
 */
function lastSent(threadID) {
  const list = LAST_SENT.get(String(threadID));
  return (list && list[0]) || '';
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
async function safe(fn, api, threadID, messageID, label = 'handler', isGroup = undefined) {
  try {
    if (typeof fn !== 'function') throw new TypeError('safe() needs a function');
    const result = await fn(api, threadID, messageID);
    return { ok: true, result };
  } catch (err) {
    error(`[ERROR] ${label}: ${err && err.message ? err.message : err}`);
    if (err && err.stack) console.error(err.stack);
    // Best-effort user feedback; never let this throw either. isGroup is
    // forwarded so this error notice is not itself lost to the same mistake.
    await reply(api, threadID, `⚠️ ${label} failed: ${err && err.message ? err.message : 'unknown error'}`, messageID, isGroup);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * True when a thread is a group chat rather than a private message.
 *
 * The `t_` prefix is only a heuristic and it is NOT reliable: production showed
 * a group arriving with `isGroup: true` and threadID `1451777763453670`, with
 * no prefix at all. Guessing from the id then marks a group as a DM, and
 * ws3-fca answers that by addressing a private message to the group id — which
 * Facebook rejects with error 1545012, "not part of conversation". Every reply
 * in that group failed while reactions kept working.
 *
 * So an explicit `isGroup` from the event always wins. The prefix is only a
 * fallback for callers that have no event to ask.
 *
 * @param {string|number} threadID
 * @param {boolean} [isGroup] the event's own isGroup flag, when known
 * @returns {boolean}
 */
function isGroupThread(threadID, isGroup) {
  if (typeof isGroup === 'boolean') return isGroup;
  return String(threadID || '').startsWith('t_');
}

/**
 * Turn whatever ws3-fca threw into one readable line.
 *
 * ws3-fca's sendMessage does `throw new Error(resData)` where resData is
 * Facebook's error OBJECT, so `err.message` is the literal string
 * "[object Object]" and every real code is lost. This digs out whatever is
 * actually present instead of reporting the placeholder.
 *
 * @param {*} err
 * @returns {string}
 */
function describeSendError(err) {
  if (err === null || err === undefined) return 'unknown error';
  if (typeof err === 'string') return err.slice(0, 300);
  if (typeof err !== 'object') return String(err).slice(0, 300);

  // A real Error: its message is only useless if that message is "[object Object]".
  const msg = typeof err.message === 'string' ? err.message : '';
  if (msg && msg !== '[object Object]' && msg !== 'Error') return msg.slice(0, 300);

  // Facebook's object, possibly re-thrown under a wrapper. Walk a few levels:
  // axios nests as err.response.data, ws3-fca hands back the parsed body.
  const bodies = [err, err.error, err.response, err.response && err.response.data, err.data];
  for (const body of bodies) {
    if (!body || typeof body !== 'object') continue;
    const parts = [];
    const push = (v) => {
      if (typeof v === 'string' && v && v !== '[object Object]') parts.push(v);
      else if (typeof v === 'number') parts.push(String(v));
      // Facebook also nests the failure as an object, e.g.
      // { error: { code: 100, message: '...' } }. Flatten it or the real code
      // is lost again one level down.
      else if (v && typeof v === 'object') {
        for (const k of ['code', 'message', 'errorSummary', 'reason', 'status']) {
          if (typeof v[k] === 'string' || typeof v[k] === 'number') parts.push(`${k}=${v[k]}`);
        }
      }
    };
    push(body.error);
    push(body.errorSummary);
    push(body.error_code);
    push(body.error_message);
    push(body.message);
    push(body.code);
    if (body.payload && body.payload.error) push(body.payload.error);
    if (parts.length) return [...new Set(parts)].join(' | ').slice(0, 300);
  }

  // ws3-fca's `throw new Error(resData)`: the object is already gone by the time
  // it reaches here, so say that plainly and point at the tap that does capture it.
  if (msg === '[object Object]') {
    return 'Facebook rejected the send; ws3-fca hides the reason — read lastFacebookResponse on /health';
  }

  // Last resort: surface the own keys so it is at least identifiable.
  const keys = Object.keys(err).slice(0, 8);
  return keys.length ? `unreadable send error (keys: ${keys.join(', ')})` : 'unknown error';
}

/** Small formatting helpers shared by commands. */

/**
 * Why the most recent reply() failed, or '' when it succeeded.
 *
 * reply() swallows the error and returns null so one dead send cannot take down
 * a command handler. That is right for the chat but leaves "reacts but never
 * replies" with no explanation anywhere: from inside the process the only trace
 * was a log line. The engine reads this to fill /health's lastSendError, which
 * is what makes the failure visible from outside the deploy.
 */
let lastSendError = '';

/** Clear the recorded send error. */
function clearSendError() {
  lastSendError = '';
}
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

module.exports = {
  log, error, reply, react, safe, isGroupThread, fmt,
  clearSendError, lastSendError: () => lastSendError, describeSendError,
  lastSent, rememberLastSent,
};
