<script>
// TableCard.svelte — one card per table: header, a read-only row per column,
// and the edit dialog for whichever column is being edited.
//
// The column row used to hold all ten controls inline (name, type, five flags,
// FK, action, remove). Measured in Chromium they needed ~342px against a 280px
// card, so the name field was squeezed to absorb the shortfall and the type
// select clipped TIMESTAMP. The row is now a label and those controls live in
// ColumnEditModal — see that file for why a <dialog>.
//
// The label keeps the row's exact 26px and the comment line's exact 16px, so
// ROW_H (42), boxHeight() and every FK anchor in geometry.js are untouched.
// The comment line renders even when empty: it is 16px of the height model, and
// dropping it would move every row below it.
import ColumnEditModal from "./ColumnEditModal.svelte";
import ColumnRow from "./ColumnRow.svelte";
import { applyCardMetrics } from "./geometry.js";
import { isJunctionTable } from "./relationships.js";
import {
	addColumn,
	commitTableName,
	dupTable,
	rmTable,
	setSelected,
	store,
} from "./schema.svelte.js";
import TableIndexModal from "./TableIndexModal.svelte";

let {
	table,
	onDragStart,
	nameById,
	referenced,
	onConnectStart = null,
	onOpenRelationship = null,
} = $props();

// FK target names + junction membership arrive as props, hoisted once per
// schema identity in App.svelte (canvasView.js): rebuilding them per card per
// change was O(T) maps and O(T×C) scans per card per frame during drag.

// Which column the dialog is editing. Local to the card: it is view state, not
// model state, so it stays out of the store and out of undo snapshots.
let editingColId = $state(null);
const editing = $derived(
	table.columns.find((c) => c.id === editingColId) ?? null,
);

// Whether the composite-index dialog is open. Same reasoning: view state.
let showIndexes = $state(false);

// Junction badge from the hoisted prop: isJunctionTable with a precomputed
// set is an O(1) membership check — no per-card full-schema scan.
const junction = $derived(isJunctionTable(table, store.schema, referenced));

// Column index map for the edit modal: indexOf() per keystroke is O(C), so
// pass positions once instead of scanning per render.
const colIndex = $derived(new Map(table.columns.map((c, i) => [c.id, i])));

const parentName = (c) => nameById.get(c.ref?.tableId);
// Column ordinal for the edit modal (replaces indexOf per keystroke).
const editingIndex = $derived(editing ? (colIndex.get(editing.id) ?? -1) : -1);

// "Add another": commit-and-continue. All modal edits apply live (each snaps
// on its own), so the current column needs no flush — append a fresh column
// and point the modal at it. The modal stays mounted (same onClose), focus
// jumps via the column-switch effect in ColumnEditModal.
function addAnother() {
	addColumn(table);
	editingColId = table.columns[table.columns.length - 1]?.id ?? null;
}
// Card metrics as an attachment: runs on mount, no reactive deps, no
// element-state round-trip through bind:this. Replaces the $effect +
// cardEl $state pair.
/** @param {HTMLElement} el */
function cardMetricsAttachment(el) {
	applyCardMetrics(el);
}
</script>

<section
	class="table"
	class:selected={store.selected === table.id}
	data-table-id={table.id}
	{@attach cardMetricsAttachment}
	style="left:{table.x}px; top:{table.y}px"
	title={table.comment || undefined}
	aria-label="Table {table.name}"
