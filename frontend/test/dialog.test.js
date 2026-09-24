import assert from "node:assert/strict";
import { test } from "node:test";
import { showDialog } from "../src/dialog.js";

function fakeDialog(open = false) {
	let calls = 0;
	return {
		open,
		showModal() {
			calls++;
			this.open = true;
		},
		get calls() {
			return calls;
		},
	};
}

test("showDialog opens a closed dialog via showModal", () => {
	const dlg = fakeDialog(false);
	showDialog(dlg);
	assert.equal(dlg.calls, 1);
	assert.equal(dlg.open, true);
});

test("showDialog leaves an already-open dialog alone", () => {
	const dlg = fakeDialog(true);
	showDialog(dlg);
	assert.equal(dlg.calls, 0, "showModal must not re-fire on an open dialog");
});

test("showDialog tolerates null without throwing", () => {
	assert.doesNotThrow(() => showDialog(null));
	assert.doesNotThrow(() => showDialog(undefined));
});
