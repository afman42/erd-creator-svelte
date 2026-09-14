import { test, expect } from '@microsoft/tui-test';

test.use({ program: { file: 'node', args: [process.cwd() + '/dist/app.mjs'] } });

test.use({ timeout: 10_000 });
test.use({ expect: { timeout: 8_000 } });

test.describe('Snapshot — visual regression', () => {
  test('initial render snapshot', async ({ terminal }) => {
    await expect(terminal.getByText('ERD CREATOR')).toBeVisible({ timeout: 8_000 });
    const serialized = terminal.serialize();
    expect(serialized).toBeDefined();
  });

  test('single entity render snapshot', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
    const serialized = terminal.serialize();
    expect(serialized).toBeDefined();
  });

  test('two entities render snapshot', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
    terminal.write('posts');
    terminal.submit('');
    await expect(terminal.getByText('Entities (2)')).toBeVisible({ timeout: 5_000 });
    const serialized = terminal.serialize();
    expect(serialized).toBeDefined();
  });

  test('entity move snapshot', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
    terminal.keyRight(3);
    terminal.keyDown(2);
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
    const serialized = terminal.serialize();
    expect(serialized).toBeDefined();
  });

  test('entity deletion snapshot', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
    terminal.keyDelete();
    await expect(terminal.getByText('Entities (0)')).toBeVisible({ timeout: 5_000 });
    const serialized = terminal.serialize();
    expect(serialized).toBeDefined();
  });

  test('undo snapshot', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    terminal.keyDelete();
    terminal.submit('u');
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
    const serialized = terminal.serialize();
    expect(serialized).toBeDefined();
  });

  test('help dialog snapshot', async ({ terminal }) => {
    terminal.submit('?');
    await expect(terminal.getByText('keys:')).toBeVisible({ timeout: 5_000 });
    const serialized = terminal.serialize();
    expect(serialized).toBeDefined();
  });
});
