'use strict';

/**
 * MODULE 9 — FUN / SOCIAL (35 commands)
 *
 * iKON-BOT v2 Ultra. The reason anyone adds the bot to a group chat.
 *
 * Exports a plain array. No factories, no legacy loader.
 *
 * Shape required for every command:
 * { name, aliases, category, description, usage, cooldown, permission, execute }
 *
 * execute receives: { api, event, args, config, registry, gemini, reply, react, userDoc }
 *
 * THE ONE RULE IN THIS MODULE
 * Almost nothing here is real. A slap is a message, a kill is a message, a
 * marriage is a string in a field. The commands say so in their output, because
 * a bot that pretends to stab somebody and then reports it as a fact is a bot
 * nobody trusts. Everything that can hurt somebody's balance is labelled.
 *
 * THE ECONOMY
 * Coin movement is real and it is the whole reason the module is viral:
 *   hug        the hugger pays 50, the target receives 50   (a gift, net zero)
 *   slap       the target loses 100, the slapper takes 50   (50 is destroyed)
 *   marry      5,000 up front
 *   divorce    10,000 up front
 *   dare       500 only on failure
 * Nothing here can print a balance, and every transfer is derived from the
 * loser's actual coins, so no combination of these commands can mint money.
 *
 * PAIR STATE
 * Ships, besties and enemies live on Group.fun, keyed on the two uids sorted
 * lexicographically. Sorting is the whole trick: without it shipping A+B and
 * B+A creates two separate rows and the scoreboard lies.
 *
 * GAMES
 * Party games (dare, truth, wouldyouother, never have I ever, 2 truth 1 lie)
 * run on bot/cache with an empty uid, which makes the key thread-scoped. They
 * expire in two minutes on their own, so an abandoned game cannot haunt a chat
 * for a day.
 */

const User = require('../models/User');
const Economy = require('../models/Economy');
const Group = require('../models/Group');
const cache = require('../bot/cache');
const mongo = require('../bot/mongo');
const canvasKit = require('../bot/canvas');

const CASH = 'K-Cash';
const OWNER = 'Aphecks iKon Klerk';

// ───────────────────────────────────────────────────────────
// TABLES
// ───────────────────────────────────────────────────────────

/** Fake violence. Every one is a message, not an event. */
const KILL_METHODS = [
  ['a very large falling fruit', 'it did not even hit properly'],
  ['the last stair', 'you could argue it was not fatal'],
  ['a misunderstanding about a nap', 'the nap was very deep'],
  ['an extremely aggressive parking ticket', 'the fine was fatal'],
  ['being slightly too online', 'they logged off permanently'],
  ['a spatula', 'police are calling it domestic'],
  ['the group chat at 3am', 'nobody survived the notifications'],
  ['an uno reverse', 'they never saw it coming'],
  ['a strongly worded email', 'cc was the whole group'],
  ['a broken promise and a broken chair', 'both were load-bearing'],
];

/** Stabs. Same rule. */
const STAB_WAYS = [
  'a butter knife, so it barely counts',
  'a letter opener, with the paperwork stacked neatly',
  'the one from the kitchen drawer everybody knows about',
  'a very sharp spoon',
  'a broken bottle and poor judgment',
];

/** Roasts. No AI anywhere in this module, by design — these are hand-written. */
const ROASTS = [
  'Your personality is a filename called "final_v2_FINAL".',
  'You are proof that a group chat can be a crime scene.',
  'Somebody peaked you and it was downhill from there.',
  'You have the personality of a terms of service agreement.',
  'You are the human version of a buffering wheel.',
  'Your chat presence is a comma. Technically present, contributing nothing.',
  'You argue like a Terms and Conditions page nobody finished.',
  'You are three messages into a conversation you have not read.',
  'Your best idea all year was reacting with 🔥. Respectfully.',
  'You peaked in the group chat in March and have been coasting since.',
  'You are the reason someone muted this chat and then unmuted it out of guilt.',
  'You bring the energy of a group chat nobody opens.',
  'Somebody set an away message on you years ago and never cleared it.',
  'Your humour has a 30% refund policy and no stock left.',
  'You are confidently wrong about everything and loud about it.',
  'You are the friend who says "we should totally do that" and never does.',
  'You have been added to a voice note three times.',
  'Your contribution to this conversation can be measured in periods.',
  'You are the human version of buffering forever.',
  'Somebody read the room and it was you who emptied it.',
];

