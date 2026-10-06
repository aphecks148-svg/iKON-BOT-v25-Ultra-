'use strict';

/**
 * Unified pet battle engine.
 *
 * Pure logic: no database, no canvas, no network. The commands in cmds_4.js
 * own the persistence and the I/O; this module owns the rules:
 *
 *   - 6 elements (Fire / Water / Earth / Wind / Light / Dark) with a 4-way
 *     cycle at 1.5× and Light ↔ Dark at 2×.
 *   - 3 skills per element (18 skills total), each with a damage multiplier
 *     and optional status.
 *   - Evolve-at-L25: each evolving species flips form 0 → 1 and gains a
 *     1.4× power bump.
 *   - Stamina: 5 max, 1 charge per hour, feed bonus refills.
 *   - Simulate a full PvP or hunt battle to completion.
 *   - Daily guild boss (gym) with a single shared health pool and rewards.
 *
 * The canvas card renderers (`battleCard`, `paintPet`) lazy-require
 * `./canvas` so they degrade to null — and the caller to a text fallback —
 * when the native binding is missing.
 */

// ───────────────────────────────────────────────────────────
// Elements
// ───────────────────────────────────────────────────────────

/** The six battle elements, in canonical order. */
const ELEMENTS = ['fire', 'water', 'earth', 'wind', 'light', 'dark'];

/**
 * The four cycle elements, in dominance order: each beats the one that
 * precedes it and is weak to the one that follows it.
 *   fire beats wind, wind beats earth, earth beats water, water beats fire.
 * Light and Dark sit outside the cycle; they only interact via the 2× rule.
 */
const CYCLE = ['fire', 'water', 'earth', 'wind'];

/** Short emoji for each element, for inline text. */
const ELEMENT_EMOJI = {
  fire: '🔥',
  water: '💧',
  earth: '🌱',
  wind: '💨',
  light: '✨',
  dark: '🌑',
};

/** Capitalised full name. */
const ELEMENT_FOR = {
  fire: 'Fire',
  water: 'Water',
  earth: 'Earth',
  wind: 'Wind',
  light: 'Light',
  dark: 'Dark',
};

/**
 * Resolve the element relation between an attack and a defence.
 * @returns {{relation:string, mult:number}}
 *   relation: 'super' | 'not' | 'neutral'
 *   mult:     1.5× | 0.75× | 1.0× (Light/Dark super is 2×)
 */
function resolveElement(atkElem, defElem) {
  if (!atkElem || !defElem || atkElem === defElem) {
    return { relation: 'neutral', mult: 1 };
  }

  // Light and Dark are 2× against each other.
  if (
    (atkElem === 'light' && defElem === 'dark')
    || (atkElem === 'dark' && defElem === 'light')
  ) {
    return { relation: 'super', mult: 2 };
  }

  // Cycle elements only: 1.5× / 0.75×.
  if (CYCLE.includes(atkElem) && CYCLE.includes(defElem)) {
    const ai = CYCLE.indexOf(atkElem);
    const prev = CYCLE[(ai + 3) % 4];   // the element this one beats
    const next = CYCLE[(ai + 1) % 4];   // the element that beats this one
    if (defElem === prev) return { relation: 'super', mult: 1.5 };
    if (defElem === next) return { relation: 'not', mult: 0.75 };
  }

  // Light/Dark attacking a cycle element, or vice-versa: neutral.
  return { relation: 'neutral', mult: 1 };
}

/** Element emoji with the capitalised label, e.g. `🔥 Fire`. */
function elementLabel(elem) {
  const e = ELEMENT_FOR[elem] || 'Unknown';
  return `${ELEMENT_EMOJI[elem] || '❓'} ${e}`;
}

// ───────────────────────────────────────────────────────────
// Skills
// ───────────────────────────────────────────────────────────

/**
 * Skill tiers amplify the base multiplier.
 * tier 0 → 1.00×, tier 1 → 1.20×, … tier 5 → 2.00×.
 */
const SKILL_TIER_MAX = 5;

/**
 * @param {number} tier 0–5
 * @returns {number}
 */
function skillTierMult(tier) {
  return 1 + (Math.max(0, Math.min(SKILL_TIER_MAX, Number(tier) || 0)) * 0.2);
}

/**
 * All 18 skills, three per element.
 * Each skill: { id, name, emoji, element, mult, status, desc }
 */
