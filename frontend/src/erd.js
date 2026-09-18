// erd.js — client-side UI helpers + auto-layout. All SQL grammar (generate,
// parse, lint) lives in Go; the browser talks to /api and /export.
import { HDR_H, ROW_H } from "./geometry.js";

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
// Dialects the server can emit. Only mysql and postgres are saveable (the
// server has parsers for both); mariadb and sqlite are export-only, which is
// why SAVEABLE_DIALECTS is a subset — the dropdown still offers all four.
export const DIALECTS = ["mysql", "mariadb", "postgres", "sqlite"];
export const SAVEABLE_DIALECTS = ["mysql", "postgres"];
export const DEFAULT_DIALECT = "mysql";
export const isSaveable = (d) => SAVEABLE_DIALECTS.includes(d);
export const baseType = (t) => t.split("(")[0];
const INT_RE = /^(INT|BIGINT|SMALLINT|TINYINT)/;
export const isInt = (t) => INT_RE.test(baseType(t));

// newSchema: the client's schema envelope. The dialect travels with the model
// so one dropdown drives save, the SQL panel, copy and export, and so a saved
// file remembers which grammar it is written in.
export function newSchema(dialect = DEFAULT_DIALECT, tables = []) {
	return { dialect, tables };
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
	const COL_W = 340,
		GAP = 12;
	for (const [layer, ts] of cols) {
		let y = 40;
		for (const t of ts) {
			t.x = 40 + layer * COL_W;
			t.y = y;
			y += HDR_H + t.columns.length * ROW_H + 24 + GAP; // box height from geometry.js
		}
	}
}

// uniqName picks a name absent from `taken`, starting at `base`.
// A trailing number is incremented, not appended: "table1" yields table2,
// table3 — the naive `base + ++i` produced table12, table13, silently
// skipping table2..table11. A base with no trailing digits gets one appended,
// so "users_copy" yields users_copy, users_copy2, users_copy3.
export function uniqName(base, taken) {
	const m = /^(.*?)(\d+)$/.exec(base);
	const prefix = m ? m[1] : base;
	let n = m ? Number(m[2]) : 1;
	let name = base;
	while (taken.includes(name)) name = prefix + ++n;
	return name;
}
