'use strict';

/**
 * Pending choices — the "which one did you mean?" list.
 *
 * Two songs have the same title. Different artists, different words, and the
 * person typing `!lyrics hello` cannot say which of them they meant from the
 * title alone. So the command answers with a numbered list and remembers it,
 * and the person answers with a number.
 *
 * The alternative — guessing — is worse than a wrong answer, because the wrong
 * answer looks like the right one. Sending the wrong song's words for the right
 * song's title is the kind of mistake nobody notices.
 *
 * In memory, like the cooldowns: a restart clears the list, and a person whose
 * choice was cleared just asks again. That is a fair trade for not writing a
 * file for something that lives for ten minutes.
 */

/** How long a list waits to be answered. */
const TTL_MS = 10 * 60 * 1000;

/** uid -> { kind, label, candidates, createdAt } */
const buckets = new Map();

/**
 * Remember a list for one person.
 *
 * @param {string|number} uid who is choosing
 * @param {string} kind what they are choosing between — 'lyrics', 'sing', …
 * @param {Array} candidates the choices, in the order they were shown
 * @param {string} [label] what the list is about, for the reply
 * @returns {object} the stored record
 */
function set(uid, kind, candidates, label = '') {
  const record = {
    kind: String(kind || ''),
    label: String(label || ''),
    candidates: Array.isArray(candidates) ? candidates : [],
    createdAt: Date.now(),
  };
  buckets.set(String(uid), record);
  return record;
}

/**
 * The list waiting for this person, or null.
 *
 * An expired list is dropped rather than returned: ten minutes later the
 * answer is a guess anyway.
 *
 * @param {string|number} uid
 * @returns {object|null}
 */
function get(uid) {
  const key = String(uid);
  const record = buckets.get(key);
  if (!record) return null;
  if (Date.now() - record.createdAt > TTL_MS) {
    buckets.delete(key);
    return null;
  }
  return record;
}

/**
 * Take the list and forget it, so the same number cannot be used twice.
 *
 * @param {string|number} uid
 * @returns {object|null}
 */
function take(uid) {
  const record = get(uid);
  if (record) buckets.delete(String(uid));
  return record;
}

/**
 * Throw the list away — for when the person changes their mind.
 *
 * @param {string|number} uid
 * @returns {boolean} whether there was anything to throw away
 */
function clear(uid) {
  return buckets.delete(String(uid));
}

/** How many lists are waiting. */
function size() {
  return buckets.size;
}

/** Drop the expired ones so the map cannot grow forever. */
function sweep() {
  const now = Date.now();
  for (const [key, record] of buckets) {
    if (now - record.createdAt > TTL_MS) buckets.delete(key);
  }
}

module.exports = {
  TTL_MS, set, get, take, clear, size, sweep,
};
