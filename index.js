'use strict';

/**
 * iKON-BOT v2 — process entry point.
 *
 * Everything lives in ws3-fca.js (the engine); this file only starts it, so
 * Render's `node index.js` and `npm start` both boot the same bot.
 */

const loginOptions = {
  appState: null, // loaded from APPSTATE env var at runtime
  userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  autoMarkDelivery: false,
  autoMarkRead: false,
  selfListen: false,
  listenEvents: true,
  updatePresence: false,
};

const engine = require('./ws3-fca');

engine.setLoginOptions(loginOptions);
engine.start();

module.exports = engine;