>
	<!-- style= above is a Svelte-compiled CSSOM write, not a parsed style
	     attribute — the CSP's style-src 'self' does not govern it. See the
	     note on the .zoom layer in App.svelte. -->
	<!-- Selection lives on a real <button> (selectBtn); drag lives on the
	     header surface, which is a plain container — keyboard selection goes
	     through the button, nudge through the canvas handler. The old
	     role=button wrapper is gone, so no Space-in-input bubble path and no
	     inner-focus special case in the Delete-key guard. -->
	<div
		class="hdr"
		onpointerdown={(e) => onDragStart(table, e)}
		title="Drag to move · keyboard: select, then arrow keys"
	>
		<button
			class="selectbtn"
			aria-label="Select table {table.name}. Use arrow keys to nudge when selected."
			aria-pressed={store.selected === table.id}
			onclick={(e) => { e.stopPropagation(); setSelected(table.id); }}
		>
			<span class="sel-dot" aria-hidden="true"></span>
			<span class="sr-only">Select {table.name}</span>
		</button>
		<input
			class="tname"
			name="table-name"
			autocomplete="off"
			value={table.name}
			onchange={(e) => commitTableName(table, e)}
			spellcheck="false"
			aria-label="Table name {table.name}"
		/>
		{#if junction}
			<span
				class="chip"
				data-testid="junction-chip"
				title="many-to-many junction (derived from composite FK PK)"
				role="note"
			>N:N</span>
		{/if}
		<button
			title="Composite indexes"
			aria-label="composite indexes for {table.name}"
			onclick={(e) => { e.stopPropagation(); showIndexes = true; }}>⌗</button>
		<button
			title="Duplicate"
			aria-label="duplicate table {table.name}"
			onclick={(e) => { e.stopPropagation(); dupTable(table); }}>⧉</button>
		<button
			title="Delete table (Del)"
			aria-label="delete table {table.name}"
			onclick={(e) => { e.stopPropagation(); rmTable(table); }}>×</button>
	</div>
	{#each table.columns as c (c.id)}
		<ColumnRow
			column={c}
			parentName={parentName(c)}
			onEdit={() => (editingColId = c.id)}
			tableId={table.id}
			{onConnectStart}
			{onOpenRelationship}
		/>
	{/each}
	<button class="addcol" onclick={() => addColumn(table)}>+ column</button>
</section>

{#if editing}
	<ColumnEditModal
		{table}
		column={editing}
		columnIndex={editingIndex}
		columnCount={table.columns.length}
		others={store.schema.tables.filter((x) => x.id !== table.id)}
		junction={junction}
		onClose={() => (editingColId = null)}
		onAddAnother={addAnother}
	/>
{/if}

{#if showIndexes}
	<TableIndexModal {table} onClose={() => (showIndexes = false)} />
{/if}

<style>
	section.table {
		position: absolute;
		width: var(--card-boxW);
		/* border-box so the declared width IS the box width (BOX_W in
		   geometry.js, via --card-boxW). With content-box the 1px borders
		   pushed the real box to 282px and every child width was understated
		   by its own padding. */
		box-sizing: border-box;
		background: var(--color-surface);
		border: var(--card-bw) solid var(--color-border);
		border-radius: var(--radius-lg);
		box-shadow: 0 2px 8px #0008;
		/* Offscreen-card skip for large schemas: the browser skips paint
		   (and layout where provable) for cards outside the viewport, but
		   keeps their box so absolute x/y layout, FK anchors (geometry.js)
		   and export capture are untouched. Fixed intrinsic size (BOX_W × a
		   3-column card) reserves the box so scrollbars don't thrash while
		   skipped; real cards re-measure on reveal. */
		content-visibility: auto;
		contain-intrinsic-size: 280px 183px;
	}
	section.selected {
		border-color: var(--color-focus);
	}
	section.table:focus-visible {
		outline: 2px solid var(--color-focus);
		outline-offset: 2px;
	}
	.hdr {
		display: flex;
		align-items: center;
		/* explicit height pins HDR_H in geometry.js (via --card-hdr) */
		height: var(--card-hdr);
		box-sizing: border-box;
		background: var(--color-primary);
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
		cursor: grab;
	}
	.tname {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: 0;
		color: var(--color-on-primary);
		font-weight: 600;
		font-size: 13px;
		padding: 5px 8px;
		outline: none;
	}
	/* Derived marker, not a flag: isJunctionTable() decides. Fits inside the
	   28px header (HDR_H) so the height model in geometry.js is untouched. */
	.chip {
		flex: 0 0 auto;
		margin-right: 4px;
		padding: 1px 5px;
		border-radius: var(--radius-xl);
		background: var(--color-accent);
		color: var(--color-bg);
		font: 10px var(--font-mono);
		line-height: 14px;
	}
	.hdr button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		/* 44px touch target that does NOT move the 28px HDR_H model: same
		   negative-margin overflow trick as the row ✎ in ColumnRow. */
		flex: 0 0 28px;
		width: 28px;
		height: 44px;
		margin: -8px 0;
		padding: 0 8px;
		background: transparent;
		color: var(--color-text-muted);
		border: 0;
		cursor: pointer;
		font-size: 14px;
		line-height: 1;
	}
	/* Selection dot: filled when the card is selected (aria-pressed + the
	   section.selected ring already announce it; the dot is the visual). */
	.hdr button.selectbtn .sel-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		border: 2px solid var(--color-on-primary);
		box-sizing: border-box;
	}
	section.selected .hdr button.selectbtn .sel-dot {
		background: var(--color-on-primary);
	}
	.hdr button:hover {
		color: var(--color-danger);
	}
	.hdr button.selectbtn:hover {
		color: var(--color-text-muted);
	}
	.hdr button:focus-visible,
	.tname:focus-visible {
		outline: 1px solid var(--color-focus);
		outline-offset: -1px;
	}
	.addcol {
		width: 100%;
		/* height (not min-height) pins ADDCOL_H (via --card-addcol): the
		   CSS-drift test reads it. 44px touch lives on the row-✎/header
		   overflow + modal controls — the footer stays model-exact. */
		height: var(--card-addcol);
		box-sizing: border-box;
		background: transparent;
		color: var(--color-flag);
		border: 0;
		border-top: 1px dashed var(--color-border);
		padding: 3px;
		cursor: pointer;
		font: inherit;
	}
	.addcol:hover {
		color: var(--color-primary-hover);
	}

	.addcol:focus-visible {
		outline: 1px solid var(--color-focus);
		outline-offset: -1px;
	}
</style>
