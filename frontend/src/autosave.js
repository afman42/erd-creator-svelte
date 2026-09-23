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
/** @type {ReturnType<typeof setTimeout> | undefined} */
let lintTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let saveTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let sqlTimer;
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
/**
 * @param {boolean} v
 */
export function setDirty(v) {
	dirty = v;
}
/** @returns {number} */
export function editGeneration() {
	return editGen;
}
export function markSkipTouch() {
	skipNextTouch = true;
}

/**
 * @typedef {object} AutosaveStore
 * @property {string} currentFile
 * @property {object} schema
 * @property {boolean} dirty  reactive mirror of the dirty flag (Toolbar indicator)
 */

/**
 * Schedule the debounced lint/save/SQL-panel work after an edit. `store` is
 * the reactive schema store; the callbacks are the work itself.
 * @param {boolean} showSql
 * @param {object} deps
 * @param {AutosaveStore} deps.store
 * @param {() => void} deps.refreshLint
 * @param {() => unknown} deps.refreshSql
 * @param {(silent?: boolean) => Promise<unknown>} deps.saveCurrent
 */
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
		lintTimer = undefined;
		refreshLint();
	}, LINT_DEBOUNCE_MS);
	if (store.currentFile) {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => saveCurrent(true), SAVE_DEBOUNCE_MS);
	}
	dirty = true;
	// Reactive mirror for the Toolbar's unsaved indicator; the module flag
	// stays the source of truth for flush gating.
	store.dirty = true;
	if (showSql) {
		clearTimeout(sqlTimer);
		sqlTimer = setTimeout(() => refreshSql(), SQL_DEBOUNCE_MS);
	}
}

export function clearTimers() {
	if (lintTimer) {
		clearTimeout(lintTimer);
		lintTimer = undefined;
	}
	clearTimeout(saveTimer);
	clearTimeout(sqlTimer);
}

/**
 * Flush any pending save now (used on unload and before file switches).
 * @param {object} deps
 * @param {AutosaveStore} deps.store
 * @param {(silent?: boolean) => Promise<unknown>} deps.saveCurrent
 */
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

/**
 * @param {() => unknown} flushFn
 */
export function installFlush(flushFn) {
	window.addEventListener("pagehide", () => void flushFn());
	window.addEventListener("beforeunload", () => void flushFn());
}
