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

<section
	class="table"
	class:selected={store.selected === table.id}
	style="left:{table.x}px; top:{table.y}px"
>
	<div class="hdr" onpointerdown={(e) => onDragStart(table, e)}>
		<input
			class="tname"
			value={table.name}
			onchange={(e) => commitTableName(table, e)}
			spellcheck="false"
		/>
		<button title="duplicate" onclick={() => dupTable(table)}>⧉</button>
		<button title="delete table (Del)" onclick={() => rmTable(table)}>×</button>
	</div>
	{#each table.columns as c (c.id)}
		<div class="row">
			<span class="cname" class:pk={c.pk} title={c.name}>{c.name}</span>
			<span class="ty" title={c.type}>{c.type}</span>
			<!-- only the flags that are set: five badges on every row is what
			     made the row overflow in the first place -->
			<span class="flags">
				{#if c.pk}<b>PK</b>{/if}
				{#if c.nn || c.pk}<b>NN</b>{/if}
				{#if c.ux}<b>UQ</b>{/if}
				{#if c.ai}<b>AI</b>{/if}
				{#if c.ix}<b>IX</b>{/if}
			</span>
			{#if c.ref}
				<span class="fkinfo" title="→ {parentName(c) ?? "?"}">→{parentName(c) ?? "?"}</span>
			{/if}
			<button
				class="edit"
				title="edit column"
				aria-label="edit {c.name}"
				onclick={() => (editingColId = c.id)}>✎</button
			>
		</div>
		<div class="cmt" title={c.comment}>{c.comment}</div>
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
	.row {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 1px 2px;
		/* explicit height + border-box pins the 26px row that ROW_H (42) is
		   built from: 26px row + 16px comment line. The row is a label now, but
		   the height is load-bearing — every FK anchor derives from it. */
		height: 26px;
		box-sizing: border-box;
	}
	.row:hover {
		background: #232b35;
	}
	/* The name is the only part that flexes; everything else is fixed-width and
	   clips with an ellipsis. The name is also the one field that degrades
	   gracefully when squeezed, so it absorbs the whole shortfall. */
	.row .cname {
		flex: 1 1 auto;
		min-width: 24px;
		font-size: 11px;
		color: #d8dee6;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row .cname.pk {
		color: #fbbf24;
		font-weight: 600;
	}
	.row .ty {
		flex: 0 0 auto;
		max-width: 80px;
		font: 9px ui-monospace, monospace;
		color: #7fa3c0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row .flags {
		flex: 0 0 auto;
		display: flex;
		gap: 2px;
		font: 8px ui-monospace, monospace;
		color: #66bb88;
		/* declared so the row's space budget is verifiable from the CSS —
		   the worst case is all five flags (PK NN UQ AI IX) */
		max-width: 62px;
		overflow: hidden;
	}
	.row .fkinfo {
		flex: 0 0 auto;
		max-width: 52px;
		font: 9px ui-monospace, monospace;
		color: #bb5588;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row .edit {
		flex: 0 0 auto;
		/* declared for the same reason as .flags above */
		width: 16px;
		box-sizing: border-box;
		background: transparent;
		color: #778;
		border: 0;
		cursor: pointer;
		font-size: 11px;
		padding: 0;
	}
	.row .edit:hover {
		color: #63b3ed;
	}
	.hdr button {
		background: transparent;
		color: #778;
		border: 0;
		cursor: pointer;
		font-size: 13px;
		flex: 0 0 auto;
	}
	.hdr button:hover {
		color: #f87171;
	}
	/* explicit 16px so row(26) + comment(16) = ROW_H(42) exactly. Always
	   rendered, even with no comment: it is part of the height model. */
	.cmt {
		height: 16px;
		box-sizing: border-box;
		padding: 0 4px;
		font: italic 10px system-ui, sans-serif;
		color: #7fa3c0;
		line-height: 16px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.addcol {
		width: 100%;
		/* explicit height + border-box pins ADDCOL_H in geometry.js, so
		   boxHeight() — which layout() and addTable() stack cards by — stays
		   true even if the font or padding changes. */
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
</style>
