// @ts-nocheck
// Shim for pnpm spec generators

export const npmScriptsGenerator: Figy.Generator = {
  script: ["cat", "package.json"],
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

export const npmSearchGenerator: Figy.Generator = {
  script: (tokens) => {
    const query = tokens[tokens.length - 1];
    if (!query || query.length < 2) return [];
    return ["echo", ""];
  },
  postProcess: () => [],
};
