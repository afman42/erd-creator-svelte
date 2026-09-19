// schema.svelte.js — shared reactive store: model state, mutations, undo,
// persistence, server round-trips. Grammar/DDL still lives in Go; this module
// owns the client model and the fetch() boundaries.
// Single exported $state object: Svelte forbids exporting a $state binding
// that is reassigned, so all state lives on `store` and mutations assign
// properties (allowed) — never the exported binding itself.
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

const history = [];
let dirty = false;
let lintTimer, saveTimer, sqlTimer;

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
let skipTouch = false;
export function touch(showSql) {
	if (skipTouch) {
		skipTouch = false;
		return;
	}
	lintTimer ??= setTimeout(() => {
		lintTimer = null;
		refreshLint();
	}, 300);
	// Schedule on every real edit, first one included — a fresh file is not
	// dirty until the first touch, but its first edit must still persist.
	if (store.currentFile) {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => saveCurrent(true), 800);
	}
	dirty = true;
	if (showSql) {
		clearTimeout(sqlTimer);
		sqlTimer = setTimeout(() => refreshSql(), 300);
	}
}

// ---- undo (client-only, JSON snapshots) ----
export function snap() {
	history.push(JSON.stringify(store.schema));
	if (history.length > 60) history.shift();
}
export function undo() {
	if (!history.length) return;
	try {
		store.schema = adoptIds(JSON.parse(history.pop()));
		store.selected = null;
	} catch {
		undo(); // snapshot can only be our own stringify; corrupt → drop it
	}
}

// ---- timers / flush ----
function clearTimers() {
	if (lintTimer) {
		clearTimeout(lintTimer);
		lintTimer = null;
	}
	clearTimeout(saveTimer);
	clearTimeout(sqlTimer);
}
// Flush pending debounced writes for the current file before any switch —
// a pending saveTimer would otherwise fire against the NEXT file (or drop).
async function flushCurrent() {
	clearTimers();
	if (dirty && store.currentFile) {
		try {
			await saveCurrent(true);
		} catch {
			// saveCurrent flashes itself; the edit is now only in memory
		}
	}
}
// Unload safety: a pending saveTimer dies with the page, dropping up to 800ms
// of edits. Flush best-effort on the way out.
// ponytail: plain fetch may abort mid-unload; keepalive fetch (64KB cap) would
// harden the final write — add if real tab-closes drop edits.
window.addEventListener("pagehide", () => void flushCurrent());
window.addEventListener("beforeunload", () => void flushCurrent());

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
export function setRef(c, ev) {
	snap();
	const id = ev.target.value;
	c.ref = id ? { tableId: id, action: c.ref?.action ?? "CASCADE" } : null;
	if (id) c.ai = false;
	flashLint();
}
export function setRefAction(c, ev) {
	snap();
	c.ref.action = ev.target.value;
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
		skipTouch = true;
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
		dirty = false;
		// Snapshots belong to the file they were taken in. Carrying them across a
		// switch lets Ctrl+Z restore file A's schema while currentFile is B — and
		// the App $effect would then autosave A's tables into B.sql (data loss).
		history.length = 0;
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
	skipTouch = true;
	// Keep the dialect the user is currently working in — switching to postgres
	// and then hitting New should give a postgres file, not silently reset.
	store.schema = newSchema(store.schema.dialect, [newTable("users")]);
	layout(store.schema);
	store.currentFile = `${name}.sql`;
	history.length = 0; // new file context → prior snapshots are unreachable
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
		dirty = false;
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
	history.length = 0; // the file these snapshots described no longer exists
	refreshFiles();
}

// ---- clipboard + exports ----
function execCopy(text) {
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.style.cssText = "position:fixed;opacity:0";
	document.body.appendChild(ta);
	ta.select();
	try {
		return document.execCommand("copy");
	} finally {
		ta.remove();
	}
}
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
		await copyText(await res.text(), `copied ${store.schema.dialect} DDL`);
	} catch (e) {
		flash(`export failed: ${e.message}`, "err");
	} finally {
		store.exporting = false;
	}
}
