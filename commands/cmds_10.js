'use strict';

/**
 * MODULE 10 — FARM / MINE / FISH / HUNT (35 commands)
 *
 * iKON-BOT v2 Ultra. The grind. This module exists so a hunter has something
 * to do at 2am that is not a coinflip.
 *
 * Exports a plain array. No factories, no legacy loader.
 *
 * Shape required for every command:
 * { name, aliases, category, description, usage, cooldown, permission, execute }
 *
 * execute receives: { api, event, args, config, registry, gemini, reply, react, userDoc }
 *
 * FOUR LOOPS, ONE ECONOMY
 * The loops are not decoration, they are the sinks and taps that close the
 * economy module 2 opened:
 *   farm  -> food. Feeds the pet loop in module 4.
 *   mine  -> stones and ore. The evolve currency in module 4 is stone-flavoured.
 *   fish  -> coins. The only loop here that pays without a tool investment.
 *   hunt  -> rare skins. Pure flex. Nobody needs a ikontitanbeast pelt.
 * Tools degrade, land costs rent, and there is a steal button, because a
 * grinder with no downside is a menu screen, not a game.
 *
 * WHY THREE NAMES CARRY THE `ultra` SUFFIX
 * `mine`, `fish` and `hunt` already exist in cmds_2 as the flat economy
 * grinders (200-1300 a pop, no tools, no durability). They are live commands,
 * and the loader keeps the first definition of a name, so shipping them again
 * here would silently shadow module 2 and break a shipped feature. These three
 * are the durable, tool-driven replacements and they keep the aliases the spec
 * asked for — !m, !dig, !fishing, !fish2, !hunting, !hunt2 — none of which
 * collided with anything. Likewise !sow and !collect rather than !p and !h,
 * which belong to !ping and !help, and the two most typed prefixes in the bot.
 *
 * DURABILITY
 * Every tool has durability and every action that swings one spends it. Tools
 * never repair themselves; !dailyfarm refills them and a replacement is always
 * purchasable. This is the single rule that stops the loops from being free.
 *
 * NOTHING HERE MINTS COINS
 * Payouts come from fixed tables, tool prices are fixed, and every fee is
 * checked against the caller's actual balance before anything is written. Land
 * tax and the hospital bill are real losses, which is the point: the only way
 * to grind is to grind.
 */

const User = require('../models/User');
const Economy = require('../models/Economy');
const cache = require('../bot/cache');
const mongo = require('../bot/mongo');
const canvasKit = require('../bot/canvas');
const { isGroupThread } = require('../bot/helpers');
const userTarget = require('../bot/target');

const CASH = 'K-Cash';

// ───────────────────────────────────────────────────────────
// TABLES
// ───────────────────────────────────────────────────────────

/**
 * Ten crops. [ id, label, growMs, sellPrice, icon ]
 *
 * growMs drives the whole pacing curve: wheat lands inside a coffee break and
 * ikonfruit takes eight hours, so the top of the table is a daily login rather
 * than something you can spam. Seed price is derived from the sell price, never
 * hand-written, so a crop can never cost more to plant than it returns.
 */
const CROPS = [
  ['wheat', 'Wheat', 5 * 60 * 1000, 100, '\u{1F33E}'],
  ['rye', 'Rye', 8 * 60 * 1000, 180, '\u{1F33F}'],
  ['corn', 'Corn', 15 * 60 * 1000, 300, '\u{1F33D}'],
  ['barley', 'Barley', 20 * 60 * 1000, 400, '\u{1F33E}'],
  ['potato', 'Potato', 30 * 60 * 1000, 600, '\u{1F954}'],
  ['tomato', 'Tomato', 60 * 60 * 1000, 1200, '\u{1F345}'],
  ['carrot', 'Carrot', 120 * 60 * 1000, 2500, '\u{1F955}'],
  ['sugarcane', 'Sugarcane', 360 * 60 * 1000, 3500, '\u{1F33D}'],
  ['goldapple', 'Gold Apple', 240 * 60 * 1000, 6000, '\u{1F34E}'],
  ['ikonfruit', 'iKon Fruit', 480 * 60 * 1000, 15000, '\u{1F34C}'],
];

/**
 * Ten fish. [ id, label, sellPrice, weight, icon ]
 *
 * weight is the share of the draw pool, so rarity is a table edit rather than
 * code. Shrimp and sardine carry most of the weight, which is why fishing is a
 * reliable coin floor and a megalodon is a story you tell afterwards.
 */
const FISH = [
  ['sardine', 'Sardine', 30, 24, '\u{1F41F}'],
  ['shrimp', 'Shrimp', 50, 22, '\u{1F990}'],
  ['bass', 'Bass', 150, 16, '\u{1F41F}'],
  ['salmon', 'Salmon', 300, 12, '\u{1F41F}'],
  ['tuna', 'Tuna', 600, 9, '\u{1F41F}'],
  ['piranha', 'Piranha', 3000, 6, '\u{1F418}'],
  ['shark', 'Shark', 1500, 5, '\u{1F988}'],
  ['whale', 'Whale', 5000, 3, '\u{1F433}'],
  ['megalodon', 'Megalodon', 20000, 2, '\u{1F9A9}'],
  ['ikonfish', 'iKon Fish', 50000, 1, '\u{1F41F}'],
];

/** Ten ores. [ id, label, sellPrice, weight, icon ]. Weight falls as price climbs. */
const ORES = [
  ['stone', 'Stone', 30, 26, '\u{1FAA8}'],
  ['coal', 'Coal', 80, 22, '\u{1F311}'],
  ['iron', 'Iron', 200, 14, '\u{26CF}'],
  ['copper', 'Copper', 200, 16, '\u{1FAA8}'],
  ['gold', 'Gold', 500, 11, '\u{1FA99}'],
  ['diamond', 'Diamond', 1200, 7, '\u{1F48E}'],
  ['emerald', 'Emerald', 3000, 4, '\u{1F48E}'],
  ['obsidian', 'Obsidian', 7000, 2, '\u{1F303}'],
  ['netherite', 'Netherite', 15000, 1, '\u{1F9F4}'],
  ['ikonium', 'iKonium', 50000, 1, '\u{1F9F4}'],
];

/** Ten animals. [ id, label, meatPrice, skinPrice, weight, icon ] */
const ANIMALS = [
  ['squirrel', 'Squirrel', 25, 40, 22, '\u{1F43F}'],
  ['rabbit', 'Rabbit', 60, 100, 19, '\u{1F407}'],
  ['fox', 'Fox', 150, 300, 15, '\u{1F98A}'],
  ['deer', 'Deer', 180, 300, 13, '\u{1F98C}'],
  ['boar', 'Boar', 360, 600, 11, '\u{1F417}'],
  ['wolf', 'Wolf', 720, 1200, 8, '\u{1F43A}'],
  ['bear', 'Bear', 1800, 3000, 6, '\u{1F43B}'],
  ['lion', 'Lion', 4200, 7000, 3, '\u{1F981}'],
  ['dragonbaby', 'Dragon Baby', 12000, 20000, 2, '\u{1F409}'],
  ['ikontitanbeast', 'iKon Titanbeast', 60000, 100000, 1, '\u{1F995}'],
];

/** Picks: price, durability, rare-weight boost. */
const PICKS = [
  ['wooden_pick', 'Wooden Pickaxe', 1000, 60, 0],
  ['iron_pick', 'Iron Pickaxe', 5000, 100, 5],
  ['diamond_pick', 'Diamond Pickaxe', 20000, 100, 12],
  ['ikonium_pick', 'iKonium Pickaxe', 100000, 100, 20],
];

/** Rods: price, durability, rare-weight boost. */
const RODS = [
  ['basic_rod', 'Basic Rod', 1000, 60, 0],
  ['pro_rod', 'Pro Rod', 5000, 100, 6],
  ['ikon_rod', 'iKon Rod', 50000, 100, 14],
];

/** Guns: price, durability, rare-weight boost. */
const GUNS = [
  ['pistol', 'Pistol', 2000, 60, 0],
  ['rifle', 'Rifle', 10000, 100, 6],
  ['sniper', 'Sniper', 30000, 100, 12],
  ['ikon_railgun', 'iKon Railgun', 150000, 100, 20],
];

/** Fixed costs. Nothing here is derived from a balance at runtime. */
const PLOT_COST = 10000;
const MAX_PLOTS = 10;
const LAND_TAX = 2000;
const STEAL_FINE = 500;
const HOSPITAL = 1000;
const DUEL_ENTRY = 2500;
const DUEL_HUNTS = 3;
const TOURNAMENT_POT = 10000;
const HUNT_LICENSE = 1000;
const PRESTIGE_COINS = 1000000;
const PRESTIGE_LEVEL = 50;
const DAILY_COINS = 5000;
const DAILY_MS = 24 * 60 * 60 * 1000;

/** What share of a catch is paid out on the spot, the rest stays in the barn. */
const CATCH_RATE = 0.3;

/** Weight column index per table — the six tables are not shaped identically. */
const W_FISH = 3;
const W_ANIMAL = 4;// ───────────────────────────────────────────────────────────
// USER STATE
// ───────────────────────────────────────────────────────────

/**
 * Make sure the four loops exist on this hunter.
 *
 * Called at the top of every command in the module. Old accounts predate it, so
 * every field is created on demand rather than trusted to the schema: a missing
 * subdocument here would be a crash twenty commands later.
 *
 * @returns {{farm:object, mine:object, fish:object, hunt:object}}
 */
