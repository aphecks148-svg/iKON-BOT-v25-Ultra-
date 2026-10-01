'use strict';

/**
 * MODULE 3 — iKON HUNTER ACADEMY (35 commands)
 *
 * iKON City is now a hunter academy. Levels come from chatting, quests and
 * battles. Coins are K-Cash and match the boosted economy from module 2.
 * Prestige is the endgame: rebirth at level 10+ for a permanent +10% income.
 *
 * Exports a plain array. No factories, no legacy loader.
 *
 * Shape required for every command:
 * { name, aliases, category, description, usage, cooldown, permission, execute }
 *
 * execute receives: { api, event, args, config, registry, gemini, reply, react, userDoc }
 * `reply` and `react` are already bound to the current thread, so a command
 * never calls api.sendMessage directly.
 *
 * Every handler is async and internally wrapped in try/catch so a failure is
 * reported to the user instead of escaping into the engine.
 */

const User = require('../models/User');
const Inventory = require('../models/Inventory');
const mongo = require('../bot/mongo');
const { fmt } = require('../bot/helpers');

const CASH = 'K-Cash';

// ───────────────────────────────────────────────────────────
// XP CURVE — level N needs N * 100 XP, so level 10 wants 1000
// ───────────────────────────────────────────────────────────
const xpNeeded = (level) => Math.max(1, level) * 100;

// ───────────────────────────────────────────────────────────
// CLASSES — each grants a passive bonus used by battle/adventure
// ───────────────────────────────────────────────────────────
const CLASSES = {
  warrior: {
    emoji: '⚔️', name: 'Warrior', bonus: '+10% battle win chance',
    blurb: 'Hits first, apologises never.',
  },
  mage: {
    emoji: '🔮', name: 'Mage', bonus: '+25% XP from all sources',
    blurb: 'Burns the academy library for practice.',
  },
  archer: {
    emoji: '🏹', name: 'Archer', bonus: '+15% coin rewards',
    blurb: 'Shoots from very far away, for legal reasons.',
  },
  assassin: {
    emoji: '🗡️', name: 'Assassin', bonus: '+20% duel and rob winnings',
    blurb: 'Was never at the crime. Allegedly.',
  },
};

// ───────────────────────────────────────────────────────────
// SKILLS — learned with !learn for 5,000 K-Cash
// ───────────────────────────────────────────────────────────
const SKILLS = {
  powerstrike: { emoji: '💥', name: 'Power Strike', cost: 5000, effect: '+10% battle win chance' },
  luckycharm: { emoji: '🍀', name: 'Lucky Charm', cost: 5000, effect: '+10% coin rewards' },
  ironwill: { emoji: '🛡️', name: 'Iron Will', cost: 5000, effect: 'Halve battle losses' },
  swiftfoot: { emoji: '💨', name: 'Swift Foot', cost: 5000, effect: '+1 max stamina' },
};

// ───────────────────────────────────────────────────────────
// MONSTERS — level 1 slimes all the way up to level 50 dragons
// ───────────────────────────────────────────────────────────
const MONSTERS = [
  { name: 'Street Slime', emoji: '🟢', level: 1, coin: [200, 400] },
  { name: 'Pigeon Golem', emoji: '🐦', level: 3, coin: [300, 600] },
  { name: 'Sewer Rat King', emoji: '🐀', level: 5, coin: [400, 800] },
  { name: 'Factory Wraith', emoji: '👻', level: 8, coin: [500, 1000] },
  { name: 'Vault Warden', emoji: '🗝️', level: 12, coin: [700, 1400] },
  { name: 'Neon Hydra', emoji: '🐍', level: 18, coin: [900, 1800] },
  { name: 'Casino Baron', emoji: '🎩', level: 25, coin: [1200, 2400] },
  { name: 'Klerk Colossus', emoji: '🗿', level: 35, coin: [1500, 3000] },
  { name: 'iKON Dragon', emoji: '🐉', level: 50, coin: [2000, 4000] },
];

// ───────────────────────────────────────────────────────────
// TITLES — unlocked automatically at level milestones
// ───────────────────────────────────────────────────────────
const TITLES = [
  { level: 5, title: 'Slayer' },
  { level: 10, title: 'Veteran' },
  { level: 20, title: 'Champion' },
  { level: 30, title: 'Legend' },
  { level: 50, title: 'God' },
];

// ───────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────

/** Run a handler with a user-facing safety net. */
async function guard(reply, messageID, label, fn) {
  try {
    await fn();
  } catch (err) {
    await reply(`⚠️ \`${label}\` failed: ${err.message}`, messageID);
  }
}

/** Inclusive random integer. */
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rand(0, arr.length - 1)];
const clamp = (v) => Math.max(0, Math.floor(Number(v) || 0));
const kc = (v) => `${Number(v || 0).toLocaleString('en-US')} ${CASH}`;
const num = (v) => Number(v || 0).toLocaleString('en-US');

/** Small story line so replies feel like a city, not a spreadsheet. */
const story = () => pick([
  'The academy courtyard clock chimes a half hour late.',
  'Training dummies are stacked like firewood by the east wall.',
  'A first-year runs past holding a broken shield.',
  'Instructor Klerk watches from the balcony with a clipboard.',
  'Chalk dust hangs in the training hall light.',
  'Somewhere the kitchens are burning something again.',
  'The noticeboard has a fresh bounty notice pinned crooked.',
  'Bells from the vault district ring without warning.',
]);

/** Persist a profile, tolerating the in-memory (DB offline) profile. */
async function save(userDoc) {
  if (!userDoc || userDoc.transient) return;
  try {
    await userDoc.save();
  } catch { /* the numbers stay visible in the reply either way */ }
}

/** Numeric stat counters, so a missing field backfills to 0 instead of NaN. */
const STAT_FIELDS = [
  'battles', 'wins', 'losses', 'quests', 'bosses',
  'heals', 'duelsWon', 'duelsLost', 'monstersSlain',
];

/** Access the rpg subdocument, creating defaults when it is missing. */
function rpg(userDoc) {
  if (!userDoc.rpg) userDoc.rpg = {};
  if (!userDoc.rpg.stats || typeof userDoc.rpg.stats !== 'object') userDoc.rpg.stats = {};
  // Backfill per field: docs created before the rpg schema landed can carry a
  // partial stats object, and `undefined + 1` would poison the record with NaN.
  for (const field of STAT_FIELDS) {
    if (!Number.isFinite(Number(userDoc.rpg.stats[field]))) userDoc.rpg.stats[field] = 0;
  }
  if (!Array.isArray(userDoc.rpg.skills)) userDoc.rpg.skills = [];
  if (!Array.isArray(userDoc.rpg.titles)) userDoc.rpg.titles = [];
  if (!userDoc.rpg.equipped) userDoc.rpg.equipped = {};
  if (!Number.isFinite(Number(userDoc.rpg.stamina))) userDoc.rpg.stamina = 10;
  else userDoc.rpg.stamina = clamp(userDoc.rpg.stamina);
  return userDoc.rpg;
}

/** The class bonus helpers all read from here, so effects stay in one place. */
function hasSkill(userDoc, id) {
  return rpg(userDoc).skills.includes(id);
}
function hasEquipped(userDoc, itemId) {
  return Boolean(rpg(userDoc).equipped && rpg(userDoc).equipped.get
    ? rpg(userDoc).equipped.get(itemId)
    : rpg(userDoc).equipped[itemId]);
}

/** Permanent prestige income bonus: +10% per rebirth. */
const prestigeBonus = (userDoc) => 1 + clamp(userDoc.prestige) * 0.1;

/** Coin reward with class, skill and prestige multipliers applied. */
function coinReward(userDoc, base) {
  let mult = prestigeBonus(userDoc);
  const c = rpg(userDoc).className;
  if (c === 'archer') mult += 0.15;
  if (hasSkill(userDoc, 'luckycharm')) mult += 0.1;
  return Math.floor(base * mult);
}

