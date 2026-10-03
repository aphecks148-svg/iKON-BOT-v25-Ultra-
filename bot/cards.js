'use strict';

/**
 * Canvas cards for the RPG boards — profile, xp, rank and richest.
 *
 * These used to be plain text, which is why the pictures and real names had
 * nowhere to go. Each card takes the rows straight from the database and renders
 * them with a real Facebook photo per hunter, falling back to a generated
 * avatar when Facebook has none.
 *
 * Every function returns a PNG data URL, or null when the native canvas binary
 * is unavailable. Callers must fall back to their text reply on null: on a
 * platform without the prebuilt binding a command that only ever sends an image
 * would be silent.
 */

const canvasKit = require('./canvas');
const profile = require('./profile');
const { error } = require('./helpers');

const W = 900;

/**
 * The join/leave card is a different shape from the boards on purpose: 1200x600
 * is what Facebook serves unrescaled in a chat, and this is the one image in the
 * bot that gets screenshotted and sent somewhere else.
 */
const ARRIVAL_W = 1200;
const ARRIVAL_H = 600;

/** Rounded rectangle path. */
function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Paint the shared dark gradient background. */
function paintBackground(ctx, h) {
  const grad = ctx.createLinearGradient(0, 0, W, h);
  grad.addColorStop(0, '#0f0f1a');
  grad.addColorStop(1, '#1a1030');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, h);
}

/** Paint a header band with a title. */
function paintHeader(ctx, emoji, title, subtitle) {
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  roundRect(ctx, 24, 24, W - 48, 108, 22);
  ctx.fill();

  ctx.font = 'bold 44px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`${emoji} ${title}`, 48, 66);

  if (subtitle) {
    ctx.font = '22px sans-serif';
    ctx.fillStyle = '#9aa0b5';
    ctx.fillText(subtitle, 48, 104);
  }
}

/**
 * Load an image Buffer with @napi-rs/canvas. Resolves null rather than throwing:
 * a corrupt or unsupported file must not take the whole card down.
 *
 * Async on purpose: @napi-rs/canvas loadImage() returns a Promise, so a sync
 * version would hand drawAvatar a pending Promise and throw "not one of these
 * types: CanvasElement, SVGCanvas, Image" on every real photo.
 *
 * @param {Buffer|null} buf
 * @returns {Promise<object|null>}
 */
async function loadImage(buf) {
  if (!buf) return null;
  try {
    return await canvasKit.lib().loadImage(buf);
  } catch (err) {
    error(`[CARD] loadImage failed: ${err.message}`);
    return null;
  }
}

/**
 * Download a Facebook avatar and decode it.
 *
 * Why the bytes are fetched here instead of handing the URL straight to
 * loadImage(): `thumbSrc` is a plain CDN URL that arrives with the thread's
 * member list, which is the fastest and only always-present source of a
 * picture. But @napi-rs/canvas accepts a URL string and node-canvas does not,
 * and this bot may be running either. Buffer works in both, so the bytes are
 * downloaded first and the loader never sees a string.
 *
 * Facebook's avatar endpoint answers with a redirect to the CDN; axios follows
 * it in Node. Anything under 128 bytes is a 1x1 placeholder or a stub error body,
 * and drawing that would put a blank square where a face should be. The floor is
 * deliberately low: a small solid-colour PNG is a few hundred bytes and is a
 * perfectly valid image, so a higher bar would throw away real avatars on the
 * strength of how well they compress.
 *
 * @param {string} url
 * @returns {Promise<Buffer|null>}
 */
