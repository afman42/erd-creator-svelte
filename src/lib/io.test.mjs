import assert from 'node:assert/strict';
import { emptyModel, addEntity, newField, addField, addRelationship, addTodo, toggleTodo, parseErdJson, toErdJson } from './model.js';
import { generateSql } from './sql.js';
import { exportSvg } from './export.js';

function makeFakeIo() {
  const store = new Map();
  return {
    store,
    read: async (p) => { if (!store.has(p)) throw new Error(`ENOENT: ${p}`); return store.get(p); },
    write: async (p, data) => { store.set(p, data); },
  };
}

const io = makeFakeIo();

// .erd roundtrip via seam
let m = emptyModel();
m.name = 'shop';
m = addEntity(m, 'users', 2, 2);
m = addField(m, 'users', newField('id', 'INT', { pk: true }));
m = addField(m, 'users', newField('email', 'VARCHAR(255)', { unique: true }));
m = addEntity(m, 'posts', 30, 5);
m = addField(m, 'posts', newField('id', 'INT', { pk: true }));
m = addRelationship(m, 'users', 'posts', '1:N');
m = addTodo(m, 'users', 'seed data');
m = toggleTodo(m, 'users', m.entities[0].todos[0].id);

const erd = toErdJson(m);
await io.write('shop.erd', erd);
const loaded = parseErdJson(await io.read('shop.erd'));
assert.deepEqual(loaded.entities.length, 2);
assert.equal(loaded.entities[0].todos[0].done, true);
assert.deepEqual(loaded.relationships.length, 1);
assert.equal(loaded.name, 'shop');

// missing file
await assert.rejects(() => io.read('missing.erd'), /ENOENT/);

// .sql via seam
const sql = generateSql(m);
await io.write('shop.sql', sql);
assert.ok((await io.read('shop.sql')).includes('CREATE TABLE `users`'));
assert.ok((await io.read('shop.sql')).includes('FOREIGN KEY'));

// .svg via seam
const svg = exportSvg(m, 80, 40);
await io.write('shop.svg', svg);
assert.ok((await io.read('shop.svg')).includes('<svg'));
assert.ok((await io.read('shop.svg')).includes('users'));

// overwrite
await io.write('shop.erd', toErdJson(emptyModel()));
assert.equal(parseErdJson(await io.read('shop.erd')).entities.length, 0);

console.log('io.test: all OK');
