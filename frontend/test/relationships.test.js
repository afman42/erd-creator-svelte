import assert from "node:assert/strict";
import { test } from "node:test";
import { cardinality, cardinalityState } from "../src/geometry.js";
import {
	createManyToMany,
	createRelationship,
	isJunctionTable,
	junctionSet,
	previewLabels,
} from "../src/relationships.js";

import { C as col, S as schema, T as tab } from "./fixtures.js";

// ---- createRelationship: 1:1 ----

test("1:1 adds a UNIQUE NOT NULL FK column naming it <parent singular>_id", () => {
	const s = schema([
		tab("u", "users", [col("c1", "id", "INT", true)]),
		tab("p", "posts", [col("c2", "id", "BIGINT", true)]),
	]);
	const r = createRelationship(s, "u", "p", "1:1");
	assert.ok(r.ok);
	const c = s.tables[0].columns[1];
	assert.equal(c.name, "post_id");
	assert.equal(c.nn, true);
	assert.equal(c.ux, true);
	assert.equal(c.pk, false);
	assert.equal(c.type, "BIGINT"); // inherits the parent's sole-PK type
	assert.deepEqual(c.ref, { tableId: "p", action: "CASCADE", onUpdate: "" });
	assert.deepEqual(cardinality(s.tables[0], c), {
		child: "0..1",
		parent: "1..1",
	});
	assert.equal(cardinalityState(s.tables[0], c), "0..1 / 1..1");
});

test("1:N adds a NOT NULL non-unique FK column", () => {
	const s = schema([
		tab("u", "users", [col("c1", "id", "INT", true)]),
		tab("p", "posts", [col("c2", "id", "INT", true)]),
	]);
	const r = createRelationship(s, "u", "p", "1:N");
	assert.ok(r.ok);
	const c = s.tables[0].columns[1];
	assert.equal(c.nn, true);
	assert.equal(c.ux, false);
	assert.deepEqual(cardinality(s.tables[0], c), {
		child: "0..N",
		parent: "1..1",
	});
	assert.equal(cardinalityState(s.tables[0], c), "0..N / 1..1");
});

// ---- createRelationship: naming + type defaults ----

test("FK column name is made unique against the child's columns via uniqName", () => {
	const s = schema([
		tab("u", "users", [
			col("c1", "id", "INT", true),
			col("c2", "post_id", "INT", false),
		]),
		tab("p", "posts", [col("c3", "id", "INT", true)]),
	]);
	const r = createRelationship(s, "u", "p", "1:N");
	assert.ok(r.ok);
	assert.equal(s.tables[0].columns[2].name, "post_id2");
});

test("parent without a PK gives INT, parent name without trailing s is used whole", () => {
	const s = schema([
		tab("u", "users", [col("c1", "id", "INT", true)]),
		tab("c", "cart", [col("c2", "item", "VARCHAR(100)", false)]),
	]);
	const r = createRelationship(s, "u", "c", "1:N");
	assert.ok(r.ok);
	const c = s.tables[0].columns[1];
	assert.equal(c.name, "cart_id");
	assert.equal(c.type, "INT");
});

// ---- createRelationship: rejections mutate nothing ----

test("same-table, unknown-table and unknown-type picks fail without mutating", () => {
	const s = schema([
		tab("u", "users", [col("c1", "id", "INT", true)]),
		tab("p", "posts", [col("c2", "id", "INT", true)]),
	]);
	const before = s.tables[0].columns.length;

	assert.deepEqual(createRelationship(s, "u", "u", "1:1"), {
		ok: false,
		error: "child and parent must be distinct tables",
	});
	assert.deepEqual(createRelationship(s, "nope", "p", "1:1"), {
		ok: false,
		error: "unknown table",
	});
	assert.deepEqual(createRelationship(s, "u", "nope", "1:1"), {
		ok: false,
		error: "unknown table",
	});
	assert.deepEqual(createRelationship(s, "u", "p", "N:N"), {
		ok: false,
		error: "unknown relationship type: N:N",
	});
	assert.equal(s.tables[0].columns.length, before);
	assert.equal(s.tables[1].columns.length, before);
});

// ---- createManyToMany / isJunctionTable ----

