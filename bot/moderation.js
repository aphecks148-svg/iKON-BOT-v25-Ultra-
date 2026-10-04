'use strict';

/**
 * Chat enforcement — makes the `gc` moderation settings actually mean something.
 *
 * Every flag in `models/Group.js` under `gc` was write-only. `!gcmute` told an
 * admin "the bot deletes everything they say", `!ghostban` told them the ban is
 * invisible, `!antilink` promised a fine per link, `!lockdown` promised emoji-only
 * — and none of them were ever read by anything. handleMessage looked at the
 * body for nothing at all: it parsed a command or it did not, and every other
 * message went straight to the RPG counter. An admin could mute a spammer and
 * watch the spam continue, because the mute was a line in a database nobody
 * queried.
 *
 * This module is that missing reader. It is deliberately small and deliberately
 * ordered, from "this person may not talk to the bot at all" down to "this
 * message costs money":
 *
 *   mute      the sender is silenced — dropped with NO reply, ever
 *   ghostban  same, except a direct message is answered so the target is not
 *             left wondering; the group sees nothing either way
 *   ban       refused, with the admin's stated reason
 *   lockdown  emoji-only chat — non-emoji text is dropped
 *   antilink  a link costs the configured fine
 *   warzone   a message from somebody above the coin floor pays a tax
 *
 * Silence is the default response to every offence. A bot that answers spam with
 * a warning is answering spam, and the reply is the part that actually gets read
 * by the rest of the chat.
 *
 * Bot admins bypass the whole module. That is not a nicety — `!lockdown`'s own
 * hint says "Admins still get through — that is the escape hatch", and an admin
 * who mutes themselves into silence cannot unmute themselves.
 */

const Economy = require('../models/Economy');
const mongo = require('./mongo');
const flood = require('./flood');
const cache = require('./cache');
const permissions = require('./permissions');
const toggles = require('./toggles');

/**
 * A link, conservatively.
 *
 * False positives are expensive here: every match costs somebody real coins. So
 * this requires either an explicit scheme, a `www.` prefix, or a dotted host
 * with a real TLD and no whitespace inside it. Bare words are never links, and
 * "e.g." or "i.e." cannot match because no TLD is "g" or "i".
 */
