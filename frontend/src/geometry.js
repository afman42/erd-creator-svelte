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

// Total rendered height of a card with nColumns columns.
export function boxHeight(nColumns) {
	return HDR_H + nColumns * ROW_H + ADDCOL_H + BORDER_H;
}

// Vertical distance between the tops of two cards stacked in the same layer:
// one card plus the gap below it.
export function stackStep(nColumns) {
	return boxHeight(nColumns) + GAP;
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
			out.push({
				d: `M ${x1} ${ci} C ${mid} ${ci}, ${mid} ${py}, ${x2} ${py}`,
				self: t.id === p.id,
			});
		}
	return out;
}
