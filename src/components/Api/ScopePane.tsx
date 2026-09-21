/**
 * A folder or a collection, open as a tab.
 *
 * A folder in this format is not a label. It carries a description, an auth
 * block, variables and scripts, and everything under it inherits all four —
 * so "open the folder" has to mean something, and until now it meant nothing
 * but a twisty. The two levels get the same four panels because the only
 * difference between them is that a collection is the outermost one.
 *
 * Auth and Scripts are the same components a request uses. They have to be: a
 * folder's bearer token and a request's are the same block in the same format,
 * and two editors for it would be two chances to write it differently.
 */

import { useEffect, useRef, useState } from "react";
import { Check, FolderOpen, Layers, Pencil, Save } from "lucide-react";
import { ApiItem, DraftAuth } from "../../types/api";
import { ParsedAuth } from "../../services/api/auth";
import { CollectedScript } from "../../services/api/scripts/events";
import { ScopeDraft, ScopeTab } from "../../services/api/scope";
import { Scope, Variable } from "../../services/api/template";
import { Markdown } from "../Updates/Markdown";
import { AuthPanel } from "./AuthPanel";
import { ScriptsPanel } from "./ScriptsPanel";
import { VariableTable } from "./VariableTable";

interface ScopePaneProps {
  kind: "folder" | "collection";
  draft: ScopeDraft;
  tab: ScopeTab;
  onTabChange: (tab: ScopeTab) => void;
  onChange: (patch: Partial<ScopeDraft>) => void;
  onSave: () => void;
  dirty: boolean;
  /** What is inside, for the overview. */
  contents: ApiItem[];
  /** What this level would use if its auth stayed on Inherit. */
  inherited: ParsedAuth;
  inheritedFrom: string | null;
  inheritedBefore: CollectedScript[];
  inheritedAfter: CollectedScript[];
  /** The chain in play, for the auth fields that take `{{variables}}`. */
  scopes: Scope[];
  /** Opens a request from the overview's list. */
  onOpenItem: (id: string) => void;
}

/** What the overview counts. Folders and requests, at any depth. */
function tally(contents: ApiItem[]): { folders: number; requests: number } {
  return {
    folders: contents.filter((row) => row.kind === "folder").length,
    requests: contents.filter((row) => row.kind === "request").length,
  };
}

