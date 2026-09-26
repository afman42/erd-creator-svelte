import assert from "node:assert/strict";
import { test } from "node:test";
import { editGeneration, isDirty, setDirty, touch } from "../src/autosave.js";
import { saveCurrent } from "../src/fileStore.js";
import {
	makeFlash,
	makeStore,
	pendingFetch,
	resetAutosave,
	stubFetch,
	withPrompt,
} from "./helpers.js";

test("saveCurrent clears dirty when no edits happened in flight", async () => {
	const pf = pendingFetch();
	resetAutosave();
	setDirty(true);
	const p = saveCurrent(makeStore(), () => {}, true);
	pf.resolveWith(true);
	await p;
	assert.equal(isDirty(), false);
	pf.restore();
	setDirty(false);
});

test("stale save response does not clear dirty for newer edits", async () => {
	const pf = pendingFetch();
	const store = makeStore();
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
	const store = makeStore();
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

import { duplicateFile, renameFile } from "../src/fileStore.js";

// renameFile/duplicateFile prompt for the target name and then refresh the
// file list, so the mock must serve the op call and the GET /api/files call.
// opFetch/withPrompt/flashCollector now live in ./helpers.js as
// stubFetch/withPrompt/makeFlash.

test("renameFile moves the file and repoints currentFile", async () => {
	const store = { currentFile: "a.sql", files: [{ name: "a.sql", mtime: 0 }] };
	const [msgs, flash] = makeFlash();
	const f = stubFetch([
		{ ok: true },
		{ ok: true, json: [{ name: "b.sql", mtime: 1 }] },
	]);
	await withPrompt(
		() => "b",
		() => renameFile(store, flash),
	);
	assert.equal(store.currentFile, "b.sql");
	assert.equal(f.calls[0].url, "/api/files/rename");
	assert.deepEqual(JSON.parse(f.calls[0].opts.body), {
		from: "a.sql",
		to: "b.sql",
	});
	assert.deepEqual(store.files, [{ name: "b.sql", mtime: 1 }]);
	assert.ok(msgs.includes("renamed to b.sql"));
	f.restore();
});

test("renameFile refuses a taken name without calling the server", async () => {
	const store = { currentFile: "a.sql", files: [{ name: "b.sql", mtime: 0 }] };
	const [msgs, flash] = makeFlash();
	const f = stubFetch();
	await withPrompt(
		() => "b",
		() => renameFile(store, flash),
	);
	assert.equal(store.currentFile, "a.sql");
	assert.equal(f.calls.length, 0, "no fetch for a clashing rename");
	assert.equal(msgs[0], "b.sql already exists");
	f.restore();
});

test("renameFile failure keeps currentFile and flashes the server error", async () => {
	const store = { currentFile: "a.sql", files: [{ name: "a.sql", mtime: 0 }] };
	const [msgs, flash] = makeFlash();
	const f = stubFetch([
		{ ok: false, text: "boom" },
		{ ok: true, json: [] },
	]);
	await withPrompt(
		() => "b",
		() => renameFile(store, flash),
	);
	assert.equal(store.currentFile, "a.sql");
	assert.ok(msgs.some((m) => m.includes("rename failed: boom")));
	f.restore();
});

test("duplicateFile skips taken _copy names and echoes the suggestion", async () => {
	const store = {
		currentFile: "blog.sql",
		files: [
			{ name: "blog.sql", mtime: 0 },
			{ name: "blog_copy.sql", mtime: 0 },
		],
	};
	const [msgs, flash] = makeFlash();
	const f = stubFetch([{ ok: true }, { ok: true, json: [] }]);
	// echo the prompt's default — the derived unused name
	await withPrompt(
		(_msg, def) => def,
		() => duplicateFile(store, flash),
	);
	assert.deepEqual(JSON.parse(f.calls[0].opts.body), {
		from: "blog.sql",
		to: "blog_copy2.sql",
	});
	assert.ok(msgs.includes("duplicated as blog_copy2.sql"));
	assert.equal(store.currentFile, "blog.sql", "editor stays on the original");
	f.restore();
});

test("resolveFileName strips separators and controls", async () => {
	const { resolveFileName } = await import("../src/api.js");
	assert.equal(resolveFileName("a/b"), "ab.sql");
	assert.equal(resolveFileName("a\\b"), "ab.sql");
	assert.equal(resolveFileName("a\x00b"), "ab.sql");
	assert.equal(resolveFileName("ok name"), "ok name.sql");
	assert.equal(resolveFileName("x.sql"), "x.sql");
	assert.equal(resolveFileName(""), "");
});
