import assert from "node:assert/strict";
import { test } from "node:test";
import { newSchema, newTable } from "../src/erd.js";
import { clearHistory, snap, snapRaw, undo } from "../src/history.js";

test("undo on an all-corrupt stack returns null and drains it", () => {
	clearHistory();
	snapRaw("{bad one");
	snapRaw("{bad two");
	snapRaw("{bad three");
	assert.equal(undo(), null);
	assert.equal(
		undo(),
		null,
		"second undo must also be null — stack must be drained, not stuck",
	);
});

test("undo with interleaved corrupt and valid entries returns valid then null", () => {
	clearHistory();
	const s = newSchema("mysql", [newTable("kept")]);
	snap(s);
	snapRaw("{corrupt top");
	const prev = undo();
	assert.ok(prev, "undo must skip the corrupt entry and return the valid one");
	assert.equal(prev.tables[0].name, "kept");
	assert.equal(undo(), null);
});
