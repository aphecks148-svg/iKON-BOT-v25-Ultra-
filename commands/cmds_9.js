'use strict';

/**
 * MODULE 9 — FUN / SOCIAL (35 commands)
 *
 * iKON-BOT v2 — Fun and social. The reason anyone adds the bot to a group chat.
 *
 * Exports a plain array. No factories, no legacy loader.
 *
 * Shape required for every command:
 * { name, aliases, category, description, usage, cooldown, permission, execute }
 *
 * execute receives: { api, event, args, config, registry, ai, reply, react, userDoc }
 *
 * THE ONE RULE IN THIS MODULE
 * Almost nothing here is real. A slap is a message, a kill is a message, a
 * marriage is a string in a field. The commands say so in their output, because
 * a bot that pretends to slap somebody and then reports it as a fact is a bot
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
const cards = require('../bot/cards');
const profile = require('../bot/profile');
const userTarget = require('../bot/target');
const gcs = require('../bot/gcs');
const aifun = require('../bot/aifun');

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

/** Roasts. The offline fallback — the AI writes them when Groq answers. */
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

/** Truth questions for !truth. */
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
/**
 * These receive the fun record itself (f(userDoc)), not the user document, so
 * every field is read bare. They interpolate nothing that is not already a
 * counter on the target's own account.
 */
const FACT_TEMPLATES = [
  (t) => `has run ${num(t.roasts)} roast(s). That is not a personality, that is a job.`,
  (t) => `has been slapped ${num(t.slaps)} time(s) and still comes back to this chat.`,
  (t) => `has ${num(t.giftsIn)} hug(s) on record and still cannot ask for one out loud.`,
  (t) => `has flexed ${num(t.flexes)} time(s). The confidence is real. The balance is not.`,
  (t) => `has failed ${num(t.daresFailed)} dare(s) and paid for every single one.`,
  (t) => `has ${num(t.kills)} fake kill(s). Nobody has ever been actually killed. This is a bot.`,
  (t) => `has issued ${num(t.dares)} dare(s), which is more commitment than most people show.`,
  (t) => `has received ${num(t.giftsIn)} gift(s) and sent ${num(t.giftsOut)}. The maths is damning.`,
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
    'hugs', 'slaps', 'kisses', 'kills', 'bonks',
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
  const need = clamp(cost);
  // Checked BEFORE any write. take() deliberately drains whatever the target
  // actually has, which is right for a victim and catastrophic for a fee: a
  // failed fee must leave the balance exactly as it was, or the "not enough"
  // message ends up quoting the money it just took.
  if (clamp(userDoc.coins) < need) {
    return {
      ok: false,
      reason: `💸 **Not enough.** ${kc(need)} needed and you have ${kc(userDoc.coins)}.`,
    };
  }
  await take(userDoc, need, action, { cost });
  return { ok: true };
}

// ───────────────────────────────────────────────────────────
// TARGETING
// ───────────────────────────────────────────────────────────

/**
 * The target of a social command, refusing empty tags and self-tags.
 *
 * Nobody gets to hug, slap or marry themselves: every one of those jokes dies
 * the moment it is allowed, and !ship self-shipping would let one person
 * fill the ships board alone.
 *
 * `api` is a PARAMETER, and it has to be. It used to be referenced here as if it
 * were in scope when it was not, so every command that calls this threw
 * "api is not defined" on the first tagged person — hug, slap, kiss,
 * bonk, kill, ship, roast, compliment, marry, divorce, besties,
 * enemies and the rest of module 9. guard() swallowed it into
 * "`hug` failed: api is not defined", which is why the module read as broken
 * rather than as a crash.
 *
 * @returns {Promise<{uid:string,name:string}|null>} null after already replying
 */