const SKILLS_BY_ELEMENT = {
  fire: [
    { id: 'ember', name: 'Ember', emoji: '🔥', mult: 0.9, status: 'burn', statusChance: 0.3, desc: 'Small fire, 30% chance to burn' },
    { id: 'flamethrower', name: 'Flamethrower', emoji: '🔥', mult: 1.3, status: 'burn', statusChance: 0.5, desc: 'Sustained flame, 50% burn' },
    { id: 'inferno', name: 'Inferno', emoji: '🔥', mult: 1.8, status: 'burn', statusChance: 0.8, desc: 'Wall of fire, 80% chance to burn' },
  ],
  water: [
    { id: 'squirt', name: 'Squirt', emoji: '💧', mult: 0.9, status: 'slow', statusChance: 0.3, desc: 'Pistol grip, 30% slow' },
    { id: 'tidalwave', name: 'Tidal Wave', emoji: '💧', mult: 1.3, status: 'slow', statusChance: 0.6, desc: 'Crashing wave, 60% slow' },
    { id: 'tsunami', name: 'Tsunami', emoji: '💧', mult: 1.8, status: 'slow', statusChance: 1.0, desc: 'Devastating torrent, 100% slow' },
  ],
  earth: [
    { id: 'rockslide', name: 'Rockslide', emoji: '🌱', mult: 0.9, status: 'guard', statusChance: 0.4, desc: 'Stones, 40% self-guard next turn' },
    { id: 'quake', name: 'Earthquake', emoji: '🌱', mult: 1.3, status: 'guard', statusChance: 0.7, desc: 'Shaking ground, 70% self-guard' },
    { id: 'cataclysm', name: 'Cataclysm', emoji: '🌱', mult: 1.8, status: 'guard', statusChance: 1.0, desc: 'Continental shift, guaranteed guard' },
  ],
  wind: [
    { id: 'gust', name: 'Gust', emoji: '💨', mult: 0.9, status: 'blind', statusChance: 0.3, desc: 'Sharp breeze, 30% blind' },
    { id: 'cyclone', name: 'Cyclone', emoji: '💨', mult: 1.3, status: 'blind', statusChance: 0.6, desc: 'Vortex, 60% blind' },
    { id: 'hurricane', name: 'Hurricane', emoji: '💨', mult: 1.8, status: 'blind', statusChance: 1.0, desc: 'Storm wall, 100% blind' },
  ],
  light: [
    { id: 'radiance', name: 'Radiance', emoji: '✨', mult: 0.9, status: 'clear', statusChance: 1.0, desc: 'Purifying light, removes negative status' },
    { id: 'flash', name: 'Flash', emoji: '✨', mult: 1.3, status: 'haste', statusChance: 0.8, desc: 'Blinding glare, 80% haste' },
    { id: 'judgment', name: 'Judgment', emoji: '✨', mult: 1.9, status: 'clear', statusChance: 1.0, desc: 'Divine verdict, cleanses and strikes' },
  ],
  dark: [
    { id: 'shadow', name: 'Shadow', emoji: '🌑', mult: 0.9, status: 'curse', statusChance: 0.3, desc: 'Creeping dark, 30% curse' },
    { id: 'nightmare', name: 'Nightmare', emoji: '🌑', mult: 1.3, status: 'curse', statusChance: 0.6, desc: 'Haunting, 60% curse' },
    { id: 'void', name: 'Void', emoji: '🌑', mult: 1.9, status: 'curse', statusChance: 1.0, desc: 'Null sphere, guaranteed curse' },
  ],
};

/** Flat array of all 18 skills. */
const ALL_SKILLS = ELEMENTS.flatMap((e) => SKILLS_BY_ELEMENT[e]);

/**
 * Skills a pet can actually use: its three skills for its element.
 * @param {object} pet must have `.element`
 * @returns {Array}
 */
function skillList(pet) {
  const elem = (pet && pet.element) || 'fire';
  return SKILLS_BY_ELEMENT[elem] || SKILLS_BY_ELEMENT.fire;
}

/** Pick a random skill from a pet's element. */
function randomSkill(pet) {
  const skills = skillList(pet);
  return skills[Math.floor(Math.random() * skills.length)];
}

// ───────────────────────────────────────────────────────────
// Species → element lookup
// ───────────────────────────────────────────────────────────

/**
 * Which element each adoptable species maps to.
 * Pets not listed here default to Fire when adopted.
 */
