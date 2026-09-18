<script>
import { baseType, isInt, TYPES } from "./erd.js";
import {
	addColumn,
	commitColName,
	commitComment,
	commitTableName,
	dupTable,
	rmColumn,
	rmTable,
	setRef,
	setRefAction,
	setType,
	store,
	toggleFlag,
	togglePk,
} from "./schema.svelte.js";

let { table, onDragStart } = $props();

const actions = ["CASCADE", "RESTRICT", "SET NULL", "NO ACTION"];
const others = $derived(store.schema.tables.filter((x) => x.id !== table.id));
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
			<input
				class="cname"
				class:pk={c.pk}
				value={c.name}
				onchange={(e) => commitColName(c, e)}
				spellcheck="false"
			/>
			<select
				value={baseType(c.type)}
				onchange={(e) => setType(c, e.currentTarget.value)}
			>
				{#each TYPES as ty}<option value={ty}>{ty}</option>{/each}
			</select>
			<label title="primary key"
				><input type="checkbox" checked={c.pk} onchange={() => togglePk(c)} />PK</label
			>
			<label title="not null"
				><input
					type="checkbox"
					checked={c.nn || c.pk}
					disabled={c.pk}
					onchange={() => toggleFlag(c, "nn")}
				/>NN</label
			>
			<label title="unique"
				><input
					type="checkbox"
					checked={c.ux}
					onchange={() => toggleFlag(c, "ux")}
				/>UQ</label
			>
			<label title="auto increment"
				><input
					type="checkbox"
					checked={c.ai}
					disabled={!isInt(c.type)}
					onchange={() => toggleFlag(c, "ai")}
				/>AI</label
			>
			<label title="index"
				><input
					type="checkbox"
					checked={c.ix}
					onchange={() => toggleFlag(c, "ix")}
				/>IX</label
			>
			<select class="fk" value={c.ref?.tableId ?? ""} onchange={(e) => setRef(c, e)}>
				<option value="">FK→</option>
				{#each others as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
			</select>
			{#if c.ref}
				<select
					class="act"
					value={c.ref.action ?? "CASCADE"}
					onchange={(e) => setRefAction(c, e)}
					title="ON DELETE"
				>
					{#each actions as a}<option value={a}>{a}</option>{/each}
				</select>
			{/if}
			<button
				title="remove column"
				class="rmcol"
				onclick={() => rmColumn(table, c)}
				>–</button
			>
		</div>
		<div class="cmt">
			<input
				placeholder="comment"
				value={c.comment}
				onchange={(e) => commitComment(c, e)}
				spellcheck="false"
			/>
		</div>
	{/each}
	<button class="addcol" onclick={() => addColumn(table)}>+ column</button>
</section>

<style>
	section.table {
		position: absolute;
		width: 280px;
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
		background: #2b6cb0;
		border-radius: 5px 5px 0 0;
		cursor: grab;
	}
	.tname {
		flex: 1;
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
		gap: 2px;
		padding: 1px 3px;
		height: 26px;
	}
	.row:hover {
		background: #232b35;
	}
	input.cname {
		width: 62px;
		background: transparent;
		border: 0;
		color: #d8dee6;
		font: inherit;
		outline: none;
	}
	input.cname.pk {
		color: #fbbf24;
		font-weight: 600;
	}
	.row select {
		background: #101418;
		color: #9fb0c0;
		border: 0;
		font: 10px ui-monospace, monospace;
	}
	.row select.fk {
		width: 62px;
	}
	.row select.act {
		width: 58px;
	}
	.row label {
		font-size: 9px;
		color: #9fb0c0;
		display: flex;
		gap: 1px;
		align-items: center;
	}
	.row label input {
		width: 10px;
		height: 10px;
		margin: 0;
	}
	.rmcol,
	.hdr button {
		background: transparent;
		color: #778;
		border: 0;
		cursor: pointer;
		font-size: 13px;
	}
	.rmcol:hover,
	.hdr button:hover {
		color: #f87171;
	}
	.cmt input {
		width: calc(100% - 10px);
		margin: 0 3px;
		background: transparent;
		border: 0;
		border-bottom: 1px dotted #2a3340;
		color: #7fa3c0;
		font: italic 10px system-ui, sans-serif;
		outline: none;
	}
	.cmt input::placeholder {
		color: #4a5a68;
	}
	.addcol {
		width: 100%;
		background: transparent;
		color: #66bb88;
		border: 0;
		border-top: 1px dashed #3b4654;
		padding: 3px;
		cursor: pointer;
		font: inherit;
	}
</style>
