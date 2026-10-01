'use strict';

/**
 * Exercises every command in the registry against a MOCKED ws3-fca api.
 * Proves each handler runs without throwing and produces a reply.
 *
 *   node bot/exec-all.js
 *
 * Pass args to test specific commands, e.g. node bot/exec-all.js help ban
 */

const assert = require('assert');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.ADMIN_IDS = process.env.ADMIN_IDS || '999000111';
process.env.BOT_PREFIX = '!';

const ik = require('../ws3-fca');
const loader = require('./loader');
const cooldown = require('./cooldown');

const loaded = loader.loadCommands(`${__dirname}/../commands`);
ik.registry.clear();
loaded.registry.forEach((v, k) => ik.registry.set(k, v));
ik.aliases.clear();
loaded.aliases.forEach((v, k) => ik.aliases.set(k, v));

function mockApi() {
  const sent = [];
  const ALLOWED = ['attachment', 'url', 'sticker', 'emoji', 'emojiSize', 'body', 'mentions', 'location'];
  return {
    sent,
    // Enforces the real payload whitelist so a handler that smuggles extra
    // keys onto the payload fails here instead of only failing on Facebook.
    async sendMessage(payload, threadID, replyToMessage = null, isSingleUser = false) {
      const bad = Object.keys(payload).filter((k) => !ALLOWED.includes(k));
      if (bad.length) throw new Error(`Dissallowed props: \`${bad.join(', ')}\``);
      if (replyToMessage && typeof replyToMessage !== 'string') throw new Error('MessageID should be of type string');
      sent.push(payload.body || '(attachment)');
      return { messageID: 'm' };
    },
    async react() { return true; },
    async getUserInfo(uid) { return { name: `Tester ${uid.slice(-2)}` }; },
    async getThreadInfo() {
      return { threadTitle: 'Test Group', adminIDs: ['999000111', 'admin_2'], participantIDs: ['a', 'b', 'c'] };
    },
  };
}

/** Arguments that make each command do something meaningful. */
const ARGS = {
  help: ['ping'],
  setprefix: ['?'],
  maintenance: ['on'],
  enablecmd: ['ping'],
  disablecmd: ['ping'],
  enablemod: ['system'],
  disablemod: ['system'],
  ban: ['999000222', 'spamming'],
  unban: ['999000222'],
  echo: ['hello', 'world'],
};

const PERMS = { all: 'all', owner: 'owner', groupAdmin: 'groupAdmin' };

(async function main() {
  const only = process.argv.slice(2);
  const api = mockApi();
  const cmds = [...ik.registry.values()]
    .filter((c) => !only.length || only.includes(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  console.log(`\n=== executing ${cmds.length} commands against a mocked api ===\n`);

  let pass = 0;
  const failures = [];
  const empty = [];

  // `!restart` calls process.exit(1) by design. Neutralise it so the harness
  // survives, and record that the exit was actually requested.
  const realExit = process.exit.bind(process);
  let exitRequested = null;
  process.exit = (code) => { exitRequested = code; };

  for (const cmd of cmds) {
    const args = ARGS[cmd.name] || [];
    cooldown.clear(`exec_${cmd.name}`, cmd.name);

    const before = api.sent.length;
    const ctx = {
      api,
      event: {
        threadID: 'exec_thread',
        messageID: `mid_${cmd.name}`,
        senderID: '999000111', // a bot admin, so owner/groupAdmin commands run
        isGroup: true,
        mentions: { '999000222': 'Banned User' },
        body: `${cmd.name} ${args.join(' ')}`.trim(),
      },
      args,
      config: require('../config'),
      registry: ik.registry,
      gemini: ik.gemini,
      reply: async (text) => { api.sent.push(text); },
      react: async () => true,
      userDoc: null,
    };

    try {
      await cmd.execute(ctx);
      const produced = api.sent.length - before;
      if (produced === 0) empty.push(cmd.name);
      assert.ok(produced > 0, `${cmd.name} produced no reply`);
      pass += 1;
      console.log(`  ✅ ${cmd.name.padEnd(12)} (${produced} msg)`);
    } catch (err) {
      failures.push(`${cmd.name}: ${err.message}`);
      console.log(`  ❌ ${cmd.name.padEnd(12)} ${err.message}`);
    }
  }

  console.log(`\n  ${pass}/${cmds.length} commands executed cleanly`);
  if (exitRequested !== null) console.log(`  ✅ restart requested process.exit(${exitRequested})`);
  if (empty.length) console.log(`  ⚠️  no reply from: ${empty.join(', ')}`);
  if (failures.length) {
    failures.forEach((f) => console.log(`  ❌ ${f}`));
    console.log('');
    realExit(1);
  }
  console.log('  All command handlers PASS ✅\n');
  process.exit = realExit;
  realExit(0);
})().catch((err) => {
  console.error('runner crashed:', err);
  process.exit(1);
});
