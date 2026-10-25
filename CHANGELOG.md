# Changelog

## 0.1.0

- Published to npm as `taasky`. `npx taasky local` runs Taasky on your own
  machine for your own sessions; `npx taasky connect` adds it to Claude Code
  and Codex as `taasky-local`.
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
