/**
 * Vendors Excalidraw's fonts into `public/`.
 *
 * Excalidraw resolves its font files against `window.EXCALIDRAW_ASSET_PATH` and
 * falls back to fetching them from a CDN — see `createUrls` in
 * `dist/prod/chunk-*.js`. A desktop app must not do that: it would put a
 * network round-trip in front of the hand-drawn fonts that make an Excalidraw
 * drawing look like one, and fail outright offline.
 *
 * So the fonts are copied next to the app and `DrawingCanvas` points the global
 * at them. Plain Node with no dependency, in the spirit of `run-ts-tests.mjs` —
 * adding a copy plugin to Vite for one directory would be a dependency and a
 * config file for `cp -r`.
 *
 * Run from `postinstall` and `prebuild`. Idempotent, and quiet when there is
 * nothing to do.
 */

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts");
const target = join(root, "public", "excalidraw-assets", "fonts");

if (!existsSync(source)) {
  // A `postinstall` that runs before the package is present, or an install that
  // skipped it. Not an error: the build does not depend on this, only the
  // drawing tool's typography does.
  console.log("excalidraw assets: no fonts to copy (package not installed)");
  process.exit(0);
}

// Copy whenever the source is newer, so a version bump is picked up but an
// unchanged tree is not re-copied on every `npm run build`.
if (existsSync(target) && statSync(target).mtimeMs >= statSync(source).mtimeMs) {
  process.exit(0);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });

console.log("excalidraw assets: fonts copied to public/excalidraw-assets/fonts");
