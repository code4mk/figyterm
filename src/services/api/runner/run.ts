/**
 * Running a folder or a collection, request by request.
 *
 * The same `executeRequest` the window uses for one request, in a loop — which
 * is the whole design. A runner with a send path of its own would drift from
 * the one people press Send on, and the difference would surface as "it passes
 * in the runner but not in the window", which is a bad afternoon.
 *
 * What it adds is the loop, the ordering, the data rows and the report. It
 * reports progress as it goes rather than at the end, because a run of two
 * hundred requests that shows nothing until it finishes is a run nobody trusts.
 */

import { ApiCollection, ApiEnvironment, ApiItem, RequestDraft } from "../../../types/api";
import { executeRequest, ScriptRun } from "../execute";
import { byRank } from "../rank";
import { VariableChanges } from "../scripts/pm";
import { DataRow } from "./data";

/** One request, one iteration, one answer. */
export interface RunEntry {
  itemId: string;
  name: string;
  iteration: number;
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  passed: number;
  failed: number;
  tests: ScriptRun["tests"];
  /** Set when the send failed, or a variable had no value. */
  error: string | null;
}

export interface RunReport {
  startedAt: number;
  finishedAt: number;
  /** What was run, and how it was set up — so a report explains itself. */
  target: string;
  iterations: number;
  entries: RunEntry[];
  passed: number;
  failed: number;
  errored: number;
  /** Set when the run was stopped early, and why. */
  stoppedBecause: string | null;
}

export interface RunOptions {
  /** The requests to run, already in order. */
  requests: { item: ApiItem; draft: RequestDraft; name: string }[];
  items: ApiItem[];
  collections: ApiCollection[];
  environments: ApiEnvironment[];
  activeEnvironmentId: string | null;
  target: string;
  iterations: number;
  delayMs: number;
  stopOnFailure: boolean;
  /** One row per iteration; the iteration count follows the file when there
   * is one, because running ten iterations over three rows is a question
   * nobody asked. */
  data: DataRow[];
  /** Written back after each request, so a token a script sets is there for
   * the next one. */
  onChanges: (changes: {
    globals: VariableChanges;
    collection: VariableChanges;
    environment: VariableChanges;
  }, item: ApiItem | null) => Promise<void>;
  onProgress: (entry: RunEntry, done: number, total: number) => void;
  /** Checked between requests, so Stop takes effect within one request rather
   * than at the end of the run. */
  shouldStop: () => boolean;
}

/** The requests under a folder or collection, in the order the rail shows. */
export function requestsUnder(
  items: ApiItem[],
  root: { kind: "collection" | "folder"; id: string }
): ApiItem[] {
  const found: ApiItem[] = [];

  const walk = (parentId: string | null, collectionId: string) => {
    const children = items
      .filter(
        (item) =>
          item.collectionId === collectionId && (item.parentId ?? null) === parentId
      )
      .sort(byRank);

    for (const child of children) {
      if (child.kind === "request") found.push(child);
      else walk(child.id, collectionId);
    }
  };

  if (root.kind === "collection") {
    walk(null, root.id);
  } else {
    const folder = items.find((item) => item.id === root.id);
    if (folder) walk(folder.id, folder.collectionId);
  }
  return found;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runCollection(options: RunOptions): Promise<RunReport> {
  const iterations = options.data.length > 0 ? options.data.length : Math.max(1, options.iterations);
  const total = options.requests.length * iterations;

  const report: RunReport = {
    startedAt: Date.now(),
    finishedAt: 0,
    target: options.target,
    iterations,
    entries: [],
    passed: 0,
    failed: 0,
    errored: 0,
    stoppedBecause: null,
  };

  let done = 0;

  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const request of options.requests) {
      if (options.shouldStop()) {
        report.stoppedBecause = "Stopped";
        report.finishedAt = Date.now();
        return report;
      }

      const started = Date.now();
      const outcome = await executeRequest({
        item: request.item,
        items: options.items,
        collections: options.collections,
        environments: options.environments,
        activeEnvironmentId: options.activeEnvironmentId,
        draft: request.draft,
        name: request.name,
        data: options.data[iteration],
        iteration,
        iterationCount: iterations,
      });

      await options.onChanges(outcome.changes, request.item);

      const tests = outcome.scripts?.tests ?? [];
      const failed = tests.filter((test) => !test.passed).length;
      const entry: RunEntry = {
        itemId: request.item.id,
        name: request.name,
        iteration,
        method: outcome.input?.method ?? request.draft.method,
        url: outcome.input?.url ?? request.draft.url,
        status: outcome.response?.status ?? null,
        durationMs: outcome.response?.timing.totalMs ?? Date.now() - started,
        passed: tests.length - failed,
        failed,
        tests,
        error:
          outcome.unresolved.length > 0
            ? `No value for ${outcome.unresolved.join(", ")}`
            : (outcome.error?.message ??
              outcome.scripts?.errors[0]?.message ??
              null),
      };

      report.entries.push(entry);
      report.passed += entry.passed;
      report.failed += entry.failed;
      if (entry.error) report.errored++;

      done++;
      options.onProgress(entry, done, total);

      if (options.stopOnFailure && (entry.failed > 0 || entry.error)) {
        report.stoppedBecause = `Stopped at ${entry.name}: ${
          entry.error ?? `${entry.failed} assertion${entry.failed === 1 ? "" : "s"} failed`
        }`;
        report.finishedAt = Date.now();
        return report;
      }

      // Between requests rather than after the last one: a delay that runs
      // after the final request is time nobody asked to wait.
      const last = iteration === iterations - 1 && done % options.requests.length === 0;
      if (options.delayMs > 0 && !last) await sleep(options.delayMs);
    }
  }

  report.finishedAt = Date.now();
  return report;
}

/** The report as a file somebody can keep, diff or attach to a ticket. */
export function reportToJson(report: RunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
