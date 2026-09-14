import assert from 'node:assert/strict';
import { boxRect, rectsFor, fieldLabel } from './layout.js';
import { emptyModel, addEntity, newField, addField } from './model.js';

// fieldLabel variants
assert.equal(fieldLabel({ name: 'id', type: 'INT', pk: true }), 'id INT PK');
assert.equal(fieldLabel({ name: 'e', type: 'VARCHAR(10)', unique: true }), 'e VARCHAR(10) UQ');
assert.equal(fieldLabel({ name: 'n', type: 'TEXT', nullable: true }), 'n TEXT NULL');
assert.equal(fieldLabel({ name: 'x', type: 'INT', pk: true, unique: true }), 'x INT PK UQ');
assert.equal(fieldLabel({ name: 'a', type: 'INT' }), 'a INT');

// boxRect: empty entity min width 8 + border 2 = 10, height 3
let r = boxRect({ name: 'ab', x: 1, y: 2, fields: [] });
assert.equal(r.x, 1); assert.equal(r.y, 2);
assert.equal(r.h, 3); // border + name + border
assert.equal(r.w, 10); // max(8,2)+2
assert.ok(r.inner === 8);

// boxRect: field widens box
r = boxRect({ name: 't', x: 0, y: 0, fields: [{ name: 'very_long_field_name', type: 'VARCHAR(255)', pk: false, unique: false, nullable: false }] });
assert.ok(r.w > 10);
assert.equal(r.h, 4); // 1 field + 3

// rectsFor: map by name
let m = emptyModel();
m = addEntity(m, 'users', 2, 3);
m = addField(m, 'users', newField('id', 'INT', { pk: true }));
m = addEntity(m, 'posts', 30, 5);
const map = rectsFor(m);
assert.ok(map.has('users') && map.has('posts'));
assert.equal(map.get('users').x, 2);
assert.equal(map.get('posts').x, 30);
assert.equal(map.size, 2);

console.log('layout.test: all OK');
