# iKON-BOT v2

A clean modular Facebook Messenger RPG/social bot.
**Owner: Aphecks iKon Klerk**

> Rebuilt from scratch — no legacy command engine, no plugin loader, no `run` wrappers.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 22+ (CommonJS) |
| Facebook | `ws3-fca` with APPSTATE cookies |
| Database | MongoDB + Mongoose |
| Server | Express (health/status) |
| Images | `@napi-rs/canvas` (prebuilt binaries, no node-gyp) |
| AI | Groq (`bot/groq.js`, OpenAI-compatible) |
| Deploy | Render (`render.yaml`) |

## Structure

```
iKON-BOT/
├── index.js            entry point (Render runs `node index.js`)
├── ws3-fca.js          central engine (Express, login, routing, permissions, cooldowns)
├── config.js           env-only configuration
├── commands/
│   ├── cmds_1.js … cmds_10.js    10 modules, 427 commands
├── bot/
│   ├── loader.js       scans cmds_1..10, builds registry + alias map
│   ├── router.js       PARSER: "!bank deposit 500" -> { name, args }
│   ├── cooldown.js     per-user, per-command cooldowns
│   ├── permissions.js  all / owner (ADMIN_IDS) / groupAdmin
│   ├── toggles.js      maintenance, disabled commands + modules per group
│   ├── cache.js        5-minute TTL profile cache (api.getUserInfo)
│   ├── helpers.js      reply (threaded), react, safe() error boundary
│   ├── canvas.js       @napi-rs/canvas wrapper
│   ├── mongo.js        connection manager
│   ├── test.js         core system self-test
│   ├── e2e.js          end-to-end chain test with a mocked api
│   ├── check.js        registry shape + per-module progress
│   ├── audit.js        completeness audit: half-written commands
│   └── gcs.js          group-chat listing, cleanup, approval sweep
└── models/             User, Group, Economy, Pet, Inventory
```

## Command contract

Every file in `commands/` exports a **plain array**. No factories, no legacy loader.

```js
module.exports = [
  {
    name: 'ping',
    aliases: ['p'],
    category: 'system',
    description: 'Check the bot is alive',
    usage: '!ping',
    cooldown: 3,            // seconds
    permission: 'all',      // all | owner | groupAdmin
    execute: async ({ api, event, args, config, registry, ai, reply, react, userDoc }) => {
      await reply(`PONG — up ${Math.round(process.uptime())}s`);
    },
  },
];
```

`reply(text)` and `react(emoji)` are already bound to the current thread, so a
command never has to pass `threadID` around.

## The chain

```
LOGIN → DATABASE → LOADER → MESSAGE → PARSER → COMMAND → REPLY
```

Each arrow runs inside an error boundary, so a broken command reports the error
to the user and the bot keeps running.

## Setup

```bash
npm install
cp .env.example .env      # then fill in APPSTATE and MONGO_URI
npm start
```

> Use `BOT_PREFIX` for the command prefix. `PREFIX` is also accepted, but on
> Linux it usually already holds an install path, so a path-like value is ignored.

## Verification

```bash
node bot/test.js   # core system self-test: config, loader, router, cooldown, perms, models
node bot/e2e.js    # end-to-end chain test with a mocked ws3-fca api
node bot/check.js  # registry shape + per-module progress
node bot/audit.js  # completeness audit — the commands that are only half written
```

`check.js` and `audit.js` look for different things. `check.js` proves a command
is shaped right; `audit.js` looks for the ones that are shaped right and still
wrong — a usage line that names a command nobody can type, a handler that draws
a card and never sends it, a description with no emoji in it.

Every command carries a hint of its own now, and `check.js` refuses a command
without one. A help page that ends in nothing is a list rather than a page, and
the deck's hint is not a substitute: it is about everything in the deck, so it
belongs on the deck page.

### Pictures

An attachment is uploaded as multipart/form-data, and the uploader reads the
filename and the content-type off the stream's `name`. A stream with no name
goes out as an anonymous `application/octet-stream` blob, and Facebook has no
way to tell that it was handed a picture: the text reply lands and the image
is simply not in the chat. Every stream the bot builds therefore carries a
name with the right extension, so a card goes out as
`filename="iKON-....png"; Content-Type: image/png`. `bot/test.js` builds the
multipart part the way the uploader builds it and asserts it, and a second
test drives fifteen card commands through the real engine and holds each one
to the whole contract — it must not die, it must send exactly one picture,
and that picture must be a named stream.

A card draws the person's real Facebook photo when Facebook will give it up,
and a generated avatar when it will not, so a card is never blank.

Set `TEST_MONGO_URI` (or `MONGO_URI`) to also run the live database round-trip
checks in `bot/test.js`.

`npm install` also runs `scripts/patch-ws3fca.js`, which guards one
ws3-fca bug on every install: the thread formatters read each
participant's profile picture as `big_image_src.uri` without checking
the image exists, so a chat with any account that has no profile
picture made `getThreadList`/`getThreadInfo` throw and the boot-time
thread cache and approval sweep failed. The patch is idempotent and
skips itself on a ws3-fca version that fixed this upstream.

## Deploying on Render

