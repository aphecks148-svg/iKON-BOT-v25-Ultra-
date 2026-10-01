'use strict';

const mongoose = require('mongoose');

const ItemSchema = new mongoose.Schema(
  {
    itemId: { type: String, required: true },
    qty: { type: Number, default: 1, min: 0 },
  },
  { _id: false },
);

const InventorySchema = new mongoose.Schema(
  {
    uid: { type: String, required: true, unique: true, index: true },
    items: { type: [ItemSchema], default: [] },
  },
  { timestamps: true },
);

module.exports = mongoose.models.Inventory || mongoose.model('Inventory', InventorySchema);
