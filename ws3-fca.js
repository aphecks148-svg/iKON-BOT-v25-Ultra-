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
const axios = require('axios');

const config = require('./config');
const mongo = require('./bot/mongo');
const router = require('./bot/router');
const loader = require('./bot/loader');
const cooldown = require('./bot/cooldown');
const permissions = require('./bot/permissions');
const toggles = require('./bot/toggles');
const cache = require('./bot/cache');
const canvas = require('./bot/canvas');
const helpers = require('./bot/helpers');

const { log, error, reply, react, safe } = helpers;

const STATE = {
  startedAt: Date.now(),
  loggedIn: false,
  userID: null,
  commandsRun: 0,
  messagesSeen: 0,
  errors: 0,
};

let client = null; // ws3-fca client (set by attachClient)
let registry = new Map();
let aliases = new Map();

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

  app.get('/health', (req, res) => {
    res.status(STATE.loggedIn && mongo.isReady() ? 200 : 503).json({
      ok: STATE.loggedIn && mongo.isReady(),
      loggedIn: STATE.loggedIn,
      db: mongo.status().readyState === 1,
      commands: registry.size,
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
// GEMINI — integration point (future AI commands)
// ─────────────────────────────────────────────────────────────
const gemini = {
  available: () => Boolean(config.GEMINI_API_KEY),
  /**
   * Ask Gemini for a completion. Returns null when unconfigured or on failure.
   * @param {string} prompt
   * @param {{system?:string, maxOutputTokens?:number}} [opts]
   */
  async ask(prompt, opts = {}) {
    if (!gemini.available()) return null;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${config.GEMINI_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`;
    try {
      const res = await axios.post(endpoint, {
        contents: [{ role: 'user', parts: [{ text: String(prompt) }] }],
        systemInstruction: opts.system ? { parts: [{ text: opts.system }] } : undefined,
        generationConfig: { maxOutputTokens: opts.maxOutputTokens || 400, temperature: 0.9 },
      }, { timeout: 20000 });

      const parts = res?.data?.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts) ? parts.map((p) => p.text || '').join('').trim() : '';
      return text || null;
    } catch (err) {
      error(`[GEMINI] request failed: ${err.message}`);
      return null;
    }
  },
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
  const say = async (text, replyTo = messageID) => reply(api, threadID, text, replyTo ?? messageID);
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
 * group standings the module ranks on.
 */
function isGroupThread(threadID) {
  return typeof threadID === 'string' && threadID.startsWith('t_');
}

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
  const action = event.type;

  try {
    // New member joined
    if (action === 'event_thread_member_join' || action === 'event_thread_join') {
      await toggles.getGroup(threadID);
      const group = await toggles.getGroup(threadID);
      if (group.settings?.welcome && group.settings.welcomeMsg) {
        const who = event.added || event.actorID;
        const text = String(group.settings.welcomeMsg)
          .replace(/{user}/g, String(who))
          .replace(/{group}/g, String(threadID));
        await reply(api, threadID, text, null);
      }
      if (config.REACTIONS_ENABLED && event.messageID) react(api, event.messageID, '👋');
    }

    // Member left
    if (action === 'event_thread_member_leave' || action === 'event_thread_leave') {
      const group = await toggles.getGroup(threadID);
      if (group?.settings?.goodbye && group.settings.goodbyeMsg) {
        const who = event.removed || event.actorID;
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

  api.on('message', (event) => {
    // Ignore our own messages and non-text events.
    if (!event || !event.threadID) return;
    if (event.isSelf === true) return;
    if (typeof event.body !== 'string' || !event.body) return;

    safe(() => handleMessage(api, event), api, event.threadID, event.messageID, 'message');
  });

  // Group joins/leaves
  const groupEvents = [
    'event_thread_member_join',
    'event_thread_member_leave',
    'event_thread_join',
    'event_thread_leave',
  ];
  for (const evt of groupEvents) {
    api.on(evt, (event) => {
      if (!event || !event.threadID) return;
      safe(() => handleGroupChange(api, event), api, event.threadID, null, evt);
    });
  }

  // Bot disconnected
  api.on('disconnect', () => {
    STATE.loggedIn = false;
    error('[LOGIN] Disconnected from Facebook');
  });

  api.on('error', (err) => {
    error(`[FCA] ${(err && err.message) || err}`);
  });
}

async function login() {
  if (!config.APPSTATE.length) {
    error('[LOGIN] APPSTATE is empty — set it in .env before starting.');
    return null;
  }

  // ws3-fca ships both CJS and ESM builds; prefer the classic build.
  let fca;
  try {
    // eslint-disable-next-line global-require
    fca = require('ws3-fca');
  } catch (err) {
    error(`[LOGIN] ws3-fca not installed: ${err.message}`);
    return null;
  }

  const client_ = new fca({
    appState: config.APPSTATE,
    logLevel: config.NODE_ENV === 'production' ? 'error' : 'warn',
    listen: false, // MQTT is wired separately so listeners attach cleanly
  });

  client_.on('qr', (qr) => {
    if (qr) log('[LOGIN] QR code received — scan it to link the account if the appstate expired.');
  });

  return new Promise((resolve) => {
    const failTimer = setTimeout(() => {
      error('[LOGIN] Timed out after 2 minutes — check APPSTATE.');
      resolve(null);
    }, 120000);

    client_.on('ready', async () => {
      clearTimeout(failTimer);
      STATE.loggedIn = true;
      try {
        STATE.userID = await client_.getOwnUserId();
      } catch { STATE.userID = null; }
      log(`[LOGIN] ${config.BOT_NAME} logged in as ${STATE.userID || 'unknown'}`);

      attachClient(client_);
      startMqtt(client_);

      // Persist a fresh appstate so restarts stay linked.
      try {
        client_.on('apstate', (state) => {
          // Never log cookies — only acknowledge.
          if (Array.isArray(state) && state.length) log('[LOGIN] Appstate refreshed.');
        });
      } catch { /* optional */ }

      clearTimeout(failTimer);
      resolve(client_);
    });

    client_.on('error', (err) => {
      clearTimeout(failTimer);
      error(`[LOGIN] ${(err && err.message) || err}`);
      resolve(null);
    });

    try {
      client_.login({ appState: config.APPSTATE, listen: false })
        .then(() => {
          try { client_.listenMqtt(true); } catch { /* ready handler covers it */ }
        })
        .catch((err) => {
          clearTimeout(failTimer);
          error(`[LOGIN] Failed: ${err.message}`);
          resolve(null);
        });
    } catch (err) {
      clearTimeout(failTimer);
      error(`[LOGIN] Threw: ${err.message}`);
      resolve(null);
    }
  });
}

/** Start MQTT with a backoff guard so a flaky network cannot spin the CPU. */
function startMqtt(api) {
  let attempts = 0;
  const start = () => {
    try {
      api.listenMqtt(true);
      attempts += 1;
      log(`[MQTT] Listening (attempt ${attempts})`);
    } catch (err) {
      attempts += 1;
      error(`[MQTT] failed to start: ${err.message}`);
      if (attempts < 5) setTimeout(start, 5000 * attempts);
    }
  };
  start();
}

// ─────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────
async function boot() {
  log(`=================================================`);
  log(` ${config.BOT_NAME} v${config.VERSION}`);
  log(` Owner: ${config.OWNER}`);
  log(` Node ${process.version} — env ${config.NODE_ENV}`);
  log(`=================================================`);

  // 1. SERVER
  startServer();

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
    error('[BOOT] Login failed — check APPSTATE. Express server stays up for /health.');
  } else {
    log(`[BOOT] ${config.BOT_NAME} is online with ${registry.size} commands. Try \`${config.PREFIX}ping\``);
  }

  // 6. HOUSEKEEPING
  const housekeeping = setInterval(() => {
    cooldown.sweep();
    cache.sweep();
  }, 60 * 1000);
  if (typeof housekeeping.unref === 'function') housekeeping.unref();

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

if (require.main === module) {
  boot().catch((err) => {
    error(`[BOOT] Fatal: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

module.exports = {
  boot,
  login,
  startServer,
  handleMessage,
  handleGroupChange,
  attachClient,
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
