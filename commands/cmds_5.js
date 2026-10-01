'use strict';

/**
 * MODULE 5 — GAMES (35 commands)
 *
 * iKON-BOT v2 Ultra. The arcade in iKON City is the only place the Klerks
 * still gamble against each other instead of paperwork. Every game here moves
 * real K-Cash, so the money path is the part that matters most: a wager is
 * taken before a result is known, and a pot is only ever paid out from coins
 * that were actually collected.
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
const Economy = require('../models/Economy');
const Group = require('../models/Group');
const cache = require('../bot/cache');
const mongo = require('../bot/mongo');
const { fmt } = require('../bot/helpers');

const CASH = 'K-Cash';
const ULTRA = 'iKON-BOT v2 Ultra';
const BROKE = `💸 **Broke ass.** Farm \`!daily\` (10,000), \`!hourly\` (2,500) first.`;

// ───────────────────────────────────────────────────────────
// CONTENT TABLES
// ───────────────────────────────────────────────────────────

const EIGHT_BALL = [
  'It is certain.', 'It is decidedly so.', 'Without a doubt.', 'Yes — definitely.',
  'You may rely on it.', 'As I see it, yes.', 'Most likely.', 'Outlook good.',
  'Yes.', 'Signs point to yes.', 'Reply hazy, try again.', 'Ask again later.',
  'Better not tell you now.', 'Cannot predict now.', 'Concentrate and ask again.',
  'Do not count on it.', 'My reply is no.', 'My sources say no.', 'Outlook not so good.',
  'Very doubtful.', 'Absolutely not.', 'Never.', 'The arcade is closed. Come back tomorrow.',
  'A coin flip would answer this better.', 'Ask Owner Aphecks. He will not answer either.',
];

const TRIVIA = [
  { q: 'Which gas do plants absorb during photosynthesis?', a: ['carbon dioxide', 'co2', 'co2'] },
  { q: 'How many bones are in the adult human body?', a: ['206', 'two hundred and six'] },
  { q: 'What is the capital of Japan?', a: ['tokyo'] },
  { q: 'Which planet is known as the Red Planet?', a: ['mars'] },
  { q: 'Who wrote "1984"?', a: ['george orwell', 'orwell'] },
  { q: 'What is the smallest prime number?', a: ['2', 'two'] },
  { q: 'How many continents are there?', a: ['7', 'seven'] },
  { q: 'What does CPU stand for?', a: ['central processing unit'] },
  { q: 'Which element has the symbol Au?', a: ['gold'] },
  { q: 'How many minutes are in a full day?', a: ['1440', 'one thousand four hundred and forty'] },
  { q: 'What is the hardest natural substance?', a: ['diamond', 'diamonds'] },
  { q: 'In which year did the Berlin Wall fall?', a: ['1989'] },
  { q: 'What is the largest ocean?', a: ['pacific', 'the pacific'] },
  { q: 'Who painted the Mona Lisa?', a: ['leonardo da vinci', 'da vinci'] },
  { q: 'What is the square root of 144?', a: ['12', 'twelve'] },
];

const RIDDLES = [
  { q: 'I have keys but no locks, space but no room. You can enter, but you cannot exit. What am I?', a: ['keyboard'] },
  { q: 'The more you take, the more you leave behind. What am I?', a: ['footsteps', 'foot steps', 'steps'] },
  { q: 'What has a head, a tail, is brown, and has no body?', a: ['coin', 'a coin', 'money'] },
  { q: 'What can travel around the world while staying in a corner?', a: ['stamp', 'a stamp', 'postage stamp'] },
  { q: 'What has hands but cannot clap?', a: ['clock', 'a clock'] },
  { q: 'What gets wetter the more it dries?', a: ['towel', 'a towel'] },
  { q: 'I am tall when I am young and short when I am old. What am I?', a: ['candle', 'a candle'] },
  { q: 'What has many teeth but cannot bite?', a: ['comb', 'a comb', 'zipper'] },
  { q: 'What runs but never walks, has a bed but never sleeps?', a: ['river', 'a river'] },
];

const QUOTES = [
  { text: 'We are what we repeatedly do. Excellence, then, is not an act, but a habit.', author: 'Aristotle' },
  { text: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' },
  { text: 'Simplicity is the ultimate sophistication.', author: 'Leonardo da Vinci' },
  { text: 'It always seems impossible until it is done.', author: 'Nelson Mandela' },
  { text: 'The best way to predict the future is to invent it.', author: 'Alan Kay' },
  { text: 'Discipline is choosing between what you want now and what you want most.', author: 'Abraham Lincoln' },
  { text: 'Everything should be made as simple as possible, but not simpler.', author: 'Albert Einstein' },
  { text: 'Do not watch the clock. Do what it does and keep going.', author: 'Sam Rayburn' },
];

const JOKES = [
  'A slime walks into a bar. The barkeeper says "We do not serve your kind." The slime says "So pour me a drink instead."',
  'Why do programmers prefer dark mode? Because light attracts bugs.',
  'I told my wife I was checking the smoke alarm. She said "Good, it has been beeping for six hours."',
  'The vault asked the robber for a password. He said "letmein". The vault said "close, but that is the WiFi."',
  'Owner Aphecks programmed the arcade door. It only opens for people who have paid their taxes. Nobody can get in.',
  'A Klerk asked the casino why the slot machines hum. "Because," said the owner, "they are thinking about it."',
  'Why was the math book sad? It had too many problems.',
  'I would tell you a UDP joke, but you might not get it.',
];

const STORY = [
  'The iKON streetlights hum one octave lower tonight.',
  'Somewhere in the vault district, a vault alarm tests itself.',
  'Owner Aphecks has not blinked in six hours.',
  'Rain taps the academy roof like it wants in.',
  'A Klerk courier runs past without looking up.',
  'The neon signs flicker in a pattern that means nothing.',
  'Somebody left a crate of K-Cash on the corner. Nobody moves it.',
  'The factory siren goes unanswered again.',
  'A fight breaks out near the slots. It ends quickly.',
  'The house always smiles. That is the warning.',
];

// ───────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────

/** Run a handler with a user-facing safety net. */
async function guard(reply, messageID, label, fn) {
  try {
    await fn();
  } catch (err) {
    await reply(`⚠️ \`${label}\` failed: ${err.message}`, messageID);
  }
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rand(0, arr.length - 1)];
const clamp = (v) => Math.max(0, Math.floor(Number(v) || 0));
const kc = (v) => `${Number(v || 0).toLocaleString('en-US')} ${CASH}`;
const num = (v) => Number(v || 0).toLocaleString('en-US');
const story = () => pick(STORY);

