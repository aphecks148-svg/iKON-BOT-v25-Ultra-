'use strict';

/**
 * MODULE 4 — DANGEROUS PETS (35 commands)
 *
 * iKON-BOT v2 Ultra. Pets in iKON City are not decoration, they are assets.
 * Fifteen species of them are genuinely dangerous, they evolve through
 * evolution stones, and an UNSAFE pet can be attacked by anybody who replies
 * `!petfight` to one of its owner's messages.
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

const Pet = require('../models/Pet');
const User = require('../models/User');
const Economy = require('../models/Economy');
const Inventory = require('../models/Inventory');
const Group = require('../models/Group');
const cache = require('../bot/cache');
const mongo = require('../bot/mongo');
const { fmt } = require('../bot/helpers');

const CASH = 'K-Cash';
const ULTRA = 'iKON-BOT v2 Ultra';

// ───────────────────────────────────────────────────────────
// THE 15 DANGEROUS PETS — expensive, rare, powerful
// ───────────────────────────────────────────────────────────
const DANGEROUS_PETS = [
  { id: 'voidreaver', name: 'Voidreaver', emoji: '🕳️', price: 50000, power: 500, lore: 'Devours souls mid-sentence. Owners report tinnitus.' },
  { id: 'bloodfang', name: 'Bloodfang Alpha', emoji: '🐺', price: 75000, power: 650, lore: 'The werewolf king. Pays for his dinner in wolf.' },
  { id: 'necrotitan', name: 'NecroTitan', emoji: '💀', price: 100000, power: 800, lore: 'Undead titan. Does not require dental.' },
  { id: 'infernal', name: 'Infernal Wyrm', emoji: '🐉', price: 120000, power: 900, lore: 'Lava dragon. Warms a room to 200 degrees.' },
  { id: 'kraken', name: 'Abyssal Kraken', emoji: '🐙', price: 150000, power: 1000, lore: 'Sea terror. Files complaints from the Mariana Trench.' },
  { id: 'shadowlord', name: 'Shadowlord', emoji: '🌑', price: 200000, power: 1200, lore: 'Controls shadows. You will not see it coming.' },
  { id: 'doomhowl', name: 'Doomhowl', emoji: '🐺', price: 180000, power: 1100, lore: 'Its scream kills. Bring ear protection.' },
  { id: 'soulripper', name: 'Soulripper', emoji: '👻', price: 250000, power: 1300, lore: 'Rips XP straight out of the air.' },
  { id: 'obsidian', name: 'Obsidian Golem', emoji: '🗿', price: 130000, power: 950, lore: 'Unbreakable. Loosely tested with a hammer.' },
  { id: 'thunder', name: 'Thunder Serpent', emoji: '🐍', price: 160000, power: 1050, lore: 'Lightning god in serpent form. Trips the vault alarms.' },
  { id: 'frost', name: 'Frost Leviathan', emoji: '❄️', price: 170000, power: 1080, lore: 'Freezes the group chat gc at 3am.' },
  { id: 'venom', name: 'Venom Queen', emoji: '🕷️', price: 190000, power: 1150, lore: 'Poison empire. Very punctual.' },
  { id: 'chaos', name: 'Chaos Behemoth', emoji: '🌀', price: 300000, power: 1500, lore: 'Pure chaos, unlabelled.' },
  { id: 'nightmare', name: 'Nightmare Hydra', emoji: '🐲', price: 280000, power: 1400, lore: 'Five heads. Five bad decisions.' },
  { id: 'titanprime', name: 'iKON Titan Prime', emoji: '👑', price: 500000, power: 2000, lore: 'FINAL BOSS. Only ONE exists per bot. Owner Aphecks refuses to say where it came from.' },
];

const PET_BY_ID = new Map(DANGEROUS_PETS.map((p) => [p.id, p]));

// ───────────────────────────────────────────────────────────
// EVOLUTION LADDER — level requirement + the stone it eats
// ───────────────────────────────────────────────────────────
const EVOLUTIONS = [
  { level: 15, stone: 'fire', title: 'Kindled', blurb: 'Your pet catches fire and stops being a normal pet.' },
  { level: 30, stone: 'inferno', title: 'Infernal', blurb: 'Smoke pours from its fur. The alarm is not worth it.' },
  { level: 50, stone: 'titan', title: 'Titanborn', blurb: 'The ground registers a new footprint.' },
  { level: 75, stone: 'void', title: 'Void-touched', blurb: 'It looks at you slightly to the left of you.' },
  { level: 100, stone: null, title: 'iKON Titan', blurb: 'Ascension. There is no tier above this.' },
];

const STONES = {
  fire: { name: 'Fire Stone', emoji: '🔥', price: 5000, desc: 'Warm to the touch. Smells like a forge.' },
  inferno: { name: 'Inferno Stone', emoji: '☄️', price: 15000, desc: 'Bites. That is the whole product.' },
  titan: { name: 'Titan Stone', emoji: '🪨', price: 30000, desc: 'Heavier than your last mistake.' },
  void: { name: 'Void Stone', emoji: '🌌', price: 75000, desc: 'Cold, black, and slightly quiet.' },
  revive: { name: 'Revive Crystal', emoji: '💠', price: 20000, desc: 'Pulls a dead pet back. Halves the resurrection bill.' },
};

// ───────────────────────────────────────────────────────────
// EXPLORE ZONES — all of them want your pet dead
// ───────────────────────────────────────────────────────────
const ZONES = [
  { name: 'Shadow Forest', emoji: '🌲', danger: 10, stones: 0.08 },
  { name: 'Lava Pits', emoji: '🌋', danger: 20, stones: 0.10 },
  { name: 'Abyss Sea', emoji: '🌊', danger: 30, stones: 0.12 },
  { name: 'Frozen Wasteland', emoji: '🏔️', danger: 25, stones: 0.11 },
  { name: 'Void Realm', emoji: '🕳️', danger: 45, stones: 0.18 },
];

// ───────────────────────────────────────────────────────────
// SKILLS — used by the turn-by-turn battle loop
// ───────────────────────────────────────────────────────────
const SKILLS = [
  { id: 'claw', name: 'Claw', emoji: '🐾', mult: 1.2, cooldown: 0 },
  { id: 'fireball', name: 'Fireball', emoji: '🔥', mult: 1.5, cooldown: 1 },
  { id: 'soulrip', name: 'Soul Rip', emoji: '👻', mult: 1.8, cooldown: 2 },
  { id: 'titan', name: 'Titan Smash', emoji: '💥', mult: 2.2, cooldown: 3 },
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

/** Sleep, so a turn-by-turn fight reads like a fight. */
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rand(0, arr.length - 1)];
const clamp = (v) => Math.max(0, Math.floor(Number(v) || 0));
const kc = (v) => `${Number(v || 0).toLocaleString('en-US')} ${CASH}`;
const num = (v) => Number(v || 0).toLocaleString('en-US');

/** Small story line so replies feel like a city, not a spreadsheet. */
const story = () => pick([
  'The iKON streetlights hum one octave lower tonight.',
  'Somewhere, a vault alarm tests itself.',
  'Owner Aphecks has not blinked in six hours.',
  'Rain taps the academy roof like it wants in.',
  'A Klerk courier runs past without looking up.',
  'The neon signs flicker in a pattern that means nothing.',
  'Somebody left a crate of K-Cash on the corner. Nobody moves it.',
  'The factory siren goes unanswered again.',
]);

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

/**
 * Total pet power.
 * power = basePower + (level * 10) + (prestige * 50)
 * Then temporary modifiers: +10% while blessed, -10% while cursed.
 * @param {object} pet
 * @param {object} [owner] the owning User doc, needed for the curse check
 */
function powerOf(pet, owner) {
  const base = Number(pet.basePower) || 0;
  const level = Number(pet.level) || 1;
  const prestige = Number(pet.prestige) || 0;
  let power = base + level * 10 + prestige * 50;

  const now = Date.now();
  if (pet.blessedUntil && now < new Date(pet.blessedUntil).getTime()) power *= 1.1;
  if (owner && owner.cursedUntil && now < new Date(owner.cursedUntil).getTime()) power *= 0.9;
  if (pet.hunger !== undefined && clamp(pet.hunger) <= 0) power *= 0.5;

  return Math.floor(power);
}

/** The strongest living pet a hunter owns. */
async function mainPet(uid) {
  if (!mongo.isReady()) return null;
  const pets = await Pet.find({ ownerUid: String(uid), isDead: false }).sort({ basePower: -1, level: -1 });
  return pets[0] || null;
}

