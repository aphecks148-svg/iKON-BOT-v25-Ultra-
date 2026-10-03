'use strict';

/**
 * Per-group toggles: maintenance mode, disabled commands, disabled modules.
 * Every write upserts the Group document.
 */

const Group = require('../models/Group');
const mongo = require('./mongo');
const config = require('../config');

/**
 * A throwaway Group doc for when the database is unreachable.
 * Writes land in memory only, so admin commands still respond instantly.
 */
function transientGroup(tid) {
  const doc = {
    tid: String(tid),
    isEnabled: true,
    // Every chat the bot is in is a chat it serves. There is no approved list:
    // a group used to sit here refusing every command until an owner noticed it
    // existed, which does not scale past the first two groups.
    isApproved: true,
    pendingApproval: false,
    prefix: null,
    autoAddLeavers: false,
    adminsOnly: false,
    settings: { welcome: false, goodbye: false, welcomeMsg: '', goodbyeMsg: '' },
    disabledCommands: [],
    disabledModules: [],
    maintenance: false,
    transient: true,
    async save() { return doc; },
  };
  return doc;
}

/** Get (or create) the group document for a thread. */
async function getGroup(tid) {
  if (!tid) return null;
  const tidStr = String(tid);
  if (!mongo.isReady()) return transientGroup(tidStr);
  let group = await Group.findOne({ tid: tidStr });
  if (!group) {
    group = await Group.create({
      tid: tidStr,
      isEnabled: true,
      // Approved on creation, because reaching this point means the chat is
      // already established. A brand new chat is held before it ever gets
      // here, in handleBotArrival — this path is for chats the bot was already
      // serving when a document went missing.
      isApproved: true,
      pendingApproval: false,
    });
  }
  // A group found still flagged pending is left exactly as it is found.
  //
  // This used to migrate it to approved on first touch, which is the same
  // "being in the group is the whole test" rule the old approval system ran on:
  // a chat nobody had approved was unlocked by the first message that arrived,
  // so the lock was only ever a delay rather than a decision. The flag now
  // means what it says, and bot/pending.js decides.
  return group;
}

/** Find a group without creating one (fast path for every message). */
function findGroup(tid) {
  if (!tid) return Promise.resolve(null);
  // No database: skip the lookup instead of hanging on a buffer timeout.
  if (!mongo.isReady()) return Promise.resolve(null);
  return Group.findOne({ tid: String(tid) }).lean().catch(() => null);
}

/**
 * The per-group switch rules, against a document that is already in hand.
 *
 * Split out of isCommandDisabled because the scheduler asks the same question
 * about work it does itself. `!pokemon off` is honoured by the command, but a
 * wild Pokemon posted by the background tick is not a command: it used to walk
 * straight past a paused chat, a maintenance switch and a disabled module,
 * which is how an admin turned a feature off and kept getting pictures anyway.
 * One set of rules, two callers.
 *
 * Pure — no database, no config — so a caller that already has the document
 * does not pay for a second lookup.
 *
 * @param {object|null} group a Group document, lean object, or null
 * @param {string} cmdName the command being gated
 * @param {string} category its category, which doubles as a module key
 * @returns {{allowed:boolean, reason:string, adminsOnly:boolean, adminBypass:boolean}}
 */
