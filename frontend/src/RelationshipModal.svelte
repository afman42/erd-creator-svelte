<script>
// RelationshipModal.svelte — the first-class relationship creator: pick child
// table, parent table and one of the three canonical types (1:1, 1:N — N:N
// arrives with the junction creator) and the matching FK column is appended.
//
// It is a VIEW over createRelationship(): the modal writes no new model state,
// the flags it produces are exactly the ones cardinality() already reads, and
// the .sql round-trip stays faithful because the modal never stores a
// relationship object.
//
// A native <dialog> for the same reasons as ColumnEditModal.svelte: showModal()
// puts it in the top layer, traps focus and wires Escape to cancel.
import {
	EDGE_STROKE,
	LABEL_FILL,
	LABEL_HALO,
	LABEL_HALO_WIDTH,
} from "./geometry.js";
import { previewLabels } from "./relationships.js";
import { addManyToMany, addRelationship, store } from "./schema.svelte.js";

let { onClose } = $props();

const tables = $derived(store.schema.tables);
// Defaults follow the tab order a user would pick: first table as child,
// second as parent. Guarded in case a two-table schema ever shrinks to one
// while the dialog is open. Computed once at init on purpose — the initial
// value is the default, not a live binding.
function defaultSelection() {
	const t = tables;
	return {
		childId: t[0]?.id ?? "",
		parentId: t.length > 1 ? t[1].id : (t[0]?.id ?? ""),
	};
}
let { childId, parentId } = $state(defaultSelection());
let type = $state("1:N");

// Live preview of what Create will draw: derived from the picked type via
// previewLabels() — the same flags the creators write, read back through the
// same vocabulary cardinality() uses. Nothing here mutates; create() does.
const preview = $derived(previewLabels(type));
const childName = $derived(
	tables.find((t) => t.id === childId)?.name ?? "child",
);
const parentName = $derived(
	tables.find((t) => t.id === parentId)?.name ?? "parent",
);
// N:N builds <A>_<B>; show the live name so a collision is visible upfront.
const junctionName = $derived(
	type === "N:N" ? `${childName}_${parentName}` : null,
);

let dlg = $state(null);

$effect(() => {
	if (dlg && !dlg.open) dlg.showModal();
});

// Human description per type, shown under the select so the flags written
// (NOT NULL / UNIQUE / junction) are visible before Create.
const typeDesc = $derived(
	type === "1:1"
		? "One row links to exactly one row — FK is NOT NULL + UNIQUE."
		: type === "N:N"
			? "Builds a junction table with two FKs — two edges."
			: "Many rows link to one row — FK is NOT NULL.",
);

const invalid = $derived(!childId || !parentId || childId === parentId);
// Note: `invalid` drives the hint/title only — Create stays enabled so a
// same-table pick hits the flash-and-stay-open path (e2e pins it).

function swap() {
	const c = childId;
	childId = parentId;
	parentId = c;
}

function create() {
	const ok =
		type === "N:N"
			? addManyToMany(childId, parentId)
			: addRelationship(childId, parentId, type);
	if (ok) onClose();
}
</script>

