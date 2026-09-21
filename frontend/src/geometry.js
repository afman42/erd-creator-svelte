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

export const HDR_H = 28; // .hdr height
export const ROW_H = 42; // .row (26px) + .cmt (16px) per column
export const ADDCOL_H = 25; // .addcol ("+ column") footer
export const BORDER_H = 2; // section.table border: 1px top + 1px bottom
export const BOX_W = 280; // section.table width
export const GAP = 12; // vertical gap between cards stacked in a layer

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

// Total rendered height of a card with nColumns columns.
export function boxHeight(nColumns) {
	return HDR_H + nColumns * ROW_H + ADDCOL_H + BORDER_H;
}

// Vertical distance between the tops of two cards stacked in the same layer:
// one card plus the gap below it.
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
//   parent min — 1 when the column is NOT NULL (the reference is mandatory),
//                else 0.
//   parent max — always 1: an FK is a scalar column reference, so a child row
//                can never point at more than one parent row.
//   child min  — ALWAYS 0, and this is not a gap in the implementation. SQL
//                cannot express "every parent must have at least one child";
//                there is no constraint for it. Printing 1..N would assert
//                something the database does not and cannot enforce, so the
//                honest reading is 0..N.
//
// t is the child (FK-holding) table, c the FK column.
export function cardinality(t, c) {
	// A sole PK is unique; a composite-PK member is not.
	const solePk = c.pk && t.columns.filter((x) => x.pk).length === 1;
	const unique = !!(c.ux || solePk);
	return {
		child: unique ? "0..1" : "0..N",
		parent: c.nn ? "1..1" : "0..1",
	};
}

export function edgePaths(schema) {
	const out = [];
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
			if (t.id === p.id) {
				x1 = t.x;
				x2 = t.x + 60;
				childAtStart = true;
			} else if (t.x > p.x) {
				x1 = p.x + BOX_W; // parent's right border
				x2 = t.x; // child's left border
				childAtStart = false;
			} else if (t.x + BOX_W < p.x) {
				x1 = t.x + BOX_W; // child's right border
				x2 = p.x; // parent's left border
				childAtStart = true;
			} else {
				x1 = t.x + BOX_W;
				x2 = p.x + BOX_W;
				childAtStart = true;
			}
			const mid = (x1 + x2) / 2;
			const { child, parent } = cardinality(t, c);
			// When the two cards overlap in x — which is every card in the
			// default stacked layout — x1 and x2 coincide, so the curve would
			// be a vertical line lying exactly on the card border: invisible,
			// with its labels floating in space. Bowing the control points out
			// to one side makes the edge visible and gives the labels a line to
			// sit on.
			const overlaps = x1 === x2;
			const bx = overlaps ? x1 + EDGE_BOW : mid;
			const d = `M ${x1} ${ci} C ${bx} ${ci}, ${bx} ${py}, ${x2} ${py}`;
			// Each label rides the curve at the end nearest its OWN card, so a
			// reader finds the symbol beside the table it describes.
			const tChild = childAtStart ? LBL_T_CHILD : LBL_T_PARENT;
			const tParent = childAtStart ? LBL_T_PARENT : LBL_T_CHILD;
			out.push({
				d,
				self: t.id === p.id,
				from: {
					...pointOnCubic(x1, ci, bx, ci, bx, py, x2, py, tChild),
					text: child,
				},
				to: {
					...pointOnCubic(x1, ci, bx, ci, bx, py, x2, py, tParent),
					text: parent,
				},
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