const SPECIES_ELEMENTS = {
  // fire
  emberdrake: 'fire', phoenix: 'fire', infernal: 'fire', cinderhound: 'cinderhound',
  godwyrm: 'fire', ratking: 'dark', pigeonlord: 'light',
  // water
  frost: 'water', swampwyrm: 'water', worldeater: 'water', kraken: 'water',
  // earth
  obsidian: 'earth', brassbeetle: 'earth', ashenwarden: 'earth',
  // wind
  stormroc: 'wind', trashgoose: 'wind', gutterhound: 'wind',
  // light
  seraphine: 'light', aurelith: 'light', severnine: 'light',
  // dark
  shadowlord: 'dark', oblivion: 'dark', nullwyrm: 'dark',
  voidreaver: 'dark', soulripper: 'dark',
};

/**
 * Resolve a species id or pet object to a canonical element.
 * @param {string|object} sp — species id string, or a pet with `.element`/`.type`
 * @returns {string} one of ELEMENTS
 */
function elementFor(sp) {
  if (typeof sp === 'object' && sp.element) return sp.element;
  const id = typeof sp === 'string' ? sp : (sp && sp.type);
  if (id && SPECIES_ELEMENTS[id]) return SPECIES_ELEMENTS[id];
  // Deterministic fallback: hash the id into the 6 elements.
  if (id) {
    const h = String(id).split('').reduce((n, c) => n + c.charCodeAt(0), 0);
    return ELEMENTS[h % ELEMENTS.length];
  }
  return 'fire';
}

// ───────────────────────────────────────────────────────────
// Evolution
// ───────────────────────────────────────────────────────────

/**
 * Species that can evolve at level 25.
 * key = species id, value = { name, element, basePower, emoji }
 */
const EVOLVES = {
  tinydragon: { name: 'Fire Dragon', element: 'fire', basePower: 170, emoji: '🐉' },
  feralhound: { name: 'Alpha Hound', element: 'dark', basePower: 280, emoji: '🐺' },
  trashgoose: { name: 'Storm Gander', element: 'wind', basePower: 300, emoji: '🪿' },
  emberdrake: { name: 'Infernal Drake', element: 'fire', basePower: 900, emoji: '🦎' },
};

/**
 * XP required to reach a given level (level × 120).
 */
function xpForLevel(level) {
  return (Number(level) || 1) * 120;
}

/**
 * Grant XP to a pet, leveling it up as needed.
 * Returns the number of levels gained.
 * @param {object} pet a mongoose doc or plain object
 * @param {number} amount
 * @returns {number}
 */
function grantXp(pet, amount) {
  pet.xp = (Number(pet.xp) || 0) + Number(amount);
  let levels = 0;
  for (let i = 0; i < 999; i += 1) {
    const needed = xpForLevel(pet.level);
    if (pet.xp < needed) break;
    pet.xp -= needed;
    pet.level = (Number(pet.level) || 1) + 1;
    levels += 1;
  }
  return levels;
}

/**
 * If a pet is level 25+ and has an evolved form, flip its form to 1 and
 * apply the evolved stats. Returns true if it evolved.
 */
function evolveIfReady(pet) {
  if (!pet || pet.form >= 1) return false;
  if ((Number(pet.level) || 1) < 25) return false;

  const species = (pet.type || '').toLowerCase();
  const evo = EVOLVES[species];
  if (!evo) return false;

  pet.form = 1;
  pet.name = evo.name;
  pet.element = evo.element;
  pet.basePower = Math.floor(Number(pet.basePower) * 1.4);
  return true;
}

// ───────────────────────────────────────────────────────────
// Battle stats
// ───────────────────────────────────────────────────────────

/**
 * Combat power used for HP, damage, and SPD.
 * Base: basePower + level*10 + prestige*50.
 * Form bonus (evolved): ×1.4.
 * @param {object} pet
 * @returns {number}
 */
function battlePower(pet) {
  if (!pet) return 1;
  const base = Number(pet.basePower) || 0;
  const level = Number(pet.level) || 1;
  const prestige = Number(pet.prestige) || 0;
  let power = base + level * 10 + prestige * 50;
  if ((Number(pet.form) || 0) >= 1) power = Math.floor(power * 1.4);
  return Math.max(1, power);
}

/**
 * Full stat block for a combatant.
 * @param {object} pet
 * @returns {{power:number,hp:number,atk:number,spd:number,crit:number,element:string,skills:Array}}
 */
function battleStats(pet) {
  const power = battlePower(pet);
  return {
    power,
    hp: power * 2,
    atk: power,
    spd: Math.max(1, Math.floor(power / 5)),
    crit: 0.15,
    element: (pet && pet.element) || elementFor(pet && pet.type),
    skills: skillList(pet),
  };
}

/**
 * Render an HP bar string, 20 chars wide.
 * @param {number} current
 * @param {number} max
 * @returns {string}
 */
