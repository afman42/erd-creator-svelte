<script>
// LintPanel.svelte — docked list of the server's lint findings.
//
// The same strings the toast flashes on an edit, kept visible: store.lint is
// refreshed by the debounced refreshLint after every edit, and this panel is
// a view of it — no new state, no new server round-trip. Each row jumps to
// its table (select + scroll into view), which is the whole point of a list
// the toast cannot offer.
import { setSelected, store } from "./schema.svelte.js";
import { scrollToTable } from "./ui.js";

// Lint messages start "<table>.<column> → …" in every Lint() branch. The
// server returns plain strings (no structured ids), so the table is matched
// by LONGEST table-name prefix before a dot — a first-dot split breaks on
// dotted table names ("a.b.c" would match "a" instead of "a.b").
// Names may contain spaces, so the message text is the only reliable source.
/** @param {string} msg */
function jumpTo(msg) {
	const t = longestTablePrefix(msg);
	if (!t) return;
	scrollToTable(t.id, t.name, setSelected);
}
/** @param {string} msg */
function longestTablePrefix(msg) {
	let best = null;
	for (const t of store.schema.tables) {
		if (msg === t.name || msg.startsWith(`${t.name}.`)) {
			if (!best || t.name.length > best.name.length) best = t;
		}
	}
	return best;
}
</script>

<aside class="lint" aria-label="lint findings">
	<div class="linthead">
		<span data-testid="lint-count">Lint{store.lint.length ? ` (${store.lint.length})` : ""}</span>
		{#if store.lint.length > 0}
			<span class="hint">Click to jump</span>
		{/if}
	</div>
	{#if store.lint.length === 0}
		<p class="clean" data-testid="lint-clean">No issues</p>
	{:else}
		<ul data-testid="lint-list" aria-label="Lint findings list">
			{#each store.lint as msg, i (i)}
				<li>
					<button onclick={() => jumpTo(msg)} aria-label="Jump to table for: {msg}" title="jump to table">
						{msg}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</aside>

<style>
	aside {
		width: 20rem;
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
		font-size: 11px;
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
		font: 11px/1.5 var(--font-mono);
		padding: 6px 10px;
		cursor: pointer;
		min-height: 44px;
		overflow-wrap: anywhere;
	}
	li button:hover {
		outline: 1px solid var(--color-border);
		outline-offset: -1px;
	}
	li button:focus-visible {
		outline: 1px solid var(--color-focus);
		outline-offset: -1px;
	}
</style>