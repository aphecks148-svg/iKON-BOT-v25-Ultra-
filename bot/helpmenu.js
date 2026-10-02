'use strict';

/**
 * Rendering for `!help`, `!hints` and friends.
 *
 * The house style, and the reason it exists:
 *
 *   • NO BOXES. No ┌ ─ │ └ ┐. A grid of characters is unreadable on a phone,
 *     wraps at whatever width the phone happens to be, and looks like a
 *     screenshot of a terminal. Everything here is emoji, bold, italic and
 *     monospace instead — all of which reflow properly and are what people
 *     already read all day.
 *   • Emojis carry the meaning. ⚙️ says "settings" faster than any word does,
 *     and they are the only part of a message that is instantly scannable.
 *   • Symbols as accents, not as structure. ❖ ✦ ◈ appear in headers as a
 *     flourish; they never form a frame.
 *   • Bold for what the reader should act on, italics for asides, `mono` for
 *     anything they have to type exactly.
 *   • Every page ends with a hint, because a menu with no next step is just a
 *     list.
 *
 * Pages are short on purpose. The old `!help` sent all 351 command names in one
 * message; on a phone that is a wall of text nobody scrolls. Each page is
 * capped, and every page says how to reach the rest.
 */

const categories = require('./categories');

/** Messenger's message body limit. Staying well under it leaves room for the footer. */
const PAGE_LIMIT = 2800;

/**
 * How many commands one deck page shows.
 *
 * Paging is done by line count rather than by measuring the message, because
 * the caller has to slice the command list to the same boundary or the footer
 * says "page 2" while the body still shows page 1. 26 keeps a full page near
 * 2,000 characters with the deck blurb, rule and hints on top.
 */
const PAGE_SIZE = 26;

/**
 * Characters that would look like a box if we drew one. This module must never
 * emit them — `!check` and the test suite both assert it.
 */
const BOX_CHARS = /[─-╿▀-▟]/;

/** A mid-weight rule. One line, no frame. */
const RULE = '· · ·';

/** Emoji that mean "you need permission for this". */
const PERMISSION_ICON = {
  all: '🌍',
  owner: '👑',
  groupAdmin: '🛡️',
};

const PERMISSION_LABEL = {
  all: 'anyone',
  owner: 'bot owner only',
  groupAdmin: 'group admins',
};

/** Longest command name, so the mono column lines up. */
function columnWidth(commands) {
  return commands.reduce((n, c) => Math.max(n, graphemes(c.name).length), 0);
}

/** Does this description already start with a picture? */
const HAS_EMOJI = /^\p{Extended_Pictographic}/u;

/**
 * Split text into user-perceived characters.
 *
 * This has to be grapheme clusters, not code points. `✍️` is three code points
 * (the pencil, a variation selector that says "render me as emoji", and — in
 * longer sequences — zero-width joiners). Taking the first code point and
 * calling it an icon yields a pencil followed by a floating invisible
 * variation selector, which is exactly the kind of invisible garbage that
 * makes a message look broken.
 */
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : null;

/** @returns {string[]} grapheme clusters */
function graphemes(text) {
  const s = String(text == null ? '' : text);
  if (segmenter) return Array.from(segmenter.segment(s), (x) => x.segment);
  // No Intl.Segmenter: fall back to code points, keeping any variation selector
  // or joiner glued to the character it belongs to.
  return s.match(/\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic})*|./gsu) || [];
}

/** The leading emoji of a string, or '' when it does not start with one. */
function firstEmoji(text) {
  const g = graphemes(text);
  return g.length && HAS_EMOJI.test(g[0]) ? g[0] : '';
}

/**
 * The icon for a command: its own if it has one, otherwise its category's.
 *
 * 315 of 351 commands already lead their description with an emoji. The rest
 * would render as a bare word in the index, so they inherit their category's
 * icon rather than showing nothing.
 *
 * @param {object} cmd
 * @returns {string}
 */
function iconFor(cmd) {
  const own = firstEmoji(cmd.description);
  if (own) return own;
  return categories.get(cmd.category).emoji;
}

