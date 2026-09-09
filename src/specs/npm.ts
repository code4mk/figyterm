// @ts-nocheck
// Shim for pnpm spec generators

export const npmScriptsGenerator: Figy.Generator = {
  // Read rather than `cat package.json`: `cat` is not a program on Windows,
  // so this generator produced nothing there and `pnpm run <tab>` came up empty.
  readFile: "package.json",
  postProcess: (out) => {
    try {
      const pkg = JSON.parse(out);
      const scripts = pkg.scripts || {};
      return Object.keys(scripts).map((name) => ({
        name,
        description: scripts[name],
        icon: "figy://icon?type=commandkey",
      }));
    } catch {
      return [];
    }
  },
};

// Registry search isn't wired up; `postProcess` has always returned nothing.
// It used to spawn `echo` to get there, which is a process per keystroke for an
// empty answer — and not even a program on Windows.
export const npmSearchGenerator: Figy.Generator = {
  script: () => [],
  postProcess: () => [],
};
