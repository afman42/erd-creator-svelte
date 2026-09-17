import assert from "node:assert/strict";
import { test } from "node:test";
import { BOX_W, edgePaths, HDR_H, ROW_H } from "../src/geometry.js";

const tab = (id, x, y, cols) => ({ id, x, y, columns: cols });

test("constants match CSS", () => {
	assert.equal(BOX_W, 280);
	assert.equal(HDR_H, 28);
	assert.equal(ROW_H, 42);
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
