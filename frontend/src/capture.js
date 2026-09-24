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

/** Shared stem rule for raster/vector export filenames (private). */
function filenameWithExt(currentFile, dialect, ext) {
	if (currentFile) return currentFile.replace(/\.sql$/i, `.${ext}`);
	return `${dialect || "erd"}-schema.${ext}`;
}

/** Filename for PNG export, mirrors exportFilename() in export.js */
export const pngFilename = (currentFile, dialect) =>
	filenameWithExt(currentFile, dialect, "png");

/** Filename for SVG export, pinned independently from pngFilename in tests. */
export const svgFilename = (currentFile, dialect) =>
	filenameWithExt(currentFile, dialect, "svg");

/**
 * Unwrap the data URL html-to-image's toSvg() returns into plain SVG source.
 *
 * toSvg() serializes the clone and hands back
 * `data:image/svg+xml;charset=utf-8,` + encodeURIComponent(svg) — a URI, not a
 * document. Writing that to a .svg file would produce a file whose first
 * characters are "data:image/svg+xml..." rather than "<svg", which no editor or
 * viewer will open. Decoding is the difference between an SVG file and a text
 * file that looks like one.
 *
 * Exported (and therefore unit-testable) because the decoding is the part with
 * a failure mode; the capture around it is a thin wrapper.
 */
export function decodeSvgDataUrl(dataUrl) {
	if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
		throw new Error("svg capture returned no data URL");
	}
	const comma = dataUrl.indexOf(",");
	if (comma < 0) throw new Error("svg data URL is malformed");
	const meta = dataUrl.slice(5, comma);
	const body = dataUrl.slice(comma + 1);
	// base64 is the other legal form; html-to-image uses encodeURIComponent
	// today, so this is a guard against a library change silently producing a
	// file full of percent-escapes rather than an SVG.
	if (meta.includes("base64")) {
		return atob(body);
	}
	const svg = decodeURIComponent(body);
	if (!svg.trimStart().startsWith("<svg")) {
		throw new Error("svg data URL did not decode to SVG source");
	}
	return svg;
}

/**
 * Capture the canvas element to SVG source, sized to the whole diagram.
 *
 * Why toSvg and not toPng: toPng/toBlob build a canvas from an <img> whose src
 * is the data URL, which the CSP's `connect-src 'self'` blocks (see the note in
 * capturePng). toSvg never goes through an <img> — it serializes the clone
 * directly — so it stays inside the policy while producing a vector file that
 * scales without the pixelation a PNG gets when zoomed.
 */
export async function captureSvg(canvasEl, schema) {
	if (!canvasEl) throw new Error("canvas not found");
	const size = captureSize(schema);
	if (!size) throw new Error("nothing to capture");
	const { toSvg } = await import("html-to-image");
	const dataUrl = await toSvg(canvasEl, {
		backgroundColor: BG,
		width: size.width,
		height: size.height,
		// Same reasoning as the PNG path: the clone inherits `overflow: auto`,
		// which would paint scrollbars into the output.
		style: { overflow: "hidden" },
	});
	return decodeSvgDataUrl(dataUrl);
}

/** Capture the canvas element to a PNG Blob, sized to the whole diagram. */

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
