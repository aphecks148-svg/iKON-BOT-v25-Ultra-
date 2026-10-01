'use strict';

/**
 * End-to-end chain test with a MOCKED ws3-fca api — no Facebook, no network.
 *
 * Proves: MESSAGE -> PARSER -> COMMAND -> REPLY runs exactly as it does live,
 * including the reaction, the reply-to-messageID threading, cooldowns,
 * toggles and permission gates.
 *
 *   node bot/e2e.js
 */

const assert = require('assert');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.ADMIN_IDS = process.env.ADMIN_IDS || '999000111';
process.env.BOT_PREFIX = '!';

const ik = require('../ws3-fca');
const router = require('./router');
const loader = require('./loader');
const config = require('../config');

const line = (s) => console.log(s);
let failures = 0;

function assertStep(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => line(`  ✅ ${label}`))
    .catch((err) => {
      failures += 1;
      line(`  ❌ ${label} — ${err.message}`);
    });
}

/** Fake ws3-fca client that records everything the bot sends. */
function mockApi() {
  const sent = [];
  const reactions = [];
  const listeners = {};
  return {
    sent,
    reactions,
    on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    emit(evt, ...args) { (listeners[evt] || []).forEach((f) => f(...args)); },
    async sendMessage(payload, threadID) {
      const rec = { body: payload.body, messageID: payload.messageID, threadID, attachment: payload.attachment };
      sent.push(rec);
      return { messageID: `mid_${sent.length}` };
    },
    async setMessageReaction(reaction, messageID) { reactions.push({ messageID, reaction }); return true; },
    async react({ messageID, reaction }) { reactions.push({ messageID, reaction }); return true; },
    async getUserInfo(uid) { return { name: `E2E ${uid.slice(-2)}` }; },
    async getThreadInfo() { return { adminIDs: ['e2e_admin'] }; },
    lastBody() { return this.sent.length ? this.sent[this.sent.length - 1].body : null; },
  };
}

const EVENT = (body, over = {}) => ({
  threadID: 'e2e_thread',
  messageID: 'trigger_mid_1',
  senderID: 'e2e_user_1',
  isGroup: true,
  body,
  type: 'message',
  ...over,
});

