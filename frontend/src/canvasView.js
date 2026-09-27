// canvasView.js — view-layer derivations for App.svelte (perf split, task 5).
//
// Smaller safe step: zoom helpers + canvas content bounds + relList live here
// as pure functions so App.svelte keeps only reactive glue + gesture handlers.
// Gesture handlers (startDrag/startPan/onMove/onUp/autoscroll/onWheel/onKey)
// stay in App.svelte: they close over rAF ids, scroll element refs, and the
// store, and lifting them would only move behavior risk, not cost.
//
// nameById/junctionSets are memoized per schema OBJECT identity in a module
// WeakMap: the drag frame mutates table x/y in place without replacing the
// schema object, so a key on the tables array alone would go stale. The entry
// is rebuilt only when the schema object (or, for relList, schema+theme
// inputs) changes — drag frames reuse the cached maps instead of rebuilding.
import { BOX_W, boxHeight, cardinality } from "./geometry.js";
import { junctionSet } from "./relationships.js";

export const ZMIN = 0.25;
export const ZMAX = 2;
export const VIEW_PAD = 40;

/** @param {number} z */
export function clampZoom(z) {
	return Math.min(ZMAX, Math.max(ZMIN, Math.round(z * 100) / 100));
}

/** @param {{ tables: import("./erd.js").Table[] }} schema */
export function contentSize(schema) {
	let w = 0;
	let h = 0;
	for (const t of schema.tables) {
		if (t.x + BOX_W > w) w = t.x + BOX_W;
		if (t.y + boxHeight(t.columns.length) > h)
			h = t.y + boxHeight(t.columns.length);
	}
	return { w, h };
}

/** @type {WeakMap<object, { nameById?: Map<string, string>, referenced?: Set<string>, relList?: string[] }>} */
const cache = new WeakMap();

/**
 * Cache entry for a schema object, created on first use.
 * @param {{ tables: import("./erd.js").Table[] }} schema
 */
function entry(schema) {
	let e = cache.get(schema);
	if (!e) {
		e = {};
		cache.set(schema, e);
	}
	return e;
}

/**
 * FK target name lookup, memoized per schema object identity.
 * @param {{ tables: import("./erd.js").Table[] }} schema
 * @returns {Map<string, string>}
 */
export function tableNameById(schema) {
	const e = entry(schema);
	if (!e.nameById)
		e.nameById = new Map(schema.tables.map((t) => [t.id, t.name]));
	return e.nameById;
}

/**
 * Inbound-reference set, memoized per schema object identity.
 * @param {{ tables: import("./erd.js").Table[] }} schema
 * @returns {Set<string>}
 */
export function referencedSet(schema) {
	const e = entry(schema);
	if (!e.referenced) e.referenced = junctionSet(schema);
	return e.referenced;
}

/**
 * Screen-reader relationship strings, memoized per schema object identity.
 * The text depends only on names/flags, so the cache key is the schema
 * object — same object across drag frames reuses the list, a replaced schema
 * (undo/load/edit) rebuilds it. The inner per-FK find() is served by the
 * memoized name map above instead of a linear scan per FK.
 * @param {{ tables: import("./erd.js").Table[] }} schema
 * @returns {string[]}
 */
export function relationshipList(schema) {
	const e = entry(schema);
	if (!e.relList) {
		const names = tableNameById(schema);
		const out = [];
		for (const t of schema.tables) {
			for (const c of t.columns) {
				if (!c.ref) continue;
				const p = names.get(c.ref.tableId) ?? "?";
				const { child, parent } = cardinality(t, c);
				out.push(`${t.name}.${c.name} ${child} references ${p} ${parent}`);
			}
		}
		e.relList = out;
	}
	return e.relList;
}