function s(userDoc) {
  const mk = (v) => (v && typeof v === 'object' ? v : {});
  userDoc.farm = mk(userDoc.farm);
  userDoc.mine = mk(userDoc.mine);
  userDoc.fish = mk(userDoc.fish);
  userDoc.hunt = mk(userDoc.hunt);

  const fm = userDoc.farm;
  if (!Number.isFinite(fm.level)) fm.level = 1;
  if (!Number.isFinite(fm.xp)) fm.xp = 0;
  fm.plots = Math.max(1, Math.min(MAX_PLOTS, clamp(fm.plots) || 3));
  if (!Array.isArray(fm.land)) fm.land = [];
  fm.crops = mk(fm.crops);
  fm.seeds = mk(fm.seeds);
  if (!Number.isFinite(fm.totalHarvest)) fm.totalHarvest = 0;
  if (!Number.isFinite(fm.prestige)) fm.prestige = 0;
  if (!Number.isFinite(fm.food)) fm.food = 0;
  if (!Number.isFinite(fm.stones)) fm.stones = 0;
  if (!Number.isFinite(fm.stolen)) fm.stolen = 0;
  if (typeof fm.taxAt !== 'string') fm.taxAt = '';
  if (typeof fm.dailyAt !== 'string') fm.dailyAt = '';

  const mi = userDoc.mine;
  if (!Number.isFinite(mi.level)) mi.level = 1;
  if (!Number.isFinite(mi.xp)) mi.xp = 0;
  mi.ores = mk(mi.ores);
  if (!mi.pick || typeof mi.pick !== 'object') mi.pick = { id: '', dur: 0 };

  const fi = userDoc.fish;
  if (!Number.isFinite(fi.level)) fi.level = 1;
  if (!Number.isFinite(fi.xp)) fi.xp = 0;
  fi.catch = mk(fi.catch);
  if (!fi.rod || typeof fi.rod !== 'object') fi.rod = { id: '', dur: 0 };

  const hu = userDoc.hunt;
  if (!Number.isFinite(hu.level)) hu.level = 1;
  if (!Number.isFinite(hu.xp)) hu.xp = 0;
  hu.meat = mk(hu.meat);
  hu.skins = mk(hu.skins);
  if (!Number.isFinite(hu.kills)) hu.kills = 0;
  // typeof, not Number.isFinite: isFinite(true) is false, so a licence check
  // written that way would silently void a real licence on every single call.
  if (typeof hu.licensed !== 'boolean') hu.licensed = false;
  if (!hu.gun || typeof hu.gun !== 'object') hu.gun = { id: '', dur: 0 };
  if (typeof hu.injuredUntil !== 'string') hu.injuredUntil = '';
  if (typeof hu.rarest !== 'string') hu.rarest = '';

  return { farm: fm, mine: mi, fish: fi, hunt: hu };
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

/** Take coins, clamped to what the target actually holds. */
async function take(userDoc, amount, action, metadata = {}) {
  const want = clamp(amount);
  const have = clamp(userDoc.coins);
  if (want <= 0) return { ok: true, took: 0, short: false };
  if (have < want) {
    userDoc.coins = 0;
    await save(userDoc);
    await ledger(userDoc.uid, action, -have, 0, { ...metadata, wanted: want, short: true });
    return { ok: false, took: have, short: true };
  }
  userDoc.coins = have - want;
  await save(userDoc);
  await ledger(userDoc.uid, action, -want, userDoc.coins, metadata);
  return { ok: true, took: want, short: false };
}

/** Give coins. Clamped at 0 so nothing can go negative. */
async function give(userDoc, amount, action, metadata = {}) {
  const gain = clamp(amount);
  if (gain <= 0) return 0;
  userDoc.coins = clamp(userDoc.coins) + gain;
  await save(userDoc);
  await ledger(userDoc.uid, action, gain, userDoc.coins, metadata);
  return gain;
}

/**
 * Take a flat fee from the caller, checked BEFORE any other write.
 *
 * A failed fee must leave the balance exactly as it was. take() deliberately
 * drains whatever the target holds, which is right for a victim and wrong for
 * a fee: the "not enough" message would otherwise quote money it just took.
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function fee(userDoc, cost, action) {
  const need = clamp(cost);
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
// TABLE LOOKUPS
// ───────────────────────────────────────────────────────────

/** Row lookup by id across any of the six-item tables. */
function row(table, id) {
  const key = String(id || '').trim().toLowerCase();
  return table.find((r) => r[0] === key) || null;
}

/** Draw from a weighted table. */
function draw(table, weightIndex) {
  const total = table.reduce((n, r) => n + r[weightIndex], 0);
  let roll = Math.random() * total;
  for (const r of table) {
    roll -= r[weightIndex];
    if (roll <= 0) return r;
  }
  return table[table.length - 1];
}

/**
 * A tool row plus how it performs.
 *
 * `boost` is handed to draw() as extra weight on the rare rows, which is the
 * only reason a diamond pickaxe finds ikonium more often than a wooden one.
 * @returns {{id:string,label:string,price:number,dur:number,boost:number,tier:number}|null}
 */
function gear(table, id) {
  const found = row(table, id);
  if (!found) return null;
  return {
    id: found[0],
    label: found[1],
    price: found[2],
    dur: found[3],
    boost: found[4] || 0,
    tier: table.indexOf(found),
  };
}

/** How deep in a table an item sits. Used to score tournaments and duels. */
function rarityOf(table, id) {
  const found = row(table, id);
  return found ? table.indexOf(found) : -1;
}

/**
 * Look up a gear row from whatever the hunter typed.
 *
 * The exact id wins — `iron_pick` must not be mangled into `iron` — and only
 * then is the `_seed` / `_pick` style suffix trimmed, so both `pro_rod` and
 * `pro` work without breaking the canonical names.
 */
function gearById(table, raw, suffixes) {
  const text = String(raw || '').trim().toLowerCase();
  const exact = row(table, text);
  if (exact) return gear(table, exact[0]);
  for (const suffix of suffixes) {
    const trimmed = text.replace(new RegExp(`_${suffix}$`), '');
    if (trimmed !== text) {
      const found = row(table, trimmed);
      if (found) return gear(table, found[0]);
    }
  }
  return null;
}

/** Rebuild a weight table, giving the tool's boost to everything past the 6th tier. */
function weighted(table, boost, weightIndex, keepIcon) {
  return table.map((r) => {
    const w = r[weightIndex] + (table.indexOf(r) >= 6 ? boost : 0);
    return keepIcon === 5 ? [r[0], r[1], r[2], r[3], w, r[5]] : [r[0], r[1], r[2], w, r[4]];
  });
}

/** Draw an ore with the pickaxe's boost applied. */
function drawOre(pick) {
  return draw(weighted(ORES, pick.boost, 3), 3);
}

/** Draw a fish with the rod's boost applied. */
function drawFish(rod) {
  return draw(weighted(FISH, rod.boost, W_FISH), W_FISH);
}

/** Draw an animal with the gun's boost applied. */
function drawAnimal(gun) {
  return draw(weighted(ANIMALS, gun.boost, W_ANIMAL, 5), W_ANIMAL);
}

// ───────────────────────────────────────────────────────────
// BAGS
// ───────────────────────────────────────────────────────────

/**
 * Render a bag as a tidy line.
 *
 * iconIndex differs between tables — fish and ore carry theirs at [4], animals
 * at [5] because they have meat and skin prices first.
 */
function bag(bucket, table, priceIndex, iconIndex = 4) {
  const keys = Object.keys(bucket || {}).filter((k) => clamp(bucket[k]) > 0);
  if (!keys.length) return '_nothing yet_';
  return keys.map((k) => {
    const found = row(table, k);
    const label = found ? found[1] : k;
    const worth = found ? clamp(found[priceIndex]) * clamp(bucket[k]) : 0;
    return `${found ? found[iconIndex] : '\u{1F4E6}'} **${label}** x${clamp(bucket[k])} _(${num(worth)})_`;
  }).join('\n');
}

/** What a bag is worth if sold right now. */
function bagValue(bucket, table, priceIndex) {
  return Object.keys(bucket || {}).reduce((sum, k) => {
    const found = row(table, k);
    return sum + (found ? clamp(found[priceIndex]) * clamp(bucket[k]) : 0);
  }, 0);
}

// ───────────────────────────────────────────────────────────
// CARDS
// ───────────────────────────────────────────────────────────

/**
 * The farm card: 800x400, one tile per plot with the crop icon, the crop name
 * and the timer.
 *
 * Returns a data URL, or null when the native canvas binary is unavailable so
 * the caller can fall back to text. No command may depend on a picture
 * rendering, because on a stripped Android container it will not.
 */
async function farmCard(farm, who) {
  const made = canvasKit.create(800, 400);
  if (!made) return null;
  const { ctx } = made;

  const bg = ctx.createLinearGradient(0, 0, 800, 400);
  bg.addColorStop(0, canvasKit.theme.bg1);
  bg.addColorStop(1, canvasKit.theme.bg2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 800, 400);

  ctx.fillStyle = canvasKit.theme.accent;
  ctx.fillRect(0, 0, 800, 8);

  ctx.fillStyle = canvasKit.theme.text;
  ctx.font = 'bold 38px iKonSans';
  ctx.fillText(`\u{1F33E} ${String(who || 'iKON').slice(0, 18)}'s Farm`, 40, 60);

  ctx.fillStyle = canvasKit.theme.accent2;
  ctx.font = 'bold 24px iKonSans';
  ctx.fillText(`Lv ${clamp(farm.level)}  \u{1F33D} ${clamp(farm.plots)} plots  \u{2B50} ${clamp(farm.prestige)}`, 40, 96);

  const tiles = Math.max(1, Math.min(MAX_PLOTS, clamp(farm.plots)));
  const cols = tiles > 5 ? 5 : tiles;
  const rows = Math.ceil(tiles / cols);
  const pad = 14;
  const w = Math.floor((720 - pad * (cols - 1)) / cols);
  const h = Math.floor((250 - pad * (rows - 1)) / rows);

  for (let i = 0; i < tiles; i += 1) {
    const plot = (Array.isArray(farm.land) ? farm.land[i] : null) || {};
    const x = 40 + (i % cols) * (w + pad);
    const y = 122 + Math.floor(i / cols) * (h + pad);

    ctx.fillStyle = plot.crop ? 'rgba(0,212,255,0.14)' : 'rgba(255,255,255,0.05)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = canvasKit.theme.accent;
    ctx.strokeRect(x, y, w, h);

    const crop = plot.crop ? row(CROPS, plot.crop) : null;
    ctx.font = 'bold 30px iKonSans';
    ctx.fillStyle = canvasKit.theme.gold;
    ctx.fillText(crop ? crop[4] : '\u{1F333}', x + 12, y + 40);

    ctx.font = '18px iKonSans';
    ctx.fillStyle = canvasKit.theme.text;
    ctx.fillText(`#${i + 1} ${crop ? crop[1] : 'Empty'}`, x + 50, y + 38);

    ctx.font = '15px iKonSans';
    ctx.fillStyle = canvasKit.theme.muted;
    ctx.fillText(landLine(plot), x + 12, y + 68);
  }

  ctx.fillStyle = canvasKit.theme.gold;
  ctx.font = 'bold 17px iKonSans';
  ctx.fillText(`Harvested ${num(farm.totalHarvest)} \u{00B7} Food ${num(farm.food)} \u{00B7} Stones ${num(farm.stones)}`, 40, 388);

  const buffer = await canvasKit.toBuffer(made.canvas);
  return buffer ? `data:image/png;base64,${buffer.toString('base64')}` : null;
}

/** One line per plot: the timer, or why it cannot be harvested. */
function landLine(plot) {
  if (!plot || !plot.crop) return 'plant something';
  if (Date.now() < clamp(plot.readyAt)) {
    return `${secs(plot.readyAt - Date.now())} left${plot.watered ? ' \u{1F4A7}' : ''}`;
  }
  return 'ready \u{2705}';
}

/**
 * A result card for the mine/fish/hunt loops. Different accent per loop so the
 * four are distinguishable at a glance in a busy chat.
 */
async function haulCard({ title, subtitle = '', body = '', footer = '', accent = canvasKit.theme.accent }) {
  const made = canvasKit.create(800, 400);
  if (!made) return null;
  const { ctx } = made;

  const bg = ctx.createLinearGradient(0, 0, 800, 400);
  bg.addColorStop(0, canvasKit.theme.bg1);
  bg.addColorStop(1, canvasKit.theme.bg2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 800, 400);

  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 800, 10);

  ctx.fillStyle = canvasKit.theme.text;
  ctx.font = 'bold 42px iKonSans';
  wrap(ctx, title || 'iKON', 40, 78, 720, 48);

  ctx.fillStyle = canvasKit.theme.accent2;
  ctx.font = 'bold 26px iKonSans';
  if (subtitle) wrap(ctx, subtitle, 40, 138, 720, 32);

  ctx.fillStyle = canvasKit.theme.muted;
  ctx.font = '21px iKonSans';
  wrap(ctx, body || '', 40, subtitle ? 200 : 160, 720, 28);

  ctx.fillStyle = canvasKit.theme.gold;
  ctx.font = 'bold 18px iKonSans';
  wrap(ctx, footer || '', 40, 372, 720, 24);

  const buffer = await canvasKit.toBuffer(made.canvas);
  return buffer ? `data:image/png;base64,${buffer.toString('base64')}` : null;
}

/** Draw wrapped text. Returns the y past the last line drawn. */
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

/**
 * Send a data URL as a photo, ignoring failure. Text always goes out too.
 *
 * The reply-to id is sendMessage's THIRD argument. ws3-fca whitelists payload
 * properties, so putting it on the payload throws "Dissallowed props" and the
 * image never leaves the process.
 */
