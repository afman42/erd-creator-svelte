// fileStore.js — working-directory .sql store client.
// Extracted from schema.svelte.js to shrink God object (~590→~470).
// All functions take `store` as first param (DI) to avoid circular import of the $state store.

import {
	clearTimers as clearAutosaveTimers,
	editGeneration,
	isDirty,
	markSkipTouch,
	setDirty,
} from "./autosave.js";
import {
	adoptIds,
	DEFAULT_DIALECT,
	DEFAULT_SQLITE_TYPES,
	layout,
	newSchema,
	newTable,
} from "./erd.js";
import { clearHistory } from "./history.js";

/**
 * @typedef {typeof import("./schema.svelte.js").store} Store
 * @typedef {(msg: string, kind?: "ok" | "err") => void} Flash
 */

/**
 * @param {Store} store
 */
export async function refreshFiles(store) {
	try {
		const res = await fetch("/api/files");
		store.files = res.ok ? await res.json() : [];
	} catch {
		store.files = [];
	}
}

/**
 * @param {Store} store
 * @param {Flash} flash
 * @param {boolean} [silent]
 */
export async function saveCurrent(store, flash, silent = false) {
	if (!store.currentFile) {
		flash("no file selected — use New", "err");
		return;
	}
	// Capture the edit generation at save start: the response only marks the
	// file clean if no edit happened while it was in flight. Otherwise an
	// older save resolving after a newer edit would clear dirty for edits
	// that are still unpersisted (and a subsequent file switch would skip
	// its flush, dropping them).
	const gen = editGeneration();
	try {
		const res = await fetch(
			`/api/files/${encodeURIComponent(store.currentFile)}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(store.schema),
				keepalive: true,
			},
		);
		if (!res.ok) throw new Error(await res.text());
		if (gen === editGeneration()) {
			setDirty(false);
			// Reactive mirror for the Toolbar's unsaved indicator, written at
			// the only place the flag goes false.
			store.dirty = false;
		}
		if (!silent) flash(`saved ${store.currentFile}`);
	} catch (e) {
		if (!silent) {
			flash(
				`save failed: ${e instanceof Error ? e.message : String(e)}`,
				"err",
			);
		}
	}
}

/**
 * @param {Store} store
 * @param {Flash} flash
 */
async function flushCurrent(store, flash) {
	clearAutosaveTimers();
	if (isDirty() && store.currentFile) {
		try {
			await saveCurrent(store, flash, true);
		} catch {
			// saveCurrent flashes itself; edit stays in memory
		}
	}
}

/**
 * @param {Store} store
 * @param {string} name
 * @param {Flash} flash
 */
export async function openFile(store, name, flash) {
	if (!name) return;
	await flushCurrent(store, flash);
	try {
		const res = await fetch(`/api/files/${encodeURIComponent(name)}`);
		if (!res.ok) throw new Error(await res.text());
		markSkipTouch();
		const loaded = await res.json();
		if (!loaded.dialect) loaded.dialect = DEFAULT_DIALECT;
		if (!loaded.sqliteTypes) loaded.sqliteTypes = DEFAULT_SQLITE_TYPES;
		store.schema = adoptIds(loaded);
		layout(store.schema);
		store.currentFile = name;
		store.error = "";
		setDirty(false);
		store.dirty = false; // reactive mirror (Toolbar indicator)
		clearHistory();
	} catch (e) {
		flash(`Open failed: ${e instanceof Error ? e.message : String(e)}`, "err");
		await refreshFiles(store);
	}
}

/**
 * @param {Store} store
 * @param {Flash} flash
 */
export async function newFile(store, flash) {
	const name = (prompt("New schema file name:", "schema") || "")
		.trim()
		.replace(/\.sql$/i, "");
	if (!name) return;
	if (store.files.some((f) => f.name === `${name}.sql`)) {
		flash(`${name}.sql already exists`, "err");
		return;
	}
	await flushCurrent(store, flash);
	markSkipTouch();
	store.schema = newSchema(store.schema.dialect, [newTable("users")]);
	layout(store.schema);
	store.currentFile = `${name}.sql`;
	clearHistory();
	await saveCurrent(store, flash);
	await refreshFiles(store);
}

/**
 * @param {Store} store
 * @param {Flash} flash
 */
export async function deleteFile(store, flash) {
	if (!store.currentFile) return;
	if (!confirm(`Delete ${store.currentFile}?`)) return;
	clearAutosaveTimers();
	const name = store.currentFile;
	const res = await fetch(`/api/files/${encodeURIComponent(name)}`, {
		method: "DELETE",
	});
	// A failed DELETE leaves the file on disk and the editor still pointed at
	// it, so currentFile/history are only cleared on success.
	if (!res.ok) {
		flash(`delete failed: ${await res.text()}`, "err");
		return;
	}
	store.currentFile = "";
	clearHistory();
	flash(`deleted ${name}`);
	await refreshFiles(store);
}
