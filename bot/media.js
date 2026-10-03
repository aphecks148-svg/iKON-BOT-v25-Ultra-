'use strict';

/**
 * Real media: actually downloading the song or the video, actually singing.
 *
 * Everything here is keyless and every function resolves null rather than
 * throwing. That combination is deliberate. The commands in cmds_8.js promise a
 * file, a voice note or a wall of pictures, and the honest failure path for a
 * free endpoint being down has to be a sentence the user reads, not a stack
 * trace in the Render log and silence in the chat.
 *
 * WHAT ACTUALLY WORKS FROM A SERVER, MEASURED
 * YouTube's innertube API (the one youtube.com itself calls) answers the ANDROID
 * and IOS clients with UNCIPHERED stream URLs — no yt-dlp, no key, no signature
 * cracking. That is the whole reason this module exists: it turns "here is a
 * link, go download it yourself" into a file that lands in the chat.
 *
 *   POST youtubei/v1/player  ->  streamingData.formats[] (progressive mp4, audio
 *   baked in) and streamingData.adaptiveFormats[] (audio-only m4a/webm).
 *   The API key below is YouTube's own public web client key. It is not a secret
 *   and not an account: it identifies the client, it grants nothing.
 *
 * What does NOT work, so nothing depends on it:
 *   - api.cobalt.tools now demands a JWT (400 error.api.auth.jwt.missing).
 *   - Piped and Invidious instances answer 401/403/502 from datacenter IPs.
 *   - Pinterest's own JSON endpoint answers 403 to anything that is not a browser
 *     session, which is exactly what Render is not.
 *   - DuckDuckGo's image API answers 403 without a browser fingerprint.
 *
 * So pictures come from Bing's image endpoint (real image URLs, rate limited, so
 * every call retries with a different page offset) and fall back to Openverse,
 * which is CC-indexed and far more patient.
 *
 * WHY ATTACHMENTS ARE STREAMS
 * ws3-fca 3.5.2 throws "Attachment should be a readable stream and not Object"
 * for anything else, and helpers.reply() swallows the failure and returns null.
 * That is why images used to vanish: every command in this repo passed
 * `{ type: 'image', data: { url } }`, which that build cannot send. attachment()
 * below turns a URL, a data URL or a Buffer into the stream the client wants,
 * which is what finally makes a picture, a voice note and a song file land.
 */

const axios = require('axios');
const { Readable } = require('stream');

/** Messenger's upload ceiling in practice. Over this, Facebook rejects the send. */
const MAX_UPLOAD_BYTES = 48 * 1024 * 1024;

/** A browser UA: the free image endpoints hand a bot UA nothing. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** YouTube's public web key. Identifies the client; authorises nothing. */
const YT_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

/**
 * Innertube clients worth asking, in order.
 *
 * ANDROID answers with the widest format list. IOS is the fallback because it is
 * the one that keeps handing back `audio/mp4`, which plays everywhere; the
 * web client returns ciphered URLs that need signature cracking we are not going
 * to grow a dependency for.
 */
const YT_CLIENTS = [
  {
    name: 'ANDROID',
    version: '20.10.38',
    agent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
    extra: { androidSdkVersion: 34 },
  },
  {
    name: 'IOS',
    version: '20.10.4',
    agent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X)',
    extra: { deviceModel: 'iPhone16,2' },
  },
];

/** Google Translate's TTS endpoint. No key, no account, returns MP3. */
const TTS_HOST = 'https://translate.google.com/translate_tts';

/**
 * Google TTS reads about 200 characters before it truncates the request, and
 * hard-rejects much past that. Chunking at 180 keeps every request legal, and
 * the MP3 frames concatenate into a file that plays as one long take.
 */
const TTS_CHUNK = 180;

/** Ceiling on how much a voice note says, so a full song does not become a novel. */
const TTS_MAX_CHARS = 1400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────────────────────────────────────────────
// ATTACHMENTS
// ───────────────────────────────────────────────────────────────────

/** Is this already something ws3-fca will accept? */
function isStream(value) {
  return Boolean(value) && typeof value.on === 'function' && typeof value.pipe === 'function';
}

/** A one-shot readable stream over a Buffer. */
function streamOf(buffer) {
  return Readable.from([buffer]);
}

