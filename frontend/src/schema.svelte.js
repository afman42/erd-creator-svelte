// schema.svelte.js — shared reactive store: model state, mutations, undo,
// persistence, server round-trips. Grammar/DDL still lives in Go; this module
// owns the client model and the fetch() boundaries.
// Single exported $state object: Svelte forbids exporting a $state binding
// that is reassigned, so all state lives on `store` and mutations assign
// properties (allowed) — never the exported binding itself.

import { api } from "./api.js";
import {
	cloneTable,
	DEFAULT_TYPE,
	isInt,
	layout,
	newColumn,
	newSchema,
	newTable,
	shiftColumn,
	uniqName,
} from "./erd.js";
import { CANVAS_ORIGIN, DUP_OFFSET, stackStep } from "./geometry.js";
import { snap as snapHistory, undo as undoHistory } from "./history.js";
import { createManyToMany, createRelationship } from "./relationships.js";
import { initialTheme, saveTheme, THEME_DARK, THEME_LIGHT } from "./theme.js";

/**
 * Type shorthands for the client model shapes, defined in erd.js.
 * @typedef {import("./erd.js").Table} Table
 * @typedef {import("./erd.js").Column} Column
 * @typedef {import("./erd.js").Ref} Ref
 * @typedef {import("./erd.js").Index} Index
 */

// ---- state ----
export const store = $state({
	currentFile: "", // "name.sql" | "" (unsaved scratch)
	/** @type {{name: string, mtime?: string}[]} */
	files: [], // [{name, mtime}]
	// The dialect lives on the schema, not beside it: one dropdown then drives
	// save, the SQL panel, copy and export, and the file remembers its grammar.
	schema: newSchema("mysql", [newTable("users")]),
	sqlText: "",
	error: "",
	errorKind: "err",
	selected: null,
	lint: [],
	exporting: false,
	// Mirror of autosave's dirty flag, made reactive so the Toolbar can render
	// an unsaved indicator. autosave.js owns the truth (it drives the flush
	// gates); the mirror is written at exactly the two places the flag changes.
	dirty: false,
	// UI theme; NOT part of the schema, so it never enters undo snapshots or
	// the saved file. App.svelte applies it as data-theme on <html>.
	theme: initialTheme(),
});
layout(store.schema);

// ---- server round-trips (debounced; local-first, banner on error) ----
// Both refreshes follow the same contract: a fetch failure keeps the last-good
// value (a transient server error must not blank the panel), an empty success
// clears it.
async function refreshLint() {
	try {
		store.lint = await api("/api/lint", "POST", { schema: store.schema });
	} catch {
		/* keep last lint */
	}
}
// refreshSql returns whether the export succeeded so callers (copySql) can tell
// a stale panel from a fresh copy instead of copying whatever was last shown.
export async function refreshSql() {
	try {
		// The panel shows the schema's own dialect, so it always agrees with
		// the dropdown and with what Save writes. It used to hardcode mysql,
		// which contradicted a dropdown reading "PostgreSQL".
		store.sqlText = await api("/export", "POST", {
			dialect: store.schema.dialect,
			schema: store.schema,
		});
		return true;
	} catch {
		/* keep last good text */
		return false;
	}
}

// Wired from App's $effect (which tracks schema deep state + the local
// showSql flag): debounce fan-out — lint, autosave and SQL-panel refresh each
// wait for their own quiet window before firing (see LINT/SAVE/SQL_DEBOUNCE_MS
// in autosave.js). skipTouch: set right before openFile/newFile swap
// store.schema; the App $effect fires once on the swap — that is a load, not a
// user edit, so it must not mark the file dirty or schedule a needless save.
import {
	flushCurrent as flushAutosave,
	installFlush,
	touch as touchAutosave,
} from "./autosave.js";

/** @param {boolean} showSql */
export function touch(showSql) {
	touchAutosave(showSql, { store, refreshLint, refreshSql, saveCurrent });
}

