'use strict';

/**
 * Permission resolver — the single choke point for command authorisation.
 *
 * Levels:
 *   all         anyone
 *   owner/botAdmin  id listed in config.ADMIN_IDS
 *   groupAdmin  owner/botAdmin, or an admin of the current thread
 */

const config = require('../config');

/** Facebook ids that are always owner-level. */
function isOwner(senderID) {
  if (!senderID) return false;
  const id = String(senderID);
  return config.ADMIN_IDS.includes(id) || id === String(config.OWNER_ID || '');
}

/** True when the sender is in a private chat (no thread admins apply). */
function isPrivate(event) {
  return !event || (event.isGroup === false) || !event.threadID;
}

/**
 * Resolve the sender's permission level.
 * @returns {Promise<'all'|'owner'|'groupAdmin'|false>} allowed level, or false when denied
 */
async function check(event, api, level = 'all') {
  const wanted = String(level || 'all').toLowerCase();

  if (wanted === 'all' || wanted === 'everyone' || wanted === '') return 'all';

  const senderID = String(event?.senderID || '');
  if (!senderID) return false;

  // Bot admin / owner — bypasses everything below.
  if (isOwner(senderID)) return 'owner';

  if (wanted === 'owner' || wanted === 'botadmin' || wanted === 'admin') return false;

  if (wanted === 'groupadmin' || wanted === 'group_owner') {
    if (isPrivate(event)) return false;
    try {
      const info = await api.getThreadInfo(event.threadID);
      const admins = (info && info.adminIDs) || [];
      if (admins.map(String).includes(senderID)) return 'groupAdmin';
    } catch (err) {
      // Fall through to denied — never grant on a failed lookup.
      return false;
    }
    return false;
  }

  return false;
}

/** Convenience wrapper used by ws3-fca.js: true = allowed. */
async function can(event, api, level) {
  const res = await check(event, api, level);
  return res !== false;
}

module.exports = { check, can, isOwner, isPrivate };
