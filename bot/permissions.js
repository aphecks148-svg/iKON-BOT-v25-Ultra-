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

/**
 * Facebook ids that are always owner-level.
 *
 * Read from the environment only (ADMIN_IDS, and the optional singular
 * OWNER_ID). Nothing here is hard-coded, so changing who is an owner is a
 * redeploy of env vars rather than a code change.
 *
 * @param {string|number} senderID
 * @returns {boolean}
 */
function isOwner(senderID) {
  if (!senderID) return false;
  const id = String(senderID);
  if (config.ADMIN_IDS.includes(id)) return true;
  const ownerId = String(config.OWNER_ID || '');
  return Boolean(ownerId) && id === ownerId;
}

/**
 * Owner ids configured in the environment. Used by commands that build an
 * "exempt from this action" set, so bot admins are protected by the same env
 * var that gates the owner-only commands.
 *
 * @returns {string[]}
 */
function ownerIds() {
  const ids = config.ADMIN_IDS.slice();
  const ownerId = String(config.OWNER_ID || '');
  if (ownerId && !ids.includes(ownerId)) ids.push(ownerId);
  return ids;
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

/**
 * Everyone who may not be moderated: the thread's own admins plus the bot
 * admins from ADMIN_IDS/OWNER_ID.
 *
 * This answers "who is protected", NOT "may this sender act". The acting user is
 * deliberately absent: adding the sender here and then testing membership would
 * always pass, which is exactly the tautology that let any member start a war.
 * For the acting-user question use can() / check(), or protectedIdsFor().
 *
 * @param {object} api ws3-fca client
 * @param {string|number} threadID
 * @returns {Promise<Set<string>>} uids that must never be targeted
 */
async function protectedIds(api, threadID) {
  const set = new Set(ownerIds());
  // Thread admins are additive. A failed lookup leaves the bot admins in place,
  // so this degrades to protecting owners rather than to protecting nobody.
  try {
    const info = await api.getThreadInfo(threadID);
    for (const id of (info && info.adminIDs) || []) set.add(String(id));
  } catch { /* keep the env-provided admins */ }
  return set;
}

/**
 * The protected set plus one extra uid. Use this for building a target
 * exemption ("never mute these people"), never for an authorisation decision.
 *
 * @param {object} api ws3-fca client
 * @param {string|number} threadID
 * @param {string|number} extra uid to add, typically the acting user
 * @returns {Promise<Set<string>>}
 */
async function protectedIdsFor(api, threadID, extra) {
  const set = await protectedIds(api, threadID);
  if (extra) set.add(String(extra));
  return set;
}

/**
 * May this sender run the moderator commands in this thread? True for a bot
 * admin from the environment, or an admin of this thread.
 *
 * The single entry point for "is this person an admin here", so a command cannot
 * accidentally re-derive it and get it tautologically true.
 *
 * @param {object} api ws3-fca client
 * @param {object} event needs senderID and threadID
 * @returns {Promise<boolean>}
 */
async function canModerate(api, event) {
  if (isOwner(event && event.senderID)) return true;
  if (isPrivate(event)) return false;
  try {
    const info = await api.getThreadInfo(event.threadID);
    return ((info && info.adminIDs) || []).map(String).includes(String(event.senderID));
  } catch {
    // Never grant on a failed lookup.
    return false;
  }
}

module.exports = {
  check, can, isOwner, isPrivate, ownerIds, protectedIds, protectedIdsFor, canModerate,
};
