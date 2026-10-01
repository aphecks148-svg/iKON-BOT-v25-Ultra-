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
      healme: { type: Date, default: null },
      quest: { type: Date, default: null },
    },

    reputation: { type: Number, default: 0 },
    prestige: { type: Number, default: 0, min: 0 },

    // module 5 — iKON arcade. Wagered is gross coins bet, not kept.
    games: {
      wins: { type: Number, default: 0 },
      losses: { type: Number, default: 0 },
      wagered: { type: Number, default: 0 },
      bestWin: { type: Number, default: 0 },
      luckyCharm: { type: Number, default: 0, min: 0 }, // +1% per point, forever
      streak: { type: Number, default: 0 },
      lastPlayed: { type: Date, default: null },
      towerFloor: { type: Number, default: 0 },
      towerBest: { type: Number, default: 0 },
      godWins: { type: Number, default: 0 },
    },

    // module 4 — set by !petcurse on this hunter's pet, -10% power until it lapses.
    cursedUntil: { type: Date, default: null },

    // module 5 — daily streak claim marker for !streakgame.
    streakDay: { type: Date, default: null },

    // module 6 — group standing. Feeds !gcstatsultra and drives the warzone tax.
    gc: {
      msgs: { type: Number, default: 0 },
      lastGroup: { type: String, default: '' },
      lastMsgAt: { type: Date, default: null },
      links: { type: Number, default: 0 },   // links posted, the antilink scoreboard
      fines: { type: Number, default: 0 },
      toxicity: { type: Number, default: 0 }, // commands run, our proxy for noise
      ghosted: { type: Number, default: 0 },
      invites: { type: Number, default: 0 },
    },

    // iKON Hunter Academy (module 3).
    rpg: {
      className: { type: String, default: '' },
      skills: { type: [String], default: [] },
      bio: { type: String, default: '' },
      titles: { type: [String], default: [] },
      // itemId -> true for whatever is currently swung/worn in battle.
      equipped: { type: Map, of: Boolean, default: {} },
      // Defence stance from !defend, consumed by the next battle.
      defending: { type: Date, default: null },
      // Energy spent by adventure/quest; +1 every 10 minutes up to the cap.
      stamina: { type: Number, default: 10, min: 0 },
      lastStamina: { type: Date, default: Date.now },
      stats: {
        battles: { type: Number, default: 0 },
        wins: { type: Number, default: 0 },
        losses: { type: Number, default: 0 },
        quests: { type: Number, default: 0 },
        bosses: { type: Number, default: 0 },
        heals: { type: Number, default: 0 },
        duelsWon: { type: Number, default: 0 },
        duelsLost: { type: Number, default: 0 },
        monstersSlain: { type: Number, default: 0 },
      },
    },

    // moderation
    isBanned: { type: Boolean, default: false },
    banReason: { type: String, default: '' },
    bannedBy: { type: String, default: null },

    stats: {
      messages: { type: Number, default: 0 },
      commandsUsed: { type: Number, default: 0 },
    },

    // module 7 — GTA. The coin sink: cars, guns and fuel are the expensive half
    // of the loop, so every money path in this module deducts before it pays.
    gta: {
      started: { type: Boolean, default: false },
      level: { type: Number, default: 1, min: 1 },
      xp: { type: Number, default: 0, min: 0 },
      money: { type: Number, default: 0, min: 0 }, // winnings banked inside GTA
      spent: { type: Number, default: 0, min: 0 },
      // Wanted level 0-5. At 5 the cops hunt, which is the whole point.
      wanted: { type: Number, default: 0, min: 0, max: 5 },
      wantedAt: { type: Date, default: null },
      jailedUntil: { type: Date, default: null },
      // Owned cars: { id, fuel, nitro, color, tuned, crashed }.
      cars: { type: [Object], default: [] },
      // Owned weapons: { id, ammo }.
      weapons: { type: [Object], default: [] },
      activeCar: { type: String, default: '' },
      activeWeapon: { type: String, default: '' },
      // Cartel this player founded or joined.
      cartel: { type: String, default: '' },
      cartelRank: { type: String, default: '' },
      // Daily claim marker for !gtadaily.
      gtadaily: { type: Date, default: null },
      lastTaxi: { type: Date, default: null },
      lastHeist: { type: Date, default: null },
      copsHuntUntil: { type: Date, default: null },
      racesWon: { type: Number, default: 0, min: 0 },
      racesLost: { type: Number, default: 0, min: 0 },
      missions: { type: Number, default: 0, min: 0 },
      busts: { type: Number, default: 0, min: 0 },
    },

    lastSeen: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
