'use strict';

/**
 * Command loader (LOADER stage).
 *
 * Scans commands/cmds_1.js … cmds_10.js. Each module must export a plain array of
 * command objects shaped like:
 *   { name, aliases, category, description, usage, cooldown, permission, execute }
 *
 * No factories. No plugin wrappers. No legacy loader.
 */

const fs = require('fs');
const path = require('path');
const { log, error } = require('./helpers');
const deckMeta = require('./categories');

const MODULE_COUNT = 10;
const COMMANDS_DIR = path.join(__dirname, '..', 'commands');

/**
 * Minimum seconds a command is allowed to carry.
 *
 * The old floor was 3s, and 145 of the 352 commands sat at or under 10s. That is
 * short enough to be spam in a busy group: every one of those commands writes to
 * the database and usually sends more than one reply, so a person holding down
 * a key produces a burst of messages and a burst of writes — and, before the
 * per-user lock, a burst of payouts.
 *
 * 8s is not arbitrary. It is about the time it takes to notice a wrong number in
 * a reply and decide not to run it again, which is the cost a cooldown is
 * actually meant to charge.
 */
const MIN_COOLDOWN = 8;

/**
 * The cooldown ladder, as an exact authored value -> effective value map.
 *
 * Two rules this table has to obey, and both were learned the hard way:
 *
 * 1. Exact keys, never thresholds. A threshold ladder ("anything <= 10 becomes
 *    20") is not idempotent, and the loader runs on `!reload`.
 * 2. No output may also be an input. If 15 is both "a value somebody wrote" and
 *    "a value the ladder produces", then scaling 3 gives 15 and scaling again
 *    gives 25 — and the number creeps upward on every pass. The rungs below are
 *    therefore chosen so that {outputs} and {inputs} are disjoint, which makes
 *    the ladder idempotent by construction: scaling 3 twice gives 12 twice.
 *
 * Anything at or above two minutes is an action limit rather than a rate limit —
 * `!daily` (24h), `!heist` (1h) — and is absent from this table on purpose, so
 * it is never touched.
 */
const COOLDOWN_TIERS = new Map([
  [3, 12],    // !help and other trivial queries
  [5, 12],
  [10, 18],   // the bulk of the casual commands
  [15, 18],
  [20, 24],
  [30, 36],
  [45, 50],
  [60, 70],   // gambling and the slower economy commands
]);

/**
 * Apply the ladder and the floor.
 *
 * @param {number} sec as authored
 * @returns {number}
 */
function scaleCooldown(sec) {
  const n = Number.isFinite(Number(sec)) ? Number(sec) : 5;
  const scaled = COOLDOWN_TIERS.get(n);
  if (scaled !== undefined) return scaled;
  // Not a rung on the ladder: an action limit, or a value somebody chose
  // deliberately. Leave it, but hold it to the floor.
  return Math.max(MIN_COOLDOWN, n);
}

/** Required fields every command must define. */
const REQUIRED = ['name', 'category', 'execute'];

/**
 * The leading emoji of a description, as one user-visible character.
 *
 * This is a grapheme cluster and not a code point: `✍️` is the pencil plus a
 * variation selector, and slicing one code point off leaves an invisible
 * selector floating in front of the text.
 *
 * @param {string} text
 * @returns {string} the emoji, or '' when there is not one
 */
function helpIcon(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const first = Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s))[0];
    return first && /^\p{Extended_Pictographic}/u.test(first.segment) ? first.segment : '';
  }
  return /^\p{Extended_Pictographic}/u.test(s[0]) ? s[0] : '';
}

/**
 * When true, command files are evicted from require.cache before being loaded,
 * so `!reload` picks up edits without a process restart.
 */
let hotReload = false;

/** Enable/disable cache eviction. @returns {boolean} the new state */
function setHotReload(on) {
  hotReload = Boolean(on);
  return hotReload;
}

/**
 * @returns {{registry: Map<string,object>, aliases: Map<string,string>, count:number, categories:Map<string,number>}}
 */
