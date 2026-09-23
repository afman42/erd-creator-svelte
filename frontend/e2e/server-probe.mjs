// server-probe.mjs — refuse to run the e2e suite against a foreign server.
//
// playwright.config.js sets reuseExistingServer: true, which adopts whatever
// is already listening on the port. That silently runs the suite against the
// wrong binary — a stale build, or a different process altogether — and the
// suite's beforeEach deletes every file in the store it finds, so adopting a
// server pointed at the real schemas/ directory would wipe real data.
//
// This probe runs in global-setup, before Playwright starts or adopts a
// server:
//
//   - nothing on the port     → fine, Playwright starts the real server
//   - a server whose / returns
//     this checkout's dist/index.html
//                             → our own build, safe to reuse (the store is
//                               the e2e dir because that is what the webServer
//                               command starts; leftover .sql files from the
//                               previous run are expected and wiped by
//                               beforeEach)
//   - anything else           → throw with an actionable message
//
// Set ERD_E2E_REUSE=1 to trust whatever is on the port (a developer who knows
// what they started, e.g. a debugging server). The suite then runs against
// that process as-is.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Single source of truth for the port: playwright.config.js imports this so
// baseURL and webServer cannot drift from the probe.
export const E2E_PORT = Number(process.env.E2E_PORT ?? "8731");

const PROBE_HOST = "127.0.0.1";
const FETCH_TIMEOUT_MS = 2000;

async function fetchWithTimeout(url) {
	return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

// connectionRefused tells the "no server here" case from a real failure: a
// closed port surfaces as TypeError with a cause whose message names refused.
function connectionRefused(err) {
	if (err instanceof TypeError) {
		const msg = `${err.message} ${err.cause?.message ?? ""}`;
		if (/refused/i.test(msg) || /failed to fetch/i.test(msg)) return true;
	}
	return false;
}

export async function probeServer(port = E2E_PORT) {
	const base = `http://${PROBE_HOST}:${port}`;
	let root;
	try {
		root = await fetchWithTimeout(`${base}/`);
	} catch (err) {
		if (connectionRefused(err)) return; // no server → Playwright starts one
		throw new Error(
			`ERD e2e: nothing verified on ${base} but the probe failed: ${err.message}`,
		);
	}

	const served = await root.text();
	const distIndex = new URL("../dist/index.html", import.meta.url);
	const expected = readFileSync(fileURLToPath(distIndex), "utf8");
	if (served !== expected) {
		throw new Error(
			`ERD e2e: ${base} is already serving a DIFFERENT process (its / ` +
				"does not match this checkout's frontend/dist/index.html). The suite " +
				"would run against that server — every test deletes all files in its " +
				`store. Stop it and rerun, or set ERD_E2E_REUSE=1 to take full ` +
				"responsibility for what is on the port.",
		);
	}
	console.log(`e2e: reusing verified server on ${base} (same build)`);
}