async function thumbBuffer(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  try {
    const axios = require('axios');
    const res = await axios.get(u, {
      responseType: 'arraybuffer',
      timeout: 8000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data || []);
    return buf.length >= 128 ? buf : null;
  } catch (err) {
    error(`[CARD] avatar download failed for ${u.slice(0, 80)}: ${err.message}`);
    return null;
  }
}

/**
 * Draw a circular avatar.
 *
 * @param {object} ctx
 * @param {Buffer|null} buf picture bytes, or null for the generated fallback
 * @param {number} x centre x
 * @param {number} y centre y
 * @param {number} d diameter
 * @returns {Promise<void>}
 */
async function drawAvatar(ctx, buf, x, y, d) {
  const img = await loadImage(buf);
  const r = d / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  if (img) {
    // Cover-fit: centre-crop whatever aspect Facebook returned to a square.
    const scale = Math.max(d / img.width, d / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.drawImage(img, x - w / 2, y - h / 2, w, h);
  } else {
    ctx.fillStyle = '#2a2a44';
    ctx.fillRect(x - r, y - r, d, d);
  }
  ctx.restore();

  // Ring so a pale photo still reads against the dark card.
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,212,255,0.65)';
  ctx.stroke();
  ctx.restore();
}

/**
 * Trim a name to fit a pixel width, with an ellipsis.
 */
function fit(ctx, text, maxWidth) {
  let out = String(text == null ? '' : text);
  if (ctx.measureText(out).width <= maxWidth) return out;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

/**
 * The display name for a row: the real Facebook name when available, otherwise
 * whatever is stored. A stored "Facebook User" is a placeholder the database
 * picked up from a failed lookup, so it is shown as a short id instead — better
 * an honest id than a fake name on a leaderboard.
 *
 * @param {object} row a lean user document
 * @param {object} api ws3-fca client
 * @returns {Promise<string>}
 */
async function realName(row, api) {
  const live = await profile.fetchRealName(row.uid, api);
  if (live) return live;
  const stored = row.name;
  if (stored && !profile.isPlaceholderName(stored)) return stored;
  return `Hunter ${String(row.uid || '').slice(-4)}`;
}

/**
 * A two-person card for the social commands: real Facebook photos of both
 * people, their real Facebook names, and the thread the whole thing happened in.
 *
 * The thread id is on the card on purpose. These commands are all per-chat state
 * (a hug count, a marriage, a beef) that lives on the Group document, and a
 * screenshot of a board is otherwise unattributable — you cannot tell which chat
 * a scoreboard came from. It also makes a wrong-thread bug obvious at a glance.
 *
 * Pass `right: null` for a command that acts on one person only (a dare, a
 * pickup line); the layout then centres the single photo.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.emoji]
 * @param {string} [opts.subtitle]
 * @param {string|number} [opts.threadID] shown in the footer
 * @param {{uid?:string,name?:string}} opts.left the person who acted
 * @param {{uid?:string,name?:string}|null} [opts.right] the person acted upon
 *        Both may carry a `thumbSrc` — the avatar URL that came with the chat's
 *        member list. It is preferred over a getUserInfo lookup: the thread
 *        already has it, so the card costs one request instead of two, and it
 *        is the only source that works for somebody who has no cached profile.
 * @param {string} [opts.body] one or two lines of context
 * @param {string} [opts.footer] the disclaimer line
 * @param {object} opts.api ws3-fca client
 * @returns {Promise<string|null>} PNG data URL, or null without the canvas binary
 */
async function duoCard({ title, emoji = '', subtitle = '', threadID, left, right = null, body = '', footer = '', api }) {
  if (!canvasKit.available()) return null;
  if (!left) return null;

  const W2 = 900;
  const H = 510;
  const solo = !right;

  try {
    const cv = canvasKit.create(W2, H);
    const ctx = cv.ctx;

    paintBackground(ctx, H);
    paintHeader(ctx, emoji, title, subtitle);

    // One round trip for both people: name and photo together, in parallel.
    const person = async (p) => {
      if (!p) return null;
      const uid = p.uid != null ? String(p.uid) : '';
      const live = uid ? await profile.fetchRealName(uid, api) : null;
      const name = live
        || (p.name && !profile.isPlaceholderName(p.name) ? p.name : '')
        || (uid ? `Hunter ${uid.slice(-4)}` : 'Someone');

      // thumbSrc first. It came with the chat, so it is free; getUserInfo is
      // the fallback for a caller that has no thread to read it from.
      const thumb = String(p.thumbSrc || '').trim();
      const pic = thumb ? (await thumbBuffer(thumb)) : null;
      if (pic) return { name, pic, uid };
      return { name, pic: uid ? await profile.picture(uid, api) : null, uid };
    };

    const [a, b] = await Promise.all([person(left), person(right)]);

    // Geometry, all fixed so nothing overlaps:
    //   header band ends y=132, photo top y=224
    //   avatars 128px at x 355 / 545 — 62px of clear space between them for
    //   the arrow, rather than a gap narrower than the circles themselves
    //   names baseline y=390, body y=430, footer y=472
    const cy = 288;
    const d = 128;
    const xs = solo ? [W2 / 2] : [W2 / 2 - 95, W2 / 2 + 95];

    await drawAvatar(ctx, a.pic, xs[0], cy, d);
    if (b) await drawAvatar(ctx, b.pic, xs[1], cy, d);

    // Names, under the photos but pushed outwards so two long names cannot
    // collide in the middle of the card.
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillStyle = '#ffffff';
    const nameY = 390;
    if (solo) {
      ctx.fillText(fit(ctx, a.name, 460), W2 / 2, nameY);
    } else {
      ctx.fillText(fit(ctx, a.name, 300), xs[0] - 60, nameY);
      ctx.fillText(fit(ctx, b.name, 300), xs[1] + 60, nameY);
    }

    // The arrow sits in the clear space between the two, so the direction of
    // the action is unambiguous.
    if (!solo) {
      ctx.font = 'bold 34px sans-serif';
      ctx.fillStyle = 'rgba(0,212,255,0.85)';
      ctx.textAlign = 'center';
      ctx.fillText('→', W2 / 2, cy);
    }

    // The body often arrives with hard newlines (a coin total, a rank, a pet
    // line). fillText does not honour \n, so it is wrapped by hand into at most
    // two lines — the alternative is a single ellipsised line that throws away
    // the most interesting part of the card.
    if (body) {
      ctx.font = '22px sans-serif';
      ctx.fillStyle = '#9aa0b5';
      ctx.textAlign = 'center';
      const maxW = W2 - 120;
      const words = String(body).split(/\s+/).filter(Boolean);
      const out = [];
      let line = '';
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(test).width > maxW) {
          out.push(line);
          line = word;
          if (out.length === 2) break;
        } else {
          line = test;
        }
      }
      if (line && out.length < 2) out.push(line);
      out.slice(0, 2).forEach((l, i) => {
        ctx.fillText(fit(ctx, l, maxW), W2 / 2, 424 + i * 26);
      });
    }

    // Footer: the disclaimer, and the thread this all belongs to.
    ctx.textAlign = 'left';
    ctx.font = 'bold 19px sans-serif';
    ctx.fillStyle = '#ffcc00';
    ctx.fillText(fit(ctx, footer || 'NONE OF THIS IS REAL', 560), 48, H - 20);
    if (threadID) {
      ctx.textAlign = 'right';
      ctx.font = '17px sans-serif';
      ctx.fillStyle = 'rgba(154,160,181,0.9)';
      ctx.fillText(`chat ${threadID}`, W2 - 48, H - 20);
    }

    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    error(`[CARD] duoCard failed: ${err.message}`);
    return null;
  }
}

