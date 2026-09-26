// download.js — pure download/clipboard helpers. Extracted from schema.svelte.js
// to keep the store focused on model/file state. No Svelte store dependency here.
export function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	try {
		document.body.appendChild(a);
		a.click();
	} finally {
		a.remove();
		// Delay the revoke: releasing the object URL on the same tick as the
		// click can abort the download before the browser commits to it.
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
}

export function downloadText(
	text,
	filename,
	mime = "text/plain;charset=utf-8",
) {
	downloadBlob(new Blob([text], { type: mime }), filename);
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
