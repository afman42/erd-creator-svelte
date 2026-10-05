<script>
import { DEFAULT_SQLITE_TYPES, DIALECTS, SQLITE_TYPES } from "./erd.js";
import {
	addTable,
	arrangeSchema,
	copyInserts,
	copySql,
	deleteFile,
	duplicateFile,
	exportDdl,
	exportPng,
	exportSvg,
	newFile,
	openFile,
	redo,
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

// tableQuery jumps to the first matching card on Enter. Local view state —
// never enters the schema or undo. Seeded from ?q=, mirrored back on input
// so find text is deep-linkable; App owns the other params.
let tableQuery = $state(new URLSearchParams(location.search).get("q") ?? "");

function jumpToTable() {
	const q = tableQuery.trim().toLowerCase();
	if (!q) return;
	const t = store.schema.tables.find((x) => x.name.toLowerCase().includes(q));
	if (!t) return;
	scrollToTable(t.id, t.name, setSelected);
}

/** Mirror find text into ?q= via replaceState (no history entry per keystroke). */
function syncQueryParam() {
	const url = new URL(location.href);
	if (tableQuery) url.searchParams.set("q", tableQuery);
	else url.searchParams.delete("q");
	const next =
		url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : "");
	if (next !== location.pathname + location.search)
		history.replaceState(null, "", next);
}
// Live-jump while typing would yank scroll on every keystroke; jump on Enter
// only (jumpToTable above), filter is Enter-free.
</script>

