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
 * execute receives: { api, event, args, config, registry, ai, reply, react, userDoc }
 * `reply` and `react` are already bound to the current thread, so a command
 * never calls api.sendMessage directly.
 *
 * Every handler is async and internally wrapped in try/catch so a failure is
 * reported to the user instead of escaping into the engine.
 */

const User = require('../models/User');
const Economy = require('../models/Economy');
const Inventory = require('../models/Inventory');
const Group = require('../models/Group');
const mongo = require('../bot/mongo');
const { fmt } = require('../bot/helpers');
const cards = require('../bot/cards');
const userTarget = require('../bot/target');
const { k, ...rarity } = require('../bot/content');

const CASH = 'K-Cash';

// ───────────────────────────────────────────────────────────
// BOOSTED ECONOMY TABLE — every payout is deliberately generous
// ───────────────────────────────────────────────────────────
const PAYOUT = {
  // Authored at 1x, read 10x through k() — see bot/content.js.
  daily: k(10000),        // 100,000
  hourly: k(2500),       //  25,000
  weekly: k(75000),      // 750,000
  monthly: k(300000),    // 3,000,000
  work: [k(500), k(1500)],
  beg: [k(100), k(1100)],
  fish: [k(200), k(1000)],
  hunt: [k(300), k(1300)],
  mine: [k(200), k(1100)],
  crime: [k(500), k(4500)],
  crimeFine: k(1000),
  heist: [k(5000), k(15000)],
  heistLoss: k(3000),
  rob: [k(500), k(5500)],
  robFine: k(500),
};

/**
 * THE BLACK MARKET — 24 items, cheapest to dearest.
 *
 * `rarity` is a stated property, not a guess from position, so adding rows
 * cannot change what any other row means. `level` is a hard gate: it is what
 * stops a hunter with more money than sense from simply buying the endgame on
 * day one, which is the whole reason the money was scaled 10x.
 */
