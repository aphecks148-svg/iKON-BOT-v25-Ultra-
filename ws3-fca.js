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
const helpers = require('./bot/helpers');
const profile = require('./bot/profile');
const cards = require('./bot/cards');

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
    // event.isGroup, not a threadID guess: a group can arrive with a bare
    // numeric id, and treating it as a DM makes every reply fail with 1545012.
    const res = await reply(api, threadID, text, replyTo ?? messageID, event.isGroup);
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
          body: pokemonSpawn.catchBody(caught.pokemon, caught.userDoc, caught.isNew, caught.reward),
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

  const parsed = router.parse(body, prefix);
  if (!parsed) {
    if (body) log(`[PARSE] no command for "${body.slice(0, 60)}" (prefix ${JSON.stringify(prefix)})`);
    // Not a command. Count the message for the RPG profile and stop.
    await recordActivity(senderID, false, isGroupThread(threadID, event.isGroup) ? threadID : null);
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
    const cd = Number.isFinite(Number(cmd.cooldown)) ? Number(cmd.cooldown) : config.DEFAULT_COOLDOWN;
    const left = cooldown.check(senderID, cmd.name, cd);
    if (left > 0) {
      await say(`⏳ Cooldown: wait ${helpers.fmt.dur(left)}.`);
      return;
    }

    // ── COOLDOWN RESERVED, NOT STARTED ──────────────────────
    // Taken before the command runs, not after. A slow command — heist sends
    // two replies and writes the ledger — spends a second or two in here, and
    // if the bucket were only written at the end the whole execution window
    // would be cooldown-free. That is how one cooldown paid out twice.
    cooldown.set(senderID, cmd.name, cd);

    // ── PROFILE ─────────────────────────────────────────────
    const userDoc = await cache.getUser(senderID, api);

    // cache.getUser returns null when the lookup itself fails, not only when
    // there is no profile: a dropped connection or a failed create lands there
    // too. Every command reads userDoc.coins straight away, so handing them a
    // null means either a stack trace in the chat or, worse, a command that
    // quietly does nothing and looks broken. One honest message beats both.
    if (!userDoc) {
      cooldown.clear(senderID, cmd.name);
      await say('⚠️ I could not load your profile just now. Try again in a moment.');
      return;
    }

    // ── MODERATION ────────────────────────────────────────────
    if (userDoc.isBanned) {
      cooldown.clear(senderID, cmd.name);
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
      cooldown.clear(senderID, cmd.name);
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
 * @param {*} data logMessageData
 * @param {string} [author] event.author, used only when the payload has nobody
 * @returns {{uid:string,name:string}[]}
 */
function changeParticipants(data, author, selfId) {
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

  if (people.length) return notMe(people, selfId);

  const one = String((data && data.leftParticipantFbId) || author || '').trim();
  if (!one) return [];
  return notMe(
    [{ uid: /^\d+$/.test(one) ? one : '', name: /^\d+$/.test(one) ? '' : one }],
    selfId,
  );
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
 * The display name of a chat, for `{group}`.
 *
 * A join/leave event carries only a thread id, and the id used to be what
 * `{group}` was replaced with — so "Welcome {user} to {group}" announced a
 * fifteen-digit number. getThreadInfo is cached per thread because a busy chat
 * fires a join event every few seconds.
 *
 * @param {string} threadID
 * @param {object} api
 * @returns {Promise<string>}
 */
async function chatName(threadID, api) {
  const fallback = String(threadID || '');
  if (!threadID || !api || typeof api.getThreadInfo !== 'function') return fallback;
  try {
    const info = await api.getThreadInfo(String(threadID));
    const name = info && (info.threadTitle || info.name || info.title);
    return name ? String(name) : fallback;
  } catch (err) {
    error(`[GROUP] getThreadInfo(${threadID}) failed: ${err.message}`);
    return fallback;
  }
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
 * Announce one arrival or departure: canvas card first, then the text line.
 *
 * The card is best-effort. Without the native canvas binary `arrivalCard`
 * returns null and only the text goes out — a platform that cannot render must
 * still say the name.
 *
 * @param {object} api
 * @param {string} threadID
 * @param {'welcome'|'goodbye'} kind
 * @param {object} who
 * @param {string} threadName
 * @param {string} template
 * @param {boolean} isGroup
 */
async function announce(api, threadID, kind, who, threadName, template, isGroup) {
  const leaving = kind === 'goodbye';

  // A tag needs the name to already be resolved, so the live lookup happens
  // here rather than inside the template filler.
  const live = who.uid ? await profile.fetchRealName(who.uid, api) : null;
  const name = live
    || (who.name && !profile.isPlaceholderName(who.name) ? who.name : '')
    || (who.uid ? `Hunter ${who.uid.slice(-4)}` : 'Someone');

  // No body at all means the admin has not written one; the card carries the
  // message and an empty text line would just be noise.
  if (template) {
    const mention = who.uid && name && !name.startsWith('Hunter ')
      ? `@${name}`
      : (who.uid ? `@${who.uid}` : name);
    const text = fillPlaceholders(template, { uid: who.uid, name }, { threadName, threadID }, mention);
    if (text.trim()) {
      await reply(api, threadID, text, null, isGroup);
    }
  }

  try {
    const url = await cards.arrivalCard({
      kind,
      uid: who.uid,
      name,
      threadName,
      threadID,
      body: leaving ? `${name} left ${threadName}` : `${name} joined ${threadName}`,
      api,
    });
    if (url) {
      await api.sendMessage(
        { attachment: { type: 'image', data: { url } } },
        threadID,
        null,
        !isGroupThread(threadID, isGroup),
      );
    }
  } catch (err) {
    error(`[GROUP] ${kind} card failed: ${err.message}`);
  }
}

async function handleGroupChange(api, event) {
  const threadID = event.threadID;
  // ws3-fca reports joins/leaves as log:subscribe / log:unsubscribe.
  const action = event.logMessageType;
  const data = event.logMessageData || {};
  const isGroup = event.isGroup;
  // The bot's own uid, used to keep it out of its own welcome/goodbye cards.
  const selfId = String((api && typeof api.getCurrentUserID === 'function' ? api.getCurrentUserID() : null)
    || event.BotID || STATE.userID || '');

  try {
    // New member joined
    if (action === 'log:subscribe') {
      const group = await toggles.getGroup(threadID);
      if (group.settings?.welcome && group.settings.welcomeMsg) {
        const people = changeParticipants(data, event.author, selfId);
        if (people.length) {
          const threadName = await chatName(threadID, api);
          // Facebook can report several people at once — an admin import adds
          // twenty. One card each is correct: a single card naming everybody
          // reads as a list, not a welcome.
          for (const who of people) {
            // eslint-disable-next-line no-await-in-loop
            await announce(api, threadID, 'welcome', who, threadName, group.settings.welcomeMsg, isGroup);
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
        const leaver = String(data.leftParticipantFbId || event.author || '');
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

      if (group?.settings?.goodbye && group.settings.goodbyeMsg) {
        const people = changeParticipants(data, event.author, selfId);
        if (people.length) {
          const threadName = await chatName(threadID, api);
          await announce(api, threadID, 'goodbye', people[0], threadName, group.settings.goodbyeMsg, isGroup);
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

    // "Reacting but never replying" is indistinguishable from "not listening",
    // and the two have completely different fixes. Log what actually arrives,
    // including the fields that decide whether it is handled below.
    log(`[EVENT DEBUG] ${safeInspect({
      type: event.type,
      isSelf: event.isSelf,
      isGroup: event.isGroup,
      threadID: event.threadID,
      messageID: event.messageID,
      senderID: event.senderID,
      body: typeof event.body === 'string' ? event.body.slice(0, 120) : event.body,
      attachments: (event.attachments || []).length,
      logMessageType: event.logMessageType,
    })}`);

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

        // Re-assert the options that decide whether we ever see a message.
        // login() takes them too, but setOptions is the only way to change them
        // AFTER a successful login, and these two are the difference between
        // "bot is deaf" and "bot is talking".
        //   selfListen:false — our own messages must not come back to us.
        //   listenEvents:true — group join/leave events, used by !autoadd.
        // Note: there is no `logLevel` option in this build
        // (core/models/setOptions.js), so it is not passed here.
        if (typeof api.setOptions === 'function') {
          try {
            await api.setOptions({ selfListen: false, listenEvents: true });
          } catch (err) {
            error(`[LOGIN] setOptions failed: ${err.message}`);
          }
        }

        STATE.loggedIn = true;
        try {
          STATE.userID = api.getCurrentUserID();
        } catch { STATE.userID = null; }
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
  // Exported for the tests: the placeholder rules and the payload shapes are
  // the whole bug surface here, and they are much easier to assert on directly
  // than through a mocked Facebook send.
  changeParticipants,
  chatName,
  fillPlaceholders,
  attachClient,
  attachEvents,
  reloadCommands,
  // Exposed so the tests can assert that an event actually reached the
  // handler, rather than only that nothing threw.
  STATE,
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
  ai,
  STATE,
};
