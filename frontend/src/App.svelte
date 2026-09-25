<script>
import { untrack } from "svelte";
import EmptyState from "./EmptyState.svelte";
import {
	EDGE_SELF_STROKE,
	EDGE_SELF_STROKE_LIGHT,
	EDGE_STROKE,
	EDGE_STROKE_LIGHT,
	EDGE_STROKE_WIDTH,
	edgePaths,
	LABEL_ANCHOR,
	LABEL_FILL,
	LABEL_FILL_LIGHT,
	LABEL_HALO,
	LABEL_HALO_LIGHT,
	LABEL_HALO_WIDTH,
	NUDGE_STEP,
	NUDGE_STEP_FAST,
	snapCoord,
} from "./geometry.js";
import LintPanel from "./LintPanel.svelte";
import RelationshipModal from "./RelationshipModal.svelte";
import SqlPanel from "./SqlPanel.svelte";
import {
	refreshSql,
	rmTable,
	setSelected,
	snap,
	store,
	touch,
	undo,
} from "./schema.svelte.js";
import TableCard from "./TableCard.svelte";
import Toast from "./Toast.svelte";
import Toolbar from "./Toolbar.svelte";

let showSql = $state(false);
let showRelationship = $state(false);
let showLint = $state(false);
/** @type {{ id: string, x0: number, y0: number, tx0: number, ty0: number, moved: boolean } | null} */
let drag = $state(null);
// Pending drag position, coalesced behind rAF: pointermove fires faster than
// frames, and every x/y write re-runs the $effect tracker (JSON.stringify,
// measured ~4.4ms at 200 tables) + edgePaths + Svelte DOM churn. Writing once
// per frame keeps drag at 60fps instead of compounding per event.
let dragPending = null;
let dragRaf = 0;

function applyDragPending() {
	dragRaf = 0;
	if (!drag || !dragPending) return;
	const t = store.schema.tables.find((x) => x.id === drag.id);
	if (t) {
		t.x = snapCoord(Math.max(0, drag.tx0 + dragPending.dx));
		t.y = snapCoord(Math.max(0, drag.ty0 + dragPending.dy));
	}
	dragPending = null;
}

function toggleRelationship() {
	showRelationship = !showRelationship;
}

const edges = $derived(edgePaths(store.schema));

// The SVG paint is applied as presentation attributes (the export-capture
// constraint: html-to-image does not carry the stylesheet), and attributes
// cannot read CSS custom properties — so the palette is picked here from
// geometry.js constants, dark or light per store.theme, and mirrored in
// tokens.css. The test in erd.test.js asserts both themes stay equal.
const dark = $derived(store.theme === "dark");

// store.schema is the single reactive root; deep-change tracker + debounce fan-out.
// showSql read untracked so toggling the panel alone doesn't mark the file dirty.
$effect(() => {
	void JSON.stringify(store.schema);
	untrack(() => touch(showSql));
});

// Apply the theme to <html> (main.js does the pre-mount paint; this keeps it
// in sync on toggle). Theme is UI state — not part of the schema — so it
// never marks the file dirty or enters undo.
$effect(() => {
	document.documentElement.dataset.theme = store.theme;
});

function toggleSql() {
	showSql = !showSql;
	if (showSql) refreshSql();
}