function hpBar(current, max) {
  const pct = Math.max(0, Math.min(1, Number(current) / (Number(max) || 1)));
  const filled = Math.round(pct * 20);
  return '█'.repeat(filled) + '░'.repeat(20 - filled);
}

// ───────────────────────────────────────────────────────────
// Stamina
// ───────────────────────────────────────────────────────────

/** Maximum stamina charges a pet can hold. */
const STAMINA_MAX = 5;
/** One charge regenerates every hour. */
const STAMINA_RECHARGE_MS = 60 * 60 * 1000;

/**
 * Current stamina for a pet, accounting for time-based regeneration.
 * @param {object} pet
 * @param {number} [now] epoch ms
 * @returns {number} 0–STAMINA_MAX
 */
function staminaOf(pet, now = Date.now()) {
  const raw = pet.stamina != null ? Number(pet.stamina) : STAMINA_MAX;
  const current = clampStam(raw);
  const last = pet.staminaReset ? new Date(pet.staminaReset).getTime() : (pet.lastBattleAt ? new Date(pet.lastBattleAt).getTime() : now);
  if (current >= STAMINA_MAX) return STAMINA_MAX;
  const elapsed = now - last;
  const recovered = Math.floor(elapsed / STAMINA_RECHARGE_MS);
  return clampStam(current + recovered);
}

/**
 * Set a pet's stamina and its reset timestamp.
 */
function setStamina(pet, value) {
  pet.stamina = clampStam(value);
  pet.staminaReset = new Date();
}

/**
 * Force-regenerate all stamina (e.g. after a feed bonus).
 */
function restoreStamina(pet, amount = STAMINA_MAX, now = Date.now()) {
  const current = staminaOf(pet, now);
  setStamina(pet, Math.min(STAMINA_MAX, current + amount));
}

/**
 * Can the pet battle right now?
 */
function canBattle(pet, now = Date.now()) {
  return staminaOf(pet, now) >= 1;
}

/**
 * Consume one stamina charge. Returns true if there was enough.
 */
function spendStamina(pet) {
  const current = staminaOf(pet);
  if (current < 1) return false;
  setStamina(pet, current - 1);
  return true;
}

function clampStam(v) {
  return Math.max(0, Math.min(STAMINA_MAX, Math.floor(Number(v) || 0)));
}

// ───────────────────────────────────────────────────────────
// Status effects
// ───────────────────────────────────────────────────────────

/**
 * Text label for each status effect.
 */
const STATUS_TEXT = {
  burn: 'Burned 🔥',
  freeze: 'Frozen ❄️',
  curse: 'Cursed 🌑',
  weaken: 'Weakened 🌱',
  blind: 'Blinded 💨',
  haste: 'Hastened ✨',
  slow: 'Slowed 💧',
};

/**
 * @param {object} status — a map of status → rounds remaining
 * @param {string} key
 * @returns {string}
 */
function statusText(status, key) {
  if (!status || !status[key]) return '';
  return STATUS_TEXT[key] || key;
}

/**
 * Apply a status to a combatant's status map.
 * `@param {object} status`
 * @param {string} key
 * @param {number} rounds — turns it lasts
 */
function applyStatus(status, key, rounds) {
  if (!status) return { [key]: rounds };
  const existing = status[key] || 0;
  status[key] = Math.max(existing, rounds);
  return status;
}

/**
 * Tick all non-permanent statuses down by one round.
 * Returns the array of statuses that expired this tick.
 * @param {object} status
 * @returns {string[]}
 */
function tickStatuses(status) {
  if (!status) return [];
  const expired = [];
  for (const k of Object.keys(status)) {
    status[k] = (Number(status[k]) || 0) - 1;
    if (status[k] <= 0) {
      delete status[k];
      expired.push(k);
    }
  }
  return expired;
}

// ───────────────────────────────────────────────────────────
// Combat resolution
// ───────────────────────────────────────────────────────────

const ATTACK_POWER = 0.85;
const CRIT_CHANCE = 0.15;
const CRIT_MULT = 1.5;
const GUARD_MULT = 0.35;
const MAX_BATTLE_ROUNDS = 20;

/**
 * Build an AI action for the given combatant.
 * @returns {{skill:object, target:'opponent'}}
 */
function chooseAction(stats) {
  const skill = randomSkill({ element: stats.element, skills: stats.skills });
  return { skill, target: 'opponent' };
}

/**
 * Resolve a single attack.
 * @param {object} attacker — { pet, stats, hp, status }
 * @param {object} defender — { pet, stats, hp, status }
 * @returns {{damage:number, crit:boolean, elementMult:number, frozen:boolean, description:string}}
 */
