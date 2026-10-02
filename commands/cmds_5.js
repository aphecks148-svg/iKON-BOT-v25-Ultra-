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
const userTarget = require('../bot/target');

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

/** Resolve a tag, a typed name, or a bare id to a User document.
 *
 * The thread knows who is actually in this chat and what they are really
 * called, which is why this lives in bot/target.js: it is the only place that
 * can turn "@Alice" into a uid. See that file for the whole order of attempts.
 */
async function resolveTarget(ref, event, api) {
  return userTarget.userDoc(ref, event, api);
}

/** resolveTarget with the two failure replies already sent. */
async function targetOr(reply, messageID, ref, event, label, api) {
  if (!ref) {
    await reply(`❌ Usage: \`!${label} <user> [amount]\` — tag a hunter or use their ID.`, messageID);
    return null;
  }
  const target = await resolveTarget(ref, event, api);
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

/** The other player's mark on a tic-tac-toe board. */
function opposite(mark) {
  return mark === '⭕' ? '❌' : '⭕';
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
// WORD GAMES
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'hangmanbet',
    aliases: [],
    category: 'games',
    description: '🔤 Hangman — guess the word one letter at a time, ropes included',
    usage: '!hangmanbet [amount]',
    cooldown: 60,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'hangmanbet', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('🔤');

      const bet = betArg(args, 200);
      const staked = await wager(userDoc, bet, 'game:hangman');
      if (!staked.ok) {
        await reply(staked.reason, event.messageID);
        return;
      }

      const WORDS = ['arcade', 'klerk', 'vault', 'neon', 'casino', 'factory', 'courier', 'alchemy',
        'monopoly', 'lantern', 'obsidian', 'paradox', 'quartz', 'reverie', 'spectrum', 'threshold'];
      const word = pick(WORDS);
      cache.setGameState(event.senderID, 'hangman', {
        word, bet, guessed: [], lives: 6,
      }, 5 * 60 * 1000);

      await reply(
        `🔤 **HANGMAN** — ${kc(bet)} on the line\n`
        + '━━━━━━━━━━━━━━━\n'
        + `📝 ${word.split('').map(() => '_').join(' ')}\n`
        + `${'❤️'.repeat(6)}\n`
        + `💡 Guess a letter: \`!hangletter <a-z>\`\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'hangletter',
    aliases: [],
    category: 'games',
    description: '🔤 Guess one letter of your open hangman word',
    usage: '!hangletter <a-z>',
    cooldown: 5,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'hangletter', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('🔤');

      const state = cache.getGameState(event.senderID);
      if (!state || state.game !== 'hangman') {
        await reply('📭 No hangman game open. Start one with `!hangmanbet`.', event.messageID);
        return;
      }

      const guess = String(args[0] || '').toLowerCase().replace(/[^a-z]/g, '');
      if (guess.length !== 1) {
        await reply('❌ One letter at a time, a-z only.', event.messageID);
        return;
      }

      const { word, bet } = state.payload;
      const guessed = state.payload.guessed;
      if (guessed.includes(guess)) {
        await reply(`🔤 You already guessed **${guess}**.`, event.messageID);
        return;
      }

      guessed.push(guess);
      const board = word.split('').map((ch) => (guessed.includes(ch) ? ch : '_')).join(' ');
      const lives = clamp(state.payload.lives);

      if (word.includes(guess)) {
        // Every letter revealed is a win. Without this the game could only be
        // lost: the board filled up and nothing ever paid out.
        const solved = word.split('').every((ch) => guessed.includes(ch));
        if (solved) {
          cache.clearGameState(event.senderID);
          await payout(userDoc, bet * 2, 'game:hangman_win', { word, bet });
          await reply(
            `🔤 🏆 **SOLVED** — ${word}\n`
            + '━━━━━━━━━━━━━━━\n'
            + `📝 ${board}\n${'❤️'.repeat(lives)}\n`
            + `💰 +${kc(bet * 2)}\n`
            + `👛 Wallet: ${kc(userDoc.coins)}\n`
            + `📖 ${story()}`,
            event.messageID,
          );
          return;
        }

        cache.setGameState(event.senderID, 'hangman', state.payload, 5 * 60 * 1000);
        await reply(
          `🔤 ✅ **${guess}** is in the word.\n`
          + '━━━━━━━━━━━━━━━\n'
          + `📝 ${board}\n${'❤️'.repeat(lives)}\n`
          + `💡 Keep going: \`!hangletter <a-z>\``,
          event.messageID,
        );
        return;
      }

      const left = lives - 1;
      if (left <= 0) {
        cache.clearGameState(event.senderID);
        await recordLoss(userDoc, 'game:hangman_loss');
        await reply(
          `🔤 💀 **The rope takes you.** The word was **${word}**.\n`
          + `💸 -${kc(bet)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      state.payload.lives = left;
      cache.setGameState(event.senderID, 'hangman', state.payload, 5 * 60 * 1000);
      await reply(
        `🔤 ❌ No **${guess}** in there.\n`
        + '━━━━━━━━━━━━━━━\n'
        + `📝 ${board}\n${'❤️'.repeat(left)}\n`
        + `💡 Keep going: \`!hangletter <a-z>\``,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'mathduel',
    aliases: [],
    category: 'games',
    description: '🧮 Math duel @user — first correct answer takes the pot',
    usage: '!mathduel <user> <amount>',
    cooldown: 120,
    permission: 'all',
    execute: async ({ api, args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'mathduel', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('🧮');

      const bet = betArg(args.slice(1), 1000);
      const target = await targetOr(reply, event.messageID, args[0], event, 'mathduel', api);
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ Doing sums with yourself is not a duel.', event.messageID);
        return;
      }
      if ((target.coins || 0) < bet) {
        await reply(`💸 ${target.name} only has ${kc(target.coins)}.`, event.messageID);
        return;
      }

      const parked = cache.setPendingGame('mathduel', event.threadID, String(target.uid), {
        fromUid: String(event.senderID), fromName: userDoc.name, bet,
      });
      if (!parked) {
        await reply(`⏳ ${target.name} already has a math duel.`, event.messageID);
        return;
      }
      await reply(
        `🧮 **MATH DUEL**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💵 Pot: ${kc(bet)}\n`
        + `⏳ ${target.name}: \`!mathaccept\` — add \`no\` to duck.`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'mathaccept',
    aliases: [],
    category: 'games',
    description: '🧮 Take a math duel — solve with !mathsolve before 60 seconds',
    usage: '!mathaccept',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'mathaccept', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('🧮');

      if (await duck('mathduel', args, userDoc, reply, event)) return;
      const challenge = cache.takePendingGame('mathduel', event.threadID, String(event.senderID));
      if (!challenge) {
        await reply('📭 No math duel waiting.', event.messageID);
        return;
      }
      const challenger = await User.findOne({ uid: challenge.fromUid });
      if (!challenger) {
        await reply('❌ Challenger left the city.', event.messageID);
        return;
      }

      const bet = challenge.bet;
      if ((userDoc.coins || 0) < bet || (challenger.coins || 0) < bet) {
        await reply('❌ Pot uncovered. Void.', event.messageID);
        return;
      }

      // Both sides stake before the question is asked. Without this a correct
      // answer paid out 2x the bet that had never been collected from either
      // side, which printed coins the arcade never held.
      const a = await wager(challenger, bet, 'game:mathduel_challenger');
      if (!a.ok) { await reply(a.reason, event.messageID); return; }
      const b = await wager(userDoc, bet, 'game:mathduel_accept');
      if (!b.ok) {
        await wager(challenger, bet, 'game:mathduel_refund');
        await reply(b.reason, event.messageID);
        return;
      }

      const n = rand(12, 60) + rand(12, 60);
      cache.setGameState(event.senderID, 'mathduel', { question: n, bet }, 60 * 1000);

      await reply(
        `🧮 **YOUR QUESTION**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `❓ What is ${n} + ${n}?\n`
        + `💵 Pot: ${kc(bet * 2)}\n`
        + `⏱️ 60 seconds. \`!mathsolve <number>\`\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'mathsolve',
    aliases: [],
    category: 'games',
    description: '✅ Answer your open math duel question',
    usage: '!mathsolve <number>',
    cooldown: 5,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'mathsolve', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('✅');

      const state = cache.getGameState(event.senderID);
      if (!state || state.game !== 'mathduel') {
        await reply('📭 No math question open. Take a duel with `!mathaccept`.', event.messageID);
        return;
      }

      const guess = Number.parseInt(args[0], 10);
      // Cleared up front so a wrong guess cannot be retried against the same
      // question, whatever the clock says afterwards.
      cache.clearGameState(event.senderID);
      const q = state.payload.question;
      const answer = q * 2;
      const bet = state.payload.bet;

      if (guess === answer) {
        await payout(userDoc, bet * 2, 'game:mathduel_win', { answer, bet });
        await reply(
          `✅ **${answer} — CORRECT**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `💰 +${kc(bet * 2)}\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      await recordLoss(userDoc, 'game:mathduel_loss');
      await reply(
        `❌ **WRONG** — ${q} + ${q} = ${answer}\n`
        + `💸 -${kc(bet)}\n`
        + `👛 Wallet: ${kc(userDoc.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'chainword',
    aliases: [],
    category: 'games',
    description: '⛓️ Chain word — last letter starts the next, break it and pay 200',
    usage: '!chainword <word>',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'chainword', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('⛓️');

      const word = String(args[0] || '').toLowerCase().trim();
      if (!/^[a-z]{3,20}$/.test(word)) {
        await reply('❌ Usage: `!chainword <word>` — 3 to 20 letters, a-z only.', event.messageID);
        return;
      }

      const chain = cache.getGameState(`chain:${event.threadID}`);
      const open = chain && chain.payload && chain.payload.open;

      // Starting a chain, or continuing one the hunter opened themselves.
      if (!open || open.ownerUid === String(event.senderID)) {
        if (!open) {
          const staked = await wager(userDoc, 200, 'game:chainword');
          if (!staked.ok) {
            await reply(staked.reason, event.messageID);
            return;
          }
        }
        cache.setGameState(`chain:${event.threadID}`, 'chain', {
          open: { ownerUid: String(event.senderID), last: word.slice(-1), words: [word] },
        }, 10 * 60 * 1000);
        await reply(
          `⛓️ **CHAIN STARTED**\n`
          + '━━━━━━━━━━━━━━━\n'
          + `📝 ${word}\n`
          + `▶️ Next word must start with **${word.slice(-1)}**. Break it and pay 200.\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      // Somebody else's chain: this hunter must supply a matching word or pay.
      if (word[0] !== open.last) {
        const staked = await wager(userDoc, 200, 'game:chainword_break');
        if (!staked.ok) {
          await reply(staked.reason, event.messageID);
          return;
        }
        cache.clearGameState(`chain:${event.threadID}`);
        await recordLoss(userDoc, 'game:chainword_break');
        await reply(
          `⛓️ 💥 **CHAIN BROKEN** — "${word}" starts with ${word[0]}, not ${open.last}.\n`
          + `💸 -${kc(200)}\n`
          + `👛 Wallet: ${kc(userDoc.coins)}\n`
          + `📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      open.last = word.slice(-1);
      open.words.push(word);
      cache.setGameState(`chain:${event.threadID}`, 'chain', { open }, 10 * 60 * 1000);
      await reply(
        `⛓️ **${open.words.length} IN THE CHAIN**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `📝 ${open.words.join(' → ')}\n`
        + `▶️ Next word must start with **${open.last}**.`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'bombgame',
    aliases: ['bomb'],
    category: 'games',
    description: '💣 Light the group bomb — it ticks, then somebody is holding it',
    usage: '!bombgame <amount>',
    cooldown: 60,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'bombgame', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('💣');

      if (!mongo.isReady()) {
        await reply('❌ The bomb needs the city grid online. Try again shortly.', event.messageID);
        return;
      }
      const group = await Group.findOne({ gid: String(event.threadID) });
      if (!group) {
        await reply('❌ No arcade record for this chat yet.', event.messageID);
        return;
      }

      const bet = betArg(args, 1000);
      const staked = await wager(userDoc, bet, 'game:bomb');
      if (!staked.ok) {
        await reply(staked.reason, event.messageID);
        return;
      }

      const holds = Number.isFinite(group.gameBomb && group.gameBomb.passes) ? group.gameBomb.passes : 0;
      const passes = holds + 1;
      const ticks = rand(2, 5);
      group.gameBomb = {
        holderUid: String(event.senderID),
        holderName: userDoc.name,
        amount: (group.gameBomb && group.gameBomb.amount) || bet,
        passes,
        expires: new Date(Date.now() + 10 * 60 * 1000),
      };
      try {
        await group.save();
      } catch {
        await reply('❌ The bomb would not light. Your stake is back.', event.messageID);
        await payout(userDoc, bet, 'game:bomb_refund', { bet });
        return;
      }

      await reply(
        `💣 **THE BOMB IS LIT**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `⏱️ It ticks down from ${ticks}. Nobody can defuse it — only pass it.\n`
        + `📮 ${userDoc.name}, you are holding it. Pass it with \`!passbomb\`.\n`
        + `🔁 Times lit in this chat: ${passes}\n`
        + `💵 It carries ${kc(group.gameBomb.amount)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'passbomb',
    aliases: [],
    category: 'games',
    description: '💣 Pass the lit bomb to somebody else in this chat',
    usage: '!passbomb @user',
    cooldown: 30,
    permission: 'all',
    execute: async ({ api, args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'passbomb', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('💣');

      if (!mongo.isReady()) {
        await reply('❌ The bomb needs the city grid online. Try again shortly.', event.messageID);
        return;
      }
      const group = await Group.findOne({ gid: String(event.threadID) });
      if (!group || !group.gameBomb || !group.gameBomb.holderUid) {
        await reply('💣 Nothing is ticking. Light it with `!bombgame`.', event.messageID);
        return;
      }
      if (String(group.gameBomb.holderUid) !== String(event.senderID)) {
        await reply(`💣 ${group.gameBomb.holderName} is holding it. Not you.`, event.messageID);
        return;
      }
      if (group.gameBomb.expires && new Date(group.gameBomb.expires).getTime() < Date.now()) {
        group.gameBomb = undefined;
        await reply('💣 It cooled off and rolled under the seats. Nobody pays.', event.messageID);
        return;
      }

      const target = await targetOr(reply, event.messageID, args[0], event, 'passbomb', api);
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ You cannot pass the bomb to yourself.', event.messageID);
        return;
      }

      group.gameBomb.holderUid = String(target.uid);
      group.gameBomb.holderName = target.name;
      try {
        await group.save();
      } catch {
        await reply('❌ The pass failed. The bomb is still yours.', event.messageID);
        return;
      }

      await reply(
        `💣 **PASSED**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `📮 ${target.name}, it is yours now. Pass it with \`!passbomb\`.\n`
        + `💵 It carries ${kc(group.gameBomb.amount)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

// ───────────────────────────────────────────────────────────
// BOARD GAMES — tic-tac-toe and 4x4 mini chess
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'tictactoe',
    aliases: ['ttt'],
    category: 'games',
    description: '⭕ Tic-tac-toe @user — first to a line takes the pot',
    usage: '!tictactoe <user> <amount>',
    cooldown: 60,
    permission: 'all',
    execute: async ({ api, args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'tictactoe', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('⭕');

      const bet = betArg(args.slice(1), 1000);
      const target = await targetOr(reply, event.messageID, args[0], event, 'tictactoe', api);
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ Tic-tac-toe needs two hunters.', event.messageID);
        return;
      }
      if ((target.coins || 0) < bet) {
        await reply(`💸 ${target.name} only has ${kc(target.coins)}.`, event.messageID);
        return;
      }

      const parked = cache.setPendingGame('ttt', event.threadID, String(target.uid), {
        fromUid: String(event.senderID), fromName: userDoc.name, bet,
      });
      if (!parked) {
        await reply(`⏳ ${target.name} already has a board waiting.`, event.messageID);
        return;
      }
      await reply(
        `⭕ **TIC-TAC-TOE**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💵 Pot: ${kc(bet)}\n`
        + `⏳ ${target.name}: \`!tttaccept\` — add \`no\` to duck.`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'tttaccept',
    aliases: [],
    category: 'games',
    description: '⭕ Take a tic-tac-toe duel — pass a square to play first',
    usage: '!tttaccept [1-9]',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'tttaccept', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('⭕');

      if (await duck('ttt', args, userDoc, reply, event)) return;
      const challenge = cache.takePendingGame('ttt', event.threadID, String(event.senderID));
      if (!challenge) {
        await reply('📭 No board waiting for you.', event.messageID);
        return;
      }
      const challenger = await User.findOne({ uid: challenge.fromUid });
      if (!challenger) {
        await reply('❌ Challenger left the city.', event.messageID);
        return;
      }

      const bet = challenge.bet;
      if ((userDoc.coins || 0) < bet || (challenger.coins || 0) < bet) {
        await reply('❌ Pot uncovered. Void.', event.messageID);
        return;
      }

      // The acceptor may pass a square to play first, or accept bare and play
      // via !tttplay. Both are advertised, so both have to work.
      const square = Number.parseInt(args[0], 10);
      const hasSquare = args[0] !== undefined && args[0] !== '';
      if (hasSquare && (!Number.isFinite(square) || square < 1 || square > 9)) {
        cache.setPendingGame('ttt', event.threadID, String(event.senderID), challenge);
        await reply('❌ Pick a square from 1 to 9 — or `!tttaccept no` to duck.', event.messageID);
        return;
      }

      const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
      const board = new Array(9).fill(null);
      const render = () => (
        `${board[0] || '1️⃣'} ${board[1] || '2️⃣'} ${board[2] || '3️⃣'}\n`
        + `${board[3] || '4️⃣'} ${board[4] || '5️⃣'} ${board[5] || '6️⃣'}\n`
        + `${board[6] || '7️⃣'} ${board[7] || '8️⃣'} ${board[8] || '9️⃣'}`
      );
      const line = (mark) => LINES.some(([a, b, c]) => board[a] === mark && board[b] === mark && board[c] === mark);

      const a = await wager(challenger, bet, 'game:ttt_challenger');
      if (!a.ok) { await reply(a.reason, event.messageID); return; }
      const b = await wager(userDoc, bet, 'game:ttt_accept');
      if (!b.ok) {
        await wager(challenger, bet, 'game:ttt_refund');
        await reply(b.reason, event.messageID);
        return;
      }

      await reply(
        `⭕ **BOARD OPEN** — ${userDoc.name} takes ⭕, ${challenger.name} takes ❌.\n\n${render()}`,
        event.messageID,
      );

      // Accepted without a square: open the board and let the acceptor move.
      if (!hasSquare) {
        cache.putPendingGame('tttplay', event.threadID, String(event.senderID), {
          toUid: String(challenge.fromUid), toName: challenger.name, bet, board, mark: '⭕',
        });
        await reply(`⭕ ${userDoc.name}, your turn: \`!tttplay <1-9>\``, event.messageID);
        return;
      }

      board[square - 1] = '⭕';
      await reply(`⭕ ${userDoc.name} played ${square}.\n\n${render()}`, event.messageID);

      if (line('⭕')) {
        await payout(userDoc, bet * 2, 'game:ttt_win', { bet, square });
        await reply(
          `🏆 **YOU WIN** — ${square} completes the line!\n`
          + `💰 +${kc(bet * 2)}\n👛 Wallet: ${kc(userDoc.coins)}\n📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      if (board.every((v) => v !== null)) {
        await payout(userDoc, bet, 'game:ttt_draw', { bet });
        await payout(challenger, bet, 'game:ttt_draw', { bet });
        await reply(`🤝 **DRAW.** Stakes returned.\n📖 ${story()}`, event.messageID);
        return;
      }

      // The house answers for the challenger: block a threat, else take a square.
      const empty = board.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
      const threat = (mark) => LINES.find(([x, y, z]) => (
        (board[x] === mark && board[y] === mark && board[z] === null)
        || (board[x] === mark && board[z] === mark && board[y] === null)
        || (board[y] === mark && board[z] === mark && board[x] === null)
      ));
      const winAt = threat('❌');
      const blockAt = threat('⭕');
      const spot = winAt ? winAt.find((i) => board[i] === null)
        : (blockAt ? blockAt.find((i) => board[i] === null) : pick(empty));

      board[spot] = '❌';
      await sleep(600);
      await reply(`❌ ${challenger.name} plays ${spot + 1}.\n\n${render()}`, event.messageID);

      if (line('❌')) {
        await recordLoss(userDoc, 'game:ttt_loss');
        await reply(
          `🏆 **${challenger.name} WINS** — line complete.\n`
          + `💸 -${kc(bet)}\n📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      if (board.every((v) => v !== null)) {
        await payout(userDoc, bet, 'game:ttt_draw', { bet });
        await payout(challenger, bet, 'game:ttt_draw', { bet });
        await reply(`🤝 **FULL BOARD, DRAW.** Stakes returned.`, event.messageID);
        return;
      }

      const parked = cache.setPendingGame('tttplay', event.threadID, String(challenge.fromUid), {
        toUid: String(event.senderID), toName: userDoc.name, bet, board, mark: '❌',
      });
      if (parked) {
        await reply(`⭕ Board open. ${challenger.name}, reply \`!tttplay <1-9>\`.`, event.messageID);
      }
    }),
  });

  commands.push({
    name: 'tttplay',
    aliases: [],
    category: 'games',
    description: '❌ Continue an open tic-tac-toe board with a square 1-9',
    usage: '!tttplay <1-9>',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'tttplay', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;

      const challenge = cache.takePendingGame('tttplay', event.threadID, String(event.senderID));
      if (!challenge) {
        await reply('📭 No open board for you.', event.messageID);
        return;
      }
      // Each player owns one mark. Without this both sides would lay the same
      // mark and could "win" a line the opponent actually built.
      const mark = challenge.mark || '❌';
      await react(mark);

      const square = Number.parseInt(args[0], 10);
      if (!Number.isFinite(square) || square < 1 || square > 9 || challenge.board[square - 1]) {
        cache.setPendingGame('tttplay', event.threadID, String(event.senderID), challenge);
        await reply('❌ Pick an empty square from 1 to 9.', event.messageID);
        return;
      }

      const board = challenge.board;
      const bet = challenge.bet;
      const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
      const line = (m) => LINES.some(([x, y, z]) => board[x] === m && board[y] === m && board[z] === m);
      const render = () => (
        `${board[0] || '1️⃣'} ${board[1] || '2️⃣'} ${board[2] || '3️⃣'}\n`
        + `${board[3] || '4️⃣'} ${board[4] || '5️⃣'} ${board[5] || '6️⃣'}\n`
        + `${board[6] || '7️⃣'} ${board[7] || '8️⃣'} ${board[8] || '9️⃣'}`
      );

      board[square - 1] = mark;
      await reply(`${mark} ${userDoc.name} plays ${square}.\n\n${render()}`, event.messageID);

      if (line(mark)) {
        await payout(userDoc, bet * 2, 'game:ttt_win', { bet, square });
        await reply(
          `🏆 **YOU WIN** — ${square} completes the line!\n`
          + `💰 +${kc(bet * 2)}\n👛 Wallet: ${kc(userDoc.coins)}\n📖 ${story()}`,
          event.messageID,
        );
        return;
      }

      if (board.every((v) => v !== null)) {
        await payout(userDoc, bet, 'game:ttt_draw', { bet });
        const other = await User.findOne({ uid: challenge.toUid });
        if (other) await payout(other, bet, 'game:ttt_draw', { bet });
        await reply('🤝 **DRAW.** Stakes returned.', event.messageID);
        return;
      }

      cache.setPendingGame('tttplay', event.threadID, challenge.toUid, {
        toUid: String(event.senderID), toName: userDoc.name, bet, board, mark: opposite(mark),
      });
      await reply(`${challenge.toName}, your turn: \`!tttplay <1-9>\``, event.messageID);
    }),
  });

  commands.push({
    name: 'chessmini',
    aliases: [],
    category: 'games',
    description: '♟️ Four-square chess duel @user — one message per move, no clock',
    usage: '!chessmini <user> <amount>',
    cooldown: 300,
    permission: 'all',
    execute: async ({ api, args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'chessmini', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('♟️');

      const bet = betArg(args.slice(1), 2000);
      const target = await targetOr(reply, event.messageID, args[0], event, 'chessmini', api);
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ Chess requires an opponent.', event.messageID);
        return;
      }
      if ((target.coins || 0) < bet) {
        await reply(`💸 ${target.name} only has ${kc(target.coins)}.`, event.messageID);
        return;
      }

      const parked = cache.setPendingGame('chess', event.threadID, String(target.uid), {
        fromUid: String(event.senderID), fromName: userDoc.name, bet,
      });
      if (!parked) {
        await reply(`⏳ ${target.name} already has a chess board.`, event.messageID);
        return;
      }
      await reply(
        `♟️ **CHESS DUEL**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💵 Pot: ${kc(bet)}\n`
        + `⏳ ${target.name}: \`!chessaccept\` — add \`no\` to duck.`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'chessaccept',
    aliases: [],
    category: 'games',
    description: '♟️ Take a chess duel — white moves first',
    usage: '!chessaccept',
    cooldown: 60,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'chessaccept', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('♟️');

      if (await duck('chess', args, userDoc, reply, event)) return;
      const challenge = cache.takePendingGame('chess', event.threadID, String(event.senderID));
      if (!challenge) {
        await reply('📭 No chess challenge waiting.', event.messageID);
        return;
      }
      const challenger = await User.findOne({ uid: challenge.fromUid });
      if (!challenger) {
        await reply('❌ Challenger left the city.', event.messageID);
        return;
      }

      const bet = challenge.bet;
      if ((userDoc.coins || 0) < bet || (challenger.coins || 0) < bet) {
        await reply('❌ Pot uncovered. Void.', event.messageID);
        return;
      }
      const a = await wager(challenger, bet, 'game:chess_challenger');
      if (!a.ok) { await reply(a.reason, event.messageID); return; }
      const b = await wager(userDoc, bet, 'game:chess_accept');
      if (!b.ok) {
        await wager(challenger, bet, 'game:chess_refund');
        await reply(b.reason, event.messageID);
        return;
      }

      // 4x4 board: each side has a king and a knight.
      const board = { wK: [0, 0], wN: [1, 0], bK: [3, 3], bN: [2, 3] };
      cache.putPendingGame('chessplay', event.threadID, String(challenge.fromUid), {
        board, bet,
        wUid: String(challenge.fromUid), wName: challenger.name,
        bUid: String(event.senderID), bName: userDoc.name,
        turn: 'w', moves: 0,
      });

      await reply(
        `♟️ **WHITE MOVES FIRST**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${chessBoard(board)}\n`
        + `♔ ${challenger.name} (white) vs ♚ ${userDoc.name} (black)\n`
        + `💵 Pot: ${kc(bet * 2)}\n`
        + `📋 Move format: \`!chessplay a1a2\` — capture the king to win.\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'chessplay',
    aliases: [],
    category: 'games',
    description: '♟️ Move the chess board, e.g. !chessplay a1a2 — 8 moves max',
    usage: '!chessplay <e.g. a1a2>',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'chessplay', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('♟️');

      const state = cache.takePendingGame('chessplay', event.threadID, String(event.senderID));
      if (!state) {
        await reply('📭 No chess board is waiting for you.', event.messageID);
        return;
      }
      // Every rejection path hands the board straight back, so a typo or an
      // out-of-turn tap never costs the player their game.
      const giveBack = () => cache.setPendingGame('chessplay', event.threadID, String(event.senderID), state);

      const move = String(args[0] || '').toLowerCase();
      const m = /^([a-d])([1-4])([a-d])([1-4])$/.exec(move);
      if (!m) {
        giveBack();
        await reply('❌ Move format: `!chessplay a1a2` — file letter + rank + file + rank.', event.messageID);
        return;
      }

      const [f1, r1, f2, r2] = [m[1], Number(m[2]), m[3], Number(m[4])];
      const board = state.board;
      const isWhite = state.turn === 'w';
      const mine = isWhite
        ? state.wUid === String(event.senderID)
        : state.bUid === String(event.senderID);
      if (!mine) {
        giveBack();
        await reply(`⏳ It is ${isWhite ? 'WHITE' : 'BLACK'} to move.`, event.messageID);
        return;
      }

      const FILES = ['a', 'b', 'c', 'd'];
      const side = isWhite ? 'w' : 'b';
      // Address the pieces by their key on the board itself. Wrapping them in
      // a fresh { K, N } object would silently break the alias back to the
      // board, and the move would render as if it never happened.
      const OWN = { K: `${side}K`, N: `${side}N` };
      const FOE_KEYS = { K: `${side === 'w' ? 'b' : 'w'}K`, N: `${side === 'w' ? 'b' : 'w'}N` };
      const pos = [FILES.indexOf(f1), r1 - 1];
      const dest = [FILES.indexOf(f2), r2 - 1];

      let moving = null;
      for (const kind of ['K', 'N']) {
        const p = board[OWN[kind]];
        if (p && p[0] === pos[0] && p[1] === pos[1]) moving = kind;
      }
      if (!moving) {
        giveBack();
        await reply('❌ No piece of yours stands there.', event.messageID);
        return;
      }

      const dx = Math.abs(dest[0] - pos[0]);
      const dy = Math.abs(dest[1] - pos[1]);
      const legal = moving === 'K' ? Math.max(dx, dy) === 1 : ((dx === 1 && dy === 2) || (dx === 2 && dy === 1));
      if (!legal) {
        giveBack();
        await reply(`❌ ${moving === 'K' ? 'A king moves one square' : 'A knight moves in an L (1+2)'}. Try again.`, event.messageID);
        return;
      }
      if (pos[0] === dest[0] && pos[1] === dest[1]) {
        giveBack();
        await reply('❌ That is not a move.', event.messageID);
        return;
      }

      let captured = null;
      for (const kind of ['K', 'N']) {
        const p = board[FOE_KEYS[kind]];
        if (p && p[0] === dest[0] && p[1] === dest[1]) {
          board[FOE_KEYS[kind]] = null;
          captured = kind;
        }
      }

      board[OWN[moving]] = dest;
      const bet = state.bet;
      state.moves = clamp(state.moves) + 1;

      const crown = `${moving === 'K' ? (side === 'w' ? '♔' : '♚') : (side === 'w' ? '♘' : '♞')}`;
      const winText = (who) => (
        `🏆 **${who} WINS** — the king is taken.\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${chessBoard(board)}\n`
        + `📖 ${story()}`
      );

      if (captured === 'K') {
        const loserUid = isWhite ? state.bUid : state.wUid;
        await payout(userDoc, bet * 2, 'game:chess_win', { bet, moves: state.moves });
        await reply(`${crown} ${userDoc.name} plays **${f1}${r1} → ${f2}${r2}** — KING TAKEN!\n${winText(userDoc.name)}\n💰 +${kc(bet * 2)}\n👛 Wallet: ${kc(userDoc.coins)}`, event.messageID);
        if (loserUid !== String(event.senderID)) {
          const loserDoc = await User.findOne({ uid: loserUid });
          if (loserDoc) await recordLoss(loserDoc, 'game:chess_loss');
        }
        return;
      }

      // Eight moves without a capture is a draw; neither side is robbed.
      if (state.moves >= 8) {
        await payout(userDoc, bet, 'game:chess_draw', { bet });
        const other = await User.findOne({ uid: isWhite ? state.bUid : state.wUid });
        if (other) await payout(other, bet, 'game:chess_draw', { bet });
        await reply(`♟️ **DRAW** after ${state.moves} moves.\n${chessBoard(board)}\n🤝 Stakes returned.`, event.messageID);
        return;
      }

      state.turn = isWhite ? 'b' : 'w';
      const nextUid = isWhite ? state.bUid : state.wUid;
      cache.setPendingGame('chessplay', event.threadID, nextUid, state);

      await reply(
        `♟️ Move ${state.moves}: **${f1}${r1} → ${f2}${r2}**${captured ? ` — captured a ${captured === 'K' ? 'KING' : 'knight'}!` : ''}\n`
        + '━━━━━━━━━━━━━━━\n'
        + `${chessBoard(board)}\n`
        + `⏳ Next: ${isWhite ? state.bName : state.wName} (\`!chessplay <move>\`)`,
        event.messageID,
      );
    }),
  });

// ───────────────────────────────────────────────────────────
// HEAD-TO-HEAD DUELS — challenge, accept (or duck), settle
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'coinflipduel',
    aliases: ['cfduel'],
    category: 'games',
    description: '🪙 Coin flip duel @user — winner takes the doubled pot',
    usage: '!coinflipduel <user> <amount>',
    cooldown: 60,
    permission: 'all',
    execute: async ({ api, args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'coinflipduel', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('🪙');

      const bet = betArg(args.slice(1), 1000);
      const target = await targetOr(reply, event.messageID, args[0], event, 'coinflipduel', api);
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ Flipping against yourself is not a duel.', event.messageID);
        return;
      }
      if ((target.coins || 0) < bet) {
        await reply(`💸 ${target.name} only has ${kc(target.coins)}.`, event.messageID);
        return;
      }

      const parked = cache.setPendingGame('cfduel', event.threadID, String(target.uid), {
        fromUid: String(event.senderID), fromName: userDoc.name, bet,
      });
      if (!parked) {
        await reply(`⏳ ${target.name} already has a flip waiting.`, event.messageID);
        return;
      }

      await reply(
        `🪙 **FLIP CHALLENGE**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💵 Pot: ${kc(bet)}\n`
        + `⏳ ${target.name}: \`!cfaccept\` — add \`no\` to duck.`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'cfaccept',
    aliases: [],
    category: 'games',
    description: '🪙 Take a coin flip duel — winner takes all',
    usage: '!cfaccept',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'cfaccept', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('🪙');

      if (await duck('cfduel', args, userDoc, reply, event)) return;
      const challenge = cache.takePendingGame('cfduel', event.threadID, String(event.senderID));
      if (!challenge) {
        await reply('📭 No flip challenge for you.', event.messageID);
        return;
      }
      const challenger = await User.findOne({ uid: challenge.fromUid });
      if (!challenger) {
        await reply('❌ Challenger left the city. Pot void.', event.messageID);
        return;
      }

      const bet = challenge.bet;
      if ((userDoc.coins || 0) < bet || (challenger.coins || 0) < bet) {
        await reply('❌ Pot is no longer covered. Void.', event.messageID);
        return;
      }

      // Both sides stake before the flip, so the pot is real money on both
      // sides rather than a number that only exists in the reply text.
      const a = await wager(challenger, bet, 'game:cf_challenger');
      if (!a.ok) { await reply(a.reason, event.messageID); return; }
      const b = await wager(userDoc, bet, 'game:cf_accept');
      if (!b.ok) {
        await wager(challenger, bet, 'game:cf_refund');
        await reply(b.reason, event.messageID);
        return;
      }

      const pot = bet * 2;
      await reply(`🪙 Both sides staked ${kc(bet)}. Spinning…`, event.messageID);
      await sleep(1200);

      const landed = pick(['HEADS', 'TAILS']);
      const mine = landed === 'HEADS';
      const winner = mine ? userDoc : challenger;
      const loser = mine ? challenger : userDoc;

      await payout(winner, pot, 'game:cf_win', { bet, landed });
      if (!mine) await recordLoss(loser, 'game:cf_loss');

      await reply(
        `🪙 **IT CAME UP ${landed}**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🏆 ${winner.name} takes ${kc(pot)}\n`
        + `👛 Wallet: ${kc(winner.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'dicewar',
    aliases: [],
    category: 'games',
    description: '🎲 Dice war @user — highest roll wins the pot',
    usage: '!dicewar <user> <amount>',
    cooldown: 60,
    permission: 'all',
    execute: async ({ api, args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'dicewar', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('🎲');

      const bet = betArg(args.slice(1), 1000);
      const target = await targetOr(reply, event.messageID, args[0], event, 'dicewar', api);
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ You cannot war yourself.', event.messageID);
        return;
      }
      if ((target.coins || 0) < bet) {
        await reply(`💸 ${target.name} only has ${kc(target.coins)}.`, event.messageID);
        return;
      }

      const parked = cache.setPendingGame('dicewar', event.threadID, String(target.uid), {
        fromUid: String(event.senderID), fromName: userDoc.name, bet,
      });
      if (!parked) {
        await reply(`⏳ ${target.name} already has a dice war waiting.`, event.messageID);
        return;
      }
      await reply(
        `🎲 **DICE WAR**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💵 Pot: ${kc(bet)}\n`
        + `⏳ ${target.name}: \`!dicewaraccept\` — add \`no\` to duck.`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'dicewaraccept',
    aliases: [],
    category: 'games',
    description: '🎲 Take a dice war — highest roll wins',
    usage: '!dicewaraccept',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'dicewaraccept', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('🎲');

      if (await duck('dicewar', args, userDoc, reply, event)) return;
      const challenge = cache.takePendingGame('dicewar', event.threadID, String(event.senderID));
      if (!challenge) {
        await reply('📭 No dice war waiting for you.', event.messageID);
        return;
      }
      const challenger = await User.findOne({ uid: challenge.fromUid });
      if (!challenger) {
        await reply('❌ Challenger left. Pot void.', event.messageID);
        return;
      }

      const bet = challenge.bet;
      if ((userDoc.coins || 0) < bet || (challenger.coins || 0) < bet) {
        await reply('❌ Pot no longer covered. Void.', event.messageID);
        return;
      }
      const a = await wager(challenger, bet, 'game:dice_challenger');
      if (!a.ok) { await reply(a.reason, event.messageID); return; }
      const b = await wager(userDoc, bet, 'game:dice_accept');
      if (!b.ok) {
        await wager(challenger, bet, 'game:dice_refund');
        await reply(b.reason, event.messageID);
        return;
      }

      await reply('🎲 Rolling…', event.messageID);
      await sleep(1200);

      const mine = rand(1, 20);
      const theirs = rand(1, 20);
      const pot = bet * 2;
      const winner = mine >= theirs ? userDoc : challenger;
      const loser = mine >= theirs ? challenger : userDoc;

      await payout(winner, pot, 'game:dice_win', { bet, mine, theirs });
      if (mine < theirs) await recordLoss(loser, 'game:dice_loss');

      await reply(
        `🎲 ${userDoc.name}: ${mine} · ${challenger.name}: ${theirs}\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🏆 ${winner.name} takes ${kc(pot)}\n`
        + `👛 Wallet: ${kc(winner.coins)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'rpsduel',
    aliases: [],
    category: 'games',
    description: '✊ Rock paper scissors duel @user — best of one, pot doubles',
    usage: '!rpsduel <user> <amount>',
    cooldown: 60,
    permission: 'all',
    execute: async ({ api, args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'rpsduel', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('✊');

      const bet = betArg(args.slice(1), 500);
      const target = await targetOr(reply, event.messageID, args[0], event, 'rpsduel', api);
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ You cannot rock-paper-scissors yourself.', event.messageID);
        return;
      }
      if ((target.coins || 0) < bet) {
        await reply(`💸 ${target.name} only has ${kc(target.coins)}.`, event.messageID);
        return;
      }

      const parked = cache.setPendingGame('rps', event.threadID, String(target.uid), {
        fromUid: String(event.senderID), fromName: userDoc.name, bet,
      });
      if (!parked) {
        await reply(`⏳ ${target.name} already has a throw waiting.`, event.messageID);
        return;
      }
      await reply(
        `✊ **ROCK PAPER SCISSORS**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💵 Pot: ${kc(bet)}\n`
        + `⏳ ${target.name}: \`!rpsaccept rock|paper|scissors\` — add \`no\` to duck.`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'rpsaccept',
    aliases: [],
    category: 'games',
    description: '✊ Take an RPS duel and throw your hand',
    usage: '!rpsaccept <rock|paper|scissors>',
    cooldown: 30,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'rpsaccept', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('✊');

      if (await duck('rps', args, userDoc, reply, event)) return;
      const challenge = cache.takePendingGame('rps', event.threadID, String(event.senderID));
      if (!challenge) {
        await reply('📭 No RPS challenge for you.', event.messageID);
        return;
      }
      const challenger = await User.findOne({ uid: challenge.fromUid });
      if (!challenger) {
        await reply('❌ Challenger left. Pot void.', event.messageID);
        return;
      }

      // Aliases are accepted, but the throw is drawn from the three distinct
      // hands only. Rolling over the whole table would hand the challenger's
      // side of the table a 2-in-6 chance of any one hand.
      const HANDS = { rock: '🪨', paper: '📄', scissors: '✂️', r: '🪨', p: '📄', s: '✂️' };
      const THREE_HANDS = ['🪨', '📄', '✂️'];
      const mineRaw = String(args[0] || '').toLowerCase();
      const mine = HANDS[mineRaw];
      if (!mine) {
        // Hand the challenge back: a typo must not destroy the duel.
        cache.setPendingGame('rps', event.threadID, String(event.senderID), challenge);
        await reply('❌ Throw `rock`, `paper` or `scissors`.', event.messageID);
        return;
      }

      const bet = challenge.bet;
      if ((userDoc.coins || 0) < bet || (challenger.coins || 0) < bet) {
        await reply('❌ Pot no longer covered. Void.', event.messageID);
        return;
      }
      const a = await wager(challenger, bet, 'game:rps_challenger');
      if (!a.ok) { await reply(a.reason, event.messageID); return; }
      const b = await wager(userDoc, bet, 'game:rps_accept');
      if (!b.ok) {
        await wager(challenger, bet, 'game:rps_refund');
        await reply(b.reason, event.messageID);
        return;
      }

      const theirs = pick(THREE_HANDS);
      await reply('✊ ...', event.messageID);
      await sleep(1200);

      const BEATS = { '🪨': '✂️', '✂️': '📄', '📄': '🪨' };
      const pot = bet * 2;
      let winner;
      if (mine === theirs) winner = null;
      else if (BEATS[mine] === theirs) winner = userDoc;
      else winner = challenger;

      if (!winner) {
        await payout(userDoc, bet, 'game:rps_draw', { bet });
        await payout(challenger, bet, 'game:rps_draw', { bet });
        await reply(`✊ ${mine} vs ${theirs} — **DRAW.** Stakes returned.\n📖 ${story()}`, event.messageID);
        return;
      }

      await payout(winner, pot, 'game:rps_win', { bet, mine, theirs });
      const loser = winner === userDoc ? challenger : userDoc;
      await recordLoss(loser, 'game:rps_loss');
      await reply(
        `✊ ${mine} vs ${theirs}\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🏆 ${winner.name} takes ${kc(pot)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'pokerduel',
    aliases: [],
    category: 'games',
    description: '🃏 Five card draw duel @user — best hand takes the pot',
    usage: '!pokerduel <user> <amount>',
    cooldown: 120,
    permission: 'all',
    execute: async ({ api, args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'pokerduel', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('🃏');

      const bet = betArg(args.slice(1), 2500);
      const target = await targetOr(reply, event.messageID, args[0], event, 'pokerduel', api);
      if (!target) return;
      if (String(target.uid) === String(event.senderID)) {
        await reply('❌ You cannot bluff yourself.', event.messageID);
        return;
      }
      if ((target.coins || 0) < bet) {
        await reply(`💸 ${target.name} only has ${kc(target.coins)}.`, event.messageID);
        return;
      }

      const parked = cache.setPendingGame('poker', event.threadID, String(target.uid), {
        fromUid: String(event.senderID), fromName: userDoc.name, bet,
      });
      if (!parked) {
        await reply(`⏳ ${target.name} already has a table waiting.`, event.messageID);
        return;
      }
      await reply(
        `🃏 **POKER DUEL**\n`
        + '━━━━━━━━━━━━━━━\n'
        + `💵 Pot: ${kc(bet)}\n`
        + `⏳ ${target.name}: \`!pokeraccept\` — add \`no\` to duck.`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'pokeraccept',
    aliases: [],
    category: 'games',
    description: '🃏 Sit down at a poker duel — best five card hand wins',
    usage: '!pokeraccept',
    cooldown: 60,
    permission: 'all',
    execute: async ({ args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'pokeraccept', async () => {
      if (await bannedCheck(reply, userDoc, event)) return;
      await react('🃏');

      if (await duck('poker', args, userDoc, reply, event)) return;
      const challenge = cache.takePendingGame('poker', event.threadID, String(event.senderID));
      if (!challenge) {
        await reply('📭 No poker table waiting for you.', event.messageID);
        return;
      }
      const challenger = await User.findOne({ uid: challenge.fromUid });
      if (!challenger) {
        await reply('❌ Challenger left. Pot void.', event.messageID);
        return;
      }

      const bet = challenge.bet;
      if ((userDoc.coins || 0) < bet || (challenger.coins || 0) < bet) {
        await reply('❌ Pot no longer covered. Void.', event.messageID);
        return;
      }
      const a = await wager(challenger, bet, 'game:poker_challenger');
      if (!a.ok) { await reply(a.reason, event.messageID); return; }
      const b = await wager(userDoc, bet, 'game:poker_accept');
      if (!b.ok) {
        await wager(challenger, bet, 'game:poker_refund');
        await reply(b.reason, event.messageID);
        return;
      }

      const deal = () => Array.from({ length: 5 }, () => rand(2, 14));
      const handName = (h) => {
        const s = [...h].sort((a, b) => b - a);
        if (s[0] === s[4]) return `four ${s[0]}s`;
        if (new Set(s).size === 3 && s.slice(0, 3).every((v) => v === s[0])) return `three ${s[0]}s`;
        if (new Set(s).size === 3) return 'two pair';
        if (new Set(s).size === 4) return `pair of ${s[0]}s`;
        if (s[0] - s[4] === 4) return 'straight';
        if (s.some((v) => v === 14)) return 'ace high';
        return `high ${s[0]}`;
      };
      const strength = (h) => {
        const s = [...h].sort((a, b) => b - a);
        if (s[0] === s[4]) return [7, s[0]];
        if (new Set(s).size === 3 && s.slice(0, 3).every((v) => v === s[0])) return [5, s[0]];
        if (new Set(s).size === 3) return [4, s[0], s[2]];
        if (new Set(s).size === 4) return [3, s[0]];
        if (s[0] - s[4] === 4) return [6, s[0]];
        return [2, s[0]];
      };

      const mine = deal();
      const theirs = deal();
      const pot = bet * 2;

      await reply('🃏 Dealing…', event.messageID);
      await sleep(1500);

      const mineStr = strength(mine);
      const theirsStr = strength(theirs);
      const cmp = (a, b) => (a[0] !== b[0] ? a[0] - b[0] : a.slice(1).reduce((x, y, i) => x + y * (i + 1), 0) - b.slice(1).reduce((x, y, i) => x + y * (i + 1), 0));
      const delta = cmp(mineStr, theirsStr);

      if (delta === 0) {
        await payout(userDoc, bet, 'game:poker_draw', { bet });
        await payout(challenger, bet, 'game:poker_draw', { bet });
        await reply(`🃏 Both drew ${handName(mine)}. **SPLIT POT.**\n📖 ${story()}`, event.messageID);
        return;
      }

      const winner = delta > 0 ? userDoc : challenger;
      const loser = delta > 0 ? challenger : userDoc;
      await payout(winner, pot, 'game:poker_win', { bet });
      await recordLoss(loser, 'game:poker_loss');
      await reply(
        `🃏 ${userDoc.name}: ${handName(mine)}\n`
        + `🃏 ${challenger.name}: ${handName(theirs)}\n`
        + '━━━━━━━━━━━━━━━\n'
        + `🏆 ${winner.name} takes ${kc(pot)}\n`
        + `📖 ${story()}`,
        event.messageID,
      );
    }),
  });

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
