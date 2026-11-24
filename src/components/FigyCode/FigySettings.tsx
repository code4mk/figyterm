/**
 * Settings, as a dialog over the window.
 *
 * It was a body screen that `/model` swapped the transcript for, and
 * before that it was nothing — you discovered the command or you did
 * not. Both were wrong in the same way: changing a setting is a thing
 * you do *to* the conversation, not instead of it. The transcript
 * staying visible underneath is the point, and so is closing this and
 * finding everything exactly as you left it.
 *
 * One dialog rather than a menu of screens, because the fields are one
 * form: a provider with no key is not set up, a key with no model is not
 * set up, and a menu that leads to three places to half-finish that is a
 * menu that produces windows which look configured and cannot send a
 * message.
 *
 * ## What is in here and what is not
 *
 * In: everything that is *stored* — the provider, both keys, the limits,
 * the prices — and the permission mode, which is stored nowhere but is
 * the setting people most need to see rather than cycle blind with
 * shift+tab.
 *
 * Not in: the things that are a *view* of this session rather than a
 * setting. Tokens and spend, the tool list, earlier conversations. They
 * are one line each at the bottom, as links, because they belong in the
 * body where there is room to read them.
 */

import { useState } from "react";
import { Check, X } from "lucide-react";
import { MODE_LABEL, type PermissionMode } from "../../services/figycode-blocks";
import type { AgentSettings } from "../../services/figycode-agent";

/** The three modes, in the order shift+tab cycles them. */
const MODES: PermissionMode[] = ["ask", "acceptEdits", "plan"];

const MODE_NOTE: Record<PermissionMode, string> = {
  ask: "Edits and commands are asked about",
  acceptEdits: "Edits land; commands and the network still ask",
  plan: "Reads and thinks, changes nothing",
};

