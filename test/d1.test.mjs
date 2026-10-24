// The D1 slice on node:sqlite: what the core relies on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteD1 } from "../src/d1.ts";
import { SqliteKV } from "../src/kv.ts";

const fresh = () => {
  const db = new SqliteD1(":memory:");
  db.sqlite.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, flag INTEGER, n INTEGER DEFAULT 0)");
  return db;
};

test("bind maps undefined to null and booleans to 0/1", async () => {
  const db = fresh();
  await db.prepare("INSERT INTO t (name, flag) VALUES (?, ?)").bind(undefined, true).run();
  assert.deepEqual(await db.prepare("SELECT name, flag FROM t").first(), { name: null, flag: 1 });
});

test("first, first(column), all and run.meta", async () => {
  const db = fresh();
  const r = await db.prepare("INSERT INTO t (name) VALUES (?)").bind("a").run();
  assert.equal(r.meta.changes, 1);
  assert.equal(await db.prepare("SELECT name FROM t WHERE id = ?").bind(r.meta.last_row_id).first("name"), "a");
  assert.equal((await db.prepare("SELECT * FROM t").all()).results.length, 1);
  assert.equal(await db.prepare("SELECT * FROM t WHERE id = 99").first(), null);
});

test("batch returns RETURNING rows and changes, and rolls back as one", async () => {
  const db = fresh();
  const [ins, upd] = await db.batch([
    db.prepare("INSERT INTO t (name) VALUES (?) RETURNING id AS seq").bind("x"),
    db.prepare("UPDATE t SET n = n + 1 WHERE name = ?").bind("x"),
  ]);
  assert.equal(ins.results[0].seq, 1);
  assert.equal(upd.meta.changes, 1);
  await assert.rejects(db.batch([db.prepare("INSERT INTO t (name) VALUES ('y')"), db.prepare("INSERT INTO nope VALUES (1)")]));
  assert.equal(await db.prepare("SELECT COUNT(*) AS c FROM t").first("c"), 1);
});

test("kv: ttl, json, prefix list", async () => {
  const kv = new SqliteKV(fresh());
  await kv.put("grant:a", JSON.stringify({ ok: 1 }));
  await kv.put("grant:b", "x", { expirationTtl: -1 });
  await kv.put("token:c", "y");
  assert.deepEqual(await kv.get("grant:a", { type: "json" }), { ok: 1 });
  assert.equal(await kv.get("grant:b"), null);
  assert.deepEqual((await kv.list({ prefix: "grant:" })).keys.map((k) => k.name), ["grant:a"]);
  assert.equal(kv.sweep(), 1);
});
