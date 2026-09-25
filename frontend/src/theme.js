// theme.js — light/dark appearance state.
//
// The app is dark by default; the light palette is a [data-theme="light"]
// override in tokens.css applied to <html>. The theme is persisted in
// localStorage so a reload keeps the choice; storage failures (private mode,
// file://) degrade to in-memory only. main.js applies the attribute BEFORE
// mount so the first paint is already correct — an inline script could do
// less because the CSP forbids inline scripts, and store.theme reads the same
// value so UI and attribute cannot disagree.
export const THEME_DARK = "dark";
export const THEME_LIGHT = "light";

/**
 * @returns {"dark" | "light"}
 */
export function initialTheme() {
	try {
		const v = localStorage.getItem("erd-theme");
		if (v === THEME_DARK || v === THEME_LIGHT) return v;
	} catch {
		/* storage unavailable: keep default */
	}
	return THEME_DARK;
}

/**
 * @param {"dark" | "light"} t
 */
export function saveTheme(t) {
	try {
		localStorage.setItem("erd-theme", t);
	} catch {
		/* in-memory only */
	}
}