test("createManyToMany builds the composite-PK junction shape", () => {
	const s = schema([
		tab("t1", "users", [col("c1", "id", "BIGINT", true)]),
		tab("t2", "posts", [col("c2", "id", "INT", true)]),
	]);
	const r = createManyToMany(s, "t1", "t2");
	assert.ok(r.ok);
	assert.equal(s.tables.length, 3);
	const j = s.tables[2];
	assert.equal(j.name, "users_posts");

	const [a, b] = j.columns;
	assert.equal(a.name, "user_id");
	assert.equal(a.type, "BIGINT"); // inherits users' sole-PK type
	assert.equal(a.nn, true);
	assert.equal(a.ux, false); // a composite-PK member is NOT unique
	assert.equal(a.pk, true);
	assert.deepEqual(a.ref, { tableId: "t1", action: "CASCADE", onUpdate: "" });
	assert.equal(b.name, "post_id");
	assert.equal(b.type, "INT");
	assert.deepEqual(b.ref, { tableId: "t2", action: "CASCADE", onUpdate: "" });

	assert.ok(isJunctionTable(j, s));
	// and the pair reads as N:N: child end many at both FKs, parent end 1..1
	assert.deepEqual(cardinality(j, a), { child: "0..N", parent: "1..1" });
	assert.deepEqual(cardinality(j, b), { child: "0..N", parent: "1..1" });
});

test("isJunctionTable rejects non-junction shapes", () => {
	const ref = (tableId) => ({ tableId, action: "CASCADE", onUpdate: "" });
	const fk = (id, tableId, pk = false) => ({
		id,
		name: `${tableId}_id`,
		type: "INT",
		pk,
		nn: pk,
		ai: false,
		ux: false,
		ix: false,
		comment: "",
		ref: ref(tableId),
	});
	const tables = [
		// sole-PK table (1-col PK) — a plain 1:N child
		tab("t1", "users", [col("c1", "id", "INT", true), fk("c2", "t1")]),
		// 3-col PK: not a junction
		tab("t2", "wide", [
			col("c3", "a", "INT", true),
			col("c4", "b", "INT", true),
			col("c5", "c", "INT", true),
		]),
		// 2-col PK but only one FK
		tab("t3", "partial", [col("c6", "a", "INT", true), fk("c7", "t1")]),
		// 2-col FK PK — a genuine junction
		tab("t4", "users_posts", [fk("c8", "t1", true), fk("c9", "t2", true)]),
	];
	const s = schema(tables);
	// basic negatives
	assert.ok(!isJunctionTable(s.tables[0], s)); // 1-col PK
	assert.ok(!isJunctionTable(s.tables[1], s)); // 3-col PK
	assert.ok(!isJunctionTable(s.tables[2], s)); // 2-col PK, one non-FK
	assert.ok(isJunctionTable(s.tables[3], s)); // t4 alone qualifies

	// …unless somebody references it, which demotes it to a plain table
	const withReferencer = schema([
		...tables,
		tab("t5", "referencer", [fk("c10", "t4")]),
	]);
	assert.ok(!isJunctionTable(withReferencer.tables[3], withReferencer));
});

test("junctionSet precompute agrees with the scan (incl. self-reference)", () => {
	const ref = (tableId) => ({ tableId, action: "CASCADE", onUpdate: "" });
	const fk = (id, tableId, pk = false) => ({
		id,
		name: `${tableId}_id`,
		type: "INT",
		pk,
		nn: pk,
		ai: false,
		ux: false,
		ix: false,
		comment: "",
		ref: ref(tableId),
	});
	// Self-referencing junction-shaped table (hand-written file can hold one;
	// the UI forbids it): the inbound set contains its own id, so the fast
	// path must fall back to the precise scan and still call it a junction.
	const self = tab("ts", "tree", [
		fk("cs1", "ts", true),
		fk("cs2", "t1", true),
	]);
	const s = schema([
		tab("t1", "users", [col("c1", "id", "INT", true)]),
		self,
		tab("t4", "users_posts", [fk("c8", "t1", true), fk("c9", "t2", true)]),
		tab("t2", "posts", [col("c2", "id", "INT", true)]),
		tab("t5", "referencer", [fk("c10", "t4")]),
	]);
	const set = junctionSet(s);
	assert.ok(set.has("ts"), "own self-ref lands in the set");
	assert.ok(set.has("t4"), "referencer lands in the set");
	for (const t of s.tables) {
		assert.equal(
			isJunctionTable(t, s, set),
			isJunctionTable(t, s),
			`precomputed agrees for ${t.name}`,
		);
	}
	assert.ok(isJunctionTable(s.tables[1], s, set), "self-ref stays a junction");
	assert.ok(!isJunctionTable(s.tables[2], s, set), "referenced stays demoted");
});

