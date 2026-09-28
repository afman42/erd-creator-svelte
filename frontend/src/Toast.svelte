<script>
import { store } from "./schema.svelte.js";

// Renders the flash notices (store.notices, written by flash()).
// Queue of max 3: rapid flashes no longer overwrite each other, and the
// `title` gives sighted users the full text the ellipsis truncates (SR
// already gets it via the live region). Lint findings are NOT toasted:
// they live in the Lint panel only. Text interpolation only — server
// strings are never {@html}.
//
// store.error/errorKind stay as the latest-notice mirror so existing
// e2e (getByTestId("toast") text assertions) keeps passing unchanged.
</script>

<div data-testid="toast" aria-live="off">
	{#each store.notices as n (n.id)}
		<span
			class={n.kind}
			title={n.msg}
			role={n.kind === "err" ? "alert" : "status"}
			aria-live={n.kind === "err" ? "assertive" : "polite"}>{n.msg}</span>
	{/each}
</div>

<style>
	div {
		position: fixed;
		right: 12px;
		bottom: 12px;
		z-index: 50;
		display: flex;
		flex-direction: column;
		gap: 6px;
		max-width: min(420px, 90vw);
		pointer-events: none;
	}
	span {
		background: var(--color-surface);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		padding: 8px 12px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.err {
		color: var(--color-danger);
	}
	.ok {
		color: var(--color-success);
	}
	.warn {
		color: var(--color-warning);
	}
</style>
