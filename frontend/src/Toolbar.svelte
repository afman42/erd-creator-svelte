<script>
import {
	DEFAULT_SQLITE_TYPES,
	DIALECTS,
	isSaveable,
	SQLITE_TYPES,
} from "./erd.js";
import {
	addTable,
	copyInserts,
	copySql,
	deleteFile,
	duplicateFile,
	exportDdl,
	exportPng,
	exportSvg,
	newFile,
	openFile,
	renameFile,
	saveCurrent,
	setDialect,
	setSqliteTypes,
	store,
	toggleTheme,
} from "./schema.svelte.js";

let { showSql, onToggleSql, onToggleRelationship, showLint, onToggleLint } =
	$props();

// Display names; the values are the server's dialect identifiers.
/** @type {Record<string, string>} */
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
	<button
		onclick={onToggleRelationship}
		disabled={store.schema.tables.length < 2}
		aria-label="+ Relationship"
		title="Create a 1:1, 1:N or N:N relationship between two tables"
	>+ Relationship</button>
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
	<button onclick={renameFile} disabled={!store.currentFile} aria-label="Rename file" title="Rename the current schema file">Rename</button>
	<button onclick={duplicateFile} disabled={!store.currentFile} aria-label="Duplicate file" title="Copy the current schema file">Duplicate</button>
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
			<!-- Enumerated from SQLITE_TYPES (erd.js) so the allowed modes live in
			     one place; the two options are native and portable. -->
			{#each SQLITE_TYPES as mode (mode)}
				<option value={mode}>types: {mode}</option>
			{/each}
		</select>
	{/if}
	<button onclick={exportDdl} disabled={store.exporting} aria-label="Export">
		{store.exporting ? "..." : "Export"}
	</button>
	<button onclick={exportPng} disabled={store.exporting} aria-label="Export PNG">Export PNG</button>
	<button onclick={exportSvg} disabled={store.exporting} aria-label="Export SVG">Export SVG</button>
	<button onclick={onToggleSql} aria-label="{showSql ? 'Hide' : 'Show'} SQL panel" aria-expanded={showSql} aria-controls="sql-panel">{showSql ? "Hide" : "Show"} SQL</button>
	<button
		onclick={onToggleLint}
		aria-label="Show or hide lint findings"
		aria-expanded={showLint}
		class:active={showLint}
		data-testid="lint-toggle"
	>
		Lint{store.lint.length ? ` (${store.lint.length})` : ""}
	</button>
	<button
		onclick={toggleTheme}
		aria-label="Toggle light or dark theme"
		title="Switch between dark and light themes"
		data-testid="theme-toggle"
	>{store.theme === "dark" ? "Light" : "Dark"}</button>
	{#if store.currentFile}
		<span class="ok" data-testid="current-file" role="status" aria-live="polite">{store.currentFile}</span>
	{/if}
	{#if store.dirty && store.currentFile}
		<!-- autosave has 800ms to land; until then the file differs from disk -->
		<span class="warn" data-testid="dirty" role="status" aria-live="polite">unsaved</span>
	{/if}
</header>

<style>
		header {
		display: flex;
		gap: 8px;
		align-items: center;
		padding: 8px 12px;
		background: var(--color-surface);
		border-bottom: 1px solid var(--color-border-strong);
		position: sticky;
		top: 0;
		z-index: 5;
		flex-wrap: nowrap;
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: thin;
		-webkit-overflow-scrolling: touch;
	}
	header::-webkit-scrollbar {
		height: 4px;
	}
	header::-webkit-scrollbar-thumb {
		background: var(--color-border);
	}
	header button,
	header .btn {
		background: var(--color-primary);
		color: #fff;
		border: 0;
		border-radius: 5px;
		padding: 6px 12px;
		cursor: pointer;
		font: inherit;
		flex: 0 0 auto;
		white-space: nowrap;
	}
	header button:disabled {
		background: var(--color-border);
		color: #778;
		cursor: default;
	}
	header button.active {
		outline: 2px solid var(--color-text-faint);
		outline-offset: -2px;
	}
	header select.dialect {
		background: var(--color-bg);
		color: var(--color-text);
		border: 1px solid var(--color-border);
		border-radius: 5px;
		padding: 5px 6px;
		font: inherit;
		flex: 0 0 auto;
		max-width: 160px;
	}
.ok,
.warn {
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	max-width: 200px;
	/* flex: 0 0 auto — NO shrink: in a nowrap header these are the trailing
	   status texts, and shrink (0 1 auto) lets a crowded toolbar squeeze
	   them to width 0, hiding the "unsaved" signal entirely. Let the header
	   scroll horizontally instead. */
	flex: 0 0 auto;
}
	.ok {
		color: var(--color-success);
	}
	.warn {
		color: var(--color-warning);
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