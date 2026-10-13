'use strict';

/**
 * iKON-BOT v2 — central engine.
 *
 * Chain: LOGIN -> DATABASE -> LOADER -> MESSAGE -> PARSER -> COMMAND -> REPLY
 *
 * This file owns everything: Express server, MongoDB, ws3-fca APPSTATE login,
 * command registry + aliases, routing, permissions, cooldowns, replies,
 * reactions, group management, maintenance/toggles, the AI integration
 * point, and the error boundary that keeps a broken command from killing the bot.
 */

const express = require('express');

const config = require('./config');
const mongo = require('./bot/mongo');
const router = require('./bot/router');
const loader = require('./bot/loader');
const cooldown = require('./bot/cooldown');
const lock = require('./bot/lock');
const permissions = require('./bot/permissions');
const toggles = require('./bot/toggles');
const cache = require('./bot/cache');
const canvas = require('./bot/canvas');
const groqClient = require('./bot/groq');
const fcaDiag = require('./bot/fcaDiag');
const dex = require('./bot/pokemon');
const pokemonSpawn = require('./bot/pokemonSpawn');
const gcs = require('./bot/gcs');
const helpers = require('./bot/helpers');
const profile = require('./bot/profile');
const cards = require('./bot/cards');
const pending = require('./bot/pending');
const flood = require('./bot/flood');
const moderation = require('./bot/moderation');
const media = require('./bot/media');
const footballCmds = require('./commands/cmds_8');

const { log, error, reply, react, safe } = helpers;

const STATE = {
  startedAt: Date.now(),
  loggedIn: false,
  userID: null,
  commandsRun: 0,
  messagesSeen: 0,
  errors: 0,
  // Send bookkeeping. "Reacts but never replies" is the symptom of every
  // sendMessage failing, and from inside the chat that is indistinguishable
  // from being offline. /health exposes these so the cause can be read off the
  // deploy instead of guessed at.
  sentOk: 0,
  sentFailures: 0,
  lastSendError: '',
  lastCommands: [],
};

/**
 * How many login attempts have failed. Counts only attempts that actually
 * reached ws3-fca, so a boot that dies before login does not inflate it — the
 * backoff in getRetryDelay() is driven by this, and it is what decides when the
 * bot stops hammering Facebook and waits for a manual refresh.
 *
 * @type {number}
 */
let loginAttempts = 0;
const LOGIN_MAX_ATTEMPTS = 5;

/** Record a successful send. */
function noteSendOk(name) {
  STATE.sentOk += 1;
  STATE.lastCommands.push(name);
  // Keep a short tail: enough to see the last few commands, not unbounded.
  if (STATE.lastCommands.length > 12) STATE.lastCommands.shift();
}

/**
 * Record a failed send with the reason. helpers.reply already swallows the
 * error so one dead reply cannot take down a handler; without this the only
 * trace is a log line nobody reads, which is how the last two rounds of this
 * bug went unnoticed.
 */
function noteSendFailure(name, reason) {
  STATE.sentFailures += 1;
  STATE.lastSendError = `${name || 'reply'}: ${reason || 'unknown error'}`.slice(0, 300);
  error(`[SEND] ${STATE.lastSendError}`);
}

let client = null; // ws3-fca client (set by attachClient)
let registry = new Map();
let aliases = new Map();

// ─────────────────────────────────────────────────────────────
// ANTI-BAN / ANTI-RESTRICTION RATE LIMITING
// ─────────────────────────────────────────────────────────────

/** Minimum ms between any two sends (Facebook flags rapid-fire messaging). */
const SEND_DELAY_MS = global.SEND_DELAY_MS ?? 1500;
/** Per-user cooldown in ms — no user can fire two commands this fast. */
const USER_COOLDOWN_MS = 5000;
/** Per-thread send cap: max sends before a 60s pause. */
const THREAD_RATE_LIMIT = 20;
const THREAD_RATE_WINDOW_MS = 60 * 1000;
const THREAD_PAUSE_MS = 60 * 1000;

// Global send throttle — the last time ANY message left the bot.
global.lastSent = global.lastSent || 0;
// Per-user: { uid: Number<lastCommandMs> }
global.commandCooldowns = global.commandCooldowns || new Map();
// Per-thread: { threadID: [timestamps] }
const threadSends = new Map();
// Per-thread pause-on-flood: { threadID: Number<resumeMs> }
const threadPaused = new Map();

/**
 * Forget every thread's rate-limit history.
 *
 * The per-thread cap is in-memory on purpose — a restart clears it —
 * and the end-to-end test fires more than THREAD_RATE_LIMIT messages
 * at one chat inside a minute, which is exactly the traffic the cap
 * exists to pause. Wiping the counters between test steps is the
 * harness's job, so the hook exists for it and nothing else calls it.
 */
function resetThreadRate() {
  threadSends.clear();
  threadPaused.clear();
}

// Module-level so a boot retry reuses the listening server instead of throwing
// EADDRINUSE on the second call.
let server = null;
let housekeeping = null;
let retryTimer = null;

/**
 * Re-run boot() after a delay.
 *
 * Facebook login fails for reasons that clear on their own: an expired
 * appstate, a rate limit, a network blip. Exiting makes Render mark the deploy
 * dead; retrying in place keeps the process (and /health) alive until the
 * account links again.
 *
 * The delay is exponential and capped, not a fixed 30s. A bot that retries a
 * blocked login every 30 seconds is a bot Facebook bans in about five minutes;
 * one that waits 30s, 45s, 67s… up to ten minutes gives the block time to cool.
 */
function scheduleRetry() {
  if (retryTimer) return;
  const delay = getRetryDelay();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    boot().catch((err) => {
      error(`[BOOT] Retry failed: ${err && err.message ? err.message : err}`);
      scheduleRetry();
    });
  }, delay);
  log(`[BOOT] Next login attempt in ${Math.round(delay / 1000)}s (attempt ${loginAttempts + 1})`);
  if (typeof retryTimer.unref === 'function') retryTimer.unref();
}

/**
 * Exponential backoff for login retries: 30s, 45s, 67s, 100s, 150s, 225s…
 * capped at 10 minutes. Each failure is counted once a login actually happens,
 * so a boot that never reaches the login step does not inflate the counter.
 *
 * @returns {number} milliseconds to wait
 */
function getRetryDelay() {
  return Math.min(30000 * Math.pow(1.5, loginAttempts), 600000);
}

// ─────────────────────────────────────────────────────────────
// EXPRESS
// ─────────────────────────────────────────────────────────────
function startServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static('public'));

  app.get('/', (req, res) => {
    res.json({
      bot: config.BOT_NAME,
      version: config.VERSION,
      owner: config.OWNER,
      status: STATE.loggedIn ? 'online' : 'booting',
      uptime: Math.floor((Date.now() - STATE.startedAt) / 1000),
      commands: registry.size,
      aliases: aliases.size,
      database: mongo.status(),
    });
  });

  // Render polls this to decide whether the deploy is alive. It must answer 200
  // even while the bot is still logging in: a 503 during a slow Facebook login
  // makes Render mark the deploy failed and restart it, which restarts the
  // login that was about to finish.
  //
  // The counters matter when "the bot is not replying". Without them there is no
  // way to tell the three causes apart from outside the process:
  //
  //   loggedIn=false, messagesSeen=0  -> never received anything. The account is
  //                                      not connected; nothing was ever parsed.
  //   messagesSeen rising, cmdsRun 0  -> messages arrive but the prefix is wrong,
  //                                      so router.parse() returns null.
  //   cmdsRun rising, sentFailures up  -> commands run but every sendMessage is
  //                                      rejected. This is the state that looks
  //                                      exactly like "reacts but never replies".
  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      cmds: registry.size,
      aliases: aliases.size,
      loggedIn: STATE.loggedIn,
      userID: STATE.userID || null,
      db: mongo.status().readyState === 1,
      prefix: config.PREFIX,
      adminsConfigured: permissions.ownerIds().length,
      messagesSeen: STATE.messagesSeen,
      commandsRun: STATE.commandsRun,
      sentOk: STATE.sentOk,
      sentFailures: STATE.sentFailures,
      lastSendError: STATE.lastSendError || null,
      // The raw Facebook response for the last send. ws3-fca's own error is
      // "[object Object]", so this is the only place the real code appears.
      lastFacebookResponse: fcaDiag.lastRawSummary() || null,
      lastCommands: STATE.lastCommands || [],
      // Pokemon spawns live in global.pokemonSpawns, so this is the count a
      // group owner asks for when they say "nothing spawned in hours".
      // The roster size and the tier ladder, read from the modules that own
      // them. The previous pair called helpers that only existed in the old
      // 45-species spawner, so /health threw instead of reporting.
      pokemonRoster: dex.POKEMON.length,
      pokemonTiers: dex.TIERS.length,
      pokemonCheckEvery: Math.round(pokemonSpawn.TICK_MS / 1000),
      threadListLimit: gcs.THREAD_LIMIT,
      // Spam posture, so "is the bot being flooded and did we notice" is one
      // request rather than a guess. `held` and `sealed` are the interesting two:
      // a chat sitting sealed is a chat that is not answering anybody.
      spam: flood.stats(),
      moderation: moderation.stats(),
      uptime: Math.floor((Date.now() - STATE.startedAt) / 1000),
      // Login posture. "Blocked N times" is the one line that separates an
      // expired appstate from a rate-limited account, and both look identical
      // from the chat: the bot is simply not replying.
      loginAttempts,
      loginMaxAttempts: LOGIN_MAX_ATTEMPTS,
      // Cookie expiry, computed at boot from the appstate. A week-long run on a
      // session whose only timed cookie dies at hour 12 is how a bot "goes
      // offline" with no warning; this is the number the operator refreshes
      // against. `null` means every cookie is a session cookie with no fixed
      // expiry, which is not a problem — it just means there is nothing to count.
      cookieExpiry: (() => {
        try { return config._internals.appstateExpiry(config.APPSTATE); }
        catch { return null; }
      })(),
    });
  });

  app.get('/ping', (req, res) => res.send('pong'));

  const server = app.listen(config.PORT, () => {
    log(`[SERVER] ${config.BOT_NAME} listening on port ${config.PORT}`);
  });

  server.on('error', (err) => error(`[SERVER] ${err.message}`));
  return server;
}

