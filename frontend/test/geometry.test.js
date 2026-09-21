import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ADDCOL_H,
	BORDER_H,
	BOX_W,
	boxHeight,
	cardinality,
	edgePaths,
	GAP,
	HDR_H,
	ROW_CENTER,
	ROW_H,
	stackStep,
} from "../src/geometry.js";

const tab = (id, x, y, cols) => ({ id, x, y, columns: cols });

// ---- min-max cardinality ----
//
// Derived from flags the model already has, so there is no stored cardinality
// to contradict the DDL. The truth table below IS the specification.

test("cardinality: NOT NULL decides the parent end", () => {
	const t = tab("c", 0, 0, []);
	assert.equal(cardinality(t, { nn: true }).parent, "1..1");
	assert.equal(cardinality(t, { nn: false }).parent, "0..1");
	// parent max is always 1 — an FK is a scalar reference, so a child row can
	// never point at more than one parent row
	assert.ok(cardinality(t, { nn: true }).parent.endsWith("1"));
});

test("cardinality: UQ makes the child end unique", () => {
	const t = tab("c", 0, 0, []);
	assert.equal(cardinality(t, { ux: true }).child, "0..1");
	assert.equal(cardinality(t, { ux: false }).child, "0..N");
});

test("cardinality: a SOLE primary key is unique", () => {
	const t = tab("c", 0, 0, [{ pk: true }, { pk: false }]);
	assert.equal(cardinality(t, t.columns[0]).child, "0..1");
});

// The one that matters most: in a junction table PK(a, b) each column repeats
// freely — that is exactly WHY it is M:N. Reading `pk` as unique would label
// every junction table 0..1 and invert the meaning of the notation.
test("cardinality: a composite-PK member is NOT unique", () => {
	const t = tab("c", 0, 0, [{ pk: true }, { pk: true }]);
	assert.equal(cardinality(t, t.columns[0]).child, "0..N");
	assert.equal(cardinality(t, t.columns[1]).child, "0..N");
});

// SQL cannot express "every parent must have at least one child", so 1..N is
// never correct: it would assert something the database cannot enforce.
test("cardinality: the child minimum is always 0", () => {
	for (const c of [
		{},
		{ ux: true },
		{ pk: true },
		{ nn: true },
		{ ux: true, nn: true },
	]) {
		assert.ok(
			cardinality(tab("c", 0, 0, [c]), c).child.startsWith("0.."),
			"child min must always be 0",
		);
	}
});

test("edgePaths: an M:N junction table labels both edges 0..N / 1..1", () => {
	// posts 1—N post_tags N—1 tags: the canonical M:N shape
	const posts = tab("p", 0, 0, [{ pk: true, nn: true }]);
	const tags = tab("g", 700, 0, [{ pk: true, nn: true }]);
	const j = tab("j", 350, 0, [
		{ pk: true, nn: true, ref: { tableId: "p" } },
		{ pk: true, nn: true, ref: { tableId: "g" } },
	]);
	const edges = edgePaths({ tables: [posts, tags, j] });
	assert.equal(edges.length, 2);
	for (const e of edges) {
		assert.equal(e.from.text, "0..N", "junction side is many");
		assert.equal(e.to.text, "1..1", "referenced side is exactly one");
	}
});

test("edgePaths: a unique FK labels the child end 0..1 (one-to-one)", () => {
	const users = tab("u", 0, 0, [{ pk: true }]);
	const profile = tab("f", 700, 0, [
		{ pk: true },
		{ ux: true, nn: true, ref: { tableId: "u" } },
	]);
	const [e] = edgePaths({ tables: [users, profile] });
	assert.equal(e.from.text, "0..1");
	assert.equal(e.to.text, "1..1");
});

test("edgePaths: a nullable FK labels the parent end 0..1", () => {
	const users = tab("u", 0, 0, [{ pk: true }]);
	const posts = tab("p", 700, 0, [
		{ pk: true },
		{ nn: false, ref: { tableId: "u" } },
	]);
	const [e] = edgePaths({ tables: [users, posts] });
	assert.equal(e.to.text, "0..1");
});

// The labels must be attached to the RIGHT CARD, not merely to a path end.
// This is the bug the visual check caught: the path picks whichever borders
// are nearest, so when the child sits to the right the path STARTS at the
// parent — anchoring `child` to the path start drew the "many" symbol on the
// parent and inverted the notation. Asserting coordinates alone did not catch
// it, so these tests assert which card each label is beside.
test("edgePaths: each label sits beside its own card, child to the right", () => {
	const users = tab("u", 0, 0, [{ pk: true, nn: true }]);
	const posts = tab("p", 700, 0, [
		{ pk: true, nn: true, ref: { tableId: "u" } },
	]);
	const [e] = edgePaths({ tables: [users, posts] });
	// child (posts) is the RIGHT card (700..980); its label must be just left
	// of it, in the gap — NOT beside the parent at 0..280
	assert.equal(e.from.text, "0..1", "child is a sole pk → unique");
	assert.ok(
		e.from.x > 280 && e.from.x < 700,
		`child label must be in the gap (280..700), got ${e.from.x}`,
	);
	// parent (users) is the LEFT card; its label must be just right of it
	assert.equal(e.to.text, "1..1");
	assert.ok(
		e.to.x > 280 && e.to.x < 700,
		`parent label must be in the gap (280..700), got ${e.to.x}`,
	);
	// the two are on opposite sides of the gap, so they cannot be swapped
	assert.ok(e.from.x > e.to.x, "child label is nearer the child card");
});

