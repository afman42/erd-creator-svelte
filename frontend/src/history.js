// history.js — undo stack for schema.svelte.js
// Extracted to keep the store focused on reactive state and server I/O.
// The stack holds JSON snapshots of the schema; it is not reactive itself.
import { adoptIds } from "./erd.js";

const stack = [];

export function snap(schema) {
	stack.push(JSON.stringify(schema));
	if (stack.length > 60) stack.shift();
}

export function undo() {
	if (!stack.length) return null;
	try {
		return adoptIds(JSON.parse(stack.pop()));
	} catch {
		return undo();
	}
}

export function clearHistory() {
	stack.length = 0;
}
