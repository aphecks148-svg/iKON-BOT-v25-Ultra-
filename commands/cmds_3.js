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
 * execute receives: { api, event, args, config, registry, ai, reply, react, userDoc }
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
const cards = require('../bot/cards');
const cache = require('../bot/cache');
const realProfile = require('../bot/profile');
const userTarget = require('../bot/target');
const Group = require('../models/Group');
const dex = require('../bot/pokemon');
const pokemonSpawn = require('../bot/pokemonSpawn');
const toggles = require('../bot/toggles');

const CASH = 'K-Cash';

// ───────────────────────────────────────────────────────────
// XP CURVE — level N needs N * 100 XP, so level 10 wants 1000
// ───────────────────────────────────────────────────────────
const xpNeeded = (level) => Math.max(1, level) * 100;

/**
 * XP still owed for the next level.
 *
 * The remaining amount, never the whole bar. `!xp` used to print the full
 * `xpNeeded(level)` as "need to rank up", so a hunter halfway to level 5 was
 * told they needed the entire level again — double what was left, and the one
 * number on the card that is actionable.
 */
const xpToNext = (level, xp) => Math.max(0, xpNeeded(level) - clamp(xp));

/**
 * Every XP point this hunter has earned, ever.
 *
 * Spending XP on levels destroys it, so "banked XP" alone goes *down* on a level
 * up: a hunter at level 5 holding 200 XP looks like a beginner next to someone
 * at level 4 holding 350, and `!topxp` duly ranked the beginner first. Lifetime
 * is what the leaderboard and the card both mean by "how much XP".
 *
 * The curve is `xpNeeded(L) = L * 100`, so the points already spent reaching
 * `level` are the sum of 100+200+…+100*(level-1), which is `50 * L * (L-1)`.
 * The old figure was `xpNeeded(level) * (level - 1)` — a rectangle where the
 * curve is a triangle — so every hunter past level 1 was credited with roughly
 * twice the XP they had actually earned.
 *
 * @param {{level?:number,xp?:number}} userDoc
 * @returns {number}
 */
function lifetimeXp(userDoc) {
  const level = Math.max(1, Number(userDoc && userDoc.level) || 1);
  return Math.round(50 * level * (level - 1) + clamp(userDoc && userDoc.xp));
}

/**
 * The academy rank for a level: the highest title the ladder has handed out.
 *
 * TITLES is the rank ladder and `grantXp` awards its entries as levels are
 * crossed, so "what rank is this hunter" and "what is the next title" are both
 * questions about this one ascending list, asked from opposite ends.
 *
 * @param {{level?:number}} userDoc
 * @returns {{level:number,title:string}} the rung reached, or Rookie at level 1
 */
function academyRank(userDoc) {
  const level = Math.max(1, Number(userDoc && userDoc.level) || 1);
  let reached = { level: 1, title: 'Rookie' };
  for (const t of TITLES) {
    if (level >= t.level) reached = t;
    else break;
  }
  return reached;
}

/**
 * A progress bar for a percentage.
 *
 * Twenty cells, matching the one `!level` drew. The glyphs are data and are the
 * only heavy characters allowed in a reply.
 *
 * @param {number} pct 0-100
 * @param {number} [cells]
 * @returns {string}
 */
