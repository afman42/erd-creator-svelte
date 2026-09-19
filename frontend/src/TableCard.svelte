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
import {
	addColumn,
	commitTableName,
	dupTable,
	rmTable,
	store,
} from "./schema.svelte.js";

let { table, onDragStart } = $props();

// Which column the dialog is editing. Local to the card: it is view state, not
// model state, so it stays out of the store and out of undo snapshots.
let editingColId = $state(null);
const editing = $derived(
	table.columns.find((c) => c.id === editingColId) ?? null,
);

const parentName = (c) =>
	store.schema.tables.find((x) => x.id === c.ref?.tableId)?.name;
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<section
	class="table"
	class:selected={store.selected === table.id}
	style="left:{table.x}px; top:{table.y}px"
	aria-label="Table {table.name}"
	tabindex="0"
	onclick={() => (store.selected = table.id)}
	onkeydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			store.selected = table.id;
		}
		if (e.target !== e.currentTarget) return;
		if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.key)) {
			e.preventDefault();
			const step = e.shiftKey ? 20 : 10;
			if (e.key === "ArrowUp") table.y = Math.max(0, table.y - step);
			if (e.key === "ArrowDown") table.y += step;
			if (e.key === "ArrowLeft") table.x = Math.max(0, table.x - step);
			if (e.key === "ArrowRight") table.x += step;
		}
	}}
>
	<div
		class="hdr"
		role="button"
		tabindex="0"
		aria-label="Move table {table.name}. Use arrow keys to nudge when selected, drag with mouse."
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
		<button
			title="duplicate"
			aria-label="duplicate table {table.name}"
			onclick={() => dupTable(table)}>⧉</button>
		<button
			title="delete table (Del)"
			aria-label="delete table {table.name}"
			onclick={() => rmTable(table)}>×</button>
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

<style>
	section.table {
		position: absolute;
		width: 280px;
		/* border-box so the declared width IS the box width (BOX_W in
		   geometry.js). With content-box the 1px borders pushed the real box to
		   282px and every child width was understated by its own padding. */
		box-sizing: border-box;
		background: #1a2028;
		border: 1px solid #3b4654;
		border-radius: 6px;
		box-shadow: 0 2px 8px #0008;
	}
	section.selected {
		border-color: #63b3ed;
	}
	section.table:focus-visible {
		outline: 2px solid #63b3ed;
		outline-offset: 2px;
	}
	.hdr {
		display: flex;
		/* explicit height pins HDR_H in geometry.js */
		height: 28px;
		box-sizing: border-box;
		background: #2b6cb0;
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
	.hdr button {
		background: transparent;
		color: #c0cedd;
		border: 0;
		cursor: pointer;
		font-size: 13px;
		flex: 0 0 auto;
	}
	.hdr button:hover {
		color: #f87171;
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
		color: #66bb88;
		border: 0;
		border-top: 1px dashed #3b4654;
		padding: 3px;
		cursor: pointer;
		font: inherit;
	}
	.addcol:focus-visible {
		outline: 1px solid #63b3ed;
		outline-offset: -1px;
	}
</style>
