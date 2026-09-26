// api.js — shared fetch + error helpers. Extracted from copy-paste across
// fileStore.js, export.js, schema.svelte.js: 10x fetch-JSON-POST (~90% same),
// 9x verbatim `e instanceof Error ? e.message : String(e)`, 20x flash("err").
export function errMsg(e) {
	return e instanceof Error ? e.message : String(e);
}

// POST/PUT/GET JSON; throws Error(await res.text()) on !ok.
export async function api(path, method = "GET", payload, opts = {}) {
	const res = await fetch(path, {
		method,
		...(payload !== undefined
			? {
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				}
			: {}),
		...opts,
	});
	if (!res.ok) throw new Error(await res.text());
	const ct = res.headers?.get?.("content-type") ?? "";
	return ct.includes("json") ? res.json() : res.text();
}

// fail flashes a prefixed error: flash(`${prefix}: ${errMsg(e)}`, "err").
export function fail(flash, prefix, e) {
	flash(`${prefix}: ${errMsg(e)}`, "err");
}

// resolveFileName normalizes a prompt result to a .sql name, or "" when empty.
// Path separators and control characters are stripped client-side to match the
// server's containment: the name travels in the DOM (a.download) before it
// reaches safeName, and a browser-sanitized name is not a contract to rely on.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping C0/C1 controls is the point
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;
export function resolveFileName(to) {
	to = (to || "").trim();
	if (!to) return "";
	to = to.replace(/[\\/]/g, "").replace(CONTROL_RE, "");
	if (!to) return "";
	return `${to.replace(/\.sql$/i, "")}.sql`;
}
