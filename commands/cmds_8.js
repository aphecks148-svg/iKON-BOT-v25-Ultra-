'use strict';

/**
 * MODULE 8 — DOWNLOAD + AI, GROQ ONLY (44 commands)
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
const cards = require('../bot/cards');
const groq = require('../bot/groq');
const media = require('../bot/media');

const config = require('../config');
const Group = require('../models/Group');
const cache = require('../bot/cache');

const CASH = 'K-Cash';
const OWNER = 'Aphecks iKon Klerk';
const POLLINATIONS = 'https://image.pollinations.ai/prompt/';
const OPENLIGADB = 'https://www.openligadb.de/api/getmatchdata';
const THESPORTSDB = 'https://www.thesportsdb.com/api/v1/json/3';
const APIFOOTBALL = process.env.FOOTBALL_API_KEY ? `https://v3.football-data.org/v4` : '';
const THESPORTSDB_BASE = THESPORTSDB;

/**
 * The free football platforms this module talks to, in priority order.
 *
 * TheSportsDB v1 is the primary source: it is unauthenticated, covers 100+
 * leagues, and serves livescores, fixtures, standings and team details from
 * one base URL. OpenLigaDB is the fallback — same shape, different host, and
 * the two together mean a Cloudflare block on one is not a broken bot.
 *
 * API-Football (v3) is the third source and only answers when the operator has
 * set a key, which is why it is last: it is the best data available and it is
 * also the only one that costs. The commands say which source answered.
 *
 * @type {string[]}
 */
const FOOTBALL_SOURCES = [
  'https://www.thesportsdb.com/api/v1/json/3',
  'https://www.openligadb.de/api/getmatchdata',
];

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
 * Ask Groq for the colour, and take the colour or leave it.
 *
 * The difference from askGroq is what happens when Groq does not answer.
 * askGroq substitutes a placeholder that says so loudly, which is right for a
 * command whose whole job is the AI's answer. It is wrong for a command that
 * has already shown the facts: there, the placeholder replaces nothing and
 * only adds noise, so the empty string is the honest answer.
 *
 * @param {string} prompt the question, already worded
 * @param {string} style extra persona instruction
 * @returns {Promise<string>} the answer, or '' when Groq did not answer
 */
async function askGroqQuiet(prompt, style = '') {
  const text = String(prompt || '').trim();
  if (!text) return '';
  try {
    const answer = await groq.ask(text, {
      system: LORE,
      style,
      maxTokens: 2048,
    });
    return answer || '';
  } catch {
    return '';
  }
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
// MONEY — prices and rates
// ───────────────────────────────────────────────────────────

/**
 * A dollar figure, short enough for a group chat.
 *
 * A market cap of 1,334,002,119,442.00 is a number nobody reads, so the
 * billions and millions keep two decimals and everything else keeps the cents.
 */
function usd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (n === 0) return '$0.00';
  return `$${n.toFixed(6)}`;
}

/**
 * The coins the price command knows by their ticker.
 *
 * A symbol is a guess — BTC is Bitcoin and so is BTC, but FTM and S are the
 * same coin with two tickers, and a lookup by ticker alone sends a third of
 * the pairs to the wrong coin. The id is the one thing the feed cannot
 * misread, so every ticker here is mapped to it.
 */
const CRYPTO_IDS = {
  btc: 'bitcoin', eth: 'ethereum', usdt: 'tether', bnb: 'binancecoin', sol: 'solana',
  xrp: 'ripple', doge: 'dogecoin', ada: 'cardano', trx: 'tron', ton: 'the-open-network',
  dot: 'polkadot', matic: 'matic-network', link: 'chainlink', avax: 'avalanche-2',
  ltc: 'litecoin', shib: 'shiba-inu', usdc: 'usd-coin', bch: 'bitcoin-cash', atom: 'cosmos',
  xlm: 'stellar', near: 'near', apt: 'aptos', arb: 'arbitrum', op: 'optimism',
  fil: 'filecoin', icp: 'internet-computer', hbar: 'hedera-hashgraph', vet: 'vechain',
  aave: 'aave', uni: 'uniswap', mkr: 'maker', ldo: 'ethereum-lido-staked',
  stx: 'blockstack', grt: 'the-graph', sand: 'the-sandbox', mana: 'decentraland',
  axs: 'axie-infinity', ftm: 'fantom', sonic: 'fantom', rndr: 'render-token',
  imx: 'immutable-x', pepe: 'pepe', wif: 'dogwifcoin', bonk: 'bonk',
  sei: 'sei-network', tia: 'celestia', inj: 'injective-protocol', sui: 'sui',
  wbtc: 'wrapped-bitcoin', cbbtc: 'coinbase-wrapped-btc', crv: 'curve-dao-token',
  eos: 'eos', neo: 'neo', egld: 'elrond-erd-2', xtz: 'tezos',
};

/**
 * The exchange rates, against the dollar, kept for an hour.
 *
 * The rates desk is a free endpoint and it is asked for a rate table, not a
 * price, so the table changes slowly. An hour of cache is the difference
 * between one request a minute and one request a second when a whole chat
 * decides to check the dollar at once.
 */
let fxCache = null;

async function fxRates() {
  if (fxCache && Date.now() - fxCache.at < 3600000) return fxCache;
  const data = await fetchJson('https://open.er-api.com/v6/latest/USD');
  if (!data || !data.rates || typeof data.rates !== 'object') return null;
  fxCache = {
    at: Date.now(),
    rates: data.rates,
    updated: data.time_last_update_utc || data.time_last_update_utc_unix || '',
  };
  return fxCache;
}

/**
 * A coin id, turned back into a name a person would recognise.
 *
 * The exchanges answer with a ticker, and "BTC (BTC)" is not a title. The id
 * is the one place the full name survives: bitcoin -> Bitcoin,
 * the-open-network -> The Open Network.
 */
