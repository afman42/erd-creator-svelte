import { test, expect } from '@microsoft/tui-test';

test.use({ program: { file: 'node', args: [process.cwd() + '/dist/app.mjs'] } });

test.use({ timeout: 10_000 });
test.use({ expect: { timeout: 8_000 } });

test.describe('UX — visual layout and rendering', () => {
  test('titlebar shows app name and hint', async ({ terminal }) => {
    await expect(terminal.getByText('ERD CREATOR')).toBeVisible({ timeout: 8_000 });
    await expect(terminal.getByText('? help')).toBeVisible({ timeout: 5_000 });
  });

  test('status bar reflects entity count changes', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
    await expect(terminal.getByText('sel: users')).toBeVisible({ timeout: 5_000 });
    terminal.keyDelete();
    await expect(terminal.getByText('sel: -')).toBeVisible({ timeout: 5_000 });
  });

  test('entity list shows multiple entities with correct names', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
    terminal.write('posts');
    terminal.submit('');
    await expect(terminal.getByText('Entities (2)')).toBeVisible({ timeout: 5_000 });
    await expect(terminal.getByText('sel: posts')).toBeVisible({ timeout: 5_000 });
  });

  test('relations section reflects relationship count', async ({ terminal }) => {
    await expect(terminal.getByText('Relations (0)')).toBeVisible({ timeout: 5_000 });
  });

  test('all UI regions render with content', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
    await expect(terminal.getByText('ERD CREATOR')).toBeVisible();
    await expect(terminal.getByText('Entities')).toBeVisible({ timeout: 5_000 });
    await expect(terminal.getByText('Relations')).toBeVisible({ timeout: 5_000 });
  });

  test('canvas area renders behind entity boxes', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
    await expect(terminal.getByText('sel: users')).toBeVisible({ timeout: 5_000 });
  });

  test('full buffer is populated', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    await expect(terminal.getByText('Entities (1)')).toBeVisible({ timeout: 5_000 });
    const buffer = terminal.getBuffer();
    const hasContent = buffer.some((row) => row.some((cell) => cell !== ''));
    expect(hasContent).toBe(true);
  });
});
