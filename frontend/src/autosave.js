// autosave.js — debounced lint/save/sql scheduling + dirty tracking.
// Extracted from schema.svelte.js to shrink the God object (518L → ~450L).
// Holds its own timers and dirty flag; schema.svelte.js wires store + callbacks.
let lintTimer, saveTimer, sqlTimer;
let dirty = false;
let skipNextTouch = false;

export function isDirty() {
	return dirty;
}
export function setDirty(v) {
	dirty = v;
}
export function markSkipTouch() {
	skipNextTouch = true;
}

export function touch(
	showSql,
	{ store, refreshLint, refreshSql, saveCurrent },
) {
	if (skipNextTouch) {
		skipNextTouch = false;
		return;
	}
	lintTimer ??= setTimeout(() => {
		lintTimer = null;
		refreshLint();
	}, 300);
	if (store.currentFile) {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => saveCurrent(true), 800);
	}
	dirty = true;
	if (showSql) {
		clearTimeout(sqlTimer);
		sqlTimer = setTimeout(() => refreshSql(), 300);
	}
}

export function clearTimers() {
	if (lintTimer) {
		clearTimeout(lintTimer);
		lintTimer = null;
	}
	clearTimeout(saveTimer);
	clearTimeout(sqlTimer);
}

export async function flushCurrent({ store, saveCurrent }) {
	clearTimers();
	if (dirty && store.currentFile) {
		try {
			await saveCurrent(true);
		} catch {
			// saveCurrent flashes itself; edit stays in memory
		}
	}
}

export function installFlush(flushFn) {
	window.addEventListener("pagehide", () => void flushFn());
	window.addEventListener("beforeunload", () => void flushFn());
}
