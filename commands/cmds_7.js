'use strict';

/**
 * MODULE 7 — GTA (35 commands)
 *
 * iKON-BOT v2 Ultra. The crime half of iKON City. This module is deliberately
 * a coin sink: cars run to a million, guns to three hundred thousand, and fuel
 * and repairs never stop. Missions pay a tenth of what a car costs, so the
 * loop is "grind missions, lose most of it to the garage" and that is the point.
 *
 * Exports a plain array. No factories, no legacy loader.
 *
 * Shape required for every command:
 * { name, aliases, category, description, usage, cooldown, permission, execute }
 *
 * execute receives: { api, event, args, config, registry, gemini, reply, react, userDoc }
 * `reply` and `react` are already bound to the current thread, so a command
 * never calls api.sendMessage directly. Car cards go out through
 * `reply({ attachment })`.
 *
 * Every handler is async and internally wrapped in try/catch so a failure is
 * reported to the user instead of escaping into the engine.
 */

const User = require('../models/User');
const Economy = require('../models/Economy');
const Inventory = require('../models/Inventory');
const Group = require('../models/Group');
const cache = require('../bot/cache');
const mongo = require('../bot/mongo');
const canvasKit = require('../bot/canvas');
const { fmt } = require('../bot/helpers');

const CASH = 'K-Cash';
const ULTRA = 'iKON-BOT v2 Ultra';

// ───────────────────────────────────────────────────────────
// THE GARAGE — 13 cars, plus the one nobody should own
// ───────────────────────────────────────────────────────────

const CARS = [
  { id: 'sultanrs', name: 'Sultan RS', price: 50000, power: 300, color: '#9aa0b5' },
  { id: 'adder', name: 'Adder', price: 80000, power: 350, color: '#c0c6d4' },
  { id: 'zentorno', name: 'Zentorno', price: 120000, power: 400, color: '#ff9f1c' },
  { id: 't20', name: 'T20', price: 150000, power: 450, color: '#2ec4b6' },
  { id: 'x80', name: 'X80', price: 200000, power: 500, color: '#e71d36' },
  { id: 'osiris', name: 'Osiris', price: 250000, power: 550, color: '#011627' },
  { id: 'entityxf', name: 'Entity XF', price: 300000, power: 600, color: '#7b2cbf' },
  { id: 'turismor', name: 'Turismo R', price: 350000, power: 650, color: '#00d4ff' },
  { id: 'bulletgt', name: 'Bullet GT', price: 400000, power: 700, color: '#ffd60a' },
  { id: 'cheetah', name: 'Cheetah', price: 450000, power: 750, color: '#06d6a0' },
  { id: 'infernus', name: 'Infernus', price: 500000, power: 800, color: '#ef233c' },
  { id: 'phantomprime', name: 'iKON Phantom Prime', price: 1000000, power: 1500, color: '#b14bff' },
];

const CAR_BY_ID = new Map(CARS.map((c) => [c.id, c]));
const CAR_BY_NAME = new Map(CARS.map((c) => [c.name.toLowerCase(), c]));

/** Tolerate "zentorno", "Zentorno", "phantom" and "phantom prime". */
function findCar(ref) {
  const q = String(ref || '').toLowerCase().trim();
  if (!q) return null;
  if (CAR_BY_ID.has(q)) return CAR_BY_ID.get(q);
  if (CAR_BY_NAME.has(q)) return CAR_BY_NAME.get(q);
  const flat = q.replace(/[^a-z0-9]/g, '');
  for (const c of CARS) {
    if (c.id === flat) return c;
    if (c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === flat) return c;
  }
  return null;
}

// ───────────────────────────────────────────────────────────
// THE ARMOURY
// ───────────────────────────────────────────────────────────

const WEAPONS = [
  { id: 'pistol', name: 'Pistol', price: 5000, dmg: 50, ammo: 12 },
  { id: 'smg', name: 'SMG', price: 10000, dmg: 80, ammo: 30 },
  { id: 'ak47', name: 'AK47', price: 20000, dmg: 120, ammo: 30 },
  { id: 'shotgun', name: 'Shotgun', price: 25000, dmg: 150, ammo: 8 },
  { id: 'sniper', name: 'Sniper', price: 40000, dmg: 200, ammo: 5 },
  { id: 'rpg', name: 'RPG', price: 75000, dmg: 400, ammo: 2 },
  { id: 'minigun', name: 'Minigun', price: 150000, dmg: 600, ammo: 200 },
  { id: 'railgun', name: 'Railgun', price: 300000, dmg: 1000, ammo: 1 },
];

const WEAPON_BY_ID = new Map(WEAPONS.map((w) => [w.id, w]));
const WEAPON_BY_NAME = new Map(WEAPONS.map((w) => [w.name.toLowerCase(), w]));

function findWeapon(ref) {
  const q = String(ref || '').toLowerCase().trim();
  if (!q) return null;
  if (WEAPON_BY_ID.has(q)) return WEAPON_BY_ID.get(q);
  if (WEAPON_BY_NAME.has(q)) return WEAPON_BY_NAME.get(q);
  const flat = q.replace(/[^a-z0-9]/g, '');
  for (const w of WEAPONS) {
    if (w.id === flat || w.name.toLowerCase().replace(/[^a-z0-9]/g, '') === flat) return w;
  }
  return null;
}

// ───────────────────────────────────────────────────────────
// MISSIONS
// ───────────────────────────────────────────────────────────

const MISSIONS = [
  {
    id: 'drugrun', name: 'Drug Run', risk: 0.30, reward: [1500, 4000], wanted: 1,
    steps: ['Driving to the drop...', 'Handing over the package...', 'Running the checkpoints...'],
  },
  {
    id: 'bankjob', name: 'Bank Job', risk: 0.45, reward: [3000, 7000], wanted: 2,
    steps: ['Casing the bank...', 'Inside. Counting seconds...', 'Out through the alley...'],
  },
  {
    id: 'carsteal', name: 'Car Steal', risk: 0.35, reward: [2000, 5500], wanted: 1,
    steps: ['Breaking into the lock...', 'Ignition. Go...', 'Losing the tail...'],
  },
  {
    id: 'hitman', name: 'Hitman Contract', risk: 0.55, reward: [4000, 9000], wanted: 3,
    steps: ['Following the target...', 'The shot...', 'Getting off the street...'],
  },
  {
    id: 'streetrace', name: 'Street Race', risk: 0.40, reward: [2500, 8000], wanted: 1,
    steps: ['Engine screaming...', 'Third corner...', 'Crossing the line...'],
  },
];

const HARD_MISSION = {
  id: 'coup', name: 'The Vault Coup', risk: 0.60, reward: [18000, 24000], wanted: 5,
  steps: ['Cutting the power...', 'Inside the vault...', 'The alarm. All of it...', 'Running.'],
};

const CRIME_LORE = [
  'The vault district counts its money twice a day. So does everyone else.',
  'A Klerk courier saw nothing. A Klerk courier is never asked.',
  'The neon signs flicker in a pattern that means nothing. Probably.',
  'Somebody left a crate of K-Cash on the corner. Nobody moves it.',
  'The factory siren goes unanswered again. That is not your problem.',
  'Rain taps the academy roof like it wants in.',
  'The house always smiles. That is the warning.',
];

const COLORS = [
  { name: 'Midnight', hex: '#011627' }, { name: 'Blood', hex: '#ef233c' },
  { name: 'Gold', hex: '#ffd60a' }, { name: 'Neon Cyan', hex: '#00d4ff' },
  { name: 'Violet', hex: '#b14bff' }, { name: 'Mint', hex: '#06d6a0' },
  { name: 'Ash', hex: '#9aa0b5' }, { name: 'Amber', hex: '#ff9f1c' },
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

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rand(0, arr.length - 1)];
const clamp = (v) => Math.max(0, Math.floor(Number(v) || 0));
const kc = (v) => `${Number(v || 0).toLocaleString('en-US')} ${CASH}`;
const num = (v) => Number(v || 0).toLocaleString('en-US');
const story = () => pick(CRIME_LORE);

const XP_FOR_LEVEL = (level) => level * 500;
const stars = (n) => '★'.repeat(clamp(n)) + '☆'.repeat(Math.max(0, 5 - clamp(n)));

/**
 * The GTA record, backfilled field by field.
 *
 * Backfilling per field matters here more than usual: `cars` and `weapons` are
 * arrays that mongoose hands back as real arrays, but a document saved before
 * this module has no `gta` at all, and a partially written one is missing
 * individual numbers. `undefined + 1` would be NaN and would then persist into
 * every level calculation.
 */