function resolveAttack(attacker, defender) {
  const skill = attacker.action.skill;
  const tierMult = skillTierMult(attacker.pet.skillTier);
  const elem = resolveElement(attacker.stats.element, defender.stats.element);
  const base = attacker.stats.atk * skill.mult * tierMult * elem.mult;

  // Defender might be guarding (from earth skills) or frozen.
  let damage = base * ATTACK_POWER;
  if (defender.status && defender.status.guard) damage *= GUARD_MULT;

  const isCrit = Math.random() < attacker.stats.crit;
  if (isCrit) damage *= CRIT_MULT;
  damage = Math.max(1, Math.round(damage));

  return {
    damage,
    crit: isCrit,
    elementMult: elem.mult,
    frozen: Boolean(defender.status && defender.status.freeze),
    description: `${skill.emoji} ${skill.name} ${isCrit ? '💥 CRIT' : ''}`,
  };
}

/**
 * Run a full battle to completion and return the result.
 *
 * @param {object} a — { pet, name, emoji } (attacker)
 * @param {object} b — { pet, name, emoji } (defender)
 * @param {object} [opts]
 * @param {boolean} [opts.wild=false] — wild pet may flee on its turn
 * @param {number} [opts.maxRounds=20]
 * @returns {{winner:'a'|'b'|'draw', rounds:number, log:Array, aFinal:{hp,stats}, bFinal:{hp,stats>, aPet:object, bPet:object}}
 */
function simulateBattle(a, b, opts = {}) {
  const wild = opts.wild === true;
  const maxRounds = opts.maxRounds || MAX_BATTLE_ROUNDS;

  const aStats = battleStats(a.pet);
  const bStats = battleStats(b.pet);

  const state = {
    a: { pet: a.pet, stats: aStats, hp: aStats.hp, status: {}, skill: null },
    b: { pet: b.pet, stats: bStats, hp: bStats.hp, status: {}, skill: null },
  };

  const log = [];

  let winner = null;

  for (let round = 1; round <= maxRounds; round += 1) {
    // Initiative: higher SPD goes first. Ties broken randomly.
    let first, second;
    if (state.a.stats.spd > state.b.stats.spd) {
      first = 'a'; second = 'b';
    } else if (state.b.stats.spd > state.a.stats.spd) {
      first = 'b'; second = 'a';
    } else {
      first = Math.random() < 0.5 ? 'a' : 'b';
      second = first === 'a' ? 'b' : 'a';
    }

    // Tick statuses at the start of the round.
    tickStatuses(state.a.status);
    tickStatuses(state.b.status);

    let roundLog = `**Round ${round}**\n`;

    for (const side of [first, second]) {
      const actor = state[side];
      const target = state[side === 'a' ? 'b' : 'a'];

      // Frozen → skip turn (unless it's a wild pet trying to flee).
      if (actor.status.freeze && actor.status.freeze > 0) {
        roundLog += `${side === 'a' ? a.emoji : b.emoji} ${actor.pet.name} is frozen and skips!\n`;
        actor.status.freeze = 0;
        delete actor.status.freeze;
        continue;
      }

      // Wild pet may flee.
      if (wild && side === 'b' && Math.random() < 0.25) {
        roundLog += `${b.emoji} ${b.pet.name} fled the scene!\n`;
        log.push(roundLog);
        winner = 'a';
        break;
      }

      actor.action = chooseAction(actor.stats);
      const res = resolveAttack(actor, target);
      target.hp = Math.max(0, target.hp - res.damage);

      // Apply status from the skill.
      if (actor.action.skill.status && Math.random() < (actor.action.skill.statusChance || 0)) {
        applyStatus(target.status, actor.action.skill.status, 2);
      }

      roundLog += `${side === 'a' ? a.emoji : b.emoji} ${actor.pet.name || ''} → ${res.description} `
        + `(${res.elementMult}× ${resolveElement(actor.stats.element, target.stats.element).relation}) `
        + `${res.crit ? '💥' : ''} -${res.damage} HP\n`;

      if (target.hp <= 0) {
        winner = side;
        break;
      }
    }

    log.push(roundLog);
    if (winner) break;
  }

  if (!winner) {
    // Draw on HP if time runs out.
    if (state.a.hp > state.b.hp) winner = 'a';
    else if (state.b.hp > state.a.hp) winner = 'b';
    else winner = 'draw';
  }

  return {
    winner,
    rounds: log.length,
    log,
    aFinal: { hp: state.a.hp, status: state.a.status },
    bFinal: { hp: state.b.hp, status: state.b.status },
    aStats,
    bStats,
  };
}