async function send(api, threadID, dataUrl, messageID, isGroup = undefined) {
  if (!dataUrl || !api || !threadID) return false;
  const payload = { attachment: { type: 'image', data: { url: dataUrl } } };
  const replyTo = messageID === undefined || messageID === null ? null : String(messageID);
  try {
    await api.sendMessage(payload, threadID, replyTo, !isGroupThread(threadID, isGroup));
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────────────────
// SMALL HELPERS
// ───────────────────────────────────────────────────────────

const clamp = (v) => Math.max(0, Math.floor(Number(v) || 0));
const num = (v) => Number(v || 0).toLocaleString('en-US');
const kc = (v) => `${Number(v || 0).toLocaleString('en-US')} ${CASH}`;
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick1 = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** 95s / 4m / 2h — the timer format used on cards and in replies. */
function secs(ms) {
  const s = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Run a handler with a user-facing safety net. */
async function guard(reply, messageID, label, fn) {
  try {
    await fn();
  } catch (err) {
    await reply(`⚠️ \`${label}\` failed: ${err.message}`, messageID);
  }
}

/** Seed price: 60% of the sell price, so every crop pays a margin. */
function seedPrice(crop) {
  return Math.max(1, Math.floor(clamp(crop[3]) * 0.6));
}

/** Yield for one harvest, including the permanent prestige bonus. */
function yieldOf(farm) {
  return Math.max(1, Math.floor(rand(2, 5) * (1 + clamp(farm.prestige) * 0.1)));
}

/** Absolute time a crop finishes, 20% sooner on a watered plot. */
function readyAt(crop, watered) {
  return Date.now() + Math.floor(clamp(crop[2]) * (watered ? 0.8 : 1));
}

/** Find the plot row for a 1-based plot number, extending the land array. */
function plotAt(farm, n) {
  const i = clamp(n) - 1;
  if (i < 0 || i >= clamp(farm.plots)) return null;
  if (!Array.isArray(farm.land)) farm.land = [];
  while (farm.land.length <= i) farm.land.push({ crop: '', plantedAt: 0, readyAt: 0, watered: false });
  return farm.land[i];
}

/** Spend one point of durability. @returns {'ok'|'broke'} */
function spend(tool) {
  tool.dur = clamp(tool.dur) - 1;
  if (tool.dur <= 0) {
    tool.dur = 0;
    return 'broke';
  }
  return 'ok';
}

/** XP needed for the next loop level. Quadratic, so level 50 is a real wall. */
function xpNeed(level) {
  return 500 + clamp(level) * 120;
}

/** Award loop XP. @returns {number} levels gained */
function gain(block, amount) {
  block.xp = clamp(block.xp) + clamp(amount);
  let ups = 0;
  while (clamp(block.xp) >= xpNeed(block.level) && clamp(block.level) < 99) {
    block.xp = clamp(block.xp) - xpNeed(block.level);
    block.level = clamp(block.level) + 1;
    ups += 1;
  }
  return ups;
}

/**
 * Look up a hunter by uid for a payout, or null.
 *
 * Returns null immediately when the database is asleep. A Mongoose query on a
 * disconnected connection buffers rather than failing, so an unguarded findOne
 * here would stall a tournament payout for ten seconds and then pay it to
 * nobody.
 */
async function payoutFor(uid) {
  if (!mongo.isReady()) return null;
  return User.findOne({ uid: String(uid) }).catch(() => null);
}

/**
 * Resolve a @tag, a typed name, or a raw uid to a User document.
 *
 * bot/target.js handles the resolution, including the offline case: the mention
 * map and the thread member list are both already on the event, so a tag still
 * works with the database asleep instead of hanging !farmsteal and !huntduel
 * for ten seconds each on a buffered Mongoose query.
 */
async function resolve(ref, event, api) {
  return userTarget.userDoc(ref, event, api);
}

/**
 * The other hunter in a steal or a duel. Refuses self-targeting, because a
 * hunter who farms themselves is not playing the game.
 * @returns {Promise<object|null>} null after already replying
 */
async function target(reply, messageID, userDoc, args, event, label) {
  if (!args[0]) {
    await reply(`❌ Usage: \`!${label} @user\``, messageID);
    return null;
  }
  const found = await resolve(args[0], event);
  if (!found) {
    await reply(`❌ Nobody called \`${args[0]}\` is registered. Tag a real hunter.`, messageID);
    return null;
  }
  if (String(found.uid) === String(userDoc.uid)) {
    await reply('🙃 That is you. Pick somebody else.', messageID);
    return null;
  }
  return found;
}

const commands = [];// ───────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────
// FARM — the slowest loop, and the one that pays in food
// ───────────────────────────────────────────────────────────

commands.push({
  name: 'farmstart',
  aliases: ['startfarm', 'getfarm'],
  category: 'farming',
  description: '🚜 Claim your farm — 3 plots, free. Start the long game',
  usage: '!farmstart',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'farmstart', async () => {
    await react('🚜');
    const fm = s(userDoc).farm;

    // A starter kit, not a windfall: three wheat seeds, so the very first
    // command a new farmer can run is a successful plant.
    fm.seeds.wheat_seed = clamp(fm.seeds.wheat_seed) + 3;
    // Lay out the land rows up front so the farm card and !farm agree with the
    // plot count instead of rendering three empty tiles of undefined.
    while (fm.land.length < clamp(fm.plots)) {
      fm.land.push({ crop: '', plantedAt: 0, readyAt: 0, watered: false });
    }
    await save(userDoc);

    await reply(
      '🚜 **Farm claimed.**\n'
      + `\`Lv ${clamp(fm.level)}\` · \`${clamp(fm.plots)} plots\` · \u{1F33E} **3 wheat seeds**\n`
      + 'Plant with `!plant wheat 1`, sell with `!farmsell wheat 1`.\n'
      + `_Rent is ${kc(LAND_TAX)} a day — !dailyfarm covers it._`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'farm',
  aliases: ['myfarm', 'f'],
  category: 'farming',
  description: '🌾 Your plots, timers and stores — with a card',
  usage: '!farm',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event, api }) => guard(reply, event.messageID, 'farm', async () => {
    await react('🌾');
    const fm = s(userDoc).farm;

    // Land tax is charged here so it cannot be avoided by never opening the
    // farm. It is the only command in this module that charges for looking, and
    // the reply says exactly what it took.
    let taxed = 0;
    const lastTax = fm.taxAt ? Date.parse(fm.taxAt) : 0;
    if (Date.now() - lastTax >= DAILY_MS && clamp(userDoc.coins) >= LAND_TAX) {
      await take(userDoc, LAND_TAX, 'farm:landtax');
      taxed = LAND_TAX;
      fm.taxAt = new Date().toISOString();
      await save(userDoc);
    }

    await send(api, event.threadID, await farmCard(fm, userDoc.name), event.messageID, event.isGroup);

    const plots = Array.from({ length: clamp(fm.plots) }, (_, i) => {
      const p = (Array.isArray(fm.land) ? fm.land[i] : null) || {};
      const crop = p.crop ? row(CROPS, p.crop) : null;
      if (!crop) return `${i + 1}. \`empty\``;
      const left = clamp(p.readyAt) - Date.now();
      return `${i + 1}. ${crop[4]} **${crop[1]}** — ${left > 0 ? `\`${secs(left)}\`` : '✅ ready'}`
        + `${p.watered && left > 0 ? ' \u{1F4A7}' : ''}`;
    }).join('\n');

    const seedTypes = Object.keys(fm.seeds).filter((k) => clamp(fm.seeds[k]) > 0).length;

    await reply(
      `🌾 **${userDoc.name}**'s farm — \`Lv ${clamp(fm.level)}\` · ${clamp(fm.plots)}/${MAX_PLOTS} plots`
      + `${clamp(fm.prestige) ? ` · \u{2B50} ${clamp(fm.prestige)}` : ''}\n\n${plots}\n\n`
      + `Stores \u{1F33E} ${num(bagValue(fm.crops, CROPS, 3))} · \u{1F33D} ${num(seedTypes)} seed types · food ${num(fm.food)}\n`
      + `Harvested ${num(fm.totalHarvest)} · land tax ${kc(LAND_TAX)}/day`
      + `${taxed ? ` — **charged ${kc(taxed)}**` : ''}`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'plant',
  aliases: ['sow', 'plantcrop'],
  category: 'farming',
  description: '🌱 Plant a seed in a plot — !plant wheat 1',
  usage: '!plant <crop> <plot>',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, args, event }) => guard(reply, event.messageID, 'plant', async () => {
    await react('🌱');
    const fm = s(userDoc).farm;

    const crop = row(CROPS, String(args[0] || '').trim().toLowerCase());
    if (!crop) {
      await reply(`❌ Unknown crop. Try \`!farmshop\` for the list of ten.`, event.messageID);
      return;
    }

    const at = clamp(args[1] || 1) || 1;
    const plot = plotAt(fm, at);
    if (!plot) {
      await reply(`❌ Plot ${at} does not exist. You have ${clamp(fm.plots)}. \`!farmexpand\` buys more.`, event.messageID);
      return;
    }
    if (plot.crop) {
      const left = clamp(plot.readyAt) - Date.now();
      await reply(
        left > 0
          ? `🌾 Plot ${at} already has **${row(CROPS, plot.crop)[1]}** growing — \`${secs(left)}\` left.`
          : `🌾 Plot ${at} has **${row(CROPS, plot.crop)[1]}** ready. \`!harvest ${at}\` first.`,
        event.messageID,
      );
      return;
    }

    const seedId = `${crop[0]}_seed`;
    if (clamp(fm.seeds[seedId]) <= 0) {
      await reply(`❌ No ${crop[1]} seeds. \`!farmbuy ${seedId}\` costs ${kc(seedPrice(crop))}.`, event.messageID);
      return;
    }

    fm.seeds[seedId] = clamp(fm.seeds[seedId]) - 1;
    plot.crop = crop[0];
    plot.plantedAt = Date.now();
    plot.readyAt = readyAt(crop, false);
    plot.watered = false;
    gain(fm, 15);
    await save(userDoc);
    await ledger(userDoc.uid, 'farm:plant', 0, clamp(userDoc.coins), { crop: crop[0], plot: at });

    await reply(
      `🌱 **${crop[4]} ${crop[1]}** planted in plot ${at}.\n`
      + `Ready in \`${secs(plot.readyAt - Date.now())}\` — \`!water ${at}\` cuts that by 20%.`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'water',
  aliases: ['waterplot', 'sprinkler'],
  category: 'farming',
  description: '💧 Water a plot for 20% faster growth',
  usage: '!water <plot>',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, args, event }) => guard(reply, event.messageID, 'water', async () => {
    await react('💧');
    const fm = s(userDoc).farm;
    const at = clamp(args[0] || 1) || 1;
    const plot = plotAt(fm, at);
    if (!plot) {
      await reply(`❌ Plot ${at} does not exist. You have ${clamp(fm.plots)}.`, event.messageID);
      return;
    }
    if (!plot.crop) {
      await reply(`💧 Plot ${at} is empty. Nothing to water — \`!plant\` something.`, event.messageID);
      return;
    }
    if (plot.watered) {
      await reply(`💧 Plot ${at} is already watered. It is not thirsty twice.`, event.messageID);
      return;
    }

    const left = clamp(plot.readyAt) - Date.now();
    if (left <= 0) {
      await reply(`✅ Plot ${at} is ready — water will not make it any riper. \`!harvest ${at}\``, event.messageID);
      return;
    }

    plot.readyAt = Date.now() + Math.floor(left * 0.8);
    plot.watered = true;
    gain(fm, 5);
    await save(userDoc);

    await reply(`💧 Plot ${at} watered — ready in \`${secs(clamp(plot.readyAt) - Date.now())}\`.`, event.messageID);
  }),
});

commands.push({
  name: 'harvest',
  aliases: ['collect', 'reap'],
  category: 'farming',
  description: '🧺 Harvest ready plots into your barn — no number does all of them',
  usage: '!harvest [plot]',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, args, event }) => guard(reply, event.messageID, 'harvest', async () => {
    await react('🧺');
    const fm = s(userDoc).farm;

    // With no plot number, harvest everything ready. A grinder should not have
    // to press the same button ten times to cash in a good minute.
    const at = args[0] ? clamp(args[0]) : 0;
    if (at && !plotAt(fm, at)) {
      await reply(`❌ Plot ${at} does not exist. You have ${clamp(fm.plots)}.`, event.messageID);
      return;
    }
    const spots = at ? [at] : Array.from({ length: clamp(fm.plots) }, (_, i) => i + 1);

    const got = [];
    let total = 0;
    let first = '';
    for (const spot of spots) {
      const plot = plotAt(fm, spot);
      if (!plot || !plot.crop) continue;

      const left = clamp(plot.readyAt) - Date.now();
      if (left > 0) {
        if (at) {
          await reply(`🌾 Plot ${spot} is still growing — \`${secs(left)}\` left.`, event.messageID);
          return;
        }
        continue;
      }

      const crop = row(CROPS, plot.crop);
      if (!crop) {
        // An unknown crop id in the land array (a renamed table entry) must
        // clear the plot rather than wedge every future harvest.
        plot.crop = '';
        plot.readyAt = 0;
        continue;
      }

      const amount = yieldOf(fm);
      fm.crops[crop[0]] = clamp(fm.crops[crop[0]]) + amount;
      fm.totalHarvest = clamp(fm.totalHarvest) + amount;
      fm.food = clamp(fm.food) + amount;
      total += amount;
      if (!first) first = crop[0];
      got.push(`${crop[4]} **${crop[1]}** x${amount}`);

      plot.crop = '';
      plot.plantedAt = 0;
      plot.readyAt = 0;
      plot.watered = false;
    }

    if (!got.length) {
      await reply('🧺 Nothing is ready. `!farm` shows the timers.', event.messageID);
      return;
    }

    const ups = gain(fm, 20 + total * 5);
    await save(userDoc);
    await ledger(userDoc.uid, 'farm:harvest', 0, clamp(userDoc.coins), { total, plots: got.length });

    await reply(
      `🧺 Harvested ${num(total)} across ${got.length} plot${got.length > 1 ? 's' : ''}:\n${got.map((g) => `· ${g}`).join('\n')}\n`
      + `Barn worth ${kc(bagValue(fm.crops, CROPS, 3))} — \`!farmsell ${first} 1\`\n`
      + `_Food ${num(fm.food)}, stones ${num(fm.stones)}._${ups ? `\n📈 **Farm level ${clamp(fm.level)}!**` : ''}`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'farmshop',
  aliases: ['seedshop', 'farmstore'],
  category: 'farming',
  description: '🛒 Every farm price in one place — seeds and land',
  usage: '!farmshop',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'farmshop', async () => {
    await react('🛒');
    const fm = s(userDoc).farm;

    const seeds = CROPS.map((c) => `${c[4]} **${c[1]}** \`${c[0]}_seed\` ${kc(seedPrice(c))} · grows \`${secs(c[2])}\``).join('\n');
    const land = clamp(fm.plots) >= MAX_PLOTS
      ? `📐 **Land is maxed** at ${MAX_PLOTS} plots.`
      : `📐 Plot ${clamp(fm.plots) + 1} — \`!farmexpand\` ${kc(PLOT_COST)} (${clamp(fm.plots)}/${MAX_PLOTS})`;

    await reply(
      `🛒 **Farm shop** — you have ${kc(userDoc.coins)}\n\n**Seeds**\n${seeds}\n\n**Land**\n${land}\n\n`
      + '_Buy with `!farmbuy <crop>_seed [qty]`._',
      event.messageID,
    );
  }),
});

commands.push({
  name: 'farmbuy',
  aliases: ['buyseed', 'farmpurchase'],
  category: 'farming',
  description: '🛍️ Buy seeds — !farmbuy corn_seed',
  usage: '!farmbuy <crop>_seed [qty]',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, args, event }) => guard(reply, event.messageID, 'farmbuy', async () => {
    await react('🛍️');
    const fm = s(userDoc).farm;

    // Both `corn_seed` and `corn` work, because asking someone to type the
    // suffix twice is how a command ends up unused.
    const crop = row(CROPS, String(args[0] || '').trim().toLowerCase().replace(/_seed$/, ''));
    if (!crop) {
      await reply('❌ Unknown seed. `!farmshop` lists all ten.', event.messageID);
      return;
    }

    const qty = clamp(args[1] || 1) || 1;
    if (qty > 100) {
      await reply('❌ One order is capped at 100 seeds. The market has limits.', event.messageID);
      return;
    }

    const cost = seedPrice(crop) * qty;
    const paid = await fee(userDoc, cost, 'farm:buyseed');
    if (!paid.ok) {
      await reply(paid.reason, event.messageID);
      return;
    }

    const id = `${crop[0]}_seed`;
    fm.seeds[id] = clamp(fm.seeds[id]) + qty;
    await save(userDoc);

    await reply(
      `🛍️ Bought **${qty}x ${crop[4]} ${crop[1]} seed${qty > 1 ? 's' : ''}** for ${kc(cost)}.\n`
      + `You now hold \`${num(clamp(fm.seeds[id]))}\`. \`!plant ${crop[0]} <plot>\``,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'farmsell',
  aliases: ['sellcrop', 'farmmarket'],
  category: 'farming',
  description: '💰 Sell crops — !farmsell wheat 10 (no quantity sells all)',
  usage: '!farmsell <crop> [qty]',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, args, event }) => guard(reply, event.messageID, 'farmsell', async () => {
    await react('💰');
    const fm = s(userDoc).farm;

    const crop = row(CROPS, String(args[0] || '').trim().toLowerCase());
    if (!crop) {
      await reply('❌ Unknown crop. `!barn` shows what you are holding.', event.messageID);
      return;
    }

    const have = clamp(fm.crops[crop[0]]);
    if (have <= 0) {
      await reply(`📦 No ${crop[1]} in the barn. Nothing to sell.`, event.messageID);
      return;
    }

    const qty = args[1] ? clamp(args[1]) : have;
    if (qty > have) {
      await reply(`📦 You only have **${num(have)}** ${crop[1]}. Selling all of them instead.`, event.messageID);
    }
    const sold = Math.min(have, qty);

    fm.crops[crop[0]] = have - sold;
    await save(userDoc);
    const got = await give(userDoc, crop[3] * sold, 'farm:sell', { crop: crop[0], qty: sold });
    await ledger(userDoc.uid, 'farm:harvest', got, clamp(userDoc.coins), { crop: crop[0], qty: sold });

    await reply(
      `💰 Sold **${num(sold)}x ${crop[4]} ${crop[1]}** for ${kc(got)}.\n`
      + `${have - sold > 0 ? `${num(have - sold)} left in the barn.` : 'Barn is clear.'} Balance ${kc(userDoc.coins)}.`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'barn',
  aliases: ['invfarm', 'storage'],
  category: 'farming',
  description: '🏚️ Everything you have stored — crops, fish, ores, meat, skins',
  usage: '!barn',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'barn', async () => {
    await react('🏚️');
    const st = s(userDoc);

    const total = bagValue(st.farm.crops, CROPS, 3)
      + bagValue(st.fish.catch, FISH, 2)
      + bagValue(st.mine.ores, ORES, 2)
      + bagValue(st.hunt.meat, ANIMALS, 2)
      + bagValue(st.hunt.skins, ANIMALS, 3);

    await reply(
      `🏚️ **${userDoc.name}**'s barn — ${kc(total)} of stock\n\n`
      + `🌾 **Crops**\n${bag(st.farm.crops, CROPS, 3)}\n\n`
      + `\u{1F41F} **Fish**\n${bag(st.fish.catch, FISH, 2)}\n\n`
      + `⛏️ **Ores**\n${bag(st.mine.ores, ORES, 2)}\n\n`
      + `\u{1F9AA} **Meat**\n${bag(st.hunt.meat, ANIMALS, 2, 5)}\n\n`
      + `\u{1F9B4} **Skins**\n${bag(st.hunt.skins, ANIMALS, 3, 5)}\n\n`
      + `_Food ${num(st.farm.food)} · Stones ${num(st.farm.stones)} · ${num(st.farm.stolen)} stolen_`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'farmexpand',
  aliases: ['expandfarm', 'buyplot'],
  category: 'farming',
  description: '📐 Buy another plot — 10k each, 10 max',
  usage: '!farmexpand',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'farmexpand', async () => {
    await react('📐');
    const fm = s(userDoc).farm;

    if (clamp(fm.plots) >= MAX_PLOTS) {
      await reply(`📐 You own every plot there is (${MAX_PLOTS}/${MAX_PLOTS}). Go plant them.`, event.messageID);
      return;
    }

    const paid = await fee(userDoc, PLOT_COST, 'farm:expand');
    if (!paid.ok) {
      await reply(paid.reason, event.messageID);
      return;
    }

    fm.plots = clamp(fm.plots) + 1;
    if (!Array.isArray(fm.land)) fm.land = [];
    fm.land.push({ crop: '', plantedAt: 0, readyAt: 0, watered: false });
    await save(userDoc);

    await reply(
      `📐 **Plot ${clamp(fm.plots)}** cleared and ready for ${kc(PLOT_COST)}.\n`
      + `You now farm ${clamp(fm.plots)}/${MAX_PLOTS} plots.`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'farmsteal',
  aliases: ['stealfarm', 'croptheft'],
  category: 'farming',
  description: '🥷 Steal crops — 30% works, otherwise a 500 fine and a bad story',
  usage: '!farmsteal @user',
  cooldown: 30,
  permission: 'all',
  execute: async ({ userDoc, reply, react, args, event }) => guard(reply, event.messageID, 'farmsteal', async () => {
    await react('🥷');
    const st = s(userDoc);
    const victim = await target(reply, event.messageID, userDoc, args, event, 'farmsteal');
    if (!victim) return;

    const their = s(victim).farm;
    const stocked = Object.keys(their.crops || {}).filter((k) => clamp(their.crops[k]) > 0);
    if (!stocked.length) {
      await reply(`🥷 ${victim.name} has nothing in the barn. You walked away empty-handed and kept your dignity.`, event.messageID);
      return;
    }

    // The fine is charged on failure only. A 70% failure rate that also cost a
    // fee every single time would make this command unusable, so the risk is
    // the coin, not a double charge.
    if (Math.random() < 0.3) {
      const key = pick1(stocked);
      const crop = row(CROPS, key);
      const amount = Math.max(1, Math.floor(clamp(their.crops[key]) / 2));
      their.crops[key] = clamp(their.crops[key]) - amount;
      st.farm.stolen = clamp(st.farm.stolen) + 1;
      await save(victim);

      await reply(
        `🥷 Clean getaway. You took **${num(amount)}x ${crop ? crop[4] : '\u{1F33E}'} ${crop ? crop[1] : key}** from ${victim.name}'s barn.\n`
        + `_They still have ${num(clamp(their.crops[key]))}._`,
        event.messageID,
      );
      return;
    }

    const paid = await fee(userDoc, STEAL_FINE, 'farm:stealfine');
    if (!paid.ok) {
      await reply(`🥷 Caught — and you cannot even afford the ${kc(STEAL_FINE)} fine. ${victim.name} never has to know.`, event.messageID);
      return;
    }

    await reply(
      `🥷 **Caught.** ${victim.name}'s dog knew somebody was coming.\n`
      + `Fined ${kc(STEAL_FINE)}. The crops are still theirs, unlike your dignity.`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'farmleaderboard',
  aliases: ['farmtop', 'topfarmers'],
  category: 'farming',
  description: '🏆 Top farmers by level and total harvest',
  usage: '!farmleaderboard',
  cooldown: 10,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'farmleaderboard', async () => {
    await react('🏆');
    const fm = s(userDoc).farm;

    if (!mongo.isReady()) {
      await reply('🏆 The ledger is offline, so nobody can be ranked. Try again when the database is back.', event.messageID);
      return;
    }

    // Level first, total harvest second: a hunter who has actually farmed
    // cannot be outranked by somebody who pressed !farmstart once.
    const top = await User.find({ 'farm.level': { $exists: true, $gt: 0 } })
      .sort({ 'farm.level': -1, 'farm.totalHarvest': -1 })
      .limit(10)
      .catch(() => []);

    if (!top.length) {
      await reply('🏆 Nobody has claimed a farm yet. `!farmstart` and change that.', event.messageID);
      return;
    }

    const lines = top.map((doc, i) => {
      const f = doc.farm || {};
      const mine = String(doc.uid) === String(userDoc.uid);
      return `${i === 0 ? '\u{1F947}' : `${i + 1}.`} **${doc.name}** — \`Lv ${clamp(f.level)}\` · ${num(clamp(f.totalHarvest))} harvested`
        + `${clamp(f.prestige) ? ` · \u{2B50}${clamp(f.prestige)}` : ''}${mine ? ' _← you_' : ''}`;
    });

    await reply(`🏆 **Top farmers**\n\n${lines.join('\n')}\n\n_You are at farm level ${clamp(fm.level)}._`, event.messageID);
  }),
});

commands.push({
  name: 'dailyfarm',
  aliases: ['dailyharvest', 'farmdaily'],
  category: 'farming',
  description: '📅 Daily: free seeds, tool refills and 5k coins',
  usage: '!dailyfarm',
  cooldown: 10,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'dailyfarm', async () => {
    await react('📅');
    const st = s(userDoc);
    const fm = st.farm;

    // A Date, not a counter, so a restart cannot hand out a second daily. The
    // mongo check mirrors the offline-mode guard used everywhere else here:
    // with no database there is no stored claim date to compare against, and
    // refusing every offline claim would be worse than allowing it.
    // No mongo guard here: dailyAt lives on the document, so it is the
    // authority whether or not the database happens to be reachable. Gating it
    // on the connection would let a hunter claim repeatedly during an outage.
    const last = fm.dailyAt ? Date.parse(fm.dailyAt) : 0;
    if (Number.isFinite(last) && last > 0 && Date.now() - last < DAILY_MS) {
      await reply(`📅 Already claimed. Back in \`${secs(DAILY_MS - (Date.now() - last))}\`.`, event.messageID);
      return;
    }

    const seeds = [];
    for (const id of ['wheat', 'corn', 'potato']) {
      fm.seeds[`${id}_seed`] = clamp(fm.seeds[`${id}_seed`]) + 5;
      const crop = row(CROPS, id);
      seeds.push(`${crop[4]} ${crop[1]} x5`);
    }

    const refilled = [];
    for (const [tool, table] of [[st.mine.pick, PICKS], [st.fish.rod, RODS], [st.hunt.gun, GUNS]]) {
      const found = gear(table, tool.id);
      if (found && clamp(tool.dur) < found.dur) {
        tool.dur = found.dur;
        refilled.push(found.label);
      }
    }

    fm.dailyAt = new Date().toISOString();
    fm.taxAt = fm.taxAt || fm.dailyAt;
    await save(userDoc);
    const got = await give(userDoc, DAILY_COINS, 'farm:daily', { source: 'dailyfarm' });

    await reply(
      '📅 **Daily farm reward**\n\n'
      + `\u{1F33D} Seeds: ${seeds.join(' · ')}\n`
      + `\u{1F6E0} Tool refills: ${refilled.length ? refilled.join(' · ') : '_nothing was worn out_'}\n`
      + `\u{1F4B0} **${kc(got)}**\n\n_Covers your ${kc(LAND_TAX)} land tax._`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'farmprestige',
  aliases: ['farmreset', 'prestigefarm'],
  category: 'farming',
  description: '♻️ Reset at level 50 for +10% yield forever and an evolution stone',
  usage: '!farmprestige',
  cooldown: 30,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'farmprestige', async () => {
    await react('♻️');
    const fm = s(userDoc).farm;

    if (clamp(fm.level) < PRESTIGE_LEVEL) {
      await reply(
        `♻️ You need farm level **${PRESTIGE_LEVEL}** to reset. You are at \`${clamp(fm.level)}\`. `
        + `_\`${Math.max(0, xpNeed(fm.level) - clamp(fm.xp))} XP to the next level._`,
        event.messageID,
      );
      return;
    }
    if (clamp(userDoc.coins) < PRESTIGE_COINS) {
      await reply(`💸 **Not enough.** A reset costs ${kc(PRESTIGE_COINS)} and you have ${kc(userDoc.coins)}.`, event.messageID);
      return;
    }

    // The bonus is banked BEFORE anything is wiped, so a prestige can never
    // reduce the hunter's own multiplier.
    const next = clamp(fm.prestige) + 1;
    const stones = clamp(fm.stones) + 1;
    const totalHarvest = clamp(fm.totalHarvest);

    fm.prestige = next;
    fm.level = 1;
    fm.xp = 0;
    fm.plots = 3;
    fm.land = [];
    fm.crops = {};
    fm.seeds = {};
    fm.food = 0;
    fm.stones = stones;
    fm.totalHarvest = totalHarvest;

    await take(userDoc, PRESTIGE_COINS, 'farm:prestige', { prestige: next });
    await save(userDoc);

    await reply(
      `♻️ **Farm prestige ${next}.**\n\nLevel, plots, crops and seeds are gone — the ${num(totalHarvest)} you already harvested stays on the record.\n`
      + `Permanent yield bonus: **+${next * 10}%**\n`
      + `\u{1FAA8} Evolution stones: **${num(stones)}**\n`
      + `Paid ${kc(PRESTIGE_COINS)}.`,
      event.messageID,
    );
  }),
});// ───────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────
// MINE — stones and ore, on a pickaxe that wears out
// ───────────────────────────────────────────────────────────

commands.push({
  name: 'mineultra',
  aliases: ['m', 'dig'],
  category: 'farming',
  description: '⛏️ Swing for ore. Costs 1 durability, better picks find rarer stone',
  usage: '!mineultra',
  cooldown: 300,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event, api }) => guard(reply, event.messageID, 'mineultra', async () => {
    await react('⛏️');
    const st = s(userDoc);
    const mi = st.mine;

    if (!mi.pick.id) {
      await reply('⛏️ No pickaxe. `!mineshop` lists four — wooden is 1k.', event.messageID);
      return;
    }
    const pick = gear(PICKS, mi.pick.id);
    if (!pick || clamp(mi.pick.dur) <= 0) {
      await reply('⛏️ Your pickaxe is **broken** — 0 durability. `!minebuy wooden_pick` for another.', event.messageID);
      return;
    }

    const state = spend(mi.pick);
    const ore = drawOre(pick);
    mi.ores[ore[0]] = clamp(mi.ores[ore[0]]) + 1;
    const ups = gain(mi, 20 + Math.round(ore[2] / 100));
    // Stone is the mine's real currency — module 4 evolution wants it — so it
    // is banked separately instead of only sitting in the sellable pile.
    if (ore[0] === 'stone') st.farm.stones = clamp(st.farm.stones) + 1;
    await save(userDoc);
    await ledger(userDoc.uid, 'mine:dig', 0, clamp(userDoc.coins), { ore: ore[0] });

    const left = clamp(mi.pick.dur);
    await send(api, event.threadID, await haulCard({
      title: `${ore[4]} ${ore[1]}`,
      subtitle: `${pick.label} — durability ${left}/${pick.dur}`,
      body: `Worth ${kc(ore[2])} on its own. You are carrying ${num(clamp(mi.ores[ore[0]]))} ${ore[1]}.`,
      footer: state === 'broke' ? 'THE PICKAXE BROKE ON THAT ONE' : '!minesell to cash in',
      accent: canvasKit.theme.accent2,
    }), event.messageID, event.isGroup);

    await reply(
      `⛏️ You break into the rock and pull out **${ore[4]} ${ore[1]}**.\n`
      + `Durability \`${left}/${pick.dur}\`${state === 'broke' ? ` — **it snapped.** \`!minebuy ${pick.id}\`` : ''}\n`
      + `Carrying ${num(clamp(mi.ores[ore[0]]))}. \`!minesell ${ore[0]} 1\` for ${kc(ore[2])} each.`
      + `${ups ? `\n📈 **Mining level ${clamp(mi.level)}!**` : ''}`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'mineshop',
  aliases: ['pickaxeshop', 'toolshop'],
  category: 'farming',
  description: '🛠️ Pickaxes — the only thing between you and a cave',
  usage: '!mineshop',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'mineshop', async () => {
    await react('🛠️');
    const st = s(userDoc);
    const held = gear(PICKS, st.mine.pick.id);

    const lines = PICKS.map((p) => {
      const owned = held && held.id === p[0];
      return `${owned ? '✅' : '\u{1F6E0}'} **${p[1]}** \`${p[0]}\` ${kc(p[2])} · ${p[3]} durability`
        + `${owned ? ` _dur \u{1F50B}${clamp(st.mine.pick.dur)}/${p[3]}_` : ''}`;
    }).join('\n');

    await reply(
      `🛠️ **Mine shop** — you have ${kc(userDoc.coins)}\n\n${lines}\n\n`
      + `_Buy with \`!minebuy ${PICKS[0][0]}\`. Higher tiers weight the deep ores more often._\n`
      + '_Refills come free with `!dailyfarm`._',
      event.messageID,
    );
  }),
});

commands.push({
  name: 'minebuy',
  aliases: ['buypick', 'buypickaxe'],
  category: 'farming',
  description: '🛠️ Buy or replace a pickaxe — !minebuy diamond_pick',
  usage: '!minebuy <pick>',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, args, event }) => guard(reply, event.messageID, 'minebuy', async () => {
    await react('🛠️');
    const st = s(userDoc);
    const want = gearById(PICKS, args[0], ['pick', 'pickaxe']);
    if (!want) {
      await reply('❌ Unknown pickaxe. `!mineshop` lists all four.', event.messageID);
      return;
    }

    const held = gear(PICKS, st.mine.pick.id);
    // A tool at 0 durability is not "already owned" — it is gone. Blocking the
    // re-purchase would leave a broke hunter permanently locked out of the loop
    // with no way back but a daily, which is a dead end rather than a grind.
    if (held && held.id === want.id && clamp(st.mine.pick.dur) > 0) {
      await reply(
        `🛠️ You already own the ${want.label}, \`${clamp(st.mine.pick.dur)}/${held.dur}\` durability left.\n`
        + `_A fresh one is ${kc(want.price)}. !dailyfarm repairs yours free._`,
        event.messageID,
      );
      return;
    }

    // Refuse a downgrade BEFORE taking the money, so the refund below can never
    // be skipped by a throw between the charge and the give-back.
    if (held && want.tier < held.tier) {
      await reply(
        `🛠️ You have the **${held.label}**. The ${want.label} would be a downgrade, so nothing was charged.`,
        event.messageID,
      );
      return;
    }

    const paid = await fee(userDoc, want.price, 'mine:buy');
    if (!paid.ok) {
      await reply(paid.reason, event.messageID);
      return;
    }

    st.mine.pick = { id: want.id, dur: want.dur };
    await save(userDoc);

    await reply(
      `🛠️ Bought the **${want.label}** for ${kc(want.price)}. Durability \`${want.dur}/${want.dur}\`.\n`
      + 'Go break something: `!m`.',
      event.messageID,
    );
  }),
});

commands.push({
  name: 'mineinventory',
  aliases: ['myore', 'oresinv'],
  category: 'farming',
  description: '🪨 Ore in your pack and what it is worth',
  usage: '!mineinventory',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'mineinventory', async () => {
    await react('🪨');
    const st = s(userDoc);
    const pick = gear(PICKS, st.mine.pick.id);

    await reply(
      `🪨 **Ore pack** — ${kc(bagValue(st.mine.ores, ORES, 2))} unsold\n\n${bag(st.mine.ores, ORES, 2)}\n\n`
      + `Pickaxe: ${pick ? `**${pick.label}** \`${clamp(st.mine.pick.dur)}/${pick.dur}\`` : '_none — `!minebuy wooden_pick`_'}\n`
      + `Mining level \`${clamp(st.mine.level)}\` · stones banked ${num(st.farm.stones)}`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'minesell',
  aliases: ['sellore', 'oremarket'],
  category: 'farming',
  description: '💎 Sell ore — !minesell diamond 5',
  usage: '!minesell <ore> [qty]',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, args, event }) => guard(reply, event.messageID, 'minesell', async () => {
    await react('💎');
    const st = s(userDoc);

    const ore = row(ORES, String(args[0] || '').trim().toLowerCase());
    if (!ore) {
      await reply('❌ Unknown ore. `!mineinventory` shows the pack.', event.messageID);
      return;
    }

    const have = clamp(st.mine.ores[ore[0]]);
    if (have <= 0) {
      await reply(`📦 No ${ore[1]} in the pack.`, event.messageID);
      return;
    }

    const qty = args[1] ? clamp(args[1]) : have;
    if (qty > have) {
      await reply(`📦 You only have **${num(have)}** ${ore[1]}. Selling all of them instead.`, event.messageID);
    }
    const sold = Math.min(have, qty);

    st.mine.ores[ore[0]] = have - sold;
    await save(userDoc);
    const got = await give(userDoc, ore[2] * sold, 'mine:sell', { ore: ore[0], qty: sold });
    await ledger(userDoc.uid, 'mine:harvest', got, clamp(userDoc.coins), { ore: ore[0], qty: sold });

    await reply(
      `💎 Sold **${num(sold)}x ${ore[4]} ${ore[1]}** for ${kc(got)}.\nBalance ${kc(userDoc.coins)}.`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'minerank',
  aliases: ['minetop', 'minerboard'],
  category: 'farming',
  description: '⛏️ Mining level leaderboard',
  usage: '!minerank',
  cooldown: 10,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'minerank', async () => {
    await react('⛏️');
    const mi = s(userDoc).mine;

    if (!mongo.isReady()) {
      await reply('⛏️ The rock is silent. Mining ranks need the database, and it is offline.', event.messageID);
      return;
    }

    const top = await User.find({ 'mine.level': { $exists: true, $gt: 0 } })
      .sort({ 'mine.level': -1, 'mine.xp': -1 })
      .limit(10)
      .catch(() => []);

    if (!top.length) {
      await reply('⛏️ Nobody has swung a pickaxe yet. `!minebuy wooden_pick` and change that.', event.messageID);
      return;
    }

    const lines = top.map((doc, i) => {
      const m = doc.mine || {};
      const mine = String(doc.uid) === String(userDoc.uid);
      const pick = gear(PICKS, m.pick && m.pick.id);
      return `${i === 0 ? '\u{1F947}' : `${i + 1}.`} **${doc.name}** — mining \`Lv ${clamp(m.level)}\`${pick ? ` · ${pick.label}` : ''}`
        + `${mine ? ' _← you_' : ''}`;
    });

    await reply(`⛏️ **Mining ranks**\n\n${lines.join('\n')}\n\n_You are at mining level ${clamp(mi.level)}._`, event.messageID);
  }),
});

commands.push({
  name: 'minedig',
  aliases: ['deepdig', 'digdeep'],
  category: 'farming',
  description: '🕳️ Hourly deep dig, big haul — 20% chance the cave comes down on your pickaxe',
  usage: '!minedig',
  cooldown: 3600,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event, api }) => guard(reply, event.messageID, 'minedig', async () => {
    await react('🕳️');
    const st = s(userDoc);
    const mi = st.mine;

    if (!mi.pick.id) {
      await reply('🕳️ No pickaxe. A deep dig without a tool is just falling. `!mineshop`', event.messageID);
      return;
    }
    const pick = gear(PICKS, mi.pick.id);
    if (!pick || clamp(mi.pick.dur) <= 0) {
      await reply('🕳️ Your pickaxe is broken. `!minebuy` first — you cannot dig with a dead tool.', event.messageID);
      return;
    }

    // Ten swings of wear for an hour of commitment, and the one thing in this
    // module that can destroy a tool outright. It says so plainly below.
    const wear = 10;
    const collapsed = Math.random() < 0.2;

    const haul = [];
    let worth = 0;
    for (let i = 0; i < 6; i += 1) {
      const ore = drawOre(pick);
      const qty = rand(1, 3);
      mi.ores[ore[0]] = clamp(mi.ores[ore[0]]) + qty;
      worth += ore[2] * qty;
      if (ore[0] === 'stone') st.farm.stones = clamp(st.farm.stones) + qty;
      if (!haul.some((h) => h.id === ore[0])) haul.push({ id: ore[0], icon: ore[4], label: ore[1], qty });
    }

    if (collapsed) {
      mi.pick.dur = 0;
      await save(userDoc);
      await ledger(userDoc.uid, 'mine:harvest', 0, clamp(userDoc.coins), { dig: true, worth, collapsed: true });

      await send(api, event.threadID, await haulCard({
        title: '\u{1F4A5} Cave-in',
        subtitle: `${pick.label} — destroyed`,
        body: `You came up with ${kc(worth)} of ore, but the ${pick.label} is now a bent piece of scrap.`,
        footer: `REPLACE IT WITH !minebuy ${pick.id}`,
        accent: '#ff4444',
      }), event.messageID, event.isGroup);

      await reply(
        '🕳️ You went deep and the roof came down.\n'
        + `**${pick.label} destroyed.** The ore you did pull is still in the pack.\n`
        + `Salvage value ${kc(worth)}. \`!minebuy ${pick.id}\` for a fresh one.`,
        event.messageID,
      );
      return;
    }

    mi.pick.dur = Math.max(0, clamp(mi.pick.dur) - wear);
    gain(mi, 150);
    await save(userDoc);
    await ledger(userDoc.uid, 'mine:harvest', 0, clamp(userDoc.coins), { dig: true, worth });

    await send(api, event.threadID, await haulCard({
      title: '\u{1F9AA} Deep haul',
      subtitle: `${pick.label} — durability ${clamp(mi.pick.dur)}/${pick.dur}`,
      body: haul.map((h) => `${h.icon} ${h.label} x${h.qty}`).join(' · '),
      footer: `WORTH ${kc(worth)}`,
      accent: canvasKit.theme.accent,
    }), event.messageID, event.isGroup);

    await reply(
      `🕳️ **Deep dig.** ${haul.map((h) => `${h.icon} ${h.label} x${h.qty}`).join(' · ')}\n`
      + `Worth ${kc(worth)} if you sell it. The pickaxe took ${wear} durability — \`${clamp(mi.pick.dur)}/${pick.dur}\` left.`,
      event.messageID,
    );
  }),
});// ───────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────
// FISH — the reliable coin floor
// ───────────────────────────────────────────────────────────

commands.push({
  name: 'fishstart',
  aliases: ['startfish', 'getrod'],
  category: 'farming',
  description: '🎣 Get your first rod — free. The friendliest grind in the bot',
  usage: '!fishstart',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'fishstart', async () => {
    await react('🎣');
    const fi = s(userDoc).fish;

    if (fi.rod.id) {
      const rod = gear(RODS, fi.rod.id);
      await reply(
        `🎣 You already fish with the **${rod ? rod.label : 'old rod'}** — \`${clamp(fi.rod.dur)}/${rod ? rod.dur : 0}\`.\n`
        + 'Cast with `!fishing`.',
        event.messageID,
      );
      return;
    }

    const rod = RODS[0];
    fi.rod = { id: rod[0], dur: rod[3] };
    await save(userDoc);

    await reply(
      `🎣 **Fishing licence issued** — the ${rod[1]}, free, \`${rod[3]} durability\`.\n`
      + 'Cast with `!fishing`. The rod banks 30% of each catch on the spot and you keep the fish.',
      event.messageID,
    );
  }),
});

commands.push({
  name: 'fishultra',
  aliases: ['fishing', 'fish2'],
  category: 'farming',
  description: '🎣 Cast a line. Costs 1 durability, better rods catch rarer fish',
  usage: '!fishultra',
  cooldown: 180,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event, api }) => guard(reply, event.messageID, 'fishultra', async () => {
    await react('🎣');
    const st = s(userDoc);
    const fi = st.fish;

    if (!fi.rod.id) {
      await reply('🎣 No rod. `!fishstart` is free and takes two seconds.', event.messageID);
      return;
    }
    const rod = gear(RODS, fi.rod.id);
    if (!rod || clamp(fi.rod.dur) <= 0) {
      await reply('🎣 Your rod is done. `!fishbuy basic_rod` for another.', event.messageID);
      return;
    }

    const state = spend(fi.rod);
    const catchOne = drawFish(rod);
    fi.catch[catchOne[0]] = clamp(fi.catch[catchOne[0]]) + 1;
    const ups = gain(fi, 15 + Math.round(catchOne[2] / 150));
    await save(userDoc);

    // 30% is paid immediately and the fish stays in the barn, so a bad cast is
    // never worth nothing.
    const coins = await give(userDoc, Math.floor(catchOne[2] * CATCH_RATE), 'fish:catch', { fish: catchOne[0] });
    await ledger(userDoc.uid, 'fish:harvest', coins, clamp(userDoc.coins), { fish: catchOne[0] });

    await tournamentCatch(userDoc, event, catchOne);
    const verdict = await settleTournament(userDoc, event);

    const left = clamp(fi.rod.dur);
    await send(api, event.threadID, await haulCard({
      title: `${catchOne[4]} ${catchOne[1]}`,
      subtitle: `${rod.label} — durability ${left}/${rod.dur}`,
      body: `Sold for ${kc(catchOne[2])}; the rod took its ${kc(Math.floor(catchOne[2] * CATCH_RATE))} cut on the spot. `
        + `Your cooler now holds ${num(clamp(fi.catch[catchOne[0]]))} ${catchOne[1]}.`,
      footer: state === 'broke' ? 'THE ROD BROKE ON THAT CAST' : '!fishsell when the cooler is full',
      accent: '#3aa0ff',
    }), event.messageID, event.isGroup);

    const big = rarityOf(FISH, catchOne[0]) >= 7;
    await reply(
      `${big ? '\u{1F929}' : '\u{1F41F}'} You pull up **${catchOne[4]} ${catchOne[1]}** — ${kc(catchOne[2])}.\n`
      + `The rod banks ${kc(coins)} straight away and you keep the fish.\n`
      + `Durability \`${left}/${rod.dur}\`${state === 'broke' ? ` — **it snapped.** \`!fishbuy ${rod.id}\`` : ''}\n`
      + `_Cooler: ${num(clamp(fi.catch[catchOne[0]]))} ${catchOne[1]}._\n`
      + `${ups ? `📈 **Fishing level ${clamp(fi.level)}!**` : ''}`
      + `${verdict ? `\n\n${verdict}` : ''}`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'fishshop',
  aliases: ['rodshop', 'tackleshop'],
  category: 'farming',
  description: '🪝 Rods — cheap, and the only reason to ever be broke',
  usage: '!fishshop',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'fishshop', async () => {
    await react('🪝');
    const st = s(userDoc);
    const held = gear(RODS, st.fish.rod.id);

    const lines = RODS.map((r) => {
      const owned = held && held.id === r[0];
      return `${owned ? '✅' : '\u{1F41F}'} **${r[1]}** \`${r[0]}\` ${kc(r[2])} · ${r[3]} durability`
        + `${owned ? ` _dur \u{1F50B}${clamp(st.fish.rod.dur)}/${r[3]}_` : ''}`;
    }).join('\n');

    await reply(
      `🪝 **Tackle shop** — you have ${kc(userDoc.coins)}\n\n${lines}\n\n`
      + `_Buy with \`!fishbuy ${RODS[0][0]}\`. Pro and iKon rods weight the deep fish more often._\n`
      + '_A worn rod is refilled free by `!dailyfarm`._',
      event.messageID,
    );
  }),
});

commands.push({
  name: 'fishbuy',
  aliases: ['buyrod', 'buytackle'],
  category: 'farming',
  description: '🪝 Buy or replace a rod — !fishbuy pro_rod',
  usage: '!fishbuy <rod>',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, args, event }) => guard(reply, event.messageID, 'fishbuy', async () => {
    await react('🪝');
    const st = s(userDoc);
    const want = gearById(RODS, args[0], ['rod']);
    if (!want) {
      await reply('❌ Unknown rod. `!fishshop` lists all three.', event.messageID);
      return;
    }

    const held = gear(RODS, st.fish.rod.id);
    // Same rule as minebuy: 0 durability is not ownership.
    if (held && held.id === want.id && clamp(st.fish.rod.dur) > 0) {
      await reply(
        `🪝 You already own the ${want.label}, \`${clamp(st.fish.rod.dur)}/${held.dur}\` durability.\n`
        + `_A replacement is ${kc(want.price)}. !dailyfarm repairs yours free._`,
        event.messageID,
      );
      return;
    }
    if (held && want.tier < held.tier) {
      await reply(
        `🪝 You have the **${held.label}**. The ${want.label} would be a downgrade, so nothing was charged.`,
        event.messageID,
      );
      return;
    }

    const paid = await fee(userDoc, want.price, 'fish:buy');
    if (!paid.ok) {
      await reply(paid.reason, event.messageID);
      return;
    }

    st.fish.rod = { id: want.id, dur: want.dur };
    await save(userDoc);

    await reply(`🪝 Bought the **${want.label}** for ${kc(want.price)}. Durability \`${want.dur}/${want.dur}\`.\nCast away: \`!fishing\`.`, event.messageID);
  }),
});

commands.push({
  name: 'fishsell',
  aliases: ['sellfish', 'fishmarket'],
  category: 'farming',
  description: '🐟 Sell fish — !fishsell shark 2',
  usage: '!fishsell <fish> [qty]',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, args, event }) => guard(reply, event.messageID, 'fishsell', async () => {
    await react('🐟');
    const st = s(userDoc);

    const one = row(FISH, String(args[0] || '').trim().toLowerCase());
    if (!one) {
      await reply('❌ Unknown fish. `!fishinventory` shows the cooler.', event.messageID);
      return;
    }

    const have = clamp(st.fish.catch[one[0]]);
    if (have <= 0) {
      await reply(`📦 No ${one[1]} in the cooler.`, event.messageID);
      return;
    }

    const qty = args[1] ? clamp(args[1]) : have;
    if (qty > have) {
      await reply(`📦 You only have **${num(have)}** ${one[1]}. Selling all of them instead.`, event.messageID);
    }
    const sold = Math.min(have, qty);

    st.fish.catch[one[0]] = have - sold;
    await save(userDoc);
    const got = await give(userDoc, one[2] * sold, 'fish:sell', { fish: one[0], qty: sold });
    await ledger(userDoc.uid, 'fish:harvest', got, clamp(userDoc.coins), { fish: one[0], qty: sold });

    await reply(`🐟 Sold **${num(sold)}x ${one[4]} ${one[1]}** for ${kc(got)}. Balance ${kc(userDoc.coins)}.`, event.messageID);
  }),
});

commands.push({
  name: 'fishinventory',
  aliases: ['fishinv', 'cooler'],
  category: 'farming',
  description: '🐟 The cooler — every fish and what it is worth',
  usage: '!fishinventory',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'fishinventory', async () => {
    await react('🐟');
    const st = s(userDoc);
    const rod = gear(RODS, st.fish.rod.id);

    await reply(
      `🐟 **Cooler** — ${kc(bagValue(st.fish.catch, FISH, 2))} unsold\n\n${bag(st.fish.catch, FISH, 2)}\n\n`
      + `Rod: ${rod ? `**${rod.label}** \`${clamp(st.fish.rod.dur)}/${rod.dur}\`` : '_none — `!fishstart`_'}\n`
      + `Fishing level \`${clamp(st.fish.level)}\``,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'fishtournament',
  aliases: ['fishtourney', 'tournamentfish'],
  category: 'farming',
  description: '🏆 GC tournament — 10k to whoever lands the rarest fish before the clock runs out',
  usage: '!fishtournament',
  cooldown: 10,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'fishtournament', async () => {
    await react('🏆');
    const st = s(userDoc);

    if (!event.isGroup) {
      await reply('🏆 Tournaments are a group-chat event. Take this somewhere with witnesses.', event.messageID);
      return;
    }
    if (!st.fish.rod.id) {
      await reply('🎣 You need a rod before you can fish in a tournament. `!fishstart` is free.', event.messageID);
      return;
    }

    // Empty uid makes the key thread-scoped, so two groups can run tournaments
    // at the same time without sharing a pot.
    const board = cache.getPendingGame('fishtournament', event.threadID, '');
    if (board && Date.now() < board.expires) {
      const entries = Array.isArray(board.entries) ? board.entries : [];
      const lines = await Promise.all(entries.map(async (e) => {
        const doc = await payoutFor(e.uid);
        return `${doc ? doc.name : e.uid}: ${e.skin || ''} **${e.label}**`;
      }));

      await reply(
        `🏆 A tournament is already running here — \`${secs(board.expires - Date.now())}\` left.\n\n`
        + `${lines.length ? lines.join('\n') : '_nobody has landed anything yet_'}\n\n`
        + '_Cast with `!fishing`._ The pot pays when the clock runs out.',
        event.messageID,
      );
      return;
    }

    cache.putPendingGame('fishtournament', event.threadID, '', { entries: [], pot: TOURNAMENT_POT });
    await reply(
      '🏆 **Fishing tournament open.**\n'
      + '\u{1F41F} Cast with `!fishing` — your best catch counts.\n'
      + `\u{1FA99} Pot: **${kc(TOURNAMENT_POT)}**\n\n`
      + '_No entry fee. The rarest fish when the clock runs out takes it._',
      event.messageID,
    );
  }),
});

/**
 * Count a cast toward this group's tournament, if one is running.
 *
 * Called from the fishing command, so the tournament cannot be won by shouting
 * in the chat — only by actually holding a rod and casting.
 */
async function tournamentCatch(userDoc, event, fish) {
  if (!event.isGroup || !mongo.isReady()) return;
  const board = cache.getPendingGame('fishtournament', event.threadID, '');
  if (!board || Date.now() >= board.expires) return;

  const entries = Array.isArray(board.entries) ? board.entries : [];
  const tier = rarityOf(FISH, fish[0]);
  const mine = entries.find((e) => e.uid === String(userDoc.uid));

  if (mine) {
    // Best catch wins, so a later sardine never downgrades a megalodon.
    if (tier <= mine.tier) return;
    mine.tier = tier;
    mine.label = fish[1];
    mine.skin = fish[4];
  } else {
    entries.push({ uid: String(userDoc.uid), tier, label: fish[1], skin: fish[4] });
  }
  cache.putPendingGame('fishtournament', event.threadID, '', { entries, pot: board.pot });
}

/**
 * Pay out an expired tournament, if this cast is the one that ends it.
 *
 * Settled lazily on the next cast rather than by a timer: nothing in this
 * module runs a background job, and a pot nobody ever claims is worse than one
 * paid a minute late. Returns null unless the pot actually changed hands, so
 * the fishing reply stays quiet in the normal case.
 *
 * @returns {Promise<string|null>} a line to append, or null
 */
async function settleTournament(userDoc, event) {
  if (!event.isGroup || !mongo.isReady()) return null;
  const board = cache.getPendingGame('fishtournament', event.threadID, '');
  if (!board || Date.now() < board.expires) return null;

  const entries = (Array.isArray(board.entries) ? board.entries : [])
    .filter((e) => e && Number.isFinite(e.tier) && e.tier >= 0);
  cache.takePendingGame('fishtournament', event.threadID, '');

  if (!entries.length) {
    return `\u{1F3C6} _The tournament closed with no catches. The ${kc(TOURNAMENT_POT)} pot stays put._`;
  }

  entries.sort((a, b) => b.tier - a.tier);
  const win = entries[0];
  const won = await payoutFor(win.uid);
  if (!won) return '\u{1F3C6} _The winner left iKON before the pot could be paid._';

  const pot = clamp(board.pot) || TOURNAMENT_POT;
  await give(won, pot, 'fish:tournament', { label: win.label });

  const ties = entries.filter((e) => e.tier === win.tier && e.uid !== win.uid).length;
  return `\u{1F3C6} **Tournament over!** ${won.name} takes ${kc(pot)} for ${win.skin || ''} **${win.label}**.`
    + `${ties ? ` (${ties} tied.)` : ''}`;
}// ───────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────
// HUNT — meat, skins, and a 1k hospital bill for a bad shot
// ───────────────────────────────────────────────────────────

commands.push({
  name: 'huntstart',
  aliases: ['starthunt', 'getlicense'],
  category: 'farming',
  description: '🎫 Hunting licence — 1k. The most expensive way to shoot a squirrel',
  usage: '!huntstart',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'huntstart', async () => {
    await react('🎫');
    const hu = s(userDoc).hunt;

    if (hu.licensed) {
      await reply(`🎫 You already hold a licence — ${num(clamp(hu.kills))} kills on it. \`!huntshop\` for a gun.`, event.messageID);
      return;
    }

    const paid = await fee(userDoc, HUNT_LICENSE, 'hunt:licence');
    if (!paid.ok) {
      await reply(`${paid.reason}\n_A licence costs ${kc(HUNT_LICENSE)}. You will also need a gun: \`!huntshop\`._`, event.messageID);
      return;
    }

    hu.licensed = true;
    await save(userDoc);

    await reply(
      `🎫 **Licensed** for ${kc(HUNT_LICENSE)}.\n`
      + `A licence is not a gun — \`!huntshop\` starts at ${kc(GUNS[0][2])}.\n`
      + '_Skins are pure flex. Nobody needs an iKon Titanbeast pelt._',
      event.messageID,
    );
  }),
});

