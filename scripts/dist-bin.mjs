#!/usr/bin/env node
// scripts/dist-bin.mjs
// Bun compile: bundle → platform-specific binary
// Usage: pnpm run dist:bin  (current platform)
//        bun build --compile dist/app.mjs --outfile erd-creator-linux
//        bun build --compile dist/app.mjs --outfile erd-creator-darwin
//        bun build --compile dist/app.mjs --outfile erd-creator-win.exe

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform } from 'node:os';

const bundle = 'dist/app.mjs';

try {
    readFileSync(bundle);
} catch {
    console.error('Error: build first — run `pnpm run build` then `pnpm run dist:bin`');
    process.exit(1);
}

const p = platform();
const ext = p === 'win32' ? '.exe' : p === 'darwin' ? '-darwin' : '-linux';
const out = `erd-creator${ext}`;
console.log(`Compiling ${bundle} → ${out} (bun compile, ${p})`);
try {
    execSync(`bun build --compile ${bundle} --outfile ${out}`, { stdio: 'inherit' });
    console.log(`Done: ./${out}`);
} catch (e) {
    console.error('Bun compile failed. Install bun first: https://bun.sh');
    process.exit(1);
}
