'use strict';

/**
 * MODULE 11 — KINGDOMS
 *
 * A kingdom is a crew with a treasury, a monarch and a standing
 * that can be wagered in a war. Ten commands, one system:
 *
 *   !kingdom          view yours, or found one (`create <name>`)
 *   !kingdomjoin      join an open kingdom by name
 *   !kingdomleave     leave; the monarch must disband instead
 *   !kingdominvite    the monarch adds a member
 *   !kingdomkick      the monarch removes one
 *   !kingdominfo      read a kingdom's card
 *   !kingdomdonate    pay coins into the treasury
 *   !kingdommembers   the roster, with ranks read off donations
 *   !kingdomwar       wager the treasury against another kingdom
 *   !kingdoms         the board, ranked by treasury
 *
 * THE ONE RULE
 * Membership is a fact, not a favour. A hunter belongs to exactly
 * one kingdom at a time, held on the User document (`kingdom`), and
 * every command that changes it changes both sides — the hunter's
 * field and the kingdom's roster — in the same breath, so a kingdom
 * can never list a member who says they are independent.
 *
 * THE MONEY
 * Founding, donations and wars move real coins, so they use the same
 * discipline as module 9: the amount is clamped to what is actually
 * there, every transfer is ledgered, and a fee that cannot be covered
 * in full leaves the balance exactly as it was. A treasury cannot go
 * negative and no war can mint money — the pot is only ever what the
 * two kingdoms wagered.
 *
 * RANKS AND LEVELS ARE DERIVED
 * A knight is a member who has donated 1,000 lifetime; a level is
 * xp over 1,000. Neither is stored, because two numbers that are
 * supposed to describe one thing will eventually disagree.
 */

const User = require('../models/User');
const Kingdom = require('../models/Kingdom');
const Economy = require('../models/Economy');
const mongo = require('../bot/mongo');
const userTarget = require('../bot/target');

const CASH = 'K-Cash';
const OWNER = 'Aphecks iKon Klerk';

// The economics of a kingdom.
const FOUND_COST = 1000;   // to found: paid into the new treasury
const MAX_MEMBERS = 20;    // a kingdom is a chat, not a server
const KNIGHT_DONATION = 1000; // lifetime donations that make a knight
const XP_PER_LEVEL = 1000;
const WAR_STAKE = 2000;    // each side wagers up to this much
const WAR_MIN = 100;       // ...but never less than this
const WAR_COOLDOWN = 60 * 60 * 1000; // one war an hour, per kingdom

// ───────────────────────────────────────────────────────────
// SMALL HELPERS
// ───────────────────────────────────────────────────────────

const clamp = (v) => Math.max(0, Math.floor(Number(v) || 0));
const num = (v) => Number(v || 0).toLocaleString('en-US');
const kc = (v) => `${num(v)} ${CASH}`;
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
 * Take coins from a hunter. Returns {ok:false, short} when they
 * cannot cover it, so a caller can say "you are broke" instead of
 * silently doing nothing. The amount is clamped to what is actually
 * held, which is what stops a kingdom command from printing a
 * negative balance.
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

/** Give coins to a hunter. Clamped at 0 so nothing goes negative. */
async function give(userDoc, amount, action, metadata = {}) {
  const gain = clamp(amount);
  if (gain <= 0) return 0;
  userDoc.coins = clamp(userDoc.coins) + gain;
  await save(userDoc);
  await ledger(userDoc.uid, action, gain, userDoc.coins, metadata);
  return gain;
}

/**
 * A fee that must be covered in full. Unlike take(), which drains
 * whatever is there, a failed fee must leave the balance untouched,
 * or the "not enough" reply ends up quoting the money it just took.
 */
async function fee(userDoc, cost, action) {
  const need = clamp(cost);
  if (clamp(userDoc.coins) < need) {
    return {
      ok: false,
      reason: `💸 **Not enough.** ${kc(need)} needed and you have ${kc(userDoc.coins)}.`,
    };
  }
  const taken = await take(userDoc, need, action, { cost });
  return { ok: true, took: taken.took };
}

