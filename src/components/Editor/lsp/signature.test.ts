/**
 * A signature tooltip must never outlive the call it describes.
 *
 * This pins the second stuck tooltip in `docs/issues`: hovering or typing put a
 * signature on screen, and moving the cursor away left it there — a description
 * of a call the caret had long since left, with nothing to dismiss it.
 *
 * The original rule cleared only on `docChanged`, on the theory that the plugin
 * would replace the tooltip when the cursor moved. It does — *when the request
 * succeeds*. Cancelled, timed out, or moved somewhere that is not a call at
 * all, nothing replaced it. The fix is to clear first and let the answer
 * re-show, so the failure mode is a flicker rather than a lie.
 */

import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { __setSignature, __signatureField } from "./signature";

let failures = 0;
function test(name: string, run: () => void) {
  try {
    run();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(error as Error).message.split("\n").join("\n        ")}`);
  }
}

const field = __signatureField();

/** A stand-in tooltip; the field only ever stores and returns it. */
const tooltip = { pos: 0, create: () => ({ dom: null as never }) };

function showing(doc = "print(x)") {
  const base = EditorState.create({ doc, extensions: [field] });
  return base.update({ effects: __setSignature.of(tooltip) }).state;
}

console.log("Editor/lsp/signature");

test("an effect shows it", () => {
  assert.notEqual(showing().field(field), null);
});

test("typing clears it", () => {
  const next = showing().update({ changes: { from: 6, insert: "y" } }).state;
  assert.equal(next.field(field), null);
});

test("moving the cursor clears it — the bug that shipped", () => {
  // The case the old rule missed: no document change, so it survived.
  const next = showing().update({ selection: { anchor: 0 } }).state;
  assert.equal(next.field(field), null);
});

test("clearing explicitly clears it", () => {
  const next = showing().update({ effects: __setSignature.of(null) }).state;
  assert.equal(next.field(field), null);
});

test("an unrelated transaction leaves it alone", () => {
  // Or it would flicker out on every annotation the editor dispatches.
  const next = showing().update({}).state;
  assert.notEqual(next.field(field), null);
});

test("a fresh document has none", () => {
  assert.equal(EditorState.create({ doc: "x", extensions: [field] }).field(field), null);
});

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("  all passing");
