'use strict';

/**
 * Per-user, per-command cooldowns (COOLDOWN stage).
 * In-memory Map — a bot restart clears everything, which is fine.
 */

/** key -> expiry timestamp (ms) */
const buckets = new Map();

const key = (uid, name) => `${uid}::${name}`;

/**
 * Remaining cooldown in seconds.
 * @returns {number} 0 when ready, otherwise whole seconds left (min 1)
 */
function check(uid, name, sec = 5) {
  const k = key(uid, name);
  const expiry = buckets.get(k);
  if (!expiry) return 0;
  const now = Date.now();
  if (now >= expiry) {
    buckets.delete(k);
    return 0;
  }
  return Math.ceil((expiry - now) / 1000);
}

/** Start the cooldown for uid+name. */
function set(uid, name, sec = 5) {
  buckets.set(key(uid, name), Date.now() + Math.max(0, sec) * 1000);
}

/** Clear one bucket, or all buckets for a uid when name is omitted. */
function clear(uid, name) {
  if (name) {
    buckets.delete(key(uid, name));
    return;
  }
  for (const k of [...buckets.keys()]) {
    if (k.startsWith(`${uid}::`)) buckets.delete(k);
  }
}

/** Drop expired buckets so the Map cannot grow forever. */
function sweep() {
  const now = Date.now();
  for (const [k, expiry] of buckets) if (now >= expiry) buckets.delete(k);
}

function size() {
  return buckets.size;
}

module.exports = { check, set, clear, sweep, size };
