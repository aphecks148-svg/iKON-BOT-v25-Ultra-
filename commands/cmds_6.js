'use strict';

/**
 * MODULE 6 — GROUP ADMINISTRATION (35 commands)
 *
 * iKON-BOT v2 Ultra. This is the module that makes a group admin fight to keep
 * the bot: welcome cards, anti-raid locks, a warzone that taxes the wealthy,
 * an invite war with real money behind it, and a ghostban that is genuinely
 * invisible to the person serving it.
 *
 * Exports a plain array. No factories, no legacy loader.
 *
 * Shape required for every command:
 * { name, aliases, category, description, usage, cooldown, permission, execute }
 *
 * execute receives: { api, event, args, config, registry, gemini, reply, react, userDoc }
 * `reply` and `react` are already bound to the current thread, so a command
 * never calls api.sendMessage directly. Canvas output goes through
 * `reply({ attachment })` for the same reason.
 *
 * Every handler is async and internally wrapped in try/catch so a failure is
 * reported to the user instead of escaping into the engine.
 *
 * Anything that touches the database refuses cleanly when mongo is offline
 * rather than half-applying state.
 */

const Group = require('../models/Group');
const User = require('../models/User');
const Economy = require('../models/Economy');
const canvasKit = require('../bot/canvas');
const mongo = require('../bot/mongo');
const { fmt } = require('../bot/helpers');

const CASH = 'K-Cash';
const OWNER = 'Aphecks iKon Klerk';

// ───────────────────────────────────────────────────────────
// CONTENT
// ───────────────────────────────────────────────────────────

const DEFAULT_WELCOME = 'Welcome {user} to the iKON arcade. The house is already watching.';
const DEFAULT_GOODBYE = '{user} left. The vault counts one fewer.';

const TRUTHS = [
  'What is the worst thing you have ever done for money?',
  'Who in this chat would you rob first, and why them?',
  'What is a rumor about you that is actually true?',
  'What is the most embarrassing thing in your search history?',
  'Who here would survive a week alone in the vault district?',
  'What talent do you pretend to have?',
  'What is the pettiest reason you have ever ended a friendship?',
];

const DARES = [
  'Change your nickname to something the bot picks, for one hour.',
  'Reply to the next person who messages here with only an emoji.',
  'Admit in chat what you would have done differently last month.',
  'Let the next person to speak choose your profile picture.',
  'Say "the house always smiles" and do not explain it.',
  'Hand the next person to speak a compliment in 5 words or fewer.',
];

const ROASTS = [
  'That link has seen things. Your balance is paying for them.',
  'Your fingers moved faster than your wallet could afford.',
  'The house thanks you for your donation.',
  'Spam is free. Consequences are not.',
  'You brought a link into a warzone. Bold.',
];

const CONFESSIONS = [
  'I read the rules after breaking them.',
  'I am the reason the slowmode exists.',
  'I have muted the notification and pretended to be busy.',
  'I ranked this chat by coins and told nobody.',
  'I read every message in this chat at 3am.',
];

// ───────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────

/** Run a handler with a user-facing safety net. */
async function guard(reply, messageID, label, fn) {
  try {
    await fn();
  } catch (err) {
    await reply(`⚠️ \`${label}\` failed: ${err.message}`, messageID);
  }
}

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rand(0, arr.length - 1)];
const clamp = (v) => Math.max(0, Math.floor(Number(v) || 0));
const kc = (v) => `${Number(v || 0).toLocaleString('en-US')} ${CASH}`;
const num = (v) => Number(v || 0).toLocaleString('en-US');

const story = () => pick([
  'The iKON streetlights hum one octave lower tonight.',
  'Somewhere in the vault district, a vault alarm tests itself.',
  'Owner Aphecks has not blinked in six hours.',
  'Rain taps the academy roof like it wants in.',
  'A Klerk courier runs past without looking up.',
  'The factory siren goes unanswered again.',
]);

/** on/off flag from an argument, or null when the hunter typed neither. */
function onOff(args) {
  const v = String(args[0] || '').toLowerCase();
  if (['on', 'enable', 'enabled', 'true', 'yes', '1'].includes(v)) return true;
  if (['off', 'disable', 'disabled', 'false', 'no', '0'].includes(v)) return false;
  return null;
}

const yesNo = (on) => (on ? 'ON' : 'OFF');

/** Substitute {user}, {group}, {count} into a configured message. */
function fill(tpl, userDoc, event, extra = {}) {
  return String(tpl || '')
    .replace(/\{user\}/g, userDoc ? userDoc.name : 'someone')
    .replace(/\{mention\}/g, userDoc ? `@${userDoc.name}` : 'someone')
    .replace(/\{group\}/g, (event && event.threadID) || 'this chat')
    .replace(/\{count\}/g, extra.count !== undefined ? String(extra.count) : '0');
}

/** Persist a document, tolerating offline mode. */
async function save(doc) {
  if (!doc || doc.transient) return;
  try {
    await doc.save();
  } catch { /* the reply still shows the outcome */ }
}

/** Append one line to the audit ledger. Never throws. */
async function ledger(uid, action, amount, balanceAfter, metadata = {}) {
  if (!mongo.isReady()) return;
  try {
    await new Economy({ uid, action, amount, balanceAfter, metadata }).save();
  } catch { /* auditing is best effort */ }
}

/** Per-hunter group standing, backfilled field by field (NaN guard). */
function ug(userDoc) {
  if (!userDoc.gc || typeof userDoc.gc !== 'object') userDoc.gc = {};
  for (const f of ['msgs', 'links', 'fines', 'toxicity', 'ghosted', 'invites']) {
    if (!Number.isFinite(userDoc.gc[f])) userDoc.gc[f] = 0;
  }
  return userDoc.gc;
}

/**
 * Resolve @tag, raw uid, or exact name to a User document.
 * Group moderation usually operates on a tag, which is the reliable case.
 */
async function resolveTarget(ref, event) {
  const clean = String(ref || '').replace(/^@/, '').trim();
  if (!clean) return null;
  if (/^\d+$/.test(clean)) return User.findOne({ uid: clean });

  const tagged = event.mentions && Object.values(event.mentions).find((m) => String(m) === clean);
  if (tagged) return User.findOne({ uid: String(tagged) });

  const safe = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return User.findOne({ name: new RegExp(`^${safe}$`, 'i') });
}

/** resolveTarget with the two failure replies already sent. */
async function targetOr(reply, messageID, ref, event, label) {
  if (!ref) {
    await reply(`❌ Usage: \`!${label} @user\` — tag somebody in this chat.`, messageID);
    return null;
  }
  const target = await resolveTarget(ref, event);
  if (!target) {
    await reply(`❌ No hunter found for \`${ref}\`.`, messageID);
    return null;
  }
  return target;
}

/**
 * The group document for this thread, or null when the database is down.
 * Commands that need to persist state bail out rather than pretend.
 */
async function liveGroup(event) {
  if (!mongo.isReady()) return null;
  if (!event || !event.threadID) return null;
  return Group.findOne({ tid: String(event.threadID) });
}

/**
 * The gc subdocument, backfilled field by field.
 * An older group document saved before module 6 has no `gc` at all, and a
 * partially saved one is missing individual toggles.
 */
