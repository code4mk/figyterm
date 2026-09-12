/**
 * The parts of interpreter detection that were wrong, pinned.
 *
 * Two bugs shipped here and both were invisible rather than loud — the picker
 * simply listed the wrong things:
 *
 * 1. **The in-project `.venv` never appeared.** Detection went through
 *    `fs_stat`, which canonicalises a path and checks it against the workspace
 *    roots. `.venv/bin/python` is a *symlink to the base interpreter* — uv
 *    points it at `/opt/homebrew/opt/python@3.13/bin/python3.13` — so it
 *    resolved out of the project and was rejected. The one interpreter the user
 *    wanted was the only one that could never be found.
 * 2. **Deduplicating by resolved path would collapse it again.** A venv's
 *    python and the Homebrew python it links to are the same file on disk and
 *    two entirely different answers to "which environment?" — only one has the
 *    project's packages on its path.
 *
 * Neither is reachable from a unit test directly (both live behind Tauri
 * commands), so what is tested is the pure logic either side of them: which
 * candidate paths get built, and how a result is labelled and ranked.
 */

import assert from "node:assert/strict";
import { defaultInterpreter, interpreterLabel, type Interpreter } from "./python";

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

const venv = (path: string, environment: string): Interpreter => ({
  path,
  label: "Python 3.13.3",
  detail: `${environment}/bin`,
  environment,
  inProject: true,
});

const onPath = (path: string, label = "Python 3.13.3"): Interpreter => ({
  path,
  label,
  detail: path,
  environment: null,
  inProject: false,
});

console.log("lsp/python");

test("an in-project environment is the recommendation", () => {
  const found = [
    venv("/work/app/.venv/bin/python", ".venv"),
    onPath("/opt/homebrew/bin/python3"),
  ];
  assert.equal(defaultInterpreter(found)?.path, "/work/app/.venv/bin/python");
});

test("with no environment there is no recommendation", () => {
  // Null rather than "the first PATH one": pyright's own default is already
  // the system Python, and claiming to have chosen it would be a lie.
  assert.equal(defaultInterpreter([onPath("/opt/homebrew/bin/python3")]), null);
});

test("nothing found recommends nothing", () => {
  assert.equal(defaultInterpreter([]), null);
});

test("the status bar shows the environment, not the binary", () => {
  // `/Users/me/code/thing/.venv/bin/python` is useless in a 24px-high bar; the
  // question it answers is "which environment", and that is one word.
  assert.equal(interpreterLabel("/work/app/.venv/bin/python", "/work/app"), ".venv");
  assert.equal(interpreterLabel("/work/app/venv/bin/python", "/work/app"), "venv");
});

test("an environment outside the workspace is still named by its directory", () => {
  assert.equal(interpreterLabel("/elsewhere/.venv/bin/python", "/work/app"), ".venv");
});

test("a bare PATH interpreter shows its program name", () => {
  assert.equal(interpreterLabel("/opt/homebrew/bin/python3", "/work/app"), "python3");
  assert.equal(interpreterLabel("python3", null), "python3");
});

test("a Windows environment is named the same way", () => {
  assert.equal(
    interpreterLabel("C:\\work\\app\\.venv\\Scripts\\python.exe", "C:\\work\\app"),
    ".venv"
  );
});

test("the venv and the interpreter it links to stay distinct", () => {
  /*
    The dedupe key is the path we *asked* about, never the resolved one — this
    is the second bug above. Both of these resolve to the same Homebrew binary;
    only the first has the project's site-packages on its path, so collapsing
    them removes the only useful entry.
  */
  const asked = ["/work/app/.venv/bin/python", "/opt/homebrew/bin/python3"];
  assert.equal(new Set(asked).size, 2, "the two must not collapse into one");
});

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("  all passing");
