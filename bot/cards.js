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
const dex = require('./pokemon');
const { error } = require('./helpers');

const W = 800;
const theme = canvasKit.theme;

/**
 * Resolve a per-command design over the shared brand theme. A command passes
 * its own bg/accent/border colours so every card in the bot looks different —
 * the economy commands burn gold, the combat commands burn red, the social
 * commands burn pink, and so on. Missing fields fall back to the brand theme.
 *
 * @param {object} [design] partial theme override
 * @returns {object} resolved colours {bg1,bg2,accent,accent2,border,text,muted}
 */
function cardDesign(design = {}) {
  return {
    bg1: design.bg1 || theme.bg1,
    bg2: design.bg2 || theme.bg2,
    accent: design.accent || theme.accent,
    accent2: design.accent2 || theme.accent2,
    border: design.border || theme.accent,
    text: design.text || theme.text,
    muted: design.muted || theme.muted,
  };
}

const W2 = 800;

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

/** Paint a glassmorphic panel with optional border. */
function glassPanel(ctx, x, y, w, h, r, opts = {}) {
  const { fill = 'rgba(255,255,255,0.04)', stroke = 'rgba(255,255,255,0.08)', glow = null } = opts;
  ctx.save();
  if (glow) {
    ctx.shadowColor = glow;
    ctx.shadowBlur = 16;
  }
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, r);
    ctx.stroke();
  }
}

/** Convert hex to rgba string. */
function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `${r},${g},${b}`;
}

/** Draw corner accent brackets. */
function cornerAccents(ctx, x, y, w, h, size = 16, color = theme.accent) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  const c = size;
  // Top-left.
  ctx.beginPath(); ctx.moveTo(x, y + c); ctx.lineTo(x, y); ctx.lineTo(x + c, y); ctx.stroke();
  // Top-right.
  ctx.beginPath(); ctx.moveTo(x + w - c, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + c); ctx.stroke();
  // Bottom-left.
  ctx.beginPath(); ctx.moveTo(x, y + h - c); ctx.lineTo(x, y + h); ctx.lineTo(x + c, y + h); ctx.stroke();
  // Bottom-right.
  ctx.beginPath(); ctx.moveTo(x + w - c, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - c); ctx.stroke();
  ctx.restore();
}

/** Draw a thin gradient accent bar. */
function accentBar(ctx, x, y, w, color1 = theme.accent, color2 = theme.accent2) {
  const grad = ctx.createLinearGradient(x, 0, x + w, 0);
  grad.addColorStop(0, color1);
  grad.addColorStop(0.5, color2);
  grad.addColorStop(1, color1);
  ctx.fillStyle = grad;
  ctx.shadowColor = color1;
  ctx.shadowBlur = 8;
  roundRect(ctx, x, y, w, 4, 2);
  ctx.fill();
  ctx.shadowBlur = 0;
}

/** Paint the shared dark gradient background with stars. `d` is the resolved
 *  per-command design, falling back to the brand theme. */
