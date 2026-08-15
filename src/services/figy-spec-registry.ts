/**
 * Spec Registry
 *
 * Manages loading, caching, and querying autocomplete specs.
 * Compatible with withfig/autocomplete spec format.
 *
 * Architecture:
 * 1. Specs are stored as ES modules (TypeScript files) in src/specs/
 * 2. At build time, they're bundled into the app
 * 3. At runtime, the registry resolves which spec to use based on the command
 * 4. The autocomplete engine queries the registry for suggestions
 *
 * Supports folder-style specs where a root spec (e.g., aws.ts) references
 * sub-specs via loadSpec (e.g., loadSpec: "aws/s3" -> aws/s3.ts).
 */

import { Figy } from "../types/figy";
import { listInstalledSpecs, readSpecFile } from "./spec-store";
import { evaluateSpec } from "./spec-evaluator";

type SpecModule = { default: Figy.Spec } | Figy.Spec;

class SpecRegistry {
  private specs: Map<string, Figy.Spec> = new Map();
  private specLoaders: Map<string, () => Promise<SpecModule>> = new Map();
  private loadedCache: Map<string, Figy.Spec> = new Map();

  registerSpec(name: string, spec: Figy.Spec): void {
    this.specs.set(name, spec);
    const names = Array.isArray(spec.name) ? spec.name : [spec.name];
    for (const n of names) {
      this.specs.set(n, spec);
    }
  }

  registerLazySpec(name: string, loader: () => Promise<SpecModule>): void {
    this.specLoaders.set(name, loader);
  }

  async getSpec(commandName: string): Promise<Figy.Spec | null> {
    if (this.specs.has(commandName)) {
      return this.specs.get(commandName)!;
    }

    if (this.loadedCache.has(commandName)) {
      return this.loadedCache.get(commandName)!;
    }

    if (this.specLoaders.has(commandName)) {
      try {
        const module = await this.specLoaders.get(commandName)!();
        const spec = "default" in module ? module.default : module;
        this.loadedCache.set(commandName, spec);
        const names = Array.isArray(spec.name) ? spec.name : [spec.name];
        for (const n of names) {
          this.loadedCache.set(n, spec);
        }
        return spec;
      } catch (err) {
        console.warn(`Failed to load spec for "${commandName}":`, err);
        return null;
      }
    }

    return null;
  }

  /**
   * Load a sub-spec by path (e.g., "aws/s3").
   * Attempts to read from the user-installed specs directory.
   */
  async loadSubSpec(specPath: string): Promise<Figy.Spec | null> {
    if (this.loadedCache.has(specPath)) {
      return this.loadedCache.get(specPath)!;
    }

    try {
      const content = await readSpecFile(specPath);
      const spec = evaluateSpec(content) as Figy.Spec;
      if (spec) {
        this.loadedCache.set(specPath, spec);
        return spec;
      }
    } catch {
      // Sub-spec file not found or failed to evaluate
    }

    return null;
  }

  hasSpec(commandName: string): boolean {
    return this.specs.has(commandName) || this.specLoaders.has(commandName) || this.loadedCache.has(commandName);
  }

  getRegisteredCommands(): string[] {
    const commands = new Set<string>();
    for (const key of this.specs.keys()) commands.add(key);
    for (const key of this.specLoaders.keys()) commands.add(key);
    for (const key of this.loadedCache.keys()) commands.add(key);
    return Array.from(commands);
  }

  clear(): void {
    this.specs.clear();
    this.specLoaders.clear();
    this.loadedCache.clear();
  }

  async loadUserSpecs(): Promise<void> {
    try {
      const installed = await listInstalledSpecs();
      for (const entry of installed) {
        // Only register root specs (no slashes), sub-specs are loaded on demand
        if (entry.name.includes("/")) continue;
        if (this.hasSpec(entry.name)) continue;
        this.registerLazySpec(entry.name, async () => {
          const content = await readSpecFile(entry.name);
          const spec = evaluateSpec(content) as Figy.Spec;
          if (!spec) throw new Error(`Could not evaluate spec: ${entry.name}`);
          return spec;
        });
      }
    } catch (err) {
      console.warn("[spec-registry] Failed to load user specs:", err);
    }
  }

  unregisterSpec(name: string): void {
    this.specs.delete(name);
    this.specLoaders.delete(name);
    this.loadedCache.delete(name);
  }
}

export const specRegistry = new SpecRegistry();
