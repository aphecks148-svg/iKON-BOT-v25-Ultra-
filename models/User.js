'use strict';

const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema(
  {
    uid: { type: String, required: true, unique: true, index: true },
    // The Facebook account id. In practice this is `uid` — every
    // sender arrives as a Facebook uid — and it is declared here for
    // a reason that has nothing to do with the schema's own shape.
    //
    // Older builds created a UNIQUE index on `facebookId` that was
    // NOT sparse. A unique index that is not sparse indexes every
    // document missing the field as null, so the SECOND account to
    // join collides with the first and the insert dies with
    // E11000 "dup key: { facebookId: null }". That is exactly the
    // failure a brand-new member produces, and it is why a new
    // user's profile never persisted while everybody already in the
    // database kept working.
    //
    // Keeping the field populated with a distinct value makes that
    // legacy index harmless, and declaring it sparse means a fresh
    // install builds the index correctly in the first place.
    facebookId: { type: String, sparse: true, unique: true },
    name: { type: String, default: 'Unknown' },

    level: { type: Number, default: 1, min: 1 },
    xp: { type: Number, default: 0, min: 0 },

    coins: { type: Number, default: 10000, min: 0 },
    // Wallet seed for a brand new hunter. Kept separate from `coins` on purpose:
    // `coins` is the live balance every command reads and spends, and the two
    // must not be silently aliased — changing one must not retro-edit the other.
    money: { type: Number, default: 500, min: 0 },
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

    // The kingdom this hunter belongs to, by name. '' = independent.
    // A name, not an id, matches how the Kingdom model is keyed and
    // lets a profile show its kingdom without a join.
    kingdom: { type: String, default: '' },

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

    // module 9 — the social half. Everything here is a counter or a score that
    // some meter in the fun module reads back out. Kept in one subdocument so
    // it is obvious which fields the fun commands own.
    spouse: { type: String, default: '' },
    marriedAt: { type: Date, default: null },
    fun: {
      hugs: { type: Number, default: 0, min: 0 },
      slaps: { type: Number, default: 0, min: 0 },
      kisses: { type: Number, default: 0, min: 0 },
      kills: { type: Number, default: 0, min: 0 },
      bonks: { type: Number, default: 0, min: 0 },
      shipped: { type: Number, default: 0, min: 0 },
      roasts: { type: Number, default: 0, min: 0 },
      compliments: { type: Number, default: 0, min: 0 },
      dares: { type: Number, default: 0, min: 0 },
      daresDone: { type: Number, default: 0, min: 0 },
      daresFailed: { type: Number, default: 0, min: 0 },
      flexes: { type: Number, default: 0, min: 0 },
      giftsIn: { type: Number, default: 0, min: 0 },
      giftsOut: { type: Number, default: 0, min: 0 },
    },

    // module 10 — the grind. Four loops that feed each other: farm food heals the
    // pets in module 4, mine drops the stones evolution wants, fish pays coins,
    // hunt drops skins nobody needs. Tools carry durability so none of it is
    // free. The item buckets are Mixed, not Map: the commands index them with
    // plain bracket assignment, which a MongooseMap would silently ignore.
    farm: {
      level: { type: Number, default: 1, min: 1 },
      xp: { type: Number, default: 0, min: 0 },
      plots: { type: Number, default: 3, min: 1, max: 10 },
      // One row per plot: { crop, plantedAt, readyAt, watered }.
      land: { type: [Object], default: [] },
      crops: { type: Object, default: {} },   // cropId -> units in the barn
      seeds: { type: Object, default: {} },   // wheat_seed -> units
      totalHarvest: { type: Number, default: 0, min: 0 },
      prestige: { type: Number, default: 0, min: 0 },  // +10% yield each
      food: { type: Number, default: 0, min: 0 },      // feeds !petheal
      stones: { type: Number, default: 0, min: 0 },    // evolution currency
      stolen: { type: Number, default: 0, min: 0 },
      taxAt: { type: Date, default: null },
      dailyAt: { type: Date, default: null },
    },

    mine: {
      level: { type: Number, default: 1, min: 1 },
      xp: { type: Number, default: 0, min: 0 },
      ores: { type: Object, default: {} },   // oreId -> units in the pack
      pick: { type: Object, default: () => ({ id: '', dur: 0 }) },
    },

    fish: {
      level: { type: Number, default: 1, min: 1 },
      xp: { type: Number, default: 0, min: 0 },
      catch: { type: Object, default: {} },  // fishId -> units in the cooler
      rod: { type: Object, default: () => ({ id: '', dur: 0 }) },
    },

    hunt: {
      level: { type: Number, default: 1, min: 1 },
      xp: { type: Number, default: 0, min: 0 },
      meat: { type: Object, default: {} },
      skins: { type: Object, default: {} },
      kills: { type: Number, default: 0, min: 0 },
      licensed: { type: Boolean, default: false },
      gun: { type: Object, default: () => ({ id: '', dur: 0 }) },
      injuredUntil: { type: Date, default: null },
      rarest: { type: String, default: '' },
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

    // Wild spawns. The bot rolls once a minute and drops a pokemon into every
    // group it is in; the first to run `.catch` banks it here. Kept as a bounded
    // list of plain objects rather than a subdocument per species — nobody is
    // meant to collect all forty-five, and a hunt for one of them is a
    // coincidence, not a checklist.
    pokemon: {
      count: { type: Number, default: 0 },
      best: { type: String, default: '' },
      bestPower: { type: Number, default: 0 },
      caught: { type: [Object], default: [] },
    },

    // moderation
    isBanned: { type: Boolean, default: false },
    banReason: { type: String, default: '' },
    bannedBy: { type: String, default: null },

    // Wild Pokemon caught from group spawns.
    //
    // `dex` is a list of national dex ids, not names: ids are what the roster
    // is keyed on and they never change, so a rename upstream cannot strand
    // somebody holding a name that no longer resolves. `pokemonCaught` counts
    // every catch including repeats, so it can go far past `dex.length` —
    // that difference is the duplicate count, and a starter seeing their dex
    // at 12/151 with 19 caught is not a bug.
    dex: { type: [Number], default: [] },
    pokemonCaught: { type: Number, default: 0, min: 0 },

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
      pvpWins: { type: Number, default: 0, min: 0 },
      pvpLosses: { type: Number, default: 0, min: 0 },
      missions: { type: Number, default: 0, min: 0 },
      busts: { type: Number, default: 0, min: 0 },
    },

    lastSeen: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
