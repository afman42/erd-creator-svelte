// erd.js — client-side UI helpers + auto-layout. All SQL grammar (generate,
// parse, lint) lives in Go; the browser talks to /api and /export.
import { CANVAS_ORIGIN, COL_W, stackStep } from "./geometry.js";

/** @type {string[]} */
export const TYPES = [
	"INT",
	"BIGINT",
	"SMALLINT",
	"TINYINT",
	"DECIMAL",
	"VARCHAR",
	"TEXT",
	"BOOLEAN",
	"DATE",
	"DATETIME",
	"TIMESTAMP",
	"JSON",
	"ENUM",
];
export const DEFAULT_TYPE = {
	DECIMAL: "DECIMAL(10,2)",
	VARCHAR: "VARCHAR(255)",
};
// Dialects the server can emit. All four are saveable: each has a parser, so a
// saved file reopens. SAVEABLE_DIALECTS is kept as a separate list because the
// dropdown labels anything absent from it "(export only)" — and because it must
// agree with the server's Schema.saveable().
//
// That agreement is the whole point: the two disagreed twice. The UI called
// MariaDB export-only while the server would have saved it as mysql, and sqlite
// was genuinely refused until it gained a parser.
/** @type {string[]} */
export const DIALECTS = ["mysql", "mariadb", "postgres", "sqlite"];
/** @type {string[]} */
export const SAVEABLE_DIALECTS = ["mysql", "mariadb", "postgres", "sqlite"];
export const DEFAULT_DIALECT = "mysql";
export const isSaveable = (d) => SAVEABLE_DIALECTS.includes(d);
export const baseType = (t) => t.split("(")[0];
const INT_RE = /^(INT|BIGINT|SMALLINT|TINYINT)/;
export const isInt = (t) => INT_RE.test(baseType(t));

// SQLite renders the types it has no storage class for (BOOLEAN, DATETIME,
// TIMESTAMP) in one of two ways. Both are defensible, so it is a schema
// setting rather than a hardcoded choice:
//
//   native (default) — keep the model's type name. SQLite accepts it and stores
//     it verbatim, so reopening returns the same type and an export to another
//     dialect is not silently downgraded.
//   portable — rewrite to the storage class SQLite would pick anyway
//     (BOOLEAN → INTEGER, DATETIME/TIMESTAMP → TEXT). What the emitter did
//     before the choice existed. LOSSY: the model type is gone on reopen.
//
// ENUM is unaffected either way (TEXT + CHECK), since SQLite has no enum type.
/** @type {string[]} */
export const SQLITE_TYPES = ["native", "portable"];
export const DEFAULT_SQLITE_TYPES = "native";

// newSchema: the client's schema envelope. The dialect travels with the model
// so one dropdown drives save, the SQL panel, copy and export, and so a saved
// file remembers which grammar it is written in. sqliteTypes rides along for the
// same reason: it changes the saved bytes, so the file must remember it.
export function newSchema(
	dialect = DEFAULT_DIALECT,
	tables = [],
	sqliteTypes = DEFAULT_SQLITE_TYPES,
) {
	return { dialect, sqliteTypes, tables };
}

/**
 * @typedef {{
 *   dialect: string,
 *   sqliteTypes: string,
 *   tables: Table[],
 * }} Schema
 */
/**
 * @typedef {{
 *   tableId: string,
 *   colId: string,
 * }} IdSource
 */
/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   x: number,
 *   y: number,
 *   columns: Column[],
 *   indexes: Index[],
 *   comment: string,
 * }} Table
 */
/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   type: string,
 *   pk: boolean,
 *   nn: boolean,
 *   ai: boolean,
 *   ux: boolean,
 *   ix: boolean,
 *   comment: string,
 *   default: string,
 *   ref: ?Ref,
 * }} Column
 */
/** @typedef {{ tableId: string, action: string, onUpdate?: string }} Ref */
/** @typedef {{ cols: string[], name?: string }} Index */