/**
 * The description with any leading emoji stripped, so it can be re-prefixed
 * with a consistent icon without ending up as "⚙️ ⚙️ System".
 *
 * @param {object} cmd
 * @returns {string}
 */
function blurbFor(cmd) {
  const desc = String(cmd.description || '').trim();
  const own = firstEmoji(desc);
  return own ? desc.slice(own.length).trim() : desc;
}

/**
 * A hint for one command: its own, or nothing.
 *
 * Not inherited from the deck on purpose — see bot/loader.js. A page with no
 * hint is better than a page whose hint is about a different command.
 *
 * @param {object} cmd
 * @returns {string}
 */
function hintFor(cmd) {
  return String(cmd.hint || '').trim();
}

/** `!prefix kick` → `!kick`, so help text always uses the live prefix. */
function usageFor(cmd, prefix) {
  const usage = String(cmd.usage || '').trim();
  // usage is stored with whatever prefix existed when the command was written,
  // and that is usually '!'. The live prefix wins, because a help page that
  // says !kick in a group that uses / is worse than no help at all — it teaches
  // a prefix that does not work. Strip the leading run of punctuation (whatever
  // character the group picked) rather than guessing which ones count.
  return usage.replace(/^[^\p{L}\p{N}]+/u, prefix) || `${prefix}${cmd.name}`;
}

/**
 * Placeholders in a usage line, replaced with something a person could type.
 *
 * Copying `<user>` verbatim is the fastest route to "nobody found", and
 * `[reason]` looks like a flag. Showing `!kick @someone spamming` teaches the
 * shape of the command; showing `!kick @user [reason]` teaches nothing.
 */
const PLACEHOLDER = [
  [/<user>/gi, '@someone'], [/<name>/gi, '@someone'], [/<reason>/gi, 'spamming'],
  [/<text>/gi, 'hello there'], [/<url>/gi, 'a link'], [/<name1>/gi, '@someone'],
  [/<name2>/gi, '@someone else'], [/<amount>/gi, '100'], [/<id>/gi, 'their id'],
  [/\[reason\]/gi, 'spamming'], [/\[message\]/gi, 'hello there'],
  [/\[text\]/gi, 'hello there'], [/\[amount\]/gi, '100'],
  [/@user\b/g, '@someone'], [/@name\b/g, '@someone'],
];

/** A usage line with the placeholders swapped for something copyable. */
function exampleFrom(usage) {
  let out = String(usage);
  for (const [re, swap] of PLACEHOLDER) out = out.replace(re, swap);
  return out;
}

/**
 * Render one page of commands as `emoji  name  blurb` lines.
 *
 * @param {object[]} commands
 * @param {string} prefix
 * @returns {string[]}
 */
function commandLines(commands, prefix) {
  const width = columnWidth(commands);
  return commands.map((cmd) => {
    const name = `${prefix}${cmd.name}`;
    const blurb = blurbFor(cmd);
    // The padding goes outside the backticks. Inside, it becomes part of the
    // rendered code and every row carries a tail of meaningless spaces.
    return `${iconFor(cmd)} \`${name}\`${' '.repeat(Math.max(1, width - graphemes(name).length + 2))}  ${blurb}`;
  });
}

/**
 * Split a deck into pages of commands.
 *
 * This pages over the command LIST, not over rendered lines, and that is the
 * whole point. The caller needs the same page boundaries the renderer uses in
 * order to slice the list it renders; if the two computed that separately — one
 * by line count, one by character count — the footer would say "page 2 of 2"
 * while the body still showed page 1. Returning the pages themselves makes that
 * class of bug impossible.
 *
 * @param {object[]} commands
 * @param {string} prefix
 * @returns {object[][]} one array of commands per page, never empty
 */
function paginate(commands, prefix) {
  const list = [...commands];
  if (!list.length) return [[]];
  const pages = [];
  for (let i = 0; i < list.length; i += PAGE_SIZE) {
    pages.push(list.slice(i, i + PAGE_SIZE));
  }
  // A page whose lines would overflow the message limit gets split again, so a
  // pathologically long description cannot produce an unsendable message.
  return pages.flatMap((page) => {
    if (commandLines(page, prefix).join('\n').length <= PAGE_LIMIT) return [page];
    const half = Math.ceil(page.length / 2);
    return paginate(page.slice(0, half), prefix).length && [page.slice(0, half), page.slice(half)]
      .filter((p) => p.length);
  });
}

