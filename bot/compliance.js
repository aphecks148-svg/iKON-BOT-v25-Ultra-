'use strict';

/**
 * Account-safety policy — how much the bot is allowed to say on its own.
 *
 * Everything here exists because of one fact about the platform: a Facebook
 * account is a person, and the person's account can be closed. The bot does not
 * get a separate rulebook. When the bot misbehaves, the account is suspended,
 * and the account is the thing the operator actually owns.
 *
 * The enforcement that matters most is not in this file. It is in the four
 * behaviours this file governs:
 *
 *   1. Answering a message nobody addressed to the bot. A bot that replies to
 *      every @mention in a chat is a bot that posts all day, and "posts all day
 *      unasked" is the single most common reason a group helper gets reported
 *      and its account disabled.
 *   2. Re-adding members to a group automatically. Facebook's terms forbid
 *      adding people to groups without their consent, and an auto re-inviter
 *      does exactly that — including on the people who were *kicked*, which is
 *      the most destructive version of it.
 *   3. Pushing the same message to every chat at once. Identical text fanning
 *      out to many recipients in a short window is what spam classifiers look
 *      for, and the account pays for it.
 *   4. Replying to shared links nobody asked about. Answering every video link
 *      in a chat makes the bot a participant in conversations it was not
 *      invited into.
 *
 * The rules are deliberately conservative. A rule that is slightly too strict
 * costs a feature; a rule that is slightly too loose costs the account.
 *
 * In-memory only, like cooldown.js, flood.js and lock.js: a restart clears the
 * counters, which is correct for a rate limiter.
 */

/** Rolling windows, in milliseconds. */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Tunables.
 *
 * fanoutPerHour / fanoutPerDay bound the number of messages the bot may push
 * out without somebody in the chat having asked for one. The per-hour number is
 * the one that matters: a fan-out of forty chats in an hour is a lot of
 * unsolicited posting, but it is not a burst, and it does not look like an
 * automated spray. A thousand in an hour does.
 *
 * broadcastDelayMs is the floor between two fan-out sends, and
 * broadcastJitterMs is the random extra on top of it. The jitter is not
 * decoration: a fixed delay is a rhythm, and a machine with a rhythm is a
 * machine, while a human pauses unpredictably.
 */
const DEFAULTS = {
  fanoutPerHour: 40,
  fanoutPerDay: 200,
  broadcastDelayMs: 3500,
  broadcastJitterMs: 3000,
};

/**
 * Tokens that are never a command, whoever types them.
 *
 * With `@` as the prefix, `@everyone` and `@here` are the way people address a
 * whole chat. If the bot treats them as commands it answers the room — not the
 * person who typed them — every single time, which is the worst possible shape
 * for an unsolicited reply.
 *
 * `admin` and `admins` are here for the same reason: `@admin` is how people
 * ask a human for help.
 */
const RESERVED_TOKENS = new Set([
  'everyone', 'all', 'here', 'channel', 'admins', 'admin', 'anyone', 'op', 'ops',
]);

/** Timestamps of fan-out sends, for the rolling windows. */
const fanoutHour = [];
const fanoutDay = [];

/** Drop timestamps that fell out of the window. Mutates in place. */
function prune(times, windowMs, now) {
  const cutoff = now - windowMs;
  let keep = 0;
  while (keep < times.length && times[keep] <= cutoff) keep += 1;
  if (keep > 0) times.splice(0, keep);
}

/**
 * Is this token a person being tagged rather than a command being typed?
 *
 * Two sources, both checked:
 *
 *   - `event.mentions`, which Facebook populates with the real mentions in the
 *     message. It maps uid -> display name, so a token is a mention when it is
 *     one of the uids, or when it matches one of the names.
 *   - the reserved list above, which covers the broadcast words Facebook does
 *     not turn into a mention.
 *
 * The mention check matters even when the token happens to be a command name:
 * if somebody in the chat is called "help", then "@help" is them getting
 * attention, not a request for the help menu.
 *
 * @param {string} token the word after the prefix
 * @param {object} [event] the message event
 * @returns {boolean}
 */
function isMentionToken(token, event) {
  const clean = String(token || '').trim().toLowerCase();
  if (!clean) return false;
  if (RESERVED_TOKENS.has(clean)) return true;

  const mentions = (event && event.mentions) || null;
  if (!mentions || typeof mentions !== 'object') return false;

  // The token may be a uid — that is the key side of the map.
  if (mentions[clean]) return true;

  // Or a display name — that is the value side. Compared loosely because
  // Facebook's own casing does not always match what somebody typed.
  const hit = Object.values(mentions).some((name) => (
    String(name || '').trim().toLowerCase() === clean
  ));
  return hit;
}

/**
 * Should the bot answer an unrecognised command?
 *
 * In a group: no. The likeliest reason a group contains `@something` the bot
 * does not know is that somebody is tagging a person. Answering it is a
 * message to the room that nobody asked for, and it is the behaviour that
 * turns a helpful bot into a reported one.
 *
 * In a private chat: yes. There is exactly one reader, they typed something at
 * the bot on purpose, and "I do not know that one" is a genuinely useful
 * answer. The cost of a wasted message in a DM is nothing.
 *
 * @param {boolean} isGroup
 * @returns {boolean}
 */
function shouldAnswerUnknown(isGroup) {
  return !isGroup;
}

/**
 * Take one slot from the fan-out budget.
 *
 * @returns {boolean} false when the budget is spent, true when the send may go
 *   out and the slot has been counted.
 */
