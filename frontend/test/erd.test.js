// node --test test/ — erd.js is DOM-free ESM; no runner deps.
// Grammar tests moved to Go (grammar_test.go); this covers UI helpers + layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newTable, newColumn, cloneTable, adoptIds, layout } from "../src/erd.js";

function col(name, props) {
  return Object.assign(newColumn(), { name }, props);
}

test("adoptIds keeps table ids, allocates column ids, bumps counters", () => {
  const wire = { tables: [{ id: "t7", name: "u", columns: [{ name: "id" }, { name: "p" }] }] };
  adoptIds(wire);
  assert.equal(wire.tables[0].id, "t7");
  assert.match(wire.tables[0].columns[0].id, /^c\d+$/);
  assert.notEqual(wire.tables[0].columns[0].id, wire.tables[0].columns[1].id);
  const t = newTable("next"); // must not reuse t7
  assert.notEqual(t.id, "t7");
});

test("cloneTable gives fresh ids, keeps refs shape", () => {
  const src = newTable("a");
  src.columns[0].ref = { tableId: "t9", action: "CASCADE" };
  const c = cloneTable(src);
  assert.notEqual(c.id, src.id);
  assert.notEqual(c.columns[0].id, src.columns[0].id);
  assert.deepEqual(c.columns[0].ref, { tableId: "t9", action: "CASCADE" });
  c.columns[0].ref.action = "RESTRICT"; // immutable: src untouched
  assert.equal(src.columns[0].ref.action, "CASCADE");
});

test("layout puts referenced tables left; stacks same layer; cycles terminate", () => {
  const users = newTable("users");
  const posts = newTable("posts");
  posts.columns.push(col("user_id", { type: "INT", ref: { tableId: users.id, action: "CASCADE" } }));
  const orphan = newTable("orphan");
  const s = { tables: [users, posts, orphan] };
  layout(s);
  assert.ok(users.x < posts.x, "referenced table leftmost");
  assert.equal(users.y, 40);
  assert.ok(orphan.y > users.y, "same-layer tables stack below");
  const a = newTable("a");
  const b = newTable("b");
  a.columns[0].ref = { tableId: b.id, action: "CASCADE" };
  b.columns[0].ref = { tableId: a.id, action: "CASCADE" };
  layout({ tables: [a, b] }); // cycle guard must terminate
  assert.ok(Number.isFinite(a.x) && Number.isFinite(b.x));
});