// ---- undo (client-only, JSON snapshots) ----
export function snap() {
	snapHistory(store.schema);
}
export function undo() {
	const prev = undoHistory();
	if (!prev) return;
	store.schema = prev;
	store.selected = null;
}

// ---- timers / flush ----
async function flushCurrent() {
	await flushAutosave({ store, saveCurrent });
}
// Unload safety: a pending saveTimer dies with the page, dropping up to
// SAVE_DEBOUNCE_MS of edits. Flush best-effort on the way out.
// ponytail: plain fetch may abort mid-unload; keepalive fetch (64KB cap) would
// harden the final write — add if real tab-closes drop edits.
installFlush(() => flushCurrent());

// ---- model mutations ----
// Names come from erd.js's uniqName (pure + unit-tested); it needs the taken
// set passed in, since it has no access to the store. Returned as Set for O(1)
// lookup when many tables exist (bench: 500 tables 5× faster).
const takenNames = () => new Set(store.schema.tables.map((t) => t.name));
export function addTable() {
	snap();
	// Place the new card one full stack step below the lowest existing card,
	// using the same arithmetic layout() uses. This was a bare `+36` with no
	// derivation; it agreed with layout()'s `24 + GAP` only by coincidence
	// (24+12=36), and both understated the real card by 3px.
	const y = Math.max(
		CANVAS_ORIGIN.y,
		...store.schema.tables.map((t) => t.y + stackStep(t.columns.length)),
	);
	store.schema.tables.push(
		Object.assign(newTable(uniqName("table1", takenNames())), {
			x: CANVAS_ORIGIN.x,
			y,
		}),
	);
}
/**
 * @param {Table} t
 */
export function dupTable(t) {
	snap();
	const c = cloneTable(t);
	c.name = uniqName(`${t.name}_copy`, takenNames());
	c.x = t.x + DUP_OFFSET;
	c.y = t.y + DUP_OFFSET;
	store.schema.tables.push(c);
}
/**
 * @param {Table} t
 */
export function rmTable(t) {
	snap();
	store.schema.tables = store.schema.tables.filter((x) => x.id !== t.id);
	for (const o of store.schema.tables)
		for (const c of o.columns) if (c.ref?.tableId === t.id) c.ref = null;
	if (store.selected === t.id) store.selected = null;
}
/**
 * @param {Table} t
 * @param {Column} c
 */
export function rmColumn(t, c) {
	if (t.columns.length === 1) {
		flash(`${t.name} needs at least one column`, "err");
		return;
	} // empty table = invalid DDL
	snap();
	t.columns = t.columns.filter((x) => x.id !== c.id);
}
// moveColumn reorders a column within its table: the array order is the DDL
// order, so the emitters follow. The edge check runs BEFORE snap so a no-op
// move does not leave a dead undo entry.
/**
 * @param {Table} t
 * @param {Column} c
 * @param {-1 | 1} delta
 */
export function moveColumn(t, c, delta) {
	const i = t.columns.findIndex((x) => x.id === c.id);
	const j = i + delta;
	if (i < 0 || j < 0 || j >= t.columns.length) return;
	snap();
	shiftColumn(t, c.id, delta);
}
/**
 * @param {Table} t
 */
export function addColumn(t) {
	snap();
	t.columns.push(newColumn());
}
/**
 * commitCreate applies a creator result: a failure flashes its error and
 * leaves the schema untouched (no dead undo entry); a success snapshots for
 * undo and re-lints. Shared by addRelationship and addManyToMany.
 * @param {{ ok: boolean, error?: string }} r
 * @returns {boolean}
 */
function commitCreate(r) {
	if (!r.ok) {
		flash(r.error, "err");
		return false;
	}
	snap();

	return true;
}
/**
 * addRelationship creates a first-class 1:1 or 1:N relationship by appending
 * the FK column createRelationship() builds.
 * @param {string} childId
 * @param {string} parentId
 * @param {"1:1" | "1:N"} type
 * @returns {boolean}
 */
