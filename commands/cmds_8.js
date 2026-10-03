'use strict';

/**
 * MODULE 8 — DOWNLOAD + AI, GROQ ONLY (37 commands)
 *
 * iKON-BOT v2 Ultra. The download half of the bot and the AI half, wired
 * together: these 37 commands all call Groq, and the downloaders use it to
 * write the caption that goes out with the file.
 *
 * DOWNLOADING IS NOT OPTIONAL
 * A download command that ends in a URL is a link dispenser. So every download
 * here resolves the link through bot/media.js and sends the actual bytes as an
 * attachment: YouTube audio and video come off YouTube's own innertube API,
 * TikTok/Facebook/Instagram/X come off tikwm, `!sing` sends a voice note, and
 * `!pinterestsearch` sends six pictures. The link is only ever the fallback for
 * when the upload itself fails, and the command says so when it does.
 *
 * Exports a plain array. No factories, no legacy loader.
 *
 * Shape required for every command:
 * { name, aliases, category, description, usage, cooldown, permission, execute }
 *
 * execute receives: { api, event, args, config, registry, ai, reply, react, userDoc }
 * `reply` and `react` are already bound to the current thread, so a command
 * never calls api.sendMessage directly. Attachments go out through
 * reply({ body, attachment }, messageID).
 *
 * AI — GROQ ONLY
 * Every handler routes through askGroq(). That is the single place that knows
 * how to talk to api.groq.com, which matters for two reasons: the endpoint is
 * spelt the same way 37 times or it is spelt wrong 37 times, and a missing API
 * key has to degrade to a placeholder in exactly one spot instead of crashing
 * a command. aiOffline() builds that fallback from the same prompt so the reply
 * still has something true in it.
 *
 * The external APIs (innertube, tikwm, Bing images, lyrics.ovh, Google TTS,
 * football-data, pollinations) are all free and all flaky. Every one of them is
 * wrapped by bot/media.js or fetchJson/fetchBuffer, which return null instead of
 * throwing, and every command has a defined path when they do. A download API
 * being down is a worse day, not a broken bot.
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
const groq = require('../bot/groq');
const media = require('../bot/media');

const config = require('../config');

const CASH = 'K-Cash';
const OWNER = 'Aphecks iKon Klerk';
const POLLINATIONS = 'https://image.pollinations.ai/prompt/';
const OPENLIGADB = 'https://www.openligadb.de/api/getmatchdata';

/**
 * The persona prefix. Injected into every prompt so that a raw Groq call and
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
// AI — GROQ
// ───────────────────────────────────────────────────────────

/**
 * Ask Groq a question.
 *
 * The HTTP call lives in bot/groq.js so the engine and these commands share one
 * client. This wrapper only adds the iKON persona and the offline placeholder,
 * so every AI command keeps its existing behaviour: a real answer when Groq
 * answers, an honest placeholder when it cannot.
 *
 * @param {string} prompt the user-facing question, already worded
 * @param {string} style extra persona instruction for this kind of task
 * @returns {Promise<string>} never throws
 */
async function askGroq(prompt, style = '') {
  const text = String(prompt || '').trim();
  if (!text) return aiOffline('', style);

  const answer = await groq.ask(text, {
    system: LORE,
    style,
    maxTokens: 2048,
  });
  if (answer) return answer;

  // Distinguish "no key" from "key present but Groq refused": telling a user
  // with a working key to go set GROQ_API_KEY sends them nowhere.
  const why = groq.available()
    ? `Groq did not answer: ${groq.lastErrorMessage() || 'no response'}`
    : 'no GROQ_API_KEY on the bot';
  return `${aiOffline(text, style)}\n\n_(⚠️ ${why})_`;
}

/**
 * The offline answer. Deterministic where it can be, and honest about the fact
 * that it is a stand-in, so nobody mistakes it for a real Groq response.
 */
