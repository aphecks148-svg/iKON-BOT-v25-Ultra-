'use strict';

/**
 * Flood control — the gate every inbound message passes through first.
 *
 * Before this existed the only rate limit in the bot was `cooldown.js`, which is
 * keyed `${uid}::${commandName}`. That answers "how often may this person run
 * this command", which is a different question from "how fast may this person
 * talk to the bot". A member could paste the same line forty times, or fire
 * forty different commands in five seconds, and every single one was answered —
 * because each command had its own untouched bucket. On a busy chat that is the
 * difference between a bot and a spam amplifier.
 *
 * Three limits, checked in this order:
 *
 *   1. duplicate  — the same text from the same person, twice, inside
 *                   `duplicateSec`. This is the cheapest and by far the most
 *                   common shape of spam (the "join my server" paste, the stuck
 *                   loop). Commands are exempt: their own cooldown already
 *                   catches a repeat, and it says something more useful.
 *   2. per-user   — more than `maxPerUser` messages inside `userWindowSec`.
 *   3. per-thread — more than `maxPerThread` messages from anybody inside
 *                   `threadWindowSec`. This one is not about one person: it is
 *                   the bot's own backstop, so twenty members each sending two
 *                   messages still cannot bury the chat in bot replies.
 *
 * A block is SILENT by design. Replying "you are sending too many messages" to
 * every dropped message is itself a message, so a bot that argues with spammer
 * amplifies the spammer. The only exception is the final, most extreme block of
 * an escalating offence, which tells the offender once and then goes quiet.
 *
 * Escalation: each offence doubles the hold, from `muteSec` up to `maxMuteSec`.
 * A user who trips the limit once is nudged; a user who keeps going is put
 * aside for progressively longer. The streak decays on its own — an offender
 * who behaves for `maxMuteSec` starts from one strike again, so an old offence
 * can never permanently silence somebody.
 *
 * Bot admins are never restricted. Not "exempt from the message limit" —
 * exempt from the whole module: they are not recorded, cannot build a streak,
 * and cannot be held. A moderation bot that rate-limits the person who
 * moderates it is worse than no rate limit, so this is checked first and
 * returns before any state is touched.
 *
 * In-memory only, like cooldown.js and lock.js: a restart clears it, which is
 * the correct behaviour for a rate limiter.
 */

/** Fallbacks, used when a chat has no `gc.flood` block of its own. */
const DEFAULTS = {
  // Master switch. ON by default: a new group is exactly where spam arrives.
  on: true,
  // Same text twice inside this window → dropped.
  duplicateSec: 12,
  // Messages per person, per window.
  maxPerUser: 8,
  userWindowSec: 10,
  // Messages from anybody at all, per window. This one is deliberately high.
  //
  // It is NOT policing how lively a chat is — it exists so the bot cannot be
  // buried. One command produces one reply, so fifty messages inside ten seconds
  // means the bot could be asked to post fifty replies into that same window,
  // which is how a Facebook account gets rate-limited or banned. The number sits
  // well above a busy-but-normal group (they would need five messages a second,
  // sustained) and well below anything the platform tolerates, so the ceiling
  // fires on a flood rather than on a lively evening.
  maxPerThread: 50,
  threadWindowSec: 10,
  // Escalation ladder, in seconds. First offence is `muteSec`, then doubling.
  muteSec: 20,
  maxMuteSec: 600,
};

/** thread -> { times: number[], until: number } — the chat-wide window. */
const threads = new Map();
/** `${threadID}::${uid}` -> { times: number[], until: number, strikes: number, last: number } */
const people = new Map();
/** `${threadID}::${uid}::${normalised body}` -> timestamp of the last copy. */
const repeats = new Map();

const key = (threadID, uid) => `${threadID}::${uid}`;

/**
 * Reduce a body to something that can be compared for sameness.
 *
 * Trimmed, lower-cased, and stripped of the common invisible noise, because the
 * way people defeat a naive string compare is to add a trailing space or two.
 * Whitespace inside is collapsed so "a  b" and "a b" are the same message.
 *
 * @param {string} body
 * @returns {string} comparable form (may be '' for whitespace-only input)
 */
function normalise(body) {
  return String(body || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    // Zero-width and bidi marks: invisible in the chat, decisive to a compare.
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '');
}

/**
 * Merge a chat's stored limits over the defaults, ignoring anything that is not
 * a usable number. A half-written or corrupted `gc.flood` must not disable flood
 * control, and must not throw on the hot path either.
 *
 * @param {object} [stored] the `gc.flood` sub-document, if any
 * @returns {object} a complete, usable limit set
 */
function limits(stored) {
  const out = { ...DEFAULTS };
  if (!stored || typeof stored !== 'object') return out;

  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'on') continue;
    const value = Number(stored[key]);
    if (Number.isFinite(value) && value >= 0) out[key] = value;
  }
  // `on` is a boolean flag, not a number: accept the truthy spellings a hand
  // edited document can contain, and treat everything else as "not set".
  if (stored.on === true || stored.on === 'true' || stored.on === 1) out.on = true;
  else if (stored.on === false || stored.on === 'false' || stored.on === 0) out.on = false;
  return out;
}

