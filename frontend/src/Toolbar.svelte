<script>
import { DIALECTS, isSaveable } from "./erd.js";
import {
	addTable,
	copyInserts,
	copySql,
	deleteFile,
	exportDdl,
	newFile,
	openFile,
	saveCurrent,
	setDialect,
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

<header>
	<button onclick={addTable}>+ Table</button>
	<select
		class="dialect"
		value={store.currentFile}
		onchange={(e) => openFile(e.currentTarget.value)}
		title="open schema file"
	>
		<option value="">— files —</option>
		{#each store.files as f (f.name)}<option value={f.name}>{f.name}</option>{/each}
	</select>
	<button onclick={newFile}>New</button>
	<button onclick={() => saveCurrent()} disabled={!store.currentFile}>Save</button>
	<button onclick={deleteFile} disabled={!store.currentFile}>Del</button>
	<button onclick={copySql}>Copy SQL</button>
	<button onclick={copyInserts}>Copy INSERTs</button>
	<select
		class="dialect"
		value={store.schema.dialect}
		onchange={(e) => setDialect(e.currentTarget.value)}
		title="DDL dialect (saved files, SQL panel, and export)"
		data-testid="dialect"
	>
		{#each DIALECTS as d (d)}
			<option value={d}>{LABELS[d]}{isSaveable(d) ? "" : " (export only)"}</option>
		{/each}
	</select>
	<button onclick={exportDdl} disabled={store.exporting}>
		{store.exporting ? "..." : "Export"}
	</button>
	<button onclick={onToggleSql}>{showSql ? "Hide" : "Show"} SQL</button>
	{#if store.currentFile}
		<span class="ok" data-testid="current-file">{store.currentFile}</span>
	{/if}
	{#if store.error}<span class={store.errorKind}>{store.error}</span>{/if}
	{#if store.lint.length && !store.error}
		<span class="warn">lint: {store.lint.join("; ")}</span>
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
</style>