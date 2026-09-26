import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { E2E_PORT, probeServer } from "../e2e/server-probe.mjs";
import { readSrc } from "./helpers.js";

// probeServer verifies the server on the e2e port before the suite adopts it.
// It refuses a FOREIGN process (different build); our own build is accepted
// even with leftover store files, because beforeEach wipes the store at the
// start of every test. These tests exercise that contract with real local
// HTTP servers.

function serve(handler) {
	const srv = createServer(handler);
	return new Promise((res) => {
		srv.listen(0, "127.0.0.1", () => res(srv));
	});
}

const distIndex = readSrc("../dist/index.html");

test("probeServer refutes a foreign process on the port", async () => {
	const srv = await serve((_req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<!doctype html><title>Some other app</title>");
	});
	const port = srv.address().port;
	try {
		await assert.rejects(probeServer(port), /DIFFERENT process/);
	} finally {
		srv.close();
	}
});

test("probeServer accepts our own build even with leftover store files", async () => {
	const srv = await serve((req, res) => {
		if (req.url === "/api/files") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end('[{"name":"dirty.sql"}]');
			return;
		}
		res.writeHead(200, { "content-type": "text/html" });
		res.end(distIndex);
	});
	const port = srv.address().port;
	try {
		await probeServer(port); // previous run's leftovers are expected
	} finally {
		srv.close();
	}
});

test("probeServer accepts an empty store on our own build too", async () => {
	const srv = await serve((req, res) => {
		if (req.url === "/api/files") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end("[]");
			return;
		}
		res.writeHead(200, { "content-type": "text/html" });
		res.end(distIndex);
	});
	const port = srv.address().port;
	try {
		await probeServer(port); // must not throw
	} finally {
		srv.close();
	}
});

test("E2E_PORT is the documented default 8731", () => {
	assert.equal(E2E_PORT, 8731);
});
