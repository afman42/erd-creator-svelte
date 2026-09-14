// Entity box geometry in cells. Outer w/h include the 1-cell border.

export function fieldLabel(f) {
  let s = `${f.name} ${f.type}`;
  if (f.pk) s += ' PK';
  if (f.unique) s += ' UQ';
  if (f.nullable) s += ' NULL';
  return s;
}

export function boxRect(e) {
  const inner = Math.max(8, e.name.length, ...e.fields.map((f) => fieldLabel(f).length));
  const w = inner + 2;
  const h = e.fields.length + 3; // border + name + fields + border
  return { x: e.x, y: e.y, w, h, inner };
}

export function rectsFor(model) {
  const map = new Map();
  for (const e of model.entities) map.set(e.name, boxRect(e));
  return map;
}
