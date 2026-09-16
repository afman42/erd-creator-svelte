// E2E drives the REAL product: Go server (embedded dist) + chromium.
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	workers: 1, // single server, shared schemas dir — serial is deterministic
	use: { baseURL: "http://127.0.0.1:8731" },
	webServer: {
		command: "go run . -dir schemas-e2e",
		cwd: "..",
		url: "http://127.0.0.1:8731",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