/** Any living pet, or a specific one by name. */
async function getPet(uid, name) {
  if (!mongo.isReady()) return null;
  const filter = { ownerUid: String(uid) };
  if (name) filter.name = new RegExp(`^${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const pets = await Pet.find(filter).sort({ basePower: -1, level: -1 });
  return pets.find((p) => !p.isDead) || null;
}

/** Debit a wallet and record it. */
async function spend(userDoc, amount, action, metadata) {
  userDoc.coins = clamp((userDoc.coins || 0) - amount);
  await save(userDoc);
  await ledger(userDoc.uid, action, -amount, userDoc.coins, metadata);
  return userDoc.coins;
}

/** Credit a wallet and record it. */
async function earn(userDoc, amount, action, metadata) {
  userDoc.coins = clamp((userDoc.coins || 0) + amount);
  await save(userDoc);
  await ledger(userDoc.uid, action, amount, userDoc.coins, metadata);
  return userDoc.coins;
}

/** Add stones to a pet's stock. */
function giveStone(pet, stoneId, qty = 1) {
  if (!STONES[stoneId]) return;
  pet.stones[stoneId] = clamp((pet.stones[stoneId] || 0) + qty);
}

/** Take stones from a pet's stock. @returns {boolean} had enough */
function takeStone(pet, stoneId, qty = 1) {
  if (clamp(pet.stones[stoneId] || 0) < qty) return false;
  pet.stones[stoneId] = clamp(pet.stones[stoneId] - qty);
  return true;
}

/** Level a pet up from its XP curve (level * 120). */
async function petXp(pet, amount) {
  pet.xp = clamp((pet.xp || 0) + amount);
  let levels = 0;
  for (let i = 0; i < 500; i += 1) {
    const needed = (Number(pet.level) || 1) * 120;
    if (pet.xp < needed) break;
    pet.xp -= needed;
    pet.level = clamp(pet.level + 1);
    levels += 1;
  }
  return levels;
}

/** Has a dead pet been dead long enough to be deleted forever? */
const graveExpired = (pet) => (
  pet.isDead && pet.diedAt && (Date.now() - new Date(pet.diedAt).getTime() > 48 * 3600 * 1000)
);

/** Delete any pet that has been dead past the 48h window. */
async function reapGraves(uid) {
  if (!mongo.isReady()) return [];
  const gone = await Pet.find({ ownerUid: String(uid), isDead: true });
  const reaped = [];
  for (const pet of gone) {
    if (graveExpired(pet)) {
      reaped.push(pet.name);
      await Pet.deleteOne({ _id: pet._id });
    }
  }
  return reaped;
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

/** Load an inventory doc (potions used by petheal style flows). */
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

/** The bleed warning that greets an injured or starving pet. */
function bleedLine(pet) {
  const hunger = clamp(pet.hunger);
  if (pet.isDead) return `${ULTRA}: Your ${pet.name} is BLEEDING out on the academy floor. Revive it.`;
  if (hunger <= 20) return `${ULTRA}: Your ${pet.name} is BLEEDING from hunger. Feed it before something eats it.`;
  if (hunger <= 50) return `${ULTRA}: Your ${pet.name} is limping. Not BLEEDING yet. Feed it.`;
  return '';
}

/**
 * Turn-by-turn pet fight.
 *
 * Loop 3-5 turns. Each turn both pets pick a random skill and trade damage:
 *   dmg = (attackerPower * skillMult) - (defenderPower * 0.3)
 * Battle HP = power * 2. When a pet's HP hits zero it DIES and needs a revive.
 *
 * @param {Function} reply bound reply
 * @param {{attacker:{user:object,pet:object},defender:{user:object,pet:object},mode:string,event:object}} cfg
 */
async function runFight(reply, { attacker, defender, mode, event }) {
  const atkPet = attacker.pet;
  const defPet = defender.pet;

  const atkPower = powerOf(atkPet);
  const defPower = powerOf(defPet);
  let atkHP = atkPower * 2;
  let defHP = defPower * 2;

  const turns = rand(3, 5);
  // Each side tracks its own skill cooldowns.
  const atkCd = {};
  const defCd = {};

  atkPet.stats.battles = clamp(atkPet.stats.battles) + 1;
  defPet.stats.battles = clamp(defPet.stats.battles) + 1;
  atkPet.lastBattleAt = new Date();
  defPet.lastBattleAt = new Date();

  await reply(
    `⚔️ **${mode === 'arena' ? 'ARENA FIGHT' : 'HUNT'}**\n`
    + '━━━━━━━━━━━━━━━\n'
    + `🔴 ${atkPet.emoji} ${atkPet.name} ⚡${num(atkPower)} · HP ${num(Math.ceil(atkHP))}\n`
    + `🔵 ${defPet.emoji} ${defPet.name} ⚡${num(defPower)} · HP ${num(Math.ceil(defHP))}\n`
    + `🔁 ${turns} turns. ${story()}`,
    event.messageID,
  );
  await wait(800);

  /** Pick a skill that is off cooldown. */
  const chooseSkill = (cds) => {
    const ready = SKILLS.filter((s) => (cds[s.id] || 0) <= 0);
    const skill = ready.length ? pick(ready) : SKILLS[0];
    cds[skill.id] = skill.cooldown;
    // Tick everything else down.
    for (const k of Object.keys(cds)) cds[k] = Math.max(0, (cds[k] || 0) - 1);
    return skill;
  };

  for (let turn = 1; turn <= turns; turn += 1) {
    if (atkHP <= 0 || defHP <= 0) break;

    const atkSkill = chooseSkill(atkCd);
    const defSkill = chooseSkill(defCd);
    const atkDmg = Math.max(1, (atkPower * atkSkill.mult) - (defPower * 0.3));
    const defDmg = Math.max(1, (defPower * defSkill.mult) - (atkPower * 0.3));

    atkHP -= defDmg;
    defHP -= atkDmg;

    await reply(
      `**Turn ${turn}**\n`
      + `${atkPet.emoji} ${atkPet.name} → ${atkSkill.emoji} ${atkSkill.name} (-${num(Math.round(atkDmg))})\n`
      + `${defPet.emoji} ${defPet.name} → ${defSkill.emoji} ${defSkill.name} (-${num(Math.round(defDmg))})\n`
      + `🔴 HP ${num(Math.max(0, Math.ceil(atkHP)))} · 🔵 HP ${num(Math.max(0, Math.ceil(defHP)))}`,
      event.messageID,
    );
    await wait(800);
  }

  const attackerWon = atkHP > 0 && defHP <= 0;
  const defenderWon = defHP > 0 && atkHP <= 0;
  const decided = attackerWon || defenderWon;

  // ── who takes it ──
  // A knockout is decided; otherwise the stronger pet takes a time-out.
  let finalWinner;
  let finalLoser;
  let verdict;
  if (attackerWon) {
    finalWinner = attacker;
    finalLoser = defender;
    verdict = `🏆 **${atkPet.name} WINS**`;
  } else if (defenderWon) {
    finalWinner = defender;
    finalLoser = attacker;
    verdict = `🏆 **${defPet.name} WINS**`;
  } else {
    finalWinner = atkPower >= defPower ? attacker : defender;
    finalLoser = atkPower >= defPower ? defender : attacker;
    verdict = '⏱️ **TIME** — the stronger pet takes it';
  }

  const winnerPet = finalWinner.pet;
  const loserPet = finalLoser.pet;

  // ── payouts ──
  const loot = Math.floor(clamp(finalLoser.user.coins) * 0.2);
  finalLoser.user.coins = clamp((finalLoser.user.coins || 0) - loot);
  await earn(finalWinner.user, loot, 'pet:battle', {
    loser: String(finalLoser.user.uid), loot, mode,
  });
  const xpGained = 100;
  const levelsGained = await petXp(winnerPet, xpGained);

  // ── record the result exactly once per side ──
  winnerPet.stats.wins = clamp(winnerPet.stats.wins) + 1;
  winnerPet.stats.kills = clamp(winnerPet.stats.kills) + 1;
  loserPet.stats.losses = clamp(loserPet.stats.losses) + 1;

  // ── the loser bleeds out ──
  loserPet.hunger = Math.max(0, clamp(loserPet.hunger) - 50);
  const loserIsDead = loserPet.hunger <= 0;
  if (loserIsDead) {
    loserPet.isDead = true;
    loserPet.diedAt = new Date();
  }

  await save(atkPet);
  await save(defPet);
  await save(attacker.user);
  await save(defender.user);
  await ledger(finalLoser.user.uid, 'pet:battle', -loot, finalLoser.user.coins, {
    winner: String(finalWinner.user.uid), mode,
  });

  // Group-level arena tally for this chat.
  if (mongo.isReady() && event.threadID) {
    try {
      const g = await Group.findOne({ tid: String(event.threadID) });
      if (g) {
        g.petArena.battles = clamp(g.petArena.battles) + 1;
        g.petArena.wins = clamp(g.petArena.wins) + (String(finalWinner.user.uid) === String(attacker.user.uid) ? 1 : 0);
        await g.save();
      }
    } catch { /* the arena tally is decorative */ }
  }

  await reply(
    `${verdict}\n`
    + '━━━━━━━━━━━━━━━\n'
    + `🏆 ${winnerPet.emoji || '🐉'} ${winnerPet.name} ⚡${num(powerOf(winnerPet))} (+${num(xpGained)} XP${levelsGained ? ` → Lv ${winnerPet.level}` : ''})\n`
    + `💀 ${loserPet.name} ⚡${num(powerOf(loserPet))} — hunger ${clamp(loserPet.hunger)}/100\n`
    + `💸 Loot taken: ${kc(loot)}\n`
    + `👛 Winner wallet: ${kc(finalWinner.user.coins)}\n`
    + (loserIsDead
      ? `💀 **${loserPet.name} IS DEAD.** Revive it: \`!petrevive\` (48h before it is gone).\n`
      : '')
    + `📖 ${story()}`,
    event.messageID,
  );
}

