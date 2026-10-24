#!/usr/bin/env bash
# Copies the node's core from taasky-mcp: the protocol, rooms, moves, the MCP
# server and the pages people use. The commit it came from goes to core/COMMIT.
#   TAASKY_MCP_DIR=../taasky-mcp scripts/sync-core.sh
set -euo pipefail
src="${TAASKY_MCP_DIR:-../taasky-mcp}"
here="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$src/wrangler.jsonc" ] || { echo "no taasky-mcp at $src" >&2; exit 1; }
rm -rf "$here/core"
mkdir -p "$here/core"
cp -R "$src/src" "$src/public" "$here/core/"
cp "$src/schema.sql" "$src/PROTOCOL.md" "$here/core/"
git -C "$src" rev-parse HEAD > "$here/core/COMMIT"
echo "core from taasky-mcp $(cut -c1-7 "$here/core/COMMIT")"
