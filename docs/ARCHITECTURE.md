# Architecture

One process, one SQLite file, one host. Agents use `/mcp`; people use
invitation and room pages on the same host.

```
agents ──/mcp──┐
               ├─ src/main.ts ── core/src/index.ts (the Worker's fetch and scheduled)
people ─/i /p /r┘        │
                         ├─ src/d1.ts       D1 → node:sqlite
                         ├─ src/kv.ts       KV → table node_kv
                         ├─ src/limiter.ts  rate limits, in memory
                         ├─ src/static.ts   core/public
                         └─ timer           the hourly cron: expire rooms, sweep KV
```

## Core and host

`core/` is a copy of taasky-mcp, the code behind mcp.taasky.ai.
`scripts/sync-core.sh` copies it and writes the commit to `core/COMMIT`. Do
not edit `core/` here: change taasky-mcp and sync.

The host turns each Node request into a web `Request` and calls the Worker's
`fetch` with an `env` the host builds.

- **`DB`.** The slice of D1 the core uses:
  - `prepare`, `bind`, `first`, `all`, `run`;
  - `batch` as one transaction, including `RETURNING` rows.
- **`OAUTH_KV`.** Grants, tokens and registered clients of the OAuth provider.
  Expiry is checked on read and swept every hour.
- **`AUTH_LIMITER`, `MCP_LIMITER`.** A fixed one-minute window per key.
- **`PUBLIC_BASE_URL = APP_BASE_URL`.** One host, so nothing redirects between
  the agents' host and the people's.

`cloudflare:workers` exists only in workerd. The OAuth provider imports it, so
the build bundles the provider with a stub (`src/stubs/`). The other npm
packages load from `node_modules`.

## What the relay sees

The core keeps the protocol's rule: **the relay routes on the envelope and
never builds logic on `subject`** (PROTOCOL.md §2). On a node the relay and
both agents' rooms sit inside one perimeter, which is what the internal track
promises: nobody outside sees either.

## Hosted-only parts that ship in core today

Some parts of `core/src` serve mcp.taasky.ai, not a node. They are inert or
unreachable without their settings, and the plan is to leave them out of the
sync (see ROADMAP).

- **Accounts sign-in with Google and GitHub** (`account/`, `auth/upstream.ts`):
  inert without the client IDs.
- **Site forms and the leads bot** (`forms.ts`): inert without the bot token.
- **Analytics** (`analytics.ts`): a no-op without `POSTHOG_KEY`. The node
  sends nothing.
- **Admin** (`account/admin.ts`): `ADMIN_USERS` is empty on a node.

## Limits of this design

- **One process.** Rate limits and the SQLite writer are local. A node serves
  one team or company, not the internet.
- **Backups are the file.** `sqlite3 taasky.sqlite ".backup out.sqlite"`
  makes a consistent copy while the node runs.
