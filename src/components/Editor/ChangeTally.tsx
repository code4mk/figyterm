import { GitChange } from "../../services/git";

/**
 * "24 edited · 6 new · 1 deleted", as coloured chips.
 *
 * Shared by the Changes tab and the history drawer so a commit and a working
 * tree of the same shape read identically — and so there is one place the
 * grouping is decided. `tally` in `services/git.ts` does the deciding and
 * explains why a rename is its own count rather than an edit.
 *
 * Coloured by `GitChange`, reusing the row classes, so "new" is the same green
 * the change gutter draws an added line in. One palette, three places.
 */

interface ChangeTallyProps {
  parts: { key: string; label: string; count: number; kind: GitChange }[];
}

export function ChangeTally({ parts }: ChangeTallyProps) {
  // Nothing to say when a single kind accounts for everything: "3 files
  // changed · 3 edited" is the same sentence twice.
  if (parts.length < 2) return null;

  return (
    <div className="editor-scm-tally flex items-center gap-2 flex-wrap mt-0.5">
      {parts.map((part) => (
        <span
          key={part.key}
          className={`editor-scm-tally-part flex items-center gap-1 git-${part.kind}`}
        >
          <span className="editor-scm-tally-dot" aria-hidden />
          <span className="tabular-nums">{part.count}</span>
          {part.label}
        </span>
      ))}
    </div>
  );
}
