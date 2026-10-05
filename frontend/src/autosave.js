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
 * Schedule one debounced callback on a timer slot.
 * @param {ReturnType<typeof setTimeout> | undefined} timer
 * @param {number} ms
 * @param {() => void} fn
 */
function schedule(timer, ms, fn) {
	clearTimeout(timer);
	return setTimeout(() => fn(), ms);
}
/**
 * Set the dirty flag AND its reactive store mirror together, keeping the two
 * in lockstep. Every writer must use this — split writes drift.
 * @param {AutosaveStore} store
 * @param {boolean} v
 */
export function setDirtyBoth(store, v) {
	dirty = v;
	store.dirty = v;
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
/**
 * Mark a load event: clears pending timers + dirty, arms skipNextTouch so the
 * $effect echo from the schema swap is dropped. Call BEFORE swapping
 * store.schema (openFile/newFile). Explicit event, not a bare flag write:
 * every load path funnels here, so a new path cannot forget the arm.
 * @param {AutosaveStore} store
 */
export function load(store) {
	clearTimers();
	setDirtyBoth(store, false);
	skipNextTouch = true;
}

/**
 * @typedef {object} AutosaveStore
 * @property {string} currentFile
 * @property {import('./erd.js').Schema} schema
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
		// A load swap is not an edit: no dirty flag, no autosave (the file
		// was just read). But the panels must still see the loaded schema —
		// skipNextTouch used to skip the whole fan-out, so opening a file
		// with lint findings left the lint panel stale (empty or the
		// previous file's list) until the first edit.
		lintTimer = schedule(lintTimer, LINT_DEBOUNCE_MS, refreshLint);
		if (showSql) {
			sqlTimer = schedule(sqlTimer, SQL_DEBOUNCE_MS, refreshSql);
		}
		return;
	}
	editGen++;
	lintTimer = schedule(lintTimer, LINT_DEBOUNCE_MS, refreshLint);
	if (store.currentFile) {
		saveTimer = schedule(saveTimer, SAVE_DEBOUNCE_MS, () => saveCurrent(true));
	}
	setDirtyBoth(store, true);
	if (showSql) {
		sqlTimer = schedule(sqlTimer, SQL_DEBOUNCE_MS, refreshSql);
	}
}

export function clearTimers() {
	clearTimeout(lintTimer);
	lintTimer = undefined;
	clearTimeout(saveTimer);
	saveTimer = undefined;
	clearTimeout(sqlTimer);
	sqlTimer = undefined;
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