async function pick(reply, messageID, userDoc, args, event, label, api) {
  if (!args[0]) {
    await reply(`❌ Usage: \`!${label} @user\` — tag somebody in this chat.`, messageID);
    return null;
  }
  // A name typed by hand can contain spaces ("!slap Dyro Urano"), so the whole
  // argument list is handed to the resolver and it reports how many tokens the
  // name ate. Most of these commands take nothing after the target, which is
  // what `max` asserts: "!slap Dyro Urano please" must not swallow "please".
  const { target, consumed } = await userTarget.resolveArgs(args, event, api, { doc: true, max: 3 });
  if (!target) {
    await reply(`❌ Nobody called \`${args.join(' ')}\` lives here. Tag somebody real.`, messageID);
    return null;
  }
  if (String(target.uid) === String(userDoc.uid)) {
    await reply(`🙃 \`!${label} ${args.slice(0, consumed).join(' ')}\` — that is you. Pick someone else.`, messageID);
    return null;
  }
  return target;
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
 * reason ship and couple can ever agree with each other.
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
/**
 * The real display name for a uid.
 *
 * Prefers the live Facebook name so a stale or placeholder database entry does
 * not show on the social boards, then the stored name, then a short id. A stored
 * "Facebook User" is the API's own placeholder, never a person's name, so it is
 * treated as no name at all.
 */
async function nameOf(uid, api) {
  try {
    const live = await profile.fetchRealName(uid, api);
    if (live) return live;
  } catch { /* fall through to the stored name */ }
  try {
    const doc = await User.findOne({ uid: String(uid) });
    if (doc && doc.name && !profile.isPlaceholderName(doc.name)) return doc.name;
  } catch { /* fall through to the uid */ }
  return `Hunter ${String(uid).slice(-4)}`;
}


/**
 * Both names on a social card, asked of Facebook rather than trusted.
 *
 * `pick()` refreshes a target's name from the chat's own member list — but only
 * when the list actually carries one. A member whose entry came back thin keeps
 * whatever was stored, and what is stored is the literal "Facebook User" that
 * ws3-fca's createDefaultUser() writes. So a chat could show a card with two real
 * faces and their real names under them, sitting directly above the reply
 * "Facebook User HUGGED Facebook User". The picture was honest and the message
 * was not.
 *
 * Live first, then the stored name if it is not the placeholder, then a short
 * id — `nameOf()`'s order, and the one the boards and the couples board use.
 * Both documents are updated so the next command to print either of them starts
 * from a real name, and the handler's own `save()` persists it.
 *
 * @param {object} actorDoc the person who acted
 * @param {object|null} targetDoc the person they acted on
 * @param {object} api ws3-fca client
 * @returns {Promise<{actor:string, target:string}>}
 */
async function faces(actorDoc, targetDoc, api) {
  const [actor, target] = await Promise.all([
    nameOf(actorDoc && actorDoc.uid, api),
    targetDoc ? nameOf(targetDoc.uid, api) : Promise.resolve(''),
  ]);
  if (actorDoc) actorDoc.name = actor;
  if (targetDoc) targetDoc.name = target;
  return { actor, target };
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
 * Attach a person's avatar URL from the chat's member list, when it has one.
 *
 * `userTarget.threadInfo` is cached for 20 seconds, so a card that shows two
 * people costs at most one extra request — and usually none, because the target
 * resolver has just read the very same thread to turn a tag into a uid.
 *
 * @param {{uid?:string,name?:string,thumbSrc?:string}|null} person
 * @param {string|number} threadID
 * @param {object} api ws3-fca client
 * @returns {Promise<object|null>} the same person, plus `thumbSrc` when found
 */
async function withThumb(person, threadID, api) {
  if (!person || !threadID) return person;
  if (person.thumbSrc) return person;
  try {
    const member = await userTarget.threadMember(person.uid, { threadID }, api);
    if (!member || !member.picture) return person;
    return { ...person, thumbSrc: member.picture };
  } catch {
    return person; // no avatar is fine — the card draws a generated one
  }
}

/**
 * A chat's real name for a card footer, or '' when it cannot be read.
 *
 * @param {string|number} threadID
 * @param {object} api ws3-fca client
 * @returns {Promise<string>}
 */
async function chatNameOf(threadID, api) {
  if (!threadID || !api) return '';
  try {
    const info = await userTarget.threadInfo({ threadID }, api);
    const name = info && (info.threadTitle || info.threadName || info.name || info.title);
    return name ? String(name) : '';
  } catch {
    return '';
  }
}

/**
 * Draw a social card. Returns a data URL, or null when the native canvas binary
 * is missing so the caller can fall back to text.
 *
 * The caveat is printed on the card itself. A hug card that does not say it is
 * a hug is just a picture of two people.
 *
 * When `api` and `left` are supplied it renders as a people card instead: the
 * real Facebook photo of each person, their real Facebook name, and the chat it
 * all happened in. Those three together are what make the card worth looking at
 * — a generated avatar and a stored nickname are not a person. Without them it
 * falls back to the plain text card below, so no call site can break.
 *
 * The photos come from `thumbSrc`, the avatar URL the chat's own member list
 * already carries, so both faces cost nothing extra — bot/cards.js downloads
 * them straight from that URL. threadInfo() only needs a threadID, so the
 * thread is read here from the id the card already has rather than from the
 * event, which is why no call site had to change to get real faces.
 *
 * @param {object} opts
 * @param {object} [opts.api] ws3-fca client; enables the people card
 * @param {{uid?:string,name?:string,thumbSrc?:string}} [opts.left] who acted
 * @param {{uid?:string,name?:string,thumbSrc?:string}} [opts.right] who they acted on
 * @param {string|number} [opts.threadID] printed in the footer, and the thread
 *   the two thumbSrc values are read from
 */
async function card({
  title, subtitle = '', body = '', footer = '',
  accent = canvasKit.theme.accent, api, left, right = null, threadID,
}) {
  // People card: real photos, real names, and the chat they happened in.
  if (api && left) {
    const art2 = await cards.duoCard({
      title, subtitle, body, footer, threadID,
      // The chat's NAME, not its id. The corner of the picture used to read
      // "chat t_9xKq2mZ" — the same identifier-as-content mistake boardCard was
      // printing a uid under every hunter on. Cached for 20s, so this is
      // usually free: the target resolver just read the same thread.
      chatName: await chatNameOf(threadID, api),
      left: await withThumb(left, threadID, api),
      right: await withThumb(right, threadID, api),
      api,
    });
    if (art2) return art2;
    // duoCard only returns null when canvas is missing or a draw threw; fall
    // through to the plain card rather than sending nothing.
  }
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

/**
 * Render a people card and send it, ignoring failure.
 *
 * Every social command calls this after its text reply, so the picture is a
 * bonus: if canvas is missing, the card throws, or a photo cannot be fetched,
 * the text the user already got is still the answer. It must never be the only
 * thing a command sends.
 */
async function art(reply, messageID, opts) {
  try {
    const png = await card(opts);
    if (png) await reply({ attachment: { type: 'image', data: { url: png } } }, messageID);
  } catch {
    /* a picture is never worth failing a command over */
  }
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
function meter(pct, label) {
  const filled = Math.max(0, Math.min(10, Math.round(clamp(pct) / 10)));
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  return `${label}\n\`${bar}\` ${Math.max(0, Math.min(100, Math.round(clamp(pct))))}%`;
}

// ───────────────────────────────────────────────────────────
// SMALL HELPERS
// ───────────────────────────────────────────────────────────

/** A dare is a plain string; this keeps the reply code readable. */
function open_dare_line(dare) {
  return String(dare || '').trim();
}

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
  hug: 50,
  slap: 50,
  kiss: 50,
  ship: 50,
  kill: 100,
  bonk: 100,
  roast: 50,
  compliment: 50,
  marry: 50,
  divorce: 50,
  dare: 100,
  expose: 100,
  flex: 100,
  auramax: 50,
  besties: 50,
  enemies: 50,
};

/** Every command in this module, in registration order. */
const commands = [];

// ───────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────
// CONTACT — the reason anyone adds this bot to a group
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'hug',
    aliases: ['hug2', 'hugx'],
    category: 'fun',
    description: '🤗 Hug somebody and pay them 50. Bringing your pet adds 25',
    usage: '!hug @user',
    cooldown: 5,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'hug', async () => {
      await react('🤗');
      const who = await pick(reply, event.messageID, userDoc, args, event, 'hug', api);
      if (!who) return;

      // Both names are resolved before anything is printed: the reply sits
      // directly above the card, and it used to say "Facebook User HUGGED
      // Facebook User" under two real faces.
      await faces(userDoc, who, api);

      const paid = await fee(userDoc, FEES.hug, 'fun:hug');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      // Bringing a pet is worth 25 more. It is the only mechanical reason to
      // have one in this module, and it costs the hugger nothing to try.
      const pet = await petOf(userDoc);
      const petBonus = pet ? 25 : 0;
      const gift = 50 + petBonus;
      const got = await give(who, gift, 'fun:hug_gift', { from: userDoc.name });

      f(userDoc).hugs += 1;
      f(who).giftsIn += 1;
      f(userDoc).giftsOut += 1;
      await save(userDoc);
      await save(who);

      const group = await groupOf(event);
      if (group) {
        group.fun.hugs = clamp(group.fun.hugs) + 1;
        try { await group.save(); } catch { /* cosmetic */ }
      }

      await react('💚');
      await reply(
        `🤗 **${userDoc.name} HUGGED ${who.name}**\n`
        + '· · · · · · ·\n'
        + `💚 +${kc(got)}${petBonus ? ` (includes +${petBonus} pet bonus${pet && pet.name ? ` — ${pet.name}` : ''})` : ''}\n`
        + `👛 Their wallet: ${kc(who.coins)}\n`
        + `📖 _This is a message and a transfer. Nobody was hugged._`,
        event.messageID,
      );

      // The picture is a bonus on top of the text above, never a replacement:
      // art() swallows every canvas failure, so a missing binary or an
      // unreachable avatar leaves the reply the user already got as the answer.
      // (It used to be `const art = await card(...)`, which shadowed the art()
      // helper inside this very handler.)
      await art(reply, event.messageID, {
        title: '🤗 HUG',
        api,
        threadID: event.threadID,
        left: { uid: userDoc.uid, name: userDoc.name },
        right: { uid: who.uid, name: who.name },
        body: pet
          ? `${pet.emoji || '🐾'} ${pet.name} came along and enjoyed it more than either of you.`
          : 'No pet. It was still acceptable.',
        footer: 'A MESSAGE AND A TRANSFER — NOT A HUG',
        accent: canvasKit.theme.gold,
      });
    }),
  });

  commands.push({
    name: 'slap',
    aliases: ['slap2'],
    category: 'fun',
    description: '👋 Slap somebody — they lose 100, you keep 50, the other 50 evaporates',
    usage: '!slap @user',
    cooldown: 5,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'slap', async () => {
      await react('👋');
      const who = await pick(reply, event.messageID, userDoc, args, event, 'slap', api);
      if (!who) return;

      // Both names are resolved before anything is printed: the reply sits
      // directly above the card, and it used to say "Facebook User HUGGED
      // Facebook User" under two real faces.
      await faces(userDoc, who, api);

      const paid = await fee(userDoc, FEES.slap, 'fun:slap');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      // The target loses up to 100 and you take half of what was actually taken.
      // Deriving the take from the real balance is what stops this printing a
      // negative wallet on somebody who is already broke.
      const lost = await take(who, 100, 'fun:slap_victim', { from: userDoc.name });
      const stole = await give(userDoc, lost.took / 2, 'fun:slap_steal', { from: who.name });

      f(userDoc).slaps += 1;
      await save(userDoc);
      await save(who);

      const group = await groupOf(event);
      if (group) {
        group.fun.slaps = clamp(group.fun.slaps) + 1;
        try { await group.save(); } catch { /* cosmetic */ }
      }

      await react('💢');
      await reply(
        `👋 **${userDoc.name} SLAPPED ${who.name}**\n`
        + '· · · · · · ·\n'
        + `💸 They lost ${kc(lost.took)}${lost.short ? ' (that is everything they had)' : ''}\n`
        + `💰 You took ${kc(stole)}\n`
        + `👛 Their wallet: ${kc(who.coins)}\n`
        + `📖 _A message and a transfer. Everybody is fine._`,
        event.messageID,
      );
    await art(reply, event.messageID, {
      title: '👋 SLAP',
      api,
      threadID: event.threadID,
      left: { uid: userDoc.uid, name: userDoc.name },
      right: { uid: who.uid, name: who.name },
      footer: 'A MESSAGE AND A TRANSFER. EVERYBODY IS FINE.',
    });

    }),
  });

  commands.push({
    name: 'kiss',
    aliases: ['kiss2'],
    category: 'fun',
    description: '💋 Kiss somebody — a love meter, and pets get a breeding chance out of it',
    usage: '!kiss @user',
    cooldown: 5,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'kiss', async () => {
      await react('💋');
      const who = await pick(reply, event.messageID, userDoc, args, event, 'kiss', api);
      if (!who) return;

      // Both names are resolved before anything is printed: the reply sits
      // directly above the card, and it used to say "Facebook User HUGGED
      // Facebook User" under two real faces.
      await faces(userDoc, who, api);

      const paid = await fee(userDoc, FEES.kiss, 'fun:kiss');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      f(userDoc).kisses += 1;
      await save(userDoc);

      // Both pets SAFE means there is no risk of the fight that pet breeding
      // usually turns into. An unsafe pet refuses the whole thing.
      const myPet = await petOf(userDoc);
      const theirPet = await petOf(who);
      const unsafe = [myPet, theirPet].filter((p) => p && p.isSafe === false);
      let petLine = '🐾 No pets involved. Purely theoretical.';
      if (unsafe.length && myPet && theirPet) {
        const names = unsafe.map((p) => p.name);
        petLine = `⚠️ **Unsafe pets.** ${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} in unsafe mode. `;
        petLine += 'Nothing is happening near them.';
      } else if (myPet && theirPet) {
        petLine = `🐾 **Both pets are safe** — ${myPet.name} and ${theirPet.name}. `
          + `There is a breeding chance in this, in the same way there is in a photograph.`;
      } else if (myPet || theirPet) {
        petLine = `🐾 One pet. It watched, unimpressed. (${(myPet || theirPet).name})`;
      }

      await react('❤️');
      await reply(
        `💋 **${userDoc.name} KISSED ${who.name}**\n`
        + '· · · · · · ·\n'
        + `${meter(rand(10, 95), '❤️ LOVE METER')}\n`
        + `${petLine}\n`
        + `👛 Your wallet: ${kc(userDoc.coins)}\n`
        + `📖 _Nothing about this changes your status._`,
        event.messageID,
      );
    await art(reply, event.messageID, {
      title: '💋 KISS',
      api,
      threadID: event.threadID,
      left: { uid: userDoc.uid, name: userDoc.name },
      right: { uid: who.uid, name: who.name },
      footer: 'NOTHING ABOUT THIS CHANGES YOUR STATUS.',
    });

    }),
  });

  commands.push({
    name: 'ship',
    aliases: ['ship2'],
    category: 'fun',
    description: '💘 Ship two people — permanent score on this chat. No take-backs',
    usage: '!ship @a @b',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'ship', async () => {
      await react('💘');
      if (args.length < 2) {
        await reply('❌ Usage: `!ship @a @b` — tag both of them.', event.messageID);
        return;
      }
      // Two names, either of which may contain spaces. Resolve the first from
      // the head of the argument list, then the second from what it left, so
      // "!ship Dyro Urano Bob Smith" reads as two people rather than four tokens
      // that match nobody.
      const first = await userTarget.resolveArgs(args, event, api, { doc: true });
      const a = first.target;
      const rest = args.slice(first.consumed);
      const second = rest.length ? await userTarget.resolveArgs(rest, event, api, { doc: true }) : { target: null };
      const b = second.target;
      if (!a || !b) {
        await reply('❌ Both people have to be real. Check your tags.', event.messageID);
        return;
      }
      if (String(a.uid) === String(b.uid)) {
        await reply('💘 You cannot ship somebody to themselves. The chart would collapse.', event.messageID);
        return;
      }
      if (String(a.uid) === String(userDoc.uid) || String(b.uid) === String(userDoc.uid)) {
        await reply('💘 Shipping yourself is banned by the shipping act of this group.', event.messageID);
        return;
      }

      // Two strangers to each other, so both names are resolved the same way.
      await faces(a, b, api);

      const paid = await fee(userDoc, FEES.ship, 'fun:ship');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const group = await groupOf(event);
      if (!group) {
        await reply('💘 Ships need a group chat and a database. None of that here.', event.messageID);
        return;
      }

      const added = rand(5, 25);
      const scored = await score(group, 'ships', a.uid, b.uid, added, userDoc.uid);
      f(userDoc).shipped += 1;
      await save(userDoc);
      await react('💘');

      const pct = Math.min(100, scored.score);
      await reply(
        `💘 **${a.name} x ${b.name}**\n`
        + '· · · · · · ·\n'
        + `${meter(pct, '💘 SHIP SCORE')}\n`
        + `➕ +${added} from ${userDoc.name}\n`
        + `📈 Total: ${num(scored.score)}\n`
        + `📖 _Permanent. There is no unship command._`,
        event.messageID,
      );

      const art = await card({
        title: '💘 SHIPPED',
        api,
        threadID: event.threadID,
        left: { uid: a.uid, name: a.name },
        right: { uid: b.uid, name: b.name },
        body: `${pct}% of this chat agrees. The other ${100 - pct}% are not invited to the wedding.`,
        footer: `${OWNER} · SHIPS NEVER UNSHIP`,
        accent: canvasKit.theme.accent2,
      });
      if (art) await reply({ attachment: { type: 'image', data: { url: art } } }, event.messageID);
    }),
  });




  commands.push({
    name: 'bonk',
    aliases: ['bonk2'],
    category: 'fun',
    description: '💫 Bonk somebody into horny jail. Costs 100, no way out for 3 minutes',
    usage: '!bonk @user',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'bonk', async () => {
      await react('💫');
      const who = await pick(reply, event.messageID, userDoc, args, event, 'bonk', api);
      if (!who) return;

      // Both names are resolved before anything is printed: the reply sits
      // directly above the card, and it used to say "Facebook User HUGGED
      // Facebook User" under two real faces.
      await faces(userDoc, who, api);

      const paid = await fee(userDoc, FEES.bonk, 'fun:bonk');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      // Horny jail is 3 minutes in cache, thread-scoped. It is cosmetic: it
      // hides commands for a bit and costs nothing, so it can never be used to
      // grief anybody for long.
      cache.setGameState(`${who.uid}:${event.threadID}`, 'hornyjail', { by: userDoc.name }, 3 * 60 * 1000);
      f(userDoc).bonks += 1;
      await save(userDoc);

      await react('🔒');
      await reply(
        `💫 **BONK!**\n`
        + '· · · · · · ·\n'
        + `${userDoc.name} bonked ${who.name} into horny jail.\n`
        + `🔒 3 minutes. No appeals.\n`
        + `👛 Your wallet: ${kc(userDoc.coins)}\n`
        + '📖 _Horny jail stops the fun commands for three minutes. Nothing else._',
        event.messageID,
      );
    await art(reply, event.messageID, {
      title: '🔨 BONK',
      api,
      threadID: event.threadID,
      left: { uid: userDoc.uid, name: userDoc.name },
      right: { uid: who.uid, name: who.name },
      footer: 'A MESSAGE WITH A HARD-LOOKING EMOJI.',
    });

    }),
  });


