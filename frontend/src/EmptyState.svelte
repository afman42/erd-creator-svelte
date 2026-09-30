<script>
import { addTable } from "./schema.svelte.js";
</script>

<div class="empty">
	<h2 class="empty-title">No tables yet</h2>
	<p class="empty-desc">Add your first table to start designing.</p>
	<button class="empty-cta" onclick={addTable} data-testid="empty-add-table">+ Table</button>
</div>

<style>
	.empty {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		text-align: center;
		padding: 24px 32px;
		background: var(--color-surface);
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-xl);
		max-width: 20rem;
	}
	.empty-title {
		margin: 0 0 6px;
		font-size: 14px;
		font-weight: 600;
		color: var(--color-text);
		text-wrap: balance;
	}
	.empty-desc {
		margin: 0 0 14px;
		font-size: 12px;
		color: var(--color-text-muted);
	}
	.empty-cta {
		background: var(--color-primary);
		color: var(--color-on-primary);
		border: 0;
		border-radius: var(--radius-md);
		padding: 6px 14px;
		cursor: pointer;
		font: inherit;
		min-height: 44px;
		min-width: 44px;
	}
	.empty-cta:hover {
		background: var(--color-primary-hover);
	}
	.empty-cta:focus-visible {
		outline: 2px solid var(--color-focus);
		outline-offset: 2px;
	}
</style>