/** XP reward with class and skill multipliers applied. */
function xpReward(userDoc, base) {
  let mult = 1;
  if (rpg(userDoc).className === 'mage') mult += 0.25;
  return Math.floor(base * mult);
}

/**
 * Grant XP and roll every level the hunter just earned.
 * Titles are granted on the way past their milestone.
 * @returns {{levels:number, newTitles:string[]}}
 */
async function grantXp(userDoc, amount) {
  const gained = clamp(amount);
  userDoc.xp = clamp((userDoc.xp || 0) + gained);

  const newTitles = [];
  let levels = 0;
  // XP curve grows, so a huge quest can cross several levels at once.
  for (let guard = 0; guard < 200; guard += 1) {
    const needed = xpNeeded(userDoc.level || 1);
    if (userDoc.xp < needed) break;
    userDoc.xp -= needed;
    userDoc.level = clamp((userDoc.level || 1) + 1);
    levels += 1;
    for (const t of TITLES) {
      if ((userDoc.level || 1) >= t.level && !rpg(userDoc).titles.includes(t.title)) {
        rpg(userDoc).titles.push(t.title);
        newTitles.push(t.title);
      }
    }
  }
  return { levels, newTitles };
}

/** Battle win chance: 60% base, nudged by class, gear and skills. */
function winChance(userDoc) {
  let chance = 0.6;
  if (rpg(userDoc).className === 'warrior') chance += 0.1;
  if (hasSkill(userDoc, 'powerstrike')) chance += 0.1;
  if (hasEquipped(userDoc, 'sword')) chance += 0.08;
  if (hasEquipped(userDoc, 'shield')) chance += 0.04;
  return Math.min(0.9, chance);
}

/** Loss penalty, halved by Iron Will and reduced by a defend stance. */
function lossPenalty(userDoc, base) {
  let amount = base;
  if (hasSkill(userDoc, 'ironwill')) amount /= 2;
  const stance = rpg(userDoc).defending;
  if (stance && Date.now() - new Date(stance).getTime() < 30 * 60 * 1000) amount /= 2;
  return Math.max(0, Math.floor(amount));
}

/** Stamina regenerates one point every 10 minutes, up to the cap. */
function refreshStamina(userDoc) {
  const data = rpg(userDoc);
  const last = data.lastStamina ? new Date(data.lastStamina).getTime() : 0;
  if (!last) {
    data.lastStamina = new Date();
    return;
  }
  const gained = Math.floor((Date.now() - last) / (10 * 60 * 1000));
  if (gained <= 0) return;
  const cap = hasSkill(userDoc, 'swiftfoot') ? 11 : 10;
  const before = data.stamina;
  data.stamina = Math.min(cap, before + gained);
  if (data.stamina !== before) data.lastStamina = new Date();
}

/** Milliseconds until a claim timer frees up (0 when ready). */
function claimLeft(userDoc, field, periodMs) {
  const last = userDoc.timers && userDoc.timers[field] ? new Date(userDoc.timers[field]).getTime() : 0;
  if (!last) return 0;
  return Math.max(0, last + periodMs - Date.now());
}

/** Load (or create in memory) an inventory document. */
async function getInv(uid) {
  if (!mongo.isReady()) return { uid, items: [], save: async () => {} };
  try {
    let inv = await Inventory.findOne({ uid });
    if (!inv) inv = await Inventory.create({ uid, items: [] });
    return inv;
  } catch {
    return { uid, items: [], save: async () => {} };
  }
}

/** Remove up to `qty` of an item. @returns {number} how many were removed */
async function removeItem(inv, itemId, qty) {
  const stack = (inv.items || []).find((i) => i.itemId === itemId);
  if (!stack) return 0;
  const taken = Math.min(stack.qty, qty);
  stack.qty -= taken;
  if (stack.qty <= 0) inv.items = inv.items.filter((i) => i.itemId !== itemId);
  await inv.save();
  return taken;
}

/** Resolve a mention, numeric id, or exact name into a User document. */
async function resolveTarget(ref, event) {
  const clean = String(ref || '').replace(/^@/, '').trim();
  if (!clean) return null;

  if (/^\d+$/.test(clean)) return User.findOne({ uid: clean });

  const tagged = event.mentions && Object.values(event.mentions).find((m) => String(m) === clean);
  if (tagged) return User.findOne({ uid: String(tagged) });

  const safe = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return User.findOne({ name: new RegExp(`^${safe}$`, 'i') });
}

/** Resolve a target or explain how to tag someone. */
async function targetOr(reply, messageID, ref, event, label) {
  if (!ref) {
    await reply(`❌ Usage: \`!${label} <user>\` — tag a hunter or use their ID.`, messageID);
    return null;
  }
  const target = await resolveTarget(ref, event);
  if (!target) {
    await reply(`❌ No hunter found for \`${ref}\`.`, messageID);
    return null;
  }
  return target;
}

/** Standard "you levelled up" tail shared by XP commands. */
async function xpTail(userDoc, gained, levels, newTitles) {
  const lines = [`✨ +${num(gained)} XP (${num(userDoc.xp)}/${num(xpNeeded(userDoc.level || 1))} to Lv ${(userDoc.level || 1) + 1})`];
  if (levels > 0) lines.push(`🎉 **LEVEL UP!** Now Level ${userDoc.level}`);
  newTitles.forEach((t) => lines.push(`🏷️ Title unlocked: **${t}**`));
  return lines;
}