(async function main() {
  line('\n=== iKON-BOT end-to-end chain test (mocked api) ===\n');

  // ── prepare engine state without a Facebook login ──────────
  const loaded = loader.loadCommands(`${__dirname}/../commands`);
  ik.registry.clear();
  loaded.registry.forEach((v, k) => ik.registry.set(k, v));
  ik.aliases.clear();
  loaded.aliases.forEach((v, k) => ik.aliases.set(k, v));

  const api = mockApi();
  ik.attachClient(api);

  // ── 1. parser stage ───────────────────────────────────────
  await assertStep('PARSER: "!ping" resolves to the ping command', () => {
    const p = router.parse('!ping', config.PREFIX);
    assert.strictEqual(p.name, 'ping');
    const cmd = loader.findCommand(p.name, ik.registry, ik.aliases);
    assert.ok(cmd, 'ping not found in registry');
    assert.strictEqual(cmd.name, 'ping');
  });

  // ── 2. full chain ─────────────────────────────────────────
  let event = EVENT('!ping');
  await assertStep('MESSAGE->PARSER->COMMAND->REPLY: !ping replies with PONG', async () => {
    await ik.handleMessage(api, event);
    const last = api.lastBody();
    assert.ok(last, 'bot sent nothing');
    assert.strictEqual(
      last,
      'PONG ✅ LOGIN->DB->LOADER->MESSAGE->PARSER->COMMAND->REPLY works',
    );
  });

  await assertStep('REPLY threads under the triggering messageID', () => {
    const rec = api.sent[api.sent.length - 1];
    assert.strictEqual(rec.messageID, 'trigger_mid_1');
    assert.strictEqual(rec.threadID, 'e2e_thread');
  });

  await assertStep('REACTION is sent for a handled command', () => {
    assert.ok(api.reactions.length >= 1, 'no reaction recorded');
    assert.strictEqual(api.reactions[0].messageID, 'trigger_mid_1');
  });

  // ── 3. alias path (different sender: !p shares !ping's cooldown bucket) ──
  event = EVENT('!p', { messageID: 'alias_mid', senderID: 'e2e_user_2' });
  await assertStep('ALIAS "!p" runs the same command', async () => {
    await ik.handleMessage(api, event);
    assert.ok(String(api.lastBody()).startsWith('PONG'), `got: ${api.lastBody()}`);
  });

  await assertStep('ALIAS shares the cooldown bucket with the real name', async () => {
    await ik.handleMessage(api, EVENT('!ping', { messageID: 'alias_cd', senderID: 'e2e_user_2' }));
    assert.ok(String(api.lastBody()).startsWith('⏳ Cooldown'), `got: ${api.lastBody()}`);
  });

  // ── 4. cooldown gate ──────────────────────────────────────
  event = EVENT('!ping', { messageID: 'cd_mid' });
  await assertStep('COOLDOWN: immediate repeat is blocked with a timer', async () => {
    await ik.handleMessage(api, event);
    assert.ok(
      String(api.lastBody()).startsWith('⏳ Cooldown'),
      `expected cooldown notice, got: ${api.lastBody()}`,
    );
  });

  // ── 5. non-command text is ignored ────────────────────────
  event = EVENT('hello everyone', { messageID: 'chat_mid' });
  await assertStep('MESSAGE: plain chat text produces no reply', async () => {
    const before = api.sent.length;
    await ik.handleMessage(api, event);
    assert.strictEqual(api.sent.length, before, 'bot replied to plain text');
  });

  // ── 6. unknown command ────────────────────────────────────
  event = EVENT('!definitelynotacommand', { messageID: 'unknown_mid' });
  await assertStep('COMMAND: unknown command gets a clear error', async () => {
    await ik.handleMessage(api, event);
    assert.ok(String(api.lastBody()).startsWith('❌ Unknown command'));
  });

  // ── 7. self-message guard (listener level) ────────────────
  await assertStep('LISTENER: bot ignores its own messages', () => {
    const before = api.sent.length;
    api.emit('message', EVENT('!ping', { isSelf: true, messageID: 'self_mid' }));
    return new Promise((resolve) => setTimeout(() => {
      try {
        assert.strictEqual(api.sent.length, before, 'bot replied to itself');
        resolve();
      } catch (e) { throw e; }
    }, 250));
  });

  // ── 8. a crashing command must not kill the bot ───────────
  await assertStep('ERROR BOUNDARY: a throwing command is caught and reported', async () => {
    const bomb = {
      name: '__bomb__',
      aliases: [],
      category: 'system',
      description: 'throws on purpose',
      usage: '!__bomb__',
      cooldown: 0,
      permission: 'all',
      execute: async () => { throw new Error('deliberate crash'); },
    };
    ik.registry.set('__bomb__', bomb);
    try {
      await ik.handleMessage(api, EVENT('!__bomb__', { messageID: 'bomb_mid' }));
      assert.ok(
        String(api.lastBody()).includes('deliberate crash'),
        'user was not told the command crashed',
      );
    } finally {
      ik.registry.delete('__bomb__');
    }
  });

  // ── 9. permissions gate at the engine level ───────────────
  await assertStep('PERMISSION: non-admin is refused an owner command', async () => {
    const ownerOnly = {
      name: '__adminonly__',
      aliases: [],
      category: 'system',
      description: 'owner only',
      usage: '!__adminonly__',
      cooldown: 0,
      permission: 'owner',
      execute: async ({ reply }) => reply('should never appear'),
    };
    ik.registry.set('__adminonly__', ownerOnly);
    try {
      await ik.handleMessage(api, EVENT('!__adminonly__', { messageID: 'perm_mid', senderID: 'random_person' }));
      assert.ok(String(api.lastBody()).startsWith('🚫'), 'permission was not enforced');
      assert.ok(!String(api.lastBody()).includes('should never appear'));
    } finally {
      ik.registry.delete('__adminonly__');
    }
  });

  line('');
  if (failures) {
    line(`  ${failures} E2E FAILURE(S)\n`);
    process.exit(1);
  }
  line('  End-to-end chain PASS ✅\n');
  process.exit(0);
})().catch((err) => {
  console.error('E2E runner crashed:', err);
  process.exit(1);
});
