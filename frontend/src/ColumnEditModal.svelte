<script>
// ColumnEditModal.svelte — every per-column control that used to be crammed
// into the 26px card row lives here instead: name, type, the five flags, the FK
// target, its ON DELETE action and the comment.
//
// The row could not hold them. Measured in Chromium the ten controls needed
// ~342px against a 280px card, so the name field was squeezed to absorb the
// shortfall and the type select clipped TIMESTAMP. Moving them into a dialog
// gives each control its natural width and leaves the row free to be a label.
//
// A native <dialog> rather than a hand-rolled overlay: showModal() puts it in
// the top layer, traps focus, and wires Escape to cancel — three things an
// overlay would have to reimplement, and the top layer is also why the dialog
// needs no inline styles (the CSP is style-src 'self', so it could not have
// them anyway).
import { baseType, isInt, TYPES } from "./erd.js";
import {
	CARDINALITY_STATES,
	cardinalityState,
	reachableStates,
} from "./geometry.js";
import {
	commitColName,
	commitComment,
	rmColumn,
	setCardinality,
	setRef,
	setRefAction,
	setRefOnUpdate,
	setType,
	store,
	toggleArray,
	toggleFlag,
	togglePk,
} from "./schema.svelte.js";

let { table, column, onClose } = $props();

const actions = ["CASCADE", "RESTRICT", "SET NULL", "NO ACTION"];
const others = $derived(store.schema.tables.filter((x) => x.id !== table.id));

// The current cardinality state, derived from the flags — never stored.
const cardState = $derived(cardinalityState(table, column));

// The states this column can actually be put into, derived from its PK shape:
// a PK is emitted NOT NULL so its parent end is pinned, and a sole PK is unique
// so its child end is too. The other options are DISABLED rather than hidden,
// so the constraint is visible instead of the choice silently disappearing.
const reachable = $derived(reachableStates(table, column));

let dlg = $state(null);

// showModal() is imperative, so it cannot be an attribute. Guarded on `open`
// because the effect also re-runs when a mutation re-renders the dialog.
$effect(() => {
	if (dlg && !dlg.open) dlg.showModal();
});

function remove() {
	const id = column.id;
	rmColumn(table, column);
	// rmColumn refuses to empty a table (it flashes instead of removing), so
	// close only when the column is actually gone — otherwise the modal would
	// disappear over an error the user still needs to read.
	if (!table.columns.some((c) => c.id === id)) onClose();
}
</script>

