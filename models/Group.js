'use strict';

const mongoose = require('mongoose');

const GroupSchema = new mongoose.Schema(
  {
    tid: { type: String, required: true, unique: true, index: true },

    isEnabled: { type: Boolean, default: true },
    isApproved: { type: Boolean, default: false },
    pendingApproval: { type: Boolean, default: true },

    prefix: { type: String, default: null }, // null = fall back to config.PREFIX

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