// Sequential id source. Every id-producing function takes an optional `idSource`
// so callers (tests especially) can inject a deterministic counter and never
// depend on how many ids earlier calls consumed — the old module-global
// counters made ids order-dependent across test runs. The default keeps ids
// unique for the life of the page.
let nextTableId = 1;
let nextColId = 1;

/**
 * @returns {IdSource}
 */
function defaultIdSource() {
	return { tableId: `t${nextTableId++}`, colId: `c${nextColId++}` };
}

/**
 * @param {string} name
 * @param {() => IdSource} [idSource]
 * @returns {Table}
 */
export function newTable(name, idSource = defaultIdSource) {
	return {
		id: idSource().tableId,
		name,
		x: 0,
		y: 0,
		columns: [
			{
				id: idSource().colId,
				name: "id",
				type: "INT",
				pk: true,
				nn: true,
				ai: true,
				ux: false,
				ix: false,
				comment: "",
				default: "",
				ref: null,
			},
		],
		// Composite indexes. Always present (empty array) so the UI can push to
		// it without a null guard, and serialized away by the server's omitempty
		// when empty — so a schema with no composite index still travels as the
		// exact JSON it did before this field existed.
		indexes: [],
		// Table comment; server-side omitempty keeps the wire JSON unchanged
		// when empty. Emitted only where the dialect has table comments
		// (mysql/mariadb option, postgres COMMENT ON); SQLite drops it.
		comment: "",
	};
}

/**
 * @param {() => IdSource} [idSource]
 * @returns {Column}
 */
export function newColumn(idSource = defaultIdSource) {
	return {
		id: idSource().colId,
		name: "column",
		type: "VARCHAR(255)",
		pk: false,
		nn: false,
		ai: false,
		ux: false,
		ix: false,
		comment: "",
		default: "",
		ref: null,
	};
}

/**
 * @param {Table} t
 * @param {() => IdSource} [idSource]
 * @returns {Table}
 */
export function cloneTable(t, idSource = defaultIdSource) {
	return {
		...t,
		id: idSource().tableId,
		columns: t.columns.map((c) => ({
			...c,
			id: idSource().colId,
			ref: c.ref ? { ...c.ref } : null,
		})),
		// Indexes must be deep-copied: the `...t` spread above copies the array
		// by reference, so without this a duplicated table would share the
		// original's index list and editing one would silently change the other.
		// The cols slice is copied too, for the same reason one level down.
		indexes: (t.indexes ?? []).map((ix) => ({ ...ix, cols: [...ix.cols] })),
	};
}

// adoptIds: wire schema (tables carry id, columns don't) → client model.
// Keeps table ids (refs point at them), allocates column ids, bumps counters
// so later newTable/newColumn never collide.
/**
 * @param {Schema} schema
 * @param {() => IdSource} [idSource]
 * @returns {*}
 */
export function adoptIds(schema, idSource = defaultIdSource) {
	for (const t of schema.tables) {
		if (/^t\d+$/.test(t.id))
			nextTableId = Math.max(nextTableId, +t.id.slice(1) + 1);
		else t.id = idSource().tableId;
		for (const c of t.columns) {
			if (!c.id) c.id = idSource().colId;
			else if (/^c\d+$/.test(c.id))
				nextColId = Math.max(nextColId, +c.id.slice(1) + 1);
		}
	}
	return schema;
}

// shiftColumn moves a column within its table's ordered list. The array
// order IS the DDL column order (every emitter writes columns in model
// order), so this changes what save/export emit — a pure array move, nothing
// stored, no format change. Returns false when the move is impossible (no
// such column, or already at the edge), leaving the list untouched.
/**
 * @param {Table} t
 * @param {string} colId
 * @param {-1 | 1} delta
 * @returns {boolean}
 */
export function shiftColumn(t, colId, delta) {
	const i = t.columns.findIndex((c) => c.id === colId);
	const j = i + delta;
	// j === i covers delta 0 (a non-move that would otherwise "swap" a
	// column with itself and report success)
	if (i < 0 || j === i || j < 0 || j >= t.columns.length) return false;
	[t.columns[i], t.columns[j]] = [t.columns[j], t.columns[i]];
	return true;
}