// ─────────────────────────────────────────────────────────────
// AI — thin facade over bot/groq.js
//
// The HTTP call, model selection and auth all live in that module so the engine
// and the AI commands cannot drift apart. This object only keeps the shape the
// command handlers expect. It is named `ai`, not `groq`, because what a command
// needs is "ask the AI something" — the provider is bot/groq.js's business and
// should not leak into 35 handlers.
// ─────────────────────────────────────────────────────────────
const ai = {
  available: groqClient.available,
  ask: (prompt, opts = {}) => groqClient.ask(prompt, {
    maxTokens: opts.maxTokens || opts.maxOutputTokens || 2048,
    system: opts.system,
  }),
  activeModel: groqClient.activeModel,
  lastErrorMessage: groqClient.lastErrorMessage,
};

// ─────────────────────────────────────────────────────────────
// MESSAGE HANDLING
// ─────────────────────────────────────────────────────────────

/** Effective prefix for a thread: group override, else config.PREFIX. */
async function resolvePrefix(threadID) {
  try {
    const group = await toggles.findGroup(threadID);
    if (group && group.prefix) return group.prefix;
  } catch { /* fall through */ }
  return config.PREFIX;
}

/** What a flood block is told, once, when the hold starts. */
function floodNotice(verdict) {
  const secs = `${verdict.holdSec}s`;
  if (verdict.reason === 'duplicate') {
    return `♻️ **Same message again.** Dropped.\n⏳ Flood control is watching — ${secs} if you keep it up.`;
  }
  if (verdict.reason === 'thread') {
    return `🌊 **This chat is flooding the bot.** Answering has stopped for ${secs}.\n📖 Slow down, everybody.`;
  }
  return `⚠️ **Too fast.** You are paused for ${secs}.\n📖 The hold doubles each time you rush it.`;
}

/**
 * The single spam gate: flood control first, then the chat's own moderation
 * settings.
 *
 * Flood runs first because it is in-memory and the settings read is not, so the
 * common case — an ordinary message in an ordinary chat — costs one cached
 * lookup and nothing else. The moderation settings then decide whether this
 * particular person is allowed to speak at all.
 *
 * Bot admins pass both, untouched. They are not merely exempt from the limits:
 * they are never recorded, so an admin running the bot cannot build up a streak
 * that later silences them, and cannot be sealed out of their own chat.
 *
 * Both gates fail OPEN. A rate limiter that throws and eats every message is
 * worse than no rate limiter, so any error here logs and lets the message
 * through.
 *
 * @param {object} event the raw message event
 * @param {object} ctx
 * @param {string} ctx.body raw text
 * @param {object|null} ctx.parsed router result, already computed
 * @param {Function} ctx.say the thread-bound reply helper
 * @returns {Promise<{allowed: boolean, reason?: string}>}
 */
async function spamGate(event, ctx) {
  const { body, parsed, say } = ctx;
  const threadID = event.threadID;
  const uid = String(event.senderID || '');
  const isGroup = event.isGroup !== false;
  const command = parsed ? String(parsed.commandName || parsed.name || '') : '';
  const exempt = permissions.isOwner(uid);

  // One settings read serves both gates. gcFor caches for a few seconds, so this
  // is one query per chat per window rather than one per message.
  let gc = null;
  try {
    gc = await moderation.gcFor(threadID);
  } catch (err) {
    error(`[SPAM] settings read failed in ${threadID}: ${err.message}`);
  }

  let verdict;
  try {
    verdict = flood.check({
      threadID,
      uid,
      body,
      cfg: gc && gc.flood,
      isCommand: Boolean(parsed),
      exempt,
    });
  } catch (err) {
    error(`[SPAM] flood check failed: ${err.message}`);
    return { allowed: true };
  }

  if (!verdict.allowed) {
    // Warn once, when the hold starts. Answering every dropped message is itself
    // a message, which is how a bot ends up amplifying the spam it is stopping.
    if (verdict.notify) {
      try {
        await say(floodNotice(verdict), event.messageID);
      } catch (err) {
        error(`[SPAM] notice failed in ${threadID}: ${err.message}`);
      }
    }
    return { allowed: false, reason: `flood:${verdict.reason}` };
  }

  let mod;
  try {
    mod = await moderation.inspect({
      threadID, uid, body, command, isGroup, exempt,
    });
  } catch (err) {
    error(`[SPAM] moderation check failed: ${err.message}`);
    return { allowed: true };
  }

  if (mod.action === 'allow') return { allowed: true };

  // silent: nothing at all. A muted member is not told they are muted, because
  // the notice is the one reply that would prove the mute is real.
  if (mod.action === 'silent') return { allowed: false, reason: `moderation:${mod.reason}` };

  // ghost: `text` is set only for a private chat, where the target is the only
  // reader. In a group it is null, which is the entire point of a ghostban.
  try {
    if (mod.text) await say(mod.text, event.messageID);
  } catch (err) {
    error(`[SPAM] reply failed in ${threadID}: ${err.message}`);
  }
  return { allowed: false, reason: `moderation:${mod.reason}` };
}

/**
 * Process one incoming message.
 * Every step is guarded: nothing here may throw out of the handler.
 */