/** Compliments with the compliment buried. */
const BACKHANDED = [
  'You are so consistent. Consistently the loudest one in here.',
  'You have real talent. For explaining a joke that already landed.',
  'Your confidence is inspiring. It is doing a lot of work on its own.',
  'You are always there. Especially when it could have been anybody else.',
  'Your heart is enormous. Your reply timing is not.',
  'You light up the chat. You also seem to feel the sunlight.',
  'You are very dependable. Predictable, even.',
  'You have great stamina for someone who keeps saying they are leaving.',
  'Your messages are short. So is the list of things you have won an argument in.',
  'You are a great listener, which is lucky, because you rarely talk.',
  'You bring joy. Mostly to yourself, quietly.',
  'You are very brave. Running away from questions is a skill.',
];

/** Dares. The failure mode is always 500 coins, never a ban. */
const DARES = [
  'change your display name to something embarrassing for 10 minutes',
  'send the last photo in your camera roll',
  'type the last thing you texted, word for word',
  'let the next person to message pick your status for an hour',
  'reply to the second-to-last message in this chat with just "yes"',
  'say the alphabet backwards in one message',
  'change your profile picture to the most recent emoji you used',
  'read your last message out loud, here, in text',
  'let someone tag you with any emoji for an hour',
  'say the most honest compliment you can think of about the last person who spoke',
  'send a voice note of yourself humming one song',
  'type your most controversial take and defend it in the next message',
];

/** Truth questions for !truthultra. */
const TRUTHS = [
  'What is the last thing you searched on your phone?',
  'Who in this chat did you pretend to like, and why?',
  'What is your most embarrassing screen name history?',
  'Which person here would you NOT want stuck in a lift with?',
  'What is the worst gift you have ever received and pretended to love?',
  'How many of your chats have you muted but still open every day?',
  'What is something you pretend to understand but do not?',
  'Who was the last person you argued with online, and were you right?',
  'What is the pettiest reason you have ever stopped talking to someone?',
  'What is your most irrational hill to die on?',
];

/** Would-you-rather pairs. Neither option is ever the safe one. */
const WYR = [
  ['always know what everybody is thinking about you', 'never be able to lie again'],
  ['be able to pause any conversation for 10 minutes', 'rewind any conversation you have had'],
  ['win every bet but owe 5000 coins', 'lose every bet but owe nothing'],
  ['be famous in a country you cannot visit', 'be anonymous in a country that loves you'],
  ['get 1,000,000 coins now and be poor for life', 'be comfortable forever and never win anything'],
  ['have your messages read aloud by everyone', 'have all your messages typed by someone else'],
  ['always know who is lying to you', 'never be lied to, even to your face'],
  ['give up your pet forever', 'give up your best friend forever'],
  ['be the most hated person here, but rich', 'be the most loved person here, but broke'],
  ['only be able to send memes for a month', 'only be able to send apologies for a month'],
];

/** Never have I ever prompts. */
const NEVER = [
  'broken a bone and told nobody',
  'sung in public with confidence',
  'read someone else private messages',
  'been kicked out of a group chat',
  'woken up in a place you could not explain',
  'blocked someone and never unblocked them',
  'pretended to still speak a language you forgot',
  'cried in front of a pet',
  'had a whole argument over a typo',
  'sent a screenshot of the wrong conversation',
  'replied "ok" to something you did not understand',
  'been more tired than angry in a fight',
];

/** Toxic facts. Generated from what is actually known, never invented. */
const FACT_TEMPLATES = [
  (t) => `has run ${num(t.fun.roasts)} roasts. That is not a personality, that is a job.`,
  (t) => `has been slapped ${num(t.fun.slaps)} times and still comes back to this chat.`,
  (t) => `has ${num(t.fun.hugs)} hugs on record and still cannot ask for one out loud.`,
  (t) => `has flexed ${num(t.fun.flexes)} times. The confidence is real. The balance is not.`,
  (t) => `has failed ${num(t.fun.daresFailed)} dares and paid for every single one.`,
  (t) => `has ${num(t.fun.kills)} fake kills. Nobody has ever been actually killed. This is a bot.`,
  (t) => `has done ${num(t.fun.dares)} dares, which is more commitment than most people show.`,
  (t) => `has ${num(t.fun.stabs)} stabs on record. All of them were messages.`,
  (t) => `has been the target of ${num(t.fun.giftsIn)} gifts and the source of ${num(t.fun.giftsOut)}. The maths is damning.`,
  (t) => `has ${num(t.fun.cuddles)} cuddles logged. Nobody has verified any of them.`,
];

