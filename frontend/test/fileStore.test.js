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

test("openFile flashes import warnings and still loads the canvas", async () => {
	const origFetch = globalThis.fetch;
	const seen = [];
	globalThis.fetch = async (url) => {
		if (String(url).includes("/api/files/foreign.sql")) {
			return {
				ok: true,
				json: async () => ({
					dialect: "mysql",
					sqliteTypes: "native",
					tables: [{ id: "t9", name: "users", columns: [], indexes: [] }],
					warnings: ["line 2: CHECK constraint skipped"],
				}),
			};
		}
		return { ok: true, json: async () => [] };
	};
	try {
		const store = {
			currentFile: "",
			files: [],
			schema: { dialect: "mysql", tables: [] },
			error: "",
		};
		const { openFile } = await import("../src/fileStore.js");
		await openFile(store, "foreign.sql", (msg, kind) => seen.push([msg, kind]));
		assert.equal(store.currentFile, "foreign.sql");
		assert.equal(store.schema.tables[0].name, "users");
		assert.equal(seen.length, 1);
		assert.equal(seen[0][1], "warn");
		assert.match(seen[0][0], /imported with 1 skips/);
	} finally {
		globalThis.fetch = origFetch;
		setDirty(false);
	}
});