function loadCommands(dir = COMMANDS_DIR) {
  const registry = new Map();
  const aliases = new Map();
  const categories = new Map();
  // A category with no row in bot/categories.js still loads — it must not break
  // help for everybody else — but it is reported, because it will render as a
  // bare word in the deck index.
  const unknownCategories = new Set();
  let loaded = 0;
  let skipped = 0;
  // Aliases that were refused because another command already owns the word.
  // Collected rather than only logged, so `bot/check.js` and `!check` can turn
  // them into a visible failure instead of a line in a log nobody reads.
  const conflicts = [];

  for (let i = 1; i <= MODULE_COUNT; i += 1) {
    const file = `cmds_${i}.js`;
    const full = path.join(dir, file);

    if (!fs.existsSync(full)) {
      log(`[LOADER] ${file} not found — skipping`);
      continue;
    }

    let mod;
    try {
      if (hotReload) {
        // Drop the cached copy so an edited file is actually re-read.
        delete require.cache[require.resolve(full)];
      }
      // eslint-disable-next-line global-require, import/no-dynamic-require
      mod = require(full);
    } catch (err) {
      error(`[LOADER] ${file} failed to load: ${err.message}`);
      skipped += 1;
      continue;
    }

    if (!Array.isArray(mod)) {
      error(`[LOADER] ${file} must export a plain array — skipping`);
      skipped += 1;
      continue;
    }

    for (const cmd of mod) {
      if (!cmd || typeof cmd !== 'object' || typeof cmd.execute !== 'function') {
        error(`[LOADER] ${file} contains an invalid command entry — skipping`);
        skipped += 1;
        continue;
      }

      const missing = REQUIRED.filter((f) => !cmd[f]);
      if (missing.length) {
        error(`[LOADER] ${file} command "${cmd.name || 'unnamed'}" missing: ${missing.join(', ')} — skipping`);
        skipped += 1;
        continue;
      }

      cmd.name = String(cmd.name).toLowerCase();
      cmd.aliases = Array.isArray(cmd.aliases) ? cmd.aliases.map((a) => String(a).toLowerCase()) : [];
      cmd.category = cmd.category || 'misc';
      cmd.description = cmd.description || 'No description yet';
      cmd.usage = cmd.usage || `${'!'}${cmd.name}`;
      cmd.cooldown = scaleCooldown(cmd.cooldown);
      cmd.permission = cmd.permission || 'all';
      cmd.module = file.replace('.js', '');

      // Give every command an icon, so the whole bot presents the same way
      // without 352 edits to descriptions that already read well. A command that
      // leads its own description with an emoji keeps it; one that does not
      // inherits its deck's.
      if (!deckMeta.get(cmd.category)) unknownCategories.add(cmd.category);
      cmd.icon = String(cmd.icon || '').trim()
        || (helpIcon(cmd.description) || deckMeta.get(cmd.category).emoji);

      // `hint` is deliberately NOT inherited from the deck. A deck hint printed
      // under 35 different commands is noise, and a wrong one is worse: telling
      // someone reading `!ping` about `!adminon` teaches them that hints are not
      // worth reading. A hint is authored per command, for the commands where
      // there is something non-obvious to say.
      cmd.hint = String(cmd.hint || '').trim();

      if (registry.has(cmd.name)) {
        error(`[LOADER] Duplicate command "${cmd.name}" in ${file} — keeping the first one`);
        skipped += 1;
        continue;
      }

      registry.set(cmd.name, cmd);
      loaded += 1;
      categories.set(cmd.category, (categories.get(cmd.category) || 0) + 1);

      for (const alias of cmd.aliases) {
        if (aliases.has(alias)) {
          error(`[LOADER] Duplicate alias "${alias}" — keeping the first one`);
          conflicts.push(`${cmd.name}: alias "${alias}" is already an alias of ${aliases.get(alias)}`);
          continue;
        }
        // A NAME is not an alias, and findCommand() checks the registry first,
        // so an alias that shadows a command name is registered and then can
        // never be reached: `!xp` keeps running the real `xp` command while the
        // alias is dead code that still reads like a working spelling.
        if (registry.has(alias)) {
          error(`[LOADER] Alias "${alias}" on ${cmd.name} is already the command name of "${alias}" — alias ignored`);
          conflicts.push(`${cmd.name}: alias "${alias}" is already the name of a command`);
          continue;
        }
        aliases.set(alias, cmd.name);
      }
    }
  }

  // A command declared AFTER an alias claimed its name leaves that alias
  // unreachable, and the check above could not see it: at the time the alias
  // was registered, that name did not exist yet. Re-check once everything is
  // loaded, so the order of the module files cannot decide whether a spelling
  // works.
  for (const [alias, owner] of [...aliases.entries()]) {
    if (registry.has(alias)) {
      error(`[LOADER] Alias "${alias}" on ${owner} is shadowed by the command "${alias}" — alias ignored`);
      conflicts.push(`${owner}: alias "${alias}" is shadowed by the command of the same name`);
      aliases.delete(alias);
    }
  }

  // Global access for commands that want registry/config without importing.
  global.ikon = { registry, aliases, categories, config: require('../config') };

  if (unknownCategories.size) {
    error(`[LOADER] ${unknownCategories.size} category key(s) have no display metadata: ${[...unknownCategories].join(', ')} — add them to bot/categories.js`);
  }

  log(`[LOADER] Loaded ${loaded} commands from ${MODULE_COUNT} module(s), ${aliases.size} aliases, ${categories.size} categories`
    + (skipped ? `, ${skipped} skipped` : ''));

  return { registry, aliases, categories, count: loaded, conflicts };
}

/** Look up a command by name or alias. */
function findCommand(name, registry, aliases) {
  if (!name) return null;
  const key = String(name).toLowerCase();
  return registry.get(key) || registry.get(aliases.get(key)) || null;
}

/** All commands in a category. */
function listCommands(category, registry) {
  const all = [...registry.values()];
  if (!category || category === 'all') return all;
  return all.filter((c) => c.category === category);
}

module.exports = {
  loadCommands, findCommand, listCommands, setHotReload, scaleCooldown,
  MODULE_COUNT, COMMANDS_DIR, MIN_COOLDOWN, COOLDOWN_TIERS,
};
