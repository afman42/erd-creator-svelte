// capture.js — rasterize the canvas (tables + SVG edges) to a PNG Blob.
//
// html-to-image sizes its output from the element's clientWidth/clientHeight —
// the *visible* box. The canvas is `overflow: auto`, so that box is the
// viewport, and anything past it is silently cropped: a 9-table diagram on a
// 1280x800 window exported as 1280x759 with two tables missing. We therefore
// pass explicit width/height from captureSize(), which measures the cards
// themselves via geometry.js rather than the viewport.
//
// Zoom independence: the clone keeps the live `.zoom` scale (transform:
// scale(z)), so a 50% export shrank into padding and 200% cropped — while
// captureSize() is zoom-blind model px. Both paths therefore capture the
// inner `.zoom` layer with its transform neutralized (see captureOptions).
//
// The html-to-image import stays dynamic so the SQL path pays 0 bytes for it.

import { diagramBounds } from "./geometry.js";

const PAD = 40;
const BG = "#0d141b"; // = --color-bg (film ink); export canvas must match the theme

// Shared stem rule for raster/vector export filenames. Exported (not private):
// export.js's exportFilename() builds the .sql name off the same stem, so the
// fallback rule (<dialect>-schema) cannot drift between DDL and raster/vector.
// Non-.sql currentFile passthrough below is preserved as-is (pinned in
// capture-filenames.test.js) — only the stem construction is shared.
/**
 * @param {?string} currentFile
 * @param {?string} dialect
 */
export function exportStem(currentFile, dialect) {
	if (currentFile) return currentFile.replace(/\.sql$/i, "");
	return `${dialect || "erd"}-schema`;
}

/** Filename for PNG export, mirrors exportFilename() in export.js */
export const pngFilename = (currentFile, dialect) =>
	filenameWithExt(currentFile, dialect, "png");

// filenameWithExt swaps a trailing .sql for the export extension; anything
// else passes through unchanged (pinned in capture-filenames.test.js) — only
// the no-file fallback goes through exportStem().
/**
 * @param {?string} currentFile
 * @param {?string} dialect
 * @param {string} ext
 */
function filenameWithExt(currentFile, dialect, ext) {
	if (currentFile && /\.sql$/i.test(currentFile))
		return currentFile.replace(/\.sql$/i, `.${ext}`);
	if (currentFile) return currentFile;
	return `${exportStem(currentFile, dialect)}.${ext}`;
}

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
	// base64 is the other legal form; html-to-image uses encodeURIComponent
	// today, so this is a guard against a library change silently producing a
	// file full of percent-escapes rather than an SVG.
	if (dataUrl.slice(5, comma).includes("base64")) {
		return atob(dataUrl.slice(comma + 1));
	}
	const svg = decodeURIComponent(dataUrl.slice(comma + 1));
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
/**
 * Shared canvas guards + data-URL capture for the SVG/PNG arms: same
 * canvas-missing / nothing-to-capture errors, same zoom-neutralized root +
 * model-px options. kind selects the html-to-image entry ("svg" or "blob").
 */
async function captureDataUrl(canvasEl, schema, kind) {
	if (!canvasEl) throw new Error("canvas not found");
	const size = captureSize(schema);
	if (!size) throw new Error("nothing to capture");
	const { toSvg, toBlob } = await import("html-to-image");
	if (kind === "svg") return toSvg(captureRoot(canvasEl), captureOptions(size));
	const blob = await toBlob(captureRoot(canvasEl), {
		...captureOptions(size),
		pixelRatio: 1,
		cacheBust: false,
	});
	if (!blob) throw new Error("png capture returned empty");
	return blob;
}

export async function captureSvg(canvasEl, schema) {
	return decodeSvgDataUrl(await captureDataUrl(canvasEl, schema, "svg"));
}

/**
 * Root html-to-image captures: the inner `.zoom` layer, not `.canvas`.
 *
 * The live zoom scale lives on `.zoom` (`transform: scale(z)`), and the
 * `style` option below only reaches the capture root — capturing `.canvas`
 * would leave the inner scale untouched. Capturing `.zoom` directly makes
 * the root IS the scaled layer, so `transform: "none"` neutralizes it.
 * Falls back to canvasEl when there is no `.zoom` (markup drift, tests).
 */
export function captureRoot(canvasEl) {
	return canvasEl?.querySelector?.(".zoom") ?? canvasEl;
}

/**
 * Shared html-to-image options: fixed model-px size, zoom-neutralized clone.
 *
 * `width`/`height` are applied to the clone root by the library (overriding
 * `.zoom`'s zoom-scaled layout box), and `transform: "none"` overrides its
 * copied `scale(z)` — children sit at model coords, so export is identical
 * at 50%, 100%, 200%. Both PNG and SVG go through here; no per-path tweaks.
 */
export function captureOptions(size) {
	return {
		backgroundColor: BG,
		width: size.width,
		height: size.height,
		// The clone inherits `overflow: auto` from `.canvas`, which would
		// paint scrollbars into the image. Hidden matches the intent: the
		// whole diagram, no window chrome.
		style: { overflow: "hidden", transform: "none" },
	};
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
	const { maxX, maxY } = diagramBounds(tables);
	return { width: maxX + PAD, height: maxY + PAD };
}

/** Capture the canvas element to a PNG Blob, sized to the whole diagram. */
// toBlob directly — toPng→fetch(data:) is blocked by CSP connect-src 'self'
export async function capturePng(canvasEl, schema) {
	return captureDataUrl(canvasEl, schema, "blob");
}