export function addRelationship(childId, parentId, type) {
	return commitCreate(
		createRelationship(store.schema, childId, parentId, type),
	);
}
/**
 * addManyToMany creates the junction table (composite PK over two FK columns)
 * that makes a pair of tables N:N, via createManyToMany. The junction badge on
 * the card is derived from the same shape (isJunctionTable), never stored.
 * @param {string} aId
 * @param {string} bId
 * @returns {boolean}
 */
export function addManyToMany(aId, bId) {
	return commitCreate(createManyToMany(store.schema, aId, bId));
}
/**
 * @param {Table} t
 */
export function commitTableName(t, ev) {
	const v = ev.target.value.trim();
	if (v && !store.schema.tables.some((x) => x !== t && x.name === v)) {
		snap();
		t.name = v;
	} else ev.target.value = t.name;
}
/**
 * @param {Column} c
 */
export function commitColName(c, ev) {
	const v = ev.target.value.trim();
	if (v) {
		snap();
		c.name = v;
	} else ev.target.value = c.name;
}
// Comments accept empty (clearing one is legitimate), unlike names.
/**
 * @param {Column} c
 */
export function commitComment(c, ev) {
	snap();
	c.comment = ev.target.value.trim();
}
// commitDefault stores the column's DEFAULT expression as typed; empty clears
// it. The server validates the expression (validateDefault); the one rule the
// UI enforces up front is AI + DEFAULT, which every dialect rejects — the
// same proactive refusal the array toggle uses for PK/AI.
/**
 * @param {Column} c
 * @param {Event & { target: HTMLInputElement }} ev
 */
export function commitDefault(c, ev) {
	const v = ev.target.value.trim();
	if (v && c.ai) {
		flash("an auto-increment column cannot also have a default", "err");
		ev.target.value = c.default ?? "";
		return;
	}
	snap();
	c.default = v;
}
// commitTableComment is the table-level twin of commitComment: the comment is
// edited in the table dialog (TableIndexModal) and emitted where the dialect
// supports table comments.
/**
 * @param {Table} t
 * @param {Event & { target: HTMLInputElement }} ev
 */
export function commitTableComment(t, ev) {
	snap();
	t.comment = ev.target.value.trim();
}
/**
 * @param {"dark" | "light"} t
 */
export function setTheme(t) {
	if (store.theme === t) return;
	store.theme = t;
	saveTheme(t);
}
export const toggleTheme = () =>
	setTheme(store.theme === THEME_DARK ? THEME_LIGHT : THEME_DARK);
/**
 * @param {Column} c
 */
export function setType(c, base) {
	if (base === "ENUM") {
		const cur = /^ENUM\((.*)\)$/i.exec(c.type)?.[1] ?? "";
		const vals = prompt("ENUM values, comma separated:", cur || "'a','b'");
		if (vals == null) return;
		snap();
		c.type =
			"ENUM(" +
			vals
				.split(",")
				.map((v) => {
					v = v.trim();
					return /^'(.*)'$/.test(v) ? v : `'${v.replace(/'/g, "")}'`;
				})
				.join(",") +
			")";
		return;
	}
	snap();
	c.type = DEFAULT_TYPE[base] ?? base;
	if (!isInt(c.type)) c.ai = false;
}

// toggleArray adds or removes the PostgreSQL array suffix on a column's type.
//
// The suffix is appended to whatever the type currently is, so `VARCHAR(255)`
// becomes `VARCHAR(255)[]` and back — no separate "element type" field, because
// the model already stores the full type expression and splitting it would mean
// two sources of truth for the same fact.
//
// Only offered while postgres is selected: `INT[]` is PostgreSQL syntax and the
// server refuses to emit it for the other dialects (ValidateFor), so exposing
// the control elsewhere would let the user build a schema that cannot be saved.
/**
 * @param {Column} c
 */
export function toggleArray(c) {
	snap();
	c.type = c.type.endsWith("[]") ? c.type.slice(0, -2) : `${c.type}[]`;
	// An array column cannot be an identity column or a primary key, so those
	// flags are cleared rather than left set for the server to reject.
	if (c.type.endsWith("[]")) {
		c.ai = false;
		c.pk = false;
	}
}
/**
 * @param {Column} c
 */
