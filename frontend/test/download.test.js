import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadBlob, downloadText, execCopy } from "../src/download.js";

// minimal DOM mocks for Node
function mockDOM() {
	const created = [];
	const origDoc = global.document;
	const origURL = global.URL;
	const urls = [];
	global.URL = {
		createObjectURL: (blob) => {
			const u = `blob:${urls.length}`;
			urls.push({ blob, url: u });
			return u;
		},
		revokeObjectURL: (u) => {
			const idx = urls.findIndex((x) => x.url === u);
			if (idx !== -1) urls.splice(idx, 1);
		},
	};
	global.document = {
		createElement: (tag) => {
			const el = {
				tag,
				href: "",
				download: "",
				style: {},
				value: "",
				selectCalled: false,
				clickCalled: false,
				select() {
					this.selectCalled = true;
				},
				click() {
					this.clickCalled = true;
				},
				remove() {
					this.removed = true;
				},
			};
			created.push(el);
			return el;
		},
		body: {
			appendChild(el) {
				el.appended = true;
			},
			removeChild(el) {
				el.removed = true;
			},
		},
	};
	// execCommand mock
	global.document.execCommand = (cmd) => cmd === "copy";

	return {
		created,
		urls,
		restore() {
			global.document = origDoc;
			global.URL = origURL;
		},
	};
}

test("downloadBlob creates object URL, clicks anchor, and revokes after a delay", async () => {
	const m = mockDOM();
	const blob = new Blob(["hello"], { type: "text/plain" });
	downloadBlob(blob, "a.txt");
	// should have created an <a>
	assert.equal(m.created.length, 1);
	assert.equal(m.created[0].tag, "a");
	assert.equal(m.created[0].download, "a.txt");
	assert.ok(m.created[0].href.startsWith("blob:"));
	assert.ok(m.created[0].clickCalled);
	// the revoke is deferred (setTimeout) so the download can start: the URL
	// must still be live right after the click, and revoked once it fires
	assert.equal(m.urls.length, 1, "object URL not yet revoked on the same tick");
	await new Promise((r) => setTimeout(r, 1100));
	assert.equal(
		m.urls.length,
		0,
		"object URL revoked after the deferred revoke",
	);
	m.restore();
});

test("downloadText creates text blob and delegates", () => {
	const m = mockDOM();
	downloadText("hello world", "out.sql");
	assert.equal(m.created.length, 1);
	assert.equal(m.created[0].download, "out.sql");
	m.restore();
});

test("execCopy creates textarea and copies", () => {
	const m = mockDOM();
	// need body.appendChild to track
	const taMock = [];
	const origCreate = global.document.createElement;
	global.document.createElement = (tag) => {
		if (tag === "textarea") {
			const el = {
				tag,
				value: "",
				style: {},
				selectCalled: false,
				select() {
					this.selectCalled = true;
				},
				remove() {},
			};
			taMock.push(el);
			return el;
		}
		return origCreate(tag);
	};
	global.document.body.appendChild = (el) => {
		el.appended = true;
	};
	// mock execCommand
	let cmd = null;
	global.document.execCommand = (c) => {
		cmd = c;
		return true;
	};

	const ok = execCopy("copy me");
	assert.equal(ok, true);
	assert.equal(taMock[0].value, "copy me");
	assert.equal(cmd, "copy");
	m.restore();
});

test("execCopy returns false when execCommand fails", () => {
	const m = mockDOM();
	global.document.execCommand = () => false;
	// need textarea mock
	const origCreate = global.document.createElement;
	global.document.createElement = (tag) => {
		if (tag === "textarea") {
			return { tag, value: "", style: {}, select() {}, remove() {} };
		}
		return origCreate(tag);
	};
	const ok = execCopy("x");
	assert.equal(ok, false);
	m.restore();
});

test("downloadText passes the SVG mime for vector exports", async () => {
	const seen = [];
	const origURL = global.URL;
	global.URL = {
		createObjectURL: (b) => {
			seen.push(b);
			return "blob:x";
		},
		revokeObjectURL: () => {},
	};
	const origDoc = global.document;
	global.document = {
		createElement: () => ({
			style: {},
			clickCalled: false,
			click() {
				this.clickCalled = true;
			},
			remove() {},
		}),
		body: { appendChild() {}, removeChild() {} },
	};
	try {
		const { downloadText } = await import("../src/download.js");
		downloadText("<svg/>", "d.svg", "image/svg+xml;charset=utf-8");
		assert.equal(seen[0].type, "image/svg+xml;charset=utf-8");
		downloadText("CREATE TABLE", "d.sql");
		assert.equal(seen[1].type, "text/plain;charset=utf-8");
	} finally {
		global.URL = origURL;
		global.document = origDoc;
	}
});
