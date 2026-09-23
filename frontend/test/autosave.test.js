import assert from "node:assert/strict";
import { test } from "node:test";
import {
	clearTimers,
	flushCurrent,
	installFlush,
	isDirty,
	markSkipTouch,
	setDirty,
	touch,
} from "../src/autosave.js";

function fakeStore(currentFile = "a.sql") {
	return { currentFile, schema: { dialect: "mysql", tables: [] }, sqlText: "" };
}

test("isDirty/setDirty", () => {
	setDirty(false);
	assert.equal(isDirty(), false);
	setDirty(true);
	assert.equal(isDirty(), true);
	setDirty(false);
	assert.equal(isDirty(), false);
});

test("touch sets dirty and schedules lint", async () => {
	setDirty(false);
	clearTimers();
	let lintCalled = 0;
	let saveCalled = 0;
	let sqlCalled = 0;
	const store = fakeStore("a.sql");
	touch(false, {
		store,
		refreshLint: () => lintCalled++,
		refreshSql: () => sqlCalled++,
		saveCurrent: () => saveCalled++,
	});
	assert.equal(isDirty(), true);
	assert.equal(store.dirty, true, "reactive mirror must follow the flag");
	await new Promise((r) => setTimeout(r, 350));
	assert.equal(lintCalled, 1);
	assert.equal(saveCalled, 0);
	await new Promise((r) => setTimeout(r, 500));
	assert.equal(saveCalled, 1);
	assert.equal(sqlCalled, 0);
	clearTimers();
	setDirty(false);
});

test("touch with showSql schedules sql", async () => {
	clearTimers();
	setDirty(false);
	let sqlCalled = 0;
	const store = fakeStore("a.sql");
	touch(true, {
		store,
		refreshLint: () => {},
		refreshSql: () => sqlCalled++,
		saveCurrent: () => {},
	});
	await new Promise((r) => setTimeout(r, 350));
	assert.equal(sqlCalled, 1);
	clearTimers();
	setDirty(false);
});

test("markSkipTouch skips next touch", async () => {
	clearTimers();
	setDirty(false);
	markSkipTouch();
	let lintCalled = 0;
	const store = fakeStore("a.sql");
	touch(false, {
		store,
		refreshLint: () => lintCalled++,
		refreshSql: () => {},
		saveCurrent: () => {},
	});
	assert.equal(isDirty(), false);
	assert.equal(lintCalled, 0);
	// next touch should work
	touch(false, {
		store,
		refreshLint: () => lintCalled++,
		refreshSql: () => {},
		saveCurrent: () => {},
	});
	assert.equal(isDirty(), true);
	await new Promise((r) => setTimeout(r, 350));
	assert.equal(lintCalled, 1);
	clearTimers();
	setDirty(false);
});

test("touch without currentFile does not schedule save", async () => {
	clearTimers();
	setDirty(false);
	let saveCalled = 0;
	const store = fakeStore("");
	touch(false, {
		store,
		refreshLint: () => {},
		refreshSql: () => {},
		saveCurrent: () => saveCalled++,
	});
	assert.equal(isDirty(), true);
	await new Promise((r) => setTimeout(r, 850));
	assert.equal(saveCalled, 0);
	clearTimers();
	setDirty(false);
});

test("clearTimers cancels pending", async () => {
	clearTimers();
	setDirty(false);
	let lintCalled = 0;
	const store = fakeStore("a.sql");
	touch(false, {
		store,
		refreshLint: () => lintCalled++,
		refreshSql: () => {},
		saveCurrent: () => {},
	});
	clearTimers();
	await new Promise((r) => setTimeout(r, 350));
	assert.equal(lintCalled, 0);
	setDirty(false);
});

test("flushCurrent saves when dirty and has file", async () => {
	clearTimers();
	setDirty(true);
	let saveCalled = 0;
	const store = fakeStore("a.sql");
	await flushCurrent({ store, saveCurrent: async () => saveCalled++ });
	assert.equal(saveCalled, 1);
	assert.equal(isDirty(), true); // flushCurrent does not clear dirty; the real saveCurrent does
	setDirty(false);
});

test("flushCurrent does nothing when not dirty", async () => {
	clearTimers();
	setDirty(false);
	let saveCalled = 0;
	const store = fakeStore("a.sql");
	await flushCurrent({ store, saveCurrent: async () => saveCalled++ });
	assert.equal(saveCalled, 0);
});

test("flushCurrent does nothing when no currentFile", async () => {
	clearTimers();
	setDirty(true);
	let saveCalled = 0;
	const store = fakeStore("");
	await flushCurrent({ store, saveCurrent: async () => saveCalled++ });
	assert.equal(saveCalled, 0);
	setDirty(false);
});

test("installFlush registers listeners", () => {
	const origWindow = global.window;
	const events = [];
	global.window = {
		addEventListener: (ev, _fn) => events.push(ev),
	};
	installFlush(() => {});
	assert.ok(events.includes("pagehide"));
	assert.ok(events.includes("beforeunload"));
	global.window = origWindow;
});
