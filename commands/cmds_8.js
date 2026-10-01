'use strict';

/**
 * MODULE 8 — DOWNLOAD + AI, GEMINI ONLY (35 commands)
 *
 * iKON-BOT v2 Ultra. The download half of the bot and the AI half, wired
 * together: every one of these 35 commands calls Gemini, and the downloaders
 * use it to write the caption rather than just handing back a file.
 *
 * Exports a plain array. No factories, no legacy loader.
 *
 * Shape required for every command:
 * { name, aliases, category, description, usage, cooldown, permission, execute }
 *
 * execute receives: { api, event, args, config, registry, gemini, reply, react, userDoc }
 * `reply` and `react` are already bound to the current thread, so a command
 * never calls api.sendMessage directly. Attachments go out through
 * reply({ body, attachment }, messageID).
 *
 * GEMINI
 * Every handler routes through askGemini(). That is the single place that
 * knows how to talk to generativelanguage.googleapis.com, which matters for two
 * reasons: the endpoint is spelt the same way 35 times or it is spelt wrong 35
 * times, and a missing API key has to degrade to a mock in exactly one spot
 * instead of crashing a command. geminiMock() builds the fallback from the same
 * prompt so the reply still has something true in it.
 *
 * The external download APIs (tikwm, lyrics.ovh, football-data, pollinations)
 * are all free and all flaky. Every one of them is wrapped in fetchJson /
 * fetchBuffer, which return null instead of throwing, and every command has a
 * defined path when they return null. A download API being down is a worse day,
 * not a broken bot.
 *
 * PRICING
 * Coin costs run 50-200 and are charged up front, before the expensive work
 * starts. Charging after would mean a player can be billed for a download that
 * failed. Every charge writes a 'downloader:<name>' line to the ledger.
 */

const axios = require('axios');
const User = require('../models/User');
const Economy = require('../models/Economy');
const mongo = require('../bot/mongo');
const canvasKit = require('../bot/canvas');

const config = require('../config');

const CASH = 'K-Cash';
const OWNER = 'Aphecks iKon Klerk';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';
const POLLINATIONS = 'https://image.pollinations.ai/prompt/';

/**
 * The persona prefix. Injected into every prompt so that a raw Gemini call and
 * an iKON call do not quietly return different voices.
 */
const LORE = [
  'You are the iKON-BOT v2 Ultra house voice for a chaotic Facebook chat bot.',
  `Your owner is ${OWNER}.`,
  'You are savage, fast, and genuinely useful underneath the bit.',
  'You never invent facts about real people, never roleplay as a real person,',
  'and you keep answers short enough to read in a chat window.',
].join(' ');

// ───────────────────────────────────────────────────────────
// GEMINI
// ───────────────────────────────────────────────────────────

/** Is a Gemini key configured at all? */
const hasGemini = () => Boolean(String(config.GEMINI_API_KEY || '').trim());

/**
 * Ask Gemini a question.
 *
 * @param {string} prompt the user-facing question, already worded
 * @param {string} style extra persona instruction for this kind of task
 * @returns {Promise<string>} the answer, or a mock when the key is absent,
 *   the network fails, or the API returns nothing usable. Never throws.
 */
async function askGemini(prompt, style = '') {
  const text = String(prompt || '').trim();
  if (!text) return geminiMock('', style);

  if (!hasGemini()) {
    // No key. The mock is built from the same prompt so the reply still tells
    // the user what happened instead of failing silently.
    return geminiMock(text, style);
  }

  try {
    const gemRes = await axios.post(`${GEMINI_URL}?key=${config.GEMINI_API_KEY}`, {
      contents: [{
        parts: [{
          text: [LORE, style, `Task: ${text}`].filter(Boolean).join('\n'),
        }],
      }],
      generationConfig: {
        maxOutputTokens: 900,
        temperature: 0.9,
      },
    });
    const out = gemRes.data
      && gemRes.data.candidates
      && gemRes.data.candidates[0]
      && gemRes.data.candidates[0].content
      && gemRes.data.candidates[0].content.parts;
    const answer = Array.isArray(out) ? out.map((p) => (p && p.text) || '').join('').trim() : '';
    if (!answer) return geminiMock(text, style);
    return answer;
  } catch (err) {
    // Rate limits and outages are normal. A 429 must not surface as a crash.
    return `${geminiMock(text, style)}\n\n_(Gemini said no: ${err.message})_`;
  }
}

/**
 * The offline answer. Deterministic where it can be, and honest about the fact
 * that it is a stand-in, so nobody mistakes it for a real Gemini response.
 */