export function SettingsDialog({
  settings,
  hasKey,
  hasExaKey,
  path,
  mode,
  earlier,
  rules,
  onMode,
  onSave,
  onCommand,
  onClose,
}: {
  settings: AgentSettings;
  hasKey: boolean;
  hasExaKey: boolean;
  /** Where the settings and the keys are written. Plain text, so said. */
  path: string;
  mode: PermissionMode;
  /** How many conversations this folder has had. */
  earlier: number;
  /** The project's own rules file, when it has one. */
  rules: string | null;
  onMode: (mode: PermissionMode) => void;
  onSave: (settings: AgentSettings) => void;
  onCommand: (name: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<AgentSettings>(settings);
  const [key, setKey] = useState("");
  const [exa, setExa] = useState("");

  const ready = !!draft.baseUrl.trim() && !!draft.model.trim();
  // An empty field means "keep what is stored", on both keys — neither
  // can be shown, so a save after changing the model must not blank them.
  const save = () => {
    if (ready) {
      onSave({ ...draft, apiKey: key.trim() || undefined, exaKey: exa.trim() || undefined });
    }
  };

  const field = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    placeholder: string,
    hint?: string
  ) => (
    <label className="figy-field" key={label}>
      <span className="figy-field-label">{label}</span>
      <input
        className="figy-input"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onPaste={(e) => e.stopPropagation()}
        /* Enter saves, because a form with one button and three fields is
           a form everybody submits from the keyboard. */
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
      />
      {hint && <span className="figy-field-hint">{hint}</span>}
    </label>
  );

  const price = (label: string, value: number | undefined, set: (n: number) => void) => (
    <label className="figy-field narrow" key={label}>
      <span className="figy-field-label">{label}</span>
      <input
        className="figy-input"
        value={value ?? ""}
        placeholder="0"
        inputMode="decimal"
        onChange={(e) => set(Number(e.target.value) || 0)}
        onPaste={(e) => e.stopPropagation()}
      />
    </label>
  );

  const link = (label: string, command: string, value: string) => (
    <button
      type="button"
      className="figy-settings-link"
      key={command + label}
      onClick={() => {
        onClose();
        onCommand(command);
      }}
    >
      <span className="figy-settings-link-label">{label}</span>
      <span className="figy-settings-link-value">{value}</span>
    </button>
  );

  return (
    /*
      Over the window, not over the app.

      The dialog is a child of the FigyCode window, so it moves with it,
      resizes with it, and cannot end up covering a terminal somebody is
      watching. The backdrop dims the transcript rather than hiding it:
      what you are configuring is that conversation.
    */
    <div className="figy-dialog-layer" onMouseDown={onClose}>
      <div
        className="figy-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="figy-dialog-head">
          <span className="figy-dialog-title">Settings</span>
          <button
            type="button"
            className="figy-iconbtn"
            onClick={onClose}
            title="Close"
            aria-label="Close settings"
          >
            <X size={12} />
          </button>
        </header>

        <div className="figy-dialog-body">
          <div className="figy-dialog-section">
            <div className="figy-dialog-section-head">Model</div>
            <div className="figy-dialog-note">
              Anything that speaks the OpenAI chat API.
            </div>
            <div className="figy-form">
              {field(
                "Base URL",
                draft.baseUrl,
                (baseUrl) => setDraft({ ...draft, baseUrl }),
                "https://api.openai.com/v1",
                "The part before /chat/completions"
              )}
              {field("Model", draft.model, (model) => setDraft({ ...draft, model }), "gpt-5.6")}
              {field(
                "API key",
                key,
                setKey,
                hasKey ? "•••••••• — stored. Type to replace it." : "sk-…",
                hasKey ? "A key is stored for this machine." : "Required before the first message."
              )}
            </div>
          </div>

          <div className="figy-dialog-section">
            <div className="figy-dialog-section-head">Web search</div>
            <div className="figy-form">
              {field(
                "Exa API key",
                exa,
                setExa,
                hasExaKey ? "•••••••• — stored. Type to replace it." : "optional",
                hasExaKey
                  ? "search_web and fetch_url are available."
                  : "Without one the agent has no web search. Everything else works."
              )}
            </div>
          </div>

          <div className="figy-dialog-section">
            <div className="figy-dialog-section-head">Limits</div>
            <div className="figy-form">
              <div className="figy-field-row">
                <div className="figy-field-group">
                  {price("context window", draft.contextWindow, (n) =>
                    setDraft({ ...draft, contextWindow: n })
                  )}
                  {price("budget, $", draft.budgetUsd, (n) =>
                    setDraft({ ...draft, budgetUsd: n })
                  )}
                </div>
                <span className="figy-field-hint">
                  The window in tokens — nothing on the wire reports it, and without it
                  nothing can say how close a conversation is to its limit. The budget
                  stops a session that is looping rather than working.
                </span>
              </div>

              <div className="figy-field-row">
                <span className="figy-field-label">Price per million tokens</span>
                <div className="figy-field-group">
                  {price("input", draft.inputPrice, (n) => setDraft({ ...draft, inputPrice: n }))}
                  {price("cached", draft.cachedPrice, (n) =>
                    setDraft({ ...draft, cachedPrice: n })
                  )}
                  {price("output", draft.outputPrice, (n) =>
                    setDraft({ ...draft, outputPrice: n })
                  )}
                </div>
                <span className="figy-field-hint">
                  What the status bar will claim a turn cost. Nobody is charged from here.
                </span>
              </div>
            </div>
          </div>

          {/*
            The mode, as three rows rather than a thing you cycle.

            shift+tab stays and is faster once you know it. It is also
            invisible, and this is the one setting where not knowing
            which one you are in is actively dangerous.
          */}
          <div className="figy-dialog-section">
            <div className="figy-dialog-section-head">Permission</div>
            {MODES.map((one) => (
              <button
                type="button"
                key={one}
                role="menuitemradio"
                aria-checked={one === mode}
                className={`figy-settings-row ${one === mode ? "on" : ""}`}
                onClick={() => onMode(one)}
              >
                <span className="figy-settings-icon">
                  {one === mode ? <Check size={12} /> : null}
                </span>
                <span className="figy-settings-label">{MODE_LABEL[one]}</span>
                <span className="figy-settings-value dim">{MODE_NOTE[one]}</span>
              </button>
            ))}
          </div>

          {/*
            A view of the session is not a setting. These open in the
            body, where there is room to read them.
          */}
          <div className="figy-dialog-section">
            <div className="figy-dialog-section-head">Also</div>
            {link("Tools and what they cost", "/tools", rules ? `${rules} is read too` : "no FIGY.md")}
            {link(
              "Earlier conversations",
              "/resume",
              earlier > 0 ? `${earlier} kept in this folder` : "none yet"
            )}
            {link("Tokens and spend", "/usage", "this session")}
            {link("New conversation", "/clear", "keeps the folder and the model")}
          </div>
        </div>

        <footer className="figy-dialog-foot">
          <button type="button" className="figy-button primary" onClick={save} disabled={!ready}>
            Save
          </button>
          <span className="figy-field-hint">
            {/* Named every time: a secret in a place nobody mentioned is
                worse than one in a place everybody knows about. */}
            {path ? (
              <>
                Written, in plain text, to <code>{path}</code>
              </>
            ) : (
              "↵ saves."
            )}
          </span>
        </footer>
      </div>
    </div>
  );
}
