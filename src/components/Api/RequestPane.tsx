/**
 * The left half: what is about to be sent.
 *
 * Params, authorization, headers, body, scripts, settings, and the request
 * written out as code — in that order, which is the order the questions come
 * in: where am I sending it, am I allowed to, what am I telling it, what am I
 * giving it.
 */

import { DraftAuth, HeaderRow, RequestBody, RequestDraft, RequestSettings } from "../../types/api";
import { CodeTarget } from "../../services/api/interchange/codegen";
import { ParsedAuth } from "../../services/api/auth";
import { CollectedScript } from "../../services/api/scripts/events";
import { Scope } from "../../services/api/template";
import { activeCount as activeParams, QueryRow } from "../../services/api/params";
import { HeaderTable } from "./HeaderTable";
import { ParamsPanel } from "./ParamsPanel";
import { BodyPanel } from "./BodyPanel";
import { CodePanel } from "./CodePanel";
import { AuthPanel } from "./AuthPanel";
import { ScriptsPanel } from "./ScriptsPanel";
import { SettingsPanel } from "./SettingsPanel";

export type RequestTab =
  | "params"
  | "auth"
  | "headers"
  | "body"
  | "scripts"
  | "settings"
  | "code";

interface RequestPaneProps {
  tab: RequestTab;
  onTabChange: (tab: RequestTab) => void;
  headers: HeaderRow[];
  onHeadersChange: (rows: HeaderRow[]) => void;
  /** The query, as a table. Rewriting these rewrites the URL — there is one
   * copy of the query and it is the one in the bar. */
  params: QueryRow[];
  onParamsChange: (rows: QueryRow[]) => void;
  body: RequestBody;
  onBodyChange: (body: RequestBody) => void;
  /** The whole draft, for the Code tab — which is about the request as a
   * whole rather than any one part of it. */
  draft: RequestDraft;
  codeTarget: CodeTarget;
  onCodeTargetChange: (target: CodeTarget) => void;
  onAuthChange: (auth: DraftAuth) => void;
  onSettingsChange: (settings: RequestSettings) => void;
  onScriptsChange: (scripts: { prerequest: string; test: string }) => void;
  /** What runs around this request that is not its own, outermost first. */
  inheritedBefore: CollectedScript[];
  inheritedAfter: CollectedScript[];
  /** Whether this request has a row to keep a script in. */
  savable: boolean;
  /** What this request would use if its auth stayed on Inherit. */
  inherited: ParsedAuth;
  inheritedFrom: string | null;
  /** The chain in play, for the fields that take `{{variables}}`. */
  scopes: Scope[];
}

/** How many headers the tab badge counts: the ones that will actually be sent. */
function activeCount(headers: HeaderRow[]): number {
  return headers.filter((header) => header.enabled && header.name.trim() !== "").length;
}

export function RequestPane({
  tab,
  onTabChange,
  headers,
  onHeadersChange,
  params,
  onParamsChange,
  body,
  onBodyChange,
  draft,
  codeTarget,
  onCodeTargetChange,
  onAuthChange,
  onSettingsChange,
  onScriptsChange,
  inheritedBefore,
  inheritedAfter,
  savable,
  inherited,
  inheritedFrom,
  scopes,
}: RequestPaneProps) {
  const headerCount = activeCount(headers);
  const paramCount = activeParams(params);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="api-tabstrip api-tabstrip-main flex items-center gap-0.5 px-2 h-8 border-b border-ft-border shrink-0">
        <button
          className={`api-tab api-tab-main ${tab === "params" ? "selected" : ""}`}
          onClick={() => onTabChange("params")}
          title="The query string, as a table"
        >
          Params
          {paramCount > 0 && <span className="api-tab-badge">{paramCount}</span>}
        </button>
        <button
          className={`api-tab api-tab-main ${tab === "auth" ? "selected" : ""}`}
          onClick={() => onTabChange("auth")}
        >
          Authorization
          {draft.auth.type !== "inherit" && draft.auth.type !== "noauth" && (
            <span className="api-tab-dot" />
          )}
        </button>
        <button
          className={`api-tab api-tab-main ${tab === "headers" ? "selected" : ""}`}
          onClick={() => onTabChange("headers")}
        >
          Headers
          {headerCount > 0 && <span className="api-tab-badge">{headerCount}</span>}
        </button>
        <button
          className={`api-tab api-tab-main ${tab === "body" ? "selected" : ""}`}
          onClick={() => onTabChange("body")}
        >
          Body
          {body.mode !== "none" && <span className="api-tab-dot" />}
        </button>
        <button
          className={`api-tab api-tab-main ${tab === "scripts" ? "selected" : ""}`}
          onClick={() => onTabChange("scripts")}
          title="What runs before this request and after its response"
        >
          Scripts
          {/* Inherited scripts count too: they run, and a request that is
              quietly having a header set for it should say so somewhere. */}
          {(draft.scripts.prerequest.trim() !== "" ||
            draft.scripts.test.trim() !== "" ||
            inheritedBefore.length > 0 ||
            inheritedAfter.length > 0) && <span className="api-tab-dot" />}
        </button>
        <button
          className={`api-tab api-tab-main ${tab === "settings" ? "selected" : ""}`}
          onClick={() => onTabChange("settings")}
        >
          Settings
          {Object.keys(draft.settings).length > 0 && <span className="api-tab-dot" />}
        </button>
        <button
          className={`api-tab api-tab-main ${tab === "code" ? "selected" : ""}`}
          onClick={() => onTabChange("code")}
          title="This request, as code"
        >
          Code
        </button>
      </div>

      {tab === "code" ? (
        <CodePanel draft={draft} target={codeTarget} onTargetChange={onCodeTargetChange} />
      ) : tab === "auth" ? (
        <AuthPanel
          auth={draft.auth}
          onChange={onAuthChange}
          inherited={inherited}
          inheritedFrom={inheritedFrom}
          scopes={scopes}
        />
      ) : tab === "scripts" ? (
        <ScriptsPanel
          scripts={draft.scripts}
          onChange={onScriptsChange}
          inheritedBefore={inheritedBefore}
          inheritedAfter={inheritedAfter}
          savable={savable}
        />
      ) : tab === "settings" ? (
        <SettingsPanel settings={draft.settings} onChange={onSettingsChange} />
      ) : tab === "params" ? (
        <ParamsPanel rows={params} onChange={onParamsChange} scopes={scopes} />
      ) : tab === "headers" ? (
        <div className="flex-1 min-h-0 overflow-auto">
          <HeaderTable rows={headers} onChange={onHeadersChange} scopes={scopes} />
        </div>
      ) : (
        <BodyPanel body={body} onChange={onBodyChange} scopes={scopes} />
      )}
    </div>
  );
}
