import assert from "node:assert/strict";
import { test } from "node:test";
import { newSchema, newTable } from "../src/erd.js";
import { exportDdl } from "../src/export.js";
import { deleteFile } from "../src/fileStore.js";
import { clearHistory, snap, undo } from "../src/history.js";

function flashCapture() {
	const msgs = [];
	const flash = (msg, kind) => msgs.push([String(msg), kind]);
	return { msgs, flash };
}

function stubFetchRejectWith(value) {
	const origFetch = globalThis.fetch;
	globalThis.fetch = () => Promise.reject(value);
	return () => {
		globalThis.fetch = origFetch;
	};
}

function fakeExportStore() {
	return {
		exporting: false,
		currentFile: "mydb.sql",
		schema: { dialect: "mysql", tables: [] },
	};
}

test("exportDdl flashes String(e) when fetch rejects with a plain string", async () => {
	const restore = stubFetchRejectWith("boom-string");
	try {
		const store = fakeExportStore();
		const { msgs, flash } = flashCapture();
		await exportDdl(store, flash);
		assert.equal(store.exporting, false, "exporting flag must reset");
		const combined = msgs.map(([m]) => m).join("\n");
		assert.match(combined, /boom-string/, "flash must contain the payload");
	} finally {
		restore();
	}
});

test("exportDdl flashes String(e) when fetch rejects with undefined", async () => {
	const restore = stubFetchRejectWith(undefined);
	try {
		const store = fakeExportStore();
		const { msgs, flash } = flashCapture();
		await exportDdl(store, flash);
		assert.equal(store.exporting, false, "exporting flag must reset");
		const combined = msgs.map(([m]) => m).join("\n");
		assert.match(
			combined,
			/export failed: /,
			"flash must stringify a non-Error throw instead of crashing",
		);
		assert.match(combined, /undefined/);
	} finally {
		restore();
	}
});

test("deleteFile network failure flashes and leaves currentFile+history untouched", async () => {
	const restoreFetch = stubFetchRejectWith(new Error("net down"));
	const origConfirm = globalThis.confirm;
	globalThis.confirm = () => true;
	try {
		clearHistory();
		snap(newSchema("mysql", [newTable("kept")]));
		const store = {
			currentFile: "mydb.sql",
			schema: { dialect: "mysql", tables: [] },
		};
		const { msgs, flash } = flashCapture();
		await deleteFile(store, flash);
		const combined = msgs.map(([m]) => m).join("\n");
		assert.match(combined, /delete failed/, "flash must report the failure");
		assert.equal(
			store.currentFile,
			"mydb.sql",
			"currentFile must survive a failed DELETE",
		);
		const prev = undo();
		assert.ok(prev, "history must be untouched by a failed DELETE");
		assert.equal(prev.tables[0].name, "kept");
	} finally {
		restoreFetch();
		globalThis.confirm = origConfirm;
		clearHistory();
	}
});