/**
 * A single-user card: the ID card for !profile and !xp.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.emoji
 * @param {string} opts.subtitle
 * @param {Array<[string, string]>} opts.rows label/value pairs
 * @param {number} [opts.accent] hue for the progress bar
 * @param {object} opts.api ws3-fca client
 * @param {object} opts.user lean-ish user document with uid
 * @returns {Promise<string|null>} PNG data URL, or null without the canvas binary
 */
async function userCard({ title, emoji, subtitle, rows, api, user }) {
  if (!canvasKit.available()) return null;
  try {
    const rowH = 46;
    const h = 172 + Math.max(1, rows.length) * rowH + 56;
    const cv = canvasKit.create(W, h);
    const ctx = cv.ctx;

    paintBackground(ctx, h);
    paintHeader(ctx, emoji, title, subtitle);

    // Avatar + name block on the left of the body.
    const pic = await profile.picture(user && user.uid, api);
    await drawAvatar(ctx, pic, 92, 208, 112);

    const name = await realName(user || {}, api);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 34px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(fit(ctx, name, W - 260), 172, 208);

    let y = 268;
    for (const [label, value] of rows) {
      ctx.font = '24px sans-serif';
      ctx.fillStyle = '#9aa0b5';
      ctx.textAlign = 'left';
      ctx.fillText(label, 48, y);

      ctx.font = 'bold 26px sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'right';
      ctx.fillText(fit(ctx, value, W - 300), W - 48, y);
      y += rowH;
    }

    ctx.font = '20px sans-serif';
    ctx.fillStyle = 'rgba(154,160,181,0.75)';
    ctx.textAlign = 'center';
    ctx.fillText('iKON-BOT v2 Ultra', W / 2, h - 30);

    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    error(`[CARD] userCard failed: ${err.message}`);
    return null;
  }
}

/**
 * A leaderboard card for !rank, !richest, !lb and friends.
 *
 * Rows are drawn in order with a medal for the top three and a real photo per
 * hunter. Pictures are fetched concurrently because ten sequential HTTPS calls
 * to Facebook would add seconds to a chat reply.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.emoji
 * @param {string} opts.subtitle
 * @param {Array<object>} opts.rows lean user documents
 * @param {(row:object, i:number) => string} opts.value renders the right-hand text
 * @param {object} opts.api ws3-fca client
 * @param {number} [opts.limit] how many rows to draw
 * @returns {Promise<string|null>} PNG data URL, or null without the canvas binary
 */