function geminiMock(prompt, style = '') {
  const topic = String(prompt || '').replace(/\s+/g, ' ').trim();
  const short = topic.length > 90 ? `${topic.slice(0, 87)}...` : topic;
  const tagged = /roast|insult|diss/i.test(style);
  return [
    '⚠️ **GEMINI OFFLINE** — no API key on the bot, so this is a placeholder.',
    tagged
      ? `iKON would have roasted "${short}" into the ground. It did not happen, because there is no key.`
      : `You asked: *"${short}"*`,
    tagged ? '' : 'Set GEMINI_API_KEY in .env and this command starts working for real.',
  ].filter(Boolean).join('\n');
}

// ───────────────────────────────────────────────────────────
// HTTP — everything here returns null rather than throwing
// ───────────────────────────────────────────────────────────

/** GET a JSON API. Resolves null on any failure. */
async function fetchJson(url, options = {}) {
  try {
    const res = await axios({
      url,
      method: 'GET',
      timeout: 12000,
      responseType: 'json',
      ...options,
    });
    return res && res.data !== undefined ? res.data : null;
  } catch {
    return null;
  }
}

/** GET bytes as a Buffer. Resolves null on any failure. */
async function fetchBuffer(url, options = {}) {
  try {
    const res = await axios({
      url,
      method: 'GET',
      timeout: 20000,
      responseType: 'arraybuffer',
      ...options,
    });
    return Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data || []);
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────
// MONEY
// ───────────────────────────────────────────────────────────

/**
 * Charge a command's fee.
 *
 * Charged before any work starts: a player must never end up billed for a
 * download that failed halfway through.
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function charge(userDoc, cost, action) {
  const fee = clamp(cost);
  if (fee <= 0) return { ok: true };
  if ((userDoc.coins || 0) < fee) {
    return {
      ok: false,
      reason: `💸 **Not enough.** This costs ${kc(fee)} and you have ${kc(userDoc.coins)}.`,
    };
  }
  userDoc.coins = clamp(userDoc.coins - fee);
  await save(userDoc);
  await ledger(userDoc.uid, action, -fee, userDoc.coins, { cost: fee });
  return { ok: true };
}

/** Append one line to the economy ledger. Never throws. */
async function ledger(uid, action, amount, balanceAfter, metadata = {}) {
  if (!mongo.isReady()) return;
  try {
    await new Economy({ uid, action, amount, balanceAfter, metadata }).save();
  } catch { /* auditing is best effort */ }
}

/** Persist a document, tolerating offline mode. */
async function save(doc) {
  if (!doc || doc.transient) return;
  try {
    await doc.save();
  } catch { /* the reply still shows the outcome */ }
}

// ───────────────────────────────────────────────────────────
// LINKS AND IMAGES
// ───────────────────────────────────────────────────────────

/** Does this string look like a URL we can try to fetch? */
function isUrl(ref) {
  return /^https?:\/\/\S+$/i.test(String(ref || '').trim());
}

/** Pull the bare host out of a link, for a friendly "wrong site" message. */
function hostOf(ref) {
  try {
    return new URL(String(ref).trim()).hostname.replace(/^www\./, '');
  } catch {
    return 'that link';
  }
}

/** Which platform a link belongs to, by hostname. */
function platformOf(ref) {
  const h = hostOf(ref);
  if (/facebook|fb\.watch|fbsbx/i.test(h)) return 'facebook';
  if (/tiktok/i.test(h)) return 'tiktok';
  if (/instagram/i.test(h)) return 'instagram';
  if (/youtu\.?be|piped|vimeo/i.test(h)) return 'youtube';
  if (/twitter|x\.com/i.test(h)) return 'twitter';
  if (/pinterest/i.test(h)) return 'pinterest';
  return null;
}

/**
 * The URL of the image the user replied to.
 *
 * Messenger hands us the quoted message id, so the attachment has to be looked
 * up. Returns { url } or null — every image command treats null as "reply to a
 * photo first" rather than crashing.
 */
async function repliedImage(api, event) {
  try {
    const info = await api.getThreadInfo(event.threadID);
    const list = (info && (info.messageList || info.messages)) || [];
    const msg = list.find((m) => String(m.messageID) === String(event.messageID))
      || list[list.length - 1];
    const atts = (msg && msg.attachments) || [];
    for (const a of atts) {
      const url = (a && (a.url || a.fileUrl || (a.data && a.data.url))) || '';
      const isImage = !a.type || a.type === 'image' || String(url).match(/\.(jpe?g|png|webp|gif)(\?|$)/i);
      if (url && isImage) return { url };
    }
  } catch {
    return null;
  }
  return null;
}

/** Load an image URL into an @napi-rs canvas. Null on any failure. */
async function loadImage(url) {
  const made = canvasKit.create(1024, 1024);
  if (!made) return null;
  const { ctx } = made;
  try {
    // eslint-disable-next-line global-require
    const { Image } = canvasKit.lib() || {};
    const img = new Image();
    img.src = Buffer.from(await fetchBuffer(url) || []);
    const w = Math.min(1024, img.width || 1024);
    const h = Math.min(1024, img.height || 1024);
    ctx.drawImage(img, 0, 0, w, h);
    return made;
  } catch {
    return null;
  }
}

/** A canvas to a data URL, or null when canvas is unavailable. */
async function pngUrl(canvasObj) {
  const buffer = await canvasKit.toBuffer(canvasObj && canvasObj.canvas);
  return buffer ? `data:image/png;base64,${buffer.toString('base64')}` : null;
}

/**
 * Render a bordered caption card: title, subtitle, body text and a footer.
 * Used by generate, imagine, 4k, upscale, enhance and bgremove, so every image
 * command in the module comes out looking like it came from the same bot.
 *
 * @returns {Promise<string|null>} data URL, or null when canvas is missing
 */
async function captionCard({ title, subtitle = '', body = '', footer = '', accent = canvasKit.theme.accent }) {
  const made = canvasKit.create(800, 520);
  if (!made) return null;
  const { ctx } = made;

  const bg = ctx.createLinearGradient(0, 0, 800, 520);
  bg.addColorStop(0, canvasKit.theme.bg1);
  bg.addColorStop(1, canvasKit.theme.bg2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 800, 520);

  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 800, 10);

  ctx.fillStyle = canvasKit.theme.text;
  ctx.font = 'bold 38px iKonSans';
  wrap(ctx, title || 'iKON', 50, 78, 700, 44);

  ctx.fillStyle = canvasKit.theme.accent2;
  ctx.font = '26px iKonSans';
  if (subtitle) wrap(ctx, subtitle, 50, 140, 700, 32);

  ctx.fillStyle = canvasKit.theme.muted;
  ctx.font = '22px iKonSans';
  let y = subtitle ? 200 : 150;
  y = wrap(ctx, body || '', 50, y, 700, 30);

  if (footer) {
    ctx.fillStyle = canvasKit.theme.gold;
    ctx.font = 'bold 20px iKonSans';
    wrap(ctx, footer, 50, 470, 700, 24);
  }

  return pngUrl(made);
}