function takeFanoutSlot() {
  return takeFanoutSlots(1);
}

/**
 * Take `n` slots from the fan-out budget, all or nothing.
 *
 * All-or-nothing on purpose. A fan-out that is cut off halfway leaves some
 * chats with the message and some without, and the operator has no way to tell
 * which is which — and the half that did go out is still the spam signal. So
 * the budget is checked for the whole batch before the first send, and a
 * broadcast either goes to every chat it was aimed at or goes nowhere.
 *
 * @param {number} n how many messages are about to go out
 * @returns {boolean} true when the whole batch is within budget and has been
 *   counted; false when it is not, and nothing was counted.
 */
function takeFanoutSlots(n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (count === 0) return true;
  const now = Date.now();
  prune(fanoutHour, HOUR, now);
  prune(fanoutDay, DAY, now);
  if (fanoutHour.length + count > DEFAULTS.fanoutPerHour) return false;
  if (fanoutDay.length + count > DEFAULTS.fanoutPerDay) return false;
  for (let i = 0; i < count; i += 1) {
    fanoutHour.push(now);
    fanoutDay.push(now);
  }
  return true;
}

/**
 * Would a batch of `n` messages fit in the remaining budget?
 *
 * Checked without spending anything, so a caller can refuse before it starts.
 *
 * @param {number} n
 * @returns {boolean}
 */
function canFanout(n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  const now = Date.now();
  prune(fanoutHour, HOUR, now);
  prune(fanoutDay, DAY, now);
  return (fanoutHour.length + count <= DEFAULTS.fanoutPerHour)
    && (fanoutDay.length + count <= DEFAULTS.fanoutPerDay);
}

/**
 * How much fan-out budget is left.
 *
 * @returns {{hour:number, day:number, hourMax:number, dayMax:number}}
 */
function fanoutRemaining() {
  const now = Date.now();
  prune(fanoutHour, HOUR, now);
  prune(fanoutDay, DAY, now);
  return {
    hour: Math.max(0, DEFAULTS.fanoutPerHour - fanoutHour.length),
    day: Math.max(0, DEFAULTS.fanoutPerDay - fanoutDay.length),
    hourMax: DEFAULTS.fanoutPerHour,
    dayMax: DEFAULTS.fanoutPerDay,
  };
}

/**
 * How long to wait before the next fan-out send.
 *
 * @returns {number} milliseconds
 */
function broadcastDelayMs() {
  return DEFAULTS.broadcastDelayMs
    + Math.floor(Math.random() * DEFAULTS.broadcastJitterMs);
}

/**
 * May the bot answer a link that was shared in this chat?
 *
 * Off unless the chat turned it on. The bot posting a download for every
 * video link in a chat is not a feature everybody wants, and in a chat where
 * somebody does not want it, it is the bot talking to people who never asked.
 *
 * @param {object|null} gc the chat's `gc` block
 * @returns {boolean}
 */
function autoDownloadAllowed(gc) {
  return Boolean(gc && gc.autoDownload && gc.autoDownload.on);
}

/**
 * List the settings in this chat that put the account at risk.
 *
 * Used by the owner-facing safety report. Each entry names the setting, why it
 * is a risk, and what to do about it — a report that only says "3 risks" is
 * not actionable.
 *
 * @param {object} [group] the chat's group document
 * @returns {Array<{level:string, setting:string, why:string, fix:string}>}
 */
function safetyReport(group) {
  const g = group || {};
  const gc = g.gc || {};
  const out = [];

  if (g.autoAddLeavers) {
    out.push({
      level: 'warning',
      setting: 'Auto re-invite of leavers',
      why: 'The bot adds people back to this chat on its own. People an admin removed are excluded, so it only pulls back the ones who left by themselves — but it is still an automated group addition, which the platform does not like.',
      fix: 'Turn it off with the autoadd command if this chat does not need it.',
    });
  }
  if (gc.autoDownload && gc.autoDownload.on) {
    out.push({
      level: 'warning',
      setting: 'Auto-download of shared links',
      why: 'The bot answers every video link in the chat, so it posts to people who never asked it to.',
      fix: 'Turn it off with the autodownload command.',
    });
  }
  if (g.settings && g.settings.welcome) {
    out.push({
      level: 'info',
      setting: 'Welcome messages on',
      why: 'The bot greets every new member. Fine in a chat that wants it, noisy in one that does not.',
      fix: 'Turn it off with the welcome command.',
    });
  }
  const invites = gc.invites || {};
  if (invites.windowStart) {
    out.push({
      level: 'warning',
      setting: 'An invite war is running',
      why: 'A game that rewards people for adding others to this chat brings in members who did not choose to be here, and they are the people most likely to report the bot.',
      fix: 'End it with the invitewar command.',
    });
  }
  return out;
}

/**
 * Housekeeping. Called from the same sweep as flood.sweep().
 */
function sweep() {
  const now = Date.now();
  prune(fanoutHour, HOUR, now);
  prune(fanoutDay, DAY, now);
}

/**
 * Forget the budget. Test-only, and used by `!compliance reset`.
 */
function reset() {
  fanoutHour.length = 0;
  fanoutDay.length = 0;
}

module.exports = {
  DEFAULTS,
  RESERVED_TOKENS,
  isMentionToken,
  shouldAnswerUnknown,
  takeFanoutSlot,
  takeFanoutSlots,
  canFanout,
  fanoutRemaining,
  broadcastDelayMs,
  autoDownloadAllowed,
  safetyReport,
  sweep,
  reset,
};
