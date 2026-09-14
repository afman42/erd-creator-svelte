import assert from 'node:assert/strict';
import {
  emptyModel, addEntity, removeEntity, moveEntity, newField, addField,
  updateField, removeField, addRelationship, removeRelationship,
  parseErdJson, toErdJson, isValidType, isValidName,
} from './model.js';

// immutability: prior snapshot untouched after mutation
let m = emptyModel();
const s0 = m;
m = addEntity(m, 'users', 2, 2);
assert.equal(s0.entities.length, 0, 'old model mutated');

m = addField(m, 'users', newField('id', 'int', { pk: true }));
assert.deepEqual(m.entities[0].fields[0].type, 'INT');
assert.equal(m.entities[0].fields[0].nullable, false, 'PK must be NOT NULL by default');
m = addField(m, 'users', newField('email', 'varchar(255)', { unique: true }));

m = addEntity(m, 'posts', 30, 10);
m = addField(m, 'posts', newField('user_id', 'INT'));
m = addRelationship(m, 'users', 'posts', '1:N');

// move returns new object, old coords intact
const before = m;
m = moveEntity(m, 'posts', 31, 11);
assert.equal(before.entities[1].x, 30);
assert.equal(m.entities[1].x, 31);

// removeEntity cascades relationships
let c = removeEntity(m, 'posts');
assert.equal(c.relationships.length, 0);

// field update/remove
c = updateField(m, 'users', 'email', { nullable: true });
assert.equal(c.entities[0].fields[1].nullable, true);
assert.equal(m.entities[0].fields[1].nullable, false);
c = removeField(m, 'users', 'email');
assert.equal(c.entities[0].fields.length, 1);

// boundary rejections
assert.throws(() => addEntity(m, 'bad name!'));
assert.throws(() => addEntity(m, 'users'));                       // duplicate
assert.throws(() => addField(m, 'users', newField('ok', 'BLOB(5)'))); // invalid type
assert.throws(() => addRelationship(m, 'users', 'ghost', '1:N')); // unknown entity
assert.throws(() => addRelationship(m, 'users', 'posts', '1:N')); // dup
// remove then re-add with other type is legal
const rr = addRelationship(removeRelationship(m, 'users', 'posts'), 'users', 'posts', 'N:M');
assert.equal(rr.relationships.length, 1);
assert.ok(isValidType('decimal(10,2)') && isValidType("ENUM('a','b')") && !isValidType('SQL_INJECTION'));
assert.ok(isValidName('_t1') && !isValidName('1x') && !isValidName('a'.repeat(65)));

// TODO list CRUD
import { addTodo, removeTodo, toggleTodo } from './model.js';
m = addTodo(m, 'users', 'setup db');
assert.equal(m.entities[0].todos.length, 1);
assert.equal(m.entities[0].todos[0].text, 'setup db');
assert.equal(m.entities[0].todos[0].done, false);
m = toggleTodo(m, 'users', m.entities[0].todos[0].id);
assert.equal(m.entities[0].todos[0].done, true);
m = removeTodo(m, 'users', m.entities[0].todos[0].id);
assert.equal(m.entities[0].todos.length, 0);

// extra gaps: self-rel, reverse dup, field dup, BOOLE normalize, parse bad rel, empty todo
assert.throws(() => addRelationship(m, 'users', 'users', '1:N'), /self-relationship/);
assert.throws(() => addRelationship(m, 'posts', 'users', '1:N'), /relationship exists/); // reverse dup
assert.throws(() => addField(m, 'users', newField('id', 'INT')), /field exists/);
assert.throws(() => updateField(m, 'users', 'email', { name: 'bad name!' }), /invalid field name/);
assert.throws(() => updateField(m, 'users', 'email', { type: 'BLOB(5)' }), /invalid mysql type/);
assert.throws(() => addTodo(m, 'users', ''), /invalid todo/);
assert.throws(() => addTodo(m, 'users', '   '), /invalid todo/);
// BOOLEAN → TINYINT(1) normalization
assert.equal(isValidType('boolean'), true);
assert.equal(isValidType('BOOLEAN'), true);
assert.equal(isValidType('tinyint(1)'), true);
assert.equal(newField('x', 'boolean').type, 'TINYINT(1)');
assert.equal(isValidType('VARCHAR(10)'), true);
assert.equal(isValidType('VARCHAR(99999)'), true);
assert.equal(isValidType('VARCHAR(100000)'), false);
// parse bad relationship unknown entity throws
assert.throws(() => parseErdJson(JSON.stringify({ version: 1, entities: [{ name: 'a', x: 0, y: 0, fields: [] }, { name: 'b', x: 0, y: 0, fields: [] }], relationships: [{ from: 'a', to: 'ghost', type: '1:N' }] })), /unknown entity/);
// todo done roundtrip
let mt = emptyModel(); mt = addEntity(mt, 't', 0, 0); mt = addTodo(mt, 't', 'do it'); const tid = mt.entities[0].todos[0].id; mt = toggleTodo(mt, 't', tid);
const j2 = toErdJson(mt); const rt = parseErdJson(j2); assert.equal(rt.entities[0].todos[0].done, true);
// immutability: addTodo old untouched
const snap = mt; const mt2 = addTodo(mt, 't', 'second'); assert.equal(snap.entities[0].todos.length, 1);
// normalize trims/cases
assert.equal(newField('f', ' varchar(10) ').type, 'VARCHAR(10)');

console.log('model.test: all OK');