async function boardCard({ title, emoji, subtitle, rows, value, api, limit = 10 }) {
  if (!canvasKit.available()) return null;
  const shown = (rows || []).slice(0, limit);
  if (!shown.length) return null;

  try {
    const rowH = 92;
    const h = 172 + shown.length * rowH + 28;
    const cv = canvasKit.create(W, h);
    const ctx = cv.ctx;

    paintBackground(ctx, h);
    paintHeader(ctx, emoji, title, subtitle);

    // Resolve names and pictures together, once, in parallel.
    const [names, pics] = await Promise.all([
      Promise.all(shown.map((r) => realName(r, api))),
      Promise.all(shown.map((r) => profile.picture(r.uid, api))),
    ]);

    const medals = ['🥇', '🥈', '🥉'];
    let y = 172 + rowH / 2;

    for (let i = 0; i < shown.length; i += 1) {
      const row = shown[i];
      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.035)';
        roundRect(ctx, 24, y - rowH / 2 + 4, W - 48, rowH - 8, 14);
        ctx.fill();
      }

      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = 'bold 30px sans-serif';
      ctx.fillStyle = '#ffcc00';
      ctx.fillText(medals[i] || `${i + 1}.`, 44, y);

      await drawAvatar(ctx, pics[i], 148, y, 60);

      ctx.font = 'bold 27px sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(fit(ctx, names[i], 380), 194, y - 13);

      ctx.font = '22px sans-serif';
      ctx.fillStyle = '#9aa0b5';
      ctx.textAlign = 'right';
      ctx.fillText(fit(ctx, value(row, i), 300), W - 44, y - 13);

      // Numeric detail line under the value.
      ctx.textAlign = 'right';
      ctx.font = '19px sans-serif';
      ctx.fillStyle = 'rgba(0,212,255,0.8)';
      ctx.fillText(fit(ctx, row.uid ? `uid ${row.uid}` : '', 300), W - 44, y + 17);

      y += rowH;
    }

    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    error(`[CARD] boardCard failed: ${err.message}`);
    return null;
  }
}

/**
 * A pair board for the social commands — best friends and enemies, where every
 * row is two people rather than one.
 *
 * Drawn as two overlapping avatars so a pair reads at a glance, which a text list
 * of names cannot do.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.emoji
 * @param {string} opts.subtitle
 * @param {Array<{a:string,b:string,score:number}>} opts.pairs uids, not names
 * @param {object} opts.api ws3-fca client
 * @param {(pair:object, i:number) => string} [opts.value] right-hand text
 * @param {number} [opts.limit]
 * @returns {Promise<string|null>} PNG data URL, or null without the canvas binary
 */
async function pairCard({ title, emoji, subtitle, pairs, api, value, limit = 8 }) {
  if (!canvasKit.available()) return null;
  const shown = (pairs || []).slice(0, limit);
  if (!shown.length) return null;

  try {
    const rowH = 88;
    const h = 172 + shown.length * rowH + 28;
    const cv = canvasKit.create(W, h);
    const ctx = cv.ctx;

    paintBackground(ctx, h);
    paintHeader(ctx, emoji, title, subtitle);

    const resolved = await Promise.all(shown.map(async (p) => {
      const [na, nb, pa, pb] = await Promise.all([
        profile.fetchRealName(p.a, api) || `Hunter ${String(p.a).slice(-4)}`,
        profile.fetchRealName(p.b, api) || `Hunter ${String(p.b).slice(-4)}`,
        profile.picture(p.a, api),
        profile.picture(p.b, api),
      ]);
      return { na, nb, pa, pb };
    }));

    let y = 172 + rowH / 2;

    for (let i = 0; i < shown.length; i += 1) {
      const pair = shown[i];
      const r = resolved[i];

      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.035)';
        roundRect(ctx, 24, y - rowH / 2 + 4, W - 48, rowH - 8, 14);
        ctx.fill();
      }

      // Overlapping pair, the left one on top. Awaited in order so the two
      // circles are drawn deterministically rather than interleaved.
      await drawAvatar(ctx, r.pa, 118, y, 62);
      await drawAvatar(ctx, r.pb, 176, y, 62);

      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = 'bold 26px sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(fit(ctx, `${r.na} + ${r.nb}`, 380), 222, y - 12);

      ctx.font = '21px sans-serif';
      ctx.fillStyle = '#9aa0b5';
      ctx.textAlign = 'right';
      ctx.fillText(fit(ctx, value ? value(pair, i) : String(pair.score || 0), 260), W - 44, y - 12);

      y += rowH;
    }

    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    error(`[CARD] pairCard failed: ${err.message}`);
    return null;
  }
}