function gcfg(group) {
  if (!group.gc || typeof group.gc !== 'object') group.gc = {};
  const c = group.gc;
  if (!c.antiLink || typeof c.antiLink !== 'object') c.antiLink = {};
  if (!c.antiRaid || typeof c.antiRaid !== 'object') c.antiRaid = {};
  if (!c.warzone || typeof c.warzone !== 'object') c.warzone = {};
  if (!c.lockdown || typeof c.lockdown !== 'object') c.lockdown = {};
  if (!c.invites || typeof c.invites !== 'object') c.invites = {};
  if (!c.tod || typeof c.tod !== 'object') c.tod = {};
  if (typeof c.policy !== 'string') c.policy = '';
  if (typeof c.msgs !== 'number' || !Number.isFinite(c.msgs)) c.msgs = 0;
  if (typeof c.level !== 'number' || !Number.isFinite(c.level)) c.level = 1;
  for (const f of ['ghostBans', 'bans', 'mutes', 'confessions']) {
    if (!Array.isArray(c[f])) c[f] = [];
  }
  if (c.antiLink.fine === undefined || !Number.isFinite(c.antiLink.fine)) c.antiLink.fine = 500;
  if (c.antiRaid.burst === undefined || !Number.isFinite(c.antiRaid.burst)) c.antiRaid.burst = 5;
  if (c.antiRaid.windowMs === undefined || !Number.isFinite(c.antiRaid.windowMs)) c.antiRaid.windowMs = 10000;
  if (c.warzone.tax === undefined || !Number.isFinite(c.warzone.tax)) c.warzone.tax = 50;
  if (c.warzone.floor === undefined || !Number.isFinite(c.warzone.floor)) c.warzone.floor = 1000;
  if (typeof c.lockdown.emoji !== 'string' || !c.lockdown.emoji) c.lockdown.emoji = '✅';
  if (!Array.isArray(c.invites.entries)) c.invites.entries = [];
  return c;
}

/** Drop expired entries from a punishment list, in place. */
function prune(list, now = Date.now()) {
  const keep = (list || []).filter((e) => e && e.uid && (!e.expires || new Date(e.expires).getTime() > now));
  list.length = 0;
  list.push(...keep);
  return list;
}

/** Every open punishment of this kind, uid list included. */
function punished(c, kind, uid) {
  prune(c[kind]);
  return c[kind].find((e) => String(e.uid) === String(uid)) || null;
}

/** True when this hunter is locked out of the chat by the bot itself. */
function locked(c, uid) {
  return Boolean(punished(c, 'bans', uid)) || Boolean(punished(c, 'ghostBans', uid));
}

/** Chat level from lifetime message count. 100 messages per level, capped 100. */
function levelFor(msgs) {
  return Math.max(1, Math.min(100, Math.floor(clamp(msgs) / 100) + 1));
}

/** Levelled progress bar for the chat level line. */
function bar(level) {
  const filled = Math.round((clamp(level) / 100) * 10);
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
}

/** Admin list for this thread, best effort. Never grants on a failed lookup. */
async function threadAdmins(api, event) {
  try {
    const info = await api.getThreadInfo(event.threadID);
    return ((info && info.adminIDs) || []).map(String);
  } catch {
    return [];
  }
}

/**
 * Paint the group banner. Returns a data URL, or null when the native canvas
 * binary is missing so the caller can fall back to text.
 */
async function renderBanner(tid, level, msgs, dominated) {
  const made = canvasKit.create(900, 480);
  if (!made) return null;
  const { ctx } = made;

  const bg = ctx.createLinearGradient(0, 0, 900, 480);
  bg.addColorStop(0, canvasKit.theme.bg1);
  bg.addColorStop(1, canvasKit.theme.bg2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 900, 480);

  ctx.fillStyle = canvasKit.theme.accent;
  ctx.fillRect(0, 0, 900, 6);
  ctx.fillStyle = canvasKit.theme.accent2;
  ctx.fillRect(0, 474, 900, 6);

  ctx.fillStyle = canvasKit.theme.text;
  ctx.font = 'bold 54px iKonSans';
  ctx.fillText('iKON CITY', 48, 110);

  ctx.fillStyle = canvasKit.theme.muted;
  ctx.font = '26px iKonSans';
  ctx.fillText(`CHAT ${String(tid).slice(-6)}`, 48, 156);

  ctx.fillStyle = canvasKit.theme.gold;
  ctx.font = 'bold 40px iKonSans';
  ctx.fillText(`LEVEL ${level}`, 48, 250);

  ctx.fillStyle = canvasKit.theme.text;
  ctx.font = '30px iKonSans';
  ctx.fillText(`${num(msgs)} lifetime messages`, 48, 302);

  // Level bar, clamped so a maxed chat cannot draw past the panel.
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(48, 340, 804, 22);
  const pct = Math.max(0, Math.min(1, clamp(level) / 100));
  ctx.fillStyle = canvasKit.theme.accent;
  ctx.fillRect(48, 340, Math.round(804 * pct), 22);

  if (dominated) {
    ctx.fillStyle = canvasKit.theme.accent2;
    ctx.font = 'bold 28px iKonSans';
    ctx.fillText('DOMINATED BY THE HOUSE', 48, 420);
  }

  const buffer = await canvasKit.toBuffer(made.canvas);
  return buffer ? `data:image/png;base64,${buffer.toString('base64')}` : null;
}

/** Paint a welcome card for one hunter. */
async function renderWelcome(name, uid, message) {
  const made = canvasKit.create(700, 340);
  if (!made) return null;
  const { ctx } = made;

  const bg = ctx.createLinearGradient(0, 0, 700, 340);
  bg.addColorStop(0, canvasKit.theme.bg2);
  bg.addColorStop(1, canvasKit.theme.bg1);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 700, 340);

  ctx.fillStyle = canvasKit.theme.accent;
  ctx.fillRect(0, 0, 700, 5);

  ctx.fillStyle = canvasKit.theme.muted;
  ctx.font = '22px iKonSans';
  ctx.fillText('WELCOME TO THE iKON ARCADE', 40, 70);

  ctx.fillStyle = canvasKit.theme.text;
  ctx.font = 'bold 44px iKonSans';
  ctx.fillText(String(name).slice(0, 22), 40, 140);

  ctx.fillStyle = canvasKit.theme.accent2;
  ctx.font = '22px iKonSans';
  ctx.fillText(`ID ${uid}`, 40, 180);

  // Word-wrap the configured welcome text by measuring it.
  ctx.fillStyle = canvasKit.theme.muted;
  ctx.font = '20px iKonSans';
  const words = String(message).split(' ');
  let line = '';
  let y = 226;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > 620 && line) {
      ctx.fillText(line, 40, y);
      line = w;
      y += 28;
      if (y > 320) break;
    } else {
      line = test;
    }
  }
  if (line && y <= 320) ctx.fillText(line, 40, y);

  const buffer = await canvasKit.toBuffer(made.canvas);
  return buffer ? `data:image/png;base64,${buffer.toString('base64')}` : null;
}

/** Paint a square icon preview. */
async function renderIcon(emoji, tid) {
  const made = canvasKit.create(256, 256);
  if (!made) return null;
  const { ctx } = made;

  ctx.fillStyle = canvasKit.theme.bg1;
  ctx.fillRect(0, 0, 256, 256);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 120px iKonSans';
  ctx.fillText(String(emoji).slice(0, 2), 128, 118);
  ctx.fillStyle = canvasKit.theme.muted;
  ctx.font = '16px iKonSans';
  ctx.fillText(`CHAT ${String(tid).slice(-6)}`, 128, 220);

  const buffer = await canvasKit.toBuffer(made.canvas);
  return buffer ? `data:image/png;base64,${buffer.toString('base64')}` : null;
}

/** Take coins from a hunter for a group offence. Returns what was taken. */
async function fine(userDoc, amount, action) {
  const take = Math.min(clamp(userDoc.coins), clamp(amount));
  if (take <= 0) return 0;
  userDoc.coins = clamp(userDoc.coins - take);
  ug(userDoc).fines += 1;
  await save(userDoc);
  await ledger(userDoc.uid, action, -take, userDoc.coins, { fine: take });
  return take;
}

/** Pay the group treasury / a member for a reward. */
async function pay(userDoc, amount, action, metadata = {}) {
  userDoc.coins = clamp((userDoc.coins || 0) + amount);
  await save(userDoc);
  await ledger(userDoc.uid, action, amount, userDoc.coins, metadata);
  return userDoc.coins;
}

/** Every command in this module, in registration order. */
const commands = [];

