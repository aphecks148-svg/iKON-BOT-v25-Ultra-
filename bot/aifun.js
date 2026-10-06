'use strict';

/**
 * bot/aifun.js — AI content for the party-game commands.
 *
 * The fun decks (!riddleultra, !quoteultra, !triviaultra, !truth, !dare,
 * !wouldyourather, !neverhaveiever, !2truth1lie, !roast, !pickupline,
 * !compliment, !jokeultra) used to draw from hand-written tables of 8 to
 * 20 entries. In a busy chat that reads as repetition: the same riddle
 * returns after nine pulls, the same lie every time. This module is the
 * AI in front of those tables.
 *
 * THE CONTRACT
 *
 * - Every generator resolves to content or null, and never throws. Null
 *   means "use the hand-written table", which is what happens whenever
 *   GROQ_API_KEY is absent — so with no key the bot behaves exactly as
 *   before, with zero latency and zero network traffic.
 *
 * - Groq is the only transport (bot/groq.js). The answer is parsed from a
 *   strict labeled shape the prompt demands; anything that does not parse
 *   is treated as "Groq did not answer" and the table is used instead. A
 *   game must always be able to start.
 *
 * - No repeats. Each generator keeps the last 40 signatures it served and
 *   asks Groq a second time when the first answer is one of them. The
 *   hand-written fallback gets the same treatment via pickFresh, which
 *   never serves the same index twice in a row.
 *
 * - Short budgets are deliberately NOT set. On the gpt-oss family the
 *   token cap also pays for reasoning, so a cap sized for the answer can
 *   come back empty (see bot/groq.js). Party content is a few words; the
 *   default budget is the safe side of that trade.
 */

const groq = require('./groq');

/** Shared persona. groq.js appends this as a system message, never as a preamble. */
const SYSTEM = [
  'You write content for party games in a group chat.',
  'Keep every answer short, original and safe for a mixed group.',
  'Never use emojis.',
].join(' ');

/** The labeled shape the question-and-answer games demand. */
const QAA_SHAPE = [
  'Reply in exactly this shape, nothing else:',
  'Q: <the question>',
  'A: <the short answer>',
  'A2: <a synonym of the answer, or leave the line out>',
].join('\n');

/** Signatures served per generator, newest last. */
const recent = new Map();

/** Last index served per static table, so a fallback never repeats either. */
const lastPick = new Map();

const clean = (s) => String(s || '').trim();

function lines(text) {
  return String(text || '').split('\n').map(clean).filter(Boolean);
}

/**
 * The value of the first line shaped like "<tag>: value" (a period works
 * too, and the tag may be a pattern such as "A2?"). The delimiter is
 * required, so "A3: z" is not a match for the label "A" with the value
 * "3: z".
 *
 * @param {string} text the model's answer
 * @param {string} tag regex source for the label
 * @returns {string} the value, or '' when no line matches
 */
function lineValue(text, tag) {
  const re = new RegExp(`^(?:${tag})\\s*[.:]\\s*(.+)$`, 'i');
  for (const line of lines(text)) {
    const m = line.match(re);
    if (m && clean(m[1])) return clean(m[1]);
  }
  return '';
}

/** Every line shaped like "<tag>: value". */
function lineValues(text, tag) {
  const re = new RegExp(`^(?:${tag})\\s*[.:]\\s*(.+)$`, 'i');
  return lines(text)
    .map((line) => line.match(re))
    .filter(Boolean)
    .map((m) => clean(m[1]))
    .filter(Boolean);
}

/**
 * A plain one-line answer. Surrounding quotes are stripped and a refusal
 * is rejected, so a model that declines still counts as "no answer" and
 * the hand-written table takes over.
 *
 * @param {string} text the model's answer
 * @param {number} max longest acceptable length
 * @returns {string|null}
 */