const LINK = /(?:https?:\/\/|ftp:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.(?:com|net|org|io|co|gg|me|app|dev|link|site|shop|top|ru|cc|tv|biz|info|xyz|online|live|club|fun|pro)\b\S*/i;

/** Roasts handed out for a caught link. */
const LINK_ROASTS = [
  '🔗 Link confiscated. That is the second thing you have brought us today.',
  '🔗 We do not click those. Now we do not click you.',
  '🔗 Link eaten. You may keep the rest of the sentence.',
  '🔗 No links. The fine is the least of what just happened.',
];

/** How long a chat's `gc` settings are trusted before being re-read. */
const GC_TTL_MS = 5000;

/** threadID -> { at, gc } */
const gcCache = new Map();

/** threadID -> { at, count } — the anti-raid join window. */
const joinsAt = new Map();

/** Anti-raid fallbacks, matching models/Group.js. */
const RAID_BURST = 5;
const RAID_WINDOW_MS = 10000;
/** A sealed chat stays sealed at least this long, however short the burst window. */
const RAID_MIN_HOLD_MS = 60000;

const clamp = (v) => Math.max(0, Math.floor(Number(v) || 0));

/**
 * Read a chat's `gc` block, cached briefly.
 *
 * Cached because this runs on the message path and `toggles.getGroup` is a Mongo
 * query: one query per message to enforce a flag that changes once every few
 * minutes is the wrong trade. Five seconds is short enough that an admin turning
 * a rule on sees it take effect immediately in practice, and long enough that a
 * busy chat does one query instead of one per message.
 *
 * A read that throws returns whatever was cached, which may be null — so a
 * database blip makes enforcement weaker for five seconds instead of taking the
 * whole chat down. Enforcement only ever fails open.
 *
 * @param {string|number} threadID
 * @returns {Promise<object|null>} the gc block, or null when there is nothing
 *   to enforce
 */
async function gcFor(threadID) {
  const id = String(threadID || '');
  if (!id) return null;

  const hit = gcCache.get(id);
  const now = Date.now();
  if (hit && now - hit.at < GC_TTL_MS) return hit.gc;

  let gc = null;
  try {
    const group = await toggles.getGroup(id);
    gc = (group && group.gc) || null;
  } catch {
    return hit ? hit.gc : null;
  }

  gcCache.set(id, { at: now, gc });
  return gc;
}

/** Forget a chat's cached settings. Called by the commands that write them. */
function invalidate(threadID) {
  gcCache.delete(String(threadID || ''));
}

/** Drop chats that have not been asked about in a long time. */
function sweep() {
  const cutoff = Date.now() - GC_TTL_MS * 8;
  for (const [k, v] of gcCache) if (v.at < cutoff) gcCache.delete(k);
  for (const [k, v] of joinsAt) if (v.at < cutoff) joinsAt.delete(k);
}

/** An entry is live when it has no expiry, or an expiry still in the future. */
function active(entry, now = Date.now()) {
  if (!entry || !entry.uid) return false;
  if (!entry.expires) return true;
  const at = entry.expires instanceof Date ? entry.expires.getTime() : new Date(entry.expires).getTime();
  return Number.isFinite(at) && at > now;
}

/** First live entry for a uid in one of the gc punishment lists. */
function find(list, uid, now = Date.now()) {
  if (!Array.isArray(list)) return null;
  const who = String(uid || '');
  if (!who) return null;
  for (const entry of list) if (active(entry, now) && String(entry.uid) === who) return entry;
  return null;
}

/**
 * Is this text nothing but emoji (or the chat's one allowed token)?
 *
 * The configured emoji is compared against the RAW text first. It is then
 * stripped along with everything else emoji-shaped, which is what lets "✅🔥"
 * and a bare "✅" through while "hello" does not.
 *
 * Empty and whitespace-only bodies pass: those are attachments, stickers and
 * reactions, and a lockdown that blocked them would be blocking the only
 * reactions the rule is meant to allow.
 *
 * @param {string} text
 * @param {string} [allowed] the chat's configured pass emoji
 * @returns {boolean}
 */
function emojiOnly(text, allowed) {
  const body = String(text || '').trim();
  if (!body) return true;
  const token = String(allowed || '').trim();
  if (token && (body === token || body.split(/\s+/).every((part) => part === token))) return true;
  const left = body
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\u200d\ufe0f\ufe0e]/gu, '')
    .replace(/[\s!.,'"*\-_~:;()]+/g, '');
  return left === '';
}

/** Append one line to the audit ledger. Never throws. */
async function ledger(uid, action, amount, balanceAfter, metadata = {}) {
  if (!mongo.isReady()) return;
  try {
    await new Economy({ uid, action, amount, balanceAfter, metadata }).save();
  } catch { /* auditing is best effort */ }
}

/**
 * Take coins for an offence, and count it against the sender.
 *
 * @returns {Promise<number>} coins actually taken — 0 when the sender has none,
 *   which is a valid outcome: the fine is a ceiling, not a debt.
 */
async function charge(uid, amount, action) {
  const wanted = clamp(amount);
  if (wanted <= 0) return 0;
  try {
    const userDoc = await cache.getOrCreateUser(uid);
    if (!userDoc) return 0;
    const take = Math.min(clamp(userDoc.coins), wanted);
    if (take <= 0) return 0;
    userDoc.coins = clamp(userDoc.coins - take);
    if (!userDoc.gc || typeof userDoc.gc !== 'object') userDoc.gc = {};
    if (!Number.isFinite(userDoc.gc.fines)) userDoc.gc.fines = 0;
    userDoc.gc.fines += 1;
    await userDoc.save();
    await ledger(userDoc.uid, action, -take, userDoc.coins, { fine: take });
    return take;
  } catch {
    return 0;
  }
}

function kc(n) {
  const v = clamp(n);
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

/**
 * Count a link against the sender and put them aside if they keep bringing them.
 *
 * The fine is the punishment the admin asked for. The escalating hold only kicks
 * in for somebody who has now been fined three times in this chat, because at
 * that point the fine has stopped being a cost and started being a subscription.
 *
 * @param {string|number} threadID
 * @param {string|number} uid
 * @param {object} gc the chat's gc block, to avoid a second settings read
 * @returns {Promise<{taken: number, held: number}>}
 */
async function punishLink(threadID, uid, gc) {
  const taken = await charge(uid, clamp(gc.antiLink && gc.antiLink.fine), 'antilink_fine');

  let held = 0;
  try {
    const userDoc = await cache.getUser(uid);
    if (!userDoc) return { taken, held };
    if (!userDoc.gc || typeof userDoc.gc !== 'object') userDoc.gc = {};
    if (!Number.isFinite(userDoc.gc.links)) userDoc.gc.links = 0;
    userDoc.gc.links += 1;
    if (userDoc.gc.links >= 3) {
      // Growing hold, capped, so somebody who never stops can still come back.
      held = flood.hold(threadID, uid, Math.min(900, 30 * (userDoc.gc.links - 2)));
      userDoc.gc.links = 0;
    }
    await userDoc.save();
  } catch { /* the fine already landed; the counter is the nice part */ }

  return { taken, held };
}

/**
 * Take the warzone tax. Silent by design — a tax that replies is not a tax.
 *
 * @returns {Promise<number>} coins taken
 */
async function collectTax(uid, gc) {
  const tax = clamp(gc.warzone && gc.warzone.tax);
  const floor = clamp(gc.warzone && gc.warzone.floor);
  if (tax <= 0) return 0;
  try {
    const userDoc = await cache.getUser(uid);
    // The floor is on COINS, and deliberately not coins+bank: taxing somebody's
    // savings is a different punishment than the one an admin asked for when they
    // read "holding N coins or more".
    if (!userDoc || clamp(userDoc.coins) < floor) return 0;
    return await charge(uid, tax, 'warzone_tax');
  } catch {
    return 0;
  }
}

/**
 * The one call handleMessage makes, after flood control has already allowed the
 * message through.
 *
 * Never throws. A moderation check that fails closed is the difference between a
 * chat that is briefly unprotected and a chat that has eaten a message.
 *
 * @param {object} msg
 * @param {string|number} msg.threadID
 * @param {string|number} msg.uid sender
 * @param {string} [msg.body] raw text
 * @param {string} [msg.command] the parsed command word, when it is a command
 * @param {boolean} [msg.isGroup] false in a private chat
 * @param {boolean} [msg.exempt] bot admin — short circuits everything
 * @returns {Promise<{action: string, text?: string|null, reason?: string, taken?: number, held?: number}>}
 *   `action` is one of:
 *     'allow'  carry on and run the message normally
 *     'silent' drop it, say nothing at all
 *     'ghost'  drop it; say `text` only when it is a private chat
 *     'refuse' drop it, say `text`
 *     'link'   drop it, fine the sender, say `text`
 */
async function inspect({
  threadID, uid, body = '', command = '', isGroup = true, exempt = false,
} = {}) {
  const who = String(uid || '');
  const out = { action: 'allow' };

  // Bot admins: not recorded, not punished, never blocked. Checked before the
  // settings read, because an admin should not cost a Mongo query to be allowed.
  if (exempt === true || permissions.isOwner(who)) return out;

  const gc = await gcFor(threadID);
  if (!gc || typeof gc !== 'object') return out;

  const now = Date.now();

  // ── 1. Mute ──
  // First, because a muted member must not be able to reach any later rule, and
  // because "the bot deletes everything they say" is only true if nothing they
  // say gets an answer — including the notice that tells them they are muted.
  if (find(gc.mutes, uid, now)) {
    out.action = 'silent';
    out.reason = 'muted';
    return out;
  }

  // ── 2. Ghostban ──
  // Indistinguishable from being offline to everybody but the target: the bot
  // says nothing, in the group or in public. A direct message IS answered,
  // because a ghostban that leaves the victim convinced the bot is simply broken
  // is a bug report waiting to happen.
  if (find(gc.ghostBans, uid, now)) {
    out.action = 'ghost';
    out.reason = 'ghosted';
    out.text = isGroup
      ? null
      : '⚠️ This conversation is not being received right now.';
    return out;
  }

  // ── 3. Ban ──
  // A real ban says so. Silence here would be a mute with extra steps, and the
  // admin wrote a reason the member is entitled to.
  const ban = find(gc.bans, uid, now);
  if (ban) {
    out.action = 'refuse';
    out.reason = 'banned';
    const why = String((ban && ban.reason) || '').trim();
    out.text = why
      ? `⛔ You are banned from using this bot here.\n📖 ${why}`
      : '⛔ You are banned from using this bot here.';
    return out;
  }

  // ── 4. Lockdown (emoji only) ──
  // Commands are exempt. A lockdown that also blocked `!lockdown off` would have
  // to be lifted from a private message by an owner, which is a much worse
  // emergency than the one it was declared for.
  const lock = gc.lockdown;
  if (lock && lock.on && !command && !emojiOnly(body, lock.emoji)) {
    out.action = 'silent';
    out.reason = 'lockdown';
    return out;
  }

  // ── 5. Anti-link ──
  // For a command, only the ARGUMENTS are tested: the command word is never a
  // link, and fining somebody for typing a command the bot does not have would
  // be charging them for talking to it.
  const haystack = command
    ? String(body || '').slice(String(command).length + 1)
    : String(body || '');
  if (gc.antiLink && gc.antiLink.on && LINK.test(haystack)) {
    const { taken, held } = await punishLink(threadID, uid, gc);
    out.action = 'link';
    out.reason = 'antilink';
    out.taken = taken;
    out.held = held;
    const roast = LINK_ROASTS[Math.floor(Math.random() * LINK_ROASTS.length)];
    out.text = `${roast}\n💸 Fine: ${taken > 0 ? kc(taken) : 'nothing, you are already broke'}`
      + (held ? `\n⏳ Too many links — you are paused for ${held}s.` : '');
    return out;
  }

  // ── 6. Warzone tax ──
  // Runs last and replies to nothing: it is a tax, not a conversation.
  if (gc.warzone && gc.warzone.on) out.taken = await collectTax(uid, gc);

  return out;
}

/**
 * The anti-raid half of the flags: count joins, seal the chat when they burst.
 *
 * The seal is flood's chat-wide hold, so the same gate that drops a spammer's
 * messages drops the raid's welcome cards, and the same admin exemption lifts it.
 * `!antiraid` promised this and nothing ever counted anything.
 *
 * @param {object} msg
 * @param {string|number} msg.threadID
 * @param {number} [msg.joins] how many joined in this event
 * @param {object} [msg.gc] the gc block, when the caller already has it
 * @returns {Promise<{sealed: boolean, holdSec: number, joins: number}>}
 */
async function raidCheck({ threadID, joins = 0, gc } = {}) {
  const settings = gc || (await gcFor(threadID));
  const raid = settings && settings.antiRaid;
  if (!raid || !raid.on) return { sealed: false, holdSec: 0, joins };

  const burst = Math.max(2, Number(raid.burst) || RAID_BURST);
  const windowMs = Math.max(1000, Number(raid.windowMs) || RAID_WINDOW_MS);

  const id = String(threadID || '');
  const now = Date.now();
  const slot = (joinsAt.has(id) && now - joinsAt.get(id).at < windowMs)
    ? joinsAt.get(id)
    : { at: now, count: 0 };
  slot.count += Math.max(0, Number(joins) || 0);
  joinsAt.set(id, slot);

  if (slot.count < burst) return { sealed: false, holdSec: 0, joins: slot.count };

  // Sealed for a full window past the burst — long enough that the raid is over,
  // short enough that nobody is locked out of their own chat overnight.
  const holdSec = Math.round(Math.max(windowMs, RAID_MIN_HOLD_MS) / 1000);
  flood.holdThread(id, holdSec);
  slot.count = 0;
  return { sealed: true, holdSec, joins: burst };
}

/** Counts for /health. */
function stats() {
  return { cachedChats: gcCache.size, trackedJoins: joinsAt.size };
}

module.exports = {
  inspect, raidCheck, invalidate, sweep, stats, gcFor,
  // exported for tests and for the commands that write these lists
  active, find, emojiOnly, matchesLink: (t) => LINK.test(String(t || '')), LINK,
};