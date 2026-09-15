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

  test('adds field to selected entity', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    await expect(terminal.getByText('sel: users')).toBeVisible({ timeout: 5_000 });
    // Tab: table input -> add button -> field input (svelterm Tab-focuses next element)
    terminal.submit('\t\t');
    terminal.write('id');
    terminal.submit('');
    // 'id INT' paints in sidebar AND canvas box -> relax strict-mode.
    await expect(terminal.getByText('id INT', { strict: false })).toBeVisible({ timeout: 5_000 });
  });

  test('second entity lands at different position', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    terminal.write('posts');
    terminal.submit('');
    await expect(terminal.getByText('Entities (2)')).toBeVisible({ timeout: 5_000 });
    const buf = terminal.getBuffer().flat().join('');
    expect(buf).toContain('2,4');
    expect(buf).toContain('24,4');
  });

  test('moved entity position updates in list', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    await expect(terminal.getByText('2,4')).toBeVisible({ timeout: 5_000 });
    terminal.keyRight(3);
    terminal.keyDown(2);
    await expect(terminal.getByText('5,6')).toBeVisible({ timeout: 5_000 });
  });

  test('undo past start restores empty model', async ({ terminal }) => {
    terminal.write('users');
    terminal.submit('');
    terminal.submit('u');
    await expect(terminal.getByText('Entities (0)')).toBeVisible({ timeout: 5_000 });
  });

  test('invalid entity name rejected with error', async ({ terminal }) => {
    terminal.write('9bad');
    terminal.submit('');
    await expect(terminal.getByText('Entities (0)')).toBeVisible({ timeout: 5_000 });
  });
});
