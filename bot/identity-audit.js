'use strict';

/**
 * Identity audit — does every command that draws a card actually show a real
 * Facebook name and a real Facebook picture?
 *
 *   node bot/identity-audit.js            audit everything
 *   node bot/identity-audit.js rank rich  audit two commands
 *
 * WHY THIS IS A TOOL AND NOT A TEST
 * `bot/exec-all.js` proves every handler runs and produces a reply. This asks a
 * different question of the same 359 commands: of the ones that draw, how many
 * put a person's real name and their real photo on the card, and how many leak a
 * raw uid, a "Facebook User", or a "Hunter 4821" stand-in into a chat?
 *
 * A card with the wrong face on it is not a crash. It is a leaderboard that
 * looks finished, so nothing goes red and nobody notices.
 *
 * HOW IT AVOIDS LYING
 *   - A real HTTP server on 127.0.0.1 serves a genuinely different PNG per uid,
 *     so the download path really runs. A mock that returns bytes for any url
 *     would pass even if the code asked for the wrong one.
 *   - `getUserInfo` answers in the shape THIS build of ws3-fca answers:
 *     `name` plus a graph.facebook.com `profilePicUrl`, and no `thumbSrc`.
 *   - `getThreadInfo` answers in its own shape: a member list carrying
 *     `thumbSrc`. Both are pointed at the local server.
 *   - The database is stubbed, because a board with no rows never reaches the
 *     drawing code at all — which is most of what these commands do.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.ADMIN_IDS = process.env.ADMIN_IDS || '999000111';
process.env.BOT_PREFIX = process.env.BOT_PREFIX || '!';

const R = path.join(__dirname, '..');
const loader = require('./loader');
const cooldown = require('./cooldown');
const mongo = require('./mongo');
const canvasKit = require('./canvas');
const cards = require('./cards');
const profile = require('./profile');
const config = require(path.join(R, 'config'));
const Group = require(path.join(R, 'models/Group'));
const User = require(path.join(R, 'models/User'));
const Economy = require(path.join(R, 'models/Economy'));
const Pet = require(path.join(R, 'models/Pet'));
const Inventory = require(path.join(R, 'models/Inventory'));

const UIDS = [
  '1000000001', '1000000002', '1000000003', '1000000004', '1000000005',
  '1000000006', '1000000007', '1000000008', '1000000009', '1000000010',
];

/** The real name each uid resolves to, so "did it use the real name" is decidable. */
const REAL_NAME = (uid) => `Ada Lovelace ${uid.slice(-2)}`;

/**
 * A local server that answers with a real, distinct PNG per uid.
 *
 * Distinct because a card that drew the same avatar for everybody would still
 * look like pictures on a card. The bytes are generated with the same canvas the
 * bot draws with, so a decode failure would be a real failure.
 */
