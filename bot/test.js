'use strict';

/**
 * Core system self-test.
 *
 * Run with:  node bot/test.js
 * Optional:  TEST_MONGO_URI=mongodb://... node bot/test.js   (skips Mongo if absent)
 *
 * It exercises loader -> router -> cooldown -> permissions -> toggles -> cache
 * -> all 5 models, using a mocked ws3-fca api so nothing is sent to Facebook.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
// Seed a test admin id BEFORE config is loaded so the owner branch is exercised.
// (Never hard-coded in config.js — this is test-only.)
process.env.ADMIN_IDS = process.env.ADMIN_IDS || '999000111';
process.env.BOT_PREFIX = process.env.BOT_PREFIX || '!';

const mongo = require('./mongo');
const router = require('./router');
const loader = require('./loader');
const cooldown = require('./cooldown');
const permissions = require('./permissions');
const toggles = require('./toggles');
const cache = require('./cache');
const canvas = require('./canvas');
const helpers = require('./helpers');
const gemini = require('./gemini');
const config = require('../config');

const User = require('../models/User');
const Group = require('../models/Group');
const Economy = require('../models/Economy');
const Pet = require('../models/Pet');
const Inventory = require('../models/Inventory');

const results = [];
let failures = 0;

function ok(label, detail = '') {
  results.push({ label, pass: true, detail });
  console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label, err) {
  failures += 1;
  results.push({ label, pass: false, detail: err.message });
  console.log(`  ❌ ${label} — ${err.message}`);
}

async function step(label, fn) {
  try {
    const detail = await fn();
    ok(label, detail || '');
  } catch (err) {
    fail(label, err);
  }
}

// ── fake ws3-fca client ──────────────────────────────────────
// sendMessage enforces the real payload whitelist, so a helper that smuggles
// the reply-to id onto the payload throws here exactly as it does live.
function mockApi() {
  const sent = [];
  const ALLOWED = ['attachment', 'url', 'sticker', 'emoji', 'emojiSize', 'body', 'mentions', 'location'];
  return {
    sent,
    async sendMessage(payload, threadID, replyToMessage = null, isSingleUser = false) {
      const bad = Object.keys(payload).filter((k) => !ALLOWED.includes(k));
      if (bad.length) throw new Error(`Dissallowed props: \`${bad.join(', ')}\``);
      if (replyToMessage && typeof replyToMessage !== 'string') throw new Error('MessageID should be of type string');
      sent.push({ payload, threadID, replyToMessage, isSingleUser });
      return { messageID: `mock_${sent.length}` };
    },
    async react({ messageID, reaction }) {
      sent.push({ react: { messageID, reaction } });
      return true;
    },
    async getUserInfo(uid) {
      return { name: `Tester ${uid.slice(-2)}` };
    },
    async getThreadInfo() {
      return { adminIDs: ['admin_1'] };
    },
  };
}

const OWNER_UID = config.ADMIN_IDS[0] || 'owner_test';

(async function main() {
  console.log('\n=== iKON-BOT core system test ===\n');

  // ── 1. config ─────────────────────────────────────────────
  await step('config loads without credentials hard-coded', () => {
    assert.strictEqual(config.BOT_NAME, 'iKON-BOT');
    assert.strictEqual(config.PREFIX, '!');
    assert.ok(Array.isArray(config.ADMIN_IDS));
    return `${config.BOT_NAME} prefix=${config.PREFIX} admins=${config.ADMIN_IDS.length}`;
  });

  // ── 2. loader ─────────────────────────────────────────────
  let loaded;
  await step('loader scans commands/cmds_1..10', () => {
    loaded = loader.loadCommands(path.join(__dirname, '..', 'commands'));
    assert.ok(loaded.registry instanceof Map);
    assert.ok(loaded.registry.size >= 1, 'expected at least the ping command');
    assert.ok(loaded.aliases.has('p'), 'alias "p" should map to ping');
    return `${loaded.registry.size} commands, ${loaded.aliases.size} aliases`;
  });

  // ── 3. router ─────────────────────────────────────────────
  await step('router parses commands', () => {
    const p = router.parse('!ping', '!');
    assert.strictEqual(p.name, 'ping');
    assert.deepStrictEqual(p.args, []);

    const q = router.parse('!bank deposit 500', '!');
    assert.strictEqual(q.name, 'bank');
    assert.deepStrictEqual(q.args, ['deposit', '500']);

    assert.strictEqual(router.parse('hello there', '!'), null);
    assert.strictEqual(router.parse('', '!'), null);
    assert.strictEqual(router.parse('!', '!'), null);
    return 'prefix + args + rejects plain text';
  });

  // ── 4. command lookup ─────────────────────────────────────
  await step('command resolves by name and alias', () => {
    const byName = loader.findCommand('ping', loaded.registry, loaded.aliases);
    const byAlias = loader.findCommand('p', loaded.registry, loaded.aliases);
    assert.strictEqual(byName, byAlias);
    assert.strictEqual(byName.name, 'ping');
    assert.strictEqual(byName.permission, 'all');
    assert.strictEqual(byName.cooldown, 3);
    return `ping / p -> ${byName.name}`;
  });

  // ── 5. cooldown ───────────────────────────────────────────
  await step('cooldown blocks a second call and expires', () => {
    cooldown.clear('u1');
    assert.strictEqual(cooldown.check('u1', 'ping', 3), 0);
    cooldown.set('u1', 'ping', 3);
    const left = cooldown.check('u1', 'ping', 3);
    assert.ok(left > 0 && left <= 3, `expected 1..3, got ${left}`);
    cooldown.clear('u1');
    assert.strictEqual(cooldown.check('u1', 'ping', 3), 0);
    return `${left}s remaining then cleared`;
  });

  // ── 6. permissions ────────────────────────────────────────
  await step('permissions resolves owner / groupAdmin / deny', async () => {
    const api = mockApi();
    const ownerEvent = { senderID: OWNER_UID, threadID: 'g1', isGroup: true };

    assert.strictEqual(await permissions.check(ownerEvent, api, 'all'), 'all');
    assert.strictEqual(await permissions.check(ownerEvent, api, 'owner'), 'owner');
    assert.strictEqual(await permissions.check(ownerEvent, api, 'groupAdmin'), 'owner');

    const adminEvent = { senderID: 'admin_1', threadID: 'g1', isGroup: true };
    assert.strictEqual(await permissions.check(adminEvent, api, 'groupAdmin'), 'groupAdmin');

    const nobody = { senderID: 'random_guy', threadID: 'g1', isGroup: true };
    assert.strictEqual(await permissions.check(nobody, api, 'owner'), false);
    assert.strictEqual(await permissions.check(nobody, api, 'groupAdmin'), false);
    return 'all / owner / groupAdmin / deny';
  });

  await step('admin ids come from the environment, with no hard-coded fallback', () => {
    // config.OWNER_ID is read by permissions.isOwner but was never defined in
    // config.js, so the comparison ran against String(undefined) and never
    // matched. Assert the key exists so that gap cannot reopen.
    assert.ok('OWNER_ID' in config, 'config must define OWNER_ID');
    assert.ok(Array.isArray(config.ADMIN_IDS), 'ADMIN_IDS must be an array');
    assert.ok(config.ADMIN_IDS.length, 'the test seeds ADMIN_IDS, so it must parse');

    const savedIds = config.ADMIN_IDS;
    const savedOwner = config.OWNER_ID;
    try {
      // Both the list and the singular form must grant owner.
      config.ADMIN_IDS = ['env_admin_1'];
      config.OWNER_ID = '';
      assert.strictEqual(permissions.isOwner('env_admin_1'), true, 'ADMIN_IDS entry must grant owner');
      assert.strictEqual(permissions.isOwner('env_admin_2'), false);

      config.ADMIN_IDS = [];
      config.OWNER_ID = 'env_owner_1';
      assert.strictEqual(permissions.isOwner('env_owner_1'), true, 'OWNER_ID must grant owner');
      assert.strictEqual(permissions.isOwner('someone_else'), false);

      // ownerIds() is what the moderation exemptions use; it must merge both.
      assert.deepStrictEqual(permissions.ownerIds().sort(), ['env_owner_1']);

      config.ADMIN_IDS = ['env_admin_1'];
      assert.deepStrictEqual(permissions.ownerIds().sort(), ['env_admin_1', 'env_owner_1'],
        'ownerIds must merge ADMIN_IDS and OWNER_ID without duplicates');

      // An empty OWNER_ID must never match a sender. String(undefined) === 'undefined'
      // was the original bug shape.
      config.OWNER_ID = '';
      assert.strictEqual(permissions.isOwner('undefined'), false);
      assert.strictEqual(permissions.isOwner(''), false);
    } finally {
      config.ADMIN_IDS = savedIds;
      config.OWNER_ID = savedOwner;
    }
    return 'ADMIN_IDS + OWNER_ID resolve from env';
  });

  await step('protectedIds exempts env admins from moderation', async () => {
    const savedIds = config.ADMIN_IDS;
    const savedOwner = config.OWNER_ID;
    try {
      config.ADMIN_IDS = ['bot_admin_env'];
      config.OWNER_ID = 'solo_owner_env';
      // getThreadInfo fails: the env admins must still be protected, because
      // degrading to "protect nobody" is how an owner gets muted by their own
      // !gcmuteall.
      const broken = { getThreadInfo: async () => { throw new Error('no api'); } };
      const set = await permissions.protectedIds(broken, 't_1');
      assert.ok(set.has('bot_admin_env'), 'ADMIN_IDS admin must be exempt');
      assert.ok(set.has('solo_owner_env'), 'OWNER_ID admin must be exempt');
      assert.ok(!set.has('random_member'), 'an ordinary member must not be exempt');
      // The acting user is NOT in here. Including it and then testing membership
      // is the tautology that let any member pass an admin gate.
      assert.ok(!set.has('acting_admin'), 'protectedIds must not auto-include the sender');

      // Thread admins are additive on top of the env list.
      const api = { getThreadInfo: async () => ({ adminIDs: ['thread_admin'] }) };
      const merged = await permissions.protectedIds(api, 't_1');
      assert.ok(merged.has('thread_admin') && merged.has('bot_admin_env'));

      // protectedIdsFor is the target-exemption variant, and does add the sender.
      const forSender = await permissions.protectedIdsFor(api, 't_1', 'acting_admin');
      assert.ok(forSender.has('acting_admin'), 'protectedIdsFor must include the sender');
    } finally {
      config.ADMIN_IDS = savedIds;
      config.OWNER_ID = savedOwner;
    }
    return 'env admins exempt even when thread lookup fails';
  });

  await step('canModerate grants env admins and thread admins, denies members', async () => {
    const savedIds = config.ADMIN_IDS;
    const savedOwner = config.OWNER_ID;
    try {
      config.ADMIN_IDS = ['bot_admin_env'];
      config.OWNER_ID = 'solo_owner_env';
      const api = { getThreadInfo: async () => ({ adminIDs: ['thread_admin'] }) };

      assert.strictEqual(await permissions.canModerate(api, { senderID: 'bot_admin_env', threadID: 't_1' }), true,
        'ADMIN_IDS admin must moderate');
      assert.strictEqual(await permissions.canModerate(api, { senderID: 'solo_owner_env', threadID: 't_1' }), true,
        'OWNER_ID admin must moderate');
      assert.strictEqual(await permissions.canModerate(api, { senderID: 'thread_admin', threadID: 't_1' }), true,
        'thread admin must moderate');
      assert.strictEqual(await permissions.canModerate(api, { senderID: 'random_member', threadID: 't_1' }), false,
        'an ordinary member must NOT moderate');

      // A failing lookup must deny, never grant.
      const broken = { getThreadInfo: async () => { throw new Error('no api'); } };
      assert.strictEqual(await permissions.canModerate(broken, { senderID: 'thread_admin', threadID: 't_1' }), false);
      // Env admins still pass when the thread lookup fails.
      assert.strictEqual(await permissions.canModerate(broken, { senderID: 'bot_admin_env', threadID: 't_1' }), true);

      // A private chat has no thread admins, so nobody moderates there.
      assert.strictEqual(
        await permissions.canModerate(api, { senderID: 'thread_admin', threadID: 't_1', isGroup: false }),
        false,
        'thread admins must not moderate in a DM',
      );
    } finally {
      config.ADMIN_IDS = savedIds;
      config.OWNER_ID = savedOwner;
    }
    return 'owner / thread admin allowed, member and DM denied';
  });

  // ── 7. helpers ────────────────────────────────────────────
  await step('helpers reply + react + safe() error boundary', async () => {
    const api = mockApi();
    // Real Messenger group thread ids are prefixed `t_`; a bare uid is a DM.
    const GROUP = 't_1234567890';
    const res = await helpers.reply(api, GROUP, 'hello', 'm1');
    assert.ok(res);
    assert.strictEqual(api.sent[0].payload.body, 'hello');
    // The reply-to id must be sendMessage's third argument, never a payload
    // key: the real client whitelists payload props and throws on the rest,
    // which dropped every reply while reactions kept working.
    assert.strictEqual(api.sent[0].replyToMessage, 'm1');
    assert.strictEqual(api.sent[0].payload.messageID, undefined);
    assert.strictEqual(api.sent[0].isSingleUser, false, 'a t_ thread is not single-user');

    // A bare uid is a one-to-one chat and needs isSingleUser=true.
    await helpers.reply(api, '999000111', 'dm');
    assert.strictEqual(api.sent[1].isSingleUser, true);

    // A numeric messageID must still reach sendMessage as a string.
    await helpers.reply(api, GROUP, 'num', 12345);
    assert.strictEqual(api.sent[2].replyToMessage, '12345');

    const before = api.sent.length;
    assert.strictEqual(await helpers.reply(api, GROUP, { body: 'x', messageID: 'nope' }), null);
    assert.strictEqual(api.sent.length, before, 'illegal payload key must not send');

    assert.strictEqual(await helpers.react(api, 'm1', '✅'), true);
    assert.strictEqual(api.sent[before].react.reaction, '✅');

    const boom = await helpers.safe(async () => { throw new Error('kaboom'); }, api, 't1', 'm1', 'test');
    assert.strictEqual(boom.ok, false);
    assert.strictEqual(boom.error, 'kaboom');
    assert.ok(api.sent.some((s) => String(s.payload?.body).includes('kaboom')));
    return 'reply, react, and crash isolation';
  });

  // ── 8. canvas wrapper ─────────────────────────────────────
  await step('canvas wrapper exposes a safe API', () => {
    assert.strictEqual(typeof canvas.create, 'function');
    assert.strictEqual(typeof canvas.available, 'function');
    if (canvas.available()) {
      const made = canvas.create(200, 100);
      assert.ok(made && made.ctx);
      return 'native binding loaded';
    }
    return 'native binding absent — image commands will report unavailable';
  });

  // ── 9. model schemas (offline — no server needed) ─────────
  await step('User schema fields, defaults and indexes', () => {
    const doc = new User({ uid: 'schema_test' });
    assert.strictEqual(doc.level, 1);
    assert.strictEqual(doc.xp, 0);
    assert.strictEqual(doc.coins, 10000);
    assert.strictEqual(doc.bank, 0);
    assert.strictEqual(doc.reputation, 0);
    assert.strictEqual(doc.prestige, 0);
    assert.strictEqual(doc.stats.messages, 0);
    assert.strictEqual(doc.stats.commandsUsed, 0);
    assert.strictEqual(doc.rpg.className, '');
    assert.strictEqual(doc.rpg.stats.battles, 0);
    assert.strictEqual(doc.rpg.stats.wins, 0);
    assert.strictEqual(doc.rpg.stamina, 10);

    const paths = Object.keys(User.schema.paths);
    for (const f of ['uid', 'name', 'level', 'xp', 'coins', 'bank', 'reputation', 'prestige', 'createdAt', 'updatedAt']) {
      assert.ok(paths.includes(f), `User is missing "${f}"`);
    }
    // Nested objects live as per-leaf paths (stats.messages), so check by prefix.
    for (const f of ['stats.messages', 'stats.commandsUsed']) {
      assert.ok(paths.includes(f), `User is missing "${f}"`);
    }
    const uidIdx = User.schema.indexes().find((i) => i[0] && i[0].uid === 1);
    assert.ok(uidIdx && uidIdx[1].unique, 'User.uid must be a unique index');
    return `paths=${paths.length}, uid unique`;
  });

  await step('Group schema fields, defaults and indexes', () => {
    const doc = new Group({ tid: 'schema_test' });
    assert.strictEqual(doc.isEnabled, true);
    assert.strictEqual(doc.isApproved, false);
    assert.strictEqual(doc.pendingApproval, true);
    assert.strictEqual(doc.prefix, null);
    assert.strictEqual(doc.settings.welcome, false);
    assert.strictEqual(doc.settings.goodbye, false);
    assert.strictEqual(doc.maintenance, false);
    assert.deepStrictEqual(doc.disabledCommands, []);
    assert.deepStrictEqual(doc.disabledModules, []);

    const paths = Object.keys(Group.schema.paths);
    for (const f of ['tid', 'isEnabled', 'isApproved', 'pendingApproval', 'prefix', 'disabledCommands', 'disabledModules', 'maintenance']) {
      assert.ok(paths.includes(f), `Group is missing "${f}"`);
    }
    for (const f of ['settings.welcome', 'settings.goodbye', 'settings.welcomeMsg', 'settings.goodbyeMsg']) {
      assert.ok(paths.includes(f), `Group is missing "${f}"`);
    }
    const tidIdx = Group.schema.indexes().find((i) => i[0] && i[0].tid === 1);
    assert.ok(tidIdx && tidIdx[1].unique, 'Group.tid must be a unique index');
    return `paths=${paths.length}, tid unique`;
  });

  await step('Economy / Pet / Inventory schemas', () => {
    const e = new Economy({ uid: 'u', action: 'work', amount: 10, balanceAfter: 20 });
    assert.strictEqual(e.amount, 10);
    for (const f of ['uid', 'action', 'amount', 'balanceAfter', 'createdAt']) {
      assert.ok(Object.keys(Economy.schema.paths).includes(f), `Economy missing "${f}"`);
    }

    const p = new Pet({ ownerUid: 'u', name: 'Sparky' });
    assert.strictEqual(p.type, 'dragon');
    assert.strictEqual(p.level, 1);
    assert.strictEqual(p.hunger, 100);
    for (const f of ['ownerUid', 'name', 'type', 'level', 'xp', 'hunger']) {
      assert.ok(Object.keys(Pet.schema.paths).includes(f), `Pet missing "${f}"`);
    }
    assert.ok(Pet.schema.indexes().some((i) => i[0] && i[0].ownerUid === 1), 'Pet.ownerUid must be indexed');

    const inv = new Inventory({ uid: 'u', items: [{ itemId: 'potion', qty: 2 }] });
    assert.strictEqual(inv.items[0].itemId, 'potion');
    assert.strictEqual(inv.items[0].qty, 2);
    const uidIdx = Inventory.schema.indexes().find((i) => i[0] && i[0].uid === 1);
    assert.ok(uidIdx && uidIdx[1].unique, 'Inventory.uid must be a unique index');
    return 'all three schemas valid';
  });

  await step('schema validation rejects bad documents', async () => {
    const bad = new User({ name: 'no uid' });
    const err = bad.validateSync();
    assert.ok(err && err.errors.uid, 'User without uid should fail validation');
    return 'required uid enforced';
  });

  // ── 10. live database round-trip ─────────────────────────
  const hasMongo = Boolean(process.env.TEST_MONGO_URI || process.env.MONGO_URI);
  if (!hasMongo) {
    console.log('\n  ⏭️  Database tests skipped — set TEST_MONGO_URI or MONGO_URI to run them.\n');
  } else {
    const uri = process.env.TEST_MONGO_URI || process.env.MONGO_URI;
    await step('mongo connects', async () => {
      const connected = await mongo.connect(uri);
      assert.ok(connected, mongo.status().error || 'connection failed');
      assert.ok(mongo.isReady());
      return mongo.status().readyState === 1 ? 'readyState=1' : '';
    });

    const uid = `test_${Date.now()}`;
    const tid = `testthread_${Date.now()}`;

    await step('User model: create, defaults, update', async () => {
      const u = await User.create({ uid, name: 'Tester' });
      assert.strictEqual(u.uid, uid);
      assert.strictEqual(u.level, 1);
      assert.strictEqual(u.xp, 0);
      assert.strictEqual(u.coins, 10000);
      assert.strictEqual(u.bank, 0);
      assert.strictEqual(u.reputation, 0);
      assert.strictEqual(u.prestige, 0);
      assert.strictEqual(u.stats.messages, 0);
      assert.strictEqual(u.stats.commandsUsed, 0);

      u.xp += 250;
      await u.save();
      assert.strictEqual((await User.findOne({ uid })).xp, 250);
      return 'defaults correct';
    });

    await step('Group model: create, settings defaults', async () => {
      const g = await Group.create({ tid });
      assert.strictEqual(g.isEnabled, true);
      assert.strictEqual(g.isApproved, false);
      assert.strictEqual(g.pendingApproval, true);
      assert.strictEqual(g.prefix, null);
      assert.strictEqual(g.settings.welcome, false);
      assert.strictEqual(g.settings.goodbye, false);
      assert.deepStrictEqual(g.disabledCommands, []);
      assert.deepStrictEqual(g.disabledModules, []);
      assert.strictEqual(g.maintenance, false);
      return 'defaults correct';
    });

    await step('toggles: disable command, module, maintenance', async () => {
      const g0 = await toggles.getGroup(tid);
      assert.strictEqual((await toggles.isCommandDisabled(tid, 'ping', 'system')).allowed, true);

      await toggles.toggleCommand(tid, 'ping', true);
      let res = await toggles.isCommandDisabled(tid, 'ping', 'system');
      assert.strictEqual(res.allowed, false);
      assert.ok(res.reason.includes('ping'));

      await toggles.toggleCommand(tid, 'ping', false);
      assert.strictEqual((await toggles.isCommandDisabled(tid, 'ping', 'system')).allowed, true);

      await toggles.toggleModule(tid, 'system', true);
      res = await toggles.isCommandDisabled(tid, 'ping', 'system');
      assert.strictEqual(res.allowed, false);

      await toggles.toggleModule(tid, 'system', false);
      assert.strictEqual((await toggles.isCommandDisabled(tid, 'ping', 'system')).allowed, true);

      await toggles.setMaintenance(tid, true);
      res = await toggles.isCommandDisabled(tid, 'ping', 'system');
      assert.strictEqual(res.allowed, false);
      assert.ok(res.reason.includes('maintenance'));

      await toggles.setMaintenance(tid, false);
      assert.strictEqual((await toggles.isCommandDisabled(tid, 'ping', 'system')).allowed, true);
      assert.ok(g0);
      return 'command, module and maintenance gates';
    });

    await step('Economy model: ledger entry', async () => {
      const e = await Economy.create({ uid, action: 'work', amount: 250, balanceAfter: 1250 });
      assert.strictEqual(e.uid, uid);
      assert.strictEqual(e.action, 'work');
      assert.strictEqual(e.amount, 250);
      assert.strictEqual(e.balanceAfter, 1250);
      assert.ok(e.createdAt);
      return 'ledger write + timestamps';
    });

    await step('Pet model: create with defaults', async () => {
      const p = await Pet.create({ ownerUid: uid, name: 'Sparky' });
      assert.strictEqual(p.ownerUid, uid);
      assert.strictEqual(p.name, 'Sparky');
      assert.strictEqual(p.type, 'dragon');
      assert.strictEqual(p.level, 1);
      assert.strictEqual(p.xp, 0);
      assert.strictEqual(p.hunger, 100);
      return 'type=dragon hunger=100';
    });

    await step('Inventory model: items array', async () => {
      const inv = await Inventory.create({ uid, items: [{ itemId: 'potion', qty: 3 }] });
      assert.strictEqual(inv.items.length, 1);
      assert.strictEqual(inv.items[0].itemId, 'potion');
      assert.strictEqual(inv.items[0].qty, 3);
      return 'nested items schema';
    });

    await step('cache: creates user via api.getUserInfo and caches', async () => {
      cache.clear();
      const api = mockApi();
      const u = await cache.getUser(uid, api);
      assert.ok(u, 'cache.getUser returned null');
      assert.ok(/^Tester/.test(u.name), `expected a fetched name, got ${u.name}`);

      const again = await cache.getUser(uid, api);
      assert.strictEqual(again.uid, u.uid);
      assert.ok(cache.size() >= 1);
      return `name="${u.name}" cached`;
    });

    await step('unique indexes enforced (uid, tid)', async () => {
      let dupUser = false;
      try { await User.create({ uid, name: 'dupe' }); } catch { dupUser = true; }
      assert.ok(dupUser, 'duplicate uid should be rejected');

      let dupGroup = false;
      try { await Group.create({ tid }); } catch { dupGroup = true; }
      assert.ok(dupGroup, 'duplicate tid should be rejected');
      return 'uid + tid unique';
    });

    await step('cleanup test documents', async () => {
      await Promise.all([
        User.deleteMany({ uid }),
        Group.deleteMany({ tid }),
        Economy.deleteMany({ uid }),
        Pet.deleteMany({ ownerUid: uid }),
        Inventory.deleteMany({ uid }),
      ]);
      return 'removed';
    });

    await step('mongo disconnects', async () => {
      await mongo.disconnect();
      return 'closed';
    });
  }

  // ── 13. gemini (offline — no network) ─────────────────────
  await step('gemini targets a live model, not the shut-down 1.5 family', () => {
    const model = gemini.preferredModel();
    // gemini-1.5-flash and gemini-1.5-pro are fully shut down: every call 404s.
    assert.ok(!/gemini-1\.5/.test(model), `model "${model}" is shut down`);
    for (const m of gemini.FALLBACK_MODELS) {
      assert.ok(!/gemini-1\.5/.test(m), `fallback "${m}" is shut down`);
    }
    return `${model}, fallbacks: ${gemini.FALLBACK_MODELS.join(', ')}`;
  });

  await step('gemini sends no parameter Gemini 3.x rejects', async () => {
    // Intercept the real request instead of grepping the source: this asserts
    // what actually goes over the wire.
    const axios = require('axios');
    const saved = config.GEMINI_API_KEY;
    const realPost = axios.post;
    let sent = null;
    config.GEMINI_API_KEY = 'AQ.test-key';
    axios.post = async (url, body, opts) => {
      sent = { url, body, opts };
      return { data: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } };
    };
    try {
      const answer = await gemini.ask('what is up');
      assert.strictEqual(answer, 'ok');
    } finally {
      axios.post = realPost;
      config.GEMINI_API_KEY = saved;
      gemini._reset();
    }

    assert.ok(sent, 'no request was made');
    const cfg = sent.body.generationConfig;
    // temperature/top_p/top_k were removed in Gemini 3.x and cause degraded
    // output when set.
    assert.ok(!('temperature' in cfg), 'must not send temperature');
    assert.ok(!('top_p' in cfg), 'must not send top_p');
    assert.ok(!('top_k' in cfg), 'must not send top_k');
    assert.ok(!('candidateCount' in cfg), 'candidateCount is unsupported in Gemini 3+');
    // thinkingBudget (a token count) was replaced by the thinkingLevel enum.
    assert.ok(!('thinkingBudget' in cfg.thinkingConfig), 'thinkingBudget is replaced by thinkingLevel');
    assert.ok(['low', 'medium', 'high'].includes(cfg.thinkingConfig.thinkingLevel),
      `thinkingLevel must be a supported enum, got ${cfg.thinkingConfig.thinkingLevel}`);
    // maxOutputTokens counts thinking tokens too, so a small cap makes a
    // thinking model return an empty string.
    assert.ok(cfg.maxOutputTokens >= 2048, `maxOutputTokens ${cfg.maxOutputTokens} leaves no room for thinking tokens`);
    assert.ok(!/gemini-1\.5/.test(sent.url), `shut-down model in url: ${sent.url}`);
    return `thinkingLevel=${cfg.thinkingConfig.thinkingLevel}, maxOutputTokens=${cfg.maxOutputTokens}`;
  });

  await step('gemini uses the native route with no key-prefix assumptions', async () => {
    const axios = require('axios');
    const saved = config.GEMINI_API_KEY;
    const realPost = axios.post;
    let sent = null;
    // An AQ... Auth key must be sent as a header on the native endpoint. AQ
    // keys are rejected by OpenAI-compatible routes with a misleading
    // "invalid_api_key", so neither the transport nor the key handling may
    // branch on the prefix.
    config.GEMINI_API_KEY = 'AQ.Ab12-example-auth-key';
    axios.post = async (url, body, opts) => {
      sent = { url, body, opts };
      return { data: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } };
    };
    try {
      await gemini.ask('hi');
    } finally {
      axios.post = realPost;
      config.GEMINI_API_KEY = saved;
      gemini._reset();
    }

    assert.ok(sent, 'no request was made');
    assert.ok(/generativelanguage\.googleapis\.com/.test(sent.url), `not the native endpoint: ${sent.url}`);
    assert.ok(!/openai/i.test(sent.url), `AQ keys cannot use an OpenAI-compatible route: ${sent.url}`);
    assert.strictEqual(sent.opts.headers['x-goog-api-key'], 'AQ.Ab12-example-auth-key');
    // Key must not ride in the URL, where proxies log it.
    assert.ok(!sent.url.includes('key='), 'API key must not be in the query string');
    return 'native route, x-goog-api-key header, no prefix branch';
  });

  await step('gemini extracts text and drops thought parts', () => {
    const body = {
      candidates: [{
        content: {
          parts: [
            { text: 'internal scratchpad', thought: true },
            { text: 'the actual ' },
            { text: 'answer' },
          ],
        },
      }],
    };
    // A thinking model interleaves thought parts. Shipping them would leak the
    // model's reasoning into chat and corrupt the prompt-rewriting commands.
    assert.strictEqual(gemini.extractText(body), 'the actual answer');
    assert.strictEqual(gemini.extractText({}), '');
    assert.strictEqual(gemini.extractText(null), '');
    return 'thought parts filtered';
  });

  await step('gemini falls back to a live model when one 404s', async () => {
    const axios = require('axios');
    const saved = config.GEMINI_API_KEY;
    const realPost = axios.post;
    const urls = [];
    config.GEMINI_API_KEY = 'AQ.fallback-key';
    // The configured model is unavailable to this project; the client must walk
    // its fallback list instead of leaving all 35 AI commands dead.
    axios.post = async (url) => {
      urls.push(url);
      const err = new Error('not found');
      err.response = { status: 404, data: { error: { message: 'models/x is not found' } } };
      throw err;
    };
    let answer;
    try {
      answer = await gemini.ask('hello');
    } finally {
      axios.post = realPost;
      config.GEMINI_API_KEY = saved;
      gemini._reset();
    }
    assert.strictEqual(answer, '', 'an unreachable Gemini must return empty, not throw');
    assert.ok(urls.length > 1, 'must try more than one model');
    for (const u of urls) assert.ok(!/gemini-1\.5/.test(u), `shut-down model tried: ${u}`);
    return `tried ${urls.length} models`;
  });

  await step('gemini returns empty with no key instead of throwing', async () => {
    const saved = config.GEMINI_API_KEY;
    config.GEMINI_API_KEY = '';
    try {
      assert.strictEqual(gemini.available(), false);
      assert.strictEqual(await gemini.ask('hello'), '');
    } finally {
      config.GEMINI_API_KEY = saved;
      gemini._reset();
    }
    return 'no key = empty answer, no crash';
  });

  // ── summary ───────────────────────────────────────────────
  console.log('\n=== SUMMARY ===');
  const passed = results.filter((r) => r.pass).length;
  console.log(`  ${passed}/${results.length} checks passed`);
  if (failures) {
    console.log(`\n  ${failures} FAILURE(S)`);
    results.filter((r) => !r.pass).forEach((r) => console.log(`   - ${r.label}: ${r.detail}`));
    console.log('');
    process.exit(1);
  }
  console.log('\n  All core systems PASS\n');
})().catch((err) => {
  console.error('\n💥 Test runner crashed:', err);
  process.exit(1);
});
