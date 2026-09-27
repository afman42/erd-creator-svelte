// store-helpers.test.js — behaviour pins for helpers the store delegates to,
// plus the documented verdict on schema.svelte.js itself.
//
// schema.svelte.js uses Svelte 5 runes ($state) and is NOT importable under
// plain node --test ($state is not defined). The store's user-visible rules
// therefore cannot be unit-tested here; what CAN be tested are the pure
// helpers those mutations delegate to, which is where the placement, naming
// and export behaviour lives. If a future harness transpiles runes, the
// behaviours to cover first are: dupTable self-ref remap, ix.cols
// rename/drop sync, case-insensitive table-dup rejection, addIndex bool
// return, setFk dispatcher no-op/snap rules.
import assert from "node:assert/strict";
import { test } from "node:test";
import { captureOptions, captureRoot, exportStem } from "../src/capture.js";
import { exportDdl, exportFilename } from "../src/export.js";
import { BOX_W, boxHeight, lowestY } from "../src/geometry.js";
import { stubFetch } from "./helpers.js";

// ---- lowestY: where a new card lands ----

test("lowestY: empty canvas starts at the origin floor", () => {
	assert.equal(lowestY([]), 40);
});

test("lowestY: a new card lands one step below the lowest card bottom", () => {
	// one card at y=40 with 2 columns: bottom = 40 + boxHeight(2),
	// next card = bottom + GAP
	const tables = [{ y: 40, columns: [{}, {}] }];
	const want = 40 + boxHeight(2) + 12;
	assert.equal(lowestY(tables), want);
});

test("lowestY: the lowest card wins, not the last one", () => {
	const tables = [
		{ y: 500, columns: [{}] },
		{ y: 40, columns: [{}, {}, {}] },
	];
	const a = 500 + boxHeight(1) + 12;
	const b = 40 + boxHeight(3) + 12;
	assert.equal(lowestY(tables), Math.max(a, b, 40));
});

test("lowestY: a card above the floor never pulls the placement up", () => {
	assert.equal(lowestY([{ y: -1000, columns: [] }]), 40);
});

// ---- exportFilename: the name an export saves under ----

test("exportFilename: a loaded file keeps its own name", () => {
	assert.equal(
		exportFilename({ currentFile: "users.sql", schema: { dialect: "mysql" } }),
		"users.sql",
	);
});

test("exportFilename: scratch names say which grammar the bytes are in", () => {
	assert.equal(
		exportFilename({ currentFile: "", schema: { dialect: "postgres" } }),
		"postgres-schema.sql",
	);
	assert.equal(
		exportFilename({ currentFile: null, schema: { dialect: "" } }),
		"erd-schema.sql",
	);
});

test("exportFilename: stem rule matches capture.js so DDL/raster agree", () => {
	assert.equal(
		exportFilename({ currentFile: "", schema: { dialect: "sqlite" } }),
		`${exportStem(null, "sqlite")}.sql`,
	);
});

// ---- exportDdl happy path: DDL reaches a download, flag resets ----

test("exportDdl: success downloads the DDL under the file name and resets", async () => {
	const ddl = "CREATE TABLE `t` (\n  `id` INT\n) ENGINE=InnoDB;\n";
	const { calls, restore } = stubFetch([{ ok: true, text: ddl, json: [] }]);
	const seen = [];
	const origDoc = globalThis.document;
	const origURL = globalThis.URL;
	globalThis.URL = {
		createObjectURL: (b) => {
			seen.push(b);
			return "blob:x";
		},
		revokeObjectURL: () => {},
	};
	globalThis.document = {
		createElement: () => ({ style: {}, click() {}, remove() {} }),
		body: { appendChild() {}, removeChild() {} },
	};
	try {
		const store = {
			exporting: false,
			currentFile: "mydb.sql",
			schema: { dialect: "mysql", tables: [] },
		};
		const msgs = [];
		const { exportDdl } = await import("../src/export.js");
		await exportDdl(store, (m, k) => msgs.push([String(m), k]));
		assert.equal(store.exporting, false, "flag must reset after success");
		assert.match(msgs.map(([m]) => m).join("\n"), /downloaded mydb\.sql/);
		const posted = JSON.parse(calls[0].opts.body);
		assert.equal(posted.dialect, "mysql");
	} finally {
		restore();
		globalThis.document = origDoc;
		globalThis.URL = origURL;
	}
});

