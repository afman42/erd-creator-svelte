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
	BORDER_H,
	BOX_W,
	boxHeight,
	GAP,
	HDR_H,
	ROW_H,
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
const STYLE = CARD_SRC.slice(
	CARD_SRC.indexOf("<style>"),
	CARD_SRC.lastIndexOf("</style>"),
).replace(/\/\*[\s\S]*?\*\//g, "");

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
	// Worst case per row: name, type select, 5 flag labels (PK NN UQ AI IX),
	// FK select, FK action select, remove button — ten flex children.
	//
	// This is a genuine space budget, not a formality. Measured in Chromium, the
	// controls need ~342px to show their longest option against a 280px box, so
	// something must clip; the name field absorbs it (it scrolls) and the type
	// select is given a floor that shows all but TIMESTAMP. This test pins that
	// arrangement: if a control grows, the name field is squeezed and the
	// assertion on its resulting width fails.
	const LABEL_W = 19; // measured in Chromium: widest flag label at 9px
	const GAP = px(decl(".row", "gap"), ".row gap");
	const PAD = 2 * 2; // .row padding: 1px 2px
	const NAME_MIN = px(
		decl("input.cname", "min-width"),
		"input.cname min-width",
	);
	const TYPE_MIN = px(
		decl(".row select:not(.fk):not(.act)", "min-width"),
		"type select min-width",
	);
	const fixed =
		NAME_MIN +
		TYPE_MIN +
		px(decl(".row select.fk", "width"), ".fk width") +
		px(decl(".row select.act", "width"), ".act width") +
		5 * LABEL_W;

	// 10 flex children in the widest row => 9 gaps
	const needed = fixed + 9 * GAP + PAD;
	assert.ok(
		needed <= BOX_W,
		`widest column row needs ${needed}px but the box is ${BOX_W}px ` +
			`(${needed - BOX_W}px over) — controls would spill outside the card`,
	);
	// the name field gets whatever is left; it must stay usable
	const nameActual = NAME_MIN + (BOX_W - needed);
	assert.ok(
		nameActual >= 28,
		`name field would be squeezed to ${nameActual}px — below a usable width`,
	);
	// and the type select must stay wide enough to read the type names
	assert.ok(
		TYPE_MIN >= 60,
		`type select floor is ${TYPE_MIN}px — too narrow to read the type names`,
	);
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
