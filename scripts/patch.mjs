import { readFileSync, writeFileSync } from 'node:fs';
const dist = 'dist/app.mjs';
let code = readFileSync(dist, 'utf8');
code = code.replace(/run\(App,\s*\{[^}]*\}\)/g, 'run(App, {fullscreen: false})');
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
code = code.replace(
  'syncEditConstraints(focused);',
  `syncEditConstraints(focused); if (focused.textBuffer && focused.attributes.get('value') !== undefined && focused.textBuffer.text !== (focused.attributes.get('value') ?? '')) { focused.textBuffer.text = focused.attributes.get('value') ?? ''; focused.textBuffer.cursor = focused.textBuffer.text.length; }`
);
code = code.replace(
  /case "Delete":\s*buf\.delete\(\);\s*return true;/g,
  `case "Delete": if (!buf.text) return false; buf.delete(); return true;`,
);
code = code.replace(
  /case "Backspace":\s*buf\.backspace\(\);\s*return true;/g,
  `case "Backspace": if (!buf.text) return false; buf.backspace(); return true;`,
);
writeFileSync(dist, code);
console.log(`patched: fullscreen:false + autofocus blocks=${patched} + bulk + textSync + delete-bubble`);