test("edgePaths: each label sits beside its own card, child to the left", () => {
	const users = tab("u", 700, 0, [{ pk: true, nn: true }]);
	const posts = tab("p", 0, 0, [{ pk: true, nn: true, ref: { tableId: "u" } }]);
	const [e] = edgePaths({ tables: [users, posts] });
	// child (posts) is now the LEFT card (0..280); parent (users) the right one
	assert.ok(
		e.from.x > 280 && e.from.x < 700,
		`child label in the gap, got ${e.from.x}`,
	);
	assert.ok(
		e.to.x > 280 && e.to.x < 700,
		`parent label in the gap, got ${e.to.x}`,
	);
	assert.ok(e.from.x < e.to.x, "child label is nearer the child card");
});

// The default layout stacks new tables directly below the last one, so both
// cards share an x range. There is then no facing border to choose, and the
// old formula nudged one label inward — inside the card. Both must go right.
test("edgePaths: stacked tables put both labels clear of the card", () => {
	const users = tab("u", 40, 40, [{ pk: true, nn: true }]);
	const posts = tab("p", 40, 200, [
		{ pk: true, nn: true, ref: { tableId: "u" } },
	]);
	const [e] = edgePaths({ tables: [users, posts] });
	const right = 40 + BOX_W;
	for (const [name, p] of [
		["from", e.from],
		["to", e.to],
	]) {
		assert.ok(
			p.x > right,
			`${name} label at ${p.x} is inside the card (40..${right})`,
		);
	}
	// and they do not collide: they differ in y (column row vs header)
	assert.notEqual(e.from.y, e.to.y);
});

test("edgePaths: a self edge still gets labels", () => {
	const s = tab("t1", 50, 20, [{ pk: true, ref: { tableId: "t1" } }]);
	const [e] = edgePaths({ tables: [s] });
	assert.equal(e.from.text, "0..1", "sole pk → unique");
	// no NN on this column, so the reference is optional
	assert.equal(e.to.text, "0..1");
	assert.ok(Number.isFinite(e.from.x) && Number.isFinite(e.to.x));
});

test("constants match CSS", () => {
	assert.equal(BOX_W, 280);
	assert.equal(HDR_H, 28);
	assert.equal(ROW_H, 42);
});

// ROW_CENTER is where an FK edge attaches inside its column row. It is
// deliberately NOT ROW_H/2: ROW_H spans the row *and* its comment line (26+16),
// so half of it (21) would land in the comment. It is half the 26px row.
test("ROW_CENTER is half the row, not half ROW_H", () => {
	assert.equal(ROW_CENTER, 13);
	assert.equal(ROW_CENTER * 2, ROW_H - 16, "2*ROW_CENTER is the 26px row");
	assert.notEqual(ROW_CENTER, ROW_H / 2);
	// and it is what edgePaths actually uses for the anchor
	const child = tab("c", 0, 0, [{ id: "c1", ref: { tableId: "p" } }]);
	const parent = tab("p", 400, 0, [{ id: "c0" }]);
	const [e] = edgePaths({ tables: [child, parent] });
	assert.ok(
		e.d.startsWith(`M ${BOX_W} ${0 + HDR_H + ROW_CENTER} `),
		`anchor should use ROW_CENTER: ${e.d}`,
	);
});

test("boxHeight and stackStep compose the CSS parts", () => {
	// the model, spelled out: header + columns + footer + borders
	assert.equal(boxHeight(0), HDR_H + ADDCOL_H + BORDER_H);
	assert.equal(boxHeight(4), HDR_H + 4 * ROW_H + ADDCOL_H + BORDER_H);
	// each added column adds exactly one ROW_H
	assert.equal(boxHeight(3) - boxHeight(2), ROW_H);
	// stackStep is one card plus the gap below it
	assert.equal(stackStep(0), boxHeight(0) + GAP);
	assert.equal(stackStep(5) - stackStep(4), ROW_H);
	// every part is a positive contribution — a zero here would silently make
	// cards overlap, which is the bug the model was introduced to fix
	for (const [name, v] of Object.entries({
		HDR_H,
		ROW_H,
		ADDCOL_H,
		BORDER_H,
		GAP,
		ROW_CENTER,
	})) {
		assert.ok(v > 0, `${name} must be positive`);
	}
});

test("edgePaths: empty schema returns empty", () => {
	assert.deepEqual(edgePaths({ tables: [] }), []);
});

