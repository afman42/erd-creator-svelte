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
	store,
} from "./schema.svelte.js";
import TableIndexModal from "./TableIndexModal.svelte";

let { table, onDragStart } = $props();

// FK target name lookup, memoized per table list: the old parentName()
// ran `store.schema.tables.find` per COLUMN per render — O(T×C) finds per
// frame during drag. One Map per schema identity keeps it O(1) per column.
let nameById = $derived(
	new Map(store.schema.tables.map((t) => [t.id, t.name])),
);

// Which column the dialog is editing. Local to the card: it is view state, not
// model state, so it stays out of the store and out of undo snapshots.
let editingColId = $state(null);
const editing = $derived(
	table.columns.find((c) => c.id === editingColId) ?? null,
);

// Whether the composite-index dialog is open. Same reasoning: view state.
let showIndexes = $state(false);

// Junction badge, memoized: isJunctionTable scans the whole schema for
// inbound refs — O(T×C) per card per render, i.e. O(T²×C) per frame during
// drag. $derived memoizes per card on schema identity.
const junction = $derived(isJunctionTable(table, store.schema));

const parentName = (c) => nameById.get(c.ref?.tableId);
</script>

<section
	class="table"
	class:selected={store.selected === table.id}
	style="left:{table.x}px; top:{table.y}px"
	title={table.comment || undefined}
	aria-label="Table {table.name}"
>
	<!-- The header is the card's interactive surface: role=button + tabindex
	   keep click/Enter/Space selection and drag on one focusable element.
	   Previously the section itself carried onclick/tabindex/keydown, which
	   needed two a11y suppressions (section is not an interactive element)
	   and double-fired selection when a header click bubbled to the section.
	   Selection now lives ONLY here; keyboard.spec's header-press flow is
	   unchanged (press lands on the name input, defocus, arrows/Backspace). -->
	<div
		class="hdr"
		role="button"
		tabindex="0"
		aria-label="Select table {table.name}. Use arrow keys to nudge when selected, drag with mouse."
		onclick={() => (store.selected = table.id)}
		onpointerdown={(e) => onDragStart(table, e)}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				store.selected = table.id;
			}
		}}
	>
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
		/* #63b3ed has no token (it is the selection/focus blue); kept literal. */
		border-color: #63b3ed;
	}
	section.table:focus-visible {
		outline: 2px solid #63b3ed;
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
		font: 9px ui-monospace, monospace;
		line-height: 14px;
	}
	.hdr button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 28px;
		width: 28px;
		height: 28px;
		padding: 0;
		background: transparent;
		color: #c0cedd;
		border: 0;
		cursor: pointer;
		font-size: 14px;
		line-height: 1;
	}
	.hdr button:hover {
		color: var(--color-danger);
	}
	.hdr button:focus-visible,
	.tname:focus-visible {
		outline: 1px solid #63b3ed;
		outline-offset: -1px;
	}
	.addcol {
		width: 100%;
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
		outline: 1px solid #63b3ed;
		outline-offset: -1px;
	}
</style>