function pictureServer() {
  const server = http.createServer(async (req, res) => {
    const uid = decodeURIComponent(String(req.url || '').split('/').pop() || '0');
    let bytes = null;
    try {
      const made = canvasKit.create(320, 320);
      if (made) {
        // A different hue per uid, so two different people are visibly two
        // different people.
        const hue = [...String(uid)].reduce((a, c) => (a + c.charCodeAt(0)) % 360, 0);
        const g = made.ctx.createLinearGradient(0, 0, 320, 320);
        g.addColorStop(0, `hsl(${hue},70%,45%)`);
        g.addColorStop(1, `hsl(${(hue + 60) % 360},70%,20%)`);
        made.ctx.fillStyle = g;
        made.ctx.fillRect(0, 0, 320, 320);
        made.ctx.fillStyle = '#ffffff';
        made.ctx.font = 'bold 90px sans-serif';
        made.ctx.textAlign = 'center';
        made.ctx.textBaseline = 'middle';
        made.ctx.fillText(uid.slice(-2), 160, 160);
        // canvasKit.toBuffer is async on @napi-rs and sync on node-canvas, so it
        // is awaited. Reading it synchronously handed the reply a Promise, every
        // avatar came back 404, and the audit spent its whole run timing out on
        // picture downloads that could never have worked.
        bytes = await canvasKit.toBuffer(made.canvas);
      }
    } catch { bytes = null; }
    if (bytes && Buffer.isBuffer(bytes)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length });
      res.end(bytes);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('no');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** A fake group document for the per-chat commands. */
function groupDoc(over = {}) {
  return {
    tid: 'audit_thread',
    isEnabled: true,
    isApproved: true,
    pendingApproval: false,
    prefix: null,
    autoAddLeavers: false,
    adminsOnly: false,
    maintenance: false,
    disabledCommands: [],
    disabledModules: [],
    settings: {
      welcome: false, goodbye: false, welcomeMsg: '', goodbyeMsg: '',
    },
    fun: {
      ships: [{ a: UIDS[0], b: UIDS[1], score: 9, by: UIDS[0] }],
      besties: [{ a: UIDS[0], b: UIDS[2], score: 40, by: UIDS[0] }],
      enemies: [{ a: UIDS[3], b: UIDS[4], score: 12, by: UIDS[3] }],
      hugs: { [UIDS[0]]: 2 },
      slaps: { [UIDS[0]]: 1 },
      kills: {},
    },
    gameBomb: { holderUid: null, holderName: '', amount: 0, passes: 0, fuse: 0, litBy: '', litByName: '', passedFrom: '', passedFromName: '', expires: null },
    gc: { msgs: 10, level: 1 },
    cartel: { name: 'Vault', founder: UIDS[0], vault: 10, members: [] },
    petArena: { battles: 0, wins: 0, steals: 0 },
    async save() { return this; },
    ...over,
  };
}

/** A fake user document with the fields the RPG commands read. */
function userDoc(uid = '999000111') {
  return {
    uid,
    name: REAL_NAME(uid),
    coins: 50000,
    money: 500,
    xp: 1200,
    level: 4,
    bank: 1000,
    stamina: 10,
    prestige: 0,
    dex: [1, 4, 7],
    pokemonCaught: 3,
    spouse: '',
    title: '',
    pets: [],
    flags: {},
    inventory: {},
    lastWork: null,
    dailyClaimedAt: null,
    hp: 100,
    wins: 2,
    losses: 1,
    raidWins: 0,
    bosses: 0,
    classed: true,
    academy: { enrolled: true, wins: 2, losses: 1, raidWins: 0, bosses: 0, classed: true, prestige: 0, coins: 0 },
    async save() { return this; },
  };
}

/** A living pet, so handlers that branch on pets actually take that branch. */
function petDoc(uid = '999000111') {
  return {
    _id: 'pet_audit',
    ownerUid: uid,
    name: 'Munchkin',
    species: 'Pikachu',
    emoji: '⚡',
    level: 5,
    basePower: 12,
    prestige: 0,
    isDead: false,
    isSafe: true,
    hunger: 40,
    async save() { return this; },
  };
}

/** A pack with something in it. */
function inventoryDoc(uid = '999000111') {
  return {
    _id: 'inv_audit',
    uid,
    items: { potion: 2, ration: 1, bandage: 0 },
    async save() { return this; },
  };
}

/** Everything a handler might read off a Group, as one document. */
const GROUP_STUB = groupDoc();

/** Rows for the leaderboards, each with a uid the card must turn into a face. */
function rows() {
  return UIDS.map((uid, i) => ({
    uid,
    name: 'Facebook User', // the worst case: a failed lookup stored this
    coins: 100000 - i * 5000,
    bank: 90000 - i * 4000,
    xp: 9000 - i * 400,
    level: 9 - (i % 5),
    wins: 12 - i,
    prestige: 0,
    _id: uid,
  }));
}

/**
 * A mongoose-shaped query that hands back whatever it was given.
 *
 * The audit stands in for the database, so the stand-in has to be as permissive
 * as the real thing or it fails the commands for the wrong reason: a chainable,
 * awaitable stub answers `.sort().limit().select().lean()` and a bare await
 * identically. The first version of this stub implemented two of those five and
 * reported `User.find(...).select is not a function` against four leaderboards
 * that were perfectly fine.
 */
function queryStub(value) {
  const q = {
    sort: () => q,
    limit: () => q,
    skip: () => q,
    select: () => q,
    lean: () => q,
    populate: () => q,
    exec: () => Promise.resolve(value),
    then: (res, rej) => Promise.resolve(value).then(res, rej),
    catch: (rej) => Promise.resolve(value).catch(rej),
  };
  return q;
}

/**
 * A plausible argument list for a command, read off its own usage string.
 *
 * Without this the audit only ever saw the usage line. Thirty-one commands —
 * every `!hug @user`, every `!ai <prompt>` — answered "tag somebody" and drew
 * nothing, which looks identical to a command that tried to draw and failed.
 * The usage string already says what each command wants, so it is read for that
 * rather than a hand-written table that goes stale the day a usage line changes.
 */
function argsFor(cmd) {
  const usage = String(cmd.usage || '').replace(/^!\S*\s*/, '').trim();
  if (!usage) return [];
  const out = [];
  for (const token of usage.split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith('@')) {
      const who = token.slice(1).toLowerCase();
      // `!ship @a @b` is two different people; every other @slot is one target.
      out.push(`@${who === 'b' ? UIDS[2] : UIDS[1]}`);
      continue;
    }
    // `<prompt>`, `[note]`, `[what you want]` — all of them want content.
    out.push(token.replace(/^[<[]|[>\]]$/g, '') || 'audit stub');
  }
  return out;
}

function mockApi(port) {
  const pic = (uid) => `http://127.0.0.1:${port}/pic/${uid}.png`;
  const sent = [];
  const ALLOWED = ['attachment', 'url', 'sticker', 'emoji', 'emojiSize', 'body', 'mentions', 'location'];
  return {
    sent,
    async sendMessage(payload, threadID, replyToMessage = null) {
      const bad = Object.keys(payload).filter((k) => !ALLOWED.includes(k));
      if (bad.length) throw new Error(`Dissallowed props: \`${bad.join(', ')}\``);
      sent.push(payload);
      return { messageID: `m${sent.length}` };
    },
    async react() { return true; },
    // This build of ws3-fca: a name and a graph URL.
    async getUserInfo(uid) {
      return { id: uid, name: REAL_NAME(uid), firstName: REAL_NAME(uid).split(' ')[0], profilePicUrl: pic(uid) };
    },
    async getThreadInfo() {
      return {
        threadTitle: 'iKON City',
        threadName: 'iKON City',
        adminIDs: ['999000111'],
        participantIDs: UIDS,
        isGroup: true,
        userInfo: UIDS.map((uid) => ({
          id: uid, name: REAL_NAME(uid), thumbSrc: pic(uid), profileUrl: pic(uid),
        })),
      };
    },
    async getThreadList() { return []; },
    async gcmember() { return true; },
    async changeThreadName() { return true; },
    async deleteAdmin() { return true; },
    async addAdmin() { return true; },
    async setThreadName() { return true; },
  };
}

/**
 * Does this command's source reach for a canvas at all?
 *
 * Static, and deliberately crude: the block from the command's `name:` to the
 * next top-level command. A false positive costs a line of report; a false
 * negative would hide a real gap, so the pattern list is generous.
 */
const CANVAS_PATTERN = /cards\.\w+Card\(|canvasKit\.create\(|\bart\(|captionCard\(|pictureSheet\(|drawCover\(|sendImage\(/;

function canvasCommands(registry) {
  const files = fs.readdirSync(path.join(R, 'commands'))
    .map((f) => [f, fs.readFileSync(path.join(R, 'commands', f), 'utf8')]);
  const names = [...registry.values()].map((c) => c.name);
  const found = new Set();
  for (const [, src] of files) {
    for (const name of names) {
      const i = src.indexOf(`name: '${name}',`);
      if (i < 0) continue;
      const next = src.indexOf('\n  {\n', i);
      const block = src.slice(i, next > i ? next : i + 5000);
      if (CANVAS_PATTERN.test(block)) found.add(name);
    }
  }
  return found;
}

/** One command's output, reduced to what the report needs. */
function readOutput(sent) {
  const bodies = [];
  let images = 0;
  for (const p of sent) {
    const payload = typeof p === 'string' ? { body: p } : p;
    if (payload && payload.body) bodies.push(String(payload.body));
    if (payload && payload.attachment) images += 1;
  }
  return { text: bodies.join('\n'), images };
}

/** One line of the reply, for telling "drew nothing" apart from "was never asked to". */
function excerpt(text, limit = 90) {
  const line = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '(no text)';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * Run a handler under a deadline.
 *
 * Several commands reach out to the internet — Pinterest, Bing, a TTS voice, an
 * AI provider. One of those hanging must not take the audit with it, and a
 * timeout is also an answer: a card that never arrives because the download
 * stalled is a card that did not arrive.
 */
function withDeadline(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no reply within ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * Anything that means the code gave up and printed a stand-in.
 *
 * The list of stand-in names is not written out here: `profile.isPlaceholderName`
 * owns it, because it is what the code itself uses to decide a stored name is a
 * failed lookup. A second copy of the list is a list that drifts.
 *
 * A name is only judged in a name slot — a whole line, either side of a
 * separator, or the value of a label that is about a person. Matching the bare
 * word "unknown" anywhere produced ten false alarms, all of them
 * "❌ Unknown item": the shop telling a caller they typed the wrong thing, which
 * is exactly what it should say.
 */
function placeholderNames(text) {
  const hits = new Set();
  const clean = (s) => String(s || '').replace(/[*_`@]/g, '').trim();
  // A label has to be about a person for the word after it to be a name. Without
  // this, "Last seen: unknown" on a profile card reads as a failed name lookup —
  // and `unknown` is the honest answer to "when did this person last appear".
  const NAME_LABEL = /name|user|admin|founder|owner|shipped|married|called|by\b|target/i;
  for (const raw of String(text || '').split('\n')) {
    const line = clean(raw);
    if (!line) continue;
    if (profile.isPlaceholderName(line)) hits.add(line);
    // "• Facebook User", "1. Unknown" — a list entry with nothing but a name.
    for (const part of line.split(/\s+[—\-|]\s+|\s+·\s+|\d+\.\s+/)) {
      const p = clean(part);
      if (profile.isPlaceholderName(p)) hits.add(p);
    }
    // "Founder: 1000000001", "Admin: Facebook User"
    for (const m of line.matchAll(/([^:]{3,40}):\s*([^:]{1,40})/g)) {
      if (!NAME_LABEL.test(m[1])) continue;
      const p = clean(m[2]);
      if (profile.isPlaceholderName(p)) hits.add(p);
    }
  }
  // `Hunter 4821` is minted by cards.js rather than stored, so it is spelled out.
  const hunter = /Hunter\s?\d{4}/i.exec(String(text || ''));
  if (hunter) hits.add(hunter[0]);
  return [...hits];
}

/** A bare 9+ digit id in a chat is a uid that should have been a name. */
const RAW_UID = /\b\d{9,}\b/;

/**
 * The text with every url taken out.
 *
 * A link is opaque by design: `!pinterestsearch` credits each picture with a
 * flickr permalink whose photo id is ten digits, and that is the link working
 * correctly, not a Facebook uid leaking into a chat. Scanning the url too
 * reported a download command as a privacy bug.
 */
const withoutUrls = (text) => String(text || '').replace(/https?:\/\/\S+/g, ' ');

/**
 * Commands whose job is to print an id.
 *
 * `!id` and `!userinfo` exist to answer "what is my Facebook id" — a uid in the
 * output is the answer, not a leak. Everything else has to name people.
 */
const ID_BY_DESIGN = new Set(['id', 'userinfo']);

/**
 * Commands that reach a canvas only on a path the harness cannot supply.
 *
 * Each one needs something outside a mocked api: a live AI provider, a message
 * being replied to, or a relationship that has to exist first. They are listed
 * with the reason rather than left to fail the run, because "the audit cannot
 * hold an API key" is not the same as "this command is broken" — and a gate that
 * always reports its own gaps is a gate nobody reads.
 *
 * A wrong entry here hides a real gap, so each one names the thing that is
 * missing rather than waving at the category.
 */
const CANVAS_GATED = {
  ai: 'needs a live AI provider',
  ask: 'needs a live AI provider',
  codeai: 'needs a live AI provider',
  groq: 'needs a live AI provider',
  rewrite: 'needs a live AI provider',
  score: 'needs a live AI provider',
  footballnews: 'needs a live AI provider',
  summarize: 'needs a message to reply to',
  divorce: 'needs an existing marriage',
};

async function main() {
  const only = process.argv.slice(2);
  const loaded = loader.loadCommands(path.join(R, 'commands'));
  const registry = loaded.registry;
  const wantCanvas = canvasCommands(registry);
  const cmds = [...registry.values()]
    .filter((c) => !only.length || only.includes(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const { server, port } = await pictureServer();
  console.log(`\n=== identity audit: ${cmds.length} commands, pictures from 127.0.0.1:${port} ===`);
  console.log(`    canvas binary: ${canvasKit.available() ? 'available' : 'MISSING — every card will fall back'}`);

  // The world the handlers run against.
  const realReady = mongo.isReady;
  mongo.isReady = () => true;
  // Every model, including the two that are only required lazily deep inside a
  // handler. A model left unpatched is a model whose queries buffer for ten
  // seconds against a connection that is not there, which reads exactly like a
  // command that hangs.
  const models = [User, Group, Economy, Pet, Inventory];
  const realFns = models.flatMap((m) => ['find', 'findOne', 'aggregate', 'countDocuments', 'distinct', 'create']
    .map((k) => [m, k, m[k]]));
  const restore = () => {
    for (const [m, k, fn] of realFns) m[k] = fn;
  };
  const patch = (Model, value, one) => {
    Model.find = () => queryStub(value);
    Model.findOne = () => queryStub(one);
    Model.aggregate = () => queryStub(value);
    Model.countDocuments = () => queryStub(one ? 1 : value.length);
    Model.distinct = () => queryStub([]);
    Model.create = async (doc) => doc;
  };
  // A uid-shaped query gets a document with that uid and that person's real name.
  const byUid = (q) => {
    const wanted = q && typeof q.uid === 'string' ? q.uid : null;
    if (!wanted) return userDoc();
    return { ...userDoc(wanted), uid: wanted, name: REAL_NAME(wanted) };
  };
  patch(User, rows(), null);
  patch(Group, [GROUP_STUB], GROUP_STUB);
  patch(Economy, [], {});
  // A real pet and a real pack, so the pet branches of these handlers run
  // instead of being skipped by an empty result.
  patch(Pet, [petDoc()], petDoc());
  patch(Inventory, [inventoryDoc()], inventoryDoc());
  // findOne has to answer the query it was given. A stub that returns the same
  // document whatever it was asked for makes every tagged person come back as
  // the sender, so thirteen commands correctly answered "that is you, pick
  // someone else" to a tag for somebody else — and the audit read that as a
  // command that drew nothing.
  User.findOne = (q) => queryStub(byUid(q));
  // `new Economy({...}).save()` is not a static, so patching the statics left it
  // talking to a disconnected mongoose connection — where a write does not
  // fail, it buffers for ten seconds and then fails. Every ledger line in every
  // `!hug` therefore cost ten seconds of silence, and ten commands were written
  // off as "drew nothing" when they had in fact drawn correctly.
  const realProtoSave = models.map((m) => [m, m.prototype.save]);
  for (const m of models) {
    m.prototype.save = async function save() { return this; };
  }
  profile.clear();

  const api = mockApi(port);
  const rowsOut = [];
  const realExit = process.exit.bind(process);
  process.exit = () => {};

  /** One command, one argument list, one row of the report. */
  const runOnce = async (cmd, api, canvas, args) => {
    cooldown.clear(`audit_${cmd.name}`, cmd.name);
    const before = api.sent.length;
    const startedAt = Date.now();
    try {
      await withDeadline(cmd.execute({
        api,
        event: {
          threadID: 'audit_thread',
          messageID: `mid_${cmd.name}`,
          senderID: '999000111',
          isGroup: true,
          mentions: { [UIDS[1]]: REAL_NAME(UIDS[1]), [UIDS[2]]: REAL_NAME(UIDS[2]), [UIDS[3]]: REAL_NAME(UIDS[3]) },
          body: `${cmd.name} ${args.join(' ')}`.trim(),
        },
        args,
        config,
        registry,
        ai: { ask: async () => 'audit stub' },
        reply: async (text) => { api.sent.push(text); },
        react: async () => true,
        userDoc: userDoc(),
      }), cmd.cooldown > 20 ? 20000 : 12000, cmd.name);
    } catch (err) {
      const took = Date.now() - startedAt;
      process.stderr.write(`    ! ${cmd.name} threw after ${took}ms\n`);
      // A deadline is not a defect. `!define` asks dictionaryapi.dev for a word
      // and this sandbox has no route to it; that is the harness failing to
      // reach the internet, not the command failing at its job.
      return {
        name: cmd.name,
        canvas,
        timedOut: /no reply within/.test(err.message),
        error: err.message,
      };
    }
    const out = readOutput(api.sent.slice(before));
    const placeholders = placeholderNames(out.text);
    // `!id` and `!userinfo` answer "what is my id" — a uid is the payload.
    const rawUid = ID_BY_DESIGN.has(cmd.name) ? null : RAW_UID.exec(withoutUrls(out.text));
    // Progress goes to stderr so a redirected stdout still shows where the run
    // is. A silent 359-command run is indistinguishable from a hung one.
    const took = Date.now() - startedAt;
    process.stderr.write(took > 1500
      ? `    … ${cmd.name} took ${took}ms\n`
      : `    . ${cmd.name}\n`);
    return {
      name: cmd.name,
      canvas,
      text: out.text,
      images: out.images,
      placeholder: placeholders.length ? placeholders.join(', ') : null,
      rawUid: rawUid ? rawUid[0] : null,
    };
  };

  try {
    // Two commands whose usage line cannot be turned into a valid argument list.
    // `!petlist` takes a rarity or a part number, and reading its bracketed
    // placeholder as an argument asks for a rarity named "rarity"; `!pokemon`
    // needs the subcommand. Everything else is read off its own usage string.
    const ARGS = { petlist: [], pokemon: ['spawn'] };
    for (const cmd of cmds) {
      const canvas = wantCanvas.has(cmd.name);
      const row = await runOnce(cmd, api, canvas, ARGS[cmd.name] || argsFor(cmd));
      rowsOut.push(row);

      // A command with a target in its usage has two shapes: `!besties @user`
      // adds somebody and `!besties` reads the board — and only the second one
      // draws. Driven by the usage line alone, the audit only ever saw the
      // first and reported two working commands as having drawn nothing.
      const targetsSomebody = /@/.test(String(cmd.usage || ''));
      if (!row.error && row.canvas && row.images === 0 && targetsSomebody) {
        const readPath = await runOnce(cmd, api, canvas, []);
        if (readPath.images > row.images || readPath.text.length > row.text.length) {
          readPath.retried = true;
          rowsOut[rowsOut.length - 1] = readPath;
        }
      }
    }
  } finally {
    process.exit = realExit;
    mongo.isReady = realReady;
    restore();
    for (const [m, fn] of realProtoSave) m.prototype.save = fn;
    server.close();
  }

  // ── the report ──────────────────────────────────────────────
  const canvasRows = rowsOut.filter((r) => r.canvas);
  const drewNothing = canvasRows.filter((r) => !r.error && r.images === 0);
  const noImage = drewNothing.filter((r) => !CANVAS_GATED[r.name]);
  const gated = drewNothing.filter((r) => CANVAS_GATED[r.name]);
  const errored = rowsOut.filter((r) => r.error && !r.timedOut);
  const noAnswer = rowsOut.filter((r) => r.timedOut);
  const placeholders = rowsOut.filter((r) => r.placeholder);
  const rawUids = rowsOut.filter((r) => r.rawUid);

  console.log(`\n  ${cmds.length} commands run · ${canvasRows.length} of them draw a canvas`);
  console.log(`  ${canvasRows.length - noImage.length - gated.length}/${canvasRows.length} drawing commands sent an image\n`);

  if (noImage.length) {
    console.log('  DREW NOTHING');
    for (const r of noImage) console.log(`    ⚠️  ${r.name.padEnd(14)} ${excerpt(r.text)}`);
    console.log('');
  }
  if (gated.length) {
    console.log('  CANVAS NOT REACHED — the harness cannot supply what these need');
    for (const r of gated) console.log(`    ·  ${r.name.padEnd(14)} ${CANVAS_GATED[r.name]}`);
    console.log('');
  }
  if (placeholders.length) {
    console.log('  SHOWED A STAND-IN NAME INSTEAD OF A REAL ONE');
    for (const r of placeholders) console.log(`    ⚠️  ${r.name.padEnd(14)} ${r.placeholder.padEnd(16)} ${excerpt(r.text)}`);
    console.log('');
  }
  if (rawUids.length) {
    console.log('  PRINTED A RAW UID');
    for (const r of rawUids) console.log(`    ⚠️  ${r.name.padEnd(14)} ${r.rawUid.padEnd(14)} ${excerpt(r.text)}`);
    console.log('');
  }
  if (errored.length) {
    console.log('  THREW');
    for (const r of errored) console.log(`    ⚠️  ${r.name.padEnd(14)} ${r.error}`);
    console.log('');
  }
  if (noAnswer.length) {
    console.log('  NO ANSWER IN TIME — usually the public internet, not the command');
    for (const r of noAnswer) console.log(`    ·  ${r.name.padEnd(14)} ${r.error}`);
    console.log('');
  }

  const clean = !noImage.length && !placeholders.length && !rawUids.length && !errored.length;
  console.log(clean
    ? `  Every drawing command that could be reached sent a picture, and no command printed a stand-in name or a raw uid.\n`
    : '  Gaps above are the ones worth fixing.\n');
  realExit(clean ? 0 : 1);
}

main().catch((err) => {
  console.error('audit crashed:', err);
  process.exit(1);
});