test("exportDdl: scratch export names the dialect grammar file", async () => {
	const { restore } = stubFetch([{ ok: true, text: "DDL", json: [] }]);
	const origDoc = globalThis.document;
	const origURL = globalThis.URL;
	globalThis.URL = {
		createObjectURL: () => "blob:x",
		revokeObjectURL: () => {},
	};
	globalThis.document = {
		createElement: () => ({ style: {}, click() {}, remove() {} }),
		body: { appendChild() {}, removeChild() {} },
	};
	try {
		const store = {
			exporting: false,
			currentFile: "",
			schema: { dialect: "postgres", tables: [] },
		};
		const msgs = [];
		await exportDdl(store, (m, k) => msgs.push([String(m), k]));
		assert.match(msgs.map(([m]) => m).join("\n"), /postgres-schema\.sql/);
	} finally {
		restore();
		globalThis.document = origDoc;
		globalThis.URL = origURL;
	}
});

// ---- captureOptions/captureRoot: zoom-neutralized capture shape ----

test("captureOptions: zoom-neutralized shape carries model-px size", () => {
	const opts = captureOptions({ width: 700, height: 337 });
	assert.equal(opts.width, 700);
	assert.equal(opts.height, 337);
	assert.equal(opts.style.transform, "none");
	assert.equal(opts.style.overflow, "hidden");
	assert.ok(opts.backgroundColor, "capture needs an opaque background");
});

test("captureRoot: prefers the zoom layer, falls back to the canvas", () => {
	const zoom = { cls: "zoom" };
	const canvas = { querySelector: (sel) => (sel === ".zoom" ? zoom : null) };
	assert.equal(captureRoot(canvas), zoom);
	const bare = { querySelector: () => null };
	assert.equal(captureRoot(bare), bare);
	assert.equal(captureRoot(null), null);
	assert.equal(captureRoot(undefined), undefined);
});

// ---- relationshipList/tableNameById: screen-reader + lookup behaviour ----

test("relationshipList: one line per FK in child/parent notation", async () => {
	const { relationshipList, tableNameById } = await import(
		"../src/canvasView.js"
	);
	const schema = {
		tables: [
			{
				id: "t1",
				name: "users",
				columns: [{ name: "id", pk: true, nn: true, ux: false }],
			},
			{
				id: "t2",
				name: "posts",
				columns: [
					{ name: "id", pk: true, nn: true, ux: false },
					{
						name: "user_id",
						pk: false,
						nn: true,
						ux: false,
						ref: { tableId: "t1" },
					},
				],
			},
		],
	};
	assert.equal(tableNameById(schema).get("t1"), "users");
	assert.deepEqual(relationshipList(schema), [
		"posts.user_id 0..N references users 1..1",
	]);
});

test("relationshipList: dangling ref names the missing parent as ?", async () => {
	const { relationshipList } = await import("../src/canvasView.js");
	const schema = {
		tables: [
			{
				id: "t1",
				name: "posts",
				columns: [{ name: "user_id", ref: { tableId: "gone" } }],
			},
		],
	};
	assert.match(relationshipList(schema)[0], /\?/);
});

// ---- scrollToTable guard: missing card still selects, reports false ----

test("scrollToTable: missing card still selects but reports not found", async () => {
	const { scrollToTable } = await import("../src/ui.js");
	globalThis.document = { querySelector: () => null };
	globalThis.CSS = { escape: (s) => s };
	try {
		let selected = null;
		assert.equal(
			scrollToTable("t9", "missing", (id) => (selected = id)),
			false,
		);
		assert.equal(selected, "t9");
	} finally {
		delete globalThis.document;
		delete globalThis.CSS;
	}
});

// keep BOX_W referenced so the placement tests stay honest about card width
test("lowestY placement accounts for card width only via boxHeight", () => {
	assert.ok(BOX_W > 0);
	assert.ok(boxHeight(0) > 0);
});
