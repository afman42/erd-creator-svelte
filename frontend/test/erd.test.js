// node --test test/ — erd.js is DOM-free ESM; no runner deps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newTable, newColumn, generate, generateInserts, parse, layout, lint, bumpCounters } from "../src/erd.js";

function col(name, props) {
  return Object.assign(newColumn(), { name }, props);
}

function schema() {
  const users = Object.assign(newTable("users"), {
    columns: [
      col("id", { type: "INT", pk: true, nn: true, ai: true, comment: "pk" }),
      col("email", { type: "VARCHAR(190)", nn: true, ux: true }),
      col("status", { type: "ENUM('active','banned')" }),
    ],
  });
  const posts = Object.assign(newTable("posts"), {
    columns: [
      col("id", { type: "BIGINT", pk: true, nn: true, ai: true }),
      col("user_id", { type: "INT", ref: { tableId: users.id, action: "SET NULL" } }),
      col("tag", { type: "VARCHAR(32)", ix: true }),
    ],
  });
  return { tables: [users, posts] };
}

test("generate emits flags, composite-free PK, FK action, index", () => {
  const sql = generate(schema());
  assert.match(sql, /`id` INT NOT NULL AUTO_INCREMENT/);
  assert.match(sql, /`email` VARCHAR\(190\) NOT NULL UNIQUE/);
  assert.match(sql, /COMMENT 'pk'/);
  assert.match(sql, /KEY `idx_posts_tag` \(`tag`\)/);
  assert.match(sql, /FOREIGN KEY \(`user_id`\) REFERENCES `users` \(`id`\) ON DELETE SET NULL/);
});

test("generate→parse→generate is stable (round-trip)", () => {
  const once = generate(schema());
  const back = parse(once);
  assert.equal(generate(back), once);
  assert.equal(back.tables[1].columns[1].ref.action, "SET NULL");
  assert.equal(back.tables[0].columns[0].comment, "pk");
  assert.ok(back.tables[0].columns[2].type.startsWith("ENUM("));
});

test("round-trip survives quotes in comments and ENUM values", () => {
  const t = Object.assign(newTable("t"), { columns: [col("c", { comment: "it's `x`", type: "ENUM('a''b','c')" })] });
  const sql = generate({ tables: [t] });
  assert.match(sql, /COMMENT 'it''s `x`'/);
  const back = parse(sql);
  assert.equal(back.tables[0].columns[0].comment, "it's `x`");
  assert.equal(generate(back), sql);
});

test("parse rejects unsupported clause and keeps nothing half-built", () => {
  // CONSTRAINT-check hits the keyword blacklist; FULLTEXT falls to the column regex → cannot parse
  assert.throws(() => parse("-- Generated\nCREATE TABLE `t` (\n  CONSTRAINT `x` CHECK (`c` > 0)\n) ENGINE=InnoDB;\n"), /unsupported clause/);
  assert.throws(() => parse("-- Generated\nCREATE TABLE `t` (\n  FULLTEXT KEY x (`c`)\n) ENGINE=InnoDB;\n"), /cannot parse/);
  assert.throws(() => parse("select 1;\n"), /not inside CREATE TABLE/);
});

test("dangling FK ref is dropped, not crashed on", () => {
  const t = Object.assign(newTable("posts"), { columns: [col("user_id", { type: "INT", ref: { tableId: "gone", action: "CASCADE" } })] });
  const sql = generate({ tables: [t] });
  assert.doesNotMatch(sql, /FOREIGN KEY/);
  assert.equal(parse(sql).tables[0].columns[0].ref, null);
});

test("composite PK survives round-trip", () => {
  const t = Object.assign(newTable("m"), {
    columns: [col("a", { pk: true }), col("b", { type: "INT", pk: true }), col("v")],
  });
  const sql = generate({ tables: [t] });
  assert.match(sql, /PRIMARY KEY \(`a`, `b`\)/);
  assert.equal(generate(parse(sql)), sql);
});

test("lint flags FK base-type mismatch", () => {
  const users = Object.assign(newTable("users"), { columns: [col("id", { type: "BIGINT", pk: true })] });
  const posts = Object.assign(newTable("posts"), { columns: [col("user_id", { type: "INT", ref: { tableId: users.id, action: "CASCADE" } })] });
  const msgs = lint({ tables: [users, posts] });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /posts\.user_id INT vs users\.id BIGINT/);
  posts.columns[0].type = "BIGINT";
  assert.deepEqual(lint({ tables: [users, posts] }), []);
});

test("FK onto composite PK: lint warns, generate skips the constraint", () => {
  const m = Object.assign(newTable("m"), { columns: [col("a", { pk: true }), col("b", { type: "INT", pk: true })] });
  const n = Object.assign(newTable("n"), { columns: [col("m_a", { type: "INT", ref: { tableId: m.id, action: "RESTRICT" } })] });
  const msgs = lint({ tables: [m, n] });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /n\.m_a → m has composite PK/);
  assert.doesNotMatch(generate({ tables: [m, n] }), /FOREIGN KEY/);
});

test("parse rejects duplicate table names", () => {
  const dup = "CREATE TABLE `t` (\n  `id` INT\n) ENGINE=InnoDB;\nCREATE TABLE `t` (\n  `id` INT\n) ENGINE=InnoDB;\n";
  assert.throws(() => parse(dup), /duplicate table "t"/);
});

test("generate skips empty tables (invalid DDL guard)", () => {
  const t = Object.assign(newTable("empty"), { columns: [] });
  const sql = generate({ tables: [t, ...[schema().tables[0]]] });
  assert.doesNotMatch(sql, /CREATE TABLE `empty`/);
  assert.match(sql, /CREATE TABLE `users`/);
  assert.doesNotMatch(generateInserts({ tables: [t] }), /INSERT INTO `empty`/);
});

test("layout puts referenced tables left; stacks same layer; cycles terminate", () => {
  const s = schema();
  bumpCounters(s);
  const orphan = Object.assign(newTable("orphan"), { columns: [col("id", { pk: true })] });
  s.tables.push(orphan);
  layout(s);
  const [users, posts] = s.tables;
  assert.ok(users.x < posts.x, "referenced table leftmost");
  assert.equal(users.y, 40);
  assert.ok(orphan.y > users.y, "same-layer tables stack below");
  const a = Object.assign(newTable("a"), { columns: [col("b_id", { type: "INT" })] });
  const b = Object.assign(newTable("b"), { columns: [col("a_id", { type: "INT" })] });
  a.columns[0].ref = { tableId: b.id, action: "CASCADE" };
  b.columns[0].ref = { tableId: a.id, action: "CASCADE" };
  const cyc = { tables: [a, b] };
  layout(cyc); // cycle guard must terminate
  assert.ok(Number.isFinite(a.x) && Number.isFinite(b.x));
});