function g(userDoc) {
  if (!userDoc.gta || typeof userDoc.gta !== 'object') userDoc.gta = {};
  const t = userDoc.gta;
  for (const f of [
    'level', 'xp', 'money', 'spent', 'wanted', 'racesWon', 'racesLost', 'pvpWins', 'pvpLosses',
    'missions', 'busts',
  ]) {
    if (!Number.isFinite(t[f])) t[f] = f === 'level' ? 1 : 0;
  }
  t.wanted = Math.max(0, Math.min(5, clamp(t.wanted)));
  if (!Array.isArray(t.cars)) t.cars = [];
  if (!Array.isArray(t.weapons)) t.weapons = [];
  if (typeof t.started !== 'boolean') t.started = false;
  if (typeof t.activeCar !== 'string') t.activeCar = '';
  if (typeof t.activeWeapon !== 'string') t.activeWeapon = '';
  if (typeof t.cartel !== 'string') t.cartel = '';
  return t;
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

/** Take coins. Returns { ok } or { ok:false, reason } so callers can reply. */
async function spend(userDoc, amount, action, metadata = {}) {
  const cost = clamp(amount);
  if (cost <= 0) return { ok: true };
  if ((userDoc.coins || 0) < cost) {
    return { ok: false, reason: `💸 **Not enough.** You need ${kc(cost)} and you have ${kc(userDoc.coins)}.` };
  }
  userDoc.coins = clamp(userDoc.coins - cost);
  g(userDoc).spent += cost;
  await save(userDoc);
  await ledger(userDoc.uid, action, -cost, userDoc.coins, metadata);
  return { ok: true };
}

/** Pay out. Returns { ok } or { ok:false, reason } when broke. */
async function earn(userDoc, amount, action, metadata = {}) {
  const gain = clamp(amount);
  if (gain <= 0) return { ok: true };
  userDoc.coins = clamp((userDoc.coins || 0) + gain);
  await save(userDoc);
  await ledger(userDoc.uid, action, gain, userDoc.coins, metadata);
  return { ok: true };
}

/** Bank winnings into the GTA purse as well as the wallet. */
async function bank(userDoc, amount) {
  const t = g(userDoc);
  t.money = clamp(t.money) + clamp(amount);
  await save(userDoc);
}

/** Award GTA xp and roll any level-ups it earned. */
async function grantXp(userDoc, amount) {
  const t = g(userDoc);
  t.xp = clamp(t.xp) + clamp(amount);
  const ups = [];
  // while, not if: one mission can clear several levels at low xp costs.
  while (clamp(t.xp) >= XP_FOR_LEVEL(t.level)) {
    t.xp -= XP_FOR_LEVEL(t.level);
    t.level = clamp(t.level) + 1;
    ups.push(t.level);
  }
  await save(userDoc);
  return ups;
}

/** Add stars, clamped to five, and stamp when the heat started. */
async function addWanted(userDoc, amount) {
  const t = g(userDoc);
  t.wanted = Math.max(0, Math.min(5, clamp(t.wanted) + clamp(amount)));
  if (t.wanted > 0 && !t.wantedAt) t.wantedAt = new Date();
  if (t.wanted === 0) t.wantedAt = null;
  await save(userDoc);
  return t.wanted;
}

/** Is this hunter in the can right now? */
function jailed(userDoc) {
  const t = g(userDoc);
  if (!t.jailedUntil) return false;
  if (new Date(t.jailedUntil).getTime() <= Date.now()) {
    t.jailedUntil = null;
    return false;
  }
  return true;
}

/** Minutes left in the cell, 0 when free. */
function jailLeft(userDoc) {
  const t = g(userDoc);
  if (!jailed(userDoc)) return 0;
  return Math.ceil((new Date(t.jailedUntil).getTime() - Date.now()) / 60000);
}

/**
 * Settle an expired five-star hunt.
 *
 * The hunt is a debt that matures: when the ten minutes run out the cops take
 * half the wallet. This is called from the commands that surface heat, because
 * there is no scheduler behind the bot to run it on a timer, and it must not
 * run from g(), which is a pure backfill.
 *
 * Returns a description when it collected, so the caller can tell the player.
 */
async function settleHunt(userDoc) {
  const t = g(userDoc);
  if (!t.copsHuntUntil) return null;
  if (new Date(t.copsHuntUntil).getTime() > Date.now()) return null;

  t.copsHuntUntil = null;
  const due = Math.floor(clamp(userDoc.coins) * 0.5);
  if (due > 0) {
    userDoc.coins = clamp(userDoc.coins - due);
    await save(userDoc);
    await ledger(userDoc.uid, 'gta:cops_theft', -due, userDoc.coins, { stolen: due });
  }
  // The hunt is over either way. The stars are not: they cool down on their own
  // or by bribe, which is the whole reason gtawanted tells you to sit still.
  return due > 0 ? `👮 The hunt ran out. They took ${kc(due)} — half of what you were carrying.` : '';
}

async function jail(userDoc, minutes, action) {
  const t = g(userDoc);
  t.jailedUntil = new Date(Date.now() + minutes * 60000);
  t.busts = clamp(t.busts) + 1;
  await save(userDoc);
  await ledger(userDoc.uid, action, 0, userDoc.coins, { jailMinutes: minutes });
}

/**
 * The player's car record, or null when the garage is empty.
 * `id` accepts an id or a name, so `!gtatune Phantom Prime` works.
 */
function ownedCar(userDoc, id) {
  const t = g(userDoc);
  const ref = id ? findCar(id) : null;
  const want = ref ? ref.id : String(id || t.activeCar || '');
  return t.cars.find((c) => c && String(c.id) === want) || null;
}

/** Power of the active car, 0 when they own nothing. */
function carPower(userDoc) {
  const rec = ownedCar(userDoc);
  if (!rec) return 0;
  const base = CAR_BY_ID.get(rec.id);
  if (!base) return 0;
  return clamp(base.power) + (rec.tuned ? 20 : 0);
}

/** The player's weapon record, or null when the armoury is empty. */
function ownedWeapon(userDoc, id) {
  const t = g(userDoc);
  const ref = id ? findWeapon(id) : null;
  const want = ref ? ref.id : String(id || t.activeWeapon || '');
  return t.weapons.find((w) => w && String(w.id) === want) || null;
}

/** Damage of the active weapon, 0 when they own nothing. */
function weaponDmg(userDoc) {
  const rec = ownedWeapon(userDoc);
  if (!rec) return 0;
  const base = WEAPON_BY_ID.get(rec.id);
  return base ? clamp(base.dmg) : 0;
}

/**
 * Mission payout multiplier from the player's best living pet.
 *
 * The lava dragon rides shotgun: it takes 20% off the payout on every mission.
 * Best effort, and only when the database is up, because a pet bonus must
 * never be the reason a mission refuses to run.
 */
async function petBonus(userDoc) {
  if (!mongo.isReady()) return { mult: 1, note: '' };
  try {
    // eslint-disable-next-line global-require
    const Pet = require('../models/Pet');
    const pet = await Pet.findOne({ ownerUid: String(userDoc.uid), isDead: false }).sort({ basePower: -1 });
    if (pet && pet.type === 'infernal') return { mult: 1.2, note: '🐉 Infernal Wyrm rode shotgun (+20%)' };
    return { mult: 1, note: '' };
  } catch {
    return { mult: 1, note: '' };
  }
}

/** Take the standard 10% cartel tax on a mission payout, if in a cartel. */
async function cartelTax(userDoc, event, amount) {
  const t = g(userDoc);
  if (!t.cartel) return 0;
  if (!mongo.isReady()) return 0;
  const group = await Group.findOne({ tid: String(event.threadID) }).catch(() => null);
  if (!group || !group.cartel || !group.cartel.name) return 0;
  if (String(group.cartel.name) !== String(t.cartel)) return 0;

  const cut = Math.max(1, Math.floor(clamp(amount) * 0.1));
  group.cartel.vault = clamp(group.cartel.vault) + cut;
  try { await group.save(); } catch { return 0; }
  await ledger(userDoc.uid, 'gta:cartel_tax', 0, userDoc.coins, { cartel: t.cartel, cut });
  return cut;
}

/** Resolve @tag, raw uid, or exact name to a User document. */
async function resolveTarget(ref, event) {
  const clean = String(ref || '').replace(/^@/, '').trim();
  if (!clean) return null;
  if (/^\d+$/.test(clean)) return User.findOne({ uid: clean });

  const tagged = event.mentions && Object.values(event.mentions).find((m) => String(m) === clean);
  if (tagged) return User.findOne({ uid: String(tagged) });

  const safe = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return User.findOne({ name: new RegExp(`^${safe}$`, 'i') });
}

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

/** Give ammo to the active weapon, or the strongest one they own. */
async function giveAmmo(userDoc, rounds) {
  const t = g(userDoc);
  if (!t.weapons.length) return false;
  const rec = ownedWeapon(userDoc) || t.weapons[t.weapons.length - 1];
  const base = WEAPON_BY_ID.get(rec.id);
  rec.ammo = clamp(rec.ammo) + clamp(rounds !== undefined ? rounds : (base ? base.ammo : 10));
  await save(userDoc);
  return true;
}

/**
 * Paint the car card. Returns a data URL, or null when the native canvas binary
 * is missing so the caller can fall back to text.
 */
async function carCard(car, power, wanted, extra = '') {
  const made = canvasKit.create(800, 400);
  if (!made) return null;
  const { ctx } = made;

  const bg = ctx.createLinearGradient(0, 0, 800, 400);
  bg.addColorStop(0, canvasKit.theme.bg1);
  bg.addColorStop(1, canvasKit.theme.bg2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 800, 400);

  ctx.fillStyle = car.color || canvasKit.theme.accent;
  ctx.fillRect(0, 0, 800, 8);

  // Silhouette block, coloured by the car's paint.
  ctx.fillStyle = car.color || canvasKit.theme.accent;
  ctx.beginPath();
  ctx.moveTo(90, 250);
  ctx.lineTo(150, 180);
  ctx.lineTo(280, 170);
  ctx.lineTo(330, 200);
  ctx.lineTo(650, 200);
  ctx.lineTo(700, 250);
  ctx.lineTo(700, 275);
  ctx.lineTo(90, 275);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#0f0f1a';
  for (const wx of [200, 560]) {
    ctx.beginPath();
    ctx.arc(wx, 278, 30, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = canvasKit.theme.text;
  ctx.font = 'bold 46px iKonSans';
  ctx.fillText(car.name, 60, 100);

  ctx.fillStyle = canvasKit.theme.gold;
  ctx.font = 'bold 32px iKonSans';
  ctx.fillText(`${num(power)} PWR`, 60, 145);

  ctx.fillStyle = canvasKit.theme.accent2;
  ctx.font = '28px iKonSans';
  ctx.fillText(`WANTED ${stars(wanted)}`, 60, 330);

  if (extra) {
    ctx.fillStyle = canvasKit.theme.muted;
    ctx.font = '22px iKonSans';
    ctx.fillText(extra, 300, 145);
  }

  const buffer = await canvasKit.toBuffer(made.canvas);
  return buffer ? `data:image/png;base64,${buffer.toString('base64')}` : null;
}

/** Every command in this module, in registration order. */
const commands = [];

// ───────────────────────────────────────────────────────────
// THE LIFE — start, stats, missions
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'gtastart',
    aliases: [],
    category: 'gta',
    description: '🚗 Start your life of crime. Everything after this costs money',
    usage: '!gtastart',
    cooldown: 30,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtastart', async () => {
      await react('🚗');
      const t = g(userDoc);
      if (t.started) {
        await reply(`🚗 You are already in the life, level ${t.level}.\n📖 ${story()}`, event.messageID);
        return;
      }

      t.started = true;
      t.level = 1;
      t.xp = 0;
      t.money = 0;
      t.wanted = 0;
      t.cars = [];
      t.weapons = [];
      // Everyone starts with a beater and a sidearm. The garage does the rest.
      t.cars.push({ id: 'sultanrs', fuel: 100, nitro: false, tuned: false, crashed: false, color: '#9aa0b5' });
      t.weapons.push({ id: 'pistol', ammo: 12 });
      t.activeCar = 'sultanrs';
      t.activeWeapon = 'pistol';
      await save(userDoc);
      await bank(userDoc, 0);

      await reply(
        `🚗 **YOU ARE IN THE LIFE.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🎖️ Level 1 · ⭐ ${stars(0)}\n`
        + `🚙 You are handed a Sultan RS and a Pistol.\n`
        + `💵 Wallet: ${kc(userDoc.coins)}\n\n`
        + 'Missions pay. Cars cost. Fuel costs. The maths is the game.\n'
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtastats',
    aliases: ['gtaprof'],
    category: 'gta',
    description: '📊 Your GTA record — level, wanted, garage, armoury, winnings',
    usage: '!gtastats',
    cooldown: 15,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtastats', async () => {
      await react('📊');
      const t = g(userDoc);
      await settleHunt(userDoc);
      if (!t.started) {
        await reply('🚗 You have not started yet. `!gtastart` first.', event.messageID);
        return;
      }

      const car = ownedCar(userDoc);
      const base = car ? CAR_BY_ID.get(car.id) : null;
      const need = XP_FOR_LEVEL(t.level);
      const pct = need ? Math.min(100, Math.round((clamp(t.xp) / need) * 100)) : 0;

      await reply(
        `📊 **${userDoc.name} — GTA RECORD**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🎖️ Level ${t.level} · XP ${num(t.xp)}/${num(need)} (${pct}%)\n`
        + `⭐ Wanted ${stars(t.wanted)} (${t.wanted}/5)\n`
        + `💰 GTA winnings: ${kc(t.money)}\n`
        + `💸 Lifetime spend: ${kc(t.spent)}\n`
        + `💼 Wallet: ${kc(userDoc.coins)}\n`
        + `🚙 Garage: ${t.cars.length} car(s)${base ? ` — active ${base.name} (${num(carPower(userDoc))} pwr${car.tuned ? ' +20 tuned' : ''})` : ''}\n`
        + `🔫 Armoury: ${t.weapons.length} weapon(s) — ${t.activeWeapon || 'none equipped'}\n`
        + `🏁 Races ${num(t.racesWon)}W/${num(t.racesLost)}L · Missions ${num(t.missions)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtamission',
    aliases: ['gta', 'gtam'],
    category: 'gta',
    description: '🎯 Take a job — drive, shoot, escape, and hope the heat stays off you',
    usage: '!gtamission',
    cooldown: 120,
    permission: 'all',
    execute: async ({ event, userDoc, reply, react }) => guard(reply, event.messageID, 'gtamission', async () => {
      await react('🎯');
      const t = g(userDoc);
      if (!t.started) {
        await reply('🚗 You have not started yet. `!gtastart` first.', event.messageID);
        return;
      }
      if (jailed(userDoc)) {
        await reply(`🔒 **Still in the cell.** ${jailLeft(userDoc)} minutes left.\nNothing in this city is worth that.`, event.messageID);
        return;
      }

      // Cars are not just a flex: power below the mission floor makes the job
      // meaningfully harder, which is what keeps the garage worth buying.
      const power = carPower(userDoc);
      const m = pick(MISSIONS);
      const risk = power > 0 ? Math.min(0.85, m.risk + (power < 200 ? 0.10 : 0)) : m.risk + 0.15;

      await reply(`🎯 **${m.name.toUpperCase()}**\n━━━━━━━━━━━━━━━\n📍 Risk ${Math.round(risk * 100)}% · Reward ${num(m.reward[0])} - ${num(m.reward[1])} ${CASH}\n📖 ${story()}`, event.messageID);

      for (const step of m.steps) {
        await sleep(700);
        await reply(`▸ ${step}`);
      }

      const failed = Math.random() < risk;
      t.missions = clamp(t.missions) + 1;
      await save(userDoc);

      if (failed) {
        const stars2 = await addWanted(userDoc, m.wanted);
        await reply(
          `💥 **IT WENT WRONG.**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `⭐ Wanted ${stars(stars2)} (${stars2}/5)\n`
          + `💸 Nothing paid. The car is scratched.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const pet = await petBonus(userDoc);
      let reward = rand(m.reward[0], m.reward[1]);
      reward = Math.floor(reward * pet.mult);
      const tax = await cartelTax(userDoc, event, reward);
      const net = Math.max(0, reward - tax);

      await earn(userDoc, net, 'gta:mission', { mission: m.id, reward: net });
      await bank(userDoc, net);
      const ups = await grantXp(userDoc, 120 + reward);
      // A clean run still leaves a little heat, which is the tax on greed.
      const stars2 = await addWanted(userDoc, 1);

      await reply(
        `✅ **CLEAN GETAWAY.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💰 +${kc(net)}${tax ? ` (${kc(tax)} to the cartel)` : ''}\n`
        + `⭐ Wanted ${stars(stars2)} (${stars2}/5)\n`
        + `🎖️ XP +${num(120 + reward)}${ups.length ? ` — **LEVEL ${ups[ups.length - 1]}**` : ''}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + (pet.note ? `${pet.note}\n` : '')
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtamissionhard',
    aliases: ['gtahard', 'gtacoup'],
    category: 'gta',
    description: '💀 The vault coup — 400 power car and a real gun required, 60% bust rate',
    usage: '!gtamissionhard',
    cooldown: 600,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtamissionhard', async () => {
      await react('💀');
      const t = g(userDoc);
      if (!t.started) {
        await reply('🚗 You have not started yet. `!gtastart` first.', event.messageID);
        return;
      }
      if (jailed(userDoc)) {
        await reply(`🔒 **Still in the cell.** ${jailLeft(userDoc)} minutes left.`, event.messageID);
        return;
      }

      // The gates are checked before the roll, so a player without the hardware
      // is told exactly what to buy instead of watching a 60% bust.
      const power = carPower(userDoc);
      if (power < 400) {
        const need = CARS.filter((c) => c.power + 20 >= 400).map((c) => c.name).join(', ');
        await reply(`❌ **Not the car for this.** You have ${num(power)} power, this needs 400.\n🏎️ ${need}`, event.messageID);
        return;
      }
      const dmg = weaponDmg(userDoc);
      if (dmg < 150) {
        const need = WEAPONS.filter((w) => w.dmg >= 150).map((w) => w.name).join(', ');
        await reply(`❌ **Not the gun for this.** You have ${num(dmg)} damage, this needs 150.\n🔫 ${need}`, event.messageID);
        return;
      }

      await reply('💀 **THE VAULT COUP**\n━━━━━━━━━━━━━━━\n📍 60% bust rate\n📖 Somebody in here is definitely watching.', event.messageID);
      for (const step of HARD_MISSION.steps) {
        await sleep(700);
        await reply(`▸ ${step}`);
      }

      t.missions = clamp(t.missions) + 1;
      await save(userDoc);

      if (Math.random() < HARD_MISSION.risk) {
        const stars2 = await addWanted(userDoc, 5);
        t.copsHuntUntil = new Date(Date.now() + 10 * 60 * 1000);
        await save(userDoc);
        await reply(
          `🚨 **THE COPS ARE ALL OVER YOU.**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `⭐ Wanted ${stars(stars2)} (5/5)\n`
          + `👮 They will take half your coins unless you bribe or run.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const pet = await petBonus(userDoc);
      let reward = rand(HARD_MISSION.reward[0], HARD_MISSION.reward[1]);
      reward = Math.floor(reward * pet.mult);
      const tax = await cartelTax(userDoc, event, reward);
      const net = Math.max(0, reward - tax);

      await earn(userDoc, net, 'gta:mission_hard', { reward: net });
      await bank(userDoc, net);
      const ups = await grantXp(userDoc, 900);
      const stars2 = await addWanted(userDoc, 2);

      await reply(
        `🏆 **THE COUP LANDED.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💰 +${kc(net)}${tax ? ` (${kc(tax)} to the cartel)` : ''}\n`
        + `⭐ Wanted ${stars(stars2)} (${stars2}/5)\n`
        + `🎖️ XP +900${ups.length ? ` — **LEVEL ${ups[ups.length - 1]}**` : ''}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + (pet.note ? `${pet.note}\n` : '')
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

// ───────────────────────────────────────────────────────────
// THE GARAGE ECONOMY
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'gtacarshop',
    aliases: ['carshop', 'gtacars'],
    category: 'gta',
    description: '🏎️ The garage — twelve cars and the one you should not buy',
    usage: '!gtacarshop',
    cooldown: 30,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtacarshop', async () => {
      await react('🏎️');
      const t = g(userDoc);
      const lines = CARS.map((c) => {
        const owned = t.cars.some((x) => x && x.id === c.id);
        return `${owned ? '✅' : '🔒'} **${c.name}** — ${kc(c.price)} · ${num(c.power)} pwr`;
      });
      const prime = CARS[CARS.length - 1];

      await reply(
        `🏎️ **THE GARAGE**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.slice(0, -1).join('\n')}\n\n`
        + `👑 **${prime.name}** — ${kc(prime.price)} · ${num(prime.power)} pwr\n`
        + `📖 One exists. The man who sold it will not say where it came from.\n\n`
        + `💼 You have ${kc(userDoc.coins)}.\n`
        + `🛒 Buy with \`!gtabuycar <name>\``,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtabuycar',
    aliases: ['gtacargobuy'],
    category: 'gta',
    description: '🛒 Buy a car. This is where the money goes',
    usage: '!gtabuycar <name>',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtabuycar', async () => {
      await react('🛒');
      const t = g(userDoc);
      if (!t.started) {
        await reply('🚗 You have not started yet. `!gtastart` first.', event.messageID);
        return;
      }

      const car = findCar(args[0]);
      if (!car) {
        await reply(`❌ No such car. \`!gtacarshop\` lists the lot.`, event.messageID);
        return;
      }
      if (t.cars.some((c) => c && c.id === car.id)) {
        await reply(`🚗 You already own the ${car.name}. \`!gtagarage\` to switch to it.`, event.messageID);
        return;
      }

      const paid = await spend(userDoc, car.price, 'gta:buyCar', { car: car.id });
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      t.cars.push({ id: car.id, fuel: 100, nitro: false, tuned: false, crashed: false, color: car.color });
      t.activeCar = car.id;
      await save(userDoc);

      const card = await carCard(car, car.power, t.wanted, 'NEW');
      const text = `🛒 **${car.name} IS PARKED OUTSIDE.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💸 -${kc(car.price)}\n`
        + `⚡ ${num(car.power)} power\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`;

      if (card) await reply({ attachment: { type: 'image', data: { url: card } } });
      await reply(text, event.messageID);
    }),
  });

  commands.push({
    name: 'gtagarage',
    aliases: ['gtacars'],
    category: 'gta',
    description: '🔑 Your garage — pick which car is active',
    usage: '!gtagarage [car]',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtagarage', async () => {
      await react('🔑');
      const t = g(userDoc);
      if (!t.started) {
        await reply('🚗 You have not started yet. `!gtastart` first.', event.messageID);
        return;
      }
      if (!t.cars.length) {
        await reply('🔑 Empty garage. `!gtabuycar <name>` first.', event.messageID);
        return;
      }

      const want = String(args[0] || '').toLowerCase();
      if (!want) {
        const rows = t.cars.map((c) => {
          const base = CAR_BY_ID.get(c.id);
          if (!base) return `• ??? (${c.id})`;
          const flags = [
            c.id === t.activeCar ? '▶ active' : '',
            c.tuned ? '+20 tuned' : '',
            c.crashed ? '💥 crashed' : '',
            `⛽ ${clamp(c.fuel)}%`,
          ].filter(Boolean).join(' · ');
          return `• **${base.name}** — ${num(base.power)} pwr — ${flags}`;
        });
        await reply(
          `🔑 **YOUR GARAGE (${t.cars.length})**\n━━━━━━━━━━━━━━━\n${rows.join('\n')}\n\n`
          + `Switch with \`!gtagarage <name>\``,
          event.messageID,
        );
        return;
      }

      const car = findCar(want);
      const rec = car && t.cars.find((c) => c && c.id === car.id);
      if (!rec) {
        await reply(`❌ You do not own that car.`, event.messageID);
        return;
      }
      if (rec.crashed) {
        await reply(`💥 The ${car.name} is on a lift. \`!gtarepair\` first.`, event.messageID);
        return;
      }
      if (clamp(rec.fuel) <= 0) {
        await reply(`⛽ The ${car.name} is dry. \`!gtafuel\` first.`, event.messageID);
        return;
      }

      t.activeCar = rec.id;
      await save(userDoc);
      await reply(`▶ **${car.name}** is the one you take out.\n⚡ ${num(carPower(userDoc))} power\n📖 ${story()}`, event.messageID);
    }),
  });

  commands.push({
    name: 'gtadrive',
    aliases: ['gtadrivecar'],
    category: 'gta',
    description: '🚙 Take the car out. Fuel burns, things crash, occasionally you find money',
    usage: '!gtadrive',
    cooldown: 60,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtadrive', async () => {
      await react('🚙');
      const t = g(userDoc);
      if (!t.started) {
        await reply('🚗 You have not started yet. `!gtastart` first.', event.messageID);
        return;
      }
      if (jailed(userDoc)) {
        await reply(`🔒 **Still in the cell.** ${jailLeft(userDoc)} minutes left. No driving.`, event.messageID);
        return;
      }

      const rec = ownedCar(userDoc);
      if (!rec) {
        await reply('🔑 No active car. `!gtagarage <name>` to pick one.', event.messageID);
        return;
      }
      const base = CAR_BY_ID.get(rec.id);
      if (rec.crashed) {
        await reply(`💥 The ${base.name} is on a lift and will not start. \`!gtarepair\` first.`, event.messageID);
        return;
      }
      if (clamp(rec.fuel) <= 0) {
        await reply(`⛽ **Out of fuel.** \`!gtafuel\` costs 500 and this is why.`, event.messageID);
        return;
      }

      await reply(`🚙 Taking the ${base.name} out...`, event.messageID);
      await sleep(700);

      // Power buys safety: a Phantom Prime is not the same 5% crash risk.
      const pwr = carPower(userDoc);
      const crashChance = Math.max(0.01, 0.05 - pwr / 40000);
      const drained = clamp(rec.fuel) - rand(8, 20);
      rec.fuel = Math.max(0, drained);
      await save(userDoc);

      const roll = Math.random();
      if (roll < crashChance) {
        rec.crashed = true;
        await save(userDoc);
        const bill = clamp(Math.floor(500 + pwr * 0.4));
        const paid = await spend(userDoc, bill, 'gta:crash_bill', { car: rec.id });
        await reply(
          `💥 **YOU CRASHED.**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `🚙 The ${base.name} is on a lift.\n`
          + `🔧 Repair bill: ${kc(bill)}${paid.ok ? ' — paid' : ' — you cannot pay it'}\n`
          + `⛽ Fuel left: ${num(rec.fuel)}%\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      if (roll < crashChance + 0.10) {
        const loot = rand(200, 900);
        await earn(userDoc, loot, 'gta:drive_loot', { car: rec.id });
        await bank(userDoc, loot);
        await reply(
          `💵 **SOMETHING WAS IN THE GLOVEBOX.**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `+${kc(loot)}\n⛽ Fuel left: ${num(rec.fuel)}%\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      await reply(
        `🚙 **A CLEAN HOUR.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `⛽ Fuel left: ${num(rec.fuel)}%\n`
        + `💼 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtafuel',
    aliases: ['gtagas'],
    category: 'gta',
    description: '⛽ Fill the tank — 500 coins, and it is never enough',
    usage: '!gtafuel',
    cooldown: 60,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtafuel', async () => {
      await react('⛽');
      const t = g(userDoc);
      const rec = ownedCar(userDoc);
      if (!rec) {
        await reply('🔑 No active car. `!gtagarage <name>` to pick one.', event.messageID);
        return;
      }
      const base = CAR_BY_ID.get(rec.id);
      if (clamp(rec.fuel) >= 100) {
        await reply(`⛽ The ${base.name} tank is already full.`, event.messageID);
        return;
      }

      const paid = await spend(userDoc, 500, 'gta:fuel', { car: rec.id });
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }
      rec.fuel = 100;
      await save(userDoc);

      await reply(`⛽ **TANK FULL.**\n━━━━━━━━━━━━━━━\n💸 -500\n🚙 ${base.name}\n📖 ${story()}`, event.messageID);
    }),
  });

  commands.push({
    name: 'gtarepair',
    aliases: [],
    category: 'gta',
    description: '🔧 Get the car off the lift. Cost scales with how fast it is',
    usage: '!gtarepair',
    cooldown: 60,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtarepair', async () => {
      await react('🔧');
      const rec = ownedCar(userDoc);
      if (!rec) {
        await reply('🔑 No active car. `!gtagarage <name>` to pick one.', event.messageID);
        return;
      }
      const base = CAR_BY_ID.get(rec.id);
      if (!rec.crashed) {
        await reply(`🔧 The ${base.name} is fine. Nothing to fix.`, event.messageID);
        return;
      }

      // Repair scales with power so a Phantom Prime is a real financial event
      // and the starter Sultan RS is not a wall.
      const bill = clamp(Math.floor(500 + (base.power + (rec.tuned ? 20 : 0)) * 0.4));
      const paid = await spend(userDoc, bill, 'gta:repair', { car: rec.id });
      if (!paid.ok) {
        await reply(`${paid.reason}\n💵 The bill is ${kc(bill)}.`, event.messageID);
        return;
      }

      rec.crashed = false;
      rec.fuel = Math.max(clamp(rec.fuel), 50);
      await save(userDoc);

      await reply(
        `🔧 **BACK ON THE ROAD.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💸 -${kc(bill)}\n`
        + `🚙 ${base.name}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtacrash',
    aliases: ['gtacrashed'],
    category: 'gta',
    description: '💥 How wrecked the car is, and what the mechanic says about it',
    usage: '!gtacrash',
    cooldown: 30,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtacrash', async () => {
      await react('💥');
      const t = g(userDoc);
      const rec = ownedCar(userDoc);
      if (!rec) {
        await reply('🔑 No active car. `!gtagarage <name>` to pick one.', event.messageID);
        return;
      }
      const base = CAR_BY_ID.get(rec.id);

      if (t.cars.filter((c) => c && c.crashed).length) {
        const wrecked = t.cars.filter((c) => c && c.crashed)
          .map((c) => `• ${(CAR_BY_ID.get(c.id) || {}).name || c.id}`).join('\n');
        await reply(`💥 **ON THE LIFT**\n━━━━━━━━━━━━━━━\n${wrecked}\n🔧 \`!gtarepair\``, event.messageID);
        return;
      }

      await reply(
        `💥 **NOTHING IS ON THE LIFT.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🚙 ${base.name} is running.\n⛽ Fuel ${num(rec.fuel)}%\n`
        + `📖 The mechanic charges 500 an hour to look at it and find nothing.`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtatune',
    aliases: ['gtatuning'],
    category: 'gta',
    description: '🔧 +20 permanent power, once per car, for 10,000',
    usage: '!gtatune [car]',
    cooldown: 120,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtatune', async () => {
      await react('🔧');
      const t = g(userDoc);
      const rec = ownedCar(userDoc, args[0]);
      if (!rec) {
        await reply('🔑 You do not own that car, or you have not started.', event.messageID);
        return;
      }
      const base = CAR_BY_ID.get(rec.id);
      if (rec.tuned) {
        await reply(`🔧 The ${base.name} is already tuned. You do not tune it twice.`, event.messageID);
        return;
      }

      const paid = await spend(userDoc, 10000, 'gta:tune', { car: rec.id });
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }
      rec.tuned = true;
      await save(userDoc);

      await reply(
        `🔧 **TUNED.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🚙 ${base.name}: ${num(base.power)} → **${num(base.power + 20)} pwr**\n`
        + `💸 -10,000\n`
        + `📖 It sounds wrong and it is faster.`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtacustomize',
    aliases: ['gtapaintjob'],
    category: 'gta',
    description: '🎨 Repaint the car — 1,000 and a card showing the new colour',
    usage: '!gtacustomize <colour>',
    cooldown: 60,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtacustomize', async () => {
      await react('🎨');
      const t = g(userDoc);
      const rec = ownedCar(userDoc);
      if (!rec) {
        await reply('🔑 No active car. `!gtagarage <name>` to pick one.', event.messageID);
        return;
      }
      const base = CAR_BY_ID.get(rec.id);
      const want = String(args[0] || '').toLowerCase();
      if (!want) {
        await reply(
          `🎨 **THE SWATCH BOOK**\n━━━━━━━━━━━━━━━\n${COLORS.map((c) => `• ${c.name} (\`${c.hex}\`)`).join('\n')}\n\n`
          + `Repaint costs 1,000. \`!gtacustomize gold\``,
          event.messageID,
        );
        return;
      }

      const colour = COLORS.find((c) => c.name.toLowerCase() === want || c.hex === want)
        || COLORS.find((c) => c.name.toLowerCase().includes(want));
      if (!colour) {
        await reply(`❌ No such colour. \`!gtacustomize\` lists the swatches.`, event.messageID);
        return;
      }

      const paid = await spend(userDoc, 1000, 'gta:paint', { car: rec.id, color: colour.name });
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }
      rec.color = colour.hex;
      await save(userDoc);

      const painted = { ...base, color: colour.hex };
      const card = await carCard(painted, carPower(userDoc), t.wanted, colour.name.toUpperCase());
      if (card) await reply({ attachment: { type: 'image', data: { url: card } } });
      await reply(`🎨 **${base.name} is now ${colour.name}.**\n💸 -1,000\n📖 ${story()}`, event.messageID);
    }),
  });

  commands.push({
    name: 'gtanitro',
    aliases: ['gtanitrous'],
    category: 'gta',
    description: '💨 Nitro, once per car — the difference between winning and not',
    usage: '!gtanitro [car]',
    cooldown: 120,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtanitro', async () => {
      await react('💨');
      const rec = ownedCar(userDoc, args[0]);
      if (!rec) {
        await reply('🔑 You do not own that car, or you have not started.', event.messageID);
        return;
      }
      const base = CAR_BY_ID.get(rec.id);
      if (rec.nitro) {
        await reply(`💨 The ${base.name} already has the bottle. One per car.`, event.messageID);
        return;
      }

      const paid = await spend(userDoc, 5000, 'gta:nitro', { car: rec.id });
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }
      rec.nitro = true;
      await save(userDoc);

      await reply(
        `💨 **NITRO ARMED.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🚙 ${base.name}\n`
        + `💸 -5,000\n`
        + `📖 One burst. You will want it.`,
        event.messageID,
      );
    }),
  });