module.exports = [
  // ─────────────────────────────────────────────────────────
  // 1
  // ─────────────────────────────────────────────────────────
  {
    name: 'profile',
    aliases: ['prof'],
    category: 'rpg',
    description: '🧬 Your hunter ID card - Level, XP, coins, rank in iKON Academy',
    usage: '!profile',
    cooldown: 10,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'profile', async () => {
      await react('🧬');
      const data = rpg(userDoc);
      refreshStamina(userDoc);
      const cls = CLASSES[data.className];
      const titles = data.titles.length ? data.titles.join(', ') : 'None yet';

      await reply(
        `🧬 **iKON ACADEMY ID CARD**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `👤 ${userDoc.name || 'Hunter'}\n`
        + `📊 Level ${userDoc.level || 1} · ${num(userDoc.xp)}/${num(xpNeeded(userDoc.level || 1))} XP\n`
        + `💰 ${kc(userDoc.coins)}\n`
        + `🎭 Class: ${cls ? `${cls.emoji} ${cls.name}` : 'Unchosen'}\n`
        + `🏷️ Titles: ${titles}\n`
        + `⚡ Stamina: ${data.stamina}/${hasSkill(userDoc, 'swiftfoot') ? 11 : 10}\n`
        + `👑 Prestige: ${clamp(userDoc.prestige)} (+${Math.round((prestigeBonus(userDoc) - 1) * 100)}% income)\n`
        + `${data.bio ? `📝 "${data.bio}"\n` : ''}`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 2
  // ─────────────────────────────────────────────────────────
  {
    name: 'level',
    aliases: [],
    category: 'rpg',
    description: '📊 Check your level progress - How close to next rank?',
    usage: '!level',
    cooldown: 5,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'level', async () => {
      await react('📊');
      const level = userDoc.level || 1;
      const needed = xpNeeded(level);
      const xp = clamp(userDoc.xp);
      const pct = Math.min(100, Math.floor((xp / needed) * 100));
      const filled = Math.round((pct / 100) * 20);
      const bar = `${'█'.repeat(filled)}${'░'.repeat(20 - filled)}`;
      const nextTitle = TITLES.find((t) => t.level > level);

      await reply(
        `📊 **LEVEL ${level}**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${bar} ${pct}%\n`
        + `✨ ${num(xp)}/${num(needed)} XP\n`
        + `🎯 ${num(needed - xp)} XP to Level ${level + 1}\n`
        + (nextTitle ? `🏷️ Next title: ${nextTitle.title} at Lv ${nextTitle.level}\n` : '👑 You have every title.\n')
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 3
  // ─────────────────────────────────────────────────────────
  {
    name: 'rank',
    aliases: [],
    category: 'rpg',
    description: '🏅 Server rank by level - Who is the strongest hunter?',
    usage: '!rank',
    cooldown: 15,
    permission: 'all',
    execute: async ({ reply, react, event }) => guard(reply, event.messageID, 'rank', async () => {
      await react('🏅');
      if (!mongo.isReady()) {
        await reply('💾 Academy records are sealed — database offline.', event.messageID);
        return;
      }
      const board = await User.find({}).sort({ level: -1, xp: -1 }).limit(10).select('name level xp prestige').lean();
      if (!board.length) {
        await reply('🏅 No hunters enrolled yet. Enroll by talking.', event.messageID);
        return;
      }
      const medals = ['🥇', '🥈', '🥉'];
      const lines = board.map((u, i) => {
        const crown = u.prestige ? ` 👑x${u.prestige}` : '';
        return `${medals[i] || `${i + 1}.`} ${u.name} — Lv ${u.level || 1}${crown} (${num(u.xp)} XP)`;
      });

      await reply(
        `🏅 **iKON ACADEMY RANK**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 4
  // ─────────────────────────────────────────────────────────
  {
    name: 'xp',
    aliases: [],
    category: 'rpg',
    description: '✨ Your experience points - Lvl up by chatting and quests',
    usage: '!xp',
    cooldown: 5,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'xp', async () => {
      await react('✨');
      const level = userDoc.level || 1;
      await reply(
        `✨ **${userDoc.name || 'Hunter'}'s EXPERIENCE**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `📊 Level ${level}\n`
        + `✨ ${num(userDoc.xp)} / ${num(xpNeeded(level))} XP\n`
        + `📈 Lifetime: ${num(xpNeeded(level) * (level - 1) + clamp(userDoc.xp))} XP total\n`
        + `🔮 Need ${num(xpNeeded(level))} XP to rank up. Try \`!train\`, \`!quest\` or \`!battle\`.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 5
  // ─────────────────────────────────────────────────────────
  {
    name: 'prestige',
    aliases: [],
    category: 'rpg',
    description: '👑 Rebirth to level 1 but keep +10% coin bonus forever - For true legends',
    usage: '!prestige',
    cooldown: 86400,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'prestige', async () => {
      await react('👑');
      const level = userDoc.level || 1;
      if (level < 10) {
        await reply(
          `👑 The academy refuses. Reach **Level 10** first.\n`
          + `📊 You are Level ${level} — ${num(xpNeeded(level) - clamp(userDoc.xp))} XP short.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const bonus = 10000 * (clamp(userDoc.prestige) + 1);
      const oldLevel = level;
      userDoc.level = 1;
      userDoc.xp = 0;
      userDoc.prestige = clamp(userDoc.prestige) + 1;
      userDoc.coins = clamp((userDoc.coins || 0) + bonus);
      await save(userDoc);

      await reply(
        `👑 **PRESTIGE ${userDoc.prestige}**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `📉 Reset Level ${oldLevel} → 1\n`
        + `💰 Aphecks pays the rebirth bonus: ${kc(bonus)}\n`
        + `📈 Permanent income bonus: +${Math.round((prestigeBonus(userDoc) - 1) * 100)}%\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `🏷️ Titles and gear survive the rebirth.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 6
  // ─────────────────────────────────────────────────────────
  {
    name: 'quest',
    aliases: [],
    category: 'rpg',
    description: '📜 Daily hunt mission - Complete for 2k-5k coins +100 XP',
    usage: '!quest',
    cooldown: 3600,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'quest', async () => {
      await react('📜');
      const data = rpg(userDoc);
      if (data.stamina < 1) {
        await reply('⚡ You are out of stamina. It refills 1 per 10 minutes.', event.messageID);
        return;
      }

      const mission = pick([
        'Clear the slime infestation under the west bridge.',
        'Escort the Klerk courier across the factory floor.',
        'Recover three stolen vault ledgers from the pawn shop.',
        'Drive the gulls off the Klerk office roof. Again.',
        'Hunt the neon beast loose in the casino basement.',
        'Tag every patrol lantern in the old district.',
        'Free the trapped cat from the bank ventilation shaft.',
      ]);
      const coins = coinReward(userDoc, rand(2000, 5000));
      const xp = xpReward(userDoc, 100);

      data.stamina -= 1;
      data.lastStamina = new Date();
      data.stats.quests += 1;
      userDoc.coins = clamp((userDoc.coins || 0) + coins);
      const { levels, newTitles } = await grantXp(userDoc, xp);
      await save(userDoc);

      await reply(
        `📜 **QUEST COMPLETE**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🎯 ${mission}\n`
        + `💰 +${kc(coins)}\n`
        + `${(await xpTail(userDoc, xp, levels, newTitles)).join('\n')}\n`
        + `⚡ Stamina: ${data.stamina}/${hasSkill(userDoc, 'swiftfoot') ? 11 : 10}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 7
  // ─────────────────────────────────────────────────────────
  {
    name: 'dailyquest',
    aliases: ['dq'],
    category: 'rpg',
    description: '🗓️ Same as quest - New mission every day',
    usage: '!dailyquest',
    cooldown: 3600,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'dailyquest', async () => {
      await react('🗓️');
      const data = rpg(userDoc);

      const left = claimLeft(userDoc, 'quest', 86400000);
      if (left > 0) {
        await reply(
          `🗓️ You already ran today's mission. A new one posts in ${fmt.dur(Math.ceil(left / 1000))}.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }
      if (data.stamina < 1) {
        await reply('⚡ No stamina. It refills 1 per 10 minutes.', event.messageID);
        return;
      }

      const mission = pick([
        'Stand guard at the vault while Klerk counts the money.',
        'Deliver a potion to the healer on the roof.',
        'Duel practice: ten dummies, no excuses.',
        'Chart the new monster nest outside the water towers.',
        'Auctioneer duty: sell a stranger\'s junk for commission.',
      ]);
      const coins = coinReward(userDoc, rand(2000, 5000));
      const xp = xpReward(userDoc, 100);

      if (!userDoc.timers) userDoc.timers = {};
      userDoc.timers.quest = new Date();
      data.stamina -= 1;
      data.lastStamina = new Date();
      data.stats.quests += 1;
      userDoc.coins = clamp((userDoc.coins || 0) + coins);
      const { levels, newTitles } = await grantXp(userDoc, xp);
      await save(userDoc);

      await reply(
        `🗓️ **DAILY MISSION**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🎯 ${mission}\n`
        + `💰 +${kc(coins)}\n`
        + `${(await xpTail(userDoc, xp, levels, newTitles)).join('\n')}\n`
        + `📆 Come back tomorrow for a new posting.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 8
  // ─────────────────────────────────────────────────────────
  {
    name: 'adventure',
    aliases: ['adv'],
    category: 'rpg',
    description: '🗺️ Go on adventure - Random rewards 500-3000, risk injury',
    usage: '!adventure',
    cooldown: 300,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'adventure', async () => {
      await react('🗺️');
      const data = rpg(userDoc);
      refreshStamina(userDoc);
      if (data.stamina < 1) {
        await reply('⚡ Too tired to wander. Stamina refills 1 per 10 minutes.', event.messageID);
        return;
      }

      const place = pick([
        'the collapsed metro spur below the market',
        'a rooftop you should not be standing on',
        'the flooded basement of the old arcade',
        'the woods past the water towers',
        'a cargo lift that stopped eleven floors short',
        'the Klerk family vault, briefly and by accident',
      ]);
      data.stamina -= 1;
      data.lastStamina = new Date();

      if (Math.random() < 0.25) {
        const injury = lossPenalty(userDoc, rand(200, 600));
        userDoc.coins = clamp((userDoc.coins || 0) - injury);
        await save(userDoc);
        await reply(
          `🗺️ You set out toward ${place}.\n`
          + `🩹 Something found you first. Injury bill: ${kc(injury)}.\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const coins = coinReward(userDoc, rand(500, 3000));
      const xp = xpReward(userDoc, rand(50, 150));
      userDoc.coins = clamp((userDoc.coins || 0) + coins);
      const { levels, newTitles } = await grantXp(userDoc, xp);
      await save(userDoc);

      const find = pick([
        'A crate of unclaimed K-Cash behind a dead vending machine.',
        'A Klerk badge somebody dropped in a hurry.',
        'Half a dragon scale, which is still a scale.',
        'An abandoned locker with a very light wallet inside.',
        'A shortcut through a door somebody left unlocked.',
      ]);

      await reply(
        `🗺️ You set out toward ${place}.\n`
        + `🔎 ${find}\n`
        + `💰 +${kc(coins)}\n`
        + `${(await xpTail(userDoc, xp, levels, newTitles)).join('\n')}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 9
  // ─────────────────────────────────────────────────────────
  {
    name: 'train',
    aliases: [],
    category: 'rpg',
    description: '💪 Train at academy - +50 XP +500 coins, 1h cooldown',
    usage: '!train',
    cooldown: 3600,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'train', async () => {
      await react('💪');
      const coins = coinReward(userDoc, 500);
      const xp = xpReward(userDoc, 50);
      userDoc.coins = clamp((userDoc.coins || 0) + coins);
      const { levels, newTitles } = await grantXp(userDoc, xp);
      await save(userDoc);

      await reply(
        `💪 Three hours of drills, two of stairs, one very sore arm.\n`
        + `💰 +${kc(coins)}\n`
        + `${(await xpTail(userDoc, xp, levels, newTitles)).join('\n')}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 10
  // ─────────────────────────────────────────────────────────
  {
    name: 'battle',
    aliases: ['fight'],
    category: 'rpg',
    description: '⚔️ Battle wild monster - Win coins + XP, lose -100 coins',
    usage: '!battle',
    cooldown: 60,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'battle', async () => {
      await react('⚔️');
      const data = rpg(userDoc);
      const pool = MONSTERS.filter((m) => m.level <= (userDoc.level || 1) + 3);
      const monster = pool.length ? pick(pool) : MONSTERS[0];

      data.stats.battles += 1;
      const chance = winChance(userDoc);
      const roll = Math.random();

      if (roll < chance) {
        const coins = coinReward(userDoc, rand(500, 2000));
        const xp = xpReward(userDoc, 100);
        data.stats.wins += 1;
        data.stats.monstersSlain += 1;
        data.defending = null;
        userDoc.coins = clamp((userDoc.coins || 0) + coins);
        const { levels, newTitles } = await grantXp(userDoc, xp);
        await save(userDoc);

        await reply(
          `⚔️ **VICTORY** — ${monster.emoji} ${monster.name} (Lv ${monster.level})\n`
          + '━━━━━━━━━━━━━━━\n'
          + `📊 Win chance: ${Math.round(chance * 100)}% · Roll ${Math.round(roll * 100)}%\n`
          + `💰 +${kc(coins)}\n`
          + `${(await xpTail(userDoc, xp, levels, newTitles)).join('\n')}\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const loss = lossPenalty(userDoc, 100);
      data.stats.losses += 1;
      data.defending = null;
      userDoc.coins = clamp((userDoc.coins || 0) - loss);
      const xp = xpReward(userDoc, 20);
      const { levels, newTitles } = await grantXp(userDoc, xp);
      await save(userDoc);

      await reply(
        `🩸 **DEFEAT** — ${monster.emoji} ${monster.name} (Lv ${monster.level})\n`
        + '━━━━━━━━━━━━━━━\n'
        + `📊 Win chance: ${Math.round(chance * 100)}% · Roll ${Math.round(roll * 100)}%\n`
        + `💸 -${kc(loss)}\n`
        + `${(await xpTail(userDoc, xp, levels, newTitles)).join('\n')}\n`
        + `🛡️ Try \`!equip\` a sword or \`!train\` for a better roll.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 11
  // ─────────────────────────────────────────────────────────
  {
    name: 'attack',
    aliases: [],
    category: 'rpg',
    description: '🗡️ Quick attack - 70% hit chance',
    usage: '!attack',
    cooldown: 60,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'attack', async () => {
      await react('🗡️');
      const data = rpg(userDoc);
      let chance = 0.7;
      if (hasEquipped(userDoc, 'sword')) chance += 0.1;
      if (hasSkill(userDoc, 'powerstrike')) chance += 0.1;
      chance = Math.min(0.95, chance);

      const hit = Math.random() < chance;
      if (!hit) {
        data.stats.battles += 1;
        data.stats.losses += 1;
        await save(userDoc);
        await reply(
          `🗡️ You swing at nothing. It was a very confident miss.\n`
          + `📊 Hit chance ${Math.round(chance * 100)}% — missed.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const crit = Math.random() < 0.2;
      const base = crit ? rand(800, 1500) : rand(300, 800);
      const coins = coinReward(userDoc, base);
      const xp = xpReward(userDoc, crit ? 80 : 40);
      data.stats.battles += 1;
      data.stats.wins += 1;
      userDoc.coins = clamp((userDoc.coins || 0) + coins);
      const { levels, newTitles } = await grantXp(userDoc, xp);
      await save(userDoc);

      await reply(
        `🗡️ ${crit ? '💥 **CRITICAL HIT!**' : '✅ Hit.'} Your ${hasEquipped(userDoc, 'sword') ? 'iKON Sword' : 'fists'} land clean.\n`
        + `📊 Hit chance ${Math.round(chance * 100)}%${crit ? ' · Critical 20%' : ''}\n`
        + `💰 +${kc(coins)}\n`
        + `${(await xpTail(userDoc, xp, levels, newTitles)).join('\n')}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 12
  // ─────────────────────────────────────────────────────────
  {
    name: 'defend',
    aliases: [],
    category: 'rpg',
    description: '🛡️ Defend stance - Reduce next damage 50%',
    usage: '!defend',
    cooldown: 300,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'defend', async () => {
      await react('🛡️');
      const data = rpg(userDoc);
      data.defending = new Date();
      await save(userDoc);

      const gear = hasEquipped(userDoc, 'shield') ? ' Your shield is already up.\n' : '';
      await reply(
        `🛡️ You drop into a defensive stance behind a rain barrel.${gear ? '' : '\n'}🛡️ **Next damage taken is halved.** Stance lasts 30 minutes.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 13
  // ─────────────────────────────────────────────────────────
  {
    name: 'heal',
    aliases: [],
    category: 'rpg',
    description: '💚 Use potion or 500 coins to heal - Restores for battle',
    usage: '!heal',
    cooldown: 300,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'heal', async () => {
      await react('💚');
      const data = rpg(userDoc);
      const cost = coinReward(userDoc, 500);
      const inv = await getInv(userDoc.uid);
      const used = await removeItem(inv, 'potion', 1);
      const source = used ? '🧪 A potion from the black market.' : `🏥 Healer took ${kc(cost)}.`;

      if (!used) {
        if ((userDoc.coins || 0) < cost) {
          await reply(
            '❌ No potion in your bag and not enough K-Cash to pay the healer.\n'
            + `🧪 Buy one with \`!buy potion\` (1,000 K-Cash in \`!shop\`).\n`
            + `👛 Wallet: ${kc(userDoc.coins)}`,
            event.messageID,
          );
          return;
        }
        userDoc.coins = clamp((userDoc.coins || 0) - cost);
      }

      data.stats.heals += 1;
      data.defending = null;
      const xp = xpReward(userDoc, 10);
      const { levels, newTitles } = await grantXp(userDoc, xp);
      await save(userDoc);

      await reply(
        `💚 ${source}\n`
        + `🩹 Patched up and back on your feet.\n`
        + `${(await xpTail(userDoc, xp, levels, newTitles)).join('\n')}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 14
  // ─────────────────────────────────────────────────────────
  {
    name: 'stats',
    aliases: ['mystats'],
    category: 'rpg',
    description: '📈 Your fight stats - Wins, losses, messages sent',
    usage: '!stats',
    cooldown: 10,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'stats', async () => {
      await react('📈');
      const data = rpg(userDoc);
      const s = data.stats;
      const total = clamp(s.battles);
      const rate = total ? Math.round((s.wins / total) * 100) : 0;

      await reply(
        `📈 **${userDoc.name || 'Hunter'} — FIGHT RECORD**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `⚔️ Battles: ${num(total)}\n`
        + `🏆 Wins: ${num(s.wins)}\n`
        + `🩸 Losses: ${num(s.losses)}\n`
        + `📊 Win rate: ${rate}%\n`
        + `📜 Quests: ${num(s.quests)}\n`
        + `👹 Bosses: ${num(s.bosses)}\n`
        + `👾 Slain: ${num(s.monstersSlain)}\n`
        + `🤺 Duels won/lost: ${num(s.duelsWon)}/${num(s.duelsLost)}\n`
        + `💚 Heals: ${num(s.heals)}\n`
        + `💬 Messages sent: ${num(userDoc.stats ? userDoc.stats.messages : 0)}\n`
        + `🎯 Commands used: ${num(userDoc.stats ? userDoc.stats.commandsUsed : 0)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 15
  // ─────────────────────────────────────────────────────────
  {
    name: 'leaderboardrpg',
    aliases: ['rlb', 'toprpg'],
    category: 'rpg',
    description: '🏆 Top hunters by level - Hall of Fame',
    usage: '!leaderboardrpg',
    cooldown: 15,
    permission: 'all',
    execute: async ({ reply, react, event }) => guard(reply, event.messageID, 'leaderboardrpg', async () => {
      await react('🏆');
      if (!mongo.isReady()) {
        await reply('💾 The Hall of Fame is sealed — database offline.', event.messageID);
        return;
      }
      const board = await User.find({ level: { $gt: 1 } })
        .sort({ level: -1, xp: -1 })
        .limit(10)
        .select('name level xp prestige')
        .lean();
      if (!board.length) {
        await reply('🏆 Nobody has ranked up yet. Be the first, do a quest.', event.messageID);
        return;
      }
      const medals = ['🥇', '🥈', '🥉'];
      const lines = board.map((u, i) => {
        const crown = u.prestige ? ` 👑x${u.prestige}` : '';
        return `${medals[i] || `${i + 1}.`} ${u.name} — Lv ${u.level || 1}${crown}`;
      });

      await reply(
        `🏆 **HALL OF FAME**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n`
        + `📜 Engraved on the academy's front wall.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 16
  // ─────────────────────────────────────────────────────────
  {
    name: 'class',
    aliases: ['classes'],
    category: 'rpg',
    description: '🎭 Choose hunter class - Warrior, Mage, Archer, Assassin',
    usage: '!class',
    cooldown: 10,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'class', async () => {
      await react('🎭');
      const current = CLASSES[rpg(userDoc).className];
      const lines = Object.entries(CLASSES).map(([id, c]) => (
        `${c.emoji} **${c.name}** — ${c.bonus}\n   \`!selectclass ${id}\``
      ));

      await reply(
        `🎭 **HUNTER CLASSES**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n`
        + (current ? `✅ Yours: ${current.emoji} ${current.name} (${current.bonus})` : '📋 You have not chosen. The registrar is waiting.')
        + `\n📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 17
  // ─────────────────────────────────────────────────────────
  {
    name: 'selectclass',
    aliases: ['setclass'],
    category: 'rpg',
    description: '✅ Lock your class - Each class has unique bonus',
    usage: '!selectclass <warrior | mage | archer | assassin>',
    cooldown: 60,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'selectclass', async () => {
      await react('✅');
      const data = rpg(userDoc);
      const choice = String(args[0] || '').toLowerCase().trim();
      const cls = CLASSES[choice];
      if (!cls) {
        await reply(
          `❌ Pick one of: ${Object.keys(CLASSES).map((k) => `\`${k}\``).join(', ')}\n`
          + '🎭 Full breakdown: `!class`',
          event.messageID,
        );
        return;
      }
      if (data.className === choice) {
        await reply(`✅ You are already a ${cls.emoji} ${cls.name}.`, event.messageID);
        return;
      }
      if (data.className) {
        await reply(
          `🚪 The registrar refuses: you already chose ${CLASSES[data.className].name}.\n`
          + `👑 Only prestige can change a hunter's class — reset your level with \`!prestige\`.`,
          event.messageID,
        );
        return;
      }

      data.className = choice;
      await save(userDoc);

      await reply(
        `✅ **CLASS LOCKED: ${cls.emoji} ${cls.name}**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🎁 Bonus: ${cls.bonus}\n`
        + `📖 "${cls.blurb}" — Instructor Klerk\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 18
  // ─────────────────────────────────────────────────────────
  {
    name: 'skill',
    aliases: ['skills'],
    category: 'rpg',
    description: '🔮 Your skills - Class-based powers',
    usage: '!skill',
    cooldown: 10,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'skill', async () => {
      await react('🔮');
      const data = rpg(userDoc);
      const owned = data.skills.filter((id) => SKILLS[id]);
      const cls = CLASSES[data.className];

      const learned = owned.length
        ? owned.map((id) => `${SKILLS[id].emoji} **${SKILLS[id].name}** — ${SKILLS[id].effect}`).join('\n')
        : 'None yet. The academy library is patient.';

      await reply(
        `🔮 **${userDoc.name || 'Hunter'}'S SKILLS**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${learned}\n`
        + (cls ? `🎭 Class power (${cls.name}): ${cls.bonus}` : '🎭 No class chosen yet — \`!class\`')
        + `\n📚 Learn more with \`!learn\`\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 19
  // ─────────────────────────────────────────────────────────
  {
    name: 'learn',
    aliases: ['learnskill'],
    category: 'rpg',
    description: '📚 Learn new skill for 5k coins',
    usage: '!learn <powerstrike | luckycharm | ironwill | swiftfoot>',
    cooldown: 60,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'learn', async () => {
      await react('📚');
      const data = rpg(userDoc);
      const id = String(args[0] || '').toLowerCase().trim();
      const skill = SKILLS[id];
      if (!skill) {
        await reply(
          `❌ Pick a skill: ${Object.keys(SKILLS).map((k) => `\`${k}\``).join(', ')}\n`
          + `📚 Current skills: \`!skill\``,
          event.messageID,
        );
        return;
      }
      if (data.skills.includes(id)) {
        await reply(`📚 You already know ${skill.emoji} **${skill.name}**.`, event.messageID);
        return;
      }
      const cost = coinReward(userDoc, 5000);
      if ((userDoc.coins || 0) < cost) {
        await reply(
          `❌ The library wants ${kc(cost)}.\n`
          + `👛 Wallet: ${kc(userDoc.coins)}`,
          event.messageID,
        );
        return;
      }

      userDoc.coins = clamp(userDoc.coins - cost);
      data.skills.push(id);
      const xp = xpReward(userDoc, 75);
      const { levels, newTitles } = await grantXp(userDoc, xp);
      await save(userDoc);

      await reply(
        `📚 **Learned ${skill.emoji} ${skill.name}!**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🎁 Effect: ${skill.effect}\n`
        + `💸 Cost: ${kc(cost)}\n`
        + `${(await xpTail(userDoc, xp, levels, newTitles)).join('\n')}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 20
  // ─────────────────────────────────────────────────────────
  {
    name: 'inventoryrpg',
    aliases: ['rpginv'],
    category: 'rpg',
    description: '🎒 RPG inventory - Potions, weapons from shop',
    usage: '!inventoryrpg',
    cooldown: 5,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'inventoryrpg', async () => {
      await react('🎒');
      const inv = await getInv(userDoc.uid);
      const items = (inv.items || []).filter((i) => i.qty > 0);
      const data = rpg(userDoc);

      if (!items.length) {
        await reply(
          '🎒 Your RPG pack is empty.\n'
          + '🛒 Gear lives in the black market: `!shop` — potions heal, swords win fights.',
          event.messageID,
        );
        return;
      }

      const NAMES = {
        sword: { emoji: '⚔️', name: 'iKON Sword' },
        shield: { emoji: '🛡️', name: 'Vault Shield' },
        potion: { emoji: '🧪', name: 'iKON Potion' },
        diamond: { emoji: '💎', name: 'K-Crystal Diamond' },
      };
      const lines = items.map((i) => {
        const meta = NAMES[i.itemId] || { emoji: '📦', name: i.itemId };
        const on = hasEquipped(userDoc, i.itemId) ? ' ⭐ EQUIPPED' : '';
        return `${meta.emoji} **${meta.name}** x${i.qty}${on}`;
      });

      await reply(
        `🎒 **${userDoc.name || 'Hunter'}'S RPG PACK**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n`
        + `⚔️ Equip with \`!equip <item>\`, take off with \`!unequip <item>\`\n`
        + `🧪 \`!heal\` drinks a potion\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 21
  // ─────────────────────────────────────────────────────────
  {
    name: 'equip',
    aliases: [],
    category: 'rpg',
    description: '⚔️ Equip sword/shield - Boost battle win chance',
    usage: '!equip <item>',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'equip', async () => {
      await react('⚔️');
      const data = rpg(userDoc);
      const itemId = String(args[0] || '').toLowerCase().trim();
      if (!['sword', 'shield'].includes(itemId)) {
        await reply('❌ Usage: `!equip <sword | shield>` — potions are drunk, not equipped.', event.messageID);
        return;
      }

      const inv = await getInv(userDoc.uid);
      const stack = (inv.items || []).find((i) => i.itemId === itemId && i.qty > 0);
      if (!stack) {
        await reply(`❌ You do not own a ${itemId}. Buy one in \`!shop\`.`, event.messageID);
        return;
      }

      data.equipped.set(itemId, true);
      await save(userDoc);

      const names = { sword: '⚔️ iKON Sword', shield: '🛡️ Vault Shield' };
      await reply(
        `⚔️ Equipped **${names[itemId]}**.\n`
        + `📊 Battle win chance is now ${Math.round(winChance(userDoc) * 100)}%.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 22
  // ─────────────────────────────────────────────────────────
  {
    name: 'unequip',
    aliases: [],
    category: 'rpg',
    description: '📦 Unequip gear',
    usage: '!unequip <item>',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'unequip', async () => {
      await react('📦');
      const data = rpg(userDoc);
      const itemId = String(args[0] || '').toLowerCase().trim();
      if (!['sword', 'shield'].includes(itemId)) {
        await reply('❌ Usage: `!unequip <sword | shield>`', event.messageID);
        return;
      }
      if (!hasEquipped(userDoc, itemId)) {
        await reply(`📦 You are not wearing the ${itemId} anyway.`, event.messageID);
        return;
      }

      data.equipped.set(itemId, false);
      await save(userDoc);

      await reply(
        `📦 Stowed your ${itemId}.\n`
        + `📊 Battle win chance back to ${Math.round(winChance(userDoc) * 100)}%.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 23
  // ─────────────────────────────────────────────────────────
  {
    name: 'boss',
    aliases: [],
    category: 'rpg',
    description: '👹 Fight iKON Boss - Need lvl 5+, reward 10k if win',
    usage: '!boss',
    cooldown: 1800,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'boss', async () => {
      await react('👹');
      const level = userDoc.level || 1;
      if (level < 5) {
        await reply(
          `👹 The boss chamber door does not open for you.\n`
          + `📊 You need **Level 5+** and you are Level ${level}.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const data = rpg(userDoc);
      const bosses = [
        { name: 'Klerk the Iron', emoji: '🤖', lvl: 10 },
        { name: 'Madame Vault', emoji: '🗝️', lvl: 20 },
        { name: 'Aphecks, Unbound', emoji: '👑', lvl: 40 },
      ];
      const boss = pick(bosses.filter((b) => b.lvl <= level + 15)) || bosses[0];

      data.stats.battles += 1;
      let chance = winChance(userDoc);
      // Under-levelled hunters take the boss seriously and lose more often.
      if (level < boss.lvl) chance -= 0.1;
      chance = Math.max(0.2, chance);

      if (Math.random() < chance) {
        const coins = coinReward(userDoc, 10000);
        const xp = xpReward(userDoc, 500);
        data.stats.wins += 1;
        data.stats.bosses += 1;
        data.defending = null;
        userDoc.coins = clamp((userDoc.coins || 0) + coins);
        const { levels, newTitles } = await grantXp(userDoc, xp);
        await save(userDoc);

        await reply(
          `👹 **BOSS DOWN — ${boss.emoji} ${boss.name} (Lv ${boss.lvl})**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `📊 Win chance ${Math.round(chance * 100)}%\n`
          + `💰 +${kc(coins)}\n`
          + `${(await xpTail(userDoc, xp, levels, newTitles)).join('\n')}\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 The chamber lights come back up. ${story()}`,
          event.messageID,
        );
        return;
      }

      const loss = lossPenalty(userDoc, 500);
      data.stats.losses += 1;
      data.defending = null;
      userDoc.coins = clamp((userDoc.coins || 0) - loss);
      await save(userDoc);

      await reply(
        `🩸 **BOSS WINS — ${boss.emoji} ${boss.name} (Lv ${boss.lvl})**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `📊 Win chance ${Math.round(chance * 100)}% — it was not enough.\n`
        + `💸 -${kc(loss)}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `🛡️ Equip gear, pick a stronger class, then go back in.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 24
  // ─────────────────────────────────────────────────────────
  {
    name: 'duel',
    aliases: [],
    category: 'rpg',
    description: '🤺 Duel @user - Winner takes 1k from loser',
    usage: '!duel <user>',
    cooldown: 300,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'duel', async () => {
      await react('🤺');
      const data = rpg(userDoc);
      const target = await targetOr(reply, event.messageID, args[0], event, 'duel');
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ Dueling yourself is a strong sign. Seek help at the academy clinic.', event.messageID);
        return;
      }

      const stake = 1000;
      const odds = winChance(userDoc) + (data.stats.duelsWon - data.stats.duelsLost) * 0.02;
      const chance = Math.max(0.2, Math.min(0.85, odds));

      data.stats.battles += 1;
      if (Math.random() < chance) {
        const won = coinReward(userDoc, stake);
        data.stats.wins += 1;
        data.stats.duelsWon += 1;
        userDoc.coins = clamp((userDoc.coins || 0) + won);
        target.coins = clamp((target.coins || 0) - stake);
        data.defending = null;
        await save(userDoc);
        if (!target.transient) {
          try { await target.save(); } catch { /* your winnings still count */ }
        }

        await reply(
          `🤺 **YOU WIN** vs ${target.name}!\n`
          + '━━━━━━━━━━━━━━━\n'
          + `📊 Win chance ${Math.round(chance * 100)}%\n`
          + `💰 +${kc(won)} taken from the loser\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const loss = lossPenalty(userDoc, stake);
      data.stats.losses += 1;
      data.stats.duelsLost += 1;
      userDoc.coins = clamp((userDoc.coins || 0) - loss);
      target.coins = clamp((target.coins || 0) + loss);
      data.defending = null;
      await save(userDoc);
      if (!target.transient) {
        try { await target.save(); } catch { /* the loss still counts */ }
      }

      await reply(
        `🤺 **YOU LOSE** to ${target.name}.\n`
        + '━━━━━━━━━━━━━━━\n'
        + `📊 Win chance ${Math.round(chance * 100)}%\n`
        + `💸 -${kc(loss)}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `🩸 Duel record: ${num(data.stats.duelsWon)}W / ${num(data.stats.duelsLost)}L\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 25
  // ─────────────────────────────────────────────────────────
  {
    name: 'pvp',
    aliases: [],
    category: 'rpg',
    description: '⚔️ Same as duel - PvP arena',
    usage: '!pvp <user>',
    cooldown: 300,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'pvp', async () => {
      await react('⚔️');
      const data = rpg(userDoc);
      const target = await targetOr(reply, event.messageID, args[0], event, 'pvp');
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ The arena does not accept fights against yourself.', event.messageID);
        return;
      }

      // The arena is a coin-flip with the loser paying a 200 entry fee.
      const entry = 200;
      if ((userDoc.coins || 0) < entry || (target.coins || 0) < entry) {
        await reply(`❌ Both fighters need ${kc(entry)} to enter the arena.`, event.messageID);
        return;
      }

      const chance = Math.max(0.25, Math.min(0.8, winChance(userDoc)));
      data.stats.battles += 1;

      const roll = Math.random() < chance;
      if (roll) {
        const purse = coinReward(userDoc, entry * 3);
        data.stats.wins += 1;
        data.stats.duelsWon += 1;
        userDoc.coins = clamp((userDoc.coins || 0) + purse - entry);
        target.coins = clamp((target.coins || 0) - entry);
        data.defending = null;
        await save(userDoc);
        if (!target.transient) {
          try { await target.save(); } catch { /* arena payout still lands */ }
        }

        await reply(
          `⚔️ **ARENA VICTORY** vs ${target.name}\n`
          + '━━━━━━━━━━━━━━━\n'
          + `🏟️ Win chance ${Math.round(chance * 100)}%\n`
          + `💰 +${kc(purse)} purse, ${kc(entry)} entry\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 The crowd does not cheer for you. ${story()}`,
          event.messageID,
        );
        return;
      }

      const loss = lossPenalty(userDoc, entry * 2);
      data.stats.losses += 1;
      data.stats.duelsLost += 1;
      userDoc.coins = clamp((userDoc.coins || 0) - loss);
      target.coins = clamp((target.coins || 0) + entry);
      data.defending = null;
      await save(userDoc);
      if (!target.transient) {
        try { await target.save(); } catch { /* the fee still transfers */ }
      }

      await reply(
        `🩸 **ARENA DEFEAT** vs ${target.name}\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🏟️ Win chance ${Math.round(chance * 100)}%\n`
        + `💸 -${kc(loss)}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 The sand absorbs the blood and the crowd moves on. ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 26
  // ─────────────────────────────────────────────────────────
  {
    name: 'monster',
    aliases: ['monsters'],
    category: 'rpg',
    description: '👾 List monsters - From slime lvl1 to dragon lvl50',
    usage: '!monster',
    cooldown: 10,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'monster', async () => {
      await react('👾');
      const level = userDoc.level || 1;
      const lines = MONSTERS.map((m) => {
        const tag = m.level <= level ? '✅ huntable' : m.level <= level + 3 ? '⚠️ risky' : '🔒 locked';
        return `${m.emoji} **${m.name}** — Lv ${m.level} · ${kc(m.coin[0])}-${kc(m.coin[1])} · ${tag}`;
      });

      await reply(
        `👾 **iKON BESTIARY** (you are Level ${level})\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n`
        + `⚔️ Fight one with \`!battle\`.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 27
  // ─────────────────────────────────────────────────────────
  {
    name: 'huntboss',
    aliases: ['hb'],
    category: 'rpg',
    description: '🐉 Hunt random boss - Scales with your level',
    usage: '!huntboss',
    cooldown: 1800,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'huntboss', async () => {
      await react('🐉');
      const level = userDoc.level || 1;
      const data = rpg(userDoc);

      const scale = rand(0, 5) * 5;
      const bossLevel = Math.max(1, level + scale);
      const bossPool = MONSTERS.filter((m) => Math.abs(m.level - bossLevel) <= 10);
      const boss = pick(bossPool.length ? bossPool : [MONSTERS[MONSTERS.length - 1]]);

      let chance = winChance(userDoc);
      if (bossLevel > level) chance -= 0.05 * Math.ceil((bossLevel - level) / 5);
      chance = Math.max(0.15, chance);

      data.stats.battles += 1;
      if (Math.random() < chance) {
        const coins = coinReward(userDoc, rand(2000, 5000) + bossLevel * 200);
        const xp = xpReward(userDoc, 200 + bossLevel * 10);
        data.stats.wins += 1;
        data.stats.bosses += 1;
        userDoc.coins = clamp((userDoc.coins || 0) + coins);
        const { levels, newTitles } = await grantXp(userDoc, xp);
        await save(userDoc);

        await reply(
          `🐉 **SLAINED ${boss.emoji} ${boss.name}** (Lv ${boss.level})\n`
          + '━━━━━━━━━━━━━━━\n'
          + `📊 Win chance ${Math.round(chance * 100)}%\n`
          + `💰 +${kc(coins)}\n`
          + `${(await xpTail(userDoc, xp, levels, newTitles)).join('\n')}\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const loss = lossPenalty(userDoc, 600);
      data.stats.losses += 1;
      userDoc.coins = clamp((userDoc.coins || 0) - loss);
      const xp = xpReward(userDoc, 40);
      const { levels, newTitles } = await grantXp(userDoc, xp);
      await save(userDoc);

      await reply(
        `🩸 **${boss.emoji} ${boss.name} (Lv ${boss.level}) FLIES AWAY**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `📊 Win chance ${Math.round(chance * 100)}%\n`
        + `💸 -${kc(loss)}\n`
        + `${(await xpTail(userDoc, xp, levels, newTitles)).join('\n')}\n`
        + `🛡️ Gear and levels win hunts.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 28
  // ─────────────────────────────────────────────────────────
  {
    name: 'healme',
    aliases: [],
    category: 'rpg',
    description: '💉 Emergency heal - Free once per hour',
    usage: '!healme',
    cooldown: 60,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'healme', async () => {
      await react('💉');
      const left = claimLeft(userDoc, 'healme', 3600000);
      if (left > 0) {
        await reply(
          `💉 The clinic already patched you up.\n`
          + `⏳ Free healing again in ${fmt.dur(Math.ceil(left / 1000))}.\n`
          + `🧪 Or carry potions: \`!shop\` → \`!buy potion\`.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      if (!userDoc.timers) userDoc.timers = {};
      userDoc.timers.healme = new Date();
      const data = rpg(userDoc);
      data.stats.heals += 1;
      data.defending = null;
      await save(userDoc);

      await reply(
        `💉 **FREE HEAL** — the academy medic did not charge you.\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🩹 Wounds closed, stance cleared.\n`
        + `⏳ One free heal per hour.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 29
  // ─────────────────────────────────────────────────────────
  {
    name: 'stamina',
    aliases: [],
    category: 'rpg',
    description: '⚡ Your energy - Needed for adventures, refills 1 per 10min',
    usage: '!stamina',
    cooldown: 5,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'stamina', async () => {
      await react('⚡');
      const data = rpg(userDoc);
      refreshStamina(userDoc);
      const cap = hasSkill(userDoc, 'swiftfoot') ? 11 : 10;
      await save(userDoc);

      const last = data.lastStamina ? new Date(data.lastStamina).getTime() : Date.now();
      const untilNext = Math.max(0, last + 10 * 60 * 1000 - Date.now());

      await reply(
        `⚡ **STAMINA ${data.stamina}/${cap}**\n`
        + '━━━━━━━━━━━━━━━\n'
        + '━'.repeat(data.stamina) + '░'.repeat(Math.max(0, cap - data.stamina)) + '\n'
        + (data.stamina >= cap
          ? '✅ Fully rested. Go burn it on something.'
          : `⏳ +1 stamina in ${fmt.dur(Math.ceil(untilNext / 1000))}`)
        + `\n🥾 Spent by \`!adventure\` and \`!quest\`.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 30
  // ─────────────────────────────────────────────────────────
  {
    name: 'rebirth',
    aliases: [],
    category: 'rpg',
    description: '🔄 Same as prestige - Reset to 1 with permanent bonus',
    usage: '!rebirth',
    cooldown: 86400,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'rebirth', async () => {
      await react('🔄');
      const level = userDoc.level || 1;
      if (level < 10) {
        await reply(
          `🔄 Too early to be reborn. The academy wants **Level 10+**; you are Level ${level}.\n`
          + `🎯 ${num(xpNeeded(level) - clamp(userDoc.xp))} XP to go.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const bonus = 10000 * (clamp(userDoc.prestige) + 1);
      const oldLevel = level;
      userDoc.level = 1;
      userDoc.xp = 0;
      userDoc.prestige = clamp(userDoc.prestige) + 1;
      userDoc.coins = clamp((userDoc.coins || 0) + bonus);
      await save(userDoc);

      await reply(
        `🔄 **REBIRTH ${userDoc.prestige}**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `📉 Level ${oldLevel} → 1, XP cleared.\n`
        + `💰 Rebirth grant: ${kc(bonus)}\n`
        + `📈 Permanent income: +${Math.round((prestigeBonus(userDoc) - 1) * 100)}%\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 31
  // ─────────────────────────────────────────────────────────
  {
    name: 'topwins',
    aliases: ['wins'],
    category: 'rpg',
    description: '🥇 Top winners - Most battle wins',
    usage: '!topwins',
    cooldown: 15,
    permission: 'all',
    execute: async ({ reply, react, event }) => guard(reply, event.messageID, 'topwins', async () => {
      await react('🥇');
      if (!mongo.isReady()) {
        await reply('💾 Academy records are sealed — database offline.', event.messageID);
        return;
      }
      const board = await User.find({ 'rpg.stats.wins': { $gt: 0 } })
        .sort({ 'rpg.stats.wins': -1 })
        .limit(10)
        .select('name level rpg.stats.wins rpg.stats.battles')
        .lean();
      if (!board.length) {
        await reply('🥇 Nobody has won a fight yet. Try `!battle`.', event.messageID);
        return;
      }
      const medals = ['🥇', '🥈', '🥉'];
      const lines = board.map((u, i) => {
        const w = (u.rpg && u.rpg.stats && u.rpg.stats.wins) || 0;
        return `${medals[i] || `${i + 1}.`} ${u.name} — ${num(w)} wins (Lv ${u.level || 1})`;
      });

      await reply(
        `🥇 **MOST WINS**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 32
  // ─────────────────────────────────────────────────────────
  {
    name: 'topxp',
    aliases: [],
    category: 'rpg',
    description: '🌟 Top XP grinders',
    usage: '!topxp',
    cooldown: 15,
    permission: 'all',
    execute: async ({ reply, react, event }) => guard(reply, event.messageID, 'topxp', async () => {
      await react('🌟');
      if (!mongo.isReady()) {
        await reply('💾 Academy records are sealed — database offline.', event.messageID);
        return;
      }
      const board = await User.aggregate([
        { $match: { $or: [{ xp: { $gt: 0 } }, { level: { $gt: 1 } }] } },
        { $addFields: { lifetimeXp: { $add: [{ $multiply: [{ $ifNull: ['$level', 1] }, 0] }, '$xp'] } } },
        { $sort: { lifetimeXp: -1, xp: -1 } },
        { $limit: 10 },
        { $project: { name: 1, level: 1, xp: 1, _id: 0 } },
      ]);
      if (!board.length) {
        await reply('🌟 Nobody has ground XP yet. Try `!train`.', event.messageID);
        return;
      }
      const medals = ['🥇', '🥈', '🥉'];
      const lines = board.map((u, i) => (
        `${medals[i] || `${i + 1}.`} ${u.name} — Lv ${u.level || 1}, ${num(u.xp)} XP banked`
      ));

      await reply(
        `🌟 **TOP XP GRINDERS**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 33
  // ─────────────────────────────────────────────────────────
  {
    name: 'setbio',
    aliases: ['bio'],
    category: 'rpg',
    description: '📝 Set hunter biography - Shown in profile',
    usage: '!setbio <text>',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'setbio', async () => {
      await react('📝');
      const text = args.join(' ').trim();
      if (!text) {
        await reply('❌ Usage: `!setbio <text>` — 120 characters max.', event.messageID);
        return;
      }
      if (text.length > 120) {
        await reply(`❌ Too long (${text.length}/120). Trim it.`, event.messageID);
        return;
      }

      rpg(userDoc).bio = text;
      await save(userDoc);

      await reply(
        `📝 Biography updated:\n`
        + `"${text}"\n`
        + `👀 Visible on your \`!profile\` ID card.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 34
  // ─────────────────────────────────────────────────────────
  {
    name: 'title',
    aliases: ['titles'],
    category: 'rpg',
    description: "🏷️ Unlock titles - 'Slayer', 'Legend', 'God' at lvl milestones",
    usage: '!title',
    cooldown: 10,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'title', async () => {
      await react('🏷️');
      const data = rpg(userDoc);
      const level = userDoc.level || 1;
      const owned = data.titles;
      const lines = TITLES.map((t) => (
        `${owned.includes(t.title) ? '✅' : level >= t.level ? '🟡' : '🔒'} **${t.title}** — Level ${t.level}`
      ));

      await reply(
        `🏷️ **TITLES** (Level ${level})\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n`
        + `🎖️ Earned: ${owned.length ? owned.join(', ') : 'none yet'}\n`
        + `📖 Titles unlock automatically when you level up.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 35
  // ─────────────────────────────────────────────────────────
  {
    name: 'rpgstats',
    aliases: ['serverrpg'],
    category: 'rpg',
    description: '🌐 Academy stats - Total hunters, avg level, total battles',
    usage: '!rpgstats',
    cooldown: 20,
    permission: 'all',
    execute: async ({ reply, react, event }) => guard(reply, event.messageID, 'rpgstats', async () => {
      await react('🌐');
      if (!mongo.isReady()) {
        await reply('💾 Academy census unavailable — database offline.', event.messageID);
        return;
      }

      const rows = await User.aggregate([
        {
          $group: {
            _id: null,
            hunters: { $sum: 1 },
            level: { $sum: '$level' },
            xp: { $sum: '$xp' },
            coins: { $sum: '$coins' },
            prestige: { $sum: '$prestige' },
            battles: { $sum: '$rpg.stats.battles' },
            wins: { $sum: '$rpg.stats.wins' },
            bosses: { $sum: '$rpg.stats.bosses' },
            classed: { $sum: { $cond: [{ $and: [{ $ifNull: ['$rpg.className', ''] }, { $ne: ['$rpg.className', ''] }] }, 1, 0] } },
          },
        },
      ]);
      const row = rows[0] || {};
      const hunters = clamp(row.hunters);
      const battles = clamp(row.battles);
      const avgLevel = hunters ? Math.floor(clamp(row.level) / hunters) : 0;
      const avgXp = hunters ? Math.floor(clamp(row.xp) / hunters) : 0;
      const winRate = battles ? Math.round((clamp(row.wins) / battles) * 100) : 0;

      await reply(
        `🌐 **iKON ACADEMY CENSUS**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `👥 Hunters enrolled: ${num(hunters)}\n`
        + `📊 Average level: ${num(avgLevel)}\n`
        + `✨ Average XP: ${num(avgXp)}\n`
        + `⚔️ Total battles: ${num(battles)}\n`
        + `🏆 Total wins: ${num(row.wins)}\n`
        + `📉 Academy win rate: ${winRate}%\n`
        + `👹 Bosses slain: ${num(row.bosses)}\n`
        + `🎭 Hunters with a class: ${num(row.classed)}\n`
        + `👑 Total prestiges: ${num(row.prestige)}\n`
        + `💰 K-Cash in the academy: ${kc(row.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },
];