/** uids never rate-limited. Bot admins, resolved from ADMIN_IDS/OWNER_ID. */
function isExempt(uid) {
  // Required lazily rather than at module scope so the module graph stays
  // acyclic: permissions pulls in config, and config is what decides who an
  // admin is, so loading it on demand keeps this usable from a test that
  // stubs isOwner before first use.
  const permissions = require('./permissions');
  if (permissions.isOwner(uid)) return true;
  const extra = permissions.ownerIds();
  return extra.includes(String(uid || ''));
}

/** Drop timestamps that fell out of the window. Mutates in place. */
function prune(times, windowMs, now) {
  const cutoff = now - windowMs;
  let keep = 0;
  while (keep < times.length && times[keep] <= cutoff) keep += 1;
  if (keep > 0) times.splice(0, keep);
  return times;
}

/**
 * Decide whether one message may be answered, and record the attempt either way.
 *
 * Call this exactly once per inbound message, before parsing. It has a side
 * effect on purpose: a blocked message still counts towards the windows, which
 * is what makes an offender's hold grow while they keep hammering.
 *
 * @param {object} msg
 * @param {string|number} msg.threadID chat the message arrived in
 * @param {string|number} msg.uid sender
 * @param {string} [msg.body] the raw text — only used for duplicate detection
 * @param {object} [msg.cfg] this chat's `gc.flood`, if it has one
 * @param {boolean} [msg.isCommand] true when the text is a bot command
 * @param {boolean} [msg.exempt] pre-computed exemption (tests, and callers that
 *   already resolved admin status for another reason)
 * @returns {{allowed: boolean, reason: string, notify: boolean, holdSec: number,
 *           strikes: number, limits: object}} the decision. `allowed: false` means
 *   "do not answer". `notify` is true only on the message that STARTS a hold, so
 *   the caller can warn the offender once instead of on every dropped message.
 */
function check({ threadID, uid, body = '', cfg, isCommand = false, exempt } = {}) {
  const who = String(uid || '');
  if (!who) return allow(DEFAULTS);

  // ── Admins first, before any state is read or written ──
  if (exempt === true || isExempt(who)) return allow(limits(cfg), true);

  const lim = limits(cfg);
  if (!lim.on) return allow(lim, true);

  const now = Date.now();
  const k = key(threadID, who);

  let p = people.get(k);
  if (!p) {
    p = { times: [], until: 0, strikes: 0, last: 0 };
    people.set(k, p);
  }

  // ── 1. Already serving a hold ──
  if (p.until > now) {
    const left = Math.ceil((p.until - now) / 1000);
    // No streak bump: this message never got through, it is not a new offence,
    // it is the same one being served. `notify` stays false so a held user is
    // told once, when the hold starts, and not once per message after it.
    return {
      allowed: false, reason: 'held', notify: false, holdSec: left, strikes: p.strikes, limits: lim,
    };
  }
  // Hold served: the offender starts over if they then behaved.
  if (p.until > 0 && p.until <= now) p.strikes = 0;
  p.until = 0;

  // ── Chat-wide window, counted before the per-user one ──
  // A thread hold outranks a user block: it is the bot protecting itself, and it
  // applies to everyone at once, so no single offender is singled out.
  let t = threads.get(threadID);
  if (!t) {
    t = { times: [], until: 0 };
    threads.set(threadID, t);
  }
  if (t.until > now) {
    return {
      allowed: false,
      reason: 'thread',
      notify: false,
      holdSec: Math.ceil((t.until - now) / 1000),
      strikes: p.strikes,
      limits: lim,
    };
  }
  t.until = 0;

  // ── 2. Duplicate ──
  // NOT applied to commands, and deliberately so. A repeated command already has
  // the better answer waiting for it: `cooldown.js` names the command and counts
  // down the seconds, which is far more useful to the person who pressed it than
  // "duplicate message dropped". The cooldown also covers the repetition before
  // it happens, so excluding commands here closes no gap — it just stops a second,
  // vaguer message from shadowing the specific one.
  const text = isCommand ? '' : normalise(body);
  let duplicate = false;
  if (text) {
    const dk = `${k}::${text}`;
    const last = repeats.get(dk);
    duplicate = last !== undefined && now - last < lim.duplicateSec * 1000;
    if (!duplicate) repeats.set(dk, now);
  }

  // ── 3. Per-user window ──
  prune(p.times, lim.userWindowSec * 1000, now);
  p.times.push(now);
  p.last = now;
  const overUser = p.times.length > lim.maxPerUser;

  prune(t.times, lim.threadWindowSec * 1000, now);
  t.times.push(now);
  const overThread = t.times.length > lim.maxPerThread;

  if (!duplicate && !overUser && !overThread) {
    p.strikes = 0;
    return allow(lim);
  }

  // ── Offence: escalate ──
  p.strikes += 1;
  const hold = Math.min(lim.maxMuteSec, lim.muteSec * (2 ** Math.min(p.strikes - 1, 10)));
  p.until = now + hold * 1000;

  let reason = 'rate';
  if (duplicate) reason = 'duplicate';
  else if (overThread) reason = 'thread';

  if (overThread) {
    // The whole chat is over the bot's ceiling. Hold EVERYONE non-admin for the
    // same window — this is the "the bot is being buried" case, and picking one
    // member to blame for it would be arbitrary.
    t.until = now + hold * 1000;
    // Reset the chat window so the hold is not immediately renewed by the
    // backlog that caused it.
    t.times.length = 0;
  }

  return {
    allowed: false, reason, notify: true, holdSec: hold, strikes: p.strikes, limits: lim,
  };
}