/**
 * A single-person card for a chat arrival or departure.
 *
 * The thread NAME is on this card, not just the id, because "Welcome to the
 * arcade" is a lie in a chat called something else entirely.
 *
 * 1200x600, because that is the size Facebook does not rescale on the way into
 * a chat, and this is the one image in the bot people screenshot. Layout, top to
 * bottom: the house gradient, a dark overlay so the type stays legible over any
 * avatar, the person's actual Facebook photo in a circle in the middle, then the
 * line the chat is about.
 *
 * Returns PNG bytes, not a data URL: this card is uploaded straight to
 * Messenger rather than handed to a template, and base64 costs a third again
 * the memory on every single join. Null when it cannot be drawn — the caller
 * falls back to its text line.
 *
 * @param {object} opts
 * @param {'welcome'|'goodbye'} opts.kind
 * @param {string|number} opts.uid
 * @param {string} [opts.name] name from the join event, used if Facebook is slow
 * @param {string} [opts.threadName]
 * @param {string|number} [opts.threadID]
 * @param {string} [opts.picUrl] a `thumbSrc` straight off the thread member list
 * @param {number} [opts.count] how many members the chat has
 * @param {object} opts.api ws3-fca client
 * @returns {Promise<Buffer|null>}
 */
async function arrivalCard({ kind, uid, name, threadName, threadID, picUrl = '', count = 0, api }) {
  if (!canvasKit.available()) return null;
  if (!uid) return null;

  const leaving = kind === 'goodbye';

  try {
    const cv = canvasKit.create(ARRIVAL_W, ARRIVAL_H);
    const ctx = cv.ctx;

    // House gradient, then the dark overlay. Two passes rather than one: the
    // gradient is the brand and the overlay is what makes white type readable
    // on top of a bright profile photo.
    const grad = ctx.createLinearGradient(0, 0, ARRIVAL_W, ARRIVAL_H);
    grad.addColorStop(0, '#0f0f1a');
    grad.addColorStop(1, '#1a1030');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, ARRIVAL_W, ARRIVAL_H);
    ctx.fillStyle = 'rgba(6,6,14,0.46)';
    ctx.fillRect(0, 0, ARRIVAL_W, ARRIVAL_H);

    // A band of brand colour behind the headline, so the words are not floating
    // in a photo-less middle.
    ctx.fillStyle = 'rgba(0,212,255,0.10)';
    roundRect(ctx, 60, 56, ARRIVAL_W - 120, 104, 28);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillStyle = '#7fe6ff';
    ctx.fillText(
      leaving ? '🚪  GOODBYE' : '👋  WELCOME',
      ARRIVAL_W / 2,
      108,
    );

    // The face. `thumbSrc` off the thread member list is the fastest source and
    // the only one already in hand; getUserInfo's own picture URL is the
    // fallback for a member who had not appeared in that list yet.
    const id = String(uid);
    const buf = picUrl
      ? await thumbBuffer(picUrl)
      : await profile.picture(id, api);
    await drawAvatar(ctx, buf || await profile.fallbackAvatar(id, 256), ARRIVAL_W / 2, 312, 212);

    // The name, from the same lookup the caption uses, so the two cannot
    // disagree — a card saying WELCOME while the body says something else is
    // worse than no card.
    const liveName = await profile.fetchRealName(id, api);
    const shown = liveName
      || (name && !profile.isPlaceholderName(name) ? String(name) : '')
      || `Hunter ${id.slice(-4)}`;

    // "WELCOME Ada Lovelace" — the two words the chat is about, as one line.
    ctx.font = 'bold 46px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(
      fit(ctx, `${leaving ? 'GOODBYE' : 'WELCOME'} ${shown}`, ARRIVAL_W - 160),
      ARRIVAL_W / 2,
      478,
    );

    ctx.font = '26px sans-serif';
    ctx.fillStyle = leaving ? '#ffb4c8' : '#9fe8c8';
    ctx.fillText(
      leaving
        ? '😢 We will miss you'
        : fit(ctx, `${threadName || `Thread ${threadID == null ? '' : threadID}`} | Member #${Number(count) || '—'}`, ARRIVAL_W - 160),
      ARRIVAL_W / 2,
      526,
    );

    return await canvasKit.toBuffer(cv.canvas);
  } catch (err) {
    error(`[CARD] arrivalCard failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  arrivalCard,
  duoCard,
  userCard,
  boardCard,
  pairCard,
  drawAvatar,
  loadImage,
  thumbBuffer,
  realName,
  fit,
  roundRect,
};
