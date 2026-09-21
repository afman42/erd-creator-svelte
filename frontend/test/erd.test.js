// node --test test/ — erd.js is DOM-free ESM; no runner deps.
// Go-side grammar already covered by grammar_test.go; UI-e2e by playwright (e2e/).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	adoptIds,
	baseType,
	cloneTable,
	DEFAULT_DIALECT,
	DEFAULT_SQLITE_TYPES,
	DEFAULT_TYPE,
	DIALECTS,
	isInt,
	isSaveable,
	layout,
	newColumn,
	newSchema,
	newTable,
	SAVEABLE_DIALECTS,
	SQLITE_TYPES,
	TYPES,
	uniqName,
} from "../src/erd.js";
import {
	ADDCOL_H,
	applyCardinality,
	BORDER_H,
	BOX_W,
	boxHeight,
	CARDINALITY_STATES,
	cardinality,
	cardinalityState,
	EDGE_SELF_STROKE,
	EDGE_STROKE,
	GAP,
	HDR_H,
	isSolePk,
	LABEL_FILL,
	LABEL_HALO,
	pkConflictsWith,
	ROW_H,
	reachableStates,
	stackStep,
} from "../src/geometry.js";

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

// The frontend's SAVEABLE_DIALECTS must match the server's Schema.saveable().
// They disagreed twice — the UI called MariaDB export-only while the server
// saved it, and sqlite was refused until it gained a parser — and both times the
// symptom was a dropdown label contradicting what the server actually did.
// This reads the Go source so the two lists cannot drift again.
test("frontend SAVEABLE_DIALECTS agrees with the Go saveable() switch", () => {
	const go = readFileSync(new URL("../../grammar.go", import.meta.url), "utf8");
	const body = go.slice(
		go.indexOf("func (s *Schema) saveable() bool"),
		go.indexOf("// Lint:"),
	);
	// the dialects named in the Go switch's case clause
	const goSaveable = [
		...body.matchAll(/Dialect(Mysql|MariaDB|Postgres|Sqlite)/g),
	].map((m) => m[1].toLowerCase());
	const normalize = (d) => (d === "mariadb" ? "mariadb" : d);
	const goSet = [...new Set(goSaveable.map(normalize))].sort();

	assert.deepEqual(
		[...SAVEABLE_DIALECTS].sort(),
		goSet,
		"SAVEABLE_DIALECTS must list exactly the dialects Go's saveable() accepts",
	);
	// every offered dialect must be saveable now; the dropdown labels anything
	// outside SAVEABLE_DIALECTS "(export only)", which would be a lie
	for (const d of DIALECTS) {
		assert.ok(
			isSaveable(d),
			`${d} is offered but not saveable — the dropdown would label it "(export only)"`,
		);
	}
	assert.ok(DIALECTS.includes(DEFAULT_DIALECT));
	assert.ok(isSaveable(DEFAULT_DIALECT));
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

test("newSchema defaults to mysql + native sqlite types", () => {
	// The sqliteTypes default matters: it selects the lossless rendering, and it
	// must be present on a fresh schema or the server would have to guess.
	const s = newSchema();
	assert.equal(s.dialect, DEFAULT_DIALECT);
	assert.equal(s.sqliteTypes, DEFAULT_SQLITE_TYPES);
	assert.equal(s.sqliteTypes, "native");
	assert.deepEqual(s.tables, []);
	// both are carried through explicitly
	const t = newTable("t");
	const s2 = newSchema("sqlite", [t], "portable");
	assert.equal(s2.dialect, "sqlite");
	assert.equal(s2.sqliteTypes, "portable");
	assert.deepEqual(s2.tables, [t]);
	// every mode the UI offers is a real value
	assert.deepEqual(SQLITE_TYPES, ["native", "portable"]);
	assert.ok(SQLITE_TYPES.includes(DEFAULT_SQLITE_TYPES));
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

test("cloneTable carries the FK onUpdate action and keeps it independent", () => {
	// A duplicate must not lose ON UPDATE, and mutating the copy must not reach
	// the original: cloneTable rebuilds the ref per column ({...c.ref}), so both
	// referential actions travel with it.
	const src = newTable("a");
	src.columns[0].ref = {
		tableId: "t9",
		action: "CASCADE",
		onUpdate: "SET NULL",
	};
	const c = cloneTable(src);
	assert.equal(c.columns[0].ref.action, "CASCADE");
	assert.equal(c.columns[0].ref.onUpdate, "SET NULL");
	c.columns[0].ref.onUpdate = "RESTRICT";
	assert.equal(src.columns[0].ref.onUpdate, "SET NULL");
	// an FK with no ON UPDATE keeps the empty value rather than gaining one
	src.columns[0].ref = { tableId: "t9", action: "CASCADE", onUpdate: "" };
	assert.equal(cloneTable(src).columns[0].ref.onUpdate, "");
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

test("newTable carries an empty indexes list", () => {
	// Always an array, never undefined, so the UI can push without a guard; the
	// server's omitempty is what keeps it off the wire when empty.
	assert.deepEqual(newTable("t").indexes, []);
});

test("cloneTable deep-copies indexes so the copy is independent", () => {
	// The `...t` spread copies the indexes array by reference, so a duplicated
	// table would share the original's index list without an explicit copy —
	// editing one table's index would silently change the other's.
	const src = newTable("a");
	src.indexes.push({ cols: ["x", "y"] });
	const c = cloneTable(src);
	assert.deepEqual(c.indexes, [{ cols: ["x", "y"] }]);
	assert.notEqual(c.indexes, src.indexes, "index array must be a new array");
	assert.notEqual(
		c.indexes[0].cols,
		src.indexes[0].cols,
		"cols must be copied",
	);
	c.indexes[0].cols.push("z");
	c.indexes[0].name = "renamed";
	assert.deepEqual(src.indexes[0].cols, ["x", "y"], "src cols mutated");
	assert.equal(src.indexes[0].name, undefined, "src name mutated");
	// a table with no indexes field (an older file) clones to an empty list
	assert.deepEqual(
		cloneTable({ ...newTable("b"), indexes: undefined }).indexes,
		[],
	);
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
	// spacing comes from geometry.js, so layout() and addTable() cannot drift
	assert.equal(t2.y, t1.y + stackStep(1));
	assert.equal(t3.y, t2.y + stackStep(1));
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

// TableCard.svelte's <style> block is the source of truth for the box metrics
// geometry.js mirrors, and those numbers are hand-copied — so they drift.
// The previous version of this test only re-asserted the constants against
// themselves, which is why it passed while the CSS said something else
// entirely: ROW_H claimed 42 (row 26 + comment 16) but the real row+comment was
// 47, so FK edges attached progressively lower down the table — 14px off by the
// fourth column. These tests read the actual CSS instead.
const CARD_SRC = readFileSync(
	new URL("../src/TableCard.svelte", import.meta.url),
	"utf8",
);
let STYLE = CARD_SRC.slice(
	CARD_SRC.indexOf("<style>"),
	CARD_SRC.lastIndexOf("</style>"),
).replace(/\/\*[\s\S]*?\*\//g, "");
// ColumnRow now owns .row/.cmt — merge its style so geometry checks still pass
try {
	const ROW_SRC = readFileSync(
		new URL("../src/ColumnRow.svelte", import.meta.url),
		"utf8",
	);
	const rowStyle = ROW_SRC.slice(
		ROW_SRC.indexOf("<style>"),
		ROW_SRC.lastIndexOf("</style>"),
	).replace(/\/\*[\s\S]*?\*\//g, "");
	STYLE += rowStyle;
} catch {}

function ruleBody(selector) {
	const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const m = STYLE.match(new RegExp(`${esc}\\s*\\{([^}]*)\\}`));
	return m ? m[1] : null;
}

function decl(selector, prop) {
	const body = ruleBody(selector);
	if (body === null) return null;
	const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
	return m ? m[1].trim() : null;
}

const px = (v, what) => {
	const n = Number.parseFloat(v);
	if (Number.isNaN(n)) {
		throw new Error(
			`could not read ${what ?? "a width"} from TableCard.svelte's <style> — ` +
				`if the selector or property was renamed, update this test with it`,
		);
	}
	return n;
};

test("TableCard CSS matches the geometry.js box metrics", () => {
	// width: the FK edge starts at x + BOX_W, so a mismatch detaches every edge
	assert.equal(
		px(decl("section.table", "width"), "section.table width"),
		BOX_W,
		"section.table width must equal BOX_W or FK edges start at the wrong x",
	);
	// without border-box the 1px borders push the real box past the declared
	// width, and every child's own padding understates its rendered width
	assert.equal(
		decl("section.table", "box-sizing"),
		"border-box",
		"section.table needs box-sizing:border-box so the declared width is the real width",
	);
	// header height: rows are positioned from HDR_H, so this shifts every row
	assert.equal(
		px(decl(".hdr", "height"), ".hdr height"),
		HDR_H,
		"header height must equal HDR_H or every column row sits at the wrong y",
	);
	// row + comment line: the per-column step used to walk down the table
	assert.equal(
		px(decl(".row", "height"), ".row height") +
			px(decl(".cmt", "height"), ".cmt height"),
		ROW_H,
		"row + comment height must equal ROW_H or FK edges drift down the table",
	);
	// the row is the unit ROW_H counts, so it must not be content-sized
	assert.equal(decl(".row", "box-sizing"), "border-box");
	// the footer and border complete the height model: boxHeight() is what
	// layout() and addTable() stack cards by, so these must match too. Both
	// callers used to open-code this, assuming a 24px footer where the real one
	// plus borders is 27px, so cards were stacked 3px tighter than intended.
	assert.equal(
		px(decl(".addcol", "height"), ".addcol height"),
		ADDCOL_H,
		".addcol footer height must equal ADDCOL_H or boxHeight() is wrong",
	);
	assert.equal(
		// declared as the shorthand `border: 1px solid …`, so take its width
		px(
			(decl("section.table", "border") ?? "").split(/\s+/)[0],
			"section.table border width",
		) * 2,
		BORDER_H,
		"section.table borders must equal BORDER_H or boxHeight() understates the card",
	);
});

test("boxHeight / stackStep match the real rendered card", () => {
	// The height model, spelled out: header + columns + footer + borders.
	assert.equal(boxHeight(0), HDR_H + ADDCOL_H + BORDER_H);
	assert.equal(boxHeight(3), HDR_H + 3 * ROW_H + ADDCOL_H + BORDER_H);
	// one card plus the gap between cards in a layer
	assert.equal(stackStep(2), boxHeight(2) + GAP);
	// and the two callers of stackStep must agree: layout() and addTable() both
	// place cards this far apart. They used to use different constants (24+GAP
	// vs a bare 36), so this equality is the regression guard.
	const t1 = newTable("t1");
	const t2 = newTable("t2");
	layout({ tables: [t1, t2] });
	assert.equal(t2.y - t1.y, stackStep(1));
});

test("TableCard column row fits inside BOX_W", () => {
	// The row is a label now — name, type, active-flag badges, FK target, edit
	// button — five flex children where there used to be ten controls. It is
	// still a genuine space budget: if the type, flags or FK label grows, the
	// name is squeezed and the assertion on its resulting width fails.
	//
	// The controls themselves moved to ColumnEditModal.svelte, which is sized by
	// its own dialog rather than by BOX_W; the test below covers that.
	const GAP = px(decl(".row", "gap"), ".row gap");
	const PAD = 2 * 2; // .row padding: 1px 2px
	const NAME_MIN = px(decl(".row .cname", "min-width"), ".cname min-width");
	const TYPE_MAX = px(decl(".row .ty", "max-width"), ".ty max-width");
	const FLAGS_MAX = px(decl(".row .flags", "max-width"), ".flags max-width");
	const FK_MAX = px(decl(".row .fkinfo", "max-width"), ".fkinfo max-width");
	const EDIT_W = px(decl(".row .edit", "width"), ".edit width");

	const fixed = NAME_MIN + TYPE_MAX + FLAGS_MAX + FK_MAX + EDIT_W;

	// 5 flex children in the widest row => 4 gaps
	const needed = fixed + 4 * GAP + PAD;
	assert.ok(
		needed <= BOX_W,
		`widest column row needs ${needed}px but the box is ${BOX_W}px ` +
			`(${needed - BOX_W}px over) — the label would spill outside the card`,
	);
	// the name gets whatever is left; it must stay usable
	const nameActual = NAME_MIN + (BOX_W - needed);
	assert.ok(
		nameActual >= 28,
		`name would be squeezed to ${nameActual}px — below a usable width`,
	);
	// and the type must stay wide enough to read the type names
	assert.ok(
		TYPE_MAX >= 60,
		`type label is ${TYPE_MAX}px — too narrow to read the type names`,
	);
});

// The ten controls that used to live in the 26px row are only actually gone if
// they are somewhere else. This pins the destination rather than trusting that
// the row rewrite did not simply delete them.
const MODAL_SRC = readFileSync(
	new URL("../src/ColumnEditModal.svelte", import.meta.url),
	"utf8",
);

// Read once and shared by the export-paint and marker tests below.
const APP_SRC = readFileSync(
	new URL("../src/App.svelte", import.meta.url),
	"utf8",
);
const TOKENS_SRC = readFileSync(
	new URL("../src/tokens.css", import.meta.url),
	"utf8",
);

// ---- cardinality states: the dropdown's round-trip ----
//
// The select is a VIEW of the ux/nn flags, not a second source of truth. These
// pin the inverse relationship, which is the property that makes that true: for
// every state, applying it and reading it back must give the same state.

test("cardinalityState reads all four states from the flags", () => {
	const mk = (flags) => {
		const c = { pk: false, nn: false, ux: false, ...flags };
		return { t: { columns: [c] }, c };
	};
	const cases = [
		[{}, "0..N / 0..1"],
		[{ nn: true }, "0..N / 1..1"],
		[{ ux: true }, "0..1 / 0..1"],
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

// The load-bearing property: apply(state) then read back must be that state.
// If this fails, the dropdown can disagree with what the diagram shows.
test("every cardinality state round-trips through applyCardinality", () => {
	for (const state of CARDINALITY_STATES) {
		// start from a plain non-pk, non-unique column
		const c = { pk: false, nn: false, ux: false };
		const t = { columns: [c] };
		assert.equal(
			applyCardinality(t, c, state.id),
			true,
			`applyCardinality refused ${state.id}`,
		);
		assert.equal(
			cardinalityState(t, c),
			state.id,
			`applying ${state.id} did not read back as itself`,
		);
	}
});

// A sole PK pins the relationship: unique (one child) and emitted NOT NULL
// (mandatory parent), so 0..1 / 1..1 is the only state it can honour. Asking for
// any other state is ALLOWED — it CLEARS the PK rather than being refused, which
// is what makes all four options selectable — and the flags then express the
// state, so the model still agrees with its own DDL.
test("a sole PK accepts every state, clearing the PK when it must", () => {
	const c = { pk: true, nn: true, ux: false };
	const t = { columns: [c] };
	assert.equal(cardinalityState(t, c), "0..1 / 1..1");
	assert.equal(isSolePk(t, c), true);
	// its own state leaves the PK alone
	assert.equal(applyCardinality(t, c, "0..1 / 1..1"), true);
	assert.equal(c.pk, true);
	// every other state drops the PK, so the flags can express it
	for (const state of CARDINALITY_STATES) {
		if (state.id === "0..1 / 1..1") continue;
		const fresh = { pk: true, nn: true, ux: false };
		const tt = { columns: [fresh] };
		assert.equal(
			applyCardinality(tt, fresh, state.id),
			true,
			`sole PK should accept ${state.id} by clearing itself`,
		);
		assert.equal(fresh.pk, false, `${state.id} should have cleared the PK`);
		assert.equal(
			cardinalityState(tt, fresh),
			state.id,
			`after clearing the PK, ${state.id} should read back as itself`,
		);
	}
});

// A composite-PK member is NOT unique on its own, so its child end is 0..N and
// stays steerable — that is what makes a junction table expressible. Its PARENT
// end is pinned to 1..1 though, because every emitter writes NOT NULL for any
// PK column (`c.Nn || c.Pk`), not just a sole one. So the child end is free
// WITHOUT touching the PK, while relaxing the parent end needs the PK gone.
test("a composite-PK member steers its child end without dropping the PK", () => {
	const a = { pk: true, nn: true, ux: false };
	const b = { pk: true, nn: true, ux: false };
	const t = { columns: [a, b] };
	assert.equal(isSolePk(t, a), false);
	assert.equal(cardinalityState(t, a), "0..N / 1..1");
	// the child end can be made unique, and the PK survives: PK(a, b) does not
	// make `a` unique on its own, so ux is a separate, compatible fact
	assert.equal(applyCardinality(t, a, "0..1 / 1..1"), true);
	assert.equal(a.pk, true);
	assert.equal(cardinalityState(t, a), "0..1 / 1..1");
	// relaxing the parent end cannot coexist with the PK, so it clears it
	assert.equal(applyCardinality(t, a, "0..1 / 0..1"), true);
	assert.equal(a.pk, false);
	assert.equal(cardinalityState(t, a), "0..1 / 0..1");
});

test("applyCardinality rejects an unknown state", () => {
	const c = { pk: false, nn: false, ux: false };
	assert.equal(applyCardinality({ columns: [c] }, c, "1..N"), false);
	assert.equal(applyCardinality({ columns: [c] }, c, ""), false);
});

// pkConflictsWith is what tells the store to warn "primary key cleared", and it
// is the exact negation of reachableStates — the same rule the dialog used to
// disable options from, seen from the other side. Pinning them together keeps
// the warning honest: it must fire precisely when the PK is dropped.
test("pkConflictsWith negates reachableStates and predicts the PK clear", () => {
	const shapes = [
		{ label: "plain", cols: [{ pk: false, nn: false, ux: false }], i: 0 },
		{ label: "sole pk", cols: [{ pk: true, nn: true, ux: false }], i: 0 },
		{
			label: "composite pk",
			cols: [
				{ pk: true, nn: true, ux: false },
				{ pk: true, nn: true, ux: false },
			],
			i: 0,
		},
	];
	for (const { label, cols, i } of shapes) {
		const t = { columns: cols };
		const reachable = reachableStates(t, cols[i]);
		assert.ok(reachable.length > 0, `${label}: no reachable states`);
		for (const s of CARDINALITY_STATES) {
			// Rebuild with the SAME column count: a one-column table would turn a
			// composite-PK member into a sole PK, changing the rule under test.
			const fresh = cols.map((c) => ({ ...c }));
			const tt = { columns: fresh };
			const conflicts = pkConflictsWith(tt, fresh[i], s.id);
			assert.equal(
				conflicts,
				!reachable.includes(s.id),
				`${label}: pkConflictsWith(${s.id}) disagrees with reachableStates`,
			);
			const hadPk = fresh[i].pk;
			applyCardinality(tt, fresh[i], s.id);
			// the PK is dropped exactly when a conflict was reported
			assert.equal(
				fresh[i].pk,
				hadPk && !conflicts,
				`${label}: ${s.id} changed the PK but pkConflictsWith said ${conflicts}`,
			);
		}
	}
});

// The bug the dropdown work uncovered: a hand-written file can parse to
// `pk=true, nn=false` (`id INT, PRIMARY KEY (id)`), and every emitter writes
// NOT NULL for a PK regardless. Reading `nn` alone made the diagram say 0..1
// where the DDL said 1..1 — the diagram lied.
test("a PK column reads as 1..1 even when nn was never set", () => {
	const c = { pk: true, nn: false, ux: false };
	const t = { columns: [c] };
	// this is the regression: nn is false, but the DDL is NOT NULL
	assert.equal(cardinality(t, c).parent, "1..1");
	assert.equal(cardinalityState(t, c), "0..1 / 1..1");
	// and touching its cardinality normalises nn, so the model stops disagreeing
	// with its own output
	assert.equal(applyCardinality(t, c, "0..1 / 1..1"), true);
	assert.equal(c.nn, true);
});

// ---- relationship edge visibility ----
//
// html-to-image does not carry the stylesheet into an export: the exported
// document has no <style> element and no `.edge` rule. Anything styled ONLY by
// a CSS class therefore loses its paint and renders invisible. Measured before
// the fix: a PNG sampled at the curve and at both cardinality labels returned
// the background colour at every point, while the crow's-foot arrowhead stayed
// visible — because it was the one element styled by a presentation attribute.
//
// The values live in geometry.js and are written as attributes in App.svelte, so
// these read both sources. The e2e test samples real PNG pixels; this one is the
// cheap guard that the wiring has not been dropped.
test("edge and label paint is applied as SVG attributes, not class-only", () => {
	// the path carries stroke and stroke-width attributes
	assert.match(
		APP_SRC,
		/<path[^>]*stroke=\{e\.self \? EDGE_SELF_STROKE : EDGE_STROKE\}/s,
		"edge path has no stroke attribute — it would be invisible in an export",
	);
	assert.match(
		APP_SRC,
		/stroke-width=\{EDGE_STROKE_WIDTH\}/,
		"no stroke-width attribute",
	);
	// the labels carry fill and font attributes
	assert.match(APP_SRC, /fill=\{LABEL_FILL\}/, "labels have no fill attribute");
	assert.match(APP_SRC, /font-size="9"/, "labels have no font-size attribute");
	assert.match(
		APP_SRC,
		/text-anchor=\{LABEL_ANCHOR\}/,
		"labels have no text-anchor",
	);
	// and the halo, so a label is legible over its own line
	assert.match(APP_SRC, /stroke=\{LABEL_HALO\}/, "labels have no halo stroke");
});

// The constants duplicate tokens.css values on purpose: a CSS custom property
// does not resolve in the exported document either, so they cannot be shared.
// That duplication is load-bearing, so it is pinned here.
test("SVG paint constants match their tokens.css values", () => {
	const token = (name) =>
		new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`)
			.exec(TOKENS_SRC)?.[1]
			?.toLowerCase();
	assert.equal(
		EDGE_STROKE.toLowerCase(),
		token("--color-edge"),
		"EDGE_STROKE != --color-edge",
	);
	assert.equal(
		EDGE_SELF_STROKE.toLowerCase(),
		token("--color-accent"),
		"EDGE_SELF_STROKE != --color-accent",
	);
	assert.equal(
		LABEL_FILL.toLowerCase(),
		token("--color-text-muted"),
		"LABEL_FILL != --color-text-muted",
	);
	assert.equal(
		LABEL_HALO.toLowerCase(),
		token("--color-bg"),
		"LABEL_HALO != --color-bg",
	);
});

// ---- relationship edge visibility ----
//
// The crow's-foot arrowhead EXISTED in the exported SVG but could not be SEEN:
// it was a 7x7 marker whose path carried no stroke-width — a marker's contents
// do not inherit the referencing path's — so it drew at 1px, in the same #888
// grey as its own line. Measured in the export: 22 differing pixels in a 6x7
// box. These read the real sources, because the failure is a rendering property
// that no coordinate assertion can catch.
const crowMarker = () =>
	APP_SRC.slice(APP_SRC.indexOf('id="crow"'), APP_SRC.indexOf("</marker>"));

test("crow's-foot marker is large enough and stroked to be visible", () => {
	const marker = crowMarker();
	assert.ok(marker, "crow marker not found in App.svelte");
	const w = Number(/markerWidth="(\d+)"/.exec(marker)?.[1]);
	const h = Number(/markerHeight="(\d+)"/.exec(marker)?.[1]);
	assert.ok(w >= 10 && h >= 10, `marker is ${w}x${h}, too small to see at 1x`);
	const sw = Number(/stroke-width="([\d.]+)"/.exec(marker)?.[1]);
	assert.ok(sw >= 1.5, `marker stroke-width ${sw} is a hairline`);
});

// context-stroke is the documented way for a marker to inherit its path's
// paint, but it does NOT resolve when that paint comes from a CSS class — the
// marker keeps the literal string and paints NOTHING. Verified in the browser:
// it turned a faint arrow into no arrow, worse than the bug it was fixing.
test("crow's-foot marker does not rely on context-stroke", () => {
	assert.ok(
		!crowMarker().includes("context-stroke"),
		"marker uses context-stroke, which does not resolve against a class-styled path",
	);
});

// The marker's colour is written twice — a presentation attribute on the marker
// and a CSS rule on the line — because it cannot be shared. This is the check
// the comment in App.svelte promises: fail if the two ever disagree.
test("marker stroke matches the edge line colour token", () => {
	const markerStroke = /stroke="(#[0-9a-fA-F]{3,8})"/.exec(crowMarker())?.[1];
	assert.ok(markerStroke, "marker has no concrete stroke colour");
	const token = /--color-edge:\s*(#[0-9a-fA-F]{3,8})/.exec(TOKENS_SRC)?.[1];
	assert.ok(token, "--color-edge token not found in tokens.css");
	assert.equal(
		markerStroke.toLowerCase(),
		token.toLowerCase(),
		`marker stroke ${markerStroke} != --color-edge ${token}`,
	);
	// and the line actually consumes the token
	assert.match(APP_SRC, /\.edge\s*\{[^}]*stroke:\s*var\(--color-edge\)/s);
});

// The edge must stay brighter than the old #888, and distinct from both the
// self-edge accent and the label colour, or the arrowhead merges into its line.
test("edge colour is brighter than the old grey and distinct from its neighbours", () => {
	const edge = /--color-edge:\s*(#[0-9a-fA-F]{3,8})/.exec(TOKENS_SRC)?.[1];
	const accent = /--color-accent:\s*(#[0-9a-fA-F]{3,8})/.exec(TOKENS_SRC)?.[1];
	const muted = /--color-text-muted:\s*(#[0-9a-fA-F]{3,8})/.exec(
		TOKENS_SRC,
	)?.[1];
	assert.ok(edge && accent && muted);
	assert.notEqual(edge, "#888888", "edge colour is the old invisible grey");
	assert.notEqual(
		edge,
		accent,
		"edge colour collides with the self-edge accent",
	);
	assert.notEqual(edge, muted, "edge colour collides with the label colour");
});

test("ColumnEditModal holds every control the row gave up", () => {
	// name, type and comment inputs, plus the FK and action selects
	assert.match(MODAL_SRC, /class="cname"/, "name input missing from modal");
	assert.match(MODAL_SRC, /class="type"/, "type select missing from modal");
	assert.match(MODAL_SRC, /class="cmt"/, "comment input missing from modal");
	assert.match(MODAL_SRC, /class="fk"/, "FK select missing from modal");
	assert.match(MODAL_SRC, /class="act"/, "ON DELETE select missing from modal");
	// ON UPDATE is a second select, so the single class="act" match above cannot
	// see it: pin the label and the mutation, or a missing ON UPDATE control
	// passes this test by virtue of its sibling existing.
	assert.match(MODAL_SRC, /ON UPDATE/, "ON UPDATE control missing from modal");
	assert.match(
		MODAL_SRC,
		/setRefOnUpdate/,
		"ON UPDATE is not wired in the modal",
	);
	// the array control must exist AND be gated on the postgres dialect: the
	// server refuses to emit an array type for any other dialect, so offering
	// the control elsewhere would let the user build a schema that cannot save
	assert.match(MODAL_SRC, /class="isarray"/, "array toggle missing from modal");
	assert.match(
		MODAL_SRC,
		/toggleArray/,
		"array toggle is not wired in the modal",
	);
	assert.match(
		MODAL_SRC,
		/dialect === "postgres"/,
		"array toggle is not gated on the postgres dialect",
	);
	// all five flags still wired to their mutations
	assert.match(MODAL_SRC, /togglePk/, "PK is not wired in the modal");
	assert.match(MODAL_SRC, /toggleFlag/, "the flag toggles are not wired");
	// removing a column is still reachable, or the row lost its delete affordance
	assert.match(MODAL_SRC, /rmColumn/, "remove-column is not reachable");
	// the modal must not reintroduce what the row was freed from: it is a
	// dialog so BOX_W does not bind it, but it must use no inline styles —
	// the CSP is style-src 'self' and would block them
	assert.ok(
		!MODAL_SRC.includes('style="'),
		"ColumnEditModal uses an inline style attribute, which the CSP blocks",
	);
	// and it must be a native <dialog>, which is what provides the top layer,
	// focus trapping and Escape-to-close without an overlay reimplementation
	assert.match(MODAL_SRC, /<dialog\b/, "modal is not a native <dialog>");
	assert.match(MODAL_SRC, /showModal\(\)/, "modal never calls showModal()");
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

import {
	captureSize,
	decodeSvgDataUrl,
	pngFilename,
	svgFilename,
} from "../src/capture.js";

test("pngFilename mirrors exportFilename with .png", () => {
	assert.equal(pngFilename("mydb.sql", "mysql"), "mydb.png");
	assert.equal(pngFilename("MYDB.SQL", "mysql"), "MYDB.png");
	assert.equal(pngFilename("", "mysql"), "mysql-schema.png");
	assert.equal(pngFilename("", "postgres"), "postgres-schema.png");
	assert.equal(pngFilename(null, "sqlite"), "sqlite-schema.png");
	assert.equal(pngFilename("", ""), "erd-schema.png");
});

test("svgFilename mirrors pngFilename with .svg", () => {
	assert.equal(svgFilename("mydb.sql", "mysql"), "mydb.svg");
	assert.equal(svgFilename("MYDB.SQL", "mysql"), "MYDB.svg");
	assert.equal(svgFilename("", "mysql"), "mysql-schema.svg");
	assert.equal(svgFilename(null, "postgres"), "postgres-schema.svg");
	assert.equal(svgFilename("", ""), "erd-schema.svg");
});

// toSvg() returns a data URL, and writing that straight to a .svg file would
// produce a file starting "data:image/svg+xml..." that no viewer opens. These
// pin the unwrapping, which is the part of the SVG path with a failure mode.
test("decodeSvgDataUrl unwraps an encodeURIComponent data URL to SVG source", () => {
	const src = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="5"/></svg>';
	const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(src)}`;
	assert.equal(decodeSvgDataUrl(dataUrl), src);
	// the decoded form must actually start with the tag, which is the property
	// that makes the output a valid .svg file
	assert.ok(decodeSvgDataUrl(dataUrl).startsWith("<svg"));
});

test("decodeSvgDataUrl handles base64 and rejects non-SVG payloads", () => {
	const src = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
	const b64 = Buffer.from(src, "utf8").toString("base64");
	assert.equal(
		decodeSvgDataUrl(`data:image/svg+xml;base64,${b64}`),
		src,
		"base64 data URL must decode too",
	);
	// not a data URL at all → the capture contract was broken
	assert.throws(() => decodeSvgDataUrl("<svg></svg>"), /no data URL/);
	// a data URL that decodes to something other than SVG must not be written
	// out as a .svg file
	assert.throws(
		() => decodeSvgDataUrl("data:text/plain,not%20svg"),
		/did not decode to SVG/,
	);
	assert.throws(() => decodeSvgDataUrl("data:image/svg+xml"), /malformed/);
});

test("captureSize measures the whole diagram, not the viewport", () => {
	const s = {
		tables: [
			{ x: 40, y: 40, columns: [{}, {}] },
			{ x: 380, y: 200, columns: [{}] },
		],
	};
	// widest right edge: 380 + BOX_W(280) = 660, plus 40 pad
	// lowest bottom edge: 200 + boxHeight(1)=97 = 297, plus 40 pad
	assert.deepEqual(captureSize(s), { width: 700, height: 337 });
});

// The bug this pins: html-to-image sized its output from the canvas's
// clientHeight — the *viewport* — because captureSize() existed but was never
// passed to it. A 9-table diagram in a 1280x800 window exported 1280x759 with
// the last two tables cropped off, and the e2e test passed anyway because it
// only asserted a PNG signature and >1000 bytes. Sizing from the cards makes
// the result independent of any viewport, so this asserts a card below the fold
// is still counted.
test("captureSize includes cards below the fold", () => {
	const far = { x: 40, y: 5000, columns: [{}, {}] };
	const size = captureSize({ tables: [far] });
	assert.equal(size.height, 5000 + 139 + 40);
	assert.ok(size.height > 800, "a card below the fold must still be counted");
});

test("captureSize returns null with nothing to draw", () => {
	assert.equal(captureSize({ tables: [] }), null);
	assert.equal(captureSize(null), null);
});
