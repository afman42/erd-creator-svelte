import { newColumn, newTable, uniqName } from "./erd.js";
import { CANVAS_ORIGIN, stackStep } from "./geometry.js";

// pkTypeOf returns the parent's sole-PK type for the FK column to inherit,
// else null (callers default to INT).
/**
 * @param {import("./erd.js").Table} t
 * @returns {?string}
 */
function pkTypeOf(t) {
	const pk = t.columns.filter((c) => c.pk);
	return pk.length === 1 ? pk[0].type : null;
}

// fkColumnName derives the default name for a relationship FK column by
// stripping a trailing "s" ("users" → "user_id"). A double-s keeps the stem
// ("address" → "address_id", not "addres_id"). It is a default, not a rule:
// the user can rename the column afterwards, and uniqName keeps it unique
// against the child's existing columns.
/**
 * @param {string} parentName
 * @returns {string}
 */
function fkColumnName(parentName) {
	const stem =
		parentName.endsWith("s") && !parentName.endsWith("ss")
			? parentName.slice(0, -1)
			: parentName;
	return `${stem}_id`;
}

/**
 * createRelationship appends an FK column to the child table so the pair reads
 * as the requested type. 1:1 writes NOT NULL + UNIQUE (child `0..1` / parent
 * `1..1`); 1:N writes NOT NULL only (child `0..N` / parent `1..1`). It writes
 * exactly the flags cardinality() already reads — nothing new is stored, so
 * the .sql round-trip keeps the relationship faithful.
 *
 * The column inherits the referenced table's sole-PK type when there is one,
 * else INT; the name is `<parent singular>_id` made unique against the child's
 * column names via uniqName.
 *
 * @param {{ tables: import("./erd.js").Table[] }} schema
 * @param {string} childId
 * @param {string} parentId
 * @param {"1:1" | "1:N"} type
 * @returns {{ ok: boolean, error?: string, column?: import("./erd.js").Column }}
 */
export function createRelationship(schema, childId, parentId, type) {
	if (childId === parentId)
		return { ok: false, error: "child and parent must be distinct tables" };
	const child = schema.tables.find((t) => t.id === childId);
	const parent = schema.tables.find((t) => t.id === parentId);
	if (!child || !parent) return { ok: false, error: "unknown table" };
	if (type !== "1:1" && type !== "1:N")
		return { ok: false, error: `unknown relationship type: ${type}` };

	const column = Object.assign(newColumn(), {
		name: uniqName(
			fkColumnName(parent.name),
			new Set(child.columns.map((c) => c.name)),
		),
		type: pkTypeOf(parent) ?? "INT",
		nn: true,
		ux: type === "1:1",
		ref: { tableId: parentId, action: "CASCADE", onUpdate: "" },
	});
	child.columns.push(column);
	return { ok: true, column };
}

// previewLabels maps a relationship type to the min-max labels its creation
// writes, so the dialog can show the result BEFORE anything is mutated. It is
// the exact forward image of the creators below: 1:1 writes nn+ux
// (child 0..1 / parent 1..1), 1:N writes nn (child 0..N / parent 1..1), and N:N
// builds a junction whose two FK edges each read child 0..N / parent 1..1
// (a composite-PK member is not unique — see cardinality() in geometry.js).
// Unknown types return null; the dialog renders no preview for those.
/**
 * @param {"1:1" | "1:N" | "N:N" | string} type
 * @returns {{ child: string, parent: string } | null}
 */
export function previewLabels(type) {
	if (type === "1:1") return { child: "0..1", parent: "1..1" };
	if (type === "1:N") return { child: "0..N", parent: "1..1" };
	if (type === "N:N") return { child: "0..N", parent: "1..1" };
	return null;
}

// isJunctionTable reports whether a table is a many-to-many junction: PK of
// exactly two columns, both FKs, and referenced by nobody else. It is the
// DERIVED definition — nothing stored marks a junction, so a table created by
// hand (or loaded from a .sql that survived a save/load) is recognized by the
// same shape the creator builds, and no stored field can drift from the DDL.
// The "referenced by nobody" clause keeps the badge conservative: a table that
// is both a 2-col FK composite-PK and a parent of another relationship is not
// a pure junction and renders as a plain table.
/**
 * @param {import("./erd.js").Table} t
 * @param {{ tables: import("./erd.js").Table[] }} schema
 * @returns {boolean}
 */
export function isJunctionTable(t, schema) {
	const pk = t.columns.filter((c) => c.pk);
	if (pk.length !== 2 || !pk.every((c) => c.ref)) return false;
	return !schema.tables.some(
		(other) =>
			other !== t && other.columns.some((c) => c.ref?.tableId === t.id),
	);
}

// createManyToMany builds the junction-table shape N:N needs: a new table
// `<A>_<B>` whose PK is exactly the two FK columns `<a>_id`, `<b>_id` — both
// NOT NULL, NEITHER unique (a composite-PK member is not unique; that is what
// makes the pair express many-to-many). Same rejections as createRelationship,
// plus: the junction name must be free — a collision fails instead of being
// silently suffixed, because `users_posts2` would read as an unrelated table.
/**
 * @param {{ tables: import("./erd.js").Table[] }} schema
 * @param {string} aId
 * @param {string} bId
 * @returns {{ ok: boolean, error?: string, table?: import("./erd.js").Table }}
 */
export function createManyToMany(schema, aId, bId) {
	if (aId === bId)
		return { ok: false, error: "a many-to-many needs two distinct tables" };
	const a = schema.tables.find((t) => t.id === aId);
	const b = schema.tables.find((t) => t.id === bId);
	if (!a || !b) return { ok: false, error: "unknown table" };
	const name = `${a.name}_${b.name}`;
	// The same pair in either order is one junction: a reversed create
	// (`posts` + `users` after `users_posts` exists) must fail, not mint a
	// second table under the flipped name. The error names the table that
	// actually exists.
	const existing = [name, `${b.name}_${a.name}`].find((n) =>
		schema.tables.some((t) => t.name === n),
	);
	if (existing) return { ok: false, error: `table ${existing} already exists` };

	const junction = Object.assign(newTable(name), {
		// One full stack step below the lowest card — the same arithmetic
		// addTable/layout use, so the new card never overlaps.
		x: CANVAS_ORIGIN.x,
		y: Math.max(
			CANVAS_ORIGIN.y,
			...schema.tables.map((t) => t.y + stackStep(t.columns.length)),
		),
		// No surrogate id: the PK IS the two FKs.
		columns: [a, b].map((side) =>
			Object.assign(newColumn(), {
				name: fkColumnName(side.name),
				type: pkTypeOf(side) ?? "INT",
				pk: true,
				nn: true,
				ai: false,
				ux: false,
				ref: { tableId: side.id, action: "CASCADE", onUpdate: "" },
			}),
		),
	});
	schema.tables.push(junction);
	return { ok: true, table: junction };
}
