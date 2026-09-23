import assert from "node:assert/strict";
import { test } from "node:test";
import { editGeneration, isDirty, setDirty, touch } from "../src/autosave.js";
import { saveCurrent } from "../src/fileStore.js";

// saveCurrent takes (store, flash, silent). driveSave returns a handle with
// resolvers so a test can complete the fetch calls in any order.
function fakeStore() {
	return { currentFile: "a.sql", schema: { dialect: "mysql", tables: [] } };
}

function pendingFetch() {
	const pending = [];
	const origFetch = globalThis.fetch;
	globalThis.fetch = () => new Promise((res) => pending.push(res));
	return {
		resolveWith(ok, n = 0) {
			if (n >= pending.length) throw new Error(`no fetch call ${n}`);
			pending[n]({ ok, text: async () => "" });
		},
		restore() {
			globalThis.fetch = origFetch;
		},
	};
}

test("saveCurrent clears dirty when no edits happened in flight", async () => {
	const pf = pendingFetch();
	setDirty(true);
	const p = saveCurrent(fakeStore(), () => {}, true);
	pf.resolveWith(true);
	await p;
	assert.equal(isDirty(), false);
	pf.restore();
	setDirty(false);
});

test("stale save response does not clear dirty for newer edits", async () => {
	const pf = pendingFetch();
	const store = fakeStore();
	const flash = () => {};
	setDirty(true);
	// edit 1 → save 1 starts, fetch in flight
	const p1 = saveCurrent(store, flash, true);
	// edit 2 arrives before save 1 resolves; dirty must stay true
	touch(false, {
		store,
		refreshLint: () => {},
		refreshSql: () => {},
		saveCurrent: () => {},
	});
	assert.equal(isDirty(), true);
	// save 1 resolves AFTER edit 2 → must NOT clear the flag
	pf.resolveWith(true, 0);
	await p1;
	assert.equal(isDirty(), true, "stale save response cleared dirty");
	// a later save (after the newer edit) resolving clean DOES clear it
	const p2 = saveCurrent(store, flash, true);
	pf.resolveWith(true, 1);
	await p2;
	assert.equal(isDirty(), false, "fresh save response did not clear dirty");
	pf.restore();
	setDirty(false);
});

test("touch bumps editGeneration, saveCurrent reads it", async () => {
	const store = fakeStore();
	const g0 = editGeneration();
	touch(false, {
		store,
		refreshLint: () => {},
		refreshSql: () => {},
		saveCurrent: () => {},
	});
	assert.equal(
		editGeneration(),
		g0 + 1,
		"editGeneration must advance on touch",
	);
	setDirty(false);
});
