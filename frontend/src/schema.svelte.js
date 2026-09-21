// schema.svelte.js — shared reactive store: model state, mutations, undo,
// persistence, server round-trips. Grammar/DDL still lives in Go; this module
// owns the client model and the fetch() boundaries.
// Single exported $state object: Svelte forbids exporting a $state binding
// that is reassigned, so all state lives on `store` and mutations assign
// properties (allowed) — never the exported binding itself.

import { downloadBlob, downloadText, execCopy } from "./download.js";
import {
	adoptIds,
	cloneTable,
	DEFAULT_DIALECT,
	DEFAULT_SQLITE_TYPES,
	DEFAULT_TYPE,
	isInt,
	layout,
	newColumn,
	newSchema,
	newTable,
	uniqName,
} from "./erd.js";
import { stackStep } from "./geometry.js";
import {
	clearHistory,
	snap as snapHistory,
	undo as undoHistory,
} from "./history.js";

// ---- state ----
export const store = $state({
	currentFile: "", // "name.sql" | "" (unsaved scratch)
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
});
layout(store.schema);

// ---- server round-trips (debounced; local-first, banner on error) ----
async function refreshLint() {
	try {
		const res = await fetch("/api/lint", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ schema: store.schema }),
		});
		store.lint = res.ok ? await res.json() : [];
	} catch {
		store.lint = [];
	}
}
export async function refreshSql() {
	try {
		const res = await fetch("/export", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			// The panel shows the schema's own dialect, so it always agrees with
			// the dropdown and with what Save writes. It used to hardcode mysql,
			// which contradicted a dropdown reading "PostgreSQL".
			body: JSON.stringify({
				dialect: store.schema.dialect,
				schema: store.schema,
			}),
		});
		if (res.ok) store.sqlText = await res.text();
	} catch {
		/* keep last good text */
	}
}

// Wired from App's $effect (which tracks schema deep state + the local
// showSql flag): debounce fan-out — lint 300ms, autosave 800ms, SQL 300ms.
// skipTouch: set right before openFile/newFile swap store.schema; the App
// $effect fires once on the swap — that is a load, not a user edit, so it must
// not mark the file dirty or schedule a needless save.
import {
	clearTimers as clearTimersImpl,
	flushCurrent as flushAutosave,
	installFlush,
	markSkipTouch,
	setDirty,
	touch as touchAutosave,
} from "./autosave.js";

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
function clearTimers() {
	clearTimersImpl();
}
async function flushCurrent() {
	await flushAutosave({ store, saveCurrent });
}
// Unload safety: a pending saveTimer dies with the page, dropping up to 800ms
// of edits. Flush best-effort on the way out.
// ponytail: plain fetch may abort mid-unload; keepalive fetch (64KB cap) would
// harden the final write — add if real tab-closes drop edits.
installFlush(() => flushCurrent());

// ---- model mutations ----
// Names come from erd.js's uniqName (pure + unit-tested); it needs the taken
// set passed in, since it has no access to the store.
const takenNames = () => store.schema.tables.map((t) => t.name);
export function addTable() {
	snap();
	// Place the new card one full stack step below the lowest existing card,
	// using the same arithmetic layout() uses. This was a bare `+36` with no
	// derivation; it agreed with layout()'s `24 + GAP` only by coincidence
	// (24+12=36), and both understated the real card by 3px.
	const y = Math.max(
		40,
		...store.schema.tables.map((t) => t.y + stackStep(t.columns.length)),
	);
	store.schema.tables.push(
		Object.assign(newTable(uniqName("table1", takenNames())), { x: 40, y }),
	);
}
export function dupTable(t) {
	snap();
	const c = cloneTable(t);
	c.name = uniqName(`${t.name}_copy`, takenNames());
	c.x = t.x + 30;
	c.y = t.y + 30;
	store.schema.tables.push(c);
}
export function rmTable(t) {
	snap();
	store.schema.tables = store.schema.tables.filter((x) => x.id !== t.id);
	for (const o of store.schema.tables)
		for (const c of o.columns) if (c.ref?.tableId === t.id) c.ref = null;
	if (store.selected === t.id) store.selected = null;
}
export function rmColumn(t, c) {
	if (t.columns.length === 1) {
		flash(`${t.name} needs at least one column`, "err");
		return;
	} // empty table = invalid DDL
	snap();
	t.columns = t.columns.filter((x) => x.id !== c.id);
}
export function addColumn(t) {
	snap();
	t.columns.push(newColumn());
}
export function commitTableName(t, ev) {
	const v = ev.target.value.trim();
	if (v && !store.schema.tables.some((x) => x !== t && x.name === v)) {
		snap();
		t.name = v;
	} else ev.target.value = t.name;
	flashLint();
}
export function commitColName(c, ev) {
	const v = ev.target.value.trim();
	if (v) {
		snap();
		c.name = v;
	} else ev.target.value = c.name;
}
// Comments accept empty (clearing one is legitimate), unlike names.
export function commitComment(c, ev) {
	snap();
	c.comment = ev.target.value.trim();
}
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
	flashLint();
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
export function toggleArray(c) {
	snap();
	c.type = c.type.endsWith("[]") ? c.type.slice(0, -2) : `${c.type}[]`;
	// An array column cannot be an identity column or a primary key, so those
	// flags are cleared rather than left set for the server to reject.
	if (c.type.endsWith("[]")) {
		c.ai = false;
		c.pk = false;
	}
	flashLint();
}
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
	flashLint();
}
export function setRefAction(c, ev) {
	snap();
	c.ref.action = ev.target.value;
}
// setRefOnUpdate sets ON UPDATE. Unlike setRefAction there is no default: the
// empty option means "omit the clause" and is stored as "", because a schema
// written before this field existed carries no ON UPDATE and must keep emitting
// none. See the Ref comment in grammar.go for why the two actions differ.
export function setRefOnUpdate(c, ev) {
	snap();
	c.ref.onUpdate = ev.target.value;
}
export function togglePk(c) {
	snap();
	c.pk = !c.pk;
	if (c.pk) c.nn = true;
	flashLint();
}