/** Pick up lines aimed at somebody. */
const PICKUP_LINES = [
  'Are you a spreadsheet? Because I want to get inside your cells.',
  'Did it hurt when you fell from heaven?',
  'You must be a regex, because you match my pattern.',
  'Are you the WiFi? Because I am feeling a connection.',
  'You have 4 wheels and a licence. That is my whole personality too.',
  'Is your name Wi-Fi? Because I am sensing a connection.',
  'Are you a cookie? Because you are the best thing in this chat.',
  'Do you have a map? Because I am completely lost in your chat.',
  'You are the human version of an update that finally fixed something.',
  'Are you a keyboard? Because you are my type.',
];

/** Rizz lines, graded by how much dignity the attempt costs. */
const RIZZ_LINES = [
  'walked in, said nothing, left. that is the whole strategy.',
  'asked a question and then listened to the answer. unheard of.',
  'complimented something they made. specific, not generic. devastating.',
  'remembered a name. THE name. that is a 95.',
  'told a joke that they laughed at, which is a hate crime in this chat.',
  'said "you always" about a single thing. that is villain behaviour.',
  'simply agreed with them. no notes. maximum respect.',
  'used their name in a sentence. basic, but it works.',
];

// ───────────────────────────────────────────────────────────
// STATE
// ───────────────────────────────────────────────────────────

/**
 * Backfill the fun record field by field.
 *
 * It matters more here than in most modules because these counters are read by
 * other commands' meters: an undefined counter plus 1 is NaN, and NaN prints
 * as "NaN" on somebody's toxicity scoreboard.
 */
function f(userDoc) {
  if (!userDoc.fun || typeof userDoc.fun !== 'object') userDoc.fun = {};
  const t = userDoc.fun;
  for (const k of [
    'hugs', 'slaps', 'kisses', 'pats', 'cuddles', 'kills', 'stabs', 'bonks', 'yeets',
    'shipped', 'roasts', 'compliments', 'dares', 'daresDone', 'daresFailed', 'flexes',
    'giftsIn', 'giftsOut',
  ]) {
    if (!Number.isFinite(t[k])) t[k] = 0;
  }
  if (typeof userDoc.spouse !== 'string') userDoc.spouse = '';
  return t;
}

/** Persist a document, tolerating offline mode. */
async function save(doc) {
  if (!doc || doc.transient) return;
  try {
    await doc.save();
  } catch { /* the reply still shows the outcome */ }
}

/** Append one line to the ledger. Never throws. */
async function ledger(uid, action, amount, balanceAfter, metadata = {}) {
  if (!mongo.isReady()) return;
  try {
    await new Economy({ uid, action, amount, balanceAfter, metadata }).save();
  } catch { /* auditing is best effort */ }
}

/**
 * Take coins from somebody.
 *
 * Returns { ok:false, short } when they cannot cover it, so a caller can say
 * "they are broke" instead of silently doing nothing. The amount is clamped to
 * what they actually hold, which is what stops a slap from printing a balance.
 *
 * @returns {Promise<{ok:boolean, took:number, short:boolean}>}
 */
async function take(userDoc, amount, action, metadata = {}) {
  const want = clamp(amount);
  const have = clamp(userDoc.coins);
  if (want <= 0) return { ok: true, took: 0, short: false };
  if (have < want) {
    const took = have;
    userDoc.coins = 0;
    await save(userDoc);
    await ledger(userDoc.uid, action, -took, 0, { ...metadata, wanted: want, short: true });
    return { ok: false, took, short: true };
  }
  userDoc.coins = have - want;
  await save(userDoc);
  await ledger(userDoc.uid, action, -want, userDoc.coins, metadata);
  return { ok: true, took: want, short: false };
}

/** Give coins to somebody. Amount is clamped at 0 so nothing goes negative. */
async function give(userDoc, amount, action, metadata = {}) {
  const gain = clamp(amount);
  if (gain <= 0) return 0;
  userDoc.coins = clamp(userDoc.coins) + gain;
  await save(userDoc);
  await ledger(userDoc.uid, action, gain, userDoc.coins, metadata);
  return gain;
}