/**
 * Pull the bytes out of whatever a command had to hand.
 *
 * Accepts a Buffer, a `data:` URL (what the canvas helpers produce) and an
 * http(s) URL (what the sprite table produces). Resolves null rather than
 * throwing, because every caller has a text fallback ready and a thrown fetch
 * would rob it of that choice.
 *
 * @param {Buffer|string} source
 * @param {number} [maxBytes] refuse anything larger
 * @returns {Promise<{buffer:Buffer, mimeType:string}|null>}
 */
async function bytes(source, maxBytes = MAX_UPLOAD_BYTES) {
  try {
    if (Buffer.isBuffer(source)) {
      return source.length && source.length <= maxBytes ? { buffer: source, mimeType: guessMime(source) } : null;
    }

    const ref = String(source || '').trim();
    if (!ref) return null;

    if (/^data:/i.test(ref)) {
      const match = ref.match(/^data:([^;,]+)?(;base64)?,/i);
      const mimeType = (match && match[1]) || 'application/octet-stream';
      const payload = ref.slice((match ? match[0].length : 5));
      const buffer = match && match[2]
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload), 'utf8');
      return buffer.length && buffer.length <= maxBytes ? { buffer, mimeType } : null;
    }

    if (/^https?:\/\//i.test(ref)) {
      const res = await axios.get(ref, {
        timeout: 25000,
        responseType: 'arraybuffer',
        maxRedirects: 4,
        headers: { 'User-Agent': UA, Accept: '*/*' },
        maxContentLength: maxBytes + 1,
      });
      const buffer = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data || []);
      if (!buffer.length || buffer.length > maxBytes) return null;
      const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

      // An image search hands back web pages as often as pictures, and Facebook
      // rejects a text/html upload — so a page is refused here rather than
      // uploaded and dropped. Callers treat null as "try the next one".
      if (/^(text\/|application\/(json|xml|xhtml|x-www-form-urlencoded))/.test(type)) return null;
      if (!type && /text\/html/i.test(buffer.subarray(0, 200).toString('utf8'))) return null;

      return { buffer, mimeType: type || guessMime(buffer) };
    }

    return null;
  } catch {
    return null;
  }
}