async function handleMessage(api, event) {
  STATE.messagesSeen += 1;

  const body = event.body || '';
  const threadID = event.threadID;
  const messageID = event.messageID;
   const senderID = event.senderID;

  // ── SLEEP MODE ──────────────────────────────────────────────
  // 03:00–05:00 Jordan time (GMT+3). The bot is dormant at night; waking up
  // to spam complaints from a sleeping chat is worse than being silent.
  if (global.botSleeping === true) return;

  // ── SAFE MODE ───────────────────────────────────────────────
  // When !safemode is on, only bot admins get replies.
  if (global.botSafeMode === true) {
    try {
      if (!(await permissions.canModerate(api, event))) return;
    } catch {
      return;
    }
  }

  // ── PER-THREAD RATE LIMIT ───────────────────────────────────
  // Cap at 20 sends/min per chat; pause the thread for 60s when exceeded.
  const now = Date.now();
  const tKey = String(threadID);
  const pausedUntil = threadPaused.get(tKey);
  if (pausedUntil && now < pausedUntil) return;
  if (pausedUntil && now >= pausedUntil) threadPaused.delete(tKey);

  const threadTimes = threadSends.get(tKey) || [];
  const recent = threadTimes.filter((t) => now - t < THREAD_RATE_WINDOW_MS);
  if (recent.length >= THREAD_RATE_LIMIT) {
    threadPaused.set(tKey, now + THREAD_PAUSE_MS);
    return;
  }
  recent.push(now);
  threadSends.set(tKey, recent);

  // Remember the sender so reply-to commands (`!petfight`) can find their target.
  cache.rememberMessage(messageID, senderID);

  // Helper bound to this thread — commands call reply(text) / react(emoji).
  //
  // reply() resolves null on failure by design, so this wraps it to keep the
  // send counters honest: without that, a null return would be indistinguishable
  // from a successful send and /health would report all green while nothing
  // reached Facebook. The command name is filled in once parsed below, so an
  // early "unknown command" is still attributed.
  let commandName = 'incoming';
  const say = async (text, replyTo = messageID, label = commandName) => {
    helpers.clearSendError();

    // Human-like posture before every reply. Three things, in this order:
    //
    //   typing indicator ON — the single most visible bot signal there is. A
    //     person pauses to read and think; a bot answers in the same millisecond
    //     it receives the message, and that rhythm is what Facebook notices
    //     regardless of how quiet the bot is otherwise. Turned off again after
    //     the send, so it does not sit on for the next message in the thread.
    //
    //   random thinking pause — a fixed delay makes the bot rhythmic, and
    //     rhythm is the other thing that gets flagged. The range is short
    //     enough that a two-second command still feels snappy.
    //
    //   global send throttle — minimum gap between ANY two messages, which is
    //     the rate limit that stops rapid-fire messaging entirely.
    if (typeof helpers.typing === 'function') {
      await helpers.typing(api, threadID, true).catch(() => { /* cosmetic */ });
    }
    const pause = helpers.thinkPause ? helpers.thinkPause() : 0;
    if (pause > 0) await new Promise((r) => setTimeout(r, pause));
    const sinceLast = Date.now() - global.lastSent;
    if (sinceLast < SEND_DELAY_MS) await new Promise((r) => setTimeout(r, SEND_DELAY_MS - sinceLast));
    global.lastSent = Date.now();
    // event.isGroup, not a threadID guess: a group can arrive with a bare
    // numeric id, and treating it as a DM makes every reply fail with 1545012.
    const res = await reply(api, threadID, text, replyTo ?? messageID, event.isGroup);
    if (typeof helpers.typing === 'function') {
      await helpers.typing(api, threadID, false).catch(() => { /* cosmetic */ });
    }
    if (res) noteSendOk(label);
    else noteSendFailure(label, helpers.lastSendError() || 'sendMessage returned nothing');
    return res;
  };
  const reactTo = (emoji) => react(api, messageID, emoji || config.REACT_EMOJI);

  // ── PARSER ────────────────────────────────────────────────
  // The prefix is resolved from the per-group override first and config.PREFIX
  // second, so a group that changed it is honoured. Logged on every non-command
  // message: a wrong prefix is the single most common reason a bot looks deaf,
  // and without this line there is no way to tell it apart from a dead listener.
  const prefix = await resolvePrefix(threadID);

  // ── SPAM AND MODERATION ───────────────────────────────────
  // Ahead of everything below, including the pokemon catch: a reply-to is still
  // a message somebody sent, and a muted or flooded member must not be able to
  // make the bot answer them by replying to a spawn.
  //
  // router.parse is called here rather than further down purely so both gates
  // can tell a command from ordinary chatter — lockdown and anti-link both have
  // to let commands through. It is a pure string operation with no side effects,
  // so the result is reused verbatim below and nothing about the message changes;
  // only the moment the word is first recognised moves earlier.
  const parsed = router.parse(body, prefix);

  const spam = await spamGate(event, { body, parsed, say });
  if (!spam.allowed) return;

  // ── AUTO-DOWNLOAD SHARED VIDEOS ────────────────────────────
  // A link shared in a group chat, or replied to, is usually a video the
  // sender wants the room to see. Downloading it is the whole point of a
  // downloader bot, and doing it on the link rather than on a command means
  // the room gets the file without anybody typing `!yt`.
  //
  // Group chats only, and only when the sender is not the bot itself: a bot
  // replying to its own download with another download is a spiral. The
  // download is best-effort — a link that is not a video is skipped, and a
  // video that will not download is answered with the plain link.
  if (event.isGroup && !event.isSelf) {
    const link = media.pickVideoLink(body);
    if (link) {
      try {
        const dl = await media.downloadVideo(link);
        if (dl && dl.url) {
          await reply(
            api,
            threadID,
            {
              body: dl.caption || `🎬 ${link}`,
              attachment: { type: 'video', data: { url: dl.url } },
            },
            event.messageID,
            event.isGroup,
          );
          await recordActivity(senderID, false, threadID);
          return;
        }
      } catch (err) {
        error(`[DOWNLOAD] auto-download of ${link.slice(0, 60)} failed: ${err.message}`);
      }
    }
  }

  // ── WILD POKEMON ──────────────────────────────────────────
  // A reply to a spawn message, carrying that Pokemon's name, is a catch. This
  // runs before the parser because a catch is not a command: the reply is just
  // a name, and `!pikachu` should not be a thing. attemptCatch answers null for
  // everything that is not a live spawn — no parent message, wrong name, already
  // caught, expired, feature off — and the message then carries on to the parser
  // exactly as it would have.
  if (event.messageReply) {
    let caught = null;
    try {
      caught = await pokemonSpawn.attemptCatch(api, event);
    } catch (err) {
      error(`[POKEMON] catch attempt failed: ${err.message}`);
    }
    if (caught) {
      await reply(
        api,
        threadID,
        {
          // Awaited because the catcher's name is looked up rather than trusted:
          // a stored "Facebook User" went out to the whole chat as the winner.
          body: await pokemonSpawn.catchBody(caught.pokemon, caught.userDoc, caught.isNew, caught.reward, api),
          attachment: { type: 'image', data: { url: dex.sprite(caught.pokemon.id) } },
        },
        // Reply to the REPLY, so the confirmation hangs off the answer rather
        // than off the spawn and the thread still reads top to bottom.
        messageID,
        event.isGroup,
      );
      await recordActivity(senderID, false, isGroupThread(threadID, event.isGroup) ? threadID : null);
      return;
    }
  }

  // `parsed` was computed above, ahead of the spam gate, and is reused here.
  if (!parsed) {
    if (body) log(`[PARSE] no command for "${body.slice(0, 60)}" (prefix ${JSON.stringify(prefix)})`);

    // A bare prefix is not a command and is not chatter — it is the single
    // most common "what is the prefix?" message, and answering it is the whole
    // point. The system prefix is what the bot was told to use and the group
    // prefix is what this chat actually uses, so say both: the first is the
    // answer to "what is the prefix", the second is the answer to "why did
    // !ping not work here". Without this, a reader in a renamed-prefix chat
    // types the prefix they were given, gets silence, and concludes the bot
    // is dead — which is exactly the deafness this log line exists to catch.
    if (body.trim() === prefix || body.trim() === config.PREFIX) {
      const groupPrefix = prefix !== config.PREFIX ? prefix : null;
      await say(
        `📖 The prefix here is \`${prefix}\` — the system default is \`${config.PREFIX}\`.`
        + (groupPrefix ? `\n\nThis chat uses \`${groupPrefix}\` — \`${groupPrefix}help\` lists the commands.` : `\n\nTry \`${config.PREFIX}help\`.`),
      );
      await recordActivity(senderID, false, isGroupThread(threadID, event.isGroup) ? threadID : null);
      return;
    }

    // Not a command. Count the message for the RPG profile and stop.
    await recordActivity(senderID, false, isGroupThread(threadID, event.isGroup) ? threadID : null);
    return;
  }

  // ── PENDING APPROVAL ──────────────────────────────────────
  // Ahead of command lookup and of every other gate, including maintenance.
  //
  // Ahead of lookup because this gate answers "should this chat be talking to
  // the bot at all", and not recognising a word is not a reason to start. Behind
  // lookup, a locked chat answered `❌ Unknown command` to anything unfamiliar —
  // the wrong message, and a way to map the command list from a chat that is
  // supposed to be getting nothing.
  //
  // It is also the only gate that must fail closed. A locked chat whose command
  // cannot be resolved is still refused, because "we could not tell" has to mean
  // "no" here and only here.
  if (pending.isPending(threadID)) {
    const allowed = pending.mayRun(loader.findCommand(parsed.name, registry, aliases), event);
    if (!allowed) {
      await say('🔒 This group is pending approval. Contact bot admins.');
      return;
    }
  }

  // ── COMMAND LOOKUP ────────────────────────────────────────
  const cmd = loader.findCommand(parsed.name, registry, aliases);
  commandName = (cmd && cmd.name) || parsed.commandName || parsed.name;
  if (!cmd) {
    // Unknown command: say so, briefly. This used to stay silent on purpose —
    // "a quiet bot is a surviving bot" — but silence here is the wrong answer
    // for the person who typed it: they get nothing back, conclude the bot is
    // dead, and either stop using it or start flooding it with "are you ok?".
    // A one-line "unknown" teaches the command list without training a spam
    // habit, and it is the same line every time so it costs nothing.
    //
    // Bare chat words never reach this point — they are handled above at the
    // "not a command" branch — so this only ever answers an actual command
    // prefix, which is the only place a reply is useful.
    await say(`❌ Unknown command \`${parsed.name}\`. Try \`${config.PREFIX}help\`.`);
    await recordActivity(senderID, false, isGroupThread(threadID, event.isGroup) ? threadID : null);
    return;
  }

  // ── TOGGLES / MAINTENANCE ─────────────────────────────────
  let gate;
  try {
    gate = await toggles.isCommandDisabled(threadID, cmd.name, cmd.category);
  } catch (err) {
    error(`[TOGGLES] check failed: ${err.message}`);
    return;
  }
  if (!gate.allowed) {
    // An admin is never blocked by the switches an admin controls.
    //
    // This is what makes admin control total rather than self-destructive.
    // !disablemod system disables every command in the system category, and that
    // set includes !enablecmd, !enablemod, !listcmds and !listmods — the exact
    // commands that undo it. Holding admins to the same gate they set meant one
    // command left the chat with no in-chat way back: not the admin who ran it,
    // not the bot owner. Recovering needed a direct edit of the group document.
    // So admins pass the per-command and per-module gate, which guarantees
    // whoever disabled something can always see it and turn it back.
    //
    // Maintenance deliberately does NOT bypass: it is a shutdown the operator
    // asked for and it holds for the owner too.
    let mayOverride = false;
    if (gate.adminBypass) {
      try {
        mayOverride = await permissions.canModerate(api, event);
      } catch {
        mayOverride = false; // a failed lookup never grants
      }
    }
    if (!mayOverride) {
      await say(`⛔ ${gate.reason}`);
      return;
    }
  }

  // ── PER-USER COOLDOWN ─────────────────────────────────────
  // No single user can fire commands faster than once every 5s, which is
  // enough headroom to type and click without triggering FB's spam filters.
  // Owner/admin IDs are exempt — operators need to test commands without
  // being rate-limited, and a compromised admin account is a different threat.
  //
  // AFTER command lookup, not before it. This used to sit above the parse,
  // which meant a user who typed fast got silence for their typos: the
  // cooldown returned before the word was even recognised, so `!ping`
  // followed by `!definitelynotacommand` answered the first and dropped the
  // second with no "unknown command" to explain it. A cooldown is about
  // stopping a person spamming a real command; a word that is not a command
  // is answered, not throttled, because the answer is the only useful thing
  // about it.
  //
  // AFTER the toggle gate, not before it. The gate answers "is this command
  // allowed in this chat at all", and that answer has to come first: a member
  // in a chat with the system module disabled gets "module disabled here",
  // not "cooldown". Putting the cooldown before the gate made the wrong
  // message win, because the cooldown is keyed per-user and survives across
  // messages — the first thing a held user hears about a disabled module is
  // a rate-limit notice.
  const userKey = String(senderID);
  let isOperator = false;
  try { isOperator = permissions.isOwner(userKey) || await permissions.canModerate(api, event); }
  catch { isOperator = false; }
  if (!isOperator) {
    const lastCmd = global.commandCooldowns.get(userKey) || 0;
    if (now - lastCmd < USER_COOLDOWN_MS) {
      // Say something. This gate used to return in silence, which is the worst
      // of both worlds: the person gets no feedback that they are being held,
      // so they press again and are held again — and the per-command cooldown
      // notice they would otherwise get never appears, because this returns
      // before the command's own bucket is even checked. A short line costs
      // one message and teaches the rate without training a spam habit.
      const wait = Math.ceil((USER_COOLDOWN_MS - (now - lastCmd)) / 1000);
      await say(`⏳ Cooldown: wait ${helpers.fmt.dur(wait)}.`);
      return;
    }
    global.commandCooldowns.set(userKey, now);
  }

  // ── ADMINS-ONLY (!onlyadminon) ─────────────────────────────
  // Checked after the toggle gate and before permission so the setting applies
  // to every command. Bot owners are exempt, which is what guarantees the
  // group can never be locked: an owner can always run !onlyadminoff.
  if (gate.adminsOnly) {
    let isAdmin = false;
    try {
      isAdmin = await permissions.canModerate(api, event);
    } catch {
      isAdmin = false; // a failed lookup never grants
    }
    if (!isAdmin) {
      await say('🔒 Only admins can run commands in this group.');
      return;
    }
  }

  // ── PERMISSION (redundant, but safe if a handler ran out of order) ──
  let allowed = false;
  try {
    allowed = await permissions.can(event, api, cmd.permission);
  } catch (err) {
    error(`[PERM] check failed: ${err.message}`);
  }
  if (!allowed) {
    await say(`🚫 You do not have permission to use \`${prefix}${cmd.name}\` (needs: ${cmd.permission}).`);
    return;
  }

  // ── ONE COMMAND AT A TIME ─────────────────────────────────
  // Message handling is fired off without being awaited, so two of the same
  // command a second apart both reach here together. A per-user lock settles
  // that: the second is refused rather than racing the first.
  const release = lock.acquire(senderID);
  if (!release) {
    await say(`⏳ Still finishing your last command. Give it a second, then try again.`);
    return;
  }

  try {
    // ── COOLDOWN ────────────────────────────────────────────
    // Re-checked inside the lock, not before it. The first check is only a fast
    // path; between it and here another message from this person may have taken
    // the cooldown, and checking once outside the lock is a check that can be
    // stale the instant it returns.
    //
    // The bucket is keyed by `cooldownKey(args)` when a command provides one, so
    // a command that answers in parts throttles each answer separately. Keyed
    // by name alone, `!petlist` and then the `!petlist 2` its own footer asks
    // for collide — and the bot refuses the request it just made.
    const cd = Number.isFinite(Number(cmd.cooldown)) ? Number(cmd.cooldown) : config.DEFAULT_COOLDOWN;
    const cdKey = typeof cmd.cooldownKey === 'function'
      ? String(cmd.cooldownKey(parsed.args) || cmd.name)
      : cmd.name;
    const left = cooldown.check(senderID, cdKey, cd);
    if (left > 0) {
      await say(`⏳ Cooldown: wait ${helpers.fmt.dur(left)}.`);
      return;
    }

    // ── COOLDOWN RESERVED, NOT STARTED ──────────────────────
    // Taken before the command runs, not after. A slow command — heist sends
    // two replies and writes the ledger — spends a second or two in here, and
    // if the bucket were only written at the end the whole execution window
    // would be cooldown-free. That is how one cooldown paid out twice.
    cooldown.set(senderID, cdKey, cd);

    // ── PROFILE ─────────────────────────────────────────────
    //
    // getOrCreateUser never returns null and never throws: a person the bot has
    // never met gets a profile created, and a database that is asleep gets an
    // in-memory one. That is the whole reason this no longer ends in "I could
    // not load your profile" — that message only ever helped whoever happened
    // to be cached.
    const userDoc = await cache.getOrCreateUser(senderID, api);

    // ── MODERATION ────────────────────────────────────────────
    if (userDoc.isBanned) {
      cooldown.clear(senderID, cdKey);
      await say(`🚫 You are banned from using the bot${userDoc.banReason ? `: ${userDoc.banReason}` : '.'}`);
      return;
    }

    // ── REACTION (fast ack before the command runs) ────────────
    if (config.REACTIONS_ENABLED) reactTo(config.REACT_EMOJI);

    // ── EXECUTE ──────────────────────────────────────────────
    try {
      await cmd.execute({
        api,
        event,
        args: parsed.args,
        config,
        registry,
        ai,
        reply: say,
        react: reactTo,
        userDoc,
      });
      STATE.commandsRun += 1;
      await recordActivity(senderID, true, isGroupThread(threadID, event.isGroup) ? threadID : null);
    } catch (err) {
      // Hand the cooldown back. A database blip or a failed upload is not the
      // person's fault, and burning the cooldown on it means they wait out a
      // command that never actually ran.
      cooldown.clear(senderID, cdKey);
      STATE.errors += 1;
      error(`[COMMAND] ${cmd.name} threw: ${err.message}`);
      if (err && err.stack) console.error(err.stack);
      await say(`⚠️ \`${cmd.name}\` crashed: ${err.message}`);
    }
  } finally {
    release();
  }
}

