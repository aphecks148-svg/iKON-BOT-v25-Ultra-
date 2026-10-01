'use strict';

const mongoose = require('mongoose');

const PetSchema = new mongoose.Schema(
  {
    ownerUid: { type: String, required: true, index: true },
    name: { type: String, required: true },
    type: { type: String, default: 'dragon' },
    level: { type: Number, default: 1, min: 1 },
    xp: { type: Number, default: 0, min: 0 },
    hunger: { type: Number, default: 100, min: 0, max: 100 },

    // ── module 4: dangerous pets ──────────────────────────────
    // Base power from the species table. Total power is
    // basePower + (level * 10) + (prestige * 50).
    basePower: { type: Number, default: 100, min: 0 },
    isTitanPrime: { type: Boolean, default: false },
    // Cosmetic + evolution metadata.
    emoji: { type: String, default: '' },
    title: { type: String, default: '' },
    // +50 permanent power per rebirth, on top of the level curve.
    prestige: { type: Number, default: 0, min: 0 },
    // +25 permanent power per !petlove.
    bond: { type: Number, default: 0, min: 0 },

    // Temporary combat modifiers.
    blessedUntil: { type: Date, default: null },
    cursedUntil: { type: Date, default: null },

    // Safe mode: while true, nobody can attack this pet. Unsafe pets can be
    // attacked by anyone replying `!petfight` to one of their messages.
    isSafe: { type: Boolean, default: true },
    // Daily safe-rent timer — safe mode is not free.
    lastRentPaid: { type: Date, default: null },
    lastSafeToggle: { type: Date, default: null },

    isDead: { type: Boolean, default: false },
    diedAt: { type: Date, default: null },
    lastExplore: { type: Date, default: null },
    lastFeed: { type: Date, default: null },
    lastBattleAt: { type: Date, default: null },

    // Evolution stone stock, keyed by stone id.
    stones: {
      fire: { type: Number, default: 0 },
      inferno: { type: Number, default: 0 },
      titan: { type: Number, default: 0 },
      void: { type: Number, default: 0 },
      revive: { type: Number, default: 0 },
    },

    stats: {
      battles: { type: Number, default: 0 },
      wins: { type: Number, default: 0 },
      losses: { type: Number, default: 0 },
      kills: { type: Number, default: 0 },
      explores: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

PetSchema.index({ ownerUid: 1, name: 1 });
PetSchema.index({ ownerUid: 1, isDead: 1 });
PetSchema.index({ basePower: -1 });

module.exports = mongoose.models.Pet || mongoose.model('Pet', PetSchema);
