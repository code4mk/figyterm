/**
 * What is running in the background, and what just stopped.
 *
 * A background command outlives the turn that started it. `bash
 * background=true` returns an id in two seconds and the Docker build
 * behind it runs for five minutes — during which, before this file,
 * the window said nothing at all. There was a chip in the composer for
 * exactly this and it was wired to `null`: it had never been fed.
 *
 * Two jobs here, both pure so they can be tested without a clock or a
 * backend:
 *
 * 1. **What to show while it runs.** One line, naming the command
 *    rather than the id — `bg_1` is the agent's handle for it and
 *    `docker build -t …` is what the person started.
 * 2. **What to say when it ends.** Which is not "the list got
 *    shorter": an exit code is the whole content of a build, and a
 *    job that merely disappeared is an outcome nobody was told.
 */

import type { BackgroundJob } from "./figycode-agent";

/**
 * The jobs that have finished since the last look.
 *
 * Compares by id against what was last seen. Two cases count, and the
 * second is the one that is easy to miss: a job that *was* running and
 * is now finished, and a job that appeared already finished — which
 * happens whenever a command fails fast enough to beat the next poll.
 *
 * A job that is simply gone does not count. The shell keeps finished
 * jobs, so a disappearance means the window was closed or the shell
 * replaced, and inventing a completion for it would be a lie with an
 * exit code on it.
 */
export function finishedSince(
  before: BackgroundJob[],
  now: BackgroundJob[]
): BackgroundJob[] {
  const was = new Map(before.map((job) => [job.id, job]));
  return now.filter((job) => {
    if (!job.finished) return false;
    const seen = was.get(job.id);
    // Already reported, or never seen and already done — both are
    // "newly finished" exactly once.
    return seen === undefined || !seen.finished;
  });
}

/**
 * Of those, the ones this surface should tell its model about.
 *
 * Both surfaces watch the same shell — one machine, one set of
 * processes — so both see every job finish. Only the conversation that
 * *started* one has any business reporting it: the other never ran it,
 * has no idea what it was for, and would be spending a request to say
 * so.
 *
 * A job with no owner is nobody's. That happens for a shell that does
 * not track owners, which is every fake in a test, and the safe
 * reading of "nobody started this" is "do not speak for it".
 */
export function mine(jobs: BackgroundJob[], surface: string): BackgroundJob[] {
  return jobs.filter((job) => job.owner === surface);
}

/** Only the ones still going, which is what a chip counts. */
export function stillRunning(jobs: BackgroundJob[]): BackgroundJob[] {
  return jobs.filter((job) => !job.finished);
}

/**
 * `docker build -t figycode-image .` → `docker build`.
 *
 * The first two words, because that is what identifies a command at a
 * glance and the rest is flags. A chip that showed the whole line
 * would push everything else off a 320px column.
 */
export function shortCommand(command: string): string {
  const words = command.trim().split(/\s+/);
  const head = words.slice(0, 2).join(" ");
  return head.length > 32 ? `${head.slice(0, 31)}…` : head;
}

/** `2m 14s`, `47s`. Rounded, because nobody is timing it to the ms. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  // Same rule one unit up: a bare `1h` rather than `1h 0m`, which the
  // minutes branch already got right and this one did not.
  const spare = minutes % 60;
  return spare ? `${Math.floor(minutes / 60)}h ${spare}m` : `${Math.floor(minutes / 60)}h`;
}

/**
 * The chip, as one line.
 *
 * Names the command when there is one of them and counts when there
 * are several — "2 background tasks" is more useful than two half
 * commands, and the list is one click away.
 */
export function backgroundLabel(jobs: BackgroundJob[]): string | null {
  const running = stillRunning(jobs);
  if (running.length === 0) return null;
  if (running.length === 1) {
    const one = running[0];
    return `${shortCommand(one.command)} · ${formatDuration(one.ms)}`;
  }
  return `${running.length} background tasks`;
}

/** How a finished job reads in the transcript. */
export interface Outcome {
  tone: "info" | "warn" | "error";
  title: string;
  body: string;
  /** Whether this is the kind of outcome worth a sentence back. */
  failed: boolean;
}

/**
 * What a finished job says for itself.
 *
 * Written so the **exit code decides the tone**, because "finished" is
 * what an agent says when it has told somebody their image built and
 * it did not. A non-zero exit is not a completion with a footnote; it
 * is a failure, and it gets the word.
 */
export function outcomeOf(job: BackgroundJob): Outcome {
  const name = shortCommand(job.command);
  const took = formatDuration(job.ms);
  const ok = job.status === 0;

  if (ok) {
    return {
      tone: "info",
      title: `${name} finished · ${took}`,
      body: `${job.command}\nExit 0 · ${job.lines} line${job.lines === 1 ? "" : "s"} of output.`,
      failed: false,
    };
  }

  return {
    tone: job.status === null ? "warn" : "error",
    title:
      job.status === null
        ? `${name} stopped · ${took}`
        : `${name} FAILED · exit ${job.status} · ${took}`,
    body:
      job.status === null
        ? `${job.command}\nIt ended without reporting an exit code — it was most likely killed.`
        : `${job.command}\nExit ${job.status} after ${took}.`,
    failed: true,
  };
}

/**
 * What the agent is told when a job it started has finished.
 *
 * Not the notice. The notice is for the person and is already on
 * screen; this is the message that makes the agent go and look, and
 * it is written for a model holding this conversation — the id and the
 * command are already in its history from the call that started them,
 * so this adds the two facts it cannot know (that it ended, and how)
 * and says what to do about them.
 *
 * It asks for **brevity on success and action on failure**, because
 * those are genuinely different situations: a green build needs one
 * line and a red one needs the log read. Without the distinction a
 * model writes four paragraphs about a build that worked.
 */
export function reportOf(job: BackgroundJob): string {
  const took = formatDuration(job.ms);
  if (job.status === 0) {
    return (
      `[background] ${job.id} (${job.command}) finished successfully, exit 0, after ${took}. ` +
      `Tell me in one sentence that it is done. Only read its output with bash_output if ` +
      `something about it needs saying.`
    );
  }
  if (job.status === null) {
    return (
      `[background] ${job.id} (${job.command}) stopped after ${took} without an exit code — ` +
      `it was most likely killed. Say so in one line. Do not restart it unless I ask.`
    );
  }
  return (
    `[background] ${job.id} (${job.command}) FAILED with exit ${job.status} after ${took}. ` +
    `Read its output with bash_output, tell me what went wrong, and fix it if the fix is clear.`
  );
}
