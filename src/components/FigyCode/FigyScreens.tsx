/**
 * The three screens that are not the transcript: the start, `/rewind` and
 * `/model`.
 *
 * All three take over the body rather than opening a dialog over it. A modal
 * inside a modal is two Escape keys deep, and the window already has a rule
 * about Escape that the user has just learned; these borrow it instead. The
 * composer stays visible underneath for the same reason — typing is always
 * the way out, including out of a screen you opened by mistake.
 */

import { FolderOpen, FolderSearch } from "lucide-react";
import { CHECKPOINTS, MODELS, type DemoModel } from "../../services/figycode-demo";
import { collapseHome } from "../../services/recent-dirs";
import { projectLabel, type FigyProject } from "../../services/figycode-projects";
import { ChoiceList } from "./FigyPrompt";

/* ─── Start ───────────────────────────────────────────────────────────────── */

/**
 * The first screen, and the only one that has to be honest about two things
 * at once: the folder is real and chosen, and everything the window will then
 * appear to do is not.
 *
 * So the right-hand column states facts it can actually stand behind — the
 * folder, the model, and the fact that nothing is wired up — and the list
 * under it is the other folders this window knows, which is both true and the
 * thing most likely to be wanted next.
 */
export function Welcome({
  model,
  user,
  root,
  index,
  others,
  onPick,
  onBrowse,
}: {
  model: DemoModel;
  user: string;
  root: string | null;
  /** What the backend found in that folder, once it has looked. */
  index: { files: number; folders: number; truncated: boolean } | null;
  others: FigyProject[];
  onPick: (root: string) => void;
  onBrowse: () => void;
}) {
  return (
    <div className="figy-welcome">
      <div className="figy-card figy-welcome-card">
        <div className="figy-welcome-left">
          <div className="figy-welcome-mark">ƒ</div>
          <div className="figy-welcome-name">FigyCode</div>
          <div className="figy-welcome-version">0.1 · {model.short}</div>
          <p className="figy-welcome-copy">
            Welcome back, {user}. Ask for a change, a fix, or an explanation — FigyCode reads,
            edits and runs commands, and asks before anything risky.
          </p>
        </div>

        <div className="figy-welcome-right">
          <div className="figy-welcome-check">
            <span className="figy-welcome-check-label">folder</span>
            {root ? (
              <span className="figy-welcome-check-detail truncate" title={root}>
                {collapseHome(root)}
              </span>
            ) : (
              <button type="button" className="figy-link" onClick={onBrowse}>
                choose one…
              </button>
            )}
          </div>
          {/* Real, counted, and the one line that proves the window is
              looking at the folder it claims to be looking at. */}
          <div className="figy-welcome-check">
            <span className="figy-welcome-check-label">files</span>
            <span className="figy-welcome-check-detail">
              {index ? (
                <>
                  {index.files.toLocaleString()} files · {index.folders.toLocaleString()} folders
                  {index.truncated && " · indexed to the limit"}
                  <span className="figy-sub"> · mention them with @</span>
                </>
              ) : (
                <span className="dim">indexing…</span>
              )}
            </span>
          </div>
          <div className="figy-welcome-check">
            <span className="figy-welcome-check-label">model</span>
            <span className="figy-welcome-check-detail">
              {model.name} · {model.note}
            </span>
          </div>
          <div className="figy-welcome-check">
            <span className="figy-welcome-check-label">agent</span>
            <span className="figy-welcome-check-detail dim">
              not wired up — replies here are scripted
            </span>
          </div>

          {others.length > 0 && (
            <>
              <div className="figy-welcome-resume-head">switch to</div>
              {others.map((other) => (
                <button
                  key={other.root}
                  type="button"
                  className="figy-welcome-resume"
                  onClick={() => onPick(other.root)}
                  title={other.root}
                >
                  <FolderOpen size={11} className="figy-welcome-resume-icon" />
                  <span className="figy-welcome-resume-title">{projectLabel(other.root)}</span>
                  <span className="figy-welcome-resume-when truncate">
                    {collapseHome(other.root)}
                  </span>
                </button>
              ))}
            </>
          )}

          <button type="button" className="figy-welcome-resume" onClick={onBrowse}>
            <FolderSearch size={11} className="figy-welcome-resume-icon" />
            <span className="figy-welcome-resume-title">Open another folder…</span>
          </button>
        </div>
      </div>

      <div className="figy-welcome-hints">
        <span className="figy-key">@</span> mention files
        <span className="figy-sub">·</span>
        <span className="figy-key warn">!</span> run a shell command
        <span className="figy-sub">·</span>
        <span className="figy-key accent">shift+tab</span> plan mode
        <span className="figy-sub">·</span>
        <span className="figy-key accent">ctrl+r</span> rewind
      </div>
    </div>
  );
}

/* ─── /rewind ─────────────────────────────────────────────────────────────── */

export type RewindScope = "both" | "chat" | "code";

const SCOPES: { id: RewindScope; label: string }[] = [
  { id: "both", label: "Restore code and conversation" },
  { id: "chat", label: "Conversation only" },
  { id: "code", label: "Code only" },
];

export function RewindScreen({
  selected,
  onSelect,
  onRestore,
}: {
  selected: number;
  onSelect: (index: number) => void;
  onRestore: (scope: RewindScope) => void;
}) {
  return (
    <div className="figy-screen">
      <div className="figy-screen-title">Rewind</div>
      <div className="figy-screen-copy">
        Pick a message to go back to. Files and the conversation return to how they were then.
      </div>

      <ChoiceList
        options={CHECKPOINTS.map((c) => ({ label: c.label, hint: c.detail }))}
        selected={selected}
        onSelect={onSelect}
        onChoose={() => onRestore("both")}
      />

      <div className="figy-screen-foot">
        {SCOPES.map((scope, i) => (
          <button
            key={scope.id}
            type="button"
            className={`figy-button ${i === 0 ? "primary" : ""}`}
            onClick={() => onRestore(scope.id)}
          >
            {scope.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── /model ──────────────────────────────────────────────────────────────── */

export function ModelScreen({
  selected,
  onSelect,
  onChoose,
  thinking,
  onToggleThinking,
}: {
  selected: number;
  onSelect: (index: number) => void;
  onChoose: (index: number) => void;
  thinking: boolean;
  onToggleThinking: () => void;
}) {
  return (
    <div className="figy-screen">
      <div className="figy-screen-title">Model</div>
      <div className="figy-screen-copy">
        Applies to this session. Set a default in <span className="figy-inline-code">/config</span>.
      </div>

      <ChoiceList
        options={MODELS.map((m) => ({
          label: m.name,
          hint: m.badge ? `${m.badge} · ${m.note}` : m.note,
        }))}
        selected={selected}
        onSelect={onSelect}
        onChoose={onChoose}
      />

      <button
        type="button"
        className="figy-card figy-toggle-row"
        onClick={onToggleThinking}
        aria-pressed={thinking}
      >
        <span className="figy-toggle-label">Extended thinking</span>
        <span className="figy-toggle-note">slower, better for hard bugs</span>
        <span className={`figy-switch ${thinking ? "on" : ""}`}>
          <span className="figy-switch-knob" />
        </span>
      </button>
    </div>
  );
}
