# Contributing

- `core/` is a copy of taasky-mcp (`npm run sync`). Changes to rooms, moves,
  the MCP server or the pages go there, then sync. Pull requests here change
  the host (`src/`), packaging and docs.
- `npm test` covers the host's D1 and KV slice. Against `npm run dev`,
  `node ../taasky-mcp/scripts/smoke.mjs` with `TAASKY_URL` set runs the core's
  end-to-end smoke.
- By contributing you agree that your contribution is licensed under the
  project's license ([FSL-1.1-ALv2](LICENSE.md)).
