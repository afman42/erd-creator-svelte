import assert from "node:assert/strict";
import { test } from "node:test";
import {
	flushCurrent,
	installFlush,
	isDirty,
	markSkipTouch,
	setDirty,
	touch,
} from "../src/autosave.js";
import { makeStore, resetAutosave, sleep } from "./helpers.js";

test("isDirty/setDirty", () => {
	resetAutosave();
	assert.equal(isDirty(), false);
	setDirty(true);
	assert.equal(isDirty(), true);
	resetAutosave();
	assert.equal(isDirty(), false);
});

test("touch sets dirty and schedules lint", async () => {
	resetAutosave();
	let lintCalled = 0;
	let saveCalled = 0;
	let sqlCalled = 0;
	const store = makeStore();
	touch(false, {
		store,
		refreshLint: () => lintCalled++,
		refreshSql: () => sqlCalled++,
		saveCurrent: () => saveCalled++,
	});
	assert.equal(isDirty(), true);
	assert.equal(store.dirty, true, "reactive mirror must follow the flag");
	await sleep(350);
	assert.equal(lintCalled, 1);
	assert.equal(saveCalled, 0);
	await sleep(500);
	assert.equal(saveCalled, 1);
	assert.equal(sqlCalled, 0);
	resetAutosave();
});

test("touch with showSql schedules sql", async () => {
	resetAutosave();
	let sqlCalled = 0;
	const store = makeStore();
	touch(true, {
		store,
		refreshLint: () => {},
		refreshSql: () => sqlCalled++,
		saveCurrent: () => {},
	});
	await sleep(350);
	assert.equal(sqlCalled, 1);
	resetAutosave();
});

test("markSkipTouch skips next touch", async () => {
	resetAutosave();
	markSkipTouch();
	let lintCalled = 0;
	const store = makeStore();
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
	await sleep(350);
	assert.equal(lintCalled, 1);
	resetAutosave();
});

test("touch without currentFile does not schedule save", async () => {
	resetAutosave();
	let saveCalled = 0;
	const store = makeStore({ currentFile: "" });
	touch(false, {
		store,
		refreshLint: () => {},
		refreshSql: () => {},
		saveCurrent: () => saveCalled++,
	});
	assert.equal(isDirty(), true);
	await sleep(850);
	assert.equal(saveCalled, 0);
	resetAutosave();
});

test("clearTimers cancels pending", async () => {
	resetAutosave();
	let lintCalled = 0;
	const store = makeStore();
	touch(false, {
		store,
		refreshLint: () => lintCalled++,
		refreshSql: () => {},
		saveCurrent: () => {},
	});
	resetAutosave();
	await sleep(350);
	assert.equal(lintCalled, 0);
	resetAutosave();
});

test("flushCurrent saves when dirty and has file", async () => {
	resetAutosave();
	setDirty(true);
	let saveCalled = 0;
	const store = makeStore();
	await flushCurrent({ store, saveCurrent: async () => saveCalled++ });
	assert.equal(saveCalled, 1);
	assert.equal(isDirty(), true); // flushCurrent does not clear dirty; the real saveCurrent does
	resetAutosave();
});

test("flushCurrent does nothing when not dirty", async () => {
	resetAutosave();
	let saveCalled = 0;
	const store = makeStore();
	await flushCurrent({ store, saveCurrent: async () => saveCalled++ });
	assert.equal(saveCalled, 0);
});

test("flushCurrent does nothing when no currentFile", async () => {
	resetAutosave();
	setDirty(true);
	let saveCalled = 0;
	const store = makeStore({ currentFile: "" });
	await flushCurrent({ store, saveCurrent: async () => saveCalled++ });
	assert.equal(saveCalled, 0);
	resetAutosave();
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
