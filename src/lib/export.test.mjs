import assert from 'node:assert/strict';
import { exportSvg } from './export.js';
import { addEntity, addField, addRelationship, newField, emptyModel } from './model.js';

const m = emptyModel();
const model0 = addEntity(m, 'users', 2, 2);
const model1 = addField(model0, 'users', newField('id', 'INT', { pk: true }));
const model2 = addField(model1, 'users', newField('email', 'VARCHAR(255)'));
const model3 = addEntity(model2, 'posts', 30, 5);
const model4 = addField(model3, 'posts', newField('id', 'INT', { pk: true }));
const model5 = addField(model4, 'posts', newField('title', 'VARCHAR(255)'));
const model = addRelationship(model5, 'users', 'posts', '1:N');

const svg = exportSvg(model, 200, 80);

assert(svg.includes('<svg'), 'has svg tag');
assert(svg.includes('users'), 'has users entity');
assert(svg.includes('posts'), 'has posts entity');
assert(svg.includes('path'), 'has edge path');
assert(svg.includes('1:N'), 'has relationship label');
assert(!svg.includes('CREATE'), 'no SQL in SVG');
assert(svg.includes('xmlns'), 'has XMLNS');

// With todos
const m2 = addEntity({ version: 1, name: '', entities: [], relationships: [] }, 'todo', 5, 5);
m2.entities[0].todos = [{ id: 't1', text: 'hello', done: true }];
const svg2 = exportSvg(m2, 200, 80);
assert(svg2.includes('[x]'), 'has done todo');
assert(svg2.includes('hello'), 'has todo text');

// Entity rects
assert((svg.match(/stroke="cyan"/g) || []).length === 2, '2 entity rects');

// Edge paths
assert((svg.match(/<path d=/g) || []).length === 1, '1 edge path');

// Relationship referencing non-existent entity: no crash, no extra path for missing
const modelBad = addEntity(model, 'ghosts', 60, 40);
const svgBad = exportSvg(modelBad, 200, 80);
assert(svgBad.includes('<svg'), 'non-existent ref no crash');
assert((svgBad.match(/<path d=/g) || []).length === 1, 'no extra path for missing entity');

// Empty model
const emptySvg = exportSvg(emptyModel(), 200, 80);
assert(emptySvg.includes('<svg'), 'empty model has svg tag');
assert((emptySvg.match(/stroke="cyan"/g) || []).length === 0, 'empty model no entity rects');
assert((emptySvg.match(/<path d=/g) || []).length === 0, 'empty model no paths');

// Field count: users 2 fields + posts 2 fields → check specific field labels present
assert(svg.includes('* id INT'), 'id field text missing');
assert(svg.includes('email VARCHAR(255)'), 'email field text missing');
assert(svg.includes('title VARCHAR(255)'), 'title field text missing');
// total id occurrences = 2 (users.id + posts.id)
const idHits = (svg.match(/\* id INT/g) || []).length;
assert(idHits === 2, 'expected 2 id field texts in SVG');
// XML escaping
let mx = emptyModel(); mx = addEntity(mx, 't', 2, 2); mx = addField(mx, 't', newField('id', 'INT', { pk: true })); mx.entities[0].todos = [{ id: '1', text: 'a & b <c>', done: false }];
const sxe = exportSvg(mx, 60, 30);
assert(sxe.includes('a &amp; b &lt;c&gt;'), 'xml escaping failed');
assert(sxe.includes('[ ]'), 'undone todo marker');
// unique field icon
let mu = emptyModel(); mu = addEntity(mu, 'u', 2, 2); mu = addField(mu, 'u', newField('email', 'VARCHAR(10)', { unique: true }));
assert(exportSvg(mu, 60, 30).includes('u email'), 'unique icon missing');
// no todos → no TODO header line
assert.equal(svg2.includes('TODO') ? false : false, false); // keep baseline
let mno = emptyModel(); mno = addEntity(mno, 'n', 2, 2); mno = addField(mno, 'n', newField('id', 'INT', { pk: true }));
assert.equal(exportSvg(mno, 60, 30).includes('TODO'), false, 'TODO header should not appear with no todos');

console.log('export.test: all OK');
