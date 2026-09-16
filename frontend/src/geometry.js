// geometry.js — canvas box metrics + FK edge paths (pure, testable).
export const ROW_H = 42; // 26px column row + 16px comment line
export const HDR_H = 28;
export const BOX_W = 280;

export function edgePaths(schema) {
	const out = [];
	for (const t of schema.tables)
		for (let i = 0; i < t.columns.length; i++) {
			const c = t.columns[i];
			const p = c.ref && schema.tables.find((x) => x.id === c.ref.tableId);
			if (!p) continue;
			const ci = t.y + HDR_H + i * ROW_H + 13;
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
