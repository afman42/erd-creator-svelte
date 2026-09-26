<script>
let { column, parentName, onEdit } = $props();
</script>

<div class="row">
	<span class="cname" class:pk={column.pk} title={column.name}>{column.name}</span>
	<span class="ty" title={column.type}>{column.type}</span>
	<span class="flags">
		{#if column.pk}<b>PK</b>{/if}
		{#if column.nn || column.pk}<b>NN</b>{/if}
		{#if column.ux}<b>UQ</b>{/if}
		{#if column.ai}<b>AI</b>{/if}
		{#if column.ix}<b>IX</b>{/if}
	</span>
	{#if column.ref}
		<span class="fkinfo" title="→ {parentName ?? '?'}">→{parentName ?? "?"}</span>
	{/if}
	<button class="edit" title="edit column" aria-label="edit {column.name}" onclick={onEdit}>✎</button>
</div>
<div class="cmt" title={column.comment}>{column.comment}</div>

<style>
	.row {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 1px 2px;
		height: 26px;
		box-sizing: border-box;
	}
	.row:hover {
		background: var(--color-surface-hover);
	}
	.row .cname {
		flex: 1 1 auto;
		min-width: 24px;
		font-size: 11px;
		color: var(--color-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row .cname.pk {
		color: var(--color-warning);
		font-weight: 600;
	}
	.row .ty {
		flex: 0 0 auto;
		max-width: 80px;
		font: 9px ui-monospace, monospace;
		color: var(--color-text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row .flags {
		flex: 0 0 auto;
		display: flex;
		gap: 2px;
		font: 8px ui-monospace, monospace;
		color: var(--color-flag);
		max-width: 62px;
		overflow: hidden;
	}
	.row .fkinfo {
		flex: 0 0 auto;
		max-width: 52px;
		font: 9px ui-monospace, monospace;
		color: var(--color-accent);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row .edit {
		flex: 0 0 auto;
		width: 16px;
		box-sizing: border-box;
		background: transparent;
		color: var(--color-text-muted);
		border: 0;
		cursor: pointer;
		font-size: 11px;
		padding: 0;
	}
	.row .edit:hover {
		color: var(--color-focus);
	}
	.row .edit:focus-visible {
		outline: 1px solid var(--color-focus);
		outline-offset: 1px;
	}
	.cmt {
		height: 16px;
		box-sizing: border-box;
		padding: 0 4px;
		font: italic 10px system-ui, sans-serif;
		color: var(--color-text-faint);
		line-height: 16px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
