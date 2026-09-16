<script>
import {
	adoptIds,
	baseType,
	cloneTable,
	DEFAULT_TYPE,
	isInt,
	layout,
	newColumn,
	newTable,
	TYPES,
} from "./erd.js";
import { edgePaths, HDR_H, ROW_H } from "./geometry.js";

let currentFile = $state(""); // "name.sql" | "" (unsaved scratch)
let files = $state([]); // [{name, mtime}]
let schema = $state({ tables: [newTable("users")] });
layout(schema);
let showSql = $state(false);
let sqlText = $state("");
let error = $state("");
let errorKind = $state("err");
let drag = $state(null);
let selected = $state(null);
let history = [];
let lint = $state([]);
let dialect = $state("postgres");
let exporting = $state(false);
let dirty = false;

const actions = ["CASCADE", "RESTRICT", "SET NULL", "NO ACTION"];

// ---- server round-trips (debounced; local-first, banner on error) ----
let lintTimer, saveTimer, sqlTimer;
$effect(() => {
	const json = JSON.stringify(schema);
	lintTimer ??= setTimeout(() => {
		lintTimer = null;
		refreshLint();
	}, 300);
	if (dirty && currentFile) {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => saveCurrent(true), 800);
	}
	dirty = true;
	if (showSql) {
		clearTimeout(sqlTimer);
		sqlTimer = setTimeout(() => refreshSql(), 300);
	}
	void json;
});

async function refreshLint() {
	try {
		const res = await fetch("/api/lint", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ schema }),
		});
		lint = res.ok ? await res.json() : [];
	} catch {
		lint = [];
	}
}
async function refreshSql() {
	try {
		const res = await fetch("/export", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ dialect: "mysql", schema }),
		});
		if (res.ok) sqlText = await res.text();
	} catch {
		/* keep last good text */
	}
}

function snap() {
	history.push(JSON.stringify(schema));
	if (history.length > 60) history.shift();
}
function undo() {
	if (!history.length) return;
	try {
		schema = adoptIds(JSON.parse(history.pop()));
		selected = null;
	} catch {
		undo(); // snapshot can only be our own stringify; corrupt → drop it
	}
}

function uniqName(base) {
	let n = base,
		i = 1;
	while (schema.tables.some((t) => t.name === n)) n = base + ++i;
	return n;
}
function addTable() {
	snap();
	const y = Math.max(
		40,
		...schema.tables.map((t) => t.y + HDR_H + t.columns.length * ROW_H + 36),
	);
	schema.tables.push(Object.assign(newTable(uniqName("table1")), { x: 40, y }));
}
function dupTable(t) {
	snap();
	const c = cloneTable(t);
	c.name = uniqName(t.name + "_copy");
	c.x = t.x + 30;
	c.y = t.y + 30;
	schema.tables.push(c);
}
function rmTable(t) {
	snap();
	schema.tables = schema.tables.filter((x) => x.id !== t.id);
	for (const o of schema.tables)
		for (const c of o.columns) if (c.ref?.tableId === t.id) c.ref = null;
	if (selected === t.id) selected = null;
}
function rmColumn(t, c) {
	if (t.columns.length === 1) {
		flash(`${t.name} needs at least one column`, "err");
		return;
	} // empty table = invalid DDL
	snap();
	t.columns = t.columns.filter((x) => x.id !== c.id);
}
function addColumn(t) {
	snap();
	t.columns.push(newColumn());
}

function flash(msg, kind = "ok") {
	error = msg;
	errorKind = kind;
	setTimeout(() => {
		if (error === msg) error = "";
	}, 1400);
}
function flashLint() {
	refreshLint().then(() => {
		if (lint.length) flash("lint: " + lint.join("; "), "warn");
	});
}

