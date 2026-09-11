/**
 * Turning a git remote URL into web addresses on the forge it points at.
 *
 * Kept apart from `git.ts` because it is guesswork of a particular kind. A
 * remote URL says where to *fetch* from; nothing in git says what a commit
 * looks like in a browser, and every forge spells it differently. So this is a
 * table of conventions with a fallback, not a protocol — and it is honest about
 * the cases it cannot answer, because a link that 404s is worse than no link.
 *
 * The four spellings a remote can arrive in:
 *
 *     git@github.com:user/repo.git          the SSH shorthand
 *     ssh://git@github.com/user/repo.git    the same, spelled out
 *     https://github.com/user/repo.git      HTTPS
 *     /srv/git/repo.git                     a local path — no web address at all
 */

export type Forge = "github" | "gitlab" | "bitbucket" | "gitea" | "unknown";

export interface Remote {
  /** `https://github.com/user/repo`, with no trailing `.git` or slash. */
  base: string;
  /** The host, for a tooltip that says where a link is about to go. */
  host: string;
  forge: Forge;
}

/**
 * Parses a remote URL into the base of its web address.
 *
 * Null for anything without a host — a local path, a bare filesystem clone, or
 * a scheme this does not recognise. There is no web page to link to in those
 * cases, and inventing one would produce a link that goes nowhere.
 */
export function parseRemote(raw: string): Remote | null {
  const url = raw.trim();
  if (!url) return null;

  let host = "";
  let path = "";

  // `git@host:user/repo.git` — the SSH shorthand, which is not a URL and so
  // cannot be handed to `new URL()`. The colon is a separator here, not a port.
  const shorthand = /^(?:([^@/]+)@)?([^@/:]+):(.+)$/.exec(url);
  if (shorthand && !url.includes("://")) {
    host = shorthand[2];
    path = shorthand[3];
  } else {
    try {
      const parsed = new URL(url);
      // `file:` has a path and no host; a link to it means nothing.
      if (!parsed.hostname) return null;
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return null;
    }
  }

  const repo = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  if (!repo || !host) return null;

  return { base: `https://${host}/${repo}`, host, forge: forgeOf(host) };
}

/**
 * Which conventions to follow, from the hostname.
 *
 * By host rather than by asking the server, because this runs on a click and
 * the answer only changes the shape of a path. A self-hosted GitLab at
 * `git.example.com` therefore reads as `unknown` and gets GitHub's spelling,
 * which is the most common one and the one Gitea and Forgejo also use — so the
 * fallback is right more often than it is wrong.
 */
function forgeOf(host: string): Forge {
  const lower = host.toLowerCase();
  if (lower === "github.com" || lower.endsWith(".github.com")) return "github";
  if (lower === "gitlab.com" || lower.startsWith("gitlab.")) return "gitlab";
  if (lower === "bitbucket.org") return "bitbucket";
  if (lower.startsWith("gitea.") || lower.startsWith("codeberg.")) return "gitea";
  return "unknown";
}

/** The page for one commit. */
export function commitUrl(remote: Remote, sha: string): string {
  switch (remote.forge) {
    case "gitlab":
      return `${remote.base}/-/commit/${sha}`;
    case "bitbucket":
      return `${remote.base}/commits/${sha}`;
    // GitHub's `/commit/<sha>`, which Gitea and Forgejo also use.
    default:
      return `${remote.base}/commit/${sha}`;
  }
}

/**
 * The page for a branch.
 *
 * A remote-tracking name arrives as `origin/main`, and the remote does not
 * have a branch called that — the prefix is this repository's bookkeeping. It
 * is stripped, and only the first segment, because `feature/code-editor` is one
 * branch name with a slash in it.
 */
export function branchUrl(remote: Remote, branch: string): string {
  const name = stripRemotePrefix(branch);
  const encoded = name.split("/").map(encodeURIComponent).join("/");

  switch (remote.forge) {
    case "gitlab":
      return `${remote.base}/-/tree/${encoded}`;
    case "bitbucket":
      return `${remote.base}/src/${encoded}`;
    default:
      return `${remote.base}/tree/${encoded}`;
  }
}

/**
 * Drops a leading remote name from a tracking ref.
 *
 * Only when it matches a remote we know about, so a branch genuinely called
 * `origin/something` is left alone — and so `feature/code-editor` never loses
 * its first half.
 */
export function stripRemotePrefix(branch: string, remotes = ["origin", "upstream"]): string {
  for (const remote of remotes) {
    if (branch.startsWith(`${remote}/`)) return branch.slice(remote.length + 1);
  }
  return branch;
}