/** Persist a document, tolerating offline mode. */
async function save(doc) {
  if (!doc || doc.transient) return;
  try {
    await doc.save();
  } catch { /* the reply still shows the outcome */ }
}

/** Append one line to the audit ledger. Never throws. */
async function ledger(uid, action, amount, balanceAfter, metadata = {}) {
  if (!mongo.isReady()) return;
  try {
    await new Economy({ uid, action, amount, balanceAfter, metadata }).save();
  } catch { /* auditing is best effort */ }
}

/**
 * The per-user games record, backfilled field by field.
 *
 * Backfilling the whole object at once is not enough: an older document can
 * have `games` present but a field missing, and `undefined + 1` is NaN, which
 * would then persist straight into the leaderboards.
 */
function g(userDoc) {
  if (!userDoc.games || typeof userDoc.games !== 'object') userDoc.games = {};
  const rec = userDoc.games;
  for (const f of ['wins', 'losses', 'wagered', 'bestWin', 'luckyCharm', 'streak', 'towerFloor', 'towerBest', 'godWins']) {
    if (!Number.isFinite(rec[f])) rec[f] = 0;
  }
  if (!Number.isFinite(rec.lastPlayed)) rec.lastPlayed = null;
  return rec;
}

/** Take a bet. Returns { ok } or { ok:false, reason } so callers can reply. */
async function wager(userDoc, amount, action) {
  if (amount <= 0) return { ok: false, reason: '❌ Bet must be more than 0.' };
  if ((userDoc.coins || 0) < amount) return { ok: false, reason: BROKE };

  userDoc.coins = clamp(userDoc.coins - amount);
  const rec = g(userDoc);
  rec.wagered = clamp(rec.wagered) + amount;
  rec.lastPlayed = new Date();
  await save(userDoc);
  await ledger(userDoc.uid, action, -amount, userDoc.coins, { bet: amount });
  return { ok: true };
}

