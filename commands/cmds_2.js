'use strict';

/**
 * MODULE 2 — ECONOMY & TREASURY (35 commands)
 *
 * iKON-BOT is a Messenger RPG city. Coins are K-Cash, the bank is a secure
 * vault, and every user is a hunter working the streets for Owner Aphecks.
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
const Economy = require('../models/Economy');
const Inventory = require('../models/Inventory');
const mongo = require('../bot/mongo');
const { fmt } = require('../bot/helpers');
const cards = require('../bot/cards');
const userTarget = require('../bot/target');

const CASH = 'K-Cash';

// ───────────────────────────────────────────────────────────
// BOOSTED ECONOMY TABLE — every payout is deliberately generous
// ───────────────────────────────────────────────────────────
const PAYOUT = {
  daily: 10000,
  hourly: 2500,
  weekly: 75000,
  monthly: 300000,
  work: [500, 1500],
  beg: [100, 1100],
  fish: [200, 1000],
  hunt: [300, 1300],
  mine: [200, 1100],
  crime: [500, 4500],
  crimeFine: 1000,
  heist: [5000, 15000],
  heistLoss: 3000,
  rob: [500, 5500],
  robFine: 500,
};

const SHOP_ITEMS = {
  sword: { emoji: '⚔️', name: 'iKON Sword', price: 5000, desc: 'Forged in the factory back room. RPG battles in cmds_3 will love it.' },
  shield: { emoji: '🛡️', name: 'Vault Shield', price: 3000, desc: 'Robbers bounce off this one. Mostly.' },
  potion: { emoji: '🧪', name: 'iKON Potion', price: 1000, desc: 'Restores a hunter in the middle of a dungeon run.' },
  diamond: { emoji: '💎', name: 'K-Crystal Diamond', price: 10000, desc: 'Pure compressed wealth. Glows in the dark alleys.' },
};

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

/** Small story line to keep replies feeling like a city, not a spreadsheet. */
const story = () => pick([
  'The neon signs flicker over the wet street.',
  'Somewhere a factory siren goes unanswered.',
  'A stray cat knocks over a bucket of coins.',
  'Owner Aphecks watches from the balcony, nodding once.',
  'The Klerk office is already three phones deep.',
  'Rain taps the awning of the pawn shop.',
  'Somewhere, a vault door slams.',
]);

/** Persist a profile, tolerating the in-memory (DB offline) profile. */
async function save(userDoc) {
  if (!userDoc || userDoc.transient) return;
  try {
    await userDoc.save();
  } catch { /* the ledger entry below still records what happened */ }
}

/** Append one line to the audit ledger. Never throws. */
async function ledger(uid, action, amount, balanceAfter, metadata = {}) {
  if (!mongo.isReady()) return;
  try {
    await Economy.create({ uid, action, amount, balanceAfter, metadata });
  } catch { /* auditing is best effort */ }
}

/** Add coins to a wallet and record it. */
async function credit(userDoc, amount, action, metadata) {
  userDoc.coins = clamp((userDoc.coins || 0) + amount);
  await save(userDoc);
  await ledger(userDoc.uid, action, amount, userDoc.coins, metadata);
  return userDoc.coins;
}

/** Take coins from a wallet and record it. */
async function debit(userDoc, amount, action, metadata) {
  userDoc.coins = clamp((userDoc.coins || 0) - amount);
  await save(userDoc);
  await ledger(userDoc.uid, action, -amount, userDoc.coins, metadata);
  return userDoc.coins;
}

/** Milliseconds until a claim timer frees up (0 when ready). */
function claimLeft(userDoc, field, periodMs) {
  const last = userDoc.timers && userDoc.timers[field] ? new Date(userDoc.timers[field]).getTime() : 0;
  if (!last) return 0;
  return Math.max(0, last + periodMs - Date.now());
}

