'use strict';

/**
 * Wild Pokemon spawns.
 *
 * Every so often a group posts a Pokemon as a picture, and the first person to
 * REPLY to that message with its name catches it.
 *
 * WHY A REPLY AND NOT A COMMAND
 * The spawn's own message id is the lock. A reply carries the id of the message
 * it answers, so "reply to the thing with the name on it" needs no coordination
 * between people and no shared counter: the message a reply points at is the
 * message being claimed. `!catch pikachu` would need a "is this the current
 * spawn" check that two people can pass at once, which is the whole problem a
 * reply removes.
 *
 * WHY THE MESSAGE ID IS STORED
 * ws3-fca resolves a sent message as { threadID, messageID }, and that id is the
 * only durable handle on a spawn. It is written to the group document the moment
 * the message goes out, so a restart does not leave every spawn uncatchable.
 *
 * WHERE THE BOUNDS ARE
 * This module owns the schedule and the catch. It deliberately does not know how
 * to send a canvas card or how to print a help page, so that those stay the
 * commands' problem and this stays testable without a Facebook client.
 */

const Group = require('../models/Group');
const mongo = require('./mongo');
const dex = require('./pokemon');

/** How often the scheduler wakes up to ask "is anything due?". */
const TICK_MS = 60 * 1000;

/**
 * Never post more than this many spawns in one tick, however many groups are
 * overdue at once. A bot that has been down for an hour comes back to twenty
 * groups all due in the same second, and posting twenty pictures in a burst is
 * how an account gets rate-limited. The rest wait for the next tick.
 */
const MAX_PER_TICK = 5;

/**
 * Chance that an eligible group actually spawns on a given tick.
 *
 * 8% against a 60s tick and a 15-minute per-group interval. Without a roll, a
 * group that came due would fire immediately and then every 15 minutes forever,
 * which is a wall of messages in a busy chat. With it, the average wait after a
 * group becomes due is a couple of minutes and the cadence still reads as
 * "something is out there".
 */
const SPAWN_CHANCE = 0.08;

/** Guards against two ticks overlapping, which a slow send can cause. */
let ticking = false;

/** Set by start(); the live client, used for scheduled spawns. */
let client = null;

let timer = null;

/**
 * Log helpers, injectable so tests do not have to capture stdout.
 * @type {{log:(s:string)=>void, error:(s:string)=>void}}
 */
let io = { log: () => {}, error: () => {} };

/**
 * Is there a live spawn on this group right now?
 *
 * Two ways there is not: nobody has caught it and it has not expired, or it was
 * caught. An expired spawn is treated as absent so the next tick rolls a new one
 * without waiting out a full interval.
 *
 * @param {object} group a Group document
 * @param {number} [now]
 * @returns {boolean}
 */
function hasLiveSpawn(group, now = Date.now()) {
  const cur = group && group.pokemon && group.pokemon.current;
  if (!cur || !cur.messageID) return false;
  // Caught counts as gone. The announcement message is still sitting in the
  // chat, but there is nothing left to catch, and treating it as live held the
  // slot for the full TTL — so after somebody caught a Pokemon the group sat
  // empty instead of getting another one.
  if (cur.caughtBy) return false;
  const expires = cur.expiresAt ? new Date(cur.expiresAt).getTime() : 0;
  return expires > now;
}

/**
 * Is this group due a new spawn?
 *
 * @param {object} group
 * @param {number} [now]
 * @returns {boolean}
 */
function isDue(group, now = Date.now()) {
  const poke = group && group.pokemon;
  // Only an explicit `false` opts out. An absent field must not, or a group
  // whose document predates the setting would silently never spawn.
  if (!poke || poke.enabled === false) return false;
  if (hasLiveSpawn(group, now)) return false;
  const interval = Number(poke.intervalMs) || dex.DEFAULT_INTERVAL_MS;
  const last = poke.lastSpawnAt ? new Date(poke.lastSpawnAt).getTime() : 0;
  return now - last >= interval;
}

/**
 * The text that accompanies the picture.
 *
 * @param {object} p
 * @returns {string}
 */
function spawnBody(p) {
  const t = dex.tier(p);
  return (
    `🌿 A wild **${p.name}** appeared!\n`
    + '· · · · · · ·\n'
    + `${t.symbol} ${t.label} · ${dex.typeLabel(p)}\n`
    + '· · · · · · ·\n'
    + '🎯 **Reply to this message with its name to catch it.**\n'
    + `⏳ It stays for ${Math.round(dex.DEFAULT_TTL_MS / 60000)} minutes.`
  );
}

