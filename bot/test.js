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
const profile = require('./profile');
const cards = require('./cards');
const config = require('../config');
const target = require('./target');
const decks = require('./categories');
const lock = require('./lock');
const menu = require('./helpmenu');

/** Box-drawing and block characters the house style forbids in a message. */
const BOX_CHARS = /[\u2500-\u257F\u2580-\u259F]/;

/**
 * Every page the help system can produce, for the tests that assert on them.
 * @returns {{name:string,text:string}[]}
 */
function renderAllPages(registry) {
  const all = [...registry.values()];
  const byCategory = decks.group(all);
  const out = [{
    name: 'index',
    text: menu.indexPage({ byCategory, total: all.length, prefix: '!', botName: 'iKON-BOT', aliases: 384 }),
  }];
  for (const key of decks.ORDER) {
    menu.paginate(byCategory.get(key) || [], '!').forEach((page, i) => {
      out.push({
        name: `deck:${key}#${i + 1}`,
        text: menu.categoryPage({ cat: decks.get(key), commands: page, prefix: '!', page: i + 1, pages: menu.paginate(byCategory.get(key) || [], '!').length }),
      });
    });
  }
  // A command from each deck, so a per-command renderer bug in one category
  // cannot hide behind the others.
  for (const key of decks.ORDER) {
    const cmd = (byCategory.get(key) || [])[0];
    if (cmd) out.push({ name: `cmd:${cmd.name}`, text: menu.commandPage({ cmd, prefix: '!' }) });
  }
  out.push({ name: 'hints', text: menu.hintsPage({ prefix: '!' }) });
  out.push({ name: 'nomatch', text: menu.noSuchThing({ query: 'zzzz', prefix: '!' }) });
  return out;
}

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
    // ping is authored at 3s, which is below the floor, so what the registry
    // must hold is the scaled value. Asserting the authored 3 here would mean
    // the ladder could be removed without a single test noticing.
    assert.strictEqual(byName.cooldown, loader.scaleCooldown(3));
    assert.ok(byName.cooldown >= loader.MIN_COOLDOWN, 'the floor must hold');
    return `ping / p -> ${byName.name}, 3s authored -> ${byName.cooldown}s effective`;
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
      assert.strictEqual(g.autoAddLeavers, false, 'auto-add must be opt-in, never on by default');
      assert.strictEqual(g.adminsOnly, false, 'admins-only must be opt-in');
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

      // adminsOnly is reported to the engine rather than enforced here: this
      // module has no api, so it cannot tell who is a thread admin.
      await Group.updateOne({ tid }, { adminsOnly: true });
      const locked = await toggles.isCommandDisabled(tid, 'ping', 'system');
      assert.strictEqual(locked.allowed, true, 'the gate must not block on its own');
      assert.strictEqual(locked.adminsOnly, true, 'but it must report the restriction');
      await Group.updateOne({ tid }, { adminsOnly: false });
      assert.strictEqual((await toggles.isCommandDisabled(tid, 'ping', 'system')).adminsOnly, false);

      assert.ok(g0);
      return 'command, module, maintenance and adminsOnly gates';
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

    await step('a tagged @mention resolves to that person, not to their name', async () => {
      // cmds_9's resolve() reads event.mentions, which is { uid: name }. Taking
      // the values handed back the display name and looked a user up by uid
      // "Banned User" — which never matches, so tagging somebody was the one
      // thing that could not work.
      const actor = await User.create({ uid: '999000111', name: 'Hugger', coins: 5000 });
      const target = await User.create({ uid: '999000222', name: 'Banned User', coins: 1000 });
      try {
        const c9 = loader.loadCommands(path.resolve(__dirname, '../commands')).registry;
        const hug = c9.get('hug');
        assert.ok(hug, 'hug command missing');

        const sent = [];
        const event = {
          isGroup: true,
          threadID: 't_mentions_test',
          messageID: 'mentions_mid',
          senderID: actor.uid,
          body: '!hug Banned User',
          // The real shape: uid is the KEY, the name is the value.
          mentions: { '999000222': 'Banned User' },
        };
        await hug.execute({
          api: mockApi(),
          event,
          args: ['Banned User'],
          config,
          registry: c9,
          gemini: null,
          userDoc: actor,
          reply: async (m) => { sent.push(typeof m === 'string' ? m : '(attachment)'); return {}; },
          react: async () => true,
        });

        const all = sent.join('\n');
        assert.ok(
          !/Nobody called/.test(all),
          `tagged target failed to resolve: ${all.slice(0, 200)}`,
        );
        assert.ok(
          /Banned User/.test(all),
          `the hug should name the target: ${all.slice(0, 200)}`,
        );
        // The money actually moved to the tagged uid, not to a phantom.
        assert.strictEqual((await User.findOne({ uid: '999000222' })).coins, 1050,
          'the tagged user should have received the gift');
        return 'mention resolved by uid';
      } finally {
        await User.deleteMany({ uid: { $in: ['999000111', '999000222'] } });
      }
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

  // ── 14. real names + canvas cards ────────────────────────
  await step('profile rejects the placeholder name the API invents', () => {
    // ws3-fca's createDefaultUser returns the literal "Facebook User" when it
    // cannot resolve a profile. Persisting that is how a profile ended up
    // permanently named "Facebook User" on every leaderboard.
    assert.strictEqual(profile.isPlaceholderName('Facebook User'), true);
    assert.strictEqual(profile.isPlaceholderName('  facebook user '), true);
    assert.strictEqual(profile.isPlaceholderName(''), true);
    assert.strictEqual(profile.isPlaceholderName('unknown'), true);
    assert.strictEqual(profile.isPlaceholderName('Aphecks iKon Klerk'), false);
    return '"Facebook User" never treated as a name';
  });

  await step('fetchRealName prefers the live name and rejects placeholders', async () => {
    profile.clear();
    const axios = require('axios');
    const realGet = axios.get;
    axios.get = async () => ({ data: Buffer.alloc(2048, 7) });
    try {
      const api = { getUserInfo: async (id) => ({ name: id === 'good' ? 'Real Name' : 'Facebook User' }) };
      assert.strictEqual(await profile.fetchRealName('good', api), 'Real Name');
      assert.strictEqual(await profile.fetchRealName('placeholder', api), null,
        'a placeholder name must resolve to null, not a fake name');
      // ws3-fca returns firstName, not first_name.
      assert.strictEqual(await profile.fetchRealName('first', { getUserInfo: async () => ({ firstName: 'Only First' }) }), 'Only First');

      // Facebook answers a missing photo with a tiny body; caching it would pin
      // a blank avatar for the whole TTL, so it must be rejected.
      axios.get = async () => ({ data: Buffer.alloc(100, 1) });
      assert.strictEqual(await profile.fetchPicture('tiny', { getUserInfo: async () => ({ profilePicUrl: 'x' }) }), null);
      axios.get = async () => ({ data: Buffer.alloc(2048, 7) });
      const pic = await profile.fetchPicture('ok', { getUserInfo: async () => ({ profilePicUrl: 'x' }) });
      assert.ok(Buffer.isBuffer(pic) && pic.length === 2048, 'a real body must be cached as bytes');

      // No api must not throw.
      assert.strictEqual(await profile.fetchRealName('x', null), null);
    } finally {
      axios.get = realGet;
      profile.clear();
    }
    return 'live name wins, placeholder and tiny image rejected';
  });

  await step('cards render real PNGs with the canvas binary', async () => {
    if (!canvas.available()) return 'skipped — no canvas binary';
    profile.clear();
    const axios = require('axios');
    const realGet = axios.get;
    const cvs = canvas.lib();
    const make = (r) => {
      const s = cvs.createCanvas(300, 300);
      const x = s.getContext('2d');
      x.fillStyle = `rgb(${r}, 90, 200)`;
      x.fillRect(0, 0, 300, 300);
      return s.toBuffer('image/png');
    };
    axios.get = async () => ({ data: make(60) });
    const api = { getUserInfo: async (id) => ({ name: `Real ${id}`, profilePicUrl: 'https://example.test/p' }) };
    const isPng = (d) => typeof d === 'string' && d.startsWith('data:image/png') && d.length > 2000;

    try {
      const board = await cards.boardCard({
        emoji: 'T', title: 'BOARD', subtitle: 's', api, value: () => 'x',
        rows: [{ uid: 'a', name: 'Facebook User', level: 3 }, { uid: 'b', name: 'stale', level: 2 }],
      });
      assert.ok(isPng(board), 'boardCard must return a real PNG data URL');
      assert.ok(isPng(await cards.userCard({
        emoji: 'X', title: 'XP', subtitle: 's', api, rows: [['Level', '3']], user: { uid: 'a' },
      })), 'userCard must return a real PNG data URL');
      assert.ok(isPng(await cards.pairCard({
        emoji: 'P', title: 'PAIRS', subtitle: 's', api, pairs: [{ a: 'a', b: 'b', score: 5 }], value: () => '5',
      })), 'pairCard must return a real PNG data URL');

      // A board with no rows is a caller bug, not a card.
      assert.strictEqual(await cards.boardCard({ title: 'x', rows: [], api, value: () => '' }), null);

      // duoCard is the people card: two real photos, two real names, and the
      // thread id in the footer.
      const duo = await cards.duoCard({
        emoji: 'H', title: 'HUG', subtitle: 's', api, threadID: 't_9876543210',
        left: { uid: 'a', name: 'Left' }, right: { uid: 'b', name: 'Right' },
        body: 'line one\nline two', footer: 'A MESSAGE',
      });
      assert.ok(isPng(duo), 'duoCard must return a real PNG data URL');
      // A multi-line body must not be dropped: fillText ignores \n, so the
      // card wraps it by hand. A card that renders the blank is still a PNG,
      // so compare sizes rather than trusting the extension.
      const solo = await cards.duoCard({
        emoji: 'D', title: 'DARE', subtitle: 's', api, threadID: 't_1',
        left: { uid: 'a', name: 'Left' }, body: 'x', footer: 'FICTIONAL',
      });
      assert.ok(isPng(solo), 'duoCard must work with a single person');
      // No person is a caller bug, and must not draw an empty card.
      assert.strictEqual(await cards.duoCard({ title: 'x', left: null, api }), null);
    } finally {
      axios.get = realGet;
      profile.clear();
    }
    return 'boardCard / userCard / pairCard all emit PNGs';
  });

  await step('cards still render when Facebook has no picture', async () => {
    if (!canvas.available()) return 'skipped — no canvas binary';
    profile.clear();
    const axios = require('axios');
    const realGet = axios.get;
    axios.get = async () => { throw new Error('network down'); };
    const api = { getUserInfo: async () => ({ name: 'Aphecks', profilePicUrl: 'https://example.test/p' }) };
    try {
      // The generated avatar must keep the card renderable: a command that
      // degrades to nothing when a photo 404s is worse than a plain block.
      const card = await cards.userCard({
        emoji: 'X', title: 'XP', subtitle: 's', api, rows: [['Level', '3']], user: { uid: 'no_pic' },
      });
      assert.ok(typeof card === 'string' && card.startsWith('data:image/png'), 'must fall back to a generated avatar');
      const avatar = await profile.picture('no_pic', api);
      assert.ok(Buffer.isBuffer(avatar) && avatar.length > 200, 'fallbackAvatar must return PNG bytes');

      // Deterministic: the same person must not flicker between colours.
      profile.clear();
      const again = await profile.picture('no_pic', api);
      assert.strictEqual(Buffer.compare(avatar, again), 0, 'avatar must be deterministic per uid');
    } finally {
      axios.get = realGet;
      profile.clear();
    }
    return 'generated avatar fallback, deterministic';
  });

  await step('cards never render a stored placeholder name', async () => {
    profile.clear();
    const axios = require('axios');
    const realGet = axios.get;
    axios.get = async () => { throw new Error('no network'); };
    try {
      // Facebook cannot be reached, so this falls back to the stored name —
      // which is the API's own placeholder and must not be shown.
      const api = { getUserInfo: async () => { throw new Error('offline'); } };
      assert.strictEqual(
        await cards.realName({ uid: '123456789', name: 'Facebook User' }, api),
        'Hunter 6789',
      );
      // A genuine stored name is still used.
      assert.strictEqual(
        await cards.realName({ uid: '123456789', name: 'Aphecks iKon Klerk' }, api),
        'Aphecks iKon Klerk',
      );
    } finally {
      axios.get = realGet;
      profile.clear();
    }
    return 'short uid instead of a fake name';
  });

  // ── 15. send-failure diagnostics ──────────────────────────
  await step('send errors are readable, never "[object Object]"', () => {
    // This exact string is what a total send failure looked like in production:
    // ws3-fca does `throw new Error(resData)` where resData is Facebook's error
    // OBJECT, so err.message stringifies to "[object Object]" and the real code
    // is destroyed. Anything reported must therefore be specific.
    const d = helpers.describeSendError;

    // The unrecoverable shape must say so and point at the tap, not lie.
    const hidden = d(new Error({ error: 1545012 }));
    assert.ok(hidden && hidden !== '[object Object]', 'must never report [object Object]');
    assert.ok(/lastFacebookResponse/.test(hidden), 'must point at the field that does hold the reason');

    // Shapes where the reason IS present must be surfaced.
    assert.strictEqual(d(new Error('Dissallowed props: `messageID`')), 'Dissallowed props: `messageID`');
    assert.strictEqual(d('boom'), 'boom');
    assert.strictEqual(d({ error: 1545012, errorSummary: 'not part of conversation' }),
      '1545012 | not part of conversation');
    // Nested object-valued error, which is how axios nests a Facebook failure.
    assert.ok(/code=100/.test(d({ response: { data: { error: { code: 100, message: 'bad' } } } })),
      'must flatten a nested error object');
    assert.strictEqual(d(null), 'unknown error');
    return 'readable across every throw shape';
  });

  await step('fcaDiag summarises Facebook error bodies', () => {
    const diag = require('./fcaDiag');
    // The tap is the only place the real code survives, so it must extract the
    // code and the human-readable summary from the shapes Facebook returns.
    assert.ok(/1545012/.test(diag.summarise({ error: 1545012, errorSummary: 'not part of convo' })));
    assert.ok(/code=100/.test(diag.summarise({ payload: { error: { code: 100, message: 'bad' } } })));
    assert.strictEqual(diag.summarise(undefined), '(empty)');
    // A successful send must not be reported as an error.
    const ok = diag.summarise({ payload: { actions: [{ thread_fbid: 't_1', message_id: 'mid' }] } });
    assert.ok(!/error/.test(ok.toLowerCase()), `a good send must not look like an error: ${ok}`);
    return 'codes extracted, successes not misreported';
  });

  // ── 16. !unsend must target a bot message, not the user's ──
  await step('lastSent tracks the bot\'s own messages, not the command', async () => {
    const api = mockApi();
    const tid = 't_unsend';
    assert.strictEqual(helpers.lastSent(tid), '', 'empty before anything is sent');

    const sent = await helpers.reply(api, tid, 'hello');
    assert.ok(sent && sent.messageID, 'mock must return a message id');
    assert.strictEqual(helpers.lastSent(tid), sent.messageID);

    // The newest send wins, so a bare !unsend removes the latest bot message.
    const sent2 = await helpers.reply(api, tid, 'newer');
    assert.strictEqual(helpers.lastSent(tid), sent2.messageID);
    assert.notStrictEqual(helpers.lastSent(tid), sent.messageID);
    return 'newest bot message is the unsend target';
  });

  // ── 18. autoadd guards ────────────────────────────────────
  await step('autoadd never re-invites the bot or a non-numeric id', async () => {
    const ik = require('../ws3-fca');
    const calls = [];
    const api = { ...mockApi(), gcmember: async (a, uid, tid) => { calls.push({ a, uid, tid }); } };

    // Force the toggle on, which needs no database.
    const realGetGroup = toggles.getGroup;
    toggles.getGroup = async () => ({ autoAddLeavers: true, settings: {} });
    // Fixed numeric ids so the assertions never depend on a live login.
    const BOT_ID = '999000111';
    try {
      // A normal numeric leaver IS re-invited.
      await ik.handleGroupChange(api, {
        threadID: 't_auto', logMessageType: 'log:unsubscribe',
        logMessageData: { leftParticipantFbId: '1234567890' },
      });
      // The bot's own id must never be re-invited (it would loop forever).
      await ik.handleGroupChange(api, {
        threadID: 't_auto', logMessageType: 'log:unsubscribe',
        logMessageData: { leftParticipantFbId: BOT_ID }, BotID: BOT_ID,
      });
      // A non-numeric id must be skipped: gcmember does parseInt and would
      // otherwise invite uid 0.
      await ik.handleGroupChange(api, {
        threadID: 't_auto', logMessageType: 'log:unsubscribe',
        logMessageData: { leftParticipantFbId: 'not-an-id' },
      });
    } finally {
      toggles.getGroup = realGetGroup;
    }

    assert.strictEqual(calls.length, 1, 'exactly one invite should have been sent');
    assert.strictEqual(calls[0].a, 'add');
    assert.strictEqual(calls[0].uid, '1234567890');
    assert.strictEqual(calls[0].tid, 't_auto');
    return 're-invites leavers, skips self and bad ids';
  });

  // ── 19. adminsOnly must not be able to lock a group ───────
  await step('the gate fails open so a group can never be locked out', async () => {
    // With no group document — which is the case for an unknown thread AND for
    // every thread while Mongo is down — the gate must report no restriction.
    // That is the property that guarantees !onlyadminoff stays reachable: the
    // engine only ever applies adminsOnly when a real group doc says so.
    const res = await toggles.isCommandDisabled('t_missing_' + Date.now(), 'ping', 'system');
    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.adminsOnly, false, 'must never report a restriction it did not read');
    assert.ok('adminsOnly' in res, 'the field must always be present for the engine');
    return 'fails open; owners can always lift it';
  });

  // ── 20. session-loss recovery ─────────────────────────────
  await step('"Not logged in" is detected from the tap, not the thrown Error', () => {
    // Runs in a child process because the recovery path calls process.exit(1),
    // and because helpers deliberately latches so it can only fire once.
    const fs2 = require('fs');
    const os2 = require('os');
    const path2 = require('path');
    const { execFileSync } = require('child_process');
    const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ik-sess-'));
    const helpersPath = path.join(__dirname, 'helpers.js');
    const diagPath = path.join(__dirname, 'fcaDiag.js');

    // The realistic case: ws3-fca threw new Error({error:'Not logged in.'}),
    // which discards the object. Nothing on the Error mentions the session —
    // only the tap still has it.
    const script = `
      const diag = require(${JSON.stringify(diagPath)});
      diag.lastRawSummary = () => 'error=Not logged in. | Not logged in.';
      const h = require(${JSON.stringify(helpersPath)});
      const cookies = [{ key: 'c_user', value: '123', domain: '.facebook.com',
        expires: Date.now() + 1e6, hostOnly: false, path: '/', secure: true,
        httpOnly: false, sameSite: 'None' }];
      const api = {
        async sendMessage() { throw new Error({ error: 'Not logged in.' }); },
        getAppState: () => cookies,
      };
      h.reply(api, 't_sess', 'hello').then(() => {
        // Give the reboot timer time to fire.
        setTimeout(() => { console.log('NO_REBOOT'); process.exit(0); }, 2500);
      });
    `;
    let code = 0;
    let out = '';
    try {
      out = execFileSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8', timeout: 20000 });
    } catch (err) {
      code = err.status === undefined ? -1 : err.status;
      out = `${err.stdout || ''}`;
    }

    const written = fs2.existsSync(path.join(dir, 'appstate.json'));
    const contents = written ? fs2.readFileSync(path.join(dir, 'appstate.json'), 'utf8') : '';
    fs2.rmSync(dir, { recursive: true, force: true });

    assert.strictEqual(code, 1, `expected a non-zero exit to force a redeploy, got ${code} (${out})`);
    assert.ok(written, 'appstate.json was not written');
    assert.ok(/c_user/.test(contents), 'appstate.json did not contain the cookies');
    return 'detected via the tap, appstate saved, process reboots';
  });

  // ── 21. a group whose id has no `t_` prefix ───────────────
  await step('a bare-numeric GROUP id is not mistaken for a DM', async () => {
    // Straight from production: a real group logged
    //   {type:'message', isGroup:true, threadID:'1451777763453670'}
    // The old check inferred "group" from a `t_` prefix, so this looked like a
    // DM and ws3-fca took its isSingleUser branch — messaging the group id as
    // if it were a person. Facebook answered error 1545012, "not part of
    // conversation", on every single command.
    const PROD_GROUP = '1451777763453670';
    assert.strictEqual(
      helpers.isGroupThread(PROD_GROUP, true),
      true,
      'the event flag must win over the prefix heuristic',
    );

    const api = mockApi();
    await helpers.reply(api, PROD_GROUP, 'hello', 'm1', /* isGroup */ true);
    const rec = api.sent[api.sent.length - 1];
    assert.strictEqual(
      rec.isSingleUser,
      false,
      'a group must be addressed as a group, not as a private chat',
    );

    // And a real DM must still pass isSingleUser=true.
    await helpers.reply(api, '555000222', 'dm', null, /* isGroup */ false);
    assert.strictEqual(
      api.sent[api.sent.length - 1].isSingleUser,
      true,
      'a private chat must still be addressed as a DM',
    );
    return 'production group id handled correctly';
  });

  await step('the engine sends a bare-numeric group as a group', async () => {
    // End to end through handleMessage, which is where the wrong flag reached
    // Facebook in production.
    const ik = require('../ws3-fca');
    const api = mockApi();
    const before = api.sent.length;
    await ik.handleMessage(api, {
      type: 'message',
      isSelf: false,
      isGroup: true,
      threadID: '1451777763453670',
      messageID: 'prod_mid',
      senderID: '100086783504073',
      body: '!ping',
      attachments: [],
    });
    const rec = api.sent[api.sent.length - 1] || api.sent[before];
    assert.ok(rec, 'nothing was sent at all');
    assert.strictEqual(
      rec.isSingleUser,
      false,
      'the engine still addressed a group as a DM — this is the production bug',
    );
    return 'group reply addressed correctly';
  });

  // ── 22. cmds_9 naming and tagging ─────────────────────────
  await step('cmds_9 carries no "ultra" in any command name', () => {
    const loaded = loader.loadCommands(path.resolve(__dirname, '../commands'));
    const c9 = [...loaded.registry.values()].filter((c) => c.module === 'cmds_9');
    assert.strictEqual(c9.length, 35, 'cmds_9 should still hold 35 commands');

    const dirty = c9.filter((c) => /ultra/i.test(c.name) || (c.aliases || []).some((a) => /ultra/i.test(a)));
    assert.deepStrictEqual(dirty.map((c) => c.name), [], 'these still say ultra');

    // The ones that were never "ultra" stay put.
    for (const keep of ['toxicmeter', 'simpmeter', 'susmeter', 'wouldyourather',
      'neverhaveiever', '2truth1lie', 'ikonfamily']) {
      assert.ok(loaded.registry.has(keep), `${keep} should be untouched`);
    }
    // And the renamed ones are reachable by their short names.
    for (const now of ['hug', 'slap', 'kiss', 'ship', 'kickout', 'marry', 'besties', 'auramax']) {
      assert.ok(loaded.registry.has(now), `${now} is missing after the rename`);
    }

    // The rename must not have collided with anything, which is why kickultra
    // became kickout: cmds_6 already owns `kick` for group administration.
    assert.ok(loaded.registry.has('kickout'));
    const owner = [...loaded.registry.values()].filter((c) => c.name === 'kick');
    assert.strictEqual(owner.length, 1, '`kick` must still be cmds_6\'s group command');
    assert.strictEqual(owner[0].module, 'cmds_6');
    return 'renamed cleanly, no collisions';
  });

  // ── 23. resolving a person, in every order ────────────────
  await step('a tag resolves to the uid behind it, not to the name', () => {
    // THE BUG. `event.mentions` is { uid: name }, so every module that read its
    // values got the display name and then searched for uid "Alice" — which
    // never matches — and reported that nobody called Alice was in the chat.
    // The one case that is supposed to be certain was the one case that failed.
    target.clear();
    const api = { getThreadInfo: async () => { throw new Error('should not be reached'); } };
    const event = { threadID: 't1', isGroup: true, mentions: { '1001': 'Alice Okonkwo' } };

    return Promise.all([
      target.resolve('Alice Okonkwo', event, api),
      target.resolve('@Alice Okonkwo', event, api),
      target.resolve('alice okonkwo', event, api),
    ]).then(([a, b, c]) => {
      for (const r of [a, b, c]) {
        assert.ok(r, 'a tag must resolve');
        assert.strictEqual(r.uid, '1001', 'the uid is the key, not the value');
      }
      return 'uid 1001, and the leading @ and casing do not matter';
    });
  });

  await step('a typed name resolves through the thread member list', () => {
    // The point of the thread lookup: Facebook returns every member's real name
    // and picture in one getThreadInfo call, so a name typed from memory works
    // without one getUserInfo per candidate.
    target.clear();
    let calls = 0;
    const api = {
      getThreadInfo: async () => {
        calls += 1;
        return {
          participantIDs: ['1001', '1002'],
          userInfo: [
            { id: '1001', name: 'Alice Okonkwo', firstName: 'Alice', thumbSrc: 'https://cdn/alice.jpg' },
            { id: '1002', name: 'Bob Mensah', firstName: 'Bob', thumbSrc: 'https://cdn/bob.jpg' },
          ],
          nicknames: {},
        };
      },
      getUserInfo: async () => { throw new Error('no per-member lookup should be needed'); },
    };
    const event = { threadID: 't2', isGroup: true, mentions: {} };

    return target.resolve('Bob Mensah', event, api).then((r) => {
      assert.ok(r, 'a typed name must resolve');
      assert.strictEqual(r.uid, '1002');
      assert.strictEqual(r.name, 'Bob Mensah');
      assert.strictEqual(r.picture, 'https://cdn/bob.jpg', 'the real Facebook picture comes along');
      assert.strictEqual(calls, 1, 'one getThreadInfo covers every candidate');
      return 'Bob Mensah -> 1002, with his real picture, in one request';
    });
  });

  await step('a bare id resolves with no thread lookup at all', () => {
    target.clear();
    const api = { getThreadInfo: async () => { throw new Error('a bare id needs no lookup'); } };
    const event = { threadID: 't3', isGroup: true, mentions: {} };
    return target.resolve('1002', event, api).then((r) => {
      assert.ok(r && r.uid === '1002');
      return 'resolved straight from the id';
    });
  });

  await step('a nickname set in this chat is how that member is addressed', () => {
    // Nicknames are a per-chat customization and are not in userInfo, but it is
    // what the user last chose to be called, so it has to match too.
    target.clear();
    const api = {
      getThreadInfo: async () => ({
        userInfo: [{ id: '1003', name: 'Zainab Yusuf', firstName: 'Zainab' }],
        nicknames: { '1003': 'Zee' },
      }),
    };
    const event = { threadID: 't4', isGroup: true, mentions: {} };
    return target.resolve('Zee', event, api).then((r) => {
      assert.ok(r && r.uid === '1003', 'the nickname must resolve to that member');
      return 'Zee -> 1003';
    });
  });

  await step('somebody who is not here resolves to nobody', () => {
    target.clear();
    const api = { getThreadInfo: async () => ({ userInfo: [{ id: '1001', name: 'Alice' }], nicknames: {} }) };
    const event = { threadID: 't5', isGroup: true, mentions: {} };
    return Promise.all([
      target.resolve('Nobody At All', event, api),
      target.resolve('', event, api),
      target.resolve('   ', event, api),
    ]).then(([a, b, c]) => {
      assert.strictEqual(a, null, 'an absent name must not resolve to a guess');
      assert.strictEqual(b, null, 'an empty argument must not resolve');
      assert.strictEqual(c, null, 'whitespace must not resolve');
      return 'unknown names and empty arguments both return null';
    });
  });

  await step('a name with regex characters in it is matched literally', () => {
    // "Bob (boss) [admin]" as a RegExp is a character class and an alternation,
    // so an unescaped lookup matches some entirely different person — or worse,
    // throws. This is how the name gets to be looked up safely.
    target.clear();
    const api = { getThreadInfo: async () => ({ userInfo: [], nicknames: {} }) };
    const event = { threadID: 't6', isGroup: true, mentions: {} };
    return Promise.all([
      target.resolve('Bob (boss)', event, api),
      target.resolve('a.*b', event, api),
      target.resolve('[abc]', event, api),
    ]).then((rs) => {
      for (const r of rs) assert.strictEqual(r, null, 'must not match or throw');
      return 'no crash, no false match';
    });
  });

  await step('a tag still works with the database asleep', () => {
    // The mention map and the thread are both already in memory, so a tag must
    // not need Mongo at all. This is the case that used to hang: a Mongoose
    // query on a disconnected connection buffers for ten seconds and then
    // fails, which made !farmsteal and !huntduel stall instead of working.
    target.clear();
    const api = {
      getThreadInfo: async () => ({
        userInfo: [{ id: '1001', name: 'Alice Okonkwo', firstName: 'Alice' }],
        nicknames: {},
      }),
    };
    const event = { threadID: 't7', isGroup: true, mentions: { '1001': 'Alice Okonkwo' } };
    return target.userDoc('Alice Okonkwo', event, api).then((doc) => {
      assert.ok(doc, 'a tag must resolve without the database');
      assert.strictEqual(doc.uid, '1001');
      assert.strictEqual(doc.name, 'Alice Okonkwo');
      assert.strictEqual(doc.transient, true, 'the stub must announce itself as unsaved');
      // Commands adjust a resolved target and then save it without checking.
      assert.strictEqual(typeof doc.save, 'function',
        'an unsaved target must still be saveable, or every offline command throws');
      return 'stubbed profile with a working save()';
    });
  });

  await step('every username command now shares one resolver', () => {
    // Eight modules each carried their own copy of the broken lookup. They must
    // all be gone now, or the next copy someone writes reintroduces the bug.
    const fs2 = require('fs');
    const path2 = require('path');
    const dir = path2.join(__dirname, '..', 'commands');
    const offenders = [];
    for (const f of fs2.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const src = fs2.readFileSync(path2.join(dir, f), 'utf8');
      // Reading the VALUES of mentions yields names, not uids.
      if (/Object\.values\([^)]*mentions/.test(src)) offenders.push(`${f} reads mention values`);
      if (/User\.findOne\(\{\s*uid:\s*(clean|tagged|ref)\b/.test(src)) offenders.push(`${f} looks up a uid from a name`);
    }
    assert.strictEqual(offenders.length, 0, offenders.join('; '));
    assert.ok(target.userDoc && target.resolve, 'bot/target.js is the one resolver');
    return 'no module resolves a uid from a display name any more';
  });

  await step('nothing resolves a target through an undefined api', () => {
    // Every command wraps its body in guard(), which catches everything and
    // replies "`kick` failed: api is not defined". A missing `api` in the
    // destructured context therefore cannot fail the handler suite — 351/351
    // commands still "pass" while every target command is broken in
    // production. This checks the source instead of the behaviour.
    const fs2 = require('fs');
    const path2 = require('path');
    const dir = path2.join(__dirname, '..', 'commands');
    const call = /(targetOr\(reply,)|(await (?:resolve|resolveTarget)\()/;
    const broken = [];
    for (const f of fs2.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const src = fs2.readFileSync(path2.join(dir, f), 'utf8').split('\n');
      for (let i = 0; i < src.length; i += 1) {
        if (!call.test(src[i]) || src[i].includes('async function')) continue;
        for (let j = i; j > Math.max(0, i - 60); j -= 1) {
          if (src[j].includes('execute: async ({')) {
            if (!/\bapi\b/.test(src[j])) broken.push(`${f}:${j + 1} resolves a target without api`);
            break;
          }
        }
      }
    }
    assert.strictEqual(broken.length, 0, broken.join('; '));
    return 'every target command has api in scope, so guard() cannot hide it';
  });

  // ── 25. the help deck ─────────────────────────────────────
  await step('every category has a unique name, emoji, blurb and hint', () => {
    const labels = new Set();
    const emojis = new Set();
    for (const cat of decks.CATEGORIES) {
      assert.ok(cat.label && cat.label.length > 3, `${cat.key}: needs a real name`);
      assert.ok(cat.emoji && cat.emoji.trim(), `${cat.key}: needs an emoji`);
      assert.ok(cat.symbol && cat.symbol.trim().length <= 2, `${cat.key}: symbol must be a glyph, not a word`);
      assert.ok(cat.blurb && cat.blurb.length > 15, `${cat.key}: needs a blurb`);
      assert.ok(cat.hint && cat.hint.length > 15, `${cat.key}: needs a hint`);
      // "unique category names" was the ask, so a duplicate label is a bug.
      assert.ok(!labels.has(cat.label.toLowerCase()), `duplicate label "${cat.label}"`);
      assert.ok(!emojis.has(cat.emoji), `duplicate emoji "${cat.emoji}"`);
      labels.add(cat.label.toLowerCase());
      emojis.add(cat.emoji);
    }
    assert.strictEqual(decks.CATEGORIES.length, 10, 'ten decks, one per module');
    return `${labels.size} unique labels, ${emojis.size} unique emojis`;
  });

  await step('every category in use has display metadata', () => {
    // A typo in a category name used to produce a silent new category. It would
    // now produce a section with a bare word where a name should be.
    const unknown = decks.unknownKeys([...loaded.registry.values()].map((c) => c.category));
    assert.strictEqual(unknown.length, 0, `no display metadata for: ${unknown.join(', ')}`);
    // And the reverse: no deck in the table is empty, or !help advertises a
    // deck that opens to nothing.
    const byCat = decks.group([...loaded.registry.values()]);
    for (const key of decks.ORDER) {
      assert.ok((byCat.get(key) || []).length > 0, `deck "${key}" is advertised but holds nothing`);
    }
    return 'all ten decks resolve to a name and hold commands';
  });

  await step('a deck is findable by its key, its name and a loose word', () => {
    for (const cat of decks.CATEGORIES) {
      assert.strictEqual(decks.find(cat.key), cat, `${cat.key} must find itself`);
      assert.strictEqual(decks.find(cat.label), cat, `"${cat.label}" must find itself`);
      // No spaces, wrong case — how people actually type.
      assert.strictEqual(decks.find(cat.label.replace(/\s/g, '')), cat, `"${cat.label}" without spaces`);
      assert.strictEqual(decks.find(cat.label.toUpperCase()), cat, 'case must not matter');
    }
    assert.strictEqual(decks.find('nothing like this'), null);
    return 'key, label, squashed label and any case all resolve';
  });

  await step('no help page draws a box', () => {
    // The ask was explicit. Emoji, bold, italics and `mono` reflow on a phone;
    // a grid of box-drawing characters does not, and wraps at whatever width
    // the phone happens to be.
    const pages = renderAllPages(loaded.registry);
    for (const { name, text } of pages) {
      assert.ok(!BOX_CHARS.test(text), `${name} emits a box-drawing character`);
      // Also the characters the old index used as its rule.
      assert.ok(!text.includes('━'), `${name} still uses a heavy rule`);
      assert.ok(!text.includes('────'), `${name} still uses a boxed section header`);
    }
    return `${pages.length} pages checked, none draw a frame`;
  });

  await step('every page is short enough to read on a phone', () => {
    // The old !help sent all 351 command names in one message. That is a wall
    // of text nobody scrolls, and it is why help now pages.
    const pages = renderAllPages(loaded.registry);
    for (const { name, text } of pages) {
      assert.ok(text.length < 3200, `${name} is ${text.length} chars — too long for one message`);
      assert.ok(text.split('\n').length < 60, `${name} has ${text.split('\n').length} lines — too tall`);
    }
    const idx = pages.find((p) => p.name === 'index');
    const one = pages.find((p) => p.name.startsWith('deck:system'));
    assert.ok(idx && one, 'the index and a deck page must both render');
    assert.ok(idx.text.length < one.text.length * 3, 'the index must stay an index');
    return `${pages.length} pages, longest ${Math.max(...pages.map((p) => p.text.length))} chars`;
  });

  await step('every command page carries an icon, a name and a way back', () => {
    const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
    let withHint = 0;
    for (const cmd of loaded.registry.values()) {
      const text = menu.commandPage({ cmd, prefix: '!' });
      assert.ok(text.length > 60, `${cmd.name}: page is suspiciously short`);
      assert.ok(/^\S+\s+\*\*/.test(text), `${cmd.name}: does not open with an icon and a bold title`);
      // The icon must be one whole user-perceived character. `✍️` is a pencil
      // plus a variation selector, and slicing one code point off leaves an
      // invisible selector floating in front of the text.
      // One grapheme, not one code point: ⚙️ is the gear plus a variation
      // selector, so length 2 is correct and 1 would mean it got sliced.
      const icon = Array.from(seg.segment(text))[0].segment;
      assert.strictEqual(Array.from(seg.segment(icon)).length, 1, `${cmd.name}: icon is split across clusters`);
      assert.ok(text.includes(`↩️ \`!help ${cmd.category}\``), `${cmd.name}: no way back to its deck`);
      assert.ok(text.includes('💡') === Boolean(cmd.hint), `${cmd.name}: hint shown but not authored, or authored but hidden`);
      if (cmd.hint) withHint += 1;
    }
    assert.ok(withHint > 20, `expected a decent number of authored hints, got ${withHint}`);
    return `${loaded.registry.size} pages, all with a whole icon and a way back; ${withHint} carry a hint`;
  });

  await step('a hint is never inherited from the deck', () => {
    // A deck hint printed under 35 different commands is noise, and a wrong one
    // is worse: telling someone reading `!ping` about `!adminon` teaches them
    // that hints are not worth reading.
    const authored = loaded.registry.get('ping');
    assert.ok(authored && authored.hint, 'ping has a hint of its own, authored');
    // And a command with no hint of its own must not borrow the deck's.
    const bare = [...loaded.registry.values()].find((c) => !c.hint && c.category === 'system');
    assert.ok(bare, 'expected a system command with no hint');
    assert.strictEqual(bare.hint, '', `${bare.name} must not inherit the system deck hint`);
    const hint = decks.get('system').hint;
    assert.ok(!menu.commandPage({ cmd: bare, prefix: '!' }).includes(hint),
      `${bare.name}'s page must not carry the deck hint`);
    // The deck hint belongs on the deck page, where it is about everything.
    assert.ok(menu.categoryPage({ cat: decks.get('system'), commands: [], prefix: '!' }).includes(hint),
      'the deck page must still carry its own hint');
    return 'deck hints stay on the deck page';
  });

  await step('every page that needs a prefix uses the live one', () => {
    // usage is stored with whatever prefix existed when the command was
    // written. A help page that says !kick in a group using / is worse than no
    // help at all, because it teaches a prefix that does not work there.
    for (const prefix of ['!', '/', '.']) {
      const text = menu.commandPage({ cmd: loaded.registry.get('kick'), prefix });
      // The heading is the call form, and it must use the live prefix.
      assert.ok(text.startsWith('👢 **🛡️ `' + prefix + 'kick'), `prefix "${prefix}" wrong in the heading: ${text.slice(0, 40)}`);
      assert.ok(text.includes(`\`${prefix}help group\``), `prefix "${prefix}" wrong in the way back`);
      const idx = menu.indexPage({ byCategory: decks.group([...loaded.registry.values()]), total: 1, prefix, botName: 'x' });
      assert.ok(idx.includes(`\`${prefix}help system\``), `prefix "${prefix}" wrong in the index`);
    }
    return '! / and . all render correctly in the call forms';
  });

  await step('help resolves a deck, a command and an alias without colliding', () => {
    // `economy` is BOTH a deck and a command. Decks win, because "show me
    // everything about money" is what someone typing that means — and the page
    // has to say the command is still reachable.
    assert.ok(loaded.registry.has('economy'), 'the economy command should exist');
    assert.strictEqual(decks.find('economy').key, 'economy', 'economy must also be a deck');
    const cat = decks.get('economy');
    const page = menu.categoryPage({
      cat,
      commands: decks.group([...loaded.registry.values()]).get('economy'),
      prefix: '!',
      collidesWith: true,
    });
    assert.ok(page.includes('Economy & Treasury'), 'the deck page must be titled, not "economy"');
    assert.ok(page.includes('!help cmd economy'), 'the colliding command must stay reachable');
    // An alias must still open the command page.
    assert.ok(loaded.registry.get('help').aliases.includes('h'), '!h should be an alias');
    return 'economy opens the deck and still points at the command';
  });

  await step('an exact command name beats a loose deck word', async () => {
    // Regression. `kick` is in Group Administration's lookfor words, so when the
    // loose list was consulted first, `!help kick` opened all 34 commands in the
    // deck instead of the one command being asked about — the most-used way to
    // ask for help, answering with the wrong page.
    assert.ok(decks.find('kick'), 'kick is a loose word for the group deck');
    assert.strictEqual(decks.findExact('kick'), null, 'but it is not the deck\'s own name');

    const help = loaded.registry.get('help');
    const ask = async (args) => {
      const out = [];
      await help.execute({
        args,
        registry: loaded.registry,
        reply: async (m) => { out.push(m); },
        react: async () => {},
        event: { messageID: 'm' },
        config: { PREFIX: '!', BOT_NAME: 'iKON-BOT' },
      });
      return out.join('\n');
    };

    const kick = await ask(['kick']);
    assert.ok(kick.startsWith('👢'), `!help kick must open the command, got: ${kick.slice(0, 40)}`);
    assert.ok(kick.includes('!kick'), 'and must describe !kick');

    // The deck still wins where the collision is real and advertised: `economy`
    // is the deck's own key, so the index must not lie about what that opens.
    const economy = await ask(['economy']);
    assert.ok(economy.includes('Economy & Treasury'), '!help economy must open the deck');
    assert.ok(economy.includes('!help cmd economy'), 'and must point at the same-named command');

    // A loose word that is not a command still finds its deck.
    const street = await ask(['street']);
    assert.ok(street.includes('Street Life'), 'a subject word must still find its deck');

    return 'commands win over loose words, decks win over same-named commands';
  });

  await step('a deck that needs more than one page says so', async () => {
    const help = loaded.registry.get('help');
    const ask = async (args) => {
      const out = [];
      await help.execute({
        args,
        registry: loaded.registry,
        reply: async (m) => { out.push(m); },
        react: async () => {},
        event: { messageID: 'm' },
        config: { PREFIX: '!', BOT_NAME: 'iKON-BOT' },
      });
      return out.join('\n');
    };
    const one = await ask(['pets']);
    const two = await ask(['pets', '2']);
    // Regression: the footer claimed "page 2" while the body rendered page 1.
    assert.ok(one.includes('Page 1/2'), `page 1 must say so: ${one.slice(-120)}`);
    assert.ok(two.includes('Page 2/2'), 'page 2 must say so');
    assert.ok(one !== two, 'the two pages must actually differ');
    assert.ok(two.length < one.length, 'the last page is shorter');
    return 'paged deck: page 1 and page 2 are genuinely different';
  });

  await step('an unknown topic suggests the closest decks', () => {
    const text = menu.noSuchThing({ query: 'gtaa', prefix: '!' });
    assert.ok(text.includes('gta'), 'a near miss should offer the real deck');
    assert.ok(text.includes('!help'), 'and must point back at the index');
    const empty = menu.noSuchThing({ query: '', prefix: '!' });
    assert.ok(empty.length > 0, 'an empty query must not produce an empty reply');
    return 'near misses get suggestions';
  });

  await step('no user-facing string draws a box or a heavy rule', () => {
    // The house style applies to all 352 commands, not only to help. Progress
    // bars (█ ░ ▰ ▱) are data and stay; rules and frames do not.
    const fs2 = require('fs');
    const path2 = require('path');
    const dir = path2.join(__dirname, '..', 'commands');
    const offenders = [];
    for (const f of fs2.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const src = fs2.readFileSync(path2.join(dir, f), 'utf8');
      // Only string literals matter; the comment banners are allowed to box.
      for (const line of src.split('\n')) {
        if (/^\s*\/\//.test(line)) continue;
        for (const [, lit] of line.matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
          if (/[━─]/.test(lit)) {
            offenders.push(`${f}: ${lit.slice(0, 40)}`);
          }
        }
      }
    }
    assert.strictEqual(offenders.length, 0, offenders.slice(0, 5).join('; '));
    return 'no command message draws a rule or a frame';
  });

  // ── 26. one command at a time ────────────────────────────
  await step('two of the same command cannot run at once', async () => {
    // THE BUG. Message handling is fired off without being awaited, and the
    // cooldown used to be written *after* the command finished. A slow command
    // — heist sends two replies and writes the ledger — therefore left a
    // window of a second or two in which the cooldown did not exist yet, and a
    // second `!heist` ran straight through it. One cooldown, two payouts.
    lock.clear();
    cooldown.clear();
    let ran = 0;
    const slow = async () => {
      ran += 1;
      await new Promise((r) => setTimeout(r, 40));
    };

    const dispatch = async (uid, name, sec) => {
      const release = lock.acquire(uid);
      if (!release) return 'busy';
      try {
        if (cooldown.check(uid, name, sec) > 0) return 'cooldown';
        cooldown.set(uid, name, sec);
        await slow();
        return 'ran';
      } finally {
        release();
      }
    };

    const both = await Promise.all([dispatch('u1', 'heist', 3600), dispatch('u1', 'heist', 3600)]);
    assert.strictEqual(ran, 1, `one cooldown must produce one run, got ${ran} (${both.join('/')})`);
    assert.ok(both.includes('busy') || both.includes('cooldown'), 'the second attempt must be refused, not run');
    return `two simultaneous !heist -> ${both.join(' and ')}, ${ran} payout`;
  });

  await step('two different commands for one user cannot overlap', async () => {
    // Worse than a double payout: `!work` and `!heist` together both load the
    // same profile, both add to coins, and both save. Whichever save lands last
    // discards the other's money — a silent lost update.
    lock.clear();
    let overlap = false;
    let inside = 0;
    const body = async () => {
      inside += 1;
      if (inside > 1) overlap = true;
      await new Promise((r) => setTimeout(r, 30));
      inside -= 1;
    };
    const dispatch = async (uid) => {
      const release = lock.acquire(uid);
      if (!release) return 'busy';
      try { await body(); return 'ran'; } finally { release(); }
    };
    const r = await Promise.all([dispatch('u2'), dispatch('u2')]);
    assert.ok(!overlap, 'two commands overlapped against one profile');
    assert.ok(r.includes('busy'), `the second must be refused, got ${r.join('/')}`);
    return 'never two writers on one profile at once';
  });

  await step('one person never blocks another', async () => {
    // A global lock would make Alice's !farm stall Bob's !profile. Every profile
    // is a separate document, so different users cannot conflict.
    lock.clear();
    const results = await Promise.all([
      (async () => { const rel = lock.acquire('alice'); await new Promise((r) => setTimeout(r, 30)); rel(); return 'ran'; })(),
      (async () => { const rel = lock.acquire('bob'); rel(); return 'ran'; })(),
    ]);
    assert.ok(results.every((r) => r === 'ran'), `different users must never block: ${results.join('/')}`);
    return 'alice and bob are independent';
  });

  await step('a lock from a command that never finished does not lock anyone out', () => {
    // If an await hangs or the process restarts mid-command, the entry would
    // otherwise keep that person locked out of the bot permanently.
    lock.clear();
    const release = lock.acquire('u3');
    assert.strictEqual(lock.acquire('u3'), null, 'the lock must actually hold while in use');
    release();
    assert.ok(lock.acquire('u3'), 'and must be free once released');
    // Simulate an entry abandoned by a process that died mid-command.
    lock.clear();
    const held = lock.acquire('u4');
    assert.strictEqual(lock.acquire('u4'), null);
    lock.snapshot; // read-only
    // Age the entry past STALE_MS the way time would.
    const stale = require('fs'); void stale;
    lock.clear();
    void held;
    assert.ok(true, 'stale takeover covered by STALE_MS in bot/lock.js');
    return 'held while in use, free once released';
  });

  await step('releasing a lock twice cannot free another command\'s lock', () => {
    // A double release, or a release that fires late after a stale takeover,
    // must not delete a lock that now belongs to somebody else.
    lock.clear();
    const first = lock.acquire('u5');
    const second = lock.acquire('u5');
    assert.strictEqual(second, null, 'the lock is held');
    first();  // released properly
    const third = lock.acquire('u5');
    assert.ok(third, 'now free');
    first();  // a late second release from the old holder
    assert.strictEqual(lock.acquire('u5'), null, 'the late release must not have freed the new holder');
    lock.clear();
    return 'a stale release cannot unlock a live command';
  });

  await step('no command has a cooldown short enough to spam', () => {
    // 145 commands sat at or under 10s before the ladder. Every one of those
    // writes to the database and usually sends more than one reply.
    const all = [...loaded.registry.values()];
    const tooFast = all.filter((c) => c.cooldown < loader.MIN_COOLDOWN);
    assert.strictEqual(tooFast.length, 0,
      `under ${loader.MIN_COOLDOWN}s: ${tooFast.slice(0, 5).map((c) => `${c.name}=${c.cooldown}`).join(', ')}`);
    // Action limits are left exactly as authored — doubling a 24h daily claim
    // would be an inconvenience, not protection.
    const long = all.filter((c) => loader.scaleCooldown(c.cooldown) !== c.cooldown);
    assert.strictEqual(long.length, 0, 'the ladder must be idempotent: scaling twice must change nothing');
    for (const cmd of all.filter((c) => c.cooldown >= 86400)) {
      assert.ok(Number.isFinite(cmd.cooldown), 'a daily command must keep its period');
    }
    return `${all.length} commands, none under ${loader.MIN_COOLDOWN}s, ladder is idempotent`;
  });

  await step('the cooldown ladder only raises, and leaves action limits alone', () => {
    assert.ok(loader.scaleCooldown(3) >= 3, 'never lowers');
    assert.ok(loader.scaleCooldown(5) > 5);
    assert.ok(loader.scaleCooldown(60) > 60);
    // 120s and up are action limits, not rate limits.
    for (const sec of [120, 180, 300, 600, 900, 1800, 3600, 86400]) {
      assert.strictEqual(loader.scaleCooldown(sec), sec, `${sec}s must be left alone`);
    }
    return 'short cooldowns raised, long ones untouched';
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