function progressBar(pct, cells = 20) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round((p / 100) * cells);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, cells - filled))}`;
}

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
// MONSTERS — level 1 slimes all the way up to level 55 dragons
// ───────────────────────────────────────────────────────────
const MONSTERS = [
  // Twenty, by level. Ordered low to high, because the boss fallback picks the
  // hardest thing in here — an unsorted list would send a level 3 hunter to
  // fight the iKON Dragon.
  { name: 'Street Slime', emoji: '🟢', level: 1, coin: [200, 400] },
  { name: 'Pigeon Golem', emoji: '🐦', level: 2, coin: [240, 480] },
  { name: 'Sewer Rat King', emoji: '🐀', level: 4, coin: [300, 600] },
  { name: 'Dumpster Bear', emoji: '🐻', level: 6, coin: [360, 720] },
  { name: 'Factory Wraith', emoji: '👻', level: 8, coin: [440, 880] },
  { name: 'Forklift Golem', emoji: '🚜', level: 10, coin: [520, 1040] },
  { name: 'Vault Warden', emoji: '🗝️', level: 12, coin: [620, 1240] },
  { name: 'Tarmac Basilisk', emoji: '🦈', level: 14, coin: [700, 1400] },
  { name: 'Neon Hydra', emoji: '🐍', level: 17, coin: [820, 1640] },
  { name: 'Casino Baron', emoji: '🎩', level: 20, coin: [940, 1880] },
  { name: 'Klerk Colossus', emoji: '🗿', level: 23, coin: [1060, 2120] },
  { name: 'Freighter Chimera', emoji: '🦩', level: 26, coin: [1180, 2360] },
  { name: 'Interest Golem', emoji: '💸', level: 29, coin: [1300, 2600] },
  { name: 'Skyline Behemoth', emoji: '🌍', level: 32, coin: [1420, 2840] },
  { name: 'Klerk Ascendant', emoji: '🗿', level: 35, coin: [1560, 3120] },
  { name: 'Blacksite Leviathan', emoji: '🐏', level: 38, coin: [1700, 3400] },
  { name: 'Debt Reaper', emoji: '🔫', level: 42, coin: [1850, 3700] },
  { name: 'Neon Sovereign', emoji: '👑', level: 46, coin: [2000, 4000] },
  { name: 'iKON Wyrm', emoji: '🐉', level: 50, coin: [2600, 5200] },
  { name: 'iKON Dragon', emoji: '🐉', level: 55, coin: [3400, 6800] },
];

// ───────────────────────────────────────────────────────────
// TITLES — unlocked automatically at level milestones
// ───────────────────────────────────────────────────────────
const TITLES = [
  // Twenty milestones, ascending. Level unlocks these automatically in grantXp,
  // and `!titles` draws them in this order, so a new rung goes at the bottom.
  { level: 2, title: 'New Face' },
  { level: 3, title: 'Busker' },
  { level: 5, title: 'Slayer' },
  { level: 7, title: 'Errand Runner' },
  { level: 10, title: 'Veteran' },
  { level: 13, title: 'Fixer' },
  { level: 16, title: 'Operator' },
  { level: 20, title: 'Champion' },
  { level: 24, title: 'Enforcer' },
  { level: 28, title: 'Kingpin' },
  { level: 32, title: 'Shadow Broker' },
  { level: 36, title: 'Cartel Elder' },
  { level: 40, title: 'Warlord' },
  { level: 44, title: 'Red Hand' },
  { level: 48, title: 'Leviathan' },
  { level: 55, title: 'Legend' },
  { level: 62, title: 'Sovereign' },
  { level: 70, title: 'Immortal' },
  { level: 80, title: 'Deity' },
  { level: 100, title: 'God' },
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

/** Resolve a tag, a typed name, or a bare id to a User document.
 *
 * The thread knows who is actually in this chat and what they are really
 * called, which is why this lives in bot/target.js: it is the only place that
 * can turn "@Alice" into a uid. See that file for the whole order of attempts.
 */
async function resolveTarget(ref, event, api) {
  return userTarget.userDoc(ref, event, api);
}

/** Resolve a target or explain how to tag someone. */
async function targetOr(reply, messageID, ref, event, label, api) {
  if (!ref) {
    await reply(`❌ Usage: \`!${label} <user>\` — tag a hunter or use their ID.`, messageID);
    return null;
  }
  const target = await resolveTarget(ref, event, api);
  if (!target) {
    await reply(`❌ No hunter found for \`${ref}\`.`, messageID);
    return null;
  }
  return target;
}

/**
 * The name to print on somebody's own card.
 *
 * getUserInfo first, because it is the only thing that knows what this person is
 * actually called today. Whatever it returns is checked against the placeholder
 * list, because ws3-fca answers "Facebook User" when it cannot resolve a profile
 * — and an honest short id beats a fake name on your own ID card.
 *
 * Never throws and never returns empty: a failed lookup falls back to the stored
 * name, then to a short id. There is no branch in here that can produce nothing,
 * which is what makes "could not load" unnecessary rather than merely unlikely.
 *
 * @param {object} userDoc the profile the engine already resolved
 * @param {string} uid whose name to look up
 * @param {object} api ws3-fca client
 * @returns {Promise<string>}
 */
