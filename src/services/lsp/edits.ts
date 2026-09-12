/**
 * Applying a server's edits to files, including files that are not open.
 *
 * This is the part of the client that **writes**, and it is a different risk
 * class from everything else. A rename across forty files is forty chances to
 * lose one, so an edit to a closed file goes through exactly the same path as a
 * save — the atomic write, the mtime conflict check and the preserved line
 * endings from `filesystem/operations.rs` — and never through a plain overwrite.
 *
 * **On atomicity, honestly.** There is no cross-file transaction to be had here:
 * the filesystem has no such thing and building a journal for this would be a
 * larger project than the feature. What this does instead is *pre-flight*
 * everything — read every closed file, resolve every range, build every new
 * text — and only then write. A failure after that point is reported naming
 * exactly which files changed and which did not, because a rename that half
 * happened and says so is recoverable, and one that half happens silently is
 * not.
 */

import { Text } from "@codemirror/state";
import { FileEncoding, LineEnding, readTextFile, writeTextFile } from "../editor-fs";
import { rangeToOffsets } from "./position";
import type { PositionEncoding, TextEdit, WorkspaceEdit } from "./protocol";
import { uriToPath } from "./uri";

/** What the editor must provide for edits to reach buffers the user has open. */
export interface EditContext {
  /**
   * Applies edits to an open buffer, through CodeMirror so the change is one
   * undoable step. Returns false when the path isn't open, which sends it down
   * the closed-file path instead.
   */
  applyToOpenBuffer: (path: string, edits: { from: number; to: number; insert: string }[]) => boolean;
  /** The text of an open buffer, for resolving ranges against what is on screen. */
  openText: (path: string) => string | null;
}

export interface EditOutcome {
  applied: boolean;
  /** Paths that changed, open buffers included. */
  changed: string[];
  /** Why it stopped, when it did. */
  error: string | null;
}

/** One file's worth of work, resolved and ready to write. */
interface PlannedFile {
  path: string;
  open: boolean;
  /** Offsets into the file as it is now, descending, so applying can't shift. */
  edits: { from: number; to: number; insert: string }[];
  /** Only for closed files: what to write, and what it must still look like. */
  content?: string;
  encoding?: FileEncoding;
  lineEnding?: LineEnding;
  mtime?: number | null;
}

/**
 * Turns a server's `TextEdit`s into CodeMirror changes against `doc`.
 *
 * Sorted descending and checked for overlap: the protocol forbids overlapping
 * edits in one document, and a server that sends them anyway would otherwise
 * produce silently mangled text rather than an error.
 */
function resolve(
  doc: Text,
  edits: TextEdit[],
  encoding: PositionEncoding
): { from: number; to: number; insert: string }[] | string {
  const resolved = edits
    .map((edit) => {
      const { from, to } = rangeToOffsets(doc, edit.range, encoding);
      return { from, to, insert: edit.newText ?? "" };
    })
    // Descending, so each application leaves the offsets of the ones still to
    // come untouched.
    .sort((a, b) => b.from - a.from || b.to - a.to);

  for (let i = 1; i < resolved.length; i++) {
    if (resolved[i].to > resolved[i - 1].from) {
      return "the server sent overlapping edits for one file";
    }
  }
  return resolved;
}

/** Every file a `WorkspaceEdit` touches, in the two shapes the protocol allows. */
function collect(edit: WorkspaceEdit): Map<string, TextEdit[]> {
  const byUri = new Map<string, TextEdit[]>();

  const add = (uri: string, edits: TextEdit[]) => {
    const existing = byUri.get(uri);
    if (existing) existing.push(...edits);
    else byUri.set(uri, [...edits]);
  };

  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      // Only `TextDocumentEdit`s. Create, rename and delete operations are a
      // different feature with different consequences, and we did not claim
      // support for them in the handshake — so a server sending one is sending
      // something we must not guess at.
      if (!change?.textDocument?.uri || !Array.isArray(change.edits)) continue;
      add(change.textDocument.uri, change.edits);
    }
  }
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      if (Array.isArray(edits)) add(uri, edits);
    }
  }

  return byUri;
}

/**
 * Applies a `WorkspaceEdit`.
 *
 * Every read happens before every write. A file that cannot be read, a range
 * that cannot be resolved, or an overlapping pair stops the whole thing before
 * anything has changed.
 */
export async function applyWorkspaceEdit(
  edit: WorkspaceEdit,
  encoding: PositionEncoding,
  context: EditContext
): Promise<EditOutcome> {
  const byUri = collect(edit);
  if (!byUri.size) return { applied: true, changed: [], error: null };

  const planned: PlannedFile[] = [];

  // ── Pre-flight: resolve everything, write nothing ────────────────────────
  for (const [uri, edits] of byUri) {
    const path = uriToPath(uri);
    if (!path) {
      return {
        applied: false,
        changed: [],
        error: `the server wants to edit ${uri}, which is not a file`,
      };
    }
    if (!edits.length) continue;

    const openText = context.openText(path);

    if (openText !== null) {
      const resolved = resolve(Text.of(openText.split("\n")), edits, encoding);
      if (typeof resolved === "string") {
        return { applied: false, changed: [], error: `${path}: ${resolved}` };
      }
      planned.push({ path, open: true, edits: resolved });
      continue;
    }

    let file;
    try {
      file = await readTextFile(path);
    } catch (error) {
      return { applied: false, changed: [], error: `could not read ${path}: ${error}` };
    }
    if (file.kind !== "text") {
      return { applied: false, changed: [], error: `${path} is not an editable text file` };
    }

    const doc = Text.of(file.content.split("\n"));
    const resolved = resolve(doc, edits, encoding);
    if (typeof resolved === "string") {
      return { applied: false, changed: [], error: `${path}: ${resolved}` };
    }

    // Applied descending, so earlier offsets stay valid throughout.
    let content = file.content;
    for (const change of resolved) {
      content = content.slice(0, change.from) + change.insert + content.slice(change.to);
    }

    planned.push({
      path,
      open: false,
      edits: resolved,
      content,
      encoding: file.encoding,
      lineEnding: file.lineEnding,
      mtime: file.mtime,
    });
  }

  // ── Apply ────────────────────────────────────────────────────────────────
  const changed: string[] = [];

  // Open buffers first: they are in memory, cannot fail for filesystem reasons,
  // and are undoable — so if a later write fails, the recoverable half is the
  // half that already happened.
  for (const file of planned.filter((entry) => entry.open)) {
    if (context.applyToOpenBuffer(file.path, file.edits)) changed.push(file.path);
  }

  for (const file of planned.filter((entry) => !entry.open)) {
    try {
      const outcome = await writeTextFile(
        file.path,
        file.content!,
        file.encoding!,
        file.lineEnding!,
        // The mtime read moments ago. A file that changed underneath in that
        // window is a conflict, and conflicts are refused rather than won.
        file.mtime ?? null
      );
      if (outcome.status === "conflict") {
        return {
          applied: false,
          changed,
          error: `${file.path} changed on disk; stopped after ${changed.length} file${
            changed.length === 1 ? "" : "s"
          }`,
        };
      }
      changed.push(file.path);
    } catch (error) {
      return {
        applied: false,
        changed,
        error: `could not write ${file.path}: ${error}`,
      };
    }
  }

  return { applied: true, changed, error: null };
}

/** How many files and edits a `WorkspaceEdit` covers, for the rename preview. */
export function summarize(edit: WorkspaceEdit): { files: number; edits: number } {
  const byUri = collect(edit);
  let edits = 0;
  for (const list of byUri.values()) edits += list.length;
  return { files: byUri.size, edits };
}
