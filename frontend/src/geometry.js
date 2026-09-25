// geometry.js — canvas box metrics + FK edge paths (pure, testable).
//
// This module is the single source of truth for how big a table card is. The
// numbers are consumed in three places that must agree, or the UI breaks in
// ways that are easy to miss:
//
//   - TableCard.svelte's CSS sizes the real box (checked against these
//     constants in test/erd.test.js, so the CSS cannot silently drift)
//   - erd.js's layout() and schema.svelte.js's addTable() stack cards using
//     boxHeight()/stackStep() rather than re-deriving the arithmetic
//   - edgePaths() anchors FK curves to the row centres
//
// The arithmetic used to be open-coded in both callers: layout() added
// `24 + GAP` and addTable() a bare `36`, which happen to agree (24+12=36) but
// both fall 3px short of the real card — the footer plus borders are 27px, not
// 24. Cards were therefore stacked 3px tighter than intended, and the number
// was unverifiable from either call site. Anything that needs a card's size
// should call boxHeight() instead of open-coding the sum.

/**
 * Type shorthands for the core shapes. The shapes are defined once in erd.js
 * (the client model's home); geometry.js consumes them.
 * @typedef {import("./erd.js").Table} Table
 * @typedef {import("./erd.js").Column} Column
 * @typedef {import("./erd.js").Schema} Schema
 */

export const HDR_H = 28; // .hdr height
export const ROW_H = 42; // .row (26px) + .cmt (16px) per column
export const ADDCOL_H = 25; // .addcol ("+ column") footer
export const BORDER_H = 2; // section.table border: 1px top + 1px bottom
export const BOX_W = 280; // section.table width
export const GAP = 12; // vertical gap between cards stacked in a layer

// Layout origin: where the first card of each layer column starts. Both
// erd.js's layout() and schema.svelte.js's addTable() used to open-code 40,
// so the two callers could diverge (and one did, before stackStep()).
export const CANVAS_ORIGIN = { x: 40, y: 40 };
// How far a duplicated card is offset from its source. Was open-coded as
// `+ 30` in dupTable; hoisted so the offset is a documented constant.
export const DUP_OFFSET = 30;
// X distance between layout layers (one table per layer). Was local to
// layout(); hoisted so placement arithmetic lives beside the other metrics.
export const COL_W = 340;

// Nudge/move step shared by every mover of cards in App.svelte. This was
// re-typed as a bare literal in the arrow-key handler; hoisted so the step has
// one owner and the two keys (plain/shift) cannot drift.
export const NUDGE_STEP = 10; // arrow-key nudge per press (shift = 2x)
export const NUDGE_STEP_FAST = NUDGE_STEP * 2;

// snapCoord rounds a card coordinate to a whole pixel. Cards are placed,
// dragged and nudged in pointer units where sub-pixel deltas are common
// (high-DPI mice, touch). Leaving a fractional position makes the saved .sql
// and the export carry x/y decimals the Go model does not intend, so the final
// position is snapped on the way in.
/**
 * @param {number} v
 * @returns {number}
 */
export function snapCoord(v) {
	return Math.round(v);
}

// Half a row: where an FK edge attaches inside its column row. ROW_H covers the
// row plus its comment line, so the anchor is half the *row*, not half ROW_H.
export const ROW_CENTER = 13;

// Where a cardinality label sits along its edge, as a fraction of the curve
// from the child end (0) to the parent end (1). Labels sit ON the line near
// each end rather than beside a card border: beside-the-border placement left
// them floating in empty space whenever the curve was not next to a card, and
// the line itself is what the symbol describes.
//
// The fractions are 0.25/0.75 rather than closer to the ends for a measured
// reason: every FK into one table terminates at the same point (its header
// centre), so two such edges converge as they approach it and their parent-end
// labels collide. At 0.82 two labels landed 9px apart with 10px-tall text —
// overlapping. Pulling them back to 0.75 uses the part of the curve where the
// edges are still apart, measured at 17px for the same fixture.
export const LBL_T_CHILD = 0.25;
export const LBL_T_PARENT = 0.75;