// Auto-layout: layered by FK depth, referenced tables leftmost. No coords stored.
/**
 * @param {Schema} schema
 */
export function layout(schema) {
	const byId = Object.fromEntries(schema.tables.map((t) => [t.id, t]));
	const depth = new Map();
	const d = (id, seen) => {
		if (depth.has(id)) return depth.get(id);
		if (seen.has(id)) return 0; // cycle guard
		seen.add(id);
		const refs = byId[id].columns
			.filter((c) => c.ref && byId[c.ref.tableId])
			.map((c) => d(c.ref.tableId, seen));
		const val = refs.length ? Math.max(...refs) + 1 : 0;
		depth.set(id, val);
		return val;
	};
	for (const t of schema.tables) d(t.id, new Set());
	// Group by layer. A Map, not an array: a cycle (a↔b) can skip a depth
	// entirely, and a sparse array would leave a hole the sweep would trip on.
	const cols = new Map();
	for (const t of schema.tables) {
		const L = depth.get(t.id);
		if (!cols.has(L)) cols.set(L, []);
		cols.get(L).push(t);
	}
	const maxLayer = Math.max(0, ...cols.keys());
	// Barycenter sweep: within each layer (processed left→right), order
	// tables by the mean position of their parents in the PREVIOUS layer, so
	// edges hug the nodes they connect instead of crossing. Tables with no
	// parent there keep their input order (stable sort); layer 0 has no
	// previous layer and is untouched. Positions are only assigned after the
	// whole layer is ordered, so the sort reads indices, not coordinates.
	for (let L = 0; L <= maxLayer; L++) {
		const layer = cols.get(L);
		if (!layer) continue; // cycle-skipped depth
		if (L > 0) {
			const prev = cols.get(L - 1);
			// when the previous depth was skipped by a cycle, no table can
			// reference it, so the sort below is a no-op — skip it entirely
			if (prev) {
				const prevIndex = new Map(prev.map((t, i) => [t.id, i]));
				const score = new Map(
					layer.map((t) => {
						const ps = t.columns
							.filter((c) => c.ref && prevIndex.has(c.ref.tableId))
							.map((c) => prevIndex.get(c.ref.tableId));
						return [
							t.id,
							ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null,
						];
					}),
				);
				layer.sort((a, b) => {
					const sa = score.get(a.id);
					const sb = score.get(b.id);
					if (sa !== null && sb !== null) return sa - sb;
					if (sa !== null) return -1; // parented tables first
					if (sb !== null) return 1;
					return 0; // stable: input order
				});
			}
		}
		let y = CANVAS_ORIGIN.y;
		for (const t of layer) {
			t.x = CANVAS_ORIGIN.x + L * COL_W;
			t.y = y;
			// stackStep() owns the card-height + gap arithmetic (geometry.js).
			// This was open-coded as `+ 24 + GAP`, which is 3px less than the
			// real card, so stacked cards sat closer than intended.
			y += stackStep(t.columns.length);
		}
	}
}

// uniqName picks a name absent from `taken`, starting at `base`.
// A trailing number is incremented, not appended: "table1" yields table2,
// table3 — the naive `base + ++i` produced table12, table13, silently
// skipping table2..table11. A base with no trailing digits gets one appended,
// so "users_copy" yields users_copy, users_copy2, users_copy3.
//
// `taken` may be an Array or a Set — callers with many tables pass a Set for
// O(1) lookup (500 tables: 5× faster than Array.includes in bench).
/**
 * @param {string} base
 * @param {string[] | Set<string>} taken
 * @returns {string}
 */
export function uniqName(base, taken) {
	const m = /^(.*?)(\d+)$/.exec(base);
	const prefix = m ? m[1] : base;
	let n = m ? Number(m[2]) : 1;
	let name = base;
	const has =
		taken instanceof Set ? (v) => taken.has(v) : (v) => taken.includes(v);
	while (has(name)) name = prefix + ++n;
	return name;
}
