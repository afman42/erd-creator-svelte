import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
	plugins: [svelte()],
	// Dev: the Go server (default :8731) serves the API, so /api + /export
	// proxy there and the app's relative fetch() paths just work under `pnpm dev`.
	server: {
		proxy: {
			"/api": "http://127.0.0.1:8731",
			"/export": "http://127.0.0.1:8731",
		},
	},
	build: {
		// The Go binary embeds dist/ and the CSP has no source-map allowance;
		// keep sourcemaps off so the bundle ships nothing to unpick it with.
		sourcemap: false,
		// Rolldown code-split: html-to-image loads only via exportPng/exportSvg,
		// so it already lands in its own chunk (see dist/assets/capture-*).
		// No manualChunks — one vendor chunk per package would just add files.
	},
});