/** Sniff the handful of types the bot actually sends. */
function guessMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return 'application/octet-stream';
  const head = buffer.subarray(0, 12);
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'audio/webm';
  if (head.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('ascii');
    if (/^(M4A|mp42|isom|mp41)/.test(brand)) return brand === 'M4A' ? 'audio/mp4' : 'video/mp4';
  }
  if (head[0] === 0x89 && head[1] === 0x50) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (head.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (head.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  return 'application/octet-stream';
}

/**
 * Turn a picture, a voice note or a song into the attachment ws3-fca accepts.
 *
 * This is the function that makes attachments work at all on this build. It is
 * also the one place that knows the ceiling, so an oversized video is refused
 * here with a reason the command can print instead of dying mid-upload.
 *
 * @param {Buffer|string|object} source a Buffer, a URL, a data URL, or an
 *   existing `{ type, data: { url } }` descriptor
 * @param {object} [opts]
 * @param {string} [opts.type] 'image' | 'audio' | 'video'
 * @param {number} [opts.maxBytes]
 * @returns {Promise<Readable|null>} null when the bytes cannot be had
 */
async function attachment(source, { type = null, maxBytes = MAX_UPLOAD_BYTES } = {}) {
  if (isStream(source)) return source;

  // Accept the descriptor shape the rest of the repo writes, so a caller can
  // hand over whatever it already had without unwrapping it first.
  let ref = source;
  let kind = type;
  if (source && typeof source === 'object' && !Buffer.isBuffer(source)) {
    kind = kind || source.type || null;
    const data = source.data || source;
    ref = data.url || data.audio_url || data.src || null;
  }

  const got = await bytes(ref, maxBytes);
  if (!got) return null;
  return streamOf(got.buffer);
}

/** Build the whole sendMessage payload in one call, attachment included. */
async function payload({ body = '', source = null, type = null, maxBytes = MAX_UPLOAD_BYTES } = {}) {
  const stream = source ? await attachment(source, { type, maxBytes }) : null;
  if (!stream) return null;
  return { body, attachment: stream };
}

/** The extension Facebook infers from the stream, for user-facing filenames. */
function extensionFor(mimeType, fallback = 'mp4') {
  const type = String(mimeType || '').toLowerCase();
  if (type.includes('mp4a') || type === 'audio/mp4') return 'm4a';
  if (type.includes('mp4')) return 'mp4';
  if (type.includes('webm')) return 'webm';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  return fallback;
}

// ───────────────────────────────────────────────────────────────────
// YOUTUBE
// ───────────────────────────────────────────────────────────────────

/** Pull the 11 character video id out of any YouTube link shape. */
function youtubeId(link) {
  const ref = String(link || '');
  const patterns = [
    /(?:v=|\/v\/|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/,
    /youtube\.com\/watch\?[^#\s]*v=([\w-]{11})/,
  ];
  for (const re of patterns) {
    const hit = ref.match(re);
    if (hit && hit[1]) return hit[1];
  }
  if (/^[\w-]{11}$/.test(ref.trim())) return ref.trim();
  return '';
}

/** Numeric height out of "720p" / "hd1080" / "1080p60". */
function heightOf(label) {
  const hit = String(label || '').match(/(\d{3,4})p?/);
  return hit ? Number(hit[1]) : 0;
}

/**
 * Ask innertube what a video is made of.
 *
 * Returns direct stream URLs. The URLs carry a six hour expiry in their
 * signature, which is far longer than a chat message lives, so they are safe to
 * hand straight to an uploader.
 *
 * @returns {Promise<object|null>} { id, title, author, lengthSeconds, thumbnail,
 *   audio: {url, mimeType, size, bitrate}, video: {url, mimeType, size, qualityLabel} }
 */
async function youtube(videoIdOrLink) {
  const id = youtubeId(videoIdOrLink);
  if (!id) return null;

  for (const client of YT_CLIENTS) {
    const info = await ytPlayer(id, client);
    if (!info) continue;

    const formats = [
      ...((info.streamingData && info.streamingData.formats) || []),
      ...((info.streamingData && info.streamingData.adaptiveFormats) || []),
    ];
    if (!formats.length) continue;

    const playable = formats.filter((f) => f && f.url);
    const audio = pickAudio(playable);
    const video = pickVideo(playable);
    if (!audio && !video) continue;

    const details = info.videoDetails || {};
    return {
      id,
      title: details.title || `YouTube ${id}`,
      author: details.author || '',
      lengthSeconds: Number(details.lengthSeconds) || 0,
      thumbnail: (info.microformat && info.microformat.playerMicroformatRenderer
        && info.microformat.playerMicroformatRenderer.thumbnail
        && info.microformat.playerMicroformatRenderer.thumbnail.thumbnails
        && (info.microformat.playerMicroformatRenderer.thumbnail.thumbnails.slice(-1)[0] || {}).url) || '',
      audio,
      video,
    };
  }
  return null;
}

/** One innertube round trip. Null on any failure. */
async function ytPlayer(id, client) {
  try {
    const res = await axios.post(`https://www.youtube.com/youtubei/v1/player?key=${YT_KEY}`, {
      videoId: id,
      contentCheckOk: true,
      racyCheckOk: true,
      context: {
        client: {
          clientName: client.name,
          clientVersion: client.version,
          hl: 'en',
          gl: 'US',
          ...(client.extra || {}),
        },
      },
    }, {
      timeout: 20000,
      responseType: 'json',
      headers: { 'User-Agent': client.agent, 'Content-Type': 'application/json' },
    });
    const data = res && res.data;
    if (!data || !data.streamingData) return null;
    if (data.playabilityStatus && /LOGIN|UNPLAYABLE|ERROR/i.test(String(data.playabilityStatus.status || ''))) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Does this stream carry its own audio track?
 *
 * YouTube does not say "audio" in the mime type. A progressive file reads
 * `video/mp4; codecs="avc1.42001E, mp4a.40.2"` — the sound is the `mp4a` codec
 * — while a video-only one reads `codecs="avc1.42001E"` and nothing else.
 * Matching on the word "audio" therefore downloads silent video and calls it a
 * music video, which is the exact failure this module exists to avoid.
 *
 * @param {string} mimeType the full mime including its codec list
 * @returns {boolean}
 */
function hasAudio(mimeType) {
  return /mp4a|opus|vorbis|aac|audio/i.test(String(mimeType || ''));
}

/**
 * The best audio-only stream: m4a first because it plays in everything, then by
 * bitrate. A webm/opus file is only chosen when there is no m4a at all.
 */
function pickAudio(formats) {
  const audio = formats.filter((f) => String(f.mimeType || '').startsWith('audio/'));
  if (!audio.length) return null;
  const m4a = audio.filter((f) => /audio\/mp4/.test(f.mimeType));
  const pool = m4a.length ? m4a : audio;
  const best = pool.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  return {
    url: best.url,
    mimeType: String(best.mimeType || '').split(';')[0].trim(),
    size: Number(best.contentLength) || 0,
    bitrate: Number(best.bitrate) || 0,
    extension: extensionFor(String(best.mimeType || '').split(';')[0], 'm4a'),
  };
}

/**
 * The best video stream.
 *
 * A progressive format (video and audio in one file) is preferred at 720p or
 * below: it is one upload and it is not silent. Above 720p the file is large
 * enough that Facebook starts refusing it, so the cap is the feature.
 */
function pickVideo(formats, maxHeight = 720) {
  const video = formats.filter((f) => /video\//.test(String(f.mimeType || '')));
  if (!video.length) return null;

  const muxed = video.filter((f) => /mp4/.test(String(f.mimeType || '')) && hasAudio(f.mimeType));
  const pool = muxed.length ? muxed : video;

  const inRange = pool.filter((f) => {
    const h = heightOf(f.qualityLabel || f.height || f.resolution);
    return !h || h <= maxHeight;
  });
  const chosen = (inRange.length ? inRange : pool).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  if (!chosen) return null;

  return {
    url: chosen.url,
    mimeType: String(chosen.mimeType || '').split(';')[0].trim(),
    size: Number(chosen.contentLength) || 0,
    bitrate: Number(chosen.bitrate) || 0,
    qualityLabel: String(chosen.qualityLabel || ''),
    silent: !hasAudio(chosen.mimeType),
    extension: extensionFor(String(chosen.mimeType || '').split(';')[0], 'mp4'),
  };
}

// ───────────────────────────────────────────────────────────────────
// TIKTOK / FACEBOOK / INSTAGRAM / X — tikwm
// ───────────────────────────────────────────────────────────────────

/**
 * The free endpoint that answers for the short-video platforms.
 *
 * tikwm has no key and covers TikTok, Facebook, Instagram and X in one call. It
 * is also the flakiest thing here, which is why it answers with the parsed body
 * or nothing at all and never with half of a file.
 *
 * @returns {Promise<object|null>} { title, author, music, cover, video: {url,...} }
 */
async function shortVideo(link) {
  try {
    const res = await axios.get('https://www.tikwm.com/api/', {
      params: { url: String(link), hd: 1 },
      timeout: 20000,
      responseType: 'json',
      headers: { 'User-Agent': UA },
    });
    const data = res && res.data;
    if (!data || !data.data || Number(data.code) !== 0) return null;

    const item = data.data;
    const play = item.hdplay || item.play || '';
    if (!play) return null;
    const mimeType = item.hdplay ? 'video/mp4' : 'video/mp4';

    return {
      title: item.title || '',
      author: item.author || '',
      music: item.music || '',
      cover: item.cover || item.dynamic_cover || '',
      video: {
        url: play,
        mimeType,
        size: 0,
        extension: 'mp4',
        silent: false,
      },
      audio: null,
    };
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────
// THE UNIFIED RESOLVER
// ───────────────────────────────────────────────────────────────────

/**
 * Resolve any supported link into something we can actually upload.
 *
 * @param {string} link
 * @param {object} [opts]
 * @param {'video'|'audio'} [opts.mode] what the caller wants
 * @returns {Promise<object|null>} { platform, title, author, music, thumbnail,
 *   file: {url, mimeType, extension, size}, mode }
 */
async function resolve(link, { mode = 'video' } = {}) {
  const ref = String(link || '').trim();
  if (!/^https?:\/\//i.test(ref)) return null;

  const yt = await youtube(ref);
  if (yt) {
    const wanted = mode === 'audio' ? (yt.audio || yt.video) : (yt.video || yt.audio);
    if (wanted) {
      return {
        platform: 'youtube',
        title: yt.title,
        author: yt.author,
        lengthSeconds: yt.lengthSeconds,
        thumbnail: yt.thumbnail,
        file: wanted,
        mode: wanted === yt.audio ? 'audio' : 'video',
        qualityLabel: wanted.qualityLabel || '',
      };
    }
  }

  const sv = await shortVideo(ref);
  if (sv) {
    // tikwm hands back one file. Asking for audio means taking the video's audio
    // track in that file, so the mode is reported honestly rather than implied.
    return {
      platform: /instagram/.test(ref) ? 'instagram'
        : /facebook|fb\.watch/.test(ref) ? 'facebook'
          : /twitter|x\.com/.test(ref) ? 'twitter' : 'tiktok',
      title: sv.title,
      author: sv.author,
      music: sv.music,
      thumbnail: sv.cover,
      file: sv.video,
      mode: 'video',
    };
  }

  return null;
}

// ───────────────────────────────────────────────────────────────────
// SPEECH — Google Translate TTS
// ───────────────────────────────────────────────────────────────────

/**
 * Speak text as an MP3.
 *
 * This is what makes `!sing` a voice note rather than a wall of text: the
 * lyrics go through a synthesiser and arrive in chat as audio. It is a
 * synthesiser, not a singer, and the command says so — pretending a speech
 * engine is a vocal performance would be the kind of lie this bot does not tell.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.tl] language code for the voice
 * @returns {Promise<Buffer|null>}
 */
async function speech(text, { tl = 'en' } = {}) {
  const flat = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[*_#`~<>|]/g, ' ')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .trim();
  if (!flat) return null;

  // Split on sentence edges where possible: a request cut mid-word sounds like a
  // glitch, and the concatenated MP3 frames then have a seam in them.
  const chunks = chunkForSpeech(flat).slice(0, Math.ceil(TTS_MAX_CHARS / TTS_CHUNK));
  const parts = [];

  for (let i = 0; i < chunks.length; i += 1) {
    if (i) await sleep(120);
    const piece = await speechChunk(chunks[i], tl);
    if (!piece) continue;
    parts.push(piece);
  }

  if (!parts.length) return null;
  const joined = Buffer.concat(parts);
  return joined.length ? joined : null;
}

/** One TTS request. Null on any failure. */
async function speechChunk(text, tl) {
  try {
    const res = await axios.get(TTS_HOST, {
      params: { ie: 'UTF-8', client: 'tw-ob', tl, total: 1, idx: 0, text },
      timeout: 20000,
      responseType: 'arraybuffer',
      headers: { 'User-Agent': UA },
    });
    const buffer = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data || []);
    return buffer.length > 200 ? buffer : null;
  } catch {
    return null;
  }
}

/** Greedy chunking that prefers a sentence or comma boundary. */
function chunkForSpeech(text) {
  const out = [];
  let rest = text;
  while (rest.length > TTS_CHUNK) {
    let cut = rest.lastIndexOf('. ', TTS_CHUNK);
    if (cut < 60) cut = rest.lastIndexOf(', ', TTS_CHUNK);
    if (cut < 60) cut = rest.lastIndexOf(' ', TTS_CHUNK);
    if (cut < 20) cut = TTS_CHUNK;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest.length) out.push(rest);
  return out.filter(Boolean);
}

// ───────────────────────────────────────────────────────────────────
// PICTURES
// ───────────────────────────────────────────────────────────────────

/** Bing HTML-escapes its JSON payloads; this puts them back. */
function unescapeHtml(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Bing image search, returning real image URLs.
 *
 * Rate limited rather than blocked: the first request of a burst works, the
 * next few come back empty. So a miss is retried once against a different page
 * offset after a pause, and only then is the source considered down.
 *
 * @returns {Promise<Array<{url:string,page:string,title:string}>>}
 */
async function bingImages(query, { first = 1 } = {}) {
  try {
    const res = await axios.get('https://www.bing.com/images/async', {
      params: { q: query, first, count: 30, mmasync: 1, async: 'content' },
      timeout: 20000,
      responseType: 'arraybuffer',
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const html = Buffer.from(res.data || []).toString('utf8');

    const out = [];
    const blocks = html.split('class="iusc"').slice(1);
    for (const block of blocks) {
      const blob = block.match(/\bm="(\{[\s\S]*?\})"/);
      if (!blob) continue;
      const json = unescapeHtml(blob[1]);
      const url = (json.match(/"murl":"(.*?)"/) || [])[1];
      if (!url || !/^https?:\/\//i.test(url)) continue;
      // Pages dressed up as pictures. Cheap to drop here, and bytes() refuses
      // them properly too — this just keeps the grid from filling with holes.
      if (/\.(html?|php|aspx?|jsp|css|js)(\?|#|$)/i.test(url)) continue;
      out.push({
        url,
        page: (json.match(/"purl":"(.*?)"/) || [])[1] || '',
        title: (json.match(/"t":"(.*?)"/) || [])[1] || '',
      });
    }
    return dedupeByUrl(out);
  } catch {
    return [];
  }
}

/**
 * Pictures for a topic, Pinterest first.
 *
 * `!pinterestsearch` promises pictures, so the order is: real Pinterest pins
 * (image hosts pinimg.com, then any pinterest.com page), then Bing again with
 * only the word "pinterest" in the query, then plain topic pictures, then
 * Openverse. Each source is a real image URL — nothing here is generated, so a
 * pin is a pin.
 *
 * @param {string} topic
 * @param {number} [want] how many, minimum 5
 * @returns {Promise<{pictures:Array, source:string}>}
 */
async function pictures(topic, want = 6) {
  const need = Math.max(5, Math.min(12, Number(want) || 6));
  const q = String(topic || '').trim();
  if (!q) return { pictures: [], source: 'none' };

  const found = [];

  let pins = await bingImages(`${q} pinterest`);
  if (pins.length < need) {
    await sleep(600);
    pins = pins.concat(await bingImages(`${q} site:pinterest.com`, { first: 36 }));
  }
  const pinterestish = pins.filter((p) => /pinimg|pinterest/i.test(p.url) || /pinterest/i.test(p.page || ''));
  if (pinterestish.length) {
    found.push(...pinterestish.slice(0, need));
    if (found.length >= need) return { pictures: dedupeByUrl(found).slice(0, need), source: 'pinterest' };
  }

  if (found.length < need) {
    await sleep(600);
    const wide = await bingImages(q, { first: 36 });
    if (wide.length) {
      for (const pic of wide) {
        if (found.length >= need) break;
        if (!found.some((f) => f.url === pic.url)) found.push({ ...pic, source: 'bing' });
      }
    }
  }

  if (found.length < need) {
    const open = await openverse(q, need);
    for (const pic of open) {
      if (found.length >= need) break;
      if (!found.some((f) => f.url === pic.url)) found.push({ ...pic, source: 'openverse' });
    }
  }

  return {
    pictures: rankForTopic(dedupeByUrl(found), q).slice(0, need),
    source: pinterestish.length ? 'mixed' : 'web',
  };
}

/**
 * Order results so the ones that actually match the topic come first.
 *
 * A web image search happily returns a YouTube logo for "aesthetic bedroom",
 * because nothing stopped it. Without this, a grid of six pictures can contain
 * two of them. Relevance is judged on the title only — no extra requests — and
 * anything that does not match keeps its place, because six pictures is the
 * promise and a logo still beats an empty message.
 *
 * @param {Array<{url:string,title:string}>} pictures
 * @param {string} topic
 */
function rankForTopic(pictures, topic) {
  const words = String(topic || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
  if (!words.length) return pictures;

  const score = (pic) => {
    const haystack = `${pic.title || ''} ${pic.url || ''} ${pic.page || ''}`.toLowerCase();
    return words.filter((w) => haystack.includes(w)).length;
  };
  return pictures
    .map((pic, i) => ({ pic, i, s: score(pic) }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map((row) => row.pic);
}

/**
 * Openverse: real, openly-licensed photographs, keyless, and far too patient to
 * rate limit a chat bot. It is the floor of the picture stack — when it is the
 * one answering, the images are photographs of the topic rather than pins.
 *
 * @returns {Promise<Array<{url:string,page:string,title:string}>>}
 */
async function openverse(query, want = 6) {
  try {
    const res = await axios.get('https://api.openverse.org/v1/images/', {
      params: { q: query, page_size: Math.min(20, want * 2), mature: false },
      timeout: 20000,
      responseType: 'json',
      headers: { 'User-Agent': 'iKON-BOT/2.0 (Messenger bot)' },
    });
    const results = (res && res.data && res.data.results) || [];
    return results
      .filter((r) => r && r.url && /^https?:\/\//i.test(r.url))
      .map((r) => ({ url: r.url, page: r.foreign_landing_url || r.url, title: String(r.title || '').slice(0, 90) }));
  } catch {
    return [];
  }
}

/** Same image twice in a grid of six looks like a bug, so drop duplicates. */
function dedupeByUrl(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    if (!item || !item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

/**
 * Pinterest has stopped serving pin images to anything that is not a browser.
 *
 * Measured, not assumed: the pin page still returns 200 and a megabyte of HTML,
 * but it has no og:image, no og:video and no og:title for a desktop browser, a
 * Googlebot, a Facebook crawler or a Twitterbot — the page is an app shell and
 * the pin data arrives by XHR afterwards. oembed.json answers 400, the v1 API
 * answers 404, and PinResource answers 403 from a server IP.
 *
 * So the lookup is a cascade of things that still work, in order of how much
 * they can be trusted:
 *
 *   1. the user pasted the image itself (pinimg.com/<...>.jpg) — send it.
 *   2. the page markup carries an og:image or og:video — still true for
 *      anything that embeds a pin rather than being Pinterest.
 *   3. Bing's image index for that exact pin URL, accepting a result ONLY when
 *      its own page URL is the pin the user pasted. A lookalike image is worse
 *      than an honest no, so a fuzzy match is thrown away.
 *
 * @param {string} link the pin URL
 * @returns {Promise<{url:string, video?:string, title:string, source:string}|null>}
 */
async function pinImage(link) {
  const ref = String(link || '').trim();

  // 1. A direct image link. The user copying "image address" off a pin lands here
  // and it always works, because nothing has to be guessed.
  if (/pinimg\.com\/|pinimg\.com%2F/i.test(ref) || /\.(jpe?g|png|gif|webp)(\?|#|$)/i.test(ref)) {
    return { url: ref, title: '', source: 'link' };
  }

  // 2. Open Graph tags, in either attribute order.
  const html = await fetchHtml(ref);
  if (html) {
    const pick = (property) => {
      const re = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i');
      const flipped = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i');
      return (html.match(re) || html.match(flipped) || [])[1] || '';
    };
    const img = pick('og:image');
    const clip = pick('og:video');
    const title = pick('og:title');
    if (img) return { url: unescapeHtml(img), video: unescapeHtml(clip), title, source: 'og' };
    if (clip) return { url: unescapeHtml(clip), title, source: 'og-video' };
  }

  // 3. The search index, exact page match only.
  const wanted = barePage(ref);
  const hits = await bingImages(ref);
  const exact = hits.find((h) => barePage(h.page) === wanted && /pinimg|pinterest/i.test(h.url));
  if (exact) return { url: exact.url, title: exact.title, source: 'index' };

  return null;
}

/** A URL with its query, fragment and trailing slash removed, for matching. */
function barePage(url) {
  return String(url || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/** GET a page as text. Null on any failure. */
async function fetchHtml(url) {
  try {
    const res = await axios.get(url, {
      timeout: 20000,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      maxContentLength: 8 * 1024 * 1024,
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    });
    return Buffer.from(res.data || []).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = {
  MAX_UPLOAD_BYTES,
  isStream,
  streamOf,
  bytes,
  attachment,
  payload,
  extensionFor,
  guessMime,
  youtubeId,
  youtube,
  pickAudio,
  pickVideo,
  shortVideo,
  resolve,
  speech,
  bingImages,
  openverse,
  pictures,
  pinImage,
};