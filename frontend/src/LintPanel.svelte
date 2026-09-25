<script>
// LintPanel.svelte — docked list of the server's lint findings.
//
// The same strings the toast flashes on an edit, kept visible: store.lint is
// refreshed by the debounced refreshLint after every edit, and this panel is
// a view of it — no new state, no new server round-trip. Each row jumps to
// its table (select + scroll into view), which is the whole point of a list
// the toast cannot offer.
import { setSelected, store } from "./schema.svelte.js";

// Lint messages start "<table>.<column> → …" in every Lint() branch. The
// table name is everything before the first dot — names may contain spaces,
// so the message text itself is the only reliable source.
function jumpTo(msg) {
	const dot = msg.indexOf(".");
	if (dot <= 0) return;
	const name = msg.slice(0, dot);
	const t = store.schema.tables.find((x) => x.name === name);
	if (!t) return;
	setSelected(t.id);
	document
		.querySelector(`[aria-label="Table ${CSS.escape(name)}"]`)
		?.scrollIntoView({ block: "center", inline: "center" });
}
</script>

<aside class="lint" aria-label="lint findings">
	<div class="linthead">
		<span data-testid="lint-count">Lint{store.lint.length ? ` (${store.lint.length})` : ""}</span>
		{#if store.lint.length > 0}
			<span class="hint">click to jump</span>
		{/if}
	</div>
	{#if store.lint.length === 0}
		<p class="clean" data-testid="lint-clean">no issues</p>
	{:else}
		<ul data-testid="lint-list">
			{#each store.lint as msg, i (i)}
				<li>
					<button onclick={() => jumpTo(msg)} title="jump to table">
						{msg}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</aside>

<style>
	aside {
		width: 320px;
		border-left: 1px solid var(--color-border-strong);
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.linthead {
		display: flex;
		gap: 8px;
		align-items: center;
		padding: 6px 10px;
		background: var(--color-surface);
		font-size: 12px;
		font-weight: 600;
	}
	.linthead .hint {
		color: var(--color-text-faint);
		font-size: 10px;
		font-weight: 400;
		margin-left: auto;
	}
	.clean {
		margin: 0;
		padding: 10px;
		font-size: 11px;
		color: var(--color-success);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 4px 0;
		overflow: auto;
		flex: 1;
	}
	li + li {
		border-top: 1px solid var(--color-border-strong);
	}
	li button {
		width: 100%;
		text-align: left;
		background: transparent;
		border: 0;
		color: var(--color-warning);
		font: 11px/1.5 ui-monospace, monospace;
		padding: 6px 10px;
		cursor: pointer;
	}
	li button:hover {
		background: var(--color-surface-hover);
	}
	li button:focus-visible {
		outline: 1px solid #63b3ed;
		outline-offset: -1px;
	}
</style>