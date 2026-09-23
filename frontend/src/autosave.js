// autosave.js — debounced lint/save/sql scheduling + dirty tracking.
// Extracted from schema.svelte.js to shrink the God object (518L → ~450L).
// Holds its own timers and dirty flag; schema.svelte.js wires store + callbacks.
//
// Debounce windows, in ms. Lint and the SQL panel refresh fast (300ms — they
// only run while typing settles), autosave waits longest (800ms) so a burst of
// edits coalesces into one write. Named so the scheduling and any tuning have
// one place to change.
const LINT_DEBOUNCE_MS = 300;
const SAVE_DEBOUNCE_MS = 800;
const SQL_DEBOUNCE_MS = 300;
let lintTimer, saveTimer, sqlTimer;
let dirty = false;
let skipNextTouch = false;
// Edit generation: bumped on every non-skipped touch. saveCurrent captures it
// when it starts and only clears dirty if no edit happened since — a stale
// (older) save response landing after a newer edit must not mark the file
// clean while the newer edit is still unpersisted.
let editGen = 0;

export function isDirty() {
	return dirty;
}
export function setDirty(v) {
	dirty = v;
}
export function editGeneration() {
	return editGen;
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
	editGen++;
	clearTimeout(lintTimer);
	lintTimer = setTimeout(() => {
		lintTimer = null;
		refreshLint();
	}, LINT_DEBOUNCE_MS);
	if (store.currentFile) {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => saveCurrent(true), SAVE_DEBOUNCE_MS);
	}
	dirty = true;
	if (showSql) {
		clearTimeout(sqlTimer);
		sqlTimer = setTimeout(() => refreshSql(), SQL_DEBOUNCE_MS);
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
