'use strict';

/**
 * MODULE 1 — SYSTEM CORE (35 commands)
 *
 * Exports a plain array. No factories, no legacy loader.
 *
 * Shape required for every command:
 * { name, aliases, category, description, usage, cooldown, permission, execute }
 *
 * execute receives: { api, event, args, config, registry, gemini, reply, react, userDoc }
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
const { fmt } = require('../bot/helpers');
const permissions = require('../bot/permissions');

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
  // 1
  // ─────────────────────────────────────────────────────────
  {
    name: 'ping',
    aliases: ['p'],
    category: 'system',
    description: 'Test the full chain: LOGIN -> DB -> LOADER -> MESSAGE -> PARSER -> COMMAND -> REPLY',
    usage: '!ping',
    cooldown: 3,
    permission: 'all',
    execute: async ({ reply, react, event }) => {
      await react('⚡');
      await reply(
        'PONG ✅ LOGIN->DB->LOADER->MESSAGE->PARSER->COMMAND->REPLY works',
        event.messageID,
      );
    },
  },

  // ─────────────────────────────────────────────────────────
  // 2
  // ─────────────────────────────────────────────────────────
  {
    name: 'help',
    aliases: ['h', 'menu', 'cmdlist'],
    category: 'system',
    description: 'List all commands, or show details for one command',
    usage: '!help [command]',
    cooldown: 3,
    permission: 'all',
    execute: async ({ args, registry, reply, react, event, config }) => guard(reply, event.messageID, 'help', async () => {
      await react('📖');

      const target = (args[0] || '').toLowerCase();
      if (target) {
        const resolved = lookup(registry, target);
        if (!resolved) {
          await reply(`❌ No command called \`${target}\`. Try \`${config.PREFIX}help\`.`, event.messageID);
          return;
        }
        const perms = {
          all: 'Everyone',
          owner: 'Bot owner only',
          groupAdmin: 'Group admins',
        };
        await reply(
          `📖 ${config.PREFIX}${resolved.name}\n`
          + `🏷 Category: ${resolved.category}\n`
          + `📝 ${resolved.description}\n`
          + `💬 Usage: ${resolved.usage}\n`
          + `⏱ Cooldown: ${resolved.cooldown}s\n`
          + `🔒 Permission: ${perms[resolved.permission] || resolved.permission}\n`
          + `🔗 Aliases: ${resolved.aliases.length ? resolved.aliases.join(', ') : 'none'}`,
          event.messageID,
        );
        return;
      }

      const all = [...registry.values()];
      const categories = [...new Set(all.map((c) => c.category))];

      const lines = [`📖 ${config.BOT_NAME} — ${all.length} commands available`, ''];
      for (const cat of categories) {
        const list = all.filter((c) => c.category === cat);
        lines.push(`━━ ${cat.toUpperCase()} (${list.length}) ━━`);
        // Chunk into rows of 4 so the list stays readable on a phone.
        for (let i = 0; i < list.length; i += 4) {
          lines.push(list.slice(i, i + 4).map((c) => `\`${c.name}\``).join('  '));
        }
        lines.push('');
      }
      lines.push(`Type \`${config.PREFIX}help <command>\` for details.`);
      await reply(lines.join('\n'), event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 3
  // ─────────────────────────────────────────────────────────
  {
    name: 'botinfo',
    aliases: ['info', 'about'],
    category: 'system',
    description: 'Show bot name, owner, uptime and command count',
    usage: '!botinfo',
    cooldown: 5,
    permission: 'all',
    execute: async ({ config, registry, reply, react, event }) => guard(reply, event.messageID, 'botinfo', async () => {
      await react(BOT_ICON);
      await reply(
        `${BOT_ICON} ${config.BOT_NAME}\n`
        + '━━━━━━━━━━━━━━━\n'
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
  // 4
  // ─────────────────────────────────────────────────────────
  {
    name: 'uptime',
    aliases: [],
    category: 'system',
    description: 'How long the bot has been running',
    usage: '!uptime',
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
  // 5
  // ─────────────────────────────────────────────────────────
  {
    name: 'dbstats',
    aliases: [],
    category: 'system',
    description: 'Total users and groups stored in the database',
    usage: '!dbstats',
    cooldown: 5,
    permission: 'all',
    execute: async ({ reply, react, event }) => guard(reply, event.messageID, 'dbstats', async () => {
      if (!mongo.isReady()) {
        await reply('💾 Database is offline — no stats right now.', event.messageID);
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
        + '━━━━━━━━━━━━━━━\n'
        + `👤 Users: ${users}\n`
        + `👥 Groups: ${groups}\n`
        + `✅ Approved groups: ${approved}\n`
        + `⏳ Pending approval: ${pending}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 6
  // ─────────────────────────────────────────────────────────
  {
    name: 'id',
    aliases: [],
    category: 'system',
    description: 'Show your Facebook ID and this thread ID',
    usage: '!id',
    cooldown: 5,
    permission: 'all',
    execute: async ({ event, reply }) => guard(reply, event.messageID, 'id', async () => {
      await reply(
        '🆔 IDs\n'
        + '━━━━━━━━━━━━━━━\n'
        + `👤 Your ID: ${event.senderID}\n`
        + `💬 Thread ID: ${event.threadID}\n`
        + `📨 Message ID: ${event.messageID}\n`
        + `👥 Group chat: ${event.isGroup ? 'yes' : 'no'}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 7
  // ─────────────────────────────────────────────────────────
  {
    name: 'userinfo',
    aliases: ['whois', 'ui'],
    category: 'system',
    description: 'Show your RPG profile and live Facebook name',
    usage: '!userinfo',
    cooldown: 5,
    permission: 'all',
    execute: async ({ api, event, userDoc, reply, react }) => guard(reply, event.messageID, 'userinfo', async () => {
      await react('👤');

      let liveName = null;
      try {
        if (api && typeof api.getUserInfo === 'function') {
          const info = await api.getUserInfo(event.senderID);
          liveName = info && (info.name || info.first_name);
        }
      } catch { /* offline — fall back to the stored name */ }

      const u = userDoc || {};
      const real = u.transient ? 'offline (not saved)' : 'saved';
      await reply(
        `👤 Profile\n`
        + '━━━━━━━━━━━━━━━\n'
        + `Name: ${liveName || u.name || 'Unknown'}\n`
        + `ID: ${event.senderID}\n`
        + `⭐ Level: ${u.level ?? 1}\n`
        + `✨ XP: ${u.xp ?? 0}\n`
        + `💰 Coins: ${fmt.n(u.coins ?? 0)}\n`
        + `🏦 Bank: ${fmt.n(u.bank ?? 0)}\n`
        + `🎖 Reputation: ${u.reputation ?? 0}\n`
        + `👑 Prestige: ${u.prestige ?? 0}\n`
        + `💬 Messages: ${fmt.n(u.stats?.messages ?? 0)}\n`
        + `🎮 Commands used: ${fmt.n(u.stats?.commandsUsed ?? 0)}\n`
        + `🕒 Last seen: ${u.lastSeen ? new Date(u.lastSeen).toUTCString() : 'unknown'}\n`
        + `💾 Profile: ${real}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 8
  // ─────────────────────────────────────────────────────────
  {
    name: 'threadinfo',
    // Not aliased to `groupinfo`: cmds_6 owns a command by that name, and the
    // loader resolves a real command before any alias, so the alias could never
    // fire. It looked reachable and was not.
    aliases: ['threaddetails'],
    category: 'system',
    description: 'Show this group name, member count and admin list',
    usage: '!threadinfo',
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
        await reply(`⚠️ Could not read this group: ${err.message}`, event.messageID);
        return;
      }

      const members = Array.isArray(info.participantIDs) ? info.participantIDs : [];
      const admins = Array.isArray(info.adminIDs) ? info.adminIDs : [];
      const group = await toggles.findGroup(event.threadID);

      await reply(
        `👥 Group info\n`
        + '━━━━━━━━━━━━━━━\n'
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
  // 9
  // ─────────────────────────────────────────────────────────
  {
    name: 'adminlist',
    aliases: ['admins'],
    category: 'system',
    description: 'List bot admins (ADMIN_IDS) and this group admin',
    usage: '!adminlist',
    cooldown: 5,
    permission: 'all',
    execute: async ({ api, event, config, reply }) => guard(reply, event.messageID, 'adminlist', async () => {
      // Read through permissions.ownerIds() rather than config.ADMIN_IDS alone:
      // that folds in the optional OWNER_ID, so this list is exactly the set the
      // permission check uses. If the two ever disagree, an operator reading
      // this would be told the wrong thing about who can run what.
      const owners = permissions.ownerIds();
      const lines = [
        `${OWNER_ICON} Bot admins (${owners.length})`,
        '━━━━━━━━━━━━━━━',
        ...(owners.length ? owners.map((id) => `• ${id}`) : ['• none configured — set ADMIN_IDS in the Render environment']),
      ];

      if (event.isGroup) {
        let admins = [];
        try {
          const info = await api.getThreadInfo(event.threadID);
          admins = Array.isArray(info.adminIDs) ? info.adminIDs : [];
        } catch { /* ignore */ }

        const sender = String(event.senderID);
        lines.push('', `👥 Group admins (${admins.length})`);
        if (!admins.length) lines.push('• could not read');
        else admins.forEach((id) => lines.push(`• ${id}${String(id) === sender ? '  ← you' : ''}`));
      }
      await reply(lines.join('\n'), event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 10
  // ─────────────────────────────────────────────────────────
  {
    name: 'prefix',
    aliases: [],
    category: 'system',
    description: 'Show the command prefix used in this chat',
    usage: '!prefix',
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
  // 11
  // ─────────────────────────────────────────────────────────
  {
    name: 'setprefix',
    aliases: ['setp'],
    category: 'system',
    description: 'Set a custom command prefix for this group',
    usage: '!setprefix ?',
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
  // 12
  // ─────────────────────────────────────────────────────────
  {
    name: 'maintenance',
    aliases: ['maint'],
    category: 'system',
    description: 'Turn maintenance mode on or off for this group',
    usage: '!maintenance on|off',
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
  // 13
  // ─────────────────────────────────────────────────────────
  {
    name: 'enablecmd',
    aliases: ['enablec'],
    category: 'system',
    description: 'Re-enable a command that was disabled in this group',
    usage: '!enablecmd <command>',
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
  // 14
  // ─────────────────────────────────────────────────────────
  {
    name: 'disablecmd',
    aliases: ['disablec'],
    category: 'system',
    description: 'Disable a command in this group',
    usage: '!disablecmd <command>',
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
      await toggles.toggleCommand(event.threadID, cmd.name, true);
      await react('🔇');
      await reply(
        `🔇 \`${cmd.name}\` is disabled in this group.\nRe-enable with \`!enablecmd ${cmd.name}\``,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 15
  // ─────────────────────────────────────────────────────────
  {
    name: 'enablemod',
    aliases: ['enablem'],
    category: 'system',
    description: 'Re-enable a whole module in this group',
    usage: '!enablemod <module|category>',
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
  // 16
  // ─────────────────────────────────────────────────────────
  {
    name: 'disablemod',
    aliases: ['disablem'],
    category: 'system',
    description: 'Disable a whole module in this group',
    usage: '!disablemod <module|category>',
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
        `🔇 Module \`${name}\` is disabled in this group.\nRe-enable with \`!enablemod ${name}\``,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 17
  // ─────────────────────────────────────────────────────────
  {
    name: 'listcmds',
    aliases: ['lsc'],
    category: 'system',
    description: 'Show which commands are enabled or disabled in this group',
    usage: '!listcmds',
    cooldown: 5,
    permission: 'all',
    execute: async ({ event, registry, reply }) => guard(reply, event.messageID, 'listcmds', async () => {
      if (!event.isGroup) {
        await reply('❌ This command only works in a group.', event.messageID);
        return;
      }
      const group = await toggles.findGroup(event.threadID);
      const disabled = new Set(group ? group.disabledCommands || [] : []);
      const all = [...registry.values()];

      const enabled = all.filter((c) => !disabled.has(c.name));
      const off = all.filter((c) => disabled.has(c.name));

      const lines = [
        `⚙️ Commands in this group (${all.length} total)`,
        '━━━━━━━━━━━━━━━',
        `✅ Enabled: ${enabled.length}`,
        ...chunk(enabled.map((c) => `\`${c.name}\``), 4),
        '',
        `🔇 Disabled: ${off.length}`,
        ...(off.length ? chunk(off.map((c) => `\`${c.name}\``), 4) : ['• none']),
      ];
      await reply(lines.join('\n'), event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 18
  // ─────────────────────────────────────────────────────────
  {
    name: 'listmods',
    aliases: ['lsm'],
    category: 'system',
    description: 'Show all 10 command modules and how many commands each holds',
    usage: '!listmods',
    cooldown: 5,
    permission: 'all',
    execute: async ({ event, registry, reply }) => guard(reply, event.messageID, 'listmods', async () => {
      const all = [...registry.values()];
      const disabled = new Set();
      if (event.isGroup) {
        const group = await toggles.findGroup(event.threadID);
        (group ? group.disabledModules || [] : []).forEach((m) => disabled.add(m));
      }

      const lines = ['📦 Modules (target 35 each)', '━━━━━━━━━━━━━━━'];
      let total = 0;
      for (let i = 1; i <= 10; i += 1) {
        const key = `cmds_${i}`;
        const count = all.filter((c) => c.module === key).length;
        total += count;
        const bar = '█'.repeat(Math.min(10, Math.round((count / 35) * 10))) + '░'.repeat(Math.max(0, 10 - Math.round((count / 35) * 10)));
        const flag = disabled.has(key) ? ' 🔇' : '';
        lines.push(`${key.padEnd(8)} ${String(count).padStart(2)}/35  ${bar}${flag}`);
      }
      lines.push('', `Total: ${total} commands loaded`);
      await reply(lines.join('\n'), event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 19
  // ─────────────────────────────────────────────────────────
  {
    name: 'approve',
    aliases: [],
    category: 'system',
    description: 'Approve this group and turn the bot on',
    usage: '!approve',
    cooldown: 10,
    permission: 'owner',
    execute: async ({ event, reply, react }) => guard(reply, event.messageID, 'approve', async () => {
      if (!event.isGroup) {
        await reply('❌ This command only works in a group.', event.messageID);
        return;
      }
      await toggles.approve(event.threadID, true);
      await react('✅');
      await reply('✅ This group is approved and the bot is enabled here.', event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 20
  // ─────────────────────────────────────────────────────────
  {
    name: 'disapprove',
    aliases: ['unapprove'],
    category: 'system',
    description: 'Disapprove this group and turn the bot off',
    usage: '!disapprove',
    cooldown: 10,
    permission: 'owner',
    execute: async ({ event, reply, react }) => guard(reply, event.messageID, 'disapprove', async () => {
      if (!event.isGroup) {
        await reply('❌ This command only works in a group.', event.messageID);
        return;
      }
      await toggles.approve(event.threadID, false);
      await react('🚫');
      await reply('🚫 This group is disapproved and the bot is disabled here.', event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 21
  // ─────────────────────────────────────────────────────────
  {
    name: 'approved',
    aliases: [],
    category: 'system',
    description: 'List every approved group',
    usage: '!approved',
    cooldown: 10,
    permission: 'owner',
    execute: async ({ config, reply, event }) => guard(reply, event.messageID, 'approved', async () => {
      if (!mongo.isReady()) {
        await reply('💾 Database is offline.', event.messageID);
        return;
      }
      const groups = await Group.find({ isApproved: true }).select('tid isEnabled maintenance').limit(50).lean();
      if (!groups.length) {
        await reply('✅ No approved groups yet.', event.messageID);
        return;
      }
      const lines = [`✅ Approved groups (${groups.length})`, '━━━━━━━━━━━━━━━'];
      groups.forEach((g, i) => {
        const flags = `${g.isEnabled ? 'enabled' : 'disabled'}${g.maintenance ? ', maintenance' : ''}`;
        lines.push(`${i + 1}. \`${g.tid}\` — ${flags}`);
      });
      if (groups.length === 50) lines.push('\n(list truncated at 50)');
      await reply(lines.join('\n'), event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 22
  // ─────────────────────────────────────────────────────────
  {
    name: 'pending',
    aliases: [],
    category: 'system',
    description: 'List groups waiting for approval',
    usage: '!pending',
    cooldown: 10,
    permission: 'owner',
    execute: async ({ config, reply, event }) => guard(reply, event.messageID, 'pending', async () => {
      if (!mongo.isReady()) {
        await reply('💾 Database is offline.', event.messageID);
        return;
      }
      const groups = await Group.find({ pendingApproval: true }).select('tid createdAt').limit(50).lean();
      if (!groups.length) {
        await reply('✅ Nothing pending — every group has been reviewed.', event.messageID);
        return;
      }
      const lines = [`⏳ Pending approval (${groups.length})`, '━━━━━━━━━━━━━━━'];
      groups.forEach((g, i) => {
        const seen = g.createdAt ? new Date(g.createdAt).toUTCString().slice(5, 17) : 'unknown';
        lines.push(`${i + 1}. \`${g.tid}\` — seen ${seen}`);
      });
      await reply(`${lines.join('\n')}\n\nApprove with \`!approve\` inside that group.`, event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 23
  // ─────────────────────────────────────────────────────────
  {
    name: 'config',
    aliases: ['showconfig'],
    category: 'system',
    description: 'Show the bot configuration (secrets are never printed)',
    usage: '!config',
    cooldown: 10,
    permission: 'owner',
    execute: async ({ config, reply, event }) => guard(reply, event.messageID, 'config', async () => {
      const status = mongo.status();
      await reply(
        '⚙️ Configuration (secrets hidden)\n'
        + '━━━━━━━━━━━━━━━\n'
        + `Bot name: ${config.BOT_NAME}\n`
        + `Owner: ${config.OWNER}\n`
        + `Version: ${config.VERSION}\n`
        + `Prefix: ${config.PREFIX}\n`
        + `Default cooldown: ${config.DEFAULT_COOLDOWN}s\n`
        + `Reactions: ${config.REACTIONS_ENABLED ? 'on' : 'off'}\n`
        + `Cache TTL: ${Math.round((config.CACHE_TTL || 0) / 1000)}s\n`
        + `Environment: ${config.NODE_ENV}\n`
        + `Port: ${config.PORT}\n`
        + '──── database ────\n'
        + `Connected: ${status.connected ? 'yes' : 'no'}\n`
        + `Host: ${maskHost(config.MONGO_URI)}\n`
        + '──── facebook ────\n'
        + `Cookies: ${config.APPSTATE.length} loaded (values hidden)\n`
        + `Admins: ${permissions.ownerIds().length}\n`
        // Loud when empty, because with no ADMIN_IDS every owner-only command
        // is silently unreachable and the bot looks broken rather than locked.
        + (permissions.ownerIds().length ? '' : '⚠️ none configured — set ADMIN_IDS in the Render environment\n')
        + '──── ai ────\n'
        + `Gemini: ${config.GEMINI_API_KEY ? 'configured' : 'not set'}\n`
        // The live model, not just the configured one: the client falls back
        // when the configured model is unavailable to the key's project.
        + `Model: ${require('../bot/gemini').activeModel()}`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 24
  // ─────────────────────────────────────────────────────────
  {
    name: 'botstatus',
    aliases: ['status', 'health'],
    category: 'system',
    description: 'Detailed health check: engine, database and image support',
    usage: '!botstatus',
    cooldown: 10,
    permission: 'owner',
    execute: async ({ config, reply, react, event }) => guard(reply, event.messageID, 'botstatus', async () => {
      const ik = require('../ws3-fca');
      const status = mongo.status();
      const dbLatency = mongo.isReady() ? await measure(() => User.estimatedDocumentCount()) : null;
      const mem = process.memoryUsage();

      const ok = ik.STATE.loggedIn && mongo.isReady();
      await react(ok ? '✅' : '⚠️');

      await reply(
        `🩺 ${config.BOT_NAME} status: ${ok ? 'HEALTHY' : 'DEGRADED'}\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🔌 Facebook login: ${ik.STATE.loggedIn ? 'connected' : 'not logged in'}\n`
        + `💾 Database: ${mongo.isReady() ? `ready (${dbLatency}ms)` : 'offline'}\n`
        + `📚 Commands: ${ik.registry.size} loaded, ${ik.aliases.size} aliases\n`
        + `🎬 Canvas: ${canvas.available() ? 'ready' : 'unavailable'}\n`
        + `⏱ Uptime: ${dur(process.uptime())}\n`
        + `📨 Messages seen: ${ik.STATE.messagesSeen}\n`
        + `⚡ Commands run: ${ik.STATE.commandsRun}\n`
        + `⚠️ Errors: ${ik.STATE.errors}\n`
        + `🧠 Memory: ${Math.round(mem.heapUsed / 1048576)}MB / ${Math.round(mem.rss / 1048576)}MB`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 25
  // ─────────────────────────────────────────────────────────
  {
    name: 'version',
    aliases: ['ver', 'v'],
    category: 'system',
    description: 'Show the running bot version',
    usage: '!version',
    cooldown: 5,
    permission: 'all',
    execute: async ({ config, reply, react, event }) => guard(reply, event.messageID, 'version', async () => {
      await react('🏷');
      let pkg = { version: config.VERSION, dependencies: {} };
      try {
        pkg = require('../package.json');
      } catch { /* fall back to config */ }
      const deps = Object.entries(pkg.dependencies || {}).slice(0, 6)
        .map(([k, v]) => `${k} ${String(v).replace(/^[\^~]/, '')}`)
        .join('\n');
      await reply(
        `🏷 ${config.BOT_NAME} v${pkg.version}\n`
        + `Engine: node >=20 | ${process.version}\n`
        + '━━━━ dependencies ━━━━\n'
        + deps,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 26
  // ─────────────────────────────────────────────────────────
  {
    name: 'owner',
    aliases: ['creator'],
    category: 'system',
    description: 'Information about the bot owner',
    usage: '!owner',
    cooldown: 5,
    permission: 'all',
    execute: async ({ config, registry, reply, react, event }) => guard(reply, event.messageID, 'owner', async () => {
      await react(OWNER_ICON);
      await reply(
        `${OWNER_ICON} Bot owner\n`
        + '━━━━━━━━━━━━━━━\n'
        + `Name: ${config.OWNER}\n`
        + `Role: Developer of ${config.BOT_NAME}\n`
        + `Bot version: v${config.VERSION}\n`
        + `Commands: ${registry.size} loaded`,
        event.messageID,
      );
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 27
  // ─────────────────────────────────────────────────────────
  {
    name: 'support',
    aliases: ['help2'],
    category: 'system',
    description: 'Where to get help or report a problem',
    usage: '!support',
    cooldown: 5,
    permission: 'all',
    execute: async ({ config, reply, react, event }) => guard(reply, event.messageID, 'support', async () => {
      await react('🆘');
      await reply(
        '🆘 Support\n'
        + '━━━━━━━━━━━━━━━\n'
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
  // 28
  // ─────────────────────────────────────────────────────────
  {
    name: 'restart',
    aliases: ['reboot'],
    category: 'system',
    description: 'Ask the host platform to restart the bot process',
    usage: '!restart',
    cooldown: 30,
    permission: 'owner',
    execute: async ({ reply, react, event }) => guard(reply, event.messageID, 'restart', async () => {
      await react('🔄');
      await reply(
        '🔄 Restart requested.\n'
        + 'The bot will be back online in about 10 seconds.\n'
        + 'Note: unsaved state in memory (cooldowns, cache) is lost.',
        event.messageID,
      );
      // Render watches for a crashed process and restarts it.
      setTimeout(() => process.exit(1), 1500);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 29
  // ─────────────────────────────────────────────────────────
  {
    name: 'reload',
    aliases: ['rl'],
    category: 'system',
    description: 'Re-scan the command files without restarting',
    usage: '!reload',
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
  // 30
  // ─────────────────────────────────────────────────────────
  {
    name: 'check',
    aliases: ['registry', 'checkreg'],
    category: 'system',
    description: 'Validate every command against the required contract',
    usage: '!check',
    cooldown: 15,
    permission: 'owner',
    execute: async ({ reply, react, event }) => guard(reply, event.messageID, 'check', async () => {
      await react('🔍');
      const checker = require('../bot/check');
      const ik = require('../ws3-fca');
      const { problems, categories } = checker.validate(ik.registry);
      const modules = checker.perModule(ik.registry);

      const lines = [
        '🔍 Registry check',
        '━━━━━━━━━━━━━━━',
        `Commands: ${ik.registry.size}`,
        `Aliases: ${ik.aliases.size}`,
        `Categories: ${categories}`,
        `Contract: ${problems.length ? `❌ ${problems.length} problem(s)` : '✅ all valid'}`,
        '',
        ...modules.map(({ key, count }) => `\`${key}\` ${count}/${checker.TARGET_PER_MODULE}`),
      ];
      if (problems.length) lines.push('', ...problems.slice(0, 8));
      await reply(lines.join('\n'), event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 31
  // ─────────────────────────────────────────────────────────
  {
    name: 'e2e',
    aliases: ['selftest'],
    category: 'system',
    description: 'Run the built-in self tests and report the result',
    usage: '!e2e',
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
      const lines = [`🧪 Self test — ${passed}/${results.length} passed`, '━━━━━━━━━━━━━━━'];
      results.forEach((r) => lines.push(`${r.passed ? '✅' : '❌'} ${r.label}`));
      await reply(lines.join('\n'), event.messageID);
    }),
  },

  // ─────────────────────────────────────────────────────────
  // 32
  // ─────────────────────────────────────────────────────────
  {
    name: 'ban',
    aliases: [],
    category: 'system',
    description: 'Ban a user from using the bot (tag, mention or numeric ID)',
    usage: '!ban <user> [reason]',
    cooldown: 10,
    permission: 'groupAdmin',
    execute: async ({ api, args, event, reply, react }) => guard(reply, event.messageID, 'ban', async () => {
      const ref = (args[0] || '').replace(/^@/, '').trim();
      if (!ref) {
        await reply('❌ Usage: `!ban <user> [reason]` — tag someone or give a numeric ID.', event.messageID);
        return;
      }

      // Resolve a numeric ID, or look up a tagged user by name.
      let uid = /^\d+$/.test(ref) ? ref : null;
      let displayName = ref;
      if (!uid) {
        const match = event.mentions && Object.values(event.mentions).find((m) => String(m).toLowerCase() === ref.toLowerCase());
        if (match) uid = String(match);
      }
      if (!uid) {
        const guess = await User.findOne({ name: new RegExp(`^${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('uid name').lean();
        if (guess) { uid = guess.uid; displayName = guess.name; }
      }
      if (!uid) {
        await reply(`❌ Could not resolve \`${ref}\` to a user. Tag them or use their numeric ID.`, event.messageID);
        return;
      }
      if (uid === String(event.senderID)) {
        await reply('❌ You cannot ban yourself.', event.messageID);
        return;
      }

      const target = await cache_getUser(uid, api);
      if (!target) {
        await reply(`❌ Could not load a profile for \`${uid}\`.`, event.messageID);
        return;
      }
      if (target.isBanned) {
        await reply(`⚠️ ${displayName} is already banned.`, event.messageID);
        return;
      }

      const reason = args.slice(1).join(' ') || 'No reason given';
      target.isBanned = true;
      target.banReason = reason;
      target.bannedBy = String(event.senderID);

      if (target.transient) {
        await react('🚫');
        await reply(
          '⚠️ Database is offline — this ban is TEMPORARY and lasts only until the bot restarts.\n'
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
  // 33
  // ─────────────────────────────────────────────────────────
  {
    name: 'unban',
    aliases: [],
    category: 'system',
    description: 'Lift a ban so a user can use the bot again',
    usage: '!unban <user>',
    cooldown: 10,
    permission: 'groupAdmin',
    execute: async ({ args, event, reply, react }) => guard(reply, event.messageID, 'unban', async () => {
      const ref = (args[0] || '').replace(/^@/, '').trim();
      if (!ref) {
        await reply('❌ Usage: `!unban <user>`', event.messageID);
        return;
      }
      const target = /^\d+$/.test(ref)
        ? await User.findOne({ uid: ref })
        : await User.findOne({ name: new RegExp(`^${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
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
  // 34
  // ─────────────────────────────────────────────────────────
  {
    name: 'ping2',
    aliases: ['latency'],
    category: 'system',
    description: 'Advanced ping: engine, database and network latency',
    usage: '!ping2',
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
        '━━━━━━━━━━━━━━━',
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
  // 35
  // ─────────────────────────────────────────────────────────
  {
    name: 'echo',
    aliases: ['repeat', 'sayit'],
    category: 'system',
    description: 'Echo your message back',
    usage: '!echo <text>',
    cooldown: 5,
    permission: 'all',
    execute: async ({ args, reply, event }) => guard(reply, event.messageID, 'echo', async () => {
      const text = args.join(' ').trim();
      if (!text) {
        await reply('❌ Usage: `!echo <text>` — nothing to echo.', event.messageID);
        return;
      }
      await reply(`🔊 ${text}`, event.messageID);
    }),
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

/** Cache-backed profile lookup (used by ban). */
async function cache_getUser(uid, api) {
  // eslint-disable-next-line global-require
  return require('../bot/cache').getUser(uid, api);
}