// ───────────────────────────────────────────────────────────
// Wild encounters (pethunt)
// ───────────────────────────────────────────────────────────

/**
 * Wild species pool — simple creatures a pet can hunt.
 */
const WILD_POOL = [
  { name: 'Gullet Rat', type: 'gulletrat', element: 'dark', basePower: 80, emoji: '🐀' },
  { name: 'Neon Hound', type: 'neonhound', element: 'light', basePower: 90, emoji: '🐕' },
  { name: 'Vault Sprite', type: 'vaultsprite', element: 'wind', basePower: 70, emoji: '🧚' },
  { name: 'Pigeon Golem', type: 'pigeongolem', element: 'earth', basePower: 100, emoji: '🐦' },
  { name: 'Sewer Troll', type: 'sewertroll', element: 'earth', basePower: 110, emoji: '🧌' },
  { name: 'Ash Cub', type: 'ashcub', element: 'fire', basePower: 85, emoji: '🔥' },
  { name: 'Glass Fin', type: 'glassfin', element: 'water', basePower: 95, emoji: '🐟' },
  { name: 'Void Wisp', type: 'voidwisp', element: 'dark', basePower: 120, emoji: '👻' },
  { name: 'Storm Pip', type: 'stormpip', element: 'wind', basePower: 100, emoji: '💨' },
  { name: 'Stone Mite', type: 'stonemite', element: 'earth', basePower: 75, emoji: '🪨' },
  { name: 'Frostling', type: 'frostling', element: 'water', basePower: 80, emoji: '❄️' },
  { name: 'Emberling', type: 'emberling', element: 'fire', basePower: 80, emoji: '🔥' },
  { name: 'Dusk Bat', type: 'duskbat', element: 'dark', basePower: 70, emoji: '🦇' },
  { name: 'Light Moth', type: 'lightmoth', element: 'light', basePower: 70, emoji: '🦋' },
  { name: 'Quicksand Lizard', type: 'quicksandlizard', element: 'earth', basePower: 90, emoji: '🦎' },
  { name: 'Driftwood Ghost', type: 'driftwoodghost', element: 'water', basePower: 85, emoji: '👻' },
  { name: 'Cinder Sprite', type: 'cindersprite', element: 'fire', basePower: 75, emoji: '🔥' },
  { name: 'Gale Hatchling', type: 'galehatchling', element: 'wind', basePower: 80, emoji: '💨' },
];

/**
 * Pick a wild species, scaled to the hunting pet's strength.
 * @param {object} pet — the hunting pet
 * @returns {{name:string,type:string,element:string,basePower:number,emoji:string,level:number}}
 */
function wildSpecies(pet) {
  const pool = WILD_POOL;  // eslint-disable-line no-unused-vars
  const base = pool[Math.floor(Math.random() * pool.length)];
  const hunterPower = battlePower(pet);
  // Wild pet level ranges so it's a fair but risky fight.
  const level = Math.max(1, Math.floor(Math.random() * 3) + (hunterPower > 500 ? 3 : 1));
  const basePower = (Number(base.basePower) || 50) * (1 + (level - 1) * 0.3);
  return {
    name: base.name,
    type: base.type,
    element: base.element,
    basePower: Math.floor(basePower),
    emoji: base.emoji,
    level,
  };
}

/**
 * Chance that a wild pet is caught after winning the battle.
 * Higher when the hunter's power greatly exceeds the wild pet's.
 * @param {object} hunterPet
 * @param {object} wild — wild species data
 * @returns {number} 0–1
 */
function catchChance(hunterPet, wild) {
  const hunterPower = battlePower(hunterPet);
  const wildPower = Math.max(1, (Number(wild.basePower) || 50) + (Number(wild.level) || 1) * 10);
  const ratio = Math.min(3, hunterPower / wildPower);
  // ratio 1× → 40%, ratio 3× → 85%
  return Math.min(0.9, 0.3 + (ratio - 1) * 0.275);
}

// ───────────────────────────────────────────────────────────
// Guild boss (gym)
// ───────────────────────────────────────────────────────────

/**
 * The weekly guild boss. It has a shared health pool that resets daily.
 * Stored on the Group schema's petArena field by the command layer.
 */
const GYM_BOSS = {
  name: 'The Vault Cannon',
  emoji: '💥',
  element: 'dark',
  basePower: 5000,
  maxHp: 5000,
  // Rewards for the hunter who dealt the final blow.
  baseReward: 500,
  coinMult: 20,
  xpReward: 500,
};

