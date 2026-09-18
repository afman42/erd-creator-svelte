// node --test test/ — erd.js is DOM-free ESM; no runner deps.
// Go-side grammar already covered by grammar_test.go; UI-e2e by playwright (e2e/).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	adoptIds,
	baseType,
	cloneTable,
	DEFAULT_TYPE,
	isInt,
	layout,
	newColumn,
	newTable,
	TYPES,
	uniqName,
} from "../src/erd.js";
import { BOX_W, HDR_H, ROW_H } from "../src/geometry.js";

function col(name, props) {
	return Object.assign(newColumn(), { name }, props);
}

test("TYPES and DEFAULT_TYPE expose expected values", () => {
	assert.equal(TYPES.length, 13);
	assert.ok(TYPES.includes("INT"));
	assert.ok(TYPES.includes("ENUM"));
	assert.ok(TYPES.includes("JSON"));
	assert.equal(DEFAULT_TYPE.VARCHAR, "VARCHAR(255)");
	assert.equal(DEFAULT_TYPE.DECIMAL, "DECIMAL(10,2)");
	assert.equal(DEFAULT_TYPE.INT, undefined);
});

test("baseType strips params", () => {
	assert.equal(baseType("VARCHAR(255)"), "VARCHAR");
	assert.equal(baseType("DECIMAL(10,2)"), "DECIMAL");
	assert.equal(baseType("ENUM('a','b')"), "ENUM");
	assert.equal(baseType("INT"), "INT");
	assert.equal(baseType("TEXT"), "TEXT");
});

test("isInt true for integer families, false otherwise", () => {
	assert.equal(isInt("INT"), true);
	assert.equal(isInt("INT UNSIGNED"), true);
	assert.equal(isInt("BIGINT"), true);
	assert.equal(isInt("SMALLINT"), true);
	assert.equal(isInt("TINYINT"), true);
	assert.equal(isInt("VARCHAR(255)"), false);
	assert.equal(isInt("TEXT"), false);
	assert.equal(isInt("DECIMAL(10,2)"), false);
	assert.equal(isInt("BOOLEAN"), false);
	assert.equal(isInt("ENUM('a','b')"), false);
	assert.equal(isInt("JSON"), false);
});

test("newTable defaults", () => {
	const t = newTable("hello");
	assert.equal(t.name, "hello");
	assert.match(t.id, /^t\d+$/);
	assert.equal(t.x, 0);
	assert.equal(t.y, 0);
	assert.equal(t.columns.length, 1);
	const c = t.columns[0];
	assert.equal(c.name, "id");
	assert.equal(c.type, "INT");
	assert.equal(c.pk, true);
	assert.equal(c.nn, true);
	assert.equal(c.ai, true);
	assert.equal(c.ref, null);
});

test("newColumn defaults: no flags, no ref", () => {
	const c = newColumn();
	assert.equal(c.name, "column");
	assert.equal(c.type, "VARCHAR(255)");
	assert.deepEqual(
		{ pk: c.pk, nn: c.nn, ai: c.ai, ux: c.ux, ix: c.ix, ref: c.ref },
		{ pk: false, nn: false, ai: false, ux: false, ix: false, ref: null },
	);
});

test("adoptIds keeps table ids, allocates column ids, bumps counters", () => {
	const wire = {
		tables: [{ id: "t7", name: "u", columns: [{ name: "id" }, { name: "p" }] }],
	};
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
	src.columns.push(
		col("extra", { ref: { tableId: "t9", action: "RESTRICT" } }),
	);
	const c = cloneTable(src);
	assert.notEqual(c.id, src.id);
	assert.notEqual(c.columns[0].id, src.columns[0].id);
	assert.notEqual(c.columns[1].id, src.columns[1].id);
	assert.deepEqual(c.columns[0].ref, { tableId: "t9", action: "CASCADE" });
	assert.deepEqual(c.columns[1].ref, { tableId: "t9", action: "RESTRICT" });
	c.columns[0].ref.action = "RESTRICT"; // immutable: src untouched
	assert.equal(src.columns[0].ref.action, "CASCADE");
	// columns array is new
	c.columns.push(newColumn());
	assert.equal(src.columns.length, 2);
});

test("cloneTable deep-copies columns so mutation does not leak", () => {
	const src = newTable("src");
	src.columns[0].comment = "keep";
	const c = cloneTable(src);
	c.columns[0].comment = "mutated";
	c.columns[0].name = "changed";
	assert.equal(src.columns[0].comment, "keep");
	assert.equal(src.columns[0].name, "id");
});

