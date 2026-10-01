'use strict';

/**
 * iKON-BOT v2 — central engine.
 *
 * Chain: LOGIN -> DATABASE -> LOADER -> MESSAGE -> PARSER -> COMMAND -> REPLY
 *
 * This file owns everything: Express server, MongoDB, ws3-fca APPSTATE login,
 * command registry + aliases, routing, permissions, cooldowns, replies,
 * reactions, group management, maintenance/toggles, the Gemini integration
 * point, and the error boundary that keeps a broken command from killing the bot.
 */

const express = require('express');

const config = require('./config');
const mongo = require('./bot/mongo');
const router = require('./bot/router');
const loader = require('./bot/loader');
const cooldown = require('./bot/cooldown');
const permissions = require('./bot/permissions');
const toggles = require('./bot/toggles');
const cache = require('./bot/cache');
const canvas = require('./bot/canvas');
const geminiClient = require('./bot/gemini');
const fcaDiag = require('./bot/fcaDiag');
const helpers = require('./bot/helpers');

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
 */
function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    boot().catch((err) => {
      error(`[BOOT] Retry failed: ${err && err.message ? err.message : err}`);
      scheduleRetry();
    });
  }, 30000);
  if (typeof retryTimer.unref === 'function') retryTimer.unref();
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
      uptime: Math.floor((Date.now() - STATE.startedAt) / 1000),
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
// GEMINI — thin facade over bot/gemini.js
//
// The HTTP call, model selection and auth all live in that module so the engine
// and the AI commands cannot drift apart. This object only keeps the shape the
// command handlers expect.
// ─────────────────────────────────────────────────────────────
const gemini = {
  available: geminiClient.available,
  ask: (prompt, opts = {}) => geminiClient.ask(prompt, {
    maxOutputTokens: opts.maxOutputTokens || 2048,
    system: opts.system,
  }),
  activeModel: geminiClient.activeModel,
  lastErrorMessage: geminiClient.lastErrorMessage,
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
    const res = await reply(api, threadID, text, replyTo ?? messageID);
    if (res) noteSendOk(label);
    else noteSendFailure(label, helpers.lastSendError() || 'sendMessage returned nothing');
    return res;
  };
  const reactTo = (emoji) => react(api, messageID, emoji || config.REACT_EMOJI);

  // ── PARSER ────────────────────────────────────────────────
  const prefix = await resolvePrefix(threadID);
  const parsed = router.parse(body, prefix);
  if (!parsed) {
    // Not a command. Count the message for the RPG profile and stop.
    await recordActivity(senderID, false, isGroupThread(threadID) ? threadID : null);
    return;
  }

  // ── COMMAND LOOKUP ────────────────────────────────────────
  const cmd = loader.findCommand(parsed.name, registry, aliases);
  commandName = (cmd && cmd.name) || parsed.commandName || parsed.name;
  if (!cmd) {
    await say(`❌ Unknown command: ${parsed.commandName || parsed.name}`);
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
    await say(`⛔ ${gate.reason}`);
    return;
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

  // ── COOLDOWN ──────────────────────────────────────────────
  const cd = Number.isFinite(Number(cmd.cooldown)) ? Number(cmd.cooldown) : config.DEFAULT_COOLDOWN;
  const left = cooldown.check(senderID, cmd.name, cd);
  if (left > 0) {
    await say(`⏳ Cooldown: wait ${helpers.fmt.dur(left)}.`);
    return;
  }

  // ── PROFILE ───────────────────────────────────────────────
  const userDoc = await cache.getUser(senderID, api);

  // cache.getUser returns null when the lookup itself fails, not only when
  // there is no profile: a dropped connection or a failed create lands there
  // too. Every command reads userDoc.coins straight away, so handing them a
  // null means either a stack trace in the chat or, worse, a command that
  // quietly does nothing and looks broken. One honest message beats both.
  if (!userDoc) {
    await say('⚠️ I could not load your profile just now. Try again in a moment.');
    return;
  }

  // ── MODERATION ────────────────────────────────────────────
  if (userDoc.isBanned) {
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
      gemini,
      reply: say,
      react: reactTo,
      userDoc,
    });
    STATE.commandsRun += 1;
    cooldown.set(senderID, cmd.name, cd);
    await recordActivity(senderID, true, isGroupThread(threadID) ? threadID : null);
  } catch (err) {
    STATE.errors += 1;
    error(`[COMMAND] ${cmd.name} threw: ${err.message}`);
    if (err && err.stack) console.error(err.stack);
    await say(`⚠️ \`${cmd.name}\` crashed: ${err.message}`);
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
    const user = await cache.getUser(senderID, client);
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
async function handleGroupChange(api, event) {
  const threadID = event.threadID;
  // ws3-fca reports joins/leaves as log:subscribe / log:unsubscribe.
  const action = event.logMessageType;
  const data = event.logMessageData || {};

  try {
    // New member joined
    if (action === 'log:subscribe') {
      const group = await toggles.getGroup(threadID);
      if (group.settings?.welcome && group.settings.welcomeMsg) {
        const added = Array.isArray(data.addedParticipants) ? data.addedParticipants : [];
        const who = added[0] || event.author;
        const text = String(group.settings.welcomeMsg)
          .replace(/{user}/g, String(who))
          .replace(/{group}/g, String(threadID));
        await reply(api, threadID, text, null);
      }
    }

    // Member left
    if (action === 'log:unsubscribe') {
      const group = await toggles.getGroup(threadID);
      if (group?.settings?.goodbye && group.settings.goodbyeMsg) {
        const who = data.leftParticipantFbId || event.author;
        const text = String(group.settings.goodbyeMsg).replace(/{user}/g, String(who));
        await reply(api, threadID, text, null);
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
    if (event.type === 'message') {
      if (event.isSelf === true) return;
      if (typeof event.body !== 'string' || !event.body) return;
      safe(() => handleMessage(api, event), api, event.threadID, event.messageID, 'message');
      return;
    }

    // Group joins/leaves arrive as `type: 'event'` with a logMessageType.
    if (event.type === 'event' && /^log:(subscribe|unsubscribe)$/.test(event.logMessageType || '')) {
      safe(() => handleGroupChange(api, event), api, event.threadID, null, event.logMessageType);
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

    const options = {
      listenEvents: true,
      listenTyping: false,
      autoMarkRead: true,
      updatePresence: true,
      selfListen: false,
      online: true,
    };

    try {
      fcaLogin({ appState: config.APPSTATE }, options, async (err, api) => {
        if (err || !api) {
          error(`[LOGIN] ${(err && err.message) || 'no api returned'}`);
          done(null);
          return;
        }

        // Capture what Facebook really says when a send is rejected. ws3-fca
        // does `throw new Error(resData)`, which stringifies the error object to
        // "[object Object]" — without this tap the reason is unrecoverable.
        fcaDiag.install();

        STATE.loggedIn = true;
        try {
          STATE.userID = api.getCurrentUserID();
        } catch { STATE.userID = null; }
        log(`[LOGIN] ${config.BOT_NAME} logged in as ${STATE.userID || 'unknown'}`);

        // startListening resolves with the emitter once the MQTT connection is
        // up. Failing to listen is not fatal: the HTTP server and commands stay
        // available, so the deploy is not restarted over a flaky socket.
        try {
          const emitter = await api.listenMqtt();
          attachEvents(api, emitter);
          log('[MQTT] Listening');
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
    error('[BOOT] Login failed — retrying in 30s. /health stays up meanwhile.');
    scheduleRetry();
  } else {
    log(`[BOOT] ${config.BOT_NAME} is online with ${registry.size} commands. Try \`${config.PREFIX}ping\``);
  }

  // 6. HOUSEKEEPING
  if (!housekeeping) {
    housekeeping = setInterval(() => {
      cooldown.sweep();
      cache.sweep();
    }, 60 * 1000);
    if (typeof housekeeping.unref === 'function') housekeeping.unref();
  }

  return { registry, aliases, api };
}

// Graceful shutdown for Render.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log(`[SHUTDOWN] ${sig} received`);
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
  attachClient,
  attachEvents,
  reloadCommands,
  findCommand: (name) => loader.findCommand(name, registry, aliases),
  listCommands: (category) => loader.listCommands(category, registry),
  mongo,
  canvas,
  config,
  loader,
  toggles,
  permissions,
  cooldown,
  cache,
  get registry() { return registry; },
  get aliases() { return aliases; },
  get client() { return client; },
  gemini,
  STATE,
};
