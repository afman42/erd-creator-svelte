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
// overlay would have to reimplement. (The old comment here claimed the CSP's
// style-src forbids inline styles on the dialog; corrected: style-src governs
// static style attributes, not the Svelte runtime's CSSOM writes — and this
// modal uses neither. See the note on the .zoom layer in App.svelte.)
import { tick } from "svelte";
import { showDialog } from "./dialog.js";
import { baseType, isInt, TYPES } from "./erd.js";
import { cardinalityState } from "./geometry.js";
import {
	commitColName,
	commitComment,
	commitDefault,
	moveColumn,
	rmColumn,
	setRef,
	setRefAction,
	setRefOnUpdate,
	setType,
	store,
	toggleAi,
	toggleArray,
	toggleFlag,
	togglePk,
	unsetRef,
} from "./schema.svelte.js";

let {
	table,
	column,
	columnIndex = -1,
	columnCount = 0,
	others = [],
	junction = false,
	onClose,
	onAddAnother = null,
} = $props();

const actions = ["CASCADE", "RESTRICT", "SET NULL", "SET DEFAULT", "NO ACTION"];
// FK-target list, move bounds, and junction state arrive as props from
// TableCard/App (hoisted per-schema maps): the old others filter + indexOf
// per keystroke + isJunctionTable full scan re-ran on every render of the
// open modal. Props default so the modal still renders standalone in tests.
// Reordering: the column list order IS the DDL order, so ↑/↓ are real edits.
// null at the edges disables the button (native disabled, not a no-op click).
const canMoveUp = $derived(
	columnIndex >= 0 ? columnIndex > 0 : table.columns.indexOf(column) > 0,
);
const canMoveDown = $derived(
	columnIndex >= 0
		? columnIndex < (columnCount || table.columns.length) - 1
		: table.columns.indexOf(column) < table.columns.length - 1,
);

// The relationship IS this column's FK: target + flags read back through
// cardinality(), so edit = retarget/flags/actions, delete = clear FK (keeps
// column) or Remove column (drops it). Junction members get a hint: dropping
// one FK demotes the table from N:N to a plain child.
//
// relKindOf reads ux only (UQ → 1:1 else 1:N): a sole PK also pins the child
// end to 0..1 via isUniqueRef, but PK is a column identity, not a type the
// radio should claim — the radio would then read 1:N while the edge says
// 0..1. The legend (cardinalityState) always shows the truth.
/** @param {{ ref: unknown, ux: boolean }} col */
function relKindOf(col) {
	if (!col.ref) return null;
	return col.ux ? "1:1" : "1:N";
}
const relState = $derived(column.ref ? cardinalityState(table, column) : null);
const relKind = $derived(relKindOf(column));

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

// Focus the name field whenever the edited column changes (mount + "Add
// another" switches). Edits never change column.id, so keystrokes do not
// re-trigger — only a column switch does. Desktop fine pointers only: on
// touch the focus would pop the keyboard over the dialog just opened.
$effect(() => {
	void column.id;
	if (!window.matchMedia("(pointer: fine)").matches) return;
	const name = dlg?.querySelector("input.cname");
	if (name instanceof HTMLElement) name.focus();
});

// Inline field-error text (S8): mirrors the toast for empty-name and
// AI+default refusals so the recovery hint sits at the field.
let fieldError = $state("");
/** @param {string} msg */
function setFieldError(msg) {
	fieldError = msg;
	// Keyboard/SR users land on the recovery hint; role=alert alone
	// announces without moving them to the field that needs fixing.
	if (msg)
		tick().then(() => {
			const el = dlg?.querySelector(".ferr");
			if (el instanceof HTMLElement) el.focus();
		});
}
function remove() {
	const id = column.id;
	rmColumn(table, column);
	// rmColumn refuses to empty a table (it flashes instead of removing), so
	// close only when the column is actually gone — otherwise the modal would
	// disappear over an error the user still needs to read.
	if (!table.columns.some((c) => c.id === id)) onClose();
}
</script>

