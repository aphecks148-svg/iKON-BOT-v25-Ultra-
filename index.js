'use strict';

/**
 * iKON-BOT v2 — process entry point.
 *
 * Everything lives in ws3-fca.js (the engine); this file only starts it, so
 * Render's `node index.js` and `npm start` both boot the same bot.
 *
 * This file used to hold the whole bot and did `new (require('ws3-fca'))(...)`.
 * ws3-fca@3 exports a single `login` function and is not a constructor, so that
 * threw "fca is not a constructor" and the process crash-looped on every boot.
 * The engine now calls `login(credentials, options, callback)` correctly — see
 * ws3-fca.js `login()`.
 */

const engine = require('./ws3-fca');

engine.start();

module.exports = engine;
