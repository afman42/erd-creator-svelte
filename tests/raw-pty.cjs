const { spawn } = require('/home/afman42/repo/erd-creator/node_modules/.pnpm/node-pty@1.2.0-beta.11/node_modules/node-pty/lib/index.js');
const pty = spawn('node', ['-e', 'console.log("START"); console.error("STDERR: START"); process.stdin.once("data", d => { console.log("GOT:", d.toString()); }); console.log("READY"); console.error("STDERR: READY");'], {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: '/home/afman42/repo/erd-creator'
});
let out = '';
pty.onData(d => { out += d.toString(); });
pty.onExit(e => { console.log('EXIT code:', e.exitCode); console.log('EXIT signal:', e.signal); });
setTimeout(() => {
  console.log('READY CHECK:', out.includes('READY'));
  pty.write('hello\r');
  console.log('WROTE hello\\r');
}, 2000);
setTimeout(() => {
  console.log('OUTPUT:', out);
  console.log('STDERR:', out.match(/STDERR:.*?$/gm));
  pty.kill();
}, 6000);
