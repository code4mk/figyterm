/**
 * The settings menu, from the footer.
 *
 * Everything in here was already reachable by typing a slash command,
 * which is fine for the second week and useless for the first: nobody
 * discovers `/model` by looking at a window, and the one thing a new
 * window needs is the screen that makes it work at all. So the footer
 * says which model is set — or that none is — and opening it lists what
 * can be changed.
 *
 * It is a menu over the commands rather than a second settings
 * implementation. Every row either runs a command the composer could
 * have run or sets the permission mode, and the screens behind them are
 * the same ones `/model` and `/usage` open. A menu that owned its own
 * copy of the fields would be a second place for them to disagree.
 */

import { useEffect, useRef } from "react";
import {
  Check,
  Cpu,
  Globe,
  History,
  MessageSquarePlus,
  Settings2,
  Wrench,
} from "lucide-react";
import { MODE_LABEL, type PermissionMode } from "../../services/figycode-blocks";

/** The three modes, in the order shift+tab cycles them. */
const MODES: PermissionMode[] = ["ask", "acceptEdits", "plan"];

const MODE_NOTE: Record<PermissionMode, string> = {
  ask: "Edits and commands are asked about",
  acceptEdits: "Edits land; commands and the network still ask",
  plan: "Reads and thinks, changes nothing",
};

export function SettingsMenu({
  model,
  configured,
  hasExaKey,
  rules,
  earlier,
  mode,
  onMode,
  onCommand,
  onClose,
}: {
  model: string;
  configured: boolean;
  hasExaKey: boolean;
  /** The project's own rules file, when it has one. */
  rules: string | null;
  /** How many conversations this folder has had. */
  earlier: number;
  mode: PermissionMode;
  onMode: (mode: PermissionMode) => void;
  onCommand: (name: string) => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement | null>(null);

  /*
    A click anywhere else closes it.

    `mousedown` rather than `click`, so the menu is gone before whatever
    was clicked reacts — a menu that closes on the way back up leaves a
    frame where the thing underneath has already been pressed.
  */
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node)) onClose();
    };
    // Next tick: the click that opened it is still on its way up.
    const timer = window.setTimeout(() => document.addEventListener("mousedown", away), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", away);
    };
  }, [onClose]);

  const run = (command: string) => {
    onClose();
    onCommand(command);
  };

  return (
    <div className="figy-settings" ref={menu} role="menu" aria-label="Settings">
      <div className="figy-settings-group">
        <div className="figy-settings-head">Configuration</div>

        <button type="button" className="figy-settings-row" role="menuitem" onClick={() => run("/model")}>
          <Cpu size={12} className="figy-settings-icon" />
          <span className="figy-settings-label">Model and provider</span>
          <span className={`figy-settings-value ${configured ? "" : "warn"}`}>
            {configured ? model : "not set up"}
          </span>
        </button>

        {/*
          The same screen, named by what it is for.

          Both keys live in one form, but "where do I put my Exa key" is
          not a question anybody answers with "the model screen", and a
          menu that only said "Model" would hide the web tools from the
          person looking for them.
        */}
        <button type="button" className="figy-settings-row" role="menuitem" onClick={() => run("/model")}>
          <Globe size={12} className="figy-settings-icon" />
          <span className="figy-settings-label">Web search key</span>
          <span className={`figy-settings-value ${hasExaKey ? "" : "dim"}`}>
            {hasExaKey ? "Exa, stored" : "none — no web tools"}
          </span>
        </button>

        <button type="button" className="figy-settings-row" role="menuitem" onClick={() => run("/tools")}>
          <Wrench size={12} className="figy-settings-icon" />
          <span className="figy-settings-label">Tools and what they cost</span>
          <span className="figy-settings-value dim">
            {rules ? `${rules} is read too` : "no FIGY.md"}
          </span>
        </button>
      </div>

      {/*
        The mode, as three rows rather than a thing you cycle.

        shift+tab stays and is faster once you know it. It is also
        invisible, and the mode is the one setting where not knowing
        which one you are in is actively dangerous.
      */}
      <div className="figy-settings-group">
        <div className="figy-settings-head">Permission</div>
        {MODES.map((one) => (
          <button
            type="button"
            key={one}
            role="menuitemradio"
            aria-checked={one === mode}
            className={`figy-settings-row ${one === mode ? "on" : ""}`}
            onClick={() => {
              onMode(one);
              onClose();
            }}
          >
            <span className="figy-settings-icon">
              {one === mode ? <Check size={12} /> : null}
            </span>
            <span className="figy-settings-label">{MODE_LABEL[one]}</span>
            <span className="figy-settings-value dim">{MODE_NOTE[one]}</span>
          </button>
        ))}
      </div>

      <div className="figy-settings-group">
        <div className="figy-settings-head">This folder</div>

        <button type="button" className="figy-settings-row" role="menuitem" onClick={() => run("/resume")}>
          <History size={12} className="figy-settings-icon" />
          <span className="figy-settings-label">Earlier conversations</span>
          <span className="figy-settings-value dim">
            {earlier > 0 ? `${earlier} kept` : "none yet"}
          </span>
        </button>

        <button type="button" className="figy-settings-row" role="menuitem" onClick={() => run("/clear")}>
          <MessageSquarePlus size={12} className="figy-settings-icon" />
          <span className="figy-settings-label">New conversation</span>
          <span className="figy-settings-value dim">/clear</span>
        </button>

        <button type="button" className="figy-settings-row" role="menuitem" onClick={() => run("/usage")}>
          <Settings2 size={12} className="figy-settings-icon" />
          <span className="figy-settings-label">Tokens and spend</span>
          <span className="figy-settings-value dim">/usage</span>
        </button>
      </div>
    </div>
  );
}
