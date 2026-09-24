import assert from "node:assert/strict";
import { test } from "node:test";
import { pngFilename, svgFilename } from "../src/capture.js";

test("png/svg stem rule swaps a .sql suffix for the export ext", () => {
	assert.equal(pngFilename("mydb.sql", "mysql"), "mydb.png");
	assert.equal(svgFilename("mydb.sql", "mysql"), "mydb.svg");
});

test("stem rule is case-insensitive on the .sql suffix", () => {
	assert.equal(pngFilename("MYDB.SQL", "mysql"), "MYDB.png");
	assert.equal(svgFilename("MYDB.SQL", "mysql"), "MYDB.svg");
});

test("no current file falls back to <dialect>-schema.<ext>", () => {
	assert.equal(pngFilename("", "mysql"), "mysql-schema.png");
	assert.equal(svgFilename(null, "postgres"), "postgres-schema.svg");
	assert.equal(pngFilename(undefined, "sqlite"), "sqlite-schema.png");
});

test("empty dialect falls back to erd-schema.<ext>", () => {
	assert.equal(pngFilename("", ""), "erd-schema.png");
	assert.equal(svgFilename("", undefined), "erd-schema.svg");
});

test("non-.sql name passes through per current rule (no suffix swap)", () => {
	// Documents current behavior: filenameWithExt only rewrites a trailing
	// .sql; anything else is returned unchanged. Do not "fix" here — a change
	// belongs in src/capture.js with a product decision behind it.
	assert.equal(pngFilename("notes.txt", "mysql"), "notes.txt");
	assert.equal(svgFilename("notes.txt", "mysql"), "notes.txt");
	assert.equal(pngFilename("mydb", "mysql"), "mydb");
});