function prettyId(id) {
  return String(id || '')
    .split('-')
    .filter(Boolean)
    .map((word, i) => (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/**
 * One coin, quoted.
 *
 * Three sources, in order, and the receipt says which one answered. CoinGecko
 * is the only one of the three that knows a market cap and a rank, so it goes
 * first; it is also the one that rate-limits hardest, so Kraken and Coinbase
 * are behind it. A coin price that came from a different exchange than the
 * last one is a small lie, and the source line is what keeps it from being
 * one.
 *
 * @param {string} symbol the exchange ticker, e.g. BTC
 * @param {string} id the CoinGecko id, e.g. bitcoin
 * @returns {Promise<object|null>} null when nobody answered
 */
async function cryptoQuote(symbol, id) {
  // 1. CoinGecko — price, 24h change, market cap, rank.
  const g = await fetchJson(
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(id)}&price_change_percentage=24h`,
  );
  if (Array.isArray(g) && g.length) {
    const c = g[0];
    return {
      source: 'CoinGecko',
      name: c.name,
      symbol: c.symbol,
      price: Number(c.current_price),
      change: Number(c.price_change_percentage_24h),
      cap: Number(c.market_cap),
      rank: c.market_cap_rank || null,
    };
  }

  // 2. Kraken — last price and yesterday's open, which is a 24-hour change.
  // Kraken answers with an `error` array that is empty when nothing is wrong,
  // and an empty array is truthy: `!k.error` would throw the answer away.
  const k = await fetchJson(`https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(symbol)}USD`);
  const krakenError = k && Array.isArray(k.error) && k.error.length;
  if (k && !krakenError && k.result && typeof k.result === 'object') {
    const key = Object.keys(k.result)[0];
    const t = k.result[key];
    const last = Number(t && t.c && t.c[0]);
    const open = Number(t && t.o);
    if (Number.isFinite(last) && last > 0) {
      return {
        source: 'Kraken',
        name: prettyId(id),
        symbol,
        price: last,
        change: Number.isFinite(open) && open > 0 ? ((last - open) / open) * 100 : NaN,
        cap: NaN,
        rank: null,
      };
    }
  }

  // 3. Coinbase — the spot price, with yesterday's open for the change.
  const spot = await fetchJson(`https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}-USD/ticker`);
  if (spot && spot.price) {
    const stats = await fetchJson(`https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}-USD/stats`);
    const last = Number(spot.price);
    const open = Number(stats && stats.open);
    return {
      source: 'Coinbase',
      name: prettyId(id),
      symbol,
      price: last,
      change: Number.isFinite(open) && open > 0 ? ((last - open) / open) * 100 : NaN,
      cap: NaN,
      rank: null,
    };
  }

  return null;
}

/**
 * Pull football data from every free platform, in order, and merge it.
 *
 * TheSportsDB v1 is the primary source (unauthenticated, 100+ leagues,
 * livescores, fixtures, standings and team details from one base URL).
 * OpenLigaDB is the fallback — same shape, different host, so a Cloudflare
 * block on one is not a broken bot. API-Football v3 is the third source and
 * only answers when the operator has set a key, which is why it is last.
 *
 * Every source returns null on failure and the merge is a flat array, so the
 * caller hands the whole thing to Groq and never has to know which host
 * answered. The commands say which source answered in their receipt.
 *
 * @param {string} what livescore|fixtures|standings|team|league
 * @param {string} [query] a league or team name, for the shaped endpoints
 * @returns {Promise<{data:object[], source:string|null}>}
 */
async function footballData(what, query = '') {
  const sources = [];
  if (APIFOOTBALL) sources.push({ base: APIFOOTBALL, path: apiFootballPath(what, query), auth: true });
  sources.push({ base: THESPORTSDB_BASE, path: footballPath(what, query) });
  sources.push({ base: OPENLIGADB, path: openligaPath(what, query) });
  for (const s of sources) {
    if (!s.path) continue;
    const opts = s.auth ? { headers: { 'X-Api-Key': process.env.FOOTBALL_API_KEY } } : {};
    const data = await fetchJson(`${s.base}${s.path}`, opts);
    if (data && typeof data === 'object') {
      const arr = footballArray(what, data);
      if (arr && arr.length) return { data: arr, source: s.auth ? 'api-football' : (s.base === THESPORTSDB_BASE ? 'thesportsdb' : 'openligadb') };
    }
  }
  return { data: [], source: null };
}

/**
 * API-Football v3 path. Only used when the operator has set FOOTBALL_API_KEY —
 * it is the best data available and it is also the only one that costs, so it
 * is tried first and the free sources are the fallback.
 *
 * The query is deliberately NOT used. API-Football wants a numeric league or
 * team id, and what a person types is a name — "EPL", "Liverpool" — so the
 * old path built a URL like `/competitions/EPL/standings` and got a 404. The
 * filters are applied to the text after the feed answers instead, which is
 * what every source agrees on.
 *
 * @param {string} what
 * @param {string} query
 * @returns {string|null}
 */
function apiFootballPath(what, query) {
  switch (what) {
    case 'fixtures': return '/fixtures?status=NS&limit=50';
    case 'livescore': return '/fixtures?status=IN,PEN,HPT&limit=50';
    case 'standings': return null;
    case 'team': return null;
    default: return null;
  }
}

/**
 * TheSportsDB v1 path for each kind of request.
 *
 * @param {string} what
 * @param {string} query
 * @returns {string|null}
 */
/**
 * TheSportsDB v1 path for each kind of request.
 *
 * The league query is dropped for the same reason as above: this feed's
 * `livescore.php` takes a sport, not a league, so `?l=EPL` was a request for
 * a sport called EPL and it came back empty. The league is filtered after the
 * answer instead.
 *
 * @param {string} what
 * @param {string} query
 * @returns {string|null}
 */
function footballPath(what, query) {
  const q = encodeURIComponent(String(query || '').trim());
  switch (what) {
    case 'fixtures': return q ? `/searchevents.php?e=${q}` : '/eventsnext.php?id=Soccer';
    case 'standings': return q ? `/lookupleague.php?l=${q}` : '/search_all_leagues.php?c=Soccer';
    case 'team': return q ? `/searchteams.php?t=${q}` : null;
    case 'league': return q ? `/lookupleague.php?l=${q}` : '/search_all_leagues.php?c=Soccer';
    case 'livescore':
    default: return '/livescore.php?l=Soccer';
  }
}

/**
 * OpenLigaDB path for each kind of request.
 *
 * The league id is dropped for the same reason: OpenLigaDB wants a number
 * (4079 for the Bundesliga) and no person types that. The whole match list
 * comes back and the league is filtered from the text.
 *
 * @param {string} what
 * @param {string} query
 * @returns {string|null}
 */
function openligaPath(what, query) {
  switch (what) {
    case 'fixtures':
    case 'livescore':
    default: return '/getmatchdata';
  }
}

/**
 * Normalise whatever a football API returned into a flat array of match
 * objects. TheSportsDB nests under `events`/`matches`/`teams`/`leagues`,
 * OpenLigaDB returns the array directly, and a null response is an empty
 * array — never null, so the caller can always iterate.
 *
 * @param {string} what
 * @param {object} data
 * @returns {object[]}
 */
function footballArray(what, data) {
  if (!data || typeof data !== 'object') return [];
  for (const key of ['events', 'matches', 'teams', 'leagues', 'table']) {
    if (Array.isArray(data[key]) && data[key].length) return data[key];
  }
  return Array.isArray(data) ? data : [];
}

/**
 * The group document for this thread, or null when the database is down.
 *
 * Mirrors the `liveGroup` helper in module 6 rather than duplicating it: the
 * football commands need the same read path as the welcome and moderation
 * commands, and a second implementation would drift.
 *
 * @param {object} event
 * @param {object} api
 * @returns {Promise<object|null>}
 */
async function footballGroup(event, api) {
  if (!mongo.isReady() || !event || !event.threadID) return null;
  return Group.findOne({ tid: String(event.threadID) }).catch(() => null);
}

/**
 * The football subdocument on a group, backfilled the same way the schema
 * states it. A document written before module 12 has no `football` at all, and
 * assigning to `group.football.subscriptions` on undefined throws — which is
 * what made `!follow` crash on every established group.
 *
 * @param {object} group
 * @returns {object}
 */
function ensureFootball(group) {
  if (!group.football || typeof group.football !== 'object') group.football = {};
  const f = group.football;
  if (typeof f.on !== 'boolean') f.on = false;
  if (!Array.isArray(f.subscriptions)) f.subscriptions = [];
  if (!f.lastScore || typeof f.lastScore !== 'object') f.lastScore = {};
  return f;
}

// ───────────────────────────────────────────────────────────
// FOOTBALL — reading the feeds without an AI round trip
//
// Every football command used to ask Groq to do two things it did not need
// an AI for: turn "EPL" into "English Premier League", and turn a wall of
// JSON into a paragraph.
//
// The first one is a table lookup that was being paid for at 50 K-Cash a
// time, on every single command, for a word the bot already knew. The second
// one is the reason the commands felt broken: the data came back fine and
// the paragraph came back empty, because Groq was not answering — and the
// person had already been charged.
//
// So the facts are now read out of the feed directly, and Groq is only ever
// asked for colour. When Groq is down the command still answers with real
// scorelines, and the fee is only taken once there is something to show.
// ───────────────────────────────────────────────────────────

/**
 * The leagues worth naming, and the words that should find each of them.
 *
 * The key is the canonical name the feeds use. The value is every spelling
 * that should land on it — including the ones people actually type.
 */
const FOOTBALL_LEAGUES = {
  'English Premier League': ['epl', 'premier league', 'premier', 'england', 'english premier league'],
  'La Liga': ['la liga', 'laliga', 'spanish', 'spain', 'espana'],
  'Serie A': ['serie a', 'seriea', 'italy', 'italian'],
  'Bundesliga': ['bundesliga', 'germany', 'german', 'deutschland'],
  'Ligue 1': ['ligue 1', 'ligue1', 'france', 'french'],
  'Eredivisie': ['eredivisie', 'netherlands', 'dutch'],
  'Champions League': ['champions league', 'ucl', 'champions'],
  'Europa League': ['europa league', 'uel'],
  'MLS': ['mls', 'major league soccer'],
  'Scottish Premiership': ['scottish', 'scotland', 'spl'],
  'Conference League': ['conference league', 'uecl'],
};

/**
 * Resolve a typed league name to the name the feeds use.
 *
 * A table, not an AI. The old version asked Groq to normalise the league
 * name — a network round trip and 50 K-Cash to do what a `.toLowerCase()`
 * and a lookup can do. It also failed in the worst possible way: when Groq
 * was down the canonical name came back empty and the command queried the
 * feed with `?l=` and nothing at all.
 *
 * @param {string} text what the person typed
 * @returns {string} the canonical name, or the input trimmed when it is not
 *   one we know — the feed may still understand it.
 */
function canonicalLeague(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const needle = raw.toLowerCase();
  for (const [canonical, words] of Object.entries(FOOTBALL_LEAGUES)) {
    if (words.includes(needle)) return canonical;
    const cNeedle = canonical.toLowerCase();
    if (cNeedle === needle || cNeedle.includes(needle)) return canonical;
  }
  // Not a league we know by name. It may still be a club ("Liverpool") or a
  // country the feed knows, so the input goes through unchanged.
  return raw;
}

/**
 * Does this row belong to the league being asked about?
 *
 * The feeds do not all filter by league the same way, and OpenLigaDB wants a
 * numeric league id where the person typed a name. So the filtering happens
 * here, on the text every feed agrees on.
 *
 * @param {object} row a raw feed row
 * @param {string} league the canonical league name
 * @returns {boolean}
 */
function matchIsLeague(row, league) {
  if (!league) return true;
  const m = normaliseMatch(row);
  if (!m.league) return false;
  const hay = m.league.toLowerCase();
  const needle = league.toLowerCase();
  if (hay.includes(needle) || needle.includes(hay)) return true;
  return FOOTBALL_LEAGUES[league]
    ? FOOTBALL_LEAGUES[league].some((w) => hay.includes(w))
    : false;
}

/**
 * Flatten whatever a feed returned into one shape.
 *
 * Three feeds, three shapes:
 *
 *   TheSportsDB — flat: strHomeTeam, intHomeScore, strProgress.
 *   OpenLigaDB  — nested: team1.teamName, team1.goals, matchDateTime.
 *   API-Football — wrapped: teams.home.name, goals.home, fixture.status.
 *
 * Every football command reads this and nothing else, so a feed changing
 * its shape is one edit here rather than ten.
 *
 * @param {object} row a raw feed row
 * @returns {{home:string,away:string,hs:string,as:string,minute:string,league:string,status:string,finished:boolean}}
 */
function normaliseMatch(row) {
  const out = {
    home: '', away: '', hs: '', as: '', minute: '', league: '', status: '', finished: false,
  };
  if (!row || typeof row !== 'object') return out;

  // ── TheSportsDB ────────────────────────────────────────
  if (row.strHomeTeam || row.strAwayTeam) {
    out.home = String(row.strHomeTeam || '');
    out.away = String(row.strAwayTeam || '');
    out.hs = row.intHomeScore === null || row.intHomeScore === undefined ? '' : String(row.intHomeScore);
    out.as = row.intAwayScore === null || row.intAwayScore === undefined ? '' : String(row.intAwayScore);
    out.league = String(row.strLeague || '');
    out.status = String(row.strStatus || '');
    out.minute = String(row.strProgress || '');
    out.finished = /finished|ft/i.test(out.status);
    return out;
  }

  // ── OpenLigaDB ─────────────────────────────────────────
  if (row.team1 || row.team2) {
    const t1 = row.team1 || {};
    const t2 = row.team2 || {};
    out.home = String(t1.teamName || '');
    out.away = String(t2.teamName || '');
    out.hs = t1.goals === undefined || t1.goals === null ? '' : String(t1.goals);
    out.as = t2.goals === undefined || t2.goals === null ? '' : String(t2.goals);
    out.league = String(row.leagueName || (row.league && row.league.name) || '');
    out.status = 'Live';
    out.finished = false;
    return out;
  }

  // ── API-Football ───────────────────────────────────────
  if (row.teams || row.fixture) {
    const teams = row.teams || {};
    const fx = row.fixture || {};
    out.home = String((teams.home && teams.home.name) || '');
    out.away = String((teams.away && teams.away.name) || '');
    const goals = row.goals || row.score || {};
    out.hs = goals.home === null || goals.home === undefined ? '' : String(goals.home);
    out.as = goals.away === null || goals.away === undefined ? '' : String(goals.away);
    out.league = String((row.league && (row.league.name || row.league.country)) || '');
    out.status = String((fx.status && fx.status.short) || '');
    out.minute = String((fx.status && fx.status.elapsed) || '');
    out.finished = /finished|ft/i.test(out.status);
    return out;
  }

  return out;
}

/**
 * One match as a line of text.
 *
 * @param {object} row a raw feed row
 * @returns {string}
 */
function matchLine(row) {
  const m = normaliseMatch(row);
  if (!m.home && !m.away) return '';
  const score = m.hs || m.as ? `${m.hs || 0} - ${m.as || 0}` : 'v';
  const clock = m.minute ? ` (${m.minute})` : '';
  const league = m.league ? ` · ${m.league}` : '';
  return `⚽ ${m.home} ${score} ${m.away}${clock}${league}`;
}

/**
 * The deterministic block of scorelines.
 *
 * This is what the command shows when Groq is not answering, and what it
 * shows underneath the commentary when it is. The facts come from the feed,
 * not from a language model, so they are the same either way.
 *
 * @param {object[]} rows raw feed rows
 * @param {number} [limit]
 * @returns {string}
 */
function footballSummary(rows, limit = 8) {
  const lines = (rows || [])
    .map(matchLine)
    .filter(Boolean)
    .slice(0, limit);
  return lines.join('\n');
}

/**
 * Are these rows worth charging for?
 *
 * @param {object[]} rows
 * @returns {boolean}
 */
function footballHasData(rows) {
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Remove the same match appearing twice.
 *
 * The live list and the fixture list overlap — a match that is on now is
 * also the next fixture — and a command that read both would print the same
 * scoreline twice. The key is the two teams and the score, which is the same
 * for one match wherever it appears.
 *
 * @param {object[]} rows
 * @returns {object[]}
 */
function dedupeMatches(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const m = normaliseMatch(row);
    if (!m.home && !m.away) continue;
    const key = `${m.home}|${m.away}|${m.hs}|${m.as}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
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
  translate: 50,
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
  leaderboard: 50,
  nextwinner: 50,
  teaminfo: 50,
  fixtures: 50,
  follow: 0,
  alerts: 0,
  cricketscore: 50,
  weatherai: 50,
  newsai: 50,
  wiki: 50,
  summarize: 50,
  rewrite: 50,
  storyai: 100,
  codeai: 100,
  songai: 150,
  crypto: 25,
  currency: 25,
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
    execute: async ({ args, userDoc, reply, react, event, config }) => guard(reply, event.messageID, 'pinterestdown', async () => {
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
    aliases: ['pinsearch', 'pinfind', 'pinterest'],
    category: 'downloader',
    description: '🔍 Pinterest search — six real pictures of the topic, sent as images',
    usage: '!pinterestsearch <topic> | !pinterestsearch strict <topic>',
    hint: '`strict` keeps every picture a Pinterest pin and says so if it cannot. Without it, the search tops up with Bing and Openverse when Pinterest is quiet.',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'pinterestsearch', async () => {
      await react('🔍');
      const strict = /^(strict|only|pins)$/i.test(String(args[0] || '').trim());
      const topic = strict ? args.slice(1).join(' ').trim() : args.join(' ').trim();
      if (!topic) {
        await reply('❌ Usage: `!pinterestsearch cars` or `!pinterestsearch strict cars`', event.messageID);
        return;
      }

      const paid = await charge(userDoc, FEES.pinterestsearch, 'downloader:pinterestsearch');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      await reply(`🔍 Pulling pictures of "${topic}"...`, event.messageID);

      const result = strict
        ? await media.picturesPinterestOnly(topic, 6)
        : await media.pictures(topic, 6);
      const { pictures, source } = result;

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
          : strict ? '⚠️ Pinterest gave us no pins — these are web images'
            : 'web images (Pinterest was unreachable)';

      // One contact sheet first, so the six images that follow have an order
      // and the chat is not six messages of nothing.
      const sheet = await pictureSheet(pictures, topic.toUpperCase());
      if (sheet) {
        await reply({
          body: `📌 **PICKS FOR "${topic.toUpperCase()}"**\n`
            + `${pictures.length} pictures · ${where}\n`
            + '· · · · · · ·\n'
            + (strict ? '📌 Strict mode: every picture is a Pinterest pin.' : 'Each one is on its way as its own image.'),
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
        + `· · · · · · ·\n${text.slice(0, 1800)}${text.length > 1800 ? '\n_(truncated)_' : ''}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'sing',
    aliases: ['singing', 'singalong', 'song', 'play'],
    category: 'downloader',
    description: '🎙️ Sings it — downloads the real mp3 from YouTube and sends it as a voice note',
    usage: '!sing <song> [artist]',
    hint: 'The voice note is the actual recording from YouTube, not a synthesiser reading the lyrics. If YouTube has no match, Groq writes eight original lines and the bot sings those.',
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

      // Look the song up on YouTube first. If there is a real recording, send
      // that — a voice note of the actual track is worth more than a
      // synthesiser reading the lyrics, and it is what the command name
      // promises.
      const yt = await media.youtube(q);
      const guide = await askGroq(
        `Turn this into a sing-along vocal guide. Give: the key feel, the tempo, the hardest line to hit, `
        + `and a 4-line "warm up like this" exercise. Song: ${q}.`
        + (yt ? `\nTitle: "${yt.title}" by ${yt.author || 'unknown'}. Length: ${yt.lengthSeconds}s.` : '\nNo YouTube match, so write the guide from the title and say so.'),
        'Style: a coach who is honest about how hard it is.',
      );

      if (yt && yt.audio && yt.audio.url) {
        const sent = await sendAudio({
          reply,
          messageID: event.messageID,
          url: yt.audio.url,
          mimeType: yt.audio.mimeType || 'audio/mpeg',
          body: `🎙️ **SINGING: ${String(yt.title || q).slice(0, 80)}**\n`
            + '· · · · · · ·\n'
            + `${guide}\n`
            + `🎙️ ${yt.author || 'unknown'} · ${yt.lengthSeconds ? `${Math.floor(yt.lengthSeconds / 60)}m` : ''}\n`
            + `🔎 ${q}`,
        });
        if (sent) return;
      }

      // No recording and no audio track: Groq writes eight original lines and
      // the bot sings those. Its own words, so singing them costs nobody a
      // copyright — and a fallback that just says "sorry" is a wasted coin.
      const data = await fetchJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(q)}`);
      const found = data && data.lyrics;
      const lines = found
        ? String(found).trim().split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 16)
        : [];
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
          + (sung.length ? `· · · · · · ·\n🎵 Sung lines:\n${sung.slice(0, 10).join('\n')}` : '')
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
      await reply(`🗣️ **SAVAGE MODE**\n· · · · · · ·\n${savage}`, event.messageID);
    }),
  });

  commands.push({
    name: 'ask',
    // `chat` is the spelling the retired raw-provider command answered to, and
    // it is the word people actually type.
    aliases: ['askai', 'ikonask2', 'chat'],
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
      await reply(`🤖 **${q.slice(0, 80)}**\n· · · · · · ·\n${answer}\n💸 ${kc(FEES.ask)}`, event.messageID);
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
      await reply(`⚡ **PRO MODE**\n· · · · · · ·\n${answer}\n💸 ${kc(FEES.ai)}`, event.messageID);
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
      let text = parts.join(' ').trim();

      // Reply-to translation. ws3-fca does not hand the replied-to message's
      // body back on the event, so a bare `!translate sw` on a reply has no
      // text to work with — say so and point at the form that does.
      if (!text) {
        await reply(
          `❌ No text to translate.\n`
          + '· · · · · · ·\n'
          + 'Two ways to use this:\n'
          + '  `!translate sw hello there` — text right in the command\n'
          + '  `!translatelang` — every language the bot knows, grouped by region\n'
          + '_(Reply-to translation is not supported: ws3-fca does not pass the replied-to body to the handler.)_',
          event.messageID,
        );
        return;
      }
      if (!lang) {
        await reply('❌ Usage: `!translate <lang> <text>`\nExample: `!translate hi hello there`\nOr `!translatelang` for the full list.', event.messageID);
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
      await reply(`🌐 **${lang.toUpperCase()}**\n· · · · · · ·\n${out}`, event.messageID);
    }),
  });

  commands.push({
    name: 'translatelang',
    aliases: ['langs', 'supportedlanguages', 'trlangs'],
    category: 'downloader',
    description: '🌐 Every language `!translate` knows, grouped by region',
    usage: '!translatelang',
    cooldown: 10,
    permission: 'all',
    execute: async ({ reply, react, event }) => guard(reply, event.messageID, 'translatelang', async () => {
      await react('🌐');
      const list = await askGroq(
        'List the languages you can translate into, grouped by region (Africa, Asia, Europe, Americas, Oceania). '
        + 'For each region give 6-8 common ones with their native script name. '
        + 'End with a one-line note that the bot keeps slang and insults intact.',
        'Style: a clean grouped list, no preamble.',
      );
      await reply(`🌐 **TRANSLATION LANGUAGES**\n· · · · · · ·\n${list}\n\n📖 \`!translate <lang> <text>\` — e.g. \`!translate sw hello there\``, event.messageID);
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
    name: 'imagine',
    // `gen` and `genimg` are the spellings the retired plain-generator command
    // answered to; this one renders the same picture with the card on top.
    aliases: ['imagineultra', 'dream', 'gen', 'genimg'],
    category: 'downloader',
    description: '🖼️ The image generator — Groq writes the prompt, the render lands on a card',
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

      await reply(`🖼️ **IMAGINED**\n· · · · · · ·\n📝 ${clean}\n\n${thought}\n\n🖼️ ${url}`, event.messageID);
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
          body: `🔍 **UPSCALED 2x**\n· · · · · · ·\n${read}\n\n📐 ${shot.width}x${shot.height}`,
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
          body: `🔬 **UPSCALED 4x**\n· · · · · · ·\n${read}\n\n📐 ${shot.width}x${shot.height}`,
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
          body: `✨ **ENHANCED**\n· · · · · · ·\n🎛️ ${fix} x${strength}\n\n${plan}`,
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
            + `· · · · · · ·\n${subject}\n\n${honest}`,
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
    aliases: ['scores', 'livenow'],
    category: 'football',
    description: '⚽ Football right now — live scorelines first, then the next fixtures',
    usage: '!football',
    hint: 'Shows what is live at this second. When nothing is live it shows the next fixtures instead, so it is never an empty answer.',
    cooldown: 15,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'football', async () => {
      await react('⚽');

      // Live first, then the day's fixtures.
      //
      // The old command asked for live matches and nothing else, so on any
      // ordinary Tuesday afternoon it had nothing to say — and it said that
      // AFTER taking the fee. The fixtures are the answer people actually
      // want most of the time, so they are the fallback rather than an
      // apology.
      const live = await footballData('livescore');
      const liveRows = live.data || [];
      const upcoming = await footballData('fixtures');
      const fixtureRows = upcoming.data || [];

      if (!footballHasData(liveRows) && !footballHasData(fixtureRows)) {
        await reply(
          '⚽ **NOTHING TO SHOW**\n'
          + '· · · · · · ·\n'
          + 'No live matches and no fixtures came back from the feeds.\n'
          + '📖 The free football feeds go down more often than they admit. Nothing was charged for this.',
          event.messageID,
        );
        return;
      }

      // Charge only now, and only for what is actually on offer. There is
      // something to read, so there is something to pay for.
      const paid = await charge(userDoc, FEES.football, 'downloader:football');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const liveBlock = footballSummary(liveRows, 8);
      const fixtureBlock = footballSummary(fixtureRows, 6);
      const sections = [];
      if (liveBlock) sections.push(`🔴 **LIVE NOW**\n· · · · · · ·\n${liveBlock}`);
      if (fixtureBlock) {
        sections.push(`📅 **NEXT UP**\n· · · · · · ·\n${fixtureBlock}`);
      }
      const facts = sections.join('\n\n');

      // Groq adds the colour. It is optional: if it does not answer, the
      // scorelines above still stand on their own.
      const read = await askGroqQuiet(
        `Here are the current football matches and next fixtures: ${facts}. `
        + `In three sentences, say who is winning, what the story is, and who to watch. `
        + `If the live list is empty, talk about the fixtures instead.`,
        'Style: a commentator who has seen the numbers.',
      );

      await reply(
        `⚽ **FOOTBALL**\n`
        + '· · · · · · ·\n'
        + `${facts}\n\n`
        + (read ? `${read}\n\n` : '')
        + `💸 ${kc(FEES.football)}`
        + `${live.source ? `\n📡 ${live.source}` : ''}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'livefootball',
    aliases: ['livefix', 'livescores', 'livescore'],
    category: 'football',
    description: '🔴 Live football in one league — the scorelines, filtered locally',
    usage: '!livefootball <league>',
    hint: 'EPL, Premier League, La Liga, Serie A, Bundesliga — the league name is matched locally, so it costs nothing to ask.',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'livefootball', async () => {
      await react('🔴');
      const league = args.join(' ').trim();
      if (!league) {
        await reply('❌ Usage: `!livefootball EPL`\nTry: EPL, Premier League, La Liga, Serie A, Bundesliga', event.messageID);
        return;
      }

      // A table, not an AI. The old command asked Groq to normalise the league
      // name — a paid round trip to spell "EPL" — and then handed the result
      // to a feed that wanted a league id.
      const canon = canonicalLeague(league);

      // Every source is asked, and the filtering happens here on the text all
      // of them agree on, because the feeds disagree about what a league
      // parameter is.
      const { data: rows, source } = await footballData('livescore');
      const mine = (rows || []).filter((r) => matchIsLeague(r, canon));

      if (!footballHasData(mine)) {
        const any = footballSummary(rows, 5);
        await reply(
          `🔴 **NOTHING LIVE IN ${canon.toUpperCase()}**\n`
          + '· · · · · · ·\n'
          + 'No match in that league is on right now.\n'
          + (any ? `\n📡 Live elsewhere:\n${any}\n` : '')
          + '📖 Nothing was charged for this.',
          event.messageID,
        );
        return;
      }

      const paid = await charge(userDoc, FEES.livefootball, 'downloader:livefootball');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const facts = footballSummary(mine, 10);
      const read = await askGroqQuiet(
        `Live ${canon} matches: ${facts}. `
        + `Give the scorelines, who is in control, and the one match worth watching. `
        + `If there is no data, say so.`,
        'Style: urgent, clipped, like a live blog.',
      );
      await reply(
        `🔴 **LIVE ${canon.toUpperCase()}**\n`
        + '· · · · · · ·\n'
        + `${facts}\n\n`
        + (read ? `${read}\n\n` : '')
        + `💸 ${kc(FEES.livefootball)}`
        + `${source ? `\n📡 ${source}` : ''}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'score',
    aliases: ['teamscore', 'whowon'],
    category: 'football',
    description: '📊 One team, one number — their scoreline if it is on, a probability if it is not',
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

      // Look for the team in the feeds BEFORE charging. The old command
      // charged first and then asked a question about data it had not
      // fetched, so a team that was not on the feed cost the person 50
      // K-Cash for a paragraph about a match that does not exist.
      const [live, fixtures] = await Promise.all([
        footballData('livescore'),
        footballData('fixtures'),
      ]);
      const needle = team.toLowerCase();
      const inAll = dedupeMatches([...(live.data || []), ...(fixtures.data || [])]);
      const mine = inAll.filter((r) => {
        const m = normaliseMatch(r);
        return m.home.toLowerCase().includes(needle) || m.away.toLowerCase().includes(needle);
      });

      const paid = await charge(userDoc, FEES.score, 'downloader:score');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      if (!footballHasData(mine)) {
        await reply(
          `📊 **${team.toUpperCase()}**\n`
          + '· · · · · · ·\n'
          + 'That team is not in the live list or the fixture list right now.\n'
          + `📖 The feeds only cover the leagues they cover — try the full club name.`,
          event.messageID,
        );
        return;
      }

      const facts = footballSummary(mine, 5);
      const read = await askGroqQuiet(
        `These are the matches involving "${team}": ${facts}. `
        + `Report the score and who is in control. If it is not on, say the data does not cover them.`,
        'Style: scoreboard voice, then one line of opinion.',
      );
      await reply(
        `📊 **${team.toUpperCase()}**\n`
        + '· · · · · · ·\n'
        + `${facts}\n\n`
        + (read ? `${read}\n\n` : '')
        + `💸 ${kc(FEES.score)}`,
        event.messageID,
      );
    }),
  });

    commands.push({
    name: 'footballnews',
    aliases: ['footballheadlines'],
    category: 'football',
    description: '📰 Football news — the biggest stories, and what they mean',
    usage: '!footballnews',
    cooldown: 20,
    permission: 'all',
    execute: async ({ userDoc, reply, react, event }) => guard(reply, event.messageID, 'footballnews', async () => {
      await react('📰');

      // No free football news API that stays up, so the headlines come from
      // Groq. It is told to write them as summaries rather than fabricating
      // specific transfer fees and quotes.
      const news = await askGroqQuiet(
        `Give the 5 biggest football stories right now. For each: a one line headline and one `
        + `line on why it matters. If you are not certain something is real today, mark it `
        + `"(unverified)" rather than inventing a fee or a quote.`,
        'Style: tabloid energy, honest about uncertainty.',
      );

      // Charge only for an answer. The old order took the fee first and then
      // found out that Groq was not answering, so a person paid 50 K-Cash for
      // an offline notice.
      if (!news) {
        await reply(
          '📰 **NO HEADLINES RIGHT NOW**\n'
          + '· · · · · · ·\n'
          + 'The AI that writes the headlines is not answering, and there is no free feed to fall back on.\n'
          + '📖 Nothing was charged for this.',
          event.messageID,
        );
        return;
      }

      const paid = await charge(userDoc, FEES.footballnews, 'downloader:footballnews');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }
      await reply(
        `📰 **FOOTBALL NEWS**\n`
        + '· · · · · · ·\n'
        + `${news}\n`
        + `💸 ${kc(FEES.footballnews)}`,
        event.messageID,
      );
    }),
  });

    commands.push({
    name: 'matchpredict',
    aliases: ['predict', 'predictmatch'],
    category: 'football',
    description: '🔮 "Real vs Barca" — a winner, the percentages, and the reasoning',
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

      const read = await askGroqQuiet(
        `Predict: ${fixture}. Give win/draw/loss percentages that add to 100, then 3 short `
        + `reasons, then one "dark horse" line. Base it on form and squad strength, `
        + `and say it is a prediction, not a fact.`,
        'Style: pundit who wants to be right and admits he might not be.',
      );
      if (!read) {
        await reply(
          `🔮 **NO PREDICTION**\n`
          + '· · · · · · ·\n'
          + 'The predictor is not answering right now, and a prediction with no numbers behind it '
          + 'is just an opinion with a fee attached.\n'
          + '📖 Nothing was charged for this.',
          event.messageID,
        );
        return;
      }

      const paid = await charge(userDoc, FEES.matchpredict, 'downloader:matchpredict');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

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
      await reply(
        `🔮 **${fixture.toUpperCase()}**\n`
        + '· · · · · · ·\n'
        + `${read}\n`
        + `💸 ${kc(FEES.matchpredict)}`,
        event.messageID,
      );
    }),
  });

  // ── FOOTBALL FIXTURES & PREDICTIONS ─────────────────────────
  // The top of every league, and the teams that can win their next match.
  // Both come from the same standings feed, so one fetch serves two
  // commands and neither has to know which host answered.

    commands.push({
    name: 'nextwinner',
    aliases: ['nextmatch', 'nextwin', 'whothenext'],
    category: 'football',
    description: '⚡ Who wins next — the fixtures, and the ones that are already decided',
    usage: '!nextwinner <league>',
    hint: 'Looks at the next fixture for every team in the league and says which ones are effectively decided.',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'nextwinner', async () => {
      await react('⚡');
      const league = args.join(' ').trim();
      if (!league) {
        await reply('❌ Usage: `!nextwinner Premier League`', event.messageID);
        return;
      }
      const canon = canonicalLeague(league);
      const { data: rows, source } = await footballData('fixtures');
      const mine = (rows || []).filter((r) => matchIsLeague(r, canon));

      if (!footballHasData(mine)) {
        await reply(
          `⚡ **NO FIXTURES FOR ${canon.toUpperCase()}**\n`
          + '· · · · · · ·\n'
          + 'The feed did not have any fixtures for that league.\n'
          + '📖 Nothing was charged for this.',
          event.messageID,
        );
        return;
      }

      const paid = await charge(userDoc, FEES.nextwinner, 'downloader:nextwinner');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const facts = footballSummary(mine, 10);
      const read = await askGroqQuiet(
        `Here are the next fixtures for ${canon}: ${facts}. `
        + `Name the teams that can win their next match and the ones that cannot, `
        + `and say which of the "can win" ones are actually sure things. `
        + `If there are no fixtures, say so.`,
        'Style: short, punchy, like a runner-up bulletin.',
      );
      await reply(
        `⚡ **NEXT WINNERS — ${canon.toUpperCase()}**\n`
        + '· · · · · · ·\n'
        + `${facts}\n\n`
        + (read ? `${read}\n\n` : '')
        + `💸 ${kc(FEES.nextwinner)}`
        + `${source ? `\n📡 ${source}` : ''}`,
        event.messageID,
      );
    }),
  });

    commands.push({
    name: 'teaminfo',
    aliases: ['team', 'squad'],
    category: 'football',
    description: '🛡️ One club, one card — the badge, the league and the squad',
    usage: '!teaminfo <team>',
    hint: 'The badge URL is sent as the picture when the feed has one, so the card looks like the club.',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'teaminfo', async () => {
      await react('🛡️');
      const team = args.join(' ').trim();
      if (!team) {
        await reply('❌ Usage: `!teaminfo Liverpool`', event.messageID);
        return;
      }

      // No AI for the name. The old command asked Groq to canonicalise a club
      // name, which is a lookup table wearing a network round trip.
      const { data: rows, source } = await footballData('team', team);
      const list = rows || [];
      const badge = list[0] && (list[0].strTeamBadge || list[0].badge || list[0].logo);

      if (!footballHasData(list)) {
        await reply(
          `🛡️ **${team.toUpperCase()}**\n`
          + '· · · · · · ·\n'
          + 'The feed does not know that club.\n'
          + '📖 Try the full name — "Real Madrid CF" rather than "Real".',
          event.messageID,
        );
        return;
      }

      const paid = await charge(userDoc, FEES.teaminfo, 'downloader:teaminfo');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const read = await askGroqQuiet(
        `Here is everything the football feeds know about ${team}: ${JSON.stringify(list)}. `
        + `Give the league, the stadium, the manager, the star player, and one line on their style of play. `
        + `If the feed had nothing, say so and talk about the club from general knowledge, labelled as such.`,
        'Style: club programme voice, warm and specific.',
      );
      // The fallback is the feed's own record, not a blank line. Everything
      // below is a fact the feed gave us, so the card is worth sending even
      // when the AI that usually writes the prose is not answering.
      const first = list[0] || {};
      const facts = [
        first.strTeam ? `🏷️ ${first.strTeam}` : null,
        first.strLeague ? `🏆 ${first.strLeague}` : null,
        first.strStadium || first.strVenue ? `🏟️ ${first.strStadium || first.strVenue}` : null,
        first.strCountry ? `🌍 ${first.strCountry}` : null,
        first.strDescription || first.strTeamDescription
          ? `📖 ${String(first.strDescription || first.strTeamDescription).slice(0, 300)}`
          : null,
      ].filter(Boolean).join('\n');
      await sendPhoto({
        reply,
        messageID: event.messageID,
        url: badge,
        body: `🛡️ **${team.toUpperCase()}**\n`
          + '· · · · · · ·\n'
          + (read ? `${read}\n\n${facts}` : facts || `${list.length} record(s) from the feed.`)
          + `\n💸 ${kc(FEES.teaminfo)}`
          + `${source ? `\n📡 Data from ${source}.` : ''}`,
        title: team,
      });
    }),
  });

    commands.push({
    name: 'fixtures',
    aliases: ['fix', 'schedule', 'nextgames'],
    category: 'football',
    description: '📅 The next batch of fixtures — the list, and the two that matter',
    usage: '!fixtures <league>',
    cooldown: 15,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'fixtures', async () => {
      await react('📅');
      const league = args.join(' ').trim();
      if (!league) {
        await reply('❌ Usage: `!fixtures Premier League`', event.messageID);
        return;
      }
      const canon = canonicalLeague(league);
      const { data: rows, source } = await footballData('fixtures');
      const mine = (rows || []).filter((r) => matchIsLeague(r, canon));

      if (!footballHasData(mine)) {
        await reply(
          `📅 **NO FIXTURES FOR ${canon.toUpperCase()}**\n`
          + '· · · · · · ·\n'
          + 'The feed did not have any fixtures for that league.\n'
          + '📖 Nothing was charged for this.',
          event.messageID,
        );
        return;
      }

      const paid = await charge(userDoc, FEES.fixtures, 'downloader:fixtures');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const facts = footballSummary(mine, 12);
      const read = await askGroqQuiet(
        `Here are the next fixtures for ${canon}: ${facts}. `
        + `List them in order, and call out the two that could change the title race. `
        + `If there are no fixtures, say so.`,
        'Style: fixture list, then one line of genuine interest.',
      );
      await reply(
        `📅 **${canon.toUpperCase()}**\n`
        + '· · · · · · ·\n'
        + `${facts}\n\n`
        + (read ? `${read}\n\n` : '')
        + `💸 ${kc(FEES.fixtures)}`
        + `${source ? `\n📡 ${source}` : ''}`,
        event.messageID,
      );
    }),
  });

  // ── FOOTBALL SUBSCRIPTIONS ────────────────────────────────
  // Follow a team and get a goal alert in this chat the moment they score.
  // The commands are free (no fee) because the value is in the alerts, and the
  // ticker is what does the work: it asks the feeds every few minutes and
  // posts only when a subscribed team's score moves.

  commands.push({
    name: 'follow',
    aliases: ['sub', 'subscribe', 'track'],
    category: 'football',
    description: '🔔 Follow a club — get a goal alert in this chat when they score',
    usage: '!follow <team> | !follow off <team> | !follow list',
    hint: 'Free. The alerts are the point, so the command does not charge.',
    cooldown: 5,
    permission: 'all',
    execute: async ({ args, event, reply, react, api }) => guard(reply, event.messageID, 'follow', async () => {
      await react('🔔');
      const group = await footballGroup(event, api);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const sub = ensureFootball(group);
      const first = String(args[0] || '').toLowerCase();
      if (!first || first === 'list') {
        const list = sub.subscriptions || [];
        if (!list.length) {
          await reply('🔔 **FOLLOWING NOTHING**\n· · · · · · ·\n`!follow Liverpool` to get goal alerts here.', event.messageID);
          return;
        }
        await reply(
          `🔔 **FOLLOWING ${list.length}**\n· · · · · · ·\n`
          + list.map((t, i) => `${i + 1}. ${t}`).join('\n')
          + `\n📖 \`!follow off <team>\` to stop one.`,
          event.messageID,
        );
        return;
      }
      if (first === 'off' || first === 'unsub' || first === 'unfollow') {
        const team = args.slice(1).join(' ').trim();
        if (!team) {
          await reply('❌ Usage: `!follow off Liverpool`', event.messageID);
          return;
        }
        const idx = sub.subscriptions.findIndex((t) => t.toLowerCase() === team.toLowerCase());
        if (idx < 0) {
          await reply(`🔔 You are not following \`${team}\`.`, event.messageID);
          return;
        }
        sub.subscriptions.splice(idx, 1);
        await group.save();
        await reply(`🔔 Stopped following **${team}**.`, event.messageID);
        return;
      }
      const team = args.join(' ').trim();
      if (sub.subscriptions.some((t) => t.toLowerCase() === team.toLowerCase())) {
        await reply(`🔔 Already following **${team}**.`, event.messageID);
        return;
      }
      sub.subscriptions.push(team);
      sub.on = true;
      await group.save();
      await reply(
        `🔔 **FOLLOWING ${team}**\n· · · · · · ·\n`
        + `Goal alerts fire in this chat the moment they score. `
        + `${sub.subscriptions.length} club${sub.subscriptions.length === 1 ? '' : 's'} total.`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'alerts',
    aliases: ['alertstatus', 'footbalalerts'],
    category: 'football',
    description: '🔔 What the football ticker is watching in this chat',
    usage: '!alerts',
    cooldown: 5,
    permission: 'all',
    execute: async ({ args, event, reply, react, api }) => guard(reply, event.messageID, 'alerts', async () => {
      await react('🔔');
      const group = await footballGroup(event, api);
      if (!group) {
        await reply('❌ The city grid is offline. Try again shortly.', event.messageID);
        return;
      }
      const sub = ensureFootball(group);
      const list = sub.subscriptions || [];
      const last = sub.lastScore || {};
      const lastLine = last.team
        ? `🔔 Last alert: **${last.team}** ${last.score || ''} in ${last.league || 'unknown league'}`
        : '🔔 No alert has fired yet.';
      if (!list.length) {
        await reply(
          `🔔 **NO ALERTS**\n· · · · · · ·\n${lastLine}\n📖 \`!follow <team>\` to start getting goal calls here.`,
          event.messageID,
        );
        return;
      }
      await reply(
        `🔔 **ALERTS ${sub.on ? 'ON' : 'OFF'}**\n· · · · · · ·\n`
        + `${list.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`
        + `${lastLine}\n`
        + `📖 \`!follow off <team>\` stops one. To stop every alert here, remove the clubs.`,
        event.messageID,
      );
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
      await reply(`🏏 **CRICKET**\n· · · · · · ·\n${read}\n💸 ${kc(FEES.cricketscore)}`, event.messageID);
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
      await reply(`🌍 **THE WORLD**\n· · · · · · ·\n${read}\n💸 ${kc(FEES.newsai)}`, event.messageID);
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
      await reply(`📋 **THE SHORT VERSION**\n· · · · · · ·\n${brief}\n💸 ${kc(FEES.summarize)}`, event.messageID);
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
      await reply(`✍️ **${mode.toUpperCase()}**\n· · · · · · ·\n${out}`, event.messageID);
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
      await reply(`📖 **${topic.toUpperCase()}**\n· · · · · · ·\n${story}`, event.messageID);
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
        `🧑‍💻️ **CODE REVIEW**\n· · · · · · ·\n${review}\n💸 ${kc(FEES.codeai)}`,
        event.messageID,
      );
    }),
  });

  commands.push({
    name: 'songai',
    aliases: ['writesong'],
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
        body: `🎵 **${topic.toUpperCase()}**\n· · · · · · ·\n${song}\n💸 ${kc(FEES.songai)}`,
      });
    }),
  });


  commands.push({
    name: 'downloadcard',
    aliases: ['dlstatus', 'dlstats'],
    category: 'downloader',
    description: '📥 Render the downloader status as a picture — supported sites',
    usage: '!downloadcard',
    cooldown: 60,
    permission: 'all',
    execute: async ({ api, event, reply, react, userDoc }) => guard(reply, event.messageID, 'downloadcard', async () => {
      await react('📥');
      const rows = [
        ['YouTube', 'audio + video'],
        ['TikTok', 'no watermark'],
        ['Instagram', 'posts + reels'],
        ['X / Twitter', 'videos + images'],
        ['Pinterest', 'six pictures'],
      ];
      const card = await cards.userCard({
        emoji: '📥', title: 'DOWNLOADER', subtitle: 'six sites, one command', api,
        user: { uid: userDoc.uid, name: userDoc.name, level: userDoc.level, xp: userDoc.xp },
        rows,
      });
      if (card) {
        await reply({ body: '📥 **DOWNLOADER**\n· · · · · · ·\nSix sites, one command', attachment: { type: 'image', data: { url: card } } }, event.messageID);
        return;
      }
      await reply('📥 **DOWNLOADER**\n· · · · · · ·\n📖 Canvas unavailable — text fallback', event.messageID);
    }),
  });


  // ───────────────────────────────────────────────────────────
  // BOT PERSONA — language
  //
  // `!setlang` writes to the hunter document, not a global config, because
  // "the bot sounds like this" is a per-hunter decision: a hunter who sets
  // Spanish in one group should not be speaking Spanish in another.
  // ───────────────────────────────────────────────────────────

  commands.push({
    name: 'setlang',
    aliases: ['lang', 'setlanguage'],
    category: 'downloader',
    description: '🌐 Set the language the bot answers you in, or show what it is',
    usage: '!setlang <lang> | !setlang off',
    cooldown: 10,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'setlang', async () => {
      await react('🌐');
      const want = String(args.join(' ') || '').trim().toLowerCase();
      if (!want) {
        await reply(
          `🌐 **YOUR LANGUAGE**\n`
          + '· · · · · · ·\n'
          + `Current: \`${userDoc.lang || 'en'}\`\n`
          + '📖 Try `!setlang es`, `!setlang fr`, `!setlang ar`, or `!setlang off`.',
          event.messageID,
        );
        return;
      }

      if (/^(off|reset|none|default|en)$/i.test(want)) {
        userDoc.lang = 'en';
        await save(userDoc);
        await reply('🌐 Language reset — the bot answers in English again.', event.messageID);
        return;
      }

      // Groq speaks hundreds of languages. Rather than gate on a whitelist we
      // ask it to confirm the code is a real language, so `!setlang klingon`
      // gets an honest answer instead of silently being stored.
      const check = await askGroq(
        `Is "${want}" a real human language? Answer ONLY with the two-letter ISO code `
        + `if it is (lowercase), or the word "no" if it is not.`,
        'Style: one word, no punctuation, no commentary.',
        userDoc.lang || 'en',
      );
      const code = String(check || '').trim().toLowerCase().match(/^[a-z]{2}$/);
      if (!code) {
        await reply(`🌐 \`${want}\` is not a language I recognised. Try a two-letter code like \`es\` or \`de\`.`, event.messageID);
        return;
      }

      userDoc.lang = code[0];
      await save(userDoc);
      await reply(`🌐 Done — the bot will answer you in ${code[0]} from now on.`, event.messageID);
    }),
  });

  // ───────────────────────────────────────────────────────────
  // PRICES — money that moves while you are not looking
  // ───────────────────────────────────────────────────────────
  commands.push({
    name: 'crypto',
    aliases: ['coinprice', 'cryptoprice'],
    category: 'downloader',
    description: '🪙 Crypto prices — `!crypto btc` for one coin, `!crypto` for the top ten',
    usage: '!crypto [symbol]',
    hint: 'Straight from the market feed, with the 24-hour change and the market cap. No advice, just the number.',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'crypto', async () => {
      await react('🪙');
      const want = String(args[0] || '').trim().toLowerCase();

      // The fee is the point: this command is a query against somebody else's
      // API, and a bot that lets anybody use it as a free price feed is a
      // bot that gets its host's key rate-limited.
      const paid = await charge(userDoc, FEES.crypto, 'downloader:crypto');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const id = CRYPTO_IDS[want];
      if (want && !id) {
        await reply(
          `❌ I do not know \`${want}\`.\n`
          + '· · · · · · ·\n'
          + `📖 I know ${Object.keys(CRYPTO_IDS).slice(0, 18).join(', ')} and a few more. \`!crypto\` alone lists the top ten.`,
          event.messageID,
        );
        return;
      }

      if (id) {
        // One coin: three sources in order, and the receipt names the one that
        // answered. A price with no market cap is still a price.
        const quote = await cryptoQuote(want.toUpperCase(), id);
        if (!quote) {
          await reply('📡 The market feed did not answer. Try again in a moment.', event.messageID);
          return;
        }
        const change = Number(quote.change);
        await reply(
          `🪙 **${String(quote.name || '').toUpperCase()} (${String(quote.symbol || '').toUpperCase()})**\n`
          + '· · · · · · ·\n'
          + `💵 ${usd(quote.price)}\n`
          + `📈 24h: ${Number.isFinite(change) ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '—'}\n`
          + (Number.isFinite(quote.cap) ? `🏦 Market cap: ${usd(quote.cap)}\n` : '')
          + (quote.rank ? `📊 Rank: #${quote.rank}\n` : '')
          + `📡 Price from ${quote.source}\n`
          + `💸 Fee: ${kc(FEES.crypto)}`,
          event.messageID,
        );
        return;
      }

      // The top ten is a ranking, and only CoinGecko can rank. If it will not
      // answer, the honest reply is that the board is down — not a list of ten
      // coins invented from whatever else happened to answer.
      const data = await fetchJson(
        'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1&price_change_percentage=24h',
      );
      if (!Array.isArray(data) || !data.length) {
        await reply(
          '📡 The ranking feed did not answer, and only one feed knows the order.\n'
          + '· · · · · · ·\n'
          + '📖 `!crypto btc` still works — that one has two more feeds behind it.',
          event.messageID,
        );
        return;
      }

      const lines = data.map((c, i) => {
        const change = Number(c.price_change_percentage_24h);
        const arrow = !Number.isFinite(change) ? '·' : (change >= 0 ? '▲' : '▼');
        const pct = Number.isFinite(change) ? `${change.toFixed(2)}%` : '—';
        return `${i + 1}. ${String(c.symbol || '').toUpperCase()} ${usd(c.current_price)} ${arrow} ${pct}`;
      });
      await reply(
        `🪙 **THE TOP TEN**\n`
        + '· · · · · · ·\n'
        + `${lines.join('\n')}\n`
        + '📡 Ranked by CoinGecko\n'
        + `💸 Fee: ${kc(FEES.crypto)}\n`
        + '📖 `!crypto btc` for one coin.',
        event.messageID,
      );
    }),
  });

  // ───────────────────────────────────────────────────────────
  // CURRENCY
  // ───────────────────────────────────────────────────────────
  commands.push({
    name: 'currency',
    aliases: ['convert', 'fx', 'forex'],
    category: 'downloader',
    description: '💱 Convert money — `!currency 100 usd kes`',
    usage: '!currency [amount] <from> <to>',
    hint: 'Live rates, refreshed hourly. No argument shows the majors against the dollar.',
    cooldown: 20,
    permission: 'all',
    execute: async ({ args, userDoc, reply, react, event }) => guard(reply, event.messageID, 'currency', async () => {
      await react('💱');
      const paid = await charge(userDoc, FEES.currency, 'downloader:currency');
      if (!paid.ok) {
        await reply(paid.reason, event.messageID);
        return;
      }

      const table = await fxRates();
      if (!table) {
        await reply('📡 The rates desk did not answer. Try again in a moment.', event.messageID);
        return;
      }

      // "!currency 100 usd kes" — the amount is optional, the codes are not.
      const list = args.map((a) => String(a).trim()).filter(Boolean);
      let amount = 1;
      if (list.length && Number.isFinite(Number(list[0]))) amount = Number(list.shift());
      const from = String(list[0] || 'USD').toUpperCase();
      const to = String(list[1] || '').toUpperCase();

      if (!to) {
        const majors = ['EUR', 'GBP', 'KES', 'NGN', 'ZAR', 'INR', 'JPY', 'AUD', 'CAD', 'GHS'];
        const lines = majors
          .filter((c) => table.rates[c])
          .map((c) => `• 1 USD = ${Number(table.rates[c]).toFixed(4)} ${c}`);
        await reply(
          `💱 **THE MAJORS**\n`
          + '· · · · · · ·\n'
          + `${lines.join('\n')}\n`
          + `🕐 Rates from ${table.updated || 'the last refresh'}\n`
          + '📖 `!currency 100 usd kes` to convert.\n'
          + `💸 Fee: ${kc(FEES.currency)}`,
          event.messageID,
        );
        return;
      }

      if (!table.rates[from] || !table.rates[to]) {
        await reply(
          `❌ I do not have a rate for that pair.\n`
          + '· · · · · · ·\n'
          + `📖 Use three-letter codes: \`USD\`, \`KES\`, \`EUR\`, \`GBP\`, \`NGN\`, \`ZAR\`.`,
          event.messageID,
        );
        return;
      }

      // The table is against the dollar, so the pair goes through it.
      const value = (amount * (table.rates[to] / table.rates[from]));
      await reply(
        `💱 **${amount} ${from} = ${value.toFixed(2)} ${to}**\n`
        + '· · · · · · ·\n'
        + `💵 1 ${from} = ${(table.rates[to] / table.rates[from]).toFixed(4)} ${to}\n`
        + `🕐 Rates from ${table.updated || 'the last refresh'}\n`
        + `💸 Fee: ${kc(FEES.currency)}`,
        event.messageID,
      );
    }),
  });

  module.exports = commands;

