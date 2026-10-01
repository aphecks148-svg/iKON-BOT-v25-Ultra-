'use strict';

const mongoose = require('mongoose');

const GroupSchema = new mongoose.Schema(
  {
    tid: { type: String, required: true, unique: true, index: true },

    isEnabled: { type: Boolean, default: true },
    isApproved: { type: Boolean, default: false },
    pendingApproval: { type: Boolean, default: true },

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
    gameBomb: {
      holderUid: { type: String, default: null },
      holderName: { type: String, default: '' },
      amount: { type: Number, default: 0 },
      passes: { type: Number, default: 0 },
      expires: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

module.exports = mongoose.models.Group || mongoose.model('Group', GroupSchema);
