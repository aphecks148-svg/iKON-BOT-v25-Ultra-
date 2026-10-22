'use strict';

/**
 * Thin, lazy wrapper around the canvas implementation.
 *
 * Two of them, tried in order:
 *
 *   1. @napi-rs/canvas — ships prebuilt native binaries, so it works on Render
 *      and Android with no build step. This is the one we expect to use.
 *   2. canvas (node-canvas) — a source build needing cairo. It is an OPTIONAL
 *      dependency precisely so that a host without the cairo headers still
 *      deploys: npm skips the build and the bot comes up with images disabled
 *      rather than the deploy failing outright.
 *
 * The two expose the same createCanvas/getContext/toBuffer surface, so only the
 * require and the buffer call differ. loadImage is checked for separately
 * because it is the one method an older node-canvas build may not expose.
 *
 * Used for profile cards, leaderboards, welcome images and the social cards.
 */

const fs = require('fs');
const path = require('path');

const { isGroupThread } = require('./helpers');
const media = require('./media');

let canvas = null;
let loadError = null;
let fontsReady = false;
let emojiFamily = '';

/** The families to try, best first, for a plain text face and a fixed one. */
const SANS_FAMILIES = [
  'Roboto', 'DejaVu Sans', 'Noto Sans', 'Liberation Sans', 'Arial', 'Helvetica',
  'Droid Sans', 'Nimbus Sans', 'FreeSans', 'Ubuntu', 'Open Sans', 'Lato',
];
const MONO_FAMILIES = [
  'Roboto Mono', 'DejaVu Sans Mono', 'Noto Sans Mono', 'Liberation Mono',
  'Droid Sans Mono', 'Courier New', 'Courier', 'Ubuntu Mono', 'FreeMono',
];

/**
 * Make the generic font names mean something.
 *
 * WHY THIS EXISTS
 * Every card in this bot draws its text with `sans-serif`, `monospace` or
 * `iKonSans`. @napi-rs/canvas does not map the CSS generic families the way a
 * browser does: it looks the family up in the list of REGISTERED fonts, and
 * "sans-serif" is not in that list. So `ctx.font = 'bold 40px sans-serif'`
 * drew NOTHING AT ALL — not a substitute face, no glyphs. Every card in the
 * bot was a coloured box with an avatar on it and not one word on it.
 *
 * The alias is the name the canvas then finds, so this one change makes all
 * of them draw. A font file is the fallback for a build whose canvas has no
 * setAlias().
 *
 * @returns {boolean} whether the text faces are ready
 */
function ensureFonts() {
  if (fontsReady) return true;
  const c = lib();
  if (!c) return false;
  const gf = c.GlobalFonts;
  if (!gf) return false;

  try {
    if (typeof gf.loadSystemFonts === 'function') gf.loadSystemFonts();
  } catch { /* the families may already be there */ }

  const list = (gf.families || (typeof gf.getFamilies === 'function' ? gf.getFamilies() : [])) || [];
  const families = list.map((f) => (typeof f === 'string' ? f : f.family)).filter(Boolean);

  const sans = SANS_FAMILIES.find((f) => families.includes(f))
    || families.find((f) => !/emoji|icon|color/i.test(f));
  const mono = MONO_FAMILIES.find((f) => families.includes(f));

  let ok = false;
  if (typeof gf.setAlias === 'function' && sans) {
    for (const alias of ['sans-serif', 'iKonSans']) {
      try {
        gf.setAlias(sans, alias);
        ok = true;
      } catch { /* try the next alias */ }
    }
    if (mono) {
      try {
        gf.setAlias(mono, 'monospace');
      } catch { /* a fixed face is a nicety */ }
    }
  }

  if (!ok) {
    // A build whose canvas cannot alias: register a font FILE under the names
    // the cards use instead.
    const file = firstFontFile();
    if (file && typeof gf.registerFromPath === 'function') {
      for (const alias of ['sans-serif', 'iKonSans', 'monospace']) {
        try {
          gf.registerFromPath(file, alias);
          ok = true;
        } catch { /* try the next alias */ }
      }
    }
  }

  fontsReady = ok;
  if (!ok) console.warn('[CANVAS] no text font could be resolved — cards will draw without words');
  return ok;
}