commands.push({
  name: 'huntultra',
  aliases: ['hunting', 'hunt2'],
  category: 'farming',
  description: '🏹 Hunt an animal. Costs 1 durability, 25% of shots end in hospital',
  usage: '!huntultra',
  cooldown: 300,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event, api }) => guard(reply, event.messageID, 'huntultra', async () => {
    await react('🏹');
    const st = s(userDoc);
    const hu = st.hunt;

    if (!hu.licensed) {
      await reply('🎫 No licence. `!huntstart` costs 1k and it is the cheapest way to waste 1k.', event.messageID);
      return;
    }
    if (!hu.gun.id) {
      await reply('🔫 No gun. `!huntshop` — a pistol is 2k.', event.messageID);
      return;
    }
    const gun = gear(GUNS, hu.gun.id);
    if (!gun || clamp(hu.gun.dur) <= 0) {
      await reply('🔫 Your gun is scrap metal. `!huntbuy pistol` replaces it.', event.messageID);
      return;
    }

    // Injury is checked before the shot, so a hunter in hospital is told why
    // instead of being shot at by a bot that forgot.
    const hurtUntil = hu.injuredUntil ? Date.parse(hu.injuredUntil) : 0;
    if (Number.isFinite(hurtUntil) && hurtUntil > Date.now()) {
      await reply(`\u{1F3E5} You are in hospital until \`${secs(hurtUntil - Date.now())}\`. Somebody shoot the doctor.`, event.messageID);
      return;
    }

    const state = spend(hu.gun);
    const shot = drawAnimal(gun);
    const injured = Math.random() < 0.25;

    // The animal is bagged either way. Missing the point of the shot does not
    // conjour the carcass into the barn, and it certainly does not refund it.
    hu.meat[shot[0]] = clamp(hu.meat[shot[0]]) + 1;
    hu.skins[shot[0]] = clamp(hu.skins[shot[0]]) + 1;
    hu.kills = clamp(hu.kills) + 1;
    if (rarityOf(ANIMALS, shot[0]) > rarityOf(ANIMALS, hu.rarest)) hu.rarest = shot[0];
    const ups = gain(hu, 25 + Math.round(shot[2] / 100));

    if (injured) {
      // Too broke to pay is the only way this loop loses you nothing but time.
      const billed = clamp(userDoc.coins) >= HOSPITAL;
      const rest = billed ? 10 : 4;
      hu.injuredUntil = new Date(Date.now() + rest * 60 * 1000).toISOString();
      if (billed) await take(userDoc, HOSPITAL, 'hunt:hospital', { animal: shot[0] });
      await save(userDoc);
      await ledger(userDoc.uid, 'hunt:harvest', 0, clamp(userDoc.coins), { animal: shot[0], injured: true, billed });

      await send(api, event.threadID, await haulCard({
        title: '\u{1F3E5} Injured',
        subtitle: `${gun.label} — durability ${clamp(hu.gun.dur)}/${gun.dur}`,
        body: `You landed the ${shot[5]} ${shot[1]}, but not cleanly. `
          + (billed ? `The hospital took ${kc(HOSPITAL)}.` : 'The hospital waived the bill because you had nothing.'),
        footer: billed ? 'TEN MINUTES ON A STRETCHER' : 'FOUR MINUTES — POORER, BUT HEALED',
        accent: '#ff4444',
      }), event.messageID, event.isGroup);

      await reply(
        `🏹 You dropped the **${shot[5]} ${shot[1]}** — and then it dropped you.\n`
        + `\u{1F3E5} Hospital ${billed ? kc(HOSPITAL) : 'waived'} · back in \`${rest}m\`\n`
        + `Meat and skin are on the rack. Durability \`${clamp(hu.gun.dur)}/${gun.dur}\``
        + `${state === 'broke' ? ' — **gun broke.**' : ''}`,
        event.messageID,
      );
      return;
    }

    await save(userDoc);
    await ledger(userDoc.uid, 'hunt:harvest', 0, clamp(userDoc.coins), { animal: shot[0] });
    const duelLine = await duelCatch(userDoc, event, shot);

    const best = row(ANIMALS, hu.rarest);
    await send(api, event.threadID, await haulCard({
      title: `${shot[5]} ${shot[1]}`,
      subtitle: `${gun.label} — durability ${clamp(hu.gun.dur)}/${gun.dur}`,
      body: `Meat ${kc(shot[2])} · skin ${kc(shot[3])}. Rarest on your licence: ${best ? best[1] : '—'}.`,
      footer: state === 'broke' ? 'THE GUN BROKE ON THAT SHOT' : `${num(clamp(hu.kills))} KILLS`,
      accent: '#c0392b',
    }), event.messageID, event.isGroup);

    await reply(
      `🏹 Clean shot — **${shot[5]} ${shot[1]}**.\n`
      + `\u{1F9AA} Meat ${kc(shot[2])} · \u{1F9B4} Skin ${kc(shot[3])} · \`!huntsell ${shot[0]} 1\`\n`
      + `Durability \`${clamp(hu.gun.dur)}/${gun.dur}\`${state === 'broke' ? ` — **it broke.** \`!huntbuy ${gun.id}\`` : ''}\n`
      + `Kills ${num(clamp(hu.kills))}${ups ? ` · 📈 **Hunting level ${clamp(hu.level)}!**` : ''}`
      + `${duelLine ? `\n\n${duelLine}` : ''}`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'huntshop',
  aliases: ['armshop', 'huntstore'],
  category: 'farming',
  description: '🔫 Guns — the most expensive toys in the bot',
  usage: '!huntshop',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'huntshop', async () => {
    await react('🔫');
    const st = s(userDoc);
    const held = gear(GUNS, st.hunt.gun.id);

    const lines = GUNS.map((g) => {
      const owned = held && held.id === g[0];
      return `${owned ? '✅' : '\u{1F52B}'} **${g[1]}** \`${g[0]}\` ${kc(g[2])} · ${g[3]} durability`
        + `${owned ? ` _dur \u{1F50B}${clamp(st.hunt.gun.dur)}/${g[3]}_` : ''}`;
    }).join('\n');

    await reply(
      `🔫 **Gun shop** — you have ${kc(userDoc.coins)}\n`
      + `${st.hunt.licensed ? '✅ Licence held' : `❌ No licence — \`!huntstart\` ${kc(HUNT_LICENSE)}`}\n\n${lines}\n\n`
      + `_Buy with \`!huntbuy ${GUNS[0][0]}\`. Bigger guns weight the big game more often._\n`
      + `_Every fourth shot ends in a ${kc(HOSPITAL)} hospital bill._`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'huntbuy',
  aliases: ['buyguns', 'buygun'],
  category: 'farming',
  description: '🔫 Buy or replace a gun — !huntbuy rifle',
  usage: '!huntbuy <gun>',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, args, event }) => guard(reply, event.messageID, 'huntbuy', async () => {
    await react('🔫');
    const st = s(userDoc);
    const want = gearById(GUNS, args[0], ['gun']);

    if (!want) {
      await reply('❌ Unknown gun. `!huntshop` lists all four.', event.messageID);
      return;
    }
    if (!st.hunt.licensed) {
      await reply(`🎫 A licence comes first — \`!huntstart\`, ${kc(HUNT_LICENSE)}. The seller will wait.`, event.messageID);
      return;
    }

    const held = gear(GUNS, st.hunt.gun.id);
    // Same rule as minebuy: 0 durability is not ownership.
    if (held && held.id === want.id && clamp(st.hunt.gun.dur) > 0) {
      await reply(
        `🔫 You already own the ${want.label}, \`${clamp(st.hunt.gun.dur)}/${held.dur}\` durability.\n`
        + `_A replacement is ${kc(want.price)}. !dailyfarm repairs yours free._`,
        event.messageID,
      );
      return;
    }
    if (held && want.tier < held.tier) {
      await reply(
        `🔫 You have the **${held.label}**. The ${want.label} would be a downgrade, so nothing was charged.`,
        event.messageID,
      );
      return;
    }

    const paid = await fee(userDoc, want.price, 'hunt:buy');
    if (!paid.ok) {
      await reply(paid.reason, event.messageID);
      return;
    }

    st.hunt.gun = { id: want.id, dur: want.dur };
    await save(userDoc);

    await reply(`🔫 Bought the **${want.label}** for ${kc(want.price)}. Durability \`${want.dur}/${want.dur}\`.\nTake it out: \`!hunting\`.`, event.messageID);
  }),
});