/**
 * True when a thread id is a group chat rather than a private message.
 *
 * Messenger thread ids are always prefixed: `t_` for a conversation, and a
 * bare numeric uid for a one-to-one chat. Counting a DM as a group would file
 * every hunter's private chatter under a fake chat record and pollute the
 * group standings the module ranks on. sendMessage needs the same distinction
 * to pick isSingleUser, so both callers share helpers.isGroupThread rather
 * than keeping two copies that can drift apart.
 */
const isGroupThread = helpers.isGroupThread;

/**
 * Bump the user profile counters. Best effort, never fatal.
 *
 * Also records where this hunter was last active, which is what the group
 * module ranks on: !gcstatsultra, !gcmembers and !quotebomb all select on
 * `gc.lastGroup`. Without this hook those three commands would find nobody
 * forever, because nothing else in the engine knows which chat a user spoke in.
 *
 * @param {string} senderID
 * @param {boolean} isCommand  true when the message actually ran a command
 * @param {string} [threadID]  the chat the message came from, when it was a group
 */
async function recordActivity(senderID, isCommand, threadID) {
  if (!senderID) return;
  try {
    const user = await cache.getOrCreateUser(senderID, client);
    if (!user || user.transient) return; // DB down — nothing to persist
    if (isCommand) user.stats.commandsUsed += 1;
    user.stats.messages += 1;
    user.lastSeen = new Date();

    if (threadID) {
      if (!user.gc || typeof user.gc !== 'object') user.gc = {};
      if (!Number.isFinite(user.gc.msgs)) user.gc.msgs = 0;
      if (!Number.isFinite(user.gc.toxicity)) user.gc.toxicity = 0;
      user.gc.msgs += 1;
      if (isCommand) user.gc.toxicity += 1;
      user.gc.lastGroup = String(threadID);
      user.gc.lastMsgAt = new Date();
    }

    await user.save();
    cache.touch(senderID, user);
  } catch (err) {
    error(`[PROFILE] stats update failed for ${senderID}: ${err.message}`);
  }
}

// ── RELOAD ───────────────────────────────────────────────────
/**
 * Re-scan commands/ without restarting the process.
 * Command files are evicted from require.cache so edits take effect.
 * @returns {{count:number, aliases:number, ms:number}}
 */
function reloadCommands() {
  const started = Date.now();
  loader.setHotReload(true);
  try {
    const loaded = loader.loadCommands();
    registry = loaded.registry;
    aliases = loaded.aliases;
    return { count: registry.size, aliases: aliases.size, ms: Date.now() - started };
  } finally {
    loader.setHotReload(false);
  }
}

