// node --test test/ — theme.js is DOM-free; localStorage is stubbed because
// node --test has no web storage by default (which is itself the fallback
// path the module must survive).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	initialTheme,
	saveTheme,
	THEME_DARK,
	THEME_LIGHT,
} from "../src/theme.js";

test("initialTheme falls back to dark without localStorage", () => {
	assert.equal(initialTheme(), THEME_DARK);
});

test("saveTheme does not throw without localStorage", () => {
	assert.doesNotThrow(() => saveTheme(THEME_LIGHT));
});

test("initialTheme reads the persisted choice and rejects unknown values", () => {
	const store = new Map();
	globalThis.localStorage = {
		getItem: (k) => store.get(k) ?? null,
		setItem: (k, v) => store.set(k, v),
	};
	try {
		assert.equal(initialTheme(), THEME_DARK); // nothing saved yet
		saveTheme(THEME_LIGHT);
		assert.equal(store.get("erd-theme"), THEME_LIGHT);
		assert.equal(initialTheme(), THEME_LIGHT);
		// a corrupted/unexpected value (e.g. a renamed theme key) must not
		// leak through to the attribute
		store.set("erd-theme", "sepia");
		assert.equal(initialTheme(), THEME_DARK);
	} finally {
		delete globalThis.localStorage;
	}
});
