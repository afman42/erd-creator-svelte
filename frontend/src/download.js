// download.js — pure download/clipboard helpers. Extracted from schema.svelte.js
// to keep the store focused on model/file state. No Svelte store dependency here.
export function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

export function downloadText(text, filename) {
	downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), filename);
}

export function execCopy(text) {
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.style.cssText = "position:fixed;opacity:0";
	document.body.appendChild(ta);
	ta.select();
	try {
		return document.execCommand("copy");
	} finally {
		ta.remove();
	}
}
