// Direct PTY test: spawn node, send input, check output
import { spawn } from 'node:child_process';

const p = spawn('node', ['dist/app.mjs'], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe']
});

let output = '';
let exitCode = null;

p.stdout.on('data', (data) => {
  output += data.toString();
});

p.stderr.on('data', (data) => {
  process.stderr.write(data);
});

p.on('exit', (code) => {
  exitCode = code;
  console.log(`\nExit code: ${code}`);
  console.log(`Output length: ${output.length}`);
  console.log(`Has Users: ${output.includes('Users')}`);
  const clean = output.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '');
  console.log(`Visible has Users: ${clean.includes('Users')}`);
  process.exit(code === 0 ? 0 : 1);
});

// Wait for initial render
p.on('spawn', () => {
  setTimeout(() => {
    console.log('Sending: users\\n');
    p.stdin.write('users\n');
    
    setTimeout(() => {
      console.log('Has Users:', output.includes('Users'));
      p.kill('SIGINT');
    }, 3000);
  }, 2000);
});