/**
 * Post one Pokemon to one group and remember it.
 *
 * The document is written with the sent message id, which is the only way a
 * later reply can be matched to this spawn. If the write fails the spawn is
 * still posted but nobody can catch it, so that is logged loudly rather than
 * swallowed.
 *
 * @param {object} api ws3-fca client
 * @param {object} group Group document
 * @param {number} [now]
 * @returns {Promise<object|null>} the Pokemon that was posted, or null
 */
async function spawnOne(api, group, now = Date.now()) {
  const p = dex.random();
  const threadID = String(group.tid);
  let sent = null;
  try {
    sent = await api.sendMessage(
      {
        body: spawnBody(p),
        attachment: { type: 'image', data: { url: dex.sprite(p.id) } },
      },
      threadID,
      null,
    );
  } catch (err) {
    io.error(`[POKEMON] could not post ${p.name} to ${threadID}: ${err.message}`);
    return null;
  }

  const messageID = sent && sent.messageID ? String(sent.messageID) : '';
  if (!messageID) {
    // Without an id this spawn is a picture nobody can answer, so there is no
    // point marking the group as having spawned.
    io.error(`[POKEMON] ${threadID} sent ${p.name} but returned no message id`);
    return null;
  }

  group.pokemon.current = {
    id: p.id,
    messageID,
    spawnedAt: new Date(now),
    expiresAt: new Date(now + dex.DEFAULT_TTL_MS),
    caughtBy: '',
  };
  group.pokemon.lastSpawnAt = new Date(now);
  try {
    await group.save();
  } catch (err) {
    io.error(`[POKEMON] posted ${p.name} to ${threadID} but could not record it: ${err.message}`);
    return null;
  }

  io.log(`[POKEMON] ${p.name} (${p.rarity}) spawned in ${threadID}`);
  return p;
}

/**
 * Post a spawn in every group that is due, up to a cap.
 *
 * @param {object} api
 * @param {number} [now]
 * @returns {Promise<number>} how many were posted
 */
async function tick(api = client, now = Date.now()) {
  if (!api || !mongo.isReady()) return 0;
  if (ticking) return 0;
  ticking = true;
  let posted = 0;
  try {
    // Every group, not only the ones that opted in. The query used to be
    // `{'pokemon.enabled': true}` against a schema that defaults to false, so a
    // group that had never been told to opt in was never visited and nothing
    // ever spawned in it — the feature looked broken in every chat that had not
    // been configured by hand. Being in a group is now enough; an admin opts
    // OUT with `!pokemon off`.
    const groups = await Group.find({}).catch(() => []);
    for (const group of groups) {
      if (posted >= MAX_PER_TICK) break;
      if (!isDue(group, now)) continue;
      // One roll per eligible group per tick, so a chat does not fire the
      // instant its interval lapses — it just becomes due, and usually wins.
      if (Math.random() >= SPAWN_CHANCE) continue;
      // eslint-disable-next-line no-await-in-loop
      const p = await spawnOne(api, group, now);
      if (p) posted += 1;
    }
  } catch (err) {
    io.error(`[POKEMON] tick failed: ${err.message}`);
  } finally {
    ticking = false;
  }
  return posted;
}

/**
 * Try to catch the spawn a reply is answering.
 *
 * Returns the Pokemon when this reply won the catch, and null every other time
 * — no live spawn, wrong name, already caught, expired, or the group has the
 * feature off. Returning null rather than a reason keeps the caller's decision
 * simple: it hands the message to the command parser instead.
 *
 * @param {object} api
 * @param {object} event the incoming message event
 * @param {object} [deps] injected for tests
 * @returns {Promise<null|{pokemon:object, group:object, userDoc:object, isNew:boolean}>}
 */
