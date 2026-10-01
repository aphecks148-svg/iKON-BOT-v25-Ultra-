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
  },
  { timestamps: true },
);

PetSchema.index({ ownerUid: 1, name: 1 });

module.exports = mongoose.models.Pet || mongoose.model('Pet', PetSchema);
