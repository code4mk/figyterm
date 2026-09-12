import { useEffect, useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, FolderPlus, X } from "lucide-react";
import {
  lastSegment,
  normalizeFolder,
  PermissionMode,
} from "../../services/claude-project";
import { collapseHome } from "../../services/recent-dirs";

/**
 * New project: one folder, and any others Claude may also touch.
 *
 * **There is no name field.** The project is called whatever the primary folder
 * is called, which is nearly always what anyone would have typed — and a name
 * that can drift from its folder is a name that will. Two checkouts of one
 * repository are told apart by the path under the name in the switcher.
 *
 * The ✕ on an additional folder here is not a contradiction of the add-only
 * rule elsewhere: nothing has been granted yet, so this is undoing a click
 * rather than revoking access. Once the project exists, its folder set only
 * grows.
 */

const MODES: { value: PermissionMode | ""; label: string }[] = [
  { value: "", label: "Default" },
  { value: "manual", label: "Ask every time" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan first" },
];

const MODELS: { value: string; label: string }[] = [
  { value: "", label: "Default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

interface ClaudeSetupProps {
  /** The focused pane's working directory — the folder this usually wants. */
  suggestedRoot?: string;
  onCancel: () => void;
  onCreate: (project: {
    root: string;
    extraDirs: string[];
    model?: string;
    permissionMode?: PermissionMode;
  }) => void;
}

export function ClaudeSetup({ suggestedRoot, onCancel, onCreate }: ClaudeSetupProps) {
  const [root, setRoot] = useState(suggestedRoot ? normalizeFolder(suggestedRoot) : "");
  const [extraDirs, setExtraDirs] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode | "">("");
  const [showOptions, setShowOptions] = useState(false);

  // The pane's cwd moves while the dialog is closed, and a stale suggestion is
  // worse than none — but only until the user has made this field theirs.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched && suggestedRoot) setRoot(normalizeFolder(suggestedRoot));
  }, [suggestedRoot, touched]);

  const browse = async (into: "root" | "extra") => {
    const picked = await openFolderDialog({
      directory: true,
      multiple: false,
      defaultPath: root || undefined,
    });
    if (typeof picked !== "string") return;
    const folder = normalizeFolder(picked);

    if (into === "root") {
      setTouched(true);
      setRoot(folder);
      // A folder that became the primary one has no business also being an
      // extra: it would be a chip granting access that is already granted.
      setExtraDirs((dirs) => dirs.filter((dir) => dir !== folder));
      return;
    }

    setExtraDirs((dirs) =>
      dirs.includes(folder) || folder === normalizeFolder(root) ? dirs : [...dirs, folder]
    );
  };

  const submit = () => {
    const folder = normalizeFolder(root);
    if (!folder) return;
    onCreate({
      root: folder,
      extraDirs,
      model: model || undefined,
      permissionMode: permissionMode || undefined,
    });
  };

  const name = lastSegment(normalizeFolder(root));

  return (
    <div
      className="editor-dialog-backdrop absolute inset-0 z-[20] flex items-start justify-center pt-[8vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onCancel();
        // ⌘↵ / Ctrl+↵ from anywhere in the form, since the folder field is the
        // only thing most people touch.
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
      }}
    >
      <div
        className="editor-workspace-modal w-[520px] max-w-[92vw] rounded-xl flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="New Claude project"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="editor-workspace-header flex items-center gap-2 px-3.5 py-2.5 shrink-0">
          <span className="editor-dialog-title text-[13px] font-semibold flex-1">
            New Claude project
          </span>
          <button
            className="editor-icon-btn p-1 rounded"
            onClick={onCancel}
            title="Close"
            aria-label="Close"
          >
            <X size={13} />
          </button>
        </div>

        <div className="px-3.5 py-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="claude-field-label">Folder</span>
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={root}
                onChange={(e) => {
                  setTouched(true);
                  setRoot(e.target.value);
                }}
                onPaste={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                spellCheck={false}
                placeholder="~/code/my-project"
                className="claude-input flex-1 min-w-0 text-[12px] px-2 py-1.5 rounded-md"
              />
              <button
                className="editor-dialog-btn flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px]"
                onClick={() => void browse("root")}
              >
                <FolderOpen size={12} />
                Browse
              </button>
            </div>
            <span className="claude-field-hint">
              {name
                ? `Claude runs here, and the project is called “${name}”.`
                : "Claude runs here. The project takes this folder's name."}
            </span>
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="claude-field-label">Additional folders</span>
            {extraDirs.length > 0 && (
              <div className="flex flex-col gap-1">
                {extraDirs.map((dir) => (
                  <div key={dir} className="claude-folder-row flex items-center gap-2 px-2 py-1.5 rounded-md">
                    <span className="text-[11px] truncate flex-1" title={dir}>
                      {collapseHome(dir)}
                    </span>
                    <button
                      className="editor-icon-btn p-0.5 rounded shrink-0"
                      onClick={() => setExtraDirs((dirs) => dirs.filter((d) => d !== dir))}
                      title="Remove from this new project"
                      aria-label={`Remove ${dir}`}
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              className="editor-dialog-btn flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] self-start"
              onClick={() => void browse("extra")}
            >
              <FolderPlus size={12} />
              Add folder…
            </button>
            <span className="claude-field-hint">
              Folders outside the project that Claude may also read and edit.
              They can be added later, but not removed — a narrower set is a new
              project.
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <button
              className="claude-disclosure text-[11px] self-start"
              onClick={() => setShowOptions((open) => !open)}
              aria-expanded={showOptions}
            >
              {showOptions ? "Hide options" : "Model and permissions…"}
            </button>
            {showOptions && (
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2">
                  <span className="claude-field-label">Model</span>
                  <select
                    className="claude-input text-[11px] px-2 py-1 rounded-md"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {MODELS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <span className="claude-field-label">Permissions</span>
                  <select
                    className="claude-input text-[11px] px-2 py-1 rounded-md"
                    value={permissionMode}
                    onChange={(e) => setPermissionMode(e.target.value as PermissionMode | "")}
                  >
                    {MODES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </div>
        </div>

        <div className="editor-workspace-footer flex items-center gap-2 px-3.5 py-2.5 shrink-0">
          <div className="flex-1" />
          <button
            className="editor-dialog-btn px-3 py-1.5 rounded-md text-[11px] font-medium"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="editor-dialog-btn primary px-3 py-1.5 rounded-md text-[11px] font-medium"
            onClick={submit}
            disabled={!root.trim()}
          >
            Start
          </button>
        </div>
      </div>
    </div>
  );
}
