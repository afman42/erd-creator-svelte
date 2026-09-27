import assert from "node:assert/strict";
import { test } from "node:test";
import {
	bumpStruct,
	clampZoom,
	contentSize,
	referencedSet,
	relationshipList,
	tableNameById,
} from "../src/canvasView.js";
import { setSnapHook, snap } from "../src/history.js";
import { resetAutosave } from "./helpers.js";

setSnapHook(bumpStruct);

import { exportStem } from "../src/capture.js";
import { exportFilename } from "../src/export.js";
import { scrollToTable } from "../src/ui.js";

const schema = () => ({
	dialect: "mysql",
	tables: [
		{
			id: "t1",
			name: "users",
			x: 40,
			y: 40,
			columns: [
				{ id: "c1", name: "id", pk: true, nn: true, ux: false, ref: null },
			],
			indexes: [],
			comment: "",
		},
		{
			id: "t2",
			name: "posts",
			x: 400,
			y: 40,
			columns: [
				{
					id: "c2",
					name: "user_id",
					pk: false,
					nn: true,
					ux: false,
					ref: { tableId: "t1", action: "CASCADE", onUpdate: "" },
				},
			],
			indexes: [],
			comment: "",
		},
	],
});

test("tableNameById memoizes per schema identity", () => {
	const s = schema();
	const a = tableNameById(s);
	assert.equal(a.get("t1"), "users");
	assert.equal(tableNameById(s), a, "same schema object must reuse the map");
	assert.notEqual(tableNameById(schema()), a, "new object must rebuild");
});

test("referencedSet memoizes per schema identity", () => {
	const s = schema();
	const a = referencedSet(s);
	assert.ok(a.has("t1"));
	assert.equal(referencedSet(s), a);
});

test("relationshipList uses the memoized names (no per-FK scan)", () => {
	const s = schema();
	assert.deepEqual(relationshipList(s), [
		"posts.user_id 0..N references users 1..1",
	]);
	assert.equal(relationshipList(s), relationshipList(s));
});

test("memo invalidates on structural snap, reuses across x/y drag writes", () => {
	resetAutosave();
	const s = schema();
	const names = tableNameById(s);
	const rel = relationshipList(s);
	const refs = referencedSet(s);
	// drag frame: x/y only, no snap → identity reuse
	s.tables[0].x = 99;
	assert.equal(tableNameById(s), names, "drag must reuse the name map");
	assert.equal(relationshipList(s), rel, "drag must reuse the rel list");
	assert.equal(referencedSet(s), refs, "drag must reuse the ref set");
	// structural edit flow (snap, then in-place apply — as schema.svelte does)
	snap(s);
	s.tables[0].name = "people";
	assert.equal(
		tableNameById(s).get("t1"),
		"people",
		"rename must rebuild the name map",
	);
	assert.deepEqual(relationshipList(s), [
		"posts.user_id 0..N references people 1..1",
	]);
	resetAutosave();
});

test("memo invalidates on FK retarget and flag flip", () => {
	resetAutosave();
	const s = schema();
	relationshipList(s);
	referencedSet(s);
	// retarget the FK away from t1: ref set must drop t1, rel text must follow
	snap(s);
	s.tables[1].columns[0].ref.tableId = "t2";
	assert.ok(!referencedSet(s).has("t1"), "retarget must drop t1 from ref set");
	assert.deepEqual(relationshipList(s), [
		"posts.user_id 0..N references posts 1..1",
	]);
	// flip ux: child end must read 0..1
	snap(s);
	s.tables[1].columns[0].ux = true;
	assert.deepEqual(relationshipList(s), [
		"posts.user_id 0..1 references posts 1..1",
	]);
	resetAutosave();
});

test("clampZoom + contentSize cover the zoom/view helpers", () => {
	assert.equal(clampZoom(99), 2);
	assert.equal(clampZoom(-1), 0.25);
	const { w, h } = contentSize(schema());
	assert.ok(w > 400 && h > 40);
});

test("exportFilename shares the canonical exportStem fallback", () => {
	assert.equal(
		exportFilename({ currentFile: "a.sql", schema: { dialect: "mysql" } }),
		"a.sql",
	);
	assert.equal(
		exportFilename({ currentFile: "", schema: { dialect: "mysql" } }),
		"mysql-schema.sql",
	);
	assert.equal(exportStem("", "mysql"), "mysql-schema");
	assert.equal(exportStem("a.sql", "mysql"), "a");
});

test("scrollToTable selects and scrolls the card", () => {
	let selected = null;
	let scrolled = null;
	global.document = {
		querySelector: (sel) => {
			assert.match(sel, /Table users/);
			return { scrollIntoView: (o) => (scrolled = o) };
		},
	};
	global.CSS = { escape: (s) => s };
	try {
		assert.equal(
			scrollToTable("t1", "users", (id) => (selected = id)),
			true,
		);
		assert.equal(selected, "t1");
		assert.deepEqual(scrolled, { block: "center", inline: "center" });
	} finally {
		delete global.document;
		delete global.CSS;
	}
});
