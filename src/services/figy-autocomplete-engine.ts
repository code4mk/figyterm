/**
 * Figy Autocomplete Engine
 *
 * Resolves the current token position and context from a typed input,
 * then queries the spec registry to produce a list of suggestions.
 *
 * Flow:
 * 1. Parse the input into tokens
 * 2. Look up the root command's spec
 * 3. Walk the spec tree following subcommands
 * 4. Based on current position (expecting subcommand, option, or arg), collect suggestions
 * 5. Run generators if needed (execute shell commands via Tauri backend)
 */

import { Figy } from "../types/figy";
import { specRegistry } from "./figy-spec-registry";
import { invoke } from "@tauri-apps/api/core";

export interface AutocompleteSuggestion {
  name: string;
  displayName?: string;
  description?: string;
  type: "subcommand" | "option" | "arg" | "file" | "folder" | "special";
  icon?: string;
  insertValue?: string;
  priority?: number;
}

interface ParsedContext {
  command: string;
  tokens: string[];
  currentToken: string;
  currentSpec: Figy.Subcommand | null;
  isTypingOption: boolean;
  expectingArgForOption: Figy.Option | null;
  consumedArgs: number;
  usedOptions: Set<string>;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (char === " " && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  if (input.endsWith(" ") && !inSingleQuote && !inDoubleQuote) {
    tokens.push("");
  }

  return tokens;
}

function normalizeOptionNames(option: Figy.Option): string[] {
  return Array.isArray(option.name) ? option.name : [option.name];
}

function normalizeSubcommandNames(sub: Figy.Subcommand): string[] {
  return Array.isArray(sub.name) ? sub.name : [sub.name];
}

function matchesPrefix(name: string, prefix: string): boolean {
  return name.toLowerCase().startsWith(prefix.toLowerCase());
}

async function resolveContext(input: string, cwd?: string): Promise<(ParsedContext & { cwd?: string }) | null> {
  const tokens = tokenize(input);
  if (tokens.length === 0) return null;

  const command = tokens[0];
  const spec = await specRegistry.getSpec(command);

  if (!spec) return null;

  let currentSpec: Figy.Subcommand = spec;
  let tokenIdx = 1;
  let expectingArgForOption: Figy.Option | null = null;
  let consumedArgs = 0;
  const usedOptions = new Set<string>();

  while (tokenIdx < tokens.length - 1) {
    const tok = tokens[tokenIdx];

    if (expectingArgForOption) {
      expectingArgForOption = null;
      tokenIdx++;
      continue;
    }

    if (tok.startsWith("-") && currentSpec.options) {
      usedOptions.add(tok);
      const opt = currentSpec.options.find((o) => {
        const names = normalizeOptionNames(o);
        return names.includes(tok);
      });
      if (opt?.args && !Array.isArray(opt.args)) {
        if (!opt.args.isOptional) {
          expectingArgForOption = opt;
        }
      }
      tokenIdx++;
      continue;
    }

    if (currentSpec.subcommands) {
      const sub = currentSpec.subcommands.find((s) => {
        const names = normalizeSubcommandNames(s);
        return names.includes(tok);
      });
      if (sub) {
        if ((sub as any).loadSpec && typeof (sub as any).loadSpec === "string") {
          const specPath = (sub as any).loadSpec as string;
          // Try loading as a sub-spec file (e.g., "aws/s3" -> ~/.figyterm/specs/aws/s3.ts)
          const loadedSpec = await specRegistry.loadSubSpec(specPath)
            || await specRegistry.getSpec(specPath);
          if (loadedSpec) {
            currentSpec = loadedSpec;
          } else {
            currentSpec = sub;
          }
        } else {
          currentSpec = sub;
        }
        consumedArgs = 0;
        tokenIdx++;
        continue;
      }
    }

    // This token is a positional argument
    consumedArgs++;
    tokenIdx++;
  }

  const currentToken = tokens[tokens.length - 1] ?? "";
  const isTypingOption = currentToken.startsWith("-");

  return {
    command,
    tokens,
    currentToken,
    currentSpec,
    isTypingOption,
    expectingArgForOption,
    consumedArgs,
    usedOptions,
    cwd,
  };
}

async function executeShellCommand(
  input: Figy.ExecuteShellCommandInput
): Promise<Figy.ExecuteShellCommandOutput> {
  try {
    const result = await invoke<{ stdout: string; stderr: string; status: number }>(
      "execute_shell_command",
      {
        command: input.command,
        args: input.args ?? [],
        cwd: input.cwd,
      }
    );
    return result;
  } catch (err) {
    return { stdout: "", stderr: String(err), status: 1 };
  }
}

async function resolveGenerator(
  generator: Figy.Generator,
  tokens: string[],
  currentToken: string,
  cwd?: string
): Promise<AutocompleteSuggestion[]> {
  const suggestions: AutocompleteSuggestion[] = [];

  if (generator.template) {
    const templates = Array.isArray(generator.template) ? generator.template : [generator.template];
    for (const t of templates) {
      if (t === "filepaths" || t === "folders") {
        suggestions.push({
          name: currentToken || ".",
          type: t === "folders" ? "folder" : "file",
          description: `${t === "folders" ? "Directory" : "File"} path`,
        });
      }
    }
  }

  if (generator.script) {
    let command: string;
    let args: string[];

    if (typeof generator.script === "function") {
      const script = generator.script(tokens);
      if (!script || (Array.isArray(script) && script.length === 0)) {
        return suggestions;
      }
      command = Array.isArray(script) ? script[0] : (script as any).command;
      args = Array.isArray(script) ? script.slice(1) : ((script as any).args || []);
    } else if (Array.isArray(generator.script)) {
      if (generator.script.length === 0) return suggestions;
      command = generator.script[0];
      args = generator.script.slice(1);
    } else {
      // Object format: { command: string, args: string[] }
      command = (generator.script as any).command;
      args = (generator.script as any).args || [];
    }

    if (command) {
      const result = await executeShellCommand({
        command,
        args,
        cwd,
      });

      if (result.status === 0 && result.stdout) {
        if (generator.splitOn) {
          const items = result.stdout.split(generator.splitOn).filter(Boolean);
          for (const item of items) {
            suggestions.push({
              name: item.trim(),
              type: "arg",
              priority: 50,
            });
          }
        } else if (generator.postProcess) {
          const processed = generator.postProcess(result.stdout, tokens);
          for (const s of processed) {
            if (!s) continue;
            const name = Array.isArray(s.name) ? s.name[0] : s.name;
            suggestions.push({
              name,
              displayName: s.displayName,
              description: s.description,
              type: "arg",
              icon: s.icon,
              insertValue: s.insertValue,
              priority: s.priority ?? 50,
            });
          }
        }
      }
    }
  }

  if (generator.custom) {
    try {
      const results = await generator.custom(tokens, executeShellCommand);
      for (const s of results) {
        if (!s) continue;
        const name = Array.isArray(s.name) ? s.name[0] : s.name;
        suggestions.push({
          name,
          displayName: s.displayName,
          description: s.description,
          type: "arg",
          icon: s.icon,
          insertValue: s.insertValue,
          priority: s.priority ?? 50,
        });
      }
    } catch {
      // Generator execution failed
    }
  }

  return suggestions;
}

export async function getAutocompleteSuggestions(
  input: string,
  cwd?: string
): Promise<AutocompleteSuggestion[]> {
  const ctx = await resolveContext(input, cwd);
  if (!ctx) return [];

  const { currentToken, currentSpec, isTypingOption, expectingArgForOption, consumedArgs, usedOptions, cwd: ctxCwd } = ctx;
  const suggestions: AutocompleteSuggestion[] = [];
  const commandIcon = `figy://icon?type=${ctx.command}`;

  if (!currentSpec) return suggestions;

  if (expectingArgForOption) {
    const arg = expectingArgForOption.args;
    if (arg && !Array.isArray(arg)) {
      if (arg.suggestions) {
        for (const s of arg.suggestions) {
          const sug = typeof s === "string" ? { name: s } : s;
          const name = Array.isArray(sug.name) ? sug.name[0] : sug.name;
          if (matchesPrefix(name, currentToken)) {
            suggestions.push({
              name,
              description: sug.description,
              type: "arg",
              icon: sug.icon,
              priority: sug.priority ?? 50,
            });
          }
        }
      }
      if (arg.generators) {
        const gens = Array.isArray(arg.generators) ? arg.generators : [arg.generators];
        for (const gen of gens) {
          const genSuggestions = await resolveGenerator(gen, ctx.tokens, currentToken, ctxCwd);
          suggestions.push(...genSuggestions.filter((s) => matchesPrefix(s.name, currentToken)));
        }
      }
    }
    return suggestions;
  }

  if (isTypingOption && currentSpec.options) {
    const shownOptionNames = new Set<string>();
    for (const opt of currentSpec.options) {
      if (opt.hidden) continue;
      const names = normalizeOptionNames(opt);
      if (!opt.isRepeatable && names.some((n) => usedOptions.has(n))) continue;
      for (const name of names) {
        if (matchesPrefix(name, currentToken) && !shownOptionNames.has(name)) {
          shownOptionNames.add(name);
          suggestions.push({
            name,
            description: opt.description,
            type: "option",
            icon: opt.icon,
            priority: opt.priority ?? 50,
          });
        }
      }
    }
  } else {
    if (currentSpec.subcommands) {
      for (const sub of currentSpec.subcommands) {
        if (sub.hidden) continue;
        const names = normalizeSubcommandNames(sub);
        for (const name of names) {
          if (matchesPrefix(name, currentToken)) {
            suggestions.push({
              name,
              description: sub.description,
              type: "subcommand",
              icon: sub.icon || commandIcon,
              priority: sub.priority ?? 70,
            });
            break;
          }
        }
      }
    }

    // Show current subcommand's options when:
    // - Empty token and no subcommands (we're inside a leaf command like `uv add`, `pnpm run`)
    // - This ensures each command shows its relevant options alongside args
    const hasSubcommands = currentSpec.subcommands && currentSpec.subcommands.length > 0;

    if (currentSpec.options && !hasSubcommands && currentToken.length === 0) {
      for (const opt of currentSpec.options) {
        if (opt.hidden) continue;
        const names = normalizeOptionNames(opt);
        if (!opt.isRepeatable && names.some((n) => usedOptions.has(n))) continue;
        suggestions.push({
          name: names[0],
          description: opt.description,
          type: "option",
          icon: opt.icon,
          priority: opt.priority ?? 30,
        });
      }
    }

    const allArgs = currentSpec.args
      ? (Array.isArray(currentSpec.args) ? currentSpec.args : [currentSpec.args])
      : [];

    // Skip args already consumed.
    // For variadic args, stop showing suggestions once at least one arg is consumed
    // and the current token is empty (user has moved past it).
    const args = allArgs.filter((arg, idx) => {
      if (idx < consumedArgs && !arg.isVariadic) return false;
      if (arg.isVariadic && consumedArgs > 0 && currentToken === "") return false;
      return true;
    });

    for (const arg of args) {
      if (arg.suggestions) {
        for (const s of arg.suggestions) {
          const sug = typeof s === "string" ? { name: s } : s;
          const name = Array.isArray(sug.name) ? sug.name[0] : sug.name;
          if (matchesPrefix(name, currentToken)) {
            suggestions.push({
              name,
              description: sug.description,
              type: "arg",
              icon: sug.icon,
              priority: sug.priority ?? 50,
            });
          }
        }
      }
      if (arg.generators) {
        const gens = Array.isArray(arg.generators) ? arg.generators : [arg.generators];
        for (const gen of gens) {
          const genSuggestions = await resolveGenerator(gen, ctx.tokens, currentToken, ctxCwd);
          suggestions.push(...genSuggestions.filter((s) => matchesPrefix(s.name, currentToken)));
        }
      }
      if (arg.template) {
        const templates = Array.isArray(arg.template) ? arg.template : [arg.template];
        for (const t of templates) {
          if (t === "filepaths" || t === "folders") {
            suggestions.push({
              name: currentToken || ".",
              type: t === "folders" ? "folder" : "file",
              description: t === "folders" ? "Directory" : "File path",
              priority: 60,
            });
          }
        }
      }
    }

    if (currentSpec.additionalSuggestions) {
      for (const s of currentSpec.additionalSuggestions) {
        const sug = typeof s === "string" ? { name: s } : s;
        const name = Array.isArray(sug.name) ? sug.name[0] : sug.name;
        if (matchesPrefix(name, currentToken)) {
          suggestions.push({
            name,
            description: sug.description,
            type: "special",
            icon: sug.icon,
            priority: sug.priority ?? 30,
          });
        }
      }
    }
  }

  suggestions.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return suggestions.slice(0, 50);
}