// ── GROUP MANAGEMENT
// ─────────────────────────────────────────────────────────────
/**
 * The people named in a group-change event, as `{uid, name}` pairs.
 *
 * Two shapes reach us for a join, and getting this wrong is why every welcome
 * used to read "[object Object]":
 *
 *   - `addedParticipants: [{ fbId: '123', fullName: 'Ada' }]` — the documented
 *     ws3-fca shape, and the one Facebook actually sends.
 *   - a bare string or number, when the payload is thin.
 *
 * The old code did `String(added[0])`, which stringifies the object form to
 * "[object Object]" and the bare form to a raw numeric uid. Neither is a name.
 *
 * WHAT IS DELIBERATELY NOT USED: `event.author`.
 *
 * ws3-fca builds that from `messageMetadata.actorFbId`
 * (src/utils/formatters.js:647) — the person who PERFORMED the action, not the
 * person it happened to. When an admin adds somebody, `author` is the admin. So
 * the previous fallback to `author` on an empty payload announced the admin:
 * "Welcome Zee to the group", for the admin who welcomed somebody else. On a
 * removal it is whoever did the removing, while the person who left is named in
 * `leftParticipantFbId`.
 *
 * Silence is the right answer when the payload names nobody. Announcing the wrong
 * person to a whole group is worse than not announcing at all.
 *
 * @param {*} data logMessageData
 * @returns {{uid:string,name:string}[]}
 */
function changeParticipants(data) {
  const raw = Array.isArray(data && data.addedParticipants)
    ? data.addedParticipants
    : [];

  const people = raw.map((p) => {
    if (p == null) return null;
    if (typeof p === 'object') {
      // fbId is the field ws3-fca forwards; id/userId appear in some payloads.
      const uid = p.fbId || p.id || p.userId || p.uid || p.actorFbId;
      return uid ? { uid: String(uid), name: p.fullName || p.name || '' } : null;
    }
    const text = String(p).trim();
    if (!text) return null;
    // A bare entry is sometimes a bare uid and sometimes "Name (uid)".
    const pair = text.match(/^(.*?)\s*\((\d+)\)$/);
    if (pair) return { uid: pair[2], name: pair[1].trim() };
    return /^\d+$/.test(text) ? { uid: text, name: '' } : { uid: '', name: text };
  }).filter(Boolean);

  if (people.length) return people;

  // A departure carries exactly one id, under a different key.
  const left = String((data && data.leftParticipantFbId) || '').trim();
  if (/^\d+$/.test(left)) return [{ uid: left, name: '' }];

  return [];
}

/**
 * Drop the bot itself from a join/leave list.
 *
 * Facebook reports the bot's own join and leave through the same
 * log:subscribe / log:unsubscribe events as everybody else, so without this the
 * chat is told "welcome, iKON BOT to the group" the moment it starts up and
 * "goodbye, iKON BOT" the moment it is restarted or removed by an admin. It is
 * the one member of the audience that the message is not for.
 *
 * @param {Array<{uid:string,name:string}>} people
 * @param {string} selfId this bot's own uid
 * @returns {Array<{uid:string,name:string}>}
 */
function notMe(people, selfId) {
  const id = String(selfId || '');
  if (!id) return people;
  return people.filter((p) => String(p.uid) !== id);
}

/**
 * Per-thread join/leave facts, cached for a few seconds.
 *
 * Short TTL on purpose: it only has to survive a burst of simultaneous join
 * events for one import, and a chat's member list going stale is the thing that
 * would put yesterday's face on today's welcome card.
 */
const THREAD_INFO_TTL_MS = 20 * 1000;
const threadInfoCache = new Map();

/** Forget every cached thread. Exposed for tests. */
function clearThreadInfo() {
  threadInfoCache.clear();
}

/**
 * The chat's own facts: its name, how many people are in it, and each member's
 * id/name/thumbSrc.
 *
 * ONE lookup, cached briefly, because a join burst in a busy chat fires this
 * event several times a second and getThreadInfo is not free. The cache exists
 * for the picture and the count: `thumbSrc` arrives here and nowhere else, and
 * it is a direct CDN url — no access token, no redirect — which makes it both the
 * cheapest and the most reliable avatar source there is.
 *
 * The previous code called getThreadInfo on every single announcement and threw
 * everything away but the title, while its own comment claimed the result was
 * cached.
 *
 * @param {string} threadID
 * @param {object} api
 * @returns {Promise<{name:string, count:number, users:Map<string,{name:string, thumbSrc:string}>}>}
 */
async function threadInfo(threadID, api) {
  const fallback = {
    name: String(threadID || ''),
    count: 0,
    users: new Map(),
  };
  if (!threadID || !api || typeof api.getThreadInfo !== 'function') return fallback;

  const key = String(threadID);
  const hit = threadInfoCache.get(key);
  if (hit && Date.now() < hit.expires) return hit.value;

  try {
    const info = await api.getThreadInfo(key);
    const name = info && (info.threadTitle || info.threadName || info.name || info.title);
    const users = new Map();
    for (const u of (info && info.userInfo) || []) {
      if (!u || !u.id) continue;
      users.set(String(u.id), {
        name: u.name || u.firstName || '',
        thumbSrc: u.thumbSrc || u.profileUrl || '',
      });
    }
    // participantIDs is the count ws3-fca exposes. A chat larger than the
    // GraphQL page it fetches reports the page size rather than the true total,
    // which is the same number the bot shows everywhere else, so the card agrees
    // with the group instead of contradicting it.
    const count = Number(info && info.participantIDs && info.participantIDs.length) || 0;
    const value = {
      name: name ? String(name) : fallback.name,
      count,
      users,
    };
    threadInfoCache.set(key, { value, expires: Date.now() + THREAD_INFO_TTL_MS });
    return value;
  } catch (err) {
    error(`[GROUP] getThreadInfo(${threadID}) failed: ${err.message}`);
    return fallback;
  }
}

/**
 * A thread-info lookup that never throws or crashes the handler.
 *
 * Wraps threadInfo so a single malformed thread cannot take down the listener.
 * Returns {threadName, participantIDs} so callers never get an undefined shape.
 *
 * @param {string} threadID
 * @param {object} api
 * @returns {Promise<{threadName:string, participantIDs:string[]}>}
 */
async function safeGetThreadInfo(threadID, api) {
  try {
    const info = await threadInfo(threadID, api);
    return {
      threadName: info?.name || String(threadID || ''),
      participantIDs: info?.users ? [...info.users.keys()] : [],
    };
  } catch (err) {
    error(`[GROUP] safeGetThreadInfo(${threadID}) failed: ${err.message}`);
    return { threadName: String(threadID || 'Unknown'), participantIDs: [] };
  }
}

/**
 * The display name of a chat, for `{group}`.
 *
 * A join/leave event carries only a thread id, and the id used to be what
 * `{group}` was replaced with — so "Welcome {user} to {group}" announced a
 * fifteen-digit number.
 *
 * @param {string} threadID
 * @param {object} api
 * @returns {Promise<string>}
 */
async function chatName(threadID, api) {
  return (await threadInfo(threadID, api)).name;
}

/**
 * Fill the placeholders a welcome or goodbye line can use.
 *
 * `{user}` is the real Facebook name — resolved live, because a join payload
 * often carries an empty one and an announcement reading "Hunter 4821" is not a
 * welcome. `{mention}` is the same name as a Facebook tag, which is what makes
 * the new arrival ping in the notification tray.
 *
 * @param {string} template
 * @param {object} who `{uid, name}`
 * @param {object} ctx `{threadName, threadID}`
 * @param {string} [mention] prebuilt @tag, passed in so the lookup happens once
 * @returns {string}
 */
function fillPlaceholders(template, who, ctx, mention) {
  return String(template)
    .replace(/{user}/g, who.name)
    .replace(/{name}/g, who.name)
    .replace(/{mention}/g, mention || who.name)
    .replace(/{uid}/g, who.uid || '')
    .replace(/{group}/g, ctx.threadName)
    .replace(/{chat}/g, ctx.threadName)
    .replace(/{thread}/g, String(ctx.threadID == null ? '' : ctx.threadID));
}

/**
 * Announce one arrival or departure: ONE message, carrying the card and the line.
 *
 * THE DOUBLE SEND, and why it was there.
 * This used to call sendMessage twice: once with the admin's text, then again
 * with the card. Every single join dropped two messages into a chat — the text
 * above, then a picture with no caption — and every goodbye did the same. The
 * card and the sentence belong to each other; a member who saw the text scroll
 * past had already missed the picture by the time it landed. There is one send
 * here now, with both in the payload, and there is one implementation of this
 * handler, so there is nothing left to delete to stop a second copy arriving.
 *
 * The card is best-effort. Without the native canvas binary — or if drawing
 * throws, or the download of the avatar fails — `arrivalCard` returns null and
 * the same message goes out as text alone. A platform that cannot render must
 * still say the name.
 *
 * @param {object} api
 * @param {string} threadID
 * @param {'welcome'|'goodbye'} kind
 * @param {object} who
 * @param {object} info `{name, count, users}` from threadInfo()
 * @param {string} template the admin's line, or '' for the built-in one
 * @param {boolean} isGroup
 */
