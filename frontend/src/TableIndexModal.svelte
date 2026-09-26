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
let draft = $state([]);

const indexes = $derived(table.indexes ?? []);
/** @type {HTMLDialogElement | null} */
let dlg = $state(null);

// showModal() is imperative, so it cannot be an attribute — see showDialog().
$effect(() => {
	showDialog(dlg);
});

function toggleDraft(name) {
	draft = draft.includes(name)
		? draft.filter((n) => n !== name)
		: [...draft, name];
}

function create() {
	addIndex(table, draft);
	// Only clear the draft when the index was actually added: addIndex refuses
	// fewer than two columns and flashes, and clearing then would lose the
	// user's selection along with the error they need to read.
	if (indexes.length > 0 && draft.length >= 2) draft = [];
}

// Derived index name, mirroring indexName() in export.go so the dialog shows
// the name the DDL will actually use when none is set explicitly.
function shownName(ix) {
	return ix.name || `idx_${table.name}_${ix.cols.join("_")}`;
}
</script>

<dialog bind:this={dlg} onclose={onClose} class="idxedit">
	<h2>{table.name} · table</h2>

	<!-- The table-level dialog hosts the table comment too: it is the one
	     place a property of the TABLE (not a column) can be edited without
	     crowding the 280px card header. The comment travels to the emitters
	     (mysql/mariadb table option, postgres COMMENT ON TABLE) and is
	     deliberately dropped for SQLite, which has no table comment. -->
	<label class="fld">
		<span>Comment</span>
		<input
			class="tcmt"
			placeholder="table comment"
			value={table.comment ?? ""}
			onchange={(e) => commitTableComment(table, e)}
			spellcheck="false"
		/>
	</label>

	{#if indexes.length === 0}
		<p class="none">No composite indexes. Pick two or more columns below.</p>
	{/if}

	{#each indexes as ix (ix)}
		<div class="ix" data-testid="index-row">
			<label class="fld">
				<span>Name</span>
				<input
					class="ixname"
					value={ix.name ?? ""}
					placeholder={shownName(ix)}
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
			<button class="rmix" onclick={() => rmIndex(table, ix)}>Remove index</button>
		</div>
	{/each}

	<fieldset class="new">
		<legend>New index</legend>
		<div class="picks">
			{#each table.columns as c (c.id)}
				<label title="pick {c.name}"
					><input
						type="checkbox"
						checked={draft.includes(c.name)}
						onchange={() => toggleDraft(c.name)}
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
	dialog.idxedit {
		background: var(--color-surface);
		color: var(--color-text);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 14px 16px;
		min-width: 320px;
		max-width: 460px;
		box-shadow: 0 8px 32px #000a;
	}
	dialog.idxedit::backdrop {
		background: #0007;
	}
	h2 {
		margin: 0 0 10px;
		font-size: 13px;
		font-weight: 600;
		color: var(--color-text-muted);
	}
	.none {
		margin: 0 0 10px;
		font-size: 11px;
		color: var(--color-text-faint);
	}
	.ix {
		border: 1px solid var(--color-border);
		border-radius: 6px;
		padding: 8px;
		margin-bottom: 8px;
	}
	.fld {
		display: grid;
		grid-template-columns: 52px 1fr;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
	}
	.fld > span {
		font-size: 11px;
		color: var(--color-text-muted);
	}
	.fld input {
		background: var(--color-bg);
		color: var(--color-text);
		border: 1px solid var(--color-border);
		border-radius: 4px;
		padding: 4px 6px;
		font: 12px ui-monospace, monospace;
		width: 100%;
		box-sizing: border-box;
	}
	fieldset {
		border: 1px solid var(--color-border);
		border-radius: 4px;
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
	}
	.new {
		border-style: dashed;
	}
	.rmix,
	.mkix {
		border: 0;
		border-radius: 4px;
		padding: 4px 10px;
		cursor: pointer;
		font: 11px inherit;
	}
	.rmix {
		background: #7f1d1d;
		color: #fecaca;
	}
	.mkix {
		background: #2f6f4f;
		color: #d1fae5;
		margin-top: 6px;
	}
	footer {
		display: flex;
		justify-content: flex-end;
		margin-top: 10px;
	}
	.done {
		background: var(--color-primary);
		color: #fff;
		border: 0;
		border-radius: 5px;
		padding: 6px 12px;
		cursor: pointer;
		font: inherit;
	}
	button:focus-visible,
	input:focus-visible {
		outline: 1px solid var(--color-focus);
		outline-offset: 1px;
	}
</style>
