'use strict';

/**
 * A raid boss — the big thing standing between a hunter and the loot.
 *
 * Bosses are seeded data, not user data: they are the same creature for
 * everybody, and the only thing that changes per hunter is whether they have
 * been defeated and when. So this is a plain document, not a per-user record,
 * and it is read with `.lean()` everywhere it is touched.
 *
 * `power` is the number the board ranks on. It used to be `hp`, which reads
 * like a health bar but is not what anything compared; renaming the field
 * would have required touching every caller, so the field is `power` and the
 * display shows it as such.
 */
const mongoose = require('mongoose');

const bossSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  emoji: { type: String, default: '🐉' },
  level: { type: Number, default: 1, min: 1 },
  power: { type: Number, default: 100, min: 0 },
  location: { type: String, default: '' },
  loot: { type: String, default: '' },
  // How often this boss can be engaged, in ms. A world boss respawns; a
  // raid boss is a one-time thing for the party that kills it.
  respawnMs: { type: Number, default: 0 },
  // The party that felled it, if any. Cleared when a new boss takes the slot.
  defeatedBy: { type: String, default: '' },
  defeatedAt: { type: Date, default: null },
}, { timestamps: true });

bossSchema.index({ power: -1 });
bossSchema.index({ level: -1 });

module.exports = mongoose.model('Boss', bossSchema);