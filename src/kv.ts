// Workers KV for the OAuth provider (grants, tokens, clients), in the same
// SQLite file. Expiry is checked on read and swept on the hourly tick.

import type { SqliteD1 } from "./d1.ts";

interface PutOptions {
  expiration?: number;
  expirationTtl?: number;
  metadata?: unknown;
}

export class SqliteKV {
  private readonly db: SqliteD1;

  constructor(db: SqliteD1) {
    this.db = db;
    db.sqlite.exec(
      "CREATE TABLE IF NOT EXISTS node_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, metadata TEXT, expires_at INTEGER)",
    );
  }

  private now = () => Math.floor(Date.now() / 1000);

  async get(key: string, type?: "text" | "json" | { type?: "text" | "json" }): Promise<unknown> {
    const row = this.db.sqlite
      .prepare("SELECT value FROM node_kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)")
      .get(key, this.now()) as { value: string } | undefined;
    if (!row) return null;
    const kind = typeof type === "string" ? type : type?.type;
    return kind === "json" ? JSON.parse(row.value) : row.value;
  }

  async put(key: string, value: string, options: PutOptions = {}): Promise<void> {
    const expires = options.expiration ?? (options.expirationTtl ? this.now() + options.expirationTtl : null);
    this.db.sqlite
      .prepare("INSERT OR REPLACE INTO node_kv (key, value, metadata, expires_at) VALUES (?, ?, ?, ?)")
      .run(key, value, options.metadata === undefined ? null : JSON.stringify(options.metadata), expires);
  }

  async delete(key: string): Promise<void> {
    this.db.sqlite.prepare("DELETE FROM node_kv WHERE key = ?").run(key);
  }

  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const limit = Math.min(options.limit ?? 1000, 1000);
    const offset = Number(options.cursor ?? 0);
    const rows = this.db.sqlite
      .prepare(
        "SELECT key, metadata, expires_at FROM node_kv WHERE key LIKE ? ESCAPE '\\' AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ? OFFSET ?",
      )
      .all(`${(options.prefix ?? "").replace(/[%_]/g, "\\$&")}%`, this.now(), limit + 1, offset) as {
      key: string;
      metadata: string | null;
      expires_at: number | null;
    }[];
    const more = rows.length > limit;
    return {
      keys: rows.slice(0, limit).map((r) => ({
        name: r.key,
        ...(r.expires_at ? { expiration: r.expires_at } : {}),
        ...(r.metadata ? { metadata: JSON.parse(r.metadata) } : {}),
      })),
      list_complete: !more,
      ...(more ? { cursor: String(offset + limit) } : {}),
    };
  }

  sweep(): number {
    return Number(this.db.sqlite.prepare("DELETE FROM node_kv WHERE expires_at IS NOT NULL AND expires_at <= ?").run(this.now()).changes);
  }
}