1. New → Web Service → connect the repo, Node 22.
2. Add env vars: `APPSTATE`, `MONGO_URI`, `ADMIN_IDS`, `GROQ_API_KEY` (optional).
3. Health check path: `/health`.

### Admin uids

Admin ids come from the environment only — nothing is hard-coded, so changing
who is an admin is an env change plus a redeploy, not a code change.

| Variable | Purpose |
|---|---|
| `ADMIN_IDS` | Comma separated Facebook numeric ids. Grants owner on every owner-only command (`!ban`, `!eval`, `!reload`, …) and exempts them from `!kick`/`!gcmute` in every group. |
| `OWNER_ID` | Optional single-owner shorthand. Folded into `ADMIN_IDS`; set either or both. |

With both empty, every owner-only command refuses everyone and the bot logs
`[CONFIG] ADMIN_IDS (and OWNER_ID) are empty` at boot — check the Render logs
first if an admin command never answers.

`bot/permissions.js` is the only place "is this person an admin" is decided:

- `isOwner(uid)` — env-driven, owner-level everywhere.
- `canModerate(api, event)` — env admins plus this thread's admins.
- `protectedIds(api, threadID)` — who must never be moderated. Deliberately does
  **not** include the sender; use `protectedIdsFor` for a target-exemption list.

### AI — Groq only

Module 8 (cmds_8.js) is the AI, download and football module.
35 of its 44 commands route through `askGroq()`; the rest resolve
a link through `bot/media.js` or a fixture through `footballData()`.
They share one client, `bot/groq.js`, which
POSTs to `https://api.groq.com/openai/v1/chat/completions`. There is no second
provider and no transport that silently switches.

- The key is a `gsk_...` key from <https://console.groq.com/keys>, sent as
  `Authorization: Bearer <key>` — never in the query string, where proxies log
  it. The client does not check the key's prefix, so a future Groq key format is
  not rejected by a regex before it is ever sent.
- Default model is `llama-3.3-70b-versatile`. Set `GROQ_MODEL` to pin one, or
  leave it blank to use the client's own ladder. If a model 400/401/403/404s —
  meaning it is unavailable to your key — the client walks
  `llama-3.1-8b-instant`, `openai/gpt-oss-120b` and `openai/gpt-oss-20b`
  rather than leaving every AI command dead. A 429 or a 5xx is about the account
  rather than the model, so it does not walk the ladder.
- The token cap is sent as `max_completion_tokens`; Groq has deprecated
  `max_tokens`. Reasoning models count their reasoning against that cap, which
  is why the default is generous for a chat reply.
- With no key set, `!ask` and the other 34 AI commands answer with an honest
  placeholder naming the missing variable, rather than throwing.

The engine exposes the client to handlers as `ai` in the execute context
(`ws3-fca.js`), so no command file imports the provider directly.

### Real names and profile pictures

`bot/profile.js` resolves identity from Facebook, `bot/cards.js` renders it.

- **Names.** ws3-fca's `getUserInfo` falls back to a literal `"Facebook User"`
  when it cannot resolve a profile. That was being written straight into Mongo,
  so a profile could stay named "Facebook User" on every leaderboard forever.
  Placeholder names are now detected and never persisted; the card shows a short
  uid instead, and a later successful lookup replaces it with the real name.
- **Pictures.** `!profile`, `!rank`, `!leaderboard`, `!richest`,
  `!topwins`, `!topxp`, `!besties`, `!enemies` and `!couple`
  draw a canvas card with each hunter's real Facebook photo.
  When Facebook has no photo, a deterministic generated avatar is drawn from the
  uid — stable per person, so a board does not flicker between renders.
- **Fallbacks.** Every card returns `null` when the native canvas binary is
  missing, and each command then sends its original text reply. A command that
  only ever sent an image would be silent on a platform without the binding.

## Diagnosing "the bot is not replying"

Hit `/health` on the deployed service. Each field rules causes in or out:

| Field | Meaning |
|---|---|
| `loggedIn` | `false` means the Facebook session never connected. Nothing is parsed, so nothing can be replied to. |
| `messagesSeen` | Rises only when MQTT delivers a message. If it stays `0` while people are typing in the chat, the account is not receiving — the app is not connected. |
| `commandsRun` | Rises when a command actually executed. Rising `messagesSeen` with flat `commandsRun` means the prefix does not match (the prefix in use is in `prefix`). |
| `sentOk` / `sentFailures` | The send path. `sentFailures` climbing with `commandsRun` rising is exactly "reacts but never replies", and `lastSendError` carries the reason. |
| `lastCommands` | The last dozen commands that ran, so a typo'd or blocked command is visible. |
| `adminsConfigured` | `0` means every owner-only command refuses everyone. |

`reactions` succeed where `replies` fail because `setMessageReaction` and
`sendMessage` are different methods with different signatures — so a working
reaction proves nothing about the send path. That is what made the last two
rounds of this bug look identical from the chat.

## Current progress