/**
 * Current boss state from a group doc. Creates defaults if absent.
 * @param {object|null} group
 * @param {number} now
 * @returns {{name:string,emoji:string,element:string,hp:number,maxHp:number,active:boolean,lastReset:Date}}
 */
function gymBoss(group, now = Date.now()) {
  if (!group || !group.gymBoss) {
    return {
      ...GYM_BOSS,
      hp: GYM_BOSS.maxHp,
      active: false,
      lastReset: new Date(),
    };
  }
  return group.gymBoss;
}

/**
 * Check whether the gym boss needs a daily reset.
 * @param {object} boss
 * @param {number} now
 */
function gymNeedsReset(boss, now = Date.now()) {
  if (!boss || !boss.active) return false;
  const last = boss.lastReset ? new Date(boss.lastReset).getTime() : 0;
  return now - last >= 24 * 3600 * 1000;
}

/**
 * Simulate one volley against the gym boss.
 * @param {object} hunterPet
 * @param {object} boss
 * @returns {{bossHp:number, damage:number, crit:boolean, streak:number, elementMult:number}}
 */
function gymVolley(hunterPet, boss) {
  const stats = battleStats(hunterPet);
  const skill = randomSkill(hunterPet);
  const tierMult = skillTierMult(hunterPet.skillTier || 0);
  const elem = resolveElement(stats.element, boss.element || 'dark');
  const base = stats.atk * skill.mult * tierMult * elem.mult;
  let damage = base * ATTACK_POWER;
  const crit = Math.random() < stats.crit;
  if (crit) damage *= CRIT_MULT;
  damage = Math.max(1, Math.round(damage));

  const bossHp = Math.max(0, Number(boss.hp || 0) - damage);
  return { bossHp, damage, crit, elementMult: elem.mult, streak: 0 };
}

/**
 * Rewards for a boss volley.
 * @param {number} damage — damage dealt this volley
 * @param {number} streak — consecutive volleys in the fight
 * @param {number} [hunterPower]
 * @returns {{coins:number, xp:number}}
 */
function gymRewards(damage, streak, hunterPower) {
  const base = GYM_BOSS.baseReward;
  const streakBonus = 1 + (Number(streak) || 0) * 0.1;
  const coins = Math.floor(base * streakBonus * (0.8 + Math.random() * 0.4));
  const xp = Math.floor(GYM_BOSS.xpReward * streakBonus * (0.8 + Math.random() * 0.4));
  return { coins, xp };
}

/**
 * Clear the gym boss (mark inactive, reset HP).
 * Mutates the boss object in place.
 */
function clearGymBoss(boss) {
  if (!boss) return;
  boss.hp = 0;
  boss.active = false;
  boss.lastReset = new Date();
}

/**
 * Internal: force a full HP reset (daily).
 */
function _resetGym(boss) {
  if (!boss) return { ...GYM_BOSS, hp: GYM_BOSS.maxHp, active: false, lastReset: new Date() };
  boss.hp = GYM_BOSS.maxHp;
  boss.active = false;
  boss.lastReset = new Date();
  return boss;
}

// ───────────────────────────────────────────────────────────
// Canvas cards (lazy — text fallback when canvas unavailable)
// ───────────────────────────────────────────────────────────

let canvasCache = null;
let canvasTried = false;

/**
 * Lazily load the canvas module. Returns null on any failure.
 */
function canvas() {
  if (canvasTried) return canvasCache;
  canvasTried = true;
  try {
    canvasCache = require('./canvas');
  } catch {
    canvasCache = null;
  }
  return canvasCache;
}

/**
 * Render a battle result card.
 * Returns a PNG data URL, or null when canvas is unavailable.
 * @param {object} result — simulateBattle result
 * @param {object} a — { name, emoji }
 * @param {object} b — { name, emoji }
 */
