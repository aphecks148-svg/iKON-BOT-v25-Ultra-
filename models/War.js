'use strict';

/**
 * A war between two kingdoms.
 *
 * A war is a wager, not a fight: each side puts coins into a pot and the
 * winner takes it. The pot is only ever what the two sides put in — no war
 * mints money, and a kingdom cannot go negative to fight one.
 *
 * Wars are short-lived by design (one hour cooldown per kingdom), so the
 * document is small and read with `.lean()` everywhere.
 */
const mongoose = require('mongoose');

const warSchema = new mongoose.Schema({
  kingdom: { type: String, required: true, trim: true },
  opponent: { type: String, required: true, trim: true },
  stake: { type: Number, default: 0, min: 0 },
  winner: { type: String, default: '' },
  pot: { type: Number, default: 0, min: 0 },
  startedAt: { type: Date, default: Date.now },
  resolvedAt: { type: Date, default: null },
  note: { type: String, default: '' },
}, { timestamps: true });

warSchema.index({ kingdom: 1, opponent: 1 });
warSchema.index({ resolvedAt: 1 });

module.exports = mongoose.model('War', warSchema);