async function announce(api, threadID, kind, who, info, template, isGroup) {
  const leaving = kind === 'goodbye';
  const threadName = info && info.name ? info.name : String(threadID || '');

  // A tag needs the name to already be resolved, so the live lookup happens
  // here rather than inside the template filler.
  const live = who.uid ? await profile.fetchRealName(who.uid, api) : null;
  const fromEvent = who.name && !profile.isPlaceholderName(who.name) ? String(who.name).trim() : '';
  // `realName` is a name we can stand behind. `display` is the last-resort
  // handle, which is NOT a real name and must never be used to build a mention.
  const realName = live || fromEvent || '';
  const display = realName || (who.uid ? `Hunter ${who.uid.slice(-4)}` : 'Someone');

  // The body. An admin who wrote their own line keeps it; the built-in one is
  // what a chat that never customised anything gets.
  const body = template
    ? fillPlaceholders(
      template,
      { uid: who.uid, name: display },
      { threadName, threadID },
      realName ? `@${realName}` : display,
    )
    : leaving
      ? `${display} left ${threadName} 😢`
      : `Hello ${realName ? `@${realName}` : display} 👋 Welcome to ${threadName} 💚`;

  const payload = { body };

  // A mention is only a mention when Facebook is told which uid the tag
  // belongs to. Writing "@Ada" into the body on its own produces an ordinary
  // message that happens to contain an @ — the arrival is never pinged,
  // which is the most visible thing a welcome can get wrong. The tag text
  // has to appear verbatim in the body for Facebook to accept the link.
  //
  // With no real name, plain text: a `mentions` entry whose tag does not
  // match the member's actual name is refused by Facebook, which would cost
  // the whole welcome message rather than just its ping.
  if (who.uid && realName && String(template || '').includes('{mention}')) {
    payload.mentions = [{ id: String(who.uid), tag: `@${realName}` }];
  }

  // The picture, in the same send. `thumbSrc` off the thread member list is
  // preferred over the getUserInfo endpoint: it is already in hand, it is a
  // direct CDN url, and it does not go through the graph redirect.
  const known = (info && info.users && info.users.get(String(who.uid))) || null;
  try {
    const png = await cards.arrivalCard({
      kind,
      uid: who.uid,
      name: display,
      threadName,
      threadID,
      picUrl: (known && known.thumbSrc) || '',
      count: (info && info.count) || 0,
      api,
    });
    if (png) {
      // A stream, not a descriptor. ws3-fca 3.5.2 throws on
      // `{ type, data: { url } }`, and this used to turn that into a silent
      // no-op — the group got its join line, just never the art.
      const card = await require('./bot/media').attachment(png, { type: 'image' });
      if (card) payload.attachment = card;
    }
  } catch (err) {
    error(`[GROUP] ${kind} card failed: ${err.message}`);
  }

  if (!String(payload.body || '').trim() && !payload.attachment) return;
  await reply(api, threadID, payload, null, isGroup);
}

/**
 * The bot's own uid, or ''.
 *
 * `api.getCurrentUserID()` returns a Promise. The two call sites that used it
 * did `String(api.getCurrentUserID())`, which stringifies the *Promise* — the
 * value was literally "[object Promise]" — so every comparison below compared a
 * real uid against that string and never matched.
 *
 * The Promise is awaited here, and the result is only accepted if it looks like
 * a uid. Anything else is worse than nothing: a wrong value flows on into
 * "did the bot just join?" and "did the leaver leave?" and both answer yes or
 * no wrongly.
 *
 * @param {object} api
 * @param {object|null} event
 * @returns {Promise<string>}
 */
async function selfUid(api, event) {
  const fallback = (event && (event.BotID || STATE.userID)) || '';
  if (!api || typeof api.getCurrentUserID !== 'function') return String(fallback);
  try {
    const id = await api.getCurrentUserID();
    if (typeof id === 'string' || typeof id === 'number') {
      const s = String(id);
      if (/^\d+$/.test(s)) return s;
    }
  } catch {
    // Fall through to the event and cached values.
  }
  return String(fallback);
}

/**
 * Lock a chat the moment the bot is added to it.
 *
 * Called on every log:subscribe, and almost always does nothing: the bot is
 * already in the chat, the document already exists, or the uid that joined was
 * a person. It acts on exactly one event — the bot's own uid appearing in a
 * chat with no Group document — which is what "a stranger added this bot"
 * looks like from the inside.
 *
 * That condition is the whole design. There is no flag to set before adding
 * the bot and no way to lock a chat retroactively, because both would require
 * trusting whoever added it, which is the person the lock exists to hold back.
 *
 * It fails open if the database is not ready. A bot that refuses to speak
 * because it cannot check a flag is a worse outcome than one un-locked chat,
 * and this is the only code path that decides whether a *new* chat is held —
 * existing locks do not depend on it.
 *
 * @returns {Promise<boolean>} true when this call locked the chat
 */
async function handleBotArrival(api, event, threadID, data, selfId, isGroup) {
  if (!isGroup || !selfId) return false;
  // changeParticipants returns {uid, name} entries, not bare ids — comparing
  // the uid list against selfId directly never matched anything, so this
  // returned false on the one event it exists for.
  const added = changeParticipants(data)
    .map((p) => (p && p.uid) || '')
    .filter(Boolean);
  if (!added.includes(selfId)) return false;
  // An existing Group document means the bot was already serving this chat, so
  // this subscribe is the bot being re-added, not a stranger adding it. Asking
  // rather than creating: getGroup() would happily mint an approved document,
  // which is exactly the wrong answer for a chat nobody approved.
  if (await toggles.findGroup(threadID)) return false;
  if (!mongo.isReady()) return false;

  // Everything `!pending` shows about this chat is written down HERE, at the one
  // moment the answer is knowable, and never read from the event again. An
  // event carries a thread id and nothing else: the chat's name and the name of
  // the person who pulled the bot in are two lookups away, and a record built
  // without them is the "(unknown chat) / someone / unknown time" row an owner
  // cannot act on.
  const info = await threadInfo(threadID, api);
  const threadName = info.name && info.name !== String(threadID) ? info.name : 'Unknown';

  // event.author is who Facebook names as the actor on this subscribe. The
  // participant list is the bot itself by construction, so it is never a source
  // for "who added it" — reading it that way is how the list ended up crediting
  // the bot with adding the bot. `alsoAdded` is the fallback for a client that
  // omits the author, and never includes the bot.
  const alsoAdded = added.filter((u) => u !== selfId);
  const addedByID = String((event && (event.author || event.actorFbId)) || (alsoAdded[0] || '')).trim();
  let addedByName = '';
  if (addedByID) {
    addedByName = (await profile.fetchRealName(addedByID, api).catch(() => null)) || '';
  }

  await pending.lock(threadID, { name: threadName, addedBy: addedByID, addedByName });
  log(`[PENDING] ${threadID} is waiting for approval (${threadName}${addedByName ? `, added by ${addedByName}` : ''})`);

  try {
    await reply(api, threadID, {
      body: `🔒 This group is pending approval. Contact bot admins.\n\nOnce approved: ${config.PREFIX}pending · ${config.PREFIX}approve`,
    }, null, true);
  } catch (err) {
    error(`[PENDING] could not announce lock in ${threadID}: ${err.message}`);
  }
  return true;
}

