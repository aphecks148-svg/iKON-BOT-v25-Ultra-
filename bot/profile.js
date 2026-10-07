'use strict';

/**
 * Real Facebook identity — display name and profile picture.
 *
 * Two problems this exists to solve.
 *
 * 1. Fake names in the database. ws3-fca's getUserInfo falls back to
 *    createDefaultUser(), which returns the literal string "Facebook User" when
 *    it cannot resolve a profile. bot/cache.js stored whatever came back, so one
 *    unlucky lookup wrote "Facebook User" into Mongo and it stayed there
 *    forever: every leaderboard and profile card showed it. Placeholder names
 *    from the API are detected here and never persisted.
 *
 * 2. No pictures. getUserInfo returns a graph.facebook.com picture URL that
 *    redirects to the real CDN image. Leaderboards and profile cards now load
 *    those bytes and draw them, with a deterministic generated avatar as the
 *    fallback so a card is never blank.
 *
 * Everything here is best effort and never throws: a command must still answer
 * when Facebook is down.
 */

const canvasKit = require('./canvas');
const { log, error } = require('./helpers');

/**
 * Names ws3-fca invents rather than resolves.
 *
 * Its `createDefaultUser` (getUserInfo.js:110) returns `name: "Facebook User"`
 * and `firstName: "Facebook"` for anyone it cannot resolve, so both are in the
 * list. Missing "facebook" meant a build that returned only firstName put
 * "Facebook" into a welcome as though it were a person's name.
 */
const PLACEHOLDER_NAMES = new Set([
  'facebook user', 'facebook', 'messenger user', 'unknown', '', 'null', 'undefined',
]);

const NAME_TTL = 10 * 60 * 1000;
const PIC_TTL = 30 * 60 * 1000;

/** uid -> { name, picUrl, expires } */
const nameCache = new Map();
/** uid -> Buffer */
const picCache = new Map();

/** Picture edge length. 720 is what getUserInfo asks Facebook for. */
const PIC_SIZE = 256;

/**
 * Is this a name the API made up rather than a real one?
 *
 * @param {string} name
 * @returns {boolean}
 */
function isPlaceholderName(name) {
  return PLACEHOLDER_NAMES.has(String(name || '').trim().toLowerCase());
}

/**
 * The real display name for a uid, or null.
 *
 * @param {string|number} uid
 * @param {object} api ws3-fca client
 * @param {{force?:boolean}} [opts] force skips the cache
 * @returns {Promise<string|null>} null when Facebook cannot tell us, or when it
 *   only has a placeholder to offer
 */
async function fetchRealName(uid, api, opts = {}) {
  if (!uid || !api || typeof api.getUserInfo !== 'function') return null;
  const id = String(uid);

  if (!opts.force) {
    const hit = nameCache.get(id);
    if (hit && Date.now() < hit.expires) return hit.name;
  }

  try {
    const info = await api.getUserInfo(id);
    // ws3-fca returns firstName, not first_name. The snake_case key never
    // existed, so that fallback was dead code.
    const name = info && (info.name || info.firstName || info.first_name);
    if (!name || isPlaceholderName(name)) {
      nameCache.set(id, { name: null, expires: Date.now() + NAME_TTL });
      return null;
    }
    const clean = String(name).trim();
    nameCache.set(id, { name: clean, expires: Date.now() + NAME_TTL });
    return clean;
  } catch (err) {
    error(`[PROFILE] getUserInfo(${id}) failed: ${err.message}`);
    nameCache.set(id, { name: null, expires: Date.now() + NAME_TTL });
    return null;
  }
}

/**
 * The picture URL for a uid, or null.
 *
 * `thumbSrc` first: it is the direct CDN url Facebook hands over with a thread's
 * member list — no access token, no redirect to follow — and `getThreadInfo`
 * already carries it. `profilePicUrl` is the graph.facebook.com endpoint this
 * build of ws3-fca builds by hand, and is the fallback for a member who had not
 * shown up in that list yet. Both shapes are accepted because callers hold
 * either one: the thread list gives the first, getUserInfo gives the second.
 *
 * @param {string|number} uid
 * @param {object} api ws3-fca client
 * @returns {Promise<string|null>}
 */