function aiOffline(prompt, style = '') {
  const topic = String(prompt || '').replace(/\s+/g, ' ').trim();
  const short = topic.length > 90 ? `${topic.slice(0, 87)}...` : topic;
  const tagged = /roast|insult|diss/i.test(style);
  return [
    '⚠️ **AI OFFLINE** — this is a placeholder, not a real answer.',
    tagged
      ? `iKON would have roasted "${short}" into the ground. It did not happen, because Groq is not answering.`
      : `You asked: *"${short}"*`,
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

/** Named CSS colours Groq can pick from for the knock-out. */
const BGCOLOURS = {
  white: '#ffffff', black: '#000000', grey: '#808080', gray: '#808080',
  blue: '#2a52c4', green: '#2e8b57', red: '#c42a2a', yellow: '#f2e629',
  sky: '#7fc4e8', beige: '#e6d8b8', pink: '#f2a3c0', purple: '#7a3fa0',
  brown: '#6b4423', orange: '#e07b2a',
};

/**
 * Draw an image onto a fresh canvas, scaled.
 *
 * `imageSmoothingQuality` is the whole point of an upscale: without it canvas
 * gives nearest-neighbour and a 4x looks like a broken zoom. The canvas is
 * capped at 4096 per side because anything larger is rejected by the renderer
 * and wasted memory.
 *
 * @returns {Promise<{canvas:object, url:string, width:number, height:number}|null>}
 */
async function drawScaled(url, factor, filter = null) {
  const buf = await fetchBuffer(url);
  if (!buf || !buf.length) return null;
  const lib = canvasKit.lib();
  if (!lib) return null;
  const { Image } = lib;

  try {
    const img = new Image();
    img.src = buf;
    const w = Math.min(4096, Math.max(1, Math.round((img.width || 512) * factor)));
    const h = Math.min(4096, Math.max(1, Math.round((img.height || 512) * factor)));
    const made = canvasKit.create(w, h);
    if (!made) return null;
    const { ctx } = made;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (filter) ctx.filter = filter;
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = await pngUrl(made);
    return dataUrl ? { canvas: made.canvas, url: dataUrl, width: w, height: h } : null;
  } catch {
    return null;
  }
}

/**
 * Upscale a URL by `factor` (2 or 4).
 * @returns {Promise<{url:string,width:number,height:number}|null>}
 */
async function upscale(url, factor) {
  const shot = await drawScaled(url, factor);
  return shot ? { url: shot.url, width: shot.width, height: shot.height } : null;
}

/**
 * Apply a Groq-chosen treatment. `fix` is a canvas filter keyword, `strength`
 * is the multiplier, and it is clamped here rather than trusted from the model.
 * @returns {Promise<string|null>} data URL
 */
async function enhanceImage(url, fix, strength) {
  const amount = Number.isFinite(strength) ? Math.max(0.5, Math.min(2, strength)) : 1.2;
  const filters = {
    contrast: `contrast(${amount}) brightness(${(1 + (amount - 1) * 0.5).toFixed(2)})`,
    saturation: `saturate(${amount})`,
    sharpen: 'grayscale(0) contrast(1.1)',
    brightness: `brightness(${amount})`,
    grayscale: 'grayscale(1) contrast(1.15)',
  };
  const shot = await drawScaled(url, 1, filters[String(fix || '').toLowerCase()] || filters.contrast);
  return shot ? shot.url : null;
}

/**
 * Knock a flat background out by colour-keying it transparent.
 *
 * This is a canvas approximation, not a segmentation model, and the command says
 * so in its reply. It works well on a person against a plain wall and badly on
 * a busy scene, which is exactly what the caveat promises.
 *
 * @param {string} url source image
 * @param {string} colour a word Groq named, or a hex value
 * @returns {Promise<{url:string, keyed:boolean}|null>} keyed is false when no
 *   colour was understood, so the caller can say so instead of claiming a cut
 *   it did not perform.
 */
async function knockOut(url, colour) {
  const shot = await drawScaled(url, 1);
  if (!shot) return null;

  let hex = BGCOLOURS[String(colour || '').toLowerCase().trim()];
  if (!hex && /^#[0-9a-f]{3,8}$/i.test(String(colour).trim())) hex = String(colour).trim();
  if (!hex) return { url: shot.url, keyed: false };

  const made = canvasKit.create(shot.width, shot.height);
  if (!made) return { url: shot.url, keyed: false };
  const { ctx } = made;
  ctx.drawImage(shot.canvas, 0, 0);

  let pixels;
  try {
    pixels = ctx.getImageData(0, 0, shot.width, shot.height);
  } catch {
    return { url: shot.url, keyed: false };
  }

  const tr = parseInt(hex.slice(1, 3), 16);
  const tg = parseInt(hex.slice(3, 5), 16);
  const tb = parseInt(hex.slice(5, 7), 16);
  const data = pixels.data;
  // Tolerance scaled by how dark the key colour is: a near-black background
  // needs a tighter window than a cream one or the subject goes with it.
  const tol = 60 + (Math.max(tr, tg, tb) < 90 ? 20 : 0);

  let cleared = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs(data[i] - tr) < tol
      && Math.abs(data[i + 1] - tg) < tol
      && Math.abs(data[i + 2] - tb) < tol) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
      cleared += 1;
    }
  }
  // Keying a colour that is not in the picture would otherwise report success
  // while doing nothing, which is worse than saying so.
  if (!cleared) return { url: shot.url, keyed: false };
  ctx.putImageData(pixels, 0, 0);
  const out = await pngUrl(made);
  return { url: out || shot.url, keyed: true };
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
 * Needed because Groq answers are longer than any single line.
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

/**
 * The search topic hiding in a pin URL.
 *
 * `/pin/1055599564417088/cute-black-cat/` carries its own subject, so the
 * recovery hint can name it instead of telling the user to invent one. Returns
 * '' when the link has no slug, and the caller words the hint accordingly.
 */
function pinTopic(link) {
  const slug = String(link || '').match(/\/pin\/[^/?#]+\/([^/?#]+)/);
  if (!slug) return '';
  try {
    return decodeURIComponent(slug[1]).replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  } catch {
    return '';
  }
}

// ───────────────────────────────────────────────────────────
// SENDING THE ACTUAL THING
//
// Every download command used to end with a link and a Groq joke. A link is not
// a download, so all of them now end here instead: the real file goes out as an
// attachment, and if the file cannot be had the honest link message does. The
// helpers below are shared so a command only has to resolve something.
// ───────────────────────────────────────────────────────────

/** "12.4 MB", for a file the user is about to receive. */
function humanSize(bytesCount) {
  const n = Number(bytesCount) || 0;
  if (!n) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Send a resolved file to the chat.
 *
 * The upload, not the link, is the feature. So the file is the message body and
 * the attachment, and the plain link only comes out when the bytes could not be
 * fetched — with the reason, because "it did not work" is what a paid command
 * feels like otherwise.
 *
 * @param {object} o
 * @param {function} o.reply bound reply
 * @param {string|number} o.messageID the command message
 * @param {object} o.resolved from media.resolve()
 * @param {string} [o.caption] Groq's text, shown above the file
 * @param {string} [o.label] command name for the failure line
 * @param {number} [o.fee] what was charged, so a failure can say so
 * @returns {Promise<boolean>} whether the file went out
 */
async function sendFile({ reply, messageID, resolved, caption = '', label = 'download', fee = 0 }) {
  const file = resolved && resolved.file;
  if (!file || !file.url) {
    await reply(noFileLine(label, fee, resolved), messageID);
    return false;
  }

  const header = [
    `📥 **${(resolved.title || 'Downloaded').slice(0, 90)}**`,
    resolved.author ? `👤 ${String(resolved.author).slice(0, 60)}` : '',
    resolved.music ? `🎵 ${String(resolved.music).slice(0, 60)}` : '',
    [
      resolved.platform ? `📡 ${resolved.platform}` : '',
      resolved.mode === 'audio' ? '🎧 audio only' : '',
      resolved.qualityLabel ? `🎞️ ${resolved.qualityLabel}` : '',
      file.mimeType ? `📄 ${file.mimeType}` : '',
      file.size ? `💾 ${humanSize(file.size)}` : '',
    ].filter(Boolean).join(' · '),
  ].filter(Boolean).join('\n');

  const body = [caption, header].filter(Boolean).join('\n\n');

  // A file we already know is too big is not worth downloading to find out.
  // Facebook's ceiling is around 50MB and Render's free memory is smaller, so
  // the raw link beats an upload that fails after a long wait.
  if (file.size && file.size > media.MAX_UPLOAD_BYTES) {
    await reply(
      `${body}\n\n⚠️ That file is ${humanSize(file.size)}, over what Messenger will take. `
      + `Here is the link — \`!mp3\` for the audio on its own is usually small enough:\n⬇️ ${file.url}`,
      messageID,
    );
    return false;
  }

  // A resolved stream is the difference between the file arriving and not.
  const stream = await media.attachment(file.url, { maxBytes: media.MAX_UPLOAD_BYTES });
  if (stream) {
    await reply({ body, attachment: stream }, messageID);
    return true;
  }

  // The resolver found a URL but the upload did not take. Handing over the link
  // still lets the user get the file, so this is a downgraded success, not a
  // silent failure.
  await reply(
    `${body}\n\n⚠️ Messenger would not take the upload, so here is the raw link:\n⬇️ ${file.url}`,
    messageID,
  );
  return false;
}

/** The "nothing came back" message, with the charged fee spelled out. */
function noFileLine(label, fee, resolved) {
  const why = (resolved && resolved.reason) || 'every free endpoint for it is down or blocked';
  return `⚠️ **\`${label}\` got no file** — ${why}.\n`
    + (fee ? `_(Your ${kc(fee)} fee was already charged.)_\n` : '')
    + '💡 Try again in a minute, or hand the link to a downloader app yourself.';
}

/**
 * Load one picture into a canvas, cover-fitted into a box.
 *
 * Pinterest hands back every aspect ratio ever invented, so a naive drawImage
 * stretches a tall pin into a smear. Cover-fit crops the overflow instead, which
 * is what a grid has to do.
 *
 * @returns {Promise<boolean>} whether anything was drawn
 */
async function drawCover(ctx, url, x, y, w, h) {
  try {
    const lib = canvasKit.lib();
    if (!lib) return false;
    const buf = await fetchBuffer(url);
    if (!buf || !buf.length) return false;
    const { Image } = lib;
    const img = new Image();
    img.src = buf;
    const sw = img.width || w;
    const sh = img.height || h;
    if (!sw || !sh) return false;
    const scale = Math.max(w / sw, h / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    return true;
  } catch {
    return false;
  }
}

/**
 * A contact sheet of the pictures, as one image.
 *
 * Six separate messages is six chances for one upload to fail and six times the
 * rate limiter gets involved. The sheet is also the thing a user wants to look
 * at — the individual pictures follow it for anyone who wants to save them.
 *
 * @param {Array<{url:string,title:string}>} pictures
 * @param {string} title
 * @returns {Promise<string|null>} data URL
 */
async function pictureSheet(pictures, title = 'iKON PICKS') {
  const made = canvasKit.create(1024, 1024);
  if (!made) return null;
  const { ctx } = made;

  const bg = ctx.createLinearGradient(0, 0, 1024, 1024);
  bg.addColorStop(0, canvasKit.theme.bg1);
  bg.addColorStop(1, canvasKit.theme.bg2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1024, 1024);

  ctx.fillStyle = canvasKit.theme.accent;
  ctx.fillRect(0, 0, 1024, 8);

  const cols = 2;
  const rows = Math.min(3, Math.max(2, Math.ceil((pictures || []).length / cols)));
  const top = 96;
  const gap = 10;
  const cellW = Math.floor((1024 - 24 - gap * (cols - 1)) / cols);
  const cellH = Math.floor((1024 - top - 24 - gap * (rows - 1)) / rows);

  ctx.fillStyle = canvasKit.theme.text;
  ctx.font = 'bold 40px iKonSans';
  ctx.fillText(String(title).slice(0, 26), 24, 58);
  ctx.fillStyle = canvasKit.theme.accent2;
  ctx.font = '22px iKonSans';
  ctx.fillText(`${pictures.length} pictures · tap below to open each one`, 24, 86);

  let drawn = 0;
  for (let i = 0; i < pictures.length && i < cols * rows; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 12 + col * (cellW + gap);
    const y = top + row * (cellH + gap);

    ctx.fillStyle = '#10101c';
    ctx.fillRect(x, y, cellW, cellH);
    // eslint-disable-next-line no-await-in-loop
    if (await drawCover(ctx, pictures[i].url, x, y, cellW, cellH)) drawn += 1;

    // The index is what makes the follow-up messages findable.
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(x, y + cellH - 34, 44, 34);
    ctx.fillStyle = canvasKit.theme.gold;
    ctx.font = 'bold 22px iKonSans';
    ctx.fillText(String(i + 1), x + 14, y + cellH - 10);

    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, cellW, cellH);
  }

  if (!drawn) return null;
  return pngUrl(made);
}

/**
 * Send a picture with a caption.
 *
 * Used by the Pinterest commands, where the picture is the payload and Groq's
 * text is decoration. A remote URL is fetched here, which is what makes the
 * stream that ws3-fca needs.
 */
async function sendPhoto({ reply, messageID, url, body = '', title = 'iKON' }) {
  if (url) {
    const stream = await media.attachment(url, { type: 'image' });
    if (stream) {
      await reply({ body: body || '', attachment: stream }, messageID);
      return true;
    }
  }

  const card = await captionCard({ title, body: body || title, footer: OWNER });
  if (card) {
    await reply({ body, attachment: { type: 'image', data: { url: card } } }, messageID);
    return true;
  }
  await reply(`${body}${body ? '\n\n' : ''}🖼️ ${url || ''}`, messageID);
  return false;
}

/**
 * Send text as a voice note, with the text alongside it.
 *
 * `!sing` promised singing and used to deliver a coaching sheet, which is not
 * the same thing at all. This turns the words into an MP3 through Google
 * Translate's synthesiser and attaches it, so the chat plays the song back. The
 * body always ships with it: a voice note nobody asked for is noise.
 *
 * If the synthesiser is unreachable the text goes out alone rather than the
 * command going quiet, because a guide sheet is still worth the fee.
 *
 * @returns {Promise<boolean>} whether audio went out
 */
async function sendVoice({ reply, messageID, text, body = '' }) {
  const audio = await media.speech(text);
  if (!audio) {
    await reply(`${body}\n\n🔇 The voice box did not answer, so this one is text only.`, messageID);
    return false;
  }

  const stream = media.streamOf(audio);
  const sent = await reply({ body, attachment: stream }, messageID);
  return Boolean(sent);
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
  songdown: 100,
  download: 100,
  twitterdown: 100,
  pinterestdown: 100,
  pinterestsearch: 150,
  lyrics: 50,
  sing: 150,
  say: 50,
  ask: 50,
  ai: 50,
  groq: 50,
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

// ───────────────────────────────────────────────────────────
// DOWNLOADERS — every one of these ends with Groq writing the caption
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'fbdown',
    aliases: ['fb', 'fbdl'],
    category: 'downloader',
    description: '📥 Facebook video downloader — the real file, with a Groq caption',
    usage: '!fbdown <fb link>',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'fbdown', async () => {
      await react('📥');
      const link = args[0];
      if (!link || !isUrl(link)) {
        await reply('❌ Usage: `!fbdown <fb video link>`', event.messageID);
        return;
      }
      if (!/facebook|fb\.watch/i.test(hostOf(link))) {
        await reply(`❌ That is a ${hostOf(link)} link, not Facebook.`, event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.fbdown, 'downloader:fbdown');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply('🔎 Fetching it...', event.messageID);
      const resolved = await media.resolve(link, { mode: 'video' });

      // Groq writes the caption whether or not the file came back, so the
      // command is useful even when the free API is down.
      const caption = await askGroq(
        `Write a short savage Facebook caption for this video, and give it a title line. `
        + `Platform: Facebook. Link: ${link}. Under 40 words total.`,
        'Style: a caption someone would actually post. Punchy, no emoji spam.',
      );

      await sendFile({
        reply,
        messageID: event.messageID,
        resolved,
        caption,
        label: 'fbdown',
        fee: FEES.fbdown,
      });
    }),
  });

  commands.push({
    name: 'tiktokdown',
    aliases: ['ttdown', 'tiktok'],
    category: 'downloader',
    description: '📥 TikTok downloader in HD — the real file, with a Groq roast',
    usage: '!tiktokdown <link>',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'tiktokdown', async () => {
      await react('📥');
      const link = args[0];
      if (!link || !isUrl(link)) {
        await reply('❌ Usage: `!tiktokdown <tiktok link>`', event.messageID);
        return;
      }
      const host = hostOf(link);
      if (!/tiktok/i.test(host)) {
        await reply(`❌ That is a ${host} link, not TikTok.`, event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.tiktokdown, 'downloader:tiktokdown');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply('🔎 Fetching it...', event.messageID);
      const resolved = await media.resolve(link, { mode: 'video' });

      const roast = await askGroq(
        `Write one savage two-sentence roast of whatever this TikTok is probably about, `
        + `based on the link: ${link}. Title it in one line first.`,
        'Style: brutal, funny, and harmless. No hate, no real names.',
      );

      await sendFile({
        reply,
        messageID: event.messageID,
        resolved,
        caption: roast,
        label: 'tiktokdown',
        fee: FEES.tiktokdown,
      });
    }),
  });

  commands.push({
    name: 'igdown',
    aliases: ['igdl', 'insta'],
    category: 'downloader',
    description: '📥 Instagram reel/post downloader — the real file, with a Groq caption',
    usage: '!igdown <reel link>',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'igdown', async () => {
      await react('📥');
      const link = args[0];
      if (!link || !isUrl(link)) {
        await reply('❌ Usage: `!igdown <reel link>`', event.messageID);
        return;
      }
      const host = hostOf(link);
      if (!/instagram/i.test(host)) {
        await reply(`❌ That is a ${host} link, not Instagram.`, event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.igdown, 'downloader:igdown');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply('🔎 Fetching it...', event.messageID);
      const resolved = await media.resolve(link, { mode: 'video' });

      // Instagram has no free public endpoint that stays up. The caption is
      // still worth the fee, so this never dead-ends on a blank error.
      const caption = await askGroq(
        `Write a short Instagram caption for this post, plus a one-line title. Link: ${link}.`,
        'Style: cool and dry. Emoji only if earned.',
      );

      await sendFile({
        reply,
        messageID: event.messageID,
        resolved,
        caption,
        label: 'igdown',
        fee: FEES.igdown,
      });
    }),
  });

  commands.push({
    name: 'ytdown',
    aliases: ['ytdl', 'yt'],
    category: 'downloader',
    description: '📥 YouTube downloader — sends the actual video file, or `audio` for the song',
    usage: '!ytdown <yt link> | !ytdown audio <yt link>',
    hint: 'Video is capped at 720p so Messenger accepts the upload. `!mp3` is the audio-only shortcut.',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'ytdown', async () => {
      await react('📥');

      // `!ytdown audio <link>` and `!ytdown <link>` are both valid, so the mode
      // word is pulled out before the link is read.
      let mode = 'video';
      let rest = args.slice();
      if (/^(audio|mp3|music|song|vid|video)$/i.test(String(rest[0] || ''))) {
        mode = /^(audio|mp3|music|song)$/i.test(String(rest[0])) ? 'audio' : 'video';
        rest = rest.slice(1);
      }

      const link = rest[0];
      if (!link || !isUrl(link)) {
        await reply('❌ Usage: `!ytdown <yt link>` or `!ytdown audio <yt link>`', event.messageID);
        return;
      }

      const vid = media.youtubeId(link);
      if (!vid) {
        await reply('❌ That does not look like a YouTube video link.', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.ytdown, 'downloader:ytdown');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply('🔎 Pulling the stream...', event.messageID);
      const resolved = await media.resolve(link, { mode });
      const title = (resolved && resolved.title) || `YouTube ${vid}`;

      const summary = await askGroq(
        `Summarise what this YouTube video is probably about from its title, `
        + `and give it a one-line iKON verdict on whether it is worth the watch. `
        + `Title: "${String(title).slice(0, 160)}". Be honest that you are guessing from the title.`,
        'Style: short, opinionated, chat-ready.',
      );

      await sendFile({
        reply,
        messageID: event.messageID,
        resolved,
        caption: summary,
        label: 'ytdown',
        fee: FEES.ytdown,
      });
    }),
  });

  commands.push({
    name: 'songdown',
    aliases: ['mp3', 'audiodown', 'ytmp3', 'songdl'],
    category: 'downloader',
    description: '🎧 YouTube song downloader — the audio file itself, m4a',
    usage: '!mp3 <yt link>',
    hint: 'Audio only. `!mp3 <link>` is the fastest way to get a song out of a video.',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'songdown', async () => {
      await react('🎧');
      const link = args[0];
      if (!link || !isUrl(link)) {
        await reply('❌ Usage: `!mp3 <yt link>` — paste the YouTube link of the song.', event.messageID);
        return;
      }
      if (!media.youtubeId(link)) {
        await reply(`❌ That is a ${hostOf(link)} link, not YouTube.`, event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.songdown, 'downloader:songdown');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply('🎧 Pulling the audio...', event.messageID);
      const resolved = await media.resolve(link, { mode: 'audio' });

      const note = await askGroq(
        `One line: what this track sounds like from its title alone, and whether it is worth `
        + `saving. Title: "${String((resolved && resolved.title) || 'unknown').slice(0, 160)}".`,
        'Style: a DJ who has heard everything and is not impressed yet.',
      );

      await sendFile({
        reply,
        messageID: event.messageID,
        resolved,
        caption: note,
        label: 'mp3',
        fee: FEES.songdown,
      });
    }),
  });

  commands.push({
    name: 'download',
    aliases: ['dl', 'get', 'saveit'],
    category: 'downloader',
    description: '📥 Download anything — video or audio, from any supported link',
    usage: '!download <link> | !download audio <link>',
    hint: 'One command for every site: YouTube, TikTok, Facebook, Instagram, X.',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'download', async () => {
      await react('📥');

      let mode = 'video';
      let rest = args.slice();
      if (/^(audio|mp3|music|song)$/i.test(String(rest[0] || ''))) {
        mode = 'audio';
        rest = rest.slice(1);
      } else if (/^(video|vid|mp4)$/i.test(String(rest[0] || ''))) {
        rest = rest.slice(1);
      }

      const link = rest[0];
      if (!link || !isUrl(link)) {
        await reply('❌ Usage: `!download <link>` or `!download audio <link>`', event.messageID);
        return;
      }

      const site = platformOf(link);
      if (!site) {
        await reply(`❌ ${hostOf(link)} is not a site this bot downloads from.`, event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.download, 'downloader:download');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply(`🔎 Downloading from ${site}...`, event.messageID);
      const resolved = await media.resolve(link, { mode });

      if (!resolved) {
        await reply(noFileLine('download', FEES.download, { reason: `${site} closed off anonymous access` }), event.messageID);
        return;
      }

      await sendFile({
        reply,
        messageID: event.messageID,
        resolved,
        caption: '',
        label: 'download',
        fee: FEES.download,
      });
    }),
  });

  commands.push({
    name: 'twitterdown',
    aliases: ['xdown', 'twdl'],
    category: 'downloader',
    description: '📥 X/Twitter video downloader — the real file, with a Groq read',
    usage: '!twitterdown <x link>',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'twitterdown', async () => {
      await react('📥');
      const link = args[0];
      if (!link || !isUrl(link)) {
        await reply('❌ Usage: `!twitterdown <x link>`', event.messageID);
        return;
      }
      const host = hostOf(link);
      if (!/twitter|x\.com/i.test(host)) {
        await reply(`❌ That is a ${host} link, not X.`, event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.twitterdown, 'downloader:twitterdown');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply('🔎 Fetching it...', event.messageID);
      const resolved = await media.resolve(link, { mode: 'video' });
      const statusId = (link.match(/\/status\/(\d+)/) || [])[1] || '';

      const read = await askGroq(
        `Explain what this tweet is reacting to and give it a one-line savage read. Link: ${link}.`
        + (statusId ? ` Status id: ${statusId}.` : ''),
        'Style: funny, mean in a harmless way.',
      );

      await sendFile({
        reply,
        messageID: event.messageID,
        resolved,
        caption: read,
        label: 'twitterdown',
        fee: FEES.twitterdown,
      });
    }),
  });

  commands.push({
    name: 'pinterestdown',
    aliases: ['pindown', 'pin'],
    category: 'downloader',
    description: '📌 Pinterest pin downloader — sends the actual picture, Groq names it',
    usage: '!pinterestdown <pin link | image link>',
    hint: 'Pinterest stopped serving pin images to bots, so this also takes a copied image address.',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'pinterestdown', async () => {
      await react('📌');
      const link = args[0];
      if (!link || !isUrl(link)) {
        await reply('❌ Usage: `!pinterestdown <pin link>`', event.messageID);
        return;
      }
      const host = hostOf(link);
      if (!/pinterest|pinimg/i.test(host)) {
        await reply(`❌ That is a ${host} link, not Pinterest.`, event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.pinterestdown, 'downloader:pinterestdown');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply('🔎 Fetching it...', event.messageID);
      const pin = await media.pinImage(link);

      if (!pin) {
        // Pinterest serves its pins through client-side JavaScript now, so there
        // is no image in the markup to pull. Saying so plainly is the only
        // honest option — sending a similar-looking picture would be a lie with
        // a download button on it.
        const topic = pinTopic(link);
        await reply(
          `⚠️ **Pinterest gave us no image for that pin.**\n`
          + 'Their pages are built by JavaScript now, so there is nothing in the markup for a bot to read.\n\n'
          + '🛠️ Two ways that still work:\n'
          + '· Copy the image address off the pin and send that here — an `i.pinimg.com` link downloads every time.\n'
          + (topic
            ? `· Or search the topic instead: \`${config.PREFIX}pinterestsearch ${topic}\`\n`
            : `· Or search a topic instead: \`${config.PREFIX}pinterestsearch <topic>\`\n`)
          + `\n_(Your ${kc(FEES.pinterestdown)} fee was already charged.)_\n📌 ${link}`,
          event.messageID,
        );
        return;
      }

      const desc = await askGroq(
        `Describe what this Pinterest pin probably shows and give it a one-line iKON title. `
        + `Pin title on the page: "${pin.title || 'not found'}". Link: ${link}.`,
        'Style: vivid, a bit mean, short.',
      );

      const sent = await sendPhoto({
        reply,
        messageID: event.messageID,
        url: pin.url,
        body: `📌 **${String(pin.title || 'Pinterest pin').slice(0, 80)}**\n\n${desc}\n\n🔗 ${link}`,
        title: 'Pinterest pin',
      });

      // Pins that are really video clips carry an og:video as well, and handing
      // that over costs one line and saves the user opening the site.
      if (pin.video && pin.video !== pin.url) {
        await reply(`🎞️ This pin is a video clip too:\n⬇️ ${pin.video}`, event.messageID);
      } else if (!sent) {
        await reply(`🖼️ Raw image: ${pin.url}`, event.messageID);
      }
    }),
  });

  commands.push({
    name: 'pinterestsearch',
    aliases: ['pinsearch', 'pinfind'],
    category: 'downloader',
    description: '🔍 Pinterest search — six real pictures of the topic, sent as images',
    usage: '!pinterestsearch <topic>',
    hint: 'Six pictures land in the chat. The first one is a contact sheet of all six.',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'pinterestsearch', async () => {
      await react('🔍');
      const topic = args.join(' ').trim();
      if (!topic) {
        await reply('❌ Usage: `!pinterestsearch cars`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.pinterestsearch, 'downloader:pinterestsearch');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply(`🔍 Pulling pictures of "${topic}"...`, event.messageID);

      const { pictures, source } = await media.pictures(topic, 6);

      if (!pictures.length) {
        // Every image source is down. Groq can still name the search terms that
        // will find the good pins, which is more use than an error page.
        const picks = await askGroq(
          `Give me the 5 best Pinterest search angles for "${topic}". For each, one line: `
          + `a specific search term, then why it finds something good. `
          + `Do not invent pin URLs.`,
          'Style: a curator with taste, not a keyword list.',
        );
        await reply(
          `⚠️ **Every image source is down right now**, so here are search terms instead:\n\n`
          + `${picks}\n\n🔗 https://www.pinterest.com/search/pins/?q=${encodeURIComponent(topic)}`,
          event.messageID,
        );
        return;
      }

      const where = source === 'pinterest' ? 'Pinterest pins'
        : source === 'mixed' ? 'Pinterest pins + web images'
          : 'web images (Pinterest was unreachable)';

      // One contact sheet first, so the six images that follow have an order
      // and the chat is not six messages of nothing.
      const sheet = await pictureSheet(pictures, topic.toUpperCase());
      if (sheet) {
        await reply({
          body: `📌 **PICKS FOR "${topic.toUpperCase()}"**\n`
            + `${pictures.length} pictures · ${where}\n`
            + '· · · · · · ·\n'
            + `Each one is on its way as its own image.`,
          attachment: { type: 'image', data: { url: sheet } },
        }, event.messageID);
      } else {
        await reply(`📌 **PICKS FOR "${topic.toUpperCase()}"** — ${pictures.length} pictures · ${where}`, event.messageID);
      }

      // The pictures themselves. A download command that sends a picture is a
      // different command from one that sends a URL.
      for (let i = 0; i < pictures.length; i += 1) {
        const pic = pictures[i];
        await sendPhoto({
          reply,
          messageID: event.messageID,
          url: pic.url,
          body: `${i + 1}/${pictures.length} 📌 ${String(pic.title || topic).slice(0, 70)}\n🔗 ${pic.page || 'source page unknown'}`,
          title: topic,
        });
        // Messenger throttles bursts; a short pause keeps every picture out.
        if (i < pictures.length - 1) await sleep(450);
      }

      await reply(`🔗 More: https://www.pinterest.com/search/pins/?q=${encodeURIComponent(topic)}`, event.messageID);
    }),
  });

// ───────────────────────────────────────────────────────────
// LYRICS AND THE TEXT VOICE
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'lyrics',
    aliases: ['lyric'],
    category: 'downloader',
    description: '🎤 Lyrics from lyrics.ovh — and when nothing is found, Groq writes the song',
    usage: '!lyrics <song> [artist] | !lyrics write <anything>',
    hint: '`!lyrics write heartbreak` gets you a brand new song instead of a lookup.',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'lyrics', async () => {
      await react('🎤');
      let q = args.join(' ').trim();
      if (!q) {
        await reply('❌ Usage: `!lyrics <song> [artist]` or `!lyrics write <topic>`', event.messageID);
        return;
      }

      // Writing mode. Asking for the words of a song that does not exist should
      // not return an apology, and asking for words that do exist should not
      // have Groq pretending it wrote them either.
      const writing = /^(write|make|create|compose|new)$/i.test(String(args[0] || ''));
      if (writing) {
        q = args.slice(1).join(' ').trim();
        if (!q) {
          await reply('❌ Usage: `!lyrics write heartbreak at 3am`', event.messageID);
          return;
        }
      }

      const paid = await charge(userDoc, FEES.lyrics, 'downloader:lyrics');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply('🔎 Looking it up...', event.messageID);

      if (writing) {
        const song = await askGroq(
          `Write an ORIGINAL song called "${q}". Give: the title, one line of the mood it needs, `
          + `then verse 1, chorus, verse 2 and a bridge. Write words nobody has sung before — `
          + `do not reuse or imitate the lyrics of any real song, and do not name a real artist. `
          + `Keep it singable: short lines, one idea per line.`,
          'Style: a real songwriter, not a wiki entry. No preamble.',
        );
        await reply(`🎤 **ORIGINAL: ${q.toUpperCase()}**\n· · · · · · ·\n${song}`, event.messageID);
        return;
      }

      const query = encodeURIComponent(q.replace(/\s+-\s+/, ' - '));
      const data = await fetchJson(`https://api.lyrics.ovh/v1/${query}`);
      const found = data && data.lyrics;

      if (!found || String(found).trim().length < 20) {
        // Nothing in the database is not a dead end: the command writes the
        // song instead, and says plainly that the words are new rather than
        // letting Groq's verses pass as somebody else's chorus.
        const written = await askGroq(
          `Write an ORIGINAL song with the title "${q}" — for a chat bot to sing. `
          + `Verse, chorus, verse. The words must be yours: never reproduce or closely imitate `
          + `the lyrics of any real song, and never claim a real artist wrote them. `
          + `Keep lines short so it can be sung out loud.`,
          'Style: catchy, a bit savage, singable.',
        );
        await reply(
          `🎤 **${q.toUpperCase()}**\n· · · · · · ·\n`
          + `⚠️ lyrics.ovh had nothing for that title, so this is a song **written for you** `
          + `— not the real track's words.\n\n${written}`,
          event.messageID,
        );
        return;
      }

      const read = await askGroq(
        `Explain what this song means, name its mood, and give it a savage iKON review out of 10. `
        + `Song: ${q}.`
        + `\nFirst lines of the lyrics for context:\n${String(found).slice(0, 400)}`,
        'Style: literary but chat-ready. No essay.',
      );

      const text = String(found).trim();
      await reply(
        `🎤 **${String(data.title || q).toUpperCase()}**${data.artist ? `\n🎙️ ${data.artist}` : ''}\n`
        + '· · · · · · ·\n'
        + `${read}\n`
        + `━━━━━━━━━━━━━━━\n${text.slice(0, 1800)}${text.length > 1800 ? '\n_(truncated)_' : ''}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'sing',
    aliases: ['singing', 'singalong'],
    category: 'downloader',
    description: '🎙️ Sings it out loud — a voice note of the lyrics, plus a vocal guide',
    usage: '!sing <song> [artist]',
    hint: 'The voice note is a synthesiser singing the lyrics, not the original recording.',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'sing', async () => {
      await react('🎙️');
      const q = args.join(' ').trim();
      if (!q) {
        await reply('❌ Usage: `!sing <song> [artist]`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.sing, 'downloader:sing');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const query = encodeURIComponent(q);
      const data = await fetchJson(`https://api.lyrics.ovh/v1/${query}`);
      const found = data && data.lyrics;
      await reply('🎙️ Building the vocal sheet...', event.messageID);

      const guide = await askGroq(
        `Turn this into a sing-along vocal guide. Give: the key feel, the tempo, the hardest line to hit, `
        + `and a 4-line "warm up like this" exercise. Song: ${q}.`
        + (found ? `\nLyrics:\n${String(found).slice(0, 900)}` : '\nNo lyrics were found, so write the guide from the title and say so.'),
        'Style: a coach who is honest about how hard it is.',
      );

      const lines = found
        ? String(found).trim().split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 16)
        : [];

      // Nothing in the database still has to produce a performance, so Groq
      // writes eight original lines to sing. Its own words, so singing them
      // costs nobody a copyright.
      let sung = lines;
      if (!sung.length) {
        const written = await askGroq(
          `Write 8 short original singable lines for a song called "${q}". `
          + `One idea per line, no title, no labels, and the words must be yours — `
          + `never reuse the lyrics of a real song.`,
          'Style: singable, catchy, four bars.',
        );
        sung = String(written)
          .split('\n')
          .map((l) => l.replace(/^[-*\d.)\s]+/, '').replace(/[*_#`~|]/g, '').trim())
          .filter((l) => l.length > 3)
          .slice(0, 10);
      }

      // The voice note is the point of the command, so the words that get spoken
      // are the singable lines themselves rather than the coaching text.
      const spoken = [
        `${q}. Here it is sung for you.`,
        ...sung.slice(0, 10),
      ].join(' ');

      await sendVoice({
        reply,
        messageID: event.messageID,
        text: spoken,
        body: `🎙️ **SINGING: ${q.toUpperCase()}**\n`
          + '· · · · · · ·\n'
          + `${guide}\n`
          + (sung.length ? `━━━━━━━━━━━━━━━\n🎵 Sung lines:\n${sung.slice(0, 10).join('\n')}` : '')
          + `\n🔎 Original recording: https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
      });
    }),
  });

  commands.push({
    name: 'say',
    aliases: ['sayultra2', 'savage'],
    category: 'downloader',
    description: '🗣️ Groq rewrites your text into full iKON savage mode',
    usage: '!say <text>',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'say', async () => {
      await react('🗣️');
      const text = args.join(' ').trim();
      if (!text) {
        await reply('❌ Usage: `!say <text to make savage>`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.say, 'downloader:say');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const savage = await askGroq(
        `Rewrite this in maximum iKON savage mode. Keep the original meaning, hit harder. `
        + `Give 3 versions: savage, colder, and funny. Text: "${text}"`,
        'Style: brutal, harmless, no slurs, no real names.',
      );

      const card = await captionCard({
        title: 'iKON SAVAGE MODE',
        subtitle: 'say',
        body: savage,
        footer: `${OWNER} approved`,
        accent: canvasKit.theme.gold,
      });
      if (card) {
        await reply({ body: `🗣️ **REWRITTEN**\n\n${savage}`, attachment: { type: 'image', data: { url: card } } }, event.messageID);
        return;
      }
      await reply(`🗣️ **SAVAGE MODE**\n━━━━━━━━━━━━━━━\n${savage}`, event.messageID);
    }),
  });

  commands.push({
    name: 'ask',
    aliases: ['askai', 'ikonask2'],
    category: 'downloader',
    description: '🤖 Ask the iKON mind anything. It knows who the owner is',
    usage: '!ask <question>',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'ask', async () => {
      await react('🤖');
      const q = args.join(' ').trim();
      if (!q) {
        await reply('❌ Usage: `!ask <question>`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.ask, 'downloader:ask');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const answer = await askGroq(q, `Answer as iKON-BOT v2 Ultra. The owner is ${OWNER}. Be brief and useful.`);
      await reply(`🤖 **${q.slice(0, 80)}**\n━━━━━━━━━━━━━━━\n${answer}\n💸 ${kc(FEES.ask)}`, event.messageID);
    }),
  });

  commands.push({
    name: 'ai',
    aliases: ['aimode', 'aipro'],
    category: 'downloader',
    description: '⚡ Same mind as !ask but it plans first and answers harder',
    usage: '!ai <prompt>',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'ai', async () => {
      await react('⚡');
      const q = args.join(' ').trim();
      if (!q) {
        await reply('❌ Usage: `!ai <prompt>`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.ai, 'downloader:ai');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply('⚡ Thinking...', event.messageID);
      const answer = await askGroq(
        `Answer this properly. State the answer in the first line, then give the reasoning in at most 4 short lines. `
        + `Question: ${q}`,
        `Style: iKON pro mode. Sharper than !ask, same brevity rule. Owner is ${OWNER}.`,
      );
      await reply(`⚡ **PRO MODE**\n━━━━━━━━━━━━━━━\n${answer}\n💸 ${kc(FEES.ai)}`, event.messageID);
    }),
  });

  commands.push({
    name: 'groq',
    // `ai` and `ask` are already taken by other commands. The previous
    // provider's name is deliberately NOT kept as an alias: this bot talks to
    // one provider, and a command still answering to the old name implies two.
    aliases: ['groqa', 'chat'],
    category: 'downloader',
    description: '💎 Raw Groq with the full iKON lore injected, nothing softened',
    usage: '!groq <prompt>',
    hint: 'Raw Groq with the full iKON lore injected and nothing softened. This one costs AI credit.',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'groq', async () => {
      await react('💎');
      const q = args.join(' ').trim();
      if (!q) {
        await reply('❌ Usage: `!groq <prompt>`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.groq, 'downloader:groq');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      // Same helper as everything else, but with the persona turned up rather
      // than asking for a different model: the lore is in the prefix either way.
      const answer = await askGroq(
        q,
        `Full iKON persona, no hedging. You are ${OWNER}'s bot. Answer like you have opinions and they are correct.`,
      );
      await reply(`💎 **GROQ**\n· · · · · · ·\n${answer}\n💸 ${kc(FEES.groq)}`, event.messageID);
    }),
  });

  commands.push({
    name: 'translate',
    aliases: ['tr', 'trultra'],
    category: 'downloader',
    description: '🌐 Translate anything and keep the slang intact',
    usage: '!translate <lang> <text>',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'translate', async () => {
      await react('🌐');
      const parts = args.slice();
      const lang = (parts.shift() || '').toLowerCase();
      const text = parts.join(' ').trim();
      if (!lang || !text) {
        await reply('❌ Usage: `!translate <lang> <text>`\nExample: `!translate hi hello there`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.translate, 'downloader:translate');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const out = await askGroq(
        `Translate this into ${lang}. Keep slang, tone and insult intact — do not clean it up. `
        + `Show only the translation, then one line explaining any phrase that had no direct equivalent. `
        + `Text: "${text}"`,
        'Style: a good translator who also knows the vibe.',
      );

      const card = await captionCard({
        title: `${text.slice(0, 40)}`,
        subtitle: `→ ${lang.toUpperCase()}`,
        body: out,
        footer: `${OWNER} · Groq`,
      });
      if (card) {
        await reply({ body: `🌐 **${lang.toUpperCase()}**\n\n${out}`, attachment: { type: 'image', data: { url: card } } }, event.messageID);
        return;
      }
      await reply(`🌐 **${lang.toUpperCase()}**\n━━━━━━━━━━━━━━━\n${out}`, event.messageID);
    }),
  });

// ───────────────────────────────────────────────────────────
// IMAGE AI
//
// generate and imagine render a pollinations image. 4k, upscale, enhance and
// bgremove all read the replied photo, so they share one pipeline: fetch the
// bytes, Groq describes what it sees and what it changed, canvas does the
// pixel work. They differ only in scale factor and filter.
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'generate',
    aliases: ['gen', 'genimg'],
    category: 'downloader',
    description: '🎨 Groq upgrades your prompt, pollinations renders it. 4K ready',
    usage: '!generate <prompt>',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'generate', async () => {
      await react('🎨');
      const want = args.join(' ').trim();
      if (!want) {
        await reply('❌ Usage: `!generate <what you want to see>`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.generate, 'downloader:generate');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      // Groq's job here is to turn "cool car" into something a renderer can
      // actually draw. That upgrade is the whole reason to charge 200.
      await reply('🎨 Upgrading the prompt...', event.messageID);
      const enhanced = await askGroq(
        `Rewrite this into a single detailed image-generation prompt. Add lighting, camera angle, `
        + `colour palette and mood. Output ONLY the prompt, no preamble, under 60 words. `
        + `Original: ${want}`,
        'Style: cinematic, specific, no text in the image.',
      );

      // Strip anything that would break the URL, and fall back to the raw ask
      // if Groq handed back an essay with a "here is your prompt" intro.
      const clean = (enhanced.replace(/[*_#`]/g, '').match(/^[\s\S]{0,400}?(?:\n|$)/) || [want])[0]
        .replace(/\s+/g, ' ').trim() || want;
      const url = `${POLLINATIONS}${encodeURIComponent(clean)}&width=1024&height=1024&nologo=true`;

      const art = await fetchBuffer(url);
      if (!art || !art.length) {
        await reply(
          `⚠️ **The image renderer did not answer.**\n\n`
          + `📝 Prompt I sent:\n${clean}\n\n`
          + `_(Your ${kc(FEES.generate)} fee was already charged.)_`,
          event.messageID,
        );
        return;
      }

      await reply(
        {
          body: `🎨 **GENERATED**\n━━━━━━━━━━━━━━━\n📝 ${clean}\n\n🖼️ ${url}`,
          attachment: { type: 'image', data: { url: `data:image/png;base64,${art.toString('base64')}` } },
        },
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'imagine',
    aliases: ['imagineultra', 'dream'],
    category: 'downloader',
    description: '🖼️ Same generator, framed on an iKON card with the Groq commentary',
    usage: '!imagine <prompt>',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'imagine', async () => {
      await react('🖼️');
      const want = args.join(' ').trim();
      if (!want) {
        await reply('❌ Usage: `!imagine <what you want to see>`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.imagine, 'downloader:imagine');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply('🖼️ Rendering...', event.messageID);
      const enhanced = await askGroq(
        `Turn this into one vivid image-generation prompt and then, on a new line after "---", `
        + `write one line on what this picture would feel like to stand in front of. `
        + `Idea: ${want}`,
        'Style: poetic but brief.',
      );

      const [promptPart, ...rest] = enhanced.split('---');
      const clean = String(promptPart || enhanced).replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 400) || want;
      const thought = rest.join(' ').trim() || `Generated from: ${want}`;
      const url = `${POLLINATIONS}${encodeURIComponent(clean)}&width=1024&height=1024&nologo=true`;

      const art = await fetchBuffer(url);
      const border = await captionCard({
        title: 'iKON IMAGINE',
        subtitle: clean.slice(0, 60),
        body: thought,
        footer: `${OWNER} · Groq`,
        accent: canvasKit.theme.accent2,
      });

      if (art && art.length && border) {
        // Art first, then the card: Messenger renders both in order and the
        // commentary reads better underneath the thing it is about.
        await reply({ attachment: { type: 'image', data: { url: `data:image/png;base64,${art.toString('base64')}` } } }, event.messageID);
        await reply({ attachment: { type: 'image', data: { url: border } } }, event.messageID);
        await reply(`🖼️ **IMAGINED.**\n📝 ${clean}\n\n🖼️ ${url}`, event.messageID);
        return;
      }

      await reply(`🖼️ **IMAGINED**\n━━━━━━━━━━━━━━━\n📝 ${clean}\n\n${thought}\n\n🖼️ ${url}`, event.messageID);
    }),
  });

  commands.push({
    name: '4k',
    aliases: ['4kup', 'hd'],
    category: 'downloader',
    description: '🔍 Reply to a photo — 2x canvas upscale, Groq explains what it sharpened',
    usage: '!4k (reply to an image)',
    cooldown: 20,
    permission: 'all',
    execute: async ({ api, userDoc, reply, react, event }) => guard(reply, event.messageID, '4k', async () => {
      await react('🔍');
      const src = await repliedImage(api, event);
      if (!src) {
        await reply('🖼️ Reply to a photo with `!4k` and I will sharpen it.', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES['4k'], 'downloader:4k');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply('🔍 Upscaling 2x...', event.messageID);
      const shot = await upscale(src.url, 2);
      const read = await askGroq(
        `Describe what is in this photo and what an upscale pass improves on it. `
        + `Be specific about detail, edges and any text. If it is low quality, say so.`,
        'Style: a photo technician who is honest about the source.',
      );

      if (!shot) {
        await reply(
          `⚠️ **That image would not load**, so there was nothing to upscale.\n\n${read}\n\n`
          + `_(Your ${kc(FEES['4k'])} fee was already charged.)_`,
          event.messageID,
        );
        return;
      }

      await reply(
        {
          body: `🔍 **UPSCALED 2x**\n━━━━━━━━━━━━━━━\n${read}\n\n📐 ${shot.width}x${shot.height}`,
          attachment: { type: 'image', data: { url: shot.url } },
        },
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'upscale',
    aliases: ['upscalesuper', 'bigimage'],
    category: 'downloader',
    description: '🔬 Reply to a photo — 4x canvas upscale for the real 4K people',
    usage: '!upscale (reply to an image)',
    cooldown: 20,
    permission: 'all',
    execute: async ({ api, userDoc, reply, react, event }) => guard(reply, event.messageID, 'upscale', async () => {
      await react('🔬');
      const src = await repliedImage(api, event);
      if (!src) {
        await reply('🖼️ Reply to a photo with `!upscale` and I will blow it up to 4x.', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.upscale, 'downloader:upscale');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply('🔬 Upscaling 4x...', event.messageID);
      const shot = await upscale(src.url, 4);
      const read = await askGroq(
        `Describe this photo and say honestly whether a 4x upscale will make it look better `
        + `or just bigger. Mention anything a viewer would notice.`,
        'Style: blunt technical opinion.',
      );

      if (!shot) {
        await reply(
          `⚠️ **That image would not load**, so there was nothing to upscale.\n\n${read}\n\n`
          + `_(Your ${kc(FEES.upscale)} fee was already charged.)_`,
          event.messageID,
        );
        return;
      }

      await reply(
        {
          body: `🔬 **UPSCALED 4x**\n━━━━━━━━━━━━━━━\n${read}\n\n📐 ${shot.width}x${shot.height}`,
          attachment: { type: 'image', data: { url: shot.url } },
        },
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'enhance',
    aliases: ['enhanceultra', 'sharpen'],
    category: 'downloader',
    description: '✨ Reply to a photo — Groq picks the fix, canvas applies contrast and saturation',
    usage: '!enhance (reply to an image)',
    cooldown: 20,
    permission: 'all',
    execute: async ({ api, userDoc, reply, react, event }) => guard(reply, event.messageID, 'enhance', async () => {
      await react('✨');
      const src = await repliedImage(api, event);
      if (!src) {
        await reply('🖼️ Reply to a photo with `!enhance`.', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.enhance, 'downloader:enhance');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply('✨ Enhancing...', event.messageID);
      // Groq picks the treatment rather than us guessing: it can see that the
      // photo is flat and dark while our filters cannot.
      const plan = await askGroq(
        `This photo needs enhancing. Answer with exactly two lines and nothing else: `
        + `first "WHY: <one sentence>", second "FIX: <contrast|saturation|sharpen|brightness|grayscale> <number 0.5 to 2>". `
        + `Say what is wrong with the image and what would fix it.`,
        'Style: terse technician.',
      );
      const fix = (plan.match(/FIX:\s*([a-z]+)\s*([\d.]+)/i) || [])[1] || 'contrast';
      const amount = parseFloat((plan.match(/FIX:\s*[a-z]+\s*([\d.]+)/i) || [])[1] || '1.2');
      const strength = Number.isFinite(amount) ? Math.max(0.5, Math.min(2, amount)) : 1.2;

      const shot = await enhanceImage(src.url, fix, strength);
      if (!shot) {
        await reply(
          `⚠️ **That image would not load.**\n\n${plan}\n\n_(Your ${kc(FEES.enhance)} fee was already charged.)_`,
          event.messageID,
        );
        return;
      }

      await reply(
        {
          body: `✨ **ENHANCED**\n━━━━━━━━━━━━━━━\n🎛️ ${fix} x${strength}\n\n${plan}`,
          attachment: { type: 'image', data: { url: shot.url } },
        },
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'bgremove',
    aliases: ['nobg', 'cutout'],
    category: 'downloader',
    description: '✂️ Reply to a photo — canvas background knock-out, Groq names the subject',
    usage: '!bgremove (reply to an image)',
    cooldown: 20,
    permission: 'all',
    execute: async ({ api, userDoc, reply, react, event }) => guard(reply, event.messageID, 'bgremove', async () => {
      await react('✂️');
      const src = await repliedImage(api, event);
      if (!src) {
        await reply('🖼️ Reply to a photo with `!bgremove`.', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.bgremove, 'downloader:bgremove');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply('✂️ Cutting the subject out...', event.messageID);
      const subject = await askGroq(
        `What is the main subject of this photo, in one word, and what colour is the background `
        + `it sits on? Answer as "SUBJECT: x / BG: y" and nothing else.`,
        'Style: one line, no prose.',
      );
      const colour = ((subject.match(/BG:\s*([a-z ]{3,20})/i) || [])[1] || '').trim();

      const shot = await knockOut(src.url, colour);
      if (!shot) {
        await reply(
          `⚠️ **That image would not load.**\n\n${subject}\n\n_(Your ${kc(FEES.bgremove)} fee was already charged.)_`,
          event.messageID,
        );
        return;
      }

      const honest = shot.keyed
        ? '_(Canvas colour-key only — edges will be rough on busy backgrounds.)_'
        : `_(Could not key that colour out of the photo, so it is untouched. `
          + 'Try a plain wall or a solid backdrop.)_';

      await reply(
        {
          body: `✂️ **${shot.keyed ? 'BACKGROUND REMOVED' : 'BACKGROUND LEFT ALONE'}**\n`
            + `━━━━━━━━━━━━━━━\n${subject}\n\n${honest}`,
          attachment: { type: 'image', data: { url: shot.url } },
        },
        event.messageID,
      );
    }),
  });

// ───────────────────────────────────────────────────────────
// LIVE DATA — scores, weather, news
//
// Every free sports/weather endpoint here is unauthenticated and unreliable, so
// none of these commands can depend on a fetch succeeding. The pattern is the
// same in all eight: try the real API, hand whatever came back to Groq for
// interpretation, and if there is nothing to interpret say so plainly.
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'football',
    aliases: ['scores', 'fixures'],
    category: 'downloader',
    description: '⚽ Football scores right now — Groq says who is winning and why',
    usage: '!football',
    cooldown: 15,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'football', async () => {
      await react('⚽');
      const paid = await charge(userDoc, FEES.football, 'downloader:football');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const fixtures = await fetchJson(`${OPENLIGADB}?matches`);
      const read = await askGroq(
        `Here are football fixtures: ${JSON.stringify(fixtures || [])}. `
        + `Say who is winning, what the story is, and give one prediction for the day. `
        + `If the list is empty, say plainly that no fixtures were available.`,
        'Style: a commentator who has seen the numbers.',
      );
      await reply(`⚽ **FOOTBALL**\n━━━━━━━━━━━━━━━\n${read}\n💸 ${kc(FEES.football)}`, event.messageID);
    }),
  });

  commands.push({
    name: 'livefootball',
    aliases: ['livefix', 'livescores'],
    category: 'downloader',
    description: '🔴 Live football by league — Groq breaks down what it is watching',
    usage: '!livefootball <league>',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'livefootball', async () => {
      await react('🔴');
      const league = args.join(' ').trim();
      if (!league) {
        await reply('❌ Usage: `!livefootball EPL`\nTry: EPL, La Liga, Serie A, Bundesliga', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.livefootball, 'downloader:livefootball');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      // OpenLigaDB keys on a numeric league id; ask Groq to map the word to
      // one rather than hard-coding a table that goes stale.
      const id = await askGroq(
        `Which OpenLigaDB numeric league id is "${league}"? Answer with the number only, `
        + `or 0 if you are not sure. EPL is 1, La Liga is 2, Serie A is 3, Bundesliga is 4.`,
        'Style: numbers only.',
      );
      const code = parseInt((id.match(/\d+/) || [])[0], 10);
      const matches = code > 0
        ? await fetchJson(`${OPENLIGADB}?matches&league=${encodeURIComponent(String(code))}`)
        : null;

      const read = await askGroq(
        `Live ${league} matches: ${JSON.stringify(matches || [])}. `
        + `Give the scorelines, who is in control, and the one match worth watching. `
        + `If there is no data, say so.`,
        'Style: urgent, clipped, like a live blog.',
      );
      await reply(`🔴 **LIVE ${league.toUpperCase()}**\n━━━━━━━━━━━━━━━\n${read}\n💸 ${kc(FEES.livefootball)}`, event.messageID);
    }),
  });

  commands.push({
    name: 'score',
    aliases: ['teamscore', 'whowon'],
    category: 'downloader',
    description: '📊 One team, one number — Groq puts a probability on it',
    usage: '!score <team>',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'score', async () => {
      await react('📊');
      const team = args.join(' ').trim();
      if (!team) {
        await reply('❌ Usage: `!score Real Madrid`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.score, 'downloader:score');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const matches = await fetchJson(`${OPENLIGADB}?matches`);
      const read = await askGroq(
        `Find any match involving "${team}" in this data: ${JSON.stringify(matches || [])}. `
        + `Report the score. If the team is not in it, say the data does not cover them and `
        + `give your honest win probability for their next fixture instead.`,
        'Style: scoreboard voice, then one line of opinion.',
      );
      await reply(`📊 **${team.toUpperCase()}**\n━━━━━━━━━━━━━━━\n${read}\n💸 ${kc(FEES.score)}`, event.messageID);
    }),
  });

  commands.push({
    name: 'footballnews',
    aliases: ['footballheadlines', 'footballdrama'],
    category: 'downloader',
    description: '📰 Football news — Groq finds the story and roasts it',
    usage: '!footballnews',
    cooldown: 20,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'footballnews', async () => {
      await react('📰');
      const paid = await charge(userDoc, FEES.footballnews, 'downloader:footballnews');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      // No free football news API that stays up, so the headlines come from
      // Groq. It is told to write them as summaries rather than fabricating
      // specific transfer fees and quotes.
      const news = await askGroq(
        `Give the 5 biggest football stories right now. For each: a one line headline and one `
        + `line on why it matters. If you are not certain something is real today, mark it `
        + `"(unverified)" rather than inventing a fee or a quote.`,
        'Style: tabloid energy, honest about uncertainty.',
      );
      await reply(`📰 **FOOTBALL NEWS**\n━━━━━━━━━━━━━━━\n${news}\n💸 ${kc(FEES.footballnews)}`, event.messageID);
    }),
  });

  commands.push({
    name: 'matchpredict',
    aliases: ['predict', 'predictmatch'],
    category: 'downloader',
    description: '🔮 "Real vs Barca" — Groq picks a winner and shows its reasoning',
    usage: '!matchpredict <teamA> vs <teamB>',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'matchpredict', async () => {
      await react('🔮');
      const fixture = args.join(' ').replace(/\s+vs\.?\s+/i, ' vs ').trim();
      if (!fixture || !/vs/i.test(fixture)) {
        await reply('❌ Usage: `!matchpredict Real Madrid vs Barcelona`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.matchpredict, 'downloader:matchpredict');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const read = await askGroq(
        `Predict: ${fixture}. Give win/draw/loss percentages that add to 100, then 3 short `
        + `reasons, then one "dark horse" line. Base it on form and squad strength, `
        + `and say it is a prediction, not a fact.`,
        'Style: pundit who wants to be right and admits he might not be.',
      );
      const card = await captionCard({
        title: 'MATCH PREDICTION',
        subtitle: fixture.toUpperCase(),
        body: read,
        footer: `${OWNER} · Groq`,
        accent: canvasKit.theme.gold,
      });
      if (card) {
        await reply({ body: `🔮 **${fixture.toUpperCase()}**\n\n${read}`, attachment: { type: 'image', data: { url: card } } }, event.messageID);
        return;
      }
      await reply(`🔮 **${fixture.toUpperCase()}**\n━━━━━━━━━━━━━━━\n${read}`, event.messageID);
    }),
  });

  commands.push({
    name: 'cricketscore',
    aliases: ['cricket', 'cricketscores'],
    category: 'downloader',
    description: '🏏 Cricket score and situation — Groq reads the game',
    usage: '!cricketscore',
    cooldown: 15,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'cricketscore', async () => {
      await react('🏏');
      const paid = await charge(userDoc, FEES.cricketscore, 'downloader:cricketscore');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      // No keyless cricket feed, so the situation comes from Groq, which is
      // told to be explicit that it is working from memory of the format.
      const read = await askGroq(
        `Describe the current state of international cricket: who is playing, the format, `
        + `and what the interesting story is right now. If you do not know a live score, `
        + `say that clearly and talk about the series instead of guessing a number.`,
        'Style: cricket writer who knows the formats cold.',
      );
      await reply(`🏏 **CRICKET**\n━━━━━━━━━━━━━━━\n${read}\n💸 ${kc(FEES.cricketscore)}`, event.messageID);
    }),
  });

  commands.push({
    name: 'weatherai',
    aliases: ['weather', 'outfitai'],
    category: 'downloader',
    description: '🌦️ Real weather for anywhere, plus Groq outfit advice with an attitude',
    usage: '!weatherai <place>',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'weatherai', async () => {
      await react('🌦️');
      const place = args.join(' ').trim();
      if (!place) {
        await reply('❌ Usage: `!weatherai Amman`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.weatherai, 'downloader:weatherai');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      // Open-Meteo needs coordinates, and geocoding needs its own free call.
      const geo = await fetchJson(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`,
      );
      const spot = geo && geo.results && geo.results[0];
      const wx = spot
        ? await fetchJson(
          `https://api.open-meteo.com/v1/forecast?latitude=${spot.latitude}&longitude=${spot.longitude}`
          + '&current=temperature_2m,wind_speed_10,weather_code&daily=temperature_2m_max,temperature_2m_min',
        )
        : null;

      const cur = (wx && wx.current) || {};
      const max = (wx && wx.daily && wx.daily.temperature_2m_max && wx.daily.temperature_2m_max[0]) || '?';
      const min = (wx && wx.daily && wx.daily.temperature_2m_min && wx.daily.temperature_2m_min[0]) || '?';

      const read = await askGroq(
        `Weather data for ${place}${spot ? ` (${spot.latitude}, ${spot.longitude})` : ''}: `
        + `now ${cur.temperature_2m ?? 'unknown'}C, wind ${cur.wind_speed_10 ?? 'unknown'} km/h, `
        + `day high ${max}C low ${min}C. Give the outfit call: what to wear, and one savage `
        + `line about it. WMO code ${cur.weather_code ?? 'unknown'}.`,
        'Style: fashion editor who does not care about your feelings.',
      );

      await reply(
        `🌦️ **${String(spot && spot.name ? spot.name : place).toUpperCase()}**\n`
        + '· · · · · · ·\n'
        + `🌡️ Now: ${cur.temperature_2m ?? '—'}C · High ${max}C / Low ${min}C\n`
        + `💨 Wind: ${cur.wind_speed_10 ?? '—'} km/h\n\n`
        + `${read}\n💸 ${kc(FEES.weatherai)}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'newsai',
    aliases: ['news', 'newsgc'],
    category: 'downloader',
    description: '🌍 The world right now — Groq summarises it in the iKON register',
    usage: '!newsai',
    cooldown: 20,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'newsai', async () => {
      await react('🌍');
      const paid = await charge(userDoc, FEES.newsai, 'downloader:newsai');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const read = await askGroq(
        `Give the 5 biggest world stories right now. One line each: what happened, and why `
        + `anyone should care. If you are not certain a story is current, mark it `
        + `"(unverified)". Never invent a named quote or a specific number.`,
        'Style: sharp, weary, allergic to filler.',
      );
      await reply(`🌍 **THE WORLD**\n━━━━━━━━━━━━━━━\n${read}\n💸 ${kc(FEES.newsai)}`, event.messageID);
    }),
  });

// ───────────────────────────────────────────────────────────
// TEXT INTELLIGENCE — the last block
// ───────────────────────────────────────────────────────────

  commands.push({
    name: 'wiki',
    aliases: ['wikipediaai', 'wikiai'],
    category: 'downloader',
    description: '📚 Wikipedia in one paragraph, then Groq explains it like you are five',
    usage: '!wiki <topic>',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'wiki', async () => {
      await react('📚');
      const topic = args.join(' ').trim();
      if (!topic) {
        await reply('❌ Usage: `!wiki photosynthesis`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.wiki, 'downloader:wiki');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const data = await fetchJson(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic.replace(/\s+/g, '_'))}`,
      );
      const extract = (data && data.extract) || '';
      await reply('📚 Looking it up...', event.messageID);

      const eli5 = await askGroq(
        `Explain "${topic}" like the reader is five years old and slightly bored. `
        + `One paragraph, then one fun fact.${extract ? `\nReference material: ${extract}` : ''}`
        + `${extract ? '' : '\nI could not fetch the article, so use your own knowledge and say if it is outside what you know.'}`,
        'Style: clear, funny, never condescending.',
      );

      await reply(
        `📚 **${String((data && data.title) || topic).toUpperCase()}**\n`
        + '· · · · · · ·\n'
        + `${extract ? `📄 ${extract.slice(0, 700)}\n\n` : ''}`
        + `🧒 ${eli5}\n💸 ${kc(FEES.wiki)}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'define',
    aliases: ['def', 'definitionai'],
    category: 'downloader',
    description: '📖 Word meaning, phonetics, and an example in the iKON register',
    usage: '!define <word>',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'define', async () => {
      await react('📖');
      const word = args.join(' ').trim();
      if (!word) {
        await reply('❌ Usage: `!define laconic`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.define, 'downloader:define');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const data = await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      const entry = Array.isArray(data) ? data[0] : null;
      const meanings = (entry && entry.meanings) || [];
      const defs = meanings.flatMap((m) => (m.definitions || []).map((d) => `${m.partOfSpeech}: ${d.definition}`));
      const phonetic = (entry && entry.phonetic)
        || (meanings.find((m) => m.phonetic) || {}).phonetic || '';

      await reply('📖 Checking the dictionary...', event.messageID);
      const usage = await askGroq(
        `Give me: an example sentence using "${word}" the way a real person would say it, `
        + `the closest single word that means almost the same thing, and one line on the vibe `
        + `of using it.`
        + (defs.length ? `\nDictionary says: ${defs.slice(0, 3).join(' | ')}` : '\nNo dictionary entry was found, so use your own knowledge.'),
        'Style: concise, slightly rude about how people misuse words.',
      );

      await reply(
        `📖 **${String(word).toUpperCase()}**${phonetic ? ` ${phonetic}` : ''}\n`
        + '· · · · · · ·\n'
        + (defs.length ? `${defs.slice(0, 4).join('\n')}\n\n` : '⚠️ Not in the dictionary.\n\n')
        + `${usage}\n💸 ${kc(FEES.define)}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'summarize',
    aliases: ['sum', 'tldr'],
    category: 'downloader',
    description: '📋 Reply to a long message — Groq tells you what actually happened',
    usage: '!summarize (reply to a message)',
    cooldown: 15,
    permission: 'all',
    execute: async ({ api, args, event, userDoc, reply, react }) => guard(reply, event.messageID, 'summarize', async () => {
      await react('📋');
      // The quoted text arrives on the message body of the message being replied
      // to. Fall back to the raw args so it still works if someone types it.
      let quoted = '';
      try {
        const info = await api.getThreadInfo(event.threadID);
        const list = (info && (info.messageList || info.messages)) || [];
        const msg = list.find((m) => String(m.messageID) === String(event.messageID)) || list[list.length - 1];
        quoted = String((msg && (msg.body || msg.text)) || '');
      } catch {
        quoted = '';
      }
      // No quoted message means they pasted it as args instead. Either is fine.
      const text = quoted || (args || []).join(' ');
      if (!text || text.length < 20) {
        await reply('📋 Reply to a message longer than a sentence and I will summarise it.', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.summarize, 'downloader:summarize');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const brief = await askGroq(
        `Summarise this in 3 lines maximum, then one line naming the real story underneath it. `
        + `Text: ${text.slice(0, 3000)}`,
        'Style: the friend who tells you what actually happened.',
      );
      await reply(`📋 **THE SHORT VERSION**\n━━━━━━━━━━━━━━━\n${brief}\n💸 ${kc(FEES.summarize)}`, event.messageID);
    }),
  });

  commands.push({
    name: 'rewrite',
    aliases: ['rephrase', 'rewriter'],
    category: 'downloader',
    description: '✍️ Same words, different energy — fancy, toxic or funny',
    usage: '!rewrite <fancy|toxic|funny> <text>',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'rewrite', async () => {
      await react('✍️');
      const mode = (args[0] || '').toLowerCase();
      const text = args.slice(1).join(' ').trim();
      if (!mode || !text) {
        await reply('❌ Usage: `!rewrite <fancy|toxic|funny> <text>`', event.messageID);
        return;
      }
      const styles = {
        fancy: 'Rewrite it as if it were written for a formal newspaper. Keep every fact identical, just dress it up.',
        toxic: 'Rewrite it to be genuinely savage. Keep every fact identical, just sharpen the edges.',
        funny: 'Rewrite it so it is actually funny without changing a single fact.',
      };
      if (!styles[mode]) {
        await reply(`❌ Pick one: ${Object.keys(styles).join(', ')}`, event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.rewrite, 'downloader:rewrite');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const out = await askGroq(
        `${styles[mode]} Output only the rewrite, nothing else. Original: "${text}"`,
        'Style: one rewrite. Do not add a preamble or offer alternatives.',
      );
      await reply(`✍️ **${mode.toUpperCase()}**\n━━━━━━━━━━━━━━━\n${out}`, event.messageID);
    }),
  });

  commands.push({
    name: 'storyai',
    aliases: ['story', 'ikostory'],
    category: 'downloader',
    description: '📖 Write a story with the reader in it — horror, comedy, whatever',
    usage: '!storyai <topic> [genre]',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'storyai', async () => {
      await react('📖');
      const topic = args.join(' ').trim();
      if (!topic) {
        await reply('❌ Usage: `!storyai haunted hotel horror`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.storyai, 'downloader:storyai');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const story = await askGroq(
        `Write a short story about "${topic}". Make ${userDoc.name} the main character by name. `
        + `Under 300 words. End on a line that lands.`,
        'Style: real prose, not a chat reply. No preamble of any kind.',
      );

      const card = await captionCard({
        title: 'iKON STORY',
        subtitle: topic.toUpperCase(),
        body: `${userDoc.name} walked in. That was the first mistake.`,
        footer: `${OWNER} · Groq`,
        accent: canvasKit.theme.accent2,
      });
      if (card) {
        await reply({ attachment: { type: 'image', data: { url: card } } }, event.messageID);
      }
      await reply(`📖 **${topic.toUpperCase()}**\n━━━━━━━━━━━━━━━\n${story}`, event.messageID);
    }),
  });

  commands.push({
    name: 'codeai',
    aliases: ['codereview', 'codium'],
    category: 'downloader',
    description: '🧑‍💻️ Groq reviews your code, roasts it, and shows the fix',
    usage: '!codeai <code>',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'codeai', async () => {
      await react('🧑‍💻️');
      const code = args.join('\n').trim();
      if (!code) {
        await reply('❌ Usage: `!codeai <paste your code>`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.codeai, 'downloader:codeai');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      // Length is capped because a whole file pasted into a chat message costs
      // Groq tokens nobody wants to pay for and produces a weaker review.
      const review = await askGroq(
        `Review this code in 4 short parts: BUGS (real problems only), ROAST (one line, funny), `
        + `FIX (a corrected version), SCORE out of 10. Do not invent bugs that are not there. `
        + `Code:\n\`\`\`\n${code.slice(0, 2500)}\n\`\`\``,
        'Style: senior engineer, kind about the code and blunt about the habits.',
      );

      await reply(
        `🧑‍💻️ **CODE REVIEW**\n━━━━━━━━━━━━━━━\n${review}\n💸 ${kc(FEES.codeai)}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'songai',
    aliases: ['song', 'writesong'],
    category: 'downloader',
    description: '🎵 Groq writes the whole song — verse, chorus, and how to sing it',
    usage: '!songai <topic> [mood]',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'songai', async () => {
      await react('🎵');
      const topic = args.join(' ').trim();
      if (!topic) {
        await reply('❌ Usage: `!songai heartbreak`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.songai, 'downloader:songai');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply('🎵 Writing...', event.messageID);
      const song = await askGroq(
        `Write a complete short song about "${topic}" for ${userDoc.name}. `
        + `Structure: TITLE, 2 verses, a chorus, a bridge line, then a 3 line "SING IT LIKE" `
        + `guide with the vocal note that fits. The words must be original — never reuse the `
        + `lyrics of any real song. No copyrighted melodies.`,
        'Style: real lyrics. No commentary before or after.',
      );

      const card = await captionCard({
        title: 'iKON SONG',
        subtitle: `FOR ${String(userDoc.name).toUpperCase()}`,
        body: `${topic}`,
        footer: `${OWNER} · Groq`,
        accent: canvasKit.theme.gold,
      });
      if (card) {
        await reply({ attachment: { type: 'image', data: { url: card } } }, event.messageID);
      }

      // The song it just wrote, read back out loud. Groq's verses are original,
      // so speaking them is not anyone's copyright.
      const singable = String(song)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^#+\s*/gm, '')
        .replace(/[*_#`~|]/g, ' ')
        .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 14)
        .join('. ');

      await sendVoice({
        reply,
        messageID: event.messageID,
        text: `${topic}. ${singable}`,
        body: `🎵 **${topic.toUpperCase()}**\n━━━━━━━━━━━━━━━\n${song}\n💸 ${kc(FEES.songai)}`,
      });
    }),
  });

module.exports = commands;
