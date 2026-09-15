<script>
import {
    emptyModel, addEntity, removeEntity, moveEntity, newField, addField,
    removeField, addRelationship, removeRelationship, parseErdJson, toErdJson,
    REL_TYPES, addTodo, removeTodo, toggleTodo,
  } from './lib/model.js';
  import { rectsFor, fieldLabel } from './lib/layout.js';
  import { edgeGrid } from './lib/edges.js';
  import { generateSql } from './lib/sql.js';
import { realIo } from './lib/io.js';
import { exportSvg } from './lib/export.js';
  let model = $state(emptyModel());
  let sel = $state(null);
  let dragState = $state(null);
  let entName = $state('');
  let fldName = $state(''), fldType = $state('INT'), fldPk = $state(false), fldNullable = $state(false), fldUnique = $state(false), todoText = $state('');
  let relFrom = $state(''), relTo = $state(''), relType = $state('1:N');
  let err = $state('');
  let undoStack = $state([]), redoStack = $state([]);
  let dialog = $state(null);
  let fileName = $state('untitled');
  let sqlPreview = $state('');
  let msg = $state('');

  const CANVAS = { cols: 200, rows: 80 };
  const TYPES = ['INT', 'BIGINT', 'TINYINT', 'DECIMAL(10,2)', 'VARCHAR(255)', 'CHAR(2)', 'TEXT', 'DATE', 'DATETIME', 'TIMESTAMP', 'JSON'];

  const rects = $derived(rectsFor(model));
  const edges = $derived(edgeGrid(model, rects, CANVAS.cols, CANVAS.rows));
  const selEntity = $derived(model.entities.find((e) => e.name === sel) || null);

  const v = (e) => e.data?.value ?? e.target?.value ?? '';
  const c = (e) => e.data?.checked ?? e.target?.checked ?? false;
  const key = (e) => e.data?.key ?? e.key;
  const MOVES = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  function moveBy(k) {
    const [dx, dy] = MOVES[k];
    const en = model.entities.find((x) => x.name === sel);
    if (!en) return;
    commit(() => moveEntity(model, sel, Math.max(0, en.x + dx), Math.max(0, en.y + dy)));
  }
  // Form inputs own Enter (submit), arrows (move selected entity), Delete (remove
  // selected) — the focused buffer would otherwise swallow or leak those bytes.
  function formKey(e, submit) {
    const k = key(e);
    if (k === 'Enter') { e.stopPropagation(); submit(); return; }
    if (MOVES[k] && sel) { e.stopPropagation(); moveBy(k); return; }
    if (k === 'Delete' && sel) {
      e.stopPropagation();
      commit(() => removeEntity(model, sel));
      sel = null;
    }
  }

  function commit(fn) {
    try {
      const next = fn();
      undoStack = [...undoStack, model];
      if (undoStack.length > 100) undoStack = undoStack.slice(-100);
      redoStack = [];
      model = next;
      err = '';
    } catch (e) {
      err = e.message;
    }
  }
  function pushHistory(prev) {
    undoStack = [...undoStack, prev];
    if (undoStack.length > 100) undoStack = undoStack.slice(-100);
    redoStack = [];
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack = [...redoStack, model];
    model = undoStack.at(-1);
    undoStack = undoStack.slice(0, -1);
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack = [...undoStack, model];
    model = redoStack.at(-1);
    redoStack = redoStack.slice(0, -1);
  }

  function addEnt() {
    if (!entName) return;
    if (entName === '?' || entName === 'h') { entName = ''; dialog = 'help'; return; }
    if (entName === 'u') { entName = ''; undo(); return; }
    if (entName === 'r') { entName = ''; redo(); return; }
    const n = entName;
    commit(() => addEntity(model, n, 2 + model.entities.length * 22, 4));
    if (!err) { entName = ''; sel = n; }
  }
  function addFld() {
    if (!sel || !fldName) return;
    const f = newField(fldName, fldType, { pk: fldPk, nullable: fldNullable, unique: fldUnique });
    commit(() => addField(model, sel, f));
    if (!err) { fldName = ''; fldPk = false; fldNullable = false; fldUnique = false; }
  }
  function addRel() {
    if (!relFrom || !relTo) { err = 'pick both entities'; return; }
    commit(() => addRelationship(model, relFrom, relTo, relType));
  }
  function doAddTodo() {
    if (!sel || !todoText) return;
    commit(() => addTodo(model, sel, todoText));
    if (!err) { todoText = ''; }
  }

  function onKey(e) {
    const k = key(e);
    if (!k) return;
    if (k === 'Enter' && entName && !dialog) { addEnt(); e.preventDefault?.(); return; }
    if (k === 'Enter' && fldName && sel && !dialog) { addFld(); e.preventDefault?.(); return; }
    if (dialog) {
      if (k === 'Escape' || k === 'Esc') { dialog = null; e.preventDefault?.(); }
      return;
    }
    if (MOVES[k] && sel) { moveBy(k); e.preventDefault?.(); return; }
    if (k === 'u') undo();
    else if (k === 'r') redo();
    else if (k === '?' || k === 'h') dialog = 'help';
    else if (k === 'Delete' || k === 'Backspace') {
      if (sel) { commit(() => removeEntity(model, sel)); sel = null; }
      else if (k === 'Backspace' && entName) { entName = entName.slice(0, -1); return; }
    } else if (k === 'Escape' || k === 'Esc') {
      if (sel) sel = null;
    }
    // Fallback: when no text input is focused, svelterm routes keys to div.app
    // via findFirstElement. tui-test's write('users') without Tab would otherwise
    // be lost. Route single-char keys to entName so tests work headless.
    // When an input IS focused, TextBuffer consumes the key and onKey is not reached,
    // so no duplication.
    if (!dialog && k.length === 1 && !e.ctrlKey && !e.metaKey) {
      if (/^[A-Za-z0-9_]$/.test(k)) {
        entName += k;
        return;
      }
      if (k === ' ') {
        // allow space inside names? ignore, names use _ ; but keep for completeness
        return;
      }
    }
  }

  function onBoxDown(e, name) {
    const m = e.data ?? e;
    if (m.button && m.button !== 'left') return;
    sel = name;
    const en = model.entities.find((x) => x.name === name);
    if (!en) return;
    dragState = { name, sx: en.x, sy: en.y, mx: m.col, my: m.row, snapshot: model };
  }
  function onCanvasMove(e) {
    if (!dragState) return;
    const m = e.data ?? e;
    if (m.col == null || m.row == null) return;
    const dx = m.col - dragState.mx;
    const dy = m.row - dragState.my;
    const nx = Math.max(0, dragState.sx + dx);
    const ny = Math.max(0, dragState.sy + dy);
    const en = model.entities.find((x) => x.name === dragState.name);
    if (!en || (en.x === nx && en.y === ny)) return;
    model = moveEntity(model, dragState.name, nx, ny);
  }
  function onCanvasUp() {
    if (!dragState) return;
    const snap = dragState.snapshot;
    const name = dragState.name;
    dragState = null;
    const cur = model.entities.find((x) => x.name === name);
    const prev = snap.entities.find((x) => x.name === name);
    if (cur && prev && (cur.x !== prev.x || cur.y !== prev.y)) {
      pushHistory(snap);
      err = '';
    }
  }

  async function doSave() {
    try {
      await realIo.write(`${fileName}.erd`, toErdJson(model));
      msg = `saved ${fileName}.erd`;
    } catch (e) { msg = e.message; }
    dialog = null;
  }
  async function doLoad() {
    try {
      model = parseErdJson(await realIo.read(`${fileName}.erd`));
      undoStack = []; redoStack = []; sel = null;
      msg = `loaded ${fileName}.erd`;
    } catch (e) { err = e.message; }
    dialog = null;
  }
  function openExport() {
    sqlPreview = generateSql(model);
    dialog = 'export';
  }
  async function doExport() {
    try {
      await realIo.write(`${fileName}.sql`, sqlPreview);
      msg = `exported ${fileName}.sql`;
    } catch (e) { msg = e.message; }
    dialog = null;
  }
  async function doSvgExport() {
    try {
      const svg = exportSvg(model, CANVAS.cols, CANVAS.rows);
      await realIo.write(`${fileName}.svg`, svg);
      msg = `exported ${fileName}.svg`;
    } catch (e) { msg = e.message; }
    dialog = null;
  }
