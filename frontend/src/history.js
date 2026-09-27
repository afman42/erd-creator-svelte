// history.js — undo stack for schema.svelte.js
// Extracted to keep the store focused on reactive state and server I/O.
// The stack holds JSON snapshots of the schema; it is not reactive itself.
import { adoptIds } from "./erd.js";

/** @type {string[]} */
const stack = [];

/** @param {string} json */
function pushCapped(json) {
	stack.push(json);
	if (stack.length > 60) stack.shift();
}

/** @param {unknown} schema */
export function snap(schema) {
	pushCapped(JSON.stringify(schema));
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
}

export function undo() {
	while (stack.length) {
		// length checked above, so pop() is defined — the ?? guards the type only.
		const raw = stack.pop() ?? "";
		try {
			return adoptIds(JSON.parse(raw));
		} catch (e) {
			console.debug("undo skip corrupt snapshot", e);
		}
	}
	return null;
}

export function depth() {
	return stack.length;
}

export function clearHistory() {
	stack.length = 0;
}