// ───────────────────────────────────────────────────────────
// WELCOME / GOODBYE / POLICY
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'welcome',
    aliases: [],
    category: 'group',
    description: '👋 Toggle the welcome message for this chat',
    usage: '!welcome on|off',
    cooldown: 10,
    permission: 'groupAdmin',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'welcome', async () => {
      await react('👋');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }

      const on = onOff(args);
      if (on === null) {
        const cfg = gcfg(group);
        await reply(`👋 Welcome messages are **${yesNo(!!group.settings.welcome)}** here.\nUse \`!welcome on\` or \`!welcome off\`.`, event.messageID);
        void cfg;
        return;
      }

      group.settings.welcome = on;
      if (on && !group.settings.welcomeMsg) group.settings.welcomeMsg = DEFAULT_WELCOME;
      await save(group);
      await reply(
        on
          ? `👋 **WELCOME IS ON.**\nNew arrivals get: "${group.settings.welcomeMsg}"`
          : '👋 Welcome messages are off. The door stays quiet.',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'goodbye',
    aliases: [],
    category: 'group',
    description: '🚪 Toggle the goodbye message for this chat',
    usage: '!goodbye on|off',
    cooldown: 10,
    permission: 'groupAdmin',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'goodbye', async () => {
      await react('🚪');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }

      const on = onOff(args);
      if (on === null) {
        await reply(`🚪 Goodbye messages are **${yesNo(!!group.settings.goodbye)}** here.\nUse \`!goodbye on\` or \`!goodbye off\`.`, event.messageID);
        return;
      }

      group.settings.goodbye = on;
      if (on && !group.settings.goodbyeMsg) group.settings.goodbyeMsg = DEFAULT_GOODBYE;
      await save(group);
      await reply(
        on
          ? `🚪 **GOODBYE IS ON.**\nDepartures get: "${group.settings.goodbyeMsg}"`
          : '🚪 Goodbye messages are off. Nobody is mourned now.',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'setwelcome',
    aliases: ['setwelcomemsg'],
    category: 'group',
    description: '✍️ Set the welcome text — {user}, {mention} and {group} all work',
    usage: '!setwelcome <message>',
    cooldown: 10,
    permission: 'groupAdmin',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'setwelcome', async () => {
      await react('✍️');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }

      const msg = args.join(' ').trim();
      if (!msg) {
        await reply(`❌ Usage: \`!setwelcome <message>\`\nCurrent: "${group.settings.welcomeMsg || DEFAULT_WELCOME}"`, event.messageID);
        return;
      }
      if (msg.length > 400) {
        await reply('❌ Too long. Keep it under 400 characters.', event.messageID);
        return;
      }

      group.settings.welcomeMsg = msg;
      group.settings.welcome = true;
      await save(group);
      await reply(`✍️ **WELCOME SET**\n━━━━━━━━━━━━━━━\nPreview: ${fill(msg, { name: 'Newcomer' }, event)}`, event.messageID);
    }),
  });

  commands.push({
    name: 'setgoodbye',
    aliases: ['setgoodbyemsg'],
    category: 'group',
    description: '✍️ Set the goodbye text — {user}, {mention} and {group} all work',
    usage: '!setgoodbye <message>',
    cooldown: 10,
    permission: 'groupAdmin',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'setgoodbye', async () => {
      await react('✍️');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }

      const msg = args.join(' ').trim();
      if (!msg) {
        await reply(`❌ Usage: \`!setgoodbye <message>\`\nCurrent: "${group.settings.goodbyeMsg || DEFAULT_GOODBYE}"`, event.messageID);
        return;
      }
      if (msg.length > 400) {
        await reply('❌ Too long. Keep it under 400 characters.', event.messageID);
        return;
      }

      group.settings.goodbyeMsg = msg;
      group.settings.goodbye = true;
      await save(group);
      await reply(`✍️ **GOODBYE SET**\n━━━━━━━━━━━━━━━\nPreview: ${fill(msg, { name: 'Leaver' }, event)}`, event.messageID);
    }),
  });

  commands.push({
    name: 'gcpolicy',
    aliases: ['gcrules', 'setpolicy'],
    category: 'group',
    description: '📜 Set or show the rules of this chat',
    usage: '!gcpolicy [rules]',
    cooldown: 10,
    permission: 'groupAdmin',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'gcpolicy', async () => {
      await react('📜');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const cfg = gcfg(group);

      const msg = args.join(' ').trim();
      if (!msg) {
        await reply(
          cfg.policy
            ? `📜 **RULES OF THIS CHAT**\n━━━━━━━━━━━━━━━\n${cfg.policy}`
            : '📜 No rules are posted. Use `!gcpolicy <rules>` to write some.',
          event.messageID,
        );
        return;
      }
      if (msg.length > 900) {
        await reply('❌ Too long. Keep the policy under 900 characters.', event.messageID);
        return;
      }

      cfg.policy = msg;
      await save(group);
      await reply(`📜 **POLICY POSTED**\n━━━━━━━━━━━━━━━\n${cfg.policy}\n📖 ${story()}`, event.messageID);
    }),
  });

// ───────────────────────────────────────────────────────────
// MEMBER MODERATION
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'kick',
    aliases: ['gckick'],
    category: 'group',
    description: '👢 Remove somebody from this chat and say why',
    usage: '!kick @user [reason]',
    cooldown: 10,
    permission: 'groupAdmin',
    execute: async ({ args, api, event, reply, react }) => guard(reply, event.messageID, 'kick', async () => {
      await react('👢');
      const target = await targetOr(reply, event.messageID, args[0], event, 'kick');
      if (!target) return;

      const admins = await threadAdmins(api, event);
      if (admins.includes(String(target.uid))) {
        await reply('❌ That person is an admin here. Demote them first.', event.messageID);
        return;
      }
      if (!api.removeUserFromGroup) {
        await reply('❌ This build cannot remove members. Nothing happened.', event.messageID);
        return;
      }

      try {
        await api.removeUserFromGroup({ threadID: event.threadID, userID: target.uid });
      } catch (err) {
        await reply(`❌ Could not remove them: ${err.message}`, event.messageID);
        return;
      }

      const reason = args.slice(1).join(' ').trim() || 'no reason given';
      await reply(`👢 **${target.name}** has been removed.\n📖 ${reason}\n📖 ${story()}`, event.messageID);
    }),
  });

  commands.push({
    name: 'promote',
    aliases: ['gcpromote'],
    category: 'group',
    description: '⬆️ Make somebody an admin of this chat',
    usage: '!promote @user',
    cooldown: 15,
    permission: 'groupAdmin',
    execute: async ({ args, api, event, reply, react }) => guard(reply, event.messageID, 'promote', async () => {
      await react('⬆️');
      const target = await targetOr(reply, event.messageID, args[0], event, 'promote');
      if (!target) return;
      if (!api.setThreadAdmin) {
        await reply('❌ This build cannot change admins. Nothing happened.', event.messageID);
        return;
      }

      try {
        await api.setThreadAdmin({ threadID: event.threadID, userID: target.uid, admin: true });
      } catch (err) {
        await reply(`❌ Could not promote them: ${err.message}`, event.messageID);
        return;
      }
      await reply(`⬆️ **${target.name}** is now an admin here.\n📖 ${story()}`, event.messageID);
    }),
  });

  commands.push({
    name: 'demote',
    aliases: ['gcdemote'],
    category: 'group',
    description: '⬇️ Remove somebody\'s admin rights in this chat',
    usage: '!demote @user',
    cooldown: 15,
    permission: 'groupAdmin',
    execute: async ({ args, api, event, reply, react }) => guard(reply, event.messageID, 'demote', async () => {
      await react('⬇️');
      const target = await targetOr(reply, event.messageID, args[0], event, 'demote');
      if (!target) return;
      if (!api.setThreadAdmin) {
        await reply('❌ This build cannot change admins. Nothing happened.', event.messageID);
        return;
      }

      try {
        await api.setThreadAdmin({ threadID: event.threadID, userID: target.uid, admin: false });
      } catch (err) {
        await reply(`❌ Could not demote them: ${err.message}`, event.messageID);
        return;
      }
      await reply(`⬇️ **${target.name}** is no longer an admin here.\n📖 ${story()}`, event.messageID);
    }),
  });

