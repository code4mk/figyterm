#!/usr/bin/env node
/**
 * Rewrites the app version from the release tag.
 *
 * The tag drives every release; the versions committed in `package.json`,
 * `tauri.conf.json` and `Cargo.toml` are only defaults. Each build job runs this
 * before bundling, so artifacts are named after the tag rather than after
 * whatever happened to be committed.
 *
 * Usage: `VERSION=1.2.3 node scripts/sync-version.mjs` (or pass it as argv[2]).
 */

import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.VERSION ?? process.argv[2];

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error(`sync-version: '${version ?? ""}' is not a MAJOR.MINOR.PATCH version`);
  process.exit(1);
}

for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.version = version;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

// Only the `[package]` version, which is the first `version = ` in the file —
// a global replace would rewrite every dependency version below it.
const cargo = "src-tauri/Cargo.toml";
const source = readFileSync(cargo, "utf8");
const updated = source.replace(/^version = ".*"$/m, `version = "${version}"`);

if (updated === source) {
  console.error(`sync-version: no [package] version line found in ${cargo}`);
  process.exit(1);
}

writeFileSync(cargo, updated);
console.log(`Synced version ${version}`);