commands.push({
  name: 'huntsell',
  aliases: ['sellmeat', 'huntmarket'],
  category: 'farming',
  description: '💵 Sell meat and skins — !huntsell bear 1',
  usage: '!huntsell <animal> [qty]',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, args, event }) => guard(reply, event.messageID, 'huntsell', async () => {
    await react('💵');
    const st = s(userDoc);

    const animal = row(ANIMALS, String(args[0] || '').trim().toLowerCase());
    if (!animal) {
      await reply('❌ Unknown animal. `!huntinventory` shows the rack.', event.messageID);
      return;
    }

    const haveMeat = clamp(st.hunt.meat[animal[0]]);
    const haveSkin = clamp(st.hunt.skins[animal[0]]);
    if (haveMeat <= 0 && haveSkin <= 0) {
      await reply(`📦 No ${animal[1]} on the rack.`, event.messageID);
      return;
    }

    // Meat and skin sell together: nobody keeps a rack of split pelts on
    // purpose, so the meaningful choice is the quantity, not the split.
    const qty = args[1] ? Math.min(clamp(args[1]), Math.max(haveMeat, haveSkin)) : Math.max(haveMeat, haveSkin);
    const meatQty = Math.min(haveMeat, qty);
    const skinQty = Math.min(haveSkin, qty);
    const worth = animal[2] * meatQty + animal[3] * skinQty;

    st.hunt.meat[animal[0]] = haveMeat - meatQty;
    st.hunt.skins[animal[0]] = haveSkin - skinQty;
    await save(userDoc);
    const got = await give(userDoc, worth, 'hunt:sell', { animal: animal[0], meatQty, skinQty });
    await ledger(userDoc.uid, 'hunt:harvest', got, clamp(userDoc.coins), { animal: animal[0] });

    await reply(
      `💵 Sold **${num(meatQty)}x \u{1F9AA} meat** and **${num(skinQty)}x \u{1F9B4} skin** `
      + `from the ${animal[5]} ${animal[1]} for ${kc(got)}.\nBalance ${kc(userDoc.coins)}.`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'huntinventory',
  aliases: ['huntinv', 'rack'],
  category: 'farming',
  description: '🥩 Meat and skins on the rack, with your licence standing',
  usage: '!huntinventory',
  cooldown: 5,
  permission: 'all',
  execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'huntinventory', async () => {
    await react('🥩');
    const hu = s(userDoc).hunt;
    const gun = gear(GUNS, hu.gun.id);
    const worth = bagValue(hu.meat, ANIMALS, 2) + bagValue(hu.skins, ANIMALS, 3);
    const best = row(ANIMALS, hu.rarest);

    await reply(
      `🥩 **Hunting rack** — ${kc(worth)} unsold\n\n\u{1F9AA} **Meat**\n${bag(hu.meat, ANIMALS, 2, 5)}\n\n`
      + `\u{1F9B4} **Skins**\n${bag(hu.skins, ANIMALS, 3, 5)}\n\n`
      + `${hu.licensed ? '✅ Licensed' : `❌ No licence — \`!huntstart\` ${kc(HUNT_LICENSE)}`}`
      + `${gun ? ` · **${gun.label}** \`${clamp(hu.gun.dur)}/${gun.dur}\`` : ' · _no gun_'}\n`
      + `Kills ${num(clamp(hu.kills))} · hunting level \`${clamp(hu.level)}\``
      + `${best ? ` · rarest ${best[1]}` : ''}`,
      event.messageID,
    );
  }),
});

