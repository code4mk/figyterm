import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Cloud, GitBranch, Search } from "lucide-react";
import {
  gitBranches,
  gitStashPush,
  gitSwitch,
  GitBranch as Branch,
  relativeDate,
} from "../../services/git";
import { fuzzyFilter } from "../../services/fuzzy";
import { scrollIntoViewWithin } from "../../services/scroll";

/**
 * The branch switcher, opened from the branch name in the panel.
 *
 * Two things happen here rather than one, because they are the same decision.
 * Picking a branch with a dirty working tree has three possible answers — take
 * the changes along, put them away first, or don't switch — and a picker that
 * only knew how to do the first would either fail with git's message or
 * silently carry half-finished work onto a branch it doesn't belong to. So the
 * dirty case turns this into its second view, where that choice is made and
 * named.
 *
 * "Take them with me" is the one that needs stating: git carries a modified
 * file across a checkout when the two branches agree on it, and refuses the
 * whole switch when they don't. That is a real and useful behaviour — it is
 * how you move a tweak onto the branch it should have been on — and the offer
 * is only there because the refusal is safe: nothing is lost when git says no.
 */

interface BranchPickerProps {
  dir: string;
  /** What HEAD is on now, for marking its row and naming where a stash lands. */
  current: string | null;
  /** Whether the working tree has anything in it that a switch would disturb. */
  dirty: boolean;
  /** Re-reads the repository once something has happened. */
  onDone: () => void;
  onClose: () => void;
  /** Git's own words, shown where the action was taken. */
  onError: (message: string) => void;
}

/** What the dirty tree will do about the switch. */
type Plan = "stash" | "carry";