/**
 * The emoji face, if this machine has one.
 *
 * @napi-rs/canvas picks ONE font for a run of text and does not fall back per
 * glyph, so an emoji drawn in a text face is a tofu box. The emoji have their
 * own family and have to be asked for by name.
 *
 * @returns {string} the family name, or '' when there is none
 */
function emojiFont() {
  const c = lib();
  if (!c || !c.GlobalFonts) return '';
  if (emojiFamily) return emojiFamily;
  const list = (c.GlobalFonts.families || (typeof c.GlobalFonts.getFamilies === 'function' ? c.GlobalFonts.getFamilies() : [])) || [];
  const families = list.map((f) => (typeof f === 'string' ? f : f.family)).filter(Boolean);
  emojiFamily = families.find((f) => /color emoji|apple color emoji|segoe ui emoji|joypixels|twemoji|noto emoji/i.test(f))
    || families.find((f) => /emoji/i.test(f))
    || '';
  return emojiFamily;
}

/**
 * Draw one emoji, in the emoji face, and say how wide it was.
 *
 * The width matters: the text after the emoji has to be placed beside it
 * rather than on top of it, and the two are in different faces.
 *
 * @param {object} ctx the 2D context
 * @param {string} emoji the character
 * @param {number} x
 * @param {number} y
 * @param {number} [size] the font size in pixels
 * @returns {number} the width it took
 */
function drawEmoji(ctx, emoji, x, y, size = 32) {
  if (!ctx || !emoji) return 0;
  const family = emojiFont();
  if (!family) return 0;
  const before = ctx.font;
  const align = ctx.textAlign;
  try {
    ctx.textAlign = 'left';
    ctx.font = `${size}px "${family}"`;
    ctx.fillText(String(emoji), x, y);
    const w = ctx.measureText(String(emoji)).width;
    ctx.font = before;
    ctx.textAlign = align;
    return w;
  } catch {
    ctx.font = before;
    ctx.textAlign = align;
    return 0;
  }
}

/** A font file on this machine, if there is one. */
function firstFontFile() {
  const dirs = [
    path.join(__dirname, 'fonts'),
    '/system/fonts',
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    'C:\\Windows\\Fonts',
  ];
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((f) => /\.(ttf|otf)$/i.test(f));
    } catch { continue; }
    // A sans face is the one wanted; a mono file is better than nothing.
    const pick = names.find((f) => /sans(?!-?mono)|roboto|droid/i.test(f)) || names[0];
    if (pick) return path.join(dir, pick);
  }
  return '';
}

/** Load the library on first use so a missing binary never breaks startup. */
function lib() {
  if (canvas || loadError) return canvas;

  for (const id of ['@napi-rs/canvas', 'canvas']) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      canvas = require(id);
      ensureFonts();
      return canvas;
    } catch (err) {
      loadError = err;
      console.warn(`[CANVAS] ${id} unavailable: ${err.message}`);
    }
  }
  return canvas;
}

const available = () => Boolean(lib());
const error = () => loadError;

/**
 * Create a canvas and expose a 2D context.
 * @param {number} width
 * @param {number} height
 * @returns {{canvas:object, ctx:object}|null} null when the library is unavailable
 */
function create(width, height) {
  const c = lib();
  if (!c) return null;
  try {
    const surface = c.createCanvas(width, height);
    const ctx = surface.getContext('2d');
    return { canvas: surface, ctx };
  } catch (err) {
    console.warn(`[CANVAS] create failed: ${err.message}`);
    return null;
  }
}

