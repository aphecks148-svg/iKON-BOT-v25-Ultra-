'use strict';

const mongoose = require('mongoose');

const GroupSchema = new mongoose.Schema(
  {
    tid: { type: String, required: true, unique: true, index: true },

    isEnabled: { type: Boolean, default: true },

    // Whether an owner has signed off on this chat, and whether a decision is
    // still outstanding. See bot/pending.js for what enforces them.
    //
    // isApproved defaults to true so every chat that already exists keeps
    // working: the alternative is that deploying this locks every established
    // group until someone notices. Only chats added from now on are held, and
    // holding them is done in memory and written here, not decided by these
    // defaults.
    isApproved: { type: Boolean, default: true },
    pendingApproval: { type: Boolean, default: false },

    // The chat's name, captured when the bot was added. `!pending` lists chats
    // by name; without it an owner is reading a column of ids.
    threadName: { type: String, default: '' },

    // Who asked for this chat, when, and what was decided. Kept as a document
    // rather than three loose fields because these are only ever written and
    // read together, and a half-written decision (approved, but not by whom)
    // is worse than none.
    approval: {
      requestedAt: { type: Date, default: null },
      addedBy: { type: String, default: '' },
      addedByName: { type: String, default: '' },
      approvedBy: { type: String, default: '' },
      approvedAt: { type: Date, default: null },
      deniedBy: { type: String, default: '' },
      deniedAt: { type: Date, default: null },
    },

    prefix: { type: String, default: null }, // null = fall back to config.PREFIX

    // Re-invite anyone who leaves this group (command: !autoadd). Honoured by
    // handleGroupChange on log:unsubscribe. Left off by default: it also fires
    // for people removed on purpose, which an admin usually did not mean.
    autoAddLeavers: { type: Boolean, default: false },

    // Only thread admins may run commands here (commands: !onlyadminon /
    // !onlyadminoff). Enforced in the engine gate, which exempts bot owners so
    // the setting can always be lifted again.
    adminsOnly: { type: Boolean, default: false },

    settings: {
      welcome: { type: Boolean, default: false },
      goodbye: { type: Boolean, default: false },
      welcomeMsg: { type: String, default: '' },
      goodbyeMsg: { type: String, default: '' },
    },

    // Wild Pokemon spawns.
    //
    // `current` is the spawn on the table right now. It lives here rather than
    // in memory because the thing that identifies a spawn is the message id of
    // the message that announced it: the bot answers a reply by comparing the
    // reply's parent to that id. A restart loses the id otherwise, and every
    // spawn would silently become uncatchable until the next one rolled.
    //
    // caughtBy is written the instant a catch lands, before the reply is sent.
    // Two people replying within the same second both pass the same checks, so
    // the write is the lock, not the read that precedes it.
    pokemon: {
      // ON by default. This was false, which combined with a spawner that only
      // queried opted-in groups to mean a wild Pokemon never appeared in any
      // group nobody had hand-configured. An admin turns it off with
      // `!pokemon off`.
      enabled: { type: Boolean, default: true },
      intervalMs: { type: Number, default: 15 * 60 * 1000 },
      lastSpawnAt: { type: Date, default: null },
      // A spawn that was tried and failed — sprite 404, send timeout. Counted
      // alongside lastSpawnAt when deciding whether a group is due, so a dead
      // network backs off to the next interval instead of retrying every tick.
      lastAttemptAt: { type: Date, default: null },
      current: {
        id: { type: Number, default: 0 },
        messageID: { type: String, default: '' },
        spawnedAt: { type: Date, default: null },
        expiresAt: { type: Date, default: null },
        caughtBy: { type: String, default: '' },
      },
    },

    disabledCommands: { type: [String], default: [] },
    disabledModules: { type: [String], default: [] },
    maintenance: { type: Boolean, default: false },

    // module 4 — per-chat pet arena record
    // module 9 — GC-wide social state. Ships and boards live on the group so
    // they survive a restart, unlike the in-memory party games.
    fun: {
      // { a, b, score, by } — a is always the lexicographically smaller uid so
      // shipping A+B and B+A is one ship, not two.
      ships: { type: [Object], default: [] },
      // { a, b, score, by } — same ordering rule as ships.
      besties: { type: [Object], default: [] },
      // { a, b, score, by } — enemies, same ordering rule.
      enemies: { type: [Object], default: [] },
      hugs: { type: Number, default: 0, min: 0 },
      slaps: { type: Number, default: 0, min: 0 },
      kills: { type: Number, default: 0, min: 0 },
    },

    petArena: {
      battles: { type: Number, default: 0 },
      wins: { type: Number, default: 0 },
      steals: { type: Number, default: 0 },
    },

    // module 6 — group administration. Every moderator tool the chat needs.
    gc: {
      // Announced policy text, shown by !gcpolicy.
      policy: { type: String, default: '' },
      // Flood control. Defaults here mirror bot/flood.js DEFAULTS and match the
      // shipped behaviour, so a document written before this block existed still
      // rate-limits at the same numbers instead of silently going unprotected.
      flood: {
        on: { type: Boolean, default: true },
        duplicateSec: { type: Number, default: 12 },
        maxPerUser: { type: Number, default: 8 },
        userWindowSec: { type: Number, default: 10 },
        maxPerThread: { type: Number, default: 50 },
        threadWindowSec: { type: Number, default: 10 },
        muteSec: { type: Number, default: 20 },
        maxMuteSec: { type: Number, default: 600 },
      },
      // Link scrubbing: on/off plus the flat fine applied to each offender.
      antiLink: { on: { type: Boolean, default: false }, fine: { type: Number, default: 500 } },
      // Raid lock: lock when `burst` joins land inside `windowMs`.
      antiRaid: {
        on: { type: Boolean, default: false },
        burst: { type: Number, default: 5 },
        windowMs: { type: Number, default: 10000 },
      },
      // Warzone: tax every message from members above `floor` coins.
      warzone: {
        on: { type: Boolean, default: false },
        tax: { type: Number, default: 50 },
        floor: { type: Number, default: 1000 },
      },
      // Emoji-only mode. `emoji` is the single character allowed through.
      lockdown: { on: { type: Boolean, default: false }, emoji: { type: String, default: '✅' } },
      // Bot-applied chat punishments. Each entry expires on its own.
      ghostBans: {
        type: [{
          uid: { type: String, default: '' },
          name: { type: String, default: '' },
          by: { type: String, default: '' },
          expires: { type: Date, default: null },
        }],
        default: [],
      },
      bans: {
        type: [{
          uid: { type: String, default: '' },
          name: { type: String, default: '' },
          reason: { type: String, default: '' },
          by: { type: String, default: '' },
          expires: { type: Date, default: null },
        }],
        default: [],
      },
      mutes: {
        type: [{ uid: { type: String, default: '' }, name: { type: String, default: '' }, expires: { type: Date, default: null } }],
        default: [],
      },
      // Chat level: derived from lifetime message count, cached so the command
      // does not have to recount history on every call.
      msgs: { type: Number, default: 0 },
      level: { type: Number, default: 1 },
      // Invite war: who pulled how many people in, inside the current window.
      invites: {
        windowStart: { type: Date, default: null },
        entries: { type: [{ uid: { type: String, default: '' }, name: { type: String, default: '' }, count: { type: Number, default: 0 } }], default: [] },
        winner: { type: String, default: '' },
        winnerName: { type: String, default: '' },
      },
      // Set when the chat reaches level 50 and the bot claims the room.
      dominated: { type: Boolean, default: false },
      dominatedAt: { type: Date, default: null },
      // Anonymous confession board.
      confessions: { type: [{ uid: { type: String, default: '' }, text: { type: String, default: '' }, at: { type: Date, default: null } }], default: [] },
      // Last truth-or-dare draw, so the result survives across messages.
      tod: { question: { type: String, default: '' }, dare: { type: String, default: '' }, at: { type: Date, default: null } },
    },

    // module 7 — cartel. A per-chat vault the members tax missions into.
    cartel: {
      name: { type: String, default: '' },
      founder: { type: String, default: '' },
      vault: { type: Number, default: 0, min: 0 },
      members: { type: [{ uid: { type: String, default: '' }, name: { type: String, default: '' }, joined: { type: Date, default: null } }], default: [] },
      // The five minute cartel war: who shot the most wins the vault.
      warEnds: { type: Date, default: null },
      warScores: { type: [{ uid: { type: String, default: '' }, name: { type: String, default: '' }, score: { type: Number, default: 0 } }], default: [] },
      warWinner: { type: String, default: '' },
      warWinnerName: { type: String, default: '' },
    },

    // module 5 — the hot potato. Exactly one bomb per chat at a time.
    //
    // `fuse` is how many passes are left before it blows. It is
    // stored, not merely shown, because the countdown is the whole
    // game: a bot cannot promise a background timer will survive a
    // restart, so the fuse ticks down on each !passbomb and the bomb
    // is resolved the moment it reaches zero.
    //
    // `litBy` funds the refund when a bomb goes off before it was
    // ever passed. `passedFrom` is the last passer, who wins the pot
    // when it blows up in the next pair of hands.
    gameBomb: {
      holderUid: { type: String, default: null },
      holderName: { type: String, default: '' },
      amount: { type: Number, default: 0 },
      passes: { type: Number, default: 0 },
      fuse: { type: Number, default: 0 },
      litBy: { type: String, default: '' },
      litByName: { type: String, default: '' },
      passedFrom: { type: String, default: '' },
      passedFromName: { type: String, default: '' },
      expires: { type: Date, default: null },
    },

    // module 2 — the chat lottery. One draw at a time,
    // settled lazily: a bot cannot promise a timer will
    // survive a restart, so the draw is resolved the next
    // time anybody buys a ticket or asks for the board,
    // rather than left to a clock nobody is guaranteed to
    // still be running.
    lottery: {
      pot: { type: Number, default: 0, min: 0 },
      tickets: {
        type: [{
          uid: { type: String, default: '' },
          name: { type: String, default: '' },
          count: { type: Number, default: 0, min: 0 },
        }],
        default: [],
      },
      endsAt: { type: Date, default: null },
      lastDrawAt: { type: Date, default: null },
      lastWinner: { uid: { type: String, default: '' }, name: { type: String, default: '' }, amount: { type: Number, default: 0 } },
    },
  },
  { timestamps: true },
);

module.exports = mongoose.models.Group || mongoose.model('Group', GroupSchema);
