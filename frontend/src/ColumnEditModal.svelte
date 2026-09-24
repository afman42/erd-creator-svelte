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
import { showDialog } from "./dialog.js";
import { baseType, isInt, TYPES } from "./erd.js";
import { cardinalityState } from "./geometry.js";
import { isJunctionTable } from "./relationships.js";
import {
	commitColName,
	commitComment,
	rmColumn,
	setRef,
	setRefAction,
	setRefOnUpdate,
	setType,
	store,
	toggleArray,
	toggleFlag,
	togglePk,
	unsetRef,
} from "./schema.svelte.js";

let { table, column, onClose } = $props();

const actions = ["CASCADE", "RESTRICT", "SET NULL", "SET DEFAULT", "NO ACTION"];
const others = $derived(store.schema.tables.filter((x) => x.id !== table.id));

// The relationship IS this column's FK: target + flags read back through
// cardinality(), so edit = retarget/flags/actions, delete = clear FK (keeps
// column) or Remove column (drops it). Junction members get a hint: dropping
// one FK demotes the table from N:N to a plain child.
//
// relKind reads ux only (UQ → 1:1 else 1:N): a sole PK also pins the child
// end to 0..1 via isUniqueRef, but PK is a column identity, not a type the
// radio should claim — the radio would then read 1:N while the edge says
// 0..1. The legend (cardinalityState) always shows the truth.
const relState = $derived(column.ref ? cardinalityState(table, column) : null);
const relKind = $derived(!column.ref ? null : column.ux ? "1:1" : "1:N");
const inJunction = $derived(isJunctionTable(table, store.schema));

function setRelKind(kind) {
	if (!column.ref) return;
	if ((kind === "1:1") !== column.ux) toggleFlag(column, "ux");
}

/** @type {HTMLDialogElement | null} */
let dlg = $state(null);

// showModal() is imperative, so it cannot be an attribute — see showDialog().
$effect(() => {
	showDialog(dlg);
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
		<fieldset class="rel">
			<legend>Relationship · {relState}</legend>
			<div class="relkinds">
				<label class="relkind" class:on={relKind === "1:N"}>
					<input
						type="radio"
						name="rel-kind-{column.id}"
						checked={relKind === "1:N"}
						onchange={() => setRelKind("1:N")}
						data-testid="rel-kind-1N"
					/>
					<span>1:N</span>
				</label>
				<label class="relkind" class:on={relKind === "1:1"}>
					<input
						type="radio"
						name="rel-kind-{column.id}"
						checked={relKind === "1:1"}
						onchange={() => setRelKind("1:1")}
						data-testid="rel-kind-11"
					/>
					<span>1:1</span>
				</label>
				<button
					type="button"
					class="rmrel"
					onclick={() => unsetRef(column)}
					data-testid="rel-remove"
					title="Delete this relationship (keeps the column)"
				>Remove relationship</button>
			</div>
			{#if inJunction}
				<p class="jhint">Junction member — removing this FK demotes {table.name} from N:N to a plain table.</p>
			{/if}
		</fieldset>
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
		<button class="done" onclick={() => dlg?.close()}>Done</button>
	</footer>
</dialog>

<style>
	dialog.coledit {
		background: var(--color-surface);
		color: var(--color-text);
		border: 1px solid var(--color-border);
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
		color: var(--color-text-muted);
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
		color: var(--color-text-muted);
	}
	.fld input,
	.fld select {
		background: var(--color-bg);
		color: var(--color-text);
		border: 1px solid var(--color-border);
		border-radius: 4px;
		padding: 4px 6px;
		font: 12px ui-monospace, monospace;
		width: 100%;
		box-sizing: border-box;
	}
	.flags {
		display: flex;
		gap: 10px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		margin: 0 0 8px;
		padding: 6px 8px;
	}
	.flags legend {
		font-size: 11px;
		color: var(--color-text-muted);
		padding: 0 4px;
	}
	.flags label {
		display: flex;
		gap: 4px;
		align-items: center;
		font-size: 11px;
	}
	/* Relationship block: the FK's type (UQ flag) + delete for this edge.
	   Same bordered fieldset vocabulary as .flags so it reads as one group. */
	.rel {
		border: 1px solid var(--color-border);
		border-radius: 4px;
		margin: 0 0 8px;
		padding: 6px 8px;
	}
	.rel legend {
		font-size: 11px;
		color: var(--color-text-muted);
		padding: 0 4px;
		font-family: ui-monospace, monospace;
	}
	.relkinds {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.relkind {
		display: flex;
		gap: 4px;
		align-items: center;
		font: 600 11px ui-monospace, monospace;
		color: var(--color-text-muted);
		border: 1px solid var(--color-border);
		border-radius: 4px;
		padding: 3px 8px;
		cursor: pointer;
	}
	.relkind.on {
		border-color: var(--color-primary);
		background: #233448;
		color: #fff;
	}
	.rmrel {
		background: transparent;
		color: var(--color-danger);
		border: 0;
		cursor: pointer;
		font-size: 11px;
		margin-left: auto;
		padding: 3px 6px;
		border-radius: 4px;
	}
	.rmrel:hover {
		background: #2a1a1d;
	}
	.jhint {
		margin: 6px 0 0;
		font-size: 11px;
		color: var(--color-warning);
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
		background: var(--color-primary);
		color: #fff;
	}
	.rmcol {
		background: transparent;
		color: var(--color-danger);
		margin-right: auto;
	}
	.rmcol:hover {
		background: #2a1a1d;
	}
</style>
