// canvasView.js — view-layer derivations for App.svelte (perf split, task 5).
//
// Smaller safe step: zoom helpers + canvas content bounds + relList live here
// as pure functions so App.svelte keeps only reactive glue + gesture handlers.
// Gesture handlers (startDrag/startPan/onMove/onUp/autoscroll/onWheel/onKey)
// stay in App.svelte: they close over rAF ids, scroll element refs, and the
// store, and lifting them would only move behavior risk, not cost.
//
// nameById/junctionSets/relList are memoized per schema OBJECT identity plus
// a structural revision: the drag frame mutates table x/y in place without
// replacing the schema object, so a key on the tables array alone would go
// stale. The snap()→bumpStruct() hook invalidates on every structural edit
// (same object, in-place rename/flags/FK), while drag frames reuse the cache.
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

/** @type {WeakMap<object, { structRev: number, nameById: Map<string, string> | null, referenced: Set<string> | null, relList: string[] | null }>} */
const cache = new WeakMap();

// Structural revision: bumped by snap() before every structural mutation
// (rename/flags/FK/columns/tables — drag-start and nudge snaps included, so
// one rebuild per drag/nudge is the cost and correctness stays trivial).
// Drag x/y writes bump only App.svelte's local pos state, so the memoized
// maps stay valid across all frames after that one rebuild. fileStore loads
// and undo() replace store.schema (fresh object → fresh cache entry), so
// entries can never leak across a load/undo boundary.
let structRev = 0;

/** @returns {number} */
export function structRevision() {
	return structRev;
}
/** Bump on structural mutation (names/flags/refs/columns/tables). */
export function bumpStruct() {
	structRev++;
}

/**
 * Cache entry for a schema object, created on first use. The entry records
 * the structRev it was built under; a mismatch means a structural edit
 * happened since (same object, in-place mutation) and the entry rebuilds.
 * @param {{ tables: import("./erd.js").Table[] }} schema
 */
function entry(schema) {
	let e = cache.get(schema);
	if (!e) {
		e = {
			structRev,
			nameById: null,
			referenced: null,
			relList: null,
		};
		cache.set(schema, e);
	} else if (e.structRev !== structRev) {
		e.structRev = structRev;
		e.nameById = null;
		e.referenced = null;
		e.relList = null;
	}
	return e;
}

/**
 * FK target name lookup, memoized per schema object identity + struct rev.
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
 * Inbound-reference set, memoized per schema object identity + struct rev.
 * @param {{ tables: import("./erd.js").Table[] }} schema
 * @returns {Set<string>}
 */
export function referencedSet(schema) {
	const e = entry(schema);
	if (!e.referenced) e.referenced = junctionSet(schema);
	return e.referenced;
}

/**
 * Screen-reader relationship strings, memoized per schema identity + rev.
 * The text depends only on names/flags; any structural edit bumps the rev
 * (via snap) and rebuilds, while drag frames reuse the list. The inner
 * per-FK find() is served by the memoized name map above instead of a
 * linear scan per FK.
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
