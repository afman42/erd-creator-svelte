import assert from 'node:assert/strict';
import { emptyModel, addEntity, newField, addField, addRelationship } from './model.js';
import { generateSql } from './sql.js';

let m = emptyModel();
m = addEntity(m, 'users', 0, 0);
m = addField(m, 'users', newField('id', 'INT', { pk: true }));
m = addField(m, 'users', newField('email', 'VARCHAR(255)', { unique: true }));
m = addEntity(m, 'posts', 0, 0);
m = addField(m, 'posts', newField('id', 'INT', { pk: true }));
m = addField(m, 'posts', newField('title', 'VARCHAR(120)'));
m = addEntity(m, 'tags', 0, 0);
m = addField(m, 'tags', newField('id', 'INT', { pk: true }));
m = addRelationship(m, 'users', 'posts', '1:N');
m = addRelationship(m, 'posts', 'tags', 'N:M');

const sql = generateSql(m);
assert.match(sql, /CREATE TABLE `users` \(/);
assert.match(sql, /`id` INT NOT NULL AUTO_INCREMENT/);
assert.match(sql, /PRIMARY KEY \(`id`\)/);
assert.match(sql, /`email` VARCHAR\(255\) NOT NULL UNIQUE/);
assert.match(sql, /`title` VARCHAR\(120\) NOT NULL/);
// 1:N: posts gets users_id FK, no UNIQUE
assert.match(sql, /`users_id` INT NOT NULL,\n\s*PRIMARY KEY/);
assert.match(sql, /FOREIGN KEY \(`users_id`\) REFERENCES `users` \(`id`\)/);
// N:M junction
assert.match(sql, /CREATE TABLE `posts_tags` \(/);
assert.match(sql, /PRIMARY KEY \(`posts_id`, `tags_id`\)/);
assert.match(sql, /CONSTRAINT `fk_posts_tags_a` FOREIGN KEY \(`posts_id`\) REFERENCES `posts` \(`id`\)/);
// 1:1 adds UNIQUE on FK col
let m2 = emptyModel();
m2 = addEntity(m2, 'a', 0, 0);
m2 = addField(m2, 'a', newField('id', 'INT', { pk: true }));
m2 = addEntity(m2, 'b', 0, 0);
m2 = addRelationship(m2, 'a', 'b', '1:1');
assert.match(generateSql(m2), /`a_id` INT NOT NULL UNIQUE/);
// defaultValue produces DEFAULT
let m3 = emptyModel();
m3 = addEntity(m3, 'cfg', 0, 0);
m3 = addField(m3, 'cfg', newField('id', 'INT', { pk: true }));
m3 = addField(m3, 'cfg', newField('value', 'VARCHAR(50)', { defaultValue: '0' }));
const sql3 = generateSql(m3);
assert.match(sql3, /DEFAULT `0`/);
// nullable field omits NOT NULL
let m4 = emptyModel();
m4 = addEntity(m4, 't', 0, 0);
m4 = addField(m4, 't', newField('id', 'INT', { pk: true }));
m4 = addField(m4, 't', newField('note', 'TEXT', { nullable: true }));
const sql4 = generateSql(m4);
assert.ok(sql4.includes('`note` TEXT'));
assert.equal(sql4.includes('`note` TEXT NOT NULL'), false);
// empty model → header only, no CREATE
assert.equal(generateSql(emptyModel()).includes('CREATE TABLE'), false);
// FK skipped when parent has no PK
let m5 = emptyModel();
m5 = addEntity(m5, 'nopk', 0, 0);
m5 = addField(m5, 'nopk', newField('x', 'VARCHAR(10)'));
m5 = addEntity(m5, 'child', 0, 0);
m5 = addField(m5, 'child', newField('id', 'INT', { pk: true }));
m5 = addRelationship(m5, 'nopk', 'child', '1:N');
assert.equal(generateSql(m5).includes('FOREIGN KEY'), false);

console.log('sql.test: all OK');
