// schema.svelte.js — shared reactive store: model state, mutations, undo,
// persistence, server round-trips. Grammar/DDL still lives in Go; this module
// owns the client model and the fetch() boundaries.
// Single exported $state object: Svelte forbids exporting a $state binding
// that is reassigned, so all state lives on `store` and mutations assign
// properties (allowed) — never the exported binding itself.

import { api } from "./api.js";
import { bumpStruct } from "./canvasView.js";
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
import { CANVAS_ORIGIN, DUP_OFFSET, lowestY } from "./geometry.js";
import {
	depth as depthHistory,
	dropLast as dropHistory,
	setSnapHook as setSnapHookHistory,
	snap as snapHistory,
	undo as undoHistory,
} from "./history.js";

setSnapHookHistory(bumpStruct);

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
	sqlLoading: false, // true while refreshSql is in flight; distinct from ""
	error: "",
	errorKind: "err",
	// Toast queue (max 3, oldest evicted): error/errorKind above mirror the
	// latest entry so existing text assertions keep working. Each entry is
	// {id, msg, kind}; id is a monotonic counter, never reused.
	/** @type {{id: number, msg: string, kind: string}[]} */
	notices: [],
	selected: null,
	lint: [],
	exporting: false,
	// Mirror of autosave's dirty flag, made reactive so the Toolbar can render
	// an unsaved indicator. autosave.js owns the truth (it drives the flush
	// gates); the mirror is kept in lockstep via setDirtyBoth() in autosave.js.
	dirty: false,
	// UI theme; NOT part of the schema, so it never enters undo snapshots or
	// the saved file. App.svelte applies it as data-theme on <html>.
	theme: initialTheme(),
	// Reactive mirror of the history.js stack depth — drives the Toolbar Undo
	// disabled state. Synced in snap()/undo() below and on clearHistory sites.
	undoDepth: 0,
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
	store.sqlLoading = true;
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
	} finally {
		store.sqlLoading = false;
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
	store.undoDepth = depthHistory();
}
export function undo() {
	const prev = undoHistory();
	// Sync even on null: undo() drains corrupt entries, so depth can move
	// while returning nothing.
	store.undoDepth = depthHistory();
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
// Lowest card bottom helper lives in geometry.js (lowestY); layout() in
// erd.js owns the same stacking via stackStep(). takenNames feeds uniqName
// the taken set (pure + unit-tested, needs it passed in — no store access).
const takenNames = () => new Set(store.schema.tables.map((t) => t.name));
// dupOf reports whether name is taken by any table other than t,
// case-insensitively. Shared by commitTableName/commitColName.
function dupOf(list, name, self, key = (x) => x.name) {
	const v = name.toLowerCase();
	return list.some((x) => x !== self && key(x).toLowerCase() === v);
}
export function addTable() {
	snap();
	// Place the new card one full stack step below the lowest existing card,
	// via lowestY() — the same arithmetic layout()/createManyToMany use.
	const y = lowestY(store.schema.tables);
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
	// A self-referencing FK (ref.tableId === source id) must follow the copy:
	// otherwise the clone points at the ORIGINAL table, not itself.
	for (const col of c.columns)
		if (col.ref?.tableId === t.id) col.ref.tableId = c.id;
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
	// Composite indexes key columns by NAME — prune the deleted one so the
	// table cannot keep an index over a column that no longer exists.
	dropIndexCol(t, c.name);
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
 * commitCreate applies a creator thunk: snap BEFORE the mutation (like every
 * other mutation), run, and on failure drop the dead entry + flash.
 * @param {() => ({ ok: boolean, error?: string } | undefined)} fn
 * @returns {boolean}
 */
function commitCreate(fn) {
	snap();
	const r = fn();
	if (!r?.ok) {
		dropHistory();
		store.undoDepth = depthHistory();
		flash(r?.error ?? "could not create relationship", "err");
		return false;
	}
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
	return commitCreate(() =>
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
	return commitCreate(() => createManyToMany(store.schema, aId, bId));
}
/**
 * @param {Table} t
 */
export function commitTableName(t, ev) {
	commitName({
		list: store.schema.tables,
		self: t,
		ev,
		dupMsg: (v) => `table ${v} already exists`,
		apply: (v) => {
			t.name = v;
		},
	});
}
// commitName is the shared rename body behind commitTableName/commitColName:
// trim, reject empty/dup (resetting the input), no-op same-value without a
// snap, else snapshot + apply. dupMsg labels the flash per caller.
/**
 * @param {{ list: { name: string }[], self: { name: string }, ev: Event, dupMsg: (v: string) => string, apply: (v: string) => void }} args
 */
function commitName({ list, self, ev, dupMsg, apply }) {
	const el = /** @type {HTMLInputElement} */ (ev.target ?? ev.currentTarget);
	const v = el.value.trim();
	const dup = dupOf(list, v, self);
	if (v && !dup) {
		if (v === self.name) return; // no-op same-value: no snap
		snap();
		apply(v);
	} else {
		if (dup) flash(dupMsg(v), "err");
		el.value = self.name;
	}
}
/**
 * Sync ix.cols with a column rename: the composite index stores NAMES.
 * @param {Table} t
 * @param {string} from
 * @param {string} to
 */
function renameIndexCol(t, from, to) {
	updateIndexCol(t, from, (ix, i) => (ix.cols[i] = to));
}
/**
 * Drop a deleted column from every composite index on its table.
 * @param {Table} t
 * @param {string} name
 */
function dropIndexCol(t, name) {
	updateIndexCol(t, name, (ix, i) => ix.cols.splice(i, 1));
}
/**
 * Apply fn to every occurrence of a column name in the table's indexes.
 * @param {Table} t
 * @param {string} name
 * @param {(ix: Index, i: number) => void} fn
 */
function updateIndexCol(t, name, fn) {
	for (const ix of t.indexes ?? []) {
		const i = ix.cols.indexOf(name);
		if (i >= 0) fn(ix, i);
	}
}
/**
 * @param {Table} t
 * @param {Column} c
 */
export function commitColName(t, c, ev) {
	commitName({
		list: t.columns,
		self: c,
		ev,
		dupMsg: (v) => `column ${v} already exists in ${t.name}`,
		apply: (v) => {
			renameIndexCol(t, c.name, v);
			c.name = v;
		},
	});
}
// commitText reads a trimmed input value; empty is legitimate for comments
// and defaults (clearing one) but resets for names. Returns null when the
// caller must bail (empty name), leaving el.value reset to the old value.
/**
 * @param {HTMLInputElement} el
 * @param {string} oldValue
 * @param {boolean} allowEmpty
 * @returns {string | null}
 */
function commitText(el, oldValue, allowEmpty = false) {
	const v = el.value.trim();
	if (!v && !allowEmpty) {
		el.value = oldValue;
		return null;
	}
	return v;
}
// Comments accept empty (clearing one is legitimate), unlike names.
/**
 * @param {Column} c
 */
export function commitComment(c, ev) {
	commitFreeText(c, ev, "comment");
}
// commitDefault stores the column's DEFAULT expression as typed; empty clears
// it. The server validates the expression (validateDefault); the one rule the
// UI enforces up front is AI + DEFAULT, which every dialect rejects — the
// same proactive refusal the array toggle uses for PK/AI.
/**
 * @param {Column} c
 * @param {Event & { target: HTMLInputElement, currentTarget: HTMLInputElement }} ev
 */
export function commitDefault(c, ev) {
	const el = ev.currentTarget ?? ev.target;
	const v = el.value.trim();
	if (v && c.ai) {
		flash("an auto-increment column cannot also have a default", "err");
		el.value = c.default ?? "";
		return;
	}
	if (v === c.default) return; // no-op same-value: no snap
	snap();
	c.default = v;
}
// commitTableComment is the table-level twin of commitComment: the comment is
// edited in the table dialog (TableIndexModal) and emitted where the dialect
// supports table comments.
export function commitTableComment(t, ev) {
	commitFreeText(t, ev, "comment");
}
// commitFreeText applies a free-text field (comment): empty clears it
// (legitimate, unlike names). No-op same-value: no snap.
function commitFreeText(obj, ev, field) {
	const el = ev.target ?? ev.currentTarget;
	const v = commitText(el, obj[field], true);
	if (v === null) return;
	if (v === obj[field]) return;
	snap();
	obj[field] = v;
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
	const next = DEFAULT_TYPE[base] ?? base;
	if (next === c.type) return; // no-op same-value: no snap
	snap();
	c.type = next;
	// AI survives only on integer types: clearing it here (and in setRef/
	// toggleArray below) is the same guard commitDefault/toggleAi enforce.
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
		c.nn = false;
	}
}
/**
 * setFk is the single FK dispatcher: retarget (tableId), ON DELETE (action),
 * ON UPDATE (onUpdate), or clear (null). The three callers in ColumnEditModal
 * pass events; prompt-free object form keeps snap-once semantics.
 * @param {Column} c
 * @param {{ tableId?: string, action?: string, onUpdate?: string } | null} patch
 */
export function setFk(c, patch) {
	if (patch === null) {
		if (!c.ref) return; // no-op: no snap
		snap();
		c.ref = null;
		return;
	}
	if (patch.tableId !== undefined) {
		const id = patch.tableId;
		if ((c.ref?.tableId ?? "") === id) return; // no-op retarget: no snap
		snap();
		// Both actions are carried across a re-target: changing which table an
		// FK points at must not silently reset the referential actions chosen.
		// onUpdate keeps its "" (meaning "omit the clause") rather than gaining
		// a default, which is the asymmetry documented on Ref in grammar.go.
		c.ref = id
			? {
					tableId: id,
					action: c.ref?.action ?? "CASCADE",
					onUpdate: c.ref?.onUpdate ?? "",
				}
			: null;
		if (id) c.ai = false;
		return;
	}
	if (!c.ref) return; // no-op: actions on a column with no FK
	if (patch.action !== undefined) {
		if (c.ref.action === patch.action) return; // no-op: no snap
		snap();
		c.ref.action = patch.action;
		return;
	}
	if (patch.onUpdate !== undefined) {
		if (c.ref.onUpdate === patch.onUpdate) return; // no-op: no snap
		snap();
		c.ref.onUpdate = patch.onUpdate;
	}
}
/**
 * @param {Column} c
 */
export function setRef(c, ev) {
	setFk(c, { tableId: ev.target.value });
}
/**
 * @param {Column} c
 */
export function setRefAction(c, ev) {
	setFk(c, { action: ev.target.value });
}
// setRefOnUpdate sets ON UPDATE. Unlike setRefAction there is no default: the
// empty option means "omit the clause" and is stored as "", because a schema
// written before this field existed carries no ON UPDATE and must keep emitting
// none. See the Ref comment in grammar.go for why the two actions differ.
/**
 * @param {Column} c
 */
export function setRefOnUpdate(c, ev) {
	setFk(c, { onUpdate: ev.target.value });
}
// unsetRef deletes the relationship without dropping the column: clears the
// FK so the edge disappears but name/type/flags stay. Separate from setRef
// (retarget) and rmColumn (drop) — the column modal's Remove relationship.
export function unsetRef(c) {
	setFk(c, null);
}
/**
 * @param {Column} c
 */
export function togglePk(c) {
	snap();
	c.pk = !c.pk;
	// pk=true forces nn (emitters write NOT NULL for PK regardless); pk=false
	// clears the sticky nn the force set — but only the STICKY one: a column
	// that was already NOT NULL before PK keeps nn (it was explicit, and the
	// NN checkbox is enabled again so the user can still clear it by hand).
	if (c.pk) {
		if (!c.nn) {
			c.nn = true;
			c._stickyNn = true;
		}
	} else if (c._stickyNn) {
		c.nn = false;
		c._stickyNn = false;
	}
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
	// pk/ai steer through togglePk/toggleAi: toggling them raw would skip the
	// nn/ai invariants (PK forces nn; AI needs an int type and no default).
	if (flag === "pk") return togglePk(c);
	if (flag === "ai") return toggleAi(c);
	snap();
	c[flag] = !c[flag];
}
/**
 * @param {Column} c
 */
export function toggleAi(c) {
	if (!c.ai && (!isInt(c.type) || c.type.endsWith("[]"))) {
		flash("auto-increment needs an integer type", "err");
		return;
	}
	if (!c.ai && c.default) {
		flash("an auto-increment column cannot also have a default", "err");
		return;
	}
	snap();
	c.ai = !c.ai;
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
		return false;
	}
	snap();
	ensureIndexes(t).push({ cols: unique });
	return true;
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
	const v = name.trim();
	if (v === (ix.name ?? "")) return; // no-op same-value: no snap
	snap();
	ix.name = v;
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

let noticeId = 0;
/**
 * @param {string} msg
 * @param {"ok" | "err" | "warn"} [kind]
 */
export function flash(msg, kind = "ok") {
	store.error = msg;
	store.errorKind = kind;
	const id = ++noticeId;
	store.notices = [...store.notices, { id, msg, kind }].slice(-3);
	setTimeout(() => {
		// Compare by id, not by string: two identical messages in flight must
		// not clear each other, and a newer different error must survive —
		// clear only when no newer notice owns store.error.
		const latest = store.notices.at(-1);
		const owned = !!latest && latest.id !== id && store.error !== latest.msg;
		if (!owned && (!latest || store.error === msg)) store.error = "";
		store.notices = store.notices.filter((n) => n.id !== id);
	}, 1400);
}
/** @param {?string} id */
export function setSelected(id) {
	store.selected = id;
}
// setSchemaField assigns one schema-level field (dialect, sqliteTypes, …).
// setDialect/setSqliteTypes share this shape: no-op same-value early-return
// (no snap), then snapshot, assign, and refresh the SQL panel eagerly — even
// when it is closed, so reopening cannot show the old dialect's text.
/**
 * @param {string} field
 * @param {string} value
 */
function setSchemaField(field, value) {
	if (store.schema[field] === value) return;
	snap();
	store.schema[field] = value;
	store.sqlText = "";
	void refreshSql();
}
// setDialect switches the schema's grammar. It is a real mutation (the saved
// bytes change), so it snapshots for undo and refreshes the SQL panel when it
// is open — previously the panel kept showing the old dialect because nothing
// reacted to the change.
/** @param {string} d */
export function setDialect(d) {
	setSchemaField("dialect", d);
}

// setSqliteTypes switches how SQLite renders the types it has no storage class
// for. Like setDialect this is a real mutation — the saved bytes change — so it
// snapshots for undo and refreshes the SQL panel when it is open.
/** @param {string} mode */
export function setSqliteTypes(mode) {
	setSchemaField("sqliteTypes", mode);
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
