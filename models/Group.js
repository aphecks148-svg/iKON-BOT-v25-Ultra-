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
  },
  { timestamps: true },
);

module.exports = mongoose.models.Group || mongoose.model('Group', GroupSchema);