const SHOP_ITEMS = {
  // ── common ────────────────────────────────────────────────
  potion: { emoji: '🧪', name: 'iKON Potion', rarity: 'common', level: 1, price: k(1000), desc: 'Restores a hunter in the middle of a dungeon run.' },
  ration: { emoji: '🍞', name: 'Field Ration', rarity: 'common', level: 1, price: k(800), desc: 'Tastes like cardboard. Works like gold.' },
  bandage: { emoji: '🩹', name: 'Field Bandage', rarity: 'common', level: 1, price: k(600), desc: 'Stops the bleeding. Eventually.' },
  flare: { emoji: '🧯', name: 'Signal Flare', rarity: 'common', level: 1, price: k(1200), desc: 'Visible from three districts away. Mostly useful for running away.' },
  lockpick: { emoji: '🗝️', name: 'Lockpick Set', rarity: 'common', level: 3, price: k(2500), desc: 'Opens doors. Doors do not open themselves.' },

  // ── uncommon ──────────────────────────────────────────────
  shield: { emoji: '🛡️', name: 'Vault Shield', rarity: 'uncommon', level: 3, price: k(3000), desc: 'Robbers bounce off this one. Mostly.' },
  sword: { emoji: '⚔️', name: 'iKON Sword', rarity: 'uncommon', level: 5, price: k(5000), desc: 'Forged in the factory back room. RPG battles will love it.' },
  duffelbag: { emoji: '🎒', name: 'Burglar Duffel', rarity: 'uncommon', level: 8, price: k(9000), desc: 'Everything fits. Evidence does not.' },
  nightvision: { emoji: '🥽', name: 'Night Goggles', rarity: 'uncommon', level: 10, price: k(12000), desc: 'iKON City is dark because of policy.' },
  crowbar: { emoji: '🪓', name: 'Crowbar', rarity: 'uncommon', level: 12, price: k(15000), desc: 'For prying and for settling arguments.' },

  // ── rare ──────────────────────────────────────────────────
  diamond: { emoji: '💎', name: 'K-Crystal Diamond', rarity: 'rare', level: 15, price: k(10000), desc: 'Pure compressed wealth. Glows in the dark alleys.' },
  medkit: { emoji: '🩺', name: 'Trauma Kit', rarity: 'rare', level: 18, price: k(28000), desc: 'Everything a hospital would use, in one metal case.' },
  incendiary: { emoji: '🔥', name: 'Thermite Charge', rarity: 'rare', level: 22, price: k(40000), desc: 'Melts one vault door. Loudly.' },
  decrypter: { emoji: '💻', name: 'Ledger Decrypter', rarity: 'rare', level: 26, price: k(60000), desc: 'Reads the bank\'s books. Nobody asked it to.' },
  vigilstone: { emoji: '💠', name: 'Vigil Stone', rarity: 'rare', level: 30, price: k(85000), desc: 'Warm. Not psychic. Probably.' },

  // ── epic ──────────────────────────────────────────────────
  ghostwire: { emoji: '🕸️', name: 'Ghostwire', rarity: 'epic', level: 35, price: k(120000), desc: 'Trip a vault alarm without tripping the vault.' },
  nullsuit: { emoji: '🥷', name: 'Null Suit', rarity: 'epic', level: 40, price: k(180000), desc: 'Bends one shadow. Yours, ideally.' },
  titanplate: { emoji: '🛡️', name: 'Titan Plate', rarity: 'epic', level: 45, price: k(260000), desc: 'Absorbs a car. Twice.' },
  chronolock: { emoji: '⏳', name: 'Chrono Lock', rarity: 'epic', level: 50, price: k(340000), desc: 'Slows one thing down by one second. Choose well.' },

  // ── legendary ─────────────────────────────────────────────
  goldpass: { emoji: '🎫', name: 'Gold Pass', rarity: 'legendary', level: 60, price: k(500000), desc: 'Opens every door in the district. Doors open.' },
  klerkey: { emoji: '🔑', name: "Klerk's Key", rarity: 'legendary', level: 70, price: k(750000), desc: 'Owner Aphecks lost it. Twice. This is the second.' },
  blackstar: { emoji: '🌟', name: 'Black Star Shard', rarity: 'legendary', level: 80, price: k(1200000), desc: 'A piece of something that used to shine.' },

  // ── mythic ────────────────────────────────────────────────
  archiver: { emoji: '🗄️', name: 'The Archiver', rarity: 'mythic', level: 90, price: k(2000000), desc: 'Remembers every transaction in the city. Including yours.' },
  ikonforge: { emoji: '⚒️', name: 'iKON Forge', rarity: 'mythic', level: 95, price: k(3200000), desc: 'Mints nothing. Forges everything. Do not ask how.' },

  // ── divine ────────────────────────────────────────────────
  ownerssignet: { emoji: '👑', name: "Owner's Signet", rarity: 'divine', level: 100, price: k(5000000), desc: 'One exists and it is not for sale. Listed anyway.' },
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

// ───────────────────────────────────────────────────────────
// LOTTERY & CRATES
// ───────────────────────────────────────────────────────────

/** One lottery ticket, in the scaled economy. */
const LOTTERY_PRICE = k(50); // 500 K-Cash
/** A draw an hour, settled when someone next looks. */
const LOTTERY_PERIOD_MS = 60 * 60 * 1000;
/** A full board ends the draw early, so a busy chat is not left waiting on the clock. */
const LOTTERY_MAX_TICKETS = 200;
/** At most ten tickets in one buy, so a typo cannot empty a wallet. */
const LOTTERY_MAX_BUY = 10;

/**
 * Settle a finished lottery draw.
 *
 * A bot cannot promise a background timer will survive a
 * restart, so the lottery has no clock of its own. The
 * draw is settled the next time anybody buys a ticket or
 * asks for the board, which is also what keeps the pot
 * from sitting unclaimed forever.
 *
 * The winner is drawn weighted by ticket count — more
 * tickets, more chances — and takes the whole pot.
 *
 * @returns {Promise<{pot:number, winUid:string, winName:string, full:boolean}|null>}
 */
async function settleLottery(group) {
  const lot = group.lottery;
  if (!lot || !lot.endsAt) return null;

  const now = Date.now();
  const due = new Date(lot.endsAt).getTime() <= now;
  // The tickets are captured before the board is cleared,
  // because the draw reads them and clearing first would
  // leave the winner undefined and the pot unpaid.
  const tickets = lot.tickets || [];
  const total = tickets.reduce((s, t) => s + (t.count || 0), 0);
  const full = total >= LOTTERY_MAX_TICKETS;
  if (!due && !full) return null;

  const pot = clamp(lot.pot);
  group.lottery.tickets = [];
  group.lottery.pot = 0;
  group.lottery.lastDrawAt = new Date();
  group.lottery.endsAt = new Date(now + LOTTERY_PERIOD_MS);

  // Nothing was sold: roll the board forward and pay nobody.
  if (!total) {
    group.lottery.lastWinner = { uid: '', name: '', amount: 0 };
    await save(group);
    return null;
  }

  // Weighted draw: every ticket is one entry.
  let roll = rand(1, total);
  let winner = tickets[0];
  for (const t of tickets) {
    roll -= (t.count || 0);
    if (roll <= 0) { winner = t; break; }
  }
  const winUid = String(winner.uid || '');
  const winName = winner.name || 'someone';
  group.lottery.lastWinner = { uid: winUid, name: winName, amount: pot };
  await save(group);

  if (pot > 0 && winUid) {
    const userDoc = await User.findOne({ uid: winUid });
    if (userDoc) {
      userDoc.coins = clamp((userDoc.coins || 0) + pot);
      await save(userDoc);
      await ledger(userDoc.uid, 'lottery_win', pot, userDoc.coins, { pot });
    }
  }

  return { pot, winUid, winName, full };
}

/** Roll a rarity out of a weighted crate table. */
function rollRarity(table) {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let roll = rand(1, total);
  for (const [key, w] of table) {
    roll -= w;
    if (roll <= 0) return key;
  }
  return table[table.length - 1][0];
}

/** The black-market crates. Each opens into a real shop item. */
const CRATES = {
  basic: {
    emoji: '🟫', name: 'Basic Crate', price: k(150),
    desc: 'Mostly common, with a rare treat inside.',
    table: [['common', 62], ['uncommon', 28], ['rare', 10]],
  },
  rare: {
    emoji: '🟦', name: 'Rare Crate', price: k(500),
    desc: 'A fair shot at Epic, a slim one at Legendary.',
    table: [['uncommon', 24], ['rare', 38], ['epic', 28], ['legendary', 10]],
  },
  epic: {
    emoji: '🟪', name: 'Epic Crate', price: k(1500),
    desc: 'Legendary is within reach, and Mythic glints.',
    table: [['rare', 26], ['epic', 40], ['legendary', 26], ['mythic', 8]],
  },
};

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
        + '· · · · · · ·\n'
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
    hint: 'Coins in the vault cannot be robbed. Moving money in is one command and worth doing early.',
    cooldown: 5,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'bank', async () => {
      await react('🏦');
      const bank = userDoc.bank || 0;
      await reply(
        `🏦 **iKON VAULT — ${userDoc.name || 'Hunter'}**\n`
        + '· · · · · · ·\n'
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
    hint: '10,000 K-Cash every 24 hours. Miss a day and the streak is gone, so claim it early.',
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
    hint: 'The honest income. 500-1500 plus XP, and it never fails — unlike the casino.',
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
      // The name is the first argument and the amount is whatever follows it, so
      // `!pay Dyro Urano 10` has to read the amount from `consumed`, not args[1].
      const { target, consumed } = await userTarget.resolveArgs(args, event, api, { doc: true });
      const amount = amountArg(args.slice(consumed), 0);
      if (!target || amount <= 0) {
        await reply('❌ Usage: `!pay <user> <amount>`', event.messageID);
        return;
      }
      if (amount > (userDoc.coins || 0)) {
        await reply(`❌ You only have ${kc(userDoc.coins)} in your wallet.`, event.messageID);
        return;
      }

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
    hint: '48% win rate, so it loses more often than it wins. The house always wins eventually.',
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

      // The coin is in the slot before the reels turn. A jackpot is
      // paid on top of that stake, not on top of a returned one.
      await debit(userDoc, bet, 'slots', { bet, reels, stake: true });

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
          + `🎰 Paid ${kc(win)} (stake ${kc(bet)} back with it)\n`
          + `👛 Wallet: ${kc(userDoc.coins)}`,
          event.messageID,
        );
        return;
      }

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

      // The stake is down before the coin leaves the thumb, so a
      // correct call pays winnings on top of a placed bet.
      await debit(userDoc, bet, 'coinflip', { bet, guess, stake: true });

      const landed = Math.random() < 0.5 ? 'heads' : 'tails';

      if (landed === guess) {
        const win = bet * 2;
        await credit(userDoc, win, 'coinflip', { bet, guess, landed, win });
        await reply(
          `🪙 ${landed.toUpperCase()}! You called it.\n`
          + `💰 Won ${kc(win)} (your ${kc(bet)} stake rides again)\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

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
    hint: 'Top 10 by TOTAL wealth — wallet plus vault. `!richest` is the vault alone.',
    cooldown: 15,
    permission: 'all',
    execute: async ({ reply, react, event, api }) => guard(reply, event.messageID, 'leaderboard', async () => {
      await react('🏆');
      if (!mongo.isReady()) {
        await reply('💾 Database offline — the ledger of the city is unavailable.', event.messageID);
        return;
      }

      // Total wealth, wallet PLUS vault.
      //
      // The query was `find({ coins: { $gt: 0 } }).sort({ coins: -1 })` while
      // the hint under it promised "money sitting in `!bank` counts": it did not
      // count. A hunter with 8,000 in their pocket and 900,000 in the vault
      // ranked below somebody carrying 200,000 loose, on the one board whose job
      // is to say who runs the city.
      //
      // It has to be an aggregation, not a sort. `{ coins: -1 }` cannot sort by
      // a sum, and the `{ coins: { $gt: 0 } }` filter dropped everybody who had
      // spent their last coin — the ones a vault board exists to find.
      const top = await User.aggregate([
        { $addFields: { total: { $add: [{ $ifNull: ['$coins', 0] }, { $ifNull: ['$bank', 0] }] } } },
        { $match: { total: { $gt: 0 } } },
        { $sort: { total: -1, coins: -1 } },
        { $limit: 10 },
        { $project: { uid: 1, name: 1, coins: 1, bank: 1, total: 1, level: 1, _id: 0 } },
      ]);
      if (!top.length) {
        await reply('🏆 Nobody has any K-Cash yet. Be the first.', event.messageID);
        return;
      }

      // A stored name is not a name: createDefaultUser() writes "Facebook User",
      // so ten rows of that still look ranked. Facebook is asked, once per row,
      // and the photo comes off the same uid.
      const names = await Promise.all(top.map((u) => cards.realName(u, api)));
      const total = top.reduce((s, u) => s + (u.total || 0), 0);

      const card = await cards.boardCard({
        emoji: '🏆',
        title: 'RICHEST HUNTERS',
        subtitle: 'Top 10 by total wealth in iKON City',
        rows: top,
        api,
        value: (u) => `${kc(u.total)} · Lv ${u.level || 1}`,
        // The split behind the total, which is the number people actually argue
        // about. Not a uid.
        detail: (u) => `wallet ${kc(u.coins)} · vault ${kc(u.bank)}`,
      });
      if (card) {
        await reply({
          body: `🏆 **RICHEST HUNTERS**\n💵 ${kc(total)} on the books.`,
          attachment: { type: 'image', data: { url: card } },
        }, event.messageID);
        return;
      }

      const medals = ['🥇', '🥈', '🥉'];
      const lines = top.map((u, i) => (
        `${medals[i] || `${i + 1}.`} ${names[i]} — ${kc(u.total)} (Lv ${u.level || 1})\n`
        + `   👛 ${kc(u.coins)} · 🏦 ${kc(u.bank)}`
      ));
      await reply(
        `🏆 **iKON CITY — RICHEST HUNTERS**\n`
        + '· · · · · · ·\n'
        + `${lines.join('\n')}\n`
        + `💵 Total on display: ${kc(total)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

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
      const top = await User.find({ bank: { $gt: 0 } }).sort({ bank: -1 }).limit(10).select('uid name bank coins level').lean();
      if (!top.length) {
        await reply('🏦 Nobody has deposited yet. The vault is empty and slightly embarrassed.', event.messageID);
        return;
      }
      const total = top.reduce((s, u) => s + (u.bank || 0), 0);

      // Same reason as !leaderboard: a stored "Facebook User" is not a name, and
      // this fallback is the path every machine without the canvas binary takes.
      const names = await Promise.all(top.map((u) => cards.realName(u, api)));

      const card = await cards.boardCard({
        emoji: '🏦',
        title: 'VAULT KINGS',
        subtitle: `Top ${top.length} bank holders · ${kc(total)} locked away`,
        rows: top,
        api,
        value: (u) => `${kc(u.bank)} · Lv ${u.level || 1}`,
        // What they are carrying in their pocket, for contrast — and never a uid.
        detail: (u) => `wallet ${kc(u.coins)}`,
      });
      if (card) {
        await reply({
          body: `🏦 **VAULT KINGS**\n🔐 ${kc(total)} locked away.`,
          attachment: { type: 'image', data: { url: card } },
        }, event.messageID);
        return;
      }

      const medals = ['🥇', '🥈', '🥉'];
      const lines = top.map((u, i) => `${medals[i] || `${i + 1}.`} ${names[i]} — ${kc(u.bank)} (Lv ${u.level || 1})`);
      await reply(
        `🏦 **VAULT KINGS**\n`
        + '· · · · · · ·\n'
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
    description: '🛒 iKON Black Market — 25 items across seven rarities',
    usage: '!shop [rarity]',
    hint: 'Swords and shields raise battle odds. Everything past Rare is level-locked, so plan around that.',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event, config }) => guard(reply, event.messageID, 'shop', async () => {
      await react('🛒');
      const entries = Object.entries(SHOP_ITEMS);
      const level = Number(userDoc && userDoc.level) || 1;
      const want = String(args[0] || '').toLowerCase().trim();

      // One rarity at a time. Twenty-five rows with a description each is a
      // wall, and the interesting part of the market is the ladder, not the
      // inventory list.
      if (want) {
        if (!rarity.rank(want) && rarity.rank(want) !== 0) {
          await reply(`❓ No rarity called \`${want}\`. Try: ${rarity.LADDER.map((r) => `\`${r.key}\``).join(', ')}`, event.messageID);
          return;
        }
        const picked = entries.filter(([, it]) => it.rarity === want);
        if (!picked.length) {
          await reply(`📭 The ${want} shelf is empty.`, event.messageID);
          return;
        }
        const lines = picked.map(([id, it]) => {
          const locked = (it.level || 1) > level;
          return `${locked ? '🔒' : '🛒'} ${it.emoji} **${it.name}** — ${kc(it.price)} · ${locked ? `needs **Lv${it.level}**` : `Lv${it.level}`}\n   \`!buy ${id}\``;
        });
        await reply(
          `${rarity.symbol(want)} **${rarity.get(want).label} — ${picked.length} of ${entries.length}**\n`
          + '· · · · · · ·\n'
          + `${lines.join('\n')}\n`
          + `↩️ \`${config.PREFIX}shop\` — every shelf`,
          event.messageID,
        );
        return;
      }

      const out = [`🛒 **iKON BLACK MARKET** — ${entries.length} items`];
      for (const r of rarity.LADDER) {
        const group = entries.filter(([, it]) => it.rarity === r.key);
        if (!group.length) continue;
        out.push('', `${r.symbol} **${r.label}** · ${group.length}`);
        out.push(group.map(([id, it]) => {
          const locked = (it.level || 1) > level;
          return locked ? `🔒\`${id}\`` : `\`${id}\``;
        }).join(' '));
      }
      out.push('', '· · · · · · ·');
      out.push(`🔎 \`${config.PREFIX}shop <rarity>\` — prices, and what you can afford`);
      out.push(`💵 Resale value is only 50% — the market is greedy.`);
      await reply(out.join('\n'), event.messageID);
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
    execute: async ({ args, userDoc, reply, react, event, config }) => guard(reply, event.messageID, 'buy', async () => {
      await react('🛍️');
      const itemId = String(args[0] || '').toLowerCase();
      const item = SHOP_ITEMS[itemId];
      if (!item) {
        await reply(
          `❌ Unknown item \`${itemId}\`.\n`
          + `🛒 \`${config.PREFIX}shop\` lists all ${Object.keys(SHOP_ITEMS).length}, by rarity.`,
          event.messageID,
        );
        return;
      }
      // The gate is checked before the wallet, so being too low a level reads as
      // "come back later" rather than "you are poor" — which is the opposite of
      // what actually stops them.
      const blocked = rarity.missing(userDoc, item);
      if (blocked) {
        await reply(`${blocked}\n🛒 You are Level ${Number(userDoc.level) || 1}.`, event.messageID);
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
    hint: 'Your backpack. Items are stacks — the count is what matters, not how many rows it takes.',
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
        + '· · · · · · ·\n'
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
    hint: 'The calm one. Same money as hunting, none of the energy cost.',
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
    hint: '300-1,300 bounty per kill, but it costs energy. Farming earns that energy back.',
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
    hint: '200-1,100 per ore. The variance is wide, so mine several times before judging it.',
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

      // The stake leaves the wallet before the wheel spins. Paying
      // winnings on top of a bet the house never collected made every
      // win the full payout on top of a returned stake — a free edge.
      await debit(userDoc, bet, 'roulette', { bet, choice, stake: true });

      const landed = Math.random() < 0.5 ? 'black' : 'red';

      if (choice === landed) {
        const win = bet * 2;
        await credit(userDoc, win, 'roulette', { bet, choice, landed, win });
        await reply(
          `🎡 Wheel stops on **${landed.toUpperCase()}**. You called ${choice}.\n`
          + `💰 Paid ${kc(win)} (your ${kc(bet)} stake rides again)\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      // The stake was already taken before the wheel spun,
      // so a loss only needs the report.
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

      // The stake is called before the bones land, so a win pays
      // winnings on top of a placed bet, not a returned one.
      await debit(userDoc, bet, 'dice', { bet, d1, d2, sum, stake: true });

      if (sum >= 9) {
        const win = bet * 2;
        await credit(userDoc, win, 'dice', { bet, d1, d2, sum, win });
        await reply(
          `🎲 ${faces[d1 - 1]} ${faces[d2 - 1]} — ${d1} + ${d2} = **${sum}**\n`
          + `✅ Nine or more. You win ${kc(win)} (stake ${kc(bet)} back with it).\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 The old bones knock twice for luck. ${story()}`,
          event.messageID,
        );
        return;
      }

      // The stake was already called before the bones
      // landed, so a loss only needs the report.
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
    hint: 'Vault to vault, so it skips the robbery risk entirely. Sending to yourself is blocked.',
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
        + '· · · · · · ·\n'
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
      // The name is the first argument and may contain spaces, so resolve it
      // from the head of the list and read the amount from what it left.
      const { target, consumed } = await userTarget.resolveArgs(args, event, api, { doc: true });
      const amount = amountArg(args.slice(consumed), 0);
      if (!target || amount <= 0) {
        await reply('❌ Usage: `!addmoney <user> <amount>`', event.messageID);
        return;
      }

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
      // The name is the first argument and may contain spaces, so resolve it
      // from the head of the list and read the amount from what it left.
      const { target, consumed } = await userTarget.resolveArgs(args, event, api, { doc: true });
      const amount = amountArg(args.slice(consumed), 0);
      if (!target || amount <= 0) {
        await reply('❌ Usage: `!removemoney <user> <amount>`', event.messageID);
        return;
      }
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
        + '· · · · · · ·\n'
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

  // ─────────────────────────────────────────────────────────
  // 36
  // ─────────────────────────────────────────────────────────
  {
    name: 'lottery',
    aliases: ['lotto'],
    category: 'economy',
    description: '🎫 iKON Lottery — one draw an hour, winner takes the whole pot',
    usage: '!lottery [buy <count>]',
    hint: 'Tickets are 500 each and every ticket is one chance. The board also closes when it fills.',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event, config }) => guard(reply, event.messageID, 'lottery', async () => {
      await react('🎫');
      if (!mongo.isReady()) {
        await reply('💾 Database offline — the lottery board is unavailable.', event.messageID);
        return;
      }
      const group = await Group.findOne({ gid: String(event.threadID) });
      if (!group) {
        await reply('❌ No arcade record for this chat yet.', event.messageID);
        return;
      }

      const sub = (args[0] || '').toLowerCase();

      // ── buy tickets ──────────────────────────────────
      if (sub === 'buy') {
        // Settle an old draw before selling into a new one,
        // so the pot a hunter just joined is the live one.
        const settled = await settleLottery(group);
        if (settled) {
          await reply(
            `🎫 **LOTTERY DRAW**\n`
            + '· · · · · · ·\n'
            + `🏆 ${settled.winName} takes the ${kc(settled.pot)} pot${settled.full ? ' — the board was full' : ''}.\n`,
            event.messageID,
          );
        }

        const count = Math.min(amountArg(args.slice(1), 1), LOTTERY_MAX_BUY);
        const cost = LOTTERY_PRICE * count;
        if (cost > (userDoc.coins || 0)) {
          await reply(`❌ ${count} ticket${count === 1 ? '' : 's'} cost ${kc(cost)} and you have ${kc(userDoc.coins)}.`, event.messageID);
          return;
        }

        await debit(userDoc, cost, 'lottery_buy', { count, cost });

        const lot = group.lottery;
        lot.pot = clamp(lot.pot) + cost;
        let mine = (lot.tickets || []).find((t) => String(t.uid) === String(userDoc.uid));
        if (!mine) {
          mine = { uid: String(userDoc.uid), name: userDoc.name, count: 0 };
          lot.tickets = lot.tickets || [];
          lot.tickets.push(mine);
        }
        mine.count = clamp(mine.count) + count;
        if (!lot.endsAt) lot.endsAt = new Date(Date.now() + LOTTERY_PERIOD_MS);
        await save(group);

        const total = lot.tickets.reduce((s, t) => s + (t.count || 0), 0);
        const left = lot.endsAt ? Math.max(0, new Date(lot.endsAt).getTime() - Date.now()) : 0;
        await reply(
          `🎫 Bought ${count} ticket${count === 1 ? '' : 's'} for ${kc(cost)}.\n`
          + '· · · · · · ·\n'
          + `💰 Pot: ${kc(lot.pot)}\n`
          + `🎟️ Your tickets: ${mine.count} of ${total}\n`
          + `⏱️ Draw in: ${left > 0 ? fmt.dur(Math.ceil(left / 1000)) : 'settling…'}\n`
          + `🏆 Every ticket is one chance. ${kc(LOTTERY_PRICE)} each.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      // ── the board ────────────────────────────────────
      const settled = await settleLottery(group);
      if (settled) {
        await reply(
          `🎫 **LOTTERY DRAW**\n`
          + '· · · · · · ·\n'
          + `🏆 ${settled.winName} takes the ${kc(settled.pot)} pot${settled.full ? ' — the board was full' : ''}.\n`,
          event.messageID,
        );
      }

      const lot = group.lottery;
      const total = (lot.tickets || []).reduce((s, t) => s + (t.count || 0), 0);
      const mine = (lot.tickets || []).find((t) => String(t.uid) === String(userDoc.uid));
      const left = lot.endsAt ? Math.max(0, new Date(lot.endsAt).getTime() - Date.now()) : 0;

      await reply(
        `🎫 **iKON LOTTERY**\n`
        + '· · · · · · ·\n'
        + `💰 Pot: ${kc(lot.pot || 0)}\n`
        + `🎫 Tickets sold: ${total}${total >= LOTTERY_MAX_TICKETS ? ' — board full' : ''}\n`
        + `⏱️ Draw in: ${left > 0 ? fmt.dur(Math.ceil(left / 1000)) : 'settling…'}\n`
        + `🎟️ Your tickets: ${mine ? mine.count : 0}\n`
        + (lot.lastWinner && lot.lastWinner.uid
          ? `🏆 Last draw: ${lot.lastWinner.name} won ${kc(lot.lastWinner.amount)}\n`
          : '')
        + `🛒 \`${config.PREFIX}lottery buy <count>\` — ${kc(LOTTERY_PRICE)} a ticket, max ${LOTTERY_MAX_BUY}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 37
  // ─────────────────────────────────────────────────────────
  {
    name: 'crate',
    aliases: ['crates', 'box'],
    category: 'economy',
    description: '🎁 iKON Crates — buy a box, roll a random item off a rarity shelf',
    usage: '!crate [open <type>]',
    hint: 'Every crate opens straight into your inventory. Rarer crates reach rarer shelves.',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event, config }) => guard(reply, event.messageID, 'crate', async () => {
      await react('🎁');
      const sub = (args[0] || '').toLowerCase();

      // ── open a crate ─────────────────────────────────
      if (sub === 'open') {
        const type = String(args[1] || '').toLowerCase();
        const crate = CRATES[type];
        if (!crate) {
          await reply(
            `❌ No crate called \`${type}\`. Crates: ${Object.keys(CRATES).map((c) => `\`${c}\``).join(', ')}\n`
            + `🎁 \`${config.PREFIX}crate\` lists every box.`,
            event.messageID,
          );
          return;
        }
        if (crate.price > (userDoc.coins || 0)) {
          await reply(`❌ A ${crate.name} costs ${kc(crate.price)} and you have ${kc(userDoc.coins)}.`, event.messageID);
          return;
        }

        await debit(userDoc, crate.price, 'crate_open', { type, price: crate.price });

        // Roll the rarity, then a random item off that
        // shelf. A table typo falls back to the common
        // shelf rather than opening an empty box.
        const rolled = rollRarity(crate.table);
        let shelf = Object.entries(SHOP_ITEMS).filter(([, it]) => it.rarity === rolled);
        if (!shelf.length) shelf = Object.entries(SHOP_ITEMS).filter(([, it]) => it.rarity === 'common');
        const [itemId, item] = shelf[rand(0, shelf.length - 1)];

        const inv = await getInv(userDoc.uid);
        await addItem(inv, itemId, 1);

        await reply(
          `🎁 **${crate.name} OPENED**\n`
          + '· · · · · · ·\n'
          + `🎉 You pulled ${item.emoji} **${item.name}** — ${rarity.label(item.rarity)}\n`
          + `🗒️ ${item.desc}\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `🎒 Check it with \`${config.PREFIX}inventory\`\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      // ── the shelves ──────────────────────────────────
      const lines = Object.entries(CRATES).map(([key, crate]) => {
        const weight = crate.table.reduce((s, [, w]) => s + w, 0);
        const odds = crate.table.map(([rk, w]) => `${rarity.symbol(rk)} ${Math.round((w / weight) * 100)}%`).join(' ');
        return `${crate.emoji} **${crate.name}** — ${kc(crate.price)}\n   ${crate.desc}\n   ${odds}\n   \`${config.PREFIX}crate open ${key}\``;
      });
      await reply(
        `🎁 **iKON CRATES** — ${Object.keys(CRATES).length} boxes\n`
        + '· · · · · · ·\n'
        + `${lines.join('\n\n')}\n`
        + '· · · · · · ·\n'
        + `🎒 Every crate opens straight into your inventory.\n`
        + `⚖️ Resale is 50% — the market is greedy.`,
        event.messageID,
      );
    }),
  },
];