// schema.svelte.js — shared reactive store: model state, mutations, undo,
// persistence, server round-trips. Grammar/DDL still lives in Go; this module
// owns the client model and the fetch() boundaries.
// Single exported $state object: Svelte forbids exporting a $state binding
// that is reassigned, so all state lives on `store` and mutations assign
// properties (allowed) — never the exported binding itself.
import {
	adoptIds,
	cloneTable,
	DEFAULT_TYPE,
	isInt,
	layout,
	newColumn,
	newTable,
} from "./erd.js";
import { HDR_H, ROW_H } from "./geometry.js";

// ---- state ----
export const store = $state({
	currentFile: "", // "name.sql" | "" (unsaved scratch)
	files: [], // [{name, mtime}]
	schema: { tables: [newTable("users")] },
	sqlText: "",
	error: "",
	errorKind: "err",
	selected: null,
	lint: [],
	dialect: "postgres",
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
			body: JSON.stringify({ dialect: "mysql", schema: store.schema }),
		});
		if (res.ok) store.sqlText = await res.text();
	} catch {
		/* keep last good text */
	}
}

// Wired from App's $effect (which tracks schema deep state + the local
// showSql flag): debounce fan-out — lint 300ms, autosave 800ms, SQL 300ms.
export function touch(showSql) {
	lintTimer ??= setTimeout(() => {
		lintTimer = null;
		refreshLint();
	}, 300);
	if (dirty && store.currentFile) {
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

// ---- model mutations ----
function uniqName(base) {
	let n = base,
		i = 1;
	while (store.schema.tables.some((t) => t.name === n)) n = base + ++i;
	return n;
}
export function addTable() {
	snap();
	const y = Math.max(
		40,
		...store.schema.tables.map(
			(t) => t.y + HDR_H + t.columns.length * ROW_H + 36,
		),
	);
	store.schema.tables.push(
		Object.assign(newTable(uniqName("table1")), { x: 40, y }),
	);
}
export function dupTable(t) {
	snap();
	const c = cloneTable(t);
	c.name = uniqName(`${t.name}_copy`);
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
export function setDialect(d) {
	store.dialect = d;
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
		snap();
		store.schema = adoptIds(await res.json());
		layout(store.schema);
		store.currentFile = name;
		store.error = "";
		dirty = false;
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
	snap();
	store.schema = { tables: [newTable("users")] };
	layout(store.schema);
	store.currentFile = `${name}.sql`;
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
			body: JSON.stringify({ dialect: store.dialect, schema: store.schema }),
		});
		if (!res.ok) throw new Error(await res.text());
		await copyText(await res.text(), `copied ${store.dialect} DDL`);
	} catch (e) {
		flash(`export failed: ${e.message}`, "err");
	} finally {
		store.exporting = false;
	}
}