/** Build a claim command (daily / hourly / weekly / monthly share one shape). */
function claim({ name, aliases, description, usage, amount, periodMs, icon, cooldown = 10 }) {
  return {
    name,
    aliases,
    category: 'economy',
    description,
    usage,
    cooldown,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, name, async () => {
      await react(icon);

      const left = claimLeft(userDoc, name, periodMs);
      if (left > 0) {
        await reply(
          `⏳ Too soon, hunter. Your next ${name} blessing unlocks in ${fmt.dur(Math.ceil(left / 1000))}.\n`
          + `${icon} ${kc(amount)} is waiting. ${story()}`,
          event.messageID,
        );
        return;
      }

      if (!userDoc.timers) userDoc.timers = {};
      userDoc.timers[name] = new Date();
      await credit(userDoc, amount, name);

      await reply(
        `${icon} **${name.toUpperCase()} CLAIMED!**\n`
        + `━━━━━━━━━━━━━━━\n`
        + `💰 +${kc(amount)}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `🏦 Vault: ${kc(userDoc.bank)}\n`
        + `💎 Total: ${kc((userDoc.coins || 0) + (userDoc.bank || 0))}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  };
}

/** Parse a positive integer amount from args, with a fallback default. */
function amountArg(args, fallback) {
  const raw = (args[0] || '').replace(/[,k]/gi, (m) => (m.toLowerCase() === 'k' ? '000' : ''));
  const v = Number.parseInt(raw, 10);
  if (Number.isFinite(v) && v > 0) return v;
  return fallback;
}

/** Resolve a tag, a typed name, or a bare id to a User document.
 *
 * The thread knows who is actually in this chat and what they are really
 * called, which is why this lives in bot/target.js: it is the only place that
 * can turn "@Alice" into a uid. See that file for the whole order of attempts.
 */
async function resolveTarget(ref, event, api) {
  return userTarget.userDoc(ref, event, api);
}

/** Load (or create in memory) an inventory document. */
async function getInv(uid) {
  if (!mongo.isReady()) {
    return { uid, items: [], transient: true, save: async () => {}, };
  }
  try {
    let inv = await Inventory.findOne({ uid });
    if (!inv) inv = await Inventory.create({ uid, items: [] });
    return inv;
  } catch {
    return { uid, items: [], transient: true, save: async () => {} };
  }
}

/** Add `qty` of an item, merging into an existing stack. */
async function addItem(inv, itemId, qty) {
  const stack = inv.items.find((i) => i.itemId === itemId);
  if (stack) stack.qty += qty;
  else inv.items.push({ itemId, qty });
  await inv.save();
}

/** Remove up to `qty` of an item. @returns {number} how many were removed */
async function removeItem(inv, itemId, qty) {
  const stack = inv.items.find((i) => i.itemId === itemId);
  if (!stack) return 0;
  const taken = Math.min(stack.qty, qty);
  stack.qty -= taken;
  if (stack.qty <= 0) inv.items = inv.items.filter((i) => i.itemId !== itemId);
  await inv.save();
  return taken;
}

/** Total resale value of an inventory. The market pays 50%. */
function invValue(inv) {
  return (inv.items || []).reduce((sum, i) => {
    const item = SHOP_ITEMS[i.itemId];
    return sum + (item ? item.price * i.qty : 0);
  }, 0);
}

/** Owner command: pull a target out of a tag / id / name. */
async function targetOr(reply, messageID, ref, event, label, api) {
  if (!ref) {
    await reply(`❌ Usage: \`!${label} <user> [amount]\` — tag a hunter or use their ID.`, messageID);
    return null;
  }
  const target = await resolveTarget(ref, event, api);
  if (!target) {
    await reply(`❌ No hunter found for \`${ref}\`.`, messageID);
    return null;
  }
  return target;
}

module.exports = [
  // ─────────────────────────────────────────────────────────
  // 1
  // ─────────────────────────────────────────────────────────
  {
    name: 'balance',
    aliases: ['bal', 'money'],
    category: 'economy',
    description: '💳 Check your K-Cash wallet and vault - See how rich you are in iKON City',
    usage: '!balance',
    cooldown: 5,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'balance', async () => {
      await react('💳');
      const coins = userDoc.coins || 0;
      const bank = userDoc.bank || 0;
      const tier = coins + bank >= 1000000 ? '💎 LEGEND'
        : coins + bank >= 250000 ? '👑 TYCOON'
          : coins + bank >= 50000 ? '🏙️ ELITE' : '🧱 STREET';

      await reply(
        `💳 **${userDoc.name || 'Hunter'}**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `👛 Wallet: ${kc(coins)}\n`
        + `🏦 Vault: ${kc(bank)}\n`
        + `💎 Net worth: ${kc(coins + bank)}\n`
        + `${tier} · Level ${userDoc.level || 1}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 2
  // ─────────────────────────────────────────────────────────
  {
    name: 'bank',
    aliases: [],
    category: 'economy',
    description: "🏦 Your secure vault - Coins in bank can't be robbed",
    usage: '!bank',
    cooldown: 5,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'bank', async () => {
      await react('🏦');
      const bank = userDoc.bank || 0;
      await reply(
        `🏦 **iKON VAULT — ${userDoc.name || 'Hunter'}**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🔐 Secured: ${kc(bank)}\n`
        + `👛 Loose cash: ${kc(userDoc.coins || 0)}\n`
        + `🛡️ Robbers cannot touch vault money.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 3
  // ─────────────────────────────────────────────────────────
  {
    name: 'deposit',
    aliases: ['dep'],
    category: 'economy',
    description: '💸 Move K-Cash to vault for safety - Bank is safe from robbers',
    usage: '!deposit <amount | all>',
    cooldown: 5,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'deposit', async () => {
      await react('🏦');
      const wallet = userDoc.coins || 0;
      if (wallet <= 0) {
        await reply('❌ Your wallet is empty. Go make some K-Cash first.', event.messageID);
        return;
      }
      const all = String(args[0] || '').toLowerCase() === 'all';
      const amount = all ? wallet : amountArg(args, 0);
      if (amount <= 0) {
        await reply('❌ Usage: `!deposit <amount>` or `!deposit all`', event.messageID);
        return;
      }
      const moved = Math.min(amount, wallet);
      userDoc.bank = clamp((userDoc.bank || 0) + moved);
      await debit(userDoc, moved, 'deposit');
      await ledger(userDoc.uid, 'deposit', 0, userDoc.coins, { toBank: moved, bank: userDoc.bank });

      await reply(
        `🏦 Vaulted ${kc(moved)}.\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `🔐 Vault: ${kc(userDoc.bank)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 4
  // ─────────────────────────────────────────────────────────
  {
    name: 'withdraw',
    aliases: ['with'],
    category: 'economy',
    description: '💵 Take cash out to spend - Needed for shopping and gambling',
    usage: '!withdraw <amount | all>',
    cooldown: 5,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'withdraw', async () => {
      await react('💵');
      const bank = userDoc.bank || 0;
      if (bank <= 0) {
        await reply('❌ Your vault is empty. Nothing to withdraw.', event.messageID);
        return;
      }
      const all = String(args[0] || '').toLowerCase() === 'all';
      const amount = all ? bank : amountArg(args, 0);
      if (amount <= 0) {
        await reply('❌ Usage: `!withdraw <amount>` or `!withdraw all`', event.messageID);
        return;
      }
      const moved = Math.min(amount, bank);
      userDoc.bank = clamp(userDoc.bank - moved);
      await credit(userDoc, moved, 'withdraw', { fromBank: moved });

      await reply(
        `💵 Withdrew ${kc(moved)}.\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `🔐 Vault: ${kc(userDoc.bank)}\n`
        + `⚠️ Loose cash CAN be robbed. Spend wisely.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 5
  // ─────────────────────────────────────────────────────────
  claim({
    name: 'daily',
    aliases: [],
    description: '🎁 Daily blessing from Owner Aphecks - Claim 10,000 K-Cash every 24h',
    usage: '!daily',
    amount: PAYOUT.daily,
    periodMs: 86400000,
    icon: '🎁',
  }),

  // ─────────────────────────────────────────────────────────
  // 6
  // ─────────────────────────────────────────────────────────
  {
    name: 'work',
    aliases: [],
    category: 'economy',
    description: '💼 Work at iKON factory - Earn 500-1500 and 50 XP, honest living',
    usage: '!work',
    cooldown: 300,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'work', async () => {
      await react('💼');
      const pay = rand(PAYOUT.work[0], PAYOUT.work[1]);
      userDoc.xp = clamp((userDoc.xp || 0) + 50);
      await credit(userDoc, pay, 'work', { xp: 50 });

      await reply(
        `💼 You clocked in at the iKON factory, boss Aphecks paid you ${kc(pay)}!\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `⭐ XP: +50 (total ${Number(userDoc.xp).toLocaleString('en-US')})\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 7
  // ─────────────────────────────────────────────────────────
  {
    name: 'beg',
    aliases: [],
    category: 'economy',
    description: '🥺 Beg on streets of iKON - 70% chance someone pities you 100-1100',
    usage: '!beg',
    cooldown: 60,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'beg', async () => {
      await react('🥺');
      const won = Math.random() < 0.7;
      if (!won) {
        await reply(
          `🥺 You held out your hat for an hour. A security guard walked past without looking.\n`
          + `💸 0 ${CASH}. The city is cruel tonight.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }
      const amount = rand(PAYOUT.beg[0], PAYOUT.beg[1]);
      await credit(userDoc, amount, 'beg');

      const line = pick([
        'A pawn shop owner drops coins without making eye contact.',
        'A kid sharing their snack budget gives you half.',
        'The Klerk office window slides open a crack.',
        'Someone in a hooded jacket says "get some food, hunter".',
      ]);
      await reply(
        `🥺 ${line}\n`
        + `💰 +${kc(amount)}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 8
  // ─────────────────────────────────────────────────────────
  {
    name: 'pay',
    aliases: ['give'],
    category: 'economy',
    description: '🤝 Send K-Cash to friends - Support your crew',
    usage: '!pay <user> <amount>',
    cooldown: 10,
    permission: 'all',
    execute: async ({ api, args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'pay', async () => {
      await react('🤝');
      const [ref, rawAmount] = args;
      const amount = amountArg([rawAmount], 0);
      if (!ref || amount <= 0) {
        await reply('❌ Usage: `!pay <user> <amount>`', event.messageID);
        return;
      }
      if (amount > (userDoc.coins || 0)) {
        await reply(`❌ You only have ${kc(userDoc.coins)} in your wallet.`, event.messageID);
        return;
      }

      const target = await targetOr(reply, event.messageID, ref, event, 'pay', api);
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ Sending money to yourself? The vault already does that for free.', event.messageID);
        return;
      }

      await debit(userDoc, amount, 'pay', { to: target.uid });
      target.coins = clamp((target.coins || 0) + amount);
      if (!target.transient) {
        try {
          await target.save();
          await ledger(target.uid, 'pay', amount, target.coins, { from: userDoc.uid });
        } catch { /* sender's ledger entry still stands */ }
      }

      await reply(
        `🤝 You handed ${kc(amount)} to ${target.name}.\n`
        + `👛 Your wallet: ${kc(userDoc.coins)}\n`
        + `💛 Crew looks loyal. ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 9
  // ─────────────────────────────────────────────────────────
  {
    name: 'rob',
    aliases: [],
    category: 'economy',
    description: '🔪 Risky robbery - 50% success to steal 500-5500, 50% you lose and get caught',
    usage: '!rob',
    cooldown: 600,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'rob', async () => {
      await react('🔪');
      if ((userDoc.coins || 0) < PAYOUT.robFine) {
        await reply(`❌ You need at least ${kc(PAYOUT.robFine)} loose cash to even think about this.`, event.messageID);
        return;
      }

      if (Math.random() < 0.5) {
        const haul = rand(PAYOUT.rob[0], PAYOUT.rob[1]);
        await credit(userDoc, haul, 'rob');
        await reply(
          `🔪 Clean get. You lifted ${kc(haul)} off an unmarked van.\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `🏃 Run. Now run. ${story()}`,
          event.messageID,
        );
        return;
      }

      await debit(userDoc, PAYOUT.robFine, 'rob_fail', { caught: true });
      await reply(
        `🚨 CAUGHT! An iKON guard knew your face. Fine: ${kc(PAYOUT.robFine)}.\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `🏦 Robbers never carry money in the vault. Lesson learned.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 10
  // ─────────────────────────────────────────────────────────
  {
    name: 'gamble',
    aliases: ['bet'],
    category: 'economy',
    description: '🎰 Gamble at iKON Casino - 48% win chance, high risk high reward',
    usage: '!gamble <amount>',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'gamble', async () => {
      await react('🎰');
      const bet = amountArg(args, 100);
      if (bet > (userDoc.coins || 0)) {
        await reply(`❌ Not enough K-Cash. You have ${kc(userDoc.coins)}.`, event.messageID);
        return;
      }
      if (bet <= 0) {
        await reply('❌ Usage: `!gamble <amount>`', event.messageID);
        return;
      }

      if (Math.random() < 0.48) {
        const win = bet * 2;
        await credit(userDoc, win, 'gamble', { bet, win });
        await reply(
          `🎰 The wheel spun your way. Won ${kc(win)}!\n`
          + `🎲 Bet: ${kc(bet)} · Payout: ${kc(win)}\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      await debit(userDoc, bet, 'gamble', { bet, lost: true });
      await reply(
        `🎰 House takes ${kc(bet)}.\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `🎭 The dealer does not look up. ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 11
  // ─────────────────────────────────────────────────────────
  {
    name: 'slots',
    aliases: ['slot'],
    category: 'economy',
    description: '🍒 iKON Slot Machine - 3x match = 5x jackpot!',
    usage: '!slots <amount>',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'slots', async () => {
      await react('🍒');
      const bet = amountArg(args, 100);
      if (bet <= 0) {
        await reply('❌ Usage: `!slots <amount>`', event.messageID);
        return;
      }
      if (bet > (userDoc.coins || 0)) {
        await reply(`❌ You only have ${kc(userDoc.coins)}. The machine laughs.`, event.messageID);
        return;
      }

      const faces = ['🍒', '🍋', '💰', '⭐', '🧱', '7️⃣'];
      const reels = [pick(faces), pick(faces), pick(faces)];
      const triple = reels[0] === reels[1] && reels[1] === reels[2];
      const pair = !triple && new Set(reels).size === 2;

      if (triple) {
        const win = bet * 5;
        await credit(userDoc, win, 'slots', { bet, reels, win });
        await reply(
          `🍒 ${reels.join(' ')} — TRIPLE!\n`
          + `🎰 Jackpot: ${kc(win)} (5x on ${kc(bet)})\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 The whole bar stops to watch. ${story()}`,
          event.messageID,
        );
        return;
      }
      if (pair) {
        const win = Math.floor(bet * 2);
        await credit(userDoc, win, 'slots', { bet, reels, win });
        await reply(
          `🍒 ${reels.join(' ')} — pair!\n`
          + `🎰 Paid ${kc(win)}\n`
          + `👛 Wallet: ${kc(userDoc.coins)}`,
          event.messageID,
        );
        return;
      }

      await debit(userDoc, bet, 'slots', { bet, reels });
      await reply(
        `🍒 ${reels.join(' ')}\n`
        + `💸 Lost ${kc(bet)}\n`
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
    name: 'coinflip',
    aliases: ['cf'],
    category: 'economy',
    description: '🪙 Flip the cursed coin - Double your bet if you guess right',
    usage: '!coinflip <amount> <heads | tails>',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'coinflip', async () => {
      await react('🪙');
      const bet = amountArg(args, 100);
      if (bet <= 0) {
        await reply('❌ Usage: `!coinflip <amount> <heads | tails>`', event.messageID);
        return;
      }
      if (bet > (userDoc.coins || 0)) {
        await reply(`❌ Not enough K-Cash. Wallet: ${kc(userDoc.coins)}`, event.messageID);
        return;
      }

      const guess = String(args[1] || 'heads').toLowerCase().startsWith('t') ? 'tails' : 'heads';
      const landed = Math.random() < 0.5 ? 'heads' : 'tails';

      if (landed === guess) {
        const win = bet * 2;
        await credit(userDoc, win, 'coinflip', { bet, guess, landed, win });
        await reply(
          `🪙 ${landed.toUpperCase()}! You called it.\n`
          + `💰 Won ${kc(win)} (double your ${kc(bet)})\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      await debit(userDoc, bet, 'coinflip', { bet, guess, landed });
      await reply(
        `🪙 ${landed.toUpperCase()}. You called ${guess}. Wrong.\n`
        + `💸 Lost ${kc(bet)}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `🪙 The cursed coin whispers "next time". ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 13
  // ─────────────────────────────────────────────────────────
  {
    name: 'leaderboard',
    aliases: ['lb', 'top'],
    category: 'economy',
    description: '🏆 Who runs iKON City? Top 10 richest hunters',
    usage: '!leaderboard',
    cooldown: 15,
    permission: 'all',
    execute: async ({ reply, react, event, api }) => guard(reply, event.messageID, 'leaderboard', async () => {
      await react('🏆');
      if (!mongo.isReady()) {
        await reply('💾 Database offline — the ledger of the city is unavailable.', event.messageID);
        return;
      }
      const top = await User.find({ coins: { $gt: 0 } }).sort({ coins: -1 }).limit(10).select('uid name coins level').lean();
      if (!top.length) {
        await reply('🏆 Nobody has any K-Cash yet. Be the first.', event.messageID);
        return;
      }

      const card = await cards.boardCard({
        emoji: '🏆',
        title: 'RICHEST HUNTERS',
        subtitle: 'Top spenders in iKON City',
        rows: top,
        api,
        value: (u) => `${kc(u.coins)} · Lv ${u.level || 1}`,
      });
      if (card) {
        await reply({
          body: `🏆 **RICHEST HUNTERS**\n💵 ${kc(top.reduce((s, u) => s + (u.coins || 0), 0))} on the books.`,
          attachment: { type: 'image', data: { url: card } },
        }, event.messageID);
        return;
      }

      const medals = ['🥇', '🥈', '🥉'];
      const lines = top.map((u, i) => `${medals[i] || `${i + 1}.`} ${u.name} — ${kc(u.coins)} (Lv ${u.level || 1})`);
      await reply(
        `🏆 **iKON CITY — RICHEST HUNTERS**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n`
        + `💵 Total on display: ${kc(top.reduce((s, u) => s + (u.coins || 0), 0))}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 14
  // ─────────────────────────────────────────────────────────
  {
    name: 'richest',
    aliases: [],
    category: 'economy',
    description: '🏦 Vault kings - Top 10 bank holders, the untouchables',
    usage: '!richest',
    cooldown: 15,
    permission: 'all',
    execute: async ({ reply, react, event, api }) => guard(reply, event.messageID, 'richest', async () => {
      await react('🏦');
      if (!mongo.isReady()) {
        await reply('💾 Database offline — vault records are sealed.', event.messageID);
        return;
      }
      // uid is selected explicitly: the canvas card needs it to fetch the real
      // Facebook photo, and the old select() omitted it.
      const top = await User.find({ bank: { $gt: 0 } }).sort({ bank: -1 }).limit(10).select('uid name bank level').lean();
      if (!top.length) {
        await reply('🏦 Nobody has deposited yet. The vault is empty and slightly embarrassed.', event.messageID);
        return;
      }
      const total = top.reduce((s, u) => s + (u.bank || 0), 0);

      const card = await cards.boardCard({
        emoji: '🏦',
        title: 'VAULT KINGS',
        subtitle: `Top ${top.length} bank holders · ${kc(total)} locked away`,
        rows: top,
        api,
        value: (u) => `${kc(u.bank)} · Lv ${u.level || 1}`,
      });
      if (card) {
        await reply({
          body: `🏦 **VAULT KINGS**\n🔐 ${kc(total)} locked away.`,
          attachment: { type: 'image', data: { url: card } },
        }, event.messageID);
        return;
      }

      const medals = ['🥇', '🥈', '🥉'];
      const lines = top.map((u, i) => `${medals[i] || `${i + 1}.`} ${u.name} — ${kc(u.bank)} (Lv ${u.level || 1})`);
      await reply(
        `🏦 **VAULT KINGS**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n`
        + `🔐 Total locked away: ${kc(total)}\n`
        + `🛡️ Robbers read this list and change careers.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 15
  // ─────────────────────────────────────────────────────────
  {
    name: 'shop',
    aliases: ['store'],
    category: 'economy',
    description: '🛒 iKON Black Market - Swords, shields, potions, diamonds',
    usage: '!shop',
    cooldown: 10,
    permission: 'all',
    execute: async ({ reply, react, event }) => guard(reply, event.messageID, 'shop', async () => {
      await react('🛒');
      const lines = Object.entries(SHOP_ITEMS).map(([id, item]) => `${item.emoji} **${item.name}** — ${kc(item.price)}\n   \`!buy ${id} [qty]\``);
      await reply(
        `🛒 **iKON BLACK MARKET**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n`
        + `💵 Resale value is only 50% — the market is greedy.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 16
  // ─────────────────────────────────────────────────────────
  {
    name: 'buy',
    aliases: [],
    category: 'economy',
    description: '🛍️ Buy gear from market - Gear will be needed for RPG battles in cmds_3',
    usage: '!buy <item> [qty]',
    cooldown: 5,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'buy', async () => {
      await react('🛍️');
      const itemId = String(args[0] || '').toLowerCase();
      const item = SHOP_ITEMS[itemId];
      if (!item) {
        await reply(
          `❌ Unknown item. Try one of: ${Object.keys(SHOP_ITEMS).map((k) => `\`${k}\``).join(', ')}\n`
          + '🛒 Full stock list: `!shop`',
          event.messageID,
        );
        return;
      }
      const qty = amountArg(args.slice(1), 1);
      const cost = item.price * qty;
      if (cost > (userDoc.coins || 0)) {
        await reply(`❌ That costs ${kc(cost)} and you have ${kc(userDoc.coins)}. The vendor laughs.`, event.messageID);
        return;
      }

      await debit(userDoc, cost, 'buy', { itemId, qty, cost });
      const inv = await getInv(userDoc.uid);
      await addItem(inv, itemId, qty);

      await reply(
        `🛍️ Bought ${qty}x ${item.emoji} **${item.name}** for ${kc(cost)}.\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `🎒 Check it with \`!inventory\`\n`
        + `⚔️ Gear matters when the RPG battles land in cmds_3.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 17
  // ─────────────────────────────────────────────────────────
  {
    name: 'sell',
    aliases: [],
    category: 'economy',
    description: '💰 Sell your gear - Get 50% back, market is greedy',
    usage: '!sell <item> [qty]',
    cooldown: 5,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'sell', async () => {
      await react('💰');
      const itemId = String(args[0] || '').toLowerCase();
      const item = SHOP_ITEMS[itemId];
      if (!item) {
        await reply(
          `❌ Unknown item. Sellable: ${Object.keys(SHOP_ITEMS).map((k) => `\`${k}\``).join(', ')}`,
          event.messageID,
        );
        return;
      }

      const inv = await getInv(userDoc.uid);
      const stack = (inv.items || []).find((i) => i.itemId === itemId);
      if (!stack || stack.qty <= 0) {
        await reply(`❌ You don't own any ${item.emoji} ${item.name}.`, event.messageID);
        return;
      }
      const qty = amountArg(args.slice(1), stack.qty);
      const sold = Math.min(qty, stack.qty);
      const payout = Math.floor((item.price * sold) / 2);

      await removeItem(inv, itemId, sold);
      await credit(userDoc, payout, 'sell', { itemId, sold, payout });

      await reply(
        `💰 Sold ${sold}x ${item.emoji} **${item.name}** for ${kc(payout)} (50% of ${kc(item.price * sold)}).\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `🧾 "Come back tomorrow, prices go up."\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 18
  // ─────────────────────────────────────────────────────────
  {
    name: 'inventory',
    aliases: ['inv'],
    category: 'economy',
    description: '🎒 Your backpack - What treasures you carry',
    usage: '!inventory',
    cooldown: 5,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'inventory', async () => {
      await react('🎒');
      const inv = await getInv(userDoc.uid);
      const items = (inv.items || []).filter((i) => i.qty > 0);

      if (!items.length) {
        await reply(
          `🎒 Your backpack is empty.\n`
          + `🛒 Load up at the black market: \`!shop\``,
          event.messageID,
        );
        return;
      }

      const lines = items.map((i) => {
        const item = SHOP_ITEMS[i.itemId];
        const icon = item ? item.emoji : '📦';
        const label = item ? item.name : i.itemId;
        return `${icon} **${label}** x${i.qty} — worth ${kc(item ? item.price * i.qty : 0)}`;
      });
      const total = invValue(inv);

      await reply(
        `🎒 **${userDoc.name || 'Hunter'}'s BACKPACK**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n`
        + `💎 Gear value: ${kc(total)} (resale ${kc(Math.floor(total / 2))})\n`
        + `⚔️ RPG battles in cmds_3 will read this list.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 19
  // ─────────────────────────────────────────────────────────
  {
    name: 'crime',
    aliases: [],
    category: 'economy',
    description: '🦹 Commit crime in dark alley - 60% success 500-4500, 40% pay fine 1000',
    usage: '!crime',
    cooldown: 600,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'crime', async () => {
      await react('🦹');
      if ((userDoc.coins || 0) < PAYOUT.crimeFine) {
        await reply(`❌ You need ${kc(PAYOUT.crimeFine)} in hand — fines are paid in cash.`, event.messageID);
        return;
      }

      if (Math.random() < 0.6) {
        const haul = rand(PAYOUT.crime[0], PAYOUT.crime[1]);
        await credit(userDoc, haul, 'crime');
        await reply(
          `🦹 Clean job. You picked a lock in the dark alley and made ${kc(haul)}.\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `🔦 The streetlight above you is definitely broken.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      await debit(userDoc, PAYOUT.crimeFine, 'crime_fine', { fined: true });
      await reply(
        `🚨 A patrol grabbed you by the collar. Fine: ${kc(PAYOUT.crimeFine)}.\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📋 File opened under your name. Try again later.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 20
  // ─────────────────────────────────────────────────────────
  {
    name: 'heist',
    aliases: [],
    category: 'economy',
    description: '💣 Bank heist with crew - 40% win 5k-15k, 60% lose 3k - The ultimate risk',
    usage: '!heist',
    cooldown: 3600,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'heist', async () => {
      await react('💣');
      if ((userDoc.coins || 0) < PAYOUT.heistLoss) {
        await reply(`❌ A failed heist costs ${kc(PAYOUT.heistLoss)}. Fund the crew first.`, event.messageID);
        return;
      }

      await reply(`💣 Crew is in position. Locks are hot. Hold breath…`, event.messageID);

      if (Math.random() < 0.4) {
        const haul = rand(PAYOUT.heist[0], PAYOUT.heist[1]);
        await credit(userDoc, haul, 'heist');
        await reply(
          `💣 **THE HEIST WORKED.**\n`
          + `💰 Crew split: ${kc(haul)}\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `🚗 Three getaway cars, one working radio.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      await debit(userDoc, PAYOUT.heistLoss, 'heist_loss', { crewBusted: true });
      await reply(
        `💥 The crew got rolled up. Loss: ${kc(PAYOUT.heistLoss)}.\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `🚔 Owner Aphecks posted your bail. He was not amused.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 21
  // ─────────────────────────────────────────────────────────
  {
    name: 'fish',
    aliases: [],
    category: 'economy',
    description: '🎣 Fish at iKON Lake - Peaceful 200-1000, relax and earn',
    usage: '!fish',
    cooldown: 300,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'fish', async () => {
      await react('🎣');
      const haul = rand(PAYOUT.fish[0], PAYOUT.fish[1]);
      const catchLine = pick([
        'You pull up a boot. Then, out of politeness, a fish.',
        'The lake gives up a K-Crystal lure worth a fortune.',
        'A bottle, a boot, and—wait. That is a fish.',
        'Something enormous bumps the line, then swims away laughing.',
      ]);
      await credit(userDoc, haul, 'fish');

      await reply(
        `🎣 ${catchLine}\n`
        + `🐟 Haul: ${kc(haul)}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `🧘 No sirens on the lake. Almost peaceful.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 22
  // ─────────────────────────────────────────────────────────
  {
    name: 'hunt',
    aliases: [],
    category: 'economy',
    description: '🏹 Hunt monsters outside city - 300-1300 bounty per kill',
    usage: '!hunt',
    cooldown: 300,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'hunt', async () => {
      await react('🏹');
      const bounty = rand(PAYOUT.hunt[0], PAYOUT.hunt[1]);
      const beast = pick([
        '🗡️ A Alley Lynx', '🦇 Rooftop Bats', '🐺 Wire Wolves',
        '🕷️ Sewer Spinners', '👹 A Street Ghoul', '🦂 Scrap Scorpions',
      ]);
      const killLine = pick([
        'One arrow. It never saw the second one coming.',
        'It charges, you sidestep, boredom wins.',
        'You get lucky. Luck counts as skill in iKON City.',
      ]);

      userDoc.xp = clamp((userDoc.xp || 0) + 25);
      await credit(userDoc, bounty, 'hunt', { xp: 25, beast });

      await reply(
        `🏹 You tracked ${beast} past the water towers.\n`
        + `${killLine}\n`
        + `💰 Bounty: ${kc(bounty)}\n`
        + `⭐ XP: +25 (total ${Number(userDoc.xp).toLocaleString('en-US')})\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 23
  // ─────────────────────────────────────────────────────────
  {
    name: 'mine',
    aliases: [],
    category: 'economy',
    description: '⛏️ Mine K-Crystals in caves - 200-1100 per ore',
    usage: '!mine',
    cooldown: 300,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'mine', async () => {
      await react('⛏️');
      const ore = rand(PAYOUT.mine[0], PAYOUT.mine[1]);
      const rock = pick(['K-Crystal', 'Neon Ore', 'Vault Slag', 'Glowstone', 'Klerk Iron']);
      const caveLine = pick([
        'Your pickaxe rings through the tunnel like a phone that nobody answers.',
        'Dust, echo, and then the wall gives something back.',
        'Headlamp flicker. Pickaxe bite. Payday.',
      ]);

      userDoc.xp = clamp((userDoc.xp || 0) + 20);
      await credit(userDoc, ore, 'mine', { xp: 20, rock });

      await reply(
        `⛏️ ${caveLine}\n`
        + `💎 Struck ${rock} worth ${kc(ore)}.\n`
        + `⭐ XP: +20 (total ${Number(userDoc.xp).toLocaleString('en-US')})\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 24
  // ─────────────────────────────────────────────────────────
  claim({
    name: 'hourly',
    aliases: [],
    description: '⏰ Hourly paycheck - 2,500 for staying active',
    usage: '!hourly',
    amount: PAYOUT.hourly,
    periodMs: 3600000,
    icon: '⏰',
  }),

  // ─────────────────────────────────────────────────────────
  // 25
  // ─────────────────────────────────────────────────────────
  claim({
    name: 'weekly',
    aliases: [],
    description: '📅 Weekly salary - 75,000 loyal hunter reward',
    usage: '!weekly',
    amount: PAYOUT.weekly,
    periodMs: 604800000,
    icon: '📅',
  }),

  // ─────────────────────────────────────────────────────────
  // 26
  // ─────────────────────────────────────────────────────────
  claim({
    name: 'monthly',
    aliases: [],
    description: '🗓️ Monthly empire reward - 300,000! Become a legend',
    usage: '!monthly',
    amount: PAYOUT.monthly,
    periodMs: 2592000000,
    icon: '🗓️',
  }),

  // ─────────────────────────────────────────────────────────
  // 27
  // ─────────────────────────────────────────────────────────
  {
    name: 'double',
    aliases: ['doubleor'],
    category: 'economy',
    description: '🔥 Double or Nothing - Flip your fate, win or lose everything',
    usage: '!double <amount | all>',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'double', async () => {
      await react('🔥');
      const wallet = userDoc.coins || 0;
      if (wallet <= 0) {
        await reply('❌ Nothing to double. Your wallet is a rumour.', event.messageID);
        return;
      }
      const bet = String(args[0] || '').toLowerCase() === 'all' ? wallet : amountArg(args, 0);
      if (bet <= 0) {
        await reply('❌ Usage: `!double <amount>` or `!double all`', event.messageID);
        return;
      }
      if (bet > wallet) {
        await reply(`❌ You only have ${kc(wallet)}. Bold, but broke.`, event.messageID);
        return;
      }

      if (Math.random() < 0.5) {
        await credit(userDoc, bet, 'double', { bet, won: true });
        await reply(
          `🔥 **DOUBLED!** ${kc(bet)} → ${kc(bet * 2)} in your pocket.\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `🎉 Owner Aphecks would call that a good decision.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      await debit(userDoc, bet, 'double', { bet, lost: true });
      await reply(
        `🔥 **GONE.** Lost ${kc(bet)}. Fortune flipped.\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `🕯️ The candle on your desk burns lower.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 28
  // ─────────────────────────────────────────────────────────
  {
    name: 'roulette',
    aliases: [],
    category: 'economy',
    description: '🎡 iKON Roulette - Red or black, 50/50 chaos',
    usage: '!roulette <amount> <red | black>',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'roulette', async () => {
      await react('🎡');
      const bet = amountArg(args, 100);
      if (bet <= 0) {
        await reply('❌ Usage: `!roulette <amount> <red | black>`', event.messageID);
        return;
      }
      if (bet > (userDoc.coins || 0)) {
        await reply(`❌ Not enough K-Cash. Wallet: ${kc(userDoc.coins)}`, event.messageID);
        return;
      }

      const raw = String(args[1] || 'red').toLowerCase();
      const choice = raw.startsWith('b') ? 'black' : 'red';
      const landed = Math.random() < 0.5 ? 'black' : 'red';

      if (choice === landed) {
        const win = bet * 2;
        await credit(userDoc, win, 'roulette', { bet, choice, landed, win });
        await reply(
          `🎡 Wheel stops on **${landed.toUpperCase()}**. You called ${choice}.\n`
          + `💰 Paid ${kc(win)}\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      await debit(userDoc, bet, 'roulette', { bet, choice, landed });
      await reply(
        `🎡 Wheel stops on **${landed.toUpperCase()}**. You called ${choice}.\n`
        + `💸 Lost ${kc(bet)}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `🎡 The table goes quiet for exactly one second.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 29
  // ─────────────────────────────────────────────────────────
  {
    name: 'dice',
    aliases: [],
    category: 'economy',
    description: '🎲 Roll 2 dice - Sum >=9 wins, ancient iKON game',
    usage: '!dice <amount>',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'dice', async () => {
      await react('🎲');
      const bet = amountArg(args, 100);
      if (bet <= 0) {
        await reply('❌ Usage: `!dice <amount>`', event.messageID);
        return;
      }
      if (bet > (userDoc.coins || 0)) {
        await reply(`❌ Not enough K-Cash. Wallet: ${kc(userDoc.coins)}`, event.messageID);
        return;
      }

      const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
      const d1 = rand(1, 6);
      const d2 = rand(1, 6);
      const sum = d1 + d2;

      if (sum >= 9) {
        const win = bet * 2;
        await credit(userDoc, win, 'dice', { bet, d1, d2, sum, win });
        await reply(
          `🎲 ${faces[d1 - 1]} ${faces[d2 - 1]} — ${d1} + ${d2} = **${sum}**\n`
          + `✅ Nine or more. You win ${kc(win)}.\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 The old bones knock twice for luck. ${story()}`,
          event.messageID,
        );
        return;
      }

      await debit(userDoc, bet, 'dice', { bet, d1, d2, sum });
      await reply(
        `🎲 ${faces[d1 - 1]} ${faces[d2 - 1]} — ${d1} + ${d2} = **${sum}**\n`
        + `❌ Short of nine. Lost ${kc(bet)}.\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 The bones are old and they remember grudges.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 30
  // ─────────────────────────────────────────────────────────
  {
    name: 'transfer',
    aliases: ['trans'],
    category: 'economy',
    description: '🏦 Bank wire - Transfer vault money to friends, safe transfer',
    usage: '!transfer <user> <amount>',
    cooldown: 10,
    permission: 'all',
    execute: async ({ api, args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'transfer', async () => {
      await react('🏦');
      const [ref, rawAmount] = args;
      const amount = amountArg([rawAmount], 0);
      if (!ref || amount <= 0) {
        await reply('❌ Usage: `!transfer <user> <amount>` — moves VAULT money.', event.messageID);
        return;
      }
      if (amount > (userDoc.bank || 0)) {
        await reply(`❌ Your vault only holds ${kc(userDoc.bank)}. Wire what you have.`, event.messageID);
        return;
      }

      const target = await targetOr(reply, event.messageID, ref, event, 'transfer', api);
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ Wiring money to yourself is just a slower withdrawal.', event.messageID);
        return;
      }

      userDoc.bank = clamp(userDoc.bank - amount);
      await save(userDoc);
      await ledger(userDoc.uid, 'transfer_out', -amount, userDoc.coins, { to: target.uid, amount, from: 'bank' });

      target.bank = clamp((target.bank || 0) + amount);
      if (!target.transient) {
        try {
          await target.save();
          await ledger(target.uid, 'transfer_in', amount, target.coins, { from: userDoc.uid, amount, to: 'bank' });
        } catch { /* sender's ledger entry still stands */ }
      }

      await reply(
        `🏦 Wire sent: ${kc(amount)} to ${target.name}'s vault.\n`
        + `🔐 Your vault: ${kc(userDoc.bank)}\n`
        + `🛡️ Bank-to-bank, robbers can't skim it.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 31
  // ─────────────────────────────────────────────────────────
  {
    name: 'networth',
    aliases: ['nw'],
    category: 'economy',
    description: '💎 True wealth - Coins + Bank + Inventory value, your real power',
    usage: '!networth',
    cooldown: 10,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'networth', async () => {
      await react('💎');
      const coins = userDoc.coins || 0;
      const bank = userDoc.bank || 0;
      const inv = await getInv(userDoc.uid);
      const gear = invValue(inv);
      const total = coins + bank + gear;

      const rank = total >= 1000000 ? '💎 iKON LEGEND'
        : total >= 500000 ? '👑 CITY TYCOON'
          : total >= 100000 ? '🏙️ VAULT OWNER'
            : total >= 25000 ? '🏪 STREET BOSS'
              : total >= 5000 ? '🧱 STREET HUNTER' : '🌱 ROOKIE';

      await reply(
        `💎 **NET WORTH — ${userDoc.name || 'Hunter'}**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `👛 Wallet: ${kc(coins)}\n`
        + `🏦 Vault: ${kc(bank)}\n`
        + `🎒 Gear: ${kc(gear)}\n`
        + `💠 Total: ${kc(total)}\n`
        + `${rank} · Level ${userDoc.level || 1}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 32
  // ─────────────────────────────────────────────────────────
  {
    name: 'reseteco',
    aliases: [],
    category: 'economy',
    description: "🔄 [OWNER] Wipe a hunter's wealth - Reset to 10k starter",
    usage: '!reseteco <user>',
    cooldown: 10,
    permission: 'owner',
    execute: async ({ api, args, event, reply, react }) => guard(reply, event.messageID, 'reseteco', async () => {
      await react('🔄');
      const target = await targetOr(reply, event.messageID, args[0], event, 'reseteco', api);
      if (!target) return;

      const before = (target.coins || 0) + (target.bank || 0);
      target.coins = 10000;
      target.bank = 0;
      if (target.timers) {
        target.timers.daily = null;
        target.timers.hourly = null;
        target.timers.weekly = null;
        target.timers.monthly = null;
      }
      if (!target.transient) {
        try {
          await target.save();
          await ledger(target.uid, 'reseteco', 0, target.coins, { before, owner: String(event.senderID) });
        } catch { /* reset still applied in memory */ }
      }

      await reply(
        `🔄 ${target.name} has been reset.\n`
        + `💸 Before: ${kc(before)}\n`
        + `👛 Now: ${kc(10000)} wallet, empty vault.\n`
        + `⏰ All claim timers cleared.\n`
        + `👑 Signed, Owner Aphecks.`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 33
  // ─────────────────────────────────────────────────────────
  {
    name: 'addmoney',
    aliases: ['addbal'],
    category: 'economy',
    description: '💸 [OWNER] Bless a hunter with K-Cash - Aphecks gift',
    usage: '!addmoney <user> <amount>',
    cooldown: 10,
    permission: 'owner',
    execute: async ({ api, args, event, reply, react }) => guard(reply, event.messageID, 'addmoney', async () => {
      await react('💸');
      const amount = amountArg(args.slice(1), 0);
      if (amount <= 0) {
        await reply('❌ Usage: `!addmoney <user> <amount>`', event.messageID);
        return;
      }
      const target = await targetOr(reply, event.messageID, args[0], event, 'addmoney', api);
      if (!target) return;

      target.coins = clamp((target.coins || 0) + amount);
      if (!target.transient) {
        try {
          await target.save();
          await ledger(target.uid, 'addmoney', amount, target.coins, { owner: String(event.senderID) });
        } catch { /* blessing still applied in memory */ }
      }

      await reply(
        `💸 Owner Aphecks blessed ${target.name} with ${kc(amount)}.\n`
        + `👛 New wallet: ${kc(target.coins)}\n`
        + `💛 "Don't waste it, hunter."`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 34
  // ─────────────────────────────────────────────────────────
  {
    name: 'removemoney',
    aliases: ['rmbal'],
    category: 'economy',
    description: '💀 [OWNER] Punish - Take coins from cheaters',
    usage: '!removemoney <user> <amount>',
    cooldown: 10,
    permission: 'owner',
    execute: async ({ api, args, event, reply, react }) => guard(reply, event.messageID, 'removemoney', async () => {
      await react('💀');
      const amount = amountArg(args.slice(1), 0);
      if (amount <= 0) {
        await reply('❌ Usage: `!removemoney <user> <amount>`', event.messageID);
        return;
      }
      const target = await targetOr(reply, event.messageID, args[0], event, 'removemoney', api);
      if (!target) return;
      if (amount > (target.coins || 0)) {
        await reply(`❌ ${target.name} only has ${kc(target.coins)}. Take what exists.`, event.messageID);
        return;
      }

      target.coins = clamp(target.coins - amount);
      if (!target.transient) {
        try {
          await target.save();
          await ledger(target.uid, 'removemoney', -amount, target.coins, { owner: String(event.senderID) });
        } catch { /* punishment still applied in memory */ }
      }

      await reply(
        `💀 ${kc(amount)} stripped from ${target.name}.\n`
        + `👛 Wallet: ${kc(target.coins)}\n`
        + `⚖️ "Cheating ends here." — Aphecks`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 35
  // ─────────────────────────────────────────────────────────
  {
    name: 'economy',
    aliases: ['eco'],
    category: 'economy',
    description: '🌐 iKON City GDP - Total K-Cash in circulation',
    usage: '!economy',
    cooldown: 20,
    permission: 'all',
    execute: async ({ reply, react, event }) => guard(reply, event.messageID, 'economy', async () => {
      await react('🌐');
      if (!mongo.isReady()) {
        await reply('💾 Database offline — the city census cannot be taken.', event.messageID);
        return;
      }

      const totals = await User.aggregate([
        {
          $group: {
            _id: null,
            coins: { $sum: '$coins' },
            bank: { $sum: '$bank' },
            hunters: { $sum: 1 },
            rich: { $sum: { $cond: [{ $gte: [{ $add: ['$coins', '$bank'] }, 100000] }, 1, 0] } },
          },
        },
      ]);

      const row = totals[0] || { coins: 0, bank: 0, hunters: 0, rich: 0 };
      const circulating = (row.coins || 0) + (row.bank || 0);
      const avg = row.hunters ? Math.floor(circulating / row.hunters) : 0;

      await reply(
        `🌐 **iKON CITY GDP**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💵 Loose K-Cash: ${kc(row.coins)}\n`
        + `🏦 Vaulted: ${kc(row.bank)}\n`
        + `💠 Total in circulation: ${kc(circulating)}\n`
        + `👥 Hunters: ${Number(row.hunters).toLocaleString('en-US')}\n`
        + `📊 Average net worth: ${kc(avg)}\n`
        + `👑 Tycoons (100k+): ${Number(row.rich).toLocaleString('en-US')}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },
];