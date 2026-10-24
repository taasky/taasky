# Changelog

## 0.1.0-draft (unreleased)

- The hosted core runs on plain Node.js: D1 on node:sqlite, KV and rate limits
  in-process, static files, the hourly tick. taasky-mcp's end-to-end smoke
  passes against it.
- Docker image and compose file (not yet tested).
- Refuses to start without a confirmation channel (Telegram, or dev mode on
  loopback).
