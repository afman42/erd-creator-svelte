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

// Where a cardinality label sits relative to its edge endpoint: pushed outward
// along the edge so it clears the card border, and dropped below the line so it
// does not sit on top of it.
export const LBL_DX = 6;
export const LBL_DY = 9;

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
			if (t.id === p.id) {
				x1 = t.x;
				x2 = t.x + 60;
			} else if (t.x > p.x) {
				x1 = p.x + BOX_W;
				x2 = t.x;
			} else if (t.x + BOX_W < p.x) {
				x1 = t.x + BOX_W;
				x2 = p.x;
			} else {
				x1 = t.x + BOX_W;
				x2 = p.x + BOX_W;
			}
			const mid = (x1 + x2) / 2;
			const { child, parent } = cardinality(t, c);
			// Labels are anchored to the CARD each one describes, not to the
			// path's endpoints. The path picks whichever borders are nearest,
			// so x1 is the parent's border when the child sits to the right —
			// anchoring `child` to x1 drew the "many" symbol on the parent and
			// the "one" on the child, inverting the notation. Measuring from
			// the cards keeps each label with its own table regardless of how
			// the path was routed.
			//
			// facing() returns the border of `from` that looks toward `toward`,
			// plus the direction to push the label (outward, into the gap).
			const childSide = facing(t, p);
			const parentSide = facing(p, t);
			out.push({
				d: `M ${x1} ${ci} C ${mid} ${ci}, ${mid} ${py}, ${x2} ${py}`,
				self: t.id === p.id,
				// child end, beside the FK column's own row
				from: {
					x: childSide.x,
					y: ci + LBL_DY,
					anchor: childSide.anchor,
					text: child,
				},
				// parent end, beside the parent's header
				to: {
					x: parentSide.x,
					y: py + LBL_DY,
					anchor: parentSide.anchor,
					text: parent,
				},
			});
		}
	return out;
}

// facing returns where a label for `from` goes when its edge runs toward
// `toward`: the x of the border it should sit beside, the direction to nudge,
// and which edge of the text to pin there.
//
// The anchor matters. Centring the text on a point LBL_DX from the border still
// overlaps the card, because half the text width reaches back over it — a 22px
// label centred 6px out covers 5px of the card. Pinning the text's NEAR edge
// (start when the label sits to the right, end when it sits to the left) makes
// the clearance independent of the label's width, which is what the offset
// cannot do on its own.
//
// When the two cards share an x range — the default layout stacks new tables
// directly below the last one — there is no facing border to choose, and
// nudging one inward would put the label inside the card. Both then take the
// right border, which is clear of both boxes; they stay apart because they sit
// at different y.
function facing(from, toward) {
	// toward is to the right of from → label sits just right of from's right
	// border, pinned by its left edge so it grows away from the card
	if (from.x + BOX_W <= toward.x) {
		return { x: from.x + BOX_W + LBL_DX, anchor: "start" };
	}
	// toward is to the left → label sits just left of from's left border,
	// pinned by its right edge so it grows away from the card
	if (from.x >= toward.x + BOX_W) {
		return { x: from.x - LBL_DX, anchor: "end" };
	}
	// x ranges overlap (the default stacked layout) → no facing border exists,
	// so both labels take the right side, which is clear of both boxes
	return { x: from.x + BOX_W + LBL_DX, anchor: "start" };
}