async function fetchPictureUrl(uid, api) {
  if (!uid || !api || typeof api.getUserInfo !== 'function') return null;
  try {
    const c = require('./cache');
    const info = await c.getUserInfoCached(uid, api);
    const url = info && (info.thumbSrc || info.profilePicUrl);
    return url ? String(url) : null;
  } catch {
    return null;
  }
}

/**
 * Download a uid's Facebook picture as PNG/JPEG bytes.
 *
 * Follows the graph.facebook.com redirect to the CDN. Returns null on any
 * failure so callers can draw a generated avatar instead.
 *
 * @param {string|number} uid
 * @param {object} api ws3-fca client
 * @returns {Promise<Buffer|null>}
 */
async function fetchPicture(uid, api) {
  if (!uid) return null;
  const id = String(uid);

  const hit = picCache.get(id);
  if (hit) return hit;

  const url = await fetchPictureUrl(uid, api);
  if (!url) return null;

  try {
    const axios = require('axios');
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
      // Facebook's picture endpoint answers 302 to the CDN, which axios follows
      // in Node. Being explicit documents that the redirect is expected rather
      // than a misconfiguration.
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data || []);
    // Facebook answers a missing picture with a tiny 1x1 or an HTML error page.
    // Caching those would pin a blank avatar for 30 minutes.
    if (buf.length < 512) return null;
    picCache.set(id, buf);
    return buf;
  } catch (err) {
    error(`[PROFILE] picture fetch failed for ${id}: ${err.message}`);
    return null;
  }
}

/**
 * A deterministic avatar for a uid, used when Facebook has no picture.
 *
 * The colour is derived from the id so the same person always gets the same
 * avatar instead of a random one that changes every render.
 *
 * @param {string|number} uid
 * @param {number} [size]
 * @returns {Promise<Buffer|null>} PNG bytes, or null if the canvas binary is missing
 */
async function fallbackAvatar(uid, size = PIC_SIZE) {
  if (!canvasKit.available()) return null;
  try {
    const id = String(uid || '?');
    let hash = 0;
    for (let i = 0; i < id.length; i += 1) {
      hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
    }
    const hue = Math.abs(hash) % 360;

    const cv = canvasKit.create(size, size);
    const ctx = cv.ctx;
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, `hsl(${hue}, 62%, 34%)`);
    grad.addColorStop(1, `hsl(${(hue + 48) % 360}, 62%, 18%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // Initial letter, so the fallback still identifies the person.
    const letter = id.replace(/\D/g, '').slice(-2) || id.slice(0, 1).toUpperCase() || '?';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = `bold ${Math.round(size * 0.34)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(letter).slice(-2), size / 2, size / 2 + 2);

    // create() returns { canvas, ctx }; toBuffer takes the surface itself, which
    // is why every caller in the command modules passes `made.canvas`.
    return canvasKit.toBuffer(cv.canvas);
  } catch (err) {
    error(`[PROFILE] fallbackAvatar failed: ${err.message}`);
    return null;
  }
}

/**
 * Picture bytes for a uid: the real Facebook photo when reachable, otherwise a
 * generated avatar. Returns null only when even the fallback cannot be drawn.
 *
 * @param {string|number} uid
 * @param {object} api ws3-fca client
 * @returns {Promise<Buffer|null>}
 */
async function picture(uid, api) {
  const real = await fetchPicture(uid, api);
  return real || fallbackAvatar(uid);
}

/** Clear the caches. Exposed for tests and !reload. */
function clear() {
  nameCache.clear();
  picCache.clear();
}

module.exports = {
  fetchRealName,
  fetchPicture,
  fetchPictureUrl,
  fallbackAvatar,
  picture,
  isPlaceholderName,
  clear,
  PIC_SIZE,
};