// ───────────────────────────────────────────────────────────
// THE DANGEROUS ONES — anti-link, anti-raid, ghostban, warzone
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'antilink',
    aliases: ['gclink'],
    category: 'group',
    description: '🔗 Auto-fine anyone who pastes a link. 500 coins each, plus a roast',
    usage: '!antilink on|off [fine]',
    cooldown: 10,
    permission: 'groupAdmin',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'antilink', async () => {
      await react('🔗');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const cfg = gcfg(group);

      const on = onOff(args);
      if (on === null) {
        await reply(
          `🔗 Anti-link is **${yesNo(!!cfg.antiLink.on)}** here.\n`
          + `💸 Current fine: ${kc(cfg.antiLink.fine)}\n`
          + `Use \`!antilink on [fine]\` or \`!antilink off\`.`,
          event.messageID,
        );
        return;
      }

      const asked = Number.parseInt(args[1], 10);
      if (Number.isFinite(asked) && asked >= 0) cfg.antiLink.fine = asked;

      cfg.antiLink.on = on;
      await save(group);
      await reply(
        on
          ? `🔗 **ANTI-LINK IS ON.** One link costs ${kc(cfg.antiLink.fine)}.\n📖 ${story()}`
          : '🔗 Anti-link is off. Post whatever you like.',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'antiraid',
    aliases: ['gcraid'],
    category: 'group',
    description: '🛡️ Lock the chat when a burst of joins lands inside 10 seconds',
    usage: '!antiraid on|off [burst]',
    cooldown: 10,
    permission: 'groupAdmin',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'antiraid', async () => {
      await react('🛡️');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const cfg = gcfg(group);

      const on = onOff(args);
      if (on === null) {
        await reply(
          `🛡️ Anti-raid is **${yesNo(!!cfg.antiRaid.on)}** here.\n`
          + `🎯 Locks at ${cfg.antiRaid.burst} joins inside ${fmt.dur(Math.round(cfg.antiRaid.windowMs / 1000))}.\n`
          + 'Use `!antiraid on [burst]` or `!antiraid off`.',
          event.messageID,
        );
        return;
      }

      const asked = Number.parseInt(args[1], 10);
      if (Number.isFinite(asked) && asked >= 2) cfg.antiRaid.burst = asked;

      cfg.antiRaid.on = on;
      await save(group);
      await reply(
        on
          ? `🛡️ **ANTI-RAID ARMED.** ${cfg.antiRaid.burst} joins inside ${fmt.dur(Math.round(cfg.antiRaid.windowMs / 1000))} and this chat seals itself.\n📖 ${story()}`
          : '🛡️ Anti-raid disarmed. The door is open again.',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'ghostban',
    aliases: ['gcghost'],
    category: 'group',
    description: '👻 Invisible ban. They still see their own messages. The chat does not',
    usage: '!ghostban @user [minutes]',
    cooldown: 30,
    permission: 'groupAdmin',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'ghostban', async () => {
      await react('👻');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const cfg = gcfg(group);

      const target = await targetOr(reply, event.messageID, args[0], event, 'ghostban');
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ You cannot ghostban yourself. The silence would be very relaxing.', event.messageID);
        return;
      }

      const mins = clamp(Number.parseInt(args[1], 10)) || 60;
      prune(cfg.ghostBans);
      const already = punished(cfg, 'ghostBans', target.uid);
      if (already) {
        await reply(`👻 ${target.name} is already ghostbanned here.`, event.messageID);
        return;
      }

      cfg.ghostBans.push({
        uid: String(target.uid),
        name: target.name,
        by: String(event.senderID),
        expires: new Date(Date.now() + mins * 60 * 1000),
      });
      ug(target).ghosted += 1;
      await save(target);
      await save(group);

      // Deliberately no public confirmation naming the target: the whole point
      // is that the banned hunter must not learn they were caught.
      await reply(
        `👻 **SOMEBODY HAS BEEN QUIETENED.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `⏳ They can still see their own messages for ${mins} minutes.\n`
        + `📖 They will not see why. That is the feature.`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'warzone',
    aliases: ['gcwar'],
    category: 'group',
    description: '⚔️ Turn this chat into a warzone — the wealthy pay a tax on every message',
    usage: '!warzone on|off [tax]',
    cooldown: 15,
    permission: 'groupAdmin',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'warzone', async () => {
      await react('⚔️');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const cfg = gcfg(group);

      const on = onOff(args);
      if (on === null) {
        await reply(
          `⚔️ Warzone is **${yesNo(!!cfg.warzone.on)}** here.\n`
          + `💸 Tax: ${kc(cfg.warzone.tax)} per message, for members holding ${kc(cfg.warzone.floor)} or more.\n`
          + 'Use `!warzone on [tax]` or `!warzone off`.',
          event.messageID,
        );
        return;
      }

      const asked = Number.parseInt(args[1], 10);
      if (Number.isFinite(asked) && asked >= 0) cfg.warzone.tax = asked;

      cfg.warzone.on = on;
      await save(group);
      await reply(
        on
          ? `⚔️ **WARZONE DECLARED.**\n━━━━━━━━━━━━━━━\n💸 Anyone holding ${kc(cfg.warzone.floor)} or more pays ${kc(cfg.warzone.tax)} a message.\n📖 ${story()}`
          : '⚔️ Warzone lifted. The tax is gone and the chat is quiet again.',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'lockdown',
    aliases: ['gclock'],
    category: 'group',
    description: '🔒 Emoji only. One emoji gets through, the rest of the chat is muted',
    usage: '!lockdown [emoji|off]',
    cooldown: 10,
    permission: 'groupAdmin',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'lockdown', async () => {
      await react('🔒');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const cfg = gcfg(group);

      const first = String(args[0] || '').toLowerCase();
      if (!first) {
        await reply(
          `🔒 Lockdown is **${yesNo(!!cfg.lockdown.on)}** here.\n`
          + (cfg.lockdown.on ? `✅ Only \`${cfg.lockdown.emoji}\` gets through.\n` : '')
          + 'Use `!lockdown <emoji>` to seal it, or `!lockdown off` to open it.',
          event.messageID,
        );
        return;
      }

      if (first === 'off' || first === 'no' || first === '0') {
        cfg.lockdown.on = false;
        await save(group);
        await reply('🔒 Lockdown lifted. Words are permitted again.', event.messageID);
        return;
      }

      const emoji = String(args[0] || '').trim();
      if ([...emoji].length > 3) {
        await reply('❌ Lockdown takes a single emoji. Pick one.', event.messageID);
        return;
      }

      cfg.lockdown.on = true;
      cfg.lockdown.emoji = emoji;
      await save(group);
      await reply(
        `🔒 **LOCKDOWN.**\n━━━━━━━━━━━━━━━\nOnly \`${emoji}\` is allowed through this door.\n📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'unlockgc',
    aliases: ['gcunlock', 'gcunlockall'],
    category: 'group',
    description: '🔓 Lift every lockdown, mute and warzone in this chat at once',
    usage: '!unlockgc',
    cooldown: 20,
    permission: 'groupAdmin',
    execute: async ({ event, reply, react }) => guard(reply, event.messageID, 'unlockgc', async () => {
      await react('🔓');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const cfg = gcfg(group);

      const mutes = cfg.mutes.length;
      const bans = cfg.bans.length;
      cfg.lockdown.on = false;
      cfg.warzone.on = false;
      cfg.antiRaid.on = false;
      cfg.mutes.length = 0;
      cfg.bans.length = 0;
      cfg.dominated = false;
      await save(group);

      await reply(
        `🔓 **EVERYTHING IS OPEN.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🚪 Lockdown: off\n⚔️ Warzone: off\n🛡️ Anti-raid: off\n👑 Domination: revoked\n`
        + `🔇 Mutes cleared: ${num(mutes)}\n🚫 Bans cleared: ${num(bans)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

// ───────────────────────────────────────────────────────────
// PUNISHMENT — bans, mutes, announcements
// ───────────────────────────────────────────────────────────

  /**
   * Everyone currently in the thread, as uid strings.
   *
   * Returns an empty list when the running build cannot enumerate members. That
   * makes a bulk action a no-op rather than a gamble: muting "everybody" from
   * an empty roster must not silently fall through to muting nobody while
   * reporting a success.
   */
  async function safeMembers(api, event) {
    try {
      if (typeof api.getThreadMembers === 'function') {
        const members = await api.getThreadMembers({ threadID: event.threadID });
        return (members || []).map((m) => String(m && (m.userID || m.id || m))).filter(Boolean);
      }
      if (typeof api.getParticipantInfo === 'function') {
        const info = await api.getParticipantInfo({ threadID: event.threadID });
        return ((info && info.participantIDs) || []).map(String);
      }
    } catch { /* fall through to the empty roster */ }
    return [];
  }

  commands.push({
    name: 'gcmute',
    aliases: ['gcmuteuser'],
    category: 'group',
    description: '🔇 Mute somebody — the bot deletes everything they say',
    usage: '!gcmute @user [minutes]',
    cooldown: 15,
    permission: 'groupAdmin',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'gcmute', async () => {
      await react('🔇');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const cfg = gcfg(group);

      const target = await targetOr(reply, event.messageID, args[0], event, 'gcmute');
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ You cannot mute yourself. Try being quieter instead.', event.messageID);
        return;
      }

      const mins = clamp(Number.parseInt(args[1], 10)) || 10;
      prune(cfg.mutes);
      const existing = punished(cfg, 'mutes', target.uid);
      if (existing) {
        // Re-muting extends rather than stacking a second overlapping entry.
        existing.expires = new Date(Date.now() + mins * 60 * 1000);
        await save(group);
        await reply(`🔇 ${target.name} is muted for another ${mins} minutes.`, event.messageID);
        return;
      }

      cfg.mutes.push({
        uid: String(target.uid),
        name: target.name,
        expires: new Date(Date.now() + mins * 60 * 1000),
      });
      await save(group);
      await reply(`🔇 **${target.name}** is muted for ${mins} minutes.\n📖 The house will delete the words for you.`, event.messageID);
    }),
  });

  commands.push({
    name: 'gcmuteall',
    aliases: ['gcmuteeveryone'],
    category: 'group',
    description: '🤐 Mute everybody except admins for 5 minutes. Total chaos',
    usage: '!gcmuteall [minutes]',
    cooldown: 60,
    permission: 'groupAdmin',
    execute: async ({ args, api, event, reply, react }) => guard(reply, event.messageID, 'gcmuteall', async () => {
      await react('🤐');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const cfg = gcfg(group);

      const mins = clamp(Number.parseInt(args[0], 10)) || 5;
      const expires = new Date(Date.now() + mins * 60 * 1000);
      prune(cfg.mutes);

      const admins = await threadAdmins(api, event);
      const exempt = new Set([...admins, String(event.senderID)]);
      const members = await safeMembers(api, event);

      if (!members.length) {
        await reply('❌ This build cannot list a chat\'s members, so nobody was muted.\nUse `!gcmute @user` one at a time.', event.messageID);
        return;
      }

      let muted = 0;
      for (const uid of members) {
        if (exempt.has(String(uid))) continue;
        cfg.mutes.push({ uid: String(uid), name: '', expires });
        muted += 1;
      }
      await save(group);

      await reply(
        muted
          ? `🤐 **EVERYONE IS MUTED.**\n`
            + '━━━━━━━━━━━━━━━\n'
            + `🔇 ${num(muted)} hunters silenced for ${mins} minutes\n`
            + `🛡️ ${num(exempt.size)} admins kept talking. You always do.\n`
            + `📖 ${story()}`
          : '🤐 Nobody to mute. Everyone here is an admin. Congratulations, you built a perfect chat.',
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gcunmute',
    aliases: ['gcunban'],
    category: 'group',
    description: '🔈 Lift a mute, a ban, or a ghostban on somebody',
    usage: '!gcunmute @user',
    cooldown: 15,
    permission: 'groupAdmin',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'gcunmute', async () => {
      await react('🔈');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const cfg = gcfg(group);

      const target = await targetOr(reply, event.messageID, args[0], event, 'gcunmute');
      if (!target) return;

      const before = cfg.mutes.length + cfg.bans.length + cfg.ghostBans.length;
      cfg.mutes = cfg.mutes.filter((e) => String(e.uid) !== String(target.uid));
      cfg.bans = cfg.bans.filter((e) => String(e.uid) !== String(target.uid));
      cfg.ghostBans = cfg.ghostBans.filter((e) => String(e.uid) !== String(target.uid));
      const lifted = before - (cfg.mutes.length + cfg.bans.length + cfg.ghostBans.length);
      await save(group);

      await reply(
        lifted
          ? `🔈 **${target.name}** walks free again. ${num(lifted)} punishment(s) lifted.\n📖 ${story()}`
          : `${target.name} was not punished here. Nothing changed.`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gcbanlist',
    aliases: ['gcbans', 'gcghostlist'],
    category: 'group',
    description: '📋 Everyone the bot has locked out of this chat',
    usage: '!gcbanlist',
    cooldown: 20,
    permission: 'groupAdmin',
    execute: async ({ event, reply, react }) => guard(reply, event.messageID, 'gcbanlist', async () => {
      await react('📋');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const cfg = gcfg(group);
      prune(cfg.bans);
      prune(cfg.ghostBans);
      prune(cfg.mutes);
      await save(group);

      const left = (e) => (e.expires
        ? fmt.dur(Math.max(0, Math.ceil((new Date(e.expires).getTime() - Date.now()) / 1000)))
        : 'permanent');

      if (!cfg.bans.length && !cfg.ghostBans.length && !cfg.mutes.length) {
        await reply('📋 Nobody is locked out. The chat is behaving itself.', event.messageID);
        return;
      }

      const lines = [];
      if (cfg.bans.length) {
        lines.push(`🚫 **BANNED (${cfg.bans.length})**`);
        for (const e of cfg.bans) lines.push(`• ${e.name || e.uid} — ${e.reason || 'no reason'} [${left(e)}]`);
      }
      if (cfg.ghostBans.length) {
        lines.push(`👻 **GHOSTBANNED (${cfg.ghostBans.length})**`);
        for (const e of cfg.ghostBans) lines.push(`• ${e.name || e.uid} [${left(e)}]`);
      }
      if (cfg.mutes.length) {
        lines.push(`🔇 **MUTED (${cfg.mutes.length})**`);
        for (const e of cfg.mutes) lines.push(`• ${e.name || e.uid} [${left(e)}]`);
      }

      await reply(`📋 **THE LOCKOUT LIST**\n━━━━━━━━━━━━━━━\n${lines.join('\n')}\n📖 ${story()}`, event.messageID);
    }),
  });

  commands.push({
    name: 'gcannounce',
    aliases: ['gcsay', 'gcnotice'],
    category: 'group',
    description: '📢 Make the bot announce a message to the whole chat',
    usage: '!gcannounce <message>',
    cooldown: 15,
    permission: 'groupAdmin',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'gcannounce', async () => {
      await react('📢');
      const msg = args.join(' ').trim();
      if (!msg) {
        await reply('❌ Usage: `!gcannounce <message>`', event.messageID);
        return;
      }

      await reply(
        `📢 **ANNOUNCEMENT**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${msg}\n`
        + `📖 — ${OWNER} is watching this chat.`,
        event.messageID,
      );
    }),
  });

// ───────────────────────────────────────────────────────────
// THE VIRAL MACHINES — invite war, level, domination
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'invitewar',
    aliases: ['invwar', 'gcwar2'],
    category: 'group',
    description: '🚪 Five minute invite war — whoever pulls in the most people wins 10,000',
    usage: '!invitewar start|join|status|end',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'invitewar', async () => {
      await react('🚪');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const cfg = gcfg(group);
      const inv = cfg.invites;
      const mode = String(args[0] || 'status').toLowerCase();
      const WINDOW = 5 * 60 * 1000;
      const PRIZE = 10000;

      // A war whose window has closed is settled lazily on the next call.
      if (inv.windowStart && Date.now() - new Date(inv.windowStart).getTime() > WINDOW && !inv.winner) {
        const top = [...(inv.entries || [])].sort((a, b) => b.count - a.count)[0];
        if (top && top.count > 0) {
          inv.winner = top.uid;
          inv.winnerName = top.name || top.uid;
          const champ = await User.findOne({ uid: top.uid });
          if (champ) {
            await pay(champ, PRIZE, 'group:invitewar_win', { tid: event.threadID, invites: top.count });
          }
        }
        inv.windowStart = null;
        inv.entries = [];
        await save(group);
        await reply(
          `🚪 **INVITE WAR OVER**\n━━━━━━━━━━━━━━━\n`
          + (inv.winner ? `🏆 ${inv.winnerName} pulled in the most people and took ${kc(PRIZE)}.\n` : 'Nobody invited anybody. Shameful.\n')
          + '📖 `!invitewar start` to run another one.',
          event.messageID,
        );
        inv.winner = '';
        inv.winnerName = '';
        await save(group);
        return;
      }

      if (mode === 'start') {
        if (inv.windowStart && Date.now() - new Date(inv.windowStart).getTime() <= WINDOW) {
          await reply('🚪 An invite war is already running here. Five minutes, then it settles itself.', event.messageID);
          return;
        }
        inv.windowStart = new Date();
        inv.entries = [];
        inv.winner = '';
        inv.winnerName = '';
        await save(group);
        await reply(
          `🚪 **INVITE WAR STARTED**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `⏱️ Five minutes.\n`
          + `🏆 Most invites wins ${kc(PRIZE)}.\n`
          + `📮 Join with \`!invitewar join\` after you add somebody.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      if (mode === 'join') {
        if (!inv.windowStart) {
          await reply('🚪 No war is running. Start one with `!invitewar start`.', event.messageID);
          return;
        }
        const mine = (inv.entries || []).find((e) => String(e.uid) === String(event.senderID));
        if (mine) {
          mine.count += 1;
          ug(userDoc).invites += 1;
          await save(userDoc);
        } else {
          inv.entries.push({ uid: String(event.senderID), name: userDoc.name, count: 1 });
          ug(userDoc).invites += 1;
          await save(userDoc);
        }
        await save(group);

        const board = [...inv.entries].sort((a, b) => b.count - a.count).slice(0, 5)
          .map((e, i) => `${i + 1}. ${e.name || e.uid} — ${e.count}`).join('\n');
        await reply(`🚪 **+1** You have ${num(mine ? mine.count : 1)} invite(s).\n━━━━━━━━━━━━━━━\n${board || 'Nobody yet.'}`, event.messageID);
        return;
      }

      const left = inv.windowStart ? fmt.dur(Math.max(0, Math.ceil((WINDOW - (Date.now() - new Date(inv.windowStart).getTime())) / 1000))) : '0s';
      const board = [...(inv.entries || [])].sort((a, b) => b.count - a.count).slice(0, 5)
        .map((e, i) => `${i + 1}. ${e.name || e.uid} — ${e.count}`).join('\n');
      await reply(
        `🚪 **INVITE WAR**\n━━━━━━━━━━━━━━━\n⏱️ ${left} left\n🏆 Prize: ${kc(PRIZE)}\n\n${board || 'No war running. `!invitewar start` to open one.'}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gclevel',
    aliases: ['gclevels', 'gcrank'],
    category: 'group',
    description: '📈 How loud this chat is — chat level 1 to 100 from message count',
    usage: '!gclevel',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'gclevel', async () => {
      await react('📈');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const cfg = gcfg(group);

      // `!gclevel add <n>` books messages against the chat. The engine cannot
      // count every message itself, so admins and the moderation commands feed
      // this number and the level is derived rather than stored and trusted.
      const bump = Number.parseInt(args[1], 10);
      if (String(args[0] || '').toLowerCase() === 'add' && Number.isFinite(bump) && bump > 0) {
        cfg.msgs = clamp(cfg.msgs) + clamp(bump);
      }
      cfg.level = levelFor(cfg.msgs);
      await save(group);

      const nextAt = cfg.level >= 100 ? null : cfg.level * 100;
      await reply(
        `📈 **CHAT LEVEL ${cfg.level}**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${bar(cfg.level)}\n`
        + `💬 Lifetime messages: ${num(cfg.msgs)}\n`
        + (nextAt ? `🎯 Level ${cfg.level + 1} at ${num(nextAt)} messages\n` : '👑 Maximum level. The chat has peaked.\n')
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gcstatsultra',
    aliases: ['gcstats', 'gcleaderboard'],
    category: 'group',
    description: '🏆 Richest, loudest, most toxic and most ghosted hunters in this chat',
    usage: '!gcstatsultra',
    cooldown: 20,
    permission: 'all',
    execute: async ({ event, reply, react }) => guard(reply, event.messageID, 'gcstatsultra', async () => {
      await react('🏆');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const cfg = gcfg(group);

      // Members of this chat, judged by their last known thread.
      const hunters = await User.find({ 'gc.lastGroup': String(event.threadID) }).limit(200).lean().catch(() => []);
      if (!hunters || !hunters.length) {
        await reply(
          '🏆 **NOTHING TO REPORT.**\n'
          + '━━━━━━━━━━━━━━━\n'
          + `💬 Chat level ${cfg.level} · ${num(cfg.msgs)} messages\n`
          + 'No hunter has activity recorded in this chat yet. Use the bot and come back.',
          event.messageID,
        );
        return;
      }

      // Counters live under gc.*, so the sorter takes a getter rather than a
      // key. A dotted path read as a literal property name returns undefined
      // for every hunter, which would rank them all equal and print an
      // arbitrary three names as though they were the loudest.
      const val = (e, path) => path.split('.').reduce((o, k) => (o == null ? 0 : o[k]), e) || 0;
      const top = (path, unit = '') => [...hunters]
        .sort((a, b) => val(b, path) - val(a, path))
        .slice(0, 3)
        .map((e) => `• ${e.name} — ${num(val(e, path))}${unit}`)
        .join('\n');

      await reply(
        `🏆 **THIS CHAT, JUDGED**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💰 Richest\n${top('coins', ` ${CASH}`)}\n\n`
        + `📢 Loudest\n${top('gc.msgs', ' msgs')}\n\n`
        + `☠️ Most toxic\n${top('gc.toxicity', ' commands')}\n\n`
        + `👻 Most ghosted\n${top('gc.ghosted', ' times')}\n\n`
        + `🔗 Link offenders\n${top('gc.links', ' links')}\n\n`
        + `💸 Fines paid\n${top('gc.fines', ' fines')}\n\n`
        + `📈 Chat level ${cfg.level} · ${num(cfg.msgs)} messages\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'ikondomination',
    aliases: ['gcdominate', 'gctakeover'],
    category: 'group',
    description: '👑 At chat level 50 the bot claims the room, icon and lore included',
    usage: '!ikondomination',
    cooldown: 60,
    permission: 'groupAdmin',
    execute: async ({ api, event, reply, react }) => guard(reply, event.messageID, 'ikondomination', async () => {
      await react('👑');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const cfg = gcfg(group);
      const level = levelFor(cfg.msgs);
      cfg.level = level;

      if (level < 50) {
        const need = 50 * 100 - clamp(cfg.msgs);
        await reply(
          `👑 **NOT YET.**\n━━━━━━━━━━━━━━━\n`
          + `This chat is level ${level}. Domination needs level 50.\n`
          + `💬 ${num(need)} more messages required.\n`
          + `📖 ${OWNER} is patient.`,
          event.messageID,
        );
        return;
      }

      const lore = pick([
        'This room now answers to the house. The house does not answer back.',
        'The lights dim on command now. Nobody wired them. Nobody dares ask.',
        'A second Klerk has been appointed. Nobody remembers hiring one.',
        'The banner was replaced overnight. The old one was never missed.',
      ]);
      cfg.dominated = true;
      cfg.dominatedAt = new Date();
      await save(group);

      await reply(
        `👑 **THIS CHAT HAS BEEN CLAIMED.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `📍 Chat level ${level} · ${num(cfg.msgs)} messages\n`
        + `🖼️ ${lore}\n\n`
        + `${lore}\n\n`
        + `🔓 Admins can still run \`!unlockgc\` to take it back.\n`
        + `📖 ${OWNER} declines to comment.`,
        event.messageID,
      );
      void api;
    }),
  });

// ───────────────────────────────────────────────────────────
// CANVAS — welcome cards, banners, icons
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'gcbanner',
    aliases: ['gcbannersign'],
    category: 'group',
    description: '🖼️ Render this chat as an iKON banner image',
    usage: '!gcbanner',
    cooldown: 30,
    permission: 'groupAdmin',
    execute: async ({ event, reply, react }) => guard(reply, event.messageID, 'gcbanner', async () => {
      await react('🖼️');
      const group = await liveGroup(event);
      const cfg = group ? gcfg(group) : null;
      const level = cfg ? levelFor(cfg.msgs) : 1;
      const msgs = cfg ? clamp(cfg.msgs) : 0;
      const tid = String(event.threadID || 'unknown');

      const made = await canvasKit.available()
        ? await renderBanner(tid, level, msgs, cfg && cfg.dominated)
        : null;

      if (!made) {
        // A missing native canvas binary is not an error worth failing over.
        // The banner degrades to text so the admin still gets their artefact.
        await reply(
          `🖼️ **BANNER (text mode — no canvas binary here)**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `🏙️ iKON CITY · CHAT ${tid.slice(-6)}\n`
          + `📈 LEVEL ${level}\n💬 ${num(msgs)} MESSAGES\n`
          + (cfg && cfg.dominated ? '👑 DOMINATED BY THE HOUSE\n' : '')
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }
      await reply({ attachment: { type: 'image', data: { url: made } } });
    }),
  });

  commands.push({
    name: 'gcicon',
    aliases: ['gcavatar'],
    category: 'group',
    description: '🖼️ Set the chat icon, or preview the new one when the build cannot',
    usage: '!gcicon <emoji>',
    cooldown: 20,
    permission: 'groupAdmin',
    execute: async ({ args, api, event, reply, react }) => guard(reply, event.messageID, 'gcicon', async () => {
      await react('🖼️');
      const icon = String(args[0] || '').trim();
      if (!icon) {
        await reply('❌ Usage: `!gcicon <emoji>` — one emoji becomes the chat icon.', event.messageID);
        return;
      }

      if (typeof api.setThreadIcon === 'function') {
        try {
          await api.setThreadIcon({ threadID: event.threadID, iconEmoji: icon });
          await reply(`🖼️ Chat icon set to ${icon}.`, event.messageID);
          return;
        } catch (err) {
          await reply(`🖼️ ${icon} it is — but Messenger refused the change (${err.message}).`, event.messageID);
          return;
        }
      }

      // ws3-fca cannot set an icon on most builds. Saying so plainly beats
      // reporting a success the group would never see.
      const made = canvasKit.available() ? await renderIcon(icon, String(event.threadID || '')) : null;
      if (made) {
        await reply({ attachment: { type: 'image', data: { url: made } } });
        return;
      }
      await reply(
        `🖼️ **${icon}** would be the icon for this chat.\n`
        + '━━━━━━━━━━━━━━━\n'
        + '⚠️ This build of ws3-fca cannot change a chat icon, so nothing was applied.',
        event.messageID,
      );
    }),
  });

// ───────────────────────────────────────────────────────────
// GROUP INFO
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'groupinfo',
    aliases: ['ginfo', 'gcinfo'],
    category: 'group',
    description: '📋 Thread id, level, member count, approval and every toggle',
    usage: '!groupinfo',
    cooldown: 15,
    permission: 'all',
    execute: async ({ api, event, reply, react }) => guard(reply, event.messageID, 'groupinfo', async () => {
      await react('📋');
      const group = await liveGroup(event);
      const members = (await safeMembers(api, event)).length;
      const admins = (await threadAdmins(api, event)).length;
      const tid = String(event.threadID || 'private chat');

      if (!group) {
        await reply(
          `📋 **CHAT RECORD**\n━━━━━━━━━━━━━━━\n`
          + `🆔 ${tid}\n`
          + `👥 ${num(members)} members · 🛡️ ${num(admins)} admins\n`
          + '❌ No database record, and the city grid is offline.',
          event.messageID,
        );
        return;
      }
      const cfg = gcfg(group);

      await reply(
        `📋 **CHAT RECORD**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🆔 ${tid}\n`
        + `👥 ${num(members)} members · 🛡️ ${num(admins)} admins\n`
        + `📈 Level ${cfg.level} · 💬 ${num(cfg.msgs)} messages\n`
        + `✅ Enabled: ${yesNo(!!group.isEnabled)}\n`
        + `🎖️ Approved: ${yesNo(!!group.isApproved)}\n`
        + `⏳ Pending approval: ${yesNo(!!group.pendingApproval)}\n`
        + `🔧 Maintenance: ${yesNo(!!group.maintenance)}\n`
        + `⬇️ Prefix: ${group.prefix ? `\`${group.prefix}\`` : 'default'}\n\n`
        + `👋 Welcome ${yesNo(!!group.settings.welcome)} · 🚪 Goodbye ${yesNo(!!group.settings.goodbye)}\n`
        + `🔗 Ant-link ${yesNo(!!cfg.antiLink.on)} · 🛡️ Anti-raid ${yesNo(!!cfg.antiRaid.on)}\n`
        + `⚔️ Warzone ${yesNo(!!cfg.warzone.on)} · 🔒 Lockdown ${yesNo(!!cfg.lockdown.on)}\n`
        + `👑 Dominated: ${yesNo(!!cfg.dominated)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gcmembers',
    aliases: ['gcmemberlist'],
    category: 'group',
    description: '👥 Member count and the busiest hunters recorded in this chat',
    usage: '!gcmembers',
    cooldown: 20,
    permission: 'all',
    execute: async ({ api, event, reply, react }) => guard(reply, event.messageID, 'gcmembers', async () => {
      await react('👥');
      const members = await safeMembers(api, event);
      const admins = await threadAdmins(api, event);
      const group = await liveGroup(event);
      const cfg = group ? gcfg(group) : null;

      const hunters = await User.find({ 'gc.lastGroup': String(event.threadID) }).limit(50).lean().catch(() => []);
      const val = (e, path) => path.split('.').reduce((o, k) => (o == null ? 0 : o[k]), e) || 0;
      const busiest = [...(hunters || [])].sort((a, b) => val(b, 'gc.msgs') - val(a, 'gc.msgs')).slice(0, 5);
      const board = busiest.length
        ? busiest.map((e, i) => `${i + 1}. ${e.name} — ${num(val(e, 'gc.msgs'))} msgs`).join('\n')
        : 'No hunter activity recorded yet.';

      await reply(
        `👥 **THE ROSTER**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `👤 ${num(members.length)} members${members.length ? ' (this build can count them)' : ' (this build cannot list them)'}\n`
        + `🛡️ ${num(admins.length)} admins\n`
        + `📈 Level ${cfg ? cfg.level : '?'} · 💬 ${cfg ? num(cfg.msgs) : '?'} messages\n\n`
        + `📢 **Busiest here**\n${board}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gcadmins',
    aliases: ['gcadminslist'],
    category: 'group',
    description: '🛡️ Everyone who can run the moderator commands in this chat',
    usage: '!gcadmins',
    cooldown: 20,
    permission: 'all',
    execute: async ({ api, event, reply, react }) => guard(reply, event.messageID, 'gcadmins', async () => {
      await react('🛡️');
      const admins = await threadAdmins(api, event);
      if (!admins.length) {
        await reply('🛡️ Messenger returned no admins for this chat, so nobody can run the moderator commands.', event.messageID);
        return;
      }

      const docs = await User.find({ uid: { $in: admins } }).lean().catch(() => []);
      const nameOf = (uid) => {
        const d = (docs || []).find((x) => String(x.uid) === String(uid));
        return d ? d.name : uid;
      };
      const rows = admins.map((uid, i) => `${i + 1}. ${nameOf(uid)}`).join('\n');

      await reply(
        `🛡️ **THE ADMIN BENCH**\n━━━━━━━━━━━━━━━\n${rows}\n`
        + `📖 ${OWNER} outranks all of them.`,
        event.messageID,
      );
    }),
  });

// ───────────────────────────────────────────────────────────
// SOCIAL CHAOS — truth or dare, confessions, quote bomb
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'truthordaregc',
    aliases: ['truthordare', 'gctod'],
    category: 'group',
    description: '🎭 Truth or dare for the whole chat — the bot picks, somebody answers',
    usage: '!truthordaregc [truth|dare]',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'truthordaregc', async () => {
      await react('🎭');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const cfg = gcfg(group);

      const want = String(args[0] || '').toLowerCase();
      const truth = want === 'truth' || (want !== 'dare' && Math.random() < 0.5);
      const question = truth ? pick(TRUTHS) : pick(DARES);
      cfg.tod = { question, dare: truth ? 'truth' : 'dare', at: new Date() };
      await save(group);

      await reply(
        `🎭 **${truth ? 'TRUTH' : 'DARE'}**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${question}\n\n`
        + `${userDoc.name}, you were handed it. There is no appeal.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'confessionwall',
    aliases: ['gcconfess'],
    category: 'group',
    description: '🕯️ Post a confession to the chat wall, anonymously',
    usage: '!confessionwall <confession>',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'confessionwall', async () => {
      await react('🕯️');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Your confession is safe for now.', event.messageID);
        return;
      }
      const cfg = gcfg(group);

      const text = args.join(' ').trim() || pick(CONFESSIONS);
      if (text.length > 280) {
        await reply('❌ Too long. Confessions cap at 280 characters.', event.messageID);
        return;
      }

      // The uid is stored but never shown. Keeping it server-side is what lets
      // the wall stay anonymous in the chat while still being rate limitable.
      cfg.confessions.push({ uid: String(event.senderID), text, at: new Date() });
      if (cfg.confessions.length > 50) cfg.confessions.splice(0, cfg.confessions.length - 50);
      await save(group);

      await reply(
        `🕯️ **A CONFESSION**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `> ${text}\n\n`
        + `— anonymous, ${cfg.confessions.length} on the wall\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'quotebomb',
    aliases: ['gcquotebomb'],
    category: 'group',
    description: '💣 Ten quotes attributed to random members, none of which they said',
    usage: '!quotebomb',
    cooldown: 60,
    permission: 'all',
    execute: async ({ event, reply, react }) => guard(reply, event.messageID, 'quotebomb', async () => {
      await react('💣');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. The bomb is defused.', event.messageID);
        return;
      }
      const cfg = gcfg(group);

      const hunters = await User.find({ 'gc.lastGroup': String(event.threadID) }).limit(60).lean().catch(() => []);
      if (!hunters || hunters.length < 3) {
        await reply('💣 Not enough hunters here to quote. Come back when the chat has a memory.', event.messageID);
        return;
      }

      const SAYINGS = [
        'I would never do that for money.',
        'The vault was already empty when I got there.',
        'This is my house now.',
        'I read the rules after breaking them.',
        'Somebody owes me a K-Cash.',
        'I have never muted a notification in my life.',
        'The bot said it would be fine.',
        'I ranked this whole chat by coins.',
      ];

      const pool = [...hunters];
      const lines = [];
      for (let i = 0; i < 10 && pool.length; i += 1) {
        const who = pool.splice(rand(0, pool.length - 1), 1)[0];
        lines.push(`${i + 1}. "${pick(SAYINGS)}" — ${who.name}`);
      }

      cfg.msgs = clamp(cfg.msgs) + 10;
      cfg.level = levelFor(cfg.msgs);
      await save(group);

      await reply(
        `💣 **QUOTE BOMB**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n\n`
        + `⚠️ None of them said any of this. That is the joke.\n`
        + `📈 Chat level ${cfg.level} · ${num(cfg.msgs)} messages\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

// ───────────────────────────────────────────────────────────
// PREFIX, RESET AND OWNER APPROVAL
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'setprefixgc',
    aliases: ['gcprefix', 'setgcprefix'],
    category: 'group',
    description: '⬇️ Give this chat its own command prefix',
    usage: '!setprefixgc <prefix|none>',
    cooldown: 10,
    permission: 'groupAdmin',
    execute: async ({ args, config, event, reply, react }) => guard(reply, event.messageID, 'setprefixgc', async () => {
      await react('⬇️');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }

      const raw = String(args[0] || '').trim();
      if (!raw) {
        await reply(
          `⬇️ This chat uses \`${group.prefix || config.PREFIX}\`.\n`
          + 'Use `!setprefixgc none` to fall back to the global prefix.',
          event.messageID,
        );
        return;
      }
      if (['none', 'default', 'reset'].includes(raw.toLowerCase())) {
        group.prefix = null;
        await save(group);
        await reply(`⬇️ Back to the global prefix \`${config.PREFIX}\`.`, event.messageID);
        return;
      }
      if (raw.length > 4) {
        await reply('❌ Keep the prefix to 4 characters or fewer. Somebody has to type it.', event.messageID);
        return;
      }

      group.prefix = raw;
      await save(group);
      await reply(`⬇️ This chat now answers to \`${raw}\` instead of \`${config.PREFIX}\`.\n📖 ${story()}`, event.messageID);
    }),
  });

  commands.push({
    name: 'resetgroup',
    aliases: ['gcreset'],
    category: 'group',
    description: '💥 Wipe every module 6 setting this chat has accumulated',
    usage: '!resetgroup',
    cooldown: 60,
    permission: 'owner',
    execute: async ({ event, reply, react }) => guard(reply, event.messageID, 'resetgroup', async () => {
      await react('💥');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Nothing was reset.', event.messageID);
        return;
      }

      group.gc = {};
      group.settings.welcome = false;
      group.settings.goodbye = false;
      group.settings.welcomeMsg = '';
      group.settings.goodbyeMsg = '';
      group.prefix = null;
      gcfg(group);
      await save(group);

      await reply(
        `💥 **THIS CHAT HAS BEEN RESET.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + '👋 Welcome · 🚪 Goodbye · 📜 Policy\n'
        + '🔗 Ant-link · 🛡️ Anti-raid · ⚔️ Warzone · 🔒 Lockdown\n'
        + '🚫 Bans · 👻 Ghostbans · 🔇 Mutes · 📈 Level · 👑 Domination\n\n'
        + 'All cleared. `!unlockgc` would not have done all of this.\n'
        + `📖 ${OWNER} did not need to be asked twice.`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'approveGC',
    aliases: ['approvegroup', 'gcapprove'],
    category: 'group',
    description: '🎖️ Approve a chat and switch the bot on there',
    usage: '!approveGC [tid]',
    cooldown: 20,
    permission: 'owner',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'approveGC', async () => {
      await react('🎖️');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Nothing was approved.', event.messageID);
        return;
      }

      const tid = String(args[0] || group.tid);
      if (tid !== String(group.tid)) {
        await reply(`❌ This command approves the chat it is run in. That is tid ${group.tid}, not ${tid}.`, event.messageID);
        return;
      }

      group.isApproved = true;
      group.pendingApproval = false;
      group.isEnabled = true;
      await save(group);

      await reply(
        `🎖️ **CHAT APPROVED.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🆔 ${group.tid}\n`
        + `✅ Enabled\n🎖️ Approved\n⏳ Pending: no\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'disapproveGC',
    aliases: ['disapprovegroup', 'gcdisapprove'],
    category: 'group',
    description: '🚫 Pull approval from a chat and pause the bot there',
    usage: '!disapproveGC [reason]',
    cooldown: 20,
    permission: 'owner',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'disapproveGC', async () => {
      await react('🚫');
      const group = await liveGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Nothing changed.', event.messageID);
        return;
      }

      const reason = args.join(' ').trim() || 'no reason given';
      group.isApproved = false;
      group.pendingApproval = true;
      group.isEnabled = false;
      await save(group);

      await reply(
        `🚫 **APPROVAL PULLED.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🆔 ${group.tid}\n`
        + `⏸️ The bot is paused here.\n📖 ${reason}\n`
        + `📖 ${OWNER} revoked it. That is the whole appeal process.`,
        event.messageID,
      );
    }),
  });

module.exports = commands;