/**
 * The football ticker. Attached to the commands array rather than a separate
 * module so the loader's `Array.isArray` check still passes and the engine can
 * reach it as `require('./cmds_8').football`.
 *
 * It is the thing that makes `!follow` worth anything: the commands store the
 * subscriptions, and this asks the feeds every few minutes and posts to a chat
 * the moment a subscribed team's score moves. Without it `!follow` is just a
 * list, and with it the bot answers a goal before the room refreshes the app.
 *
 * @param {object} api ws3-fca client
 * @returns {Promise<number>} chats that got an alert
 */
async function footballTick(api) {
  if (!api || !mongo.isReady()) return 0;
  const Group = require('../models/Group');
  const groups = await Group.find({ 'football.on': true }).catch(() => []);
  let posted = 0;
  for (const group of groups) {
    const sub = ensureFootball(group);
    const list = sub.subscriptions || [];
    if (!list.length) continue;
    // eslint-disable-next-line no-await-in-loop
    const { data } = await footballData('livescore');
    for (const row of data) {
      const name = String(row.strHomeTeam || row.strAwayTeam || row.homeTeam || row.awayTeam || '').trim();
      if (!name) continue;
      const match = list.find((t) => name.toLowerCase() === String(t).toLowerCase());
      if (!match) continue;
      const home = Number(row.intHomeScore || row.homeScore || 0);
      const away = Number(row.intAwayScore || row.awayScore || 0);
      if (home === 0 && away === 0) continue; // not a goal, just a fixture
      const league = row.strLeague || row.league || 'unknown league';
      const key = `${name}|${league}|${home}-${away}`;
      const prev = sub.lastScore && sub.lastScore.key;
      if (prev === key) continue; // already announced this exact score
      sub.lastScore = { team: name, score: `${home}-${away}`, league, key };
      try {
        await group.save();
      } catch { /* the alert still goes out */ }
      try {
        await api.sendMessage(
          `⚽ **GOAL ALERT — ${name}**\n`
          + `· · · · · · ·\n`
          + `${row.strHomeTeam || 'Home'} ${home} - ${away} ${row.strAwayTeam || 'Away'}\n`
          + `🏆 ${league}`,
          String(group.tid),
        );
        posted += 1;
      } catch (err) {
        error(`[FOOTBALL] alert failed for ${group.tid}: ${err.message}`);
      }
    }
  }
  return posted;
}

commands.football = { tick: footballTick, ensure: ensureFootball, group: footballGroup };
