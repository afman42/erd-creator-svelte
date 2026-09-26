// test/fixtures.js — shared schema/table/column factories. Extracted from
// divergent copies in relationships.test.js, geometry.test.js, erd.test.js
// (~40 uses): one trio with explicit defaults, no hidden drift.
export const S = (tables) => ({ tables });

export const T = (id, name, cols, x = 0, y = 0) => ({
	id,
	name,
	x,
	y,
	columns: cols,
	indexes: [],
});

export const C = (id, name, type = "INT", pk = false, extra = {}) => ({
	id,
	name,
	type,
	pk,
	nn: !!pk,
	ai: false,
	ux: false,
	ix: false,
	comment: "",
	ref: null,
	...extra,
});

// Geometry-only table (position + columns, no names/indexes).
export const GT = (id, x, y, cols) => ({ id, x, y, columns: cols });