test("createManyToMany rejections mutate nothing", () => {
	const s = schema([
		tab("t1", "users", [col("c1", "id", "INT", true)]),
		tab("t2", "posts", [col("c2", "id", "INT", true)]),
	]);
	const before = s.tables.length;

	assert.deepEqual(createManyToMany(s, "t1", "t1"), {
		ok: false,
		error: "a many-to-many needs two distinct tables",
	});
	assert.deepEqual(createManyToMany(s, "nope", "t2"), {
		ok: false,
		error: "unknown table",
	});

	// first create takes the name; a second must fail, not silently suffix
	const first = createManyToMany(s, "t1", "t2");
	assert.ok(first.ok);
	assert.deepEqual(createManyToMany(s, "t2", "t1"), {
		ok: false,
		error: "table users_posts already exists",
	});
	assert.equal(s.tables.length, before + 1);
});

// ---- previewLabels: the dialog preview agrees with the creators ----

test("previewLabels maps each type to the labels its creation writes", () => {
	assert.deepEqual(previewLabels("1:1"), { child: "0..1", parent: "1..1" });
	assert.deepEqual(previewLabels("1:N"), { child: "0..N", parent: "1..1" });
	assert.deepEqual(previewLabels("N:N"), { child: "0..N", parent: "1..1" });
	assert.equal(previewLabels("bogus"), null);
	assert.equal(previewLabels(""), null);
});

// The load-bearing agreement: creating a relationship and reading it back
// through cardinality() must give exactly what the preview promised. If this
// fails, the dialog preview can disagree with the drawn edge.
test("preview agrees with createRelationship read back through cardinality", () => {
	for (const type of ["1:1", "1:N"]) {
		const s = schema([
			tab("u", "users", [col("c1", "id", "INT", true)]),
			tab("p", "posts", [col("c2", "id", "INT", true)]),
		]);
		const r = createRelationship(s, "u", "p", type);
		assert.ok(r.ok);
		const c = s.tables[0].columns.at(-1);
		assert.deepEqual(cardinality(s.tables[0], c), previewLabels(type));
	}
});

// N:N preview agrees with both junction edges read back through cardinality().
test("preview agrees with createManyToMany junction edges", () => {
	const s = schema([
		tab("t1", "users", [col("c1", "id", "INT", true)]),
		tab("t2", "posts", [col("c2", "id", "INT", true)]),
	]);
	const r = createManyToMany(s, "t1", "t2");
	assert.ok(r.ok);
	const j = s.tables[2];
	for (const c of j.columns) {
		assert.deepEqual(cardinality(j, c), previewLabels("N:N"));
	}
});

// Orphan states stay reachable through raw flags (no select writes them now):
// 0..N / 0..1 is ux=false,nn=false; 0..1 / 0..1 is ux=true,nn=false.
test("all four states stay reachable through raw ux/nn flags", () => {
	const mk = (flags) => {
		const c = { pk: false, nn: false, ux: false, ...flags };
		return { t: { columns: [c] }, c };
	};
	const cases = [
		[{ ux: false, nn: false }, "0..N / 0..1"],
		[{ ux: false, nn: true }, "0..N / 1..1"],
		[{ ux: true, nn: false }, "0..1 / 0..1"],
		[{ ux: true, nn: true }, "0..1 / 1..1"],
	];
	for (const [flags, want] of cases) {
		const { t, c } = mk(flags);
		assert.equal(
			cardinalityState(t, c),
			want,
			`flags ${JSON.stringify(flags)}`,
		);
	}
});