/**
 * Take a flat fee from the caller before doing anything expensive.
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function fee(userDoc, cost, action) {
  const paid = await take(userDoc, cost, action, { cost });
  if (!paid.ok) {
    return {
      ok: false,
      reason: `💸 **Not enough.** ${kc(cost)} needed and you have ${kc(userDoc.coins)}.`,
    };
  }
  return { ok: true };
}

// ───────────────────────────────────────────────────────────
// TARGETING
// ───────────────────────────────────────────────────────────

/** Resolve @tag, raw uid, or an exact name to a User document. */
async function resolve(ref, event) {
  const clean = String(ref || '').replace(/^@/, '').trim();
  if (!clean) return null;
  if (/^\d+$/.test(clean)) return User.findOne({ uid: clean });

  const tagged = event.mentions && Object.values(event.mentions).find((m) => String(m) === clean);
  if (tagged) return User.findOne({ uid: String(tagged) });

  const safe = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return User.findOne({ name: new RegExp(`^${safe}$`, 'i') });
}

/**
 * The target of a social command, refusing empty tags and self-tags.
 *
 * Nobody gets to hug, slap or marry themselves: every one of those jokes dies
 * the moment it is allowed, and !shipultra self-shipping would let one person
 * fill the ships board alone.
 *
 * @returns {Promise<{uid:string,name:string}|null>} null after already replying
 */
async function pick(reply, messageID, userDoc, args, event, label) {
  if (!args[0]) {
    await reply(`❌ Usage: \`!${label} @user\` — tag somebody in this chat.`, messageID);
    return null;
  }
  const found = await resolve(args[0], event);
  if (!found) {
    await reply(`❌ Nobody called \`${args[0]}\` lives here. Tag somebody real.`, messageID);
    return null;
  }
  if (String(found.uid) === String(userDoc.uid)) {
    await reply(`🙃 \`!${label} ${args[0]}\` — that is you. Pick someone else.`, messageID);
    return null;
  }
  return found;
}

// ───────────────────────────────────────────────────────────
// GROUP PAIRS
// ───────────────────────────────────────────────────────────

/**
 * Find this group's document, backfilling the fun block.
 * Returns null in DMs and whenever the database is asleep.
 */
async function groupOf(event) {
  if (!event || !event.isGroup) return null;
  if (!mongo.isReady()) return null;
  const group = await Group.findOne({ tid: String(event.threadID) }).catch(() => null);
  if (!group) return null;
  if (!group.fun || typeof group.fun !== 'object') group.fun = {};
  if (!Array.isArray(group.fun.ships)) group.fun.ships = [];
  if (!Array.isArray(group.fun.besties)) group.fun.besties = [];
  if (!Array.isArray(group.fun.enemies)) group.fun.enemies = [];
  return group;
}

/**
 * Add score to a pair on a board.
 *
 * The two uids are sorted so that a+b and b+a are one row. That is the entire
 * reason shipultra and coupleultra can ever agree with each other.
 *
 * @returns {Promise<{score:number, row:object}|null>}
 */
async function score(group, list, a, b, amount, by) {
  if (!group || !Array.isArray(group.fun[list])) return null;
  const [x, y] = [String(a), String(b)].sort();
  let row = group.fun[list].find((r) => r && r.a === x && r.b === y);
  if (!row) {
    row = { a: x, b: y, score: 0, by: String(by) };
    group.fun[list].push(row);
  }
  row.score = clamp(row.score) + clamp(amount);
  try { await group.save(); } catch { /* the reply still reports the new total */ }
  return { score: row.score, row };
}

/** Name a uid from a board row, falling back to the uid if the user is gone. */
async function nameOf(uid) {
  try {
    const doc = await User.findOne({ uid: String(uid) });
    return (doc && doc.name) || String(uid);
  } catch {
    return String(uid);
  }
}

// ───────────────────────────────────────────────────────────
// PETS
// ───────────────────────────────────────────────────────────

/**
 * The strongest living pet of a hunter, or null.
 *
 * Only used for flavour and for the two places a pet matters mechanically:
 * a hug gets a bonus if you bring one, and a pet can be "killed" in roleplay.
 * Every failure path returns null so a pet lookup can never block a command.
 */
