// global-setup.mjs — runs before Playwright starts or adopts the web server.
// The suite refuses to run against a foreign process on the port (wrong
// binary, wrong store dir — every test wipes the store it finds). Nothing on
// the port is fine: Playwright then starts the real server itself.
// See server-probe.mjs for the verification and the ERD_E2E_REUSE escape.
import { probeServer } from "./server-probe.mjs";

export default async function globalSetup() {
	if (process.env.ERD_E2E_REUSE) {
		console.log("e2e: ERD_E2E_REUSE set — trusting whatever is on the port");
		return;
	}
	await probeServer();
}
