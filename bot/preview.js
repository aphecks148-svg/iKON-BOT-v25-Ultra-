'use strict';

/**
 * Renders each command's reply so the output can be eyeballed.
 *   node bot/preview.js help version botinfo listmods
 */

process.env.ADMIN_IDS = process.env.ADMIN_IDS || '999000111';
process.env.BOT_PREFIX = '!';

const loader = require('./loader');
const cfg = require('../config');

const loaded = loader.loadCommands(`${__dirname}/../commands`);
const registry = new Map();
const aliases = new Map();
loaded.registry.forEach((v, k) => registry.set(k, v));
loaded.aliases.forEach((v, k) => aliases.set(k, v));

const ARGS = {
  help: ['ping'],
  echo: ['hello', 'world'],
  setprefix: ['?'],
  ban: ['999000222', 'spamming'],
};

const api = {
  async sendMessage(p) { return { messageID: 'm' }; },
  async react() { return true; },
  async getUserInfo(uid) { return { name: `Aphecks ${uid.slice(-2)}` }; },
  async getThreadInfo() {
    return { threadTitle: 'iKON Crew', adminIDs: ['999000111'], participantIDs: Array(12).fill('x') };
  },
};

const out = [];
const reply = async (text) => { out.push(text); };

const want = process.argv.slice(2);
const list = (want.length ? want : [...registry.keys()]).sort();

(async () => {
  for (const name of list) {
    const cmd = registry.get(aliases.get(name) || name);
    if (!cmd) { console.log(`\n### ${name} — NOT FOUND`); continue; }
    out.length = 0;
    let err = null;
    try {
      await cmd.execute({
        api,
        event: { threadID: 't1', messageID: 'm1', senderID: '999000111', isGroup: true, mentions: {} },
        args: ARGS[cmd.name] || [],
        config: cfg,
        registry,
        ai: { available: () => false, ask: async () => null },
        reply,
        react: async () => {},
        userDoc: {
          uid: '999000111', name: 'Aphecks', level: 12, xp: 3400, coins: 15420, bank: 89000,
          reputation: 42, prestige: 1, lastSeen: new Date(),
          stats: { messages: 1843, commandsUsed: 267 },
        },
      });
    } catch (e) { err = e.message; }
    console.log(`\n${'━'.repeat(46)}\n### ${cmd.name}  →  ${cmd.usage}   [${cmd.permission}]`);
    if (err) console.log(`❌ ERROR: ${err}`);
    out.forEach((t) => console.log(String(t)));
    if (!out.length) console.log('(no output)');
  }
})();