<dialog bind:this={dlg} onclose={onClose} class="coledit">
	<h2>{table.name} · column</h2>

	<label class="fld">
		<span>Name</span>
		<input
			class="cname"
			value={column.name}
			onchange={(e) => commitColName(column, e)}
			spellcheck="false"
		/>
	</label>

	<label class="fld">
		<span>Type</span>
		<select
			class="type"
			value={baseType(column.type)}
			onchange={(e) => setType(column, e.currentTarget.value)}
		>
			{#each TYPES as ty (ty)}<option value={ty}>{ty}</option>{/each}
		</select>
	</label>

	{#if store.schema.dialect === "postgres"}
		<!-- Array types are PostgreSQL syntax, and the server refuses to emit one
		     for any other dialect (ValidateFor). Showing the control elsewhere
		     would let the user build a schema that cannot be saved. -->
		<label class="fld" title="PostgreSQL array type (e.g. INT[])">
			<span>Array</span>
			<input
				class="isarray"
				type="checkbox"
				data-testid="is-array"
				checked={column.type.endsWith("[]")}
				onchange={() => toggleArray(column)}
			/>
		</label>
	{/if}

	<fieldset class="flags">
		<legend>Flags</legend>
		<label title="primary key"
			><input type="checkbox" checked={column.pk} onchange={() => togglePk(column)} />PK</label
		>
		<label title="not null"
			><input
				type="checkbox"
				checked={column.nn || column.pk}
				disabled={column.pk}
				onchange={() => toggleFlag(column, "nn")}
			/>NN</label
		>
		<label title="unique"
			><input type="checkbox" checked={column.ux} onchange={() => toggleFlag(column, "ux")} />UQ</label
		>
		<label title="auto increment"
			><input
				type="checkbox"
				checked={column.ai}
				disabled={!isInt(column.type)}
				onchange={() => toggleFlag(column, "ai")}
			/>AI</label
		>
		<label title="index"
			><input type="checkbox" checked={column.ix} onchange={() => toggleFlag(column, "ix")} />IX</label
		>
	</fieldset>

	<label class="fld">
		<span>FK</span>
		<select class="fk" value={column.ref?.tableId ?? ""} onchange={(e) => setRef(column, e)}>
			<option value="">— none —</option>
			{#each others as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
		</select>
	</label>

	{#if column.ref}
		<label class="fld">
			<span>Cardinality</span>
			<!-- Derived from the flags, never stored: the .sql file has nowhere
			     to keep a cardinality, so this select WRITES ux/nn and reads
			     them back. A sole PK pins the state, so the other options are
			     disabled rather than silently overridden. -->
			<select
				class="card"
				data-testid="cardinality"
				value={cardState ?? ""}
				onchange={(e) => setCardinality(table, column, e.currentTarget.value)}
			>
				{#each CARDINALITY_STATES as s (s.id)}
					<option value={s.id} disabled={!reachable.includes(s.id)}>{s.id}</option>
				{/each}
			</select>
		</label>

		<label class="fld">
			<span>ON DELETE</span>
			<select
				class="act"
				value={column.ref.action ?? "CASCADE"}
				onchange={(e) => setRefAction(column, e)}
			>
				{#each actions as a (a)}<option value={a}>{a}</option>{/each}
			</select>
		</label>

		<label class="fld">
			<span>ON UPDATE</span>
			<select
				class="act"
				data-testid="on-update"
				value={column.ref.onUpdate ?? ""}
				onchange={(e) => setRefOnUpdate(column, e)}
			>
				<option value="">— none —</option>
				{#each actions as a (a)}<option value={a}>{a}</option>{/each}
			</select>
		</label>
	{/if}

	<label class="fld">
		<span>Comment</span>
		<input
			class="cmt"
			placeholder="comment"
			value={column.comment}
			onchange={(e) => commitComment(column, e)}
			spellcheck="false"
		/>
	</label>

	<footer>
		<button class="rmcol" onclick={remove}>Remove column</button>
		<button class="done" onclick={() => dlg.close()}>Done</button>
	</footer>
</dialog>

<style>
	dialog.coledit {
		background: #1a2028;
		color: #d8dee6;
		border: 1px solid #3b4654;
		border-radius: 8px;
		padding: 14px 16px;
		min-width: 300px;
		box-shadow: 0 8px 32px #000a;
	}
	dialog.coledit::backdrop {
		background: #0007;
	}
	h2 {
		margin: 0 0 10px;
		font-size: 13px;
		font-weight: 600;
		color: #9fb0c0;
	}
	.fld {
		display: grid;
		grid-template-columns: 76px 1fr;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
	}
	.fld > span {
		font-size: 11px;
		color: #9fb0c0;
	}
	.fld input,
	.fld select {
		background: #101418;
		color: #d8dee6;
		border: 1px solid #3b4654;
		border-radius: 4px;
		padding: 4px 6px;
		font: 12px ui-monospace, monospace;
		width: 100%;
		box-sizing: border-box;
	}
	.flags {
		display: flex;
		gap: 10px;
		border: 1px solid #3b4654;
		border-radius: 4px;
		margin: 0 0 8px;
		padding: 6px 8px;
	}
	.flags legend {
		font-size: 11px;
		color: #9fb0c0;
		padding: 0 4px;
	}
	.flags label {
		display: flex;
		gap: 4px;
		align-items: center;
		font-size: 11px;
	}
	footer {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
		margin-top: 12px;
	}
	footer button {
		border: 0;
		border-radius: 5px;
		padding: 6px 12px;
		cursor: pointer;
		font: inherit;
	}
	.done {
		background: #2b6cb0;
		color: #fff;
	}
	.rmcol {
		background: transparent;
		color: #f87171;
		margin-right: auto;
	}
	.rmcol:hover {
		background: #2a1a1d;
	}
</style>
