/**
 * Keeping a piece of a response as a variable.
 *
 * The thing people do a hundred times a day: send the login request, find the
 * token in what came back, and put it where the next request can reach it.
 * Done by hand that is select, copy, open the environment tab, find the row,
 * paste, save — six steps, and the fifth one is where the token ends up in
 * the wrong environment.
 *
 * The value is shown but not editable. It is what was selected; if that was
 * the wrong thing the answer is to select again, not to correct it here where
 * a stray keystroke would quietly save something that was never in the
 * response.
 *
 * **It writes the current value, never the initial one.** A token out of a
 * response belongs to this machine and this hour. The initial value is what
 * exports with the collection and what syncing sends to everybody else, and a
 * bearer token has no business in either.
 *
 * The name field offers the names already there, because the common case is
 * not a new variable — it is `access_token` again, an hour later. Typing it
 * out by hand is how you end up with `access_token` and `acess_token` and a
 * request that reads the one nothing is writing to.
 */

import { useMemo, useState } from "react";
import { Variable as VariableIcon } from "lucide-react";
import { Select } from "./Select";
import { SuggestInput } from "./SuggestInput";

export type VariableTarget = "environment" | "globals";

/** A variable that is already there, and what it holds now. */
export interface ExistingVariable {
  name: string;
  value: string;
}

interface SaveVariableDialogProps {
  value: string;
  /** The active environment's name, or null when none is selected. */
  environmentName: string | null;
  /** What each target already has, so a name can be picked rather than typed
   * and replacing one is as easy as adding one. */
  existing: Record<VariableTarget, ExistingVariable[]>;
  onSave: (name: string, target: VariableTarget) => void;
  onClose: () => void;
}

/** Long values are shown cut: a JWT is three hundred characters and would
 * otherwise be the whole dialog. */
const PREVIEW = 300;

/** The tail end of a value, for the line saying what is being replaced. */
function shorten(value: string): string {
  return value.length > 48 ? `${value.slice(0, 48)}…` : value;
}

export function SaveVariableDialog({
  value,
  environmentName,
  existing,
  onSave,
  onClose,
}: SaveVariableDialogProps) {
  // With no environment selected there is only one place it can go, and the
  // picker says so rather than offering a choice that does not exist.
  const [target, setTarget] = useState<VariableTarget>(
    environmentName ? "environment" : "globals"
  );
  const [name, setName] = useState("");

  const trimmed = name.trim();

  /** The one this would overwrite, when there is one. */
  const replacing = useMemo(
    () => existing[target].find((entry) => entry.name === trimmed) ?? null,
    [existing, target, trimmed]
  );

  /*
    The names already in this target, narrowed by what has been typed.

    Substring rather than prefix: somebody reaching for `stagingAccessToken`
    types `token`, and a prefix match would offer nothing at the moment the
    list is most wanted.
  */
  const suggestions = useMemo(() => {
    const needle = trimmed.toLowerCase();
    return existing[target]
      .filter((entry) => needle === "" || entry.name.toLowerCase().includes(needle))
      .map((entry) => ({
        value: entry.name,
        hint: entry.value === "" ? "set to nothing" : entry.value,
      }));
  }, [existing, target, trimmed]);
  const save = () => {
    if (trimmed === "") return;
    onSave(trimmed, target);
    onClose();
  };

  return (
    <div
      className="api-dialog-scrim"
      onClick={onClose}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        className="api-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Save as a variable"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          } else if (event.key === "Enter") {
            event.preventDefault();
            save();
          }
          // Nothing below sees these: ⌘S and the tab shortcuts would
          // otherwise fire while a name is being typed.
          event.stopPropagation();
        }}
      >
        <div className="api-dialog-head">
          <VariableIcon size={13} className="shrink-0 text-ft-accent" />
          <span className="api-dialog-title">Save as a variable</span>
        </div>

        <div className="api-dialog-body">
          <label className="api-dialog-row">
            <span className="api-dialog-label">Name</span>
            {/* Suggested, not restricted: a name that is not there yet is
                the other half of what this dialog is for. */}
            <SuggestInput
              className="api-url flex-1 min-w-0"
              value={name}
              placeholder="access_token"
              ariaLabel="Variable name"
              title={target === "globals" ? "GLOBALS" : "ENVIRONMENT"}
              suggestions={suggestions}
              onChange={setName}
            />
          </label>

          <label className="api-dialog-row">
            <span className="api-dialog-label">Save in</span>
            <Select
              className="flex-1"
              value={target}
              options={[
                {
                  value: "environment" as VariableTarget,
                  label: environmentName ?? "No environment selected",
                  hint: environmentName ? "This environment only" : undefined,
                },
                {
                  value: "globals" as VariableTarget,
                  label: "Globals",
                  hint: "Whichever environment is in use",
                },
              ].filter((option) => option.value !== "environment" || environmentName !== null)}
              onChange={setTarget}
              ariaLabel="Where to save it"
            />
          </label>

          <div className="api-dialog-row items-start">
            <span className="api-dialog-label">Value</span>
            <div className="api-dialog-value">
              {value.slice(0, PREVIEW)}
              {value.length > PREVIEW && (
                <span className="api-dialog-more"> … {value.length} characters</span>
              )}
            </div>
          </div>

          {/* What is about to happen, said before it happens. Overwriting a
              token nobody meant to overwrite is a quiet failure that costs an
              afternoon. */}
          <p className="api-dialog-note">
            {replacing ? (
              <>
                Replaces what <b>{replacing.name}</b> holds now:{" "}
                <span className="api-dialog-was">
                  {replacing.value === "" ? "nothing" : shorten(replacing.value)}
                </span>
                .{" "}
              </>
            ) : trimmed !== "" ? (
              <>
                Adds <b>{trimmed}</b>.{" "}
              </>
            ) : null}
            Saved as the <b>current value</b>, which stays on this machine — it is
            never exported with the collection and never synced.
          </p>
        </div>

        <div className="api-dialog-foot">
          <button className="api-button-quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="api-button" disabled={trimmed === ""} onClick={save}>
            {replacing ? "Replace" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
