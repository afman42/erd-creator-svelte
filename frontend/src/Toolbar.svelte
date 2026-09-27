<script>
import { DEFAULT_SQLITE_TYPES, DIALECTS, SQLITE_TYPES } from "./erd.js";
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
	setSelected,
	setSqliteTypes,
	store,
	toggleTheme,
	undo,
} from "./schema.svelte.js";
import { scrollToTable } from "./ui.js";

let {
	showSql,
	onToggleSql,
	onToggleRelationship,
	showLint,
	onToggleLint,
	zoom,
	zoomMin,
	zoomMax,
	onZoomOut,
	onZoomIn,
	onZoomFit,
} = $props();

// Display names; the values are the server's dialect identifiers.
/** @type {Record<string, string>} */
const LABELS = {
	mysql: "MySQL",
	mariadb: "MariaDB",
	postgres: "PostgreSQL",
	sqlite: "SQLite",
};

// Filter queries: fileQuery narrows the file <select> options; tableQuery
// jumps to the first matching card on Enter. Local view state — never enters
// the schema or undo.

let fileQuery = $state("");
let tableQuery = $state("");
const fileOptions = $derived(
	store.files.filter((f) =>
		f.name.toLowerCase().includes(fileQuery.trim().toLowerCase()),
	),
);

function jumpToTable() {
	const q = tableQuery.trim().toLowerCase();
	if (!q) return;
	const t = store.schema.tables.find((x) => x.name.toLowerCase().includes(q));
	if (!t) return;
	scrollToTable(t.id, t.name, setSelected);
}
// Live-jump while typing would yank scroll on every keystroke; jump on Enter
// only (jumpToTable above), filter is Enter-free.
</script>