// ───────────────────────────────────────────────────────────
// THE ARMOURY AND THE SHOOTING
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'gtaweaponshop',
    aliases: ['gunshop'],
    category: 'gta',
    description: '🔫 The armoury — eight guns, from a pistol to a railgun',
    usage: '!gtaweaponshop',
    cooldown: 30,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtaweaponshop', async () => {
      await react('🔫');
      const t = g(userDoc);
      const lines = WEAPONS.map((w) => {
        const owned = t.weapons.some((x) => x && x.id === w.id);
        return `${owned ? '✅' : '🔒'} **${w.name}** — ${kc(w.price)} · ${num(w.dmg)} dmg`;
      });
      await reply(
        `🔫 **THE ARMOURY**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n\n`
        + `💼 You have ${kc(userDoc.coins)}.\n`
        + `🛒 Buy with \`!gtabuyweapon <name>\``,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtabuyweapon',
    aliases: ['gtagunbuy'],
    category: 'gta',
    description: '🛒 Buy a gun. The railgun costs more than your first three missions',
    usage: '!gtabuyweapon <name>',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtabuyweapon', async () => {
      await react('🛒');
      const t = g(userDoc);
      if (!t.started) {
        await reply('🚗 You have not started yet. `!gtastart` first.', event.messageID);
        return;
      }

      const gun = findWeapon(args[0]);
      if (!gun) {
        await reply(`❌ No such weapon. \`!gtaweaponshop\` lists the stock.`, event.messageID);
        return;
      }
      if (t.weapons.some((w) => w && w.id === gun.id)) {
        await reply(`🔫 You already own the ${gun.name}. \`!gtaweapons\` to switch to it.`, event.messageID);
        return;
      }

      const paid = await spend(userDoc, gun.price, 'gta:buyWeapon', { weapon: gun.id });
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      t.weapons.push({ id: gun.id, ammo: gun.ammo });
      t.activeWeapon = gun.id;
      await save(userDoc);

      await reply(
        `🛒 **${gun.name.toUpperCase()} ACQUIRED.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💸 -${kc(gun.price)}\n`
        + `🎯 ${num(gun.dmg)} damage · ${num(gun.ammo)} rounds\n`
        + `👛 Wallet: ${kc(userDoc.coins)}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtaweapons',
    aliases: ['gtaarmoury', 'gtaguns'],
    category: 'gta',
    description: '🔫 Your armoury — pick which gun is equipped',
    usage: '!gtaweapons [gun]',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtaweapons', async () => {
      await react('🔫');
      const t = g(userDoc);
      if (!t.weapons.length) {
        await reply('🔫 Empty armoury. `!gtabuyweapon <name>` first.', event.messageID);
        return;
      }

      const want = String(args[0] || '').toLowerCase();
      if (!want) {
        const rows = t.weapons.map((w) => {
          const base = WEAPON_BY_ID.get(w.id);
          if (!base) return `• ??? (${w.id})`;
          return `• **${base.name}** — ${num(base.dmg)} dmg — ${num(w.ammo)} rounds${w.id === t.activeWeapon ? ' — ▶ equipped' : ''}`;
        });
        await reply(
          `🔫 **YOUR ARMOURY (${t.weapons.length})**\n━━━━━━━━━━━━━━━\n${rows.join('\n')}\n\n`
          + `Equip with \`!gtaweapons <gun>\``,
          event.messageID,
        );
        return;
      }

      const gun = findWeapon(want);
      const rec = gun && t.weapons.find((w) => w && w.id === gun.id);
      if (!rec) {
        await reply(`❌ You do not own that gun.`, event.messageID);
        return;
      }

      t.activeWeapon = rec.id;
      await save(userDoc);
      await reply(`▶ **${gun.name}** equipped — ${num(gun.dmg)} damage, ${num(rec.ammo)} rounds.`, event.messageID);
    }),
  });

  commands.push({
    name: 'gtashoot',
    aliases: ['gtashootgun', 'gtapistol'],
    category: 'gta',
    description: '💥 Fire the equipped gun. Ammo runs out. Someone usually runs',
    usage: '!gtashoot [@user]',
    cooldown: 45,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtashoot', async () => {
      await react('💥');
      const t = g(userDoc);
      if (!t.started) {
        await reply('🚗 You have not started yet. `!gtastart` first.', event.messageID);
        return;
      }
      if (jailed(userDoc)) {
        await reply(`🔒 **Still in the cell.** ${jailLeft(userDoc)} minutes left.`, event.messageID);
        return;
      }

      const rec = ownedWeapon(userDoc);
      if (!rec) {
        await reply('🔫 No gun equipped. `!gtabuyweapon pistol` first.', event.messageID);
        return;
      }
      const base = WEAPON_BY_ID.get(rec.id);
      if (clamp(rec.ammo) <= 0) {
        await reply(`🈳 **EMPTY.** The ${base.name} is dry. \`!gtamission\` for ammo.`, event.messageID);
        return;
      }

      rec.ammo = clamp(rec.ammo) - 1;
      const stars2 = await addWanted(userDoc, 1);
      const target = args[0] ? await targetOr(reply, event.messageID, args[0], event, 'gtashoot') : null;

      await reply(`💥 **BANG.** ${base.name}, one round gone. ${num(rec.ammo)} left.`, event.messageID);
      await sleep(500);

      const hit = Math.random() < 0.65;
      if (target && hit) {
        // Nothing is deleted. A hit costs them the draft and raises their heat,
        // which is enough of a consequence without touching anyone's account.
        await addWanted(target, 2);
        await save(target);
        await reply(
          `🎯 **YOU HIT ${target.name}.**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `⭐ They are now wanted ${stars(target.gta.wanted)} (${target.gta.wanted}/5)\n`
          + `⭐ You are wanted ${stars(stars2)} (${stars2}/5)\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      if (Math.random() < 0.25) {
        const loot = rand(100, 600);
        await earn(userDoc, loot, 'gta:shoot_loot', {});
        await bank(userDoc, loot);
        await reply(`💵 Dropped something worth ${kc(loot)}. ⭐ Wanted ${stars(stars2)} (${stars2}/5)`, event.messageID);
        return;
      }

      await reply(`💨 **Nothing but noise.** ⭐ Wanted ${stars(stars2)} (${stars2}/5)\n📖 ${story()}`, event.messageID);
    }),
  });