module.exports = [
  // ─────────────────────────────────────────────────────────
  // 1
  // ─────────────────────────────────────────────────────────
  {
    name: 'pet',
    aliases: ['mypet'],
    category: 'pets',
    description: '🐾 Your pet card - power, level, hunger, safe status, stones',
    usage: '!pet [name]',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'pet', async () => {
      await react('🐾');
      const pet = await getPet(userDoc.uid, args[0]);
      if (!pet) {
        await reply(
          `🐾 You have no pet in iKON City.\n`
          + `🥚 Hatch one with \`!petegg\`, or buy a dangerous one with \`!adopt <id>\`.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const power = powerOf(pet);
      const stones = Object.keys(STONES)
        .filter((id) => clamp(pet.stones[id]) > 0)
        .map((id) => `${STONES[id].emoji} ${clamp(pet.stones[id])}`)
        .join(' ') || 'none';

      await reply(
        `🐾 **${pet.emoji || '🐉'} ${pet.name}**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `⚡ Power: ${num(power)}\n`
        + `📊 Level ${pet.level} · ${num(pet.xp)} XP\n`
        + `🍖 Hunger: ${clamp(pet.hunger)}/100\n`
        + `🛡️ Safe mode: ${pet.isSafe ? 'ON ✅' : 'OFF ⚠️ EXPOSED'}\n`
        + `💀 State: ${pet.isDead ? 'DEAD' : 'alive'}\n`
        + `💎 Stones: ${stones}\n`
        + `📈 Battles: ${num(pet.stats ? pet.stats.battles : 0)} (${num(pet.stats ? pet.stats.wins : 0)}W)\n`
        + (pet.isSafe ? '🔐 Nobody can attack a safe pet.\n' : '⚠️ Anyone can `!petfight` this pet. No refunds.\n')
        + (bleedLine(pet) ? `${bleedLine(pet)}\n` : '')
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 2
  // ─────────────────────────────────────────────────────────
  {
    name: 'adopt',
    aliases: [],
    category: 'pets',
    description: '🥚 Adopt a starter dragon (1k) or buy one of 15 dangerous pets',
    usage: '!adopt [starter | <pet id>]',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'adopt', async () => {
      await react('🥚');
      if (!mongo.isReady()) {
        await reply('💾 The pet registry is offline. No adoptions until the database wakes.', event.messageID);
        return;
      }

      const owned = await Pet.countDocuments({ ownerUid: String(userDoc.uid), isDead: false });
      if (owned >= 5) {
        await reply(
          `🚫 You already house ${owned} pets. iKON City has a zoning limit of five.\n`
          + `💀 Release one with \`!petrelease <name>\`.`,
          event.messageID,
        );
        return;
      }

      const arg = String(args[0] || 'starter').toLowerCase();

      // ── starter dragon ──
      if (arg === 'starter' || arg === 'dragon') {
        const cost = 1000;
        if ((userDoc.coins || 0) < cost) {
          await reply(`❌ A starter dragon costs ${kc(cost)}. Wallet: ${kc(userDoc.coins)}`, event.messageID);
          return;
        }
        await spend(userDoc, cost, 'pet:adopt_starter', { pet: 'dragon' });
        const pet = await Pet.create({
          ownerUid: String(userDoc.uid), name: 'Tiny Dragon', type: 'dragon',
          basePower: 100, level: 1, hunger: 100, isSafe: true,
        });
        await reply(
          `🥚 You adopted **${pet.name}** 🐉 for ${kc(cost)}.\n`
          + `⚡ Power: ${num(powerOf(pet))}\n`
          + `🛡️ Safe mode ON — protect it with \`!petsafe\`, or go feral with \`!petsafe off\`.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      // ── dangerous pet ──
      const spec = PET_BY_ID.get(arg);
      if (!spec) {
        await reply(
          `❌ Unknown pet \`${arg}\`.\n`
          + `🐉 Available: \`starter\`, or one of:\n`
          + `${DANGEROUS_PETS.map((p) => `\`${p.id}\` (${kc(p.price)})`).join(', ')}\n`
          + `📖 \`!petlist\` has the full bestiary.`,
          event.messageID,
        );
        return;
      }

      // Only ONE iKON Titan Prime exists per bot.
      if (spec.id === 'titanprime') {
        const exists = await Pet.countDocuments({ isTitanPrime: true });
        if (exists > 0) {
          await reply(
            `👑 **There is only ONE iKON Titan Prime in this bot.**\n`
            + `😈 It already belongs to someone. Owner Aphecks says find your own path.`,
            event.messageID,
          );
          return;
        }
      }

      if ((userDoc.coins || 0) < spec.price) {
        await reply(
          `💸 **${spec.emoji} ${spec.name} costs ${kc(spec.price)}.**\n`
          + `👛 You have ${kc(userDoc.coins)}.\n`
          + `📖 Short ${num(spec.price - (userDoc.coins || 0))} ${CASH}. Come back with it.`,
          event.messageID,
        );
        return;
      }

      await spend(userDoc, spec.price, 'pet:adopt', { pet: spec.id, power: spec.power });
      const pet = await Pet.create({
        ownerUid: String(userDoc.uid),
        name: spec.name,
        type: spec.id,
        basePower: spec.power,
        level: 1,
        hunger: 100,
        isSafe: true,
        isTitanPrime: spec.id === 'titanprime',
      });

      await reply(
        `${spec.emoji} **YOU ADOPTED ${spec.name.toUpperCase()}**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💸 Price: ${kc(spec.price)}\n`
        + `⚡ Base power: ${num(spec.power)}\n`
        + `📖 "${spec.lore}"\n`
        + `🛡️ Safe mode ON. Safe mode costs 500/day — \`!petsafe\` to manage.\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 3
  // ─────────────────────────────────────────────────────────
  {
    name: 'petinfo',
    aliases: [],
    category: 'pets',
    description: '🔢 Full pet stats + power breakdown (base + level*10 + prestige*50)',
    usage: '!petinfo [name]',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'petinfo', async () => {
      await react('🔢');
      const pet = await getPet(userDoc.uid, args[0]);
      if (!pet) {
        await reply('🐾 No living pet to inspect. Adopt one with `!adopt`.', event.messageID);
        return;
      }

      const base = Number(pet.basePower) || 0;
      const level = Number(pet.level) || 1;
      const prestige = Number(pet.prestige) || 0;
      const stats = pet.stats || {};

      await reply(
        `🔢 **POWER BREAKDOWN — ${pet.name}**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🧬 Base power: ${num(base)}\n`
        + `📊 Level: ${level} → +${num(level * 10)}\n`
        + `👑 Prestige: ${prestige} → +${num(prestige * 50)}\n`
        + `⚡ TOTAL POWER: **${num(powerOf(pet))}**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🍖 Hunger: ${clamp(pet.hunger)}/100\n`
        + `🛡️ Safe: ${pet.isSafe ? 'ON' : 'OFF ⚠️'}\n`
        + `⚔️ Battles: ${num(stats.battles)} · W ${num(stats.wins)} · L ${num(stats.losses)}\n`
        + `👾 Kills: ${num(stats.kills)} · Explores: ${num(stats.explores)}\n`
        + (bleedLine(pet) ? `${bleedLine(pet)}\n` : '')
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 4
  // ─────────────────────────────────────────────────────────
  {
    name: 'petsafe',
    aliases: ['unsafenow'],
    category: 'pets',
    description: '🛡️ Toggle safe mode — safe costs 500/day rent, OFF means anyone can !petfight',
    usage: '!petsafe <on | off>',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'petsafe', async () => {
      await react('🛡️');
      const pet = await mainPet(userDoc.uid);
      if (!pet) {
        await reply('🐾 You have no pet to protect. Adopt one with `!adopt`.', event.messageID);
        return;
      }

      const mode = String(args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(mode)) {
        await reply(
          `🛡️ Safe mode is currently **${pet.isSafe ? 'ON' : 'OFF'}** for ${pet.name}.\n`
          + `💡 Usage: \`!petsafe on\` (500 ${CASH}/day rent) or \`!petsafe off\` (EXPOSED)\n`
          + (pet.isSafe ? '🔐 Nobody can attack it right now.' : '⚠️ Anyone replying `!petfight` to your messages can hit it.'),
          event.messageID,
        );
        return;
      }

      const wantSafe = mode === 'on';

      // ── turning OFF ──
      if (!wantSafe) {
        if (!pet.isSafe) {
          await reply(`⚠️ ${pet.name} is already UNSAFE. It is out there bleeding already.`, event.messageID);
          return;
        }
        pet.isSafe = false;
        pet.lastSafeToggle = new Date();
        await save(pet);
        await ledger(userDoc.uid, 'pet:safe_off', 0, userDoc.coins, { pet: pet.name });

        await reply(
          `⚠️ **SAFE MODE OFF — ${pet.name} IS EXPOSED**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `💀 Anyone replying \`!petfight\` to your messages can attack it.\n`
          + `💸 If it loses, they steal 1,000 ${CASH}.\n`
          + `🚫 Rent waived. Protection costs.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      // ── turning ON (costs 500/day rent) ──
      const last = pet.lastRentPaid ? new Date(pet.lastRentPaid).getTime() : 0;
      const dayMs = 24 * 3600 * 1000;
      const owesRent = !last || (Date.now() - last) > dayMs;

      if (owesRent) {
        if ((userDoc.coins || 0) < 500) {
          await reply(
            `💸 Safe mode costs a **500 ${CASH}/day** rent, and you have ${kc(userDoc.coins)}.\n`
            + `⚠️ ${pet.name} stays EXPOSED until you can pay.\n`
            + `📖 ${story()}`,
            event.messageID,
          );
          return;
        }
        await spend(userDoc, 500, 'pet:safe_rent', { pet: pet.name, period: 'day' });
      }

      pet.isSafe = true;
      pet.lastSafeToggle = new Date();
      if (owesRent) pet.lastRentPaid = new Date();
      await save(pet);

      await reply(
        `🛡️ **SAFE MODE ON — ${pet.name} is locked down**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🏠 Vault rent: ${kc(500)}/day${owesRent ? ' (charged)' : ' (already paid today)'}\n`
        + `🔐 Attackers cannot touch it.\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 5
  // ─────────────────────────────────────────────────────────
  {
    name: 'petevolve',
    aliases: [],
    category: 'pets',
    description: '🔥 Evolve your pet — lvl 15 Fire, 30 Inferno, 50 Titan, 75 Void, 100 iKON Titan',
    usage: '!petevolve [name]',
    cooldown: 120,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'petevolve', async () => {
      await react('🔥');
      const pet = await getPet(userDoc.uid, args[0]);
      if (!pet) {
        await reply('🐾 No living pet to evolve. Adopt one with `!adopt`.', event.messageID);
        return;
      }
      if (pet.isDead) {
        await reply(`💀 ${pet.name} is dead. Revive it with \`!petrevive\` before evolution.`, event.messageID);
        return;
      }

      const next = EVOLUTIONS.find((e) => (Number(pet.level) || 1) < e.level);
      if (!next) {
        await reply(
          `👑 ${pet.name} has reached **iKON Titan**. There is nothing above this.\n`
          + `⚡ Power: ${num(powerOf(pet))}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      // ── not ready ── roast the user ──
      if ((Number(pet.level) || 1) < next.level) {
        const short = next.level - (Number(pet.level) || 1);
        const line = pick([
          'Come back when it can climb a flight of stairs.',
          'Level it. It is not ready. You are not ready.',
          'The stone would be wasted on a pet this small.',
          'Train it. Evolution is not a participation trophy.',
        ]);
        await reply(
          `🔥 **EVOLUTION FAILED — ${pet.name} is not ready**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `📊 Needs Level ${next.level}, you are Level ${pet.level} (${short} short).\n`
          + `${next.stone ? `💎 Requires 1x ${STONES[next.stone].emoji} ${STONES[next.stone].name}.\n` : ''}`
          + `${line}\n`
          + `💪 Train with \`!trainpet\`. Stones from \`!petshop\` or \`!petexplore\`.`,
          event.messageID,
        );
        return;
      }

      // ── level reached, need the stone ──
      if (next.stone && !takeStone(pet, next.stone, 1)) {
        await reply(
          `🔥 **EVOLUTION HALTED — missing stone**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `📊 Level ${pet.level} ✅ — but you need 1x ${STONES[next.stone].emoji} ${STONES[next.stone].name}.\n`
          + `👛 Buy it for ${kc(STONES[next.stone].price)} with \`!petshop ${next.stone}\`.\n`
          + `🗺️ Or find one in \`!petexplore\` (${Math.round((ZONES.find((z) => z.stones > 0.15) || ZONES[0]).stones * 100)}% in the deepest zones).\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      // ── ascend ──
      const before = powerOf(pet);
      pet.basePower = clamp((Number(pet.basePower) || 0) + 150);
      pet.hunger = Math.min(100, clamp(pet.hunger) + 40);
      pet.title = next.title;
      if (next.level >= 100) pet.isTitanPrime = true;
      await save(pet);
      await ledger(userDoc.uid, 'pet:evolve', 0, userDoc.coins, {
        pet: pet.name, title: next.title, level: next.level,
      });

      await reply(
        `🔥 **${next.title.toUpperCase()} — ${pet.name} EVOLVED**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `📖 "${next.blurb}"\n`
        + `⚡ Power: ${num(before)} → **${num(powerOf(pet))}** (+150 base)\n`
        + `📊 Level ${pet.level} · Hunger restored to ${clamp(pet.hunger)}\n`
        + (next.level >= 100 ? '👑 **iKON TITAN ASCENDED.** There is no next tier.\n' : `🔥 Next: Level ${(EVOLUTIONS.find((e) => e.level > next.level) || {}).level || '??'} evolution.\n`)
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 6
  // ─────────────────────────────────────────────────────────
  {
    name: 'petshop',
    aliases: [],
    category: 'pets',
    description: '🛒 Feed, evolution stones and Revive Crystals — the whole dangerous supply table',
    usage: '!petshop [item] [qty]',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'petshop', async () => {
      await react('🛒');
      const catalogue = [
        { id: 'feed', name: 'Raw Feed', emoji: '🍖', price: 100, desc: '+25 hunger. The reason pets stay alive.' },
        ...Object.keys(STONES).map((id) => ({ id, ...STONES[id] })),
      ];
      const wantId = String(args[0] || '').toLowerCase();

      if (!wantId) {
        const lines = catalogue.map((i) => `${i.emoji} **${i.name}** — ${kc(i.price)}\n   \`!petshop ${i.id} [qty]\``);
        await reply(
          `🛒 **iKON PET SUPPLY**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `${lines.join('\n')}\n`
          + `💎 Stones unlock evolution. Crystals bring back the dead.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const item = catalogue.find((i) => i.id === wantId);
      if (!item) {
        await reply(
          `❌ Unknown item \`${wantId}\`. Stock: ${catalogue.map((i) => `\`${i.id}\``).join(', ')}`,
          event.messageID,
        );
        return;
      }

      const qty = Math.max(1, Number.parseInt(args[1], 10) || 1);
      const cost = item.price * qty;
      if ((userDoc.coins || 0) < cost) {
        await reply(`❌ ${qty}x ${item.name} costs ${kc(cost)}. Wallet: ${kc(userDoc.coins)}`, event.messageID);
        return;
      }

      const pet = await mainPet(userDoc.uid);
      if (!pet && item.id !== 'feed') {
        await reply('🐾 You need a pet to carry items. Adopt one with `!adopt`.', event.messageID);
        return;
      }

      await spend(userDoc, cost, 'pet:shop', { item: item.id, qty, cost });

      if (item.id === 'feed') {
        pet.hunger = Math.min(100, clamp(pet.hunger) + 25 * qty);
        pet.lastFeed = new Date();
        await save(pet);
        await reply(
          `🍖 Fed ${pet.name} ${qty} time(s).\n`
          + `🍖 Hunger: ${clamp(pet.hunger)}/100\n`
          + `💸 ${kc(cost)} · Wallet: ${kc(userDoc.coins)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      giveStone(pet, item.id, qty);
      await save(pet);
      await reply(
        `🛒 Bought ${qty}x ${item.emoji} **${item.name}** for ${kc(cost)}.\n`
        + `💎 ${pet.name} now holds ${clamp(pet.stones[item.id])}.\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + (item.id === 'revive' ? '💀 A dead pet revives for 20,000 + 1 Crystal (or 50,000 bare).\n' : '🔥 Ready for `!petevolve`.\n')
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 7
  // ─────────────────────────────────────────────────────────
  {
    name: 'petstones',
    aliases: [],
    category: 'pets',
    description: '💎 Your evolution stone inventory, held by your pet',
    usage: '!petstones [name]',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'petstones', async () => {
      await react('💎');
      const pet = await getPet(userDoc.uid, args[0]);
      if (!pet) {
        await reply('🐾 No living pet holds stones. Adopt one with `!adopt`.', event.messageID);
        return;
      }

      const lines = Object.keys(STONES).map((id) => {
        const have = clamp(pet.stones[id]);
        return `${STONES[id].emoji} **${STONES[id].name}** x${have} ${have > 0 ? '✅' : '— empty'}`;
      });
      const next = EVOLUTIONS.find((e) => (Number(pet.level) || 1) < e.level);

      await reply(
        `💎 **${pet.name}'S STONES**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n`
        + (next
          ? `🔥 Next evolution: Level ${next.level}${next.stone ? ` + 1x ${STONES[next.stone].name}` : ' (final tier)'}\n`
          : '👑 Fully evolved. No stones required.\n')
        + `🛒 Buy more with \`!petshop\`.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 8
  // ─────────────────────────────────────────────────────────
  {
    name: 'petexplore',
    aliases: ['explore'],
    category: 'pets',
    description: '🗺️ Send your pet into 5 deadly zones — coins, XP, stones, or injuries',
    usage: '!petexplore [name]',
    cooldown: 3600,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'petexplore', async () => {
      await react('🗺️');
      const pet = await getPet(userDoc.uid, args[0]);
      if (!pet) {
        await reply('🐾 You have no pet to send anywhere. Adopt one with `!adopt`.', event.messageID);
        return;
      }
      if (pet.isDead) {
        await reply(`💀 ${pet.name} is dead. Revive it with \`!petrevive\`.`, event.messageID);
        return;
      }

      const last = pet.lastExplore ? new Date(pet.lastExplore).getTime() : 0;
      if (last && Date.now() - last < 3600 * 1000) {
        const left = 3600 * 1000 - (Date.now() - last);
        await reply(
          `😴 ${pet.name} is still out there. It comes back in ${fmt.dur(Math.ceil(left / 1000))}.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }
      if (clamp(pet.hunger) < 10) {
        await reply(
          `🍖 ${pet.name} is too hungry to travel (${clamp(pet.hunger)}/100 hunger).\n`
          + `🛒 Feed it: \`!petshop feed\``,
          event.messageID,
        );
        return;
      }

      const zone = pick(ZONES);
      pet.lastExplore = new Date();
      pet.stats.explores = clamp(pet.stats.explores) + 1;
      pet.hunger = clamp(pet.hunger) - 20;

      // ── the run itself ──
      const coins = rand(500, 5000);
      const xp = rand(50, 500);

      // 10-ish% stone find, weighted by how deep the zone is.
      const foundStone = Math.random() < Math.max(0.10, zone.stones);
      const stoneId = foundStone ? pick(['fire', 'fire', 'inferno', 'titan', 'void']) : null;

      // Injury chance scales with the zone's danger.
      const injured = Math.random() < zone.danger / 100;

      await earn(userDoc, coins, 'pet:explore', { zone: zone.name, xp, stone: stoneId });
      const levels = await petXp(pet, xp);
      if (stoneId) giveStone(pet, stoneId, 1);
      await save(pet);

      const lines = [
        `🗺️ **${pet.name} explored ${zone.emoji} ${zone.name}**`,
        '━━━━━━━━━━━━━━━',
        `💰 +${kc(coins)}`,
        `✨ +${num(xp)} XP${levels ? ` (**LEVEL UP!** → Level ${pet.level})` : ''}`,
        `🍖 Hunger: ${clamp(pet.hunger)}/100`,
      ];
      if (stoneId) lines.push(`💎 Found 1x ${STONES[stoneId].emoji} **${STONES[stoneId].name}**!`);
      else lines.push('💎 No stones this run. Go deeper.');
      if (injured) {
        pet.hunger = clamp(pet.hunger) - 15;
        lines.push('🩹 Your pet came back INJURED (-15 extra hunger).');
      }
      lines.push(`👛 Wallet: ${kc(userDoc.coins)}`);
      lines.push(`📖 ${story()}`);

      await reply(lines.join('\n'), event.messageID);
      if (injured) await save(pet);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 9
  // ─────────────────────────────────────────────────────────
  {
    name: 'petbattle',
    aliases: ['pbattle', 'parena'],
    category: 'pets',
    description: '⚔️ Challenge a hunter — turn-by-turn fight, winner takes 20% + 100 XP',
    usage: '!petbattle <user>',
    cooldown: 300,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'petbattle', async () => {
      await react('⚔️');
      if (!mongo.isReady()) {
        await reply('💾 The pet arena is closed — database offline.', event.messageID);
        return;
      }

      const myPet = await mainPet(userDoc.uid);
      if (!myPet) {
        await reply('🐾 You need a pet to fight with. Adopt one with `!adopt`.', event.messageID);
        return;
      }

      const target = await targetOr(reply, event.messageID, args[0], event, 'petbattle');
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ You cannot duel yourself. The arena has standards.', event.messageID);
        return;
      }

      const theirPet = await mainPet(target.uid);
      if (!theirPet) {
        await reply(`🐾 ${target.name} has no pet. Nothing to fight.`, event.messageID);
        return;
      }
      if (theirPet.isSafe) {
        await reply(
          `🛡️ ${theirPet.name} is in SAFE mode. Protected.\n`
          + `💡 They have to run \`!petsafe off\` before you can challenge them.`,
          event.messageID,
        );
        return;
      }

      // One live challenge per hunter at a time.
      const parked = cache.setPendingBattle(event.threadID, String(target.uid), {
        fromUid: String(event.senderID),
        fromName: userDoc.name,
        threadID: event.threadID,
        expires: Date.now() + 2 * 60 * 1000,
      });
      if (!parked) {
        await reply(`⏳ ${target.name} already has a pending challenge. Tell them to answer it.`, event.messageID);
        return;
      }

      await reply(
        `⚔️ **CHALLENGE SENT**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🐾 ${myPet.emoji} ${myPet.name} (⚡${num(powerOf(myPet))})\n`
        + `🎯 vs ${theirPet.emoji} ${theirPet.name} (⚡${num(powerOf(theirPet))})\n`
        + `⏳ ${target.name} has **2 minutes** to answer with \`!petaccept\` or \`!petdeny\`.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 10
  // ─────────────────────────────────────────────────────────
  {
    name: 'petaccept',
    aliases: [],
    category: 'pets',
    description: '✅ Accept a pending pet challenge — starts a turn-by-turn fight',
    usage: '!petaccept',
    cooldown: 30,
    permission: 'all',
    execute: async ({ event, userDoc, reply, react }) => guard(reply, event.messageID, 'petaccept', async () => {
      await react('✅');
      if (!mongo.isReady()) {
        await reply('💾 The pet arena is closed — database offline.', event.messageID);
        return;
      }

      const challenge = cache.getPendingBattle(event.threadID, String(event.senderID));
      if (!challenge) {
        await reply('📭 No pending challenge for you. Unless it expired.', event.messageID);
        return;
      }
      if (Date.now() >= challenge.expires) {
        cache.clearPendingBattle(event.threadID, String(event.senderID));
        await reply('⌛ That challenge expired. Ask them to send another.', event.messageID);
        return;
      }
      cache.takePendingBattle(event.threadID, String(event.senderID));

      const challenger = await User.findOne({ uid: challenge.fromUid });
      if (!challenger) {
        await reply('❌ The challenger vanished. Fight cancelled.', event.messageID);
        return;
      }

      const myPet = await mainPet(userDoc.uid);
      const theirPet = await mainPet(challenger.uid);
      if (!myPet || !theirPet) {
        await reply('❌ One of the pets is gone now. Fight cancelled.', event.messageID);
        return;
      }
      if (myPet.isSafe) {
        await reply('🛡️ Your pet just went safe. The challenger backs off.', event.messageID);
        return;
      }

      await runFight(reply, {
        attacker: { user: challenger, pet: theirPet },
        defender: { user: userDoc, pet: myPet },
        quiet: false,
        mode: 'arena',
        event,
      });
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 11
  // ─────────────────────────────────────────────────────────
  {
    name: 'petdeny',
    aliases: [],
    category: 'pets',
    description: '🚫 Refuse a pet challenge — no shame, only strategy',
    usage: '!petdeny',
    cooldown: 30,
    permission: 'all',
    execute: async ({ event, userDoc, reply, react }) => guard(reply, event.messageID, 'petdeny', async () => {
      await react('🚫');
      const challenge = cache.getPendingBattle(event.threadID, String(event.senderID));
      if (!challenge) {
        await reply('📭 Nothing to refuse. No challenge is pending for you.', event.messageID);
        return;
      }
      cache.takePendingBattle(event.threadID, String(event.senderID));

      await reply(
        `🚫 **CHALLENGE REFUSED**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🛡️ ${userDoc.name} says no.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 12
  // ─────────────────────────────────────────────────────────
  {
    name: 'petfight',
    aliases: ['pfight', 'stealpet'],
    category: 'pets',
    description: '🔪 REPLY to an unsafe pet owner with this to attack their pet — instant, 1 turn',
    usage: '!petfight (as a reply to the victim\'s message)',
    cooldown: 30,
    permission: 'all',
    execute: async ({ event, userDoc, reply, react }) => guard(reply, event.messageID, 'petfight', async () => {
      await react('🔪');
      if (!mongo.isReady()) {
        await reply('💾 The arena is closed — database offline.', event.messageID);
        return;
      }

      // Who is being attacked? Prefer the reply-to target, then a tag.
      const repliedUid = cache.ownerOfMessage(event.messageID);
      let victimUid = repliedUid;
      let victim = null;

      if (victimUid) victim = await User.findOne({ uid: victimUid });

      if (!victim) {
        // Fall back to a tagged user in the same message.
        const mentioned = event.mentions && Object.keys(event.mentions)[0];
        if (mentioned) {
          victim = await User.findOne({ uid: String(mentioned) });
          victimUid = victim ? String(victim.uid) : null;
        }
      }

      if (!victim || !victimUid) {
        await reply(
          '🔪 **REPLY TO SOMEONE\'S MESSAGE** with `!petfight` to attack their pet.\n'
          + '💡 Targeting only works against an UNSAFE pet. Safe pets are untouchable.\n'
          + '📖 ' + story(),
          event.messageID,
        );
        return;
      }

      if (victimUid === String(event.senderID)) {
        await reply('❌ Attacking your own pet is a cry for help, not a strategy.', event.messageID);
        return;
      }

      const theirPet = await mainPet(victimUid);
      if (!theirPet) {
        await reply(`🐾 ${victim.name} has no pet to attack. Nothing but pride here.`, event.messageID);
        return;
      }
      if (theirPet.isSafe) {
        await reply(
          `🛡️ **${theirPet.name} IS SAFE.** No blood today.\n`
          + `💡 They are paying 500/day for exactly this.`,
          event.messageID,
        );
        return;
      }

      const myPet = await mainPet(userDoc.uid);
      if (!myPet) {
        await reply('🐾 You need your own pet to fight with. Adopt one with `!adopt`.', event.messageID);
        return;
      }

      // ── one-turn quick fight: raw power comparison ──
      const mine = powerOf(myPet);
      const theirs = powerOf(theirPet);
      myPet.stats.battles = clamp(myPet.stats.battles) + 1;
      theirPet.stats.battles = clamp(theirPet.stats.battles) + 1;

      if (mine > theirs) {
        myPet.stats.wins = clamp(myPet.stats.wins) + 1;
        myPet.stats.kills = clamp(myPet.stats.kills) + 1;
        theirPet.stats.losses = clamp(theirPet.stats.losses) + 1;

        const steal = Math.min(1000, clamp(victim.coins));
        victim.coins = clamp((victim.coins || 0) - steal);
        await earn(userDoc, steal, 'pet:steal', { victim: victimUid, pet: theirPet.name });

        // Losing to a quick fight drags the loser to the brink.
        theirPet.hunger = Math.max(0, clamp(theirPet.hunger) - 50);
        theirPet.lastBattleAt = new Date();
        await save(myPet);
        await save(theirPet);
        await save(victim);
        await ledger(victimUid, 'pet:attacked', -steal, victim.coins, { by: String(userDoc.uid) });

        await reply(
          `⚠️ **UNSAFE PET DETECTED! ${userDoc.name} RIPPED ${victim.name}!**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `🐾 ${myPet.emoji} ${myPet.name} ⚡${num(mine)}\n`
          + `💀 vs ${theirPet.emoji} ${theirPet.name} ⚡${num(theirs)}\n`
          + `💸 Stole ${kc(steal)} from ${victim.name}.\n`
          + `🍖 ${theirPet.name} hunger → ${clamp(theirPet.hunger)}/100\n`
          + `👛 Your wallet: ${kc(userDoc.coins)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      // ── the attacker loses ──
      myPet.stats.losses = clamp(myPet.stats.losses) + 1;
      theirPet.stats.wins = clamp(theirPet.stats.wins) + 1;
      theirPet.stats.kills = clamp(theirPet.stats.kills) + 1;

      const loss = Math.min(1000, clamp(userDoc.coins));
      await spend(userDoc, loss, 'pet:quickfight_loss', { victim: victimUid });
      theirPet.hunger = Math.max(0, clamp(theirPet.hunger) - 50);
      myPet.hunger = Math.max(0, clamp(myPet.hunger) - 50);
      myPet.lastBattleAt = new Date();
      await save(myPet);
      await save(theirPet);
      await save(victim);

      await reply(
        `⚠️ **UNSAFE PET DETECTED! ${victim.name} RIPPED ${userDoc.name}!**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🐾 ${myPet.emoji} ${myPet.name} ⚡${num(mine)} — WEAKER\n`
        + `🛡️ vs ${theirPet.emoji} ${theirPet.name} ⚡${num(theirs)}\n`
        + `💸 You lost ${kc(loss)}.\n`
        + `🍖 Both pets hunger → ${clamp(myPet.hunger)} / ${clamp(theirPet.hunger)}\n`
        + `💡 Turn safe mode on with \`!petsafe on\` before you post again.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 13
  // ─────────────────────────────────────────────────────────
  {
    name: 'petrevive',
    aliases: [],
    category: 'pets',
    description: '💀 Revive a dead pet — 20k + Revive Crystal, or 50k alone. Dead pets vanish after 48h',
    usage: '!petrevive [name]',
    cooldown: 300,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'petrevive', async () => {
      await react('💀');
      if (!mongo.isReady()) {
        await reply('💾 The resurrection desk is closed — database offline.', event.messageID);
        return;
      }

      // Anything past the 48h window is gone for good.
      const reaped = await reapGraves(userDoc.uid);
      if (reaped.length) {
        await reply(`🪦 **${reaped.join(', ')}** crossed the 48-hour line and was deleted forever.`, event.messageID);
        return;
      }

      const filter = { ownerUid: String(userDoc.uid), isDead: true };
      if (args[0]) filter.name = new RegExp(`^${String(args[0]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
      const pet = await Pet.findOne(filter).sort({ diedAt: -1 });
      if (!pet) {
        await reply('💀 You have no dead pet. Your pets are all still breathing.', event.messageID);
        return;
      }

      // Dead long enough that even we cannot bring it back.
      if (graveExpired(pet)) {
        await Pet.deleteOne({ _id: pet._id });
        await reply(`🪦 ${pet.name} was deleted. You were too late by hours.`, event.messageID);
        return;
      }

      const hasCrystal = clamp(pet.stones.revive) > 0;
      const cost = hasCrystal ? 20000 : 50000;
      if ((userDoc.coins || 0) < cost) {
        await reply(
          `💸 Resurrection costs ${kc(cost)}${hasCrystal ? ' (Crystal discount applied)' : ' — buy a Revive Crystal to pay 20,000'}.\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `🛒 Crystals: \`!petshop revive\`\n`
          + `⏳ ${pet.name} has ${fmt.dur(Math.max(0, 48 * 3600 * 1000 - (Date.now() - new Date(pet.diedAt).getTime())) / 1000)} left before it is deleted forever.`,
          event.messageID,
        );
        return;
      }

      await spend(userDoc, cost, 'pet:revive', { pet: pet.name, crystal: hasCrystal });
      if (hasCrystal) takeStone(pet, 'revive', 1);
      pet.isDead = false;
      pet.diedAt = null;
      pet.hunger = 40;
      await save(pet);

      await reply(
        `💀 **${pet.name} IS BACK.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💸 Cost: ${kc(cost)}${hasCrystal ? ' (1x 💠 Revive Crystal used)' : ' — no crystal, full price'}\n`
        + `⚡ Power: ${num(powerOf(pet))}\n`
        + `🍖 Hunger: 40/100 — feed it before someone finds it\n`
        + `🛡️ Safe mode: ${pet.isSafe ? 'ON' : 'OFF ⚠️ still exposed'}\n`
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
    name: 'petfeed',
    aliases: [],
    category: 'pets',
    description: '🍖 Feed your pet — +25 hunger for 100 coins, or free scraps if desperate',
    usage: '!petfeed [name]',
    cooldown: 60,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'petfeed', async () => {
      await react('🍖');
      const pet = await getPet(userDoc.uid, args[0]);
      if (!pet) {
        await reply('🐾 No pet to feed. Adopt one with `!adopt`.', event.messageID);
        return;
      }
      if (clamp(pet.hunger) >= 100) {
        await reply(`🍖 ${pet.name} is stuffed. Full bar, no appetite.`, event.messageID);
        return;
      }

      const broke = (userDoc.coins || 0) < 100;
      const cost = broke ? 0 : 100;
      if (cost) await spend(userDoc, cost, 'pet:feed', { pet: pet.name });

      pet.hunger = Math.min(100, clamp(pet.hunger) + 25);
      pet.lastFeed = new Date();
      await save(pet);

      const line = cost
        ? `🍖 You bought a slab of raw feed for ${kc(cost)}. ${pet.name} inhaled it.`
        : `🗑️ You cannot afford feed. You scraped scraps off the alley floor for free.`;

      await reply(
        `${line}\n`
        + `🍖 Hunger: ${clamp(pet.hunger)}/100\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 15
  // ─────────────────────────────────────────────────────────
  {
    name: 'trainpet',
    aliases: [],
    category: 'pets',
    description: '💪 Train your pet — XP, power growth, and the occasional accident',
    usage: '!trainpet [name]',
    cooldown: 600,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'trainpet', async () => {
      await react('💪');
      const pet = await getPet(userDoc.uid, args[0]);
      if (!pet) {
        await reply('🐾 No pet to train. Adopt one with `!adopt`.', event.messageID);
        return;
      }
      if (clamp(pet.hunger) < 20) {
        await reply(
          `🍖 ${pet.name} is too hungry to train (${clamp(pet.hunger)}/100).\n`
          + `🛒 \`!petshop feed\` first.`,
          event.messageID,
        );
        return;
      }

      const xp = rand(60, 220);
      pet.hunger = clamp(pet.hunger) - 15;
      const before = powerOf(pet);
      const levels = await petXp(pet, xp);
      await save(pet);
      await ledger(userDoc.uid, 'pet:train', 0, userDoc.coins, { pet: pet.name, xp, levels });

      await reply(
        `💪 **${pet.name} trained all morning.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `✨ +${num(xp)} XP${levels ? ` (**LEVEL UP!** → Level ${pet.level})` : ''}\n`
        + `⚡ Power: ${num(before)} → **${num(powerOf(pet))}**\n`
        + `🍖 Hunger: ${clamp(pet.hunger)}/100\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 16
  // ─────────────────────────────────────────────────────────
  {
    name: 'petrank',
    aliases: [],
    category: 'pets',
    description: '🏆 Strongest pets in iKON City by total power',
    usage: '!petrank',
    cooldown: 15,
    permission: 'all',
    execute: async ({ reply, react, event }) => guard(reply, event.messageID, 'petrank', async () => {
      await react('🏆');
      if (!mongo.isReady()) {
        await reply('💾 The bestiary is sealed — database offline.', event.messageID);
        return;
      }

      const top = await Pet.find({ isDead: false })
        .sort({ basePower: -1, level: -1 })
        .limit(10)
        .populate('ownerUid', 'name')
        .exec();
      if (!top.length) {
        await reply('🏆 No living pets in the city yet. Hatch one with `!petegg`.', event.messageID);
        return;
      }

      const medals = ['🥇', '🥈', '🥉'];
      const lines = top.map((p, i) => {
        const owner = p.ownerUid && p.ownerUid.name ? p.ownerUid.name : 'unknown';
        return `${medals[i] || `${i + 1}.`} ${p.emoji || '🐉'} ${p.name} — ${owner} (⚡${num(powerOf(p))})`;
      });

      await reply(
        `🏆 **STRONGEST PETS IN iKON CITY**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n`
        + `👑 Only one iKON Titan Prime can exist. One does.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 17
  // ─────────────────────────────────────────────────────────
  {
    name: 'petlist',
    aliases: [],
    category: 'pets',
    description: '🐉 The bestiary — all 15 dangerous pets, prices, power and lore',
    usage: '!petlist',
    cooldown: 15,
    permission: 'all',
    execute: async ({ reply, react, event }) => guard(reply, event.messageID, 'petlist', async () => {
      await react('🐉');
      const lines = DANGEROUS_PETS.map((p) => (
        `${p.emoji} **${p.name}** ⚡${num(p.power)} — ${kc(p.price)}\n   \`!adopt ${p.id}\``
      ));

      await reply(
        `🐉 **iKON BESTIARY — 15 DANGEROUS PETS**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n`
        + `🥚 Cheaper start: \`!adopt starter\` for 1,000 ${CASH}.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 18
  // ─────────────────────────────────────────────────────────
  {
    name: 'petbreed',
    aliases: [],
    category: 'pets',
    description: '🧬 Breed two Level 30+ pets for 50k — offspring inherits the stronger bloodline',
    usage: '!petbreed <name1> <name2>',
    cooldown: 3600,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'petbreed', async () => {
      await react('🧬');
      if (!mongo.isReady()) {
        await reply('💾 The breeding lab is offline.', event.messageID);
        return;
      }

      const [a, b] = args;
      if (!a || !b) {
        await reply('❌ Usage: `!petbreed <name1> <name2>` — both pets must be Level 30+.', event.messageID);
        return;
      }
      if (a.toLowerCase() === b.toLowerCase()) {
        await reply('❌ You cannot breed a pet with itself. Find a second pet.', event.messageID);
        return;
      }

      const owned = await Pet.find({ ownerUid: String(userDoc.uid), isDead: false });
      const find = (ref) => {
        const safe = String(ref).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return owned.find((p) => p.name.match(new RegExp(`^${safe}$`, 'i')));
      };
      const parentA = find(a);
      const parentB = find(b);

      if (!parentA || !parentB) {
        await reply('❌ Both pets must be yours and alive. Check `!petlist` of your pets with `!pet`.', event.messageID);
        return;
      }
      if (clamp(parentA.level) < 30 || clamp(parentB.level) < 30) {
        await reply(
          `📊 Both pets need Level 30+.\n`
          + `${parentA.name}: Lv ${parentA.level} · ${parentB.name}: Lv ${parentB.level}\n`
          + `💪 Train them with \`!trainpet\`.`,
          event.messageID,
        );
        return;
      }

      const cost = 50000;
      if ((userDoc.coins || 0) < cost) {
        await reply(`💸 Breeding costs ${kc(cost)}. Wallet: ${kc(userDoc.coins)}`, event.messageID);
        return;
      }

      await spend(userDoc, cost, 'pet:breed', { parents: [parentA.name, parentB.name] });

      // Child inherits the stronger bloodline, minus a small mutation.
      const stronger = powerOf(parentA) >= powerOf(parentB) ? parentA : parentB;
      const mutation = pick(['Feral', 'Ancient', 'Voidborn', 'Solar', 'Abyssal']);
      const childPower = clamp(Math.floor((Number(stronger.basePower) || 0) * 0.7) + rand(50, 250));
      const child = await Pet.create({
        ownerUid: String(userDoc.uid),
        name: `${mutation} ${stronger.name.split(' ').slice(-1)[0]}cub`,
        type: stronger.type,
        basePower: childPower,
        level: 1,
        hunger: 80,
        isSafe: true,
      });

      await reply(
        `🧬 **A NEW PET WAS BORN**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🥚 ${child.name}\n`
        + `⚡ Base power: ${num(childPower)} (inherited from ${stronger.name})\n`
        + `💸 Cost: ${kc(cost)}\n`
        + `🍖 Hunger: 80/100\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 19
  // ─────────────────────────────────────────────────────────
  {
    name: 'petegg',
    aliases: ['egg'],
    category: 'pets',
    description: '🥚 Hatch a mystery egg in 24h — the roll decides your bloodline',
    usage: '!petegg',
    cooldown: 3600,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'petegg', async () => {
      await react('🥚');
      if (!mongo.isReady()) {
        await reply('💾 The hatchery is offline.', event.messageID);
        return;
      }

      const eggs = await Pet.find({ ownerUid: String(userDoc.uid), isDead: false, type: 'egg' });
      const hatching = eggs[0];
      if (hatching) {
        const ready = hatching.createdAt && (Date.now() - new Date(hatching.createdAt).getTime() > 24 * 3600 * 1000);
        if (!ready) {
          const left = 24 * 3600 * 1000 - (Date.now() - new Date(hatching.createdAt).getTime());
          await reply(
            `🥚 Your egg is still wobbling. Hatches in ${fmt.dur(Math.ceil(left / 1000))}.\n`
            + `📖 ${story()}`,
            event.messageID,
          );
          return;
        }

        // Hatch it.
        const roll = Math.random();
        let spec;
        if (roll < 0.5) spec = PET_BY_ID.get(pick(['voidreaver', 'bloodfang', 'necrotitan', 'obsidian']));
        else if (roll < 0.85) spec = PET_BY_ID.get(pick(['infernal', 'thunder', 'frost', 'venom']));
        else spec = PET_BY_ID.get(pick(['kraken', 'shadowlord', 'doomhowl', 'nightmare', 'chaos']));

        hatching.name = spec.name;
        hatching.type = spec.id;
        hatching.basePower = spec.power;
        hatching.emoji = spec.emoji;
        hatching.level = 1;
        hatching.xp = 0;
        hatching.hunger = 100;
        await save(hatching);

        await reply(
          `🥚💥 **THE EGG HATCHED**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `${spec.emoji} **${spec.name}** ⚡${num(powerOf(hatching))}\n`
          + `📖 "${spec.lore}"\n`
          + `🍖 Hunger: 100/100 · 🛡️ Safe mode ON\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const cost = 5000;
      if ((userDoc.coins || 0) < cost) {
        await reply(`💸 A mystery egg costs ${kc(cost)}. Wallet: ${kc(userDoc.coins)}`, event.messageID);
        return;
      }
      await spend(userDoc, cost, 'pet:egg', {});

      const egg = await Pet.create({
        ownerUid: String(userDoc.uid),
        name: 'Mystery Egg',
        type: 'egg',
        basePower: 0,
        level: 1,
        hunger: 100,
        isSafe: true,
      });

      await reply(
        `🥚 You bought a **Mystery Egg** for ${kc(cost)}.\n`
        + '━━━━━━━━━━━━━━━\n'
        + `⏳ It hatches in 24 hours. Come back with \`!petegg\`.\n`
        + `📖 Common bloodlines are cheap here. So are the good ones.\n`
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
    name: 'pethunt',
    aliases: [],
    category: 'pets',
    description: '🗡️ Send your pet hunting — it brings back loot, coins, and occasionally trouble',
    usage: '!pethunt [name]',
    cooldown: 1800,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'pethunt', async () => {
      await react('🗡️');
      const pet = await getPet(userDoc.uid, args[0]);
      if (!pet) {
        await reply('🐾 No pet to send hunting. Adopt one with `!adopt`.', event.messageID);
        return;
      }

      const last = pet.lastBattleAt ? new Date(pet.lastBattleAt).getTime() : 0;
      if (last && Date.now() - last < 1800 * 1000) {
        await reply(
          `😴 ${pet.name} is still out hunting. Back in ${fmt.dur(Math.ceil(1800 - (Date.now() - last) / 1000))}.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      // Stronger pets hunt better. Hunger gates the run.
      const power = powerOf(pet);
      const loot = rand(200, 800) + Math.floor(power * 0.4);
      const xp = rand(40, 180) + Math.floor(power * 0.15);
      const hurt = Math.random() < 0.3;

      pet.lastBattleAt = new Date();
      pet.hunger = clamp(pet.hunger) - 25;
      pet.stats.kills = clamp(pet.stats.kills) + 1;
      const levels = await petXp(pet, xp);
      await earn(userDoc, loot, 'pet:hunt', { pet: pet.name, power, xp });
      if (hurt) pet.hunger = clamp(pet.hunger) - 20;
      await save(pet);

      const prey = pick(['a gullet rat', 'a neon hound', 'a vault sprite', 'a pigeon golem', 'a sewer troll']);
      await reply(
        `🗡️ **${pet.name} hunted ${prey}**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💰 +${kc(loot)}\n`
        + `✨ +${num(xp)} XP${levels ? ` (**LEVEL UP!** → Level ${pet.level})` : ''}\n`
        + `🍖 Hunger: ${clamp(pet.hunger)}/100${hurt ? ' (hunted something bigger — injured)' : ''}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 21
  // ─────────────────────────────────────────────────────────
  {
    name: 'petheist',
    aliases: [],
    category: 'pets',
    description: '🕵️ Three-hunter crew job — tag 2 allies, share the vault split 50/25/25',
    usage: '!petheist <user1> <user2>',
    cooldown: 3600,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'petheist', async () => {
      await react('🕵️');
      const [refA, refB] = args;
      if (!refA || !refB) {
        await reply('❌ Usage: `!petheist <user1> <user2>` — a heist needs a crew of three.', event.messageID);
        return;
      }

      const pet = await mainPet(userDoc.uid);
      if (!pet) {
        await reply('🐾 You need a pet for a crew job. Adopt one with `!adopt`.', event.messageID);
        return;
      }

      const a = await resolveTarget(refA, event);
      const b = await resolveTarget(refB, event);
      if (!a || !b) {
        await reply('❌ Both crew members must be taggable hunters. Try again.', event.messageID);
        return;
      }
      if ([String(a.uid), String(b.uid)].includes(String(event.senderID))
        || String(a.uid) === String(b.uid)) {
        await reply('❌ The crew must be three different hunters.', event.messageID);
        return;
      }

      // Every pet must be alive; safe mode is fine, this is a crew job.
      const crewPets = await Promise.all([mainPet(a.uid), mainPet(b.uid)]);
      if (!crewPets[0] || !crewPets[1]) {
        await reply('❌ Both crew members need a living pet. Recruiting failed.', event.messageID);
        return;
      }

      const crewPower = powerOf(pet) + powerOf(crewPets[0]) + powerOf(crewPets[1]);
      const tier = crewPower > 4000 ? 'THE iKON VAULT' : crewPower > 2000 ? 'the casino reserve' : 'a street strongbox';

      const roll = Math.random();
      if (roll < 0.25) {
        const penalty = 1500;
        await spend(userDoc, penalty, 'pet:heist_fail', { tier });
        pet.hunger = Math.max(0, clamp(pet.hunger) - 30);
        await save(pet);
        await reply(
          `🚨 **THE HEIST FAILED**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `🕵️ Your crew tried ${tier} and got made.\n`
          + `💸 Bail: ${kc(penalty)}\n`
          + `🍖 ${pet.name} hunger → ${clamp(pet.hunger)}/100\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      const haul = rand(6000, 24000) + Math.floor(crewPower * 3);
      const mine = Math.floor(haul * 0.5);
      const shareA = Math.floor(haul * 0.25);
      const shareB = haul - mine - shareA;

      await earn(userDoc, mine, 'pet:heist', { tier, haul, crew: [a.uid, b.uid] });
      a.coins = clamp((a.coins || 0) + shareA);
      b.coins = clamp((b.coins || 0) + shareB);
      await save(a);
      await save(b);

      pet.stats.kills = clamp(pet.stats.kills) + 1;
      await save(pet);
      await ledger(String(a.uid), 'pet:heist_share', shareA, a.coins, { crew: [String(event.senderID), String(b.uid)] });
      await ledger(String(b.uid), 'pet:heist_share', shareB, b.coins, { crew: [String(event.senderID), String(a.uid)] });

      await reply(
        `🕵️ **THE HEIST CAME OFF CLEAN**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🎯 Target: ${tier}\n`
        + `💰 Haul: ${kc(haul)}\n`
        + `👛 You: ${kc(mine)}\n`
        + `👛 ${a.name}: ${kc(shareA)}\n`
        + `👛 ${b.name}: ${kc(shareB)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 22
  // ─────────────────────────────────────────────────────────
  {
    name: 'petgift',
    aliases: [],
    category: 'pets',
    description: '🎁 Gift 1000 coins of care to another hunter — feeds and heals their pet',
    usage: '!petgift <user>',
    cooldown: 300,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'petgift', async () => {
      await react('🎁');
      const target = await targetOr(reply, event.messageID, args[0], event, 'petgift');
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ Gifting yourself is just feeding your own pet. Use `!petfeed`.', event.messageID);
        return;
      }

      const cost = 1000;
      if ((userDoc.coins || 0) < cost) {
        await reply(`💸 A care package costs ${kc(cost)}. Wallet: ${kc(userDoc.coins)}`, event.messageID);
        return;
      }

      const theirPet = await mainPet(target.uid);
      if (!theirPet) {
        await reply(`🐾 ${target.name} has no pet. Your gift would be wasted.`, event.messageID);
        return;
      }

      await spend(userDoc, cost, 'pet:gift', { to: target.uid });
      theirPet.hunger = Math.min(100, clamp(theirPet.hunger) + 40);
      theirPet.hunger = Math.max(0, clamp(theirPet.hunger) - 0);
      await save(theirPet);
      await ledger(String(target.uid), 'pet:gift_received', 0, target.coins, { from: String(userDoc.uid), amount: cost });

      await reply(
        `🎁 You sent ${target.name} a care package worth ${kc(cost)}.\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🍖 ${theirPet.name} hunger → ${clamp(theirPet.hunger)}/100\n`
        + `👛 Your wallet: ${kc(userDoc.coins)}\n`
        + `💚 Crew looks loyal. ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 23
  // ─────────────────────────────────────────────────────────
  {
    name: 'petplay',
    aliases: [],
    category: 'pets',
    description: '🎾 Play with your pet — free XP, small hunger cost, occasional bonding miracle',
    usage: '!petplay [name]',
    cooldown: 300,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'petplay', async () => {
      await react('🎾');
      const pet = await getPet(userDoc.uid, args[0]);
      if (!pet) {
        await reply('🐾 No pet to play with. Adopt one with `!adopt`.', event.messageID);
        return;
      }
      if (clamp(pet.hunger) < 15) {
        await reply(`🍖 ${pet.name} is too hungry to play. Feed it: \`!petshop feed\``, event.messageID);
        return;
      }

      const miracle = Math.random() < 0.1;
      const xp = miracle ? rand(200, 400) : rand(20, 90);
      pet.hunger = clamp(pet.hunger) - 10;
      const before = powerOf(pet);
      const levels = await petXp(pet, xp);
      await save(pet);

      await reply(
        `🎾 ${miracle ? '🌟 **A BONDING MIRACLE**' : 'You played fetch.'}\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${pick([
          'Your pet brought back the exact stick you threw. Twice.',
          'It rolled over. Voluntarily. Historic.',
          'It chased its own tail and made it look intentional.',
          'Somebody in the academy was visibly moved.',
        ])}\n`
        + `✨ +${num(xp)} XP${levels ? ` (**LEVEL UP!** → Level ${pet.level})` : ''}\n`
        + `⚡ Power: ${num(before)} → ${num(powerOf(pet))}\n`
        + `🍖 Hunger: ${clamp(pet.hunger)}/100\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 24
  // ─────────────────────────────────────────────────────────
  {
    name: 'petsleep',
    aliases: [],
    category: 'pets',
    description: '😴 Put your pet to sleep — recovers hunger over 8h, free to use',
    usage: '!petsleep [name]',
    cooldown: 1800,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'petsleep', async () => {
      await react('😴');
      const pet = await getPet(userDoc.uid, args[0]);
      if (!pet) {
        await reply('🐾 No pet to sleep. Adopt one with `!adopt`.', event.messageID);
        return;
      }
      if (clamp(pet.hunger) >= 100) {
        await reply(`😴 ${pet.name} is already fully rested. Do not disturb it.`, event.messageID);
        return;
      }

      const last = pet.lastFeed ? new Date(pet.lastFeed).getTime() : 0;
      const rested = last && Date.now() - last > 8 * 3600 * 1000;
      const gain = rested ? 50 : 25;
      pet.hunger = Math.min(100, clamp(pet.hunger) + gain);
      pet.lastFeed = new Date();
      await save(pet);

      await reply(
        `😴 **${pet.name} curled up and slept**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🍖 Hunger: +${gain} → ${clamp(pet.hunger)}/100\n`
        + `${rested ? '😌 It had been a long day. Proper rest kicked in.' : '💤 A short nap. Nothing heroic.'}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 25
  // ─────────────────────────────────────────────────────────
  {
    name: 'petstats',
    aliases: [],
    category: 'pets',
    description: '📊 Career statistics for your whole menagerie',
    usage: '!petstats',
    cooldown: 15,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'petstats', async () => {
      await react('📊');
      if (!mongo.isReady()) {
        await reply('💾 The pet registry is offline.', event.messageID);
        return;
      }

      const pets = await Pet.find({ ownerUid: String(userDoc.uid) });
      if (!pets.length) {
        await reply('📊 No pets on record. Adopt one with `!adopt`.', event.messageID);
        return;
      }

      const s = (p) => p.stats || {};
      const total = pets.reduce((acc, p) => ({
        battles: acc.battles + clamp(s(p).battles),
        wins: acc.wins + clamp(s(p).wins),
        losses: acc.losses + clamp(s(p).losses),
        kills: acc.kills + clamp(s(p).kills),
        explores: acc.explores + clamp(s(p).explores),
      }), { battles: 0, wins: 0, losses: 0, kills: 0, explores: 0 });
      const rate = total.battles ? Math.round((total.wins / total.battles) * 100) : 0;

      const lines = pets.map((p) => {
        const mark = p.isDead ? '💀' : (p.isSafe ? '🛡️' : '⚠️');
        return `${mark} ${p.emoji || '🐉'} ${p.name} — Lv ${p.level} ⚡${num(powerOf(p))} 🍖${clamp(p.hunger)}`;
      });

      await reply(
        `📊 **${userDoc.name || 'Hunter'}'S MENAGERIE**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n`
        + `🐾 Pets: ${num(pets.length)} (${num(pets.filter((p) => p.isDead).length)} dead)\n`
        + `⚔️ Battles: ${num(total.battles)} · ${rate}% win rate\n`
        + `👾 Kills: ${num(total.kills)} · Explores: ${num(total.explores)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 26
  // ─────────────────────────────────────────────────────────
  {
    name: 'petprestige',
    aliases: [],
    category: 'pets',
    description: '♻️ Reset a pet to Level 1 for +50 permanent power per rebirth',
    usage: '!petprestige [name]',
    cooldown: 86400,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'petprestige', async () => {
      await react('♻️');
      const pet = await getPet(userDoc.uid, args[0]);
      if (!pet) {
        await reply('🐾 No living pet to rebirth. Adopt one with `!adopt`.', event.messageID);
        return;
      }
      if ((Number(pet.level) || 1) < 10) {
        await reply(
          `♻️ A pet must reach **Level 10** to be reborn.\n`
          + `📊 ${pet.name} is Level ${pet.level}. ${(10 - (Number(pet.level) || 1))} to go.\n`
          + `💪 Train it: \`!trainpet\``,
          event.messageID,
        );
        return;
      }

      const before = powerOf(pet);
      const oldLevel = pet.level;
      pet.prestige = clamp(pet.prestige) + 1;
      pet.level = 1;
      pet.xp = 0;
      pet.hunger = 60;
      await save(pet);
      await ledger(userDoc.uid, 'pet:prestige', 0, userDoc.coins, { pet: pet.name, prestige: pet.prestige });

      await reply(
        `♻️ **${pet.name} REBORN**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `📉 Level ${oldLevel} → 1\n`
        + `⚡ Power: ${num(before)} → **${num(powerOf(pet))}** (+50 prestige)\n`
        + `👑 Prestige: ${pet.prestige} (+${num(pet.prestige * 50)} permanent)\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 27
  // ─────────────────────────────────────────────────────────
  {
    name: 'petcurse',
    aliases: [],
    category: 'pets',
    description: '🧿 Curse a rival pet — -10% power for 2h, costs 3000 and hurts your own luck',
    usage: '!petcurse <user>',
    cooldown: 1800,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'petcurse', async () => {
      await react('🧿');
      const target = await targetOr(reply, event.messageID, args[0], event, 'petcurse');
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ Cursing yourself is a cry for help.', event.messageID);
        return;
      }

      const cost = 3000;
      if ((userDoc.coins || 0) < cost) {
        await reply(`💸 A curse costs ${kc(cost)}. Wallet: ${kc(userDoc.coins)}`, event.messageID);
        return;
      }

      const theirPet = await mainPet(target.uid);
      if (!theirPet) {
        await reply(`🐾 ${target.name} has no pet to curse. The air is confused.`, event.messageID);
        return;
      }
      if (theirPet.isSafe) {
        await reply(
          `🛡️ ${theirPet.name} is SAFE. The curse bounces off the vault.\n`
          + `😤 ${kc(cost)} wasted.`,
          event.messageID,
        );
        return;
      }

      // Existing curse stacks are refreshed, not compounded.
      const theirUser = target;
      theirUser.cursedUntil = new Date(Date.now() + 2 * 3600 * 1000);
      await spend(userDoc, cost, 'pet:curse', { to: target.uid });
      await save(theirUser);

      await reply(
        `🧿 **CURSE LANDED**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🎯 ${target.name}'s ${theirPet.name} is cursed for 2 hours.\n`
        + `📉 -10% power while it lasts.\n`
        + `💸 Cost: ${kc(cost)}\n`
        + `⚠️ Backlash: your next hunt earns 10% less.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 28
  // ─────────────────────────────────────────────────────────
  {
    name: 'petbless',
    aliases: [],
    category: 'pets',
    description: '🙏 Bless your own pet — +10% power for 1h, costs 2000',
    usage: '!petbless [name]',
    cooldown: 1800,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'petbless', async () => {
      await react('🙏');
      const pet = await getPet(userDoc.uid, args[0]);
      if (!pet) {
        await reply('🐾 No pet to bless. Adopt one with `!adopt`.', event.messageID);
        return;
      }

      const cost = 2000;
      if ((userDoc.coins || 0) < cost) {
        await reply(`💸 A blessing costs ${kc(cost)}. Wallet: ${kc(userDoc.coins)}`, event.messageID);
        return;
      }

      await spend(userDoc, cost, 'pet:bless', { pet: pet.name });
      pet.blessedUntil = new Date(Date.now() + 3600 * 1000);
      pet.hunger = Math.min(100, clamp(pet.hunger) + 15);
      await save(pet);

      await reply(
        `🙏 **${pet.name} IS BLESSED**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `📈 +10% power for 1 hour.\n`
        + `🍖 Hunger +15 → ${clamp(pet.hunger)}/100\n`
        + `💸 Cost: ${kc(cost)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 29
  // ─────────────────────────────────────────────────────────
  {
    name: 'petlove',
    aliases: [],
    category: 'pets',
    description: '💘 Raise a pet bond — permanent power that survives rebirths and evolution',
    usage: '!petlove [name]',
    cooldown: 3600,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'petlove', async () => {
      await react('💘');
      const pet = await getPet(userDoc.uid, args[0]);
      if (!pet) {
        await reply('🐾 No pet to bond with. Adopt one with `!adopt`.', event.messageID);
        return;
      }

      const cost = 7500;
      if ((userDoc.coins || 0) < cost) {
        await reply(`💘 Deep bonding costs ${kc(cost)}. Wallet: ${kc(userDoc.coins)}`, event.messageID);
        return;
      }

      await spend(userDoc, cost, 'pet:love', { pet: pet.name });
      pet.bond = clamp((pet.bond || 0) + 1);
      pet.basePower = clamp((Number(pet.basePower) || 0) + 25);
      pet.hunger = Math.min(100, clamp(pet.hunger) + 20);
      const before = powerOf(pet) - 25;
      await save(pet);

      const line = pick([
        'It leaned into you and did not move for an hour.',
        'It slept on your feet through the whole shift.',
        'Somebody watched from the doorway and wiped their eye.',
        'It brought you something. You will never know what.',
      ]);

      await reply(
        `💘 **BOND DEEPENED**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${line}\n`
        + `🔗 Bond level: ${pet.bond}\n`
        + `⚡ Power: ${num(before)} → **${num(powerOf(pet))}** (+25 permanent)\n`
        + `🍖 Hunger: ${clamp(pet.hunger)}/100\n`
        + `💸 Cost: ${kc(cost)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 30
  // ─────────────────────────────────────────────────────────
  {
    name: 'ikontitan',
    aliases: [],
    category: 'pets',
    description: '👑 Summon the iKON Titan Prime — only ONE exists per bot, and only at max evolution',
    usage: '!ikontitan',
    cooldown: 86400,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'ikontitan', async () => {
      await react('👑');
      if (!mongo.isReady()) {
        await reply('💾 The summoning circle is offline.', event.messageID);
        return;
      }

      // Only one Titan Prime may ever exist.
      const existing = await Pet.findOne({ isTitanPrime: true });
      if (existing) {
        const owner = await User.findOne({ uid: existing.ownerUid });
        await reply(
          `👑 **THE iKON TITAN PRIME IS ALREADY SUMMONED.**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `🐾 ${existing.name} serves ${owner ? owner.name : 'someone'}.\n`
          + `😈 Only one exists per bot. Owner Aphecks does not allow exceptions.`,
          event.messageID,
        );
        return;
      }

      const mine = await Pet.find({ ownerUid: String(userDoc.uid), isDead: false }).sort({ level: -1 });
      const ready = mine.find((p) => (Number(p.level) || 1) >= 100);
      if (!ready) {
        const best = mine[0];
        await reply(
          `👑 **THE SUMMONING FAILS.**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `📊 The iKON Titan Prime requires a pet at **Level 100**.\n`
          + (best ? `📈 Your strongest: ${best.name} — Level ${best.level}.\n` : '🐾 You have no pets at all.\n')
          + `🔥 Level it, evolve it with stones, then try again.\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      // Ascend the pet into the single Titan Prime.
      ready.isTitanPrime = true;
      ready.basePower = 2000;
      ready.title = 'iKON Titan';
      ready.hunger = 100;
      ready.isSafe = true;
      await save(ready);
      await ledger(userDoc.uid, 'pet:titan_summon', 0, userDoc.coins, { pet: ready.name });

      await reply(
        `👑🌟 **THE iKON TITAN PRIME IS SUMMONED**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🐾 ${ready.name} ⚡${num(powerOf(ready))}\n`
        + `📖 Owner Aphecks says: "Finally. Do not waste it."\n`
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
    name: 'petarena',
    aliases: ['arenastats'],
    category: 'pets',
    description: '🏟️ Chat-wide pet arena record — battles fought here',
    usage: '!petarena',
    cooldown: 20,
    permission: 'all',
    execute: async ({ event, reply, react }) => guard(reply, event.messageID, 'petarena', async () => {
      await react('🏟️');
      if (!mongo.isReady()) {
        await reply('💾 The arena scoreboard is offline.', event.messageID);
        return;
      }

      const g = await Group.findOne({ tid: String(event.threadID) });
      const battles = g ? clamp(g.petArena.battles) : 0;
      const wins = g ? clamp(g.petArena.wins) : 0;
      const pending = cache.battleCount();

      await reply(
        `🏟️ **iKON PET ARENA — THIS CHAT**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `⚔️ Battles fought: ${num(battles)}\n`
        + `🏆 Challenger wins: ${num(wins)}\n`
        + `⏳ Live challenges pending: ${num(pending)}\n`
        + (battles ? `📉 Challenger win rate: ${wins ? Math.round((wins / battles) * 100) : 0}%\n` : '')
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 32
  // ─────────────────────────────────────────────────────────
  {
    name: 'petrename',
    aliases: [],
    category: 'pets',
    description: '✏️ Rename a pet — power, level and stones are untouched',
    usage: '!petrename <name> <new name>',
    cooldown: 60,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'petrename', async () => {
      await react('✏️');
      const [oldName, ...rest] = args;
      const newName = rest.join(' ').trim();
      if (!oldName || !newName) {
        await reply('❌ Usage: `!petrename <name> <new name>`', event.messageID);
        return;
      }
      if (newName.length > 32) {
        await reply(`❌ Too long (${newName.length}/32).`, event.messageID);
        return;
      }

      const pet = await getPet(userDoc.uid, oldName);
      if (!pet) {
        await reply(`🐾 No living pet called \`${oldName}\`. Check \`!pet\`.`, event.messageID);
        return;
      }

      const taken = await Pet.countDocuments({
        ownerUid: String(userDoc.uid),
        _id: { $ne: pet._id },
        name: new RegExp(`^${newName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      });
      if (taken) {
        await reply('❌ You already have a pet with that name. Pick another.', event.messageID);
        return;
      }

      const before = pet.name;
      pet.name = newName;
      await save(pet);

      await reply(
        `✏️ Renamed **${before}** → **${newName}**\n`
        + `⚡ Power unchanged: ${num(powerOf(pet))}\n`
        + `📖 It answers to its new name. Slowly. ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 33
  // ─────────────────────────────────────────────────────────
  {
    name: 'petrelease',
    aliases: [],
    category: 'pets',
    description: '🕊️ Release a pet into the wild — gone forever, no refunds, 50% back',
    usage: '!petrelease <name>',
    cooldown: 300,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'petrelease', async () => {
      await react('🕊️');
      if (!mongo.isReady()) {
        await reply('💾 The registry is offline. Nothing is being released.', event.messageID);
        return;
      }

      const pet = await getPet(userDoc.uid, args[0]);
      if (!pet) {
        await reply('🐾 No living pet with that name. Nothing to release.', event.messageID);
        return;
      }

      // Half the price paid at adoption comes back.
      const spec = PET_BY_ID.get(pet.type);
      const paid = pet.type === 'dragon' ? 1000 : (spec ? spec.price : 5000);
      const refund = Math.floor(paid * 0.5);

      await Pet.deleteOne({ _id: pet._id });
      await earn(userDoc, refund, 'pet:release', { pet: pet.name, refund });
      await ledger(userDoc.uid, 'pet:release_delete', 0, userDoc.coins, { pet: pet.name });

      await reply(
        `🕊️ **${pet.name} was released into the wild.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💸 The city paid you ${kc(refund)} (50% of ${kc(paid)}).\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 It walked into the fog without looking back. Gone for good.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 34
  // ─────────────────────────────────────────────────────────
  {
    name: 'petduel',
    aliases: [],
    category: 'pets',
    description: '🤺 Quick ranked duel — no challenge delay, unsafe pets only, 1 turn',
    usage: '!petduel <user>',
    cooldown: 300,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'petduel', async () => {
      await react('🤺');
      if (!mongo.isReady()) {
        await reply('💾 The arena is closed — database offline.', event.messageID);
        return;
      }

      const myPet = await mainPet(userDoc.uid);
      if (!myPet) {
        await reply('🐾 You need a pet to duel with. Adopt one with `!adopt`.', event.messageID);
        return;
      }

      const target = await targetOr(reply, event.messageID, args[0], event, 'petduel');
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ Dueling yourself is not a hobby.', event.messageID);
        return;
      }

      const theirPet = await mainPet(target.uid);
      if (!theirPet) {
        await reply(`🐾 ${target.name} has no pet. Nothing to duel.`, event.messageID);
        return;
      }
      if (theirPet.isSafe) {
        await reply(
          `🛡️ ${theirPet.name} is in SAFE mode. They pay 500/day for exactly this privilege.\n`
          + `😤 Try \`!petcurse\` or wait for them to go unsafe.`,
          event.messageID,
        );
        return;
      }

      await runFight(reply, {
        attacker: { user: userDoc, pet: myPet },
        defender: { user: target, pet: theirPet },
        mode: 'arena',
        event,
      });
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 35
  // ─────────────────────────────────────────────────────────
  {
    name: 'petinventory',
    aliases: ['pinv'],
    category: 'pets',
    description: '🎒 Full pet registry — every pet you own, alive or dead, with its stones',
    usage: '!petinventory',
    cooldown: 15,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'petinventory', async () => {
      await react('🎒');
      if (!mongo.isReady()) {
        await reply('💾 The pet registry is offline.', event.messageID);
        return;
      }

      const pets = await Pet.find({ ownerUid: String(userDoc.uid) }).sort({ isDead: 1, basePower: -1 });
      if (!pets.length) {
        await reply(
          '🎒 You own no pets.\n'
          + `🥚 \`!petegg\` for a mystery egg, or \`!adopt starter\` for 1,000 ${CASH}.`,
          event.messageID,
        );
        return;
      }

      const lines = pets.map((p) => {
        const mark = p.isDead ? '💀' : (p.isSafe ? '🛡️' : '⚠️');
        const stoneCount = Object.keys(STONES).reduce((n, id) => n + clamp(p.stones[id]), 0);
        const stones = stoneCount ? `💎${stoneCount}` : '💎0';
        return `${mark} ${p.emoji || '🐉'} **${p.name}** Lv ${p.level} ⚡${num(powerOf(p))} 🍖${clamp(p.hunger)} ${stones}`;
      });
      const reaped = await reapGraves(userDoc.uid);

      await reply(
        `🎒 **${userDoc.name || 'Hunter'}'S PET REGISTRY**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${lines.join('\n')}\n`
        + `🐾 Total: ${num(pets.length)} · Dead: ${num(pets.filter((p) => p.isDead).length)}\n`
        + (reaped.length ? `🪦 Deleted past 48h: ${reaped.join(', ')}\n` : '')
        + `⚠️ = unsafe pet · 🛡️ = safe · 💀 = dead\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  },
];