export function BranchPicker({
  dir,
  current,
  dirty,
  onDone,
  onClose,
  onError,
}: BranchPickerProps) {
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  /** Set once a branch is picked and the tree turns out to be dirty. */
  const [pending, setPending] = useState<Branch | null>(null);
  const [stashMessage, setStashMessage] = useState("");
  const [working, setWorking] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void gitBranches(dir)
      .then((all) => {
        if (!cancelled) setBranches(all);
      })
      .catch((e) => {
        if (cancelled) return;
        setBranches([]);
        onError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [dir, onError]);

  const results = useMemo(() => {
    if (!branches) return [];
    const trimmed = query.trim();
    if (!trimmed) return branches.map((item) => ({ item, matches: [] as number[] }));
    return fuzzyFilter(branches, trimmed, (branch) => branch.name).map((hit) => ({
      item: hit.item,
      matches: hit.matches,
    }));
  }, [branches, query]);

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    const list = listRef.current;
    scrollIntoViewWithin(list, list?.children[cursor] as HTMLElement | undefined);
  }, [cursor]);

  /** Does the switch, having decided what to do about the working tree. */
  const run = useCallback(
    async (branch: Branch, plan: Plan | null) => {
      setWorking(true);
      try {
        if (plan === "stash") {
          /*
            The title is required, not defaulted. A generated name — "Before
            switching to X" — is the same sentence on every row, and a stash
            list where every entry reads alike is a list you have to open one
            by one to use. The one thing only the person stashing knows is what
            the work was.
          */
          const message = stashMessage.trim();
          if (!message) return;
          await gitStashPush(dir, message);
        }
        await gitSwitch(dir, branch.name, branch.remote);
        onDone();
        onClose();
      } catch (e) {
        // Left open on the branch that failed: git's message is usually
        // "commit or stash them", and the button for that is right here.
        onError(String(e));
        setWorking(false);
      }
    },
    [dir, stashMessage, onDone, onClose, onError]
  );

  const choose = useCallback(
    (branch: Branch) => {
      if (working || branch.current) return;
      if (dirty) {
        setPending(branch);
        return;
      }
      void run(branch, null);
    },
    [working, dirty, run]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setCursor((i) => Math.min(i + 1, results.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setCursor((i) => Math.max(i - 1, 0));
        break;
      case "Enter": {
        e.preventDefault();
        const picked = results[cursor]?.item;
        if (picked) choose(picked);
        break;
      }
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  return (
    <div
      className="editor-overlay-backdrop fixed inset-0 z-[300] flex items-start justify-center pt-[10%]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div
        className="editor-palette w-[440px] max-w-[92%] rounded-xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {pending ? (
          <DirtySwitch
            branch={pending}
            from={current}
            message={stashMessage}
            working={working}
            onMessage={setStashMessage}
            onBack={() => setPending(null)}
            onChoose={(plan) => void run(pending, plan)}
          />
        ) : (
          <>
            <div className="editor-palette-head px-3 py-2 text-[11px]">
              Switch branch
              {current && (
                <>
                  {" from "}
                  <span className="editor-palette-subject">{current}</span>
                </>
              )}
            </div>

            <div className="editor-palette-field flex items-center gap-2 px-3 py-2">
              <Search size={13} className="editor-palette-icon shrink-0" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                onKeyUp={(e) => e.stopPropagation()}
                onPaste={(e) => e.stopPropagation()}
                placeholder={branches ? "Find a branch…" : "Reading branches…"}
                spellCheck={false}
                className="editor-palette-input flex-1 min-w-0 bg-transparent outline-none text-[12px]"
              />
            </div>

            <div ref={listRef} className="editor-palette-list max-h-[300px] overflow-y-auto py-1">
              {results.map((result, index) => (
                <div
                  key={`${result.item.remote ? "r" : "l"}:${result.item.name}`}
                  className={`editor-palette-row editor-branch-row flex items-center gap-2 px-3 py-1.5 ${
                    index === cursor ? "selected" : ""
                  } ${result.item.current ? "current" : ""}`}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => choose(result.item)}
                  title={
                    result.item.current
                      ? "Already on this branch"
                      : result.item.remote
                        ? `Create a local branch tracking ${result.item.name}`
                        : result.item.subject
                  }
                >
                  {result.item.current ? (
                    <Check size={12} className="editor-branch-check shrink-0" />
                  ) : result.item.remote ? (
                    <Cloud size={12} className="editor-branch-remote shrink-0" />
                  ) : (
                    <GitBranch size={12} className="shrink-0 opacity-70" />
                  )}
                  <span className="flex-1 min-w-0 truncate text-[12px]">
                    <Highlighted text={result.item.name} matches={result.matches} />
                  </span>
                  <span className="editor-branch-when text-[10px] shrink-0">
                    {result.item.date ? relativeDate(result.item.date) : ""}
                  </span>
                </div>
              ))}

              {branches && results.length === 0 && (
                <div className="editor-palette-empty px-3 py-5 text-center text-[11px]">
                  No matching branch
                </div>
              )}
            </div>

            {dirty && (
              <div className="editor-branch-dirty px-3 py-2 text-[10px]">
                You have uncommitted changes — picking a branch will ask what to do with
                them.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The second view: what to do with a dirty tree before switching. */
function DirtySwitch({
  branch,
  from,
  message,
  working,
  onMessage,
  onBack,
  onChoose,
}: {
  branch: Branch;
  from: string | null;
  message: string;
  working: boolean;
  onMessage: (value: string) => void;
  onBack: () => void;
  onChoose: (plan: Plan) => void;
}) {
  const named = message.trim().length > 0;

  return (
    <>
      <div className="editor-palette-head px-3 py-2 text-[11px]">
        Switching to <span className="editor-palette-subject">{branch.name}</span>
      </div>

      <div className="editor-branch-explain px-3 py-2.5 text-[11px] leading-relaxed">
        You have uncommitted changes{from ? ` on ${from}` : ""}. Stashing puts them away —
        untracked files included — and you can bring them back from the Stashes tab on
        {from ? ` ${from}` : " that branch"}.
      </div>

      <div className="px-3 pb-1">
        <label className="editor-branch-label block mb-1 text-[10px] font-semibold uppercase tracking-wide">
          What is this work?
        </label>
        <input
          autoFocus
          value={message}
          onChange={(e) => onMessage(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              // Enter is the stash button, and the stash button needs a title.
              if (named) onChoose("stash");
            } else if (e.key === "Escape") {
              e.preventDefault();
              onBack();
            }
          }}
          onKeyUp={(e) => e.stopPropagation()}
          onPaste={(e) => e.stopPropagation()}
          placeholder="Half-finished login form"
          spellCheck={false}
          className="editor-dialog-input w-full px-2 py-1.5 rounded-md text-[12px] outline-none"
        />
      </div>

      <div className="editor-branch-actions flex items-center justify-end gap-2 px-3 py-2">
        <button
          className="editor-dialog-btn px-3 py-1.5 rounded-md text-[11px] font-medium"
          onClick={onBack}
          disabled={working}
        >
          Back
        </button>
        {/*
          Offered, not hidden: carrying a change across is how a tweak ends up
          on the branch it belonged on. Git refuses when the two branches
          disagree about the file, so the worst case is the message saying so.
        */}
        <button
          className="editor-dialog-btn px-3 py-1.5 rounded-md text-[11px] font-medium"
          onClick={() => onChoose("carry")}
          disabled={working}
          title="Switch without stashing. Git will refuse if the changes collide with the other branch."
        >
          Take changes with me
        </button>
        <button
          className="editor-dialog-btn primary px-3 py-1.5 rounded-md text-[11px] font-medium"
          onClick={() => onChoose("stash")}
          disabled={working || !named}
          title={named ? undefined : "Give the stash a title first"}
        >
          {working ? "Working…" : "Stash and switch"}
        </button>
      </div>
    </>
  );
}

/** Shows which characters the query matched. */
function Highlighted({ text, matches }: { text: string; matches: number[] }) {
  const hits = new Set(matches);
  return (
    <>
      {[...text].map((char, index) => (
        <span key={index} className={hits.has(index) ? "editor-palette-match" : ""}>
          {char}
        </span>
      ))}
    </>
  );
}
