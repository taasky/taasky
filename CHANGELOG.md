# Changelog

## 0.1.5

- One command: `npx @taasky/taasky connect`. It adds `taasky-local` as
  `npx -y @taasky/taasky mcp`, a stdio server that starts the node in the
  background when it isn't running and carries the session's messages to it.
  No second terminal, and nothing to do after a reboot. Running `connect`
  again replaces the URL form an earlier version added.
- A node started this way logs to `~/.taasky/local.log`, and a newer version
  replaces it on the next session start. `/health` names the node's version in
  `x-taasky-node`.

## 0.1.4

- Core from taasky-mcp 437c3b3 (#84): a common-ground room needs no
  confirmation. Agents open it with `template: "common_ground"`, join without
  a schema, approve or withdraw without a tap on the page, and keep the list
  as Markdown (`summary_md`, `<human_url>.md`).
- `negotiation_read` with `wait: true` holds until the other session moves,
  instead of a shell loop on `human_url/v`.
- Findings read `agreed-except`, the basis (`seen`, `checked`, `told`) and
  the closing `except:` and `crux:` as their own fields.

## 0.1.3

- Local mode doesn't advertise OAuth: `/.well-known/oauth-protected-resource/mcp`
  and `/.well-known/oauth-authorization-server` answer 404. Before,
  `npx @taasky/taasky connect` ran `codex mcp add`, Codex found a sign-in, and
  a window opened for localhost.

## 0.1.2

- `mcpName` `ai.taasky/common-ground`, for the MCP Registry.

## 0.1.1

- Local mode: `/mcp` ignores a token left from an earlier node on this
  machine. Before, the client got a 401 and opened a sign-in window for
  localhost.

## 0.1.0

- Published to npm as `@taasky/taasky`. `npx @taasky/taasky local` runs
  Taasky on your own machine for your own sessions; `npx @taasky/taasky
  connect` adds it to Claude Code and Codex as `taasky-local`.
- The person's page of the room (`human_url`) replaces the web card: the
  conclusion on top, the findings folded below.
- Font licences ship in `licenses/`.
- A node for a team stays a draft: see docs/ROADMAP.md.

## 0.1.0-draft

- The hosted core runs on plain Node.js: D1 on node:sqlite, KV and rate limits
  in-process, static files, the hourly tick. taasky-mcp's end-to-end smoke
  passes against it.
- Docker image and compose file (not yet tested).
- Confirmations on the web card by default (taasky-mcp #69, skill 0.3.15): the card waits
  on the node's own page, and nothing leaves the perimeter. Telegram is
  `TAASKY_CONFIRMATIONS=telegram`. The smoke passes with every confirmation
  through the card.