async function realNameOf(userDoc, uid, api) {
  const fallback = (userDoc && userDoc.name && !realProfile.isPlaceholderName(userDoc.name))
    ? userDoc.name
    : `Hunter ${String((userDoc && userDoc.uid) || uid || '').slice(-4)}`;

  try {
    if (!api || typeof api.getUserInfo !== 'function') return fallback;
    const info = await api.getUserInfo(uid || (userDoc && userDoc.uid));
    const live = info && (info.name || info.firstName);
    if (!live || realProfile.isPlaceholderName(live)) return fallback;
    return String(live).trim();
  } catch {
    return fallback; // Facebook is having a moment; the card still prints
  }
}

/** Standard "you levelled up" tail shared by XP commands. */
async function xpTail(userDoc, gained, levels, newTitles) {
  const lines = [`✨ +${num(gained)} XP (${num(userDoc.xp)}/${num(xpNeeded(userDoc.level || 1))} to Lv ${(userDoc.level || 1) + 1})`];
  if (levels > 0) lines.push(`🎉 **LEVEL UP!** Now Level ${userDoc.level}`);
  newTitles.forEach((t) => lines.push(`🏷️ Title unlocked: **${t}**`));
  return lines;
}

// ───────────────────────────────────────────────────────────
// WILD POKEMON — helpers
// ───────────────────────────────────────────────────────────

/**
 * This chat's Group document, or null.
 *
 * Pokemon are a group feature, so there is nothing to do in a DM and the
 * commands say so rather than silently doing nothing.
 */
async function pokeGroup(event) {
  if (!mongo.isReady() || !event || !event.isGroup || !event.threadID) return null;
  const group = await Group.findOne({ tid: String(event.threadID) }).catch(() => null);
  if (group && !group.pokemon) {
    // Backfilled with the same defaults the schema states, not with `{}`. A
    // document written before wild Pokemon existed read as OFF here while the
    // scheduler read it as ON, so `!pokemon` reported a setting that had never
    // been turned down and sent the admin off to fix the wrong thing.
    group.pokemon = {
      enabled: true,
      intervalMs: dex.DEFAULT_INTERVAL_MS,
      lastSpawnAt: null,
      lastAttemptAt: null,
      current: {
        id: 0, messageID: '', spawnedAt: null, expiresAt: null, caughtBy: '',
      },
    };
  }
  return group;
}

/** Persist a group document, tolerating an in-memory one (DB offline). */
async function pokeSave(group) {
  if (!group || group.transient) return;
  try {
    await group.save();
  } catch { /* the reply below still tells the operator what happened */ }
}

/** "on" / "off" / null — null when the argument is neither. */
function onOff(args) {
  const raw = String((args && args[0]) || '').toLowerCase().trim();
  if (raw === 'on' || raw === 'enable' || raw === 'start') return true;
  if (raw === 'off' || raw === 'disable' || raw === 'stop') return false;
  return null;
}

const yesNo = (b) => (b ? 'ON' : 'OFF');

/** What is on the table right now, as one line. */
function currentLine(group) {
  const cur = group.pokemon && group.pokemon.current;
  if (!cur || !cur.messageID) return 'Nothing is out there right now.';
  const p = dex.byId(cur.id);
  if (!p) return 'Something is out there. Its name will not load.';
  if (cur.caughtBy) return `${p.name} was caught. Waiting for the next one.`;
  if (cur.expiresAt && new Date(cur.expiresAt).getTime() < Date.now()) return `${p.name} got away. A new one is due soon.`;
  const left = Math.max(0, new Date(cur.expiresAt || Date.now()).getTime() - Date.now());
  return `**${p.name}** is out there — ${Math.ceil(left / 60000)} min left to reply with its name.`;
}