export function setRef(c, ev) {
	snap();
	const id = ev.target.value;
	// Both actions are carried across a re-target: changing which table an FK
	// points at must not silently reset the referential actions the user chose.
	// onUpdate keeps its "" (meaning "omit the clause") rather than gaining a
	// default, which is the asymmetry documented on Ref in grammar.go.
	c.ref = id
		? {
				tableId: id,
				action: c.ref?.action ?? "CASCADE",
				onUpdate: c.ref?.onUpdate ?? "",
			}
		: null;
	if (id) c.ai = false;
}
/**
 * @param {Column} c
 */
export function setRefAction(c, ev) {
	snap();
	if (c.ref) c.ref.action = ev.target.value;
}
// setRefOnUpdate sets ON UPDATE. Unlike setRefAction there is no default: the
// empty option means "omit the clause" and is stored as "", because a schema
// written before this field existed carries no ON UPDATE and must keep emitting
// none. See the Ref comment in grammar.go for why the two actions differ.
/**
 * @param {Column} c
 */
export function setRefOnUpdate(c, ev) {
	snap();
	if (c.ref) c.ref.onUpdate = ev.target.value;
}
// unsetRef deletes the relationship without dropping the column: clears the
// FK so the edge disappears but name/type/flags stay. Separate from setRef
// (retarget) and rmColumn (drop) — the column modal's Remove relationship.
export function unsetRef(c) {
	if (!c.ref) return;
	snap();
	c.ref = null;
}
/**
 * @param {Column} c
 */
export function togglePk(c) {
	snap();
	c.pk = !c.pk;
	if (c.pk) c.nn = true;
}

// toggleFlag flips one of a column's boolean flags (nn/ux/ai/ix). Lives here
// with the other mutations so every undo snapshot is taken in one place —
// TableCard used to inline snap() plus the flip four times.
//
// Cardinality is steered through these flags directly now (the old
// setCardinality/applyCardinality writer pair was removed with the
// ColumnEditModal select): UQ → child 0..1 else 0..N; NN (or PK, which the
// emitters always write NOT NULL for) → parent 1..1 else 0..1 — the rule
// cardinality() in geometry.js reads. The RelationshipModal writes the same
// flags at creation; nothing is stored beyond them.
/**
 * @param {Column} c
 */
export function toggleFlag(c, flag) {
	snap();
	c[flag] = !c[flag];
}

// ---- composite indexes ----
// A composite index spans several columns, so it cannot live on a Col — see the
// Index comment in grammar.go. These mutations mirror the column ones: snapshot
// for undo, then mutate. Every one is guarded so the UI cannot produce a state
// the server would reject (an index with no columns, or the same column twice,
// which is legal SQL but always a mistake here).

// ensureIndexes returns the table's index list, creating it on a table that
// predates the field (a schema loaded from an older file has no `indexes`).
/** @param {Table} t */
function ensureIndexes(t) {
	if (!Array.isArray(t.indexes)) t.indexes = [];
	return t.indexes;
}

// addIndex creates a composite index over the named columns. Duplicates are
// dropped: the same column twice in one index is almost certainly a mis-click,
// and the server's validation would accept it while the DDL it produces is
// useless.
/**
 * @param {Table} t
 * @param {string[]} cols
 */
export function addIndex(t, cols) {
	const unique = [...new Set(cols.filter(Boolean))];
	if (unique.length < 2) {
		flash("pick at least two columns for a composite index", "err");
		return;
	}
	snap();
	ensureIndexes(t).push({ cols: unique });
}

/**
 * @param {Table} t
 * @param {Index} ix
 */
export function rmIndex(t, ix) {
	snap();
	const list = ensureIndexes(t);
	const i = list.indexOf(ix);
	if (i >= 0) list.splice(i, 1);
}

