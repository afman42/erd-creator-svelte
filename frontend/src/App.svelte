<script>
import { untrack } from "svelte";
import EmptyState from "./EmptyState.svelte";
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
	else if (
		!editing &&
		store.selected &&
		["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.key)
	) {
		const t = store.schema.tables.find((x) => x.id === store.selected);
		if (t) {
			ev.preventDefault();
			const step = ev.shiftKey ? 20 : 10;
			if (ev.key === "ArrowUp") t.y = Math.max(0, t.y - step);
			if (ev.key === "ArrowDown") t.y += step;
			if (ev.key === "ArrowLeft") t.x = Math.max(0, t.x - step);
			if (ev.key === "ArrowRight") t.x += step;
		}
	}
}
</script>

<svelte:window onpointermove={onMove} onpointerup={onUp} onkeydown={onKey} />

<Toolbar showSql={showSql} onToggleSql={toggleSql} />

<main>
	<div class="canvas" class:dragging={!!drag}>
		<svg>
			<defs>
				<!-- The crow's foot ("many") marker.
				     Sized up from 7x7 with an explicit stroke-width. At 7x7 the
				     arrowhead was a hairline chevron a few pixels across: it
				     rendered, but could not be SEEN in an exported PNG (measured
				     at ~6x7px, grey on grey). stroke-width is set here because a
				     marker's contents do NOT inherit the referencing path's
				     stroke-width, so the old marker drew at 1px while its line
				     was 1.5px.

				     The stroke is a concrete colour, not `context-stroke`. That
				     value is the documented way to inherit the referencing
				     path's paint, but it does NOT resolve when the path's stroke
				     comes from a CSS class rather than a presentation attribute
				     — verified: the exported marker kept the literal string
				     `context-stroke` and painted NOTHING, turning a faint arrow
				     into no arrow at all. The line colour is therefore written
				     twice (here and in .edge); the marker test below fails if the
				     two ever disagree. -->
				<marker
					id="crow"
					viewBox="0 0 10 10"
					refX="9"
					refY="5"
					markerWidth="11"
					markerHeight="11"
					orient="auto-start-reverse"
				>
					<path
						d="M 0 0 L 10 5 L 0 10"
						fill="none"
						stroke="#7fa3c0"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</marker>
			</defs>
			{#each edges as e}
				<path
					d={e.d}
					class={e.self ? "edge self" : "edge"}
					marker-end="url(#crow)"
				/>
				<!-- Min-max cardinality, derived from the column's flags (see
				     cardinality() in geometry.js). The position comes from
				     pointOnCubic(), so each label sits ON its own curve;
				     `dy` lifts it a few px so the stroke does not strike
				     through the text. -->
				<text class="card" x={e.from.x} y={e.from.y + e.from.dy}>{e.from.text}</text>
				<text class="card" x={e.to.x} y={e.to.y + e.to.dy}>{e.to.text}</text>
			{/each}
		</svg>
		{#each store.schema.tables as t (t.id)}
			<TableCard table={t} onDragStart={startDrag} />
		{/each}
		{#if store.schema.tables.length === 0}
			<EmptyState />
		{/if}
	</div>

	{#if showSql}
		<SqlPanel />
	{/if}
</main>

<style>
	:global(body) {
		margin: 0;
		font: 13px system-ui, sans-serif;
		background: var(--color-bg);
		color: var(--color-text);
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
		min-height: 300px;
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
		/* --color-edge, not the old #888: that grey was shared with the
		   arrowhead and made the relationship read as faint in an export. */
		stroke: var(--color-edge);
		stroke-width: 2;
	}
	/* Min-max cardinality labels, centred on their curve point so the symbol
	   straddles the line it describes. Styled via a class, not an inline style:
	   the CSP is style-src 'self' and would block the latter. */
	.card {
		fill: #9fb0c0;
		font: 9px ui-monospace, monospace;
		text-anchor: middle;
		paint-order: stroke;
		stroke: #101418;
		stroke-width: 2.5px;
	}
	.self {
		stroke: var(--color-accent);
	}
	@media (max-width: 768px) {
		main {
			flex-direction: column;
			height: auto;
			min-height: calc(100vh - 41px);
		}
		.canvas {
			min-height: 420px;
		}
		:global(aside) {
			width: 100% !important;
			border-left: none !important;
			border-top: 1px solid var(--color-border-strong);
			height: 40vh;
			min-height: 220px;
		}
	}
	@media (max-width: 320px) {
		.canvas {
			background-size: 16px 16px;
		}
	}
</style>