test("edgePaths: dangling ref dropped", () => {
	const t = tab("t1", 0, 0, [{ id: "c1", ref: { tableId: "nope" } }]);
	assert.equal(edgePaths({ tables: [t] }).length, 0);
});

test("edgePaths: self edge uses left edge + 60", () => {
	const s = tab("t1", 50, 20, [{ id: "c1", ref: { tableId: "t1" } }]);
	const [e] = edgePaths({ tables: [s] });
	assert.equal(e.self, true);
	assert.ok(e.d.startsWith(`M 50 `), "x1 is t.x");
	assert.match(e.d, / C .* 110 /); // x2 = t.x + 60 = 110
	// ci = y + HDR_H + 0*ROW_H + 13 = 20+28+13 =61
	assert.match(e.d, /^M 50 61 /);
	// py = p.y + HDR_H/2 = 20 + 14 = 34, end y is py
	assert.match(e.d, / 34$/);
});

test("edgePaths: normal, direction-flip, self, dangling", () => {
	const users = tab("t1", 0, 0, [{ id: "c1" }]);
	const posts = tab("t2", 340, 0, [{ id: "c2", ref: { tableId: "t1" } }]);
	const same = tab("t3", 100, 0, [{ id: "c3", ref: { tableId: "t3" } }]);
	const dangling = tab("t4", 0, 100, [{ id: "c4", ref: { tableId: "nope" } }]);
	const edges = edgePaths({ tables: [users, posts, same, dangling] });
	assert.equal(edges.length, 2); // dangling dropped
	assert.equal(edges[0].self, false);
	assert.match(edges[0].d, /^M 280 /); // posts.x > users.x → starts at users right edge
	assert.ok(edges[0].d.startsWith(`M 280 ${0 + HDR_H + 13} `)); // first column row
	assert.equal(edges[1].self, true);
});
test("edgePaths: child right of parent (t.x > p.x → p right edge to t left edge)", () => {
	const parent = tab("p", 0, 40, [{ id: "c0" }]);
	const child = tab("c", 500, 10, [{ id: "c1", ref: { tableId: "p" } }]);
	const [e] = edgePaths({ tables: [parent, child] });
	assert.equal(e.self, false);
	// x1 = p.x + BOX_W = 280, x2 = child.x = 500
	// ci = child.y + HDR_H + 0*ROW_H + 13 = 10+28+13=51, py= parent.y+HDR_H/2=40+14=54
	assert.equal(e.d, `M 280 51 C 390 51, 390 54, 500 54`);
});

test("edgePaths: child far left of parent (t.x + BOX_W < p.x → t right edge to p left edge)", () => {
	const child = tab("c", 0, 0, [{ id: "c1", ref: { tableId: "p" } }]);
	const parent = tab("p", 400, 20, [{ id: "c0" }]);
	const [e] = edgePaths({ tables: [child, parent] });
	assert.equal(e.self, false);
	assert.match(e.d, /^M 280 /); // x1 = child.x + BOX_W
	assert.ok(e.d.includes(" 400 "), `x2 should be parent.x 400, got ${e.d}`);
});

test("edgePaths: overlap fallback uses right edges", () => {
	const a = tab("a", 0, 0, [{ id: "x", ref: { tableId: "b" } }]);
	const b = tab("b", 100, 0, [{ id: "y" }]);
	const [e] = edgePaths({ tables: [a, b] });
	assert.match(e.d, /^M 280 .* C .* 380 /);
});

test("edgePaths: ci offset increases with column index", () => {
	const parent = tab("p", 500, 0, [{ id: "pp" }]);
	const child = tab("c", 0, 10, [
		{ id: "c0" },
		{ id: "c1", ref: { tableId: "p" } }, // row i=1
		{ id: "c2", ref: { tableId: "p" } }, // row i=2
	]);
	const edges = edgePaths({ tables: [parent, child] });
	assert.equal(edges.length, 2);
	const ci1 = 10 + HDR_H + 1 * ROW_H + 13; // 10+28+42+13=93
	const ci2 = 10 + HDR_H + 2 * ROW_H + 13; // 135
	assert.ok(edges[0].d.startsWith(`M 280 ${ci1} `), `ci1 ${edges[0].d}`);
	assert.ok(edges[1].d.startsWith(`M 280 ${ci2} `), `ci2 ${edges[1].d}`);
});

test("edgePaths: py is parent y + HDR_H/2", () => {
	const parent = tab("p", 300, 100, [{ id: "pp" }]);
	const child = tab("c", 0, 0, [{ id: "c1", ref: { tableId: "p" } }]);
	const [e] = edgePaths({ tables: [parent, child] });
	const py = 100 + HDR_H / 2; // 114
	assert.ok(e.d.endsWith(` ${py}`), `expected py ${py}, got ${e.d}`);
	// ci = 0+28+13=41
	assert.ok(e.d.startsWith("M 280 41 "), e.d);
});
