<script>
import { DEFAULT_SQLITE_TYPES, DIALECTS, isSaveable } from "./erd.js";
import {
	addTable,
	copyInserts,
	copySql,
	deleteFile,
	exportDdl,
	exportPng,
	newFile,
	openFile,
	saveCurrent,
	setDialect,
	setSqliteTypes,
	store,
} from "./schema.svelte.js";

let { showSql, onToggleSql } = $props();

// Display names; the values are the server's dialect identifiers.
const LABELS = {
	mysql: "MySQL",
	mariadb: "MariaDB",
	postgres: "PostgreSQL",
	sqlite: "SQLite",
};
</script>

<header aria-label="ERD toolbar">
	<h1 class="sr-only">ERD Creator</h1>
	<button onclick={addTable} aria-label="+ Table">+ Table</button>
	<label class="sr-only" for="file-select">Open schema file</label>
	<select
		id="file-select"
		class="dialect"
		value={store.currentFile}
		onchange={(e) => openFile(e.currentTarget.value)}
		title="open schema file"
		aria-label="Open schema file"
	>
		<option value="">— files —</option>
		{#each store.files as f (f.name)}<option value={f.name}>{f.name}</option>{/each}
	</select>
	<button onclick={newFile} aria-label="New">New</button>
	<button onclick={() => saveCurrent()} disabled={!store.currentFile} aria-label="Save">Save</button>
	<button onclick={deleteFile} disabled={!store.currentFile} aria-label="Del">Del</button>
	<button onclick={copySql} aria-label="Copy SQL">Copy SQL</button>
	<button onclick={copyInserts} aria-label="Copy INSERTs">Copy INSERTs</button>
	<label class="sr-only" for="dialect-select">DDL dialect</label>
	<select
		id="dialect-select"
		class="dialect"
		value={store.schema.dialect}
		onchange={(e) => setDialect(e.currentTarget.value)}
		title="DDL dialect (saved files, SQL panel, and export)"
		aria-label="DDL dialect"
		data-testid="dialect"
	>
		{#each DIALECTS as d (d)}
			<option value={d}>{LABELS[d]}{isSaveable(d) ? "" : " (export only)"}</option>
		{/each}
	</select>
	{#if store.schema.dialect === "sqlite"}
		<!-- SQLite has no BOOLEAN/DATETIME storage class, so the declared type is
		     a real choice: keep the model's name (lossless) or write the storage
		     class it would pick anyway. Only shown for sqlite — it changes nothing
		     for the other dialects. -->
		<label class="sr-only" for="sqlite-types">SQLite types mode</label>
		<select
			id="sqlite-types"
			class="dialect"
			value={store.schema.sqliteTypes ?? DEFAULT_SQLITE_TYPES}
			onchange={(e) => setSqliteTypes(e.currentTarget.value)}
			title="how SQLite renders BOOLEAN / DATETIME / TIMESTAMP"
			aria-label="SQLite types mode"
			data-testid="sqlite-types"
		>
			<option value="native">types: native</option>
			<option value="portable">types: portable</option>
		</select>
	{/if}
	<button onclick={exportDdl} disabled={store.exporting} aria-label="Export">
		{store.exporting ? "..." : "Export"}
	</button>
	<button onclick={exportPng} disabled={store.exporting} aria-label="Export PNG">Export PNG</button>
	<button onclick={onToggleSql} aria-label="{showSql ? 'Hide' : 'Show'} SQL panel" aria-expanded={showSql} aria-controls="sql-panel">{showSql ? "Hide" : "Show"} SQL</button>
	{#if store.currentFile}
		<span class="ok" data-testid="current-file" role="status" aria-live="polite">{store.currentFile}</span>
	{/if}
	{#if store.error}<span class={store.errorKind} role={store.errorKind === 'err' ? 'alert' : 'status'} aria-live={store.errorKind === 'err' ? 'assertive' : 'polite'}>{store.error}</span>{/if}
	{#if store.lint.length && !store.error}
		<span class="warn" role="status" aria-live="polite">lint: {store.lint.join("; ")}</span>
	{/if}
</header>

<style>
	header {
		display: flex;
		gap: 8px;
		align-items: center;
		padding: 8px 12px;
		background: #1a2028;
		border-bottom: 1px solid #2a3340;
		position: sticky;
		top: 0;
		z-index: 5;
		flex-wrap: wrap;
	}
	header button,
	header .btn {
		background: #2b6cb0;
		color: #fff;
		border: 0;
		border-radius: 5px;
		padding: 6px 12px;
		cursor: pointer;
		font: inherit;
	}
	header button:disabled {
		background: #3b4654;
		color: #778;
		cursor: default;
	}
	header select.dialect {
		background: #101418;
		color: #d8dee6;
		border: 1px solid #3b4654;
		border-radius: 5px;
		padding: 5px 6px;
		font: inherit;
	}
	.err {
		color: #f87171;
	}
	.ok {
		color: #4ade80;
	}
	.warn {
		color: #fbbf24;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>