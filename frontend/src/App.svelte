<script>
import { untrack } from "svelte";
import { edgePaths } from "./geometry.js";
import SqlPanel from "./SqlPanel.svelte";
import {
	refreshSql,
	rmTable,
	setSelected,
	store,
	touch,
	undo,
} from "./schema.svelte.js";
import TableCard from "./TableCard.svelte";
import Toolbar from "./Toolbar.svelte";

let showSql = $state(false);
let drag = $state(null);

const edges = $derived(edgePaths(store.schema));

// store.schema is the single reactive root; deep-change tracker + debounce fan-out.
// showSql read untracked so toggling the panel alone doesn't mark the file dirty.
$effect(() => {
	void JSON.stringify(store.schema);
	untrack(() => touch(showSql));
});

function toggleSql() {
	showSql = !showSql;
	if (showSql) refreshSql();
}

function startDrag(t, ev) {
	if (ev.target.closest("button")) return;
	// Pure delta: only the pointer origin and the table's origin matter. The
	// previous form stored the canvas rect and scroll offsets too, but they
	// cancel out of `client - cl + sl - ox`, so they were dead state.
	drag = {
		id: t.id,
		x0: ev.clientX,
		y0: ev.clientY,
		tx0: t.x,
		ty0: t.y,
		moved: false,
	};
	if (!ev.target.closest("input")) ev.preventDefault();
}
function onMove(ev) {
	if (!drag) return;
	if (!drag.moved) {
		// <4px = click (select), not a drag
		if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < 4) return;
		drag.moved = true;
	}
	const t = store.schema.tables.find((x) => x.id === drag.id);
	if (t) {
		t.x = Math.max(0, drag.tx0 + ev.clientX - drag.x0);
		t.y = Math.max(0, drag.ty0 + ev.clientY - drag.y0);
	}
}
function onUp() {
	if (!drag) return;
	const moved = drag.moved;
	const t = store.schema.tables.find((x) => x.id === drag.id);
	drag = null;
	if (t && !moved) setSelected(t.id);
}
function onKey(ev) {
	// The column dialog owns the keyboard while it is open. Without this, a
	// focused <button> inside it is not INPUT/SELECT/TEXTAREA, so `editing` is
	// false and Delete would delete the whole TABLE out from under the dialog;
	// Escape would likewise clear the selection on its way to closing it.
	if (document.querySelector("dialog[open]")) return;
	const tag = document.activeElement?.tagName;
	const editing = /INPUT|SELECT|TEXTAREA/.test(tag);
	if ((ev.key === "Delete" || ev.key === "Backspace") && !editing) {
		const t = store.schema.tables.find((x) => x.id === store.selected);
		if (t) rmTable(t);
	} else if ((ev.ctrlKey || ev.metaKey) && ev.key === "z" && !editing) {
		ev.preventDefault();
		undo();
	} else if (ev.key === "Escape") setSelected(null);
}
</script>

<svelte:window onpointermove={onMove} onpointerup={onUp} onkeydown={onKey} />

<Toolbar showSql={showSql} onToggleSql={toggleSql} />

<main>
	<div class="canvas" class:dragging={!!drag}>
		<svg>
			<defs>
				<marker
					id="crow"
					viewBox="0 0 10 10"
					refX="9"
					refY="5"
					markerWidth="7"
					markerHeight="7"
					orient="auto-start-reverse"
				>
					<path d="M 0 0 L 10 5 L 0 10" fill="none" stroke="#888" />
				</marker>
			</defs>
			{#each edges as e}
				<path
					d={e.d}
					class={e.self ? "edge self" : "edge"}
					marker-end="url(#crow)"
				/>
			{/each}
		</svg>
		{#each store.schema.tables as t (t.id)}
			<TableCard table={t} onDragStart={startDrag} />
		{/each}
	</div>

	{#if showSql}
		<SqlPanel />
	{/if}
</main>

<style>
	:global(body) {
		margin: 0;
		font: 13px system-ui, sans-serif;
		background: #101418;
		color: #d8dee6;
	}
	main {
		display: flex;
		height: calc(100vh - 41px);
	}
	.canvas {
		position: relative;
		flex: 1;
		overflow: auto;
		background: radial-gradient(#232b35 1px, transparent 1px);
		background-size: 20px 20px;
	}
	.canvas.dragging {
		user-select: none;
		cursor: grabbing;
	}
	.canvas svg {
		position: absolute;
		inset: 0;
		width: 200%;
		height: 200%;
		pointer-events: none;
	}
	.edge {
		fill: none;
		stroke: #888;
		stroke-width: 1.5;
	}
	.self {
		stroke: #bb5588;
	}
</style>