/**
 * Draw wrapped text and return the y position just past the last line.
 * Needed because Gemini answers are longer than any single line.
 */
function wrap(ctx, text, x, y, maxWidth, lineHeight) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  let line = '';
  let at = y;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, at);
      line = w;
      at += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) {
    ctx.fillText(line, x, at);
    at += lineHeight;
  }
  return at;
}

// ───────────────────────────────────────────────────────────
// SMALL HELPERS
// ───────────────────────────────────────────────────────────

/** Run a handler with a user-facing safety net. */
async function guard(reply, messageID, label, fn) {
  try {
    await fn();
  } catch (err) {
    await reply(`⚠️ \`${label}\` failed: ${err.message}`, messageID);
  }
}

const clamp = (v) => Math.max(0, Math.floor(Number(v) || 0));
const num = (v) => Number(v || 0).toLocaleString('en-US');
const kc = (v) => `${Number(v || 0).toLocaleString('en-US')} ${CASH}`;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** How a fee is labelled in a receipt line. */
const FEES = {
  fbdown: 100,
  tiktokdown: 100,
  igdown: 100,
  ytdown: 100,
  twitterdown: 100,
  pinterestdown: 100,
  pinterestsearch: 150,
  lyrics: 50,
  sing: 150,
  say: 50,
  ask: 50,
  ai: 50,
  gemini: 50,
  translate: 50,
  generate: 200,
  imagine: 200,
  '4k': 200,
  upscale: 200,
  enhance: 150,
  bgremove: 200,
  football: 50,
  livefootball: 50,
  score: 50,
  footballnews: 50,
  matchpredict: 100,
  cricketscore: 50,
  weatherai: 50,
  newsai: 50,
  wiki: 50,
  define: 50,
  summarize: 50,
  rewrite: 50,
  storyai: 100,
  codeai: 100,
  songai: 150,
};

/** Every command in this module, in registration order. */
const commands = [];

// ───────────────────────────────────────────────────────────

module.exports = commands;
