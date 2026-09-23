// E2E drives the REAL product: Go server (embedded dist) + chromium.
import { defineConfig } from "@playwright/test";
import { E2E_PORT } from "./e2e/server-probe.mjs";

export default defineConfig({
	testDir: "./e2e",
	workers: 1, // single server, shared schemas dir — serial is deterministic
	use: { baseURL: `http://127.0.0.1:${E2E_PORT}` },
	// Refuses a foreign process already on the port instead of adopting it:
	// reuseExistingServer would silently run against a wrong binary, or wipe a
	// real schemas store (every test deletes all files in the server's store).
	globalSetup: "./e2e/global-setup.mjs",
	webServer: {
		command: "go run . -dir schemas-e2e",
		cwd: "..",
		url: `http://127.0.0.1:${E2E_PORT}`,
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