/**
 * "in 12m" / "3m ago" / "never".
 *
 * A clock time for the next spawn is less useful than how far away it is, and
 * "never" has to be said rather than rendered as 1970.
 */
function ago(date) {
  if (!date || !(date instanceof Date) || Number.isNaN(date.getTime()) || date.getTime() <= 0) return 'never';
  const delta = Math.round((Date.now() - date.getTime()) / 1000);
  return delta >= 0 ? `${fmt.dur(delta)} ago` : `in ${fmt.dur(-delta)}`;
}

module.exports = [
  // ─────────────────────────────────────────────────────────
  // 1
  // ─────────────────────────────────────────────────────────
  {
    name: 'profile',
    // `!level` and `!xp` were two more cards showing two of the four numbers
    // already on this one, each answering "how far to the next level" with a
    // different and sometimes wrong figure. They are aliases here so one card is
    // the answer and there is nothing left to disagree with itself.
    // `!rank` stays separate: that is the server's hall of fame, not a stat
    // about the person asking.
    aliases: ['prof', 'level', 'xp'],
    category: 'rpg',
    description: '🧬 Your hunter ID card - Level, XP, rank in iKON Academy',
    usage: '!profile',
    hint: 'Your hunter card: rank, level bar, XP banked and lifetime. Also answers to `!level` and `!xp`.',
    cooldown: 10,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event, api }) => guard(reply, event.messageID, 'profile', async () => {
      await react('🧬');

      // The engine handed us a profile already — cache.getOrCreateUser creates
      // one for a first-time user and falls back to memory when Mongo is down,
      // so there is no longer a "could not load" path to guard. All that is left
      // is to make the name as real as Facebook can make it.
      const name = await realNameOf(userDoc, event.senderID, api);
      userDoc.name = name;

      const data = rpg(userDoc);
      refreshStamina(userDoc);
      const cls = CLASSES[data.className];
      const titles = data.titles.length ? data.titles.join(', ') : 'None yet';

      // Level, rank and XP, computed once and printed the same way on both
      // paths below. Every figure on this card comes from here, so the canvas
      // and the text fallback cannot drift apart.
      const level = Math.max(1, Number(userDoc.level) || 1);
      const needed = xpNeeded(level);
      const xp = clamp(userDoc.xp);
      const remaining = xpToNext(level, xp);
      const pct = Math.min(100, Math.floor((xp / needed) * 100));
      const lifetime = lifetimeXp(userDoc);
      const rank = academyRank(userDoc);
      const nextTitle = TITLES.find((t) => t.level > level);

      // Real name and real Facebook photo, drawn on canvas. Falls back to the
      // text card when the native binary is missing, so the command always
      // answers something.
      const card = await cards.userCard({
        emoji: '🧬',
        title: 'iKON ACADEMY ID CARD',
        subtitle: `${rank.title} · Level ${level}`,
        user: userDoc,
        api,
        rows: [
          ['Name', name],
          ['Rank', `${rank.title} (${num(rank.level)})`],
          ['Level', `${level} · ${pct}%`],
          ['XP', `${num(xp)}/${num(needed)}`],
          ['Lifetime XP', `${num(lifetime)} XP`],
          ['To level up', `${num(remaining)} XP`],
          ['Money', kc(userDoc.coins)],
          ['Starting allowance', kc(userDoc.money ?? cache.STARTING_MONEY)],
          ['Class', cls ? `${cls.emoji} ${cls.name}` : 'Unchosen'],
          ['Titles', titles],
          ['Stamina', `${data.stamina}/${hasSkill(userDoc, 'swiftfoot') ? 11 : 10}`],
          ['Prestige', `${clamp(userDoc.prestige)} (+${Math.round((prestigeBonus(userDoc) - 1) * 100)}% income)`],
        ],
      });

      if (card) {
        await reply({
          body: `🧬 **${name}**\n${rank.title} · Level ${level} · ${num(xp)}/${num(needed)} XP`,
          attachment: { type: 'image', data: { url: card } },
        }, event.messageID);
        return;
      }

      await reply(
        `🧬 **iKON ACADEMY ID CARD**\n`
        + '· · · · · · ·\n'
        + `👤 ${name}\n`
        + `🏅 Rank: ${rank.title} (${num(rank.level)})\n`
        + `📊 Level ${level} · ${progressBar(pct)} ${pct}%\n`
        + `✨ XP: ${num(xp)}/${num(needed)} banked\n`
        + `📈 Lifetime XP: ${num(lifetime)}\n`
        + `🎯 ${num(remaining)} XP to Level ${level + 1}\n`
        + (nextTitle ? `🏷️ Next title: ${nextTitle.title} at Lv ${nextTitle.level}\n` : '👑 You have every title.\n')
        + `💰 Money: ${kc(userDoc.coins)}\n`
        + `🌱 Starting allowance: ${kc(userDoc.money ?? cache.STARTING_MONEY)}\n`
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
    name: 'rank',
    // `!leaderboardrpg`, `!rlb` and `!toprpg` were a second copy of this same
    // board: same sort, same board card, same medals, differing only in a
    // level filter and one icon. They are aliases here so neither spelling
    // ever answers "Unknown command" again.
    aliases: ['leaderboardrpg', 'rlb', 'toprpg'],
    category: 'rpg',
    description: '🏅 Server rank by level - Who is the strongest hunter?',
    usage: '!rank',
    hint: 'The full hall of fame. Also answers to `!leaderboardrpg` and `!rlb`.',
    cooldown: 15,
    permission: 'all',
    execute: async ({ reply, react, event, api }) => guard(reply, event.messageID, 'rank', async () => {
      await react('🏅');
      if (!mongo.isReady()) {
        await reply('💾 Academy records are sealed — database offline.', event.messageID);
        return;
      }
      const board = await User.find({}).sort({ level: -1, xp: -1 }).limit(10).select('uid name level xp prestige').lean();
      if (!board.length) {
        await reply('🏅 No hunters enrolled yet. Enroll by talking.', event.messageID);
        return;
      }
      const medals = ['🥇', '🥈', '🥉'];

      // Real photos and real Facebook names on a canvas board, with the text
      // list kept as the fallback for platforms without the canvas binary.
      const card = await cards.boardCard({
        emoji: '🏅',
        title: 'iKON ACADEMY RANK',
        subtitle: 'Strongest hunters on the server',
        rows: board,
        api,
        value: (u) => `Lv ${u.level || 1} · ${num(u.xp)} XP${u.prestige ? ` 👑${u.prestige}` : ''}`,
        detail: (u) => `${num(xpToNext(u.level || 1, u.xp))} XP to the next level`,
      });
      if (card) {
        await reply({
          body: `🏅 **iKON ACADEMY RANK**\n${board.length} hunters enrolled.`,
          attachment: { type: 'image', data: { url: card } },
        }, event.messageID);
        return;
      }

      // Facebook is asked for the name; a stored "Facebook User" is not a name,
      // and a board of ten of them still looks like a ranking.
      const names = await Promise.all(board.map((u) => cards.realName(u, api)));
      const lines = board.map((u, i) => {
        const crown = u.prestige ? ` 👑x${u.prestige}` : '';
        return `${medals[i] || `${i + 1}.`} ${names[i]} — Lv ${u.level || 1}${crown} (${num(u.xp)} XP)`;
      });

      await reply(
        `🏅 **iKON ACADEMY RANK**\n`
        + '· · · · · · ·\n'
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
          + `📊 You are Level ${level} — ${num(xpToNext(level, userDoc.xp))} XP short.\n`
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
        + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
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
          + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
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
    hint: 'Equipping a sword and shield raises your battle win rate. Unequipped gear does nothing.',
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
          + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
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
    hint: 'Winner takes 1,000. Both sides are wagering, so tag someone who can actually afford it.',
    cooldown: 300,
    permission: 'all',
    execute: async ({ api, args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'duel', async () => {
      await react('🤺');
      const data = rpg(userDoc);
      const target = await targetOr(reply, event.messageID, args[0], event, 'duel', api);
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
          + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
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
    hint: 'Identical to `!duel`, different arena. Pick one and use it — there is no advantage to switching.',
    cooldown: 300,
    permission: 'all',
    execute: async ({ api, args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'pvp', async () => {
      await react('⚔️');
      const data = rpg(userDoc);
      const target = await targetOr(reply, event.messageID, args[0], event, 'pvp', api);
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
          + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
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
          + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
        + '▰'.repeat(data.stamina) + '▱'.repeat(Math.max(0, cap - data.stamina)) + '\n'
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
          + `🎯 ${num(xpToNext(level, userDoc.xp))} XP to go.\n`
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
        + '· · · · · · ·\n'
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
    execute: async ({ reply, react, event, api }) => guard(reply, event.messageID, 'topwins', async () => {
      await react('🥇');
      if (!mongo.isReady()) {
        await reply('💾 Academy records are sealed — database offline.', event.messageID);
        return;
      }
      const board = await User.find({ 'rpg.stats.wins': { $gt: 0 } })
        .sort({ 'rpg.stats.wins': -1 })
        .limit(10)
        .select('uid name level rpg.stats.wins rpg.stats.battles')
        .lean();
      if (!board.length) {
        await reply('🥇 Nobody has won a fight yet. Try `!battle`.', event.messageID);
        return;
      }
      const winsOf = (u) => (u.rpg && u.rpg.stats && u.rpg.stats.wins) || 0;

      const card = await cards.boardCard({
        emoji: '🥇',
        title: 'MOST WINS',
        subtitle: 'Undefeated in the arena',
        rows: board,
        api,
        value: (u) => `${num(winsOf(u))} wins · Lv ${u.level || 1}`,
        detail: (u) => `${num(winsOf(u) ? (u.rpg && u.rpg.stats && u.rpg.stats.losses) || 0 : 0)} losses`,
      });
      if (card) {
        await reply({
          body: `🥇 **MOST WINS**\nThe academy is watching.`,
          attachment: { type: 'image', data: { url: card } },
        }, event.messageID);
        return;
      }

      const medals = ['🥇', '🥈', '🥉'];
      const names = await Promise.all(board.map((u) => cards.realName(u, api)));
      const lines = board.map((u, i) => `${medals[i] || `${i + 1}.`} ${names[i]} — ${num(winsOf(u))} wins (Lv ${u.level || 1})`);

      await reply(
        `🥇 **MOST WINS**\n`
        + '· · · · · · ·\n'
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
    execute: async ({ reply, react, event, api }) => guard(reply, event.messageID, 'topxp', async () => {
      await react('🌟');
      if (!mongo.isReady()) {
        await reply('💾 Academy records are sealed — database offline.', event.messageID);
        return;
      }
// uid is projected so the card can fetch each hunter's real photo.
      //
      // Lifetime XP, not banked XP. Spending XP on a level destroys it, so
      // banked XP *falls* when a hunter levels up: this board used to sort on
      // `level * 0 + xp`, which is xp and nothing else, and put the hunter with
      // the most grinding last. 50 * L * (L-1) is the sum of the curve
      // xpNeeded(1..L-1) = 100, 200, … 100*(L-1) — the same figure `!profile`
      // prints, computed here in the database so the board can be sorted on it.
      const board = await User.aggregate([
        { $match: { $or: [{ xp: { $gt: 0 } }, { level: { $gt: 1 } }] } },
        {
          $addFields: {
            lifetimeXp: {
              $add: [
                { $multiply: [{ $ifNull: ['$level', 1] }, { $subtract: [{ $ifNull: ['$level', 1] }, 1] }, 50] },
                { $ifNull: ['$xp', 0] },
              ],
            },
          },
        },
        { $sort: { lifetimeXp: -1, xp: -1 } },
        { $limit: 10 },
        { $project: { uid: 1, name: 1, level: 1, xp: 1, lifetimeXp: 1, _id: 0 } },
      ]);
      if (!board.length) {
        await reply('🌟 Nobody has ground XP yet. Try `!train`.', event.messageID);
        return;
      }

      const card = await cards.boardCard({
        emoji: '🌟',
        title: 'TOP XP GRINDERS',
        subtitle: 'Hardest working hunters on the server',
        rows: board,
        api,
        value: (u) => `Lv ${u.level || 1} · ${num(u.lifetimeXp)} XP`,
        detail: (u) => `${num(u.xp)} XP in the bank`,
      });
      if (card) {
        await reply({
          body: `🌟 **TOP XP GRINDERS**\nThe grind does not lie.`,
          attachment: { type: 'image', data: { url: card } },
        }, event.messageID);
        return;
      }

      const medals = ['🥇', '🥈', '🥉'];
      const names = await Promise.all(board.map((u) => cards.realName(u, api)));
      const lines = board.map((u, i) => (
        `${medals[i] || `${i + 1}.`} ${names[i]} — Lv ${u.level || 1}, ${num(u.lifetimeXp)} XP`
      ));

      await reply(
        `🌟 **TOP XP GRINDERS**\n`
        + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
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
        + '· · · · · · ·\n'
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
// ─────────────────────────────────────────────────────────
  // 35 · POKEMON — the wild ones
  // ─────────────────────────────────────────────────────────
  {
    name: 'pokemon',
    aliases: ['pokebot', 'pokespawn'],
    category: 'rpg',
    description: '🌿 Admin control for wild Pokemon spawns in this chat',
    usage: '!pokemon on | off | spawn',
    hint: 'One Pokemon every 15 minutes. Catch it by replying to its message with its name.',
    cooldown: 5,
    permission: 'groupAdmin',
    execute: async ({ api, args, event, reply, react }) => guard(reply, event.messageID, 'pokemon', async () => {
      if (!event.isGroup) {
        await reply('❌ Pokemon only spawn in group chats.', event.messageID);
        return;
      }
      const group = await pokeGroup(event);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }

      // No argument, or on/off: report and toggle.
      const want = onOff(args);
      if (want !== null) {
        if (group.pokemon.enabled === want) {
          await reply(
            `ℹ️ Pokemon are already ${yesNo(want)} here.
${currentLine(group)}`,
            event.messageID,
          );
          return;
        }
        group.pokemon.enabled = want;
        if (!want) {
          // Switching off clears the live spawn. Leaving it would let somebody
          // catch one that the admin had just turned off.
          group.pokemon.current = { id: 0, messageID: '', spawnedAt: null, expiresAt: null, caughtBy: '' };
        } else {
          // Turning on: start the clock now rather than waiting a full interval
          // from whenever this group was last seen, which could be days ago.
          group.pokemon.lastSpawnAt = new Date();
        }
        await pokeSave(group);
        await react(want ? '🌿' : '🚫');
        await reply(
          want
            ? `🌿 **POKEMON ARE ON.**
One every 15 minutes. Reply to its message with its name to catch it.
First spawn due in ${Math.round((Number(group.pokemon.intervalMs) || dex.DEFAULT_INTERVAL_MS) / 60000)} minutes.`
            : '🚫 Pokemon are off in this chat. Nothing will spawn.',
          event.messageID,
        );
        return;
      }

      // "spawn" posts one immediately, which is how an admin checks the setting
      // works without waiting a quarter of an hour.
      if (String(args[0] || '').toLowerCase() === 'spawn') {
        if (!group.pokemon.enabled) {
          await reply('❌ Pokemon are off here. Turn them on with `!pokemon on` first.', event.messageID);
          return;
        }
        if (pokemonSpawn.hasLiveSpawn(group)) {
          await reply(`ℹ️ ${currentLine(group)}`, event.messageID);
          return;
        }
        const p = await pokemonSpawn.spawnNow(api, group);
        if (!p) {
          await reply('❌ Could not post a spawn. Check the logs.', event.messageID);
          return;
        }
        await reply(`🌿 Posted a **${p.name}** on request.`, event.messageID);
        return;
      }

      // Bare !pokemon: status.
      const interval = Number(group.pokemon.intervalMs) || dex.DEFAULT_INTERVAL_MS;
      const last = group.pokemon.lastSpawnAt ? new Date(group.pokemon.lastSpawnAt) : null;
      // `dex.nextDue` reads the same two stamps the scheduler reads and clamps a
      // past date forward. Computing it here as `last + interval` is what made a
      // chat whose last spawn was a day ago print "next due: 1d 8h ago" — a
      // countdown to a moment already gone, on the line directly under "last
      // spawn: 1d 8h ago".
      const due = dex.nextDue(group.pokemon);
      // A group that has never spawned is due on the next tick, not in fifteen
      // minutes — saying otherwise here is how an admin talks themselves into
      // thinking the scheduler is asleep.
      const dueIn = !group.pokemon.enabled
        ? 'while they are off'
        : !due.dueAt ? 'any minute now' : ago(due.dueAt);
      // Behind by more than a second is not rounding, and saying so is more
      // useful than a countdown that implies the schedule was kept.
      const behind = due.overdueMs > 1000 ? `\n⚠️ Overdue by ${fmt.dur(due.overdueMs / 1000)} — the next tick posts it.` : '';
      await react('🌿');
      await reply(
        `🌿 **POKEMON IN THIS CHAT: ${yesNo(!!group.pokemon.enabled)}**\n`
        + '· · · · · · ·\n'
        + `⏱️ One every ${Math.round(interval / 60000)} minutes\n`
        + `🕐 Last spawn: ${ago(last)}\n`
        + `⏭️ Next due: ${dueIn}${behind}\n`
        + `🎯 ${currentLine(group)}\n`
        + '· · · · · · ·\n'
        + 'Turn it on or off with `!pokemon on` / `!pokemon off`.'
        + `${!group.pokemon.enabled || pokemonSpawn.mayPost(group) ? '' : '\n⚠️ The scheduler will not post here anyway: ' + toggles.evaluateGroup(group, pokemonSpawn.SWITCH.cmdName, pokemonSpawn.SWITCH.category).reason}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 36 · POKEMON DEX
  // ─────────────────────────────────────────────────────────
  {
    name: 'pokedex',
    aliases: ['dex'],
    category: 'rpg',
    description: '📖 Your Pokemon collection — who you have caught',
    usage: '!pokedex [rarity]',
    hint: 'Caught Pokemon are kept here. They are a collection, not pets — nothing can attack them.',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'pokedex', async () => {
      await react('📖');
      const owned = Array.isArray(userDoc.dex) ? userDoc.dex : [];
      const total = dex.POKEMON.length;
      const want = String(args[0] || '').toLowerCase().trim();

      if (want && !dex.TIER_BY_KEY.has(want)) {
        await reply(
          `❓ No rarity called \`${want}\`. Try: ${dex.TIERS.map((t) => `\`${t.key}\``).join(', ')}`,
          event.messageID,
        );
        return;
      }

      const rows = want
        ? dex.POKEMON.filter((p) => p.rarity === want)
        : dex.POKEMON;

      const lines = [];
      for (const p of rows) {
        const got = owned.includes(p.id);
        lines.push(got ? `${dex.tier(p).symbol} **${p.name}** · ${dex.typeLabel(p)}` : `${dex.tier(p).symbol} \`#${String(p.id).padStart(3, '0')}\` — not caught`);
      }

      // dex.tier() expects a Pokemon and reads its `rarity`. Here we already
      // hold the tier itself, so read its symbol directly — going through
      // dex.tier() returns the bottom rung for a key it cannot find, which
      // labelled every legendary section as Common.
      const tier = want ? dex.TIER_BY_KEY.get(want) : null;
      const header = tier
        ? `${tier.symbol} **${tier.label.toUpperCase()}** — ${rows.filter((p) => owned.includes(p.id)).length}/${rows.length}`
        : `📖 **YOUR POKEDEX — ${owned.length}/${total}**`;

      await reply(
        `${header}\n`
        + '· · · · · · ·\n'
        + `${lines.join('\n')}\n`
        + '· · · · · · ·\n'
        + `🎯 ${num(userDoc.pokemonCaught || 0)} caught in total${owned.length < total ? ` · ${total - owned.length} still out there` : ' · **COMPLETE**'}`,
        event.messageID,
      );
    }),
  },
];
