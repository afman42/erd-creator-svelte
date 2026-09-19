// capture.js — rasterize .canvas (tables + SVG edges) to PNG Blob.
// Uses html-to-image dynamic import so SQL path pays 0 bytes.
// Bounds via geometry.js, not viewport, so scrolled/offscreen cards not clipped.

import { BOX_W, boxHeight } from "./geometry.js";

const PAD = 40;
const BG = "#101418";

/** Filename for PNG export, mirrors exportFilename() in schema.svelte.js */
export function pngFilename(currentFile, dialect) {
	if (currentFile) return currentFile.replace(/\.sql$/i, ".png");
	return `${dialect || "erd"}-schema.png`;
}

/** Compute canvas bounds from schema tables — pure, testable. */
export function captureBounds(schema) {
	if (!schema?.tables?.length) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const t of schema.tables) {
		const h = boxHeight(t.columns.length);
		minX = Math.min(minX, t.x);
		minY = Math.min(minY, t.y);
		maxX = Math.max(maxX, t.x + BOX_W);
		maxY = Math.max(maxY, t.y + h);
	}
	return {
		x: minX - PAD,
		y: minY - PAD,
		width: maxX - minX + PAD * 2,
		height: maxY - minY + PAD * 2,
	};
}

/** Capture .canvas element to PNG Blob. Returns Blob. */
export async function capturePng(canvasEl) {
	if (!canvasEl) throw new Error("canvas not found");
	// html-to-image handles Svelte scoped CSS + SVG marker better than html2canvas
	// Use toBlob directly — toPng→fetch(data:) is blocked by CSP connect-src 'self'
	const { toBlob } = await import("html-to-image");
	const blob = await toBlob(canvasEl, {
		backgroundColor: BG,
		pixelRatio: 1,
		cacheBust: false,
	});
	if (!blob) throw new Error("png capture returned empty");
	return blob;
}
