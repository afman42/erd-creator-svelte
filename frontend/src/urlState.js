// urlState.js — URL-synced view state (file, panels, zoom, find, selection).
//
// Shareable deep links without a router: five query params cover the stateful
// UI the guidelines flag (panels, find box, selection, zoom):
//
//   file — schema file name (no .sql suffix in the URL; added on open)
//   sql, lint — panel visibility (presence = open; value ignored)
//   zoom — canvas zoom percent (25–200, clamped; bare "zoom" = 100)
//   q — find-table query text (mirrors the toolbar box)
//   sel — selected table NAME (not id: ids are session-local, adoptIds
//     rewrites non-tN ids on load, so an id link would rot; names are what
//     the saved file actually keeps)
//
// Pure encode/decode over URLSearchParams so node --test can drive it with
// no DOM. App/Toolbar own the live sync (replaceState writes, popstate
// reads); this module never touches window/location.
import { clampZoom } from "./canvasView.js";

/** @typedef {{ file: string, showSql: boolean, showLint: boolean, zoom: number, query: string, sel: string }} ViewState */

/** Defaults when no params are present. */
export function defaultViewState() {
	return {
		file: "",
		showSql: false,
		showLint: false,
		zoom: 1,
		query: "",
		sel: "",
	};
}

// Zoom is stored as an integer percent (100 = 1x): "?zoom=50" reads at a
// glance, and rounding on write keeps clampZoom's 2-decimal model values
// from producing "?zoom=74.999999".
/**
 * @param {URLSearchParams} params
 * @returns {ViewState}
 */
export function decodeViewState(params) {
	const state = defaultViewState();
	const file = params.get("file");
	if (file) state.file = file;
	state.showSql = params.has("sql");
	state.showLint = params.has("lint");
	if (params.has("zoom")) {
		const raw = Number(params.get("zoom") || "100");
		state.zoom = clampZoom(Number.isFinite(raw) ? raw / 100 : 1);
	}
	const q = params.get("q");
	if (q) state.query = q;
	const sel = params.get("sel");
	if (sel) state.sel = sel;
	return state;
}

// Falsy/empty/default values are dropped so the URL stays minimal: no
// "?sql=&lint=&zoom=100", just "?file=x". Panels encode as bare flags
// (?sql&lint) — presence is the signal, the value carries nothing.
/**
 * @param {ViewState} state
 * @returns {URLSearchParams}
 */
export function encodeViewState(state) {
	const params = new URLSearchParams();
	if (state.file) params.set("file", state.file);
	if (state.showSql) params.set("sql", "");
	if (state.showLint) params.set("lint", "");
	if (state.zoom !== 1)
		params.set("zoom", String(Math.round(state.zoom * 100)));
	if (state.query) params.set("q", state.query);
	if (state.sel) params.set("sel", state.sel);
	return params;
}

/**
 * Selection links by NAME, but the store selects by id: resolve the linked
   name against the loaded tables. Case-sensitive exact match — table names
   are case-sensitive in the DDL, so a fuzzy match could select the wrong
   table ("Users" linking to "users").
 * @param {{ tables: { id: string, name: string }[] }} schema
 * @param {string} name
 * @returns {string|null} table id, or null when no table has that name
 */
export function resolveSelectedId(schema, name) {
	if (!name) return null;
	return schema.tables.find((t) => t.name === name)?.id ?? null;
}
