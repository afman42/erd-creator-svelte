<script>
import { copySql, store } from "./schema.svelte.js";
</script>

<aside>
	<div class="sqlhead">
		<span>{store.currentFile || "unsaved"}</span>
		<!-- Names the dialect so the panel is unambiguous now that a file can be
		     written in more than one grammar. -->
		<span class="dialect" data-testid="sql-dialect">{store.schema.dialect}</span>
		<button onclick={copySql}>copy</button>
	</div>
	<pre>{store.sqlText}</pre>
</aside>

<style>
	aside {
		width: 420px;
		border-left: 1px solid #2a3340;
		display: flex;
		flex-direction: column;
	}
	.sqlhead {
		display: flex;
		gap: 4px;
		align-items: center;
		padding: 6px 8px;
		background: #1a2028;
	}
	.sqlhead .dialect {
		color: #9fb0c0;
		font-size: 11px;
		border: 1px solid #3b4654;
		border-radius: 4px;
		padding: 0 5px;
	}
	.sqlhead button {
		margin-left: auto;
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
</style>