async function attemptCatch(api, event, deps = {}) {
  const {
    loadGroup = Group.findOne.bind(Group),
    loadUser = require('./cache').getUser,
    saveUser = async (u) => { if (!u.transient) await u.save(); },
  } = deps;

  const parent = event && event.messageReply && event.messageReply.messageID;
  if (!parent || !event.threadID || !event.senderID) return null;
  if (!String(event.body || '').trim()) return null;
  if (!mongo.isReady()) return null;

  const group = await loadGroup({ tid: String(event.threadID) }).catch(() => null);
  if (!group || !group.pokemon || group.pokemon.enabled === false) return null;

  const cur = group.pokemon.current;
  if (!cur || !cur.messageID || String(cur.messageID) !== String(parent)) return null;
  if (cur.caughtBy) return null;
  if (cur.expiresAt && new Date(cur.expiresAt).getTime() < Date.now()) return null;

  // A wrong name is not an error — the reply is somebody talking about Pokemon
  // in general, or guessing, and it should fall through to the command parser.
  const p = dex.find(event.body);
  if (!p || p.id !== Number(cur.id)) return null;

  // Claim BEFORE paying out and before replying. Both of the steps after this
  // one can fail, and if the claim were last the loser of a near-simultaneous
  // race would already have been paid.
  cur.caughtBy = String(event.senderID);
  try {
    await group.save();
  } catch (err) {
    io.error(`[POKEMON] catch claim failed for ${p.name}: ${err.message}`);
    return null;
  }

  const userDoc = await loadUser(String(event.senderID), api);
  if (!userDoc) return null;

  const already = Array.isArray(userDoc.dex) && userDoc.dex.includes(p.id);
  if (!already) {
    if (!Array.isArray(userDoc.dex)) userDoc.dex = [];
    userDoc.dex.push(p.id);
  }
  userDoc.pokemonCaught = (userDoc.pokemonCaught || 0) + 1;

  const reward = dex.bounty(p);
  userDoc.coins = (userDoc.coins || 0) + reward.coins;
  userDoc.xp = (userDoc.xp || 0) + reward.xp;

  try {
    await saveUser(userDoc);
  } catch (err) {
    io.error(`[POKEMON] could not save ${p.name} catch for ${event.senderID}: ${err.message}`);
  }

  return { pokemon: p, group, userDoc, isNew: !already, reward };
}

/**
 * The message that confirms a catch.
 *
 * @param {object} p
 * @param {object} userDoc
 * @param {boolean} isNew
 * @param {object} reward
 * @returns {string}
 */
function catchBody(p, userDoc, isNew, reward) {
  const t = dex.tier(p);
  const seen = Array.isArray(userDoc.dex) ? userDoc.dex.length : 0;
  return (
    `🎉 **${userDoc.name} caught ${p.name}!**\n`
    + '· · · · · · ·\n'
    + `${t.symbol} ${t.label} · ${dex.typeLabel(p)}\n`
    + `💰 ${reward.coins.toLocaleString('en-US')} K-Cash · ✨ ${reward.xp.toLocaleString('en-US')} XP\n`
    + `📖 **${isNew ? 'New to your dex!' : 'Another one for the collection.'}** ${seen}/${dex.POKEMON.length}`
  );
}

/**
 * Start the scheduler.
 *
 * The first tick runs after a delay rather than immediately: on boot the
 * database may still be connecting, and every group with a null lastSpawnAt is
 * due, so an immediate tick would post a picture to every enabled group the
 * moment the bot starts.
 *
 * @param {object} api
 * @param {{log?:Function, error?:Function}} [logging]
 * @param {number} [intervalMs]
 * @returns {boolean} false if it was already running
 */
function start(api, logging = {}, intervalMs = TICK_MS) {
  if (timer) return false;
  client = api;
  io = { log: logging.log || io.log, error: logging.error || io.error };
  timer = setInterval(() => { tick(api); }, intervalMs);
  if (timer.unref) timer.unref();
  io.log(`[POKEMON] scheduler started (checking every ${Math.round(intervalMs / 1000)}s)`);
  return true;
}

/** Stop the scheduler. */
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  client = null;
}

/**
 * Post a spawn right now, ignoring the schedule. Used by the admin command.
 *
 * @param {object} api
 * @param {object} group
 * @returns {Promise<object|null>}
 */
async function spawnNow(api, group) {
  if (hasLiveSpawn(group)) return null;
  return spawnOne(api, group);
}

module.exports = {
  TICK_MS, MAX_PER_TICK, SPAWN_CHANCE,
  hasLiveSpawn, isDue, spawnBody, spawnOne, tick,
  attemptCatch, catchBody, start, stop, spawnNow,
};
