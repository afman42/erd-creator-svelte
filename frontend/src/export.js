// export.js — clipboard + file-export helpers, extracted from schema.svelte.js
// to shrink the God object. Parallel to capture.js (which owns the
// canvas → PNG/SVG rasterization); this module owns the "ship it out of the
// app" half: clipboard copy, DDL download, and the filename each export saves
// under. Functions take store + flash as params (DI), the same shape fileStore.js
// uses, so nothing here touches the reactive store directly.

import { api, errMsg } from "./api.js";
import { exportStem } from "./capture.js";
import { downloadBlob, downloadText, execCopy } from "./download.js";

// copy to clipboard via navigator.clipboard, falling back to a hidden
// textarea + execCommand when the async API is blocked (e.g. http:// hosts).
// Returns whether the payload reached a clipboard.
async function copyText(text, msg, flash) {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		if (!execCopy(text)) {
			flash("clipboard blocked — copy failed", "err");
			return false;
		}
	}
	flash(msg);
	return true;
}

export async function copyInserts(store, flash) {
	try {
		await copyText(
			await api("/api/inserts", "POST", { schema: store.schema }),
			"copied INSERT templates",
			flash,
		);
	} catch (e) {
		flash(`INSERTs failed: ${errMsg(e)}`, "err");
	}
}

// copySql copies what the SQL panel currently shows (`store.sqlText`). It
// refreshes first so the copy matches the schema, but only flashes "copied" if
// that refresh actually succeeded — otherwise it flashes the failure instead of
// pretending a stale export is the current one.
export async function copySql(store, refreshSql, flash) {
	if (!(await refreshSql())) {
		flash("SQL refresh failed — copy aborted", "err");
		return;
	}
	await copyText(store.sqlText, "copied SQL", flash);
}

// The name to save under. A loaded file keeps its own name (users.sql stays
// users.sql); an unsaved scratch schema gets a name that says which grammar it
// is in, since that is the one thing the bytes do not state up front. The
// unsaved fallback stem is the canonical exportStem() in capture.js — shared
// with png/svg — so the "<dialect>-schema" rule lives in one place.
export function exportFilename(store) {
	if (store.currentFile) return store.currentFile;
	return `${exportStem(null, store.schema.dialect)}.sql`;
}

export async function exportDdl(store, flash) {
	store.exporting = true;
	try {
		const text = await api("/export", "POST", {
			dialect: store.schema.dialect,
			schema: store.schema,
		});
		const name = exportFilename(store);
		downloadText(text, name);
		flash(`downloaded ${name}`);
	} catch (e) {
		flash(`export failed: ${errMsg(e)}`, "err");
	} finally {
		store.exporting = false;
	}
}

export async function exportPng(store, flash) {
	await guardRaster(store, flash, "png", async () => {
		// The store owns the DOM lookup and the schema; capture.js is handed
		// both so it stays free of ambient document/store access and can be
		// driven with a plain element in tests.
		const el = document.querySelector(".canvas");
		const { capturePng, pngFilename } = await import("./capture.js");
		const blob = await capturePng(el, store.schema);
		const name = pngFilename(store.currentFile, store.schema.dialect);
		downloadBlob(blob, name);
		flash(`downloaded ${name}`);
	});
}

// guardRaster shares the empty-schema guard + exporting flag between the PNG
// and SVG arms: same guard, same flag set/reset, same "<kind> export failed"
// flash on error.
// kind selects the error label ("png" or "svg").
/**
 * @param {any} store
 * @param {(msg: string, kind?: "ok" | "err" | "warn") => void} flash
 * @param {string} kind
 * @param {() => Promise<void>} run
 */
async function guardRaster(store, flash, kind, run) {
	if (!store.schema.tables.length) {
		flash("nothing to export — add a table first", "err");
		return;
	}
	store.exporting = true;
	try {
		await run();
	} catch (e) {
		flash(`${kind} export failed: ${errMsg(e)}`, "err");
	} finally {
		store.exporting = false;
	}
}

// exportSvg is the vector twin of exportPng: same sizing, same empty-schema
// guard, same filename rule with a .svg extension. It exists alongside PNG
// rather than replacing it because the two answer different needs — SVG for
// docs and slides where the diagram is rescaled, PNG where a bitmap is
// required. The SVG is written as text, not as a data URL: see decodeSvgDataUrl.
export async function exportSvg(store, flash) {
	await guardRaster(store, flash, "svg", async () => {
		const el = document.querySelector(".canvas");
		const { captureSvg, svgFilename } = await import("./capture.js");
		const svg = await captureSvg(el, store.schema);
		const name = svgFilename(store.currentFile, store.schema.dialect);
		// downloadText already sets a text charset; an SVG is XML, so it is
		// passed through as-is with the .svg extension as the type signal.
		downloadText(svg, name, "image/svg+xml;charset=utf-8");
		flash(`downloaded ${name}`);
	});
}
