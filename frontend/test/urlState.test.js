import assert from "node:assert/strict";
import { test } from "node:test";
import {
	decodeViewState,
	defaultViewState,
	encodeViewState,
	resolveSelectedId,
} from "../src/urlState.js";
import { C, S, T } from "./fixtures.js";

const params = (s) => new URLSearchParams(s);

test("empty query decodes to defaults", () => {
	assert.deepEqual(decodeViewState(params("")), defaultViewState());
});

test("full query decodes every param", () => {
	const got = decodeViewState(
		params("file=blog&sql&lint&zoom=50&q=us&sel=users"),
	);
	assert.deepEqual(got, {
		file: "blog",
		showSql: true,
		showLint: true,
		zoom: 0.5,
		query: "us",
		sel: "users",
	});
});

test("bare zoom flag means 100%", () => {
	assert.equal(decodeViewState(params("zoom")).zoom, 1);
});

test("zoom clamps to 25-200 and rejects garbage", () => {
	assert.equal(decodeViewState(params("zoom=500")).zoom, 2);
	assert.equal(decodeViewState(params("zoom=1")).zoom, 0.25);
	assert.equal(decodeViewState(params("zoom=bogus")).zoom, 1);
});

test("panels decode on presence, value ignored", () => {
	const got = decodeViewState(params("sql=0&lint=no"));
	assert.equal(got.showSql, true);
	assert.equal(got.showLint, true);
});

test("defaults encode to an empty query", () => {
	assert.equal(encodeViewState(defaultViewState()).toString(), "");
});

test("full state round-trips through encode/decode", () => {
	const state = {
		file: "blog",
		showSql: true,
		showLint: true,
		zoom: 0.5,
		query: "us",
		sel: "users",
	};
	const back = decodeViewState(encodeViewState(state));
	assert.deepEqual(back, state);
});

test("zoom 1 is dropped from the URL", () => {
	const q = encodeViewState({ ...defaultViewState(), zoom: 1 }).toString();
	assert.ok(!q.includes("zoom"));
});

test("selection resolves by exact name, null when missing", () => {
	const schema = S([T("t1", "users", [C("c1", "id")]), T("t2", "posts", [])]);
	assert.equal(resolveSelectedId(schema, "posts"), "t2");
	assert.equal(resolveSelectedId(schema, "missing"), null);
	assert.equal(resolveSelectedId(schema, ""), null);
});

test("selection match is case-sensitive", () => {
	const schema = S([T("t1", "users", [])]);
	assert.equal(resolveSelectedId(schema, "Users"), null);
});