function battleCard(result, a, b) {
  const c = canvas();
  if (!c || !c.available()) return null;
  try {
    const surface = c.create(900, 500);
    if (!surface) return null;
    const { ctx } = surface;
    const { theme } = c;

    // Background
    const grad = ctx.createLinearGradient(0, 0, 900, 500);
    grad.addColorStop(0, theme.bg1);
    grad.addColorStop(1, theme.bg2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 900, 500);

    // Title
    ctx.fillStyle = theme.text;
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      `${a.emoji} vs ${b.emoji}  ·  ${result.winner === 'a' ? a.name : b.name} wins`,
      450, 60,
    );

    // HP bars
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'left';
    const aPct = Math.max(0, result.aFinal.hp) / result.aStats.hp;
    const bPct = Math.max(0, result.bFinal.hp) / result.bStats.hp;
    ctx.fillText(`${a.emoji} ${a.name}`, 40, 120);
    ctx.fillStyle = '#444';
    ctx.fillRect(40, 140, 360, 24);
    ctx.fillStyle = '#4CAF50';
    ctx.fillRect(40, 140, 360 * aPct, 24);
    ctx.fillStyle = theme.text;
    ctx.fillText(`${result.aFinal.hp}/${result.aStats.hp} HP`, 40, 165);

    ctx.fillText(`${b.emoji} ${b.name}`, 40, 220);
    ctx.fillStyle = '#444';
    ctx.fillRect(40, 240, 360, 24);
    ctx.fillStyle = '#e91e63';
    ctx.fillRect(40, 240, 360 * bPct, 24);
    ctx.fillStyle = theme.text;
    ctx.fillText(`${result.bFinal.hp}/${result.bStats.hp} HP`, 40, 265);

    // Battle log
    ctx.font = '14px monospace';
    ctx.textAlign = 'left';
    let y = 310;
    const lines = result.log.slice(-8);
    for (const line of lines) {
      const txt = String(line).replace(/\*\*/g, '').replace(/Round \d+/, 'R');
      ctx.fillText(txt.slice(0, 70), 40, y);
      y += 18;
    }

    return c.toBuffer(surface);
  } catch (err) {
    return null;
  }
}

/**
 * Render a single pet's stat card.
 * Returns a PNG data URL, or null when canvas is unavailable.
 */
function paintPet(pet) {
  const c = canvas();
  if (!c || !c.available()) return null;
  try {
    const surface = c.create(900, 400);
    if (!surface) return null;
    const { ctx } = surface;
    const { theme } = c;

    const grad = ctx.createLinearGradient(0, 0, 900, 400);
    grad.addColorStop(0, theme.bg1);
    grad.addColorStop(1, theme.bg2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 900, 400);

    ctx.fillStyle = theme.text;
    ctx.font = 'bold 44px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${pet.emoji || '🐉'} ${pet.name}`, 450, 80);

    const stats = battleStats(pet);
    ctx.font = '28px sans-serif';
    ctx.fillText(`${ELEMENT_EMOJI[pet.element] || '❓'} ${ELEMENT_FOR[pet.element] || 'Unknown'}`, 450, 150);
    ctx.fillText(`⚡ Power: ${stats.power}  HP: ${stats.hp}  SPD: ${stats.spd}`, 450, 210);

    const skill = skillList(pet);
    ctx.fillText(`Skills: ${skill.map((s) => s.emoji + s.name).join(' / ')}`, 450, 270);

    const st = staminaOf(pet);
    ctx.fillText(`Stamina: ${'⚡'.repeat(st)}${'◯'.repeat(STAMINA_MAX - st)}  Tier: ${pet.skillTier || 0}`, 450, 330);

    return c.toBuffer(surface);
  } catch (err) {
    return null;
  }
}

// ───────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function clamp(v) {
  return Math.max(0, Math.floor(Number(v) || 0));
}

// ───────────────────────────────────────────────────────────
// Module exports
// ───────────────────────────────────────────────────────────

module.exports = {
  // Elements
  ELEMENTS,
  CYCLE,
  ELEMENT_EMOJI,
  ELEMENT_FOR,
  resolveElement,
  elementFor,
  elementLabel,

  // Skills
  SKILLS_BY_ELEMENT,
  ALL_SKILLS,
  skillList,
  randomSkill,
  skillTierMult,
  SKILL_TIER_MAX,

  // Evolution
  EVOLVES,
  xpForLevel,
  grantXp,
  evolveIfReady,

  // Stats
  ATTACK_POWER,
  CRIT_CHANCE,
  CRIT_MULT,
  GUARD_MULT,
  MAX_BATTLE_ROUNDS,
  battlePower,
  battleStats,
  hpBar,

  // Stamina
  STAMINA_MAX,
  STAMINA_RECHARGE_MS,
  staminaOf,
  setStamina,
  restoreStamina,
  canBattle,
  spendStamina,

  // Status
  STATUS_TEXT,
  statusText,
  applyStatus,
  tickStatuses,

  // Combat
  chooseAction,
  resolveAttack,
  simulateBattle,

  // Wild / hunt
  WILD_POOL,
  wildSpecies,
  catchChance,

  // Gym boss
  GYM_BOSS,
  gymBoss,
  gymNeedsReset,
  gymVolley,
  gymRewards,
  clearGymBoss,
  _resetGym,

  // Canvas
  battleCard,
  paintPet,

  // Helpers
  rand,
  pick,
  clamp,
};
