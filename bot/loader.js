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

const MODULE_COUNT = 10;
const COMMANDS_DIR = path.join(__dirname, '..', 'commands');

/** Required fields every command must define. */
const REQUIRED = ['name', 'category', 'execute'];

/**
 * @returns {{registry: Map<string,object>, aliases: Map<string,string>, count:number, categories:Map<string,number>}}
 */
function loadCommands(dir = COMMANDS_DIR) {
  const registry = new Map();
  const aliases = new Map();
  const categories = new Map();
  let loaded = 0;
  let skipped = 0;

  for (let i = 1; i <= MODULE_COUNT; i += 1) {
    const file = `cmds_${i}.js`;
    const full = path.join(dir, file);

    if (!fs.existsSync(full)) {
      log(`[LOADER] ${file} not found — skipping`);
      continue;
    }

    let mod;
    try {
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
      cmd.cooldown = Number.isFinite(Number(cmd.cooldown)) ? Number(cmd.cooldown) : 5;
      cmd.permission = cmd.permission || 'all';
      cmd.module = file.replace('.js', '');

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
          continue;
        }
        aliases.set(alias, cmd.name);
      }
    }
  }

  // Global access for commands that want registry/config without importing.
  global.ikon = { registry, aliases, categories, config: require('../config') };

  log(`[LOADER] Loaded ${loaded} commands from ${MODULE_COUNT} module(s), ${aliases.size} aliases, ${categories.size} categories`
    + (skipped ? `, ${skipped} skipped` : ''));

  return { registry, aliases, categories, count: loaded };
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

module.exports = { loadCommands, findCommand, listCommands, MODULE_COUNT, COMMANDS_DIR };