function evaluateGroup(group, cmdName, category) {
  // Reported rather than enforced here: only the engine knows the sender, and
  // this module has no api to resolve thread admins with.
  const adminsOnly = group.adminsOnly === true;
  const bypass = { allowed: false, adminsOnly, adminBypass: true };

  if (group.isEnabled === false) {
    // Paused holds for everybody, admin included: the whole point of pausing a
    // chat is that the bot says nothing in it.
    return {
      allowed: false, reason: 'This group is paused.', adminsOnly, adminBypass: false,
    };
  }

  if (group.maintenance) {
    return {
      allowed: false, reason: 'This group is under maintenance.', adminsOnly, adminBypass: false,
    };
  }

  const moduleKey = String(cmdName || '').split('_')[0];
  if (group.disabledModules?.length) {
    if (group.disabledModules.includes(moduleKey)) {
      return {
        ...bypass, reason: `Module ${moduleKey} is disabled here.`,
      };
    }
    // A command may also declare its module by category.
    if (group.disabledModules.includes(category)) {
      return {
        ...bypass, reason: `Category ${category} is disabled here.`,
      };
    }
  }

  if (cmdName && group.disabledCommands?.includes(cmdName)) {
    return {
      ...bypass, reason: `Command ${cmdName} is disabled here.`,
    };
  }

  return {
    allowed: true, reason: '', adminsOnly, adminBypass: true,
  };
}

/**
 * Decide whether a command may run in a thread.
 * Checks, in order: bot-wide maintenance, then the group rules above.
 *
 * Fails OPEN when the database is unreachable so a DB outage never takes the
 * whole bot down — maintenance is enforced from config.MAINTENANCE_MODE, which
 * needs no database at all.
 *
 * There is no approval check here, and that is not an oversight — bot/pending.js
 * runs before this one and answers it, in memory, for every event. It does not
 * belong here because it fails CLOSED, which is the opposite of the rule below:
 * a chat that is locked and whose command cannot be resolved still has to be
 * refused, and by the time a command has been resolved this gate is already
 * past the point where "we could not tell" means "allow".
 *
 * @returns {Promise<{allowed:boolean, reason:string, adminsOnly:boolean, adminBypass:boolean}>}
 *   `adminBypass` says whether an admin of the thread may run the command anyway.
 *   It is true for the per-command and per-module switches — the things an admin
 *   sets — and false for maintenance, which is a deliberate shutdown that has to
 *   hold for everybody, including the owner who turned it on.
 */
async function isCommandDisabled(tid, cmdName, category) {
  if (config.MAINTENANCE_MODE) {
    return {
      allowed: false, reason: 'Bot is under maintenance. Back shortly.', adminsOnly: false, adminBypass: false,
    };
  }

  const group = await findGroup(tid);
  if (!group) return {
    allowed: true, reason: '', adminsOnly: false, adminBypass: true,
  };

  return evaluateGroup(group, cmdName, category);
}

/** Turn maintenance mode on/off for a group. */
async function setMaintenance(tid, on) {
  const group = await getGroup(tid);
  group.maintenance = Boolean(on);
  await group.save();
  return group;
}

/** Disable (true) or re-enable (false) a single command in a group. */
async function toggleCommand(tid, cmdName, disable) {
  const group = await getGroup(tid);
  const name = String(cmdName).toLowerCase();
  const list = new Set(group.disabledCommands || []);
  if (disable) list.add(name);
  else list.delete(name);
  group.disabledCommands = [...list];
  await group.save();
  return group;
}

/** Disable (true) or re-enable (false) a whole module/category in a group. */
async function toggleModule(tid, mod, disable) {
  const group = await getGroup(tid);
  const name = String(mod);
  const list = new Set(group.disabledModules || []);
  if (disable) list.add(name);
  else list.delete(name);
  group.disabledModules = [...list];
  await group.save();
  return group;
}

/** Approve a group and turn it on. */
async function approve(tid, on = true) {
  const group = await getGroup(tid);
  group.isApproved = Boolean(on);
  group.pendingApproval = !on;
  group.isEnabled = on;
  await group.save();
  return group;
}

/** Enable / disable the bot entirely inside a group. */
async function setEnabled(tid, on) {
  const group = await getGroup(tid);
  group.isEnabled = Boolean(on);
  await group.save();
  return group;
}

module.exports = {
  getGroup,
  findGroup,
  evaluateGroup,
  isCommandDisabled,
  setMaintenance,
  toggleCommand,
  toggleModule,
  approve,
  setEnabled,
};