| Module | Commands |
|---|---|
| cmds_1 (system) | 47 |
| cmds_2 (economy) | 38 |
| cmds_3 (hunter academy + kingdoms) | 52 |
| cmds_4 (pets) | 43 |
| cmds_5 (games) | 40 |
| cmds_6 (group admin) | 50 |
| cmds_7 (street life) | 38 |
| cmds_8 (downloads + AI + football) | 44 |
| cmds_9 (fun & social) | 35 |
| cmds_10 (farming) | 40 |

**427 commands** across 10 modules, 602 aliases, 0 conflicts. Every command is
shaped, aliased, permission-tagged and carries a hint of its own;
`node bot/check.js` reports the per-module progress and refuses to pass on a
malformed entry, a missing hint or a usage line that names a command which
does not answer.

### The cleanup

Nine commands were retired as duplicates — a command that answers a question
another command already answers better is two things to read and one thing to
break. The retired names, and what took each one over:

| Retired | Replaced by |
|---|---|
| `!groq` | `!ask` (also answers to `!chat`) |
| `!generate` | `!imagine` (also answers to `!gen`, `!genimg`) |
| `!aicard` | `!config` — the owner's Groq key and live model |
| `!define` | `!wiki` |
| `!auramax` | `!aura` (also answers to `!auraa`) |
| `!flexcard` | `!flex` (also answers to `!showoff`, `!brag`) |
| `!roastcard` | `!roast` (also answers to `!burncard`) |
| `!simpmeter` | — |
| `!susmeter` | `!toxicmeter` (also answers to `!sus`) |

The spellings people already type were carried onto the command that took over,
so a group does not lose a word it used last week. `bot/test.js` asserts both
halves of this: the retired names are gone, and the carried spellings still
reach the right command.

### What is new

Twenty commands, two in every module, each one built on state that was already
there rather than on a new system:

| Module | Command | What it does |
|---|---|---|
| cmds_1 | `!search` | Finds any command by keyword — name, alias or description |
| cmds_1 | `!time` | The clock in any IANA timezone, and whether that is today or tomorrow there |
| cmds_2 | `!split` | Splits a bill between the people you tag; the remainder stays with you |
| cmds_2 | `!interest` | The vault pays 2% a day, once a day, straight back into the vault |
| cmds_3 | `!simulate` | A battle on paper — the odds, the payoff, and what would improve it |
| cmds_3 | `!mentor` | The free progress you are leaving on the table |
| cmds_4 | `!petmood` | The pet's real mood, read off hunger, bond and workload |
| cmds_4 | `!petbond` | What the bond is worth in permanent power |
| cmds_5 | `!dicecup` | Rolls dice and shows every face — free, and it wins nothing |
| cmds_5 | `!streakgame` | A daily streak whose payout grows, and a lucky charm every third day |
| cmds_6 | `!gcsettings` | Every switch this chat has set, in one read |
| cmds_6 | `!gcword` | A word filter — a filtered message never lands, and the word is never named back |
| cmds_7 | `!gtataxi` | A night shift behind the wheel, and the one fare in ten that does not pay |
| cmds_7 | `!gtapickup` | Sweeps the street for whatever somebody dropped |
| cmds_8 | `!crypto` | A coin price, from three feeds in order, with the source named |
| cmds_8 | `!currency` | Converts money off a rates table cached for an hour |
| cmds_9 | `!poll` / `!vote` | A poll the chat can answer, one vote each, changeable |
| cmds_10 | `!recipe` | Cooks raw goods into dishes worth 35% more than their parts |
| cmds_10 | `!almanac` | What to plant right now — profit per hour for every crop |

`!petcard` was broken and is fixed in the same pass: it asked the Pet model for
`owner` and `active`, which are not fields on it, and read a `PETS` table that
does not exist, so every call threw and no pet was ever drawn.

### Football (a deck in cmds_8.js)

Live scores, fixtures, standings and predictions, all interpreted by Groq. The
data layer is `footballData()` in `cmds_8.js`, which tries three sources in order:

1. **TheSportsDB v1** — unauthenticated, 100+ leagues, livescores, fixtures,
   standings and team details from one base URL.
2. **OpenLigaDB** — the fallback, same shape, different host, so a Cloudflare
   block on one is not a broken bot.
3. **API-Football v3** — the best data available, and the only one that costs.
   Used only when `FOOTBALL_API_KEY` is set.

Every command reports which source answered in its receipt line. The commands:
`!football`, `!livefootball`, `!score`, `!nextwinner`, `!teaminfo` (badge
picture card), `!fixtures`, `!footballnews`, `!matchpredict`, `!cricketscore`.

**Goal alerts.** `!follow <team>` subscribes a club to this chat for free, and
`!alerts` shows what is being watched. `footballTick()` is attached to the cmds_8
array and wired into the engine's housekeeping sweep: it asks the feeds every
minute and posts to any chat following a team whose score moved.

### Group administration (module 6)

`!gclist` lists every group chat the bot is in, up to 100, with thread ids.
`!leavegc <threadID>` removes the bot from one without opening it — it confirms
the bot is actually in that chat, calls `api.leaveThread`, and drops the Group
record regardless of the result. It refuses to leave the chat the caller is
standing in, and refuses to leave a chat the bot is not in, so a typo cannot
silently remove the bot from the wrong place.
