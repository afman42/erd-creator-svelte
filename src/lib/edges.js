// Orthogonal edge routing → cell glyphs. Pure: model+rects in, 2D char grid out.
// ponytail: naive midpoint-Z routing, lines may cross entity boxes (opaque UI
// boxes hide them); upgrade to obstacle-aware routing only if models grow past MVP.

const H = '─', V = '│', NE = '┐', SE = '┘', SW = '└', NW = '┌';

export function edgeGrid(model, rects, cols, rows) {
  const g = new Map(); // Map(y, Map(x, ch))
  const put = (x, y, ch, force) => {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return;
    if (!g.has(y)) g.set(y, new Map());
    const row = g.get(y);
    const prev = row.get(x);
    row.set(x, !force && prev && prev !== ch ? '┼' : ch);
  };

  for (const r of model.relationships) {
    const a = rects.get(r.from), b = rects.get(r.to);
    if (!a || !b) continue;
    const ay = a.y + Math.floor(a.h / 2), by = b.y + Math.floor(b.h / 2);
    let x1, x2;
    if (b.x >= a.x + a.w) { x1 = a.x + a.w; x2 = b.x; }              // b right of a
    else if (a.x >= b.x + b.w) { x1 = a.x - 1; x2 = b.x + b.w - 1; } // b left of a
    else continue; // vertically overlapping boxes: skip (MVP)
    const dir = x2 > x1 ? 1 : -1;
    const hrun = (fx, tx, y) => { for (let x = fx; dir > 0 ? x < tx : x > tx; x += dir) put(x, y, H); };
    const [side, other] = r.type.split(':');

    if (ay === by) {
      hrun(x1, x2, ay);
    } else {
      const mid = x1 + Math.round((x2 - x1) / 2);
      const vy = by > ay ? 1 : -1;
      if (mid === x1) put(x1 + dir, ay, H); else hrun(x1, mid, ay);
      for (let y = ay + vy; vy > 0 ? y < by : y > by; y += vy) put(mid, y, V);
      put(mid, ay, vy > 0 ? (dir > 0 ? NE : NW) : (dir > 0 ? SW : SE));
      put(mid, by, vy > 0 ? SW : SE);
      const d2 = x2 > mid ? 1 : -1;
      for (let x = mid + d2; d2 > 0 ? x < x2 : x > x2; x += d2) put(x, by, H);
    }
    put(x1, ay, side === 'N' ? '3' : '│', true);
    put(x2 - dir, by, other === 'N' ? '3' : '│', true);
  }

  const lines = [];
  for (let y = 0; y < rows; y++) {
    const row = g.get(y);
    if (!row) { lines.push(' '); continue; }
    let s = '';
    for (let x = 0; x < cols; x++) s += row.get(x) ?? ' ';
    lines.push(s.trimEnd() || ' ');
  }
  return lines.join('\n');
}
