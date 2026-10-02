'use strict';

/**
 * One command at a time per person.
 *
 * WHY THIS EXISTS
 *
 * Message handling is fired off, not awaited: two `!heist` messages arriving a
 * second apart both call handleMessage at the same time. The cooldown could not
 * stop that, because the cooldown used to be written *after* the command
 * finished — so both messages passed the gate, both ran, and both paid out from
 * one cooldown. `!work` and `!heist` together were worse than a double payout:
 * both load the same profile, both add to `coins`, and both save, so whichever
 * save landed last silently discarded the other's money.
 *
 * This is the "multiple sessions at once" problem. A command is not a session —
 * it is a read-modify-write on one person's profile, and two of those against
 * one document is a race whoever wins. Serialising per user fixes both: the
 * second message is refused instead of racing.
 *
 * WHY IT IS PER USER AND NOT GLOBAL
 *
 * A global lock would make the bot feel broken — Alice's `!farm` would stall
 * Bob's `!profile`. Every profile is a separate document, so different people
 * can never conflict with each other. Same user, different commands, is the only
 * case that actually races.
 *
 * WHY IT IS NOT A QUEUE
 *
 * A queue would let someone bank twenty commands and then get twenty replies in
 * a burst, minutes later, out of context. Refusing the second attempt is
 * better: the cooldown will let them run it again shortly, and the message they
 * get says why.
 */

/** key -> true while held */
const held = new Map();

/** How long a lock may be held before it is assumed dead. */
const STALE_MS = 60000;

/**
 * Try to take the lock for a key.
 *
 * @param {string} key usually the sender's uid
 * @returns {(() => void)|null} a release function, or null when already held
 */
function acquire(key) {
  const k = String(key);
  const current = held.get(k);
  const now = Date.now();

  // A lock older than STALE_MS belongs to a command that never finished — the
  // process was mid-restart, or an await hung. Treat it as free rather than
  // locking that person out of the bot permanently.
  if (current && now - current.since < STALE_MS) return null;

  // The object that goes INTO the map is the one release() has to compare
  // against later. Comparing against whatever was in the map beforehand means
  // comparing against undefined on a fresh lock, so release() would silently
  // never free anything.
  const mine = { since: now };
  held.set(k, mine);

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    // Only clear if it is still ours; a stale takeover may already own it.
    if (held.get(k) === mine) held.delete(k);
  };
}

/** Release everything. Used by tests and by reload. */
function clear() {
  held.clear();
}

/** Diagnostics: how many locks are held, and for whom. */
function snapshot() {
  const now = Date.now();
  const out = [];
  for (const [key, entry] of held) {
    if (now - entry.since >= STALE_MS) continue;
    out.push({ key, ms: now - entry.since });
  }
  return out;
}

function size() {
  return snapshot().length;
}

module.exports = { acquire, clear, snapshot, size, STALE_MS };