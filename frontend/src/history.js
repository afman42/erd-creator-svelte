// history.js — undo stack for schema.svelte.js
// Extracted to keep the store focused on reactive state and server I/O.
// The stack holds JSON snapshots of the schema; it is not reactive itself.
import { adoptIds } from "./erd.js";

// Structural-revision hook, wired by schema.svelte.js to canvasView's
// bumpStruct(). history.js cannot import canvasView (canvasView imports
// geometry/relationships only — importing it here would cycle through the
// store). The hook defaults to a no-op so unit tests driving history.js
// directly keep working.
let onSnap = () => {};
/** @param {() => void} fn */
export function setSnapHook(fn) {
	onSnap = fn;
}

/** @type {string[]} */
const stack = [];

/** @param {string} json */
function pushCapped(json) {
	stack.push(json);
	if (stack.length > 60) stack.shift();
}

/** @type {string[]} */
const redoStack = [];
const REDO_CAP = 60; // same ceiling as the undo stack

/** @param {string} json */
function pushRedo(json) {
	redoStack.push(json);
	if (redoStack.length > REDO_CAP) redoStack.shift();
}

// Stash for commitCreate's snap-then-fail path: snap() clears redo because a
// new edit forks history, but a REFUSED create is not an edit — dropLast()
// (called only on creator failure) restores what snap() cleared.
/** @type {string[] | null} */
let stashedRedo = null;

/** @param {unknown} schema */
export function snap(schema) {
	pushCapped(JSON.stringify(schema));
	stashedRedo = redoStack.length ? redoStack.slice() : null;
	redoStack.length = 0;
	onSnap();
}

// snapRaw pushes a pre-serialized entry, bypassing JSON.stringify. It exists as
// a seam for tests: undo() must skip a corrupt snapshot (its catch→recurse
// path), and the only way to PUT corrupt JSON on the stack is to push it
// raw. Production callers should use snap().
// @internal — test-only seam, not for production use.
/** @param {string} json */
export function snapRaw(json) {
	pushCapped(json);
}

/** Discard the most recent snapshot (e.g. a snap taken before a failed mutation). */
export function dropLast() {
	stack.pop();
	if (stashedRedo) redoStack.push(...stashedRedo.slice(-REDO_CAP));
	stashedRedo = null;
}

/**
 * @param {unknown} [current] the schema being left; pushed onto redo only
 * when an entry is actually restored, so an empty/corrupt stack records no
 * phantom redo. Optional so existing no-arg callers keep working.
 */
export function undo(current) {
	while (stack.length) {
		// length checked above, so pop() is defined — the ?? guards the type only.
		const raw = stack.pop() ?? "";
		try {
			const schema = adoptIds(JSON.parse(raw));
			if (current !== undefined) pushRedo(JSON.stringify(current));
			return schema;
		} catch (e) {
			console.debug("undo skip corrupt snapshot", e);
		}
	}
	return null;
}

/**
 * @param {unknown} current the schema being left; pushed back onto undo so
 * the redo itself is undoable. Required: without the outgoing state there is
 * nothing to return to, so a missing current is a null, not a guess.
 */
export function redo(current) {
	if (current === undefined) return null;
	const raw = redoStack.pop();
	if (raw === undefined) return null;
	try {
		const schema = adoptIds(JSON.parse(raw));
		pushCapped(JSON.stringify(current));
		return schema;
	} catch (e) {
		console.debug("redo skip corrupt snapshot", e);
		return null;
	}
}

export function redoDepth() {
	return redoStack.length;
}

export function depth() {
	return stack.length;
}

export function clearHistory() {
	stack.length = 0;
	redoStack.length = 0;
	stashedRedo = null;
}
