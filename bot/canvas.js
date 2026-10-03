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

let canvas = null;
let loadError = null;

/** Load the library on first use so a missing binary never breaks startup. */
function lib() {
  if (canvas || loadError) return canvas;

  for (const id of ['@napi-rs/canvas', 'canvas']) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      canvas = require(id);
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
 * @param {boolean} [isGroup] the event's isGroup flag. Required for groups whose
 *   threadID has no `t_` prefix, which is how these images failed too.
 */
async function sendImage(api, threadID, canvasObj, messageID, isGroup = undefined) {
  const buffer = await toBuffer(canvasObj);
  if (!buffer || !api) return null;
  const payload = { attachment: { type: 'image', data: { url: `data:image/png;base64,${buffer.toString('base64')}` } } };
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
  sendImage,
  theme,
  FONT,
  lib,
};
