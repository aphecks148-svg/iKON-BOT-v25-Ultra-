'use strict';

/**
 * MODULE 1 — SYSTEM CORE
 * Exports a plain array of command objects.
 *
 * Shape required for every command:
 * { name, aliases, category, description, usage, cooldown, permission, execute }
 *
 * execute receives: { api, event, args, config, registry, reply, react, userDoc }
 */

module.exports = [
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
];
