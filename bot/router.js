'use strict';

/**
 * Command parser (PARSER stage of the chain).
 *
 * parse("!ping", "!")      -> { name: "ping", args: [] }
 * parse("!bank deposit 50","!") -> { name: "bank", args: ["deposit","50"] }
 * parse("hello", "!")      -> null
 */

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
  if (!text.startsWith(prefix)) return null;

  // Trim before splitting. " pet".split(/\s+/) is ["", "pet"], so shifting the
  // name yields an empty string and the `!name` guard below rejected the whole
  // message — which is why `! pet` and `! profile` did nothing at all while
  // `!ping` worked. A prefix is a prefix; the space after it is nobody's
  // business.
  const withoutPrefix = text.slice(prefix.length).trim();
  if (!withoutPrefix) return null;

  // Only the first token is the command name; everything else is args.
  const parts = withoutPrefix.split(/\s+/);
  const name = (parts.shift() || '').toLowerCase();
  if (!name) return null;

  return { name, args: parts, raw: text };
}

/** Convenience: parse then resolve against an alias map. */
function resolve(body, prefix, aliases) {
  const parsed = parse(body, prefix);
  if (!parsed) return null;
  const target = aliases.get(parsed.name) || parsed.name;
  return { ...parsed, commandName: target };
}

module.exports = { parse, resolve };
