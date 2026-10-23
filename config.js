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
 *
 * Three shapes arrive here, and all three are handled:
 *   1. A plain JSON array string — the normal case on Render, where the env
 *      var is one long line of `[{...},{...}]`.
 *   2. A JSON string that itself contains a JSON string — some operators paste
 *      the value through another layer of quoting, so `process.env.APPSTATE`
 *      is `"[\"[{...}]\"]"`. Parsed once it is a string, parsed again.
 *   3. A base64-encoded JSON array — operators who copied the value out of a
 *      tool that base64-encodes it. Starts with `ey` (the base64 of `{"`).
 *
 * Never read from appstate.json when the env var exists: the env wins. A stale
 * file next to a fresh env var is how a bot keeps logging in with yesterday's
 * cookies after the operator refreshed them.
 *
 * @param {string} raw
 * @returns {object[]}
 */
function parseAppState(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;

  const trimmed = String(raw).trim();
  if (!trimmed) return [];

  // Base64 first, because a base64 blob is not valid JSON and would throw
  // immediately — so the check is a cheap prefix test, not a parse attempt.
  if (/^ey[A-Za-z0-9+/=]+$/.test(trimmed)) {
    try {
      const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
      return parseAppState(decoded);
    } catch {
      // fall through to the JSON path below
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    console.warn('[CONFIG] APPSTATE is not valid JSON — login will fail until it is fixed.', err.message);
    return [];
  }

  // A string inside a string: unwrap and parse again.
  if (typeof parsed === 'string') {
    return parseAppState(parsed);
  }

  return Array.isArray(parsed) ? parsed : [];
}

/**
 * What a usable appState has to contain, named so the boot log can say
 * something specific instead of "APPSTATE missing".
 *
 * ws3-fca reads `c_user` for the account id and `xs` for the session token;
 * without either it fails with "Error retrieving userID", which is the same
 * error Facebook gives for a blocked login. Distinguishing the two at boot is
 * the whole point of this check.
 *
 * @param {object[]} state
 * @returns {{ok:boolean, hasCUser:boolean, hasXs:boolean, count:number}}
 */
function appstateHealth(state) {
  const arr = Array.isArray(state) ? state : [];
  const names = arr.map((c) => (c && (c.name || c.key)) || '');
  return {
    ok: arr.length > 0,
    hasCUser: names.includes('c_user'),
    hasXs: names.includes('xs'),
    hasFr: names.includes('fr'),
    hasDatr: names.includes('datr'),
    hasSb: names.includes('sb'),
    hasPixelRatio: names.includes('m_pixel_ratio'),
    count: arr.length,
  };
}

/**
 * When the appstate's cookies stop working.
 *
 * Facebook cookies carry an `expiry` field (seconds since the epoch). A cookie
 * whose expiry is in the past is dead, and ws3-fca will not send it — so a
 * session that is 90% alive can still fail with "Error retrieving userID" if
 * the one cookie it needs has expired. This reports the soonest expiry so the
 * boot log can say "refresh in 2 days" instead of leaving the operator to
 * discover it at hour 12 of a week-long run.
 *
 * Cookies without an expiry field are session cookies and are treated as
 * expiring with the browser — i.e. they are not the thing that dies first.
 *
 * @param {object[]} state
 * @returns {{ soonest: number|null, soonestName: string|null, expired: number, total: number }}
 */
function appstateExpiry(state) {
  const arr = Array.isArray(state) ? state : [];
  let soonest = null;
  let soonestName = null;
  let expired = 0;
  const now = Math.floor(Date.now() / 1000);
  for (const c of arr) {
    if (!c || typeof c !== 'object') continue;
    const exp = Number(c.expiry || c.expires);
    if (!Number.isFinite(exp)) continue; // session cookie, no fixed expiry
    if (exp <= now) {
      expired += 1;
      if (soonest === null || exp < soonest) { soonest = exp; soonestName = c.name || c.key || null; }
      continue;
    }
    if (soonest === null || exp < soonest) { soonest = exp; soonestName = c.name || c.key || null; }
  }
  return { soonest, soonestName, expired, total: arr.length };
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
  // Singular form of the same thing. bot/permissions.js compared senders against
  // this key, but it was never defined here, so the comparison was against
  // `String(undefined)` === "undefined" and never matched. Optional: ADMIN_IDS
  // alone is enough to grant owner.
  OWNER_ID: env('OWNER_ID', '').trim(),

  // ── messenger behaviour ───────────────────────────────────
  PREFIX: resolvePrefix(),
  REACTIONS_ENABLED: envBool('REACTIONS_ENABLED', true),
  REACT_EMOJI: env('REACT_EMOJI', '✅'),
  DEFAULT_COOLDOWN: envInt('DEFAULT_COOLDOWN', 5),
  MAINTENANCE_MODE: envBool('MAINTENANCE_MODE', false),

  // ── database ──────────────────────────────────────────────
  MONGO_URI: env('MONGO_URI', 'mongodb://127.0.0.1:27017/ikon-bot'),

  // ── ai ────────────────────────────────────────────────────
  // Groq is the only AI provider. Keys are `gsk_...`; the client does not
  // validate the prefix, so a future key format is the API's business rather
  // than a regex's. A leftover Google key fails loudly here instead of
  // half-working against the old endpoint.
  GROQ_API_KEY: env('GROQ_API_KEY', ''),
  // Empty means "use bot/groq.js's own ladder", which starts at
  // openai/gpt-oss-120b. Left blank on purpose so one model being retired
  // does not require touching this file — see FALLBACK_MODELS in bot/groq.js.
  GROQ_MODEL: env('GROQ_MODEL', ''),

  // ── server ────────────────────────────────────────────────
  PORT: envInt('PORT', 3000),
  NODE_ENV: env('NODE_ENV', 'development'),

  // ── cache ─────────────────────────────────────────────────
  CACHE_TTL: envInt('CACHE_TTL', 5 * 60 * 1000), // 5 minutes
};

// Helpful startup sanity warnings (never print secret values).
const _state = appstateHealth(config.APPSTATE);
const _exp = appstateExpiry(config.APPSTATE);
if (!config.APPSTATE.length) {
  console.warn('[CONFIG] APPSTATE missing — bot cannot log into Facebook.');
} else if (!_state.hasCUser || !_state.hasXs) {
  const missing = [
    !_state.hasCUser && 'c_user',
    !_state.hasXs && 'xs',
    !_state.hasFr && 'fr',
    !_state.hasDatr && 'datr',
    !_state.hasSb && 'sb',
    !_state.hasPixelRatio && 'm_pixel_ratio',
  ].filter(Boolean).join(', ');
  console.warn(
    `[CONFIG] APPSTATE loaded ${_state.count} cookie(s) but is missing ${missing} — `
    + 'the session is expired. Refresh the cookie jar with 2FA cookies and redeploy.',
  );
} else {
  console.log(`[LOGIN] Loaded ${_state.count} cookies from ENV (c_user + xs present)`);
}

// Cookie expiry. A week-long run on a session whose only timed cookie dies
// at hour 12 is how a bot "goes offline" with no warning, so say when the
// first one is due rather than letting the operator find out at 03:00.
if (_state.ok && _exp.total) {
  if (_exp.expired) {
    console.warn(
      `[CONFIG] ${_exp.expired} of ${_exp.total} cookies have already expired — `
      + 'the session is dying. Refresh the appstate and redeploy.',
    );
  } else if (_exp.soonest) {
    const ms = (_exp.soonest * 1000) - Date.now();
    const hours = Math.max(0, Math.round(ms / 3600000));
    const days = Math.floor(hours / 24);
    const label = days > 0 ? `${days}d ${hours % 24}h` : `${hours}h`;
    if (hours < 24) {
      console.warn(
        `[CONFIG] Nearest cookie (\`${_exp.soonestName}\`) expires in ${label} — `
        + 'refresh the appstate before then or the bot stops replying.',
      );
    } else {
      console.log(`[CONFIG] Nearest cookie (\`${_exp.soonestName}\`) expires in ${label}.`);
    }
  }
}
if (!config.MONGO_URI) console.warn('[CONFIG] MONGO_URI missing — database features disabled.');
// Every owner-only command is refused without an admin id, and the bot gives no
// hint that the operator forgot it, so say so once at boot rather than letting
// an operator wonder why !ban and !eval never answer. Computed here rather than
// via permissions.ownerIds() because that module requires this one.
if (!config.ADMIN_IDS.length && !config.OWNER_ID) {
  console.warn('[CONFIG] ADMIN_IDS (and OWNER_ID) are empty — every owner-only command will refuse everyone.');
}

module.exports = config;
module.exports._internals = { env, envBool, envInt, parseAdminIds, parseAppState, appstateHealth, appstateExpiry, resolvePrefix };
