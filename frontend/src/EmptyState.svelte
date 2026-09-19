<script>
import { addTable } from "./schema.svelte.js";
</script>

<div class="empty" role="status" aria-label="No tables">
	<p class="empty-title">No tables yet</p>
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
		background: #1a2028;
		border: 1px dashed #3b4654;
		border-radius: 8px;
		max-width: 320px;
	}
	.empty-title {
		margin: 0 0 6px;
		font-size: 14px;
		font-weight: 600;
		color: #d8dee6;
	}
	.empty-desc {
		margin: 0 0 14px;
		font-size: 12px;
		color: #9fb0c0;
	}
	.empty-cta {
		background: #2b6cb0;
		color: #fff;
		border: 0;
		border-radius: 5px;
		padding: 6px 14px;
		cursor: pointer;
		font: inherit;
	}
	.empty-cta:hover {
		background: #357ac4;
	}
	.empty-cta:focus-visible {
		outline: 2px solid #63b3ed;
		outline-offset: 2px;
	}
</style>