</script>

<div class="app" onkeydown={onKey} onmousemove={onCanvasMove} onmouseup={onCanvasUp}>
  <div class="titlebar">ERD CREATOR <span class="hint">? help · arrows move · click table</span></div>

  <div class="body">
    <aside class="panel">
      <details open>
        <summary>Entities ({model.entities.length})</summary>
        {#each model.entities as e (e.name)}
          <div class="ent {e.name === sel ? 'sel' : ''}" onclick={() => sel = e.name}>
            <strong>{e.name}</strong> <span class="dim">{e.x},{e.y}</span>
            <button onclick={() => { commit(() => removeEntity(model, e.name)); if (sel === e.name) sel = null; }}>x</button>
            {#each e.fields as f (f.name)}
              <div class="fld"><code>{fieldLabel(f)}</code> <button onclick={(ev) => { ev.stopPropagation(); commit(() => removeField(model, e.name, f.name)); }}>del</button></div>
            {/each}
          </div>
        {/each}
      </details>

      {#if selEntity}
        <details open>
          <summary>Field → {sel}</summary>
          {#each selEntity.fields as f (f.name)}
            <div class="fld">{fieldLabel(f)}<button onclick={() => commit(() => removeField(model, sel, f.name))}>x</button></div>
          {/each}
          <details class="todo">
            <summary>TODOs ({(selEntity.todos || []).length})</summary>
            <div class="row">
              <input data-navkeys placeholder="new task" value={todoText} oninput={(e) => todoText = v(e)} onclick={doAddTodo} onkeydown={(e) => formKey(e, doAddTodo)} />
              <button onclick={doAddTodo}>+</button>
            </div>
            {#each (selEntity.todos || []) as t (t.id)}
              <div class="row"><label><input type="checkbox" checked={t.done} onchange={() => commit(() => toggleTodo(model, sel, t.id))} /></label>
                <span class="{t.done ? 'dim' : ''}">{t.text}</span>
                <button onclick={() => commit(() => removeTodo(model, sel, t.id))}>x</button></div>
            {/each}
          </details>
        </details>
        {/if}
      <details>
        <summary>Relations ({model.relationships.length})</summary>
        {#each model.relationships as r (`${r.from}:${r.to}`)}
          <div class="fld">{r.from} <span class="dim">{r.type}</span> {r.to}
            <button onclick={() => commit(() => removeRelationship(model, r.from, r.to))}>x</button></div>
        {/each}
      </details>

      {#if err}<div class="err">{err}</div>{/if}
    </aside>

    <main class="canvas" onmousemove={onCanvasMove} onmouseup={onCanvasUp}>
      <pre class="edges">{edges}</pre>
      {#each model.entities as e (e.name)}
        <div class="box {e.name === sel ? 'selbox' : ''}" style="left: {e.x}cell; top: {e.y}cell" onclick={(ev) => { ev.stopPropagation(); sel = e.name; }} onmousedown={(ev) => onBoxDown(ev, e.name)}>
          <div class="boxname">{e.name}</div>
          {#each e.fields as f (f.name)}<div class="boxfld">{fieldLabel(f)}</div>{/each}
        </div>
      {/each}
    </main>
  </div>
  <div class="footer">
    <div class="row">
      <input data-autofocus data-navkeys placeholder="table_name" value={entName} oninput={(e) => entName = v(e)} onclick={addEnt} onkeydown={(e) => formKey(e, addEnt)} />
      <button onclick={addEnt}>add</button>
      {#if selEntity}
        <input data-navkeys placeholder="field" value={fldName} oninput={(e) => fldName = v(e)} onclick={addFld} onkeydown={(e) => formKey(e, addFld)} />
        <select value={fldType} onchange={(e) => fldType = v(e)}>{#each TYPES as t (t)}<option value={t}>{t}</option>{/each}</select>
        <label><input type="checkbox" checked={fldPk} onchange={(e) => fldPk = c(e)} />PK</label>
        <label><input type="checkbox" checked={fldNullable} onchange={(e) => fldNullable = c(e)} />NULL</label>
        <label><input type="checkbox" checked={fldUnique} onchange={(e) => fldUnique = c(e)} />UQ</label>
        <button onclick={addFld}>add</button>
      {/if}
    </div>
    <div class="row">
      <select value={relFrom} onchange={(e) => relFrom = v(e)}><option value="">from…</option>{#each model.entities as e (e.name)}<option value={e.name}>{e.name}</option>{/each}</select>
      <select value={relType} onchange={(e) => relType = v(e)}>{#each REL_TYPES as t (t)}<option value={t}>{t}</option>{/each}</select>
      <select value={relTo} onchange={(e) => relTo = v(e)}><option value="">to…</option>{#each model.entities as e (e.name)}<option value={e.name}>{e.name}</option>{/each}</select>
      <button onclick={addRel}>link</button>
      <button onclick={() => { fileName = model.name; dialog = 'save'; }}>save</button>
      <button onclick={() => dialog = 'load'}>load</button>
      <button onclick={openExport}>sql</button>
      <button onclick={() => { fileName = model.name; dialog = 'svgexport'; }}>svg</button>
    </div>
  </div>

  <div class="status">{msg || `${model.entities.length} entities · ${model.relationships.length} relations · sel: ${sel || '-'} · u/r undo/redo`}</div>
</div>

{#if dialog === 'help'}
  <div class="modal">
    <pre class="help">keys:
  arrows   move selected table 1 cell
  click    select table       Del  remove
  u / r    undo / redo        ?    this help
  bottom bar: add table/field · link · save/load/sql/svg
  esc      close dialog</pre>
    <button onclick={() => dialog = null}>ok</button>
  </div>
{/if}

{#if dialog === 'save' || dialog === 'load' || dialog === 'export' || dialog === 'svgexport'}
  <div class="modal">
    <span>{dialog === 'export' ? 'SQL export' : dialog === 'svgexport' ? 'SVG export' : dialog} as:</span>
    <input value={fileName} oninput={(e) => fileName = v(e)} />
    {#if dialog === 'export'}<pre class="sqlprev">{sqlPreview.slice(0, 900)}</pre>{/if}
    <div class="row">
      <button onclick={dialog === 'save' ? doSave : dialog === 'load' ? doLoad : dialog === 'svgexport' ? doSvgExport : doExport}>confirm</button>
      <button onclick={() => dialog = null}>cancel</button>
    </div>
  </div>
{/if}

<style>
  .app {
    display: flex;
    flex-direction: column;
  }
  .titlebar { color: cyan; font-weight: bold; }
  .hint { color: gray; font-weight: normal; }
  .body { display: flex; gap: 1cell; }
  .panel {
    border: single; border-color: cyan;
    overflow: auto; padding: 0 1cell;
    width: 36cell; height: 24cell;
  }
  .footer { display: flex; gap: 1cell; margin: 1cell 0 0 0; }
  .row { display: flex; gap: 1cell; align-items: center; }
  .ent { border: single; border-color: gray; padding: 0 1cell; }
  .ent.sel { border-color: yellow; }
  .ent.sel strong { color: yellow; }
  .fld { color: gray; }
  .dim { color: gray; }
  .err { color: red; font-weight: bold; }
  .canvas {
    position: relative;
    overflow: auto;
    background: black;
    flex: 1;
    height: 24cell;
  }
  .edges { position: absolute; left: 0; top: 0; color: white; white-space: pre; }
  .box {
    position: absolute;
    border: single; border-color: cyan; background: black;
    padding: 0 1cell; min-width: 8cell;
  }
  .box.selbox { border: heavy; border-color: yellow; }
  .boxname { font-weight: bold; color: cyan; }
  .box.selbox .boxname { color: yellow; }
  .boxfld { color: white; }
  .status { color: gray; border: single; border-color: gray; padding: 0 1cell; }
  button:focus, input:focus, select:focus { border-color: yellow; color: yellow; }
  .modal {
    position: absolute; left: 20cell; top: 8cell; z-index: 10;
    border: double; border-color: cyan; background: black;
    padding: 1cell 2cell; display: flex; flex-direction: column; gap: 1cell;
  }
  .help, .sqlprev { color: white; white-space: pre; }
</style>
