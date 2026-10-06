'use strict';

const mongoose = require('mongoose');

/**
 * A kingdom — a persistent crew with a treasury, a leader and a
 * standing that can be wagered in a war.
 *
 * The leader is also a row in `members`, ranked 'monarch', so the
 * roster is one list and the crown is a rank rather than a separate
 * pointer that can drift out of sync. `leaderUid` is denormalised on
 * top of that for the same reason Pet.ownerName is: a kingdom row
 * reads its leader without a second query, and a rename upstream
 * cannot strand a kingdom showing a stale name.
 *
 * A hunter's membership is tracked on the User document (`kingdom`
 * holds the kingdom name), not only here, so "which kingdom am I in"
 * is one field on the profile the command already has in hand.
 */
const KingdomSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, index: true },
    // A short tag the members put before their name, and the banner.
    tag: { type: String, default: '' },
    emoji: { type: String, default: '🏰' },

    leaderUid: { type: String, required: true, index: true },
    leaderName: { type: String, default: '' },

    // The roster. `donated` is the lifetime total that decides
    // who is a knight; rank is derived from it, never stored,
    // so the two can never disagree.
    members: [{
      uid: { type: String },
      name: { type: String, default: '' },
      donated: { type: Number, default: 0, min: 0 },
      joinedAt: { type: Date, default: Date.now },
    }],

    treasury: { type: Number, default: 0, min: 0 },
    // Level is derived from xp, never stored apart from it: one number
    // to advance means one number that can disagree with the other.
    xp: { type: Number, default: 0, min: 0 },

    // A closed kingdom takes nobody new. The leader toggles it.
    open: { type: Boolean, default: true },
    // Last war declared, so a kingdom cannot be at war every minute.
    lastWarAt: { type: Date, default: null },

    stats: {
      warsWon: { type: Number, default: 0, min: 0 },
      warsLost: { type: Number, default: 0, min: 0 },
      donations: { type: Number, default: 0, min: 0 },
    },
  },
  { timestamps: true },
);

KingdomSchema.index({ treasury: -1 });
KingdomSchema.index({ xp: -1 });

module.exports = mongoose.models.Kingdom || mongoose.model('Kingdom', KingdomSchema);
