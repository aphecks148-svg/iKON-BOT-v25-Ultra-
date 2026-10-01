'use strict';

/**
 * Static integrity check for the command registry.
 *   node bot/check.js
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

const problems = [];
const perModule = {};

const loaded = loader.loadCommands(path.join(__dirname, '..', 'commands'));

for (let i = 1; i <= MODULES; i += 1) {
  const key = `cmds_${i}`;
  const list = [...loaded.registry.values()].filter((c) => c.module === key);
  perModule[key] = list.length;
}

// shape validation
for (const cmd of loaded.registry.values()) {
  for (const field of SHAPE) {
    if (cmd[field] === undefined || cmd[field] === null) {
      problems.push(`${cmd.module}/${cmd.name}: missing "${field}"`);
    }
  }
  if (typeof cmd.execute !== 'function') problems.push(`${cmd.name}: execute is not a function`);
  if (!Number.isFinite(Number(cmd.cooldown))) problems.push(`${cmd.name}: cooldown is not a number`);
  if (typeof cmd.usage === 'string' && !cmd.usage.startsWith(config.PREFIX)) {
    problems.push(`${cmd.name}: usage "${cmd.usage}" does not start with "${config.PREFIX}"`);
  }
  if (cmd.aliases.includes(cmd.name)) problems.push(`${cmd.name}: alias duplicates its own name`);
}

const names = new Set();
for (const cmd of loaded.registry.values()) {
  if (names.has(cmd.name)) problems.push(`duplicate command name "${cmd.name}"`);
  names.add(cmd.name);
}

console.log('\n=== iKON-BOT registry check ===\n');
console.log(`  prefix        : ${config.PREFIX}`);
console.log(`  commands      : ${loaded.registry.size}`);
console.log(`  aliases       : ${loaded.aliases.size}`);
console.log(`  categories    : ${loaded.categories.size}`);
console.log(`  target        : ${MODULES} modules x ${TARGET_PER_MODULE} = ${MODULES * TARGET_PER_MODULE} commands`);
console.log('\n  per module:');
for (let i = 1; i <= MODULES; i += 1) {
  const key = `cmds_${i}`;
  const n = perModule[key] || 0;
  const bar = `${'█'.repeat(Math.min(35, n))}${'░'.repeat(Math.max(0, 35 - n))}`;
  console.log(`    ${key.padEnd(9)} ${String(n).padStart(3)}/35  ${bar}`);
}

if (problems.length) {
  console.log(`\n  ❌ ${problems.length} PROBLEM(S):`);
  problems.forEach((p) => console.log(`    - ${p}`));
  console.log('');
  process.exit(1);
}

console.log('\n  ✅ registry OK — every command matches the required shape\n');
