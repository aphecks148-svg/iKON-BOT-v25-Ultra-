'use strict';

/**
 * iKON-BOT v2 — central configuration.
 * NEVER hard-code credentials here. Everything is read from .env / process.env.
 */

require('dotenv').config();

/** Read a plain env var. */
function env(key, fallback = '') {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

/** Read a boolean env var ("true"/"1"/"yes" => true). */
function envBool(key, fallback = false) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(true|1|yes|on)$/i.test(String(v).trim());
}

/** Read an integer env var. */
function envInt(key, fallback) {
  const v = parseInt(process.env[key], 10);
  return Number.isFinite(v) ? v : fallback;
}

/** ADMIN_IDS is a comma separated list of Facebook numeric user ids. */
function parseAdminIds(raw) {
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * APPSTATE is the ws3-fca cookie array.
 * On Render it is usually a single-line JSON string, which must be parsed once
 * here so every consumer gets a real array.
 */
function parseAppState(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  const trimmed = String(raw).trim();
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.warn('[CONFIG] APPSTATE is not valid JSON — login will fail until it is fixed.');
    return [];
  }
}

/**
 * Resolve the command prefix.
 * `PREFIX` is a standard name on Linux/macOS (it holds an install path), so it is
 * only honoured when it looks like an actual command prefix. BOT_PREFIX wins.
 */
function resolvePrefix() {
  const explicit = env('BOT_PREFIX', '');
  if (explicit) return explicit;

  const raw = env('PREFIX', '');
  if (!raw) return '!';
  // Reject values that are clearly filesystem paths or longer than 4 characters.
  if (raw.length > 4 || /[\\/]|^\s|\s$/.test(raw)) {
    console.warn(`[CONFIG] Ignoring PREFIX="${raw}" (looks like a system path, not a command prefix) — using "!"`);
    return '!';
  }
  return raw;
}

const config = {
  // ── identity ──────────────────────────────────────────────
  BOT_NAME: env('BOT_NAME', 'iKON-BOT'),
  OWNER: env('OWNER', 'Aphecks iKon Klerk'),
  VERSION: env('BOT_VERSION', '2.0.0'),

  // ── facebook / ws3-fca ────────────────────────────────────
  APPSTATE: parseAppState(env('APPSTATE')),
  ADMIN_IDS: parseAdminIds(env('ADMIN_IDS', '')),

  // ── messenger behaviour ───────────────────────────────────
  PREFIX: resolvePrefix(),
  REACTIONS_ENABLED: envBool('REACTIONS_ENABLED', true),
  REACT_EMOJI: env('REACT_EMOJI', '✅'),
  DEFAULT_COOLDOWN: envInt('DEFAULT_COOLDOWN', 5),
  MAINTENANCE_MODE: envBool('MAINTENANCE_MODE', false),

  // ── database ──────────────────────────────────────────────
  MONGO_URI: env('MONGO_URI', 'mongodb://127.0.0.1:27017/ikon-bot'),

  // ── ai ────────────────────────────────────────────────────
  GEMINI_API_KEY: env('GEMINI_API_KEY', ''),
  GEMINI_MODEL: env('GEMINI_MODEL', 'gemini-1.5-flash'),

  // ── server ────────────────────────────────────────────────
  PORT: envInt('PORT', 3000),
  NODE_ENV: env('NODE_ENV', 'development'),

  // ── cache ─────────────────────────────────────────────────
  CACHE_TTL: envInt('CACHE_TTL', 5 * 60 * 1000), // 5 minutes
};

// Helpful startup sanity warnings (never print secret values).
if (!config.APPSTATE.length) console.warn('[CONFIG] APPSTATE missing — bot cannot log into Facebook.');
if (!config.MONGO_URI) console.warn('[CONFIG] MONGO_URI missing — database features disabled.');

module.exports = config;
module.exports._internals = { env, envBool, envInt, parseAdminIds, parseAppState, resolvePrefix };
