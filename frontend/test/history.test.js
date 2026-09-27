import assert from "node:assert/strict";
import { test } from "node:test";
import { newSchema, newTable } from "../src/erd.js";
import {
	clearHistory,
	depth,
	setSnapHook,
	snap,
	snapRaw,
	undo,
} from "../src/history.js";

test("history snap/undo round-trips schema", () => {
	clearHistory();
	const s = newSchema("mysql", [newTable("users")]);
	s.tables[0].name = "users";
	snap(s);
	// mutate
	s.tables[0].name = "changed";
	const prev = undo();
	assert.ok(prev);
	assert.equal(prev.tables[0].name, "users");
	assert.equal(prev.tables[0].id, s.tables[0].id);
});

test("undo returns null when empty", () => {
	clearHistory();
	assert.equal(undo(), null);
});

test("depth mirrors push/pop/drain", () => {
	clearHistory();
	assert.equal(depth(), 0);
	snap(newSchema("mysql", [newTable("a")]));
	assert.equal(depth(), 1);
	snap(newSchema("mysql", [newTable("b")]));
	assert.equal(depth(), 2);
	assert.ok(undo());
	assert.equal(depth(), 1);
	clearHistory();
	assert.equal(depth(), 0);
});

test("snap caps at 60", () => {
	clearHistory();
	for (let i = 0; i < 65; i++) {
		const s = newSchema("mysql", [newTable(`t${i}`)]);
		snap(s);
	}
	// after 65 pushes, stack should be 60 (shifted)
	// undo 60 times should succeed, 61st null
	let count = 0;
	while (undo() !== null) count++;
	assert.equal(count, 60);
});

test("undo skips corrupt snapshot", () => {
	clearHistory();
	const s = newSchema("mysql", [newTable("a")]);
	snap(s);
	// snapRaw is the test seam: it pushes a pre-serialized string, so a
	// genuinely corrupt entry can be injected. undo() must skip it via the
	// catch→recurse path and return the valid snapshot beneath.
	snapRaw("{bad json");
	const prev = undo();
	assert.ok(prev, "undo skipped the corrupt entry and returned the valid one");
	assert.equal(prev.tables[0].name, "a");
	assert.equal(undo(), null);
});

test("clearHistory drops all", () => {
	clearHistory();
	snap(newSchema("mysql", [newTable("x")]));
	snap(newSchema("mysql", [newTable("y")]));
	clearHistory();
	assert.equal(undo(), null);
});

test("snap preserves dialect and columns", () => {
	clearHistory();
	const s = newSchema("postgres", [newTable("t")]);
	s.tables[0].columns.push({
		id: "c999",
		name: "flag",
		type: "BOOLEAN",
		pk: false,
		nn: false,
		ai: false,
		ux: false,
		ix: false,
		comment: "",
		ref: null,
	});
	snap(s);
	const prev = undo();
	assert.equal(prev.dialect, "postgres");
	assert.equal(prev.tables[0].columns.length, 2);
});

test("snap fires the snap hook once per call", () => {
	clearHistory();
	let calls = 0;
	setSnapHook(() => calls++);
	try {
		const s = newSchema("mysql", [newTable("a")]);
		snap(s);
		snap(s);
		assert.equal(calls, 2);
		assert.equal(depth(), 2);
	} finally {
		setSnapHook(() => {});
	}
});

test("snap hook defaults to a no-op without wiring", () => {
	clearHistory();
	setSnapHook(() => {});
	const s = newSchema("mysql", [newTable("a")]);
	snap(s);
	assert.equal(depth(), 1);
	const prev = undo();
	assert.equal(prev.tables[0].name, "a");
});
