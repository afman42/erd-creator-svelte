// Pure, immutable ERD model. Every mutation returns a new model; old snapshots
// are exactly what the undo stack keeps. No UI, no I/O, no runes here.

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// MySQL type whitelist (MVP). Patterns with params normalized on input.
const TYPE_RE = /^(TINYINT|SMALLINT|INT|BIGINT|DECIMAL\(\d{1,3},\d{1,2}\)|FLOAT|DOUBLE|CHAR\(\d{1,3}\)|VARCHAR\(\d{1,5}\)|TEXT|MEDIUMTEXT|LONGTEXT|BLOB|DATE|DATETIME|TIMESTAMP|JSON|BOOLEAN)$/;
const ENUM_RE = /^ENUM\((?:'[^']{1,64}'(?:,'[^']{1,64}')*)\)$/;

function deepClone(o) {
  try { return structuredClone(o); } catch { return JSON.parse(JSON.stringify(o)); }
}

export function normalizeType(raw) {
  const t = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  return t === 'BOOLEAN' ? 'TINYINT(1)' : t;
}

export function isValidType(raw) {
  const t = normalizeType(raw);
  return t === 'TINYINT(1)' || TYPE_RE.test(t) || ENUM_RE.test(t);
}

export function isValidName(name) {
  return NAME_RE.test(name);
}

export function emptyModel() {
  return { version: 1, name: 'untitled', entities: [], relationships: [] };
}

export function newTodo(text) {
  return { id: crypto.randomUUID?.() ?? `t${Date.now()}`, text, done: false };
}

export function addTodo(model, entity, text) {
  assert(text && text.trim().length > 0, `invalid todo: ${text}`);
  return withEntity(model, entity, (e) => {
    e.todos = [...(e.todos || []), newTodo(text)];
    return e;
  });
}

export function removeTodo(model, entity, todoId) {
  return withEntity(model, entity, (e) => {
    e.todos = (e.todos || []).filter(t => t.id !== todoId);
    return e;
  });
}

export function toggleTodo(model, entity, todoId) {
  return withEntity(model, entity, (e) => {
    e.todos = (e.todos || []).map(t => t.id === todoId ? { ...t, done: !t.done } : t);
    return e;
  });
}

export function newField(name, type, opts = {}) {
  return {
    name,
    type: normalizeType(type),
    pk: !!opts.pk,
    nullable: opts.pk ? false : !!opts.nullable,
    unique: !!opts.unique,
    defaultValue: opts.defaultValue || null,
  };
}

function withEntity(model, name, fn) {
  const next = deepClone(model);
  next.entities = next.entities.map((e) => (e.name === name ? fn(e) : e));
  return next;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export function addEntity(model, name, x = 2, y = 2) {
  assert(isValidName(name), `invalid entity name: ${name}`);
  assert(!model.entities.some((e) => e.name === name), `entity exists: ${name}`);
  const next = deepClone(model);
  next.entities.push({ name, x, y, fields: [], todos: [] });
  return next;
}

export function removeEntity(model, name) {
  const next = deepClone(model);
  next.entities = next.entities.filter((e) => e.name !== name);
  next.relationships = next.relationships.filter((r) => r.from !== name && r.to !== name);
  return next;
}

export function moveEntity(model, name, x, y) {
  return withEntity(model, name, (e) => {
    e.x = x;
    e.y = y;
    return e;
  });
}

export function addField(model, entity, field) {
  assert(isValidName(field.name), `invalid field name: ${field.name}`);
  assert(isValidType(field.type), `invalid mysql type: ${field.type}`);
  return withEntity(model, entity, (e) => {
    assert(!e.fields.some((f) => f.name === field.name), `field exists: ${field.name}`);
    e.fields.push(field);
    return e;
  });
}

export function updateField(model, entity, fieldName, patch) {
  if (patch.name !== undefined) assert(isValidName(patch.name), `invalid field name: ${patch.name}`);
  if (patch.type !== undefined) assert(isValidType(patch.type), `invalid mysql type: ${patch.type}`);
  return withEntity(model, entity, (e) => {
    e.fields = e.fields.map((f) => (f.name === fieldName ? { ...f, ...patch, type: patch.type ? normalizeType(patch.type) : f.type } : f));
    return e;
  });
}

export function removeField(model, entity, fieldName) {
  return withEntity(model, entity, (e) => {
    e.fields = e.fields.filter((f) => f.name !== fieldName);
    return e;
  });
}

export const REL_TYPES = ['1:1', '1:N', 'N:M'];

export function addRelationship(model, from, to, type) {
  assert(REL_TYPES.includes(type), `invalid relationship type: ${type}`);
  assert(model.entities.some((e) => e.name === from), `unknown entity: ${from}`);
  assert(model.entities.some((e) => e.name === to), `unknown entity: ${to}`);
  assert(from !== to, 'self-relationship not supported in MVP');
  assert(!model.relationships.some((r) => (r.from === from && r.to === to) || (r.from === to && r.to === from)), 'relationship exists');
  const next = deepClone(model);
  next.relationships.push({ from, to, type });
  return next;
}

export function removeRelationship(model, from, to) {
  const next = deepClone(model);
  next.relationships = next.relationships.filter((r) => !(r.from === from && r.to === to));
  return next;
}

// ponytail: O(n²) clone chain for multi-field/todo entities — batch-construct if models grow past MVP.
// Boundary: .erd JSON (unknown) → trusted ERDModel, or throws. Parse, don't validate.
export function parseErdJson(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('not valid .erd JSON');
  }
  assert(raw.version === 1, 'unsupported .erd version');
  assert(Array.isArray(raw.entities), 'entities must be an array');
  let m = emptyModel();
  m.name = typeof raw.name === 'string' && raw.name ? raw.name : 'untitled';
  for (const e of raw.entities) {
    assert(isValidName(e.name), `bad entity: ${e?.name}`);
    m = addEntity(m, e.name, Number(e.x) || 0, Number(e.y) || 0);
    for (const f of e.fields || []) {
      m = addField(m, e.name, newField(f.name, f.type, f));
    }
    for (const t of e.todos || []) {
      m = addTodo(m, e.name, t.text);
      if (t.done) {
        const todoId = m.entities.at(-1)?.todos?.at(-1)?.id;
        if (todoId) m = toggleTodo(m, e.name, todoId);
      }
    }
  }
  for (const r of raw.relationships || []) {
    m = addRelationship(m, r.from, r.to, r.type);
  }
  return m;
}
export function toErdJson(model) {
  return JSON.stringify(model, null, 2);
}