<dialog bind:this={dlg} onclose={onClose} class="modal coledit" aria-labelledby="coledit-title" aria-describedby="coledit-desc">
	<h2 id="coledit-title">{table.name} · column</h2>
	<p id="coledit-desc" class="sr-only">Edit column properties. Press Escape to close without losing changes; edits apply live.</p>
	<!-- Inline field errors (S8): the same failures flash() toasts now also
	     anchor to the field — the toast stays for AT users, the <p> pins the
	     recovery hint where the eye is. Local view state, cleared on close. -->
	{#if fieldError}
		<p class="ferr" role="alert" tabindex="-1">{fieldError}</p>
	{/if}

	<label class="fld">
		<span>Name</span>
		<input
			class="cname"
			name="column-name"
			autocomplete="off"
			value={column.name}
			onchange={(e) => {
				const v = e.currentTarget.value.trim();
				setFieldError(v ? "" : "Name can’t be empty — the old name was kept.");
				commitColName(table, column, e);
			}}
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
			><input type="checkbox" checked={column.pk} onchange={() => togglePk(column)} />PK <small>primary key</small></label
		>
		<label title="not null"
			><input
				type="checkbox"
				checked={column.nn || column.pk}
				disabled={column.pk}
				onchange={() => toggleFlag(column, "nn")}
				/>NN <small>not null</small></label
		>
		<label title="unique"
			><input type="checkbox" checked={column.ux} onchange={() => toggleFlag(column, "ux")} />UQ <small>unique</small></label
		>
		<label title="auto increment"
			><input
				type="checkbox"
				checked={column.ai}
				disabled={!isInt(column.type)}
				onchange={() => toggleAi(column)}
				/>AI <small>auto-inc</small></label
		>
		<label title="index"
			><input type="checkbox" checked={column.ix} onchange={() => toggleFlag(column, "ix")} />IX <small>indexed</small></label
		>
	</fieldset>

		<label class="fld">
			<span>Default</span>
			<input
				class="dflt"
				name="column-default"
				autocomplete="off"
				placeholder="0 · 'x' · CURRENT_TIMESTAMP…"
				value={column.default ?? ""}
			onchange={(e) => {
				const v = e.currentTarget.value.trim();
				setFieldError(v && column.ai ? "An auto-increment column can’t have a default — clear AI first." : "");
					commitDefault(column, e);
				}}
				spellcheck="false"
				title="SQL DEFAULT expression, emitted verbatim after server validation (e.g. 0, 'active', CURRENT_TIMESTAMP, (uuid()))"
			/>
		</label>

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
			{#if junction}
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
			name="column-comment"
			autocomplete="off"
			placeholder="e.g. owner id…"
			value={column.comment}
			onchange={(e) => commitComment(column, e)}
			spellcheck="false"
		/>
	</label>

	<footer>
		<div class="move">
			<button
				class="mvup"
				onclick={() => moveColumn(table, column, -1)}
				disabled={!canMoveUp}
				title="move column up (changes DDL order)"
				aria-label="move column up"
			>↑</button>
			<button
				class="mvdown"
				onclick={() => moveColumn(table, column, 1)}
				disabled={!canMoveDown}
				title="move column down (changes DDL order)"
				aria-label="move column down"
			>↓</button>
		</div>
		{#if onAddAnother}
			<button class="another" onclick={onAddAnother} aria-label="add another column" title="Keep this column and start a new one">Add another</button>
		{/if}
		<button class="rmcol" onclick={remove} title="Remove column (undo with Ctrl+Z)">Remove column</button>
		<button class="done" onclick={() => dlg?.close()}>Done</button>
 	</footer>
</dialog>

<style>
	/* Base skin (bg/border/backdrop/h2/fields/footer) lives in dialog.css —
	   only the coledit width + label-column width stay here. */
	dialog.coledit {
		min-width: 300px;
	}
	.ferr {
		margin: 0 0 8px;
		font-size: 11px;
		color: var(--color-danger);
	}
	.fld {
		grid-template-columns: 76px 1fr;
	}
	.flags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
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
		align-items: baseline;
		font-size: 11px;
		min-height: 44px;
	}
	.flags label small {
		font-size: 10px;
		color: var(--color-text-faint);
	}
	/* Relationship block: the FK's type (UQ flag) + delete for this edge.
	   Same bordered fieldset vocabulary as .flags so it reads as one group. */
	.rel {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		margin: 0 0 8px;
		padding: 6px 8px;
	}
	.rel legend {
		font-size: 11px;
		color: var(--color-text-muted);
		padding: 0 4px;
		font-family: var(--font-mono);
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
		font: 600 11px var(--font-mono);
		color: var(--color-text-muted);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: 3px 8px;
		cursor: pointer;
		min-height: 44px;
	}
	.relkind.on {
		border-color: var(--color-primary);
		background: var(--color-on-bg);
		color: var(--color-on-text);
	}
	.rmrel {
		background: transparent;
		color: var(--color-danger);
		border: 0;
		cursor: pointer;
		font-size: 11px;
		margin-left: auto;
		padding: 3px 6px;
		border-radius: var(--radius-sm);
	}
	.rmrel:hover {
		background: var(--color-danger-hover);
	}
	.jhint {
		margin: 6px 0 0;
		font-size: 11px;
		color: var(--color-warning);
	}
	footer button {
		border: 0;
		border-radius: var(--radius-md);
		padding: 6px 12px;
		cursor: pointer;
		font: inherit;
		min-height: 44px;
	}
	/* ↑/↓ are compact square controls beside the remove button; the footer
	   buttons are otherwise unstyled because they inherit `footer button`.
	   .rmcol's margin-right:auto supplies the push, so .move needs none. */
	footer .move {
		display: flex;
		gap: 4px;
	}
	footer .move button {
		width: 30px;
		padding: 6px 0;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		color: var(--color-text);
	}
	footer .move button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.done {
		background: var(--color-primary);
		color: var(--color-on-primary);
	}
	.done:hover {
		background: var(--color-primary-hover);
	}
	.rmcol {
		background: transparent;
		color: var(--color-danger);
		margin-right: auto;
	}
</style>
