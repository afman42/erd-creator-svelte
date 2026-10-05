<script>
let {
	column,
	parentName,
	onEdit,
	tableId = null,
	onConnectStart = null,
	onOpenRelationship = null,
} = $props();
</script>

<div class="row">
	<span class={["cname", column.pk && "pk"]} title={column.name || undefined}>{column.name}</span>
	<span class="ty" title={column.type || undefined}>{column.type}</span>
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
	{#if onConnectStart}
		<button
			class="conn"
			title="drag to another table to wire a 1:N foreign key"
			aria-label="connect {column.name} to another table"
			data-testid="connect-handle"
			onpointerdown={(e) => onConnectStart?.(tableId, column.id, e)}
			onkeydown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onOpenRelationship?.();
				}
			}}
		>⤳</button>
	{/if}
	<button class="edit" title="edit column" aria-label="edit {column.name}" onclick={onEdit}>✎</button>
</div>
<div class="cmt" title={column.comment || undefined}>{column.comment}</div>

<style>
	.row {
		position: relative;
		display: flex;
		align-items: center;
		/* gap 2px: the 44px ✎ (S4) added 28px to the row budget, pushing the
		   widest row 2px past BOX_W — the BOX_W fit test caught it. Gap is the
		   only free variable: widths are data-driven, heights pin geometry. */
		gap: 2px;
		padding: 1px 2px;
		height: var(--card-row);
		box-sizing: border-box;
	}
	.row .conn {
		position: absolute;
		left: 0;
		top: 50%;
		transform: translateY(-50%);
		opacity: 0;
		pointer-events: none;
		width: 44px;
		height: 44px;
		margin: -9px 0 -9px -2px;
		background: var(--color-surface);
		color: var(--color-flag);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		cursor: grab;
		font-size: 14px;
		padding: 0;
	}
	.row:hover .conn,
	.row:focus-within .conn,
	.row .conn:focus-visible {
		opacity: 1;
		pointer-events: auto;
	}
	.row .conn:focus-visible {
		outline: 1px solid var(--color-focus);
		outline-offset: 1px;
	}
	.row:hover {
		outline: 1px solid var(--color-border);
		outline-offset: -1px;
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
		font: 10px var(--font-mono);
		color: var(--color-text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row .flags {
		flex: 0 0 auto;
		display: flex;
		gap: 2px;
		font: 10px var(--font-mono);
		color: var(--color-flag);
		max-width: 62px;
		overflow: hidden;
	}
	.row .fkinfo {
		flex: 0 0 auto;
		max-width: 52px;
		font: 10px var(--font-mono);
		color: var(--color-accent);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row .edit {
		flex: 0 0 auto;
		/* 44px touch target that does NOT move the 26px height model: the
		   button overflows the row vertically (negative margin), so ROW_H,
		   boxHeight() and every FK anchor in geometry.js are untouched. */
		width: 44px;
		height: 44px;
		margin: -9px -2px -9px 0;
		box-sizing: border-box;
		background: transparent;
		color: var(--color-text-muted);
		border: 0;
		cursor: pointer;
		font-size: 14px;
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
		height: var(--card-cmt);
		box-sizing: border-box;
		padding: 0 4px;
		font: italic 10px system-ui, sans-serif;
		color: var(--color-text-faint);
		line-height: var(--card-cmt);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