function paintBackground(ctx, h, d = theme) {
  const grad = ctx.createLinearGradient(0, 0, W, h);
  grad.addColorStop(0, d.bg1);
  grad.addColorStop(0.4, d.bg2);
  grad.addColorStop(0.7, d.bg1);
  grad.addColorStop(1, '#0d0618');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, h);

  // Radial glow behind the centre for depth.
  const glow = ctx.createRadialGradient(W / 2, h * 0.35, 0, W / 2, h * 0.35, Math.max(W, h) * 0.6);
  glow.addColorStop(0, `rgba(${hexToRgb(d.accent)},0.08)`);
  glow.addColorStop(0.5, `rgba(${hexToRgb(d.accent2)},0.03)`);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, h);

  // Star field with varying brightness.
  for (let i = 0; i < 60; i++) {
    const x = (i * 137 + (i % 7) * 23) % W;
    const y = (i * 89 + (i % 5) * 17) % h;
    const r = (i % 3) + 0.5;
    ctx.fillStyle = `rgba(255,255,255,${0.15 + (i % 5) * 0.08})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // Brighter stars get a subtle glow.
    if (i % 4 === 0) {
      ctx.fillStyle = `rgba(${hexToRgb(d.accent)},0.15)`;
      ctx.beginPath();
      ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Neon grid lines for the cyberpunk feel.
  ctx.strokeStyle = `rgba(${hexToRgb(d.accent)},0.06)`;
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 45) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += 45) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  // Vignette for depth.
  const vig = ctx.createRadialGradient(W / 2, h / 2, h * 0.3, W / 2, h / 2, Math.max(W, h) * 0.75);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.3)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, h);
}

/** Paint a header band with a title and neon glow. `d` is the resolved
 *  per-command design, falling back to the brand theme. */
function paintHeader(ctx, emoji, title, subtitle, d = theme) {
  // Outer neon glow in the command's accent colour.
  ctx.save();
  ctx.shadowColor = d.accent;
  ctx.shadowBlur = 24;
  ctx.fillStyle = `rgba(${hexToRgb(d.accent)},0.08)`;
  roundRect(ctx, 20, 20, W - 40, 116, 24);
  ctx.fill();
  ctx.restore();

  // Glassmorphic header panel tinted to the command's accent.
  const hGrad = ctx.createLinearGradient(24, 24, W - 24, 132);
  hGrad.addColorStop(0, `rgba(${hexToRgb(d.accent)},0.18)`);
  hGrad.addColorStop(0.5, `rgba(${hexToRgb(d.accent2)},0.10)`);
  hGrad.addColorStop(1, `rgba(${hexToRgb(d.accent)},0.06)`);
  ctx.fillStyle = hGrad;
  roundRect(ctx, 24, 24, W - 48, 112, 22);
  ctx.fill();

  // Subtle inner border.
  ctx.strokeStyle = `rgba(255,255,255,0.08)`;
  ctx.lineWidth = 1;
  roundRect(ctx, 24, 24, W - 48, 112, 22);
  ctx.stroke();

  // Top accent line with gradient.
  const accentGrad = ctx.createLinearGradient(24, 0, W - 24, 0);
  accentGrad.addColorStop(0, d.accent);
  accentGrad.addColorStop(0.5, d.accent2);
  accentGrad.addColorStop(1, d.accent);
  ctx.fillStyle = accentGrad;
  ctx.shadowColor = d.accent;
  ctx.shadowBlur = 14;
  roundRect(ctx, 24, 24, W - 48, 5, 2.5);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = d.text;

  const size = 44;
  const emojiWidth = canvasKit.drawEmoji(ctx, emoji, 48, 68, size);
  ctx.font = `bold ${size}px sans-serif`;
  ctx.shadowColor = d.accent;
  ctx.shadowBlur = 10;
  ctx.fillText(String(title), 48 + emojiWidth + 14, 66);
  ctx.shadowBlur = 0;

  if (subtitle) {
    ctx.font = '22px sans-serif';
    const subGrad = ctx.createLinearGradient(48, 0, W - 48, 0);
    subGrad.addColorStop(0, d.accent2);
    subGrad.addColorStop(1, d.accent);
    ctx.fillStyle = subGrad;
    ctx.fillText(subtitle, 48, 108);
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

  // Outer glow ring.
  ctx.save();
  ctx.shadowColor = `rgba(${hexToRgb(theme.accent)},0.6)`;
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.arc(x, y, r + 4, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${hexToRgb(theme.accent)},0.08)`;
  ctx.fill();
  ctx.restore();

  // Clip to circle and draw image.
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

  // Inner ring (bright).
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r - 1, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = `rgba(${hexToRgb(theme.accent)},0.7)`;
  ctx.shadowColor = `rgba(${hexToRgb(theme.accent)},0.4)`;
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.restore();

  // Outer ring (dim).
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r + 3, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = `rgba(${hexToRgb(theme.accent2)},0.3)`;
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
async function duoCard({ title, emoji = '❤️', subtitle = '', threadID, chatName = '', left, right = null, body = '', footer = '', api, design }) {
  if (!canvasKit.available()) return null;
  if (!left) return null;

  const W2 = 800;
  const H = 510;
  const solo = !right;
  const d = cardDesign(design);

  try {
    const cv = canvasKit.create(W2, H);
    const ctx = cv.ctx;

    paintBackground(ctx, H, d);
    paintHeader(ctx, emoji, title, subtitle, d);

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
    ctx.fillStyle = d.text;
    const nameY = 390;
    if (solo) {
      ctx.fillText(fit(ctx, a.name, 460), W2 / 2, nameY);
    } else {
      ctx.fillText(fit(ctx, a.name, 300), xs[0] - 60, nameY);
      ctx.fillText(fit(ctx, b.name, 300), xs[1] + 60, nameY);
    }

    // The heart sits in the clear space between the two, so the direction of
    // the action is unambiguous.
    if (!solo) {
      ctx.font = 'bold 34px sans-serif';
      ctx.fillStyle = d.accent;
      ctx.textAlign = 'center';
      ctx.fillText('❤️', W2 / 2, cy);
    }

    // Glass panel behind the body text.
    if (body) {
      glassPanel(ctx, 40, 408, W2 - 80, 56, 14, { fill: 'rgba(255,255,255,0.04)', stroke: 'rgba(255,255,255,0.06)' });
    }

    // The body often arrives with hard newlines (a coin total, a rank, a pet
    // line). fillText does not honour \n, so it is wrapped by hand into at most
    // two lines — the alternative is a single ellipsised line that throws away
    // the most interesting part of the card.
    if (body) {
      ctx.font = '22px sans-serif';
      ctx.fillStyle = d.muted;
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

    cornerAccents(ctx, 8, 8, W2 - 16, H - 16, 18, d.border);

    // Footer: the disclaimer, and the thread this all belongs to.
    ctx.textAlign = 'left';
    ctx.font = 'bold 19px sans-serif';
    ctx.fillStyle = d.accent2;
    ctx.fillText(fit(ctx, footer || 'NONE OF THIS IS REAL', 560), 48, H - 20);
    // The chat's name, not its id.
    //
    // This corner used to read "chat t_9xKq2mZ". The picture already carries two
    // real faces and two real names; finishing with an internal identifier is the
    // same mistake boardCard made printing a uid under every hunter, and it is
    // the one part of this card a viewer cannot do anything with.
    if (chatName) {
      ctx.textAlign = 'right';
      ctx.font = '17px sans-serif';
      ctx.fillStyle = d.muted;
      ctx.fillText(fit(ctx, `in ${chatName}`, 420), W2 - 48, H - 20);
    }

    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    error(`[CARD] duoCard failed: ${err.message}`);
    return null;
  }
}

/**
 * A single-user card: the ID card for !profile (and anything else that wants
 * a labelled table for one person).
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

/**
 * A wild Pokemon encounter card with official artwork, type and rarity.
 * The generated PNG is used for both the scheduled spawn and its catch reply.
 *
 * @param {object} pokemon from the dex
 * @returns {Promise<Buffer|null>} PNG bytes, or null for the raw-sprite fallback
 */
async function pokemonCard(pokemon) {
  const id = Number(pokemon && pokemon.id);
  if (!Number.isInteger(id) || id < 1 || !canvasKit.available()) return null;

  const height = 560;
  const tier = dex.tier(pokemon);
  const accents = {
    common: '#b9c2d0',
    uncommon: '#5dd39e',
    rare: '#56b0ff',
    epic: '#c083ff',
    legendary: '#ffbd59',
    mythic: '#ff5577',
  };
  const accent = accents[pokemon.rarity] || '#00d4ff';

  try {
    const cv = canvasKit.create(W, height);
    if (!cv) return null;
    const ctx = cv.ctx;
    paintBackground(ctx, height);

    // Thin rarity-coloured frame, with enough contrast to survive Messenger's
    // image compression and the dark background.
    roundRect(ctx, 16, 16, W - 32, height - 32, 26);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.stroke();

    paintHeader(ctx, '🌿', 'WILD ENCOUNTER', 'A Pokemon appeared in this chat');
    accentBar(ctx, 24, 148, W - 48);

    // Keep the official artwork uncropped: the sprite is the point of the card.
    glassPanel(ctx, 32, 154, 340, 330, 24, { fill: 'rgba(255,255,255,0.045)', stroke: 'rgba(255,255,255,0.06)' });
    ctx.beginPath();
    ctx.arc(202, 317, 126, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,77,140,0.09)';
    ctx.fill();

    const imageBytes = await thumbBuffer(dex.sprite(id));
    const art = await loadImage(imageBytes);
    if (!art) return null;
    const maxArt = 286;
    const scale = Math.min(maxArt / art.width, maxArt / art.height);
    const imageWidth = art.width * scale;
    const imageHeight = art.height * scale;
    ctx.drawImage(art, 202 - imageWidth / 2, 317 - imageHeight / 2, imageWidth, imageHeight);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 50px sans-serif';
    ctx.fillStyle = theme.text;
    ctx.fillText(fit(ctx, pokemon.name || 'Unknown Pokemon', 438), 410, 205);

    ctx.font = '24px sans-serif';
    ctx.fillStyle = theme.muted;
    ctx.fillText('#' + String(id).padStart(3, '0') + '  ·  ' + dex.typeLabel(pokemon), 414, 252);

    // Glass panel behind tier badge and catch instructions.
    glassPanel(ctx, 402, 276, 362, 180, 18);

    roundRect(ctx, 414, 286, 238, 56, 16);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.font = 'bold 23px sans-serif';
    ctx.fillStyle = '#0f0f1a';
    const tierWidth = canvasKit.drawEmoji(ctx, tier.symbol, 434, 315, 24);
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(tier.label, 434 + tierWidth + 12, 315);

    ctx.font = 'bold 24px sans-serif';
    ctx.fillStyle = theme.text;
    ctx.fillText('Reply with its name to catch it.', 414, 386);
    ctx.font = '21px sans-serif';
    ctx.fillStyle = theme.muted;
    ctx.fillText('First correct reply wins · disappears after ' + Math.round(dex.DEFAULT_TTL_MS / 60000) + ' min', 414, 426);

    cornerAccents(ctx, 8, 8, W - 16, height - 16, 18, accent);

    ctx.font = '19px sans-serif';
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'right';
    ctx.fillText('iKON-BOT  ·  POKEDEX #' + String(id).padStart(3, '0'), W - 36, height - 38);

    return await canvasKit.toBuffer(cv.canvas);
  } catch (err) {
    error('[CARD] pokemonCard failed: ' + err.message);
    return null;
  }
}

async function userCard({ title, emoji, subtitle, rows, api, user, image, design }) {
  if (!canvasKit.available()) return null;
  try {
    const rowH = 46;
    const h = 172 + Math.max(1, rows.length) * rowH + 56;
    const cv = canvasKit.create(W, h);
    const ctx = cv.ctx;
    const d = cardDesign(design);

    paintBackground(ctx, h, d);

    // Neon glow border in the command's accent colour.
    ctx.save();
    ctx.shadowColor = d.accent;
    ctx.shadowBlur = 12;
    ctx.strokeStyle = d.accent;
    ctx.lineWidth = 2;
    roundRect(ctx, 8, 8, W - 16, h - 16, 28);
    ctx.stroke();
    ctx.restore();

    paintHeader(ctx, emoji, title, subtitle, d);
    accentBar(ctx, 24, 148, W - 48, d.accent, d.accent2);

    // Avatar + name block on the left of the body.
    const pic = image ? await thumbBuffer(image) : await profile.picture(user && user.uid, api);
    await drawAvatar(ctx, pic, 92, 208, 112);

    const name = await realName(user || {}, api);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillStyle = d.text;
    ctx.fillText(fit(ctx, name, W - 260), 172, 208);

    // Glass panel behind the stat rows.
    const panelY = 252;
    const panelH = Math.max(1, rows.length) * rowH + 16;
    glassPanel(ctx, 32, panelY, W - 64, panelH, 16);

    let y = panelY + rowH;
    for (let i = 0; i < rows.length; i++) {
      const [label, value] = rows[i];
      // Subtle separator line between rows.
      if (i > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(48, y - rowH + 8);
        ctx.lineTo(W - 48, y - rowH + 8);
        ctx.stroke();
      }
      ctx.font = '24px sans-serif';
      ctx.fillStyle = d.muted;
      ctx.textAlign = 'left';
      ctx.fillText(label, 48, y);

      ctx.font = 'bold 26px sans-serif';
      ctx.fillStyle = d.text;
      ctx.textAlign = 'right';
      ctx.fillText(fit(ctx, value, W - 300), W - 48, y);
      y += rowH;
    }

    cornerAccents(ctx, 8, 8, W - 16, h - 16, 18, d.border);

    ctx.font = '20px sans-serif';
    ctx.fillStyle = d.muted;
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
 * @param {(row:object, i:number) => string} [opts.detail] the small second line,
 *   for the caller who has a second number worth drawing
 * @param {object} opts.api ws3-fca client
 * @param {number} [opts.limit] how many rows to draw
 * @returns {Promise<string|null>} PNG data URL, or null without the canvas binary
 */
async function boardCard({ title, emoji, subtitle, rows, value, detail, api, limit = 10, wide = false, design }) {
  if (!canvasKit.available()) return null;
  const shown = (rows || []).slice(0, limit);
  if (!shown.length) return null;

  try {
    const rowH = 92;
    const h = 172 + shown.length * rowH + 28;
    const cv = canvasKit.create(W, h);
    const ctx = cv.ctx;
    const d = cardDesign(design);

    paintBackground(ctx, h, d);

    // Neon glow border with the command's accent colour.
    ctx.save();
    ctx.shadowColor = d.accent;
    ctx.shadowBlur = 16;
    ctx.strokeStyle = d.accent;
    ctx.lineWidth = 2;
    roundRect(ctx, 8, 8, W - 16, h - 16, 28);
    ctx.stroke();
    ctx.restore();

    paintHeader(ctx, emoji, title, subtitle, d);
    accentBar(ctx, 24, 148, W - 48, d.accent, d.accent2);

    // Resolve names and pictures together, once, in parallel.
    const [names, pics] = await Promise.all([
      Promise.all(shown.map((r) => realName(r, api))),
      Promise.all(shown.map((r) => profile.picture(r.uid, api))),
    ]);

    const medals = ['🥇', '🥈', '🥉'];
    let y = 172 + rowH / 2;

    // Glass panel behind all rows.
    glassPanel(ctx, 24, 156, W - 48, shown.length * rowH + 8, 18);

    for (let i = 0; i < shown.length; i += 1) {
      const row = shown[i];
      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.035)';
        roundRect(ctx, 32, y - rowH / 2 + 4, W - 64, rowH - 8, 14);
        ctx.fill();
      }

      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const medal = medals[i];
      if (medal) {
        canvasKit.drawEmoji(ctx, medal, 44, y, 30);
      } else {
        ctx.font = 'bold 30px sans-serif';
        ctx.fillStyle = d.accent2;
        ctx.fillText(`${i + 1}.`, 44, y);
      }

      await drawAvatar(ctx, pics[i], 148, y, 60);

      ctx.font = 'bold 27px sans-serif';
      ctx.fillStyle = d.text;
      // A wide row is for a line of prose rather than a number, so the name
      // gives up half its room and the text takes it.
      ctx.fillText(fit(ctx, names[i], wide ? 210 : 380), 194, y - 13);

      ctx.font = '22px sans-serif';
      ctx.fillStyle = d.muted;
      if (wide) {
        // Left-aligned, because a sentence has no right-hand end to align to.
        ctx.textAlign = 'left';
        ctx.fillText(fit(ctx, value(row, i), 460), 414, y - 13);
      } else {
        ctx.textAlign = 'right';
        ctx.fillText(fit(ctx, value(row, i), 300), W - 44, y - 13);
      }

      // The caller's second number, under the value.
      //
      // This line used to read `uid <id>` on every board in the bot. That is the
      // one thing a leaderboard must not put under a person's photo: the row
      // already carries their real name and their real picture, and then the
      // row finished with an internal identifier — which is also why
      // `!gcmembers` and `!gtacartel` were audited for uid leaks while the
      // canvas quietly printed one on all five of these boards.
      const foot = detail ? String(detail(row, i) || '') : '';
      if (foot && !wide) {
        ctx.textAlign = 'right';
        ctx.font = '19px sans-serif';
        ctx.fillStyle = d.accent;
        ctx.fillText(fit(ctx, foot, 300), W - 44, y + 17);
      }

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
async function pairCard({ title, emoji = '💕', subtitle = '', pairs, api, value, limit = 8, design }) {
  if (!canvasKit.available()) return null;
  const shown = (pairs || []).slice(0, limit);
  if (!shown.length) return null;

  try {
    const rowH = 88;
    const h = 172 + shown.length * rowH + 28;
    const cv = canvasKit.create(W, h);
	const ctx = cv.ctx;

	// Romantic dreamy background.
	const bg = ctx.createLinearGradient(0, 0, W, h);
	bg.addColorStop(0, '#ffd6e8'); bg.addColorStop(0.5, '#e8d5f5'); bg.addColorStop(1, '#d4c5f9');
	ctx.fillStyle = bg; ctx.fillRect(0, 0, W, h);
	for (let i = 0; i < 12; i++) {
	  const x = (i * 137) % W, y = (i * 89) % h, r = 30 + (i % 4) * 15;
	  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
	  const colors = ['#ff9ecf', '#c9a7ff', '#ffd6a5', '#b5e8ff'];
	  g.addColorStop(0, colors[i % colors.length] + '44'); g.addColorStop(1, 'transparent');
	  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
	}

	// Romantic glow border.
	ctx.save();
	ctx.shadowColor = '#ff69b4';
    ctx.shadowBlur = 16;
    ctx.strokeStyle = d.accent;
    ctx.lineWidth = 2;
    roundRect(ctx, 8, 8, W - 16, h - 16, 28);
    ctx.stroke();
    ctx.restore();

    paintHeader(ctx, emoji, title, subtitle, d);

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

    // Glass panel behind all rows.
    glassPanel(ctx, 24, 156, W - 48, shown.length * rowH + 8, 18);

    for (let i = 0; i < shown.length; i += 1) {
      const pair = shown[i];
      const r = resolved[i];

      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.035)';
        roundRect(ctx, 32, y - rowH / 2 + 4, W - 64, rowH - 8, 14);
        ctx.fill();
      }

      // Overlapping pair, the left one on top. Awaited in order so the two
      // circles are drawn deterministically rather than interleaved.
      await drawAvatar(ctx, r.pa, 118, y, 62);
      await drawAvatar(ctx, r.pb, 176, y, 62);

      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = 'bold 26px sans-serif';
      ctx.fillStyle = d.accent2;
      ctx.fillText(fit(ctx, `${r.na} 💘 ${r.nb}`, 380), 222, y - 12);

      ctx.font = '21px sans-serif';
      ctx.fillStyle = d.muted;
      ctx.textAlign = 'right';
      ctx.fillText(fit(ctx, value ? value(pair, i) : String(pair.score || 0), 260), W - 44, y - 12);

      y += rowH;
    }

    // Bottom love note corner accents.
    cornerAccents(ctx, 8, 8, W - 16, h - 16, 18, d.border);

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

    // House gradient with star field and neon grid.
    const grad = ctx.createLinearGradient(0, 0, ARRIVAL_W, ARRIVAL_H);
    grad.addColorStop(0, '#0a0a1a');
    grad.addColorStop(0.4, '#12082a');
    grad.addColorStop(0.7, '#1a0a3a');
    grad.addColorStop(1, '#0d0618');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, ARRIVAL_W, ARRIVAL_H);

    // Radial glow for depth.
    const glow = ctx.createRadialGradient(ARRIVAL_W / 2, ARRIVAL_H * 0.4, 0, ARRIVAL_W / 2, ARRIVAL_H * 0.4, ARRIVAL_H * 0.7);
    glow.addColorStop(0, leaving ? 'rgba(255,100,150,0.10)' : 'rgba(0,212,255,0.10)');
    glow.addColorStop(0.5, 'rgba(177,75,255,0.03)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, ARRIVAL_W, ARRIVAL_H);

    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    for (let i = 0; i < 60; i += 1) {
      const x = (i * 137) % ARRIVAL_W;
      const y = (i * 89) % ARRIVAL_H;
      const r = (i % 3) + 1;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (i % 4 === 0) {
        ctx.fillStyle = leaving ? 'rgba(255,100,150,0.15)' : 'rgba(0,212,255,0.15)';
        ctx.beginPath();
        ctx.arc(x, y, r + 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
      }
    }
    ctx.fillStyle = 'rgba(6,6,14,0.46)';
    ctx.fillRect(0, 0, ARRIVAL_W, ARRIVAL_H);

    // Glassmorphic band behind the headline.
    const bandColor = leaving ? 'rgba(255,100,150,0.12)' : 'rgba(0,212,255,0.12)';
    ctx.fillStyle = bandColor;
    roundRect(ctx, 60, 56, ARRIVAL_W - 120, 104, 28);
    ctx.fill();
    ctx.strokeStyle = leaving ? 'rgba(255,100,150,0.2)' : 'rgba(0,212,255,0.2)';
    ctx.lineWidth = 1;
    roundRect(ctx, 60, 56, ARRIVAL_W - 120, 104, 28);
    ctx.stroke();

    // Accent bar.
    const barColor = leaving ? '#ff6496' : '#00d4ff';
    const barGrad = ctx.createLinearGradient(60, 0, ARRIVAL_W - 60, 0);
    barGrad.addColorStop(0, barColor);
    barGrad.addColorStop(0.5, '#b14bff');
    barGrad.addColorStop(1, barColor);
    ctx.fillStyle = barGrad;
    ctx.shadowColor = barColor;
    ctx.shadowBlur = 10;
    roundRect(ctx, 60, 56, ARRIVAL_W - 120, 5, 2.5);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillStyle = leaving ? '#ffb4c8' : '#7fe6ff';
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

    // Glass panel behind the name and subtitle.
    glassPanel(ctx, 80, 430, ARRIVAL_W - 160, 130, 22, {
      fill: 'rgba(255,255,255,0.05)',
      stroke: 'rgba(255,255,255,0.08)',
    });

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

/**
 * The bot dashboard — uptime, memory, command count, chat count.
 *
 * A picture, because a dashboard is a thing you look at: the numbers sit in
 * labelled boxes with a status dot, and the version line is the one thing an
 * operator glances at. Text fallbacks on the caller side when the canvas
 * binary is not built, so a platform without it still gets the numbers.
 *
 * @param {object} opts botName, version, uptime, memory, commands, aliases, chats, pending
 * @returns {Promise<string|null>} a PNG data URL, or null
 */
async function botCard(opts) {
  const o = opts || {};
  try {
    const cv = canvasKit.create(W, 320);
    const ctx = cv.ctx;
    const d = cardDesign(o.design);

    paintBackground(ctx, 320, d);

    // Glassmorphic header band with accent bar.
    glassPanel(ctx, 24, 24, W - 48, 110, 22, { fill: 'rgba(255,255,255,0.06)', stroke: 'rgba(255,255,255,0.08)' });
    accentBar(ctx, 24, 24, W - 48, d.accent, d.accent2);

    ctx.font = 'bold 46px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const botEmoji = canvasKit.drawEmoji(ctx, '🤖', 48, 72, 40);
    ctx.fillText(String(o.botName || 'iKON-BOT'), 48 + botEmoji + 14, 72);
    ctx.font = '24px sans-serif';
    const verGrad = ctx.createLinearGradient(48, 0, 300, 0);
    verGrad.addColorStop(0, '#b14bff');
    verGrad.addColorStop(1, '#00d4ff');
    ctx.fillStyle = verGrad;
    ctx.fillText('v' + (o.version || '2.0.0'), 48, 104);

    // Four stat boxes with glassmorphic styling.
    const stats = [
      { label: 'UPTIME', value: String(o.uptime || '—'), color: '#00d4ff' },
      { label: 'COMMANDS', value: String(o.commands || 0), color: '#b14bff' },
      { label: 'ALIASES', value: String(o.aliases || 0), color: '#00d4ff' },
      { label: 'CHATS', value: String(o.chats || 0), color: '#b14bff' },
    ];
    const boxW = (W - 72) / 4;
    const boxH = 120;
    const boxY = 168;
    stats.forEach((s, i) => {
      const x = 24 + i * (boxW + 8);
      glassPanel(ctx, x, boxY, boxW, boxH, 16, { fill: 'rgba(255,255,255,0.04)', stroke: 'rgba(255,255,255,0.06)' });
      // Top accent bar per box.
      const barGrad = ctx.createLinearGradient(x, 0, x + boxW, 0);
      barGrad.addColorStop(0, s.color);
      barGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = barGrad;
      roundRect(ctx, x, boxY, boxW, 3, 1.5);
      ctx.fill();

      ctx.fillStyle = '#9aa0b5';
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(s.label, x + boxW / 2, boxY + 28);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 30px sans-serif';
      ctx.fillText(String(s.value).slice(0, 12), x + boxW / 2, boxY + 72);
      ctx.textAlign = 'left';
    });

    cornerAccents(ctx, 8, 8, W - 16, 304, 18, d.border);

    // Footer: memory + pending.
    const mem = o.memory || {};
    const rss = Math.round((mem.rss || 0) / 1024 / 1024);
    const heap = Math.round((mem.heapUsed || 0) / 1024 / 1024);
    ctx.font = '20px sans-serif';
    ctx.fillStyle = '#9aa0b5';
    ctx.textAlign = 'left';
    ctx.fillText(`🧠 RSS ${rss}MB · heap ${heap}MB`, 24, 300);
    ctx.textAlign = 'right';
    ctx.fillText(`🔒 Pending ${o.pending || 0}`, W - 24, 300);

    return await canvasKit.toBuffer(cv.canvas);
  } catch (err) {
    error(`[CARD] botCard failed: ${err.message}`);
    return null;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.emoji
 * @param {string} [opts.subtitle]
 * @param {string} opts.body the lines under the header, joined with \n
 * @param {string} [opts.footer]
 * @param {object} [opts.user] the hunter document, for the avatar
 * @param {object} [opts.api] ws3-fca client
 * @param {number} [opts.accent] accent colour, defaults to gold
 * @returns {Promise<string|null>} PNG data URL, or null when canvas is missing
 */
async function textCard({ title, emoji = '', subtitle = '', body = '', footer = '', user, api, accent = theme.gold, design }) {
  if (!canvasKit.available()) return null;
  try {
    const lines = String(body || '').split('\n').filter(Boolean);
    const lineH = 32;
    const h = 240 + Math.max(1, lines.length) * lineH + 76;
    const cv = canvasKit.create(W, h);
    const ctx = cv.ctx;
    const d = cardDesign(design);

    paintBackground(ctx, h, d);
    // Gradient accent bar at top.
    const topBarGrad = ctx.createLinearGradient(0, 0, W, 0);
    topBarGrad.addColorStop(0, d.accent);
    topBarGrad.addColorStop(0.5, d.accent2);
    topBarGrad.addColorStop(1, d.accent);
    ctx.fillStyle = topBarGrad;
    ctx.fillRect(0, 0, W, 8);

    paintHeader(ctx, emoji, title, subtitle, d);
    accentBar(ctx, 24, 148, W - 48, d.accent, d.accent2);

    const pic = user ? await thumbBuffer(await profile.picture(user.uid, api)) : null;
    await drawAvatar(ctx, pic, 92, 208, 112);

    const name = await realName(user || {}, api);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(fit(ctx, name, W - 260), 172, 208);

    // Glass panel behind the body text.
    const bodyPanelY = 252;
    const bodyPanelH = Math.max(1, lines.length) * lineH + 32;
    glassPanel(ctx, 32, bodyPanelY, W - 64, bodyPanelH, 16);

    let y = bodyPanelY + lineH;
    for (const line of lines) {
      ctx.font = 'bold 24px sans-serif';
      ctx.fillStyle = '#e0e0e8';
      ctx.textAlign = 'left';
      const wrapped = wrapText(ctx, line, W - 96);
      for (const wline of wrapped) {
        ctx.fillText(wline, 48, y);
        y += lineH;
      }
    }

    if (footer) {
      ctx.font = 'bold 22px sans-serif';
      const footGrad = ctx.createLinearGradient(48, 0, W - 48, 0);
      footGrad.addColorStop(0, d.accent);
      footGrad.addColorStop(1, d.accent2);
      ctx.fillStyle = footGrad;
      ctx.textAlign = 'left';
      ctx.fillText(fit(ctx, footer, W - 96), 48, h - 36);
    }

    cornerAccents(ctx, 8, 8, W - 16, h - 16, 18, d.border);

    ctx.font = '20px sans-serif';
    ctx.fillStyle = 'rgba(154,160,181,0.75)';
    ctx.textAlign = 'center';
    ctx.fillText('iKON-BOT v2 Ultra', W / 2, h - 12);

    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    error(`[CARD] textCard failed: ${err.message}`);
    return null;
  }
}

/** Wrap a single line of text to fit within maxWidth, returning an array. */
function wrapText(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/);
  const out = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      out.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/**
 * A romantic single-pair card for !ship / !couple / !marry style commands.
 * 800x600, dreamy pastel aesthetic with two avatars and a heart match badge.
 *
 * @param {object} opts
 * @param {string} [opts.leftName]
 * @param {string} [opts.rightName]
 * @param {string} [opts.leftPic] avatar url for left person
 * @param {string} [opts.rightPic] avatar url for right person
 * @param {number} [opts.match] match percentage (default 99)
 * @param {string} [opts.footer]
 * @param {object} opts.api
 * @returns {Promise<string|null>}
 */
async function perfectPairCard(opts) {
  if (!canvasKit.available()) return null;
  const o = opts || {};
  const H = 600;
  const match = o.match != null ? o.match : 99;
  try {
    const cv = canvasKit.create(800, H);
    const ctx = cv.ctx;

    // Pastel gradient background pink -> purple.
    const bg = ctx.createLinearGradient(0, 0, 800, H);
    bg.addColorStop(0, '#ffd6e8'); bg.addColorStop(0.5, '#e8d5f5'); bg.addColorStop(1, '#d4c5f9');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, 800, H);

    // Bokeh lights.
    for (let i = 0; i < 18; i++) {
      const x = (i * 137) % 800, y = (i * 89) % H, r = 40 + (i % 5) * 16;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const colors = ['#ff9ecf', '#c9a7ff', '#ffd6a5', '#b5e8ff'];
      g.addColorStop(0, colors[i % colors.length] + '55'); g.addColorStop(1, 'transparent');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }

    // Floating emojis.
    const emojis = ['🦋', '🌸', '💫', '✨', '💕', '💖', '⭐', '❤️', '🌹'];
    ctx.font = '24px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < 36; i++) {
      ctx.globalAlpha = 0.4 + (i % 5) * 0.12;
      ctx.fillText(emojis[i % emojis.length], (i * 97) % 780 + 10, (i * 61) % 580 + 10);
    }
    ctx.globalAlpha = 1;

    // Header.
    ctx.textAlign = 'center';
    ctx.shadowColor = '#ff4fa3'; ctx.shadowBlur = 18;
    ctx.font = 'italic bold 46px serif';
    ctx.fillStyle = '#ff2d87';
    ctx.fillText('💖 PERFECT PAIR 💖', 400, 70);
    ctx.shadowBlur = 0;
    ctx.font = '22px serif'; ctx.fillStyle = '#fff';
    ctx.fillText('✨', 170, 62); ctx.fillText('✨', 630, 62);
    ctx.fillText('✨', 210, 80); ctx.fillText('✨', 590, 80);

    // Golden divider.
    const dg = ctx.createLinearGradient(140, 100, 660, 100);
    dg.addColorStop(0, 'transparent'); dg.addColorStop(0.3, '#ffd700'); dg.addColorStop(0.5, '#fff3b0'); dg.addColorStop(0.7, '#ffd700'); dg.addColorStop(1, 'transparent');
    ctx.strokeStyle = dg; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(140, 100); ctx.lineTo(660, 100); ctx.stroke();
    ctx.font = '16px serif'; ctx.fillStyle = '#ff4fa3';
    ctx.fillText('♡', 280, 106); ctx.fillText('♡', 520, 106);

    // Avatars.
    const cy = 300, r = 95;
    const leftX = 230, rightX = 570;
    const leftBuf = o.leftPic ? await thumbBuffer(o.leftPic) : null;
    const rightBuf = o.rightPic ? await thumbBuffer(o.rightPic) : null;

    // blue ring left
    ctx.save(); ctx.shadowColor = '#3b82f6'; ctx.shadowBlur = 28;
    ctx.beginPath(); ctx.arc(leftX, cy, r + 6, 0, Math.PI * 2); ctx.lineWidth = 8; ctx.strokeStyle = '#3b82f6'; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.arc(leftX, cy, r, 0, Math.PI * 2); ctx.clip();
    if (leftBuf) { const img = await loadImage(leftBuf); if (img) { const sc = Math.max(190 / img.width, 190 / img.height); ctx.drawImage(img, leftX - img.width * sc / 2, cy - img.height * sc / 2, img.width * sc, img.height * sc); } else { ctx.fillStyle = '#2a2a44'; ctx.fillRect(leftX - r, cy - r, 190, 190); } }
    else { ctx.fillStyle = '#2a2a44'; ctx.fillRect(leftX - r, cy - r, 190, 190); }
    ctx.restore();

    // pink ring right
    ctx.save(); ctx.shadowColor = '#ff69b4'; ctx.shadowBlur = 28;
    ctx.beginPath(); ctx.arc(rightX, cy, r + 6, 0, Math.PI * 2); ctx.lineWidth = 8; ctx.strokeStyle = '#ff69b4'; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.arc(rightX, cy, r, 0, Math.PI * 2); ctx.clip();
    if (rightBuf) { const img = await loadImage(rightBuf); if (img) { const sc = Math.max(190 / img.width, 190 / img.height); ctx.drawImage(img, rightX - img.width * sc / 2, cy - img.height * sc / 2, img.width * sc, img.height * sc); } else { ctx.fillStyle = '#2a2a44'; ctx.fillRect(rightX - r, cy - r, 190, 190); } }
    else { ctx.fillStyle = '#2a2a44'; ctx.fillRect(rightX - r, cy - r, 190, 190); }
    ctx.restore();

    // Center heart.
    const hx = 400, hy = cy;
    const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, 90);
    hg.addColorStop(0, 'rgba(255,60,90,0.6)'); hg.addColorStop(1, 'transparent');
    ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(hx, hy, 90, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.shadowColor = '#ff1744'; ctx.shadowBlur = 30; ctx.fillStyle = '#ff1744';
    ctx.beginPath();
    const s = 1.1;
    ctx.moveTo(hx, hy + 30 * s);
    ctx.bezierCurveTo(hx - 55 * s, hy - 10 * s, hx - 70 * s, hy - 55 * s, hx, hy - 25 * s);
    ctx.bezierCurveTo(hx + 70 * s, hy - 55 * s, hx + 55 * s, hy - 10 * s, hx, hy + 30 * s);
    ctx.fill(); ctx.restore();
    ctx.font = 'bold 20px sans-serif'; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 4;
    ctx.fillText(match + '%', hx, hy - 6);
    ctx.font = 'bold 12px sans-serif'; ctx.fillText('MATCH', hx, hy + 14); ctx.shadowBlur = 0;

    // flying hearts/sparkles.
    ctx.font = '18px serif';
    const flies = [{ x: hx - 110, y: hy - 60, t: '💕' }, { x: hx + 105, y: hy - 55, t: '✨' }, { x: hx - 95, y: hy + 55, t: '💖' }, { x: hx + 100, y: hy + 60, t: '✨' }, { x: hx - 130, y: hy + 10, t: '🌸' }, { x: hx + 125, y: hy + 5, t: '💫' }];
    flies.forEach((f) => ctx.fillText(f.t, f.x, f.y));

    // Names.
    ctx.font = 'bold 26px sans-serif'; ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 6;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('♡ ' + (o.leftName || 'Alex') + ' ♡', leftX, cy + r + 40);
    ctx.fillText('♡ ' + (o.rightName || 'Emma') + ' ♡', rightX, cy + r + 40);
    ctx.shadowBlur = 0;

    // Footer.
    const fy = H - 70;
    const fdg = ctx.createLinearGradient(200, fy - 30, 600, fy - 30);
    fdg.addColorStop(0, 'transparent'); fdg.addColorStop(0.5, '#ffd700'); fdg.addColorStop(1, 'transparent');
    ctx.strokeStyle = fdg; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(200, fy - 30); ctx.lineTo(600, fy - 30); ctx.stroke();
    ctx.font = 'italic 18px serif'; ctx.fillStyle = '#7c3aed';
    ctx.shadowColor = 'rgba(255,255,255,0.6)'; ctx.shadowBlur = 2;
    ctx.fillText(o.footer || 'Made with 💖 by iKON BOT', 400, fy); ctx.shadowBlur = 0;
    ctx.font = '14px serif'; ctx.fillStyle = '#ff4fa3';
    ctx.fillText('• ── ♡ ── •', 400, fy + 22);
    ctx.font = '16px serif'; ctx.fillStyle = '#7c3aed';
    ctx.fillText('🌹 ✨ 💑 ✨ 🌹', 400, fy + 46);

    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    const { error } = require('./helpers');
    error(`[CARD] perfectPairCard failed: ${err.message}`);
    return null;
  }
}

/**
 * Funny slap battle card for the !slap command. 800x500, cartoon/anime style.
 */
async function slapCard(opts) {
  if (!canvasKit.available()) return null;
  const o = opts || {};
  const W = 800, H = 500;
  try {
    const cv = canvasKit.create(W, H);
    const ctx = cv.ctx;

    // Bright yellow->orange gradient.
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#ffe066'); bg.addColorStop(0.5, '#ffc04d'); bg.addColorStop(1, '#ff9a3c');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    // Comic halftone dots.
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    for (let y = 0; y < H; y += 14) {
      for (let x = (y/14)%2*7; x < W; x += 14) {
        ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI*2); ctx.fill();
      }
    }


    // Header.
    ctx.textAlign='center';
    ctx.shadowColor='#ff2d00'; ctx.shadowBlur=16;
	ctx.font='bold 44px sans-serif'; ctx.fillStyle='#fff';
	ctx.fillText('SLAP BATTLE!', W/2, 58);
	ctx.shadowBlur=0;

    // Golden divider.
    const dg = ctx.createLinearGradient(140, 88, 660, 88);
    dg.addColorStop(0,'transparent'); dg.addColorStop(0.3,'#ffd700'); dg.addColorStop(0.5,'#fff3b0'); dg.addColorStop(0.7,'#ffd700'); dg.addColorStop(1,'transparent');
    ctx.strokeStyle=dg; ctx.lineWidth=3;
    ctx.beginPath(); ctx.moveTo(140,88); ctx.lineTo(660,88); ctx.stroke();
    ctx.font='16px serif'; ctx.fillStyle='#ff2d00'; ctx.fillText('• ──  ── •', W/2, 100);

    // Avatars.
    const cy=260, r=80, leftX=200, rightX=600;
    const leftBuf = o.leftPic ? await thumbBuffer(o.leftPic) : null;
    const rightBuf = o.rightPic ? await thumbBuffer(o.rightPic) : null;

    // Left shocked avatar (red ring).
    ctx.save(); ctx.shadowColor='#ff3b30'; ctx.shadowBlur=24;
    ctx.beginPath(); ctx.arc(leftX,cy,r+6,0,Math.PI*2); ctx.lineWidth=8; ctx.strokeStyle='#ff3b30'; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.arc(leftX,cy,r,0,Math.PI*2); ctx.clip();
    if (leftBuf){ const img=await loadImage(leftBuf); if(img){ const sc=Math.max(160/img.width,160/img.height); ctx.drawImage(img,leftX-img.width*sc/2,cy-img.height*sc/2,img.width*sc,img.height*sc);} else { ctx.fillStyle='#2a2a44'; ctx.fillRect(leftX-r,cy-r,160,160);} }
    else { ctx.fillStyle='#2a2a44'; ctx.fillRect(leftX-r,cy-r,160,160);} 
    ctx.restore();

    // Right slapper (blue ring).
    ctx.save(); ctx.shadowColor='#007aff'; ctx.shadowBlur=24;
    ctx.beginPath(); ctx.arc(rightX,cy,r+6,0,Math.PI*2); ctx.lineWidth=8; ctx.strokeStyle='#007aff'; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.arc(rightX,cy,r,0,Math.PI*2); ctx.clip();
    if (rightBuf){ const img=await loadImage(rightBuf); if(img){ const sc=Math.max(160/img.width,160/img.height); ctx.drawImage(img,rightX-img.width*sc/2,cy-img.height*sc/2,img.width*sc,img.height*sc);} else { ctx.fillStyle='#2a2a44'; ctx.fillRect(rightX-r,cy-r,160,160);} }
    else { ctx.fillStyle='#2a2a44'; ctx.fillRect(rightX-r,cy-r,160,160);} 
    ctx.restore();

    // Comic POW text.
    ctx.save(); ctx.translate(W/2, cy);
    ctx.font='bold 72px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.lineWidth=8; ctx.strokeStyle='#ff0000'; ctx.fillStyle='#ffff00';
    ctx.strokeText('POW!',0,-10); ctx.fillText('POW!',0,-10);
    ctx.font='bold 36px sans-serif'; ctx.strokeStyle='#ff0000'; ctx.fillStyle='#fff';
    ctx.strokeText('SLAP!',0,40); ctx.fillText('SLAP!',0,40);
    ctx.restore();

    // Motion lines.
    ctx.strokeStyle='rgba(0,0,0,0.35)'; ctx.lineWidth=3;
    for (let i=0;i<6;i++){ ctx.beginPath(); ctx.moveTo(rightX-110, cy-30+i*12); ctx.lineTo(rightX-60, cy-30+i*12); ctx.stroke(); }


    // Names.
    ctx.font='bold 24px sans-serif'; ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='rgba(0,0,0,0.6)'; ctx.shadowBlur=6;
    ctx.fillText('★ ' + (o.leftName || 'Alex') + ' got slapped! ★', leftX, cy+r+36);
    ctx.fillText('★ ' + (o.rightName || 'Emma') + ' ★', rightX, cy+r+36);
    ctx.shadowBlur=0;

    // Footer.
    const fy = H - 50;
    const fdg = ctx.createLinearGradient(120, fy-20, 680, fy-20);
    fdg.addColorStop(0,'transparent'); fdg.addColorStop(0.5,'#ffd700'); fdg.addColorStop(1,'transparent');
    ctx.strokeStyle=fdg; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(120, fy-20); ctx.lineTo(680, fy-20); ctx.stroke();
    ctx.font='italic 16px serif'; ctx.fillStyle='#7c3aed';
    ctx.shadowColor='rgba(255,255,255,0.6)'; ctx.shadowBlur=2;
    ctx.fillText('Made with love by iKON BOT', W/2, fy);
	ctx.shadowBlur=0;

    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    const { error } = require('./helpers');
    error(`[CARD] slapCard failed: ${err.message}`);
    return null;
  }
}

/**
 * Welcome card for !welcome command. 800x500, dreamy anime aesthetic.
 */
async function welcomeCard(opts) {
  if (!canvasKit.available()) return null;
  const o = opts || {};
  const W = 800, H = 500;
  try {
    const cv = canvasKit.create(W, H);
    const ctx = cv.ctx;
    const bg = ctx.createLinearGradient(0,0,W,H);
    bg.addColorStop(0,'#a8d8ff'); bg.addColorStop(0.5,'#c9b8ff'); bg.addColorStop(1,'#ffc4e0');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    // bokeh
    for(let i=0;i<16;i++){const x=(i*131)%W,y=(i*83)%H,r=40+(i%4)*20;const g=ctx.createRadialGradient(x,y,0,x,y,r);const c=['#fff','#ffd6a5','#b5e8ff','#ffc4e0'];g.addColorStop(0,c[i%c.length]+'55');g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
    const emojis=['🌸','💖','⭐','🎈','✨','🎊','👑'];
    ctx.font='26px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    for(let i=0;i<32;i++){ctx.globalAlpha=0.5+(i%5)*0.1;ctx.fillText(emojis[i%emojis.length],(i*97)%780+10,(i*61)%480+10);}ctx.globalAlpha=1;
    // header
    ctx.textAlign='center'; ctx.shadowColor='#ff69b4'; ctx.shadowBlur=16;
    ctx.font='bold 38px sans-serif'; ctx.fillStyle='#fff';
    ctx.fillText('🎉 WELCOME TO THE FAMILY! 🎉', W/2, 52);
    if (o.groupName){ ctx.font='bold 22px sans-serif'; ctx.fillStyle='#fff'; ctx.fillText('('+o.groupName+')', W/2, 84); }
    ctx.shadowBlur=0;
    ctx.font='20px serif'; ctx.fillStyle='#fff';
    ctx.fillText('🎊', W/2-230, 50); ctx.fillText('✨', W/2+230, 50); ctx.fillText('👑', W/2, 20);
    const dg=ctx.createLinearGradient(140,108,660,108);
    dg.addColorStop(0,'transparent');dg.addColorStop(0.3,'#ffd700');dg.addColorStop(0.5,'#fff3b0');dg.addColorStop(0.7,'#ffd700');dg.addColorStop(1,'transparent');
    ctx.strokeStyle=dg; ctx.lineWidth=3; ctx.beginPath();ctx.moveTo(140,108);ctx.lineTo(660,108);ctx.stroke();
    ctx.font='16px serif'; ctx.fillStyle='#ff69b4'; ctx.fillText('• ── 🌸 ── •', W/2, 120);
    // avatar center
    const cx=W/2, cy=270, r=95;
    // rays
    ctx.save(); ctx.translate(cx,cy);
    for(let i=0;i<12;i++){const a=i*Math.PI/6;ctx.rotate(a);ctx.fillStyle='rgba(255,255,255,0.18)';ctx.fillRect(-4,-160,8,120);ctx.rotate(-a);}ctx.restore();
    // golden ring
    ctx.save(); ctx.shadowColor='#ffd700'; ctx.shadowBlur=30;
    ctx.beginPath(); ctx.arc(cx,cy,r+6,0,Math.PI*2); ctx.lineWidth=8; ctx.strokeStyle='#ffd700'; ctx.stroke(); ctx.restore();
    // crown
    ctx.font='46px serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('👑', cx, cy-r-30);
    ctx.save(); ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.clip();
    const buf = o.pic ? await thumbBuffer(o.pic) : null;
    if(buf){const img=await loadImage(buf); if(img){const sc=Math.max(190/img.width,190/img.height);ctx.drawImage(img,cx-img.width*sc/2,cy-img.height*sc/2,img.width*sc,img.height*sc);}else{ctx.fillStyle='#2a2a44';ctx.fillRect(cx-r,cy-r,190,190);}}
    else {ctx.fillStyle='#2a2a44';ctx.fillRect(cx-r,cy-r,190,190);}
    ctx.restore();
    ctx.font='20px serif'; ctx.fillStyle='#fff'; ctx.fillText('New Member!', cx, cy+r+20);
    // names
    ctx.font='bold 28px sans-serif'; ctx.fillStyle='#fff'; ctx.shadowColor='rgba(0,0,0,0.5)'; ctx.shadowBlur=6;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('Welcome, '+(o.name||'Alex')+'! ♡', cx, cy+r+52);
    ctx.font='18px sans-serif'; ctx.shadowBlur=0;
    ctx.fillText('You are our '+(o.memberCount||'1,250')+'th member 🥳', cx, cy+r+80);
    // footer
    const fy=H-50;
    const fdg=ctx.createLinearGradient(120,fy-20,680,fy-20);
    fdg.addColorStop(0,'transparent');fdg.addColorStop(0.5,'#ffd700');fdg.addColorStop(1,'transparent');
    ctx.strokeStyle=fdg; ctx.lineWidth=2; ctx.beginPath();ctx.moveTo(120,fy-20);ctx.lineTo(680,fy-20);ctx.stroke();
    ctx.font='italic 15px serif'; ctx.fillStyle='#7c3aed';
    ctx.shadowColor='rgba(255,255,255,0.6)'; ctx.shadowBlur=2;
    ctx.fillText('• ── 💖 Made with 🌸 by iKON BOT • Enjoy Your Stay! 🌸 ── •', W/2, fy); ctx.shadowBlur=0;
    ctx.font='16px serif'; ctx.fillStyle='#ff69b4';
    ctx.fillText('Welcome to '+(o.groupName||'[Group Name]')+' 🌸', W/2, fy+20);
    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    const { error } = require('./helpers');
    error(`[CARD] welcomeCard failed: ${err.message}`);
    return null;
  }
}

/**
 * Goodbye/leave card. 800x500, emotional aesthetic.
 */
async function goodbyeCard(opts) {
  if (!canvasKit.available()) return null;
  const o = opts || {};
  const W = 800, H = 500;
  try {
    const cv = canvasKit.create(W, H);
    const ctx = cv.ctx;
    const bg = ctx.createLinearGradient(0,0,W,H);
    bg.addColorStop(0,'#1e2a4a'); bg.addColorStop(0.5,'#3a2f5c'); bg.addColorStop(1,'#5a4a6a');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    // bokeh dim
    for(let i=0;i<14;i++){const x=(i*149)%W,y=(i*97)%H,r=35+(i%4)*18;const g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,'rgba(200,200,255,0.18)');g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
    // rain drops
    ctx.strokeStyle='rgba(200,220,255,0.35)'; ctx.lineWidth=1.5;
    for(let i=0;i<40;i++){const x=(i*47)%W,y=(i*31)%H;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+2,y+12);ctx.stroke();}
    const emojis=['😢','💔','🥀','☁️','🕊️','💫'];
    ctx.font='24px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    for(let i=0;i<26;i++){ctx.globalAlpha=0.45+(i%4)*0.1;ctx.fillText(emojis[i%emojis.length],(i*103)%780+10,(i*67)%480+10);}ctx.globalAlpha=1;
    // sunset glow behind avatar
    const sg=ctx.createRadialGradient(W/2,260,0,W/2,260,200);sg.addColorStop(0,'rgba(255,150,120,0.35)');sg.addColorStop(1,'transparent');ctx.fillStyle=sg;ctx.beginPath();ctx.arc(W/2,260,200,0,Math.PI*2);ctx.fill();
    // header
    ctx.textAlign='center'; ctx.shadowColor='rgba(255,255,255,0.5)'; ctx.shadowBlur=12;
    ctx.font='bold 34px sans-serif'; ctx.fillStyle='#f0f0ff';
    ctx.fillText('😢 GOODBYE, WE WILL MISS YOU! 😢', W/2, 52);
    ctx.shadowBlur=0;
    ctx.font='20px serif'; ctx.fillStyle='#f0f0ff';
    ctx.fillText('💔', W/2-210, 50); ctx.fillText('☁️', W/2+210, 50);
    const dg=ctx.createLinearGradient(140,88,660,88);
    dg.addColorStop(0,'transparent');dg.addColorStop(0.3,'#a0a0c0');dg.addColorStop(0.5,'#d0d0e8');dg.addColorStop(0.7,'#a0a0c0');dg.addColorStop(1,'transparent');
    ctx.strokeStyle=dg; ctx.lineWidth=3; ctx.beginPath();ctx.moveTo(140,88);ctx.lineTo(660,88);ctx.stroke();
    ctx.font='16px serif'; ctx.fillStyle='#c8c8e8'; ctx.fillText('• ── 🕊️ ── •', W/2, 100);
    // avatar
    const cx=W/2, cy=270, r=90;
    ctx.save(); ctx.shadowColor='#a0a0c0'; ctx.shadowBlur=24;
    ctx.beginPath(); ctx.arc(cx,cy,r+6,0,Math.PI*2); ctx.lineWidth=8; ctx.strokeStyle='rgba(180,180,220,0.6)'; ctx.stroke(); ctx.restore();
    // angel wings
    ctx.font='44px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('👼', cx-r-30, cy); ctx.fillText('👼', cx+r+30, cy);
    ctx.save(); ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.clip();
    const buf = o.pic ? await thumbBuffer(o.pic) : null;
    if(buf){const img=await loadImage(buf); if(img){const sc=Math.max(180/img.width,180/img.height);ctx.globalAlpha=0.85;ctx.drawImage(img,cx-img.width*sc/2,cy-img.height*sc/2,img.width*sc,img.height*sc);ctx.globalAlpha=1;}else{ctx.fillStyle='#2a2a44';ctx.fillRect(cx-r,cy-r,180,180);}}
    else {ctx.fillStyle='#2a2a44';ctx.fillRect(cx-r,cy-r,180,180);}
    ctx.restore();
    // names
    ctx.font='bold 26px sans-serif'; ctx.fillStyle='#f0f0ff'; ctx.shadowColor='rgba(0,0,0,0.5)'; ctx.shadowBlur=6;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('Goodbye, '+(o.name||'Alex')+' ♡', cx, cy+r+36);
    ctx.font='18px sans-serif'; ctx.shadowBlur=0;
    ctx.fillText('Hope to see you again soon! 💫', cx, cy+r+64);
    // footer
    const fy=H-50;
    const fdg=ctx.createLinearGradient(120,fy-20,680,fy-20);
    fdg.addColorStop(0,'transparent');fdg.addColorStop(0.5,'#a0a0c0');fdg.addColorStop(1,'transparent');
    ctx.strokeStyle=fdg; ctx.lineWidth=2; ctx.beginPath();ctx.moveTo(120,fy-20);ctx.lineTo(680,fy-20);ctx.stroke();
    ctx.font='italic 15px serif'; ctx.fillStyle='#d0d0e8';
    ctx.shadowColor='rgba(0,0,0,0.6)'; ctx.shadowBlur=2;
    ctx.fillText('• ── 🥀 Made with 💔 by iKON BOT • Good Luck! 🕊️ ── •', W/2, fy); ctx.shadowBlur=0;
    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    const { error } = require('./helpers');
    error(`[CARD] goodbyeCard failed: ${err.message}`);
    return null;
  }
}

/**
 * Premium profile card. 800x550, modern gaming aesthetic.
 */
async function profileCard(opts) {
  if (!canvasKit.available()) return null;
  const o = opts || {};
  const W = 800, H = 550;
  try {
    const cv = canvasKit.create(W, H);
    const ctx = cv.ctx;
    const bg = ctx.createLinearGradient(0,0,W,H);
    bg.addColorStop(0,'#0a0f2e'); bg.addColorStop(0.5,'#1a1040'); bg.addColorStop(1,'#2d1050');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    // particles
    for(let i=0;i<24;i++){const x=(i*137)%W,y=(i*89)%H,r=2+(i%3);const g=ctx.createRadialGradient(x,y,0,x,y,r*4);g.addColorStop(0,'rgba(180,150,255,0.6)');g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r*4,0,Math.PI*2);ctx.fill();}
    const emojis=['💎','✨','🔥','⭐','👑'];
    ctx.font='24px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    for(let i=0;i<22;i++){ctx.globalAlpha=0.4+(i%4)*0.12;ctx.fillText(emojis[i%emojis.length],(i*113)%780+10,(i*71)%530+10);}ctx.globalAlpha=1;
    // header
    ctx.textAlign='center'; ctx.shadowColor='#c084fc'; ctx.shadowBlur=18;
    ctx.font='bold 40px sans-serif'; ctx.fillStyle='#fff';
    ctx.fillText('👤 USER PROFILE 👤', W/2, 52);
    ctx.shadowBlur=0;
    ctx.font='20px serif'; ctx.fillStyle='#fff';
    ctx.fillText('✨', W/2-200, 48); ctx.fillText('💎', W/2+200, 48);
    const dg=ctx.createLinearGradient(140,88,660,88);
    dg.addColorStop(0,'transparent');dg.addColorStop(0.3,'#c084fc');dg.addColorStop(0.5,'#ffd700');dg.addColorStop(0.7,'#c084fc');dg.addColorStop(1,'transparent');
    ctx.strokeStyle=dg; ctx.lineWidth=3; ctx.beginPath();ctx.moveTo(140,88);ctx.lineTo(660,88);ctx.stroke();
    ctx.font='16px serif'; ctx.fillStyle='#c084fc'; ctx.fillText('• ── 💎 ── •', W/2, 100);
    // avatar left
    const ax=200, ay=290, r=95;
    // double ring
    ctx.save(); ctx.shadowColor='#c084fc'; ctx.shadowBlur=26;
    ctx.beginPath(); ctx.arc(ax,ay,r+10,0,Math.PI*2); ctx.lineWidth=6; ctx.strokeStyle='#c084fc'; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.shadowColor='#ffd700'; ctx.shadowBlur=18;
    ctx.beginPath(); ctx.arc(ax,ay,r+2,0,Math.PI*2); ctx.lineWidth=4; ctx.strokeStyle='#ffd700'; ctx.stroke(); ctx.restore();
    // crown
    ctx.font='40px serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('👑', ax, ay-r-26);
    // avatar
    ctx.save(); ctx.beginPath(); ctx.arc(ax,ay,r,0,Math.PI*2); ctx.clip();
    const buf = o.pic ? await thumbBuffer(o.pic) : null;
    if(buf){const img=await loadImage(buf); if(img){const sc=Math.max(190/img.width,190/img.height);ctx.drawImage(img,ax-img.width*sc/2,ay-img.height*sc/2,img.width*sc,img.height*sc);}else{ctx.fillStyle='#2a2a44';ctx.fillRect(ax-r,ay-r,190,190);}}
    else {ctx.fillStyle='#2a2a44';ctx.fillRect(ax-r,ay-r,190,190);}
    ctx.restore();
    // status dot
    ctx.fillStyle='#00e676'; ctx.beginPath(); ctx.arc(ax+r-10, ay+r-10, 10,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#fff'; ctx.lineWidth=3; ctx.stroke();
    // level badge
    ctx.save(); ctx.shadowColor='#ffd700'; ctx.shadowBlur=14;
    ctx.beginPath(); ctx.arc(ax+r-8, ay+r+8, 26,0,Math.PI*2); ctx.fillStyle='#ffd700'; ctx.fill(); ctx.restore();
    ctx.font='bold 14px sans-serif'; ctx.fillStyle='#1a1040'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('LVL '+(o.level||25), ax+r-8, ay+r+8);
    // info box glassmorphism
    const bx=330, by=130, bw=440, bh=360;
    ctx.save();
    ctx.fillStyle='rgba(255,255,255,0.08)';
    // rounded rect
    const rad=20;
    ctx.beginPath(); ctx.moveTo(bx+rad,by); ctx.lineTo(bx+bw-rad,by); ctx.quadraticCurveTo(bx+bw,by,bx+bw,by+rad); ctx.lineTo(bx+bw,by+bh-rad); ctx.quadraticCurveTo(bx+bw,by+bh,bx+bw-rad,by+bh); ctx.lineTo(bx+rad,by+bh); ctx.quadraticCurveTo(bx,by+bh,bx,by+bh-rad); ctx.lineTo(bx,by+rad); ctx.quadraticCurveTo(bx,by,bx+rad,by); ctx.closePath();
    ctx.fill();
    ctx.strokeStyle='rgba(192,132,252,0.5)'; ctx.lineWidth=2; ctx.stroke();
    ctx.restore();
    // info text
    const lines = [
      '♡ Name: '+(o.name||'Alex Carter')+' ♡',
      '🆔 UID: '+(o.uid||'100012345678'),
      '💰 Balance: '+(o.balance||'12,500')+' coins',
      '⭐ Level: '+(o.level||25)+' • EXP: '+(o.exp||'2,340'),
      '💬 Messages: '+(o.messages||'1,890'),
      '🎖️ Rank: '+(o.rank||'Legend 👑'),
      '📅 Joined: '+(o.joined||'12 Jan 2026'),
    ];
    ctx.font='bold 20px sans-serif'; ctx.fillStyle='#fff'; ctx.textAlign='left'; ctx.textBaseline='middle';
    ctx.shadowColor='rgba(0,0,0,0.4)'; ctx.shadowBlur=4;
    let y=by+30;
    for (const l of lines){ ctx.fillText(l, bx+24, y); y+=44; }
    ctx.shadowBlur=0;
    // footer
    const fy=H-40;
    const fdg=ctx.createLinearGradient(120,fy-16,680,fy-16);
    fdg.addColorStop(0,'transparent');fdg.addColorStop(0.5,'#c084fc');fdg.addColorStop(1,'transparent');
    ctx.strokeStyle=fdg; ctx.lineWidth=2; ctx.beginPath();ctx.moveTo(120,fy-16);ctx.lineTo(680,fy-16);ctx.stroke();
    ctx.font='italic 15px serif'; ctx.fillStyle='#c084fc'; ctx.textAlign='center';
    ctx.shadowColor='rgba(255,255,255,0.5)'; ctx.shadowBlur=2;
    ctx.fillText('• ── 💖 Made with 👑 by iKON BOT • Your Profile • ── •', W/2, fy); ctx.shadowBlur=0;
    ctx.font='16px serif'; ctx.fillStyle='#ffd700';
    ctx.fillText('🌟 ✨ 💎 ✨ 🌟', W/2, fy+18);
    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    const { error } = require('./helpers');
    error(`[CARD] profileCard failed: ${err.message}`);
    return null;
  }
}

/**
 * Richest users card. 900x600, royal gold aesthetic.
 */
async function richestCard(opts) {
  if (!canvasKit.available()) return null;
  const o = opts || {};
  const W = 900, H = 600;
  try {
    const cv = canvasKit.create(W, H);
    const ctx = cv.ctx;
    const bg = ctx.createLinearGradient(0,0,W,H);
    bg.addColorStop(0,'#0a0800'); bg.addColorStop(0.5,'#1a1400'); bg.addColorStop(1,'#2a1f00');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    // bokeh gold
    for(let i=0;i<18;i++){const x=(i*157)%W,y=(i*101)%H,r=40+(i%5)*18;const g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,'rgba(255,215,0,0.22)');g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
    const emojis=['💰','💎','👑','💸','💵','✨'];
    ctx.font='26px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    for(let i=0;i<30;i++){ctx.globalAlpha=0.45+(i%4)*0.12;ctx.fillText(emojis[i%emojis.length],(i*109)%880+10,(i*73)%580+10);}ctx.globalAlpha=1;
    // falling coins
    ctx.font='18px serif';
    for(let i=0;i<12;i++){ctx.globalAlpha=0.6;ctx.fillText('🪙',(i*73)%880+10,(i*41+ (i*7))%580+10);}ctx.globalAlpha=1;
    // header
    ctx.textAlign='center'; ctx.shadowColor='#ffd700'; ctx.shadowBlur=20;
    ctx.font='bold 42px sans-serif'; ctx.fillStyle='#ffd700';
    ctx.fillText('👑 TOP RICHEST KINGS 👑', W/2, 56);
    ctx.shadowBlur=0;
    ctx.font='22px serif'; ctx.fillStyle='#fff';
    ctx.fillText('💰', W/2-260, 52); ctx.fillText('💎', W/2+260, 52); ctx.fillText('👑', W/2, 22);
    const dg=ctx.createLinearGradient(140,92,760,92);
    dg.addColorStop(0,'transparent');dg.addColorStop(0.3,'#ffd700');dg.addColorStop(0.5,'#fff3b0');dg.addColorStop(0.7,'#ffd700');dg.addColorStop(1,'transparent');
    ctx.strokeStyle=dg; ctx.lineWidth=3; ctx.beginPath();ctx.moveTo(140,92);ctx.lineTo(760,92);ctx.stroke();
    ctx.font='16px serif'; ctx.fillStyle='#ffd700'; ctx.fillText('• ── 💰 ── •', W/2, 104);
    const rows = (o.rows && o.rows.length) ? o.rows : [
      {rank:1,name:'Alex',bal:'1,250,000',emoji:'🥇'},
      {rank:2,name:'Emma',bal:'980,000',emoji:'🥈'},
      {rank:3,name:'John',bal:'750,000',emoji:'🥉'},
      {rank:4,name:'Sarah',bal:'620,000',emoji:'4'},
      {rank:5,name:'Mike',bal:'510,000',emoji:'5'},
    ];
    // podium top 3
    const podiumY=230;
    const positions=[{x:W/2-260,y:podiumY+30,r:70,ring:'#c0c0c0'},{x:W/2,y:podiumY,r:95,ring:'#ffd700'},{x:W/2+260,y:podiumY+30,r:70,ring:'#cd7f32'}];
    for (const idx of [1,0,2]) {
      const p=positions[idx]; const u=rows[idx];
      if(!u) return;
      ctx.save(); ctx.shadowColor=p.ring; ctx.shadowBlur=28;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r+6,0,Math.PI*2); ctx.lineWidth=7; ctx.strokeStyle=p.ring; ctx.stroke(); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.clip();
      const buf = u.pic ? await thumbBuffer(u.pic) : null;
      if(buf){const img=await loadImage(buf); if(img){const sc=Math.max(p.r*2/img.width,p.r*2/img.height);ctx.drawImage(img,p.x-img.width*sc/2,p.y-img.height*sc/2,img.width*sc,img.height*sc);}else{ctx.fillStyle='#2a2a1a';ctx.fillRect(p.x-p.r,p.y-p.r,p.r*2,p.r*2);}}
      else {ctx.fillStyle='#2a2a1a';ctx.fillRect(p.x-p.r,p.y-p.r,p.r*2,p.r*2);}
      ctx.restore();
      if(idx===1){ctx.font='40px serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('👑',p.x,p.y-p.r-24);}
      ctx.font='bold 16px sans-serif'; ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.shadowColor='rgba(0,0,0,0.6)'; ctx.shadowBlur=4;
      ctx.fillText(u.emoji+' '+u.name, p.x, p.y+p.r+24);
      ctx.font='bold 14px sans-serif'; ctx.fillStyle=p.ring;
      ctx.fillText(u.bal+' coins', p.x, p.y+p.r+44);
      ctx.shadowBlur=0;
    }
    // list rows
    const listStart=370;
    const show = rows.slice(3, (o.limit||8));
    let y=listStart;
    for (const u of show){
      // glass row
      ctx.fillStyle='rgba(255,255,255,0.07)';
      ctx.beginPath(); const rr=12; ctx.moveTo(80+rr,y); ctx.lineTo(W-80-rr,y); ctx.quadraticCurveTo(W-80,y,W-80,y+rr); ctx.lineTo(W-80,y+44-rr); ctx.quadraticCurveTo(W-80,y+44,W-80-rr,y+44); ctx.lineTo(80+rr,y+44); ctx.quadraticCurveTo(80,y+44,80,y+44-rr); ctx.lineTo(80,y+rr); ctx.quadraticCurveTo(80,y,80+rr,y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle='rgba(255,215,0,0.3)'; ctx.lineWidth=1; ctx.stroke();
      ctx.font='bold 20px sans-serif'; ctx.fillStyle='#ffd700'; ctx.textAlign='left'; ctx.textBaseline='middle';
      ctx.fillText(u.emoji+'  '+(u.rank||'')+'.  '+(u.name||''), 100, y+22);
      ctx.textAlign='right'; ctx.fillStyle='#fff';
      ctx.fillText((u.bal||'0')+' coins 💰', W-100, y+22);
      y+=52;
    }
    // footer
    const fy=H-40;
    const fdg=ctx.createLinearGradient(120,fy-16,780,fy-16);
    fdg.addColorStop(0,'transparent');fdg.addColorStop(0.5,'#ffd700');fdg.addColorStop(1,'transparent');
    ctx.strokeStyle=fdg; ctx.lineWidth=2; ctx.beginPath();ctx.moveTo(120,fy-16);ctx.lineTo(780,fy-16);ctx.stroke();
    ctx.font='italic 15px serif'; ctx.fillStyle='#ffd700'; ctx.textAlign='center';
    ctx.shadowColor='rgba(0,0,0,0.6)'; ctx.shadowBlur=2;
    ctx.fillText('• ── 💰 Made with 👑 by iKON BOT • Who is the richest? 💎 ── •', W/2, fy); ctx.shadowBlur=0;
    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    const { error } = require('./helpers');
    error(`[CARD] richestCard failed: ${err.message}`);
    return null;
  }
}

/**
 * Leaderboard card. 900x600, gaming aesthetic.
 */
async function leaderboardCard(opts) {
  if (!canvasKit.available()) return null;
  const o = opts || {};
  const W = 900, H = 600;
  try {
    const cv = canvasKit.create(W, H);
    const ctx = cv.ctx;
    const bg = ctx.createLinearGradient(0,0,W,H);
    bg.addColorStop(0,'#050a1f'); bg.addColorStop(0.5,'#0f1030'); bg.addColorStop(1,'#1a0a3a');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    // neon grid
    ctx.strokeStyle='rgba(0,200,255,0.08)'; ctx.lineWidth=1;
    for(let x=0;x<W;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
    for(let y=0;y<H;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
    // bokeh
    for(let i=0;i<16;i++){const x=(i*163)%W,y=(i*97)%H,r=30+(i%4)*15;const g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,'rgba(0,200,255,0.18)');g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
    const emojis=['🔥','⚡','💫','🏆','✨'];
    ctx.font='24px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    for(let i=0;i<24;i++){ctx.globalAlpha=0.4+(i%4)*0.12;ctx.fillText(emojis[i%emojis.length],(i*127)%880+10,(i*67)%580+10);}ctx.globalAlpha=1;
    // header
    ctx.textAlign='center'; ctx.shadowColor='#00c8ff'; ctx.shadowBlur=20;
    ctx.font='bold 44px sans-serif'; ctx.fillStyle='#00c8ff';
    ctx.fillText('🏆 LEADERBOARD 🏆', W/2, 56);
    ctx.shadowBlur=0;
    ctx.font='22px serif'; ctx.fillStyle='#fff';
    ctx.fillText('🔥', W/2-230, 52); ctx.fillText('⭐', W/2+230, 52);
    const dg=ctx.createLinearGradient(140,92,760,92);
    dg.addColorStop(0,'transparent');dg.addColorStop(0.3,'#00c8ff');dg.addColorStop(0.5,'#fff3b0');dg.addColorStop(0.7,'#00c8ff');dg.addColorStop(1,'transparent');
    ctx.strokeStyle=dg; ctx.lineWidth=3; ctx.beginPath();ctx.moveTo(140,92);ctx.lineTo(760,92);ctx.stroke();
    ctx.font='16px serif'; ctx.fillStyle='#00c8ff'; ctx.fillText('• ── ⚡ ── •', W/2, 104);
    const rows = (o.rows && o.rows.length) ? o.rows : [
      {rank:1,name:'Alex',level:45,xp:15200,max:20000,medal:'🥇'},
      {rank:2,name:'Emma',level:42,xp:13800,max:20000,medal:'🥈'},
      {rank:3,name:'John',level:38,xp:11000,max:20000,medal:'🥉'},
      {rank:4,name:'Sarah',level:35,xp:9800,max:20000,medal:'4'},
      {rank:5,name:'Mike',level:32,xp:8500,max:20000,medal:'5'},
    ];
    let y=130;
    for (const u of rows.slice(0, (o.limit||10))){
      // glass row
      ctx.fillStyle='rgba(255,255,255,0.06)';
      const rr=14;
      ctx.beginPath(); ctx.moveTo(60+rr,y); ctx.lineTo(W-60-rr,y); ctx.quadraticCurveTo(W-60,y,W-60,y+rr); ctx.lineTo(W-60,y+52-rr); ctx.quadraticCurveTo(W-60,y+52,W-60-rr,y+52); ctx.lineTo(60+rr,y+52); ctx.quadraticCurveTo(60,y+52,60,y+52-rr); ctx.lineTo(60,y+rr); ctx.quadraticCurveTo(60,y,60+rr,y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle='rgba(0,200,255,0.35)'; ctx.lineWidth=1.5; ctx.stroke();
      // small avatar
      const ax=100, ay=y+26, ar=18;
      ctx.save(); ctx.beginPath(); ctx.arc(ax,ay,ar,0,Math.PI*2); ctx.clip();
      const buf = u.pic ? await thumbBuffer(u.pic) : null;
      if(buf){const img=await loadImage(buf); if(img){const sc=Math.max(ar*2/img.width,ar*2/img.height);ctx.drawImage(img,ax-img.width*sc/2,ay-img.height*sc/2,img.width*sc,img.height*sc);}else{ctx.fillStyle='#1a1a3a';ctx.fillRect(ax-ar,ay-ar,ar*2,ar*2);}}
      else {ctx.fillStyle='#1a1a3a';ctx.fillRect(ax-ar,ay-ar,ar*2,ar*2);}
      ctx.restore();
      // medal
      ctx.font='bold 22px sans-serif'; ctx.fillStyle='#fff'; ctx.textAlign='left'; ctx.textBaseline='middle';
      ctx.fillText(u.medal||u.rank, 68, y+14);
      // name
      ctx.font='bold 18px sans-serif'; ctx.fillStyle='#fff';
      ctx.fillText(u.name||'User', 130, y+16);
      // level
      ctx.font='14px sans-serif'; ctx.fillStyle='#00c8ff';
      ctx.fillText('LVL '+(u.level||0), 130, y+36);
      // xp text
      ctx.textAlign='right'; ctx.fillStyle='#fff';
      ctx.fillText((u.xp||0).toLocaleString()+' XP', W-70, y+16);
      // xp bar
      const barX=300, barY=y+36, barW=W-370, barH=8;
      ctx.fillStyle='rgba(255,255,255,0.12)'; ctx.fillRect(barX,barY,barW,barH);
      const pct=Math.min(1, (u.xp||0)/(u.max||1));
      const grad=ctx.createLinearGradient(barX,barY,barX+barW*pct,barY);
      grad.addColorStop(0,'#00c8ff'); grad.addColorStop(1,'#ffd700');
      ctx.fillStyle=grad; ctx.fillRect(barX,barY,barW*pct,barH);
      ctx.strokeStyle='rgba(0,200,255,0.4)'; ctx.lineWidth=1; ctx.strokeRect(barX,barY,barW,barH);
      y+=60;
    }
    // footer
    const fy=H-40;
    const fdg=ctx.createLinearGradient(120,fy-16,780,fy-16);
    fdg.addColorStop(0,'transparent');fdg.addColorStop(0.5,'#00c8ff');fdg.addColorStop(1,'transparent');
    ctx.strokeStyle=fdg; ctx.lineWidth=2; ctx.beginPath();ctx.moveTo(120,fy-16);ctx.lineTo(780,fy-16);ctx.stroke();
    ctx.font='italic 15px serif'; ctx.fillStyle='#00c8ff'; ctx.textAlign='center';
    ctx.shadowColor='rgba(0,0,0,0.6)'; ctx.shadowBlur=2;
    ctx.fillText('• ── 🏆 Made with ⚡ by iKON BOT • Keep Grinding! 🔥 ── •', W/2, fy); ctx.shadowBlur=0;
    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    const { error } = require('./helpers');
    error(`[CARD] leaderboardCard failed: ${err.message}`);
    return null;
  }
}

/**
 * Cute kiss card. 800x500, romantic anime style. No emoji in fillText (boxes on Linux).
 */
async function kissCard(opts) {
  if (!canvasKit.available()) return null;
  const o = opts || {};
  const W = 800, H = 500;
  try {
    const cv = canvasKit.create(W, H);
    const ctx = cv.ctx;
    const bg = ctx.createLinearGradient(0,0,W,H);
    bg.addColorStop(0,'#ffc4e0'); bg.addColorStop(0.5,'#ff9ecf'); bg.addColorStop(1,'#c9a7ff');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    // bokeh hearts
    for(let i=0;i<16;i++){const x=(i*131)%W,y=(i*83)%H,r=30+(i%4)*18;const g=ctx.createRadialGradient(x,y,0,x,y,r);const c=['#fff','#ff9ecf','#ffd6a5','#c9a7ff'];g.addColorStop(0,c[i%c.length]+'55');g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
    // floating symbols
    const syms=['•','♡','★',' '];
    ctx.font='24px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    for(let i=0;i<30;i++){ctx.globalAlpha=0.4+(i%5)*0.1;ctx.fillText(syms[i%syms.length],(i*97)%780+10,(i*61)%480+10);}ctx.globalAlpha=1;
    // header
    ctx.textAlign='center'; ctx.shadowColor='#ff2d87'; ctx.shadowBlur=18;
    ctx.font='italic bold 46px serif'; ctx.fillStyle='#ff2d87';
    ctx.fillText('KISS!', W/2, 58);
    ctx.shadowBlur=0;
    ctx.font='22px serif'; ctx.fillStyle='#fff';
    // divider
    const dg=ctx.createLinearGradient(140,88,660,88);
    dg.addColorStop(0,'transparent');dg.addColorStop(0.3,'#ff69b4');dg.addColorStop(0.5,'#fff3b0');dg.addColorStop(0.7,'#ff69b4');dg.addColorStop(1,'transparent');
    ctx.strokeStyle=dg; ctx.lineWidth=3; ctx.beginPath();ctx.moveTo(140,88);ctx.lineTo(660,88);ctx.stroke();
    ctx.font='16px serif'; ctx.fillStyle='#ff2d87'; ctx.fillText('• ──  ── •', W/2, 100);
    // avatars
    const cy=270, r=85, leftX=220, rightX=580;
    const leftBuf = o.leftPic ? await thumbBuffer(o.leftPic) : null;
    const rightBuf = o.rightPic ? await thumbBuffer(o.rightPic) : null;
    for(const [x,buf,color] of [[leftX,leftBuf,'#ff69b4'],[rightX,rightBuf,'#ff69b4']]){
      ctx.save(); ctx.shadowColor=color; ctx.shadowBlur=26;
      ctx.beginPath(); ctx.arc(x,cy,r+6,0,Math.PI*2); ctx.lineWidth=8; ctx.strokeStyle=color; ctx.stroke(); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.arc(x,cy,r,0,Math.PI*2); ctx.clip();
      if(buf){const img=await loadImage(buf); if(img){const sc=Math.max(170/img.width,170/img.height);ctx.drawImage(img,x-img.width*sc/2,cy-img.height*sc/2,img.width*sc,img.height*sc);}else{ctx.fillStyle='#2a2a44';ctx.fillRect(x-r,cy-r,170,170);}}
      else {ctx.fillStyle='#2a2a44';ctx.fillRect(x-r,cy-r,170,170);}
      ctx.restore();
    }
    // center lips/mwah
    const hx=W/2, hy=cy;
    const hg=ctx.createRadialGradient(hx,hy,0,hx,hy,80); hg.addColorStop(0,'rgba(255,60,90,0.5)'); hg.addColorStop(1,'transparent');
    ctx.fillStyle=hg; ctx.beginPath(); ctx.arc(hx,hy,80,0,Math.PI*2); ctx.fill();
    ctx.font='bold 48px sans-serif'; ctx.fillStyle='#ff1744'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='#ff1744'; ctx.shadowBlur=20;
    ctx.fillText('MWAH!', hx, hy);
    ctx.shadowBlur=0;
    ctx.font='24px serif'; ctx.fillStyle='#fff';
    ctx.fillText('♡', hx-90, hy-50); ctx.fillText('♡', hx+90, hy-55); ctx.fillText('♡', hx-70, hy+55); ctx.fillText('♡', hx+75, hy+60);
    // names
    ctx.font='bold 24px sans-serif'; ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='rgba(0,0,0,0.5)'; ctx.shadowBlur=6;
    ctx.fillText(o.leftName||'Alex', leftX, cy+r+34);
    ctx.fillText(o.rightName||'Emma', rightX, cy+r+34);
    ctx.shadowBlur=0;
    ctx.font='bold 20px sans-serif'; ctx.fillStyle='#fff';
    ctx.fillText((o.leftName||'Alex')+' kissed '+(o.rightName||'Emma')+'!', W/2, cy+r+62);
    // footer
    const fy=H-50;
    const fdg=ctx.createLinearGradient(120,fy-20,680,fy-20);
    fdg.addColorStop(0,'transparent');fdg.addColorStop(0.5,'#ff69b4');fdg.addColorStop(1,'transparent');
    ctx.strokeStyle=fdg; ctx.lineWidth=2; ctx.beginPath();ctx.moveTo(120,fy-20);ctx.lineTo(680,fy-20);ctx.stroke();
    ctx.font='italic 16px serif'; ctx.fillStyle='#7c3aed';
    ctx.shadowColor='rgba(255,255,255,0.6)'; ctx.shadowBlur=2;
    ctx.fillText('Made with love by iKON BOT', W/2, fy); ctx.shadowBlur=0;
    ctx.font='16px serif'; ctx.fillStyle='#ff2d87';
    ctx.fillText('• ──  ── •', W/2, fy+20);
    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    const { error } = require('./helpers');
    error(`[CARD] kissCard failed: ${err.message}`);
    return null;
  }
}

/**
 * Warm hug card. 800x500, cozy anime style. No emoji in fillText.
 */
async function hugCard(opts) {
  if (!canvasKit.available()) return null;
  const o = opts || {};
  const W = 800, H = 500;
  try {
    const cv = canvasKit.create(W, H);
    const ctx = cv.ctx;
    const bg = ctx.createLinearGradient(0,0,W,H);
    bg.addColorStop(0,'#ffd9b3'); bg.addColorStop(0.5,'#ffc4d6'); bg.addColorStop(1,'#ffb3a7');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    // bokeh warm
    for(let i=0;i<16;i++){const x=(i*131)%W,y=(i*83)%H,r=30+(i%4)*18;const g=ctx.createRadialGradient(x,y,0,x,y,r);const c=['#fff','#ffd9b3','#ffc4d6','#ffe0a3'];g.addColorStop(0,c[i%c.length]+'55');g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
    // warm rays
    ctx.save(); ctx.translate(W/2,H/2);
    for(let i=0;i<8;i++){const a=i*Math.PI/4;ctx.rotate(a);ctx.fillStyle='rgba(255,220,180,0.12)';ctx.fillRect(-3,-200,6,160);ctx.rotate(-a);}ctx.restore();
    const syms=['•','♡','★'];
    ctx.font='24px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    for(let i=0;i<28;i++){ctx.globalAlpha=0.4+(i%5)*0.1;ctx.fillText(syms[i%syms.length],(i*97)%780+10,(i*61)%480+10);}ctx.globalAlpha=1;
    // header
    ctx.textAlign='center'; ctx.shadowColor='#ff8c42'; ctx.shadowBlur=18;
    ctx.font='italic bold 46px serif'; ctx.fillStyle='#ff6b35';
    ctx.fillText('BIG HUG!', W/2, 58);
    ctx.shadowBlur=0;
    const dg=ctx.createLinearGradient(140,88,660,88);
    dg.addColorStop(0,'transparent');dg.addColorStop(0.3,'#ff8c42');dg.addColorStop(0.5,'#fff3b0');dg.addColorStop(0.7,'#ff8c42');dg.addColorStop(1,'transparent');
    ctx.strokeStyle=dg; ctx.lineWidth=3; ctx.beginPath();ctx.moveTo(140,88);ctx.lineTo(660,88);ctx.stroke();
    ctx.font='16px serif'; ctx.fillStyle='#ff6b35'; ctx.fillText('• ──  ── •', W/2, 100);
    // avatars leaning in
    const cy=270, r=85, leftX=240, rightX=560;
    const leftBuf = o.leftPic ? await thumbBuffer(o.leftPic) : null;
    const rightBuf = o.rightPic ? await thumbBuffer(o.rightPic) : null;
    for(const [x,buf] of [[leftX,leftBuf],[rightX,rightBuf]]){
      ctx.save(); ctx.shadowColor='#ff8c42'; ctx.shadowBlur=26;
      ctx.beginPath(); ctx.arc(x,cy,r+6,0,Math.PI*2); ctx.lineWidth=8; ctx.strokeStyle='#ff8c42'; ctx.stroke(); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.arc(x,cy,r,0,Math.PI*2); ctx.clip();
      if(buf){const img=await loadImage(buf); if(img){const sc=Math.max(170/img.width,170/img.height);ctx.drawImage(img,x-img.width*sc/2,cy-img.height*sc/2,img.width*sc,img.height*sc);}else{ctx.fillStyle='#2a2a44';ctx.fillRect(x-r,cy-r,170,170);}}
      else {ctx.fillStyle='#2a2a44';ctx.fillRect(x-r,cy-r,170,170);}
      ctx.restore();
    }
    // center hug heart
    const hx=W/2, hy=cy;
    const hg=ctx.createRadialGradient(hx,hy,0,hx,hy,90); hg.addColorStop(0,'rgba(255,120,80,0.55)'); hg.addColorStop(1,'transparent');
    ctx.fillStyle=hg; ctx.beginPath(); ctx.arc(hx,hy,90,0,Math.PI*2); ctx.fill();
    ctx.font='bold 44px sans-serif'; ctx.fillStyle='#ff6b35'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='#ff6b35'; ctx.shadowBlur=20;
    ctx.fillText('HUG!', hx, hy);
    ctx.shadowBlur=0;
    ctx.font='28px serif'; ctx.fillStyle='#fff';
    ctx.fillText('♡', hx-95, hy-55); ctx.fillText('♡', hx+95, hy-60); ctx.fillText('♡', hx-75, hy+55); ctx.fillText('♡', hx+80, hy+60);
    // names
    ctx.font='bold 24px sans-serif'; ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='rgba(0,0,0,0.5)'; ctx.shadowBlur=6;
    ctx.fillText(o.leftName||'Alex', leftX, cy+r+34);
    ctx.fillText(o.rightName||'Emma', rightX, cy+r+34);
    ctx.shadowBlur=0;
    ctx.font='bold 20px sans-serif'; ctx.fillStyle='#fff';
    ctx.fillText((o.leftName||'Alex')+' hugged '+(o.rightName||'Emma')+'!', W/2, cy+r+62);
    // footer
    const fy=H-50;
    const fdg=ctx.createLinearGradient(120,fy-20,680,fy-20);
    fdg.addColorStop(0,'transparent');fdg.addColorStop(0.5,'#ff8c42');fdg.addColorStop(1,'transparent');
    ctx.strokeStyle=fdg; ctx.lineWidth=2; ctx.beginPath();ctx.moveTo(120,fy-20);ctx.lineTo(680,fy-20);ctx.stroke();
    ctx.font='italic 16px serif'; ctx.fillStyle='#7c3aed';
    ctx.shadowColor='rgba(255,255,255,0.6)'; ctx.shadowBlur=2;
    ctx.fillText('Made with love by iKON BOT', W/2, fy); ctx.shadowBlur=0;
    ctx.font='16px serif'; ctx.fillStyle='#ff6b35';
    ctx.fillText('• ──  ── •', W/2, fy+20);
    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    const { error } = require('./helpers');
    error(`[CARD] hugCard failed: ${err.message}`);
    return null;
  }
}

/**
 * Funny gaming kill card. 800x500, cartoon game style. No emoji in fillText.
 */
async function killCard(opts) {
  if (!canvasKit.available()) return null;
  const o = opts || {};
  const W = 800, H = 500;
  try {
    const cv = canvasKit.create(W, H);
    const ctx = cv.ctx;
    const bg = ctx.createLinearGradient(0,0,W,H);
    bg.addColorStop(0,'#1a0a2e'); bg.addColorStop(0.5,'#0f0a1f'); bg.addColorStop(1,'#000000');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    // neon grid
    ctx.strokeStyle='rgba(255,0,100,0.12)'; ctx.lineWidth=1;
    for(let x=0;x<W;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
    for(let y=0;y<H;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
    // bokeh
    for(let i=0;i<14;i++){const x=(i*157)%W,y=(i*101)%H,r=30+(i%4)*15;const g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,'rgba(255,0,100,0.22)');g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
    const syms=['•','★','X'];
    ctx.font='24px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    for(let i=0;i<24;i++){ctx.globalAlpha=0.4+(i%4)*0.12;ctx.fillText(syms[i%syms.length],(i*127)%780+10,(i*67)%480+10);}ctx.globalAlpha=1;
    // header
    ctx.textAlign='center'; ctx.shadowColor='#ff0066'; ctx.shadowBlur=20;
    ctx.font='bold 52px sans-serif'; ctx.fillStyle='#fff';
    ctx.fillText('K.O.!', W/2, 56);
    ctx.shadowBlur=0;
    ctx.font='22px serif'; ctx.fillStyle='#fff';
    ctx.fillText('•', W/2-180, 52); ctx.fillText('•', W/2+180, 52);
    const dg=ctx.createLinearGradient(140,92,660,92);
    dg.addColorStop(0,'transparent');dg.addColorStop(0.3,'#ff0066');dg.addColorStop(0.5,'#fff3b0');dg.addColorStop(0.7,'#ff0066');dg.addColorStop(1,'transparent');
    ctx.strokeStyle=dg; ctx.lineWidth=3; ctx.beginPath();ctx.moveTo(140,92);ctx.lineTo(660,92);ctx.stroke();
    ctx.font='16px serif'; ctx.fillStyle='#ff0066'; ctx.fillText('• ──  ── •', W/2, 104);
    // avatars
    const cy=270, r=85, leftX=220, rightX=580;
    const leftBuf = o.leftPic ? await thumbBuffer(o.leftPic) : null;
    const rightBuf = o.rightPic ? await thumbBuffer(o.rightPic) : null;
    // left winner - cool (green ring)
    ctx.save(); ctx.shadowColor='#00ff88'; ctx.shadowBlur=26;
    ctx.beginPath(); ctx.arc(leftX,cy,r+6,0,Math.PI*2); ctx.lineWidth=8; ctx.strokeStyle='#00ff88'; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.arc(leftX,cy,r,0,Math.PI*2); ctx.clip();
    if(leftBuf){const img=await loadImage(leftBuf); if(img){const sc=Math.max(170/img.width,170/img.height);ctx.drawImage(img,leftX-img.width*sc/2,cy-img.height*sc/2,img.width*sc,img.height*sc);}else{ctx.fillStyle='#1a1a2e';ctx.fillRect(leftX-r,cy-r,170,170);}}
    else {ctx.fillStyle='#1a1a2e';ctx.fillRect(leftX-r,cy-r,170,170);}
    ctx.restore();
    // sunglasses overlay
    ctx.fillStyle='rgba(0,0,0,0.7)'; ctx.fillRect(leftX-40,cy-15,80,22);
    ctx.fillStyle='#00ff88'; ctx.font='bold 14px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('COOL', leftX, cy-4);
    // right loser - dizzy (red ring)
    ctx.save(); ctx.shadowColor='#ff0066'; ctx.shadowBlur=26;
    ctx.beginPath(); ctx.arc(rightX,cy,r+6,0,Math.PI*2); ctx.lineWidth=8; ctx.strokeStyle='#ff0066'; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.arc(rightX,cy,r,0,Math.PI*2); ctx.clip();
    if(rightBuf){const img=await loadImage(rightBuf); if(img){const sc=Math.max(170/img.width,170/img.height);ctx.drawImage(img,rightX-img.width*sc/2,cy-img.height*sc/2,img.width*sc,img.height*sc);}else{ctx.fillStyle='#1a1a2e';ctx.fillRect(rightX-r,cy-r,170,170);}}
    else {ctx.fillStyle='#1a1a2e';ctx.fillRect(rightX-r,cy-r,170,170);}
    ctx.restore();
    // dizzy X eyes
    ctx.strokeStyle='#fff'; ctx.lineWidth=4;
    ctx.beginPath(); ctx.moveTo(rightX-25,cy-20); ctx.lineTo(rightX-5,cy); ctx.moveTo(rightX-5,cy-20); ctx.lineTo(rightX-25,cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rightX+5,cy-20); ctx.lineTo(rightX+25,cy); ctx.moveTo(rightX+25,cy-20); ctx.lineTo(rightX+5,cy); ctx.stroke();
    // center comic text
    const hx=W/2, hy=cy;
    const eg=ctx.createRadialGradient(hx,hy,0,hx,hy,100); eg.addColorStop(0,'rgba(255,0,100,0.5)'); eg.addColorStop(1,'transparent');
    ctx.fillStyle=eg; ctx.beginPath(); ctx.arc(hx,hy,100,0,Math.PI*2); ctx.fill();
    ctx.font='bold 52px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.lineWidth=6; ctx.strokeStyle='#ff0000'; ctx.fillStyle='#ffff00';
    ctx.strokeText('BANG!', hx, hy-18); ctx.fillText('BANG!', hx, hy-18);
    ctx.font='bold 34px sans-serif'; ctx.strokeStyle='#ff0000'; ctx.fillStyle='#fff';
    ctx.strokeText('POW!', hx, hy+22); ctx.fillText('POW!', hx, hy+22);
    // motion lines
    ctx.strokeStyle='rgba(255,255,255,0.4)'; ctx.lineWidth=2;
    for(let i=0;i<5;i++){ctx.beginPath();ctx.moveTo(rightX-100, cy-20+i*10);ctx.lineTo(rightX-60,cy-20+i*10);ctx.stroke();}
    // names
    ctx.font='bold 22px sans-serif'; ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='rgba(0,0,0,0.6)'; ctx.shadowBlur=6;
    ctx.fillText((o.leftName||'Alex')+' killed '+(o.rightName||'Emma')+'!', W/2, cy+r+40);
    ctx.shadowBlur=0;
    // footer
    const fy=H-50;
    const fdg=ctx.createLinearGradient(120,fy-20,680,fy-20);
    fdg.addColorStop(0,'transparent');fdg.addColorStop(0.5,'#ff0066');fdg.addColorStop(1,'transparent');
    ctx.strokeStyle=fdg; ctx.lineWidth=2; ctx.beginPath();ctx.moveTo(120,fy-20);ctx.lineTo(680,fy-20);ctx.stroke();
    ctx.font='italic 16px serif'; ctx.fillStyle='#c084fc';
    ctx.shadowColor='rgba(255,255,255,0.6)'; ctx.shadowBlur=2;
    ctx.fillText('Made with love by iKON BOT', W/2, fy); ctx.shadowBlur=0;
    ctx.font='16px serif'; ctx.fillStyle='#ff0066';
    ctx.fillText('• ──  ── •', W/2, fy+20);
    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    const { error } = require('./helpers');
    error(`[CARD] killCard failed: ${err.message}`);
    return null;
  }
}

/**
 * Funny savage roast card. 800x500, comedy roast battle style. No emoji in fillText.
 */
async function roastCard(opts) {
  if (!canvasKit.available()) return null;
  const o = opts || {};
  const W = 800, H = 500;
  try {
    const cv = canvasKit.create(W, H);
    const ctx = cv.ctx;
    const bg = ctx.createLinearGradient(0,0,W,H);
    bg.addColorStop(0,'#ff3300'); bg.addColorStop(0.5,'#cc1100'); bg.addColorStop(1,'#1a0000');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    // fire particles
    for(let i=0;i<20;i++){const x=(i*137)%W,y=(i*89)%H,r=20+(i%5)*12;const g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,'rgba(255,180,0,0.35)');g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
    // smoke
    for(let i=0;i<8;i++){const x=(i*211)%W,y=(i*67)%H,r=40+(i%3)*20;const g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,'rgba(80,80,80,0.25)');g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
    const syms=['•','★','X'];
    ctx.font='24px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    for(let i=0;i<24;i++){ctx.globalAlpha=0.35+(i%4)*0.1;ctx.fillText(syms[i%syms.length],(i*127)%780+10,(i*67)%480+10);}ctx.globalAlpha=1;
    // header
    ctx.textAlign='center'; ctx.shadowColor='#ff0000'; ctx.shadowBlur=20;
    ctx.font='bold 52px sans-serif'; ctx.fillStyle='#fff';
    ctx.fillText('ROASTED!', W/2, 56);
    ctx.shadowBlur=0;
    const dg=ctx.createLinearGradient(140,92,660,92);
    dg.addColorStop(0,'transparent');dg.addColorStop(0.3,'#ff6600');dg.addColorStop(0.5,'#fff3b0');dg.addColorStop(0.7,'#ff6600');dg.addColorStop(1,'transparent');
    ctx.strokeStyle=dg; ctx.lineWidth=3; ctx.beginPath();ctx.moveTo(140,92);ctx.lineTo(660,92);ctx.stroke();
    ctx.font='16px serif'; ctx.fillStyle='#ff6600'; ctx.fillText('• ──  ── •', W/2, 104);
    // avatar center with burning ring
    const cx=W/2, cy=250, r=90;
    ctx.save(); ctx.shadowColor='#ff6600'; ctx.shadowBlur=30;
    ctx.beginPath(); ctx.arc(cx,cy,r+8,0,Math.PI*2); ctx.lineWidth=10; ctx.strokeStyle='#ff6600'; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.clip();
    const buf = o.pic ? await thumbBuffer(o.pic) : null;
    if(buf){const img=await loadImage(buf); if(img){const sc=Math.max(180/img.width,180/img.height);ctx.drawImage(img,cx-img.width*sc/2,cy-img.height*sc/2,img.width*sc,img.height*sc);}else{ctx.fillStyle='#1a1a2e';ctx.fillRect(cx-r,cy-r,180,180);}}
    else {ctx.fillStyle='#1a1a2e';ctx.fillRect(cx-r,cy-r,180,180);}
    ctx.restore();
    // burn toast
    ctx.font='32px serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('!', cx+r-10, cy-r+10);
    // BURN! text
    ctx.font='bold 56px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.lineWidth=6; ctx.strokeStyle='#ff0000'; ctx.fillStyle='#ffff00';
    ctx.strokeText('BURN!', W/2, cy+r+30); ctx.fillText('BURN!', W/2, cy+r+30);
    // roast line
    ctx.font='bold 22px sans-serif'; ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='rgba(0,0,0,0.7)'; ctx.shadowBlur=6;
    const roast = o.roast || 'Bro thinks he is the main character.';
    ctx.fillText(roast, W/2, cy+r+62);
    ctx.shadowBlur=0;
    ctx.font='bold 20px sans-serif'; ctx.fillStyle='#fff';
    ctx.fillText((o.name||'Alex')+' got roasted!', W/2, cy+r+88);
    // footer
    const fy=H-45;
    const fdg=ctx.createLinearGradient(120,fy-16,680,fy-16);
    fdg.addColorStop(0,'transparent');fdg.addColorStop(0.5,'#ff6600');fdg.addColorStop(1,'transparent');
    ctx.strokeStyle=fdg; ctx.lineWidth=2; ctx.beginPath();ctx.moveTo(120,fy-16);ctx.lineTo(680,fy-16);ctx.stroke();
    ctx.font='italic 16px serif'; ctx.fillStyle='#ffcc00';
    ctx.shadowColor='rgba(0,0,0,0.6)'; ctx.shadowBlur=2;
    ctx.fillText('Made with love by iKON BOT', W/2, fy); ctx.shadowBlur=0;
    ctx.font='16px serif'; ctx.fillStyle='#ff6600';
    ctx.fillText('• ──  ── •', W/2, fy+18);
    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    const { error } = require('./helpers');
    error(`[CARD] roastCard failed: ${err.message}`);
    return null;
  }
}

/**
 * Ship / love match card. 800x500, romantic. No emoji in fillText.
 */
async function shipCard(opts) {
  if (!canvasKit.available()) return null;
  const o = opts || {};
  const W = 800, H = 500;
  try {
    const cv = canvasKit.create(W, H);
    const ctx = cv.ctx;
    const bg = ctx.createLinearGradient(0,0,W,H);
    bg.addColorStop(0,'#ffc4e0'); bg.addColorStop(0.5,'#e8d5f5'); bg.addColorStop(1,'#c9a7ff');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    for(let i=0;i<16;i++){const x=(i*131)%W,y=(i*83)%H,r=30+(i%4)*18;const g=ctx.createRadialGradient(x,y,0,x,y,r);const c=['#fff','#ff9ecf','#ffd6a5','#c9a7ff'];g.addColorStop(0,c[i%c.length]+'55');g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
    const syms=['•','♡','★'];
    ctx.font='24px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    for(let i=0;i<30;i++){ctx.globalAlpha=0.4+(i%5)*0.1;ctx.fillText(syms[i%syms.length],(i*97)%780+10,(i*61)%480+10);}ctx.globalAlpha=1;
    // header
    ctx.textAlign='center'; ctx.shadowColor='#ff2d87'; ctx.shadowBlur=18;
    ctx.font='italic bold 46px serif'; ctx.fillStyle='#ff2d87';
    ctx.fillText('SHIP!', W/2, 58);
    ctx.shadowBlur=0;
    const dg=ctx.createLinearGradient(140,88,660,88);
    dg.addColorStop(0,'transparent');dg.addColorStop(0.3,'#ff69b4');dg.addColorStop(0.5,'#fff3b0');dg.addColorStop(0.7,'#ff69b4');dg.addColorStop(1,'transparent');
    ctx.strokeStyle=dg; ctx.lineWidth=3; ctx.beginPath();ctx.moveTo(140,88);ctx.lineTo(660,88);ctx.stroke();
    ctx.font='16px serif'; ctx.fillStyle='#ff2d87'; ctx.fillText('• ──  ── •', W/2, 100);
    // avatars
    const cy=260, r=80, leftX=210, rightX=590;
    const leftBuf = o.leftPic ? await thumbBuffer(o.leftPic) : null;
    const rightBuf = o.rightPic ? await thumbBuffer(o.rightPic) : null;
    for(const [x,buf,color] of [[leftX,leftBuf,'#ff69b4'],[rightX,rightBuf,'#ff69b4']]){
      ctx.save(); ctx.shadowColor=color; ctx.shadowBlur=24;
      ctx.beginPath(); ctx.arc(x,cy,r+6,0,Math.PI*2); ctx.lineWidth=8; ctx.strokeStyle=color; ctx.stroke(); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.arc(x,cy,r,0,Math.PI*2); ctx.clip();
      if(buf){const img=await loadImage(buf); if(img){const sc=Math.max(160/img.width,160/img.height);ctx.drawImage(img,x-img.width*sc/2,cy-img.height*sc/2,img.width*sc,img.height*sc);}else{ctx.fillStyle='#2a2a44';ctx.fillRect(x-r,cy-r,160,160);}}
      else {ctx.fillStyle='#2a2a44';ctx.fillRect(x-r,cy-r,160,160);}
      ctx.restore();
    }
    // center heart with percentage
    const hx=W/2, hy=cy;
    const hg=ctx.createRadialGradient(hx,hy,0,hx,hy,80); hg.addColorStop(0,'rgba(255,60,90,0.55)'); hg.addColorStop(1,'transparent');
    ctx.fillStyle=hg; ctx.beginPath(); ctx.arc(hx,hy,80,0,Math.PI*2); ctx.fill();
    // heart shape
    ctx.save(); ctx.shadowColor='#ff1744'; ctx.shadowBlur=24; ctx.fillStyle='#ff1744';
    ctx.beginPath();
    const s=1.0;
    ctx.moveTo(hx, hy+28*s);
    ctx.bezierCurveTo(hx-50*s, hy-10*s, hx-65*s, hy-50*s, hx, hy-22*s);
    ctx.bezierCurveTo(hx+65*s, hy-50*s, hx+50*s, hy-10*s, hx, hy+28*s);
    ctx.fill(); ctx.restore();
    ctx.font='bold 22px sans-serif'; ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='rgba(0,0,0,0.4)'; ctx.shadowBlur=4;
    ctx.fillText((o.match||95)+'%', hx, hy-4);
    ctx.font='bold 11px sans-serif'; ctx.fillText('MATCH', hx, hy+14); ctx.shadowBlur=0;
    // cupid arrow
    ctx.strokeStyle='#ffd700'; ctx.lineWidth=3;
    ctx.beginPath(); ctx.moveTo(hx-100, hy+10); ctx.lineTo(hx+100, hy-10); ctx.stroke();
    ctx.fillStyle='#ffd700'; ctx.font='18px serif'; ctx.fillText('♡', hx+100, hy-14);
    // floating hearts
    ctx.font='20px serif'; ctx.fillStyle='#fff';
    ctx.fillText('♡', hx-120, hy-60); ctx.fillText('♡', hx+120, hy-65); ctx.fillText('♡', hx-100, hy+60); ctx.fillText('♡', hx+105, hy+65);
    // names
    ctx.font='bold 22px sans-serif'; ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='rgba(0,0,0,0.5)'; ctx.shadowBlur=6;
    ctx.fillText(o.leftName||'Alex', leftX, cy+r+30);
    ctx.fillText(o.rightName||'Emma', rightX, cy+r+30);
    ctx.shadowBlur=0;
    ctx.font='bold 18px sans-serif'; ctx.fillStyle='#fff';
    ctx.fillText((o.leftName||'Alex')+'  '+ (o.rightName||'Emma')+' - Perfect Match!', W/2, cy+r+56);
    // love bar
    const barX=200, barY=cy+r+78, barW=400, barH=10;
    ctx.fillStyle='rgba(255,255,255,0.2)'; ctx.fillRect(barX,barY,barW,barH);
    const pct=Math.min(1,(o.match||95)/100);
    const grad=ctx.createLinearGradient(barX,barY,barX+barW*pct,barY);
    grad.addColorStop(0,'#ff69b4'); grad.addColorStop(1,'#ff1744');
    ctx.fillStyle=grad; ctx.fillRect(barX,barY,barW*pct,barH);
    // footer
    const fy=H-45;
    const fdg=ctx.createLinearGradient(120,fy-16,680,fy-16);
    fdg.addColorStop(0,'transparent');fdg.addColorStop(0.5,'#ff69b4');fdg.addColorStop(1,'transparent');
    ctx.strokeStyle=fdg; ctx.lineWidth=2; ctx.beginPath();ctx.moveTo(120,fy-16);ctx.lineTo(680,fy-16);ctx.stroke();
    ctx.font='italic 16px serif'; ctx.fillStyle='#7c3aed';
    ctx.shadowColor='rgba(255,255,255,0.6)'; ctx.shadowBlur=2;
    ctx.fillText('Made with love by iKON BOT', W/2, fy); ctx.shadowBlur=0;
    ctx.font='16px serif'; ctx.fillStyle='#ff2d87';
    ctx.fillText('• ──  ── •', W/2, fy+18);
    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    const { error } = require('./helpers');
    error(`[CARD] shipCard failed: ${err.message}`);
    return null;
  }
}

/**
 * Wedding marry card. 800x500, luxury wedding style. No emoji in fillText.
 */
async function marryCard(opts) {
  if (!canvasKit.available()) return null;
  const o = opts || {};
  const W = 800, H = 500;
  try {
    const cv = canvasKit.create(W, H);
    const ctx = cv.ctx;
    const bg = ctx.createLinearGradient(0,0,W,H);
    bg.addColorStop(0,'#fffaf0'); bg.addColorStop(0.5,'#ffe4d6'); bg.addColorStop(1,'#ffd6e8');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    for(let i=0;i<16;i++){const x=(i*131)%W,y=(i*83)%H,r=30+(i%4)*18;const g=ctx.createRadialGradient(x,y,0,x,y,r);const c=['#fff','#ffd700','#ffc4e0','#ffe4d6'];g.addColorStop(0,c[i%c.length]+'55');g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
    const syms=['•','♡','★'];
    ctx.font='24px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    for(let i=0;i<28;i++){ctx.globalAlpha=0.4+(i%5)*0.1;ctx.fillText(syms[i%syms.length],(i*97)%780+10,(i*61)%480+10);}ctx.globalAlpha=1;
    // header
    ctx.textAlign='center'; ctx.shadowColor='#ffd700'; ctx.shadowBlur=20;
    ctx.font='italic bold 46px serif'; ctx.fillStyle='#b8860b';
    ctx.fillText('JUST MARRIED!', W/2, 56);
    ctx.shadowBlur=0;
    const dg=ctx.createLinearGradient(140,88,660,88);
    dg.addColorStop(0,'transparent');dg.addColorStop(0.3,'#ffd700');dg.addColorStop(0.5,'#fff3b0');dg.addColorStop(0.7,'#ffd700');dg.addColorStop(1,'transparent');
    ctx.strokeStyle=dg; ctx.lineWidth=3; ctx.beginPath();ctx.moveTo(140,88);ctx.lineTo(660,88);ctx.stroke();
    ctx.font='16px serif'; ctx.fillStyle='#b8860b'; ctx.fillText('• ──  ── •', W/2, 100);
    // avatars
    const cy=260, r=85, leftX=210, rightX=590;
    const leftBuf = o.leftPic ? await thumbBuffer(o.leftPic) : null;
    const rightBuf = o.rightPic ? await thumbBuffer(o.rightPic) : null;
    for(const [x,buf] of [[leftX,leftBuf],[rightX,rightBuf]]){
      ctx.save(); ctx.shadowColor='#ffd700'; ctx.shadowBlur=28;
      ctx.beginPath(); ctx.arc(x,cy,r+6,0,Math.PI*2); ctx.lineWidth=8; ctx.strokeStyle='#ffd700'; ctx.stroke(); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.arc(x,cy,r,0,Math.PI*2); ctx.clip();
      if(buf){const img=await loadImage(buf); if(img){const sc=Math.max(170/img.width,170/img.height);ctx.drawImage(img,x-img.width*sc/2,cy-img.height*sc/2,img.width*sc,img.height*sc);}else{ctx.fillStyle='#f0e6d2';ctx.fillRect(x-r,cy-r,170,170);}}
      else {ctx.fillStyle='#f0e6d2';ctx.fillRect(x-r,cy-r,170,170);}
      ctx.restore();
    }
    // center ring + I DO
    const hx=W/2, hy=cy;
    const hg=ctx.createRadialGradient(hx,hy,0,hx,hy,90); hg.addColorStop(0,'rgba(255,215,0,0.5)'); hg.addColorStop(1,'transparent');
    ctx.fillStyle=hg; ctx.beginPath(); ctx.arc(hx,hy,90,0,Math.PI*2); ctx.fill();
    ctx.font='bold 46px serif'; ctx.fillStyle='#b8860b'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='#ffd700'; ctx.shadowBlur=18;
    ctx.fillText('I DO!', hx, hy);
    ctx.shadowBlur=0;
    ctx.font='36px serif'; ctx.fillStyle='#ffd700';
    ctx.fillText('O', hx-40, hy-50); ctx.fillText('O', hx+40, hy-50);
    // floating hearts
    ctx.font='22px serif'; ctx.fillStyle='#ff69b4';
    ctx.fillText('♡', hx-120, hy-60); ctx.fillText('♡', hx+120, hy-65); ctx.fillText('♡', hx-100, hy+60); ctx.fillText('♡', hx+105, hy+65);
    // names
    ctx.font='bold 24px sans-serif'; ctx.fillStyle='#b8860b'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='rgba(0,0,0,0.3)'; ctx.shadowBlur=4;
    ctx.fillText((o.leftName||'Alex')+'  '+(o.rightName||'Emma'), W/2, cy+r+34);
    ctx.shadowBlur=0;
    ctx.font='bold 18px sans-serif'; ctx.fillStyle='#b8860b';
    ctx.fillText((o.leftName||'Alex')+'  '+(o.rightName||'Emma')+' - Just Married!', W/2, cy+r+58);
    ctx.font='14px sans-serif'; ctx.fillStyle='#7c3aed';
    ctx.fillText(o.date||new Date().toLocaleDateString(), W/2, cy+r+78);
    // footer
    const fy=H-45;
    const fdg=ctx.createLinearGradient(120,fy-16,680,fy-16);
    fdg.addColorStop(0,'transparent');fdg.addColorStop(0.5,'#ffd700');fdg.addColorStop(1,'transparent');
    ctx.strokeStyle=fdg; ctx.lineWidth=2; ctx.beginPath();ctx.moveTo(120,fy-16);ctx.lineTo(680,fy-16);ctx.stroke();
    ctx.font='italic 16px serif'; ctx.fillStyle='#7c3aed';
    ctx.shadowColor='rgba(255,255,255,0.6)'; ctx.shadowBlur=2;
    ctx.fillText('Made with love by iKON BOT', W/2, fy); ctx.shadowBlur=0;
    ctx.font='16px serif'; ctx.fillStyle='#b8860b';
    ctx.fillText('• ──  ── •', W/2, fy+18);
    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    const { error } = require('./helpers');
    error(`[CARD] marryCard failed: ${err.message}`);
    return null;
  }
}

/**
 * Funny sad divorce card. 800x500, breakup style. No emoji in fillText.
 */
async function divorceCard(opts) {
  if (!canvasKit.available()) return null;
  const o = opts || {};
  const W = 800, H = 500;
  try {
    const cv = canvasKit.create(W, H);
    const ctx = cv.ctx;
    const bg = ctx.createLinearGradient(0,0,W,H);
    bg.addColorStop(0,'#4a4a6a'); bg.addColorStop(0.5,'#2a2a4a'); bg.addColorStop(1,'#1a1a3a');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    // rain
    ctx.strokeStyle='rgba(200,220,255,0.3)'; ctx.lineWidth=1.5;
    for(let i=0;i<40;i++){const x=(i*47)%W,y=(i*31)%H;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+2,y+12);ctx.stroke();}
    // bokeh dim
    for(let i=0;i<12;i++){const x=(i*149)%W,y=(i*97)%H,r=35+(i%4)*18;const g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,'rgba(150,150,200,0.18)');g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
    const syms=['•',' '];
    ctx.font='24px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    for(let i=0;i<24;i++){ctx.globalAlpha=0.35+(i%4)*0.1;ctx.fillText(syms[i%syms.length],(i*127)%780+10,(i*67)%480+10);}ctx.globalAlpha=1;
    // header
    ctx.textAlign='center'; ctx.shadowColor='rgba(255,255,255,0.5)'; ctx.shadowBlur=14;
    ctx.font='bold 46px sans-serif'; ctx.fillStyle='#e0e0ff';
    ctx.fillText('DIVORCED!', W/2, 56);
    ctx.shadowBlur=0;
    const dg=ctx.createLinearGradient(140,88,660,88);
    dg.addColorStop(0,'transparent');dg.addColorStop(0.3,'#a0a0c0');dg.addColorStop(0.5,'#d0d0e8');dg.addColorStop(0.7,'#a0a0c0');dg.addColorStop(1,'transparent');
    ctx.strokeStyle=dg; ctx.lineWidth=3; ctx.beginPath();ctx.moveTo(140,88);ctx.lineTo(660,88);ctx.stroke();
    ctx.font='16px serif'; ctx.fillStyle='#c8c8e8'; ctx.fillText('• ──  ── •', W/2, 100);
    // avatars moving apart
    const cy=270, r=80, leftX=200, rightX=600;
    const leftBuf = o.leftPic ? await thumbBuffer(o.leftPic) : null;
    const rightBuf = o.rightPic ? await thumbBuffer(o.rightPic) : null;
    for(const [x,buf] of [[leftX,leftBuf],[rightX,rightBuf]]){
      ctx.save(); ctx.shadowColor='rgba(180,180,220,0.5)'; ctx.shadowBlur=20;
      ctx.beginPath(); ctx.arc(x,cy,r+6,0,Math.PI*2); ctx.lineWidth=8; ctx.strokeStyle='rgba(180,180,220,0.6)'; ctx.stroke(); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.arc(x,cy,r,0,Math.PI*2); ctx.clip();
      if(buf){const img=await loadImage(buf); if(img){const sc=Math.max(160/img.width,160/img.height);ctx.globalAlpha=0.85;ctx.drawImage(img,x-img.width*sc/2,cy-img.height*sc/2,img.width*sc,img.height*sc);ctx.globalAlpha=1;}else{ctx.fillStyle='#2a2a44';ctx.fillRect(x-r,cy-r,160,160);}}
      else {ctx.fillStyle='#2a2a44';ctx.fillRect(x-r,cy-r,160,160);}
      ctx.restore();
    }
    // center broken heart + IT'S OVER
    const hx=W/2, hy=cy;
    const hg=ctx.createRadialGradient(hx,hy,0,hx,hy,90); hg.addColorStop(0,'rgba(100,100,150,0.4)'); hg.addColorStop(1,'transparent');
    ctx.fillStyle=hg; ctx.beginPath(); ctx.arc(hx,hy,90,0,Math.PI*2); ctx.fill();
    // broken heart (two halves)
    ctx.save(); ctx.fillStyle='#8888aa'; ctx.globalAlpha=0.9;
    ctx.beginPath();
    ctx.moveTo(hx-5, hy+28); ctx.bezierCurveTo(hx-55, hy-10, hx-70, hy-50, hx-5, hy-22);
    ctx.lineTo(hx-5, hy+28); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(hx+5, hy+28); ctx.bezierCurveTo(hx+55, hy-10, hx+70, hy-50, hx+5, hy-22);
    ctx.lineTo(hx+5, hy+28); ctx.fill();
    ctx.globalAlpha=1; ctx.restore();
    ctx.font='bold 30px sans-serif'; ctx.fillStyle='#e0e0ff'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='rgba(0,0,0,0.5)'; ctx.shadowBlur=6;
    ctx.fillText("IT'S OVER!", hx, hy+5);
    ctx.shadowBlur=0;
    // papers
    ctx.fillStyle='rgba(255,255,255,0.15)';
    ctx.fillRect(hx-60, hy+50, 40, 28); ctx.fillRect(hx+20, hy+45, 40, 28);
    ctx.font='12px sans-serif'; ctx.fillStyle='#fff';
    ctx.fillText('decree', hx-40, hy+64); ctx.fillText('papers', hx+40, hy+59);
    // tears
    ctx.fillStyle='rgba(150,180,255,0.6)';
    for(let i=0;i<6;i++){ctx.beginPath();ctx.arc(leftX+(i*20), cy+r+5+i*3, 3,0,Math.PI*2);ctx.fill();}
    for(let i=0;i<6;i++){ctx.beginPath();ctx.arc(rightX-(i*20), cy+r+5+i*3, 3,0,Math.PI*2);ctx.fill();}
    // names
    ctx.font='bold 22px sans-serif'; ctx.fillStyle='#e0e0ff'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='rgba(0,0,0,0.5)'; ctx.shadowBlur=6;
    ctx.fillText((o.leftName||'Alex')+'  '+(o.rightName||'Emma'), W/2, cy+r+34);
    ctx.shadowBlur=0;
    ctx.font='bold 18px sans-serif'; ctx.fillStyle='#e0e0ff';
    ctx.fillText((o.leftName||'Alex')+'  '+(o.rightName||'Emma')+' - It is Over!', W/2, cy+r+58);
    ctx.font='14px sans-serif'; ctx.fillStyle='#c8c8e8';
    if(o.reason) ctx.fillText(o.reason, W/2, cy+r+78);
    // footer
    const fy=H-45;
    const fdg=ctx.createLinearGradient(120,fy-16,680,fy-16);
    fdg.addColorStop(0,'transparent');fdg.addColorStop(0.5,'#a0a0c0');fdg.addColorStop(1,'transparent');
    ctx.strokeStyle=fdg; ctx.lineWidth=2; ctx.beginPath();ctx.moveTo(120,fy-16);ctx.lineTo(680,fy-16);ctx.stroke();
    ctx.font='italic 16px serif'; ctx.fillStyle='#d0d0e8';
    ctx.shadowColor='rgba(0,0,0,0.6)'; ctx.shadowBlur=2;
    ctx.fillText('Made with love by iKON BOT', W/2, fy); ctx.shadowBlur=0;
    ctx.font='16px serif'; ctx.fillStyle='#c8c8e8';
    ctx.fillText('• ──  ── •', W/2, fy+18);
    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    const { error } = require('./helpers');
    error(`[CARD] divorceCard failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  arrivalCard,
  botCard,
  duoCard,
  perfectPairCard,
  slapCard,
  roastCard,
  killCard,
  divorceCard,
  marryCard,
  shipCard,
  hugCard,
  kissCard,
  welcomeCard,
  goodbyeCard,
  leaderboardCard,
  richestCard,
  profileCard,
  userCard,
  boardCard,
  pairCard,
  pokemonCard,
  drawAvatar,
  loadImage,
  thumbBuffer,
  realName,
  fit,
  roundRect,
  glassPanel,
  cornerAccents,
  accentBar,
  textCard,
  wrapText,
};