<dialog bind:this={dlg} onclose={onClose} class="reledit" aria-labelledby="rel-title">
	<h2 id="rel-title">New relationship</h2>
	<p class="sub">Pick the two tables and how they link — the FK is added for you.</p>

	<div class="endpoints">
		<label class="fld">
			<span>{type === "N:N" ? "Table A" : "Child · many"}</span>
			<select data-testid="rel-child" value={childId} onchange={(e) => (childId = e.currentTarget.value)}>
				{#each tables as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
			</select>
			{#if type !== "N:N"}<small>referencing side, gets the FK</small>{/if}
		</label>

		<button
			type="button"
			class="swap"
			onclick={swap}
			title="Swap tables"
			aria-label="Swap child and parent tables"
		>⇅</button>

		<label class="fld">
			<span>{type === "N:N" ? "Table B" : "Parent · one"}</span>
			<select data-testid="rel-parent" value={parentId} onchange={(e) => (parentId = e.currentTarget.value)}>
				{#each tables as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
			</select>
			{#if type !== "N:N"}<small>referenced side</small>{/if}
		</label>
	</div>

	{#if childId === parentId}
		<p class="warnhint" role="alert">Pick two different tables — a table can't reference itself here.</p>
	{/if}

	<fieldset class="types">
		<legend>Type</legend>
		<label class="type" class:on={type === "1:N"}>
			<input
				type="radio"
				name="rel-type"
				value="1:N"
				checked={type === "1:N"}
				onchange={() => (type = "1:N")}
				data-testid="rel-type-1N"
			/>
			<span class="tn">1:N</span>
			<small>one to many</small>
		</label>
		<label class="type" class:on={type === "1:1"}>
			<input
				type="radio"
				name="rel-type"
				value="1:1"
				checked={type === "1:1"}
				onchange={() => (type = "1:1")}
				data-testid="rel-type-11"
			/>
			<span class="tn">1:1</span>
			<small>one to one</small>
		</label>
		<label class="type" class:on={type === "N:N"}>
			<input
				type="radio"
				name="rel-type"
				value="N:N"
				checked={type === "N:N"}
				onchange={() => (type = "N:N")}
				data-testid="rel-type-NN"
			/>
			<span class="tn">N:N</span>
			<small>junction table</small>
		</label>
		<!-- Hidden select keeps the data-testid="rel-type" contract for tests
		     that selectOption("1:1" | "1:N" | "N:N") directly. -->
		<select
			class="sr-only"
			data-testid="rel-type"
			value={type}
			onchange={(e) => (type = e.currentTarget.value)}
			aria-hidden="true"
			tabindex="-1"
		>
			<option value="1:1">1:1 — one to one</option>
			<option value="1:N">1:N — one to many</option>
			<option value="N:N">N:N — many to many (junction table)</option>
		</select>
	</fieldset>
	<p class="typedesc">{typeDesc}</p>

	{#if preview}
		<!-- Live edge-label sample: static curve, live <text> labels in the same
		     paint vocabulary as the canvas (geometry.js constants as presentation
		     attributes, so the sample cannot drift from the real edges). -->
		<div class="preview" data-testid="rel-preview" role="status" aria-live="polite">
			<svg viewBox="0 0 220 44" aria-hidden="true">
				<path
					d="M 10 22 C 80 22, 140 22, 210 22"
					fill="none"
					stroke={EDGE_STROKE}
					stroke-width="2"
				/>
				<text
					x="65"
					y="16"
					fill={LABEL_FILL}
					font-family="ui-monospace, monospace"
					font-size="9"
					text-anchor="middle"
					paint-order="stroke"
					stroke={LABEL_HALO}
					stroke-width={LABEL_HALO_WIDTH}
				>{preview.child}</text>
				<text
					x="155"
					y="16"
					fill={LABEL_FILL}
					font-family="ui-monospace, monospace"
					font-size="9"
					text-anchor="middle"
					paint-order="stroke"
					stroke={LABEL_HALO}
					stroke-width={LABEL_HALO_WIDTH}
				>{preview.parent}</text>
			</svg>
			{#if type === "N:N"}
				<p class="cap" data-testid="rel-preview-caption">
					{childName} {preview.child} · {parentName} {preview.parent} · junction <code>{junctionName}</code> · 2 edges
				</p>
			{:else}
				<p class="cap" data-testid="rel-preview-caption">
					{childName} {preview.child} · {parentName} {preview.parent}
				</p>
			{/if}
		</div>
	{/if}

	<footer class="acts">
		<button class="cancel" onclick={onClose}>Cancel</button>
		<button
			class="create"
			data-testid="rel-create"
			onclick={create}
			title={invalid ? "Pick two different tables" : "Create relationship"}
		>Create</button>
	</footer>
</dialog>

<style>
	dialog.reledit {
		background: var(--color-surface);
		color: var(--color-text);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 14px 16px;
		width: 340px;
		max-width: calc(100vw - 32px);
		box-shadow: 0 8px 32px #000a;
	}
	dialog.reledit::backdrop {
		background: #0007;
	}
	h2 {
		margin: 0;
		font-size: 13px;
		font-weight: 600;
		color: var(--color-text-muted);
	}
	.sub {
		margin: 4px 0 12px;
		font-size: 11px;
		color: var(--color-text-faint);
	}
	/* Two selects side by side with a swap button between them: the flow reads
	   child → parent, and the button flips the direction in one click. */
	.endpoints {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		gap: 8px;
		align-items: start;
	}
	.fld {
		display: grid;
		gap: 4px;
		min-width: 0;
	}
	.fld span {
		font-size: 11px;
		color: var(--color-text-muted);
	}
	.fld small {
		font-size: 10px;
		color: var(--color-text-faint);
	}
	.fld select {
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 4px;
		color: var(--color-text);
		padding: 4px 6px;
		font: 12px ui-monospace, monospace;
		width: 100%;
		box-sizing: border-box;
	}
	.swap {
		margin-top: 20px;
		background: transparent;
		color: var(--color-text-muted);
		border: 1px solid var(--color-border);
		border-radius: 4px;
		cursor: pointer;
		padding: 3px 7px;
		font-size: 13px;
		line-height: 1;
	}
	.swap:hover {
		color: var(--color-text);
		border-color: var(--color-text-faint);
	}
	.warnhint {
		color: var(--color-warning);
		font-size: 11px;
		margin: 8px 0 0;
	}
	/* Segmented type picker: three tappable cards instead of a dropdown, so
	   all options are visible and the active one reads at a glance. */
	.types {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 6px;
		border: 0;
		margin: 12px 0 0;
		padding: 0;
	}
	.types legend {
		font-size: 11px;
		color: var(--color-text-muted);
		padding: 0;
		margin-bottom: 6px;
	}
	.type {
		display: grid;
		justify-items: center;
		gap: 1px;
		padding: 7px 4px 6px;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		cursor: pointer;
		font-size: 11px;
	}
	.type input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.type .tn {
		font: 600 12px ui-monospace, monospace;
		color: var(--color-text-muted);
	}
	.type small {
		font-size: 10px;
		color: var(--color-text-faint);
		text-align: center;
	}
	.type:hover {
		border-color: var(--color-text-faint);
	}
	.type.on {
		border-color: var(--color-primary);
		background: #233448;
	}
	.type.on .tn {
		color: #fff;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	.typedesc {
		margin: 6px 0 0;
		font-size: 11px;
		color: var(--color-text-muted);
	}
	/* Preview sits in its own bordered box so the live edge sample reads as a
	   result, not as another input; the sentence under it names both ends. */
	.preview {
		margin-top: 10px;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		padding: 6px 8px 7px;
		background: var(--color-bg);
	}
	.preview svg {
		display: block;
		width: 100%;
		height: 44px;
	}
	.preview .cap {
		color: var(--color-text-muted);
		font-size: 11px;
		margin: 2px 0 0;
	}
	.preview .cap code {
		font: 11px ui-monospace, monospace;
		color: var(--color-text);
	}
	.acts {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
		margin-top: 12px;
	}
	.acts button {
		border: 0;
		border-radius: 5px;
		padding: 6px 12px;
		cursor: pointer;
		font: inherit;
	}
	.create {
		background: var(--color-primary);
		color: #fff;
	}
	.create:hover {
		background: var(--color-primary-hover);
	}
	.cancel {
		background: transparent;
		color: var(--color-text-muted);
	}
	.cancel:hover {
		color: var(--color-text);
		background: var(--color-surface-hover);
	}
	button:focus-visible,
	select:focus-visible,
	.type:focus-within {
		outline: 1px solid #63b3ed;
		outline-offset: 1px;
	}
</style>