// erd.js — client-side UI helpers + auto-layout. All SQL grammar (generate,
// parse, lint) lives in Go; the browser talks to /api and /export.
import { stackStep } from "./geometry.js";

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
export const DIALECTS = ["mysql", "mariadb", "postgres", "sqlite"];
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

export let nextTableId = 1;
export let nextColId = 1;
export function newTable(name) {
	return {
		id: `t${nextTableId++}`,
		name,
		x: 0,
		y: 0,
		columns: [
			{
				id: `c${nextColId++}`,
				name: "id",
				type: "INT",
				pk: true,
				nn: true,
				ai: true,
				ux: false,
				ix: false,
				comment: "",
				ref: null,
			},
		],
		// Composite indexes. Always present (empty array) so the UI can push to
		// it without a null guard, and serialized away by the server's omitempty
		// when empty — so a schema with no composite index still travels as the
		// exact JSON it did before this field existed.
		indexes: [],
	};
}
export function newColumn() {
	return {
		id: `c${nextColId++}`,
		name: "column",
		type: "VARCHAR(255)",
		pk: false,
		nn: false,
		ai: false,
		ux: false,
		ix: false,
		comment: "",
		ref: null,
	};
}
export function cloneTable(t) {
	return {
		...t,
		id: `t${nextTableId++}`,
		columns: t.columns.map((c) => ({
			...c,
			id: `c${nextColId++}`,
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
export function adoptIds(schema) {
	for (const t of schema.tables) {
		if (/^t\d+$/.test(t.id))
			nextTableId = Math.max(nextTableId, +t.id.slice(1) + 1);
		else t.id = `t${nextTableId++}`;
		for (const c of t.columns) {
			if (!c.id) c.id = `c${nextColId++}`;
			else if (/^c\d+$/.test(c.id))
				nextColId = Math.max(nextColId, +c.id.slice(1) + 1);
		}
	}
	return schema;
}

// Auto-layout: layered by FK depth, referenced tables leftmost. No coords stored.
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
	const cols = new Map();
	for (const t of schema.tables) {
		const layer = depth.get(t.id);
		if (!cols.has(layer)) cols.set(layer, []);
		cols.get(layer).push(t);
	}
	const COL_W = 340;
	for (const [layer, ts] of cols) {
		let y = 40;
		for (const t of ts) {
			t.x = 40 + layer * COL_W;
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
export function uniqName(base, taken) {
	const m = /^(.*?)(\d+)$/.exec(base);
	const prefix = m ? m[1] : base;
	let n = m ? Number(m[2]) : 1;
	let name = base;
	const has = taken instanceof Set ? (v) => taken.has(v) : (v) => taken.includes(v);
	while (has(name)) name = prefix + ++n;
	return name;
}
