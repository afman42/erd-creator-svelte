<script>
// TableIndexModal.svelte — the table's composite indexes.
//
// Composite indexes live here rather than in the card row for the same reason
// the column controls did: the row is a 280px label, and a control that has to
// show a column list does not fit. Putting them in a dialog also keeps
// boxHeight() (geometry.js) unchanged, so no FK edge anchor moves and the
// CSS-drift test does not have to be renegotiated.
//
// A composite index cannot be a Col flag: `ix` says "this column is indexed",
// which cannot express (a, b) as one index — three columns marked ix are three
// separate indexes. So an index is a table-level list, and a one-column index
// deliberately stays on Col.ix. The server routes by arity on the way back in,
// which is what keeps both shapes round-tripping.

import { showDialog } from "./dialog.js";
import {
	addIndex,
	commitTableComment,
	rmIndex,
	setIndexName,
	store,
	toggleIndexCol,
} from "./schema.svelte.js";

let { table, onClose } = $props();

// Columns offered for a new index. The checkboxes below toggle membership of
// the index currently being edited; this draft is only for creation, so a new
// index starts as a selection rather than appearing immediately.
// Keyed by column ID, not name: two columns can share a display name while a
// rename is mid-flight, and addIndex takes names — resolved at create() time.
let draft = $state([]);

const indexes = $derived(table.indexes ?? []);
/** @type {HTMLDialogElement | null} */
let dlg = $state(null);

// showModal() is imperative, so it cannot be an attribute — see showDialog().
$effect(() => {
	showDialog(dlg);
});

function toggleDraft(id) {
	draft = draft.includes(id) ? draft.filter((n) => n !== id) : [...draft, id];
}

function create() {
	// Resolve ids → names at create time (ix.cols are names). Only clear the
	// draft when the index was actually added: addIndex refuses fewer than
	// two columns and flashes, and clearing then would lose the selection
	// along with the error the user needs to read.
	const names = draft
		.map((id) => table.columns.find((c) => c.id === id)?.name)
		.filter(Boolean);
	if (addIndex(table, names)) draft = [];
}

// Derived index name, mirroring indexName() in export.go so the dialog shows
// the name the DDL will actually use when none is set explicitly.
function shownName(ix) {
	return ix.name || `idx_${table.name}_${ix.cols.join("_")}`;
}
</script>

<dialog bind:this={dlg} onclose={onClose} class="modal idxedit" aria-labelledby="idxedit-title" aria-describedby="idxedit-desc">
	<h2 id="idxedit-title">{table.name} · table</h2>
	<p id="idxedit-desc" class="sr-only">Edit the table comment and composite indexes. Press Escape to close.</p>

	<!-- The table-level dialog hosts the table comment too: it is the one
	     place a property of the TABLE (not a column) can be edited without
	     crowding the 280px card header. The comment travels to the emitters
	     (mysql/mariadb table option, postgres COMMENT ON TABLE) and is
	     deliberately dropped for SQLite, which has no table comment. -->
	<label class="fld">
		<span>Comment</span>
		<input
			class="tcmt"
			name="table-comment"
			autocomplete="off"
			placeholder="e.g. users table…"
			value={table.comment ?? ""}
			onchange={(e) => commitTableComment(table, e)}
			spellcheck="false"
		/>
	</label>

	{#if indexes.length === 0}
		<p class="none">No composite indexes. Pick two or more columns below.</p>
	{/if}

	{#each indexes as ix (ix.name ?? ix.cols.join(","))}
		<div class="ix" data-testid="index-row">
			<label class="fld">
				<span>Name</span>
				<input
					class="ixname"
					name="index-name"
					autocomplete="off"
					value={ix.name ?? ""}
					placeholder="{shownName(ix)}…"
					onchange={(e) => setIndexName(ix, e.currentTarget.value)}
					spellcheck="false"
				/>
			</label>
			<fieldset class="cols">
				<legend>Columns</legend>
				{#each table.columns as c (c.id)}
					<label title="include {c.name}"
						><input
							type="checkbox"
							checked={ix.cols.includes(c.name)}
							onchange={() => toggleIndexCol(ix, c.name)}
						/>{c.name}</label
					>
				{/each}
			</fieldset>
			<button class="rmix" onclick={() => rmIndex(table, ix)} title="Remove index (undo with Ctrl+Z)">Remove index</button>
		</div>
	{/each}

	<fieldset class="new">
		<legend>New index</legend>
		<div class="picks">
			{#each table.columns as c (c.id)}
					<label title="pick {c.name}"
						><input
							type="checkbox"
							checked={draft.includes(c.id)}
							onchange={() => toggleDraft(c.id)}
						/>{c.name}</label
					>
			{/each}
		</div>
		<button class="mkix" onclick={create}>Add index</button>
	</fieldset>

	<footer>
		<button class="done" onclick={() => dlg?.close()}>Done</button>
	</footer>
</dialog>

<style>
	/* Base skin in dialog.css — only idxedit width + own layout stay here. */
	dialog.idxedit {
		min-width: 320px;
	}
	.none {
		margin: 0 0 10px;
		font-size: 11px;
		color: var(--color-text-faint);
	}
	.ix {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		padding: 8px;
		margin-bottom: 8px;
	}
	.fld {
		grid-template-columns: 52px 1fr;
	}
	fieldset {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		margin: 0 0 6px;
		padding: 6px 8px;
	}
	legend {
		font-size: 11px;
		color: var(--color-text-muted);
		padding: 0 4px;
	}
	.cols,
	.picks {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}
	.cols label,
	.picks label {
		display: flex;
		gap: 4px;
		align-items: center;
		font-size: 11px;
		min-height: 44px;
	}
	.new {
		border-style: dashed;
	}
	.rmix,
	.mkix {
		border: 0;
		border-radius: var(--radius-sm);
		padding: 4px 10px;
		cursor: pointer;
		font: 11px inherit;
		min-height: 44px;
	}
	.rmix {
		background: var(--color-danger-bg);
		color: var(--color-danger-text);
	}
	.rmix:hover {
		filter: brightness(1.05);
	}
	.mkix {
		background: var(--color-ok-bg);
		color: var(--color-ok-text);
		margin-top: 6px;
	}
	.mkix:hover {
		filter: brightness(1.05);
	}
	.done {
		background: var(--color-primary);
		color: var(--color-on-primary);
		border: 0;
		border-radius: var(--radius-md);
		padding: 6px 12px;
		cursor: pointer;
		font: inherit;
		min-height: 44px;
	}
	.done:hover {
		background: var(--color-primary-hover);
	}
</style>
