<script>
import { copySql, store } from "./schema.svelte.js";

let sqlLoading = $derived(!store.sqlText);
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
			<div class="sk-line" style="width: 70%"></div>
			<div class="sk-line" style="width: 85%"></div>
			<div class="sk-line" style="width: 60%"></div>
			<div class="sk-line short" style="width: 45%"></div>
		</div>
	{:else}
		<pre aria-live="polite">{store.sqlText}</pre>
	{/if}
</aside>

<style>
	aside {
		width: 420px;
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
		border-radius: 4px;
		padding: 0 5px;
	}
	.sqlhead button {
		margin-left: auto;
		background: var(--color-primary);
		color: #fff;
		border: 0;
		border-radius: 4px;
		padding: 4px 8px;
		cursor: pointer;
		font: inherit;
	}
	.sqlhead button:focus-visible {
		outline: 2px solid #63b3ed;
		outline-offset: 2px;
	}
	pre {
		flex: 1;
		margin: 0;
		padding: 12px;
		overflow: auto;
		font: 12px/1.5 ui-monospace, monospace;
		color: #a5d6ff;
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
		border-radius: 4px;
		animation: pulse 1.4s ease-in-out infinite;
	}
	.sk-line.short {
		height: 10px;
	}
	@keyframes pulse {
		0%, 100% { opacity: 0.5; }
		50% { opacity: 1; }
	}
</style>