/** Render a canvas to a PNG buffer, ready for api.sendMessage. */
async function toBuffer(canvasObj) {
  if (!canvasObj) return null;
  try {
    // @napi-rs/canvas exposes Canvas#toBuffer(); there is no encode() helper.
    // node-canvas has encode(); it has no toBuffer(). Try both.
    let buf = null;
    if (typeof canvasObj.toBuffer === 'function') buf = canvasObj.toBuffer('image/png');
    else if (typeof canvasObj.toDataURL === 'function') {
      const url = canvasObj.toDataURL('image/png');
      return Buffer.from(String(url).split(',')[1] || '', 'base64');
    } else if (typeof canvasObj.encode === 'function') buf = canvasObj.encode('png');
    if (Buffer.isBuffer(buf)) return buf;
    return buf ? Buffer.from(buf) : null;
  } catch (err) {
    console.warn(`[CANVAS] toBuffer failed: ${err.message}`);
    return null;
  }
}

/** Load a font from disk (optional — falls back to the default face). */
async function loadFont(name, file) {
  const c = lib();
  if (!c) return false;
  try {
    await c.GlobalFonts.registerFromPath(file, name);
    return true;
  } catch (err) {
    console.warn(`[CANVAS] font "${name}" failed: ${err.message}`);
    return false;
  }
}

/**
 * Register the best font available for labels.
 * Android containers ship almost no system fonts, so a missing font must
 * degrade to shapes-and-gradients rather than crash or render blank text.
 */
async function registerDefaultFont(dir = path.join(__dirname, 'fonts')) {
  const c = lib();
  if (!c) return false;
  try {
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => /\.(ttf|otf)$/i.test(f))
      : [];
    if (!files.length) return false;
    let loadedAny = false;
    for (const f of files) {
      // eslint-disable-next-line no-await-in-loop
      if (await loadFont('iKonSans', path.join(dir, f))) loadedAny = true;
    }
    return loadedAny;
  } catch {
    return false;
  }
}

/**
 * Send a canvas as a Messenger attachment.
 *
 * The reply-to id is sendMessage's THIRD argument, not a payload key: ws3-fca
 * whitelists payload properties and throws "Dissallowed props" otherwise, which
 * is why the text side of these commands used to go out while the image did not.
 *
 * The attachment itself has to be a readable stream. This build rejects the
 * `{ type, data: { url } }` descriptor that every command in the repo used to
 * write, so media.attachment() turns the PNG into something the uploader accepts.
 * Passing a stream in front of a client that wanted an object would be harmless;
 * passing an object in front of this one loses the image silently.
 *
 * @param {boolean} [isGroup] the event's isGroup flag. Required for groups whose
 *   threadID has no `t_` prefix, which is how these images failed too.
 */
async function sendImage(api, threadID, canvasObj, messageID, isGroup = undefined) {
  const buffer = await toBuffer(canvasObj);
  if (!buffer || !api) return null;
  const stream = await media.attachment(buffer, { type: 'image' });
  if (!stream) return null;
  const payload = { attachment: stream };
  const replyTo = messageID === undefined || messageID === null ? null : String(messageID);
  try {
    return await api.sendMessage(payload, threadID, replyTo, !isGroupThread(threadID, isGroup));
  } catch (err) {
    console.warn(`[CANVAS] sendImage failed: ${err.message}`);
    return null;
  }
}

/** Common brand colours. */
const FONT = 'iKonSans';

const theme = {
  bg1: '#0f0f1a',
  bg2: '#1a1030',
  accent: '#00d4ff',
  accent2: '#b14bff',
  gold: '#ffcc00',
  text: '#ffffff',
  muted: '#9aa0b5',
};

module.exports = {
  available,
  error,
  create,
  toBuffer,
  loadFont,
  registerDefaultFont,
  ensureFonts,
  emojiFont,
  drawEmoji,
  sendImage,
  theme,
  FONT,
  lib,
};