/** Run a handler with a user-facing safety net. */
async function guard(reply, messageID, label, fn) {
  try {
    await fn();
  } catch (err) {
    await reply(`⚠️ \`${label}\` failed: ${err.message}`, messageID);
  }
}

// ───────────────────────────────────────────────────────────
// KINGDOM LOOKUPS
// ───────────────────────────────────────────────────────────

/** Find a kingdom by exact name, case-insensitive. */
async function kingdomOf(name) {
  if (!name || !mongo.isReady()) return null;
  return Kingdom.findOne({ name: new RegExp(`^${reEsc(String(name).trim())}$`, 'i') }).catch(() => null);
}

/** The kingdom this hunter belongs to, if it still exists. */
async function myKingdom(userDoc) {
  if (!userDoc.kingdom) return null;
  return kingdomOf(userDoc.kingdom);
}

/** A member row by uid. */
function memberRow(kingdom, uid) {
  return (kingdom.members || []).find((m) => String(m.uid) === String(uid)) || null;
}

/** Level from xp — never stored, so it can never disagree. */
function levelOf(kingdom) {
  return Math.floor(clamp(kingdom.xp) / XP_PER_LEVEL) + 1;
}

/** Rank from donations and the crown. Derived, never stored. */
function rankOf(member, uid, leaderUid) {
  if (String(uid) === String(leaderUid)) return '👑 monarch';
  return clamp(member && member.donated) >= KNIGHT_DONATION ? '⚔️ knight' : '🌾 peasant';
}

/** Add xp and report whether the kingdom levelled up. */
async function addXp(kingdom, amount) {
  const before = levelOf(kingdom);
  kingdom.xp = clamp(kingdom.xp) + clamp(amount);
  await save(kingdom);
  return levelOf(kingdom) > before;
}

/** Resolve a tagged member of this chat into a User document. */
async function resolvePerson(args, event, api) {
  if (!args.length) return null;
  const { target, consumed } = await userTarget.resolveArgs(args, event, api, { doc: true, max: 3 });
  return target ? { person: target, consumed } : null;
}

/** A progress bar, the same shape the rest of the bot draws. */
function meter(pct, label) {
  const filled = Math.max(0, Math.min(10, Math.round(clamp(pct) / 10)));
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  return `${label}\n\`${bar}\` ${Math.max(0, Math.min(100, Math.round(clamp(pct))))}%`;
}

/** The card every kingdom command shares: name, crown, size, treasury. */
function cardLines(k) {
  const lvl = levelOf(k);
  const next = lvl * XP_PER_LEVEL;
  return [
    `👑 **${k.name}** ${k.emoji || '🏰'}`,
    '· · · · · · ·',
    `👑 Monarch: ${k.leaderName || 'unknown'}`,
    `👥 Members: ${num((k.members || []).length)}/${num(MAX_MEMBERS)}`,
    `💰 Treasury: ${kc(k.treasury)}`,
    `⭐ Level ${lvl} — ${num(clamp(k.xp))}/${num(next)} xp`,
    `🚪 ${k.open ? 'Open — anyone may join' : 'Closed — invite only'}`,
  ];
}

// ───────────────────────────────────────────────────────────
// THE COMMANDS
// ───────────────────────────────────────────────────────────

const commands = [];