/**
 * The front page: every category, what is in it, and how to open it.
 *
 * @param {object} opts
 * @param {Map} opts.byCategory commands grouped by category key
 * @param {number} opts.total total commands
 * @param {string} opts.prefix
 * @param {string} [opts.botName]
 * @param {number} [opts.aliases]
 * @returns {string}
 */
function indexPage({ byCategory, total, prefix, botName, aliases = 0 }) {
  const lines = [
    `📚 **${botName} — Command Deck**`,
    `*${total} commands${aliases ? ` · ${aliases} aliases` : ''} across ${byCategory.size} decks*`,
    '',
  ];

  for (const key of categories.ORDER) {
    const cat = categories.get(key);
    const list = byCategory.get(key) || [];
    if (!list.length) continue;
    lines.push(`${cat.emoji} **${cat.symbol} ${cat.label}**  ·  ${list.length}`);
    lines.push(`  ${cat.blurb}`);
    lines.push(`  \`${prefix}help ${key}\``);
    lines.push('');
  }

  lines.push(RULE);
  lines.push(`💡 \`${prefix}help <command>\` — one command in detail`);
  lines.push(`💡 \`${prefix}hints\` — how to get the most out of all of it`);
  return lines.join('\n');
}

/**
 * One category: what it is, every command in it, and a hint.
 *
 * @param {object} opts
 * @param {object} opts.cat category metadata
 * @param {object[]} opts.commands
 * @param {string} opts.prefix
 * @param {number} [opts.page] 1-based
 * @param {number} [opts.pages]
 * @param {boolean} [opts.collidesWith] a command in this deck has the same name
 * @returns {string}
 */
function categoryPage({ cat, commands, prefix, page = 1, pages = 1, collidesWith = false }) {
  // `commands` is the slice for THIS page, not the whole deck. Rendering the
  // whole deck here is what made `!help pets` a 3,200-character wall while its
  // own footer cheerfully claimed "Page 1 of 2".
  const lines = [
    `${cat.emoji} **${cat.symbol} ${cat.label}**`,
    `*${cat.blurb}*`,
    '',
    ...commandLines(commands, prefix),
    '',
    RULE,
  ];

  if (cat.hint) lines.push(`💡 ${cat.hint}`);
  const more = pages > 1 ? `\n📄 Page ${page}/${pages} — \`${prefix}help ${cat.key} ${page + 1}\` for more` : '';
  lines.push(`↩️ \`${prefix}help\` — all decks${more}`);

  // `economy` is a deck and a command at once. The deck wins on `!help economy`,
  // so the page has to say the command is still one hop away — otherwise the
  // only way to read `!economy`'s own help is to already know it exists.
  if (collidesWith) {
    lines.push(`⚠️ \`${prefix}${cat.key}\` is also a command — \`${prefix}help cmd ${cat.key}\` opens that one.`);
  }
  return lines.join('\n');
}

/**
 * One command, in full: what it is, how to call it, what it costs, and a hint.
 *
 * @param {object} opts
 * @param {object} opts.cmd
 * @param {string} opts.prefix
 * @param {object} [opts.cat] override category metadata
 * @returns {string}
 */
