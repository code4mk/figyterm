/**
 * Spec Index
 *
 * Registers all available autocomplete specs with the registry.
 * Specs are lazily loaded for performance.
 *
 * To add a new spec:
 * 1. Copy the .ts file into this directory (src/specs/)
 * 2. Add a lazy loader entry below
 * 3. The spec will automatically be available for autocomplete
 *
 * Note: Some specs use specific imports like `@figy/autocomplete-generators`.
 * Those will need a compatibility shim (see below).
 */

import { specRegistry } from "../services/figy-spec-registry";

export function initializeSpecs(): void {
  specRegistry.registerLazySpec("git", () => import("./git"));
  specRegistry.registerLazySpec("pnpm", () => import("./pnpm"));
  specRegistry.registerLazySpec("uv", () => import("./uv"));
}
