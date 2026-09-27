// fileStore.js — working-directory .sql store client.
// Extracted from schema.svelte.js to shrink God object (~590→~470).
// All functions take `store` as first param (DI) to avoid circular import of the $state store.

import { api, apiJson, errMsg, fail, resolveFileName } from "./api.js";
import {
	clearTimers as clearAutosaveTimers,
	editGeneration,
	flushCurrent as flushAutosave,
	markSkipTouch,
	setDirtyBoth,
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
 * @typedef {(msg: string, kind?: "ok" | "err" | "warn") => void} Flash
 */

/**
 * @param {Store} store
 */
export async function refreshFiles(store) {
	try {
		store.files = await apiJson("/api/files");
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
		await api(
			`/api/files/${encodeURIComponent(store.currentFile)}`,
			"PUT",
			store.schema,
			{ keepalive: true },
		);
		if (gen === editGeneration()) {
			setDirtyBoth(store, false);
		}
		if (!silent) flash(`saved ${store.currentFile}`);
	} catch (e) {
		if (!silent) {
			flash(`save failed: ${errMsg(e)}`, "err");
		}
	}
}

/**
 * @param {Store} store
 * @param {Flash} flash
 */
async function flushCurrent(store, flash) {
	await flushAutosave({
		store,
		saveCurrent: (silent) => saveCurrent(store, flash, silent),
	});
}

/**
 * @param {Store} store
 */
function resetUndo(store) {
	clearHistory();
	store.undoDepth = 0;
}

/**
 * Prompt for a .sql file name, normalized via resolveFileName (""/cancel → "").
 * Single prompt+normalize body behind newFile/renameFile/duplicateFile.
 * @param {string} message
 * @param {string} initial
 * @returns {string}
 */
export function promptFileName(message, initial) {
	return resolveFileName((prompt(message, initial) || "").trim());
}

/**
 * @param {Store} store
 * @param {string} name
 */
function nameTaken(store, name) {
	return store.files.some((f) => f.name === name);
}

/**
 * @param {{ warnings?: unknown }} loaded
 * @param {Flash} flash
 */
function flashWarnings(loaded, flash) {
	// Best-effort import report: the loss list rides the open response, and
	// a warn toast names the skips (server excerpts are capped/sanitized;
	// Toast interpolates text, never html). Canvas loads regardless.
	if (!Array.isArray(loaded.warnings) || !loaded.warnings.length) return;
	const shown = loaded.warnings.slice(0, 3).join("; ");
	const more =
		loaded.warnings.length > 3 ? ` (+${loaded.warnings.length - 3} more)` : "";
	flash(
		`imported with ${loaded.warnings.length} skips: ${shown}${more}`,
		"warn",
	);
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
		const loaded = await apiJson(`/api/files/${encodeURIComponent(name)}`);
		markSkipTouch();
		if (!loaded.dialect) loaded.dialect = DEFAULT_DIALECT;
		if (!loaded.sqliteTypes) loaded.sqliteTypes = DEFAULT_SQLITE_TYPES;
		store.schema = adoptIds(loaded);
		layout(store.schema);
		store.currentFile = name;
		store.error = "";
		setDirtyBoth(store, false); // reactive mirror (Toolbar indicator)
		resetUndo(store);
		flashWarnings(loaded, flash);
	} catch (e) {
		flash(`Open failed: ${errMsg(e)}`, "err");
		await refreshFiles(store);
	}
}

/**
 * @param {Store} store
 * @param {Flash} flash
 */
export async function newFile(store, flash) {
	const name = promptFileName("New schema file name:", "schema");
	if (!name) return;
	if (nameTaken(store, name)) {
		flash(`${name} already exists`, "err");
		return;
	}
	await flushCurrent(store, flash);
	markSkipTouch();
	store.schema = newSchema(store.schema.dialect, [newTable("users")]);
	layout(store.schema);
	store.currentFile = name;
	resetUndo(store);
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
	try {
		// A failed DELETE leaves the file on disk and the editor still pointed at
		// it, so currentFile/history are only cleared on success.
		await api(`/api/files/${encodeURIComponent(name)}`, "DELETE");
	} catch (e) {
		fail(flash, "delete failed", e);
		return;
	}
	store.currentFile = "";
	resetUndo(store);
	flash(`deleted ${name}`);
	await refreshFiles(store);
}

/**
 * renameFile moves the current file on the server (POST /api/files/rename).
 * Pending edits are flushed first so the move carries the latest bytes; the
 * editor stays pointed at the same schema under its new name.
 * @param {Store} store
 * @param {Flash} flash
 */
export async function renameFile(store, flash) {
	if (!store.currentFile) return;
	const cur = store.currentFile;
	const name = promptFileName("Rename schema file to:", cur);
	if (!name || name === cur) return;
	if (nameTaken(store, name)) {
		flash(`${name} already exists`, "err");
		return;
	}
	await flushCurrent(store, flash);
	try {
		await api("/api/files/rename", "POST", { from: cur, to: name });
		store.currentFile = name;
		flash(`renamed to ${name}`);
	} catch (e) {
		fail(flash, "rename failed", e);
	} finally {
		await refreshFiles(store);
	}
}

/**
 * duplicateFile copies the current file on the server (POST /api/files/copy),
 * prompting with an unused derived name (<base>_copy.sql, then _copy2, …).
 * The editor stays on the original; the copy is the on-disk snapshot.
 * @param {Store} store
 * @param {Flash} flash
 */
export async function duplicateFile(store, flash) {
	if (!store.currentFile) return;
	const cur = store.currentFile;
	const base = cur.replace(/\.sql$/i, "");
	const taken = new Set(store.files.map((f) => f.name));
	let suggested = `${base}_copy.sql`;
	for (let n = 2; taken.has(suggested); n++) {
		suggested = `${base}_copy${n}.sql`;
	}
	const name = promptFileName("Duplicate schema file as:", suggested);
	if (!name) return;
	if (name === cur) return;
	if (nameTaken(store, name)) {
		flash(`${name} already exists`, "err");
		return;
	}
	try {
		await api("/api/files/copy", "POST", { from: cur, to: name });
		flash(`duplicated as ${name}`);
	} catch (e) {
		fail(flash, "copy failed", e);
	} finally {
		await refreshFiles(store);
	}
}