<header aria-label="ERD toolbar">
	<h1 class="sr-only">ERD Creator</h1>
	<!-- Groups: create | file | schema | view. Del sits last in its group,
	     never adjacent to Save. Rename/duplicate/copy/export collapse into
	     the ⋯ overflow <details> which stays in the DOM so role queries keep
	     working; CSS moves .more inline on wide screens. -->
	<div class="grp" role="group" aria-label="Create">
		<button onclick={addTable} aria-label="+ Table" title="Add a table">+ Table</button>
		<button
			onclick={onToggleRelationship}
			disabled={store.schema.tables.length < 2}
			aria-label="+ Relationship"
			title="Create a 1:1, 1:N or N:N relationship between two tables"
		>+ Relationship</button>
		<button onclick={undo} disabled={!store.undoDepth} aria-label="Undo" title="Undo (Ctrl+Z)">Undo</button>
	</div>
	<div class="grp" role="group" aria-label="File">
		<label class="sr-only" for="file-select">Open schema file</label>
		<select
			id="file-select"
			class="dialect"
			value={store.currentFile}
			onchange={(e) => openFile(e.currentTarget.value)}
			title="Open schema file"
			aria-label="Open schema file"
		>
			<option value="">Open file…</option>
			{#each fileOptions as f (f.name)}<option value={f.name}>{f.name}</option>{/each}
		</select>
		<input
			class="search"
			type="search"
			placeholder="Filter files…"
			aria-label="Filter files"
			value={fileQuery}
			oninput={(e) => (fileQuery = e.currentTarget.value)}
		/>
		<button onclick={newFile} aria-label="New" title="Create a new schema file">New</button>
		<button onclick={() => saveCurrent()} disabled={!store.currentFile} aria-label="Save" title="Save the current file">Save</button>
		<button onclick={renameFile} disabled={!store.currentFile} aria-label="Rename file" title="Rename the current schema file">Rename</button>
		<button onclick={duplicateFile} disabled={!store.currentFile} aria-label="Duplicate file" title="Copy the current schema file">Duplicate</button>
		<button onclick={deleteFile} disabled={!store.currentFile} aria-label="Del" title="Delete the current schema file">Del</button>
	</div>
	<div class="grp" role="group" aria-label="Schema">
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
				<option value={d}>{LABELS[d]}</option>
			{/each}
		</select>
		{#if store.schema.dialect === "sqlite"}
			<label class="sr-only" for="sqlite-types">SQLite types mode</label>
			<select
				id="sqlite-types"
				class="dialect"
				value={store.schema.sqliteTypes ?? DEFAULT_SQLITE_TYPES}
				onchange={(e) => setSqliteTypes(e.currentTarget.value)}
				title="How SQLite renders BOOLEAN / DATETIME / TIMESTAMP: native keeps the declared name, portable uses the storage class"
				aria-label="SQLite types mode"
				data-testid="sqlite-types"
			>
				{#each SQLITE_TYPES as mode (mode)}
					<option value={mode}>types: {mode}</option>
				{/each}
			</select>
		{/if}
		<input
			class="search"
			type="search"
			placeholder="Find table…"
			aria-label="Find table on canvas"
			value={tableQuery}
			oninput={(e) => (tableQuery = e.currentTarget.value)}
			onkeydown={(e) => {
				if (e.key === "Enter") jumpToTable();
			}}
		/>
	</div>
	<details class="more">
		<summary aria-label="More share actions">⋯</summary>
		<div class="grp" role="group" aria-label="Share">
			<button onclick={copySql} aria-label="Copy SQL" title="Copy the current DDL to the clipboard">Copy SQL</button>
			<button onclick={copyInserts} aria-label="Copy INSERTs" title="Copy seed-row INSERT templates">Copy INSERTs</button>
		<button
			onclick={exportDdl}
			disabled={store.exporting}
			aria-label="Export"
			aria-busy={store.exporting}
			title="Download the current DDL as a .sql file"
		>
			{store.exporting ? "Exporting…" : "Export"}
		</button>
			<button onclick={exportPng} disabled={store.exporting} aria-label={store.exporting ? "Exporting PNG" : "Export PNG"} aria-busy={store.exporting}>Export PNG</button>
			<button onclick={exportSvg} disabled={store.exporting} aria-label={store.exporting ? "Exporting SVG" : "Export SVG"} aria-busy={store.exporting}>Export SVG</button>
		</div>
	</details>
	<div class="grp" role="group" aria-label="View">
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
		<button onclick={onZoomOut} disabled={zoom <= zoomMin} aria-label="Zoom out" title="Zoom out">−</button>
		<button onclick={onZoomFit} aria-label="Fit schema to view" title="Fit schema to view">Fit</button>
		<button onclick={onZoomIn} disabled={zoom >= zoomMax} aria-label="Zoom in" title="Zoom in">+</button>
		<span role="status" aria-live="polite" aria-label="Zoom level">{Math.round(zoom * 100)}%</span>
	</div>
	{#if store.currentFile}
		<span class="ok" data-testid="current-file" role="status" aria-live="polite">{store.currentFile}</span>
	{/if}
	{#if store.dirty && store.currentFile}
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
	header button {
		background: var(--color-primary);
		color: #fff;
		border: 0;
		border-radius: 5px;
		padding: 6px 12px;
		cursor: pointer;
		font: inherit;
		flex: 0 0 auto;
		white-space: nowrap;
		min-height: 44px;
	}
	header button:disabled {
		background: var(--color-border);
		color: var(--color-text-faint);
		cursor: default;
		opacity: 0.7;
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
		min-height: 44px;
	}
	/* Group separators: related controls read as one cluster. */
	.grp {
		display: flex;
		gap: 8px;
		align-items: center;
		flex: 0 0 auto;
	}
	.grp + .grp,
	.grp + .more,
	.more + .grp {
		border-left: 1px solid var(--color-border);
		padding-left: 8px;
	}
	header input.search {
		background: var(--color-bg);
		color: var(--color-text);
		border: 1px solid var(--color-border);
		border-radius: 5px;
		padding: 5px 8px;
		font: inherit;
		flex: 0 0 auto;
		width: 110px;
		min-height: 44px;
		box-sizing: border-box;
	}
	/* ⋯ overflow popover on narrow screens; inline row on wide ones. */
	.more {
		flex: 0 0 auto;
	}
	.more > summary {
		list-style: none;
		cursor: pointer;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 5px;
		padding: 5px 10px;
		min-height: 44px;
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
	}
	.more > summary::-webkit-details-marker {
		display: none;
	}
	.more > summary:focus-visible {
		outline: 2px solid var(--color-focus);
		outline-offset: 2px;
	}
	@media (max-width: 1100px) {
		.more .grp {
			position: absolute;
			background: var(--color-surface);
			border: 1px solid var(--color-border);
			border-radius: var(--radius-md);
			padding: 8px;
			z-index: 10;
			flex-wrap: wrap;
		}
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
	/* .sr-only lives in tokens.css (global) — one class, not four copies. */
</style>