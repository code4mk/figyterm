/**
 * Runs the `*.test.ts` files under `src/`, without a test framework.
 *
 * There isn't one in this project, and adding Vitest to check two hundred lines
 * of arithmetic would be a dependency, a config file and a second module
 * resolver to keep in step with Vite's — for code that has no components, no
 * DOM and no async in it.
 *
 * So: esbuild (already here, as Vite's own bundler) transpiles each test to one
 * self-contained ESM file, and Node runs it. A test is a plain script that
 * exits non-zero when something fails; `node:assert` provides the assertions.
 * The rule that keeps this honest is that a test must not import anything with
 * a runtime dependency on the browser — which for the LSP position code is
 * true by construction, since it takes a document shape rather than a
 * CodeMirror `Text`.
 *
 * Usage: `npm test`
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const esbuild = join(root, "node_modules", ".bin", "esbuild");

/** Every `*.test.ts` under `dir`, depth first. */
function findTests(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...findTests(path));
    else if (entry.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

const tests = findTests(join(root, "src")).sort();
if (!tests.length) {
  console.log("no *.test.ts files found");
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "figy-tests-"));
let failed = 0;

try {
  for (const test of tests) {
    const bundle = join(work, `${relative(root, test).replace(/[/\\.]/g, "_")}.mjs`);
    try {
      execFileSync(
        esbuild,
        [
          test,
          "--bundle",
          "--format=esm",
          // Node builtins stay external; everything of ours is inlined, so the
          // bundle runs with no resolution step at all.
          "--platform=node",
          "--log-level=warning",
          `--outfile=${bundle}`,
        ],
        { stdio: "inherit" }
      );
    } catch {
      console.error(`could not build ${relative(root, test)}`);
      failed++;
      continue;
    }

    try {
      execFileSync(process.execPath, [bundle], { stdio: "inherit" });
    } catch {
      failed++;
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${failed} test file${failed === 1 ? "" : "s"} failing`);
  process.exit(1);
}
