const { spawn } = require('/home/afman42/repo/erd-creator/node_modules/.pnpm/node-pty@1.2.0-beta.11/node_modules/node-pty/lib/index.js');
const pty = spawn('node', ['/home/afman42/repo/erd-creator/dist/app.mjs'], {
  name: 'xterm-256color', cols: 120, rows: 30, cwd: '/home/afman42/repo/erd-creator'
});
let out = '';
pty.onData(d => { out += d.toString(); });
setTimeout(() => {
  console.log('Writing: users\\r');
  pty.write('users\r');
}, 3000);
setTimeout(() => {
  console.log('OUTPUT LENGTH:', out.length);
  const lines = out.split('\n');
  for (const line of lines) {
    if (line.includes('KEY_DATA') || line.includes('KEY_DATA') || line.includes('Error') || line.includes('byte')) {
      console.log('MATCH:', line.substring(0, 200));
    }
  }
  // Check for crash
  console.log('Exit:', out.includes('at Readable.push'));
  pty.kill();
}, 8000);
