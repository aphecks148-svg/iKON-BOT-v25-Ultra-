'use strict';

/**
 * Command parser (PARSER stage of the chain).
 *
 * parse("!ping", "!")      -> { name: "ping", args: [] }
 * parse("!bank deposit 50","!") -> { name: "bank", args: ["deposit","50"] }
 * parse("hello", "!")      -> null
 * parse(".catch", "!")     -> { name: "catch", args: [] }
 */

/**
 * Commands that answer to a leading dot whatever the configured prefix is.
 *
 * `.catch` is the whole reason this exists: the spawner prints "first to run
 * `.catch`", and a reader whose prefix is `!` types exactly what they were told
 * and gets silence. A dot reads as "chat-wide, not addressed to a bot" in every
 * group the bot is in, so it is honoured regardless of PREFIX.
 *
 * Only names listed here are recognised with a dot. Without the allow-list a
 * message starting with "." — a URL, a decimal, an ellipsis — would be parsed as
 * a command on every single message the bot sees.
 */
const DOT_COMMANDS = new Set(['catch', 'pokemon']);

/** Split a prefix-free message body into a command name and its args. */
function shape(text, raw = text) {
  const parts = text.split(/\s+/);
  const name = (parts.shift() || '').toLowerCase();
  if (!name) return null;
  return { name, args: parts, raw };
}

/**
 * @param {string} body raw message text
 * @param {string} prefix command prefix, e.g. "!"
 * @returns {{name:string,args:string[],raw:string}|null}
 */
function parse(body, prefix = '!') {
  if (typeof body !== 'string') return null;

  const text = body.trim();
  if (!text) return null;
  if (!prefix) return null;

  // Trim before splitting. " pet".split(/\s+/) is ["", "pet"], so shifting the
  // name yields an empty string and the `!name` guard below rejected the whole
  // message — which is why `! pet` and `! profile` did nothing at all while
  // `!ping` worked. A prefix is a prefix; the space after it is nobody's
  // business.
  if (text.startsWith(prefix)) {
    const withoutPrefix = text.slice(prefix.length).trim();
    if (!withoutPrefix) return null;
    return shape(withoutPrefix);
  }

  // The dot fallback, checked only when the configured prefix did not match.
  if (prefix !== '.' && text.startsWith('.')) {
    const dotted = shape(text.slice(1), text);
    if (dotted && DOT_COMMANDS.has(dotted.name)) return dotted;
  }

  return null;
}

/** Convenience: parse then resolve against an alias map. */
function resolve(body, prefix, aliases) {
  const parsed = parse(body, prefix);
  if (!parsed) return null;
  const target = aliases.get(parsed.name) || parsed.name;
  return { ...parsed, commandName: target };
}

module.exports = { parse, resolve, DOT_COMMANDS };
