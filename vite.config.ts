import { defineConfig } from 'vite'
import { svelterm } from '@svelterm/core/vite'

// Terminal-only app — svelterm's plugins compile .svelte for the
// terminal environment; no vite-plugin-svelte needed. (Dual-target
// browser + terminal setups do need it — see
// https://svelterm.dev/docs/getting-started.)
export default defineConfig({
    plugins: [
        ...svelterm.terminalServer({ entry: './src/App.svelte' }),
    ],
    environments: svelterm.environments(),
    optimizeDeps: { exclude: ['svelte'] },
    ssr: { noExternal: ['svelte'] },
})
