import { rectsFor } from './layout.js';

const CELL_W = 6;
const CELL_H = 18;
const PAD_X = 8;
const PAD_TOP = 6;

function boxRects(model) {
  const rects = rectsFor(model);
  return model.entities.map(e => ({
    ...e,
    ...rects.get(e.name),
  }));
}

function edgePath(fromR, toR) {
  const fx = fromR.x * CELL_W, fy = fromR.y * CELL_H, fw = fromR.w * CELL_W, fh = fromR.h * CELL_H;
  const tx = toR.x * CELL_W, ty = toR.y * CELL_H, tw = toR.w * CELL_W;
  const fromCx = fx + fw / 2, fromBy = fy + fh;
  const toCx = tx + tw / 2, toTy = ty;
  const midX = (fromCx + toCx) / 2;
  const midY = (fromBy + toTy) / 2;
  return `M ${fromCx},${fromBy} Q ${midX},${midY} ${toCx},${toTy}`;
}

function escXml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function exportSvg(model, cols, rows) {
  const entities = boxRects(model);
  const w = cols * CELL_W;
  const h = rows * CELL_H;

  let maxX = w, maxY = h;
  entities.forEach(e => {
    const pxX = e.x * CELL_W, pxY = e.y * CELL_H, pxW = e.w * CELL_W, pxH = e.h * CELL_H;
    if (pxX + pxW > maxX) maxX = pxX + pxW;
    if (pxY + pxH > maxY) maxY = pxY + pxH;
  });

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX + 4}" height="${maxY + 4}" viewBox="0 0 ${maxX + 4} ${maxY + 4}">\n`;
  svg += `<rect width="100%" height="100%" fill="black"/>\n`;

  // Edges
  model.relationships.forEach(r => {
    const fromE = entities.find(e => e.name === r.from);
    const toE = entities.find(e => e.name === r.to);
    if (fromE && toE) {
      svg += `<path d="${edgePath(fromE, toE)}" stroke="white" fill="none" stroke-width="2"/>\n`;
      const fx = fromE.x * CELL_W, fw = fromE.w * CELL_W;
      const tx = toE.x * CELL_W, tw = toE.w * CELL_W;
      const fy = fromE.y * CELL_H, fh = fromE.h * CELL_H;
      const ty = toE.y * CELL_H;
      const midX = (fx + fw / 2 + tx + tw / 2) / 2;
      const midY = (fy + fh + ty) / 2;
      svg += `<text x="${midX}" y="${midY}" fill="yellow" text-anchor="middle" font-size="12">${r.type}</text>\n`;
    }
  });

  // Entities
  entities.forEach(e => {
    const pxX = e.x * CELL_W, pxY = e.y * CELL_H, pxW = e.w * CELL_W, pxH = e.h * CELL_H;
    svg += `<rect x="${pxX}" y="${pxY}" width="${pxW}" height="${pxH}" fill="black" stroke="cyan" stroke-width="2"/>\n`;
    svg += `<text x="${pxX + PAD_X}" y="${pxY + PAD_TOP + 12}" fill="cyan" font-weight="bold" font-size="13">${escXml(e.name)}</text>\n`;

    e.fields.forEach((f, i) => {
      const fy = pxY + PAD_TOP + 14 + (i + 1) * CELL_H;
      const icon = f.pk ? '*' : (f.unique ? 'u' : '');
      svg += `<text x="${pxX + PAD_X}" y="${fy}" fill="white" font-size="12">${icon} ${escXml(f.name)} ${escXml(f.type)}</text>\n`;
    });

    if (e.todos && e.todos.length > 0) {
      const todoY = pxY + PAD_TOP + 14 + (e.fields.length + 1) * CELL_H + 6;
      svg += `<line x1="${pxX}" y1="${todoY - 4}" x2="${pxX + pxW}" y2="${todoY - 4}" stroke="gray" stroke-width="1"/>\n`;
      svg += `<text x="${pxX + PAD_X}" y="${todoY + 10}" fill="gray" font-size="10">TODO</text>\n`;
      e.todos.forEach((t, i) => {
        const ty = todoY + 24 + i * 14;
        svg += `<text x="${pxX + PAD_X}" y="${ty}" fill="${t.done ? 'green' : 'white'}" font-size="10">${t.done ? '[x]' : '[ ]'} ${escXml(t.text)}</text>\n`;
      });
    }
  });

  svg += '</svg>';
  return svg;
}