function commitTableName(t, ev) {
	const v = ev.target.value.trim();
	if (v && !schema.tables.some((x) => x !== t && x.name === v)) {
		snap();
		t.name = v;
	} else ev.target.value = t.name;
	flashLint();
}
function commitColName(c, ev) {
	const v = ev.target.value.trim();
	if (v) {
		snap();
		c.name = v;
	} else ev.target.value = c.name;
}
function setType(c, base) {
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
					return /^'(.*)'$/.test(v) ? v : "'" + v.replace(/'/g, "") + "'";
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
function setRef(c, ev) {
	snap();
	const id = ev.target.value;
	c.ref = id ? { tableId: id, action: c.ref?.action ?? "CASCADE" } : null;
	if (id) c.ai = false;
	flashLint();
}
function setRefAction(c, ev) {
	snap();
	c.ref.action = ev.target.value;
}
function togglePk(c) {
	snap();
	c.pk = !c.pk;
	if (c.pk) c.nn = true;
	flashLint();
}

function startDrag(t, ev) {
	selected = t.id;
	drag = { id: t.id, ox: ev.clientX - t.x, oy: ev.clientY - t.y };
	ev.preventDefault();
}
function onMove(ev) {
	if (!drag) return;
	const t = schema.tables.find((x) => x.id === drag.id);
	if (t) {
		t.x = Math.max(0, ev.clientX - drag.ox - 8);
		t.y = Math.max(0, ev.clientY - drag.oy - 44);
	}
}
function onUp() {
	drag = null;
}
function onKey(ev) {
	const tag = document.activeElement?.tagName;
	const editing = /INPUT|SELECT|TEXTAREA/.test(tag);
	if ((ev.key === "Delete" || ev.key === "Backspace") && !editing) {
		const t = schema.tables.find((x) => x.id === selected);
		if (t) rmTable(t);
	} else if ((ev.ctrlKey || ev.metaKey) && ev.key === "z" && !editing) {
		ev.preventDefault();
		undo();
	} else if (ev.key === "Escape") selected = null;
}

const edges = $derived(edgePaths(schema));

// ---- file store (Go working dir) ----
async function refreshFiles() {
	try {
		const res = await fetch("/api/files");
		files = res.ok ? await res.json() : [];
	} catch {
		files = [];
	}
}
refreshFiles().then(() => {
	if (!files.length) return;
	const newest = files.reduce((a, b) => (b.mtime > a.mtime ? b : a));
	openFile(newest.name);
});

async function openFile(name) {
	if (!name) return;
	try {
		const res = await fetch("/api/files/" + encodeURIComponent(name));
		if (!res.ok) throw new Error(await res.text());
		snap();
		schema = adoptIds(await res.json());
		layout(schema);
		currentFile = name;
		error = "";
		dirty = false;
	} catch (e) {
		flash("Open failed: " + e.message, "err");
		refreshFiles();
	}
}
async function newFile() {
	const name = (prompt("New schema file name:", "schema") || "")
		.trim()
		.replace(/\.sql$/i, "");
	if (!name) return;
	if (files.some((f) => f.name === name + ".sql")) {
		flash(name + ".sql already exists", "err");
		return;
	}
	snap();
	schema = { tables: [newTable("users")] };
	layout(schema);
	currentFile = name + ".sql";
	await saveCurrent();
	refreshFiles();
}
async function saveCurrent(silent = false) {
	if (!currentFile) {
		flash("no file selected — use New", "err");
		return;
	}
	try {
		const res = await fetch("/api/files/" + encodeURIComponent(currentFile), {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(schema),
		});
		if (!res.ok) throw new Error(await res.text());
		dirty = false;
		if (!silent) flash("saved " + currentFile);
	} catch (e) {
		if (!silent) flash("save failed: " + e.message, "err");
	}
}
async function deleteFile() {
	if (!currentFile) return;
	if (!confirm("Delete " + currentFile + "?")) return;
	const res = await fetch("/api/files/" + encodeURIComponent(currentFile), {
		method: "DELETE",
	});
	if (!res.ok) flash("delete failed: " + (await res.text()), "err");
	else flash("deleted " + currentFile);
	currentFile = "";
	refreshFiles();
}
async function copyText(text, msg) {
	try {
		await navigator.clipboard.writeText(text);
		flash(msg);
	} catch {
		flash("clipboard blocked", "err");
	}
}
async function copyInserts() {
	try {
		const res = await fetch("/api/inserts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ schema }),
		});
		if (!res.ok) throw new Error(await res.text());
		await copyText(await res.text(), "copied INSERT templates");
	} catch (e) {
		flash("INSERTs failed: " + e.message, "err");
	}
}
async function copySql() {
	await refreshSql();
	await copyText(sqlText, "copied SQL");
}

async function exportDdl() {
	exporting = true;
	try {
		const res = await fetch("/export", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ dialect, schema }),
		});
		if (!res.ok) throw new Error(await res.text());
		await copyText(await res.text(), `copied ${dialect} DDL`);
	} catch (e) {
		flash("export failed: " + e.message, "err");
	} finally {
		exporting = false;
	}
}
</script>