function commandPage({ cmd, prefix, cat = categories.get(cmd.category) }) {
  const usage = usageFor(cmd, prefix);
  const aliases = (cmd.aliases || []).filter((a) => a !== cmd.name);
  const icon = iconFor(cmd);

  // A command that borrows its category's icon must not then have that same
  // icon printed beside it again — "⚙️ ⚙️ !ping" reads like a mistake.
  const heading = icon === cat.emoji ? `**\`${usage}\`**` : `**${cat.emoji} \`${usage}\`**`;

  const lines = [
    `${icon} ${heading}`,
    `*${blurbFor(cmd) || 'No description yet.'}*`,
    '',
  ];

  const example = exampleFrom(usage);
  if (example !== usage) {
    lines.push(`✏️ Try: \`${example}\``);
  } else if (usage.includes(' ')) {
    lines.push(`✏️ Try: \`${usage}\``);
  }

  const rows = [
    `${PERMISSION_ICON[cmd.permission] || '🔑'} \`${PERMISSION_LABEL[cmd.permission] || cmd.permission}\``,
    `⏱️ ${cmd.cooldown}s between uses`,
    `📂 ${cat.label}`,
  ];
  if (aliases.length) rows.push(`🔗 also \`${prefix}${aliases.join('` `')}\``);

  lines.push('', ...rows);

  const hint = hintFor(cmd);
  if (hint) lines.push('', `💡 ${hint}`);
  lines.push(`↩️ \`${prefix}help ${cat.key}\` — the rest of ${cat.label}`);
  return lines.join('\n');
}

/**
 * The tips page. Deliberately full of things that are not obvious from the
 * command name, because that is what a hint is for.
 *
 * @param {object} opts
 * @param {string} opts.prefix
 * @param {object} [opts.decks] category metadata, to link each tip to its deck
 * @returns {string}
 */
function hintsPage({ prefix, decks = categories.CATEGORIES }) {
  const tips = [
    ['🏷️', 'Tag people, do not type names', `Commands that act on someone read \`${prefix}help <command>\` — but they resolve fastest and most reliably from an actual @tag.`],
    ['🎯', 'Every command has a detail page', `\`${prefix}help kick\` shows usage, cooldown and permission before you spend the cooldown discovering them.`],
    ['👑', 'Owner commands look owner-only on purpose', `A grey padlock means only the bot owner can run it. If you are the owner and it refuses, \`OWNER_ID\` is not set.`],
    ['🛡️', 'Admin commands need group admin', `Green shield means any group admin. That is checked against the live admin list, not a cached one.`],
    ['⏱️', 'Cooldowns are per command', `Each command times out separately. Waiting on \`!work\` does not delay \`!farm\`.`],
    ['🔕', 'Disable what a group does not use', `\`${prefix}disablecmd <name>\` and \`${prefix}disablemod <module>\` are how you quiet a busy room.`],
    ['🌍', 'Nothing here needs the bot to be admin', 'Only the commands that actually remove or promote someone need bot admin. The rest work anywhere.'],
    ['💬', 'Every command replies to the message', `Replying to a reply keeps the conversation together instead of scattering replies across the chat.`],
  ];

  const lines = ['💡 **Hints & shortcuts**', '*Things that are not obvious from the command name*', ''];
  for (const [icon, title, body] of tips) {
    lines.push(`${icon} **${title}**`);
    lines.push(`   ${body}`);
    lines.push('');
  }

  lines.push(RULE);
  lines.push(`🗂️ Browse a deck: \`${prefix}help\` for the full list of ${decks.length}.`);
  return lines.join('\n');
}

/**
 * A "did you mean" line for an unknown topic, offering the closest decks.
 *
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} opts.prefix
 * @returns {string}
 */
function noSuchThing({ query, prefix }) {
  const q = String(query || '').trim();
  // Anything that shares a letter with a deck name is probably a typo of it.
  const near = categories.CATEGORIES
    .map((c) => {
      const target = c.key.toLowerCase();
      let score = 0;
      for (const ch of new Set(q.toLowerCase())) if (target.includes(ch)) score += 1;
      return { cat: c, score };
    })
    .filter((x) => x.score >= Math.max(2, Math.ceil(q.length / 2)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => `\`${prefix}help ${x.cat.key}\``);

  const lines = [`🔍 Nothing here is called \`${q}\`.`];
  if (near.length) lines.push('', `Did you mean ${near.join(' · ')}?`);
  lines.push('', `↩️ \`${prefix}help\` — all ${categories.CATEGORIES.length} decks`);
  return lines.join('\n');
}

module.exports = {
  PAGE_SIZE,
  iconFor,
  blurbFor,
  hintFor,
  usageFor,
  commandLines,
  paginate,
  indexPage,
  categoryPage,
  commandPage,
  hintsPage,
  noSuchThing,
  BOX_CHARS,
  RULE,
};