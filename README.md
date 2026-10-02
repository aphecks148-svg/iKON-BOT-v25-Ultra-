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
│   ├── cmds_1.js … cmds_10.js    10 modules x 35 commands = 350
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
│   └── check.js        registry shape + per-module progress
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
node bot/test.js   # 12 core checks: config, loader, router, cooldown, perms, models
node bot/e2e.js    # 12 end-to-end checks with a mocked ws3-fca api
node bot/check.js  # registry shape + per-module progress toward 350
```

Set `TEST_MONGO_URI` (or `MONGO_URI`) to also run the live database round-trip
checks in `bot/test.js`.

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

The 35 AI commands in module 8 share one client, `bot/groq.js`, which POSTs to
`https://api.groq.com/openai/v1/chat/completions`. There is no second provider
and no transport that silently switches.

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
- With no key set, `!groq` and the other 34 AI commands answer with an honest
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
- **Pictures.** `!profile`, `!xp`, `!rank`, `!leaderboard`, `!leaderboardrpg`,
  `!richest`, `!topwins`, `!topxp`, `!bestiesultra`, `!enemiesultra` and
  `!coupleultra` draw a canvas card with each hunter's real Facebook photo.
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
| cmds_1 (system) | 1 / 35 |
| cmds_2 … cmds_10 | 0 / 35 each |

The foundation is verified; the remaining 349 commands are added one module at
a time.