/** Pay a winner. Returns the new wallet. */
async function payout(userDoc, amount, action, metadata = {}) {
  userDoc.coins = clamp((userDoc.coins || 0) + amount);
  const rec = g(userDoc);
  rec.wins = clamp(rec.wins) + 1;
  rec.streak = clamp(rec.streak) + 1;
  if (amount > clamp(rec.bestWin)) rec.bestWin = amount;
  await save(userDoc);
  await ledger(userDoc.uid, action, amount, userDoc.coins, metadata);
  return userDoc.coins;
}

/** Record a loss. The coins were already taken by wager(). */
async function recordLoss(userDoc, action) {
  const rec = g(userDoc);
  rec.losses = clamp(rec.losses) + 1;
  rec.streak = 0;
  await save(userDoc);
  await ledger(userDoc.uid, action, 0, userDoc.coins, { lost: true });
}

/** Permanent luck bonus, as a probability nudge. Capped so it stays a nudge. */
function luck(userDoc) {
  return Math.min(0.15, clamp(g(userDoc).luckyCharm) * 0.01);
}

/**
 * Parse a bet amount.
 *
 * Deliberately does NOT clamp to the wallet: an unaffordable bet must be
 * refused with the "Broke ass" line rather than quietly shrunk to whatever the
 * hunter can afford, or a typo silently wipes their whole balance.
 */
function betArg(args, fallback) {
  const raw = Number.parseInt(
    String(args[0] || '').replace(/[,k]/gi, (m) => (m.toLowerCase() === 'k' ? '000' : '')),
    10,
  );
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return raw;
}

/** Resolve @tag, raw uid, or exact name to a User document. */
async function resolveTarget(ref, event) {
  const clean = String(ref || '').replace(/^@/, '').trim();
  if (!clean) return null;
  if (/^\d+$/.test(clean)) return User.findOne({ uid: clean });

  const tagged = event.mentions && Object.values(event.mentions).find((m) => String(m) === clean);
  if (tagged) return User.findOne({ uid: String(tagged) });

  const safe = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return User.findOne({ name: new RegExp(`^${safe}$`, 'i') });
}

/** resolveTarget with the two failure replies already sent. */
async function targetOr(reply, messageID, ref, event, label) {
  if (!ref) {
    await reply(`❌ Usage: \`!${label} <user> [amount]\` — tag a hunter or use their ID.`, messageID);
    return null;
  }
  const target = await resolveTarget(ref, event);
  if (!target) {
    await reply(`❌ No hunter found for \`${ref}\`.`, messageID);
    return null;
  }
  return target;
}

/** Refuse the command when the hunter is banned from the arcade. */
async function bannedCheck(reply, userDoc, event) {
  const left = cache.gameBanLeft(userDoc.uid);
  if (left <= 0) return false;
  await reply(
    `🚫 **THE ARCADE HAS BANNED YOU**\n`
    + '━━━━━━━━━━━━━━━\n'
    + `⏳ Back in ${fmt.dur(Math.ceil(left / 1000))}.\n`
    + `📖 You pulled the trigger. Do it again in an hour.`,
    event.messageID,
  );
  return true;
}

/**
 * `!xxxaccept no` declines a duel inside the accept command itself, which
 * saves a whole command slot versus a dedicated deny command.
 * @returns {Promise<boolean>} true when the hunter ducked, caller must stop
 */