// toggleFlag flips one of a column's boolean flags (nn/ux/ai/ix). Lives here
// with the other mutations so every undo snapshot is taken in one place —
// TableCard used to inline snap() plus the flip four times.
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
function ensureIndexes(t) {
	if (!Array.isArray(t.indexes)) t.indexes = [];
	return t.indexes;
}

// addIndex creates a composite index over the named columns. Duplicates are
// dropped: the same column twice in one index is almost certainly a mis-click,
// and the server's validation would accept it while the DDL it produces is
// useless.
export function addIndex(t, cols) {
	const unique = [...new Set(cols.filter(Boolean))];
	if (unique.length < 2) {
		flash("pick at least two columns for a composite index", "err");
		return;
	}
	snap();
	ensureIndexes(t).push({ cols: unique });
}

export function rmIndex(t, ix) {
	snap();
	const list = ensureIndexes(t);
	const i = list.indexOf(ix);
	if (i >= 0) list.splice(i, 1);
}

// setIndexName sets an explicit name. Empty clears it back to the derived
// idx_<table>_<cols> form, which is the default and needs no UI. No table
// parameter: the name lives on the index itself, so only the index is needed.
export function setIndexName(ix, name) {
	snap();
	ix.name = name.trim();
}

// toggleIndexCol adds or removes one column from an existing composite index.
// Refuses to drop below two columns: a one-column index is Col.Ix, and letting
// it become one here would emit the same DDL two different ways depending on
// how it was created. Takes only the index for the same reason as setIndexName.
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

export function flash(msg, kind = "ok") {
	store.error = msg;
	store.errorKind = kind;
	setTimeout(() => {
		if (store.error === msg) store.error = "";
	}, 1400);
}
export function setSelected(id) {
	store.selected = id;
}
// setDialect switches the schema's grammar. It is a real mutation (the saved
// bytes change), so it snapshots for undo and refreshes the SQL panel when it
// is open — previously the panel kept showing the old dialect because nothing
// reacted to the change.
export function setDialect(d) {
	if (store.schema.dialect === d) return;
	snap();
	store.schema.dialect = d;
	if (store.sqlText) refreshSql();
}

// setSqliteTypes switches how SQLite renders the types it has no storage class
// for. Like setDialect this is a real mutation — the saved bytes change — so it
// snapshots for undo and refreshes the SQL panel when it is open.
export function setSqliteTypes(mode) {
	if (store.schema.sqliteTypes === mode) return;
	snap();
	store.schema.sqliteTypes = mode;
	if (store.sqlText) refreshSql();
}
function flashLint() {
	refreshLint().then(() => {
		if (store.lint.length) flash(`lint: ${store.lint.join("; ")}`, "warn");
	});
}

// ---- file store (Go working dir) ----
async function refreshFiles() {
	try {
		const res = await fetch("/api/files");
		store.files = res.ok ? await res.json() : [];
	} catch {
		store.files = [];
	}
}
refreshFiles().then(() => {
	if (!store.files.length) return;
	const newest = store.files.reduce((a, b) => (b.mtime > a.mtime ? b : a));
	openFile(newest.name);
});

