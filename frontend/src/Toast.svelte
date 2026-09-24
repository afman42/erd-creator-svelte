<script>
import { store } from "./schema.svelte.js";

// Renders the flash + lint notices. Reads store.error/errorKind (written by
// flash()) and store.lint; auto-clear timing stays in flash() itself.
// Text interpolation only — server strings are never {@html}.
</script>

<div data-testid="toast" aria-live="off">
	{#if store.error}
		<span
			class={store.errorKind}
			role={store.errorKind === "err" ? "alert" : "status"}
			aria-live={store.errorKind === "err" ? "assertive" : "polite"}>{store.error}</span>
	{/if}
	{#if store.lint.length && !store.error.startsWith("lint:")}
		<span class="warn" role="status" aria-live="polite">lint: {store.lint.join("; ")}</span>
	{/if}
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
		border-radius: 5px;
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
