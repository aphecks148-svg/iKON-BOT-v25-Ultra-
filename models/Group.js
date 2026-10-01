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
