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

// Labels ride ON the curve. Their position comes from the same cubic the path
// uses, so a label cannot drift off its own line — which is what happened when
// they were positioned relative to a card border: whenever the curve was not
// beside a card, the label floated in empty space with no visible line.
test("edgePaths: labels lie on their own curve, child to the right", () => {
	const users = tab("u", 0, 0, [{ pk: true, nn: true }]);
	const posts = tab("p", 700, 0, [
		{ pk: true, nn: true, ref: { tableId: "u" } },
	]);
	const [e] = edgePaths({ tables: [users, posts] });
	assert.equal(e.from.text, "0..1", "child is a sole pk → unique");
	assert.equal(e.to.text, "1..1");
	// both labels sit within the span the curve covers, and the child's is
	// nearer the child card — the notation must not be swapped
	for (const p of [e.from, e.to]) {
		assert.ok(p.x > 280 && p.x < 700, `label x ${p.x} not between the cards`);
	}
	assert.ok(e.from.x > e.to.x, "child label nearer the child card");
});

test("edgePaths: labels lie on their own curve, child to the left", () => {
	const users = tab("u", 700, 0, [{ pk: true, nn: true }]);
	const posts = tab("p", 0, 0, [{ pk: true, nn: true, ref: { tableId: "u" } }]);
	const [e] = edgePaths({ tables: [users, posts] });
	// child (posts) is the LEFT card now → its label must be the left one
	assert.ok(e.from.x < e.to.x, "child label nearer the child card");
	for (const p of [e.from, e.to]) {
		assert.ok(p.x > 280 && p.x < 700, `label x ${p.x} not between the cards`);
	}
});

// The default layout stacks new tables directly below the last one, so every
// card shares an x range. The curve then degenerated to a vertical line lying
// exactly on the card border — invisible — with its labels adrift in space.
// The bow is what makes the edge visible at all, so it is asserted here rather
// than left as an incidental detail.
test("edgePaths: overlapping cards bow the edge clear of the border", () => {
	const users = tab("u", 40, 40, [{ pk: true, nn: true }]);
	const posts = tab("p", 40, 200, [
		{ pk: true, nn: true, ref: { tableId: "u" } },
	]);
	const [e] = edgePaths({ tables: [users, posts] });
	const right = 40 + BOX_W;
	// the labels are clear of the card on both ends
	assert.ok(e.from.x > right, `child label ${e.from.x} not clear of the card`);
	assert.ok(e.to.x > right, `parent label ${e.to.x} not clear of the card`);
	// the curve bows out, so the stroke is off the border. The bow is
	// symmetric, so the two labels share an x and are separated by y — which
	// is why the assertion below is on the control point, not on the labels
	// differing in x.
	const bowX = Number(/C ([\d.-]+) /.exec(e.d)?.[1]);
	assert.ok(
		bowX > right,
		`curve control point ${bowX} must bow past the card border ${right}`,
	);
	// and the two labels do not sit on top of each other
	assert.notEqual(e.from.y, e.to.y, "labels must be separated vertically");
});

// Every FK into one table terminates at the same point (its header centre), so
// two such edges converge as they approach it and their parent-end labels can
// collide. This was found visually at t=0.82, where two labels landed 9px apart
// with 10px-tall text; the fractions are 0.25/0.75 so the labels sit where the
// edges are still apart.
test("edgePaths: two FKs into one parent do not collide at the parent end", () => {
	const users = tab("u", 0, 0, [{ pk: true, nn: true }]);
	const a = tab("a", 40, 200, [{ pk: true, nn: true, ref: { tableId: "u" } }]);
	const b = tab("b", 40, 320, [{ pk: true, nn: true, ref: { tableId: "u" } }]);
	const edges = edgePaths({ tables: [users, a, b] });
	assert.equal(edges.length, 2);
	const [e1, e2] = edges;
	// both parent-end labels are 1..1 and must not overlap: they need at least
	// one text height (10px) of vertical separation
	const dy = Math.abs(e1.to.y - e2.to.y);
	assert.ok(
		dy >= 10,
		`parent-end labels only ${dy.toFixed(1)}px apart — they would overlap`,
	);
});

test("edgePaths: a self edge still gets labels", () => {
	const s = tab("t1", 50, 20, [{ pk: true, ref: { tableId: "t1" } }]);
	const [e] = edgePaths({ tables: [s] });
	assert.equal(e.from.text, "0..1", "sole pk → unique");
	// The parent end is 1..1, NOT 0..1: this column is a primary key, and every
	// emitter writes NOT NULL for a PK regardless of the nn flag. Reading `nn`
	// alone here is the bug that made the diagram disagree with its own DDL —
	// this assertion previously encoded it.
	assert.equal(e.to.text, "1..1", "pk → emitted NOT NULL → mandatory");
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

// A self-referencing FK (parent_id → same table) is a real pattern that parses,
// emits and round-trips. The loop must leave and re-enter the card from OUTSIDE
// it: the old routing ran from t.x to t.x + 60, straight through the card body,
// drawing the curve and both labels inside the table.
test("edgePaths: self edge loops outside the card, not through it", () => {
	const s = tab("t1", 50, 20, [{ id: "c1", ref: { tableId: "t1" } }]);
	const [e] = edgePaths({ tables: [s] });
	assert.equal(e.self, true);
	// both ends sit on the card's RIGHT border, clear of the body
	assert.ok(
		e.d.startsWith(`M ${50 + BOX_W} `),
		`x1 should be the right border: ${e.d}`,
	);
	// the curve bows out to the right, away from the card
	const bowX = Number(/C ([\d.-]+) /.exec(e.d)?.[1]);
	assert.ok(bowX > 50 + BOX_W, `curve must bow outside the card, got ${bowX}`);
	// and neither label is inside the card
	const card = { l: 50, r: 50 + BOX_W, t: 20, b: 20 + boxHeight(1) };
	for (const [name, p] of [
		["from", e.from],
		["to", e.to],
	]) {
		const inside =
			p.x >= card.l && p.x <= card.r && p.y >= card.t && p.y <= card.b;
		assert.ok(!inside, `${name} label (${p.x},${p.y}) is inside the card`);
	}
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

// PARTIAL x overlap, the case the old exact-equality check missed: a and b
// overlap by 180px but share no border, so the side-to-side routing sent the
// curve through both card bodies. Both ends now leave from the right of the
// rightmost card, clear of both.
test("edgePaths: partial x overlap bows clear of both cards", () => {
	const a = tab("a", 0, 0, [{ id: "x", ref: { tableId: "b" } }]);
	const b = tab("b", 100, 0, [{ id: "y" }]);
	const [e] = edgePaths({ tables: [a, b] });
	const rightmost = 100 + BOX_W; // b is the rightmost card
	assert.ok(
		e.d.startsWith(`M ${rightmost} `),
		`both ends should leave the rightmost border: ${e.d}`,
	);
	// the curve bows outside it, and the labels are clear of both cards
	const bowX = Number(/C ([\d.-]+) /.exec(e.d)?.[1]);
	assert.ok(bowX > rightmost, `curve must bow clear, got ${bowX}`);
	for (const [name, p] of [
		["from", e.from],
		["to", e.to],
	]) {
		assert.ok(p.x > rightmost, `${name} label ${p.x} not clear of the cards`);
	}
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
