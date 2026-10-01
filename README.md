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
| AI | Google Gemini (integration point ready) |
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
    execute: async ({ api, event, args, config, registry, gemini, reply, react, userDoc }) => {
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
2. Add env vars: `APPSTATE`, `MONGO_URI`, `ADMIN_IDS`, `GEMINI_API_KEY` (optional).
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

### Gemini

The 35 AI commands in module 8 share one client, `bot/gemini.js`, which calls
the native `generativelanguage.googleapis.com` endpoint directly.

- Keys may be the newer `AQ...` Auth keys or the older `AIza...` keys. Both work
  on this endpoint. An `AQ...` key is rejected by OpenAI-compatible routes with
  a misleading "invalid_api_key", so the client stays on the native route and
  sends the key in the `x-goog-api-key` header.
- Default model is `gemini-3.8-flash` (`GEMINI_MODEL` overrides). If that model
  is unavailable to your project the client falls back automatically instead of
  failing every AI command.
- Thinking is on by default in Gemini 3.x, so `maxOutputTokens` counts thinking
  tokens as well as the answer. The client also strips thought parts from the
  response so the model's reasoning never reaches the chat.

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

## Current progress

| Module | Commands |
|---|---|
| cmds_1 (system) | 1 / 35 |
| cmds_2 … cmds_10 | 0 / 35 each |

The foundation is verified; the remaining 349 commands are added one module at
a time.
