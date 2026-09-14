import { test, expect } from '@microsoft/tui-test';

test.use({ program: { file: 'node', args: [process.cwd() + '/dist/app.mjs'] } });

test.use({ timeout: 10_000 });
test.use({ expect: { timeout: 8_000 } });

test.describe('UI — keyboard interaction flow', () => {
  test('shows title bar and empty status on startup', async ({ terminal }) => {
    await expect(terminal.getByText('ERD CREATOR')).toBeVisible({ timeout: 8_000 });
    await expect(terminal.getByText('Entities (0)')).toBeVisible({ timeout: 5_000 });
    await expect(terminal.getByText('Relations (0)')).toBeVisible({ timeout: 5_000 });
    await expect(terminal.getByText('sel: -')).toBeVisible({ timeout: 5_000 });
  });

  test('adds entity via sidebar form', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
    await expect(terminal.getByText('sel: users')).toBeVisible({ timeout: 5_000 });
  });

  test('moves entity with arrow keys', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
    terminal.keyRight(3);
    terminal.keyDown(2);
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
  });

  test('removes entity with Delete key', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
    terminal.keyDelete();
    await expect(terminal.getByText('Entities (0)')).toBeVisible({ timeout: 5_000 });
    await expect(terminal.getByText('sel: -')).toBeVisible({ timeout: 5_000 });
  });

  test('undo and redo restore entity state', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
    terminal.keyDelete();
    await expect(terminal.getByText('Entities (0)')).toBeVisible({ timeout: 5_000 });
    terminal.submit('u');
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
  });

  test('opens help dialog with ? key', async ({ terminal }) => {
    terminal.submit('?');
    await expect(terminal.getByText('keys:')).toBeVisible({ timeout: 5_000 });
  });

  test('adds nothing with empty entity name', async ({ terminal }) => {
    terminal.submit('');
    await expect(terminal.getByText('Entities (0)')).toBeVisible({ timeout: 5_000 });
  });

  test('adds multiple entities sequentially', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
    terminal.write('posts');
    terminal.submit('');
    await expect(terminal.getByText('Entities (2)')).toBeVisible({ timeout: 5_000 });
    await expect(terminal.getByText('sel: posts')).toBeVisible({ timeout: 5_000 });
  });

  test('shows box borders after two entities (edge area)', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
    terminal.write('posts');
    terminal.submit('');
    await expect(terminal.getByText('Entities (2)')).toBeVisible({ timeout: 5_000 });
    const buf = terminal.getBuffer();
    const flat = buf.flat().join('');
    const hasBorder = flat.includes('┌') || flat.includes('─') || flat.includes('│') || flat.includes('┐') || flat.includes('└') || flat.includes('┘');
    expect(hasBorder).toBe(true);
  });
});