// ───────────────────────────────────────────────────────────
// THE HEAT — cops, bribes, escape
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'gtawanted',
    aliases: ['gtawantedlevel', 'gtaheat'],
    category: 'gta',
    description: '⭐ Your wanted level, what the heat is doing, and what it will cost',
    usage: '!gtawanted',
    cooldown: 20,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtawanted', async () => {
      await react('⭐');
      const t = g(userDoc);
      const collected = await settleHunt(userDoc);
      const wanted = clamp(t.wanted);
      const hunting = t.copsHuntUntil && new Date(t.copsHuntUntil).getTime() > Date.now();
      const jailedNow = jailed(userDoc);

      let status = '🟢 **CLEAR.** Nobody is looking for you.';
      if (jailedNow) status = `🔒 **IN THE CELL.** ${jailLeft(userDoc)} minutes left.`;
      else if (wanted >= 5) status = '🚨 **FIVE STARS.** The whole department is out.';
      else if (wanted >= 3) status = '🟠 **UNIT LOOKING.** They will find you soon.';
      else if (wanted > 0) status = '🟡 **SUSPICIOUS.** They have a description, not a name.';

      const heatLines = [];
      if (wanted > 0 && t.wantedAt) {
        heatLines.push(`⏱️ Heat has been on for ${Math.max(0, Math.round((Date.now() - new Date(t.wantedAt).getTime()) / 60000))} min.`);
      }
      if (hunting) {
        const mins = Math.ceil((new Date(t.copsHuntUntil).getTime() - Date.now()) / 60000);
        const due = Math.floor((userDoc.coins || 0) * 0.5);
        heatLines.push(`🚨 **ACTIVE HUNT — ${mins} min left.** They take ${kc(due)} unless you \`!gtabribe\` or \`!gtaescape\`.`);
      }
      if (wanted >= 5) heatLines.push('💀 Five stars and a bust puts you in the cell for 10 minutes.');

      await reply(
        `⭐ **WANTED ${stars(wanted)}**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${wanted}/5 · ${status}\n`
        + (collected ? `${collected}\n` : '')
        + (heatLines.length ? `${heatLines.join('\n')}\n` : '')
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + (wanted > 0 ? '📖 Hold still long enough and the heat cools on its own.' : '📖 Nobody is looking. Keep it that way.'),
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtacops',
    aliases: ['gtacopshunt', 'gtapolice'],
    category: 'gta',
    description: '👮 The hunt is on. At five stars they take half your coins in 10 minutes',
    usage: '!gtacops',
    cooldown: 60,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtacops', async () => {
      await react('👮');
      const t = g(userDoc);
      const collected = await settleHunt(userDoc);
      const wanted = clamp(t.wanted);

      // Cops only take the cut when the hunt is actually live. Wanted, hunted
      // and jailed are separate states on purpose: five stars is the trigger,
      // copsHuntUntil is the countdown, jailedUntil is the sentence.
      const hunting = t.copsHuntUntil && new Date(t.copsHuntUntil).getTime() > Date.now();
      if (jailed(userDoc)) {
        await reply(`🔒 **Still in the cell.** ${jailLeft(userDoc)} minutes left. The cops have already won this one.`, event.messageID);
        return;
      }
      if (wanted < 5) {
        await reply(`👮 **No active hunt.** You need five stars. You are on ${stars(wanted)}.`, event.messageID);
        return;
      }
      if (!hunting) {
        t.copsHuntUntil = new Date(Date.now() + 10 * 60 * 1000);
        await save(userDoc);
        await reply(
          `🚨 **UNITS DISPATCHED.**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `⭐ Five stars. The hunt runs for 10 minutes.\n`
          + `💸 If it expires they take ${kc(Math.floor((userDoc.coins || 0) * 0.5))}.\n`
          + `🛡️ \`!gtabribe\` to pay it off, \`!gtaescape\` to run.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const mins = Math.ceil((new Date(t.copsHuntUntil).getTime() - Date.now()) / 60000);
      await reply(
        `🚨 **THE HUNT IS ON.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `⏱️ ${mins} min left.\n`
        + `💸 Due: ${kc(Math.floor((userDoc.coins || 0) * 0.5))} — half of what you are carrying.\n`
        + `🛡️ \`!gtabribe\` or \`!gtaescape\`.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtabribe',
    aliases: ['gtapaybribe'],
    category: 'gta',
    description: '🛡️ Buy your way out of a hunt — the heat clears completely',
    usage: '!gtabribe',
    cooldown: 120,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtabribe', async () => {
      await react('🛡️');
      const t = g(userDoc);
      if (jailed(userDoc)) {
        await reply(`🔒 **Bribery does not work through bars.** ${jailLeft(userDoc)} minutes left.`, event.messageID);
        return;
      }
      const hunting = t.copsHuntUntil && new Date(t.copsHuntUntil).getTime() > Date.now();
      if (clamp(t.wanted) < 5 && !hunting) {
        await reply(`🛡️ Nobody is asking for a bribe. You are wanted ${stars(t.wanted)}.`, event.messageID);
        return;
      }

      // 20% of the wallet, on a floor, so a rich crook cannot buy silence for
      // pocket change and a broke one is not left with no way out.
      const price = Math.max(2000, Math.floor((userDoc.coins || 0) * 0.2));
      const paid = await spend(userDoc, price, 'gta:bribe', { price });
      if (!paid.ok) {
        await reply(
          `${paid.reason}\n🛡️ The bribe is ${kc(price)}. \`!gtaescape\` is free if your car is fast.`,
          event.messageID,
        );
        return;
      }

      t.wanted = 0;
      t.wantedAt = null;
      t.copsHuntUntil = null;
      await save(userDoc);

      await reply(
        `🛡️ **THE HUNT IS OFF.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💸 -${kc(price)}\n`
        + `⭐ Wanted ${stars(0)} (0/5)\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 Nobody says anything. That is how you know it worked.`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtaescape',
    aliases: ['gtaflee', 'gtarun'],
    category: 'gta',
    description: '🏃 Outrun the police — the faster the car, the better the odds',
    usage: '!gtaescape',
    cooldown: 120,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtaescape', async () => {
      await react('🏃');
      const t = g(userDoc);
      if (jailed(userDoc)) {
        await reply(`🔒 **You are not going anywhere.** ${jailLeft(userDoc)} minutes left.`, event.messageID);
        return;
      }
      const hunting = t.copsHuntUntil && new Date(t.copsHuntUntil).getTime() > Date.now();
      if (clamp(t.wanted) < 5 && !hunting) {
        await reply(`🏃 Nobody is chasing you. Go and start something.`, event.messageID);
        return;
      }

      const rec = ownedCar(userDoc);
      if (!rec) {
        await reply('🔑 No car. You cannot outrun a police car on foot. `!gtaescape` needs the garage.', event.messageID);
        return;
      }
      if (rec.crashed) {
        await reply(`💥 The ${CAR_BY_ID.get(rec.id).name} is on a lift. \`!gtarepair\` first.`, event.messageID);
        return;
      }

      const pwr = carPower(userDoc);
      // Nitro buys a flat 15 points, tuning 5. At 1500 power with nitro this is
      // close to certain, which is exactly what a million-coin car should feel.
      const bonus = (rec.nitro ? 15 : 0) + (rec.tuned ? 5 : 0);
      const chance = Math.max(0.02, Math.min(0.95, pwr / 1200 + bonus / 100));

      await reply(`🏃 Tearing off from the sirens with the ${CAR_BY_ID.get(rec.id).name}...`, event.messageID);
      await sleep(800);

      t.racesLost = clamp(t.racesLost) + (Math.random() < chance ? 0 : 1);
      await save(userDoc);

      if (Math.random() < chance) {
        t.wanted = Math.max(0, clamp(t.wanted) - 2);
        t.copsHuntUntil = null;
        if (t.wanted === 0) t.wantedAt = null;
        await save(userDoc);
        await reply(
          `🏆 **YOU LOST THEM.**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `⭐ Wanted ${stars(t.wanted)} (${t.wanted}/5)\n`
          + `🚨 The hunt is called off.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      // Caught, not busted: the sentence is what a failed escape buys.
      await jail(userDoc, 10, 'gta:jail_escape');
      t.wanted = 0;
      t.wantedAt = null;
      t.copsHuntUntil = null;
      await save(userDoc);
      await reply(
        `🚔 **BOXED IN ON WHEELER AVENUE.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🔒 10 minutes in the cell.\n`
        + `⭐ The heat is off your record.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtabankrob',
    aliases: ['gtabank', 'gtaheistbank'],
    category: 'gta',
    description: '🏦 Rob a bank — heavy heat either way, one good payout if it holds',
    usage: '!gtabankrob',
    cooldown: 300,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtabankrob', async () => {
      await react('🏦');
      const t = g(userDoc);
      if (!t.started) {
        await reply('🚗 You have not started yet. `!gtastart` first.', event.messageID);
        return;
      }
      if (jailed(userDoc)) {
        await reply(`🔒 **Still in the cell.** ${jailLeft(userDoc)} minutes left.`, event.messageID);
        return;
      }

      const pwr = carPower(userDoc);
      // Car power scales the take and shrinks the risk. Without a car this is a
      // 65% walk into a bank on foot, which should never be tempting.
      const risk = Math.max(0.25, Math.min(0.85, 0.65 - pwr / 4000));
      await reply(`🏦 **THE BANK**\n━━━━━━━━━━━━━━━\n📍 Risk ${Math.round(risk * 100)}% · ⭐ +2 stars minimum\n📖 ${story()}`, event.messageID);
      for (const step of ['Case the front...', 'The teller stops talking...', 'Back to the car...', 'Running the checkpoints...']) {
        await sleep(650);
        await reply(`▸ ${step}`);
      }

      await addWanted(userDoc, 2);
      if (Math.random() < risk) {
        await jail(userDoc, 5, 'gta:jail_bank');
        await reply(
          `🚔 **YOU GOT THE DOOR BUT NOT THE STREET.**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `🔒 5 minutes in the cell.\n`
          + `💸 Nothing taken.\n`
          + `⭐ Wanted ${stars(t.wanted)} (${t.wanted}/5)\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const pet = await petBonus(userDoc);
      let reward = rand(20000, 60000) + Math.floor(pwr * 4);
      reward = Math.floor(reward * pet.mult);
      const tax = await cartelTax(userDoc, event, reward);
      const net = Math.max(0, reward - tax);

      await earn(userDoc, net, 'gta:bankrob', { reward: net });
      await bank(userDoc, net);
      const ups = await grantXp(userDoc, 600);

      await reply(
        `💰 **THE VAULT WAS LIGHT.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💵 +${kc(net)}${tax ? ` (${kc(tax)} to the cartel)` : ''}\n`
        + `⭐ Wanted ${stars(t.wanted)} (${t.wanted}/5)\n`
        + `🎖️ XP +600${ups.length ? ` — **LEVEL ${ups[ups.length - 1]}**` : ''}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + (pet.note ? `${pet.note}\n` : '')
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

// ───────────────────────────────────────────────────────────
// HONEST WORK AND THE BIG ONE
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'gtaheist',
    aliases: ['gtajob', 'gtathejob'],
    category: 'gta',
    description: '🎩 The big heist — once a day, 40% bust rate, huge payout',
    usage: '!gtaheist',
    cooldown: 600,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtaheist', async () => {
      await react('🎩');
      const t = g(userDoc);
      if (!t.started) {
        await reply('🚗 You have not started yet. `!gtastart` first.', event.messageID);
        return;
      }
      if (jailed(userDoc)) {
        await reply(`🔒 **Still in the cell.** ${jailLeft(userDoc)} minutes left.`, event.messageID);
        return;
      }
      // Once a day, and the stamp is only written on completion. Otherwise a
      // busted player is locked out until the cooldown expires anyway, which is
      // a confusing way to discover the rule.
      if (t.lastHeist && Date.now() - new Date(t.lastHeist).getTime() < 86400000) {
        const hrs = Math.ceil((86400000 - (Date.now() - new Date(t.lastHeist).getTime())) / 3600000);
        await reply(`🎩 **You have already done this one today.** Come back in ${hrs} hour(s).`, event.messageID);
        return;
      }

      const pwr = carPower(userDoc);
      const risk = Math.max(0.20, Math.min(0.80, 0.40 - pwr / 6000));
      await reply(`🎩 **THE BIG JOB**\n━━━━━━━━━━━━━━━\n📍 Risk ${Math.round(risk * 100)}%\n📖 Everyone gets one good idea a year.`, event.messageID);
      for (const step of ['The plan takes four minutes...', 'The van is loaded...', 'The whole job is on one minute...', 'And it is now that minute.']) {
        await sleep(700);
        await reply(`▸ ${step}`);
      }

      t.lastHeist = new Date();
      await save(userDoc);

      if (Math.random() < risk) {
        await jail(userDoc, 15, 'gta:jail_heist');
        await addWanted(userDoc, 3);
        await reply(
          `🚔 **THE JOB WAS A SETUP.**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `🔒 15 minutes in the cell.\n`
          + `⭐ Wanted ${stars(t.wanted)} (${t.wanted}/5)\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const pet = await petBonus(userDoc);
      let reward = rand(150000, 400000);
      reward = Math.floor(reward * pet.mult);
      const tax = await cartelTax(userDoc, event, reward);
      const net = Math.max(0, reward - tax);

      await earn(userDoc, net, 'gta:heist', { reward: net });
      await bank(userDoc, net);
      const ups = await grantXp(userDoc, 1500);

      await reply(
        `🎩 **CLEAN.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💰 +${kc(net)}${tax ? ` (${kc(tax)} to the cartel)` : ''}\n`
        + `🎖️ XP +1500${ups.length ? ` — **LEVEL ${ups[ups.length - 1]}**` : ''}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📅 The van is a write-off. Another one will do.\n`
        + (pet.note ? `${pet.note}\n` : '')
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtarobstore',
    aliases: ['gtashop', 'gtashoplift'],
    category: 'gta',
    description: '🏪 Rob a corner store — small money, small risk, always available',
    usage: '!gtarobstore',
    cooldown: 300,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtarobstore', async () => {
      await react('🏪');
      const t = g(userDoc);
      if (!t.started) {
        await reply('🚗 You have not started yet. `!gtastart` first.', event.messageID);
        return;
      }
      if (jailed(userDoc)) {
        await reply(`🔒 **Still in the cell.** ${jailLeft(userDoc)} minutes left.`, event.messageID);
        return;
      }

      await reply('🏪 **CORNER STORE**\n━━━━━━━━━━━━━━━\n📍 The alarm is wired to nothing.', event.messageID);
      for (const step of ['In through the side door...', 'The till. Then the second till...', 'The kid behind the counter just watches...']) {
        await sleep(650);
        await reply(`▸ ${step}`);
      }

      if (Math.random() < 0.20) {
        await jail(userDoc, 3, 'gta:jail_store');
        await addWanted(userDoc, 1);
        await reply(
          `🚔 **SOMEONE IN THE BACK CALLED IT IN.**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `🔒 3 minutes in the cell.\n`
          + `⭐ Wanted ${stars(t.wanted)} (${t.wanted}/5)\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const pet = await petBonus(userDoc);
      let reward = rand(3000, 9000);
      reward = Math.floor(reward * pet.mult);
      const tax = await cartelTax(userDoc, event, reward);
      const net = Math.max(0, reward - tax);

      await earn(userDoc, net, 'gta:robstore', { reward: net });
      await bank(userDoc, net);
      await grantXp(userDoc, 200);
      await giveAmmo(userDoc, 5);

      await reply(
        `💵 **TWO TILLS, ONE SHELF.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💰 +${kc(net)}${tax ? ` (${kc(tax)} to the cartel)` : ''}\n`
        + `🔫 +5 rounds\n`
        + `⭐ Wanted ${stars(t.wanted)} (${t.wanted}/5)\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + (pet.note ? `${pet.note}\n` : '')
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtawork',
    aliases: ['gtajobshift', 'gtashift'],
    category: 'gta',
    description: '🔧 A legal shift at the chop shop. Small money, zero heat',
    usage: '!gtawork',
    cooldown: 900,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtawork', async () => {
      await react('🔧');
      const t = g(userDoc);
      if (!t.started) {
        await reply('🚗 You have not started yet. `!gtastart` first.', event.messageID);
        return;
      }

      // The shift pays a flat 2,000 and does nothing else. It exists so that a
      // player who has blown everything on cars is never completely stuck, and
      // it is deliberately worth less than one store robbery.
      const pay = 2000;
      await earn(userDoc, pay, 'gta:work', { pay });
      await bank(userDoc, pay);
      await grantXp(userDoc, 100);
      await giveAmmo(userDoc, 10);

      await reply(
        `🔧 **SHIFT DONE.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💼 +${kc(pay)} for a full shift\n`
        + `🔫 +10 rounds\n`
        + `⭐ Wanted ${stars(t.wanted)} (${t.wanted}/5) — unchanged\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 The foreman asks why you smell like petrol. You tell him it is the shop.`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtadaily',
    aliases: ['gtaclaim', 'gtabonus'],
    category: 'gta',
    description: '🎁 Daily payout. Scales with your level, so it matters later',
    usage: '!gtadaily',
    cooldown: 300,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtadaily', async () => {
      await react('🎁');
      const t = g(userDoc);
      if (!t.started) {
        await reply('🚗 You have not started yet. `!gtastart` first.', event.messageID);
        return;
      }

      const readyAt = t.dailyAt ? new Date(t.dailyAt).getTime() + 86400000 : 0;
      if (readyAt > Date.now()) {
        const hrs = Math.ceil((readyAt - Date.now()) / 3600000);
        await reply(`🎁 **Already claimed.** Next one in ${hrs} hour(s).`, event.messageID);
        return;
      }

      // 2000 + 500 per level. At level 10 that is a thousand more than the
      // legal shift, which is the reason to keep levelling.
      const reward = 2000 + clamp(t.level) * 500;
      t.dailyAt = new Date();
      await save(userDoc);

      await earn(userDoc, reward, 'gta:daily', { reward });
      await bank(userDoc, reward);
      const ups = await grantXp(userDoc, 200);

      await reply(
        `🎁 **DAILY.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💰 +${kc(reward)} (level ${t.level})\n`
        + `🎖️ XP +200${ups.length ? ` — **LEVEL ${ups[ups.length - 1]}**` : ''}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

// ───────────────────────────────────────────────────────────
// RACING AND PVP
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'gtarace',
    aliases: ['gtaracing', 'gtastreetrace'],
    category: 'gta',
    description: '🏁 Street race — 300 stake, the faster car usually wins',
    usage: '!gtarace [bet]',
    cooldown: 120,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtarace', async () => {
      await react('🏁');
      const t = g(userDoc);
      if (!t.started) {
        await reply('🚗 You have not started yet. `!gtastart` first.', event.messageID);
        return;
      }

      const rec = ownedCar(userDoc);
      if (!rec) {
        await reply('🔑 No active car. `!gtagarage <name>` to pick one.', event.messageID);
        return;
      }
      const base = CAR_BY_ID.get(rec.id);
      if (rec.crashed) {
        await reply(`💥 The ${base.name} is on a lift. \`!gtarepair\` first.`, event.messageID);
        return;
      }

      // Floor 50, ceiling 5000, and never more than the player actually has.
      let stake = Math.floor(clamp(args[0]) / 50) * 50;
      if (!stake) stake = 300;
      stake = Math.max(50, Math.min(5000, stake));
      if (stake > (userDoc.coins || 0)) {
        await reply(`💸 You cannot cover a ${kc(stake)} stake. You have ${kc(userDoc.coins)}.`, event.messageID);
        return;
      }

      const pwr = carPower(userDoc);
      const bonus = (rec.nitro ? 15 : 0) + (rec.tuned ? 5 : 0);
      // 45% at the bottom of the range, 95% on a maxed Phantom Prime.
      const chance = Math.max(0.35, Math.min(0.95, 0.45 + (pwr - 300) / 1600 + bonus / 100));

      await reply(`🏁 **STREET RACE**\n━━━━━━━━━━━━━━━\n🚙 ${base.name} · ${num(pwr)} pwr\n💰 Staked: ${kc(stake)}\n📖 Two lanes, one working brake light.`, event.messageID);
      await sleep(700);
      await reply('▸ Green light...');
      await sleep(700);

      const won = Math.random() < chance;
      if (won) {
        t.racesWon = clamp(t.racesWon) + 1;
        await save(userDoc);
        await earn(userDoc, stake, 'gta:race_win', { stake });
        await bank(userDoc, stake);
        await grantXp(userDoc, 150);
        await reply(
          `🏆 **YOU TOOK THE RACE.**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `💰 +${kc(stake)}\n`
          + `🏁 Record: ${t.racesWon}W/${t.racesLost}L\n`
          + `👛 Wallet: ${kc(userDoc.coins)}`,
          event.messageID,
        );
        return;
      }

      t.racesLost = clamp(t.racesLost) + 1;
      await save(userDoc);
      const paid = await spend(userDoc, stake, 'gta:race_loss', { stake });
      await reply(
        `💥 **YOU LOST THE RACE.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💸 -${kc(stake)}${paid.ok ? '' : ' (you could not cover it)'}\n`
        + `🏁 Record: ${t.racesWon}W/${t.racesLost}L\n`
        + `📖 The other car did not have a working brake light either.`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtaduel',
    aliases: ['gtacarduel', 'gta1v1'],
    category: 'gta',
    description: '⚔️ Car duel against another player — the better car takes it',
    usage: '!gtaduel @user',
    cooldown: 180,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtaduel', async () => {
      await react('⚔️');
      const mine = g(userDoc);
      if (!mine.started) {
        await reply('🚗 You have not started yet. `!gtastart` first.', event.messageID);
        return;
      }

      const foe = await targetOr(reply, event.messageID, args[0], event, 'gtaduel');
      if (!foe) return;
      if (String(foe.uid) === String(userDoc.uid)) {
        await reply('⚔️ You cannot duel yourself. The police tried that too.', event.messageID);
        return;
      }

      const theirs = g(foe);
      if (!theirs.started) {
        await reply(`⚔️ ${foe.name} is not in the life yet. They have to \`!gtastart\` first.`, event.messageID);
        return;
      }

      const myRec = ownedCar(userDoc);
      const foRec = ownedCar(foe);
      if (!myRec || myRec.crashed) {
        await reply('🔑 You have no usable car. `!gtagarage` then `!gtarepair`.', event.messageID);
        return;
      }
      if (!foRec || foRec.crashed) {
        await reply(`🔑 ${foe.name} has no usable car. Nothing to duel.`, event.messageID);
        return;
      }

      const myPwr = carPower(userDoc);
      const foPwr = carPower(foe);
      await reply(
        `⚔️ **DUEL**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🚙 ${CAR_BY_ID.get(myRec.id).name} — ${num(myPwr)} pwr\n`
        + `vs\n`
        + `🚙 ${CAR_BY_ID.get(foRec.id).name} — ${num(foPwr)} pwr\n`
        + `💀 Loser gets 2 stars and a fine.`,
        event.messageID,
      );
      await sleep(800);

      const total = myPwr + foPwr || 1;
      const won = Math.random() < myPwr / total;

      if (won) {
        mine.racesWon = clamp(mine.racesWon) + 1;
        await save(userDoc);
        const fine = 1500;
        const took = await spend(foe, fine, 'gta:duel_fine', { from: userDoc.name });
        await addWanted(foe, 2);
        await addWanted(userDoc, 1);
        await save(foe);
        await reply(
          `🏆 **YOU TOOK THE RACE.**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `${foe.name} pays ${kc(fine)}${took.ok ? '' : ' — they cannot cover it'}.\n`
          + `⭐ They are wanted ${stars(foe.gta.wanted)} (${foe.gta.wanted}/5)\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      mine.racesLost = clamp(mine.racesLost) + 1;
      await save(userDoc);
      const fine = 1500;
      const took = await spend(userDoc, fine, 'gta:duel_fine', { from: foe.name });
      await addWanted(userDoc, 2);
      await addWanted(foe, 1);
      await save(foe);
      await reply(
        `💥 **YOU LOST THE DUEL.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💸 Fine: ${kc(fine)}${took.ok ? '' : ' — you cannot cover it'}\n`
        + `⭐ Wanted ${stars(mine.wanted)} (${mine.wanted}/5)\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gtapvp',
    aliases: ['gtapvpareal', 'gtacheat'],
    category: 'gta',
    description: '🔫 PvP — damage rolls against the other player, coins change hands',
    usage: '!gtapvp @user',
    cooldown: 180,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'gtapvp', async () => {
      await react('🔫');
      const t = g(userDoc);
      if (!t.started) {
        await reply('🚗 You have not started yet. `!gtastart` first.', event.messageID);
        return;
      }
      if (jailed(userDoc)) {
        await reply(`🔒 **Still in the cell.** ${jailLeft(userDoc)} minutes left.`, event.messageID);
        return;
      }

      const foe = await targetOr(reply, event.messageID, args[0], event, 'gtapvp');
      if (!foe) return;
      if (String(foe.uid) === String(userDoc.uid)) {
        await reply('🔫 Shooting yourself is not PvP, and the armoury charges full price for it.', event.messageID);
        return;
      }

      const rec = ownedWeapon(userDoc);
      if (!rec) {
        await reply('🔫 No gun equipped. `!gtabuyweapon pistol` first.', event.messageID);
        return;
      }
      if (clamp(rec.ammo) <= 0) {
        await reply(`🈳 **EMPTY.** The ${WEAPON_BY_ID.get(rec.id).name} is dry.`, event.messageID);
        return;
      }

      const myDmg = weaponDmg(userDoc);
      const theirRec = ownedWeapon(foe);
      const theirDmg = theirRec ? weaponDmg(foe) : 25; // unarmed is a valid target
      rec.ammo = clamp(rec.ammo) - 1;
      await save(userDoc);

      await reply(`🔫 **PVP**\n━━━━━━━━━━━━━━━\n🎯 Your ${myDmg} dmg vs their ${theirDmg} dmg\n📖 No weapons on the ground.`, event.messageID);
      await sleep(800);

      const total = myDmg + theirDmg || 1;
      const won = Math.random() < myDmg / total;

      // Winner takes a percentage of the loser's wallet. Capped by what the
      // loser actually has, so the transfer can never mint coins.
      const taken = won ? Math.floor(clamp(foe.coins) * 0.1) : Math.floor(clamp(userDoc.coins) * 0.1);
      await addWanted(foe, won ? 2 : 0);
      await addWanted(userDoc, won ? 1 : 2);
      await save(foe);

      let line;
      if (won) {
        const ok = await spend(foe, taken, 'gta:pvp_loss', { from: userDoc.name });
        await earn(userDoc, taken, 'gta:pvp_win', { from: foe.name });
        await bank(userDoc, taken);
        t.pvpWins = clamp(t.pvpWins) + 1;
        line = `🏆 **YOU WON THE FIGHT.**\n💰 +${kc(taken)} taken from ${foe.name}${taken ? '' : ' — they had nothing on them'}`;
      } else {
        const ok = await spend(userDoc, taken, 'gta:pvp_loss', { from: foe.name });
        await earn(foe, taken, 'gta:pvp_win', { from: userDoc.name });
        foe.gta.pvpWins = clamp(foe.gta.pvpWins) + 1;
        await save(foe);
        line = `💀 **YOU LOST THE FIGHT.**\n💸 -${kc(taken)} to ${foe.name}${taken ? '' : ' — you had nothing on you'}`;
      }
      t.pvpLosses = clamp(t.pvpLosses) + (won ? 0 : 1);
      await grantXp(userDoc, 200);
      await save(userDoc);

      await reply(
        `${line}\n`
        + '━━━━━━━━━━━━━━━\n'
        + `⭐ They are wanted ${stars(foe.gta.wanted)} (${foe.gta.wanted}/5)\n`
        + `⭐ You are wanted ${stars(t.wanted)} (${t.wanted}/5)\n`
        + `🔫 ${num(rec.ammo)} rounds left\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

module.exports = commands;
