import { readFileSync, writeFileSync } from 'node:fs';
const dist = 'dist/app.mjs';
let code = readFileSync(dist, 'utf8');
code = code.replace(/run\(App,\s*\{[^}]*\}\)/g, "run(App, {fullscreen: false, debug: !!process.env.SVELTERM_DEBUG_PORT_FILE})");
let patched = 0;
code = code.replace(
  /if \(!initialRegistrationDone\) \{\s*registerFocusableNodes\(root, focusManager\);\s*initialRegistrationDone = true;\s*\}/g,
  (m) => {
    patched++;
    return m.replace(
      'initialRegistrationDone = true;',
      `initialRegistrationDone = true;
\t\tif (!focusManager.focused) { const af = focusManager.elements.find(e => e.attributes.has('data-autofocus') || e.attributes.has('autofocus')); if (af) focusManager.focusByNode(af); else focusManager.focusNext(); scheduleRender(); }`
    );
  }
);
// Bulk write already handled in core (0.33+) — no patch needed. Kept for reference:
// tui-test write('users') sends 5 bytes; core splits via `if (data.length > 1 && data[0] !== 27)`.
// Sync TextBuffer with Svelte value prop after entName cleared (prevents 'users' + 'posts' => 'usersposts')
// ponytail: heuristic sync at keydown; real fix belongs in svelterm core (flush
// attribute bindings before dispatching the next stdin read). Re-test removal upstream.
code = code.replace(
  'syncEditConstraints(focused);',
  `syncEditConstraints(focused); if (focused.textBuffer && focused.textBuffer.text !== (focused.attributes.get('value') ?? '')) { focused.textBuffer.text = focused.attributes.get('value') ?? ''; focused.textBuffer.cursor = focused.textBuffer.text.length; }`
);
code = code.replace(
  /case "Delete":\s*buf\.delete\(\);\s*return true;/g,
  `case "Delete": if (!buf.text) return false; buf.delete(); return true;`,
);
code = code.replace(
  /case "Backspace":\s*buf\.backspace\(\);\s*return true;/g,
  `case "Backspace": if (!buf.text) return false; buf.backspace(); return true;`,
);
// Bubble nav keys out of text buffers: inputs with data-navkeys let arrows and
// Delete escape TextBuffer to keydown, so app-level move/remove work while typing.
code = code.replace(
  'if (focused.textBuffer.handleKey(key)) {',
  `if (!(focused.attributes.has('data-navkeys') && SVELTERM_NAV_KEYS.has(key.key)) && focused.textBuffer.handleKey(key)) {`
);
code = code.replace(
  'const handleKeyData = (data) => {',
  `const SVELTERM_NAV_KEYS = new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Delete']);
    const handleKeyData = (data) => {`
);
// Real ws for the debug harness: bundle aliases ws -> no-op stub; load the
// installed package lazily (guarded; absent in shipped dists -> stub stays).
code = code.replace(
  'WebSocketServer = class {};\n\tWebSocket = class {};',
  `WebSocketServer = class {};
\tWebSocket = class {};
\tif (typeof process !== 'undefined' && process.env.SVELTERM_DEBUG_PORT_FILE) { try { const { createRequire } = require('node:module'); const ws = createRequire(__filename || import.meta.url)('ws'); if (ws.WebSocketServer) WebSocketServer = ws.WebSocketServer; } catch {} }`
);
code = code.replace(/^/, "import { createRequire as __createRequire } from 'node:module';\nglobalThis.__cr = __createRequire(import.meta.url);\n");
code = code.replace("const { createRequire } = require('node:module'); const ws = createRequire(__filename || import.meta.url)('ws')", "const ws = globalThis.__cr('ws')");
// Burst CSI input (keyRight(3) sends \x1b[C\x1b[C\x1b[C in one read): split ESC
// sequences onto separate onKey calls; parser consumes only the first otherwise.
code = code.replace(
  'if (data.length > 1 && data[0] !== 27) for (let i = 0; i < data.length; i++) this.handlers?.onKey(data.slice(i, i + 1));\n\t\telse this.handlers?.onKey(data);',
  `(() => {
\t\t\tlet buf = data;
\t\t\tif (this.__esc) { buf = Buffer.concat([this.__esc, buf]); delete this.__esc; }
\t\t\tconst feed = (b) => {
\t\t\t\tlet off = 0;
\t\t\t\twhile (off < b.length) {
\t\t\t\t\tlet fin;
\t\t\t\t\tif (b[off] === 27) {
\t\t\t\t\t\tlet j = off + 1;
\t\t\t\t\t\tif (b[j] === 0x5b) { j++; while (j < b.length && b[j] >= 0x30 && b[j] <= 0x3f) j++; fin = j < b.length ? j + 1 : -1; }
\t\t\t\t\t\telse fin = j < b.length && b[j] !== 27 ? j + 1 : -1;
\t\t\t\t\t\tif (fin === -1) { if (j >= b.length) this.__esc = b.slice(off); return; }
\t\t\t\t\t} else fin = off + 1;
\t\t\t\t\tconst seq = b.slice(off, fin);
\t\t\t\t\toff = fin;
\t\t\t\t\tthis.handlers?.onKey(seq);
\t\t\t\t\t// Enter mutates state whose input-value flush rides Svelte's
\t\t\t\t\t// microtask queue; drain it before the next byte so the buffer is
\t\t\t\t\t// cleared (run_micro_tasks is the fork's top-level scheduler).
\t\t\t\t\tif (seq.length === 1 && seq[0] === 0x0d) { try { run_micro_tasks(); } catch {} }
\t\t\t\t}
\t\t\t};
\t\t\tfeed(buf);
\t\t})()`
);
// Tab order = document order: register() appends, so late-mounted elements
// (field input appears on select) land after footer buttons. Insert in DOM order.
code = code.replace(
  /\tregister\(node\) \{\n\t\tif \(!this\.elements\.includes\(node\)\) this\.elements\.push\(node\);\n\t\}/,
  `\tregister(node) {
\t\tif (this.elements.includes(node)) return;
\t\tlet i = this.elements.length;
\t\tfor (let k = 0; k < this.elements.length; k++) { if (domPrecedes(node, this.elements[k])) { i = k; break; } }
\t\tthis.elements.splice(i, 0, node);
\t\tif (i <= this.focusIndex) this.focusIndex++;
\t}`
);
code = code.replace(
  /var FocusManager = class \{/,
  `function domPrecedes(a, b) {
\tconst pa = [], pb = [];
\tfor (let n = a; n; n = n.parent) pa.push(n);
\tfor (let n = b; n; n = n.parent) pb.push(n);
\tpa.reverse(); pb.reverse();
\tconst len = Math.min(pa.length, pb.length);
\tfor (let i = 0; i < len; i++) {
\t\tif (pa[i] !== pb[i]) {
\t\t\tconst ia = pa[i].parent ? pa[i].parent.children.indexOf(pa[i]) : -1;
\t\t\tconst ib = pb[i].parent ? pb[i].parent.children.indexOf(pb[i]) : -1;
\t\t\treturn ia < ib;
\t\t}
\t}
\treturn pa.length < pb.length;
}
var FocusManager = class {`
);
writeFileSync(dist, code);
console.log(`patched: fullscreen:false + autofocus blocks=${patched} + bulk + textSync + delete-bubble`);
