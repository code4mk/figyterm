import { open as openExternal } from "@tauri-apps/plugin-shell";
import { ExternalLink } from "lucide-react";
import { branchUrl, commitUrl, Remote, stripRemotePrefix } from "../../services/git-forge";

/**
 * A commit SHA or a branch name that opens on the forge.
 *
 * Two things it deliberately is not:
 *
 * - **Not the in-app browser.** The embedded browser exists and would be
 *   slicker, but a commit page is something people send to a colleague, paste
 *   into a review, and open beside four other tabs. The system browser is where
 *   their session, their extensions and their other tabs already are.
 * - **Not always a link.** A repository with no remote, or one cloned from a
 *   local path, has no web page behind it. `parseRemote` returns null there and
 *   this renders the plain text instead — a link that 404s is worse than none.
 *
 * The SHA gets a background because monospace digits on their own do not read
 * as something you can press. That is the whole reason for the chip: it says
 * "this is an object, and it goes somewhere".
 */

interface RemoteLinkProps {
  remote: Remote | null;
  /** A commit, by full SHA — the short form is what gets shown. */
  sha?: { full: string; short: string };
  /** A branch, possibly still carrying its `origin/` prefix. */
  branch?: string;
  className?: string;
}

export function RemoteLink({ remote, sha, branch, className = "" }: RemoteLinkProps) {
  const label = sha ? sha.short : branch ? stripRemotePrefix(branch) : "";
  if (!label) return null;

  const href = !remote
    ? null
    : sha
      ? commitUrl(remote, sha.full)
      : branch
        ? branchUrl(remote, branch)
        : null;

  if (!href || !remote) {
    return <span className={className}>{label}</span>;
  }

  return (
    <button
      className={`editor-remote-link ${className}`}
      onClick={(e) => {
        // The rows these sit in open a diff or a drawer; a link is not that.
        e.stopPropagation();
        void openExternal(href).catch(() => {});
      }}
      title={`Open on ${remote.host}`}
    >
      <span className="truncate">{label}</span>
      <ExternalLink size={9} className="editor-remote-link-icon shrink-0" />
    </button>
  );
}