// ───────────────────────────────────────────────────────────
// FAKE VIOLENCE AND HATE — all of it is a message
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'kill',
    aliases: ['kill2'],
    category: 'fun',
    description: '💀 Fake kill somebody — and their unsafe pet dies with them, also fake',
    usage: '!kill @user',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'kill', async () => {
      await react('💀');
      const who = await pick(reply, event.messageID, userDoc, args, event, 'kill', api);
      if (!who) return;

      // Both names are resolved before anything is printed: the reply sits
      // directly above the card, and it used to say "Facebook User HUGGED
      // Facebook User" under two real faces.
      await faces(userDoc, who, api);

      const paid = await fee(userDoc, FEES.kill, 'fun:kill');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const method = pick1(KILL_METHODS);
      const lost = await take(who, 100, 'fun:kill_victim', { from: userDoc.name });
      f(userDoc).kills += 1;
      await save(userDoc);

      // An UNSAFE pet is the only thing this module ever "kills". Safe pets are
      // explicitly unattackable in module 4 and that rule is respected here:
      // a safe pet gets sympathy, an unsafe one gets dragged into the roleplay.
      const pet = await petOf(who);
      let petLine = '';
      if (pet && pet.isSafe === false) {
        petLine = `\n🐾 **${pet.emoji || '🐾'} ${pet.name} was unsafe mode.** It was dragged along and did not survive the story.`;
        pet.isDead = true;
        pet.diedAt = new Date();
        try { await pet.save(); } catch { /* roleplay damage only */ }
      } else if (pet) {
        petLine = `\n🐾 ${pet.emoji || '🐾'} ${pet.name} is in safe mode and walked out of this one untouched.`;
      }

      const group = await groupOf(event);
      if (group) {
        group.fun.kills = clamp(group.fun.kills) + 1;
        try { await group.save(); } catch { /* cosmetic */ }
      }

      await react('⚰️');
      await reply(
        `💀 **${userDoc.name} KILLED ${who.name}**\n`
        + '· · · · · · ·\n'
        + `🔪 Cause of death: ${method[0]}. ${method[1]}.\n`
        + `💸 They lost ${kc(lost.took)}\n`
        + `👛 Their wallet: ${kc(who.coins)}\n`
        + `${petLine}\n`
        + '📖 _Nobody was killed. This is a message with a sad emoji._',
        event.messageID,
      );
    await art(reply, event.messageID, {
      title: '💀 KILL',
      api,
      threadID: event.threadID,
      left: { uid: userDoc.uid, name: userDoc.name },
      right: { uid: who.uid, name: who.name },
      footer: 'NOBODY WAS KILLED. THIS IS A MESSAGE WITH A SAD EMOJI.',
    });

    }),
  });



  commands.push({
    name: 'roast',
    aliases: ['roast2'],
    category: 'fun',
    description: '🔥 Roast somebody — written fresh by the AI, hand-written when it is away',
    usage: '!roast @user',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'roast', async () => {
      await react('🔥');
      const who = await pick(reply, event.messageID, userDoc, args, event, 'roast', api);
      if (!who) return;

      // Both names are resolved before anything is printed: the reply sits
      // directly above the card, and it used to say "Facebook User HUGGED
      // Facebook User" under two real faces.
      await faces(userDoc, who, api);

      const paid = await fee(userDoc, FEES.roast, 'fun:roast');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      // Fresh from the AI when Groq answers, hand-written when it does
      // not. The prompt hands the model nothing but the target's name, so
      // it has no facts to invent about a real person.
      const aiLine = await aifun.genRoast(who.name);
      const line = aiLine || aifun.pickFresh(ROASTS, 'roast');
      f(userDoc).roasts += 1;
      await save(userDoc);

      await react('💀');
      await reply(
        `🔥 **${userDoc.name} ROASTED ${who.name}**\n`
        + '· · · · · · ·\n'
        + `${line}\n\n`
        + `👛 Your wallet: ${kc(userDoc.coins)}\n`
        + `📖 _${aiLine ? 'Written this second, and still about you.' : 'Pre-written. No AI was involved in this one.'}_`,
        event.messageID,
      );
    await art(reply, event.messageID, {
      title: '🔥 ROAST',
      api,
      threadID: event.threadID,
      left: { uid: userDoc.uid, name: userDoc.name },
      right: { uid: who.uid, name: who.name },
      footer: aiLine ? 'WRITTEN THIS SECOND.' : 'PRE-WRITTEN. NO AI WAS INVOLVED IN THIS ONE.',
    });

    }),
  });

  commands.push({
    name: 'compliment',
    aliases: ['compliment2'],
    category: 'fun',
    description: '🪞 Compliment somebody. The compliment is real, the backhand is too',
    usage: '!compliment @user',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'compliment', async () => {
      await react('🪞');
      const who = await pick(reply, event.messageID, userDoc, args, event, 'compliment', api);
      if (!who) return;

      // Both names are resolved before anything is printed: the reply sits
      // directly above the card, and it used to say "Facebook User HUGGED
      // Facebook User" under two real faces.
      await faces(userDoc, who, api);

      const paid = await fee(userDoc, FEES.compliment, 'fun:compliment');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const aiLine = await aifun.genCompliment(who.name);
      const line = aiLine || aifun.pickFresh(BACKHANDED, 'compliment');
      f(userDoc).compliments += 1;
      await save(userDoc);

      await react('🙃');
      await reply(
        `🪞 **${userDoc.name} COMPLIMENTED ${who.name}**\n`
        + '· · · · · · ·\n'
        + `${line}\n\n`
        + `👛 Your wallet: ${kc(userDoc.coins)}\n`
        + '📖 _Mean it however you want._',
        event.messageID,
      );
    await art(reply, event.messageID, {
      title: '💐 COMPLIMENT',
      api,
      threadID: event.threadID,
      left: { uid: userDoc.uid, name: userDoc.name },
      right: { uid: who.uid, name: who.name },
      footer: 'MEAN IT HOWEVER YOU WANT.',
    });

    }),
  });

  commands.push({
    name: 'expose',
    aliases: ['expose2'],
    category: 'fun',
    description: '🕵️ Expose somebody — every number on their record, none of it flattering',
    usage: '!expose @user',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'expose', async () => {
      await react('🕵️');
      const who = await pick(reply, event.messageID, userDoc, args, event, 'expose', api);
      if (!who) return;

      // Both names are resolved before anything is printed: the reply sits
      // directly above the card, and it used to say "Facebook User HUGGED
      // Facebook User" under two real faces.
      await faces(userDoc, who, api);

      const paid = await fee(userDoc, FEES.expose, 'fun:expose');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const t = f(who);
      const pet = await petOf(who);
      const couple = who.spouse ? await User.findOne({ uid: String(who.spouse) }) : null;
      const exposure = couple
        ? `They are married to ${couple.name}. That is public record now.`
        : 'They are not married to anyone, which explains a lot about this chat.';

      await react('📂');
      await reply(
        `🕵️ **EXPOSED: ${who.name}**\n`
        + '· · · · · · ·\n'
        + `💀 Kills: ${num(t.kills)} · Stabs: ${num(t.stabs)} · Slaps dealt: ${num(t.slaps)}\n`
        + `🔥 Roasts: ${num(t.roasts)} · Dares failed: ${num(t.daresFailed)}\n`
        + `🤗 Hugs received: ${num(t.giftsIn)} · Given: ${num(t.giftsOut)}\n`
        + `💸 Spent on this module: ${num(t.giftsOut + t.daresFailed * 500)}\n`
        + `🐾 Pet: ${pet ? `${pet.emoji || '🐾'} ${pet.name} (${num(petPower(pet))} pwr)` : 'none. Suspicious.'}\n`
        + `💍 ${exposure}\n`
        + `👛 Their wallet: ${kc(who.coins)}\n`
        + '📖 _All of this is from their own command history. Nothing here is invented._',
        event.messageID,
      );
    await art(reply, event.messageID, {
      title: '🔍 EXPOSE',
      api,
      threadID: event.threadID,
      left: { uid: userDoc.uid, name: userDoc.name },
      right: { uid: who.uid, name: who.name },
      footer: 'BUILT FROM THEIR OWN COMMAND HISTORY. NOTHING IS INVENTED.',
    });

    }),
  });