commands.push({
  name: 'huntduel',
  aliases: ['duelhunt', 'huntversus'],
  category: 'farming',
  description: '🏹 Duel — 3 hunts each, whoever lands the rarest animal takes the pot',
  usage: '!huntduel @user',
  cooldown: 30,
  permission: 'all',
  execute: async ({ userDoc, reply, react, args, event }) => guard(reply, event.messageID, 'huntduel', async () => {
    await react('🏹');
    const st = s(userDoc);
    const me = st.hunt;

    if (!me.licensed) {
      await reply('🎫 You need a licence and a gun before you can duel anybody. `!huntstart`, then `!huntshop`.', event.messageID);
      return;
    }

    // One duel per thread, keyed on the empty uid. A board keyed on the
    // challenger's uid would be invisible to whoever accepts it, and two boards
    // would let one hunter open a duel and forget about it.
    const open = cache.getPendingGame('huntduel', event.threadID, '');

    // Step 1: open a duel by challenging somebody.
    if (!open) {
      const rival = await target(reply, event.messageID, userDoc, args, event, 'huntduel');
      if (!rival) return;
      const them = s(rival).hunt;
      if (!them.licensed) {
        await reply(`🎫 ${rival.name} has no licence. Rematch when they have one.`, event.messageID);
        return;
      }

      const paid = await fee(userDoc, DUEL_ENTRY, 'hunt:duelentry');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      // putPendingGame, not setPendingGame: challenging somebody while a stale
      // board is still open must not be silently refused.
      cache.putPendingGame('huntduel', event.threadID, '', {
        pot: DUEL_ENTRY,
        hunts: DUEL_HUNTS,
        a: {
          uid: String(userDoc.uid),
          name: userDoc.name,
          tier: rarityOf(ANIMALS, me.rarest),
          label: me.rarest ? row(ANIMALS, me.rarest)[1] : '',
          hits: 0,
        },
        b: {
          uid: String(rival.uid),
          name: rival.name,
          tier: rarityOf(ANIMALS, them.rarest),
          label: them.rarest ? row(ANIMALS, them.rarest)[1] : '',
          hits: 0,
        },
      });

      await reply(
        `🏹 **Duel opened against ${rival.name}.** Entry ${kc(DUEL_ENTRY)} each — pot ${kc(DUEL_ENTRY * 2)}.\n`
        + `Both of you take **${DUEL_HUNTS} hunts** with \`!hunting\`. Rarest animal wins.\n`
        + `_${rival.name} accepts with \`!huntduel @you\`._ Expires in 2 minutes.`,
        event.messageID,
      );
      return;
    }

    // Step 2: accept somebody's challenge.
    if (open.a.uid === String(userDoc.uid)) {
      await reply('🏹 That is your own duel — wait for somebody to accept it.', event.messageID);
      return;
    }
    if (open.b.uid === String(userDoc.uid)) {
      await reply(`🏹 You are already challenged by ${open.a.name}. Take your ${DUEL_HUNTS} hunts with \`!hunting\`.`, event.messageID);
      return;
    }
    if (!me.gun.id || clamp(me.gun.dur) <= 0) {
      await reply(`🔫 You accepted, but you have no working gun. Nothing was charged — \`!huntbuy pistol\` first.`, event.messageID);
      return;
    }

    const paid = await fee(userDoc, DUEL_ENTRY, 'hunt:duelentry');
    if (!paid.ok) {
      await reply(`${paid.reason}\n_The pot is ${kc(DUEL_ENTRY * 2)} and ${open.a.name} is waiting._`, event.messageID);
      return;
    }

    open.b.uid = String(userDoc.uid);
    open.b.name = userDoc.name;
    open.b.tier = rarityOf(ANIMALS, me.rarest);
    open.b.label = me.rarest ? row(ANIMALS, me.rarest)[1] : '';
    open.b.hits = 0;
    cache.putPendingGame('huntduel', event.threadID, '', open);

    await reply(
      `🏹 **Duel accepted.** ${open.a.name} vs ${userDoc.name} — pot ${kc(DUEL_ENTRY * 2)}.\n`
      + `${open.a.name}'s best: ${open.a.label || '_nothing yet_'}\n`
      + `Yours: ${open.b.label || '_nothing yet_'}\n\n`
      + `_Take ${DUEL_HUNTS} hunts each with \`!hunting\`._`,
      event.messageID,
    );
  }),
});

