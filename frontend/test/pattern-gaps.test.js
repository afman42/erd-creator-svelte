// pattern-gaps.test.js — pins for the just-applied frontend refactors:
// apiJson extraction, promptFileName unification, flushCurrent delegation.
//
// NOT covered here (with reason):
// - commitName/dupOf live in schema.svelte.js, which uses Svelte 5 runes
//   ($state) and is not importable under plain node --test (same documented
//   verdict as store-helpers.test.js). Needs a rune-transpiling harness.
// - longestTablePrefix lives in LintPanel.svelte (a .svelte component, not
//   importable). Its rule — longest table-name prefix before a dot — is
//   exercised by the e2e lint click-to-jump test instead.
import assert from "node:assert/strict";
import { test } from "node:test";
import { apiJson } from "../src/api.js";
import { setDirty } from "../src/autosave.js";
import { newFile, openFile, promptFileName } from "../src/fileStore.js";
import {
	makeFlash,
	makeStore,
	resetAutosave,
	stubFetch,
	withPrompt,
} from "./helpers.js";

// ---- apiJson: the GET-JSON twin of api() ----

test("apiJson: success returns the parsed JSON", async () => {
	const { restore } = stubFetch([{ ok: true, json: { tables: [] } }]);
	try {
		assert.deepEqual(await apiJson("/api/files"), { tables: [] });
	} finally {
		restore();
	}
});

test("apiJson: !ok throws Error carrying the body text", async () => {
	const { calls, restore } = stubFetch([
		{ ok: false, text: "file not found: x.sql" },
	]);
	try {
		await assert.rejects(apiJson("/api/files/x.sql"), /file not found: x\.sql/);
		assert.equal(calls.length, 1);
	} finally {
		restore();
	}
});

// ---- promptFileName: one prompt+normalize body behind new/rename/duplicate ----

test("promptFileName: cancel (null) resolves to empty", async () => {
	const name = await withPrompt(
		() => null,
		() => Promise.resolve(promptFileName("New schema file name:", "schema")),
	);
	assert.equal(name, "");
});

test("promptFileName: empty and blank resolve to empty", async () => {
	for (const v of ["", "   "]) {
		const name = await withPrompt(
			() => v,
			() => Promise.resolve(promptFileName("Name:", "schema")),
		);
		assert.equal(name, "", `input ${JSON.stringify(v)} should resolve empty`);
	}
});

test("promptFileName: valid input resolves to a .sql name", async () => {
	const name = await withPrompt(
		() => "mydb",
		() => Promise.resolve(promptFileName("Name:", "schema")),
	);
	assert.equal(name, "mydb.sql");
});

test("newFile: taken name flashes and never reaches the server", async () => {
	const store = { currentFile: "", files: [{ name: "x.sql", mtime: 0 }] };
	const [msgs, flash] = makeFlash();
	const f = stubFetch();
	try {
		await withPrompt(
			() => "x",
			() => newFile(store, flash),
		);
		assert.equal(f.calls.length, 0, "no fetch for a clashing new file");
		assert.equal(msgs[0], "x.sql already exists");
		assert.equal(
			store.currentFile,
			"",
			"editor must not point at a file never created",
		);
	} finally {
		f.restore();
	}
});

// ---- flushCurrent delegation: file switches flush pending edits first ----

test("openFile: dirty store with a file saves before loading", async () => {
	resetAutosave();
	setDirty(true);
	const store = makeStore({
		currentFile: "a.sql",
		schema: { dialect: "mysql", tables: [] },
	});
	const f = stubFetch([
		{ ok: true, text: "" }, // PUT saveCurrent (silent flush)
		{
			ok: true,
			json: {
				dialect: "mysql",
				sqliteTypes: "native",
				tables: [{ id: "t9", name: "users", columns: [], indexes: [] }],
			},
		},
	]);
	try {
		const { openFile: open } = await import("../src/fileStore.js");
		await open(store, "b.sql", () => {});
		assert.equal(f.calls.length, 2, "flush PUT must precede the open GET");
		assert.equal(f.calls[0].opts.method, "PUT");
		assert.match(f.calls[0].url, /a\.sql/);
		assert.match(f.calls[1].url, /b\.sql/);
		assert.equal(store.currentFile, "b.sql");
	} finally {
		f.restore();
		resetAutosave();
	}
});

test("openFile: clean store skips the save", async () => {
	resetAutosave();
	setDirty(false);
	const store = makeStore({
		currentFile: "a.sql",
		schema: { dialect: "mysql", tables: [] },
	});
	const f = stubFetch([
		{
			ok: true,
			json: {
				dialect: "mysql",
				sqliteTypes: "native",
				tables: [{ id: "t9", name: "users", columns: [], indexes: [] }],
			},
		},
	]);
	try {
		await openFile(store, "b.sql", () => {});
		assert.equal(f.calls.length, 1, "clean store must not PUT before opening");
		assert.match(f.calls[0].url, /b\.sql/);
	} finally {
		f.restore();
		resetAutosave();
	}
});