/** The "nothing to see" result, shaped like a decision so callers can spread it. */
function allow(lim, skipped = false) {
  return {
    allowed: true, reason: skipped ? 'exempt' : 'ok', notify: false, holdSec: 0, strikes: 0, limits: lim,
  };
}

/**
 * Put one sender aside for a while, regardless of what the limits say.
 *
 * Used by the anti-spam escalation ladder in moderation.js: an offence the flood
 * counters cannot see (three links, say) still deserves a timeout, and it must
 * not require a database write to impose.
 *
 * @param {string|number} threadID
 * @param {string|number} uid
 * @param {number} sec how long
 * @returns {number} the hold actually applied, in seconds
 */
function hold(threadID, uid, sec) {
  const who = String(uid || '');
  if (!who || !Number.isFinite(sec) || sec <= 0) return 0;
  const k = key(threadID, who);
  let p = people.get(k);
  if (!p) {
    p = { times: [], until: 0, strikes: 0, last: 0 };
    people.set(k, p);
  }
  p.until = Date.now() + sec * 1000;
  // One strike is already spent — the caller decided this was an offence.
  p.strikes = Math.max(1, p.strikes);
  return sec;
}

/**
 * Put an entire chat aside — the anti-raid seal.
 *
 * Bot admins are still exempt: that call goes through `check`, which short
 * circuits for them, so a sealed chat can always be unsealed by a bot admin.
 *
 * @param {string|number} threadID
 * @param {number} sec how long
 * @returns {number} seconds applied
 */
function holdThread(threadID, sec) {
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  let t = threads.get(threadID);
  if (!t) {
    t = { times: [], until: 0 };
    threads.set(threadID, t);
  }
  t.until = Date.now() + sec * 1000;
  t.times.length = 0;
  return sec;
}

/**
 * Read the seal on a chat without recording anything.
 *
 * handleGroupChange asks this before it writes a welcome card, so a burst of
 * joins does not get forty welcome messages out of the bot during the raid.
 *
 * @param {string|number} threadID
 * @returns {boolean}
 */
function threadSealed(threadID) {
  const t = threads.get(threadID);
  return Boolean(t && t.until > Date.now());
}

/** Forget one sender in one chat, or everywhere when threadID is omitted. */
function clear(uid, threadID) {
  const who = String(uid || '');
  if (!who) return;
  if (threadID) {
    people.delete(key(threadID, who));
    for (const dk of [...repeats.keys()]) {
      if (dk.startsWith(`${threadID}::${who}::`)) repeats.delete(dk);
    }
    return;
  }
  for (const k of [...people.keys()]) if (k.endsWith(`::${who}`)) people.delete(k);
  for (const dk of [...repeats.keys()]) if (dk.includes(`::${who}::`)) repeats.delete(dk);
}

/** Lift the seal on a chat. */
function clearThread(threadID) {
  const t = threads.get(threadID);
  if (t) t.until = 0;
}

/**
 * Housekeeping. Called from the same 60-second sweep as cooldown.sweep().
 *
 * Drops every duplicate fingerprint past its window and every person window
 * that is both expired and empty, so the maps track live traffic rather than
 * everything this process has ever seen.
 */
function sweep() {
  const now = Date.now();
  for (const [dk, at] of repeats) {
    // The longest window any chat could have configured is used as the ceiling:
    // an entry younger than that may still be inside a longer window.
    if (now - at >= DEFAULTS.maxMuteSec * 1000) repeats.delete(dk);
  }
  for (const [k, p] of people) {
    if (p.until > now) continue;
    prune(p.times, DEFAULTS.maxMuteSec * 1000, now);
    if (p.times.length === 0 && p.until === 0) people.delete(k);
  }
  for (const [id, t] of threads) {
    if (t.until > now) continue;
    prune(t.times, DEFAULTS.maxMuteSec * 1000, now);
    if (t.times.length === 0 && t.until === 0) threads.delete(id);
  }
}

/** Counts for /health. */
function stats() {
  const now = Date.now();
  let held = 0;
  let sealed = 0;
  for (const p of people.values()) if (p.until > now) held += 1;
  for (const t of threads.values()) if (t.until > now) sealed += 1;
  return {
    people: people.size,
    threads: threads.size,
    repeats: repeats.size,
    held,
    sealed,
  };
}

module.exports = {
  check, hold, holdThread, threadSealed, clear, clearThread, sweep, stats, normalise, limits, DEFAULTS,
};