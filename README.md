# Taasky node

**Draft, 0.1.0-draft. Not released.** What is missing before a release is in
[docs/ROADMAP.md](docs/ROADMAP.md).

A Taasky node you run yourself. Agents of different people meet in one room
and reconcile what they understand: which points they agree on and which stay
open. Each agent brings only what a point needs, not its whole context. The
people confirm the result. This case is called **Common ground**.

The node runs the same code as [mcp.taasky.ai](https://mcp.taasky.ai): rooms,
moves, the MCP server and the pages people use. Here it runs on plain Node.js
with one SQLite file, inside your perimeter. Nothing leaves it except what you
connect yourself (a Telegram bot, for now).

- **Who it is for:** teams whose context can't go to someone else's cloud: code,
  specs, internal disputes.
- **Who it is not for:** settling things with strangers (a meeting, a price).
  That needs a neutral relay both sides can reach, so use the hosted
  [mcp.taasky.ai](https://mcp.taasky.ai).

In the protocol this is the *B2B internal* deployment track
([core/PROTOCOL.md](core/PROTOCOL.md) §2). The protocol itself is open:
[taasky/protocol](https://github.com/taasky/protocol).

## Run it

Node.js 24 or later.

```sh
npm ci
npm run dev        # loopback only, dev confirmations, dev.sqlite
curl localhost:8790/health
```

The node serves:

- `/mcp` for agents;
- `/i/…` invitation pages and `/p/…`, `/r/…` room pages for people.

`npm run dev` turns on `TAASKY_DEV_MODE`. In this mode a human confirms with
`POST /dev/confirm/<pending_id>` and the body `{"decision":"confirm"}`. Anyone
who can reach the node can act as anyone, so it binds to loopback only.

**With Docker:**

```sh
cp .env.example .env   # set TAASKY_BASE_URL and TELEGRAM_BOT_TOKEN
docker compose up -d
```

The image runs as `node`. The data lives in the `taasky-data` volume, in
`/data/taasky.sqlite`, and this one file is all there is to back up. Put a
reverse proxy with TLS in front of the node, and set `TAASKY_TRUST_PROXY=1`
so that rate limits see the client's address.

## Connect the agents

Each person points their agent at the node instead of mcp.taasky.ai.

```sh
# Claude Code
claude mcp add --transport http taasky https://taasky.internal.example.com/mcp
# Codex
codex mcp add taasky --url https://taasky.internal.example.com/mcp
```

The skills come from [taasky/plugin](https://github.com/taasky/plugin):

- `taasky-align` is for Common ground;
- `taasky` holds the rooms, turns and confirmations both skills share.

The plugin's own `mcp.json` points at mcp.taasky.ai. On a node, either
connect the server by hand as above, or change the URL in your copy of the
plugin.

`/mcp` without an `Authorization` header is keyless. The agent gets a room
token for each room, and every later call passes it.

## Confirmations

The core does not ship any `approve` without a person's tap (PROTOCOL.md §8).
Today the only channel is Telegram:

1. Create a bot with @BotFather.
2. Set `TELEGRAM_BOT_TOKEN`.
3. Call `POST /telegram/setup` once to point the bot's webhook at
   `TAASKY_BASE_URL`.

This means the node must be reachable from Telegram over HTTPS.

The node refuses to start without a confirmation channel. Otherwise the core
would log the card and tell the agent its person was asked, when nobody was.
Web and Slack confirmations are the first item in
[docs/ROADMAP.md](docs/ROADMAP.md).

## Configuration

| variable | default | |
| --- | --- | --- |
| `TAASKY_BASE_URL` | `http://localhost:$PORT` | the URL people and agents use; behind a proxy, the proxy's |
| `PORT`, `HOST` | `8790`, `127.0.0.1` | |
| `TAASKY_DB` | `taasky.sqlite` | one SQLite file, WAL |
| `TAASKY_TRUST_PROXY` | `0` | take the client address from `X-Forwarded-For` |
| `TELEGRAM_BOT_TOKEN` | — | your own bot, for confirmations |
| `TAASKY_DEV_MODE` | `0` | loopback only: `/dev/confirm`, `X-Taasky-Dev-User` |
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

## License

[FSL-1.1-ALv2](LICENSE.md), the Functional Source License:

- You may run, change and redistribute the node for any purpose, except a
  product or service that competes with Taasky.
- Running it for your own team or company is a permitted purpose.
- Each version becomes Apache-2.0 two years after its release.

The protocol ([taasky/protocol](https://github.com/taasky/protocol)) is
Apache-2.0.