function Overview({
  kind,
  draft,
  onChange,
  contents,
  onOpenItem,
}: Pick<ScopePaneProps, "kind" | "draft" | "onChange" | "contents" | "onOpenItem">) {
  const counts = tally(contents);
  const requests = contents.filter((row) => row.kind === "request");

  /*
    One of the two at a time.

    The description used to be a textarea with a rendered copy of itself
    underneath, so the same words were on screen twice and neither had the
    room: a paragraph of Markdown in a 110px box above its own preview. A
    description is read far more often than it is written, so reading is the
    default and writing is a state you enter — by pressing Edit, or by clicking
    the text, which is where anybody who wants to change a word will click
    first.
  */
  const [editing, setEditing] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);

  // Focus follows the mode, with the caret at the end rather than at the
  // start: entering the editor is nearly always to add to what is there.
  useEffect(() => {
    if (!editing) return;
    const box = editor.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [editing]);

  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="px-3 pt-3 pb-3">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-ft-text-muted">
            Description
          </span>
          <span className="text-[10px] text-ft-text-muted">
            {editing
              ? "Markdown. Escape when you are done."
              : `Everyone who opens this ${kind} reads it.`}
          </span>
          <span className="flex-1" />
          <button
            className="api-chip-action"
            onClick={() => setEditing(!editing)}
            title={editing ? "Show it as everyone else sees it" : "Edit the Markdown"}
          >
            {editing ? <Check size={10} /> : <Pencil size={10} />}
            {editing ? "Done" : "Edit"}
          </button>
        </div>

        {editing ? (
          <textarea
            ref={editor}
            className="api-body-editor w-full min-h-[160px] resize-y rounded border border-ft-border-subtle bg-transparent px-2 py-1.5 text-[11px] leading-relaxed outline-none focus:border-ft-accent"
            value={draft.description}
            spellCheck={false}
            placeholder={
              kind === "collection"
                ? "What this service is, where it lives, who to ask."
                : "What these requests have in common."
            }
            onChange={(e) => onChange({ description: e.target.value })}
            onKeyDown={(e) => {
              // Escape leaves the editor rather than the tab. Nothing is
              // discarded by it — the draft is already saved on every
              // keystroke, and this only changes which of the two you see.
              if (e.key === "Escape") {
                e.stopPropagation();
                setEditing(false);
              }
            }}
          />
        ) : (
          /*
            The rendered description, and the way into editing it.

            A `div` with a click rather than a button: it holds headings, lists
            and links, and a button full of block elements is invalid markup
            whose links you cannot click — the link would win the click and the
            button would swallow it. So the surface takes the click, and the
            keyboard gets it through the Edit button above, which is a real
            button and already in the tab order.
          */
          <div
            className="api-description"
            onClick={(e) => {
              // A link in the description is for following, not for opening
              // the editor.
              if ((e.target as HTMLElement).closest("a")) return;
              setEditing(true);
            }}
            title="Click to edit"
          >
            {draft.description.trim() === "" ? (
              <span className="text-[11px] text-ft-text-muted">
                {kind === "collection"
                  ? "No description yet. Click to say what this service is, where it lives and who to ask."
                  : "No description yet. Click to say what these requests have in common."}
              </span>
            ) : (
              <Markdown source={draft.description} />
            )}
          </div>
        )}
      </div>

      <div className="border-t border-ft-border-subtle px-3 py-2">
        <div className="mb-1.5 text-[10px] uppercase tracking-wide text-ft-text-muted">
          {counts.requests} request{counts.requests === 1 ? "" : "s"}
          {counts.folders > 0 &&
            ` in ${counts.folders} folder${counts.folders === 1 ? "" : "s"}`}
        </div>

        {requests.length === 0 ? (
          <div className="text-[11px] text-ft-text-muted">
            Nothing in here yet. The <b>+</b> on its row in the sidebar adds a request.
          </div>
        ) : (
          requests.map((row) => (
            <button
              key={row.id}
              className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-ft-surface"
              onClick={() => onOpenItem(row.id)}
              title={row.url ?? row.name}
            >
              <span className="api-method-chip text-ft-accent">
                {(row.method ?? "GET").toUpperCase()}
              </span>
              <span className="flex-1 min-w-0 truncate text-[11px] text-ft-text">{row.name}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-ft-text-muted">
                {row.url}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export function ScopePane({
  kind,
  draft,
  tab,
  onTabChange,
  onChange,
  onSave,
  dirty,
  contents,
  inherited,
  inheritedFrom,
  inheritedBefore,
  inheritedAfter,
  scopes,
  onOpenItem,
}: ScopePaneProps) {
  const Icon = kind === "collection" ? Layers : FolderOpen;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Name, and the one button that writes it */}
      <div className="flex items-center gap-2 px-2 py-2 shrink-0 border-b border-ft-border">
        <Icon size={14} className="shrink-0 text-ft-text-muted" />
        <input
          className="api-url flex-1 min-w-0"
          value={draft.name}
          spellCheck={false}
          placeholder={kind === "collection" ? "Collection name" : "Folder name"}
          onChange={(e) => onChange({ name: e.target.value })}
          aria-label={kind === "collection" ? "Collection name" : "Folder name"}
        />
        <button
          className={`api-icon-button ${dirty ? "text-ft-accent" : "text-ft-text-muted"}`}
          onClick={onSave}
          title="Save (⌘S)"
          aria-label="Save"
        >
          <Save size={13} />
        </button>
      </div>

      <div className="api-tabstrip flex items-center gap-1 px-2 h-7 shrink-0 border-b border-ft-border">
        <button
          className={`api-tab ${tab === "overview" ? "selected" : ""}`}
          onClick={() => onTabChange("overview")}
        >
          Overview
          {draft.description.trim() !== "" && <span className="api-tab-dot" />}
        </button>
        <button
          className={`api-tab ${tab === "auth" ? "selected" : ""}`}
          onClick={() => onTabChange("auth")}
        >
          Authorization
          {draft.auth.type !== "inherit" && draft.auth.type !== "noauth" && (
            <span className="api-tab-dot" />
          )}
        </button>
        <button
          className={`api-tab ${tab === "scripts" ? "selected" : ""}`}
          onClick={() => onTabChange("scripts")}
        >
          Scripts
          {(draft.scripts.prerequest.trim() !== "" || draft.scripts.test.trim() !== "") && (
            <span className="api-tab-dot" />
          )}
        </button>
        <button
          className={`api-tab ${tab === "variables" ? "selected" : ""}`}
          onClick={() => onTabChange("variables")}
        >
          Variables
          {draft.variables.length > 0 && (
            <span className="api-tab-badge">{draft.variables.length}</span>
          )}
        </button>

        <div className="flex-1" />
        <span className="text-[10px] text-ft-text-muted">
          Everything here is inherited by what is inside.
        </span>
      </div>

      {tab === "overview" ? (
        <Overview
          kind={kind}
          draft={draft}
          onChange={onChange}
          contents={contents}
          onOpenItem={onOpenItem}
        />
      ) : tab === "auth" ? (
        <AuthPanel
          auth={draft.auth}
          onChange={(auth: DraftAuth) => onChange({ auth })}
          inherited={inherited}
          inheritedFrom={inheritedFrom}
          scopes={scopes}
        />
      ) : tab === "scripts" ? (
        <ScriptsPanel
          scripts={draft.scripts}
          onChange={(scripts) => onChange({ scripts })}
          inheritedBefore={inheritedBefore}
          inheritedAfter={inheritedAfter}
          savable
        />
      ) : (
        <VariableTable
          variables={draft.variables}
          onChange={(variables: Variable[]) => onChange({ variables })}
          scopes={scopes}
          hint={
            kind === "collection"
              ? "The outermost scope under the environment. Use them anywhere as {{name}}; an environment of the same name wins."
              : "Applies to everything in this folder. A request or an inner folder of the same name wins."
          }
        />
      )}
    </div>
  );
}
