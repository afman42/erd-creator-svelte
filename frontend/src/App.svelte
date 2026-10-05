<script>
import { untrack } from "svelte";
import {
	clampZoom,
	contentSize,
	referencedSet,
	relationshipList,
	structRevision,
	tableNameById,
	VIEW_PAD,
	ZMAX,
	ZMIN,
} from "./canvasView.js";
import EmptyState from "./EmptyState.svelte";
import {
	columnAnchor,
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
	addRelationship,
	addTableAt,
	dupSelected,
	flash,
	redo,
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
import { scrollToTable } from "./ui.js";
import {
	decodeViewState,
	encodeViewState,
	resolveSelectedId,
} from "./urlState.js";

// Deep-link seed: panels, zoom, find text and selection restore from the
// query string on load (?file=&sql&lint&zoom=&q=&sel=). File open happens
// once the file list arrives (schema.svelte owns that fetch); selection by
// NAME resolves then too — ids are session-local, names survive reload.
const initialView = decodeViewState(new URLSearchParams(location.search));
// One-shot guard: the apply effect below must run once when the file list
// lands, not on every files refresh afterwards.
let appliedDeepLink = false;

let showSql = $state(false);
let showRelationship = $state(false);
let showLint = $state(initialView.showLint);
// Canvas zoom (S7): CSS-transform scale on .zoom, clamped 0.25–2. Pinch
// (ctrl+wheel) + buttons + Fit. Local view state — never enters schema/undo.
let zoom = $state(initialView.zoom);
/** @param {number} z */
function setZoom(z) {
	zoom = clampZoom(z);
}
function fitZoom() {
	const n = store.schema.tables.length;
	if (n > 12) setZoom(0.5);
	else if (n > 6) setZoom(0.75);
	else setZoom(1);
	announce = `zoom ${Math.round(zoom * 100)} percent`;
}
// Scrollable area at zoom: transform: scale() never changes layout, so the
// scrollbars cannot see scaled content. The layout box is sized in the markup
// instead — content bounds × zoom + pad — while the transform stays visual.
// contentSize() measures the model bounds (see canvasView.js); the derivation
// splits w/h so Svelte tracks each axis separately.
const contentW = $derived(contentSize(store.schema).w);
const contentH = $derived(contentSize(store.schema).h);
/** @type {{ id: string, x0: number, y0: number, tx0: number, ty0: number, z: number, moved: boolean } | null} */
let drag = $state(null);
// Canvas viewport: read scroll off this instead of ev.currentTarget (Svelte 5
// delegates events, so currentTarget is unreliable in startPan). Assigned by
// the {@attach} on #erd-canvas — an attachment running on mount, not an
// $effect round-trip through bind:this.
/** @type {HTMLElement | null} */
let canvasEl = $state(null);
// The canvas lives for the app's lifetime, so the attachment runs exactly
// once; the $state write is what the read-only handlers subscribe to.
/** @param {HTMLElement} el */
function canvasAttach(el) {
	canvasEl = el;
}
// Empty-canvas pan: press origin + scroll origin; moves scroll, never schema.
/** @type {{ x0: number, y0: number, sl0: number, st0: number, moved: boolean } | null} */
let pan = $state(null);
// Pending drag position, coalesced behind rAF: pointermove fires faster than
// frames, and every x/y write re-runs the $effect tracker (JSON.stringify,
// measured ~4.4ms at 200 tables) + edgePaths + Svelte DOM churn. Writing once
// per frame keeps drag at 60fps instead of compounding per event.
/** @type {{ dx: number, dy: number } | null} */
let dragPending = null;
let dragRaf = 0;
// Fix C: hysteresis memory for edge routing — one Map per session, passed to
// edgePaths so the overlap branch sticks across drag frames instead of
// flipping at the boundary. Not reactive state: geometry reads it, never renders it.
let edgeSticky = new Map();

// <4px = click (select), not a drag/pan
/** @param {{ x0: number, y0: number }} origin @param {PointerEvent} ev */
function pastClickThreshold(origin, ev) {
	return Math.hypot(ev.clientX - origin.x0, ev.clientY - origin.y0) >= 4;
}

function applyDragPending() {
	dragRaf = 0;
	const d = drag;
	if (!d || !dragPending) return;
	const t = store.schema.tables.find((x) => x.id === d.id);
	if (t) {
		t.x = snapCoord(Math.max(0, d.tx0 + dragPending.dx));
		t.y = snapCoord(Math.max(0, d.ty0 + dragPending.dy));
		// Position-only write: bump the local pos state (not struct) so the
		// edge derivation re-runs on the same frame — the mutation alone may
		// not invalidate $derived — while the memoized name/ref maps in
		// canvasView.js stay valid across the whole drag.
		pos++;
	}
	dragPending = null;
}

// Position revision: bumped once per applied drag frame / nudge (see
// applyDragPending + onKey). t.x/t.y are mutated in place, so without an
// explicit subscription the $derived below may render the arrow a frame
// behind the card.
let pos = $state(0);
const edges = $derived.by(() => {
	void pos;
	return edgePaths(store.schema, { sticky: edgeSticky });
});

// Polite announcer for selection/position changes (nudge, drag-drop,
// select): the canvas moves silently otherwise. One string, mirrored into
// the aria-live region below; emptied by nothing — each write re-announces.
let announce = $state("");

// Screen-reader text alternative for the edge SVG (aria-hidden below): one
// "<child>.<col> <childEnd> references <parent> <parentEnd>" string per FK.
// Memoized on the structural revision in canvasView.js — the drag frame bumps
// only the pos revision, so the cached list + name map are reused across
// frames instead of rebuilding per frame. Any structural edit (snap →
// bumpStruct) invalidates via the structRevision() read below.
const relList = $derived.by(() => {
	void structRevision();
	return relationshipList(store.schema);
});
// Hoisted per-schema maps: TableCard used to rebuild both per card per change
// (nameById map + junctionSet scan). One computation here, props below.
// Same struct subscription: renames/flag/FK edits rebuild, drags reuse.
const nameById = $derived.by(() => {
	void structRevision();
	return tableNameById(store.schema);
});
const referenced = $derived.by(() => {
	void structRevision();
	return referencedSet(store.schema);
});

// The SVG paint is applied as presentation attributes (the export-capture
// constraint: html-to-image does not carry the stylesheet), and attributes
// cannot read CSS custom properties — so the palette is picked here from
// geometry.js constants, dark or light per store.theme, and mirrored in
// tokens.css. The test in erd.test.js asserts both themes stay equal.
const dark = $derived(store.theme === "dark");

// store.schema is the single reactive root; deep-change tracker + debounce fan-out.
// showSql read untracked so toggling the panel alone doesn't mark the file dirty.
// touch() schedules debounced lint/save/SQL work — an imperative side channel
// (no $derived can fetch DDL or write storage), so the untrack+touch pair is
// deliberate, not an assignment the autofixer's $derived suggestion applies to.
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

// Warn before tab close with unsaved edits: autosave flushes on pagehide, but
// a save in flight can still fail server-side after the page is gone.
$effect(() => {
	if (!store.dirty || !store.currentFile) return;
	/** @param {BeforeUnloadEvent} e */
	const warn = (e) => e.preventDefault();
	window.addEventListener("beforeunload", warn);
	return () => window.removeEventListener("beforeunload", warn);
});

// URL mirror: panels, zoom, file and selection stay deep-linkable via
// replaceState (no history spam per keystroke/drag frame). Selection writes
// the table NAME — ids are session-local, names survive reload. Find text
// (?q=) is owned by Toolbar's input handler; this effect reads it from the
// URL so the two writers never fight over one param.
// Tracked reactive roots: showSql/showLint/zoom/store.schema/store.selected/
// store.currentFile. untrack() is absent here on purpose — every root above
// must re-fire the mirror when it changes. The mirror writes to the browser
// history (encodeViewState is called for its side effect), so the whole body
// is an imperative sync, not a value that could be $derived.
$effect(() => {
	const selName =
		store.schema.tables.find((t) => t.id === store.selected)?.name ?? "";
	const q = new URLSearchParams(location.search).get("q") ?? "";
	const qs = encodeViewState({
		file: store.currentFile.replace(/\.sql$/, ""),
		showSql,
		showLint,
		zoom,
		query: q,
		sel: selName,
	}).toString();
	const next = qs ? `?${qs}` : location.pathname;
	if (next !== location.pathname + location.search)
		history.replaceState(null, "", next);
});

// Deep-link apply: once the FILE lands, resolve ?sel= (name) to an id and
// select + scroll to it. ?file= is opened by schema.svelte's startup (which
// owns the file list); this effect waits for currentFile (not just the list)
// so the schema is the loaded file — refreshing SQL on the scratch default
// would fetch (and briefly render) the wrong DDL, and the touch effect's
// debounced refresh can land after the real one.
// The showSql write below is the one-shot result of the deep link — a
// conditional initialized here on purpose (opening it at mount would schedule
// a scratch-schema SQL refresh via touch), so it must stay in the guarded
// effect rather than becoming an initializer or a $derived.
$effect(() => {
	const files = store.files;
	if (!files.length || appliedDeepLink || !store.currentFile) return;
	appliedDeepLink = true;
	if (initialView.showSql) {
		showSql = true;
		refreshSql();
	}
	if (initialView.sel) {
		const id = resolveSelectedId(store.schema, initialView.sel);
		if (id) scrollToTable(id, initialView.sel, setSelected);
	}
});

function toggleSql() {
	showSql = !showSql;
	if (showSql) refreshSql();
}

/**
 * @param {import("./erd.js").Table} t
 * @param {PointerEvent} ev
 */
function startDrag(t, ev) {
	// Click-select lives on .hdr (both the select button and the header
	// surface bubble there): the press must always set drag state, or the
	// onUp click-select never fires. Buttons keep their own actions via
	// stopPropagation at their own handlers.
	setSelected(t.id);
	// Pure delta: only the pointer origin and the table's origin matter. The
	// previous form stored the canvas rect and scroll offsets too, but they
	// cancel out of `client - cl + sl - ox`, so they were dead state.
	// z snapshots zoom at press: one screen px is 1/z model px inside .zoom,
	// and a mid-drag zoom step must not shear the in-flight delta.
	drag = {
		id: t.id,
		x0: ev.clientX,
		y0: ev.clientY,
		tx0: t.x,
		ty0: t.y,
		z: zoom,
		moved: false,
	};
	if (!(ev.target instanceof HTMLElement) || !ev.target.closest("input"))
		ev.preventDefault();
}
// Empty-canvas drag pans the viewport, the partner to the layout-box fix:
// zoomed content is reachable by drag, not just scrollbars. Table headers own
// their press (startDrag above — the closest() guard returns here), buttons
// and inputs keep theirs; touch keeps native pan via touch-action, so JS
// stays out and cannot double-scroll.
/** @param {PointerEvent} ev */
function startPan(ev) {
	if (ev.button !== 0 || ev.pointerType === "touch" || !canvasEl) return;
	const el = ev.target instanceof HTMLElement ? ev.target : null;
	if (el?.closest("section.table, dialog, button, input, select, textarea"))
		return;
	pan = {
		x0: ev.clientX,
		y0: ev.clientY,
		sl0: canvasEl.scrollLeft,
		st0: canvasEl.scrollTop,
		moved: false,
	};
	ev.preventDefault();
}
// Double-click empty canvas adds a table at the point. Card/dialog/button/
// input presses are excluded via closest(); the 4px click threshold does not
// apply — dblclick fires only when the press did not drag.
/** @param {MouseEvent} ev */
function onDbl(ev) {
	if (!canvasEl) return;
	const el = ev.target instanceof HTMLElement ? ev.target : null;
	if (el?.closest("section.table, dialog, button, input, select, textarea"))
		return;
	const r = canvasEl.getBoundingClientRect();
	addTableAt(
		(ev.clientX - r.left + canvasEl.scrollLeft) / zoom,
		(ev.clientY - r.top + canvasEl.scrollTop) / zoom,
	);
}
// Connect-drag: pointerdown on a column handle arms { childId, colId },
// moves update the pointer end, pointerup on another card commits a 1:N via
// the existing creator (type inference, naming, single snap all reused).
// Transient view state: never enters the schema or undo. Aborted (Esc /
// empty-canvas release / no movement) → no mutation, no snap.
/** @type {{ childId: string, colId: string, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number } | null} */
let connect = $state(null);
/** Canvas-relative model coords for a client pointer (zoom-aware). @param {PointerEvent} ev */
function toModel(ev) {
	const r = canvasEl?.getBoundingClientRect();
	if (!r || !canvasEl) return { x: 0, y: 0 };
	return {
		x: (ev.clientX - r.left + canvasEl.scrollLeft) / zoom,
		y: (ev.clientY - r.top + canvasEl.scrollTop) / zoom,
	};
}
/** @param {string} childId @param {string} colId @param {PointerEvent} ev */
function beginConnect(childId, colId, ev) {
	if (ev.button !== 0 || !canvasEl) return;
	const t = store.schema.tables.find((x) => x.id === childId);
	if (!t) return;
	const idx = t.columns.findIndex(
		(/** @param {{ id: string }} c */ c) => c.id === colId,
	);
	if (idx < 0) return;
	const a = columnAnchor(t, idx);
	const m = toModel(ev);
	connect = {
		childId,
		colId,
		x0: ev.clientX,
		y0: ev.clientY,
		x1: a.x,
		y1: a.y,
		x2: m.x,
		y2: m.y,
	};
	ev.preventDefault();
}
/** @param {PointerEvent} ev */
function moveConnect(ev) {
	if (!connect || !canvasEl) return;
	const m = toModel(ev);
	connect.x2 = m.x;
	connect.y2 = m.y;
}
/** @param {PointerEvent} ev */
function endConnect(ev) {
	if (!connect) return;
	const c = connect;
	connect = null;
	// Press-and-release without drag must not create an edge when the pointer
	// happens to be over another card — require the 4px click threshold.
	if (!pastClickThreshold({ x0: c.x0, y0: c.y0 }, ev)) return;
	const el = document
		.elementFromPoint(ev.clientX, ev.clientY)
		?.closest("section.table");
	const parentId =
		el instanceof HTMLElement ? (el.dataset.tableId ?? null) : null;
	if (!parentId) return; // dropped on empty canvas: abort, no snap
	if (parentId === c.childId) {
		flash("child and parent must be distinct tables", "err");
		return;
	}
	addRelationship(c.childId, parentId, "1:N");
}
/** @param {PointerEvent} ev */
function onMove(ev) {
	if (connect) {
		moveConnect(ev);
		return;
	}
	if (pan && canvasEl) {
		if (!pan.moved && !pastClickThreshold(pan, ev)) return;
		if (!pan.moved) {
			pan.moved = true;
		}
		canvasEl.scrollLeft = pan.sl0 - (ev.clientX - pan.x0);
		canvasEl.scrollTop = pan.st0 - (ev.clientY - pan.y0);
		return;
	}
	if (!drag) return;
	if (!drag.moved && !pastClickThreshold(drag, ev)) return;
	if (!drag.moved) {
		drag.moved = true;
		// One undo step per drag, snapshot before the first position write so
		// undo restores the pre-drag coordinates.
		snap();
	}
	// Coalesce behind rAF: one reactive write per frame, not per pointer event.
	dragPending = {
		dx: (ev.clientX - drag.x0) / drag.z,
		dy: (ev.clientY - drag.y0) / drag.z,
	};
	if (!dragRaf) dragRaf = requestAnimationFrame(applyDragPending);
	autoscroll(ev);
}
// Viewport follows the pointer near the canvas edge mid-drag, so a card can
// be pushed to (and past) the bottom-right at zoom. Scroll-only: the drag
// delta above is client px minus origin, scroll-independent, so scrolling
// alongside cannot shear the card. Speed ramps with closeness; writes past
// the max clamp, never throw. Immediate, not rAF: scroll writes skip Svelte
// reactivity, so there is nothing to coalesce.
/** @param {PointerEvent} ev */
function autoscroll(ev) {
	if (!canvasEl) return;
	const r = canvasEl.getBoundingClientRect();
	const px = ev.clientX - r.left;
	const py = ev.clientY - r.top;
	if (px < 0 || py < 0 || px > r.width || py > r.height) return;
	const EDGE_PX = 48;
	const MAX_PX = 24;
	/** @param {number} d */
	const near = (d) => (d < EDGE_PX ? MAX_PX * (1 - d / EDGE_PX) : 0);
	canvasEl.scrollLeft += near(r.width - px) - near(px);
	canvasEl.scrollTop += near(r.height - py) - near(py);
}
// Ctrl+wheel = pinch-zoom on the canvas (plain wheel keeps scrolling).
/** @param {WheelEvent} ev */
function onWheel(ev) {
	if (!ev.ctrlKey) return;
	ev.preventDefault();
	setZoom(zoom - Math.sign(ev.deltaY) * 0.1);
}
/** @param {PointerEvent} ev */
function onUp(ev) {
	if (connect) {
		endConnect(ev);
		return;
	}
	if (pan) pan = null;
	if (!drag) return;
	// Fix A: flush the pending frame synchronously so the card and its arrow
	// land together — otherwise the last pointermove's delta is dropped by the
	// cancel and the arrow sits one step off the released card.
	if (dragRaf) {
		cancelAnimationFrame(dragRaf);
		dragRaf = 0;
	}
	applyDragPending();
	const moved = drag.moved;
	const id = drag.id;
	const t = store.schema.tables.find((x) => x.id === id);
	drag = null;
	dragPending = null;
	if (t && !moved) {
		setSelected(t.id);
		announce = `${t.name} selected`;
	} else if (t) {
		announce = `${t.name} moved to ${t.x}, ${t.y}`;
	}
}
// pointercancel (touch takeover, alert, pen) must abort, never commit: clear
// the transient gesture state with no schema write and no snap.
function onCancel() {
	connect = null;
	drag = null;
	dragPending = null;
	pan = null;
}
/** @param {KeyboardEvent} ev */
function onKey(ev) {
	// The column dialog owns the keyboard while it is open. Without this, a
	// focused <button> inside it is not INPUT/SELECT/TEXTAREA, so `editing` is
	// false and Delete would delete the whole TABLE out from under the dialog;
	// Escape would likewise clear the selection on its way to closing it.
	if (document.querySelector("dialog[open]")) return;
	// Delete/Backspace deletes the selected table (S8 split the old
	// role=button header into a real select button + drag surface, so inner
	// focus can no longer fake a selection — the !editing guard is enough).
	const tag = document.activeElement?.tagName ?? "";
	const editing = /INPUT|SELECT|TEXTAREA/.test(tag);
	if ((ev.key === "Delete" || ev.key === "Backspace") && !editing) {
		const t = store.schema.tables.find((x) => x.id === store.selected);
		if (t) rmTable(t);
	} else if (
		(ev.ctrlKey || ev.metaKey) &&
		ev.key.toLowerCase() === "d" &&
		!editing
	) {
		// Ctrl+D duplicates the selected table. preventDefault: the browser
		// bookmark shortcut must not fire. No selection → silent no-op.
		ev.preventDefault();
		dupSelected();
	} else if (
		(ev.ctrlKey || ev.metaKey) &&
		(ev.key.toLowerCase() === "y" ||
			(ev.key.toLowerCase() === "z" && ev.shiftKey)) &&
		!editing
	) {
		// Ctrl+Y / Ctrl+Shift+Z: redo. Checked before plain Ctrl+Z because
		// Shift+Z reports key "Z", which toLowerCase would also match below.
		ev.preventDefault();
		redo();
	} else if (
		(ev.ctrlKey || ev.metaKey) &&
		ev.key.toLowerCase() === "z" &&
		!editing
	) {
		ev.preventDefault();
		undo();
	} else if (ev.key === "Escape") {
		if (connect) connect = null;
		else setSelected(null);
	} else if (
		!editing &&
		["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.key)
	) {
		const t = store.selected
			? store.schema.tables.find((x) => x.id === store.selected)
			: null;
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
			// Position-only write (same as a drag frame): bump pos so the
			// edges re-render, structural memo stays cached.
			pos++;
			announce = `${t.name} moved to ${t.x}, ${t.y}`;
		} else if (!store.selected) {
			// No selection: arrows pan the canvas instead of doing nothing.
			const el = document.querySelector(".canvas");
			if (el) {
				ev.preventDefault();
				const step = ev.shiftKey ? 80 : 40;
				if (ev.key === "ArrowUp") el.scrollTop -= step;
				if (ev.key === "ArrowDown") el.scrollTop += step;
				if (ev.key === "ArrowLeft") el.scrollLeft -= step;
				if (ev.key === "ArrowRight") el.scrollLeft += step;
			}
		}
	}
}
</script>

<svelte:window onpointermove={onMove} onpointerup={onUp} onpointercancel={onCancel} onkeydown={onKey} />

<Toolbar
	showSql={showSql}
	onToggleSql={toggleSql}
	onToggleRelationship={() => (showRelationship = !showRelationship)}
	showLint={showLint}
	onToggleLint={() => (showLint = !showLint)}
	zoom={zoom}
	zoomMin={ZMIN}
	zoomMax={ZMAX}
	onZoomOut={() => setZoom(zoom - 0.25)}
	onZoomIn={() => setZoom(zoom + 0.25)}
	onZoomFit={fitZoom}
/>

<main>
	<a class="skip-link" href="#erd-canvas">Skip to canvas</a>
	<div
		id="erd-canvas"
		tabindex="-1"
		{@attach canvasAttach}
		class={["canvas", drag && "dragging", pan?.moved && "panning"]}
		role="application"
		aria-label="ERD canvas. Drag empty space to pan; arrow keys pan when no table is selected."
		onwheel={onWheel}
		onpointerdown={startPan}
		ondblclick={onDbl}
		style="touch-action: pan-x pan-y pinch-zoom"
	>
		<!-- Inline style= here is a Svelte-compiled el.style.setProperty() call,
		     not a parsed `style` attribute: the CSP is style-src 'self' with
		     no 'unsafe-inline', and that directive governs only static style
		     attributes parsed by the HTML parser — CSSOM writes bypass it.
		     The same holds for TableCard's left/top and download.js's
		     cssText. Moving these to CSS vars would change nothing about the
		     policy; the old comments claiming otherwise are corrected. -->
		<div class="zoom" style="transform: scale({zoom}); width: {contentW * zoom + VIEW_PAD}px; height: {contentH * zoom + VIEW_PAD}px">
		<svg aria-hidden="true">
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
				refX="7"
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
			{#each edges as e (e.key)}
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
								font-size="10" letter-spacing="0.04em"
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
								font-size="10" letter-spacing="0.04em"
								text-anchor={LABEL_ANCHOR}
								paint-order="stroke"
								stroke={dark ? LABEL_HALO : LABEL_HALO_LIGHT}
								stroke-width={LABEL_HALO_WIDTH}
							>{e.to.text}</text>
			{/each}
			{#if connect}
				<line
					x1={connect.x1}
					y1={connect.y1}
					x2={connect.x2}
					y2={connect.y2}
					stroke={dark ? EDGE_STROKE : EDGE_STROKE_LIGHT}
					stroke-width={EDGE_STROKE_WIDTH}
					stroke-dasharray="6 4"
					pointer-events="none"
				/>
			{/if}
 		</svg>
		<!-- Text alternative for the edge SVG above (aria-hidden): screen
		     readers get the same relationships as a list instead of raw
		     path/text nodes. -->
		<ul class="sr-only" aria-label="Relationships">
			{#each relList as r (r)}
				<li>{r}</li>
			{/each}
		</ul>
		{#each store.schema.tables as t (t.id)}
			<TableCard table={t} onDragStart={startDrag} {nameById} {referenced} onConnectStart={beginConnect} onOpenRelationship={() => (showRelationship = true)} />
		{/each}
		{#if store.schema.tables.length === 0}
			<EmptyState />
		{/if}
		</div>
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
	<!-- Polite live region for canvas position/selection changes (S5). -->
	<div class="sr-only" role="status" aria-live="polite">{announce}</div>
	<Toast />

<style>
	:global(body) {
		margin: 0;
		font: 13px system-ui, sans-serif;
		background: var(--color-bg);
		color: var(--color-text);
		touch-action: manipulation;
	}
	main {
		display: flex;
		height: calc(100vh - 41px);
	}
	.skip-link {
		position: absolute;
		left: 8px;
		top: -48px;
		z-index: 60;
		background: var(--color-surface);
		color: var(--color-text);
		border: 1px solid var(--color-focus);
		border-radius: var(--radius-md);
		padding: 8px 12px;
		text-decoration: none;
		transition: transform 150ms var(--ease-out), opacity 150ms var(--ease-out);
	}
	.skip-link:focus-visible {
		transform: translateY(56px);
		outline: 2px solid var(--color-focus);
		outline-offset: 2px;
	}
	/* .sr-only lives in tokens.css (global) — one class, not four copies. */
	.canvas {
		position: relative;
		flex: 1;
		overflow: auto;
		background: radial-gradient(var(--color-dot) 1px, transparent 1px);
		background-size: 20px 20px;
		min-height: 300px;
	}
	.canvas.dragging,
	.canvas.panning {
		user-select: none;
		cursor: grabbing;
	}
	/* Zoom layer: transform-origin top-left so scale grows right/down. The
	   explicit width/height (content bounds × zoom + pad, set inline above)
	   is the layout box the scrollbars see — transform: scale() alone is
	   visual only and never grows the scroll area. min-width/min-height win
	   when content is smaller than the viewport, so empty/small schemas are
	   unaffected. Cards keep absolute px layout. */
	.zoom {
		position: relative;
		transform-origin: 0 0;
		min-width: 100%;
		min-height: 100%;
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
	   straddles the line it describes. Styled via a class so the paint also
	   survives export capture (html-to-image does not carry the stylesheet —
	   the attribute paint above is what actually exports). 10px floor (was
	   9px): glyphs smaller than 10px fail readability regardless of contrast. */
	.card {
		fill: var(--color-text-muted);
		font: 10px ui-monospace, monospace;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.04em;
		text-anchor: middle;
		paint-order: stroke;
		stroke: var(--color-bg);
		stroke-width: 2.5px;
	}
	.self {
		stroke: var(--color-accent);
	}
	/* Modal open animation: fade + scale on every native <dialog>. Close stays
	   instant (an exit animation would need a JS-delayed close). One GLOBAL
	   <style> so every dialog gets it without triplicating the block; Svelte
	   scopes @keyframes by default, so wrap each name in -global- to unmangle.
	   Killed under prefers-reduced-motion. */
	:global(dialog[open]) {
		animation: dialog-in 140ms var(--ease-out);
	}
	:global(dialog[open]::backdrop) {
		animation: backdrop-in 140ms var(--ease-out);
	}
	@keyframes -global-dialog-in {
		from {
			opacity: 0;
			transform: scale(0.96) translateY(4px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
	@keyframes -global-backdrop-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		:global(dialog[open]),
		:global(dialog[open]::backdrop) {
			animation: none;
		}
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