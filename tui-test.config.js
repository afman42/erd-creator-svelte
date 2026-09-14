export default {
  testDir: 'tests',
  timeout: 15_000,
  expect: { timeout: 8_000 },
  retries: 0,
  trace: false,
  use: {
    program: {
      file: 'node',
      args: [process.cwd() + '/dist/app.mjs'],
    },
  },
};
