// @ts-nocheck
// Shim for pnpm spec generators

export const dependenciesGenerator: Figy.Generator = {
  script: ["cat", "package.json"],
  postProcess: (out) => {
    try {
      const pkg = JSON.parse(out);
      const deps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };
      return Object.keys(deps).map((name) => ({
        name,
        description: deps[name],
        icon: "figy://icon?type=package",
      }));
    } catch {
      return [];
    }
  },
};

export const nodeClis: Figy.Suggestion[] = [
  { name: "eslint" },
  { name: "prettier" },
  { name: "tsc" },
  { name: "jest" },
  { name: "mocha" },
  { name: "vite" },
  { name: "next" },
  { name: "nuxt" },
  { name: "webpack" },
  { name: "rollup" },
  { name: "esbuild" },
  { name: "turbo" },
  { name: "vitest" },
  { name: "playwright" },
  { name: "cypress" },
];
