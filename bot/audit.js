'use strict';

/**
 * Completeness audit for every command in the registry.
 *
 *   node bot/audit.js            every module
 *   node bot/audit.js cmds_3     one module
 *
 * check.js proves a command is shaped right and exec-all.js proves it does
 * not throw. Neither of them can see that a command is only HALF written —
 * that its usage line advertises a command that does not exist, or that it
 * draws a card and then forgets to send it. Those are the gaps this file
 * looks for, and they are the ones a person actually notices.
 *
 * Every finding is a defect, not a style opinion, except the missing hint,
 * which is reported separately because a command without one still works.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.ADMIN_IDS = process.env.ADMIN_IDS || '999000111';
process.env.BOT_PREFIX = process.env.BOT_PREFIX || '!';

const fs = require('fs');
const path = require('path');

const loader = require('./loader');
const config = require('../config');

const COMMANDS_DIR = path.join(__dirname, '..', 'commands');
const PREFIX = config.BOT_PREFIX || '!';

/** The files a module audit may be pointed at. */
const MODULES = fs.readdirSync(COMMANDS_DIR)
  .filter((f) => /^cmds_\d+\.js$/.test(f))
  .sort();

/**
 * The command word a usage line tells the user to type.
 *
 * `!petrename <name> <new name>` -> `petrename`
 *
 * @param {string} usage
 * @returns {string} the word, or '' when there is not one
 */
function usageWord(usage) {
  const s = String(usage || '').trim();
  if (!s) return '';
  const body = s.startsWith(PREFIX) ? s.slice(PREFIX.length) : s;
  return body.split(/\s+/)[0].replace(/[^\w]/g, '');
}

/** Does this description open with an emoji? */
function hasEmoji(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const first = Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s))[0];
    return Boolean(first && /^\p{Extended_Pictographic}/u.test(first.segment));
  }
  return /^\p{Extended_Pictographic}/u.test(s[0]);
}

/**
 * A call that produces a canvas card.
 *
 * The point is a real card BUILDER, not the word "card": a comment about a
 * card, a deck of playing cards and a sentence about somebody else's card all
 * say "card" and none of them build one. `cards.realName()` is a name lookup,
 * not a card, so only the builders in bot/cards.js count.
 */
const BUILDS_A_CARD = /\bcards\.(duoCard|pokemonCard|userCard|boardCard|pairCard|arrivalCard|botCard)\s*\(|\bcanvasKit\.create\s*\(|\b(battle|duo|board|user|pokemon|pair|arrival|bot)Card\s*\(/;

/**
 * A call that puts a picture in front of somebody.
 *
 * `attachment` is the payload key. The rest are the helpers that do the
 * sending for a command, so a command that calls one of them is fine.
 */
const SENDS_A_CARD = /attachment|\b(sendPhoto|sendImage|sendCard|sendPicture|art|picture|photo)\s*\(/;

/**
 * Audit one command.
 *
 * @param {object} cmd the command
 * @param {Set<string>} known every word that answers to a command
 * @returns {{defects: string[], notes: string[]}}
 */
function auditCommand(cmd, known) {
  const defects = [];
  const notes = [];
  const name = cmd.name;

  if (!cmd.description || !String(cmd.description).trim()) {
    defects.push('no description');
  } else if (!hasEmoji(cmd.description)) {
    defects.push(`description has no emoji: "${String(cmd.description).slice(0, 48)}"`);
  }

  if (!cmd.usage || !String(cmd.usage).trim()) {
    defects.push('no usage');
  } else {
    const u = String(cmd.usage).trim();
    if (!u.startsWith(PREFIX)) defects.push(`usage does not start with "${PREFIX}": ${u}`);
    // The one that matters: a usage line that names a command nobody can type.
    const word = usageWord(u);
    if (word && word !== name && !cmd.aliases.includes(word) && !known.has(word)) {
      defects.push(`usage tells the user to type "!${word}", which is not a command`);
    }
  }

  if (!Array.isArray(cmd.aliases)) defects.push('aliases is not an array');
  if (!cmd.permission) defects.push('no permission');
  if (!Number.isFinite(Number(cmd.cooldown))) defects.push('cooldown is not a number');
  if (!cmd.category) defects.push('no category');
  if (typeof cmd.execute !== 'function') defects.push('execute is not a function');

  // A command that builds a canvas card and never sends it has built it for
  // nobody. Only a real card BUILDER counts: the word "card" also turns up in
  // comments, in a deck of playing cards, and in a sentence about a card
  // somebody else drew, and flagging those was fifteen false positives.
  const body = typeof cmd.execute === 'function' ? String(cmd.execute) : '';
  if (BUILDS_A_CARD.test(body) && !SENDS_A_CARD.test(body)) {
    defects.push('builds a card but never sends one');
  }

  if (!cmd.hint || !String(cmd.hint).trim()) {
    notes.push('no hint');
  }

  return { defects, notes };
}

const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = want.length
  ? MODULES.filter((f) => want.some((w) => f.includes(w)))
  : MODULES;

if (!files.length) {
  console.error(`no module matches ${want.join(', ')}`);
  process.exit(1);
}

const loaded = loader.loadCommands(COMMANDS_DIR);
const known = new Set(loaded.registry.keys());

// Which file each command came from, so the report can be read per module.
const home = new Map();
for (const file of files) {
  const list = require(path.join(COMMANDS_DIR, file));
  for (const cmd of list) home.set(cmd.name, file);
}

let defectCount = 0;
let noteCount = 0;
const perFile = [];

for (const file of files) {
  const list = require(path.join(COMMANDS_DIR, file));
  const defects = [];
  const notes = [];

  for (const cmd of list) {
    const { defects: d, notes: n } = auditCommand(cmd, known);
    if (d.length) defects.push({ name: cmd.name, d });
    if (n.length) notes.push({ name: cmd.name, n });
  }

  perFile.push({ file, count: list.length, defects, notes });
  defectCount += defects.reduce((n, x) => n + x.d.length, 0);
  noteCount += notes.length;
}

console.log('\n=== iKON command audit ===\n');
console.log(`  prefix     : ${PREFIX}`);
console.log(`  commands   : ${loaded.registry.size}`);
console.log(`  modules    : ${files.join(', ')}`);
console.log(`  defects    : ${defectCount}`);
console.log(`  notes      : ${noteCount} (a command without a hint still works)`);

for (const { file, count, defects, notes } of perFile) {
  console.log(`\n  ${file}  (${count} commands)`);
  if (!defects.length && !notes.length) {
    console.log('    ✅ nothing to fix');
    continue;
  }
  for (const { name, d } of defects) {
    d.forEach((x) => console.log(`    ❌ ${name} — ${x}`));
  }
  for (const { name, n } of notes) {
    n.forEach((x) => console.log(`    ⚠️  ${name} — ${x}`));
  }
}

console.log('');
process.exit(defectCount ? 1 : 0);