// ───────────────────────────────────────────────────────────
// RELATIONSHIPS — the two expensive commands in the module
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'marry',
    aliases: ['marry2'],
    category: 'fun',
    description: '💍 Marry somebody. 5,000 up front, and they have to already be yours',
    usage: '!marry @user',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'marry', async () => {
      await react('💍');
      const who = await pick(reply, event.messageID, userDoc, args, event, 'marry', api);
      if (!who) return;

      // Both names are resolved before anything is printed: the reply sits
      // directly above the card, and it used to say "Facebook User HUGGED
      // Facebook User" under two real faces.
      await faces(userDoc, who, api);

      const t = f(userDoc);

      // Re-marriage: 5,000 to change your mind, because getting out should cost
      // more than getting in. That is the only way the divorce command has any
      // teeth at all.
      if (userDoc.spouse) {
        const current = await User.findOne({ uid: String(userDoc.spouse) }).catch(() => null);
        if (String(userDoc.spouse) === String(who.uid)) {
          await reply(`💍 You are already married to ${who.name}. Save up for the divorce.`, event.messageID);
          return;
        }
        // Checked before the 5,000, not after. Re-marrying onto somebody who is
        // already married would make the target's spouse field lie to two people.
        if (who.spouse) {
          const theirs = await User.findOne({ uid: String(who.spouse) }).catch(() => null);
          await reply(
            `💍 **${who.name} is already married** to ${(theirs && theirs.name) || 'somebody'}.\n`
            + `⏳ You were not charged.`,
            event.messageID,
          );
          return;
        }
        const paid = await fee(userDoc, 5000, 'fun:remarry');
        if (!paid.ok) {
          await reply(`${paid.reason}\n💍 Leaving somebody costs 5,000.`, event.messageID);
          return;
        }
        // The old spouse is released without being told, which is exactly the
        // kind of thing that makes this command funny and slightly awful.
        if (current) {
          current.spouse = '';
          current.marriedAt = null;
          await save(current);
        }
        userDoc.spouse = who.uid;
        userDoc.marriedAt = new Date();
        await save(userDoc);
        await reply(
          `💍 **DIVORCE. MARRIAGE. ALL IN ONE NIGHT.**\n`
          + '· · · · · · ·\n'
          + `💸 -5,000 to leave ${(current && current.name) || 'your old spouse'}\n`
          + `💑 ${userDoc.name} is now married to ${who.name}\n`
          + `👛 Your wallet: ${kc(userDoc.coins)}\n`
          + `📖 _${(current && current.name) || 'They'} was not asked._`,
          event.messageID,
        );
        return;
      }

      const paid = await fee(userDoc, 5000, 'fun:marry');
      if (!paid.ok) {
        await reply(`${paid.reason}\n💍 A wedding costs 5,000. \`!gtaheist\` is cheaper than a divorce.`, event.messageID);
        return;
      }

      // Married people cannot marry somebody else. Without this, one person
      // could chain-marriage the entire group.
      if (who.spouse) {
        const theirSpouse = await User.findOne({ uid: String(who.spouse) }).catch(() => null);
        await reply(
          `💍 **${who.name} is already married** to ${(theirSpouse && theirSpouse.name) || 'somebody'}.\n`
          + `⏳ You were not charged. Break up first, then come back.`,
          event.messageID,
        );
        return;
      }

      userDoc.spouse = who.uid;
      userDoc.marriedAt = new Date();
      who.spouse = userDoc.uid;
      who.marriedAt = userDoc.marriedAt;
      t.shipped += 1;
      await save(userDoc);
      await save(who);

      const group = await groupOf(event);
      if (group) {
        await score(group, 'ships', userDoc.uid, who.uid, 50, userDoc.uid);
      }

      await react('🎊');
      const art = await card({
        title: '💍 MARRIED',
        api,
        threadID: event.threadID,
        left: { uid: userDoc.uid, name: userDoc.name },
        right: { uid: who.uid, name: who.name },
        body: 'This is binding under group chat law. The divorce costs double.',
        footer: `${OWNER} · 5,000 SPENT`,
        accent: canvasKit.theme.accent2,
      });
      if (art) await reply({ attachment: { type: 'image', data: { url: art } } }, event.messageID);
      await reply(
        `💍 **${userDoc.name} MARRIED ${who.name}**\n`
        + '· · · · · · ·\n'
        + `💸 -5,000\n`
        + `💑 Both sides now point at each other.\n`
        + `👛 Your wallet: ${kc(userDoc.coins)}\n`
        + `📖 _A field called spouse. It is not real, but it is permanent until one of you pays 10,000._`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'divorce',
    aliases: ['divorce2'],
    category: 'fun',
    description: '💔 Divorce somebody. 10,000, and you do not get to say why',
    usage: '!divorce @user',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'divorce', async () => {
      await react('💔');
      const who = await pick(reply, event.messageID, userDoc, args, event, 'divorce', api);
      if (!who) return;

      // Both names are resolved before anything is printed: the reply sits
      // directly above the card, and it used to say "Facebook User HUGGED
      // Facebook User" under two real faces.
      await faces(userDoc, who, api);

      if (!userDoc.spouse || String(userDoc.spouse) !== String(who.uid)) {
        await reply(`💔 You are not married to ${who.name}. Nothing to end.`, event.messageID);
        return;
      }

      // Charged BEFORE the marriage is cleared, so a bot crash halfway through
      // cannot leave somebody divorced for free.
      const paid = await fee(userDoc, 10000, 'fun:divorce');
      if (!paid.ok) {
        await reply(
          `${paid.reason}\n💔 The exit costs 10,000. That is what getting in costs 5,000 twice over.`,
          event.messageID,
        );
        return;
      }

      const years = userDoc.marriedAt
        ? Math.max(0, Math.floor((Date.now() - new Date(userDoc.marriedAt).getTime()) / 86400000))
        : 0;
      userDoc.spouse = '';
      userDoc.marriedAt = null;
      who.spouse = '';
      who.marriedAt = null;
      await save(userDoc);
      await save(who);

      await react('🗑️');
      await reply(
        `💔 **${userDoc.name} DIVORCED ${who.name}**\n`
        + '· · · · · · ·\n'
        + `💸 -10,000\n`
        + `📅 It lasted ${num(years)} day(s).\n`
        + `👛 Your wallet: ${kc(userDoc.coins)}\n`
        + `📖 _The bot does not record who was at fault. It is not that kind of bot._`,
        event.messageID,
      );
    await art(reply, event.messageID, {
      title: '💔 DIVORCE',
      api,
      threadID: event.threadID,
      left: { uid: userDoc.uid, name: userDoc.name },
      right: { uid: who.uid, name: who.name },
      footer: 'THE BOT DOES NOT RECORD WHO WAS AT FAULT.',
    });

    }),
  });

  commands.push({
    name: 'couple',
    aliases: ['couple2', 'couples'],
    category: 'fun',
    description: '💑 Everybody coupled up - the married ones and the ones this chat shipped',
    usage: '!couple',
    hint: 'Marriages are global. `!ship` pairs are this chat\'s. Both show here.',
    cooldown: 15,
    permission: 'all',
    execute: async ({ api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'couple', async () => {
      await react('💑');
      if (!mongo.isReady()) {
        await reply('💑 The marriage registry is asleep. No records. Ever.', event.messageID);
        return;
      }

      // ── married, from the User documents ────────────────────────────
      let married = [];
      try {
        // Only half of each couple is stored twice, so matching both directions
        // and then de-duplicating on the lower uid halves the list.
        married = (await User.find({ spouse: { $nin: ['', null] } }).sort({ marriedAt: -1 }).limit(60)) || [];
      } catch {
        await reply('💑 The registry refused to open.', event.messageID);
        return;
      }

      // ── shipped, from this chat's group document ────────────────────
      //
      // `!ship` writes here and `!marry` writes here too, and until now nothing
      // read it: a chat full of shipped couples answered "Nobody is married",
      // which is true of the registry and a lie about the chat. The subtitle
      // used to promise "every married couple in this chat" and the registry
      // holds marriages from every chat the bot is in.
      const group = await groupOf(event);
      const ships = group && Array.isArray(group.fun.ships) ? group.fun.ships : [];

      // ── one query for every name on the board ───────────────────────
      //
      // This used to be a findOne per spouse and then another per name inside
      // nameOf, so a chat with sixty couples spent 180 round trips to print
      // sixty lines. Every uid the board can print is fetched at once.
      const wanted = new Set();
      for (const d of married) {
        wanted.add(String(d.uid));
        if (d.spouse) wanted.add(String(d.spouse));
      }
      for (const r of ships) { wanted.add(String(r.a)); wanted.add(String(r.b)); }
      const docs = wanted.size
        ? (await User.find({ uid: { $in: [...wanted] } }).select('uid name spouse marriedAt').lean()
          .catch(() => [])) || []
        : [];
      const exists = (uid) => docs.some((u) => u.uid === String(uid));

      // ── rows ────────────────────────────────────────────────────────
      const seen = new Set();
      const wedded = [];
      for (const d of married) {
        const partner = String(d.spouse || '');
        // A spouse who never signed up, or a uid that no longer resolves, is
        // not a couple — printing half of one is worse than printing neither.
        if (!partner || !exists(partner)) continue;
        const key = [String(d.uid), partner].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const days = d.marriedAt
          ? Math.max(0, Math.floor((Date.now() - new Date(d.marriedAt).getTime()) / 86400000))
          : 0;
        wedded.push({ a: String(d.uid), b: partner, days, married: true, score: days });
      }

      // A pair that is married and shipped is one row, not two. Married wins,
      // because it is the one with a date on it.
      //
      // Both uids stay even when the profile behind one is gone: the group
      // document is the record of the ship, and dropping the row would quietly
      // delete somebody's score because their account was deleted.
      const shipped = ships
        .map((r) => ({
          a: String(r.a || ''), b: String(r.b || ''), score: clamp(r.score), married: false, days: 0,
        }))
        .filter((r) => r.a && r.b && r.a !== r.b && !seen.has([r.a, r.b].sort().join('|')))
        .sort((x, y) => y.score - x.score);

      const rows = [...wedded, ...shipped];
      if (!rows.length) {
        await reply(
          '💑 **NOBODY IS COUPLED UP.**\n'
          + '· · · · · · ·\n'
          + '10,000 a divorce and still zero couples. Impressive.\n'
          + `💘 \`!marry @user\` or \`!ship @a @b\` fixes that.`,
          event.messageID,
        );
        return;
      }

      // Names resolved once per uid, so a couple appearing on both sides of two
      // rows is looked up once.
      const names = new Map();
      const nameFor = async (uid) => {
        if (!names.has(uid)) names.set(uid, await nameOf(uid, api));
        return names.get(uid);
      };

      // Both partners' real photos, with real Facebook names.
      const card = await cards.pairCard({
        emoji: '💑',
        title: 'THE COUPLES',
        subtitle: group
          ? `${wedded.length} married · ${shipped.length} shipped in this chat`
          : `${wedded.length} married across the server`,
        pairs: rows,
        api,
        value: (p) => (p.married
          ? (p.days > 0 ? `${num(p.days)} day(s)` : 'today')
          : `${num(p.score)} 💘`),
        limit: 10,
      });

      // The asker's own row, named the same way on both paths. This read the
      // raw stored name before, so the text fallback could answer "you are
      // married to Facebook User" — the placeholder ws3-fca invents.
      const mine = userDoc.spouse
        ? `💖 You are married to ${await nameFor(String(userDoc.spouse))}.`
        : '💔 You are single. 5,000 fixes that.';

      if (card) {
        await reply({
          body: `💑 **THE COUPLES (${rows.length})**\n${mine}`,
          attachment: { type: 'image', data: { url: card } },
        }, event.messageID);
        return;
      }

      const lines = await Promise.all(rows.slice(0, 15).map(async (p) => {
        const [an, bn] = await Promise.all([nameFor(p.a), nameFor(p.b)]);
        const tail = p.married
          ? (p.days > 0 ? `${num(p.days)} day(s)` : 'married today')
          : `${num(p.score)} ship pts`;
        return `${p.married ? '💍' : '💘'} **${an}** ${p.married ? '+' : 'x'} **${bn}** — ${tail}`;
      }));

      await reply(
        `💑 **THE COUPLES (${rows.length})**\n`
        + '· · · · · · ·\n'
        + `${lines.join('\n')}\n`
        + (rows.length > 15 ? `…and ${rows.length - 15} more.\n` : '')
        + (shipped.length
          ? `\n💘 ${shipped.length} of those ${shipped.length === 1 ? 'is a' : 'are'} \`!ship\` pair${shipped.length === 1 ? '' : 's'} from this chat.\n`
          : '')
        + `\n${mine}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'pair',
    aliases: ['pairup', 'matchmake', 'shipme', 'pairme', 'pair2'],
    category: 'fun',
    description: '💘 Let the bot pair two people in this chat — it picks, you find out',
    usage: '!pair',
    hint: 'Needs a group with two members other than the bot. The pair it makes is a real `!ship`, so `!couple` shows it.',
    cooldown: 20,
    permission: 'all',
    execute: async ({ api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'pair', async () => {
      await react('💘');

      const group = await groupOf(event);
      if (!group) {
        await reply('💘 Pairing needs a group chat and a database. This is neither.', event.messageID);
        return;
      }

      // The roster comes from getThreadInfo, the one endpoint this build of
      // ws3-fca actually implements — getThreadMembers and getParticipantInfo are
      // not on the client, which is where "!gcmembers says 0 members" came from.
      const info = await userTarget.threadInfo({ threadID: event.threadID }, api).catch(() => null);
      const everyone = [
        ...new Set([...((info && info.participantIDs) || [])].map(String).filter(Boolean)),
      ];

      // The bot is not eligible to be paired with itself, and neither is a DM.
      const exempt = new Set(await gcs.exemptIds(api, event.threadID));
      const pool = everyone.filter((uid) => !exempt.has(uid));

      if (pool.length < 2) {
        await reply(
          `💘 **NOBODY TO PAIR.**\n`
          + '· · · · · · ·\n'
          + `This chat has ${pool.length} member${pool.length === 1 ? '' : 's'} other than the bot, and pairing needs two.\n`
          + 'Get more people in here, or tag them yourself with `!ship @a @b`.',
          event.messageID,
        );
        return;
      }

      // A real ship, not a throwaway: it goes into this chat's scoreboard, so the
      // pair it makes is one `!ship` later adds to and `!couple` will show.
      const shuffled = pool.slice();
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = rand(0, i);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const [aUid, bUid] = shuffled;

      // Both faces, both names — the same resolution every other social command
      // does, so the card and the reply agree.
      const docs = await User.find({ uid: { $in: [aUid, bUid] } }).select('uid name').lean().catch(() => []);
      const docFor = (uid) => docs.find((d) => String(d.uid) === uid) || { uid, name: '' };
      const a = docFor(aUid);
      const b = docFor(bUid);
      await faces(a, b, api);

      const added = rand(20, 60);
      const scored = await score(group, 'ships', aUid, bUid, added, userDoc.uid);
      f(userDoc).shipped += 1;
      await save(userDoc);

      // If either of them is already married, say so rather than announcing it as
      // a surprise. The pairing still happens — the scoreboard is this chat's,
      // and a married pair being shipped is half the point of the command.
      const married = [];
      for (const d of [a, b]) {
        if (!d.spouse) continue;
        // eslint-disable-next-line no-await-in-loop
        const partner = await User.findOne({ uid: String(d.spouse) }).catch(() => null);
        married.push(`${d.name} is already married to ${partner ? partner.name : 'somebody'}`);
      }

      await react('💞');
      await reply(
        `💘 **THE BOT HAS SPOKEN**\n`
        + '· · · · · · ·\n'
        + `**${a.name}** + **${b.name}**\n`
        + `💘 Ship score: ${num(scored.score)}${scored.score > added ? ` (+${num(added)})` : ''}\n`
        + (married.length ? `⚠️ ${married.join(' · ')}\n` : '')
        + (userDoc.uid === aUid || userDoc.uid === bUid
          ? '📖 _You are in this one. The bot does not take requests._\n'
          : '📖 _Two strangers to each other five seconds ago._'),
        event.messageID,
      );

      await art(reply, event.messageID, {
        title: '💘 THE BOT HAS SPOKEN',
        subtitle: `${a.name} + ${b.name}`,
        api,
        threadID: event.threadID,
        left: { uid: a.uid, name: a.name },
        right: { uid: b.uid, name: b.name },
        body: `Ship score ${num(scored.score)}. It counts now, same as any other pair in here.`,
        footer: 'PAIRED BY THE BOT · NOT BY EITHER OF THEM',
        accent: canvasKit.theme.accent2,
      });
    }),
  });

  commands.push({
    name: 'besties',
    aliases: ['besties2', 'bff'],
    category: 'fun',
    description: '🫂 Build or read a best-friends board. Score never goes down',
    usage: '!besties @user',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'besties', async () => {
      await react('🫂');
      const group = await groupOf(event);
      if (!group) {
        await reply('🫂 Besties are per-chat. Needs a group and a database.', event.messageID);
        return;
      }

      if (!args[0]) {
        const ranked = [...group.fun.besties]
          .sort((x, y) => clamp(y.score) - clamp(x.score))
          .slice(0, 10);

        // Real photos of both people in each pair, drawn on canvas.
        const card = await cards.pairCard({
          emoji: '🫂',
          title: 'BEST FRIENDS',
          subtitle: 'Scores only go up. It is not a fair system.',
          pairs: ranked.map((r) => ({ a: r.a, b: r.b, score: r.score })),
          api,
          value: (p) => `${num(p.score)} BFF pts`,
        });
        if (card) {
          await reply({
            body: `🫂 **BEST FRIENDS**\nAdd with \`!besties @user\``,
            attachment: { type: 'image', data: { url: card } },
          }, event.messageID);
          return;
        }

        const rows = [];
        for (const r of ranked) {
          const [an, bn] = await Promise.all([nameOf(r.a, api), nameOf(r.b, api)]);
          rows.push(`🫂 **${an} + ${bn}** — ${num(r.score)}`);
        }
        await reply(
          `🫂 **BEST FRIENDS**\n━━━━━━━━━━━━━━━\n`
          + `${rows.length ? rows.join('\n') : 'Nobody is on the board. Tag somebody.'}\n\n`
          + `Add with \`!besties @user\``,
          event.messageID,
        );
        return;
      }

      const who = await pick(reply, event.messageID, userDoc, args, event, 'besties', api);
      if (!who) return;
      const paid = await fee(userDoc, FEES.besties, 'fun:besties');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const added = rand(10, 30);
      const scored = await score(group, 'besties', userDoc.uid, who.uid, added, userDoc.uid);
      await react('✨');
      await reply(
        `🫂 **${userDoc.name} + ${who.name}: BESTIES**\n`
        + '· · · · · · ·\n'
        + `${meter(Math.min(100, scored.score), '🫂 BFF SCORE')}\n`
        + `➕ +${added}\n`
        + `📈 Total: ${num(scored.score)}\n`
        + '📖 _Best friend scores only go up. It is not a fair system._',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'enemies',
    aliases: ['enemies2', 'nemesis'],
    category: 'fun',
    description: '⚔️ Build or read an enemies board. Score never goes down either',
    usage: '!enemies @user',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'enemies', async () => {
      await react('⚔️');
      const group = await groupOf(event);
      if (!group) {
        await reply('⚔️ Enemies are per-chat. Needs a group and a database.', event.messageID);
        return;
      }

      if (!args[0]) {
        const ranked = [...group.fun.enemies]
          .sort((x, y) => clamp(y.score) - clamp(x.score))
          .slice(0, 10);

        const card = await cards.pairCard({
          emoji: '⚔️',
          title: 'ENEMIES',
          subtitle: 'Scores only go up either. Grudges forever.',
          pairs: ranked.map((r) => ({ a: r.a, b: r.b, score: r.score })),
          api,
          value: (p) => `${num(p.score)} beef`,
        });
        if (card) {
          await reply({
            body: `⚔️ **ENEMIES**\nAdd with \`!enemies @user\``,
            attachment: { type: 'image', data: { url: card } },
          }, event.messageID);
          return;
        }

        const rows = [];
        for (const r of ranked) {
          const [an, bn] = await Promise.all([nameOf(r.a, api), nameOf(r.b, api)]);
          rows.push(`⚔️ **${an} vs ${bn}** — ${num(r.score)}`);
        }
        await reply(
          `⚔️ **ENEMIES**\n━━━━━━━━━━━━━━━\n`
          + `${rows.length ? rows.join('\n') : 'No enemies yet. Everyone is getting along, which is suspicious.'}\n\n`
          + `Add with \`!enemies @user\``,
          event.messageID,
        );
        return;
      }

      const who = await pick(reply, event.messageID, userDoc, args, event, 'enemies', api);
      if (!who) return;
      const paid = await fee(userDoc, FEES.enemies, 'fun:enemies');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const added = rand(10, 30);
      const scored = await score(group, 'enemies', userDoc.uid, who.uid, added, userDoc.uid);
      await react('🔥');
      await reply(
        `⚔️ **${userDoc.name} vs ${who.name}: ENEMIES**\n`
        + '· · · · · · ·\n'
        + `${meter(Math.min(100, scored.score), '⚔️ RIVALRY')}\n`
        + `➕ +${added}\n`
        + `📈 Total: ${num(scored.score)}\n`
        + '📖 _There is no un-rival command._',
        event.messageID,
      );
    }),
  });

