/**
 * One completion source per buffer, enforced by CodeMirror itself.
 *
 * This pins a bug that shipped and broke the editor outright: the word-
 * completion source and the language server's were both in a buffer's state at
 * once. `autocompletion()` contributes an `override` config, CodeMirror refuses
 * to merge two of those, and the throw comes out of `EditorState.create` — so
 * the record was never built, the view kept its empty placeholder, and opening
 * a `.ts` file showed a blank pane with only an unhandled rejection to say why.
 *
 * The reason it survived review is worth remembering: the code *did* clear the
 * word list when a server attached, but it did so with a `reconfigure` applied
 * **after** the state was created. By then the state that would have needed
 * fixing had already failed to exist.
 *
 * So the test is not "does the picker choose correctly" — it is "does the
 * composition CodeMirror is actually handed survive being built".
 */

import assert from "node:assert/strict";
import { autocompletion } from "@codemirror/autocomplete";
import { Compartment, EditorState } from "@codemirror/state";

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

console.log("Editor/lsp/completion-exclusive");

const wordCompletion = () =>
  autocompletion({ override: [() => null], activateOnTyping: false });
const serverCompletion = () =>
  autocompletion({ override: [async () => null], activateOnTyping: true });

test("two completion sources in one state is the failure we shipped", () => {
  // Guards the test itself: if a future CodeMirror merges these quietly, the
  // rest of this file stops meaning anything and should be revisited rather
  // than left passing.
  assert.throws(
    () =>
      EditorState.create({
        extensions: [wordCompletion(), serverCompletion()],
      }),
    /merge conflict/i,
    "CodeMirror should still refuse two `override` configs"
  );
});

test("a buffer with a server carries only the server's source", () => {
  const completion = new Compartment();
  const lsp = new Compartment();

  // Exactly the composition `createRecord` builds when `lsp.open` returned a
  // session: the compartment is filled in with the right value up front, not
  // corrected afterwards.
  const state = EditorState.create({
    doc: "const x = 1;",
    extensions: [lsp.of(serverCompletion()), completion.of([])],
  });

  assert.equal(state.doc.toString(), "const x = 1;");
});

test("a buffer without a server carries only the word list", () => {
  const completion = new Compartment();
  const lsp = new Compartment();

  const state = EditorState.create({
    doc: "hello",
    extensions: [lsp.of([]), completion.of(wordCompletion())],
  });

  assert.equal(state.doc.toString(), "hello");
});

test("attaching a server and clearing the word list in one transaction is safe", () => {
  const completion = new Compartment();
  const lsp = new Compartment();

  const state = EditorState.create({
    doc: "x",
    extensions: [lsp.of([]), completion.of(wordCompletion())],
  });

  // Both effects in one dispatch, which is what the settings-change path does.
  // Applied in two transactions instead, the intermediate state would hold both
  // sources and throw — so this is the ordering that matters, not a detail.
  const next = state.update({
    effects: [lsp.reconfigure(serverCompletion()), completion.reconfigure([])],
  }).state;

  assert.equal(next.doc.toString(), "x");
});

test("detaching a server and restoring the word list in one transaction is safe", () => {
  const completion = new Compartment();
  const lsp = new Compartment();

  const state = EditorState.create({
    doc: "x",
    extensions: [lsp.of(serverCompletion()), completion.of([])],
  });

  const next = state.update({
    effects: [lsp.reconfigure([]), completion.reconfigure(wordCompletion())],
  }).state;

  assert.equal(next.doc.toString(), "x");
});

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("  all passing");
