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
 * ## Why tabs, and these tabs
 *
 * One scrolling form was fine while there was one model. Models are a
 * list now — several providers, several models, a price plan each — and
 * a list plus three unrelated sections in one scroll is a form where the
 * thing you came to change is never on screen.
 *
 * So: **Models** is the list and its editor. **Web search** is the Exa
 * key, which is a different provider with a different bill and belongs
 * nowhere near the model that is answering. **Behaviour** is what the
 * agent may do and what it may spend — the two settings that are about
 * the session rather than about who is serving it. **Session** is the
 * views: tokens, tools, earlier conversations. Those are not settings at
 * all, and they open in the body where there is room to read them.
 *
 * ## One draft, one save
 *
 * Every tab edits one draft and the Save button writes all of it. The
 * alternative — a save per section — is four ways for the file and the
 * screen to disagree, and the backend takes the whole shape anyway so it
 * would have bought nothing.
 */

import { useState } from "react";
import { Check, Cpu, Globe, History, Plus, Sliders, Trash2, X } from "lucide-react";
import { MODE_LABEL, formatCost, type PermissionMode } from "../../services/figycode-blocks";
import type { AgentSettings, AgentStatus, ProviderModel } from "../../services/figycode-agent";

/* ─── Tabs ────────────────────────────────────────────────────────────────── */

type Tab = "models" | "web" | "behaviour" | "session";

const TABS: { id: Tab; label: string; icon: typeof Cpu }[] = [
  { id: "models", label: "Models", icon: Cpu },
  { id: "web", label: "Web search", icon: Globe },
  { id: "behaviour", label: "Behaviour", icon: Sliders },
  { id: "session", label: "Session", icon: History },
];

/** The three modes, in the order shift+tab cycles them. */
const MODES: PermissionMode[] = ["ask", "acceptEdits", "plan"];

const MODE_NOTE: Record<PermissionMode, string> = {
  ask: "Edits and commands are asked about",
  acceptEdits: "Edits land; commands and the network still ask",
  plan: "Reads and thinks, changes nothing",
};

/**
 * A new model's id.
 *
 * Minted here because the window is what creates the row, and it has to
 * be stable from that moment: the `active` pointer is an id, and a row
 * keyed by its position would change identity the first time somebody
 * deleted the one above it.
 */