// How far an edge bows out when the two cards overlap in x. In the default
// layout every card shares an x range, so the curve degenerated to a vertical
// line exactly on the card border — invisible, with its labels adrift. Bowing
// it clear of the cards is what makes the edge visible at all.
export const EDGE_BOW = 30;

// How far apart two edges between the SAME pair of tables are offset. Without
// it they route to identical coordinates and paint one line on top of itself,
// so a reciprocal FK pair showed a single arrowhead and two sets of cardinality
// labels stacked at each end.
//
// The offset is applied to the control points, so it reaches the labels
// ATTENUATED: a label sits at t=0.25/0.75, where the cubic's x contribution
// from the control points is 3(1-t)²t + 3(1-t)t² = 0.5625. A lane of L
// therefore separates two labels by only 0.5625·L, not L — which is what made
// a first attempt at 22px leave the labels 12.4px apart and still overlapping.
//
// The minimum is LABEL_W / 0.5625. LABEL_W is a measured 21.609px (the
// cardinality labels are always four characters — "0..1", "0..N", "1..1" — in
// the monospace face), so 38.4px is the threshold and 44px gives 24.75px
// centre-to-centre, i.e. 3.1px of clear space between the boxes. That is the
// whole margin and it is enough, because the label width is fixed.
export const EDGE_LANE = 44;

// Total rendered height of a card with nColumns columns.
/**
 * @param {number} nColumns
 * @returns {number}
 */
export function boxHeight(nColumns) {
	return HDR_H + nColumns * ROW_H + ADDCOL_H + BORDER_H;
}

// ---- SVG presentation values for edges and their labels ----
//
// These are applied as PRESENTATION ATTRIBUTES on the SVG elements, not as CSS
// classes, because html-to-image does not carry the stylesheet into an export:
// the exported document has no <style> element and no `.edge` rule, so anything
// styled only by a class loses its paint and renders invisible. Measured before
// the change: a PNG sampled at the curve and at both cardinality labels returned
// the background colour (rgb(16,20,24)) at every point — the line and labels
// were simply not drawn. The crow's-foot arrowhead was visible throughout
// because it was the one element already styled by an attribute, which is what
// identified the cause.
//
// The values mirror tokens.css. They are duplicated rather than referenced
// through var() because a CSS custom property does not resolve in the exported
// document either — so the duplication is load-bearing, and a test asserts these
// stay equal to the tokens so the two cannot drift apart.
export const EDGE_STROKE = "#7fa3c0"; // = --color-edge
export const EDGE_STROKE_WIDTH = 2;
export const EDGE_SELF_STROKE = "#bb5588"; // = --color-accent, for self-loops
export const LABEL_FILL = "#9fb0c0"; // = --color-text-muted
export const LABEL_HALO = "#101418"; // = --color-bg, so the line does not cut the text
export const LABEL_HALO_WIDTH = 2.5;
// font-family/font-size are set as separate attributes rather than a font
// shorthand, because SVG presentation attributes have no `font` shorthand.
export const LABEL_ANCHOR = "middle";

// Light-theme twins of the four paint constants above. The SVG paint is
// applied as presentation ATTRIBUTES in App.svelte, and attributes cannot
// read CSS custom properties — so each theme's palette lives twice: here and
// in tokens.css (:root vs [data-theme="light"]). App.svelte picks by
// store.theme; the equality test in erd.test.js asserts all eight stay
// equal. LABEL_HALO_LIGHT is white because --color-bg is white there.
export const EDGE_STROKE_LIGHT = "#5b83a5"; // [data-theme=light] --color-edge
export const EDGE_SELF_STROKE_LIGHT = "#a94d7a"; // --color-accent (light)
export const LABEL_FILL_LIGHT = "#4a5a6a"; // --color-text-muted (light)
export const LABEL_HALO_LIGHT = "#ffffff"; // --color-bg (light)

