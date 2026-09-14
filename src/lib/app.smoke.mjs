// Headless UI smoke: render App, drive keyboard/inputs through the real event
// tree, assert the model round-trips into painted cells. No real terminal.
import assert from 'node:assert/strict';
import { renderHeadless, bufferToText } from '@svelterm/core/headless';
import { tick } from 'svelte';
import App from '../App.svelte';

const { root, buffer, unmount } = renderHeadless(App, { width: 120, height: 30 });
function walk(n, f) {
  f(n);
  for (const c of n.children ?? []) walk(c, f);
}
function find(tag, cls) {
  let hit = null;
  walk(root, (n) => { if (!hit && n.tag === tag && (!cls || (n.attributes.get('class') || '').includes(cls))) hit = n; });
  if (!hit) throw new Error(`no <${tag}> with class ${cls}`);
  return hit;
}
const fire = (n, type, ev = {}) => {
  const hs = n.listeners?.get(type);
  if (!hs) throw new Error(`no ${type} listener`);
  for (const h of hs) h({ type, target: n, stopPropagation() {}, preventDefault() {}, ...ev });
};
const texts = () => { let s = ''; walk(root, (n) => { if (n.text) s += `${n.text}\n`; }); return s; };

// event target — App mounts key handler on div.app, not synthetic root
const appDiv = (() => {
  let h = null;
  walk(root, (n) => { if (!h && n.tag === 'div' && (n.attributes.get('class') || '').split(/\s+/).includes('app')) h = n; });
  return h ?? root;
})();

// 1. add entity 'users' via input + Enter
const entInput = find('input');
fire(entInput, 'input', { data: { value: 'users' } });
await tick();
fire(entInput, 'keydown', { key: 'Enter' });
await tick();
assert.ok(texts().includes('users'), 'entity not added');
assert.ok(texts().includes('(1)'), 'entity count not 1');

// 2. add field id INT PK via checkbox + button
const boxes = []; walk(root, (n) => { if (n.tag === 'input' && n.attributes.get('type') === 'checkbox') boxes.push(n); });
assert.equal(boxes.length, 3, 'expected PK/NULL/UQ checkboxes');
fire(boxes[0], 'change', { data: { checked: true } });
await tick();
const fldInput = (() => { let out = null; walk(root, (n) => { if (n.tag === 'input' && (n.attributes.get('placeholder') || '') === 'name') out = n; }); return out; })();
fire(fldInput, 'input', { data: { value: 'id' } });
await tick();
fire(fldInput, 'keydown', { key: 'Enter' });
await tick();
assert.ok(texts().includes('id INT PK'), 'field not added');

// 3. add entity posts + relationship users 1:N posts
fire(entInput, 'input', { data: { value: 'posts' } });
await tick();
fire(entInput, 'keydown', { key: 'Enter' });
await tick();
assert.ok(texts().includes('posts'));

const allSelects = []; walk(root, (n) => { if (n.tag === 'select') allSelects.push(n); });
assert.ok(allSelects.length >= 3, 'relation selects missing');
const relSelects = allSelects.slice(-3);
fire(relSelects[0], 'change', { data: { value: 'users' } });
fire(relSelects[2], 'change', { data: { value: 'posts' } });
await tick();
let link = null; walk(root, (n) => { if (n.tag === 'button' && n.children.some((c) => c.text === 'link')) link = n; });
fire(link, 'click');
await tick();
assert.ok(texts().includes('Relations (1)'), 'relationship not recorded');

// 4. undo (key 'u' on app div, not root — handler is on div.app)
fire(appDiv, 'keydown', { key: 'u' });
await tick();
assert.ok(texts().includes('Relations (0)'), 'undo failed');
fire(appDiv, 'keydown', { key: 'r' });
await tick();
assert.ok(texts().includes('Relations (1)'), 'redo failed');
  // 5. arrow moves selected entity (posts currently selected by add) — check still present and coords present
  fire(appDiv, 'keydown', { key: 'ArrowRight' });
  await tick();
  assert.ok(texts().includes('posts'), 'posts missing after move');
  assert.ok(/\d+,\d+/.test(texts()), 'coord readout missing');
assert.ok(bufferToText(buffer).includes('\u2500') || texts().includes('\u2500'), 'no edge line painted');

unmount();
console.log('app.test: all OK');
