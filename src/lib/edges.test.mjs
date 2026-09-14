import assert from 'node:assert/strict';
import { emptyModel, addEntity, newField, addField, addRelationship } from './model.js';
import { boxRect, rectsFor } from './layout.js';
import { edgeGrid } from './edges.js';

let m = emptyModel();
m = addEntity(m, 'users', 2, 2);
m = addField(m, 'users', newField('id', 'INT', { pk: true }));
m = addEntity(m, 'posts', 26, 8);
m = addField(m, 'posts', newField('user_id', 'INT'));
m = addField(m, 'posts', newField('body', 'TEXT', { nullable: true }));
m = addRelationship(m, 'users', 'posts', '1:N');

const rects = rectsFor(m);
const a = rects.get('users'), b = rects.get('posts');
assert.ok(a.w >= 'users'.length + 2 && a.h === 4); // border+name+1 field+border
assert.ok(b.h === 5); // border+name+2 fields+border

const grid = edgeGrid(m, rects, 60, 16);
assert.ok(grid.includes('─'), 'no horizontal run');
assert.ok(grid.includes('3'), 'no many-side marker');
assert.ok(grid.includes('│'), 'no vertical/one-side');
// elbow when rows differ
assert.ok(grid.includes('┘') || grid.includes('┐') || grid.includes('┌') || grid.includes('└'), 'no bend glyph');

// same-row relationship: pure horizontal
m = addEntity(m, 'x', 46, 3);
m = addField(m, 'x', newField('id', 'INT', { pk: true }));
m = addRelationship(m, 'posts', 'x', '1:N');
const g2 = edgeGrid(m, rectsFor(m), 70, 16);
assert.ok(g2.includes('3'), 'posts→x many marker missing');
assert.ok(g2.includes('┌') || g2.includes('└') || g2.includes('┐') || g2.includes('┘'), 'elbow expected (rows differ)');

// vertical-overlap skip: boxes stacked with overlapping x-range → no line
let mv = emptyModel();
mv = addEntity(mv, 'a', 2, 2); mv = addField(mv, 'a', newField('id', 'INT', { pk: true }));
mv = addEntity(mv, 'b', 4, 6); mv = addField(mv, 'b', newField('id', 'INT', { pk: true }));
mv = addRelationship(mv, 'a', 'b', '1:N');
const gOverlap = edgeGrid(mv, rectsFor(mv), 40, 16);
assert.equal(gOverlap.includes('─'), false, 'vertical overlap should skip');

// missing rect → skipped (no crash, blank grid)
let mm2 = emptyModel();
mm2 = addEntity(mm2, 'a', 2, 2); mm2 = addField(mm2, 'a', newField('id', 'INT', { pk: true }));
mm2.relationships.push({ from: 'a', to: 'ghost', type: '1:N' });
const gGhost = edgeGrid(mm2, rectsFor(mm2), 40, 16);
assert.equal(gGhost.includes('─'), false, 'missing rect should produce no line');

// crossing → ┼ at intersection
let mc = emptyModel();
mc = addEntity(mc, 'left1', 0, 2); mc = addField(mc, 'left1', newField('id', 'INT', { pk: true }));
mc = addEntity(mc, 'right1', 30, 2); mc = addField(mc, 'right1', newField('id', 'INT', { pk: true }));
mc = addEntity(mc, 'left2', 0, 8); mc = addField(mc, 'left2', newField('id', 'INT', { pk: true }));
mc = addEntity(mc, 'right2', 30, 8); mc = addField(mc, 'right2', newField('id', 'INT', { pk: true }));
mc = addRelationship(mc, 'left1', 'right1', '1:N');
mc = addRelationship(mc, 'left2', 'right2', '1:N');
// left entity as b (to) should render when b left of a
let ml = emptyModel();
ml = addEntity(ml, 'right', 30, 4); ml = addField(ml, 'right', newField('id', 'INT', { pk: true }));
ml = addEntity(ml, 'left', 2, 8); ml = addField(ml, 'left', newField('id', 'INT', { pk: true }));
ml = addRelationship(ml, 'right', 'left', '1:N');
const gLeft = edgeGrid(ml, rectsFor(ml), 60, 16);
assert.ok(gLeft.includes('─') || gLeft.includes('│'), 'right→left should still render');

// 1:1 uses │ not 3 at both ends
let m11 = emptyModel();
m11 = addEntity(m11, 'aa', 2, 2); m11 = addField(m11, 'aa', newField('id', 'INT', { pk: true }));
m11 = addEntity(m11, 'bb', 26, 2); m11 = addField(m11, 'bb', newField('id', 'INT', { pk: true }));
m11 = addRelationship(m11, 'aa', 'bb', '1:1');
const g11 = edgeGrid(m11, rectsFor(m11), 50, 10);
assert.equal(g11.includes('3'), false, '1:1 should not have 3 marker');
assert.ok(g11.includes('│'), '1:1 should have │ markers');

console.log('edges.test: all OK');