/**
 * Count a hunt toward this hunter's open duel and settle it once both sides
 * have taken their three.
 *
 * Same lazy settlement as the fishing tournament: the shot on the deadline
 * finishes the duel, rather than a background timer nobody owns.
 *
 * @returns {Promise<string|null>} a line to append to the hunt reply, or null
 */
async function duelCatch(userDoc, event, animal) {
  if (!event.isGroup) return null;
  const duel = cache.getPendingGame('huntduel', event.threadID, '');
  if (!duel) return null;

  const key = String(userDoc.uid);
  const mine = duel.a.uid === key ? duel.a : duel.b.uid === key ? duel.b : null;
  if (!mine) return null;
  const other = mine === duel.a ? duel.b : duel.a;
  const tier = rarityOf(ANIMALS, animal[0]);

  mine.hits += 1;
  if (tier > mine.tier) {
    mine.tier = tier;
    mine.label = animal[1];
  }

  if (mine.hits < DUEL_HUNTS || other.hits < DUEL_HUNTS) {
    cache.putPendingGame('huntduel', event.threadID, '', duel);
    return `🏹 _Duel: you ${mine.hits}/${DUEL_HUNTS}, ${other.name} ${other.hits}/${DUEL_HUNTS}. Best so far: ${mine.label || '—'}._`;
  }

  cache.takePendingGame('huntduel', event.threadID, '');
  const pot = clamp(duel.pot) * 2;

  if (mine.tier === other.tier) {
    // A tie refunds rather than picking a winner by coin flip: this is a flex
    // contest, and settling it arbitrarily leaves both players cheated.
    const half = Math.floor(pot / 2);
    await give(userDoc, half, 'hunt:duelrefund', { reason: 'draw' });
    const otherDoc = await payoutFor(other.uid);
    if (otherDoc) await give(otherDoc, pot - half, 'hunt:duelrefund', { reason: 'draw' });
    return `\u{1F3C6} **Duel drawn** — you and ${other.name} matched at **${mine.label}**. Both refunded.`;
  }

  const iWon = mine.tier > other.tier;
  const won = iWon ? mine : other;
  const loser = iWon ? other : mine;
  const winnerDoc = await payoutFor(won.uid);
  if (!winnerDoc) return '\u{1F3C6} _The winner left before the pot could be paid._';
  await give(winnerDoc, pot, 'hunt:duelwin', { label: won.label });

  return iWon
    ? `\u{1F3C6} **You win ${kc(pot)}** for the **${won.label}** — beating ${other.name}'s ${loser.label}.`
    : `\u{1F3C6} ${other.name} wins ${kc(pot)} for the **${won.label}**. Your best was ${loser.label}.`;
}

module.exports = commands;