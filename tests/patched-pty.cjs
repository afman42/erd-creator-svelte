const { spawn } = require('/home/afman42/repo/erd-creator/node_modules/.pnpm/node-pty@1.2.0-beta.11/node_modules/node-pty/lib/index.js');

// Inside the child: patch stdin before the app loads
const childCode = `
// Patch before app loads
const origStdin = require('node:process').stdin;
const origOn = origStdin.on.bind(origStdin);
origStdin.on = function(event, handler) {
  if (event === 'data') console.error('CHILD_STDIN_ON_DATA');
  return origOn(event, handler);
};
`;

const pty = spawn('node', ['-e', childCode + " require('./dist/app.mjs');"], {
  name: 'xterm-256color', cols: 120, rows: 30, cwd: '/home/afman42/repo/erd-creator'
});

let out = '';
pty.onData(d => { out += d.toString(); });

setTimeout(() => {
  console.log('READY:', out.includes('ERD CREATOR'));
  console.log('Writing: users\\r');
  pty.write('users\r');
}, 3000);

setTimeout(() => {
  console.log('HAS Users:', out.includes('Users'));
  console.log('CHILD_STDIN_ON_DATA seen:', out.includes('CHILD_STDIN_ON_DATA'));
  const clean = out.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '');
  clean.split('\n').forEach((l) => {
    if (l.includes('STDIN')) console.log('  ' + l);
  });
  pty.kill();
}, 8000);
