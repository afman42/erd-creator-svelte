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
 * @typedef {(msg: string, kind?: "ok" | "err" | "warn") => void} Flash
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
		// Best-effort import report: the loss list rides the open response, and
		// a warn toast names the skips (server excerpts are capped/sanitized;
		// Toast interpolates text, never html). Canvas loads regardless.
		if (Array.isArray(loaded.warnings) && loaded.warnings.length) {
			const shown = loaded.warnings.slice(0, 3).join("; ");
			const more =
				loaded.warnings.length > 3
					? ` (+${loaded.warnings.length - 3} more)`
					: "";
			flash(
				`imported with ${loaded.warnings.length} skips: ${shown}${more}`,
				"warn",
			);
		}
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
	try {
		const res = await fetch(`/api/files/${encodeURIComponent(name)}`, {
			method: "DELETE",
		});
		// A failed DELETE leaves the file on disk and the editor still pointed at
		// it, so currentFile/history are only cleared on success.
		if (!res.ok) {
			flash(`delete failed: ${await res.text()}`, "err");
			return;
		}
	} catch (e) {
		flash(
			`delete failed: ${e instanceof Error ? e.message : String(e)}`,
			"err",
		);
		return;
	}
	store.currentFile = "";
	clearHistory();
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
	const to = (prompt("Rename schema file to:", cur) || "").trim();
	if (!to || to === cur) return;
	const name = to.replace(/\.sql$/i, "") + ".sql";
	if (store.files.some((f) => f.name === name)) {
		flash(`${name} already exists`, "err");
		return;
	}
	await flushCurrent(store, flash);
	try {
		const res = await fetch("/api/files/rename", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ from: cur, to: name }),
		});
		if (!res.ok) throw new Error(await res.text());
		store.currentFile = name;
		flash(`renamed to ${name}`);
	} catch (e) {
		flash(
			`rename failed: ${e instanceof Error ? e.message : String(e)}`,
			"err",
		);
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
	const to = (prompt("Duplicate schema file as:", suggested) || "").trim();
	if (!to) return;
	const name = to.replace(/\.sql$/i, "") + ".sql";
	if (name === cur) return;
	if (store.files.some((f) => f.name === name)) {
		flash(`${name} already exists`, "err");
		return;
	}
	try {
		const res = await fetch("/api/files/copy", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ from: cur, to: name }),
		});
		if (!res.ok) throw new Error(await res.text());
		flash(`duplicated as ${name}`);
	} catch (e) {
		flash(`copy failed: ${e instanceof Error ? e.message : String(e)}`, "err");
	} finally {
		await refreshFiles(store);
	}
}
