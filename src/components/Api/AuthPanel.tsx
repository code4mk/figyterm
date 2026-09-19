/**
 * The Auth tab.
 *
 * The default is **Inherit**, and it says what it would inherit — the one piece
 * of information that makes a chain understandable from inside it. Without it,
 * "why is this request authenticated?" means opening the folder, then the
 * collection, then guessing.
 *
 * Values may be `{{templates}}`, and usually are; they are resolved at send
 * time like everything else, so a token lives in an environment rather than in
 * fifty requests.
 */

import { DraftAuth } from "../../types/api";
import {
  AUTH_FIELDS,
  AUTH_LABELS,
  AuthType,
  ParsedAuth,
  SUPPORTED_AUTH,
} from "../../services/api/auth";
import { Scope } from "../../services/api/template";
import { VariableInput } from "./VariableInput";
import { Select } from "./Select";

interface AuthPanelProps {
  auth: DraftAuth;
  onChange: (auth: DraftAuth) => void;
  /** What this request would use if it inherited — the chain's answer. */
  inherited: ParsedAuth;
  /** Where that answer came from, for the sentence under the selector. */
  inheritedFrom: string | null;
  /** The chain in play, so a `{{token}}` here is coloured and completed. */
  scopes: Scope[];
}

export function AuthPanel({
  auth,
  onChange,
  inherited,
  inheritedFrom,
  scopes,
}: AuthPanelProps) {
  const type = auth.type;
  const known = SUPPORTED_AUTH.includes(type as AuthType);
  const fields = AUTH_FIELDS[type] ?? [];

  const set = (key: string, value: string) =>
    onChange({ ...auth, params: { ...auth.params, [key]: value } });

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="flex items-center gap-2 px-3 h-7 shrink-0 border-b border-ft-border-subtle text-[11px] text-ft-text-muted">
        <Select
          className="w-[150px]"
          value={known ? (type as AuthType) : (SUPPORTED_AUTH[0] as AuthType)}
          options={SUPPORTED_AUTH.map((entry) => ({
            value: entry,
            label: AUTH_LABELS[entry],
          }))}
          // A type this window does not offer, out of an imported document.
          // Shown as it was written rather than silently read as the first
          // one in the list.
          fallbackLabel={known ? undefined : type}
          onChange={(next) => {
            // The parameters are kept when switching away and back, so a token
            // typed once is not lost to a mis-click on the selector.
            onChange({ ...auth, type: next });
          }}
          ariaLabel="Authentication"
        />

        {type === "inherit" && (
          <span className="truncate">
            {inherited.type === "noauth"
              ? "Nothing above sets any, so this request sends none."
              : `Using ${AUTH_LABELS[inherited.type as AuthType] ?? inherited.type}${
                  inheritedFrom ? ` from ${inheritedFrom}` : ""
                }.`}
          </span>
        )}
      </div>

      {!known && (
        <div className="px-3 py-3 text-[11px] text-ft-text-muted">
          This request carries <span className="text-ft-text">{type}</span>{" "}
          authentication. It is kept with the request and written back out on
          export, but cannot be applied to a send yet — the response pane says so
          rather than sending an unauthenticated request that looks like it
          should have worked.
        </div>
      )}

      {fields.length > 0 && (
        <div className="flex flex-col gap-2 px-3 py-3">
          {fields.map((field) =>
            field.key === "in" ? (
              <label key={field.key} className="flex items-center gap-2 text-[11px]">
                <span className="w-20 shrink-0 text-ft-text-muted">{field.label}</span>
                <Select
                  className="w-[140px]"
                  value={auth.params.in ?? "header"}
                  options={[
                    { value: "header", label: "Header", hint: "Sent as a header" },
                    { value: "query", label: "Query parameter", hint: "Appended to the URL" },
                  ]}
                  onChange={(next) => set("in", next)}
                  ariaLabel="Where the key goes"
                />
              </label>
            ) : (
              <label key={field.key} className="flex items-center gap-2 text-[11px]">
                <span className="w-20 shrink-0 text-ft-text-muted">{field.label}</span>
                {/* Not a password field: the value is nearly always
                    `{{token}}`, and hiding a variable name helps nobody. What
                    must not leak is the *stored* value, which is a sync
                    question answered in that phase. */}
                <VariableInput
                  className="api-url flex-1 min-w-0"
                  value={auth.params[field.key] ?? ""}
                  scopes={scopes}
                  placeholder={field.secret ? "{{token}}" : ""}
                  onChange={(value) => set(field.key, value)}
                  ariaLabel={field.label}
                />
              </label>
            )
          )}
        </div>
      )}

      {type === "noauth" && (
        <div className="px-3 py-3 text-[11px] text-ft-text-muted">
          This request sends no credentials, and does not inherit any. That is
          different from leaving it on Inherit, which would use whatever the
          folder or collection sets.
        </div>
      )}
    </div>
  );
}
