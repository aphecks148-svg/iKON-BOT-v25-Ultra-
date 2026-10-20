'use strict';

const mongoose = require('mongoose');

const GroupSchema = new mongoose.Schema(
  {
    tid: { type: String, required: true, unique: true, index: true },

    isEnabled: { type: Boolean, default: true },

    // Whether an owner has signed off on this chat, and whether a decision is
    // still outstanding. See bot/pending.js for what enforces them.
    //
    // isApproved defaults to true so every chat that already exists keeps
    // working: the alternative is that deploying this locks every established
    // group until someone notices. Only chats added from now on are held, and
    // holding them is done in memory and written here, not decided by these
    // defaults.
    isApproved: { type: Boolean, default: true },
    pendingApproval: { type: Boolean, default: false },

    // The chat's name, captured when the bot was added. `!pending` lists chats
    // by name; without it an owner is reading a column of ids.
    threadName: { type: String, default: '' },

    // Who asked for this chat, when, and what was decided. Kept as a document
    // rather than three loose fields because these are only ever written and
    // read together, and a half-written decision (approved, but not by whom)
    // is worse than none.
    approval: {
      requestedAt: { type: Date, default: null },
      addedBy: { type: String, default: '' },
      addedByName: { type: String, default: '' },
      approvedBy: { type: String, default: '' },
      approvedAt: { type: Date, default: null },
      deniedBy: { type: String, default: '' },
      deniedAt: { type: Date, default: null },
    },

    prefix: { type: String, default: null }, // null = fall back to config.PREFIX

    // Re-invite anyone who leaves this group (command: !autoadd). Honoured by
    // handleGroupChange on log:unsubscribe. Left off by default: it also fires
    // for people removed on purpose, which an admin usually did not mean.
    autoAddLeavers: { type: Boolean, default: false },

    // Only thread admins may run commands here (commands: !onlyadminon /
    // !onlyadminoff). Enforced in the engine gate, which exempts bot owners so
    // the setting can always be lifted again.
    adminsOnly: { type: Boolean, default: false },

    settings: {
      welcome: { type: Boolean, default: false },
      goodbye: { type: Boolean, default: false },
      welcomeMsg: { type: String, default: '' },
      goodbyeMsg: { type: String, default: '' },
    },

    // Wild Pokemon spawns.
    //
    // `current` is the spawn on the table right now. It lives here rather than
    // in memory because the thing that identifies a spawn is the message id of
    // the message that announced it: the bot answers a reply by comparing the
    // reply's parent to that id. A restart loses the id otherwise, and every
    // spawn would silently become uncatchable until the next one rolled.
    //
    // caughtBy is written the instant a catch lands, before the reply is sent.
    // Two people replying within the same second both pass the same checks, so
    // the write is the lock, not the read that precedes it.
  },
  { timestamps: true },
);

module.exports = mongoose.models.Group || mongoose.model('Group', GroupSchema);