<svelte:window onpointermove={onMove} onpointerup={onUp} onkeydown={onKey} />

<header>
  <button onclick={addTable}>+ Table</button>
  <select class="dialect" value={currentFile} onchange={(e) => openFile(e.target.value)} title="open schema file">
    <option value="">— files —</option>
    {#each files as f (f.name)}<option value={f.name}>{f.name}</option>{/each}
  </select>
  <button onclick={newFile}>New</button>
  <button onclick={() => saveCurrent()} disabled={!currentFile}>Save</button>
  <button onclick={deleteFile} disabled={!currentFile}>Del</button>
  <button onclick={copySql}>Copy SQL</button>
  <button onclick={copyInserts}>Copy INSERTs</button>
  <select class="dialect" bind:value={dialect}>
    <option value="mysql">MySQL</option>
    <option value="mariadb">MariaDB</option>
    <option value="postgres">PostgreSQL</option>
    <option value="sqlite">SQLite</option>
  </select>
  <button onclick={exportDdl} disabled={exporting}>{exporting ? "..." : "Export"}</button>
  <button onclick={() => { showSql = !showSql; if (showSql) refreshSql(); }}>{showSql ? "Hide" : "Show"} SQL</button>
  {#if currentFile}<span class="ok">{currentFile}</span>{/if}
  {#if error}<span class={errorKind}>{error}</span>{/if}
  {#if lint.length && !error}<span class="warn">lint: {lint.join("; ")}</span>{/if}
</header>

<main>
  <div class="canvas" class:dragging={!!drag}>
    <svg>
      <defs>
        <marker id="crow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10" fill="none" stroke="#888" />
        </marker>
      </defs>
      {#each edges as e}
        <path d={e.d} class={e.self ? "edge self" : "edge"} marker-end="url(#crow)" />
      {/each}
    </svg>
    {#each schema.tables as t (t.id)}
      <section class="table" class:selected={selected === t.id} style="left:{t.x}px; top:{t.y}px">
        <div class="hdr" onpointerdown={(e) => !e.target.matches("button,input") && startDrag(t, e)}>
          <input class="tname" value={t.name} onchange={(e) => commitTableName(t, e)} spellcheck="false" />
          <button title="duplicate" onclick={() => dupTable(t)}>⧉</button>
          <button title="delete table (Del)" onclick={() => rmTable(t)}>×</button>
        </div>
        {#each t.columns as c (c.id)}
          <div class="row">
            <input class="cname" class:pk={c.pk} value={c.name} onchange={(e) => commitColName(c, e)} spellcheck="false" />
            <select value={baseType(c.type)} onchange={(e) => setType(c, e.target.value)}>
              {#each TYPES as ty}<option value={ty}>{ty}</option>{/each}
            </select>
            <label title="primary key"><input type="checkbox" checked={c.pk} onchange={() => togglePk(c)} />PK</label>
            <label title="not null"><input type="checkbox" checked={c.nn || c.pk} disabled={c.pk} onchange={() => { snap(); c.nn = !c.nn; }} />NN</label>
            <label title="unique"><input type="checkbox" checked={c.ux} onchange={() => { snap(); c.ux = !c.ux; }} />UQ</label>
            <label title="auto increment"><input type="checkbox" checked={c.ai} disabled={!isInt(c.type)} onchange={() => { snap(); c.ai = !c.ai; }} />AI</label>
            <label title="index"><input type="checkbox" checked={c.ix} onchange={() => { snap(); c.ix = !c.ix; }} />IX</label>
            <select class="fk" value={c.ref?.tableId ?? ""} onchange={(e) => setRef(c, e)}>
              <option value="">FK→</option>
              {#each schema.tables.filter((x) => x.id !== t.id) as p (p.id)}
                <option value={p.id}>{p.name}</option>
              {/each}
            </select>
            {#if c.ref}
              <select class="act" value={c.ref.action ?? "CASCADE"} onchange={(e) => setRefAction(c, e)} title="ON DELETE">
                {#each actions as a}<option value={a}>{a}</option>{/each}
              </select>
            {/if}
            <button title="remove column" class="rmcol" onclick={() => rmColumn(t, c)}>–</button>
          </div>
          <div class="cmt">
            <input placeholder="comment" value={c.comment} onchange={(e) => { snap(); c.comment = e.target.value.trim(); }} spellcheck="false" />
          </div>
        {/each}
        <button class="addcol" onclick={() => addColumn(t)}>+ column</button>
      </section>
    {/each}
  </div>

  {#if showSql}
    <aside>
      <div class="sqlhead">
        <span>{currentFile || "unsaved"}</span>
        <button onclick={copySql}>copy</button>
      </div>
      <pre>{sqlText}</pre>
    </aside>
  {/if}
</main>

<style>
  :global(body) { margin: 0; font: 13px system-ui, sans-serif; background: #101418; color: #d8dee6; }
  header { display: flex; gap: 8px; align-items: center; padding: 8px 12px; background: #1a2028; border-bottom: 1px solid #2a3340; position: sticky; top: 0; z-index: 5; flex-wrap: wrap; }
  header button, header .btn { background: #2b6cb0; color: #fff; border: 0; border-radius: 5px; padding: 6px 12px; cursor: pointer; font: inherit; }
  header button:disabled { background: #3b4654; color: #778; cursor: default; }
  .hiddenfile { display: none; }
  header select.dialect { background: #101418; color: #d8dee6; border: 1px solid #3b4654; border-radius: 5px; padding: 5px 6px; font: inherit; }
  .err { color: #f87171; }
  .ok { color: #4ade80; }
  .warn { color: #fbbf24; }
  main { display: flex; height: calc(100vh - 41px); }
  .canvas { position: relative; flex: 1; overflow: auto; background: radial-gradient(#232b35 1px, transparent 1px); background-size: 20px 20px; }
  .canvas.dragging { user-select: none; cursor: grabbing; }
  .canvas svg { position: absolute; inset: 0; width: 200%; height: 200%; pointer-events: none; }
  .edge { fill: none; stroke: #888; stroke-width: 1.5; }
  .self { stroke: #bb5588; }
  section.table { position: absolute; width: 280px; background: #1a2028; border: 1px solid #3b4654; border-radius: 6px; box-shadow: 0 2px 8px #0008; }
  section.selected { border-color: #63b3ed; }
  .hdr { display: flex; background: #2b6cb0; border-radius: 5px 5px 0 0; cursor: grab; }
  .tname { flex: 1; background: transparent; border: 0; color: #fff; font-weight: 600; font-size: 13px; padding: 5px 8px; outline: none; }
  .row { display: flex; align-items: center; gap: 2px; padding: 1px 3px; height: 26px; }
  .row:hover { background: #232b35; }
  input.cname { width: 62px; background: transparent; border: 0; color: #d8dee6; font: inherit; outline: none; }
  input.cname.pk { color: #fbbf24; font-weight: 600; }
  .row select { background: #101418; color: #9fb0c0; border: 0; font: 10px ui-monospace, monospace; }
  .row select.fk { width: 62px; }
  .row select.act { width: 58px; }
  .row label { font-size: 9px; color: #9fb0c0; display: flex; gap: 1px; align-items: center; }
  .row label input { width: 10px; height: 10px; margin: 0; }
  .rmcol, .hdr button { background: transparent; color: #778; border: 0; cursor: pointer; font-size: 13px; }
  .rmcol:hover, .hdr button:hover { color: #f87171; }
  .cmt input { width: calc(100% - 10px); margin: 0 3px; background: transparent; border: 0; border-bottom: 1px dotted #2a3340; color: #7fa3c0; font: italic 10px system-ui, sans-serif; outline: none; }
  .cmt input::placeholder { color: #4a5a68; }
  .addcol { width: 100%; background: transparent; color: #66bb88; border: 0; border-top: 1px dashed #3b4654; padding: 3px; cursor: pointer; font: inherit; }
  aside { width: 420px; border-left: 1px solid #2a3340; display: flex; flex-direction: column; }
  .sqlhead { display: flex; gap: 4px; align-items: center; padding: 6px 8px; background: #1a2028; }
  .sqlhead button { margin-left: auto; }
  aside pre { flex: 1; margin: 0; padding: 12px; overflow: auto; font: 12px/1.5 ui-monospace, monospace; color: #a5d6ff; white-space: pre-wrap; }
</style>