commands.push({
  name: 'kingdom',
  aliases: [],
  category: 'kingdom',
  description: '🏰 Your kingdom — view it, found one, or disband it',
  usage: '!kingdom [create <name>|disband|open|close]',
  cooldown: 10,
  permission: 'all',
  execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'kingdom', async () => {
    await react('🏰');
    if (!mongo.isReady()) {
      await reply('🏰 The kingdoms are asleep. Adopt a database.', event.messageID);
      return;
    }

    const sub = (args[0] || '').toLowerCase();

    // ── found a kingdom ──────────────────────────────
    if (sub === 'create') {
      const name = args.slice(1).join(' ').trim().replace(/\s+/g, ' ');
      if (!name) {
        await reply('❌ Usage: `!kingdom create <name>` — name your kingdom.', event.messageID);
        return;
      }
      if (name.length > 24) {
        await reply('❌ A kingdom name is 24 characters at most. Shorter is mightier.', event.messageID);
        return;
      }
      if (userDoc.kingdom) {
        await reply(`❌ You already march under **${userDoc.kingdom}**. Leave it first (\`!kingdomleave\`).`, event.messageID);
        return;
      }
      if (await kingdomOf(name)) {
        await reply(`❌ A kingdom called **${name}** already holds that land. Pick another name.`, event.messageID);
        return;
      }

      const paid = await fee(userDoc, FOUND_COST, 'kingdom:found');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const k = new Kingdom({
        name,
        leaderUid: String(userDoc.uid),
        leaderName: userDoc.name,
        members: [{ uid: String(userDoc.uid), name: userDoc.name, donated: 0, joinedAt: new Date() }],
        treasury: FOUND_COST,
        xp: 0,
        open: true,
      });
      await save(k);

      userDoc.kingdom = name;
      await save(userDoc);

      await react('👑');
      await reply(
        `🏰 **KINGDOM FOUNDED: ${name}**\n`
        + '· · · · · · ·\n'
        + `👑 You are the monarch, and the first soldier.\n`
        + `💰 Treasury: ${kc(FOUND_COST)} (your founding gift)\n`
        + `🚪 Open — anybody may join with \`!kingdomjoin ${name}\`\n`
        + `📖 Invite your hunters. A kingdom of one is a hermitage.`,
        event.messageID,
      );
      return;
    }

    // ── disband ──────────────────────────────────────
    if (sub === 'disband') {
      const k = await myKingdom(userDoc);
      if (!k) {
        await reply('❌ You are not in a kingdom. Found one with `!kingdom create <name>`.', event.messageID);
        return;
      }
      if (String(k.leaderUid) !== String(userDoc.uid)) {
        await reply(`❌ Only the monarch of **${k.name}** can disband it. ${k.leaderName} holds the crown.`, event.messageID);
        return;
      }
      const treasury = k.treasury;
      await Kingdom.deleteOne({ _id: k._id }).catch(() => null);
      // Every member's field is cleared, so nobody is left pointing
      // at a kingdom that no longer exists.
      for (const m of k.members || []) {
        const doc = await User.findOne({ uid: String(m.uid) }).catch(() => null);
        if (doc && doc.kingdom === k.name) {
          doc.kingdom = '';
          await save(doc);
        }
      }
      await reply(
        `🔥 **${k.name} HAS FALLEN**\n`
        + '· · · · · · ·\n'
        + `💰 The treasury of ${kc(treasury)} was destroyed with it.\n`
        + `👥 ${num((k.members || []).length)} member(s) are independent again.\n`
        + `📖 There is no ruin left to visit.`,
        event.messageID,
      );
      return;
    }

    // ── open / close ─────────────────────────────────
    if (sub === 'open' || sub === 'close') {
      const k = await myKingdom(userDoc);
      if (!k) {
        await reply('❌ You are not in a kingdom. Found one with `!kingdom create <name>`.', event.messageID);
        return;
      }
      if (String(k.leaderUid) !== String(userDoc.uid)) {
        await reply(`❌ Only the monarch of **${k.name}** decides who may join.`, event.messageID);
        return;
      }
      k.open = sub === 'open';
      await save(k);
      await reply(
        `🚪 **${k.name} is now ${k.open ? 'OPEN' : 'CLOSED'}**\n`
        + '· · · · · · ·\n'
        + (k.open
          ? `Anybody may join with \`!kingdomjoin ${k.name}\`.\n`
          : `Only an invite from the monarch will bring somebody in.\n`)
        + `📖 Toggle it again with \`!kingdom ${sub === 'open' ? 'close' : 'open'}\`.`,
        event.messageID,
      );
      return;
    }

    // ── view yours ───────────────────────────────────
    const k = await myKingdom(userDoc);
    if (!k) {
      await reply(
        `🏰 **YOU ARE INDEPENDENT**\n`
        + '· · · · · · ·\n'
        + `No kingdom flies your flag.\n`
        + `👑 Found one with \`!kingdom create <name>\` — ${kc(FOUND_COST)}, and you are the monarch.\n`
        + `📖 Or join somebody else's with \`!kingdomjoin <name>\`.`,
        event.messageID,
      );
      return;
    }

    const me = memberRow(k, userDoc.uid);
    const lvl = levelOf(k);
    await reply(
      `${cardLines(k).join('\n')}\n`
      + `⚔️ Wars: ${num(k.stats.warsWon)} won / ${num(k.stats.warsLost)} lost\n`
      + `🎖️ Your rank: ${rankOf(me, userDoc.uid, k.leaderUid)}${me ? ` (${num(clamp(me.donated))} donated)` : ''}\n`
      + `📖 \`!kingdommembers\` for the roster, \`!kingdomwar <name>\` to fight.`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'kingdomjoin',
  aliases: ['kjoin'],
  category: 'kingdom',
  description: '🚪 Join an open kingdom by name',
  usage: '!kingdomjoin <name>',
  cooldown: 10,
  permission: 'all',
  execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'kingdomjoin', async () => {
    await react('🚪');
    if (!mongo.isReady()) {
      await reply('🏰 The kingdoms are asleep. Adopt a database.', event.messageID);
      return;
    }
    const name = args.join(' ').trim();
    if (!name) {
      await reply('❌ Usage: `!kingdomjoin <name>` — which kingdom?', event.messageID);
      return;
    }
    if (userDoc.kingdom) {
      await reply(`❌ You already march under **${userDoc.kingdom}**. Leave it first (\`!kingdomleave\`).`, event.messageID);
      return;
    }
    const k = await kingdomOf(name);
    if (!k) {
      await reply(`❌ No kingdom called **${name}** holds that land. Found it with \`!kingdom create ${name}\`.`, event.messageID);
      return;
    }
    if (!k.open) {
      await reply(`❌ **${k.name}** is closed. Only the monarch can bring somebody in.`, event.messageID);
      return;
    }
    if ((k.members || []).length >= MAX_MEMBERS) {
      await reply(`❌ **${k.name}** is at full strength (${num(MAX_MEMBERS)}). It takes no more soldiers.`, event.messageID);
      return;
    }

    k.members.push({ uid: String(userDoc.uid), name: userDoc.name, donated: 0, joinedAt: new Date() });
    await save(k);
    userDoc.kingdom = k.name;
    await save(userDoc);

    await react('⚔️');
    await reply(
      `⚔️ **WELCOME TO ${k.name}**\n`
      + '· · · · · · ·\n'
      + `👑 Monarch: ${k.leaderName}\n`
      + `👥 You are member ${num(k.members.length)}/${num(MAX_MEMBERS)} — a peasant, for now.\n`
      + `💰 Treasury: ${kc(k.treasury)}\n`
      + `📖 Donate with \`!kingdomdonate\` to become a knight (${kc(KNIGHT_DONATION)} lifetime).`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'kingdomleave',
  aliases: ['kleave'],
  category: 'kingdom',
  description: '🚶 Leave your kingdom — the monarch must disband instead',
  usage: '!kingdomleave',
  cooldown: 10,
  permission: 'all',
  execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'kingdomleave', async () => {
    await react('🚶');
    if (!mongo.isReady()) {
      await reply('🏰 The kingdoms are asleep. Adopt a database.', event.messageID);
      return;
    }
    const k = await myKingdom(userDoc);
    if (!k) {
      await reply('❌ You are not in a kingdom.', event.messageID);
      return;
    }
    if (String(k.leaderUid) === String(userDoc.uid)) {
      await reply(
        `❌ You are the monarch of **${k.name}** — a kingdom cannot outlive its crown.\n`
        + `📖 Disband it with \`!kingdom disband\`, or pass the crown by handing the kingdom to a knight first.`,
        event.messageID,
      );
      return;
    }

    k.members = (k.members || []).filter((m) => String(m.uid) !== String(userDoc.uid));
    await save(k);
    userDoc.kingdom = '';
    await save(userDoc);

    await react('🌾');
    await reply(
      `🚶 **YOU LEFT ${k.name}**\n`
      + '· · · · · · ·\n'
      + `👥 ${num(k.members.length)} member(s) remain.\n`
      + `📖 You are independent. Join another with \`!kingdomjoin <name>\`, or found your own.`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'kingdominvite',
  aliases: ['kinvite'],
  category: 'kingdom',
  description: '🤝 The monarch brings somebody into the kingdom',
  usage: '!kingdominvite @user',
  cooldown: 10,
  permission: 'all',
  execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'kingdominvite', async () => {
    await react('🤝');
    if (!mongo.isReady()) {
      await reply('🏰 The kingdoms are asleep. Adopt a database.', event.messageID);
      return;
    }
    const k = await myKingdom(userDoc);
    if (!k) {
      await reply('❌ You are not in a kingdom. Found one with `!kingdom create <name>`.', event.messageID);
      return;
    }
    if (String(k.leaderUid) !== String(userDoc.uid)) {
      await reply(`❌ Only the monarch of **${k.name}** may invite. ${k.leaderName} holds the crown.`, event.messageID);
      return;
    }
    const found = await resolvePerson(args, event, api);
    if (!found) {
      await reply('❌ Usage: `!kingdominvite @user` — tag somebody in this chat.', event.messageID);
      return;
    }
    const person = found.person;
    if (String(person.uid) === String(userDoc.uid)) {
      await reply('🙃 You are already in your own kingdom. That is the whole point of founding it.', event.messageID);
      return;
    }
    if (person.kingdom) {
      await reply(`❌ **${person.name}** already marches under **${person.kingdom}**. They must leave it first.`, event.messageID);
      return;
    }
    if ((k.members || []).length >= MAX_MEMBERS) {
      await reply(`❌ **${k.name}** is at full strength (${num(MAX_MEMBERS)}). It takes no more soldiers.`, event.messageID);
      return;
    }

    k.members.push({ uid: String(person.uid), name: person.name, donated: 0, joinedAt: new Date() });
    await save(k);
    person.kingdom = k.name;
    await save(person);

    await react('⚔️');
    await reply(
      `🤝 **${person.name} JOINS ${k.name}**\n`
      + '· · · · · · ·\n'
      + `👑 Brought in by ${userDoc.name}, the monarch.\n`
      + `👥 ${num(k.members.length)}/${num(MAX_MEMBERS)} members now.\n`
      + `📖 Welcome to the kingdom, ${person.name}.`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'kingdomkick',
  aliases: ['kkick'],
  category: 'kingdom',
  description: '🦵 The monarch removes a member from the kingdom',
  usage: '!kingdomkick @user',
  cooldown: 10,
  permission: 'all',
  execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'kingdomkick', async () => {
    await react('🦵');
    if (!mongo.isReady()) {
      await reply('🏰 The kingdoms are asleep. Adopt a database.', event.messageID);
      return;
    }
    const k = await myKingdom(userDoc);
    if (!k) {
      await reply('❌ You are not in a kingdom. Found one with `!kingdom create <name>`.', event.messageID);
      return;
    }
    if (String(k.leaderUid) !== String(userDoc.uid)) {
      await reply(`❌ Only the monarch of **${k.name}** may kick. ${k.leaderName} holds the crown.`, event.messageID);
      return;
    }
    const found = await resolvePerson(args, event, api);
    if (!found) {
      await reply('❌ Usage: `!kingdomkick @user` — tag somebody in this chat.', event.messageID);
      return;
    }
    const person = found.person;
    if (String(person.uid) === String(userDoc.uid)) {
      await reply('❌ You cannot kick yourself out of your own kingdom. Disband it instead.', event.messageID);
      return;
    }
    if (!memberRow(k, person.uid)) {
      await reply(`❌ **${person.name}** is not a member of **${k.name}**.`, event.messageID);
      return;
    }

    k.members = (k.members || []).filter((m) => String(m.uid) !== String(person.uid));
    await save(k);
    if (person.kingdom === k.name) {
      person.kingdom = '';
      await save(person);
    }

    await react('🌾');
    await reply(
      `🦵 **${person.name} WAS REMOVED FROM ${k.name}**\n`
      + '· · · · · · ·\n'
      + `👑 Removed by ${userDoc.name}, the monarch.\n`
      + `👥 ${num(k.members.length)} member(s) remain.\n`
      + `📖 ${person.name} is independent again.`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'kingdominfo',
  aliases: ['kinfo'],
  category: 'kingdom',
  description: '🔍 Read a kingdom\'s card — its crown, treasury and wars',
  usage: '!kingdominfo [name]',
  cooldown: 10,
  permission: 'all',
  execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'kingdominfo', async () => {
    await react('🔍');
    if (!mongo.isReady()) {
      await reply('🏰 The kingdoms are asleep. Adopt a database.', event.messageID);
      return;
    }
    const k = await kingdomOf(args.join(' ').trim()) || await myKingdom(userDoc);
    if (!k) {
      await reply('❌ Usage: `!kingdominfo <name>` — which kingdom? (Or run it with no name for your own.)', event.messageID);
      return;
    }

    const knights = (k.members || []).filter((m) => clamp(m.donated) >= KNIGHT_DONATION).length;
    await react('🏰');
    await reply(
      `${cardLines(k).join('\n')}\n`
      + `⚔️ Wars: ${num(k.stats.warsWon)} won / ${num(k.stats.warsLost)} lost\n`
      + `⚔️ Knights: ${num(knights)} · 🌾 Peasants: ${num((k.members || []).length - knights)}\n`
      + `💰 Lifetime donations: ${kc(k.stats.donations)}\n`
      + `📖 \`!kingdommembers ${k.name}\` for the roster.`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'kingdomdonate',
  aliases: ['kdonate'],
  category: 'kingdom',
  description: '💰 Pay coins into your kingdom\'s treasury',
  usage: '!kingdomdonate <amount>',
  cooldown: 10,
  permission: 'all',
  execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'kingdomdonate', async () => {
    await react('💰');
    if (!mongo.isReady()) {
      await reply('🏰 The kingdoms are asleep. Adopt a database.', event.messageID);
      return;
    }
    const k = await myKingdom(userDoc);
    if (!k) {
      await reply('❌ You are not in a kingdom. Found one with `!kingdom create <name>`.', event.messageID);
      return;
    }
    const want = clamp(parseInt(args[0], 10));
    if (!want) {
      await reply('❌ Usage: `!kingdomdonate <amount>` — how many coins?', event.messageID);
      return;
    }

    const paid = await fee(userDoc, want, 'kingdom:donate');
    if (!paid.ok) {
      await reply(paid.reason, event.messageID);
      return;
    }

    const me = memberRow(k, userDoc.uid);
    if (me) me.donated = clamp(me.donated) + paid.took;
    k.treasury = clamp(k.treasury) + paid.took;
    k.stats.donations = clamp(k.stats.donations) + paid.took;
    await save(k);
    await save(userDoc);

    const levelled = await addXp(k, Math.floor(paid.took / 10));
    await react('🏦');
    await reply(
      `💰 **DONATION TO ${k.name}**\n`
      + '· · · · · · ·\n'
      + `💸 You gave ${kc(paid.took)} to the treasury.\n`
      + `🏦 Treasury: ${kc(k.treasury)}\n`
      + `⭐ Level ${levelOf(k)}${levelled ? ' — LEVEL UP!' : ''}\n`
      + `🎖️ Your rank: ${rankOf(me, userDoc.uid, k.leaderUid)}\n`
      + `📖 A knight is ${kc(KNIGHT_DONATION)} donated, lifetime.`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'kingdommembers',
  aliases: ['kmembers'],
  category: 'kingdom',
  description: '👥 The kingdom roster, ranked by donations',
  usage: '!kingdommembers [name]',
  cooldown: 10,
  permission: 'all',
  execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'kingdommembers', async () => {
    await react('👥');
    if (!mongo.isReady()) {
      await reply('🏰 The kingdoms are asleep. Adopt a database.', event.messageID);
      return;
    }
    const k = await kingdomOf(args.join(' ').trim()) || await myKingdom(userDoc);
    if (!k) {
      await reply('❌ Usage: `!kingdommembers <name>` — which kingdom? (Or run it with no name for your own.)', event.messageID);
      return;
    }

    const rows = (k.members || [])
      .slice()
      .sort((a, b) => clamp(b.donated) - clamp(a.donated))
      .map((m, i) => `${num(i + 1)}. ${m.name || `Hunter ${String(m.uid).slice(-4)}`} — ${rankOf(m, m.uid, k.leaderUid)} (${num(clamp(m.donated))} donated)`)
      .join('\n');

    await react('📜');
    await reply(
      `👥 **THE ROSTER OF ${k.name}**\n`
      + '· · · · · · ·\n'
      + `${rows || '👥 Empty. A kingdom with nobody in it.'}\n\n`
      + `👑 Monarch: ${k.leaderName}\n`
      + `💰 Treasury: ${kc(k.treasury)}\n`
      + `📖 ${num((k.members || []).length)}/${num(MAX_MEMBERS)} members.`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'kingdomwar',
  aliases: ['kwar'],
  category: 'kingdom',
  description: '⚔️ Wager your treasury against another kingdom',
  usage: '!kingdomwar <name>',
  cooldown: 60,
  permission: 'all',
  execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'kingdomwar', async () => {
    await react('⚔️');
    if (!mongo.isReady()) {
      await reply('🏰 The kingdoms are asleep. Adopt a database.', event.messageID);
      return;
    }
    const mine = await myKingdom(userDoc);
    if (!mine) {
      await reply('❌ You are not in a kingdom. Found one with `!kingdom create <name>`.', event.messageID);
      return;
    }
    if (String(mine.leaderUid) !== String(userDoc.uid)) {
      await reply(`❌ Only the monarch of **${mine.name}** may declare war. ${mine.leaderName} holds the crown.`, event.messageID);
      return;
    }
    const targetName = args.join(' ').trim();
    if (!targetName) {
      await reply('❌ Usage: `!kingdomwar <name>` — which kingdom are you fighting?', event.messageID);
      return;
    }
    const theirs = await kingdomOf(targetName);
    if (!theirs) {
      await reply(`❌ No kingdom called **${targetName}** holds that land.`, event.messageID);
      return;
    }
    if (theirs.name === mine.name) {
      await reply('🙃 A kingdom cannot war itself. That is a civil war with nobody to fight.', event.messageID);
      return;
    }

    // One war an hour, per kingdom. The cooldown is on the kingdom,
    // not the monarch, so passing the crown does not reset it.
    const since = Date.now() - (mine.lastWarAt ? new Date(mine.lastWarAt).getTime() : 0);
    if (since < WAR_COOLDOWN) {
      const left = Math.ceil((WAR_COOLDOWN - since) / 60000);
      await reply(`⏳ **${mine.name}** is licking its wounds. It may war again in ${num(left)} minute(s).`, event.messageID);
      return;
    }
    const sinceTheirs = Date.now() - (theirs.lastWarAt ? new Date(theirs.lastWarAt).getTime() : 0);
    if (sinceTheirs < WAR_COOLDOWN) {
      const left = Math.ceil((WAR_COOLDOWN - sinceTheirs) / 60000);
      await reply(`⏳ **${theirs.name}** is licking its wounds. It may be warred against again in ${num(left)} minute(s).`, event.messageID);
      return;
    }

    // Each side wagers up to the stake, but never more than it has,
    // and never less than the minimum — a war over nothing is a
    // parade, not a war.
    const myWager = Math.max(WAR_MIN, Math.min(WAR_STAKE, clamp(mine.treasury)));
    const theirWager = Math.max(WAR_MIN, Math.min(WAR_STAKE, clamp(theirs.treasury)));
    if (clamp(mine.treasury) < WAR_MIN || clamp(theirs.treasury) < WAR_MIN) {
      await reply(
        `❌ Both kingdoms need at least ${kc(WAR_MIN)} in the treasury to make a war worth fighting.\n`
        + `**${mine.name}** has ${kc(mine.treasury)}; **${theirs.name}** has ${kc(theirs.treasury)}.`,
        event.messageID,
      );
      return;
    }

    // Power: numbers, level and coffers all count, so a rich but
    // tiny kingdom is not unbeatable and a huge poor one is not
    // invincible either.
    const power = (k) => (k.members || []).length * 10 + levelOf(k) * 25 + Math.min(clamp(k.treasury), 5000) / 100;
    const myPower = power(mine);
    const theirPower = power(theirs);
    const chance = Math.max(0.05, Math.min(0.95, myPower / (myPower + theirPower)));
    const won = Math.random() < chance;

    // Move the pot first, so the reply can never report a treasury
    // the war did not actually pay out.
    mine.treasury = clamp(mine.treasury) - myWager;
    theirs.treasury = clamp(theirs.treasury) - theirWager;
    const pot = myWager + theirWager;
    mine.lastWarAt = new Date();
    theirs.lastWarAt = new Date();

    let winner, loser, wonWager, lostWager;
    if (won) {
      winner = mine; loser = theirs; wonWager = myWager; lostWager = theirWager;
      mine.treasury = clamp(mine.treasury) + pot;
      mine.stats.warsWon = clamp(mine.stats.warsWon) + 1;
      theirs.stats.warsLost = clamp(theirs.stats.warsLost) + 1;
    } else {
      winner = theirs; loser = mine; wonWager = theirWager; lostWager = myWager;
      theirs.treasury = clamp(theirs.treasury) + pot;
      theirs.stats.warsWon = clamp(theirs.stats.warsWon) + 1;
      mine.stats.warsLost = clamp(mine.stats.warsLost) + 1;
    }
    await save(mine);
    await save(theirs);

    await addXp(winner, 250);
    await addXp(loser, 50);

    await react(won ? '🏆' : '💀');
    await reply(
      `${won ? '🏆' : '💀'} **WAR: ${mine.name} vs ${theirs.name}**\n`
      + '· · · · · · ·\n'
      + `🏟️ ${mine.name}: ${num(mine.members.length)} soldiers, level ${levelOf(mine)} — ${Math.round(chance * 100)}% to win\n`
      + `🏟️ ${theirs.name}: ${num(theirs.members.length)} soldiers, level ${levelOf(theirs)}\n`
      + `💰 Pot: ${kc(pot)} (${kc(myWager)} vs ${kc(theirWager)})\n`
      + `${won ? `🏆 **${mine.name} WINS** and takes the pot.` : `💀 **${theirs.name} WINS** and takes the pot.`}\n`
      + `👑 ${winner.leaderName} pockets ${kc(pot)} for the treasury.\n`
      + `📖 ${loser.name} lost ${kc(lostWager)}. There is no rematch for an hour.`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'kingdoms',
  aliases: ['kings', 'kleaderboard'],
  category: 'kingdom',
  description: '🏆 The kingdom board, ranked by treasury',
  usage: '!kingdoms',
  cooldown: 10,
  permission: 'all',
  execute: async ({ args, api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'kingdoms', async () => {
    await react('🏆');
    if (!mongo.isReady()) {
      await reply('🏰 The kingdoms are asleep. Adopt a database.', event.messageID);
      return;
    }
    const top = await Kingdom.find({}).sort({ treasury: -1 }).limit(10).catch(() => null);
    if (!top || !top.length) {
      await reply(
        `🏆 **THE KINGDOM BOARD IS EMPTY**\n`
        + '· · · · · · ·\n'
        + `No kingdom has been founded yet.\n`
        + `👑 Be the first: \`!kingdom create <name>\` — ${kc(FOUND_COST)}.`,
        event.messageID,
      );
      return;
    }

    const rows = top
      .map((k, i) => `${num(i + 1)}. ${k.emoji || '🏰'} **${k.name}** — ${kc(k.treasury)} · level ${levelOf(k)} · ${num((k.members || []).length)} members`)
      .join('\n');

    await react('📜');
    await reply(
      `🏆 **THE KINGDOM BOARD**\n`
      + '· · · · · · ·\n'
      + `${rows}\n\n`
      + `📖 Ranked by treasury. \`!kingdominfo <name>\` reads a kingdom's card.`,
      event.messageID,
    );
  }),
});

module.exports = commands;
