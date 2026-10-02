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

/**
 * Fake ws3-fca client that records everything the bot sends.
 *
 * sendMessage enforces the same contract as the real one: the payload may only
 * carry whitelisted keys, and the reply-to id is the third argument. A looser
 * mock is what let `payload.messageID` ship and silently kill every reply.
 */
function mockApi() {
  const sent = [];
  const reactions = [];
  const listeners = {};
  const ALLOWED = ['attachment', 'url', 'sticker', 'emoji', 'emojiSize', 'body', 'mentions', 'location'];
  return {
    sent,
    reactions,
    on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    emit(evt, ...args) { (listeners[evt] || []).forEach((f) => f(...args)); },
    async sendMessage(payload, threadID, replyToMessage = null, isSingleUser = false) {
      const bad = Object.keys(payload).filter((k) => !ALLOWED.includes(k));
      if (bad.length) throw new Error(`Dissallowed props: \`${bad.join(', ')}\``);
      if (replyToMessage && typeof replyToMessage !== 'string') throw new Error('MessageID should be of type string');
      const rec = {
        body: payload.body,
        messageID: replyToMessage,
        threadID,
        isSingleUser,
        attachment: payload.attachment,
      };
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
  await assertStep('MESSAGE->PARSER->COMMAND->REPLY: !ping replies with Pong + uptime', async () => {
    await ik.handleMessage(api, event);
    const last = api.lastBody();
    assert.ok(last, 'bot sent nothing');
    assert.ok(String(last).startsWith('Pong!'), `expected a Pong, got: ${last}`);
    assert.ok(/Uptime:/.test(String(last)), `expected an uptime, got: ${last}`);
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
    assert.ok(String(api.lastBody()).startsWith('Pong!'), `got: ${api.lastBody()}`);
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

  // ── 10. admin control covers every module, and cannot lock itself out ──
  // This is the whole point of the gate. `!disablemod system` switches off every
  // command in the system category, and that set contains !enablecmd,
  // !enablemod, !listcmds and !listmods. Because the gate applied to admins as
  // well, running it left the chat with no in-chat way back — not for the admin
  // who ran it, not for the owner. Admins must therefore pass the switches they
  // control, while members obey them.
  await assertStep('ADMIN CONTROL: a member obeys the switches, an admin is never locked out', async () => {
    const Group = require('../models/Group');
    const mongo = require('./mongo');
    const cache = require('./cache');
    const realFindOne = Group.findOne;
    const realReady = mongo.isReady;
    const realGetUser = cache.getUser;
    const realSaveUser = cache.saveUser;

    // A uid the bot has never seen has to be created, and there is no database
    // here. Without this the handler fails on the profile and the test ends up
    // asserting on that failure instead of on the gate under test.
    const stubProfile = async (uid) => ({
      uid: String(uid),
      name: `E2E ${String(uid).slice(-3)}`,
      coins: 1000,
      bank: 0,
      level: 1,
      xp: 0,
      commandsUsed: 0,
      async save() { return this; },
      increment() { return this; },
    });
    cache.getUser = stubProfile;
    cache.saveUser = async () => {};

    const GROUP = {
      tid: 'e2e_thread',
      isEnabled: true,
      maintenance: false,
      adminsOnly: false,
      // The nastiest realistic case: the system module is off, which takes out
      // the very commands used to undo it.
      disabledModules: ['system'],
      disabledCommands: [],
    };
    Group.findOne = () => ({ lean: () => Promise.resolve(GROUP) });
    mongo.isReady = () => true;

    // api.getThreadInfo() reports e2e_admin as a thread admin (see mockApi).
    const asMember = async (body, mid) => {
      await ik.handleMessage(api, EVENT(body, { messageID: mid, senderID: 'e2e_plain_member' }));
      return String(api.lastBody());
    };
    const asAdmin = async (body, mid) => {
      await ik.handleMessage(api, EVENT(body, { messageID: mid, senderID: 'e2e_admin' }));
      return String(api.lastBody());
    };
    const asOwner = async (body, mid) => {
      await ik.handleMessage(api, EVENT(body, { messageID: mid, senderID: '999000111' }));
      return String(api.lastBody());
    };

    try {
      // A command in the disabled module. The member is refused...
      const memberOut = await asMember('!ping', 'gate_m1');
      assert.ok(memberOut.startsWith('⛔'), `member should be gated, got: ${memberOut}`);
      assert.ok(/disabled here/.test(memberOut), 'and told why');

      // ...while the thread admin and the owner both get through, which is the
      // only reason the switch is reversible at all.
      // !ping rather than !listcmds: both are in the disabled module, but ping
      // needs no database profile, so this asserts the gate alone instead of
      // silently testing the profile cache instead.
      const adminOut = await asAdmin('!ping', 'gate_m2');
      assert.ok(!adminOut.startsWith('⛔'), `admin must not be locked out, got: ${adminOut}`);
      assert.ok(/Pong/.test(adminOut), `admin actually ran it -> ${JSON.stringify(adminOut)}`);

      const ownerOut = await asOwner('!ping', 'gate_m3');
      assert.ok(/Pong/.test(ownerOut), `owner actually ran it -> ${JSON.stringify(ownerOut)}`);

      // The admin's view of their own chat has to count module kills, or
      // !listcmds reports "356 enabled" in a chat with 38 commands switched off.
      const view = await asAdmin('!listcmds', 'gate_m4');
      assert.ok(/Modules off/.test(view), `the admin is shown which modules are off -> ${JSON.stringify(view.slice(0, 120))}`);
      const enabled = Number((view.match(/Enabled: (\d+)/) || [])[1]);
      assert.ok(enabled > 0 && enabled < 356, `enabled count accounts for module kills (got ${enabled})`);

      // With the module switch off, a member keeps every command outside it:
      // by default everybody can use the bot, and only the switches take
      // anything away.
      GROUP.disabledModules = [];
      const untouched = await asMember('!ping', 'gate_m5');
      assert.ok(/Pong/.test(untouched), `members keep the bot by default, got: ${untouched}`);

      // Maintenance is a shutdown, not a switch — it holds for admins and the
      // owner too, because it is the operator who asked for it.
      GROUP.maintenance = true;
      const maintAdmin = await asAdmin('!ping', 'gate_m6');
      assert.ok(/under maintenance/.test(maintAdmin), `maintenance holds for admins, got: ${maintAdmin}`);
      const maintOwner = await asOwner('!ping', 'gate_m7');
      assert.ok(/under maintenance/.test(maintOwner), `maintenance holds for the owner, got: ${maintOwner}`);
    } finally {
      GROUP.maintenance = false;
      GROUP.disabledModules = ['system'];
      Group.findOne = realFindOne;
      mongo.isReady = realReady;
      cache.getUser = realGetUser;
      cache.saveUser = realSaveUser;
    }
  });

  // ── 9. a message sent AS A REPLY must still be handled ────
  // ws3-fca labels a reply "message_reply" (listenMqtt.js:246). The listener
  // used to accept only "message", so replying to the bot produced a reaction
  // but never a reply — indistinguishable from a dead send path.
  await assertStep('EVENT FILTER: type "message_reply" is handled, not dropped', () => {
    const seen = [];
    const fakeApi = mockApi();
    fakeApi.sendMessage = async (...args) => { seen.push(args); return { messageID: 'm' }; };
    const emitter = new (require('events').EventEmitter)();
    ik.attachEvents(fakeApi, emitter);

    emitter.emit('message', {
      type: 'message_reply',
      isSelf: false,
      isGroup: false,
      threadID: 'e2e_reply_thread',
      messageID: 'reply_mid',
      senderID: 'e2e_user_9',
      body: '!ping',
      attachments: [],
    });

    // attachEvents dispatches through safe(), which is async internally, so
    // let the microtask queue drain before asserting.
    return new Promise((resolve) => setImmediate(() => {
      assert.strictEqual(seen.length, 1, `a message_reply was dropped (${seen.length} sends)`);
      resolve();
    }));
  });

  await assertStep('EVENT FILTER: an attachment-only message is not dropped', () => {
    const fakeApi = mockApi();
    const emitter = new (require('events').EventEmitter)();
    ik.attachEvents(fakeApi, emitter);

    const before = ik.STATE.messagesSeen;
    // A sticker or photo arrives with an empty body. The old filter required a
    // non-empty body and threw the message away before it was ever counted.
    emitter.emit('message', {
      type: 'message',
      isSelf: false,
      isGroup: false,
      threadID: 'e2e_att_thread',
      messageID: 'att_mid',
      senderID: 'e2e_user_9',
      body: '',
      attachments: [{ type: 'sticker' }],
    });
    assert.ok(
      ik.STATE.messagesSeen > before,
      'an attachment-only message never reached the handler',
    );

    // And a genuinely empty message still is dropped, so this is not just a
    // counter that increments for everything.
    const before2 = ik.STATE.messagesSeen;
    emitter.emit('message', {
      type: 'message',
      isSelf: false,
      isGroup: false,
      threadID: 'e2e_att_thread',
      messageID: 'empty_mid',
      senderID: 'e2e_user_9',
      body: '',
      attachments: [],
    });
    assert.strictEqual(
      ik.STATE.messagesSeen,
      before2,
      'a truly empty message should still be ignored',
    );
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
