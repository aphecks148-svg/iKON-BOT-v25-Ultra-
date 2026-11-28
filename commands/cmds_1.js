'use strict';

/**
 * MODULE 1 — SYSTEM CORE (47 commands)
 *
 * Exports a plain array. No factories, no legacy loader.
 *
 * Shape required for every command:
 * { name, aliases, category, description, usage, cooldown, permission, execute }
 *
 * execute receives: { api, event, args, config, registry, ai, reply, react, userDoc }
 * `reply` and `react` are already bound to the current thread, so a command
 * never calls api.sendMessage directly.
 *
 * Every handler is async and internally wrapped in try/catch so a failure is
 * reported to the user instead of escaping into the engine.
 */

const User = require('../models/User');
const Group = require('../models/Group');
const toggles = require('../bot/toggles');
const mongo = require('../bot/mongo');
const canvas = require('../bot/canvas');
const loader = require('../bot/loader');
const { fmt, describeSendError, lastSent, error, reply: helpersReply, savage } = require('../bot/helpers');
const permissions = require('../bot/permissions');
const moderation = require('../bot/moderation');
// The same real-name resolution the cards use, so a text list and a card cannot
// disagree about who somebody is.
const cards = require('../bot/cards');
const userTarget = require('../bot/target');
const cache = require('../bot/cache');
const decks = require('../bot/categories');
const menu = require('../bot/helpmenu');
const compliance = require('../bot/compliance');
const realProfile = require('../bot/profile');

const BOT_ICON = '🤖';
const OWNER_ICON = '👑';

/** Seconds -> "1d 2h 3m" */
const dur = (sec) => fmt.dur(sec);

/** Run a handler with a user-facing safety net. */
async function guard(reply, messageID, label, fn) {
  try {
    await fn();
  } catch (err) {
    await reply(`⚠️ \`${label}\` failed: ${err.message}`, messageID);
  }
}

/** Resolve the effective prefix for a thread. */
async function currentPrefix(threadID, config) {
  const group = await toggles.findGroup(threadID);
  return (group && group.prefix) || config.PREFIX;
}