// Vertical distance between the tops of two cards stacked in the same layer:
// one card plus the gap below it.
/**
 * @param {number} nColumns
 * @returns {number}
 */
export function stackStep(nColumns) {
	return boxHeight(nColumns) + GAP;
}

// cardinality derives the min-max notation for an FK edge, in the standard
// "min..max" form (0..1, 1..1, 0..N).
//
// It is DERIVED from flags the model already has, not authored. That is the
// whole design: a stored cardinality field would be a second source of truth
// that could contradict the flags, and it would have to round-trip through the
// .sql file, which stores no such thing. Deriving means no model change, no
// format change, and no way for the diagram to disagree with the DDL.
//
// Three of the four numbers are derivable. The fourth is not, and deliberately
// so:
//
//   child max  — is this reference unique? UQ, or a SOLE primary key. A
//                composite-PK member is NOT unique on its own: in a junction
//                table PK(a, b), each column repeats freely, which is exactly
//                why it is M:N. Treating `pk` as unique would label every
//                junction table 0..1 and invert the meaning of the notation.
//   parent min — 1 when the column is NOT NULL, else 0. Note this reads
//                `nn || pk`, NOT `nn` alone: every emitter writes " NOT NULL"
//                for a primary key regardless of the nn flag (export.go, the
//                `c.Nn || c.Pk` guards), so a column parsed from a hand-written
//                file as `pk=true, nn=false` emits NOT NULL while the old check
//                read it as optional — the diagram said 0..1 where the DDL said
//                1..1. The label must follow what is actually emitted.
//   parent max — always 1: an FK is a scalar column reference, so a child row
//                can never point at more than one parent row.
//   child min  — ALWAYS 0, and this is not a gap in the implementation. SQL
//                cannot express "every parent must have at least one child";
//                there is no constraint for it. Printing 1..N would assert
//                something the database does not and cannot enforce, so the
//                honest reading is 0..N.
//
// t is the child (FK-holding) table, c the FK column.
/**
 * @param {import("./erd.js").Table} t
 * @param {import("./erd.js").Column} c
 * @returns {{ child: "0..1"|"0..N", parent: "0..1"|"1..1" }}
 */
export function cardinality(t, c) {
	// A sole PK is unique; a composite-PK member is not.
	const unique = isUniqueRef(t, c);
	// nn || pk, because that is what the emitters write — see above.
	const required = !!(c.nn || c.pk);
	return {
		child: unique ? "0..1" : "0..N",
		parent: required ? "1..1" : "0..1",
	};
}

// isSolePk: a sole primary key is unique, pinning the CHILD end to 0..1.
/**
 * @param {import("./erd.js").Table} t
 * @param {import("./erd.js").Column} c
 * @returns {boolean}
 */
export function isSolePk(t, c) {
	return !!c.pk && t.columns.filter((x) => x.pk).length === 1;
}

// isUniqueRef reports whether an FK column references at most one row.
//
// A UQ column is unique. A SOLE primary key is too. A COMPOSITE-PK member is
// NOT: in a junction table PK(a, b) each column repeats freely, which is
// exactly why it is M:N — reading `pk` alone as unique would label every
// junction table 0..1 and invert the notation.
/**
 * @param {import("./erd.js").Table} t
 * @param {import("./erd.js").Column} c
 * @returns {boolean}
 */
export function isUniqueRef(t, c) {
	return !!(c.ux || isSolePk(t, c));
}

// The four cardinality states a relationship can actually be in.
//
// Only four: the child minimum is always 0 (SQL cannot enforce a minimum on the
// parent side), and the parent maximum is always 1 (an FK is a scalar
// reference). So the state is fully described by (child max, parent min).
export const CARDINALITY_STATES = [
	{ id: "0..N / 0..1", child: "0..N", parent: "0..1" },
	{ id: "0..N / 1..1", child: "0..N", parent: "1..1" },
	{ id: "0..1 / 0..1", child: "0..1", parent: "0..1" },
	{ id: "0..1 / 1..1", child: "0..1", parent: "1..1" },
];

