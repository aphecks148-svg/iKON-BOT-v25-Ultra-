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
    'level', 'xp', 'money', 'spent', 'wanted', 'racesWon', 'racesLost', 'missions', 'busts',
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

async function jail(userDoc, minutes, action) {
  const t = g(userDoc);
  t.jailedUntil = new Date(Date.now() + minutes * 60000);
  t.busts = clamp(t.busts) + 1;
  await save(userDoc);
  await ledger(userDoc.uid, action, 0, userDoc.coins, { jailMinutes: minutes });
}

/** The player's car record, or null when the garage is empty. */
function ownedCar(userDoc, id) {
  const t = g(userDoc);
  const want = String(id || t.activeCar || '');
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
  const want = String(id || t.activeWeapon || '');
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

module.exports = commands;
