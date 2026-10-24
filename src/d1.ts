// The slice of Cloudflare D1 the core uses (prepare, bind, first, all, run,
// batch), on node:sqlite. One file, WAL, one writer: a node serves one team.

import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

type Row = Record<string, unknown>;

interface Meta {
  changes: number;
  last_row_id: number;
  duration: number;
}

export interface Result<T = Row> {
  success: true;
  results: T[];
  meta: Meta;
}

// node:sqlite hands rows without a prototype; D1 hands plain objects, and the core spreads and compares them.
const plain = (row: Row): Row => ({ ...row });

// D1 binds undefined as null and booleans as 0/1; node:sqlite refuses both.
const value = (v: unknown): SQLInputValue => {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v as SQLInputValue;
};

export class Statement {
  private readonly db: SqliteD1;
  readonly sql: string;
  readonly params: SQLInputValue[];

  constructor(db: SqliteD1, sql: string, params: SQLInputValue[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): Statement {
    return new Statement(this.db, this.sql, values.map(value));
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.db.statement(this.sql).get(...this.params) as Row | undefined;
    if (!row) return null;
    return (column ? row[column] : plain(row)) as T;
  }

  async all<T = Row>(): Promise<Result<T>> {
    return this.db.execute<T>(this);
  }

  async run<T = Row>(): Promise<Result<T>> {
    return this.db.execute<T>(this);
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const s = this.db.statement(this.sql);
    s.setReturnArrays(true);
    try {
      return s.all(...this.params) as T[];
    } finally {
      s.setReturnArrays(false);
    }
  }
}

export class SqliteD1 {
  readonly sqlite: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  constructor(file: string) {
    this.sqlite = new DatabaseSync(file);
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }

  prepare(sql: string): Statement {
    return new Statement(this, sql);
  }

  /** D1 runs a batch as one transaction: all of it lands, or none. */
  async batch<T = Row>(statements: Statement[]): Promise<Result<T>[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const out = statements.map((s) => this.execute<T>(s));
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }

  statement(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.sqlite.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  /** Rows when the statement returns any (SELECT, … RETURNING), and changes either way. */
  execute<T>(st: Statement): Result<T> {
    const s = this.statement(st.sql);
    const t0 = performance.now();
    if (s.columns().length) {
      const results = (s.all(...st.params) as Row[]).map(plain) as T[];
      const { changes, last } = this.sqlite.prepare("SELECT changes() AS changes, last_insert_rowid() AS last").get() as {
        changes: number;
        last: number;
      };
      return { success: true, results, meta: { changes: Number(changes), last_row_id: Number(last), duration: performance.now() - t0 } };
    }
    const r = s.run(...st.params);
    return {
      success: true,
      results: [],
      meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), duration: performance.now() - t0 },
    };
  }
}