async function duck(game, args, userDoc, reply, event) {
  if (String(args[0] || '').toLowerCase() !== 'no') return false;
  cache.takePendingGame(game, event.threadID, String(event.senderID));
  await reply(`🚫 ${userDoc.name} ducks the ${game}. The pot stays untouched.`, event.messageID);
  return true;
}

/** Render the 4x4 mini-chess board. Shared so the two views cannot disagree. */
function chessBoard(board) {
  const grid = [
    [null, null, null, null],
    [null, null, null, null],
    [null, null, null, null],
    [null, null, null, null],
  ];
  for (const [p, ch] of [[board.wK, '♔'], [board.wN, '♘'], [board.bK, '♚'], [board.bN, '♞']]) {
    if (p) grid[p[1]][p[0]] = ch;
  }
  return '  a b c d\n'
    + grid.map((row, i) => `${i + 1} ${row.map((c) => c || '·').join(' ')}`).join('\n');
}

/** Every command in this module, in registration order. */
const commands = [];

// ───────────────────────────────────────────────────────────
// SOLO GAMES — the hunter plays the house
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'russianroulette',
    aliases: ['rr', 'rrgame'],
    category: 'games',
    description: '💀 Six chambers, one bullet. Win the pot or get banned for an hour',
    usage: '!russianroulette [amount]',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'russianroulette', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('💀');

      const bet = betArg(args, 1000);
      const staked = await wager(userDoc, bet, 'game:russianroulette');
      if (!staked.ok) {
        await reply(staked.reason, event.messageID);
        return;
      }

      const bullet = rand(1, 6);
      await reply(`💀 Cylinder open. One chamber. Spinning…`, event.messageID);
      await sleep(1200);

      if (bullet !== 1) {
        await payout(userDoc, bet * 2, 'game:rr_win', { bet });
        const rec = g(userDoc);
        await reply(
          `💀 **CLICK** — empty chamber.\n`
          + '━━━━━━━━━━━━━━━\n'
          + `🟢 You walked away with ${kc(bet * 2)}\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `🔥 Streak: ${rec.streak}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      cache.banFromGames(userDoc.uid, 60 * 60 * 1000);
      await recordLoss(userDoc, 'game:rr_loss');
      await reply(
        `💥 **CLICK.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💸 -${kc(bet)}\n`
        + `🚫 The arcade has banned you for one hour.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'blackjack',
    aliases: ['bj'],
    category: 'games',
    description: '🎴 Blackjack against the house — beat 21 and double the bet',
    usage: '!blackjack [amount]',
    cooldown: 45,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'blackjack', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('🎴');

      const bet = betArg(args, 1000);
      const staked = await wager(userDoc, bet, 'game:blackjack');
      if (!staked.ok) {
        await reply(staked.reason, event.messageID);
        return;
      }

      const value = () => rand(1, 13);
      const suit = () => pick(['♠', '♥', '♦', '♣']);
      const card = () => ({ v: value(), s: suit() });
      const label = (c) => (c.v === 1 ? 'A' : String(c.v - 1));
      const totalOf = (hand) => hand.reduce((sum, c) => sum + Math.min(c.v === 1 ? 11 : c.v, 10), 0);

      let hand = [card(), card()];
      let dealer = [card(), card()];
      const show = (h) => h.map(label).join(' ');

      await reply(
        `🎴 **BLACKJACK**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🃏 You: ${show(hand)} = ${totalOf(hand)}\n`
        + `🃏 Dealer: ${label(dealer[0])} ?\n`
        + `💵 Pot: ${kc(bet * 2)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );

      while (totalOf(hand) < 17) {
        hand.push(card());
        await sleep(500);
      }

      const mine = totalOf(hand);
      while (totalOf(dealer) < 17) dealer.push(card());
      const theirs = totalOf(dealer);

      const won = mine > theirs || (mine <= 21 && theirs > 21);
      if (won) {
        await payout(userDoc, bet * 2, 'game:bj_win', { bet, mine, theirs });
        await reply(
          `🎴 You: ${show(hand)} = ${mine}\n`
          + `🃏 Dealer: ${show(dealer)} = ${theirs}\n`
          + `━━━━━━━━━━━━━━━\n`
          + `🏆 **YOU WIN** +${kc(bet * 2)}\n`
          + `👛 Wallet: ${kc(userDoc.coins)}`,
          event.messageID,
        );
        return;
      }

      await recordLoss(userDoc, 'game:bj_loss');
      await reply(
        `🎴 You: ${show(hand)} = ${mine}\n`
        + `🃏 Dealer: ${show(dealer)} = ${theirs}\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💸 -${kc(bet)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'gambaall',
    aliases: ['gamball'],
    category: 'games',
    description: '🎰 Gamble the entire wallet in one pull. No survivors',
    usage: '!gambaall',
    cooldown: 60,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gambaall', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('🎰');

      const all = clamp(userDoc.coins);
      if (all <= 0) {
        await reply('💸 **Broke ass.** Farm `!daily` (10,000), `!hourly` (2,500) first.', event.messageID);
        return;
      }

      const staked = await wager(userDoc, all, 'game:gambaall');
      if (!staked.ok) {
        await reply(staked.reason, event.messageID);
        return;
      }

      const rec = g(userDoc);
      rec.wagered = clamp(rec.wagered) + all;
      await sleep(1500);

      // Luck is a nudge, not a promise: at most 15% better than fair.
      const edge = Math.random() * (1 - 2 * luck(userDoc));
      if (edge < 0.3) {
        await payout(userDoc, all * 2, 'game:gambaall_win', { all });
        await reply(
          `🎰 **JACKPOT**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `💰 ${kc(all * 2)} off a ${kc(all)} stake\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 The house always smiles. That is the warning.`,
          event.messageID,
        );
        return;
      }

      rec.losses = clamp(rec.losses) + 1;
      rec.streak = 0;
      await save(userDoc);
      await ledger(userDoc.uid, 'game:gambaall_loss', 0, userDoc.coins, { lost: true });
      await reply(
        `🎰 **Nothing.**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💸 -${kc(all)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'anarchy',
    aliases: ['ultranothing'],
    category: 'games',
    description: '🌀 Roll against the iKON algorithm. Usually nothing. Sometimes not',
    usage: '!anarchy [amount]',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'anarchy', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('🌀');

      const bet = betArg(args, 1000);
      const staked = await wager(userDoc, bet, 'game:anarchy');
      if (!staked.ok) {
        await reply(staked.reason, event.messageID);
        return;
      }

      await sleep(1000);
      const roll = rand(1, 100);
      if (roll > 95) {
        await payout(userDoc, bet * 3, 'game:anarchy_win', { bet, roll });
        await reply(
          `🌀 **THE ALGORITHM LIED.**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `🎲 ${roll} — that should not have happened\n`
          + `💰 +${kc(bet * 3)}\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      if (roll > 80) {
        await payout(userDoc, bet, 'game:anarchy_refund', { bet, roll });
        await reply(`🌀 ${roll}. Nothing happened. Your stake is returned.\n👛 Wallet: ${kc(userDoc.coins)}`, event.messageID);
        return;
      }

      await recordLoss(userDoc, 'game:anarchy_loss');
      await reply(`🌀 ${roll}. **NOTHING. NOT A THING.**\n💸 -${kc(bet)}\n📖 ${story()}`, event.messageID);
    }),
  });

  commands.push({
    name: 'eightballultra',
    aliases: ['8ball'],
    category: 'games',
    description: '🎱 Ask the 8-Ball a question. It costs you and it always answers',
    usage: '!eightballultra <question>',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'eightballultra', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('🎱');

      const q = args.join(' ').trim();
      if (!q) {
        await reply('❌ Usage: `!eightballultra <question>` — ask it something.', event.messageID);
        return;
      }

      const staked = await wager(userDoc, 50, 'game:eightball');
      if (!staked.ok) {
        await reply(staked.reason, event.messageID);
        return;
      }

      await reply(`🎱 **THE 8-BALL ANSWERS**\n━━━━━━━━━━━━━━━\n💭 "${q}"\n⏳ ...`, event.messageID);
      await sleep(1100);
      await reply(`🔮 **${pick(EIGHT_BALL)}**\n👛 Wallet: ${kc(userDoc.coins)}\n📖 ${story()}`, event.messageID);
    }),
  });

  commands.push({
    name: 'jokeultra',
    aliases: [],
    category: 'games',
    description: '😂 Tell a joke for 10 coins. The house is always laughing',
    usage: '!jokeultra',
    cooldown: 30,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'jokeultra', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('😂');

      // The 10 coins are charged up front rather than conditionally: Messenger
      // gives us no way to read reactions back off a message, so a "react to
      // keep your coins" mechanic could never actually be checked and would
      // just be a promise the bot cannot keep.
      const staked = await wager(userDoc, 10, 'game:joke');
      if (!staked.ok) {
        await reply(staked.reason, event.messageID);
        return;
      }

      await reply(`😂 **${pick(JOKES)}**\n━━━━━━━━━━━━━━━\n👛 Wallet: ${kc(userDoc.coins)}\n📖 ${story()}`, event.messageID);
    }),
  });

  commands.push({
    name: 'quoteultra',
    aliases: [],
    category: 'games',
    description: '💬 Guess the author of a quote — bet on your memory',
    usage: '!quoteultra [amount]',
    cooldown: 45,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'quoteultra', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('💬');

      const bet = betArg(args, 2000);
      const staked = await wager(userDoc, bet, 'game:quote');
      if (!staked.ok) {
        await reply(staked.reason, event.messageID);
        return;
      }

      const q = pick(QUOTES);
      cache.setGameState(event.senderID, 'quote', { author: q.author, bet }, 90 * 1000);
      await reply(
        `💬 **WHO SAID THIS?**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `"${q.text}"\n\n`
        + `💵 Pot: ${kc(bet * 2)}\n`
        + `⏱️ 90 seconds. \`!quoteanswer <name>\`\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'quoteanswer',
    aliases: [],
    category: 'games',
    description: '✅ Name the author of an open quote',
    usage: '!quoteanswer <author>',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'quoteanswer', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('✅');

      const state = cache.getGameState(event.senderID);
      if (!state || state.game !== 'quote') {
        await reply('📭 No quote open. Start one with `!quoteultra`.', event.messageID);
        return;
      }

      const guess = String(args.join(' ')).toLowerCase().trim();
      cache.clearGameState(event.senderID);
      const author = state.payload.author;
      const bet = state.payload.bet;

      if (guess && author.toLowerCase().includes(guess)) {
        await payout(userDoc, bet * 2, 'game:quote_win', { author, bet });
        await reply(
          `✅ **CORRECT** — ${author}\n`
          + '━━━━━━━━━━━━━━━\n'
          + `💰 +${kc(bet * 2)}\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      await recordLoss(userDoc, 'game:quote_loss');
      await reply(
        `❌ **WRONG** — it was ${author}\n`
        + `💸 -${kc(bet)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'riddleultra',
    aliases: [],
    category: 'games',
    description: '🧩 Solve a riddle for the pot',
    usage: '!riddleultra [amount]',
    cooldown: 45,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'riddleultra', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('🧩');

      const bet = betArg(args, 300);
      const staked = await wager(userDoc, bet, 'game:riddle');
      if (!staked.ok) {
        await reply(staked.reason, event.messageID);
        return;
      }

      const r = pick(RIDDLES);
      cache.setGameState(event.senderID, 'riddle', { answer: r.a, bet }, 120 * 1000);
      await reply(
        `🧩 **RIDDLE**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${r.q}\n\n`
        + `💵 Pot: ${kc(bet * 2)}\n`
        + `⏱️ 2 minutes. \`!riddleanswer <answer>\`\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'riddleanswer',
    aliases: [],
    category: 'games',
    description: '✅ Answer an open riddle',
    usage: '!riddleanswer <answer>',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'riddleanswer', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('✅');

      const state = cache.getGameState(event.senderID);
      if (!state || state.game !== 'riddle') {
        await reply('📭 No riddle open. Start one with `!riddleultra`.', event.messageID);
        return;
      }

      const guess = String(args.join(' ')).toLowerCase().trim();
      cache.clearGameState(event.senderID);
      const bet = state.payload.bet;

      const right = state.payload.answer.some((a) => a === guess);
      if (right) {
        await payout(userDoc, bet * 2, 'game:riddle_win', { bet });
        await reply(
          `✅ **CORRECT**\n`
          + `💰 +${kc(bet * 2)}\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      await recordLoss(userDoc, 'game:riddle_loss');
      await reply(
        `❌ **WRONG** — it was "${state.payload.answer[0]}"\n`
        + `💸 -${kc(bet)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'triviaultra',
    aliases: [],
    category: 'games',
    description: '🧠 Trivia sprint — answer before the clock runs out',
    usage: '!triviaultra [amount]',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'triviaultra', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('🧠');

      const bet = betArg(args, 500);
      const staked = await wager(userDoc, bet, 'game:trivia');
      if (!staked.ok) {
        await reply(staked.reason, event.messageID);
        return;
      }

      const t = pick(TRIVIA);
      cache.setGameState(event.senderID, 'trivia', { answer: t.a, bet }, 30 * 1000);
      await reply(
        `🧠 **TRIVIA SPRINT** — ${kc(bet)} on the line\n`
        + '━━━━━━━━━━━━━━━\n'
        + `❓ ${t.q}\n`
        + `⏱️ 30 seconds. \`!triviaanswer <answer>\`\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'triviaanswer',
    aliases: [],
    category: 'games',
    description: '✅ Answer an open trivia question',
    usage: '!triviaanswer <answer>',
    cooldown: 5,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'triviaanswer', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('✅');

      const state = cache.getGameState(event.senderID);
      if (!state || state.game !== 'trivia') {
        await reply('📭 No trivia question open. Start one with `!triviaultra`.', event.messageID);
        return;
      }

      const guess = String(args.join(' ')).toLowerCase().trim();
      cache.clearGameState(event.senderID);
      const bet = state.payload.bet;
      const right = state.payload.answer.includes(guess);

      if (right) {
        await payout(userDoc, bet * 2, 'game:trivia_win', { bet });
        await reply(`✅ **CORRECT**\n💰 +${kc(bet * 2)}\n👛 Wallet: ${kc(userDoc.coins)}\n📖 ${story()}`, event.messageID);
        return;
      }

      await recordLoss(userDoc, 'game:trivia_loss');
      await reply(`❌ **WRONG**\n💸 -${kc(bet)}\n📖 ${story()}`, event.messageID);
    }),
  });

  commands.push({
    name: 'gstats',
    aliases: ['arcadestats'],
    category: 'games',
    description: '📊 Your arcade record — wins, losses, wagered, biggest win',
    usage: '!gstats',
    cooldown: 20,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'gstats', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('📊');

      const rec = g(userDoc);
      const played = clamp(rec.wins) + clamp(rec.losses);
      const rate = played ? Math.round((clamp(rec.wins) / played) * 100) : 0;

      await reply(
        `📊 **${userDoc.name} — ARCADE RECORD**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🎮 Games played: ${num(played)}\n`
        + `🏆 Wins: ${num(rec.wins)} · 💀 Losses: ${num(rec.losses)}\n`
        + `📉 Win rate: ${rate}%\n`
        + `💸 Total wagered: ${kc(rec.wagered)}\n`
        + `💰 Biggest win: ${kc(rec.bestWin)}\n`
        + `🔥 Current streak: ${num(rec.streak)}\n`
        + `🍀 Lucky charm: ${num(rec.luckyCharm)}%\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

module.exports = commands;