function oneLiner(text, max) {
  let s = clean(text).split('\n').join(' ').replace(/\s{2,}/g, ' ');
  s = s.replace(/^["'“‘]+/, '').replace(/["'”’]+$/, '');
  if (s.length < 3 || s.length > max) return null;
  if (/^(sorry|i can'?t|i cannot|as an ai|i am an ai|i'?m sorry)\b/i.test(s)) return null;
  return s;
}

/** Case- and punctuation-insensitive signature for the repeat check. */
function sig(s) {
  return clean(s).toLowerCase().replace(/\s+/g, ' ');
}

function repeated(key, signature) {
  return (recent.get(key) || []).includes(signature);
}

function remember(key, signature) {
  const list = recent.get(key) || [];
  list.push(signature);
  if (list.length > 40) list.splice(0, list.length - 40);
  recent.set(key, list);
}

/**
 * The loop every generator shares: no key means null straight away,
 * otherwise ask Groq, parse, and try again once when the parse failed or
 * the model served a repeat. A repeat on the second attempt is accepted —
 * fresh AI content that happens to rhyme with the last one still beats an
 * eight-entry table.
 *
 * @param {string} key generator name, scopes the repeat memory
 * @param {string} prompt the user message, already worded
 * @param {(text:string)=>object|null} parse turns the raw answer into content
 * @param {(value:object)=>string} sigOf the repeat signature of parsed content
 * @returns {Promise<object|null>}
 */
async function generate(key, prompt, parse, sigOf) {
  if (!groq.available()) return null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const value = parse(await groq.ask(prompt, { system: SYSTEM, temperature: 0.7 }));
    if (!value) continue;
    const signature = sigOf(value);
    if (attempt === 0 && repeated(key, signature)) continue;
    remember(key, signature);
    return value;
  }
  return null;
}

/**
 * A random pick that never serves the same index twice in a row. The
 * hand-written tables are 8 to 20 entries; plain random picks repeat
 * constantly, which is the complaint this module exists to fix.
 *
 * @param {object[]} list the hand-written table
 * @param {string} key scopes the memory
 * @returns {object|undefined}
 */
function pickFresh(list, key) {
  if (!Array.isArray(list) || !list.length) return undefined;
  if (list.length < 2) return list[0];
  const last = lastPick.get(key);
  let i = Math.floor(Math.random() * list.length);
  if (i === last) i = (i + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length;
  lastPick.set(key, i);
  return list[i];
}

/**
 * Normalize an answer for comparison: case, leading articles,
 * punctuation. "The Pacific" and "pacific" become the same string.
 */
function normA(s) {
  return String(s).toLowerCase().trim()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does a guess answer the question? Word-level matching, so "orwell" hits
 * "george orwell" and "a keyboard" hits "keyboard" — but "mars" misses
 * "marseille", which a plain substring test would accept. Exact for the
 * hand-written lists, forgiving for the AI-written ones.
 *
 * @param {string} guess the player's answer
 * @param {string[]} answers the accepted answers
 * @returns {boolean}
 */
function answerHits(guess, answers) {
  const g = normA(guess);
  if (!g) return false;
  const gw = g.split(' ');
  return (answers || []).some((a) => {
    const n = normA(a);
    if (!n) return false;
    if (n === g) return true;
    const aw = n.split(' ');
    return gw.every((w) => aw.includes(w)) || aw.every((w) => gw.includes(w));
  });
}

// ───────────────────────────────────────────────────────────
// QUESTION + ANSWER GAMES
// ───────────────────────────────────────────────────────────

/** { q, a: string[] } or null. Shared by the riddle and trivia games. */
function parseQAA(text) {
  const q = lineValue(text, 'Q');
  const answers = lineValues(text, 'A2?').slice(0, 3);
  if (!q || q.length > 400 || !answers.length) return null;
  if (answers.some((a) => a.length > 60)) return null;
  return { q, a: answers };
}

/** One original riddle, or null when Groq is away. */
async function genRiddle() {
  return generate(
    'riddle',
    'Write one original riddle for a group chat. The answer must be one common word or a short phrase. Do not copy a famous riddle verbatim.\n\n' + QAA_SHAPE,
    parseQAA,
    (v) => sig(v.q),
  );
}

/** One trivia question with a short unambiguous answer, or null. */
async function genTrivia() {
  return generate(
    'trivia',
    'Write one trivia question with one unambiguous short answer. Prefer words over numbers, and knowledge a group can actually guess.\n\n' + QAA_SHAPE,
    parseQAA,
    (v) => sig(v.q),
  );
}

/** { text, author } or null. The author is the answer to the game. */
async function genQuote() {
  return generate(
    'quote',
    'Write one short memorable quote, and the famous person it sounds like it belongs to. It feeds a guessing game, so the style of the person is the point.\n'
    + 'Reply in exactly this shape, nothing else:\nQUOTE: <the quote>\nAUTHOR: <the person, first and last name>',
    (text) => {
      const quote = lineValue(text, 'QUOTE');
      const author = lineValue(text, 'AUTHOR');
      if (!quote || !author) return null;
      if (quote.length > 300 || author.length > 60) return null;
      if (!/[a-z]/i.test(author)) return null;
      return { text: quote, author };
    },
    (v) => sig(v.text),
  );
}

// ───────────────────────────────────────────────────────────
// PARTY GAMES
// ───────────────────────────────────────────────────────────

/** One truth question, or null. */
async function genTruth() {
  return generate(
    'truth',
    'Write one truth question for a mixed group chat. Interesting, not illegal, not too personal. Reply with just the question.',
    (text) => oneLiner(text, 300),
    (v) => sig(v),
  );
}

/** One dare as a verb phrase, or null. */
async function genDare() {
  return generate(
    'dare',
    'Write one dare for a group chat game, as a verb phrase like "sing the chorus of a song in a dramatic voice". It must be silly, safe and doable without leaving the chat. No danger, no illegal things, no real money. Reply with just the dare.',
    (text) => oneLiner(text, 200),
    (v) => sig(v),
  );
}

/** One never-have-I-ever prompt as a verb phrase, or null. */
async function genNever() {
  return generate(
    'never',
    'Write one never-have-I-ever prompt as a verb phrase like "sung in public with confidence". Mild and chat-appropriate. Reply with just the activity.',
    (text) => oneLiner(text, 200),
    (v) => sig(v),
  );
}

/** One joke, or null. */
async function genJoke() {
  return generate(
    'joke',
    'Write one short joke, clean enough for a mixed group. Reply with just the joke.',
    (text) => oneLiner(text, 300),
    (v) => sig(v),
  );
}

/** One cheesy pickup line, or null. */
async function genPickup() {
  return generate(
    'pickup',
    'Write one cheesy pickup line a player could send in a group chat. Reply with just the line.',
    (text) => oneLiner(text, 200),
    (v) => sig(v),
  );
}

/** One would-you-rather pair [option, option], or null. */
async function genWyr() {
  return generate(
    'wyr',
    'Write one would-you-rather question with two options. Both options must be slightly awful, neither one safe.\n'
    + 'Reply in exactly this shape, nothing else:\n1. <first option>\n2. <second option>',
    (text) => {
      const one = lineValue(text, '1');
      const two = lineValue(text, '2');
      if (!one || !two) return null;
      if (one.length > 120 || two.length > 120) return null;
      if (sig(one) === sig(two)) return null;
      return [one, two];
    },
    (v) => sig(v.join(' | ')),
  );
}

/**
 * One plausible-but-false statement about a player, or null. The real
 * stats are handed over so the invented line sits believably between two
 * true ones — the whole point of the game.
 *
 * @param {string} stats the player's real counters, already formatted
 */
async function genLie(stats) {
  const s = clean(stats);
  if (!s) return null;
  return generate(
    'lie',
    `A player in this group chat has these real stats: ${s}\nWrite ONE sentence about this player that sounds true but is FALSE. Invent a number or an event that never happened, but keep it plausible next to the real stats. Reply with just the sentence.`,
    (text) => oneLiner(text, 200),
    (v) => sig(v),
  );
}

// ───────────────────────────────────────────────────────────
// AIMED ONE-LINERS
// ───────────────────────────────────────────────────────────

/**
 * One roast aimed at a named player, or null. The model is handed the
 * name and nothing else, which is what keeps it from inventing a fact
 * about a real person: it has none to invent from.
 *
 * @param {string} name the target's display name
 */
async function genRoast(name) {
  const n = clean(name);
  if (!n) return null;
  return generate(
    'roast',
    `Write one short roast of a group chat member named ${n}. Banter, not abuse: no slurs, no threats, nothing about looks or real life. You know only the name, so invent no facts about them. Reply with just the roast.`,
    (text) => oneLiner(text, 200),
    (v) => sig(v),
  );
}

/** One compliment with a backhand buried in it, aimed at a named player. */
async function genCompliment(name) {
  const n = clean(name);
  if (!n) return null;
  return generate(
    'compliment',
    `Write one compliment for a group chat member named ${n} with a backhand buried in it. The surface must still read as praise. You know only the name, so invent no facts about them. Reply with just the sentence.`,
    (text) => oneLiner(text, 200),
    (v) => sig(v),
  );
}

/** Test seam: forget served signatures and last picks. */
function _reset() {
  recent.clear();
  lastPick.clear();
}

module.exports = {
  genRiddle,
  genTrivia,
  genQuote,
  genTruth,
  genDare,
  genNever,
  genJoke,
  genPickup,
  genWyr,
  genLie,
  genRoast,
  genCompliment,
  pickFresh,
  answerHits,
  _reset,
  // Exported for the test suite, the same way bot/groq.js exports
  // extractText: the parsers are the contract with the model.
  parseQAA,
  oneLiner,
  lineValue,
  lineValues,
};
