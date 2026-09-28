<script>
import { copySql, store } from "./schema.svelte.js";

// Loading (fetch in flight) is distinct from empty (fetch ok, zero text):
// the old `!store.sqlText` showed a skeleton for a legitimately empty schema
// and hid it during a slow fetch that still had stale text.
const sqlLoading = $derived(store.sqlLoading && !store.sqlText);
</script>

<aside id="sql-panel" aria-label="SQL preview">
	<div class="sqlhead">
		<span>{store.currentFile || "unsaved"}</span>
		<!-- Names the dialect so the panel is unambiguous now that a file can be
		     written in more than one grammar. -->
		<span class="dialect" data-testid="sql-dialect">{store.schema.dialect}</span>
		<button onclick={copySql} aria-label="Copy SQL to clipboard">copy</button>
	</div>
	{#if sqlLoading}
		<div class="skeleton" aria-busy="true" aria-label="Loading SQL">
			<div class="sk-line w70"></div>
			<div class="sk-line w85"></div>
			<div class="sk-line w60"></div>
			<div class="sk-line short w45"></div>
		</div>
	{:else}
		<!-- aria-live OFF + labelled region: the full dump re-renders on every
		     debounced refresh, and announcing all of it would flood SR users. -->
		<pre role="region" aria-label="SQL preview">{store.sqlText}</pre>
	{/if}
</aside>

<style>
	aside {
		width: 26.25rem;
		border-left: 1px solid var(--color-border-strong);
		display: flex;
		flex-direction: column;
	}
	.sqlhead {
		display: flex;
		gap: 4px;
		align-items: center;
		padding: 6px 8px;
		background: var(--color-surface);
	}
	.sqlhead .dialect {
		color: var(--color-text-muted);
		font-size: 11px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: 0 5px;
	}
	.sqlhead button {
		margin-left: auto;
		background: var(--color-primary);
		color: var(--color-on-primary);
		border: 0;
		border-radius: var(--radius-sm);
		padding: 4px 8px;
		cursor: pointer;
		font: inherit;
		min-height: 44px;
		min-width: 44px;
	}
	.sqlhead button:focus-visible {
		outline: 2px solid var(--color-focus);
		outline-offset: 2px;
	}
	pre {
		flex: 1;
		margin: 0;
		padding: 12px;
		overflow: auto;
		font: 12px/1.5 var(--font-mono);
		/* --color-sql: a SQL-tint blue that stays readable in both themes
		   (tokens.css defines the light value). */
		color: var(--color-sql);
		white-space: pre-wrap;
	}
	.skeleton {
		flex: 1;
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.sk-line {
		height: 12px;
		background: var(--color-border-strong);
		border-radius: var(--radius-sm);
		animation: pulse 1.4s ease-in-out infinite;
	}
	.sk-line.w70 { width: 70%; }
	.sk-line.w85 { width: 85%; }
	.sk-line.w60 { width: 60%; }
	.sk-line.w45 { width: 45%; }
	.sk-line.short {
		height: 10px;
	}
	@keyframes pulse {
		0%, 100% { opacity: 0.5; }
		50% { opacity: 1; }
	}
	@media (prefers-reduced-motion: reduce) {
		.sk-line {
			animation: none;
		}
	}
</style>