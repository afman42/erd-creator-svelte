// test/helpers.js — shared unit-test harnesses. Extracted from copy-paste
// across autosave, fileStore, export-errors, download, theme, history tests:
// fake stores (~13x), fetch stubs (~10x), prompt stubs (6x), flash collectors
// (8x), global save/restore (~20x), reset+sleep (~16x), touch deps (8x),
// history reset (9x), read-source (~10x).
import { readFileSync } from "node:fs";
import {
	clearTimers as _clearTimers,
	setDirty as _setDirty,
} from "../src/autosave.js";
import { clearHistory } from "../src/history.js";

export function makeStore(overrides = {}) {
	return {
		currentFile: "a.sql",
		files: [],
		schema: { dialect: "mysql", tables: [] },
		sqlText: "",
		error: "",
		...overrides,
	};
}

export function makeFlash() {
	const msgs = [];
	return [msgs, (m, _kind = "ok") => msgs.push(m)];
}

export function flashCapture() {
	const msgs = [];
	const flash = (msg, kind) => msgs.push([String(msg), kind]);
	return { msgs, flash };
}

export function stubFetch(responses = []) {
	const calls = [];
	const orig = globalThis.fetch;
	globalThis.fetch = async (url, opts) => {
		calls.push({ url, opts });
		const r = responses.shift() ?? { ok: true, json: [], text: "" };
		return {
			ok: r.ok,
			text: async () => r.text ?? "",
			json: async () => r.json ?? [],
		};
	};
	return { calls, restore: () => (globalThis.fetch = orig) };
}

export function stubFetchRejectWith(value) {
	const orig = globalThis.fetch;
	globalThis.fetch = () => Promise.reject(value);
	return () => {
		globalThis.fetch = orig;
	};
}

export function pendingFetch() {
	const pending = [];
	const orig = globalThis.fetch;
	globalThis.fetch = () => new Promise((res) => pending.push(res));
	return {
		resolveWith(ok, n = 0) {
			if (n >= pending.length) throw new Error(`no fetch call ${n}`);
			pending[n]({ ok, text: async () => "" });
		},
		restore() {
			globalThis.fetch = orig;
		},
	};
}

export async function withPrompt(value, fn) {
	const orig = globalThis.prompt;
	globalThis.prompt = value;
	try {
		return await fn();
	} finally {
		globalThis.prompt = orig;
	}
}

export function touchDeps(counters = {}) {
	return {
		store: counters.store ?? makeStore(),
		refreshLint: counters.refreshLint ?? (() => {}),
		refreshSql: counters.refreshSql ?? (() => {}),
		saveCurrent: counters.saveCurrent ?? (() => {}),
	};
}

export function resetAutosave() {
	_clearTimers();
	_setDirty(false);
	clearHistory();
}

export function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

export function readSrc(relpath) {
	return readFileSync(new URL(relpath, import.meta.url), "utf8");
}
