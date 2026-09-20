// capture.js — rasterize the canvas (tables + SVG edges) to a PNG Blob.
//
// html-to-image sizes its output from the element's clientWidth/clientHeight —
// the *visible* box. The canvas is `overflow: auto`, so that box is the
// viewport, and anything past it is silently cropped: a 9-table diagram on a
// 1280x800 window exported as 1280x759 with two tables missing. We therefore
// pass explicit width/height from captureSize(), which measures the cards
// themselves via geometry.js rather than the viewport.
//
// The html-to-image import stays dynamic so the SQL path pays 0 bytes for it.

import { BOX_W, boxHeight } from "./geometry.js";

const PAD = 40;
const BG = "#101418";

/** Filename for PNG export, mirrors exportFilename() in schema.svelte.js */
export function pngFilename(currentFile, dialect) {
	if (currentFile) return currentFile.replace(/\.sql$/i, ".png");
	return `${dialect || "erd"}-schema.png`;
}

/**
 * Rendered size of the whole diagram, padded, in CSS pixels.
 * Measured from the cards so a scrolled or offscreen one is still included.
 * Returns null when there is nothing to draw.
 *
 * Width and height only: layout() clamps every card to x,y >= 0, so content
 * always starts at the padding and there is no offset left to apply —
 * html-to-image has no offset option anyway.
 */
export function captureSize(schema) {
	const tables = schema?.tables;
	if (!tables?.length) return null;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const t of tables) {
		maxX = Math.max(maxX, t.x + BOX_W);
		maxY = Math.max(maxY, t.y + boxHeight(t.columns.length));
	}
	return { width: maxX + PAD, height: maxY + PAD };
}

/** Capture the canvas element to a PNG Blob, sized to the whole diagram. */
export async function capturePng(canvasEl, schema) {
	if (!canvasEl) throw new Error("canvas not found");
	const size = captureSize(schema);
	if (!size) throw new Error("nothing to capture");
	// toBlob directly — toPng→fetch(data:) is blocked by CSP connect-src 'self'
	const { toBlob } = await import("html-to-image");
	const blob = await toBlob(canvasEl, {
		backgroundColor: BG,
		pixelRatio: 1,
		cacheBust: false,
		width: size.width,
		height: size.height,
		// The clone inherits `overflow: auto`, which paints the browser's
		// scrollbars into the image. Hidden matches the intent: the whole
		// diagram, no window chrome.
		style: { overflow: "hidden" },
	});
	if (!blob) throw new Error("png capture returned empty");
	return blob;
}