test("layout puts referenced tables left; stacks same layer; cycles terminate", () => {
	const users = newTable("users");
	const posts = newTable("posts");
	posts.columns.push(
		col("user_id", {
			type: "INT",
			ref: { tableId: users.id, action: "CASCADE" },
		}),
	);
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

test("layout assigns deterministic x by FK depth (40 + layer*340)", () => {
	const c = newTable("c");
	const b = newTable("b");
	const a = newTable("a");
	a.columns[0].ref = { tableId: b.id };
	b.columns[0].ref = { tableId: c.id };
	layout({ tables: [a, b, c] });
	assert.equal(c.x, 40);
	assert.equal(b.x, 40 + 340);
	assert.equal(a.x, 40 + 680);
	assert.ok(c.y === 40);
	assert.ok(b.y === 40);
});

test("layout: FK depth 2 layers — a→b→c puts c leftmost, a rightmost", () => {
	const a = newTable("a"),
		b = newTable("b"),
		c = newTable("c");
	a.columns[0].ref = { tableId: b.id };
	b.columns[0].ref = { tableId: c.id };
	layout({ tables: [a, b, c] });
	assert.ok(c.x < b.x && b.x < a.x);
});

test("layout stacks tables in same layer vertically by box height", () => {
	const t1 = newTable("t1");
	const t2 = newTable("t2");
	const t3 = newTable("t3");
	layout({ tables: [t1, t2, t3] });
	assert.equal(t1.x, 40);
	assert.equal(t2.x, 40);
	assert.equal(t3.x, 40);
	assert.ok(t2.y > t1.y);
	assert.ok(t3.y > t2.y);
	// y step = HDR_H + ncols*ROW_H + 24 + GAP (12)
	const expectedStep = HDR_H + 1 * ROW_H + 24 + 12;
	assert.equal(t2.y, t1.y + expectedStep);
});

test("adoptIds regenerates foreign/garbage ids, keeps refs resolvable", () => {
	const wire = {
		tables: [
			{
				id: "weird",
				name: "a",
				columns: [{ name: "id", ref: { tableId: "t2" } }],
			},
			{ id: "t2", name: "b", columns: [{ name: "id" }] },
		],
	};
	adoptIds(wire);
	const a = wire.tables[0];
	assert.match(a.id, /^t\d+$/);
	assert.equal(a.columns[0].ref.tableId, "t2"); // refs untouched — parent id stays valid
});

test("adoptIds bumps counter past max id so newTable never collides", () => {
	const wire = {
		tables: [{ id: "t9", name: "a", columns: [{ name: "id", id: "c9" }] }],
	};
	adoptIds(wire);
	for (let i = 0; i < 5; i++) {
		const t = newTable(`x${i}`);
		assert.notEqual(t.id, "t9");
		for (const c of t.columns) assert.notEqual(c.id, "c9");
	}
});

test("adoptIds handles missing column ids and empty schema", () => {
	const empty = { tables: [] };
	adoptIds(empty);
	assert.equal(empty.tables.length, 0);
	const wire = {
		tables: [
			{ id: "t1", name: "x", columns: [{ name: "a" }, { name: "b", id: "" }] },
		],
	};
	adoptIds(wire);
	assert.match(wire.tables[0].columns[0].id, /^c\d+$/);
	assert.match(wire.tables[0].columns[1].id, /^c\d+$/);
	assert.notEqual(wire.tables[0].columns[0].id, wire.tables[0].columns[1].id);
});

test("BOX_W / HDR_H / ROW_H constants match CSS", () => {
	assert.equal(BOX_W, 280);
	assert.equal(HDR_H, 28);
	assert.equal(ROW_H, 42);
});

// uniqName increments a trailing number instead of appending to it. The old
// `base + ++i` produced table1, table12, table13 — skipping table2..table11,
// which is what a user sees as "why did my table numbers jump?".
test("uniqName increments the trailing number rather than appending", () => {
	assert.equal(uniqName("table1", ["users"]), "table1");
	assert.equal(uniqName("table1", ["users", "table1"]), "table2");
	assert.equal(uniqName("table1", ["users", "table1", "table2"]), "table3");
	// the regression: with 1..11 taken, the next must be 12 — not "table12" from
	// concatenation, and not a jump past 11.
	const many = [
		"table1",
		...Array.from({ length: 10 }, (_, i) => `table${i + 2}`),
	];
	assert.equal(uniqName("table1", many), "table12");
});

test("uniqName appends a number when the base has no trailing digits", () => {
	assert.equal(uniqName("users_copy", ["users"]), "users_copy");
	assert.equal(uniqName("users_copy", ["users", "users_copy"]), "users_copy2");
	assert.equal(
		uniqName("users_copy", ["users_copy", "users_copy2"]),
		"users_copy3",
	);
});

test("uniqName fills the first free number, not just max+1", () => {
	// table2 freed by deletion → reused, keeping names dense
	assert.equal(uniqName("table1", ["table1", "table3"]), "table2");
});

test("uniqName handles multi-digit suffixes and empty taken sets", () => {
	assert.equal(uniqName("table9", ["table9"]), "table10");
	assert.equal(uniqName("table10", ["table10"]), "table11");
	assert.equal(uniqName("t1", []), "t1");
});