async function handleGroupChange(api, event) {
  const threadID = event.threadID;
  // ws3-fca reports joins/leaves as log:subscribe / log:unsubscribe.
  const action = event.logMessageType;
  const data = event.logMessageData || {};
  // These events never carry `isGroup` — formatDeltaEvent (formatters.js:636)
  // omits it entirely — so it arrives here undefined. Left that way the send
  // falls back to a `t_` prefix test, which is right for every real group, but
  // it makes the flag below depend on that fallback holding. Join and leave
  // events only ever happen in group threads, so it is derived once, here.
  const isGroup = event.isGroup === undefined ? true : event.isGroup !== false;
  // The bot's own uid, used to keep it out of its own welcome/goodbye cards.
  const selfId = await selfUid(api, event);

  try {
    // New member joined
    if (action === 'log:subscribe') {
      // Ahead of getGroup(), which would create the document this is deciding
      // about. Returns true when the bot itself was the one added.
      if (await handleBotArrival(api, event, threadID, data, selfId, isGroup)) return;
      const group = await toggles.getGroup(threadID);
      // notMe, not the caller: Facebook reports the bot's own join through
      // the same log:subscribe as everybody else, so without this the chat is
      // told "welcome, iKON BOT to the group" the moment it starts up.
      const people = notMe(changeParticipants(data), selfId);

      // Anti-raid, ahead of the welcome announcement and independent of it.
      //
      // A raid is exactly the case where `welcome on` and a burst of twenty
      // joins happen together, and the answer to both at once must not be twenty
      // welcome cards from the bot — that is the raid being amplified instead of
      // stopped. This also gives `!antiraid` the thing it always promised: it had
      // a burst number and a window in the database, and nothing anywhere counted
      // a join, so the lock could never fire no matter how the chat was set up.
      if (people.length && group.gc && group.gc.antiRaid && group.gc.antiRaid.on) {
        try {
          const raid = await moderation.raidCheck({ threadID, joins: people.length, gc: group.gc });
          if (raid.sealed) {
            await helpers.reply(
              api,
              threadID,
              `🛡️ **RAID LOCK**\n\n`
              + `${raid.joins} people joined inside ${fmt.dur(Math.round((Number(group.gc.antiRaid.windowMs) || 10000) / 1000))}.\n`
              + `This chat is sealed for ${Math.round(raid.holdSec / 60) || 1} minutes.\n`
              + '📖 Bot admins still get through.',
              null,
              isGroup,
            );
            return;
          }
        } catch (err) {
          // Never let the raid check cost somebody their welcome message.
          error(`[GROUP] anti-raid check failed in ${threadID}: ${err.message}`);
        }
      }

      // The toggle alone, not the toggle AND a configured line. A chat that ran
      // `!welcome on` and never touched `!setwelcome` used to get silence,
      // because the gate also asked for a message that only the second command
      // writes — so "welcome is on" and "nothing is ever announced" were both
      // true at once.
      if (group.settings?.welcome) {
        if (people.length) {
          const info = await threadInfo(threadID, api);
          // Facebook can report several people at once — an admin import adds
          // twenty. One message each is correct: a single line naming everybody
          // reads as a list, not a welcome.
          for (const who of people) {
            // eslint-disable-next-line no-await-in-loop
            await announce(api, threadID, 'welcome', who, info, group.settings.welcomeMsg, isGroup);
          }
        }
      }
      return;
    }

    // Member left
    if (action === 'log:unsubscribe') {
      const group = await toggles.getGroup(threadID);

      // !autoadd: invite the leaver straight back. gcmember is an MQTT publish,
      // so it resolves once the request is queued, not once Facebook confirms
      // the person is back.
      if (group.autoAddLeavers) {
        // leftParticipantFbId only. Never event.author: that is actorFbId, the
        // person who did the removing, so falling back to it would invite the
        // admin who kicked somebody straight back into the chat — the exact
        // opposite of what a group admin pressing "remove" expects.
        const leaver = String(data.leftParticipantFbId || '');
        // Never re-add ourselves, and never try a non-numeric id: gcmember
        // does parseInt on it and would invite uid 0.
        if (leaver && /^\d+$/.test(leaver) && leaver !== String(event.BotID || STATE.userID || '')) {
          try {
            await api.gcmember('add', leaver, threadID);
            log(`[GROUP] re-invited ${leaver} to ${threadID} (autoAddLeavers)`);
          } catch (err) {
            error(`[GROUP] re-invite of ${leaver} failed: ${err.message}`);
          }
        } else {
          error(`[GROUP] autoAddLeavers could not re-invite "${leaver}" — unusable id`);
        }
      }

      if (group?.settings?.goodbye) {
        const people = notMe(changeParticipants(data), selfId);
        // A dead account this bot just cleared out of the roster is not a loss.
        // It comes back as the same log:unsubscribe a person leaving does, with
        // nothing in the payload to tell the two apart — so `!gccleanup` was
        // posting a goodbye card for every account it removed, in every chat it
        // ran in. gcs records what it removed; this is where that is read back.
        const human = people.filter((p) => !gcs.wasKicked(threadID, p.uid));
        if (human.length) {
          const info = await threadInfo(threadID, api);
          await announce(api, threadID, 'goodbye', human[0], info, group.settings.goodbyeMsg, isGroup);
        }
      }
    }
  } catch (err) {
    error(`[GROUP] ${action} failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// LOGIN + CLIENT WIRING
// ─────────────────────────────────────────────────────────────
function attachClient(api) {
  client = api;
  // The spawner and the group sweep both need a live client, and the only moment
  // we are certain we have one is the moment it is handed over.
  pokemonSpawn.start(api, { log, error });
  // Before the sweep, not beside it. A restart is exactly when a lock has to
  // still be true, and the sweep runs per-chat writes that take as long as the
  // thread list does.
  pending.hydrate()
    .catch((err) => error(`[PENDING] hydrate failed: ${err.message}`))
    .then(() => gcs.cacheThreadsOnLogin(api))
    .catch((err) => error(`[GCS] thread cache at login failed: ${err.message}`))
    .then(() => gcs.approveAll(api))
    .catch((err) => error(`[GCS] boot enable sweep failed: ${err.message}`));
}

/**
 * JSON.stringify that cannot throw.
 *
 * An MQTT event carries a normalised message object, and `JSON.stringify`
 * dies on the first circular reference it meets — which would take down the
 * listener itself, the one piece of code that must never fail. Falls back to
 * a plain key list, which is still enough to see what arrived.
 *
 * @param {*} value
 * @param {number} [limit] max characters
 * @returns {string}
 */
function safeInspect(value, limit = 500) {
  try {
    return JSON.stringify(value).slice(0, limit);
  } catch {
    try {
      return JSON.stringify(Object.keys(value || {})).slice(0, limit);
    } catch {
      return '(unserialisable)';
    }
  }
}

/**
 * Route ws3-fca MQTT events into the command chain.
 *
 * ws3-fca does NOT expose `api.on(...)`. Events arrive on the EventEmitter
 * that `api.listenMqtt()` returns, so that is what this subscribes to. The
 * emitter is also the only place a disconnect is signalled.
 *
 * @param {object} api ws3-fca client
 * @param {EventEmitter} emitter emitter returned by api.listenMqtt()
 */
function attachEvents(api, emitter) {
  client = api;

  emitter.on('message', (event) => {
    if (!event || !event.threadID) return;

    // Text messages from other people are the only thing commands care about.
    // ws3-fca labels a reply "message_reply" (listenMqtt.js:246), so accepting
    // only "message" silently dropped every message sent as a reply to the bot
    // — the reaction path still worked, which is exactly the reported symptom.
    if (event.type === 'message' || event.type === 'message_reply') {
      if (event.isSelf === true) return;
      // An attachment-only message has no body but is still a real message
      // (a sticker or a photo is sent with an empty body).
      const hasBody = typeof event.body === 'string' && event.body.length > 0;
      const hasAttachment = Array.isArray(event.attachments) && event.attachments.length > 0;
      if (!hasBody && !hasAttachment) return;
      safe(() => handleMessage(api, event), api, event.threadID, event.messageID, 'message', event.isGroup);
      return;
    }

    // Group joins/leaves arrive as `type: 'event'` with a logMessageType.
    if (event.type === 'event' && /^log:(subscribe|unsubscribe)$/.test(event.logMessageType || '')) {
      safe(() => handleGroupChange(api, event), api, event.threadID, null, event.logMessageType, true);
    }
  });

  emitter.on('error', (err) => {
    STATE.loggedIn = false;
    error(`[FCA] ${(err && err.message) || err}`);
  });

  emitter.on('stop', () => {
    STATE.loggedIn = false;
    error('[MQTT] Listener stopped');
  });
}

/**
 * Toggle sleep mode every minute based on Jordan time (GMT+3).
 * 03:00–05:00 → bot dormant, no replies.
 */
function startSleepMode() {
  const tick = () => {
    const d = new Date();
    const offsetMin = d.getTimezoneOffset() + 180;
    const jordan = new Date(d.getTime() + offsetMin * 60 * 1000);
    const h = jordan.getHours();
    global.botSleeping = (h >= 3 && h < 5);
  };
  tick();
  setInterval(tick, 60 * 1000);
}

/**
 * Log into Facebook and start the MQTT listener.
 *
 * ws3-fca exports `{ login }` — a function, NOT a constructor. Calling
 * `new fca(...)` throws "fca is not a constructor", which is what used to kill
 * the process here. The real shape is:
 *
 *   login(credentials, options, (err, api) => ...)
 *
 * Options are passed to login() (there is no api.setOptions), events come from
 * the emitter api.listenMqtt() returns (there is no api.on), and the account id
 * comes from api.getCurrentUserID() (there is no api.getOwnUserId).
 *
 * @returns {Promise<object|null>} the api, or null if login failed
 */
function login() {
  if (!config.APPSTATE.length) {
    error('[LOGIN] APPSTATE is empty — set it in .env before starting.');
    return Promise.resolve(null);
  }

  let fcaLogin;
  try {
    // eslint-disable-next-line global-require
    ({ login: fcaLogin } = require('ws3-fca'));
  } catch (err) {
    error(`[LOGIN] ws3-fca not installed: ${err.message}`);
    return Promise.resolve(null);
  }

  if (typeof fcaLogin !== 'function') {
    error('[LOGIN] ws3-fca did not export login() — check the installed version.');
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(failTimer);
      resolve(value);
    };

    const failTimer = setTimeout(() => {
      error('[LOGIN] Timed out after 2 minutes — check APPSTATE.');
      done(null);
    }, 120000);

    // A bot that logs in the instant the process starts looks like a bot. A
    // random 5-10s delay before the first attempt is the difference between
    // "account logging in from a new device" and "account logging in from a new
    // device at machine speed", and Facebook notices the second one.
    const preDelay = 5000 + Math.random() * 5000;
    log(`[LOGIN] Waiting ${Math.round(preDelay / 1000)}s before the first attempt...`);

    const options = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      // Anti-detection. Each of these stops the bot doing something Facebook
      // uses as a bot signal:
      //   autoMarkDelivery:false - read receipts on every message.
      //   autoMarkRead:false      - same, on the other side of the pair.
      //   updatePresence:false    - presence pings, another spam signal.
      //   online:false            - don't announce the session as active.
      //   selfListen:false        - our own messages must not come back to us.
      //   listenEvents:true       - group join/leave events, used by !autoadd.
      //   logLevel:'silent'       - ws3-fca's own chatter is noise in the logs.
      //   forceLogin:false        - let ws3-fca reuse the session where it can.
      listenEvents: true,
      listenTyping: false,
      autoMarkRead: false,
      autoMarkDelivery: false,
      updatePresence: false,
      selfListen: false,
      online: false,
      logLevel: 'silent',
      forceLogin: false,
      autoReconnect: true,
    };

    try {
      fcaLogin({ appState: config.APPSTATE }, options, async (err, api) => {
        if (err || !api) {
          const msg = (err && err.message) || 'no api returned';
          error(`[LOGIN] ${msg}`);
          loginAttempts += 1;

          // "Error retrieving userID" is what Facebook returns for a blocked
          // login as well as a bad cookie. Retrying it in a tight loop is how
          // a bot gets permanently banned, so count the blocks and stop
          // hammering once the account has clearly been rate-limited.
          if (/retrieving userID|blocked|try again later|captcha/i.test(msg)) {
            if (loginAttempts >= LOGIN_MAX_ATTEMPTS) {
              error(
                `[LOGIN] Blocked ${loginAttempts} times - the account is rate-limited. `
                + 'Stopping retries. Refresh the appstate and redeploy.',
              );
              done(null);
              return;
            }
            error(
              `[LOGIN] Blocked (${loginAttempts}/${LOGIN_MAX_ATTEMPTS}) - waiting `
              + `${Math.round(getRetryDelay() / 1000)}s before the next attempt.`,
            );
          }
          done(null);
          return;
        }

        // Capture what Facebook really says when a send is rejected. ws3-fca
        // does `throw new Error(resData)`, which stringifies the error object to
        // "[object Object]" — without this tap the reason is unrecoverable.
        fcaDiag.install();

        // Re-assert the options that decide whether we ever see a message.
        // login() takes them too, but setOptions is the only way to change them
        // AFTER a successful login, and these two are the difference between
        // "bot is deaf" and "bot is talking".
        //   selfListen:false — our own messages must not come back to us.
        //   listenEvents:true — group join/leave events, used by !autoadd.
        //   autoMarkRead:false, autoMarkDelivery:false — stop generating read
        //     receipts Facebook treats as bot spam on every message.
        //   updatePresence:false — stop ping-ing presence, another FB spam signal.
        if (typeof api.setOptions === 'function') {
          try {
            await api.setOptions({
              selfListen: false, listenEvents: true,
              autoMarkRead: false, autoMarkDelivery: false,
              updatePresence: false, online: false,
            });
          } catch (err) {
            error(`[LOGIN] setOptions failed: ${err.message}`);
          }
        }

        STATE.loggedIn = true;
        // A successful login resets the block counter. The backoff only grows
        // across consecutive failures; one good login clears the slate so the
        // next block starts from 30s instead of 10 minutes.
        loginAttempts = 0;
        STATE.userID = await selfUid(api, null);
        log(`[LOGIN] ${config.BOT_NAME} logged in as ${STATE.userID || 'unknown'}`);

        // Wild Pokemon start spawning now that there is a client to post with
        // and an emitter to receive catches on. Started here rather than at
        // module load because before login there is no api to send with.
        pokemonSpawn.start(api, { log, error });

        // startListening resolves with the emitter once the MQTT connection is
        // up. Failing to listen is not fatal: the HTTP server and commands stay
        // available, so the deploy is not restarted over a flaky socket.
        try {
          const emitter = await api.listenMqtt();
          attachEvents(api, emitter);
          log('[MQTT] Listening');
          startSleepMode();
        } catch (err) {
          error(`[MQTT] listener failed to start: ${err.message}`);
        }

        done(api);
      });
    } catch (err) {
      error(`[LOGIN] Threw: ${err.message}`);
      done(null);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────
async function boot() {
  log('=================================================');
  log(` ${config.BOT_NAME} v${config.VERSION}`);
  log(` Owner: ${config.OWNER}`);
  log(` Node ${process.version} — env ${config.NODE_ENV}`);
  log('=================================================');

  // 1. SERVER — first thing, so /health answers even if every later step fails.
  if (!server) server = startServer();

  // 2. LOADER — runs first so the bot is command-ready even if the DB is slow.
  const loaded = loader.loadCommands();
  registry = loaded.registry;
  aliases = loaded.aliases;

  if (!registry.size) {
    error('[BOOT] No commands loaded — check commands/cmds_*.js');
  }

  // 3. DATABASE — retried, but never blocks the rest of boot for long.
  log('[BOOT] Connecting to database…');
  const dbOk = await mongo.connectWithRetry(2, 4000);
  if (!dbOk) {
    error('[BOOT] Database unreachable — running in degraded mode (non-DB commands still work).');
  }

  // 4. CANVAS (optional)
  log(canvas.available() ? '[CANVAS] ready' : '[CANVAS] not available (image commands disabled)');

  // 5. LOGIN
  const api = await login();
  if (!api) {
    error(`[BOOT] Login failed — retrying in ${Math.round(getRetryDelay() / 1000)}s. /health stays up meanwhile.`);
    scheduleRetry();
  } else {
    log(`[BOOT] ${config.BOT_NAME} is online with ${registry.size} commands. Try \`${config.PREFIX}ping\``);
  }

  // 6. POKEMON SPAWNER — after login, because it needs a real client to post
  // with. Started even when login failed: the timer holds the handle and the
  // first tick after a successful retry is the first one that does anything.
  pokemonSpawn.start(api || client, { log, error });

  // 7. PENDING LOCKS — read the database's locks back into memory, then sweep
  // the chats so every established group is enabled.
  //
  // Hydrate first and await it. Until the cache is rebuilt a restarted bot
  // believes no chat is pending, and would let a locked chat run commands until
  // the read landed — a window that is exactly as long as the query and is
  // taken every single restart.
  await pending.hydrate().catch((err) => error(`[PENDING] hydrate failed: ${err.message}`));
  if (api) {
    try { await gcs.cacheThreadsOnLogin(api); } catch (err) { error(`[GCS] thread cache at login failed: ${err.message}`); }
    await gcs.approveAll(api).catch((err) => error(`[GCS] boot enable sweep failed: ${err.message}`));
  }

  // 8. HOUSEKEEPING
  if (!housekeeping) {
    housekeeping = setInterval(() => {
      cooldown.sweep();
      cache.sweep();
      // Both spam stores are per-message state with no user-visible reason to
      // keep a stale entry: flood drops expired fingerprints and spent holds,
      // moderation drops chats it has not been asked about in a while.
      flood.sweep();
      moderation.sweep();
      // Football goal alerts. A chat following a club gets a message the
      // moment its score moves, which is the whole point of `!follow`; this
      // runs in the same minute sweep as the cleanup so the bot has one
      // background clock for every periodic job.
      if (api && footballCmds && footballCmds.football) {
        footballCmds.football.tick(api).catch((err) => error(`[FOOTBALL] tick: ${err.message}`));
      }
    }, 60 * 1000);
    if (typeof housekeeping.unref === 'function') housekeeping.unref();
  }

  return { registry, aliases, api };
}