// setIndexName sets an explicit name. Empty clears it back to the derived
// idx_<table>_<cols> form, which is the default and needs no UI. No table
// parameter: the name lives on the index itself, so only the index is needed.
/**
 * @param {Index} ix
 * @param {string} name
 */
export function setIndexName(ix, name) {
	snap();
	ix.name = name.trim();
}

// toggleIndexCol adds or removes one column from an existing composite index.
// Refuses to drop below two columns: a one-column index is Col.Ix, and letting
// it become one here would emit the same DDL two different ways depending on
// how it was created. Takes only the index for the same reason as setIndexName.
/**
 * @param {Index} ix
 * @param {string} colName
 */
export function toggleIndexCol(ix, colName) {
	const i = ix.cols.indexOf(colName);
	if (i >= 0 && ix.cols.length <= 2) {
		flash("a composite index needs at least two columns", "err");
		return;
	}
	snap();
	if (i >= 0) ix.cols.splice(i, 1);
	else ix.cols.push(colName);
}

/**
 * @param {string} msg
 * @param {string} kind
 */
export function flash(msg, kind = "ok") {
	store.error = msg;
	store.errorKind = kind;
	setTimeout(() => {
		if (store.error === msg) store.error = "";
	}, 1400);
}
/** @param {?string} id */
export function setSelected(id) {
	store.selected = id;
}
// setDialect switches the schema's grammar. It is a real mutation (the saved
// bytes change), so it snapshots for undo and refreshes the SQL panel when it
// is open — previously the panel kept showing the old dialect because nothing
// reacted to the change.
/** @param {string} d */
export function setDialect(d) {
	if (store.schema.dialect === d) return;
	snap();
	store.schema.dialect = d;
	if (store.sqlText) refreshSql();
}

// setSqliteTypes switches how SQLite renders the types it has no storage class
// for. Like setDialect this is a real mutation — the saved bytes change — so it
// snapshots for undo and refreshes the SQL panel when it is open.
/** @param {string} mode */
export function setSqliteTypes(mode) {
	if (store.schema.sqliteTypes === mode) return;
	snap();
	store.schema.sqliteTypes = mode;
	if (store.sqlText) refreshSql();
}

import {
	deleteFile as deleteFileImpl,
	duplicateFile as duplicateFileImpl,
	newFile as newFileImpl,
	openFile as openFileImpl,
	refreshFiles as refreshFilesImpl,
	renameFile as renameFileImpl,
	saveCurrent as saveCurrentImpl,
} from "./fileStore.js";

async function refreshFiles() {
	await refreshFilesImpl(store);
}
refreshFiles().then(() => {
	if (!store.files.length) return;
	const newest = store.files.reduce((a, b) => (b.mtime > a.mtime ? b : a));
	openFile(newest.name);
});

/** @param {string} name */
export async function openFile(name) {
	await openFileImpl(store, name, flash);
}
export async function newFile() {
	await newFileImpl(store, flash);
}
export async function saveCurrent(silent = false) {
	await saveCurrentImpl(store, flash, silent);
}
export async function deleteFile() {
	await deleteFileImpl(store, flash);
}
export async function renameFile() {
	await renameFileImpl(store, flash);
}
export async function duplicateFile() {
	await duplicateFileImpl(store, flash);
}

// ---- clipboard + exports ----
// The implementations live in export.js (parallel to capture.js); the store
// keeps the public API and wires its own store/flash/refreshSql so components
// import these exact names without knowing about the split.
import {
	copyInserts as copyInsertsImpl,
	copySql as copySqlImpl,
	exportDdl as exportDdlImpl,
	exportPng as exportPngImpl,
	exportSvg as exportSvgImpl,
} from "./export.js";

export const copyInserts = () => copyInsertsImpl(store, flash);
export const copySql = () => copySqlImpl(store, refreshSql, flash);
export const exportDdl = () => exportDdlImpl(store, flash);
export const exportPng = () => exportPngImpl(store, flash);
export const exportSvg = () => exportSvgImpl(store, flash);
