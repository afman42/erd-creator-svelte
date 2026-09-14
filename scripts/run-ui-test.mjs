// Runner: headless UI smoke via Vite's terminal environment (custom renderer).
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'warn' });
try {
  // App.svelte needs the terminal environment's customRenderer; ssr/client won't compile it.
  const runner = server.environments?.terminal?.runner;
  if (runner?.import) {
    await runner.import('/src/lib/app.smoke.mjs');
  } else {
    // fallback — older Vite without environments.terminal
    await server.ssrLoadModule('/src/lib/app.smoke.mjs');
  }
} finally {
  await server.close();
}