// The PK constraint, kept as documentation of the single rule the flags obey:
// every emitter writes NOT NULL for a primary key regardless of the nn flag
// (export.go's `c.Nn || c.Pk` guards), so a PK column's PARENT end is always
// 1..1; a SOLE PK is unique, pinning its CHILD end to 0..1. A composite-PK
// member keeps a free child end (toggled by ux — what makes junctions
// expressible). The RelationshipModal writes these flags at creation;
// the flag checkboxes in ColumnEditModal steer them afterwards.

// cardinalityState returns the id of the state a column is currently in.
// Kept: the RelationshipModal preview and edge labels read through it.
/**
 * @param {import("./erd.js").Table} t
 * @param {import("./erd.js").Column} c
 * @returns {?string}
 */
export function cardinalityState(t, c) {
	const { child, parent } = cardinality(t, c);
	const found = CARDINALITY_STATES.find(
		(s) => s.child === child && s.parent === parent,
	);
	return found ? found.id : null;
}

/**
 * @param {{ tables: import("./erd.js").Table[] }} schema
 * @returns {Array<{d: string, self: boolean, arrowAtStart: boolean, from: {x: number, y: number, dy: number, text: string}, to: {x: number, y: number, dy: number, text: string}}>}
 */
export function edgePaths(schema) {
	// Edges are ROUTED first and drawn second, because the lane an edge takes
	// depends on how many other edges share its table pair — a fact only known
	// once every edge has been seen.
	//
	// Two edges between the SAME pair of tables (a reciprocal FK pair, or two
	// columns referencing one table) compute identical endpoints whenever their
	// columns sit at the same row index and the cards share a y. They were then
	// drawn as one curve on top of itself: a single visible line, a single
	// visible arrowhead, and two sets of cardinality labels stacked on each
	// other at both ends. Each edge in such a group is offset along its control
	// points so every relationship stays separately visible.
	const routed = [];
	for (const t of schema.tables)
		for (let i = 0; i < t.columns.length; i++) {
			const c = t.columns[i];
			const p = c.ref && schema.tables.find((x) => x.id === c.ref.tableId);
			if (!p) continue;
			const ci = t.y + HDR_H + i * ROW_H + ROW_CENTER;
			const py = p.y + HDR_H / 2;
			let x1, x2;
			// childAtStart records which END OF THE CURVE is at the child's
			// card. The routing starts at the parent's border when the child is
			// to the right, so the child's end is not always the path's start —
			// and placing the child's label by a fixed fraction from the start
			// therefore put it at the parent's end, inverting the notation.
			let childAtStart;
			// Interval overlap, not x equality. Testing `x1 === x2` caught only
			// the exactly-stacked case and missed cards that overlap *partially*
			// — where the side-to-side routing sent the curve straight through
			// both card bodies, putting the labels inside a card.
			const overlapsX = t.x < p.x + BOX_W && p.x < t.x + BOX_W;
			if (t.id === p.id) {
				// Self-reference (e.g. parent_id → same table): a loop out of
				// the right border and back into it. Routing it through the
				// card body, as the old `t.x` → `t.x + 60` did, drew the curve
				// and both labels inside the table.
				x1 = t.x + BOX_W;
				x2 = t.x + BOX_W;
				childAtStart = true;
			} else if (overlapsX) {
				// No facing border exists when the x ranges overlap, so both
				// ends leave from the right of the rightmost card and the curve
				// bows clear of both. This is the general form of the stacked
				// case, which only happened to work because the two borders
				// coincided.
				x1 = Math.max(t.x, p.x) + BOX_W;
				x2 = x1;
				childAtStart = true;
			} else if (t.x > p.x) {
				x1 = p.x + BOX_W; // parent's right border
				x2 = t.x; // child's left border
				childAtStart = false;
			} else {
				x1 = t.x + BOX_W; // child's right border
				x2 = p.x; // parent's left border
				childAtStart = true;
			}
			const { child, parent } = cardinality(t, c);
			// When both ends leave from the same border — the self loop, and
			// any x-overlapping pair — the curve would degenerate to a vertical
			// line lying on that border: invisible, with its labels adrift.
			// Bowing the control points out makes the edge visible and gives the
			// labels a line to sit on.
			const degenerate = x1 === x2;
			routed.push({
				t,
				p,
				ci,
				py,
				x1,
				x2,
				childAtStart,
				degenerate,
				child,
				parent,
			});
		}

	// Group edges that would otherwise be drawn at the SAME coordinates. Two
	// edges collide only when every endpoint agrees — same facing borders, same
	// anchor rows — which is what the signature below captures. Grouping by
	// table pair alone would also spread edges that are already distinct: two
	// FKs from one table to one parent (`created_by` / `updated_by` → users) sit
	// on different rows, and offsetting those would move a diagram that was
	// never broken.
	const lanes = new Map();
	for (const r of routed) {
		const key = [r.x1, r.x2, r.ci, r.py].join("|");
		if (!lanes.has(key)) lanes.set(key, []);
		lanes.get(key).push(r);
	}

	const out = [];
	for (const group of lanes.values()) {
		// A single edge needs no lane: offset 0 leaves every existing geometry
		// untouched, so the one-way cases render exactly as before.
		const count = group.length;
		group.forEach((r, lane) => {
			const offset = count === 1 ? 0 : (lane - (count - 1) / 2) * EDGE_LANE;
			const bx = (r.degenerate ? r.x1 + EDGE_BOW : (r.x1 + r.x2) / 2) + offset;
			// The crow's foot belongs at the CHILD end — the many side of the
			// relationship, and the card the child-end label describes. The
			// routing starts at the parent's border when the child is to the
			// right, so `marker-end` alone put the arrowhead on the parent for
			// those edges, and it pointed the wrong way whenever a child sat
			// left of its parent. The marker carries
			// `orient="auto-start-reverse"`, so naming the right end is enough;
			// the geometry itself stays untouched.
			const arrowAtStart = r.childAtStart;
			const d = `M ${r.x1} ${r.ci} C ${bx} ${r.ci}, ${bx} ${r.py}, ${r.x2} ${r.py}`;
			// Each label rides the curve at the end nearest its OWN card, so a
			// reader finds the symbol beside the table it describes.
			const tChild = r.childAtStart ? LBL_T_CHILD : LBL_T_PARENT;
			const tParent = r.childAtStart ? LBL_T_PARENT : LBL_T_CHILD;
			out.push({
				d,
				self: r.t.id === r.p.id,
				arrowAtStart,
				from: {
					...pointOnCubic(r.x1, r.ci, bx, r.ci, bx, r.py, r.x2, r.py, tChild),
					text: r.child,
				},
				to: {
					...pointOnCubic(r.x1, r.ci, bx, r.ci, bx, r.py, r.x2, r.py, tParent),
					text: r.parent,
				},
			});
		});
	}
	return out;
}

// pointOnCubic evaluates a cubic Bezier at t ∈ [0,1], given its four control
// points as flat coordinates. Labels are placed with it so they sit on the
// rendered curve rather than near it — the alternative (measuring from a card
// border) put them in empty space whenever the curve was not beside a card.
//
// The control points are passed separately rather than parsed back out of the
// path string: re-parsing would make the label depend on the string format, so
// a change to how `d` is written would silently move the labels.
function pointOnCubic(x0, y0, x1, y1, x2, y2, x3, y3, t) {
	const u = 1 - t;
	const a = u * u * u;
	const b = 3 * u * u * t;
	const cc = 3 * u * t * t;
	const d = t * t * t;
	return {
		x: a * x0 + b * x1 + cc * x2 + d * x3,
		y: a * y0 + b * y1 + cc * y2 + d * y3,
		// labels sit slightly above the line so the stroke does not strike
		// through the text
		dy: -4,
	};
}
