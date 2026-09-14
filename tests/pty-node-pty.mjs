import { spawn } from '/home/afman42/repo/erd-creator/node_modules/.pnpm/node-pty@1.2.0-beta.11/node_modules/node-pty/lib/index.js';
// node-pty loaded above

const pty = spawn('node', ['dist/app.mjs'], {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: process.cwd()
});

let output = '';
let rendered = false;

pty.onData((data) => {
  output += data.toString();
  if (!rendered && output.includes('ERD CREATOR') && output.includes('Entities')) {
    rendered = true;
    console.log('=== APP RENDERED ===');
    console.log('Output length:', output.length);
    // Type 'users' then Enter
    console.log('Writing: users\r');
    pty.write('users\r');
  }
  if (output.includes('Users')) {
    console.log('=== SUCCESS: Users found! ===');
    pty.kill();
    process.exit(0);
  }
});

setTimeout(() => {
  console.log('\n=== TIMEOUT ===');
  console.log('Output length:', output.length);
  console.log('Has Users:', output.includes('Users'));
  const clean = output.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '');
  console.log('Visible has Users:', clean.includes('Users'));
  console.log('Last 300 chars:', clean.slice(-300));
  pty.kill();
  process.exit(1);
}, 8000);
