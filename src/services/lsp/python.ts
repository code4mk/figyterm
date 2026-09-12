/**
 * Which Python a project's language server should use.
 *
 * Pyright is only as useful as the environment it resolves imports against.
 * Point it at the system interpreter in a project with a `.venv` and every
 * third-party import is reported as missing — which does not look like a
 * misconfiguration, it looks like a broken language server.
 *
 * **Why this does not use `fs_stat`.** That was the first attempt and it found
 * nothing: `fs_stat` canonicalises a path and checks it against the workspace
 * roots, and `.venv/bin/python` is a *symlink to the base interpreter* — uv
 * points it at `/opt/homebrew/opt/python@3.13/bin/python3.13`. Canonicalising
 * resolves it out of the project, the confinement check rejects it, and the one
 * interpreter the user actually wanted was the only one that could never
 * appear. Detection goes through `lsp_detect` instead, which is the same
 * executable lookup the language servers use and has no notion of roots.
 *
 * **No package-manager integration.** `uv`, `python -m venv`, `virtualenv` and
 * `poetry config virtualenvs.in-project true` all produce the same thing: a
 * directory in the project with `bin/python` (or `Scripts\\python.exe`) inside.
 * Detecting the *directory* covers all of them and stays correct when the next
 * tool arrives, whereas shelling out to each to ask where its environment lives
 * means four subprocesses, four output formats, and a list that goes stale.
 */

import { invoke } from "@tauri-apps/api/core";
import { isWindows } from "../platform";
import type { DetectedProgram } from "./servers";

/** Directory names that hold an in-project environment, in preference order. */
const VENV_DIRS = [".venv", "venv", ".virtualenv", "env", "virtualenv"];

/** Where the interpreter sits inside one, per platform. */
const BIN = isWindows ? "Scripts" : "bin";
const EXE = isWindows ? "python.exe" : "python";

/** How long `python --version` gets before its row goes unlabelled. */
const VERSION_TIMEOUT_MS = 2_000;

export interface Interpreter {
  /** Absolute path to the interpreter binary. */
  path: string;
  /** `Python 3.12.4`, once known; the program name until then. */
  label: string;
  /** Where it came from — the second line in the picker. */
  detail: string;
  /** `.venv` for an in-project environment, else null. */
  environment: string | null;
  /** In-project environments sort first and are the recommended choice. */
  inProject: boolean;
}

function join(...parts: string[]): string {
  return parts.join(isWindows ? "\\" : "/");
}

interface ShellOutput {
  stdout: string;
  stderr: string;
  status: number;
}

/**
 * The interpreter's own version string.
 *
 * Asked of the binary rather than inferred from its path, because the path lies:
 * `.venv/bin/python` says nothing, and a `python3.11` on `PATH` may well be a
 * shim for something else. This is what turns a list of paths into the list VS
 * Code shows.
 *
 * Old versions print to stderr rather than stdout, which is why both are read.
 */
async function versionOf(path: string): Promise<string | null> {
  try {
    const result = await Promise.race([
      invoke<ShellOutput>("execute_shell_command", {
        command: path,
        args: ["--version"],
        cwd: null,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), VERSION_TIMEOUT_MS)),
    ]);
    if (!result) return null;
    const said = `${result.stdout} ${result.stderr}`.trim();
    return /Python \d+\.\d+(\.\d+)?/.exec(said)?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The environments inside `root`, and the interpreters on `PATH`.
 *
 * Both, always: "my project has no venv" and "my project has three" are equally
 * ordinary and the picker has to show either.
 */
export async function findInterpreters(root: string | null): Promise<Interpreter[]> {
  // Candidate paths first, then one call to ask which of them exist. Absolute
  // paths go through the same resolver as a bare program name — see
  // `spawn::find_program` — so a symlink into Homebrew is still found here.
  const candidates: { program: string; environment: string | null }[] = [];

  if (root) {
    for (const dir of VENV_DIRS) {
      candidates.push({ program: join(root, dir, BIN, EXE), environment: dir });
    }
  }
  candidates.push({ program: "python3", environment: null });
  candidates.push({ program: "python", environment: null });

  let detected: DetectedProgram[] = [];
  try {
    detected = await invoke<DetectedProgram[]>("lsp_detect", {
      programs: candidates.map((candidate) => candidate.program),
    });
  } catch {
    return [];
  }

  const found: Interpreter[] = [];
  const seen = new Set<string>();

  detected.forEach((entry, index) => {
    if (!entry.path) return;
    const { environment } = candidates[index];

    /*
      Deduplicated by the path we *asked* about, not the one that came back.

      A `.venv/bin/python` and the Homebrew interpreter it links to are the same
      file on disk and two completely different answers to "which environment?":
      only the first has the project's packages on its path. Collapsing them —
      which keying on the resolved path would do — is exactly how the venv
      disappears from the list again.
    */
    const key = entry.program;
    if (seen.has(key)) return;
    seen.add(key);

    found.push({
      path: entry.program,
      label: entry.program,
      detail: environment ? `${environment}${isWindows ? "\\" : "/"}${BIN}` : entry.path,
      environment,
      inProject: environment !== null,
    });
  });

  // Versions in parallel, once we know which are real. A missing version costs
  // the row its title, not its place in the list.
  const versions = await Promise.all(found.map((entry) => versionOf(entry.path)));
  versions.forEach((version, index) => {
    if (version) found[index].label = version;
  });

  // In-project first, then PATH, so the recommended one is always at the top.
  return found.sort((a, b) => Number(b.inProject) - Number(a.inProject));
}

/**
 * The one to use when the user has not chosen.
 *
 * An in-project environment if there is one — the answer in the overwhelming
 * majority of cases, and asking would be asking a question with one sensible
 * answer. Otherwise null, and pyright uses its own default, which is the honest
 * behaviour for a project that has no environment.
 */
export function defaultInterpreter(found: Interpreter[]): Interpreter | null {
  return found.find((candidate) => candidate.inProject) ?? null;
}

/**
 * The short name for the status bar.
 *
 * `.venv` rather than `/Users/me/code/thing/.venv/bin/python`: the interesting
 * part is which environment, and the bar has room for one word.
 */
export function interpreterLabel(path: string, root: string | null): string {
  const parts = path.split(/[/\\]/);
  // …/<env>/bin/python — the environment directory is three from the end.
  const environment = parts[parts.length - 3];
  if (environment && (VENV_DIRS.includes(environment) || (root && path.startsWith(root)))) {
    return environment;
  }
  return parts[parts.length - 1] || path;
}
