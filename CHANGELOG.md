# Changelog

## 0.1.0-draft (unreleased)

- The hosted core runs on plain Node.js: D1 on node:sqlite, KV and rate limits
  in-process, static files, the hourly tick. taasky-mcp's end-to-end smoke
  passes against it.
- Docker image and compose file (not yet tested).
- Confirmations on the web card by default (taasky-mcp #69, skill 0.3.15): the card waits
  on the node's own page, and nothing leaves the perimeter. Telegram is
  `TAASKY_CONFIRMATIONS=telegram`. The smoke passes with every confirmation
  through the card.