/**
 * @param {import("./erd.js").Table} t
 */
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
		// One undo step per drag, snapshot before the first position write so
		// undo restores the pre-drag coordinates.
		snap();
	}
	// Coalesce behind rAF: one reactive write per frame, not per pointer event.
	dragPending = { dx: ev.clientX - drag.x0, dy: ev.clientY - drag.y0 };
	if (!dragRaf) dragRaf = requestAnimationFrame(applyDragPending);
}
function onUp() {
	if (!drag) return;
	if (dragRaf) {
		cancelAnimationFrame(dragRaf);
		dragRaf = 0;
		applyDragPending();
	}
	const moved = drag.moved;
	const id = drag.id;
	const t = store.schema.tables.find((x) => x.id === id);
	drag = null;
	dragPending = null;
	if (t && !moved) setSelected(t.id);
}
function onKey(ev) {
	// The column dialog owns the keyboard while it is open. Without this, a
	// focused <button> inside it is not INPUT/SELECT/TEXTAREA, so `editing` is
	// false and Delete would delete the whole TABLE out from under the dialog;
	// Escape would likewise clear the selection on its way to closing it.
	if (document.querySelector("dialog[open]")) return;
	const tag = document.activeElement?.tagName ?? "";
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
			// One undo step per nudge press; snapshot before moving so undo
			// restores the pre-nudge position.
			snap();
			const step = ev.shiftKey ? NUDGE_STEP_FAST : NUDGE_STEP;
			if (ev.key === "ArrowUp") t.y = Math.max(0, t.y - step);
			if (ev.key === "ArrowDown") t.y += step;
			if (ev.key === "ArrowLeft") t.x = Math.max(0, t.x - step);
			if (ev.key === "ArrowRight") t.x += step;
		}
	}
}
</script>

<svelte:window onpointermove={onMove} onpointerup={onUp} onkeydown={onKey} />

<Toolbar
	showSql={showSql}
	onToggleSql={toggleSql}
	onToggleRelationship={toggleRelationship}
	showLint={showLint}
	onToggleLint={() => (showLint = !showLint)}
/>

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
										stroke={dark ? EDGE_STROKE : EDGE_STROKE_LIGHT}
										stroke-width="1.8"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
				</marker>
			</defs>
			{#each edges as e}
				<!-- Presentation ATTRIBUTES, not just classes: html-to-image does
				     not carry the stylesheet into the export, so class-only paint
				     is lost and the line renders invisible in PNG/SVG. See the
				     constants in geometry.js. -->
				<path
					d={e.d}
					class={e.self ? "edge self" : "edge"}
					fill="none"
					stroke={e.self ? (dark ? EDGE_SELF_STROKE : EDGE_SELF_STROKE_LIGHT) : (dark ? EDGE_STROKE : EDGE_STROKE_LIGHT)}
					stroke-width={EDGE_STROKE_WIDTH}
					marker-end={e.arrowAtStart ? undefined : "url(#crow)"}
					marker-start={e.arrowAtStart ? "url(#crow)" : undefined}
				/>
				<!-- Min-max cardinality, derived from the column's flags (see
				     cardinality() in geometry.js). The position comes from
				     pointOnCubic(), so each label sits ON its own curve;
				     `dy` lifts it a few px so the stroke does not strike
				     through the text. -->
				<text
								class="card"
								x={e.from.x}
								y={e.from.y + e.from.dy}
								fill={dark ? LABEL_FILL : LABEL_FILL_LIGHT}
								font-family="ui-monospace, monospace"
								font-size="9"
								text-anchor={LABEL_ANCHOR}
								paint-order="stroke"
								stroke={dark ? LABEL_HALO : LABEL_HALO_LIGHT}
								stroke-width={LABEL_HALO_WIDTH}
							>{e.from.text}</text>
				<text
								class="card"
								x={e.to.x}
								y={e.to.y + e.to.dy}
								fill={dark ? LABEL_FILL : LABEL_FILL_LIGHT}
								font-family="ui-monospace, monospace"
								font-size="9"
								text-anchor={LABEL_ANCHOR}
								paint-order="stroke"
								stroke={dark ? LABEL_HALO : LABEL_HALO_LIGHT}
								stroke-width={LABEL_HALO_WIDTH}
							>{e.to.text}</text>
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

	{#if showLint}
		<LintPanel />
	{/if}

	{#if showRelationship}
		<RelationshipModal onClose={() => (showRelationship = false)} />
	{/if}
</main>
<Toast />

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
		background: radial-gradient(var(--color-surface-hover) 1px, transparent 1px);
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
		fill: var(--color-text-muted);
		font: 9px ui-monospace, monospace;
		text-anchor: middle;
		paint-order: stroke;
		stroke: var(--color-bg);
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