module.exports = [
  // ─────────────────────────────────────────────────────────
  // 1$
  // ─────────────────────────────────────────────────────────
  

  // ─────────────────────────────────────────────────────────
  // 2$
  // ─────────────────────────────────────────────────────────
  {
    name: 'help',
    aliases: ['h', 'menu', 'cmdlist', 'commands'],
    category: 'system',
    description: '📚 Browse every deck, or read one command in detail',
    usage: '!help [deck] [page] | !help <command>',
    hint: 'Start here. `!help <deck>` opens one category, `!help <command>` opens one command. Everything else is guesswork.',
    cooldown: 3,
    permission: 'all',
    execute: async ({ args, registry, reply, react, event, config }) => guard(reply, event.messageID, 'help', async () => {
      const prefix = config.PREFIX;
      const all = [...registry.values()];
      const byCategory = decks.group(all);
      const want = String(args[0] || '').trim().toLowerCase();

      // ── a deck, by its actual name ────────────────────────
      // Only the deck's own key or label counts here. `economy` is both a deck
      // and a command, and the index advertises `!help economy` as the deck, so
      // that spelling has to open the deck — the collision is called out on the
      // page itself, leaving the command one `!help cmd economy` away.
      const cat = decks.findExact(want);
      if (cat) {
        await react(cat.emoji);
        const pages = menu.paginate(byCategory.get(cat.key) || [], prefix);
        const page = Math.min(Math.max(1, Number.parseInt(args[1], 10) || 1), pages.length);
        await reply(
          menu.categoryPage({
            cat,
            // The commands for THIS page. Passing the whole deck here is what
            // made `!help pets` a 3,200-character wall while its own footer
            // claimed "Page 1 of 2".
            commands: pages[page - 1],
            prefix,
            page,
            pages: pages.length,
            collidesWith: registry.has(cat.key),
          }),
          event.messageID,
        );
        return;
      }

      // ── one command, by its exact name ────────────────────
      // Checked before the loose category words on purpose. `kick` is listed in
      // Group's lookfor words, so letting those win made `!help kick` open all
      // 34 commands in the deck instead of the one command being asked about.
      if (want) {
        const name = String((want === 'cmd' ? args[1] : args[0]) || '').toLowerCase();
        const resolved = lookup(registry, name);
        if (resolved) {
          await react(menu.iconFor(resolved));
          await reply(menu.commandPage({ cmd: resolved, prefix }), event.messageID);
          return;
        }

        // Not a command. It may still be a deck someone knows by its subject
        // rather than its name — "street" for Street Life, "hunt" for a deck.
        const loose = decks.find(want);
        if (loose) {
          await react(loose.emoji);
          const list = byCategory.get(loose.key) || [];
          const pages = menu.paginate(list, prefix);
          // A deck found by subject paginates exactly like one found by
          // name. Without this, `!help settings 2` kept serving page 1 —
          // "settings" is a System Core lookfor word, not the deck's
          // label, so the exact-match branch above never saw it.
          const page = Math.min(Math.max(1, Number.parseInt(args[1], 10) || 1), pages.length);
          await reply(
            menu.categoryPage({
              cat: loose,
              commands: pages[page - 1],
              prefix,
              page,
              pages: pages.length,
              collidesWith: registry.has(loose.key),
            }),
            event.messageID,
          );
          return;
        }

        await react('🔍');
        await reply(menu.noSuchThing({ query: name, prefix }), event.messageID);
        return;
      }

      // ── the front page ────────────────────────────────────
      await react('📚');
      const aliases = all.reduce((n, c) => n + (c.aliases || []).length, 0);
      await reply(
        menu.indexPage({ byCategory, total: all.length, prefix, botName: config.BOT_NAME, aliases }),
        event.messageID,
      );
    }),
  },

  {
    name: 'hints',
    aliases: ['tips', 'hint'],
    category: 'system',
    description: '💡 Shortcuts and habits that make the whole bot easier to use',
    usage: '!hints',
    hint: 'Every tip here is a habit, not a command — the commands are in `!help`.',
    cooldown: 10,
    permission: 'all',
    execute: async ({ config, reply, react, event }) => guard(reply, event.messageID, 'hints', async () => {
      await react('💡');
      await reply(menu.hintsPage({ prefix: config.PREFIX }), event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 3$
  // ─────────────────────────────────────────────────────────
  {
    name: 'botinfo',
    aliases: ['info', 'about'],
    category: 'system',
    description: '🤖 Show bot name, owner, uptime and command count',
    usage: '!botinfo',
    hint: 'Uptime, version, database state and the live send counters. It is mostly uptime — the rest is decor.',
    cooldown: 5,
    permission: 'all',
    execute: async ({ config, registry, reply, react, event }) => guard(reply, event.messageID, 'botinfo', async () => {
      await react(BOT_ICON);
      await reply(
        `${BOT_ICON} ${config.BOT_NAME}\n`
        + '· · · · · · ·\n'
        + `${OWNER_ICON} Owner: ${config.OWNER}\n`
        + `🏷 Version: v${config.VERSION}\n`
        + `⏱ Uptime: ${dur(process.uptime())}\n`
        + `⚙️ Commands: ${registry.size}\n`
        + `🔗 Aliases: ${registryAliasesCount(registry)}\n`
        + `🌐 Environment: ${config.NODE_ENV}\n`
        + `💾 Database: ${mongo.isReady() ? 'connected' : 'offline'}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 4$
  // ─────────────────────────────────────────────────────────
  {
    name: 'uptime',
    aliases: [],
    category: 'system',
    description: '⏱ How long the bot has been running',
    usage: '!uptime',
    hint: 'How long the process has been up. A restart resets it, and with it every in-memory cooldown.',
    cooldown: 3,
    permission: 'all',
    execute: async ({ reply, event }) => guard(reply, event.messageID, 'uptime', async () => {
      const s = process.uptime();
      await reply(
        `⏱ Uptime: ${dur(s)}\n`
        + `Seconds: ${Math.floor(s)} | Minutes: ${Math.floor(s / 60)}\n`
        + `Started: ${new Date(Date.now() - s * 1000).toUTCString()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 5$
  // ─────────────────────────────────────────────────────────
  {
    name: 'dbstats',
    aliases: [],
    category: 'system',
    description: '📊 Total users and groups stored in the database',
    usage: '!dbstats',
    hint: 'Counts, not sizes. A count that stops growing is the first sign the database is not being written to.',
    cooldown: 5,
    permission: 'all',
    execute: async ({ reply, react, event }) => guard(reply, event.messageID, 'dbstats', async () => {
      if (!mongo.isReady()) {
        await reply('📖 The city grid is down right now — no stats right now.', event.messageID);
        return;
      }
      await react('📊');
      const [users, groups, approved, pending] = await Promise.all([
        User.estimatedDocumentCount(),
        Group.estimatedDocumentCount(),
        Group.countDocuments({ isApproved: true }),
        Group.countDocuments({ pendingApproval: true }),
      ]);
      await reply(
        `📊 ${'BOT'} database stats\n`
        + '· · · · · · ·\n'
        + `👤 Users: ${users}\n`
        + `👥 Groups: ${groups}\n`
        + `✅ Approved groups: ${approved}\n`
        + `⏳ Pending approval: ${pending}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 6$
  // ─────────────────────────────────────────────────────────
  {
    name: 'id',
    aliases: [],
    category: 'system',
    description: '🆔 Show your Facebook ID and this thread ID',
    usage: '!id',
    hint: 'Your Facebook id and this chat\'s id. Moderation commands accept either.',
    cooldown: 5,
    permission: 'all',
    execute: async ({ event, reply }) => guard(reply, event.messageID, 'id', async () => {
      await reply(
        '🆔 IDs\n'
        + '· · · · · · ·\n'
        + `👤 Your ID: ${event.senderID}\n`
        + `💬 Thread ID: ${event.threadID}\n`
        + `📨 Message ID: ${event.messageID}\n`
        + `👥 Group chat: ${event.isGroup ? 'yes' : 'no'}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 7$
  // ─────────────────────────────────────────────────────────
  

  // ─────────────────────────────────────────────────────────
  // 8$
  // ─────────────────────────────────────────────────────────
  {
    name: 'threadinfo',
    // Not aliased to `groupinfo`: cmds_6 owns a command by that name, and the
    // loader resolves a real command before any alias, so the alias could never
    // fire. It looked reachable and was not.
    aliases: ['threaddetails'],
    category: 'system',
    description: '👥 Show this group name, member count and admin list',
    usage: '!threadinfo',
    hint: 'This chat\'s id, name and admin list. Moderation commands take an id, so this is where you get one.',
    cooldown: 5,
    permission: 'all',
    execute: async ({ api, event, reply, react }) => guard(reply, event.messageID, 'threadinfo', async () => {
      if (!event.isGroup) {
        await reply('💬 This is a private chat — no group info available.', event.messageID);
        return;
      }
      await react('👥');

      let info = null;
      try {
        info = await api.getThreadInfo(event.threadID);
      } catch (err) {
        await reply(`⚠️ Could not read this group just now. Try again in a moment.`, event.messageID);
        return;
      }

      const members = Array.isArray(info.participantIDs) ? info.participantIDs : [];
      const admins = Array.isArray(info.adminIDs) ? info.adminIDs : [];
      const group = await toggles.findGroup(event.threadID);

      await reply(
        `👥 Group info\n`
        + '· · · · · · ·\n'
        + `Name: ${info.threadTitle || info.name || 'Unknown'}\n`
        + `Members: ${members.length}\n`
        + `Admins: ${admins.length}\n`
        + `Thread ID: ${event.threadID}\n`
        + `🔧 Bot enabled: ${group ? (group.isEnabled ? 'yes' : 'no') : 'auto'}\n`
        + `🛠 Maintenance: ${group ? (group.maintenance ? 'yes' : 'no') : 'no'}`,
        event.messageID,
      );
    }),
  },
// ─────────────────────────────────────────────────────────
  // 10$
  // ─────────────────────────────────────────────────────────
  {
    name: 'prefix',
    aliases: [],
    category: 'system',
    description: '⚙️ Show the command prefix used in this chat',
    usage: '!prefix',
    hint: 'The prefix this chat uses. It is set per group, so two chats can use two different ones.',
    cooldown: 5,
    permission: 'all',
    execute: async ({ event, config, reply }) => guard(reply, event.messageID, 'prefix', async () => {
      const group = await toggles.findGroup(event.threadID);
      const active = (group && group.prefix) || config.PREFIX;
      const isCustom = Boolean(group && group.prefix);
      await reply(
        `🔧 Prefix: \`${active}\`\n`
        + `Source: ${isCustom ? 'this group (custom)' : `bot default (${config.PREFIX})`}\n`
        + `Try: ${active}help`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 11$
  // ─────────────────────────────────────────────────────────
  {
    name: 'setprefix',
    aliases: ['setp'],
    category: 'system',
    description: '⚙️ Set a custom command prefix for this group',
    usage: '!setprefix ?',
    hint: 'One character, and it changes this group only — every command here has to be typed with it, `!help` included.',
    cooldown: 10,
    permission: 'groupAdmin',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'setprefix', async () => {
      if (!event.isGroup) {
        await reply('❌ This command only works in a group.', event.messageID);
        return;
      }
      const raw = args.join('');
      if (!raw) {
        await reply('❌ Usage: `!setprefix ?` — one to four characters.', event.messageID);
        return;
      }
      if (raw.length > 4 || /\s/.test(raw)) {
        await reply('❌ The prefix must be 1–4 characters with no spaces.', event.messageID);
        return;
      }
      if (raw === '/') {
        await reply('❌ `/` conflicts with Facebook shortcuts. Pick another.', event.messageID);
        return;
      }
      const group = await toggles.getGroup(event.threadID);
      group.prefix = raw;
      await group.save();
      await react('✅');
      await reply(`✅ Prefix for this group is now \`${raw}\`\nTry: ${raw}help`, event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 12$
  // ─────────────────────────────────────────────────────────
  {
    name: 'maintenance',
    aliases: ['maint'],
    category: 'system',
    description: '🔧 Turn maintenance mode on or off for this group',
    usage: '!maintenance on|off',
    hint: 'Owner only, and it is per group. While it is on, ordinary commands answer with a notice instead of working.',
    cooldown: 5,
    permission: 'owner',
    execute: async ({ args, event, config, reply, react }) => guard(reply, event.messageID, 'maintenance', async () => {
      const mode = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(mode)) {
        const group = await toggles.findGroup(event.threadID);
        await reply(
          `🛠 Maintenance in this group: ${group && group.maintenance ? 'ON' : 'OFF'}\n`
          + `Bot-wide maintenance: ${config.MAINTENANCE_MODE ? 'ON' : 'OFF'}\n`
          + 'Usage: `!maintenance on` or `!maintenance off`',
          event.messageID,
        );
        return;
      }
      await toggles.setMaintenance(event.threadID, mode === 'on');
      await react(mode === 'on' ? '🔧' : '✅');
      await reply(
        mode === 'on'
          ? '🛠 Maintenance mode ON — commands are paused in this group.'
          : '✅ Maintenance mode OFF — commands are running again.',
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 13$
  // ─────────────────────────────────────────────────────────
  {
    name: 'enablecmd',
    aliases: ['enablec'],
    category: 'system',
    description: '✅ Re-enable a command that was disabled in this group',
    usage: '!enablecmd <command>',
    hint: 'Puts one command back after `!disablecmd`. The name is the command itself, not the alias.',
    cooldown: 5,
    permission: 'groupAdmin',
    execute: async ({ args, event, registry, reply, react }) => guard(reply, event.messageID, 'enablecmd', async () => {
      if (!event.isGroup) {
        await reply('❌ This command only works in a group.', event.messageID);
        return;
      }
      const name = (args[0] || '').toLowerCase();
      if (!name) {
        await reply('❌ Usage: `!enablecmd ping`', event.messageID);
        return;
      }
      const cmd = registry.get(name);
      if (!cmd) {
        await reply(`❌ \`${name}\` is not a known command.`, event.messageID);
        return;
      }
      await toggles.toggleCommand(event.threadID, cmd.name, false);
      await react('✅');
      await reply(`✅ \`${cmd.name}\` is enabled in this group.`, event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 14$
  // ─────────────────────────────────────────────────────────
  {
    name: 'disablecmd',
    aliases: ['disablec'],
    category: 'system',
    description: '❌ Disable a command in this group',
    usage: '!disablecmd <command>',
    hint: 'One command, this group only. `!disablemod` is the wider hammer.',
    cooldown: 5,
    permission: 'groupAdmin',
    execute: async ({ args, event, registry, reply, react }) => guard(reply, event.messageID, 'disablecmd', async () => {
      if (!event.isGroup) {
        await reply('❌ This command only works in a group.', event.messageID);
        return;
      }
      const name = (args[0] || '').toLowerCase();
      if (!name) {
        await reply('❌ Usage: `!disablecmd ping`', event.messageID);
        return;
      }
      const cmd = registry.get(name);
      if (!cmd) {
        await reply(`❌ \`${name}\` is not a known command.`, event.messageID);
        return;
      }
      // Refused rather than disabled: these are already gated to the bot owner,
      // so no member of this group could run them in the first place. Switching
      // them off here does nothing except make the group look like it has
      // quietly removed a feature it never had.
      if (cmd.permission === 'owner') {
        await reply(
          `❌ \`${cmd.name}\` is owner-only — no member of this group can run it, so there is nothing to disable here.`,
          event.messageID,
        );
        return;
      }
      await toggles.toggleCommand(event.threadID, cmd.name, true);
      await react('🔇');
      await reply(
        `🔇 \`${cmd.name}\` is disabled in this group.\n`
        + escapeHatchNote(cmd.name, '!enablecmd')
        + `Admins can still run it.`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 15$
  // ─────────────────────────────────────────────────────────
  {
    name: 'enablemod',
    aliases: ['enablem'],
    category: 'system',
    description: '✅ Re-enable a whole module in this group',
    usage: '!enablemod <module|category>',
    hint: 'Puts a whole category back after `!disablemod`. Give it the category name, e.g. `rpg`.',
    cooldown: 5,
    permission: 'groupAdmin',
    execute: async ({ args, event, registry, reply, react }) => guard(reply, event.messageID, 'enablemod', async () => {
      if (!event.isGroup) {
        await reply('❌ This command only works in a group.', event.messageID);
        return;
      }
      const name = (args[0] || '').toLowerCase();
      if (!name) {
        await reply('❌ Usage: `!enablemod system`\nModules: cmds_1 … cmds_10', event.messageID);
        return;
      }
      const known = registry.size && [...registry.values()].some((c) => c.module === name)
        || [...registry.values()].some((c) => c.category === name);
      if (!known && !/^cmds_\d+$/.test(name)) {
        await reply(`❌ \`${name}\` is not a known module or category.\nUse \`!listmods\` to see them.`, event.messageID);
        return;
      }
      await toggles.toggleModule(event.threadID, name, false);
      await react('✅');
      await reply(`✅ Module \`${name}\` is enabled in this group.`, event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 16$
  // ─────────────────────────────────────────────────────────
  {
    name: 'disablemod',
    aliases: ['disablem'],
    category: 'system',
    description: '❌ Disable a whole module in this group',
    usage: '!disablemod <module|category>',
    hint: 'A whole category, this group only. The switch fails open, so a group can never be locked out of the bot entirely.',
    cooldown: 5,
    permission: 'groupAdmin',
    execute: async ({ args, event, registry, reply, react }) => guard(reply, event.messageID, 'disablemod', async () => {
      if (!event.isGroup) {
        await reply('❌ This command only works in a group.', event.messageID);
        return;
      }
      const name = (args[0] || '').toLowerCase();
      if (!name) {
        await reply('❌ Usage: `!disablemod system`\nModules: cmds_1 … cmds_10', event.messageID);
        return;
      }
      const known = [...registry.values()].some((c) => c.module === name)
        || [...registry.values()].some((c) => c.category === name);
      if (!known && !/^cmds_\d+$/.test(name)) {
        await reply(`❌ \`${name}\` is not a known module or category.\nUse \`!listmods\` to see them.`, event.messageID);
        return;
      }
      await toggles.toggleModule(event.threadID, name, true);
      await react('🔇');
      await reply(
        `🔇 Module \`${name}\` is disabled in this group.\n`
        + moduleEscapeHatchNote(registry, name)
        + `Admins can still run everything.`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 17$
  // ─────────────────────────────────────────────────────────
  {
    name: 'listcmds',
    aliases: ['lsc'],
    category: 'system',
    description: '📋 Show which commands are enabled or disabled in this group',
    usage: '!listcmds',
    hint: 'What is on and off in this chat. Off means an admin switched it off for this group only.',
    cooldown: 5,
    permission: 'all',
    execute: async ({ event, registry, reply }) => guard(reply, event.messageID, 'listcmds', async () => {
      if (!event.isGroup) {
        await reply('❌ This command only works in a group.', event.messageID);
        return;
      }
      const group = await toggles.findGroup(event.threadID);
      const disabled = new Set(group ? group.disabledCommands || [] : []);
      const offModules = new Set(group ? group.disabledModules || [] : []);
      const all = [...registry.values()];

      // A module switch turns off everything it holds, so it has to be counted
      // here too. Reading only disabledCommands reported "354 enabled" in a chat
      // where the whole system module was switched off — the admin's own picture
      // of their chat was wrong in the one direction that hides breakage.
      const killedByModule = new Set(
        all.filter((c) => offModules.has(c.module) || offModules.has(c.category)).map((c) => c.name),
      );
      const enabled = all.filter((c) => !disabled.has(c.name) && !killedByModule.has(c.name));
      const off = all.filter((c) => disabled.has(c.name) || killedByModule.has(c.name));

      const lines = [
        `⚙️ Commands in this group (${all.length} total)`,
        '· · · · · · ·',
        ...(offModules.size
          ? [`📦 Modules off: ${[...offModules].map((m) => `\`${m}\``).join(', ')}`, '']
          : []),
        `✅ Enabled: ${enabled.length}`,
        ...chunk(enabled.map((c) => `\`${c.name}\``), 4),
        '',
        `🔇 Disabled: ${off.length}`,
        ...(off.length ? chunk(off.map((c) => `\`${c.name}\``), 4) : ['• none']),
        '',
        '📖 Off means only for members — admins can still run all of it.',
      ];
      await reply(lines.join('\n'), event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 18$
  // ─────────────────────────────────────────────────────────
  

  // ─────────────────────────────────────────────────────────
  // 19$
  // ─────────────────────────────────────────────────────────
  {
    name: 'autoadd',
    aliases: ['autojoin', 'reinvite'],
    category: 'system',
    description: '🔄 Auto re-invite members who leave this group',
    usage: '!autoadd <on|off>',
    hint: 'Re-invites whoever leaves. It is a per-group setting, and it needs the bot to still be an admin here.',
    cooldown: 5,
    permission: 'groupAdmin',
    execute: async ({ api, args, event, reply, react }) => guard(reply, event.messageID, 'autoadd', async () => {
      if (!event.isGroup) {
        await reply('❌ This command only works in a group.', event.messageID);
        return;
      }
      const group = await toggles.getGroup(event.threadID);
      const mode = (args[0] || '').toLowerCase();

      if (!['on', 'off'].includes(mode)) {
        await reply(
          `🔁 Auto re-add: ${group.autoAddLeavers ? 'ON' : 'OFF'}\n`
          + 'Usage: `!autoadd on` or `!autoadd off`\n'
          + 'When ON, anyone who leaves is invited straight back. '
          + 'People an admin removed are not — the bot never pulls back somebody '
          + 'who was kicked.',
          event.messageID,
        );
        return;
      }

      group.autoAddLeavers = mode === 'on';
      // Same honesty as !ban: a transient save() is a no-op, so say so rather
      // than confirming a setting that will be gone after a restart.
      if (group.transient) {
        await reply('⚠️ The city grid is down right now — this setting is TEMPORARY and resets on restart.', event.messageID);
        return;
      }
      await group.save();
      await react(mode === 'on' ? '🔁' : '✅');
      await reply(
        mode === 'on'
          ? '🔁 Auto re-add is ON — leavers get invited back. People an admin removed do not.'
          : '✅ Auto re-add is OFF — leavers stay out.',
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 19a$ — auto-download of shared links
  // ─────────────────────────────────────────────────────────
  {
    name: 'autodownload',
    aliases: ['autodl', 'autovert'],
    category: 'system',
    description: '⬇️ Auto-download video links posted in this chat',
    usage: '!autodownload <on|off>',
    hint: 'Video links posted in this chat get downloaded for you. It is per group, and it is the links only, not every post.',
    cooldown: 5,
    permission: 'groupAdmin',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'autodownload', async () => {
      if (!event.isGroup) {
        await reply('❌ This command only works in a group.', event.messageID);
        return;
      }
      const group = await toggles.getGroup(event.threadID);
      const mode = (args[0] || '').toLowerCase();
      const gc = group.gc || {};
      const on = Boolean(gc.autoDownload && gc.autoDownload.on);

      if (!['on', 'off'].includes(mode)) {
        await reply(
          `⬇️ Auto-download: ${on ? 'ON' : 'OFF'}\n`
          + 'Usage: `!autodownload on` or `!autodownload off`\n'
          + 'When ON, the bot downloads any video link posted in this chat and '
          + 'posts the file. When OFF, it stays quiet until somebody asks for it '
          + 'with a download command.',
          event.messageID,
        );
        return;
      }

      if (!gc.autoDownload) gc.autoDownload = { on: false };
      gc.autoDownload.on = mode === 'on';
      // Mongoose notices the change to the nested object on its own, but saying
      // so explicitly costs nothing and removes the doubt.
      if (typeof group.markModified === 'function') group.markModified('gc');

      // Same honesty as !ban: a transient save() is a no-op, so say so rather
      // than confirming a setting that will be gone after a restart.
      if (group.transient) {
        await reply('⚠️ The city grid is down right now — this setting is TEMPORARY and resets on restart.', event.messageID);
        return;
      }
      await group.save();
      try {
        moderation.invalidate(event.threadID);
      } catch { /* the cache is a cache */ }
      await react(mode === 'on' ? '⬇️' : '✅');
      await reply(
        mode === 'on'
          ? '⬇️ Auto-download is ON — the bot will answer video links in this chat.'
          : '✅ Auto-download is OFF — the bot waits to be asked.',
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 20$
  // ─────────────────────────────────────────────────────────
  {
    name: 'count',
    aliases: ['members'],
    category: 'system',
    description: '🔢 Count the members and admins in this group',
    usage: '!count',
    hint: 'Members and admins, counted from the live member list rather than the bot\'s own bookkeeping.',
    cooldown: 10,
    permission: 'all',
    execute: async ({ api, event, reply, react }) => guard(reply, event.messageID, 'count', async () => {
      await react('👥');

      // A DM has exactly one member and no admins, so answer without a lookup.
      if (!event.isGroup) {
        await reply('👥 This is a private chat — just you and me.', event.messageID);
        return;
      }

      // getThreadInfo can fail on a transient fetch. Count what is known rather
      // than claiming a number we do not have.
      let members = 0;
      let admins = 0;
      let known = true;
      try {
        const info = await api.getThreadInfo(event.threadID);
        const ids = (info && info.participantIDs) || [];
        const adminIds = (info && info.adminIDs) || [];
        // An empty participant list means the build could not read it, not that
        // the group is empty — reporting "0 members" would be a lie.
        known = ids.length > 0;
        members = ids.length;
        admins = adminIds.length;
      } catch {
        known = false;
      }

      if (!known) {
        await reply('👥 I could not read the member list just now. Try again in a moment.', event.messageID);
        return;
      }

      const group = await toggles.findGroup(event.threadID);
      await reply(
        `👥 Members: ${members}\n`
        + `🛡️ Admins: ${admins}\n`
        + `💬 Messages recorded: ${group && group.gc && group.gc.msgs ? group.gc.msgs : 0}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 21$
  // ─────────────────────────────────────────────────────────
  {
    name: 'unsend',
    aliases: ['del', 'undelete'],
    category: 'system',
    description: '🗑 Delete the bot\'s last message, or the one you replied to',
    usage: '!unsend',
    hint: 'Deletes the bot\'s own last message, or the one you replied to. Facebook only lets a bot unsend what the bot sent.',
    cooldown: 5,
    permission: 'groupAdmin',
    execute: async ({ api, event, reply, react }) => guard(reply, event.messageID, 'unsend', async () => {
      if (typeof api.unsendMessage !== 'function') {
        await reply('⚠️ This build of ws3-fca cannot unsend messages.', event.messageID);
        return;
      }

      // WHAT TO DELETE
      //
      // The target is the message the user REPLIED TO. The old code read
      // `event.replyToMessage`, which ws3-fca does not set — a reply carries
      // the parent under `event.messageReply.messageID`, so that expression was
      // always undefined and every "delete the one I replied to" silently fell
      // through to deleting the bot's last message instead. Replying to
      // something and unsending it deleted a different message, every time.
      //
      // With no reply at all there is no target to point at, so it falls back to
      // the bot's most recent message in this thread.
      const repliedTo = event.messageReply && event.messageReply.messageID;
      const target = String(repliedTo || lastSent(event.threadID) || '');
      if (!target) {
        await reply('❌ Nothing to unsend. Reply to a message with `!unsend`, or wait for the bot to post something first.', event.messageID);
        return;
      }

      try {
        await api.unsendMessage(target);
      } catch (err) {
        // Facebook only lets an account unsend messages it sent itself. Unsend is
        // not admin moderation: it is "take this back". There is no delete-for-
        // everyone endpoint in ws3-fca, so deleting somebody else's message is
        // not something this bot can do at all, and saying so plainly is more
        // use than a raw Facebook error object.
        await reply(
          `⚠️ Could not unsend that message.\n`
          + '📖 Facebook only lets the sender unsend their own message, and ws3-fca has no '
          + '"delete for everyone" endpoint — a group admin deletes other people\'s messages in the app.',
          event.messageID,
        );
        error(`[UNSEND] ${target} in ${event.threadID} failed: ${describeSendError(err)}`);
        return;
      }

      await react('🗑');
      await reply('🗑 Deleted that message.', event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 22$
  // ─────────────────────────────────────────────────────────
  {
    name: 'onlyadminon',
    aliases: ['adminsonly', 'adminonly'],
    category: 'system',
    description: '🔒 Restrict this group so only admins can run commands',
    usage: '!onlyadminon',
    hint: 'From now on only admins get answers here. Ordinary members are told why, so nobody thinks the bot is dead.',
    cooldown: 5,
    permission: 'groupAdmin',
    execute: async ({ event, reply, react }) => guard(reply, event.messageID, 'onlyadminon', async () => {
      if (!event.isGroup) {
        await reply('❌ This command only works in a group.', event.messageID);
        return;
      }
      const group = await toggles.getGroup(event.threadID);
      if (group.adminsOnly) {
        await reply('ℹ️ Admins-only is already ON here.', event.messageID);
        return;
      }
      group.adminsOnly = true;
      if (group.transient) {
        await reply('⚠️ The city grid is down right now — this setting is TEMPORARY and resets on restart.', event.messageID);
        return;
      }
      await group.save();
      await react('🔒');
      await reply(
        '🔒 Admins-only is ON — only group admins can run commands here.\n'
        + 'Turn it back off with `!onlyadminoff`.',
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 23$
  // ─────────────────────────────────────────────────────────
  {
    name: 'onlyadminoff',
    // `adminonlyoff` is the mirror of the `adminonly` alias on !onlyadminon.
    // Without it the two spellings of "turn it off" had no relationship to each
    // other, and the one people actually type is the one that failed.
    aliases: ['allusers', 'adminonlyoff'],
    category: 'system',
    description: '🔓 Let everyone run commands in this group again',
    usage: '!onlyadminoff',
    hint: 'Everyone can run commands in this group again. This is the one that lifts the lock.',
    cooldown: 5,
    permission: 'groupAdmin',
    execute: async ({ event, reply, react }) => guard(reply, event.messageID, 'onlyadminoff', async () => {
      if (!event.isGroup) {
        await reply('❌ This command only works in a group.', event.messageID);
        return;
      }
      const group = await toggles.getGroup(event.threadID);
      if (!group.adminsOnly) {
        await reply('ℹ️ Admins-only is already OFF here.', event.messageID);
        return;
      }
      group.adminsOnly = false;
      if (group.transient) {
        await reply('⚠️ The city grid is down right now — this setting is TEMPORARY and resets on restart.', event.messageID);
        return;
      }
      await group.save();
      await react('🔓');
      await reply('🔓 Admins-only is OFF — everyone can run commands here again.', event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 24$
  // ─────────────────────────────────────────────────────────
  {
    name: 'config',
    aliases: ['showconfig'],
    category: 'system',
    description: '⚙️ Show the bot configuration (secrets are never printed)',
    usage: '!config',
    hint: 'Owner only. Every setting, with the secrets replaced — a real value is never printed.',
    cooldown: 10,
    permission: 'owner',
    execute: async ({ config, reply, event }) => guard(reply, event.messageID, 'config', async () => {
      const status = mongo.status();
      await reply(
        '⚙️ Configuration (secrets hidden)\n'
        + '· · · · · · ·\n'
        + `Bot name: ${config.BOT_NAME}\n`
        + `Owner: ${config.OWNER}\n`
        + `Version: ${config.VERSION}\n`
        + `Prefix: ${config.PREFIX}\n`
        + `Default cooldown: ${config.DEFAULT_COOLDOWN}s\n`
        + `Reactions: ${config.REACTIONS_ENABLED ? 'on' : 'off'}\n`
        + `Cache TTL: ${Math.round((config.CACHE_TTL || 0) / 1000)}s\n`
        + `Environment: ${config.NODE_ENV}\n`
        + `Port: ${config.PORT}\n`
        + '💾 database\n'
        + `Connected: ${status.connected ? 'yes' : 'no'}\n`
        + `Host: ${maskHost(config.MONGO_URI)}\n`
        + '📡 facebook\n'
        + `Cookies: ${config.APPSTATE.length} loaded (values hidden)\n`
        + `Admins: ${permissions.ownerIds().length}\n`
        // Loud when empty, because with no ADMIN_IDS every owner-only command
        // is silently unreachable and the bot looks broken rather than locked.
        + (permissions.ownerIds().length ? '' : '⚠️ none configured — set ADMIN_IDS in the Render environment\n')
        + '🧠 ai\n'
        + `Groq: ${config.GROQ_API_KEY ? 'configured' : 'not set'}\n`
        // The live model, not just the configured one: the client walks its
        // own ladder when the configured model is unavailable to the key.
        + `Model: ${require('../bot/groq').activeModel()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 25$
  // ─────────────────────────────────────────────────────────
  

  // ─────────────────────────────────────────────────────────
  // 26$
  // ─────────────────────────────────────────────────────────
  

  // ─────────────────────────────────────────────────────────
  // 27$
  // ─────────────────────────────────────────────────────────
  {
    name: 'owner',
    aliases: ['creator'],
    category: 'system',
    description: '👑 Information about the bot owner',
    usage: '!owner',
    hint: 'Who builds and runs this bot, and how to reach them.',
    cooldown: 5,
    permission: 'all',
    execute: async ({ config, registry, reply, react, event }) => guard(reply, event.messageID, 'owner', async () => {
      await react(OWNER_ICON);
      await reply(
        `${OWNER_ICON} Bot owner\n`
        + '· · · · · · ·\n'
        + `Name: ${config.OWNER}\n`
        + `Role: Developer of ${config.BOT_NAME}\n`
        + `Bot version: v${config.VERSION}\n`
        + `Commands: ${registry.size} loaded`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 28$
  // ─────────────────────────────────────────────────────────
  {
    name: 'support',
    aliases: ['help2'],
    category: 'system',
    description: '🆘 Where to get help or report a problem',
    usage: '!support',
    hint: 'Where to report a problem, and what to include when you do so it can actually be fixed.',
    cooldown: 5,
    permission: 'all',
    execute: async ({ config, reply, react, event }) => guard(reply, event.messageID, 'support', async () => {
      await react('🆘');
      await reply(
        '🆘 Support\n'
        + '· · · · · · ·\n'
        + `Owner: ${config.OWNER}\n`
        + '• Report bugs with the exact command you ran.\n'
        + `• Built-in help: \`${config.PREFIX}help\`\n`
        + `• Detailed help: \`${config.PREFIX}help <command>\`\n`
        + `• Bot health: \`${config.PREFIX}botstatus\`\n`
        + '• Admin tools: `!adminlist` to see who can manage groups.',
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 29$
  // ─────────────────────────────────────────────────────────
  

  // ─────────────────────────────────────────────────────────
  // 30$
  // ─────────────────────────────────────────────────────────
  {
    name: 'reload',
    aliases: ['rl'],
    category: 'system',
    description: '♻️ Re-scan the command files without restarting',
    usage: '!reload',
    hint: 'Owner only. Re-reads the command files without a restart, so the process stays up while the new commands take effect.',
    cooldown: 15,
    permission: 'owner',
    execute: async ({ reply, react, event }) => guard(reply, event.messageID, 'reload', async () => {
      const result = require('../ws3-fca').reloadCommands();
      await react('♻️');
      await reply(
        `♻️ Commands reloaded in ${result.ms}ms\n`
        + `Loaded: ${result.count} commands, ${result.aliases} aliases`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 31$
  // ─────────────────────────────────────────────────────────
  

  // ─────────────────────────────────────────────────────────
  // 32$
  // ─────────────────────────────────────────────────────────
  {
    name: 'e2e',
    aliases: ['selftest'],
    category: 'system',
    description: '🧪 Run the built-in self tests and report the result',
    usage: '!e2e',
    hint: 'Owner only. The chain end to end against a mocked Facebook: loader, router, cooldown, permissions, models and canvas.',
    cooldown: 30,
    permission: 'owner',
    execute: async ({ reply, react, event }) => guard(reply, event.messageID, 'e2e', async () => {
      await react('🧪');
      const checks = [
        ['Registry loads', () => require('../ws3-fca').registry.size > 0],
        ['Router parses', () => require('../bot/router').parse('!ping', '!').name === 'ping'],
        ['Cooldown works', () => {
          const cd = require('../bot/cooldown');
          cd.clear('__e2e__', 'probe');
          cd.set('__e2e__', 'probe', 5);
          const left = cd.check('__e2e__', 'probe', 5);
          cd.clear('__e2e__', 'probe');
          return left > 0;
        }],
        ['Permissions gate', () => typeof require('../bot/permissions').check === 'function'],
        ['Models registered', () => Boolean(User && Group)],
        ['Canvas wrapper', () => typeof canvas.create === 'function'],
      ];

      const results = [];
      for (const [label, fn] of checks) {
        // eslint-disable-next-line no-await-in-loop
        const passed = await Promise.resolve().then(fn).catch(() => false);
        results.push({ label, passed });
      }

      const passed = results.filter((r) => r.passed).length;
      const lines = [`🧪 Self test — ${passed}/${results.length} passed`, '· · · · · · ·'];
      results.forEach((r) => lines.push(`${r.passed ? '✅' : '❌'} ${r.label}`));
      await reply(lines.join('\n'), event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 33$
  // ─────────────────────────────────────────────────────────
  {
    name: 'ban',
    aliases: [],
    category: 'system',
    description: '🔨 Ban a user from using the bot (tag, mention or numeric ID)',
    usage: '!ban <user> [reason]',
    hint: 'Blocks someone from using the bot at all. To unban the same person, tag them for `!unban` too.',
    cooldown: 10,
    permission: 'groupAdmin',
    execute: async ({ api, args, event, reply, react }) => guard(reply, event.messageID, 'ban', async () => {
      if (!args[0]) {
        await reply('❌ Usage: `!ban <user> [reason]` — tag someone or give a numeric ID.', event.messageID);
        return;
      }

      // The thread knows who is actually here and what they are really called,
      // so this resolves a tag, a typed name, or a bare id in one place. The
      // name is resolved from the head of the argument list because a typed
      // name may contain spaces, and `consumed` says how many tokens it ate, so
      // the reason is read from what is left rather than from args.slice(1).
      const { target: found, consumed } = await userTarget.resolveArgs(args, event, api);
      if (!found) {
        await reply(`❌ Could not resolve \`${args.join(' ')}\` to a user. Tag them or use their numeric ID.`, event.messageID);
        return;
      }
      const uid = found.uid;
      const displayName = found.name;
      if (uid === String(event.senderID)) {
        await reply('❌ You cannot ban yourself.', event.messageID);
        return;
      }

      const target = await cache_getUser(uid, api);
      // getOrCreateUser never returns null, so the old "could not load a
      // profile" branch is gone: it fired for exactly the people who had never
      // used the bot, which is everyone a moderator is trying to ban.
      if (target.isBanned) {
        await reply(`⚠️ ${displayName} is already banned.`, event.messageID);
        return;
      }

      const reason = args.slice(consumed).join(' ').trim() || 'No reason given';
      target.isBanned = true;
      target.banReason = reason;
      target.bannedBy = String(event.senderID);

      if (target.transient) {
        await react('🚫');
        await reply(
          '⚠️ The city grid is down right now — this ban is TEMPORARY and lasts only until the bot restarts.\n'
          + `Banned ${displayName} (\`${uid}\`) for: ${reason}`,
          event.messageID,
        );
        return;
      }
      await target.save();

      await react('🚫');
      await reply(`🚫 Banned ${displayName} (\`${uid}\`)\nReason: ${reason}`, event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 34$
  // ─────────────────────────────────────────────────────────
  {
    name: 'unban',
    aliases: [],
    category: 'system',
    description: '🔨 Lift a ban so a user can use the bot again',
    usage: '!unban <user>',
    hint: 'Use a tag. Searching by name alone used to be the only option, which is why nobody could be unbanned.',
    cooldown: 10,
    permission: 'groupAdmin',
    execute: async ({ api, args, event, reply, react }) => guard(reply, event.messageID, 'unban', async () => {
      const ref = (args[0] || '').replace(/^@/, '').trim();
      if (!ref) {
        await reply('❌ Usage: `!unban <user>`', event.messageID);
        return;
      }
      // Same resolver as !ban, so unbanning works for exactly the people who
      // can be banned. This one used to search the database by name only, so a
      // tag could never be unbanned — the reply you got was "no profile found"
      // for the person standing right there.
      const target = await userTarget.userDoc(ref, event, api);
      if (!target) {
        await reply(`❌ No profile found for \`${ref}\`.`, event.messageID);
        return;
      }
      if (!target.isBanned) {
        await reply(`ℹ️ ${target.name} is not banned.`, event.messageID);
        return;
      }
      target.isBanned = false;
      target.banReason = '';
      target.bannedBy = null;
      if (!target.transient) await target.save();

      await react('✅');
      await reply(`✅ Unbanned ${target.name} (\`${target.uid}\`).`, event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 35$
  // ─────────────────────────────────────────────────────────
  {
    name: 'ping2',
    aliases: ['latency'],
    category: 'system',
    description: '⏱ Advanced ping: engine, database and network latency',
    usage: '!ping2',
    hint: 'Slower than `!ping` and far more useful: it times the database and the network, not just the process.',
    cooldown: 5,
    permission: 'all',
    execute: async ({ reply, react, event }) => guard(reply, event.messageID, 'ping2', async () => {
      await react('⏱');
      const ik = require('../ws3-fca');

      const engineStart = Date.now();
      // Engine responsiveness: how long a registry lookup takes.
      loader.findCommand('ping', ik.registry, ik.aliases);
      const engineMs = Date.now() - engineStart;

      const dbMs = mongo.isReady() ? await measure(() => User.findOne({ uid: '__ping_probe__' }).lean()) : null;

      const parts = [
        '⏱ Advanced ping',
        '· · · · · · ·',
        `🤖 Engine: ${engineMs}ms`,
        `💾 Database: ${dbMs === null ? 'offline' : `${dbMs}ms`}`,
        `⏳ Bot uptime: ${dur(process.uptime())}`,
        `📨 Messages: ${fmt.n(ik.STATE.messagesSeen)}`,
        `⚡ Commands run: ${fmt.n(ik.STATE.commandsRun)}`,
        `⚠️ Errors: ${fmt.n(ik.STATE.errors)}`,
      ];
      await reply(parts.join('\n'), event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 36$
  // ─────────────────────────────────────────────────────────
  
// ─────────────────────────────────────────────────────────
  // BROADCAST — one message, every group
  // ─────────────────────────────────────────────────────────
  {
    name: 'broadcast',
    aliases: ['bc', 'announceall', 'sendall'],
    category: 'system',
    description: '📡 Send one message to every chat that asked for broadcasts',
    usage: '!broadcast <message>',
    hint: 'Owner only. `!broadcast preview <message>` shows it here first without sending. `!broadcast all <message>` forces every chat and spends the fan-out budget.',
    cooldown: 300,
    permission: 'owner',
    execute: async ({ api, args, event, config, reply, react }) => guard(reply, event.messageID, 'broadcast', async () => {
      await react('📡');

      // `preview` is here because a broadcast cannot be recalled. There is no
      // way to un-send from two hundred chats, so the way to check the wording
      // is to see it before it goes.
      const preview = String(args[0] || '').toLowerCase() === 'preview';
      // `all` sends to every chat the bot is in, whether or not that chat asked
      // for broadcasts. It is the override, and it is the expensive one.
      const all = !preview && String(args[0] || '').toLowerCase() === 'all';
      const msg = (preview || all ? args.slice(1) : args).join(' ').trim();
      if (!msg) {
        await reply('❌ Usage: `!broadcast <message>`, `!broadcast all <message>` or `!broadcast preview <message>`', event.messageID);
        return;
      }

      if (!mongo.isReady()) {
        await reply('💾 The roster is sealed — The city grid is down right now, so no chat list. Nothing was sent.', event.messageID);
        return;
      }

      const body = `📡 **BROADCAST**\n· · · · · · ·\n${msg}\n· · · · · · ·\n📖 Sent by ${config.BOT_NAME}.`;

      if (preview) {
        await reply(`👀 **PREVIEW — nothing was sent.**\n· · · · · · ·\n${body}`, event.messageID);
        return;
      }

      // The default is the chats that asked for this. A broadcast is, by
      // definition, a message nobody in the chat requested, so a chat that has
      // not opted in has no business getting one — and a chat full of people
      // who report unsolicited messages is how an account gets suspended.
      const query = all
        ? { isEnabled: true }
        : { isEnabled: true, 'gc.broadcasts.on': true };
      const groups = await Group.find(query).select('tid').lean().catch(() => []);
      if (!groups.length) {
        await reply(
          all
            ? '❌ The bot is in no active chats, so there was nowhere to send this.'
            : '❌ No chat has asked for broadcasts.\n'
            + '· · · · · · ·\n'
            + 'An admin turns them on with `!broadcasts on`. '
            + 'Use `!broadcast all <message>` to override and send to every chat anyway.',
          event.messageID,
        );
        return;
      }

      // The budget is checked for the WHOLE batch before the first send.
      //
      // Two reasons it is all-or-nothing. The first is that a half-delivered
      // broadcast is the worst of both worlds: some chats have the message and
      // some do not, and there is no way to tell which is which. The second is
      // that the part which did go out is still the signal — the same text to
      // a hundred recipients in ten minutes is what the spam classifiers look
      // for, whether or not the last ten chats got it.
      const left = compliance.fanoutRemaining();
      const needed = groups.length;
      if (!compliance.canFanout(needed)) {
        await reply(
          '🛑 **Refusing to send.**\n'
          + '· · · · · · ·\n'
          + `This would push ${needed} messages at once, and the budget has room for `
          + `${Math.min(left.hour, left.day)}.\n`
          + `Hourly limit: ${left.hour}/${left.hourMax} left · Daily limit: ${left.day}/${left.dayMax} left.\n`
          + 'Send a smaller broadcast, or wait for the window to clear.',
          event.messageID,
        );
        return;
      }
      compliance.takeFanoutSlots(needed);

      // Sequential, with a randomised gap.
      //
      // Every send is an HTTP request to Facebook, and a burst of two hundred
      // of them is how an account gets rate-limited mid-broadcast. The gap is
      // randomised rather than fixed on purpose: a fixed delay is a rhythm, and
      // a machine with a rhythm is a machine, while a person pauses
      // unpredictably.
      let sent = 0;
      const failed = [];
      let elapsed = 0;
      for (const g of groups) {
        const tid = String(g.tid);
        const wait = compliance.broadcastDelayMs();
        elapsed += wait;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, wait));
        // eslint-disable-next-line no-await-in-loop
        const res = await helpersReply(api, tid, body, null, true).catch(() => null);
        if (res) sent += 1;
        else failed.push(tid);
      }

      await reply(
        `📡 **BROADCAST SENT**\n`
        + '· · · · · · ·\n'
        + `✅ Delivered to ${sent} of ${groups.length} chats\n`
        + (failed.length ? `⚠️ Failed: ${failed.length}\n` : '')
        + `⏱️ About ${Math.ceil(elapsed / 1000)}s of pacing.`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 35b$ — per-chat broadcast opt-in
  // ─────────────────────────────────────────────────────────
  {
    name: 'broadcasts',
    aliases: ['broadcastopt', 'allowbroadcast'],
    category: 'system',
    description: '📬 Let the bot owner send broadcasts into this chat',
    usage: '!broadcasts <on|off>',
    hint: 'Lets the bot owner send notices into this chat. Off by default — the owner cannot broadcast into a chat that has not said yes.',
    cooldown: 5,
    permission: 'groupAdmin',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'broadcasts', async () => {
      if (!event.isGroup) {
        await reply('❌ This command only works in a group.', event.messageID);
        return;
      }
      const group = await toggles.getGroup(event.threadID);
      const mode = (args[0] || '').toLowerCase();
      const gc = group.gc || {};
      const on = Boolean(gc.broadcasts && gc.broadcasts.on);

      if (!['on', 'off'].includes(mode)) {
        await reply(
          `📬 Operator broadcasts: ${on ? 'ON' : 'OFF'}\n`
          + 'Usage: `!broadcasts on` or `!broadcasts off`\n'
          + 'When ON, the bot owner can push a message into this chat with '
          + '`!broadcast`. When OFF, this chat is skipped.',
          event.messageID,
        );
        return;
      }

      if (!gc.broadcasts) gc.broadcasts = { on: false };
      gc.broadcasts.on = mode === 'on';
      if (typeof group.markModified === 'function') group.markModified('gc');
      if (group.transient) {
        await reply('⚠️ The city grid is down right now — this setting is TEMPORARY and resets on restart.', event.messageID);
        return;
      }
      await group.save();
      try {
        moderation.invalidate(event.threadID);
      } catch { /* the cache is a cache */ }
      await react(mode === 'on' ? '📬' : '✅');
      await reply(
        mode === 'on'
          ? '📬 Broadcasts are ON — the owner can push messages into this chat.'
          : '✅ Broadcasts are OFF — this chat is skipped.',
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 35c$ — account-safety report
  // ─────────────────────────────────────────────────────────
  {
    name: 'compliance',
    aliases: ['safety', 'suspend', 'accountrisk'],
    category: 'system',
    description: '🛡️ Account safety report — what this bot is doing that could get it suspended',
    usage: '!compliance',
    hint: 'Owner only. Lists the settings in this chat that put the account at risk, and the broadcast budget.',
    cooldown: 30,
    permission: 'owner',
    execute: async ({ event, reply, react }) => guard(reply, event.messageID, 'compliance', async () => {
      await react('🛡️');
      const group = await toggles.getGroup(event.threadID);
      const risks = compliance.safetyReport(group);
      const budget = compliance.fanoutRemaining();

      const lines = [
        '🛡️ **ACCOUNT SAFETY**',
        '· · · · · · ·',
        `📡 Broadcast budget — ${budget.hour}/${budget.hourMax} hourly, ${budget.day}/${budget.dayMax} daily left.`,
      ];

      if (!risks.length) {
        lines.push('✅ Nothing risky is switched on in this chat.');
      } else {
        lines.push('');
        for (const r of risks) {
          const icon = r.level === 'critical' ? '🛑' : r.level === 'warning' ? '⚠️' : 'ℹ️';
          lines.push(`${icon} **${r.setting}**`);
          lines.push(`   ${r.why}`);
          lines.push(`   → ${r.fix}`);
        }
      }

      lines.push('');
      lines.push('💡 Unsolicited replies to unknown commands are only sent in private chats, '
        + 'and shared links are only auto-downloaded when the chat asks for it.');

      await reply(lines.join('\n'), event.messageID);
    }),
  },
// ─────────────────────────────────────────────────────────
  // 36b$  — operator broadcast (owner only)
  // ─────────────────────────────────────────────────────────
  

  // ─────────────────────────────────────────────────────────
  // 36c$  — operator shutdown (owner only)
  // ─────────────────────────────────────────────────────────
  

  // ─────────────────────────────────────────────────────────
  // 37$  — anti-ban safe mode (owner only)
  // ─────────────────────────────────────────────────────────
  {
    name: 'safemode',
    aliases: ['safemodeon', 'safemodeoff'],
    category: 'system',
    description: '🔒 Toggle bot-wide safe mode — only admins get replies when on',
    usage: '!safemode on|off',
    hint: 'Owner only, and it is bot-wide: while it is on, only admins get an answer anywhere, not just here.',
    cooldown: 10,
    permission: 'owner',
    execute: async ({ args, reply, react, event }) => guard(reply, event.messageID, 'safemode', async () => {
      await react('🔒');
      const arg = String(args[0] || '').toLowerCase();
      if (!arg || !['on', 'off'].includes(arg)) {
        const status = global.botSafeMode ? 'ON' : 'OFF';
        await reply(
          `🔒 **Safe mode is currently ${status}**\n`
          + '· · · · · · ·\n'
          + `When ON, the bot only replies to admins — use during FB warnings.\n`
          + `Toggle with \`!safemode on\` or \`!safemode off\`.`,
          event.messageID,
        );
        return;
      }
      global.botSafeMode = arg === 'on';
      const state = global.botSafeMode ? 'ON ✅' : 'OFF 🔓';
      await reply(
        `🔒 **Safe mode ${state}**\n`
        + '· · · · · · ·\n'
        + (global.botSafeMode
          ? 'The bot will now ignore all non-admin commands. Silence is safety.\n'
          : 'The bot is back to normal operation.\n')
        + `📖 ${arg === 'on' ? 'Go make coffee — you are off the record.' : 'Welcome back.'}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 38$ — find a command by what it does
  // ─────────────────────────────────────────────────────────
  

  // ─────────────────────────────────────────────────────────
  // 39$ — the clock, anywhere on earth
  // ─────────────────────────────────────────────────────────
  {
    name: 'time',
    aliases: ['clock', 'worldtime'],
    category: 'system',
    description: '🕐 The clock in any city — `!time Africa/Nairobi`',
    usage: '!time [timezone]',
    hint: 'No argument gives the bot\'s own clock. Give it an IANA zone and it gives that one.',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, reply, react, event }) => guard(reply, event.messageID, 'time', async () => {
      await react('🕐');
      const now = new Date();
      const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const zone = String(args[0] || '').trim();

      const stamp = (tz) => new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'full', timeStyle: 'short', timeZone: tz,
      }).format(now);

      if (!zone) {
        await reply(
          `🕐 **SERVER CLOCK**\n`
          + '· · · · · · ·\n'
          + `🖥️ ${stamp(serverZone)} (${serverZone})\n`
          + `🌍 UTC: ${stamp('UTC')}\n`
          + '📖 `!time <timezone>` — `Africa/Nairobi`, `Europe/London`, `America/New_York`, `Asia/Tokyo`.',
          event.messageID,
        );
        return;
      }

      let formatted;
      try {
        formatted = stamp(zone);
      } catch {
        await reply(
          `❌ \`${zone}\` is not a timezone I know.\n`
          + '· · · · · · ·\n'
          + '📖 Use an IANA name: `Africa/Nairobi`, `Europe/London`, `America/New_York`, `Asia/Tokyo`, `UTC`.',
          event.messageID,
        );
        return;
      }

      // Which day is it over there, compared to the bot's own day. A nicety,
      // never a reason to fail the command.
      let dayNote = '';
      try {
        const day = (tz) => new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(now);
        const here = day(serverZone);
        const there = day(zone);
        if (here !== there) {
          const diff = Math.round((Date.parse(`${there}T00:00:00Z`) - Date.parse(`${here}T00:00:00Z`)) / 86400000);
          dayNote = diff > 0
            ? `\n📅 That is ${diff === 1 ? 'tomorrow' : `${diff} days ahead`} of ${serverZone}.`
            : `\n📅 That is ${diff === -1 ? 'yesterday' : `${-diff} days behind`} ${serverZone}.`;
        }
      } catch { /* the day note is optional */ }

      await reply(`🕐 **${zone}**\n· · · · · · ·\n🕰️ ${formatted}${dayNote}`, event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 40$ — spy on a user's public Facebook profile
  // ─────────────────────────────────────────────────────────
  {
    name: 'spy',
    aliases: ['stalk', 'profileinfo', 'whois'],
    category: 'system',
    description: '🔍 View detailed public Facebook profile info — bio, cover photo, location, and more',
    usage: '.spy @user',
    hint: 'Tag someone to see their public profile details: HD profile/cover photos, bio, location, nickname, and UID.',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, event, api, reply, react, userDoc }) => guard(reply, event.messageID, 'spy', async () => {
      await react('🔍');

      // Resolve target user from mention, name, or UID
      let result = null;
      if (event.mentions && Object.keys(event.mentions).length > 0) {
        // Use the first mention
        const mentionUid = Object.keys(event.mentions)[0];
        result = await userTarget.byId(mentionUid, event, api);
      } else if (args.length > 0) {
        // Try to resolve from args (name or UID)
        result = await userTarget.resolve(event, args, api);
      } else {
        // Default to the sender
        result = await userTarget.byId(event.senderID, event, api);
      }

      if (!result || !result.uid) {
        await reply('❌ Could not resolve that user. Tag someone or provide a name/UID.', event.messageID);
        return;
      }

      const uid = result.uid;
      const chatName = result.name || 'Unknown';

      // Fetch detailed profile using getUserInfo with usePayload=false for full data
      let profileData = null;
      try {
        profileData = await api.getUserInfo(uid, false);
      } catch (err) {
        error(`[SPY] getUserInfo(${uid}) failed: ${err.message}`);
      }

      if (!profileData) {
        // Fallback to cached info
        profileData = await cache.getUserInfoCached(uid, api);
      }

      if (!profileData) {
        await reply('❌ Could not fetch profile data from Facebook.', event.messageID);
        return;
      }

      const profileName = profileData.name || chatName;

      // Also get chat nickname from thread info if available
      let chatNickname = null;
      try {
        const threadInfo = await api.getThreadInfo(event.threadID);
        if (threadInfo && threadInfo.nicknames && threadInfo.nicknames[uid]) {
          chatNickname = threadInfo.nicknames[uid];
        }
      } catch (err) {
        // Ignore thread info errors
      }

      // Build the spy report
      const lines = [];
      lines.push(`🔍 **SPY REPORT: ${profileName}**`);
      lines.push('· · · · · · ·');
      lines.push(`🆔 UID: \`${uid}\``);
      lines.push(`👤 Profile Name: ${profileName}`);
      if (chatName !== profileName) lines.push(`💬 Chat Name: ${chatName}`);
      if (chatNickname && chatNickname !== chatName && chatNickname !== profileName) lines.push(`🏷️ Chat Nickname: ${chatNickname}`);
      if (profileData.firstName) lines.push(`📛 First Name: ${profileData.firstName}`);
      if (profileData.lastName) lines.push(`📛 Last Name: ${profileData.lastName}`);
      if (profileData.vanity) lines.push(`🔗 Vanity URL: https://facebook.com/${profileData.vanity}`);
      lines.push(`🌐 Profile: ${profileData.profileUrl || `https://facebook.com/${uid}`}`);
      
      if (profileData.gender) lines.push(`⚧ Gender: ${profileData.gender}`);
      if (profileData.isVerified) lines.push('✅ Verified: Yes');
      if (profileData.isFriend) lines.push('👥 Friend Status: Friends');
      if (profileData.isBirthday) lines.push('🎂 Today is their birthday!');

      if (profileData.bio) {
        lines.push('');
        lines.push(`📝 **Bio:**`);
        lines.push(profileData.bio);
      }

      if (profileData.live_city) {
        lines.push('');
        lines.push(`📍 **Location:** ${profileData.live_city}`);
      }

      if (profileData.headline) {
        lines.push('');
        lines.push(`💼 **Headline:** ${profileData.headline}`);
      }

      if (profileData.followers) {
        lines.push('');
        lines.push(`👥 **Followers:** ${profileData.followers}`);
      }

      if (profileData.following) {
        lines.push(`👥 **Following:** ${profileData.following}`);
      }

      // Profile picture and cover photo URLs
      if (profileData.profilePicUrl) {
        lines.push('');
        lines.push(`🖼️ **Profile Picture:** ${profileData.profilePicUrl}`);
      }
      if (profileData.coverPhoto) {
        lines.push(`🖼️ **Cover Photo:** ${profileData.coverPhoto}`);
      }

      // Type info
      if (profileData.type) {
        lines.push('');
        lines.push(`📋 Account Type: ${profileData.type}`);
      }

      // Send as text first
      await reply(lines.join('\n'), event.messageID);

      // Then send profile picture and cover photo as attachments if available
      const attachments = [];
      if (profileData.profilePicUrl) {
        attachments.push({ type: 'image', data: { url: profileData.profilePicUrl } });
      }
      if (profileData.coverPhoto) {
        attachments.push({ type: 'image', data: { url: profileData.coverPhoto } });
      }

      if (attachments.length > 0) {
        try {
          await reply({ body: `📸 **${profileName}'s Photos**`, attachment: attachments }, event.messageID);
        } catch (attachErr) {
          error(`[SPY] Failed to send attachments: ${attachErr.message}`);
        }
      }
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 41$ — fake hack prank (admin only)
  // ─────────────────────────────────────────────────────────
  {
    name: 'hack',
    aliases: ['stealpassword', 'getlogin', 'pwn'],
    category: 'fun',
    description: '😈 Pretend to hack someone — fake progress bar, fake data, pure chaos',
    usage: '!hack @user',
    hint: 'Admin only. Tags a victim and runs a hilariously fake "hacking" sequence. No real data is stolen, obviously.',
    cooldown: 30,
    permission: 'admin',
    execute: async ({ args, event, api, reply, react, userDoc }) => guard(reply, event.messageID, 'hack', async () => {
      await react('😈');

      // Resolve target
      let targetUid = null;
      let targetName = 'the target';

      if (event.mentions && Object.keys(event.mentions).length > 0) {
        targetUid = Object.keys(event.mentions)[0];
        targetName = event.mentions[targetUid];
      } else if (args.length > 0) {
        const result = await userTarget.resolve(event, args, api);
        if (result && result.uid) {
          targetUid = result.uid;
          targetName = result.name || targetName;
        }
      } else {
        await reply('❌ Tag someone to "hack" — `!hack @user`', event.messageID);
        return;
      }

      // Don't let admins hack themselves (too easy)
      if (targetUid === event.senderID) {
        await reply('🤦 You can\'t hack yourself, genius.', event.messageID);
        return;
      }

      // Don't hack the bot owner
      const config = require('../config');
      if (config.OWNER_ID && targetUid === config.OWNER_ID) {
        await reply('🛑 Nice try. The bot owner is immune to script kiddies.', event.messageID);
        return;
      }

      // Fake hacking sequence
      const stages = [
        { msg: '🔓 **INITIATING SOCIAL ENGINEERING ATTACK...**', delay: 800 },
        { msg: '📡 **CONNECTING TO FACEBOOK MAINFRAME...**\n[█░░░░░░░░░] 10%', delay: 600 },
        { msg: '📡 **CONNECTING TO FACEBOOK MAINFRAME...**\n[███░░░░░░░] 30%', delay: 500 },
        { msg: '📡 **CONNECTING TO FACEBOOK MAINFRAME...**\n[█████░░░░░] 50%', delay: 400 },
        { msg: '📡 **CONNECTING TO FACEBOOK MAINFRAME...**\n[███████░░░] 70%', delay: 300 },
        { msg: '📡 **CONNECTING TO FACEBOOK MAINFRAME...**\n[██████████] 100%', delay: 500 },
        { msg: '🔍 **SCANNING TARGET PROFILE...**\n> Extracting cookies...\n> Bypassing 2FA...\n> Decrypting passwords...', delay: 1000 },
        { msg: '💾 **DOWNLOADING CREDENTIALS...**\n[██████████] 100%\n✅ Email: `victim@gmail.com`\n✅ Password: `hunter2`\n✅ Recovery: `mother\'s maiden name`', delay: 800 },
        { msg: '🌐 **ACCESSING PRIVATE MESSAGES...**\n> Reading DMs with crush...\n> Found 47 unread messages from mom...\n> Screenshotting embarrassing photos...', delay: 1000 },
        { msg: '💳 **STEALING PAYMENT INFO...**\n> Visa ending in 4206\n> CVV: 696\n> Expiry: 04/25\n> Balance: $0.00 (lol)', delay: 800 },
        { msg: '📍 **TRACKING LOCATION...**\n> GPS: 37.7749° N, 122.4194° W\n> Accuracy: 3 meters\n> Current activity: "pretending to work"', delay: 700 },
        { msg: '🤖 **DEPLOYING RANSOMWARE...**\n> Encrypting family photos...\n> Demand: 0.000001 BTC\n> Timer: 00:00:10', delay: 1000 },
      ];

      // Send initial message
      let sentMsg = await reply(stages[0].msg, event.messageID);

      // Animate through stages by editing the same message
      // Note: fbchat doesn't support editMessage, so we send new messages
      // But we'll simulate it with rapid replies
      for (let i = 1; i < stages.length; i++) {
        await new Promise(r => setTimeout(r, stages[i].delay));
        sentMsg = await reply(stages[i].msg, event.messageID);
      }

      // The punchline
      await new Promise(r => setTimeout(r, 800));
      
      const punchlines = [
        `🎉 **JUST KIDDING!** ${targetName} is safe... for now.`,
        `😂 **GOTTEM!** No passwords were stolen. ${targetName}, you can breathe.`,
        `🤡 **PRANK COMPLETE.** The only thing hacked was ${targetName}'s patience.`,
        `✨ **404: CREDENTIALS NOT FOUND.** ${targetName} uses a password manager like a responsible adult.`,
        `🛡️ **ACCESS DENIED.** ${targetName} has 2FA enabled. Nice try, script kiddie.`,
        `📛 **ERROR 418: I'M A TEAPOT.** The hacking module crashed. ${targetName} lives to see another day.`,
      ];

      const punchline = punchlines[Math.floor(Math.random() * punchlines.length)];
      
      await reply(
        `${punchline}\n\n` +
        `· · · · · · ·\n` +
        `💡 **Pro tip:** Real hackers don't use chat bots. ` +
        `Enable 2FA, use unique passwords, and don't click sketchy links.\n` +
        `🛡️ Your digital hygiene > this prank.`,
        event.messageID
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 42$ — save system (user-specific storage)
  // ─────────────────────────────────────────────────────────
  {
    name: 'save',
  aliases: ['remember'],
  category: 'fun',
  description: '💾 Save text to your personal storage (persists across restarts)',
  usage: '!save <name> <text>',
  hint: 'Save anything you want to remember later. Items are user-specific and persist between sessions.',
  cooldown: 10,
  permission: 'all',
  execute: async ({ args, event, api, reply, react, userDoc }) => {
    await react('💾');

    // Validate arguments
    if (args.length < 2) {
      await reply('❌ Usage: `!save <name> <text>`', event.messageID);
      return;
    }

    // Extract name and content
    const name = args[0].trim();
    const content = args.slice(1).join(' ');

    if (!name) {
      await reply('❌ Invalid name. Usage: `!save <name> <text>`', event.messageID);
      return;
    }

    // Save to user's personal storage
    userDoc.saved.set(name, content);
    await userDoc.save().catch(() => {
      // If save fails, we still want to tell the user it was saved locally
      // but couldn't persist to DB (which is fine for a save system)
    });

    await reply(`✅ Saved \`${name}\`:\n${content}`, event.messageID);
  },
},
{
  name: 'saved',
  aliases: ['list', 'show'],
  category: 'fun',
  description: '📋 View all saved items',
  usage: '!saved',
  hint: 'See everything you have saved. Items are stored per-user and persist between sessions.',
  cooldown: 5,
  permission: 'all',
  execute: async ({ event, reply, react, userDoc }) => {
    await react('📋');

    // List all saved items
    const savedItems = Array.from(userDoc.saved.entries());
    
    if (savedItems.length === 0) {
      await reply('📭 You have no saved items yet. Use `!save <name> <text>` to start saving.', event.messageID);
      return;
    }

    const lines = ['💾 **YOUR SAVED ITEMS:**'];
    savedItems.forEach(([name, data]) => {
      lines.push(`• ${name}: ${data}`);
    });

    await reply(lines.join('\n'), event.messageID);
  },
},
{
  name: 'unsave',
  aliases: ['remove', 'delete'],
  category: 'fun',
  description: '🗑️ Remove a saved item',
  usage: '!unsave <name>',
  hint: 'Delete a previously saved item. Cannot be undone.',
  cooldown: 5,
  permission: 'all',
  execute: async ({ args, event, reply, react, userDoc }) => {
    await react('🗑️');

    // Validate arguments
    if (args.length < 1) {
      await reply('❌ Usage: `!unsave <name>`', event.messageID);
      return;
    }

    const name = args[0].trim();
    if (!name) {
      await reply('❌ Invalid name.', event.messageID);
      return;
    }

    // Remove the item
    if (userDoc.saved.has(name)) {
      userDoc.saved.delete(name);
      await userDoc.save().catch(() => {});
      await reply(`🗑️ Removed saved item \`${name}\`.`, event.messageID);
      return;
    }
    await reply(`❌ No saved item named \`${name}\` found.`, event.messageID);
  },
},
];

// ───────────────────────────────────────────────────────────
// local helpers
// ───────────────────────────────────────────────────────────

/** Split an array into rows of `size` for tidy chat output. */
function chunk(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size).join('  '));
  return rows;
}

// The commands that undo the disable switches. Admins keep these regardless —
// the engine lets an admin override any disabled command — so disabling one is
// not a trap for the admin who did it. It is still worth saying out loud,
// because it removes the ability from everybody else in the chat, and that is
// the half of it an admin cannot take back with a bot command.
const UNDO_COMMANDS = ['enablecmd', 'enablemod', 'listcmds', 'listmods'];

/**
 * Warn that a single command being switched off also takes the undo command
 * away from ordinary members.
 *
 * @param {string} name the command about to be disabled
 * @param {string} undo how to turn it back on
 * @returns {string} an extra line, or '' when nothing important is lost
 */
function escapeHatchNote(name, undo) {
  if (!UNDO_COMMANDS.includes(name)) return `Re-enable with \`${undo} ${name}\``;
  return '⚠️ This is how admins turn commands back on, so members will lose the '
    + `ability to undo it. Admins keep \`${undo}\`.`;
}

/**
 * Same warning for a whole module: disabling the system module takes out every
 * command an admin uses to manage the group.
 *
 * @param {Map} registry command registry
 * @param {string} mod module or category key
 * @returns {string}
 */
function moduleEscapeHatchNote(registry, mod) {
  const victims = [...registry.values()]
    .filter((c) => c.module === mod || c.category === mod)
    .map((c) => c.name)
    .filter((n) => UNDO_COMMANDS.includes(n));
  if (!victims.length) return `Re-enable with \`!enablemod ${mod}\``;
  return `⚠️ This takes out \`${victims.join('`, `')}\` — so members will have no way to undo this. `
    + 'Admins keep them. Re-enable with `!enablemod ' + mod + '`';
}

/** Resolve a command name against the registry (name or alias). */
function lookup(registry, name) {
  for (const cmd of registry.values()) {
    if (cmd.name === name || cmd.aliases.includes(name)) return cmd;
  }
  return null;
}

/** Count total aliases across the registry. */
function registryAliasesCount(registry) {
  let n = 0;
  for (const cmd of registry.values()) n += cmd.aliases.length;
  return n;
}

/** Run an async operation and report how long it took, in ms. */
async function measure(fn) {
  const started = Date.now();
  try {
    await fn();
  } catch { /* a failed probe is still a latency sample */ }
  return Date.now() - started;
}

/** Hide the credentials inside a Mongo URI: mongodb+srv://host/db */
function maskHost(uri) {
  if (!uri) return 'not set';
  const m = /^(mongodb(?:\+srv)?:\/\/)([^/?]+)/.exec(uri);
  return m ? `${m[1]}${m[2].split('@').pop()}` : 'set';
}

/** Cache-backed profile lookup that never comes back empty (used by ban). */
async function cache_getUser(uid, api) {
  // eslint-disable-next-line global-require
  return require('../bot/cache').getOrCreateUser(uid, api);
}

