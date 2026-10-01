'use strict';

/**
 * Registry validation — shared by `node bot/check.js` and the `!check` command.
 *
 * Verifies the cmds_1..10 contract:
 *   - every file exports a plain array
 *   - every command has name/aliases/category/description/usage/cooldown/permission/execute
 *   - names and aliases are unique
 *   - usage always starts with the configured prefix
 */

const path = require('path');
process.env.BOT_PREFIX = process.env.BOT_PREFIX || '!';

const loader = require('./loader');
const config = require('../config');

const SHAPE = ['name', 'aliases', 'category', 'description', 'usage', 'cooldown', 'permission', 'execute'];
const MODULES = 10;
const TARGET_PER_MODULE = 35;

/**
 * Validate a loaded registry.
 * @param {Map} registry
 * @returns {{problems:string[], categories:number}}
 */
function validate(registry) {
  const problems = [];
  const seenNames = new Set();

  for (const cmd of registry.values()) {
    for (const field of SHAPE) {
      if (cmd[field] === undefined || cmd[field] === null) problems.push(`${cmd.name || 'unnamed'}: missing "${field}"`);
    }
    if (typeof cmd.execute !== 'function') problems.push(`${cmd.name}: execute is not a function`);
    if (!Number.isFinite(Number(cmd.cooldown))) problems.push(`${cmd.name}: cooldown is not a number`);
    if (!Array.isArray(cmd.aliases)) problems.push(`${cmd.name}: aliases must be an array`);
    if (typeof cmd.usage === 'string' && !cmd.usage.startsWith(config.PREFIX)) {
      problems.push(`${cmd.name}: usage "${cmd.usage}" does not start with "${config.PREFIX}"`);
    }
    if (Array.isArray(cmd.aliases) && cmd.aliases.includes(cmd.name)) {
      problems.push(`${cmd.name}: alias duplicates its own name`);
    }
    if (seenNames.has(cmd.name)) problems.push(`duplicate command name "${cmd.name}"`);
    seenNames.add(cmd.name);
  }

  return { problems, categories: new Set([...registry.values()].map((c) => c.category)).size };
}

/** Command count per module key (cmds_1 … cmds_10). */
function perModule(registry) {
  const all = [...registry.values()];
  const out = [];
  for (let i = 1; i <= MODULES; i += 1) {
    const key = `cmds_${i}`;
    out.push({ key, count: all.filter((c) => c.module === key).length });
  }
  return out;
}

/** Count every alias across the registry. */
function aliasCount(registry) {
  let n = 0;
  for (const cmd of registry.values()) n += cmd.aliases.length;
  return n;
}

module.exports = {
  SHAPE, MODULES, TARGET_PER_MODULE, validate, perModule, aliasCount, config,
};

/* Run as a script: node bot/check.js */
if (require.main === module) {
  const loaded = loader.loadCommands(path.join(__dirname, '..', 'commands'));
  const { problems, categories } = validate(loaded.registry);
  const modules = perModule(loaded.registry);

  console.log('\n=== iKON-BOT registry check ===\n');
  console.log(`  prefix        : ${config.PREFIX}`);
  console.log(`  commands      : ${loaded.registry.size}`);
  console.log(`  aliases       : ${loaded.aliases.size}`);
  console.log(`  categories    : ${categories}`);
  console.log(`  target        : ${MODULES} modules x ${TARGET_PER_MODULE} = ${MODULES * TARGET_PER_MODULE} commands`);
  console.log('\n  per module:');
  modules.forEach(({ key, count }) => {
    const filled = Math.round((count / TARGET_PER_MODULE) * 24);
    const bar = `${'█'.repeat(Math.min(24, filled))}${'░'.repeat(Math.max(0, 24 - filled))}`;
    console.log(`    ${key.padEnd(9)} ${String(count).padStart(3)}/${TARGET_PER_MODULE}  ${bar}`);
  });

  if (problems.length) {
    console.log(`\n  ❌ ${problems.length} PROBLEM(S):`);
    problems.forEach((p) => console.log(`    - ${p}`));
    console.log('');
    process.exit(1);
  }
  console.log('\n  ✅ registry OK — every command matches the required shape\n');
}
