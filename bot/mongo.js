'use strict';

/**
 * MongoDB connection manager.
 * Single connection, retried, never throws the bot down.
 */

const mongoose = require('mongoose');
const config = require('../config');

mongoose.set('strictQuery', false);

let state = {
  connected: false,
  connecting: false,
  error: null,
  uri: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Connect to MongoDB.
 * @param {string} [uri] override MONGO_URI
 * @param {object} [opts] mongoose connect options
 * @returns {Promise<boolean>} true when ready
 */
async function connect(uri = config.MONGO_URI, opts = {}) {
  if (state.connected) return true;
  if (state.connecting) return false;

  if (!uri) {
    state.error = 'MONGO_URI not configured';
    console.error('[DATABASE] MONGO_URI is empty — skipping connection.');
    return false;
  }

  state.connecting = true;
  state.uri = uri;
  state.error = null;

  const options = {
    serverSelectionTimeoutMS: 6000,
    maxPoolSize: 10,
    ...opts,
  };

  mongoose.connection.on('error', (err) => {
    state.error = err.message;
    console.error('[DATABASE] Error:', err.message);
  });
  mongoose.connection.on('disconnected', () => {
    state.connected = false;
    console.warn('[DATABASE] Disconnected');
  });
  mongoose.connection.on('reconnected', () => {
    state.connected = true;
    console.log('[DATABASE] Reconnected');
  });

  try {
    await mongoose.connect(uri, options);
    state.connected = true;
    state.connecting = false;
    console.log('[DATABASE] Connected');
    return true;
  } catch (err) {
    state.error = err.message;
    state.connecting = false;
    console.error(`[DATABASE] Connection failed: ${err.message}`);
    return false;
  }
}

/** Close the connection cleanly (Render shutdown). */
async function disconnect() {
  if (!state.connected && !state.connecting) return;
  try {
    await mongoose.disconnect();
  } catch { /* already gone */ }
  state.connected = false;
  state.connecting = false;
  console.log('[DATABASE] Closed');
}

/** Keep-alive loop: retry until the database is reachable. */
async function connectWithRetry(attempts = 5, delayMs = 5000) {
  for (let i = 1; i <= attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await connect();
    if (ok) return true;
    console.warn(`[DATABASE] Attempt ${i}/${attempts} failed, retrying in ${delayMs}ms…`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(delayMs);
  }
  console.error('[DATABASE] Giving up after repeated failures.');
  return false;
}

const isReady = () => state.connected && mongoose.connection.readyState === 1;
const status = () => ({ ...state, readyState: mongoose.connection.readyState });

module.exports = {
  mongoose,
  connect,
  connectWithRetry,
  disconnect,
  isReady,
  status,
};