// ───────────────────────────────────────────────────────────
// METERS
//
// All seven read the same record and differ only in what they weigh. None of
// them invent a number: every figure is derived from counters and balances that
// already exist, so a meter can be wrong but it cannot be a lie.
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'toxicmeter',
    aliases: ['toxic'],
    category: 'fun',
    description: '☣️ Toxicity read straight off the activity tracker. Commands run is the proxy',
    usage: '!toxicmeter @user',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'toxicmeter', async () => {
      await react('☣️');
      const who = args[0] ? await pick(reply, event.messageID, userDoc, args, event, 'toxicmeter', api) : userDoc;
      if (!who) {
        // No target resolved. A command that answers nothing reads as broken,
        // so say why instead of returning in silence.
        await reply('⚠️ I could not work out who this is for. Tag somebody, or run it again in a moment.', event.messageID);
        return;
      }

      const gc = who.gc || {};
      const msgs = clamp(gc.msgs);
      const tox = clamp(gc.toxicity);
      const fines = clamp(gc.fines);
      // toxicity is commands run and msgs is messages, so the ratio is roughly
      // "how much of their chat is aimed at the bot".
      const perMsg = msgs > 0 ? Math.round((tox / msgs) * 100) : 0;
      const level = perMsg > 60 ? '☣️ TOXIC' : perMsg > 30 ? '🟠 SPICY' : perMsg > 10 ? '🟡 A BIT MUCH' : '🟢 MOSTLY FINE';
      const pet = await petOf(who);

      await reply(
        `☣️ **${who.name} — TOXICITY**\n`
        + '· · · · · · ·\n'
        + `${meter(perMsg, level)}\n`
        + `💬 Group messages tracked: ${num(msgs)}\n`
        + `⌨️ Commands run: ${num(tox)}\n`
        + `💸 Fines: ${num(fines)}\n`
        + `🐾 Pet contribution: ${pet ? `${pet.emoji || '🐾'} ${pet.name} makes it worse` : 'no pet to blame'}\n`
        + '📖 _Read from the activity tracker. Nothing here is generated._',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'simpmeter',
    aliases: ['simp'],
    category: 'fun',
    description: '🥀 Simp meter — derived from how much you give away versus what you run',
    usage: '!simpmeter @user',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'simpmeter', async () => {
      await react('🥀');
      const who = args[0] ? await pick(reply, event.messageID, userDoc, args, event, 'simpmeter', api) : userDoc;
      if (!who) {
        // No target resolved. A command that answers nothing reads as broken,
        // so say why instead of returning in silence.
        await reply('⚠️ I could not work out who this is for. Tag somebody, or run it again in a moment.', event.messageID);
        return;
      }

      const t = f(who);
      // Gifts out versus gifts in: handing over coins to other people is the
      // only behaviour here that genuinely resembles simping.
      const out = clamp(t.giftsOut);
      const incoming = clamp(t.giftsIn);
      const pet = await petOf(who);
      // Holding a weak pet while giving coins away pushes it up.
      const petPity = pet && petPower(pet) < 200 ? 15 : 0;
      const scorePct = Math.max(0, Math.min(100, Math.round(out * 1.2 + petPity - incoming * 0.5)));
      const verdict = scorePct > 75 ? 'CERTIFIED SIMP' : scorePct > 45 ? 'SOFT SIMP' : scorePct > 20 ? 'MIGHT BE A SIMP' : 'NOT A SIMP';

      await reply(
        `🥀 **${who.name} — SIMP METER**\n`
        + '· · · · · · ·\n'
        + `${meter(scorePct, verdict)}\n`
        + `💸 Given away: ${num(out)} coins of affection\n`
        + `🎁 Received: ${num(incoming)}\n`
        + `🐾 ${pet ? `${pet.emoji || '🐾'} ${pet.name} (${num(petPower(pet))} pwr)${petPity ? ` — weak pet, +${petPity} simp` : ''}` : 'no pet, no excuses'}\n`
        + '📖 _Derived from actual transfers. You can be audited._',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'susmeter',
    aliases: ['sus'],
    category: 'fun',
    description: '🕵️ SUS meter — kills, stabs and slaps do not look innocent',
    usage: '!susmeter @user',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'susmeter', async () => {
      await react('🕵️');
      const who = args[0] ? await pick(reply, event.messageID, userDoc, args, event, 'susmeter', api) : userDoc;
      if (!who) {
        // No target resolved. A command that answers nothing reads as broken,
        // so say why instead of returning in silence.
        await reply('⚠️ I could not work out who this is for. Tag somebody, or run it again in a moment.', event.messageID);
        return;
      }

      const t = f(who);
      const violent = clamp(t.kills) * 12 + clamp(t.stabs) * 9 + clamp(t.slaps) * 4;
      const pet = await petOf(who);
      const unsafe = pet && pet.isSafe === false ? 20 : 0;
      const scorePct = Math.max(0, Math.min(100, violent + unsafe));
      const verdict = scorePct > 70 ? 'EXTREMELY SUS' : scorePct > 40 ? 'SOMEWHAT SUS' : scorePct > 15 ? 'A LITTLE SUS' : 'CLEAR';

      await reply(
        `🕵️ **${who.name} — SUS METER**\n`
        + '· · · · · · ·\n'
        + `${meter(scorePct, verdict)}\n`
        + `💀 Fake kills: ${num(t.kills)} (+${clamp(t.kills) * 12})\n`
        + `🔪 Stabs: ${num(t.stabs)} (+${clamp(t.stabs) * 9})\n`
        + `👋 Slaps: ${num(t.slaps)} (+${clamp(t.slaps) * 4})\n`
        + `🐾 Unsafe pet: ${unsafe ? '+20' : 'none'}\n`
        + `👛 Wallet: ${kc(who.coins)}\n`
        + '📖 _Every point is a counter on their own account. All of the violence was a message._',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'rizz',
    category: 'fun',
    description: '😏 Rizz score — presence, gifts and whether you actually have a pet',
    usage: '!rizz @user',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'rizz', async () => {
      await react('😏');
      const who = args[0] ? await pick(reply, event.messageID, userDoc, args, event, 'rizz', api) : userDoc;
      if (!who) {
        // No target resolved. A command that answers nothing reads as broken,
        // so say why instead of returning in silence.
        await reply('⚠️ I could not work out who this is for. Tag somebody, or run it again in a moment.', event.messageID);
        return;
      }

      const t = f(who);
      const pet = await petOf(who);
      const petPowerN = petPower(pet);
      // Gifting adds presence, hugs and kisses add warmth, a real pet adds the
      // single biggest chunk. Coins alone do very little, which is on purpose.
      const scorePct = Math.max(0, Math.min(100, Math.round(
        clamp(t.giftsOut) * 1.5 + clamp(t.hugs) * 2 + clamp(t.kisses) * 2 + clamp(t.compliments) + petPowerN * 0.05,
      )));
      const line = pick1(RIZZ_LINES);
      const verdict = scorePct > 80 ? 'CERTIFIED RIZZ' : scorePct > 55 ? 'HAS SOME RIZZ' : scorePct > 30 ? 'TRYING' : 'NO RIZZ DETECTED';

      await reply(
        `😏 **${who.name} — RIZZ**\n`
        + '· · · · · · ·\n'
        + `${meter(scorePct, verdict)}\n`
        + `🐾 ${pet ? `${pet.emoji || '🐾'} ${pet.name} — ${num(petPowerN)} pwr` : 'no pet. that is most of the problem.'}\n`
        + `💸 Gifts sent: ${num(t.giftsOut)} · 🤗 Hugs: ${num(t.hugs)} · 💋 Kisses: ${num(t.kisses)}\n\n`
        + `💬 *"${line}"*\n`
        + '📖 _Coins barely count. Charisma is not purchasable in this module._',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'cringe',
    category: 'fun',
    description: '😬 Cringe meter — net worth against how much you have spent on being funny',
    usage: '!cringe @user',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'cringe', async () => {
      await react('😬');
      const who = args[0] ? await pick(reply, event.messageID, userDoc, args, event, 'cringe', api) : userDoc;
      if (!who) {
        // No target resolved. A command that answers nothing reads as broken,
        // so say why instead of returning in silence.
        await reply('⚠️ I could not work out who this is for. Tag somebody, or run it again in a moment.', event.messageID);
        return;
      }

      const t = f(who);
      const attempts = clamp(t.roasts) + clamp(t.compliments) + clamp(t.flexes) + clamp(t.kills) + clamp(t.yeets);
      // Cringe is volume of public attempts against what it has actually earned.
      // Spending money on attention with an empty wallet is the worst case.
      const broke = clamp(who.coins) < 1000 ? 30 : 0;
      const scorePct = Math.max(0, Math.min(100, attempts * 5 + broke));
      const verdict = scorePct > 70 ? 'PHYSICALLY PAINFUL' : scorePct > 45 ? 'VERY CRINGE' : scorePct > 20 ? 'A LITTLE CRINGE' : 'BARELY CRINGE';

      await reply(
        `😬 **${who.name} — CRINGE METER**\n`
        + '· · · · · · ·\n'
        + `${meter(scorePct, verdict)}\n`
        + `🎭 Public attempts: ${num(attempts)}\n`
        + `🔥 Roasts ${num(t.roasts)} · 🪞 Compliments ${num(t.compliments)} · 💪 Flexes ${num(t.flexes)} · 💀 Kills ${num(t.kills)} · 🚀 Yeets ${num(t.yeets)}\n`
        + `👛 Wallet: ${kc(who.coins)}${broke ? ' — broke, which is +30' : ''}\n`
        + '📖 _Counted, not judged. The number is real even if the verdict is not._',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'auramax',
    aliases: ['aura', 'auraa'],
    category: 'fun',
    description: '⚡ Aura, from -1000 to +1000. Coins and pet power pull in both directions',
    usage: '!auramax @user',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'auramax', async () => {
      await react('⚡');
      const who = args[0] ? await pick(reply, event.messageID, userDoc, args, event, 'auramax', api) : userDoc;
      if (!who) {
        // No target resolved. A command that answers nothing reads as broken,
        // so say why instead of returning in silence.
        await reply('⚠️ I could not work out who this is for. Tag somebody, or run it again in a moment.', event.messageID);
        return;
      }

      const t = f(who);
      const pet = await petOf(who);
      const petPowerN = petPower(pet);
      // Wealth is the biggest pull and it can drag you DOWN: a rich person with
      // nothing else going on reads as try-hard, which is the joke.
      const wealth = Math.round(clamp(who.coins) / 1000);
      const social = clamp(t.hugs) * 3 + clamp(t.kisses) * 3 + clamp(t.compliments) * 2 - clamp(t.slaps) * 2 - clamp(t.kills) * 2;
      const raw = Math.round(petPowerN * 0.1 + wealth * 0.5 + social);
      const aura = Math.max(-1000, Math.min(1000, raw));
      // The bar is a -1000..1000 scale, so zero sits in the middle at 50%. That
      // is exactly what NEUTRAL means, and it must not be labelled as a failing
      // state the way a negative aura is.
      const title = aura > 600 ? 'MAIN CHARACTER ENERGY' : aura > 300 ? 'POSITIVE AURA' : aura > 0 ? 'STEADY' : aura === 0 ? 'NEUTRAL AURA' : aura > -300 ? 'SHAKY' : aura > -600 ? 'NEGATIVE AURA' : 'AURA EMERGENCY';

      const art = await card({
        title: '⚡ AURA',
        api,
        threadID: event.threadID,
        left: { uid: who.uid, name: who.name },
        body: meter(Math.round((aura + 1000) / 20), `${aura > 0 ? '+' : ''}${num(aura)} · ${title}`),
        footer: aura >= 0 ? 'COINS. PETS. BEING LIKED.' : 'TOO MUCH SLAPPING. TOO LITTLE RESPECT.',
        accent: aura >= 0 ? canvasKit.theme.accent : canvasKit.theme.accent2,
      });
      if (art) await reply({ attachment: { type: 'image', data: { url: art } } }, event.messageID);

      await reply(
        `⚡ **${who.name} — AURA ${aura > 0 ? '+' : ''}${num(aura)} / 1000**\n`
        + '· · · · · · ·\n'
        + `${meter(Math.round((aura + 1000) / 20), title)}\n`
        + `💰 Wallet: ${kc(who.coins)} (${wealth > 0 ? '+' : ''}${num(wealth)})\n`
        + `🐾 Pet power: ${num(petPowerN)} (${petPowerN > 0 ? '+' : ''}${num(Math.round(petPowerN * 0.1))})\n`
        + `🤗 Social: ${social > 0 ? '+' : ''}${num(social)}\n`
        + '📖 _Every term is a counter or a balance. You can check the maths._',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'flex',
    aliases: ['flex2'],
    category: 'fun',
    description: '💪 Flex your wallet and your pet. Costs 100, because showing off should',
    usage: '!flex',
    cooldown: 15,
    permission: 'all',
    execute: async ({ api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'flex', async () => {
      await react('💪');
      const paid = await fee(userDoc, FEES.flex, 'fun:flex');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const t = f(userDoc);
      const pet = await petOf(userDoc);

      // Rank against the whole collection. The query sorts in the database
      // rather than pulling every user into memory and sorting in JS.
      let rank = null;
      if (mongo.isReady()) {
        try {
          rank = (await User.countDocuments({ coins: { $gt: clamp(userDoc.coins) } })) + 1;
        } catch {
          rank = null;
        }
      }

      f(userDoc).flexes += 1;
      await save(userDoc);

      const brags = [];
      if (clamp(userDoc.coins) >= 1000000) brags.push('six figures. casually.');
      else if (clamp(userDoc.coins) >= 100000) brags.push('five figures and not raising them.');
      else if (clamp(userDoc.coins) < 1000) brags.push('flexing on fumes, which takes a kind of confidence.');
      if (pet && petPower(pet) >= 600) brags.push(`${pet.name} is doing most of the work here.`);
      else if (pet && petPower(pet) < 200) brags.push(`${pet.name} is watching from a safe distance.`);
      if (!pet) brags.push('no pet, all you.');

      await react('📢');
      const art = await card({
        title: '💪 FLEX',
        api,
        threadID: event.threadID,
        left: { uid: userDoc.uid, name: userDoc.name },
        body: `${kc(userDoc.coins)}\n${pet ? `${pet.emoji || '🐾'} ${pet.name} — ${num(petPower(pet))} pwr` : 'No pet'}\n${rank ? `Rank #${num(rank)}` : 'Rank unavailable'}`,
        footer: `-${kc(FEES.flex)} TO POST THIS`,
        accent: canvasKit.theme.gold,
      });
      if (art) await reply({ attachment: { type: 'image', data: { url: art } } }, event.messageID);
      await reply(
        `💪 **${userDoc.name} IS FLEXING**\n`
        + '· · · · · · ·\n'
        + `👛 ${kc(userDoc.coins)}${rank ? ` · rank #${num(rank)}` : ''}\n`
        + `🐾 ${pet ? `${pet.emoji || '🐾'} ${pet.name} — ${num(petPower(pet))} pwr` : 'no pet'}\n`
        + `💸 -${kc(FEES.flex)} to post this\n\n`
        + `${brags.map((b) => `• ${b}`).join('\n')}\n\n`
        + '📖 _Your real balance and your real pet. The flex is the only fiction._',
        event.messageID,
      );
    }),
  });

// ───────────────────────────────────────────────────────────
// PARTY GAMES AND THE LAST WORD
//
// Games are thread-scoped in cache with an empty uid, so two groups playing at
// the same time never see each other's board. Everything expires on its own in
// two minutes: an abandoned game must not outlive the conversation that started
// it, and nothing here bans anybody.
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'dare',
    aliases: ['dare2'],
    category: 'fun',
    description: '🎯 Dare somebody. They reply `!darego` to do it, `!gostop` to weasel and pay 500',
    usage: '!dare @user',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'dare', async () => {
      await react('🎯');

      // One command, three jobs. The spec allows exactly one dare command, so
      // the game has to resolve itself: no tag opens your current dare, and the
      // words done / no settle it. Otherwise a dare could be issued and never
      // closed, which is the worst way for a party game to end.
      const open = cache.getPendingGame('dare', event.threadID, String(userDoc.uid));
      const word = String(args[0] || '').toLowerCase();

      // done / no with nothing open is a real answer, not a missing tag. Without
      // this the word falls through to target resolution and tells the player
      // that a person called "done" does not exist here.
      if ((word === 'done' || word === 'no') && !open) {
        await reply(
          `🎯 You have no dare open, so there is nothing to ${word === 'done' ? 'do' : 'fail'}.\n`
          + '😈 `!dare @you` to start one.',
          event.messageID,
        );
        return;
      }

      if (!args[0] && open) {
        await reply(
          `🎯 **YOU HAVE A DARE OPEN**\n`
          + '· · · · · · ·\n'
          + `😈 **${open.dare}**\n`
          + `🎯 ${open.by} dared you.\n`
          + `⏱️ ${Math.max(1, Math.ceil((open.expires - Date.now()) / 1000))}s left.\n\n`
          + `✅ \`!dare done\` when you have done it\n`
          + '💸 \`!dare no\` to chicken out for 500',
          event.messageID,
        );
        return;
      }

      if ((word === 'done' || word === 'no') && open) {
        if (word === 'done') {
          cache.takePendingGame('dare', event.threadID, String(userDoc.uid));
          f(userDoc).daresDone += 1;
          await save(userDoc);
          await reply(
            `✅ **DARE DONE.**\n`
            + '· · · · · · ·\n'
            + `😈 It was: *${open.dare}*\n`
            + `🎯 ${open.by} dared you and you did it.\n`
            + '📖 _Nobody checked. You are trusted, which is a mistake but an honest one._',
            event.messageID,
          );
          return;
        }

        const paid = await fee(userDoc, 500, 'fun:dare_fail');
        if (!paid.ok) {
          await reply(`${paid.reason}\n💸 Failing costs 500. Do the dare or save up.`, event.messageID);
          return;
        }
        // Cleared only after the payment lands, so a broke player keeps the dare
        // open instead of losing it for free.
        cache.takePendingGame('dare', event.threadID, String(userDoc.uid));
        f(userDoc).daresFailed += 1;
        await save(userDoc);
        await reply(
          `💸 **WEASELLED OUT.**\n`
          + '· · · · · · ·\n'
          + `😈 It was: *${open.dare}*\n`
          + `💸 -500 to ${open.by}\n`
          + `👛 Your wallet: ${kc(userDoc.coins)}\n`
          + '📖 _No ban. No timeout. Just 500 coins and a permanent record._',
          event.messageID,
        );
        return;
      }

      const who = await pick(reply, event.messageID, userDoc, args, event, 'dare', api);
      if (!who) return;

      const paid = await fee(userDoc, FEES.dare, 'fun:dare');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const dare = (await aifun.genDare()) || aifun.pickFresh(DARES, 'dare');
      // setPendingGame refuses to overwrite, so one person cannot be spammed
      // with dares while an old one is still open.
      const opened = cache.setPendingGame('dare', event.threadID, String(who.uid), {
        dare,
        by: userDoc.name,
        from: String(userDoc.uid),
      });
      if (!opened) {
        await reply(`🎯 ${who.name} already has a dare open. Finish that one first.`, event.messageID);
        return;
      }

      f(userDoc).dares += 1;
      await save(userDoc);

      await react('😈');
      await reply(
        `🎯 **${userDoc.name} DARES ${who.name}**\n`
        + '· · · · · · ·\n'
        + `😈 **${open_dare_line(dare)}**\n\n`
        + `⏱️ 2 minutes.\n`
        + `▶️ \`!dare done\` to do it, \`!dare no\` to weasel out for 500.\n`
        + '📖 _Nobody is ever forced to do anything. Weaseling costs coins and nothing else._',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'truth',
    aliases: ['truth2'],
    category: 'fun',
    description: '🫢 One truth question for the chat. Replying costs nothing and hides nothing',
    usage: '!truth',
    cooldown: 10,
    permission: 'all',
    execute: async ({ api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'truth', async () => {
      await react('🫢');
      const q = (await aifun.genTruth()) || aifun.pickFresh(TRUTHS, 'truth');

      // Thread-scoped with an empty uid, so the newest question replaces the old
      // one and two groups never collide.
      cache.putPendingGame('truth', event.threadID, '', { q, by: userDoc.name });
      await reply(
        `🫢 **TRUTH**\n`
        + '· · · · · · ·\n'
        + `❓ **${q}**\n\n`
        + `👤 ${userDoc.name} asked.\n`
        + '📖 _Answer in the chat. There is no enforcement and no punishment._',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'wouldyourather',
    aliases: ['wyr', 'wouldurather'],
    category: 'fun',
    description: '🤔 Two options, one answer. Votes are counted from cache and expire in 2 minutes',
    usage: '!wouldyourather',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'wouldyourather', async () => {
      await react('🤔');

      // Same self-resolving trick as dare: with only one command allowed,
      // the first call opens the vote and the second closes it. Otherwise a
      // would-you-rather could never report a result.
      const open = cache.getPendingGame('wyr', event.threadID, '');

      if (open && open.pair) {
        const votes = open.votes || {};
        let one = 0;
        let two = 0;
        for (const v of Object.values(votes)) {
          if (v === 1) one += 1;
          else if (v === 2) two += 1;
        }
        const total = one + two;
        cache.takePendingGame('wyr', event.threadID, '');
        if (!total) {
          await reply(
            `📊 **NOBODY VOTED.**\n`
            + '· · · · · · ·\n'
            + `1️⃣ ${open.pair[0]}\n`
            + `2️⃣ ${open.pair[1]}\n\n`
            + 'The chat has chosen nothing, loudly.',
            event.messageID,
          );
          return;
        }
        const winner = one === two ? null : one > two ? 1 : 2;
        const pct = Math.round((Math.max(one, two) / total) * 100);
        await reply(
          `📊 **THE CHAT HAS SPOKEN**\n`
          + '· · · · · · ·\n'
          + `1️⃣ ${open.pair[0]} — ${num(one)} vote(s)\n`
          + `2️⃣ ${open.pair[1]} — ${num(two)} vote(s)\n\n`
          + (winner === null
            ? `🤷 Dead heat. ${num(total)} vote(s), no winner, no decision.`
            : `${meter(pct, `OPTION ${winner} WINS WITH ${pct}%`)}\n🏆 **${open.pair[winner - 1]}**`)
          + `\n\n📖 _${num(total)} vote(s) counted. Nobody is named._`,
          event.messageID,
        );
        return;
      }

      const pair = (await aifun.genWyr()) || aifun.pickFresh(WYR, 'wyr');
      cache.putPendingGame('wyr', event.threadID, '', { pair, votes: {} });
      await reply(
        `🤔 **WOULD YOU RATHER**\n`
        + '· · · · · · ·\n'
        + `1️⃣ ${pair[0]}\n`
        + `2️⃣ ${pair[1]}\n\n`
        + `👤 ${userDoc.name} started it. 2 minutes. Neither option is safe.\n`
        + '▶️ Reply with just `1` or `2`, then run `!wouldyourather` again to close it.\n'
        + '📖 _The bot does not record who voted._',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'neverhaveiever',
    aliases: ['neverhave', 'nhi'],
    category: 'fun',
    description: '🍻 Never have I ever — the group answers with a number, 1 to 5',
    usage: '!neverhaveiever',
    cooldown: 10,
    permission: 'all',
    execute: async ({ api, args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'neverhaveiever', async () => {
      await react('🍻');

      // One command, so the tally has to live in the same command. With no args
      // it closes whatever is open; with any args it starts a custom item.
      const open = cache.getPendingGame('nhi', event.threadID, '');
      if (open && open.item && !args.length) {
        cache.takePendingGame('nhi', event.threadID, '');
        const answered = clamp(open.answered);
        await reply(
          `📊 **THE TALLY**\n`
          + '· · · · · · ·\n'
          + `❓ *${open.item}*\n`
          + `🙋 ${num(answered)} people said they were still here.\n\n`
          + `${answered === 0 ? 'The silence is the answer.' : 'And the chat continues regardless.'}\n`
          + '📖 _This bot does not collect or store who pressed what._',
          event.messageID,
        );
        return;
      }

      const item = args.length
        ? args.join(' ').trim()
        : ((await aifun.genNever()) || aifun.pickFresh(NEVER, 'never'));
      cache.putPendingGame('nhi', event.threadID, '', { item, by: userDoc.name, answered: 0 });
      await reply(
        `🍻 **NEVER HAVE I EVER**\n`
        + '· · · · · · ·\n'
        + `❓ Never have I ever **${item}**?\n\n`
        + `👤 ${userDoc.name} asked. 2 minutes.\n`
        + '📖 _Self-reporting only. There is no way to check anybody._',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: '2truth1lie',
    aliases: ['twotruthline', '2t1l'],
    category: 'fun',
    description: '🃏 Three statements, two true. The group works out the lie',
    usage: '!2truth1lie',
    cooldown: 10,
    permission: 'all',
    execute: async ({ api, event, userDoc, reply, react }) => guard(reply, event.messageID, '2truth1lie', async () => {
      await react('🃏');
      // Built from the caller's OWN counters, so the two truths are true by
      // construction and only the third is fiction. It is a lie detector that
      // cannot lie.
      const t = f(userDoc);
      const truths = [
        `You have run ${num(t.roasts)} roast(s) in this chat.`,
        `You have hugged ${num(t.giftsOut)} times.`,
        `You have been killed ${num(t.kills)} time(s), all of them messages.`,
        `You are holding ${kc(userDoc.coins)}.`,
        `You have failed ${num(t.daresFailed)} dare(s).`,
        `You have cuddled ${num(t.cuddles)} time(s).`,
      ];
      const picked = [...truths].sort(() => Math.random() - 0.5).slice(0, 2);
      const lies = [
        'You have never been married in this bot. (Probably a lie.)',
        'You have never slapped anybody. (Nobody believes this.)',
        'You have never cuddled a pet in this chat.',
        'You have never flexed. (Deeply implausible.)',
        'You have never been bonked.',
      ];
      // The AI writes the lie from the player's own counters, so it sits
      // plausibly between two statements that are true by construction.
      // The hand-written list is the offline fallback.
      const stats = `roasts run: ${t.roasts}, hugs given: ${t.giftsOut}, kills: ${t.kills}, `
        + `coins held: ${userDoc.coins}, dares failed: ${t.daresFailed}, cuddles: ${t.cuddles}`;
      const line = (await aifun.genLie(stats)) || aifun.pickFresh(lies, 'lie');
      const order = [...picked, line].sort(() => Math.random() - 0.5);

      cache.putPendingGame('2t1l', event.threadID, '', { order, truths: picked, lie: line });
      await reply(
        `🃏 **TWO TRUTHS, ONE LIE**\n`
        + '· · · · · · ·\n'
        + `${order.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n`
        + `👤 ${userDoc.name}. Pick the lie.\n`
        + '📖 _The first two are read from your own record. Only one of the three is invented._',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'fact',
    aliases: ['fact2', 'toxicfact'],
    category: 'fun',
    description: '🧾 One true, unkind fact about somebody — assembled from their own counters',
    usage: '!fact @user',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'fact', async () => {
      await react('🧾');
      const who = args[0] ? await pick(reply, event.messageID, userDoc, args, event, 'fact', api) : userDoc;
      if (!who) {
        // No target resolved. A command that answers nothing reads as broken,
        // so say why instead of returning in silence.
        await reply('⚠️ I could not work out who this is for. Tag somebody, or run it again in a moment.', event.messageID);
        return;
      }

      const fact = pick1(FACT_TEMPLATES)(f(who));
      await reply(
        `🧾 **FACT ABOUT ${who.name.toUpperCase()}**\n`
        + '· · · · · · ·\n'
        + `${fact}\n\n`
        + `👛 Their wallet: ${kc(who.coins)}\n`
        + '📖 _True, in the sense that it is a number from their own account._',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'pickupline',
    aliases: ['pickupl', 'rizzline'],
    category: 'fun',
    description: '💘 A pickup line aimed at somebody. Costs 50, because embarrassment is a service',
    usage: '!pickupline @user',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'pickupline', async () => {
      await react('💘');
      const who = args[0] ? await pick(reply, event.messageID, userDoc, args, event, 'pickupline', api) : userDoc;
      if (!who) {
        // No target resolved. A command that answers nothing reads as broken,
        // so say why instead of returning in silence.
        await reply('⚠️ I could not work out who this is for. Tag somebody, or run it again in a moment.', event.messageID);
        return;
      }

      const paid = await fee(userDoc, FEES.pickupline || 50, 'fun:pickupline');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const aiLine = await aifun.genPickup();
      const line = aiLine || aifun.pickFresh(PICKUP_LINES, 'pickup');
      await reply(
        `💘 **${userDoc.name} → ${who.name}**\n`
        + '· · · · · · ·\n'
        + `"${line}"\n\n`
        + `👛 Your wallet: ${kc(userDoc.coins)}\n`
        + `📖 _${aiLine ? 'Written this second, just for them.' : 'Pre-written. There is no AI in this module.'}_`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'ikonfamily',
    aliases: ['ikonsystem3', 'thefamily'],
    category: 'fun',
    description: '👨‍👩‍👧‍👦 The iKON family tree — owner, god-mode winners, and where you sit in it',
    usage: '!ikonfamily',
    cooldown: 15,
    permission: 'all',
    execute: async ({ api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'ikonfamily', async () => {
      await react('👨‍👩‍👧‍👦');
      if (!mongo.isReady()) {
        await reply('👨‍👩‍👧‍👦 The family tree is asleep. Adopt a database.', event.messageID);
        return;
      }

      const group = await groupOf(event);
      let married = 0;
      let pets = 0;
      try {
        married = (await User.countDocuments({ spouse: { $nin: ['', null] } })) || 0;
        pets = (await User.countDocuments({})) || 0;
      } catch {
        married = 0;
        pets = 0;
      }

      const you = f(userDoc);
      const pet = await petOf(userDoc);
      // Where you sit: above the average wallet or below it. It is a rank, not
      // a compliment, and both halves are true.
      const rich = clamp(userDoc.coins) >= (married > 0 ? 50000 : 0);
      const seat = clamp(userDoc.coins) > 1000000
        ? 'Front row, aisle seat, holding the vault.'
        : clamp(userDoc.coins) > 100000
          ? 'Middle of the family photo. Comfortable.'
          : clamp(userDoc.coins) > 1000
            ? 'Back row. Visible, technically.'
            : 'Standing outside the door pretending to check a phone.';

      await react('📸');
      const art = await card({
        title: '👨‍👩‍👧‍👦 iKON FAMILY',
        api,
        threadID: event.threadID,
        left: { uid: userDoc.uid, name: userDoc.name },
        body: `${num(married / 2)} marriage(s) on file\n${num(pets)} member(s) in the database\n\nYou: ${seat}`,
        footer: pet ? `${pet.emoji || '🐾'} ${pet.name} IS ALSO HERE` : 'NO PET. THAT IS YOUR LEGACY.',
        accent: canvasKit.theme.accent2,
      });
      if (art) await reply({ attachment: { type: 'image', data: { url: art } } }, event.messageID);

      await reply(
        `👨‍👩‍👧‍👦 **THE iKON FAMILY**\n`
        + '· · · · · · ·\n'
        + `👑 **${OWNER}** — founder, and the only person who cannot be removed.\n`
        + `💍 ${num(Math.floor(married / 2))} married couple(s) in the database.\n`
        + `👥 ${num(pets)} hunter(s) on record.\n\n`
        + `👤 **YOUR SEAT: ${seat}**\n`
        + `🤗 Hugs ${num(you.hugs)} · 🔪 Stabs ${num(you.stabs)} · 💀 Kills ${num(you.kills)}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + '📖 _Your seat is derived from your balance. It is not a metaphor._',
        event.messageID,
      );
    }),
  });

module.exports = commands;