// Graceful shutdown for Render.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log(`[SHUTDOWN] ${sig} received`);
    // Stop spawning before the database goes away. A tick that fires during
    // disconnect would log a connection error on the way out, and the interval
    // holds the event loop open until process.exit anyway.
    try { pokemonSpawn.stop(); } catch { /* noop */ }
    try { await mongo.disconnect(); } catch { /* noop */ }
    process.exit(0);
  });
}

// Never let an unhandled rejection take the bot down.
process.on('unhandledRejection', (err) => {
  STATE.errors += 1;
  error(`[UNHANDLED] ${(err && err.message) || err}`);
});
process.on('uncaughtException', (err) => {
  STATE.errors += 1;
  error(`[UNCAUGHT] ${(err && err.message) || err}`);
});

/**
 * Start the bot. Shared by both entry points (index.js and this file when run
 * directly) so a boot failure always ends in a retry, never in process.exit.
 *
 * @returns {Promise<void>}
 */
function start() {
  return boot().catch((err) => {
    // Never process.exit on a boot failure: the HTTP server is already up and
    // Render only needs /health to answer. Retry instead.
    error(`[BOOT] Fatal: ${err && err.stack ? err.stack : err}`);
    scheduleRetry();
  });
}

if (require.main === module) start();

module.exports = {
  start,
  boot,
  login,
  startServer,
  handleMessage,
  handleGroupChange,
  handleBotArrival,
  selfUid,
  // Exported for the tests: the placeholder rules and the payload shapes are
  // the whole bug surface here, and they are much easier to assert on directly
  // than through a mocked Facebook send.
  changeParticipants,
  notMe,
  chatName,
   threadInfo,
   safeGetThreadInfo,
   clearThreadInfo,
  fillPlaceholders,
  attachClient,
  attachEvents,
  reloadCommands,
  resetThreadRate,
  // Exposed so the tests can assert that an event actually reached the
  // handler, rather than only that nothing threw.
  STATE,
  findCommand: (name) => loader.findCommand(name, registry, aliases),
  listCommands: (category) => loader.listCommands(category, registry),
  mongo,
  canvas,
  // `dex` is the roster (151 Pokemon, rarity tiers); `pokemon` is an alias of
  // the same module, kept because the engine internals and several tests refer
  // to it by that name. Two names for one module, not two rosters.
  dex,
  pokemon: dex,
  pokemonSpawn,
  gcs,
  config,
  loader,
  toggles,
  pending,
  permissions,
  cooldown,
  cache,
  get registry() { return registry; },
  get aliases() { return aliases; },
  get client() { return client; },
  ai,
  STATE,
};
