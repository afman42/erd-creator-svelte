// fileStore.js — working-directory .sql store client.
// Extracted from schema.svelte.js to shrink God object (~590→~470).
// All functions take `store` as first param (DI) to avoid circular import of the $state store.
import {
	adoptIds,
	DEFAULT_DIALECT,
	DEFAULT_SQLITE_TYPES,
	layout,
	newSchema,
	newTable,
} from "./erd.js";
import { clearHistory } from "./history.js";
import {
	clearTimers as clearAutosaveTimers,
	isDirty,
	markSkipTouch,
	setDirty,
} from "./autosave.js";

export async function refreshFiles(store) {
	try {
		const res = await fetch("/api/files");
		store.files = res.ok ? await res.json() : [];
	} catch {
		store.files = [];
	}
}

export async function saveCurrent(store, flash, silent = false) {
	if (!store.currentFile) {
		flash("no file selected — use New", "err");
		return;
	}
	try {
		const res = await fetch(`/api/files/${encodeURIComponent(store.currentFile)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(store.schema),
			keepalive: true,
		});
		if (!res.ok) throw new Error(await res.text());
		setDirty(false);
		if (!silent) flash(`saved ${store.currentFile}`);
	} catch (e) {
		if (!silent) flash(`save failed: ${e.message}`, "err");
	}
}

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
		clearHistory();
	} catch (e) {
		flash(`Open failed: ${e.message}`, "err");
		await refreshFiles(store);
	}
}

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

export async function deleteFile(store, flash) {
	if (!store.currentFile) return;
	if (!confirm(`Delete ${store.currentFile}?`)) return;
	clearAutosaveTimers();
	const res = await fetch(`/api/files/${encodeURIComponent(store.currentFile)}`, {
		method: "DELETE",
	});
	if (!res.ok) flash(`delete failed: ${await res.text()}`, "err");
	else flash(`deleted ${store.currentFile}`);
	store.currentFile = "";
	clearHistory();
	await refreshFiles(store);
}
