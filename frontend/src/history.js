// history.js — undo stack for schema.svelte.js
// Extracted to keep the store focused on reactive state and server I/O.
// The stack holds JSON snapshots of the schema; it is not reactive itself.
import { adoptIds } from "./erd.js";

const stack = [];

export function snap(schema) {
	stack.push(JSON.stringify(schema));
	if (stack.length > 60) stack.shift();
}

// snapRaw pushes a pre-serialized entry, bypassing JSON.stringify. It exists as
// a seam for tests: undo() must skip a corrupt snapshot (its catch→recurse
// path), and the only way to PUT corrupt JSON on the stack is to push it
// raw. Production callers should use snap().
export function snapRaw(json) {
	stack.push(json);
	if (stack.length > 60) stack.shift();
}

export function undo() {
	while (stack.length) {
		try {
			return adoptIds(JSON.parse(stack.pop()));
		} catch (e) {
			console.debug("undo skip corrupt snapshot", e);
		}
	}
	return null;
}

export function clearHistory() {
	stack.length = 0;
}