<header aria-label="ERD toolbar">
	<h1 class="sr-only">ERD Creator</h1>
	<!-- Groups: create | file | schema | view. Delete sits last in its group,
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
		<button onclick={redo} disabled={!store.redoDepth} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">Redo</button>
		<button onclick={arrangeSchema} disabled={store.schema.tables.length < 1} aria-label="Arrange tables" title="Auto-layout tables by FK depth">Arrange</button>
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
			{#each store.files as f (f.name)}<option value={f.name}>{f.name}</option>{/each}
		</select>
		<button onclick={newFile} aria-label="New file" title="Create a new schema file">New</button>
		<button onclick={() => saveCurrent()} disabled={!store.currentFile} aria-label="Save" title="Save the current file">Save</button>
		<button onclick={renameFile} disabled={!store.currentFile} aria-label="Rename file" title="Rename the current schema file">Rename</button>
		<button onclick={duplicateFile} disabled={!store.currentFile} aria-label="Duplicate file" title="Copy the current schema file">Duplicate</button>
		<button onclick={deleteFile} disabled={!store.currentFile} aria-label="Delete file" title="Delete the current schema file">Delete</button>
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
			name="find-table"
			autocomplete="off"
			placeholder="Find table…"
			aria-label="Find table on canvas"
			value={tableQuery}
			oninput={(e) => { tableQuery = e.currentTarget.value; syncQueryParam(); }}
			onkeydown={(e) => {
				if (e.key === "Enter") jumpToTable();
			}}
		/>
	</div>
	<details class="more">
		<summary
			aria-label="More share actions"
			aria-keyshortcuts="Escape"
			onkeydown={(e) => {
				if (e.key !== "Escape") return;
				const d = e.currentTarget.closest("details");
				if (d?.open) {
					d.open = false;
					e.currentTarget.blur();
				}
			}}
		>⋯</summary>
		<div class="grp" role="group" aria-label="Share">
			<button onclick={copySql} aria-label="Copy SQL" title="Copy the current DDL to the clipboard">Copy SQL</button>
			<button onclick={copyInserts} aria-label="Copy INSERTs" title="Copy seed-row INSERT templates">Copy INSERTs</button>
		<button
			onclick={exportDdl}
			disabled={store.exporting}
			aria-label="Export DDL"
			aria-busy={store.exporting}
			title="Download the current DDL as a .sql file"
		>
			{store.exporting ? "Exporting…" : "Export"}
		</button>
			<button onclick={exportPng} disabled={store.exporting} aria-label={store.exporting ? "Exporting PNG…" : "Export PNG"} aria-busy={store.exporting}>Export PNG</button>
			<button onclick={exportSvg} disabled={store.exporting} aria-label={store.exporting ? "Exporting SVG…" : "Export SVG"} aria-busy={store.exporting}>Export SVG</button>
		</div>
	</details>
	<div class="grp" role="group" aria-label="View">
		<button onclick={onToggleSql} aria-label="{showSql ? 'Hide' : 'Show'} SQL panel" aria-expanded={showSql} aria-controls="sql-panel">{showSql ? "Hide" : "Show"} SQL</button>
		<button
			onclick={onToggleLint}
			aria-label="Show or hide lint findings"
			aria-expanded={showLint}
			class={showLint && "active"}
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
		<span class="warn" data-testid="dirty" role="status" aria-live="polite">Unsaved</span>
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
		scrollbar-color: var(--color-border) transparent;
		-webkit-overflow-scrolling: touch;
		scroll-behavior: smooth;
		scroll-padding-inline: 12px;
		scroll-snap-type: x proximity;
	}
	header::-webkit-scrollbar {
		height: 6px;
	}
	header::-webkit-scrollbar-track {
		background: transparent;
	}
	header::-webkit-scrollbar-thumb {
		background: var(--color-border);
		border-radius: 999px;
	}
	header::-webkit-scrollbar-thumb:hover {
		background: var(--color-border-strong);
	}
	header button {
		background: var(--color-primary);
		color: var(--color-on-primary);
		border: 0;
		border-radius: var(--radius-md);
		padding: 6px 12px;
		cursor: pointer;
		font: inherit;
		flex: 0 0 auto;
		white-space: nowrap;
		min-height: 44px;
		transition: transform 0.15s ease, opacity 0.15s ease;
	}
	header button:not(:disabled):hover {
		opacity: 0.92;
	}
	header button:not(:disabled):active {
		transform: translateY(1px);
	}
	header button:focus-visible {
		outline: 2px solid var(--color-focus);
		outline-offset: 2px;
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
		background-color: var(--color-bg);
		color: var(--color-text);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: 5px 6px;
		font: inherit;
		flex: 0 0 auto;
		max-width: 160px;
		min-height: 44px;
	}
	header select.dialect:hover {
		border-color: var(--color-border-strong);
	}
	/* Tab pills: each group reads as one tab; the ::after bar slides in on
	   hover or keyboard focus-within. Separators are gone — the pill border
	   carries the grouping now. */
	.grp {
		display: flex;
		gap: 8px;
		align-items: center;
		flex: 0 0 auto;
		position: relative;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: 6px 8px;
		scroll-snap-align: start;
		transition: opacity 0.18s ease;
	}
	.grp::after {
		content: "";
		position: absolute;
		left: 8px;
		right: 8px;
		bottom: 2px;
		height: 2px;
		border-radius: 999px;
		background: var(--color-primary);
		transform: scaleX(0);
		transform-origin: left;
		transition: transform 0.22s ease, opacity 0.22s ease;
		pointer-events: none;
	}
	header input.search {
		background-color: var(--color-bg);
		color: var(--color-text);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: 5px 8px;
		font: inherit;
		flex: 0 0 auto;
		width: 110px;
		min-height: 44px;
		box-sizing: border-box;
	}
	header input.search:hover {
		border-color: var(--color-border-strong);
	}
	/* ⋯ overflow popover on narrow screens; inline row on wide ones. Open
	   animates via keyframes (close snaps shut — <details> close is not
	   transitionable in pure CSS). Resolved against the header so the
	   absolute popover anchors to the toolbar, and scrolls with the row:
	   unavoidable inside overflow-x:auto without popover JS. */
	.more {
		flex: 0 0 auto;
		position: relative;
		scroll-snap-align: start;
	}
	.more > summary {
		list-style: none;
		cursor: pointer;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: 5px 10px;
		min-height: 44px;
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
		transition: opacity 0.18s ease;
	}
	.more > summary:hover {
		border-color: var(--color-border-strong);
	}
	.more[open] > summary {
		border-color: var(--color-primary);
	}
	.more > summary::-webkit-details-marker {
		display: none;
	}
	.more > summary:focus-visible {
		outline: 2px solid var(--color-focus);
		outline-offset: 2px;
	}
	@media (max-width: 1100px) {
		/* fixed, not absolute: the header is a scrollport (overflow-x:auto),
		   which clips absolute descendants. Fixed escapes to the viewport. */
		.more .grp {
			position: fixed;
			top: 64px;
			right: 8px;
			background: var(--color-surface);
			border: 1px solid var(--color-border);
			border-radius: var(--radius-md);
			padding: 8px;
			z-index: 10;
			flex-wrap: wrap;
		}
		.more[open] .grp {
			animation: more-pop 0.18s ease;
		}
	}
	@keyframes more-pop {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		header {
			scroll-behavior: auto;
			scroll-snap-type: none;
		}
		.grp,
		.grp::after,
		header button,
		.more > summary {
			transition: none;
		}
		.more[open] .grp {
			animation: none;
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