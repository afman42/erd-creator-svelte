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

let { table, onDragStart, nameById, referenced } = $props();

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
</script>

<section
	class="table"
	class:selected={store.selected === table.id}
	style="left:{table.x}px; top:{table.y}px"
	title={table.comment || undefined}
	aria-label="Table {table.name}"
>
	<!-- style= above is a Svelte-compiled CSSOM write, not a parsed style
	     attribute — the CSP's style-src 'self' does not govern it. See the
	     note on the .zoom layer in App.svelte. -->
	<!-- Selection lives on a real <button> (selectBtn); drag lives on the
	     header surface. Previously one role=button div held the name input +
	     3 buttons, so Space inside the input bubbled to the header handler —
	     benign but fragile, and the S5 Delete-key guard had to special-case
	     inner focus. The drag handle keeps pointer+keyboard(nudge) behavior;
	     selectTable e2e flow (press on header, defocus, arrows) is unchanged
	     because the handle is where the press lands. -->
	<div
		class="hdr"
		role="button"
		tabindex="0"
		aria-label="Select table {table.name}. Drag to move. Use arrow keys to nudge when selected."
		onpointerdown={(e) => onDragStart(table, e)}
		onclick={() => setSelected(table.id)}
		onkeydown={(e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				setSelected(table.id);
			}
		}}
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
			title="composite indexes"
			aria-label="composite indexes for {table.name}"
			onclick={(e) => { e.stopPropagation(); showIndexes = true; }}>⌗</button>
		<button
			title="duplicate"
			aria-label="duplicate table {table.name}"
			onclick={(e) => { e.stopPropagation(); dupTable(table); }}>⧉</button>
		<button
			title="delete table (Del)"
			aria-label="delete table {table.name}"
			onclick={(e) => { e.stopPropagation(); rmTable(table); }}>×</button>
	</div>
	{#each table.columns as c (c.id)}
		<ColumnRow
			column={c}
			parentName={parentName(c)}
			onEdit={() => (editingColId = c.id)}
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
	/>
{/if}

{#if showIndexes}
	<TableIndexModal {table} onClose={() => (showIndexes = false)} />
{/if}

<style>
	section.table {
		position: absolute;
		width: 280px;
		/* border-box so the declared width IS the box width (BOX_W in
		   geometry.js). With content-box the 1px borders pushed the real box to
		   282px and every child width was understated by its own padding. */
		box-sizing: border-box;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		box-shadow: 0 2px 8px #0008;
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
		/* explicit height pins HDR_H in geometry.js */
		height: 28px;
		box-sizing: border-box;
		background: var(--color-primary);
		border-radius: 5px 5px 0 0;
		cursor: grab;
	}
	.tname {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: 0;
		color: #fff;
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
		border-radius: 8px;
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
		border: 2px solid #fff;
		box-sizing: border-box;
	}
	section.selected .hdr button.selectbtn .sel-dot {
		background: #fff;
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
		/* height (not min-height) pins ADDCOL_H: the CSS-drift test reads it.
		   44px touch lives on the row-✎/header overflow + modal controls —
		   the footer stays model-exact. */
		height: 25px;
		box-sizing: border-box;
		background: transparent;
		color: var(--color-flag);
		border: 0;
		border-top: 1px dashed var(--color-border);
		padding: 3px;
		cursor: pointer;
		font: inherit;
	}
	.addcol:focus-visible {
		outline: 1px solid var(--color-focus);
		outline-offset: -1px;
	}
</style>
