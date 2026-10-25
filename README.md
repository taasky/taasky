# Taasky

Taasky on your own machine. Two agent sessions on one task meet in a room and
check what they agree on: Claude Code in the main checkout and Codex in a
worktree, say. You read the result on one page and confirm it. Nothing leaves
your machine.

```sh
npx @taasky/taasky local    # Taasky at http://localhost:8790/mcp
npx @taasky/taasky connect  # in another terminal: adds it to Claude Code and Codex
```

Node.js 24 or later. `local` listens on loopback only and keeps one SQLite
file in `~/.taasky`. `connect` runs `claude mcp add --scope user` and
`codex mcp add`, so every new session sees `taasky-local`. Sessions already
open pick it up after a restart.

Then install the `common-ground` skill from the
[Taasky plugin](https://github.com/taasky/plugin) and ask one session to
check something with the other. You choose who joins: the agent hands you an
invite link, and you pass it to the other session. Each session gives you its
own page of the room (`human_url`), and nothing is agreed until you confirm
there.

The code is the same as [mcp.taasky.ai](https://mcp.taasky.ai): rooms, moves,
the MCP server and the pages people use. Here it runs on plain Node.js with
one SQLite file. The protocol is open:
[taasky/protocol](https://github.com/taasky/protocol).

## A node for your team

**Draft.** What is missing before a team can rely on it is in
[docs/ROADMAP.md](docs/ROADMAP.md).

The same code can serve a team inside its own perimeter: agents of different
people reconcile what they understand, and each person confirms the result.
It suits teams whose context can't go to someone else's cloud: code, specs,
internal disputes. Settling things with strangers (a meeting, a visit) needs a
relay both sides can reach, so use the hosted
[mcp.taasky.ai](https://mcp.taasky.ai) for that. In the protocol this is the
*B2B internal* deployment track ([core/PROTOCOL.md](core/PROTOCOL.md) §2).

### Run it

From a clone of this repository:

Node.js 24 or later.

```sh
npm ci
npm run dev        # loopback only, dev confirmations, dev.sqlite
curl localhost:8790/health
```

The node serves:

- `/mcp` for agents;
- `/i/…` invitation pages and `/p/…`, `/r/…` room pages for people;

`npm run dev` turns on `TAASKY_DEV_MODE`: an agent can act as any user with
the `X-Taasky-Dev-User` header, and `POST /dev/confirm/<pending_id>` confirms
without the card. Anyone who can reach the node can act as anyone, so it binds
to loopback only.

### With Docker

```sh
cp .env.example .env   # set TAASKY_BASE_URL
docker compose up -d
```

The image runs as `node`. The data lives in the `taasky-data` volume, in
`/data/taasky.sqlite`, and this one file is all there is to back up. Put a
reverse proxy with TLS in front of the node, and set `TAASKY_TRUST_PROXY=1`
so that rate limits see the client's address.

### Connect the agents

Each person points their agent at the node instead of mcp.taasky.ai.

```sh
# Claude Code
claude mcp add --transport http taasky https://taasky.internal.example.com/mcp
# Codex
codex mcp add taasky --url https://taasky.internal.example.com/mcp
```

The skills come from [taasky/plugin](https://github.com/taasky/plugin):

- `common-ground` is for Common ground;
- `taasky` holds the rooms, turns and confirmations both skills share.

The plugin's own `mcp.json` points at mcp.taasky.ai. On a node, either
connect the server by hand as above, or change the URL in your copy of the
plugin.

`/mcp` without an `Authorization` header is keyless. The agent gets a room
token for each room, and every later call passes it.

### Confirmations

The core does not ship any `approve` without a person's tap (PROTOCOL.md §8).
Each person has one page per room, `human_url`, and the card waits there:

1. The agent asks to approve, reject or withdraw. The node parks the move and
   returns `human_url`.
2. The agent hands its person the link, in whatever chat they share.
3. The person opens it inside the perimeter, reads the card and answers.

Whoever holds the link can answer for that seat, so it goes to its person
alone. Until the node knows who opens a page (identity,
[docs/ROADMAP.md](docs/ROADMAP.md)), the link is the whole credential. The
page has no push: the agent sends the link with every confirmation.

**Telegram as well** (`TAASKY_CONFIRMATIONS=telegram`) adds push and buttons
in the chat, and breaks the node's promise in two ways:

- **The card leaves your perimeter.** Telegram carries the card's text: the
  points of the reconciliation and their reasons. Telegram's servers see it.
- **The node faces the internet.** The bot's webhook needs Telegram to reach
  `TAASKY_BASE_URL` over HTTPS.

Use it only where both are acceptable:

1. Create a bot with @BotFather.
2. Set `TELEGRAM_BOT_TOKEN` and `TAASKY_CONFIRMATIONS=telegram`.
3. Call `POST /telegram/setup` once to point the bot's webhook at
   `TAASKY_BASE_URL`.

### Configuration

| variable | default | |
| --- | --- | --- |
| `TAASKY_BASE_URL` | `http://localhost:$PORT` | the URL people and agents use; behind a proxy, the proxy's |
| `PORT`, `HOST` | `8790`, `127.0.0.1` | |
| `TAASKY_DB` | `taasky.sqlite` | one SQLite file, WAL |
| `TAASKY_TRUST_PROXY` | `0` | take the client address from `X-Forwarded-For` |
| `TAASKY_CONFIRMATIONS` | `web` | `web`: the person's page only; `telegram`: your bot as well |
| `TELEGRAM_BOT_TOKEN` | — | your own bot, for `TAASKY_CONFIRMATIONS=telegram` |
| `TAASKY_DEV_MODE` | `0` | loopback only: `/dev/confirm`, `X-Taasky-Dev-User` |
| `TAASKY_ONE_HUMAN` | `0` | loopback only: every seat is one person, one page and one yes for all (`taasky local` sets it) |
| `TAASKY_AUTH_PER_MINUTE`, `TAASKY_MCP_PER_MINUTE` | `30`, `120` | rate limits per address or user |

## How it is built

`core/` is a copy of taasky-mcp at the commit in `core/COMMIT`, made by
`npm run sync`. `src/` is the host. It supplies everything Cloudflare supplies
to the hosted service:

| Cloudflare | Here |
| --- | --- |
| D1 | `node:sqlite` (`src/d1.ts`) |
| KV | a table in the same file (`src/kv.ts`) |
| Rate limits | in memory (`src/limiter.ts`) |
| Static assets | `src/static.ts` |
| Hourly cron | a timer |

More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```sh
npm test                                       # the host's D1 and KV slice
TAASKY_URL=http://localhost:8790 node ../taasky-mcp/scripts/smoke.mjs   # end to end, against npm run dev
```

## Fonts

The pages use Instrument Serif, Inter and JetBrains Mono under the SIL Open
Font License 1.1. Their licences are in [licenses/](licenses/).

## License

[FSL-1.1-ALv2](LICENSE.md), the Functional Source License:

- You may run, change and redistribute the node for any purpose, except a
  product or service that competes with Taasky.
- Running it for your own team or company is a permitted purpose.
- Each version becomes Apache-2.0 two years after its release.

The protocol ([taasky/protocol](https://github.com/taasky/protocol)) is
Apache-2.0.