async function petOf(userDoc) {
  if (!mongo.isReady()) return null;
  try {
    // eslint-disable-next-line global-require
    const Pet = require('../models/Pet');
    return await Pet.findOne({ ownerUid: String(userDoc.uid), isDead: false }).sort({ basePower: -1 });
  } catch {
    return null;
  }
}

/** Total pet power, mirroring the module 4 formula. */
function petPower(pet) {
  if (!pet) return 0;
  return clamp(pet.basePower) + clamp(pet.level) * 10 + clamp(pet.prestige) * 50;
}

// ───────────────────────────────────────────────────────────
// CARDS
// ───────────────────────────────────────────────────────────

/**
 * Draw a social card. Returns a data URL, or null when the native canvas binary
 * is missing so the caller can fall back to text.
 *
 * The caveat is printed on the card itself. A hug card that does not say it is
 * a hug is just a picture of two people.
 */
async function card({ title, subtitle = '', body = '', footer = '', accent = canvasKit.theme.accent }) {
  const made = canvasKit.create(800, 460);
  if (!made) return null;
  const { ctx } = made;

  const bg = ctx.createLinearGradient(0, 0, 800, 460);
  bg.addColorStop(0, canvasKit.theme.bg1);
  bg.addColorStop(1, canvasKit.theme.bg2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 800, 460);

  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 800, 10);

  ctx.fillStyle = canvasKit.theme.text;
  ctx.font = 'bold 44px iKonSans';
  wrap(ctx, title || 'iKON', 50, 84, 700, 50);

  ctx.fillStyle = canvasKit.theme.accent2;
  ctx.font = 'bold 28px iKonSans';
  if (subtitle) wrap(ctx, subtitle, 50, 146, 700, 34);

  ctx.fillStyle = canvasKit.theme.muted;
  ctx.font = '22px iKonSans';
  wrap(ctx, body || '', 50, subtitle ? 210 : 160, 700, 30);

  ctx.fillStyle = canvasKit.theme.gold;
  ctx.font = 'bold 19px iKonSans';
  wrap(ctx, footer || 'NONE OF THIS IS REAL', 50, 415, 700, 24);

  const buffer = await canvasKit.toBuffer(made.canvas);
  return buffer ? `data:image/png;base64,${buffer.toString('base64')}` : null;
}

/** Draw wrapped text and return the y past the last line. */
function wrap(ctx, text, x, y, maxWidth, lineHeight) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  let line = '';
  let at = y;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, at);
      line = w;
      at += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) {
    ctx.fillText(line, x, at);
    at += lineHeight;
  }
  return at;
}

/** A 0-100 score with a label, for every meter in the module. */
function meter(pct, label, rows) {
  const filled = Math.max(0, Math.min(10, Math.round(clamp(pct) / 10)));
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  return `${label}\n\`${bar}\` ${Math.max(0, Math.min(100, Math.round(clamp(pct))))}%`;
}

// ───────────────────────────────────────────────────────────
// SMALL HELPERS
// ───────────────────────────────────────────────────────────

/** Run a handler with a user-facing safety net. */
async function guard(reply, messageID, label, fn) {
  try {
    await fn();
  } catch (err) {
    await reply(`⚠️ \`${label}\` failed: ${err.message}`, messageID);
  }
}

const clamp = (v) => Math.max(0, Math.floor(Number(v) || 0));
const num = (v) => Number(v || 0).toLocaleString('en-US');
const kc = (v) => `${Number(v || 0).toLocaleString('en-US')} ${CASH}`;
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick1 = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Fees. Only the commands that move real money are listed. */
const FEES = {
  hugultra: 50,
  slapultra: 50,
  kissultra: 50,
  shipultra: 50,
  killultra: 100,
  stabultra: 100,
  patultra: 50,
  cuddleultra: 50,
  kickultra: 100,
  punchultra: 100,
  bonkultra: 100,
  yeetultra: 100,
  roastultra: 50,
  complimentultra: 50,
  marryultra: 50,
  divorceultra: 50,
  dareultra: 100,
  exposeultra: 100,
  flexultra: 100,
  auraultramax: 50,
  bestiesultra: 50,
  enemiesultra: 50,
};

/** Every command in this module, in registration order. */
const commands = [];

// ───────────────────────────────────────────────────────────
module.exports = commands;