function mintId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** What is shown on a collapsed row, under the name. */
function summarise(model: ProviderModel): string {
  const host = (() => {
    try {
      return new URL(model.baseUrl).host;
    } catch {
      return model.baseUrl.replace(/^https?:\/\//, "").split("/")[0];
    }
  })();
  const price =
    model.inputPrice || model.outputPrice
      ? `${formatCost(model.inputPrice ?? 0)} in · ${formatCost(model.outputPrice ?? 0)} out`
      : "no prices set";
  return [host || "no address", model.model || "no model name", price]
    .filter(Boolean)
    .join(" · ");
}

/* ─── The dialog ──────────────────────────────────────────────────────────── */

export function SettingsDialog({
  status,
  mode,
  earlier,
  rules,
  onMode,
  onSave,
  onCommand,
  onClose,
}: {
  /** What the backend says is stored. The only source there is. */
  status: AgentStatus;
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
  const [tab, setTab] = useState<Tab>("models");
  const [models, setModels] = useState<ProviderModel[]>(status.models);
  const [active, setActive] = useState<string | null>(status.active);
  const [budget, setBudget] = useState<number | undefined>(status.budgetUsd);
  const [exa, setExa] = useState("");
  /**
   * Which row is open for editing. A new one opens itself.
   *
   * With exactly one model, that one: there is nothing to choose
   * between, so a collapsed row would be a click in the way of the only
   * thing anybody opened this to change.
   */
  const [editing, setEditing] = useState<string | null>(
    status.models.length === 1 ? status.models[0].id : null
  );

  const change = (id: string, patch: Partial<ProviderModel>) =>
    setModels((list) => list.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  const add = () => {
    const one: ProviderModel = {
      id: mintId(),
      label: "",
      baseUrl: "https://api.openai.com/v1",
      model: "",
    };
    setModels((list) => [...list, one]);
    setEditing(one.id);
    // The first model anybody adds is the one they want to use.
    if (!active) setActive(one.id);
  };

  const remove = (id: string) => {
    setModels((list) => list.filter((m) => m.id !== id));
    if (active === id) setActive(null);
    if (editing === id) setEditing(null);
  };

  const save = () =>
    onSave({
      models,
      active,
      budgetUsd: budget,
      exaKey: exa.trim() || undefined,
    });

  /* ─── Small field helpers ──────────────────────────────────────────────── */

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
        /* Enter saves: a form everybody submits from the keyboard. */
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

  const number = (
    label: string,
    value: number | undefined,
    set: (n: number | undefined) => void,
    placeholder = "0"
  ) => (
    <label className="figy-field narrow" key={label}>
      <span className="figy-field-label">{label}</span>
      <input
        className="figy-input"
        value={value ?? ""}
        placeholder={placeholder}
        inputMode="decimal"
        onChange={(e) => {
          const text = e.target.value.trim();
          set(text === "" ? undefined : Number(text) || 0);
        }}
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

  /* ─── Panels ───────────────────────────────────────────────────────────── */

  const modelsPanel = (
    <>
      <div className="figy-dialog-note">
        Anything that speaks the OpenAI chat API. Add as many as you like — the one with
        the dot is the one that answers, and each carries its own prices, so the status
        bar is right whichever is in use.
      </div>

      {models.length === 0 && (
        <div className="figy-empty">
          No models yet. Add one and FigyCode can answer — base URL, model name and a
          key is the whole of it.
        </div>
      )}

      <div className="figy-models">
        {models.map((one) => {
          const open = editing === one.id;
          const chosen = active === one.id;
          return (
            <div className={`figy-model ${open ? "open" : ""}`} key={one.id}>
              <div className="figy-model-head">
                {/*
                  The dot is the choice and the row is the editor, kept
                  apart: picking which model answers is the thing done
                  most often here, and it should not mean opening a form
                  and finding somewhere to click out of it.
                */}
                <button
                  type="button"
                  className={`figy-model-pick ${chosen ? "on" : ""}`}
                  onClick={() => setActive(one.id)}
                  title={chosen ? "This model answers" : "Use this model"}
                  aria-pressed={chosen}
                >
                  <span className="figy-model-dot" />
                </button>

                <button
                  type="button"
                  className="figy-model-main"
                  onClick={() => setEditing(open ? null : one.id)}
                  aria-expanded={open}
                >
                  <span className="figy-model-name">
                    {one.label.trim() || one.model || "Untitled model"}
                  </span>
                  <span className="figy-model-sub">{summarise(one)}</span>
                </button>

                <span className={`figy-model-key ${one.hasKey ? "" : "missing"}`}>
                  {one.hasKey ? "key stored" : "no key"}
                </span>

                <button
                  type="button"
                  className="figy-iconbtn"
                  onClick={() => remove(one.id)}
                  title="Remove this model"
                  aria-label={`Remove ${one.label || one.model}`}
                >
                  <Trash2 size={11} />
                </button>
              </div>

              {open && (
                <div className="figy-model-body figy-form">
                  {field("Name", one.label, (label) => change(one.id, { label }), one.model || "optional", "What to call it here")}
                  {field(
                    "Base URL",
                    one.baseUrl,
                    (baseUrl) => change(one.id, { baseUrl }),
                    "https://api.openai.com/v1",
                    "The part before /chat/completions"
                  )}
                  {field("Model", one.model, (model) => change(one.id, { model }), "gpt-5.6")}
                  {field(
                    "API key",
                    one.apiKey ?? "",
                    (apiKey) => change(one.id, { apiKey }),
                    one.hasKey ? "•••••••• — stored. Type to replace it." : "sk-…",
                    one.hasKey
                      ? "A key is stored for this model."
                      : "Required before this model can be used."
                  )}

                  <div className="figy-field-row">
                    <span className="figy-field-label">Price per million tokens</span>
                    <div className="figy-field-group">
                      {number("input", one.inputPrice, (n) => change(one.id, { inputPrice: n }))}
                      {number("cached", one.cachedPrice, (n) => change(one.id, { cachedPrice: n }))}
                      {number("output", one.outputPrice, (n) => change(one.id, { outputPrice: n }))}
                    </div>
                    <span className="figy-field-hint">
                      What the status bar will claim a turn cost. Nobody is charged from
                      here — and cached input is usually a tenth of input, which is the
                      whole reason the hit rate is worth watching.
                    </span>
                  </div>

                  <div className="figy-field-row">
                    <span className="figy-field-label">Window and temperature</span>
                    <div className="figy-field-group">
                      {number(
                        "context, tokens",
                        one.contextWindow,
                        (n) => change(one.id, { contextWindow: n }),
                        "200000"
                      )}
                      {number(
                        "temperature",
                        one.temperature,
                        (n) => change(one.id, { temperature: n }),
                        "default"
                      )}
                    </div>
                    <span className="figy-field-hint">
                      Nothing on the wire reports the window, so without it nothing can
                      say how close a conversation is to its limit — or when to compact.
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button type="button" className="figy-add-model" onClick={add}>
        <Plus size={12} />
        Add a model
      </button>
    </>
  );

  const webPanel = (
    <>
      <div className="figy-dialog-note">
        Exa backs <code>search_web</code> and <code>fetch_url</code>. Without a key the
        agent has no web tools at all — which is a configuration rather than a failure,
        and the tools say so if the model reaches for them.
      </div>
      <div className="figy-form">
        {field(
          "Exa API key",
          exa,
          setExa,
          status.hasExaKey ? "•••••••• — stored. Type to replace it." : "optional",
          status.hasExaKey
            ? "search_web and fetch_url are available."
            : "Everything else works without one."
        )}
      </div>
      <div className="figy-dialog-note muted">
        Exa charges per call and reports what each one cost. That lands in the ledger as
        a column of its own, so a search-heavy session does not read as an expensive
        model — see Session → Tokens and spend.
      </div>
    </>
  );

  const behaviourPanel = (
    <>
      <div className="figy-dialog-section first">
        <div className="figy-dialog-section-head">Permission</div>
        {/*
          The mode as three rows rather than a thing you cycle.
          shift+tab stays and is faster once you know it; it is also
          invisible, and this is the one setting where not knowing which
          one you are in is actively dangerous.
        */}
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

      <div className="figy-dialog-section">
        <div className="figy-dialog-section-head">Budget</div>
        <div className="figy-form">
          <div className="figy-field-row">
            <div className="figy-field-group">
              {number("dollars per conversation", budget, setBudget, "none")}
            </div>
            <span className="figy-field-hint">
              Checked before each request rather than reported after one: the point of a
              ceiling is not to record the overspend but to not make it. An agent looping
              on a broken test spends real money fast.
            </span>
          </div>
        </div>
      </div>
    </>
  );

  const sessionPanel = (
    <>
      <div className="figy-dialog-note">
        Not settings — views of what this window has done. They open behind this dialog,
        where there is room to read them.
      </div>
      {link("Tools and what they cost", "/tools", rules ? `${rules} is read too` : "no FIGY.md")}
      {link(
        "Earlier conversations",
        "/resume",
        earlier > 0 ? `${earlier} kept in this folder` : "none yet"
      )}
      {link("Tokens and spend", "/usage", "this session")}
      {link("New conversation", "/clear", "keeps the folder and the model")}
    </>
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
        className="figy-dialog wide"
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

        <div className="figy-dialog-split">
          <nav className="figy-tabs" role="tablist" aria-label="Settings sections">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={`figy-tab ${tab === id ? "on" : ""}`}
                onClick={() => setTab(id)}
              >
                <Icon size={12} className="figy-tab-icon" />
                <span>{label}</span>
                {id === "models" && models.length > 0 && (
                  <span className="figy-tab-count">{models.length}</span>
                )}
              </button>
            ))}
          </nav>

          <div className="figy-dialog-body" role="tabpanel">
            {tab === "models" && modelsPanel}
            {tab === "web" && webPanel}
            {tab === "behaviour" && behaviourPanel}
            {tab === "session" && sessionPanel}
          </div>
        </div>

        <footer className="figy-dialog-foot">
          <button type="button" className="figy-button primary" onClick={save}>
            Save
          </button>
          <span className="figy-field-hint">
            {/* Named every time: a secret in a place nobody mentioned is
                worse than one in a place everybody knows about. */}
            {status.path ? (
              <>
                Written, in plain text, to <code>{status.path}</code>
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
