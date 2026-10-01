'use strict';

const mongoose = require('mongoose');

/**
 * Append-only ledger of every coin movement, so the economy is auditable.
 */
const EconomySchema = new mongoose.Schema(
  {
    uid: { type: String, required: true, index: true },
    action: { type: String, required: true }, // e.g. 'work', 'deposit', 'gamble'
    amount: { type: Number, required: true }, // signed: negative = spent
    balanceAfter: { type: Number, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

EconomySchema.index({ uid: 1, createdAt: -1 });

module.exports = mongoose.models.Economy || mongoose.model('Economy', EconomySchema);
