'use strict';

const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema(
  {
    uid: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: 'Unknown' },

    level: { type: Number, default: 1, min: 1 },
    xp: { type: Number, default: 0, min: 0 },

    coins: { type: Number, default: 10000, min: 0 },
    bank: { type: Number, default: 0, min: 0 },

    // Claim timers for the boosted payouts (module 2). Dates, so a bot restart
    // never hands out a free second daily.
    timers: {
      daily: { type: Date, default: null },
      hourly: { type: Date, default: null },
      weekly: { type: Date, default: null },
      monthly: { type: Date, default: null },
    },

    reputation: { type: Number, default: 0 },
    prestige: { type: Number, default: 0, min: 0 },

    // moderation
    isBanned: { type: Boolean, default: false },
    banReason: { type: String, default: '' },
    bannedBy: { type: String, default: null },

    stats: {
      messages: { type: Number, default: 0 },
      commandsUsed: { type: Number, default: 0 },
    },

    lastSeen: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
