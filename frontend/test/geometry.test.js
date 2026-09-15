import { test } from "node:test";
import assert from "node:assert/strict";
import { edgePaths, HDR_H, ROW_H } from "../src/geometry.js";

const tab = (id, x, y, cols) => ({ id, x, y, columns: cols });

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
  // FK column row lands on the bezier start: y = table.y + HDR_H + row*ROW_H + 13
});

test("edgePaths: overlap fallback uses right edges", () => {
  const a = tab("a", 0, 0, [{ id: "x", ref: { tableId: "b" } }]);
  const b = tab("b", 100, 0, [{ id: "y" }]);
  const [e] = edgePaths({ tables: [a, b] });
  assert.match(e.d, /^M 280 .* C .* 380 /);
});