export async function openFile(name) {
	if (!name) return;
	await flushCurrent();
	try {
		const res = await fetch(`/api/files/${encodeURIComponent(name)}`);
		if (!res.ok) throw new Error(await res.text());
		markSkipTouch();
		const loaded = await res.json();
		// The server always sets dialect (both parsers do), but default rather
		// than leave the dropdown blank if an older payload omits it. Same for
		// sqliteTypes: absent means the lossless default, and every file written
		// before the setting existed has it absent.
		if (!loaded.dialect) loaded.dialect = DEFAULT_DIALECT;
		if (!loaded.sqliteTypes) loaded.sqliteTypes = DEFAULT_SQLITE_TYPES;
		store.schema = adoptIds(loaded);
		layout(store.schema);
		store.currentFile = name;
		store.error = "";
		setDirty(false);
		// Snapshots belong to the file they were taken in. Carrying them across a
		// switch lets Ctrl+Z restore file A's schema while currentFile is B — and
		// the App $effect would then autosave A's tables into B.sql (data loss).
		clearHistory();
	} catch (e) {
		flash(`Open failed: ${e.message}`, "err");
		refreshFiles();
	}
}
export async function newFile() {
	const name = (prompt("New schema file name:", "schema") || "")
		.trim()
		.replace(/\.sql$/i, "");
	if (!name) return;
	if (store.files.some((f) => f.name === `${name}.sql`)) {
		flash(`${name}.sql already exists`, "err");
		return;
	}
	await flushCurrent();
	markSkipTouch();
	// Keep the dialect the user is currently working in — switching to postgres
	// and then hitting New should give a postgres file, not silently reset.
	store.schema = newSchema(store.schema.dialect, [newTable("users")]);
	layout(store.schema);
	store.currentFile = `${name}.sql`;
	clearHistory(); // new file context → prior snapshots are unreachable
	await saveCurrent();
	refreshFiles();
}
export async function saveCurrent(silent = false) {
	if (!store.currentFile) {
		flash("no file selected — use New", "err");
		return;
	}
	try {
		const res = await fetch(
			`/api/files/${encodeURIComponent(store.currentFile)}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(store.schema),
			},
		);
		if (!res.ok) throw new Error(await res.text());
		setDirty(false);
		if (!silent) flash(`saved ${store.currentFile}`);
	} catch (e) {
		if (!silent) flash(`save failed: ${e.message}`, "err");
	}
}
export async function deleteFile() {
	if (!store.currentFile) return;
	if (!confirm(`Delete ${store.currentFile}?`)) return;
	clearTimers(); // pending autosave targets a file about to vanish
	const res = await fetch(
		`/api/files/${encodeURIComponent(store.currentFile)}`,
		{
			method: "DELETE",
		},
	);
	if (!res.ok) flash(`delete failed: ${await res.text()}`, "err");
	else flash(`deleted ${store.currentFile}`);
	store.currentFile = "";
	clearHistory(); // the file these snapshots described no longer exists
	refreshFiles();
}

// ---- clipboard + exports ----
async function copyText(text, msg) {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		if (!execCopy(text)) {
			flash("clipboard blocked — copy failed", "err");
			return;
		}
	}
	flash(msg);
}
export async function copyInserts() {
	try {
		const res = await fetch("/api/inserts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ schema: store.schema }),
		});
		if (!res.ok) throw new Error(await res.text());
		await copyText(await res.text(), "copied INSERT templates");
	} catch (e) {
		flash(`INSERTs failed: ${e.message}`, "err");
	}
}
export async function copySql() {
	await refreshSql();
	await copyText(store.sqlText, "copied SQL");
}
// The name to save under. A loaded file keeps its own name (users.sql stays
// users.sql); an unsaved scratch schema gets a name that says which grammar it
// is in, since that is the one thing the bytes do not state up front.
export function exportFilename() {
	return store.currentFile || `${store.schema.dialect}-schema.sql`;
}
export async function exportDdl() {
	store.exporting = true;
	try {
		const res = await fetch("/export", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				dialect: store.schema.dialect,
				schema: store.schema,
			}),
		});
		if (!res.ok) throw new Error(await res.text());
		const name = exportFilename();
		downloadText(await res.text(), name);
		flash(`downloaded ${name}`);
	} catch (e) {
		flash(`export failed: ${e.message}`, "err");
	} finally {
		store.exporting = false;
	}
}
export async function exportPng() {
	if (!store.schema.tables.length) {
		flash("nothing to export — add a table first", "err");
		return;
	}
	store.exporting = true;
	try {
		// The store owns the DOM lookup and the schema; capture.js is handed
		// both so it stays free of ambient document/store access and can be
		// driven with a plain element in tests.
		const el = document.querySelector(".canvas");
		const { capturePng, pngFilename } = await import("./capture.js");
		const blob = await capturePng(el, store.schema);
		const name = pngFilename(store.currentFile, store.schema.dialect);
		downloadBlob(blob, name);
		flash(`downloaded ${name}`);
	} catch (e) {
		flash(`png export failed: ${e.message}`, "err");
	} finally {
		store.exporting = false;
	}
}
// exportSvg is the vector twin of exportPng: same sizing, same empty-schema
// guard, same filename rule with a .svg extension. It exists alongside PNG
// rather than replacing it because the two answer different needs — SVG for
// docs and slides where the diagram is rescaled, PNG where a bitmap is
// required. The SVG is written as text, not as a data URL: see decodeSvgDataUrl.
export async function exportSvg() {
	if (!store.schema.tables.length) {
		flash("nothing to export — add a table first", "err");
		return;
	}
	store.exporting = true;
	try {
		const el = document.querySelector(".canvas");
		const { captureSvg, svgFilename } = await import("./capture.js");
		const svg = await captureSvg(el, store.schema);
		const name = svgFilename(store.currentFile, store.schema.dialect);
		// downloadText already sets a text charset; an SVG is XML, so it is
		// passed through as-is with the .svg extension as the type signal.
		downloadText(svg, name);
		flash(`downloaded ${name}`);
	} catch (e) {
		flash(`svg export failed: ${e.message}`, "err");
	} finally {
		store.exporting = false;
	}
}
