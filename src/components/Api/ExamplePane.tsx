/**
 * A kept response, in the one tab examples get.
 *
 * An example is a request that was sent and what came back, and both halves
 * matter: the 422 is only documentation if you can also see what earned it.
 *
 * There is at most one of these tabs and opening another example replaces what
 * is in it — a request with six kept responses is ordinary, and a tab apiece
 * turns reading them into housekeeping. The request's own tab is untouched, so
 * a live response and a kept one can be on screen together.
 *
 * Everything but the name is read-only, and deliberately so: an example is a
 * record of something that happened, and editing the request it records would
 * make it a record of something that did not.
 */

import { useMemo, useState } from "react";
import {
  Copy,
  CornerUpLeft,
  FileJson,
  List,
  Save,
  TextQuote,
  Trash2,
  Variable as VariableIcon,
} from "lucide-react";
import { ApiExample } from "../../types/api";
import { exampleContentType, exampleRequest } from "../../services/api/example";
import {
  contentKind,
  formatBytes,
  prettyJson,
  statusTone,
  toneClass,
} from "../../services/api/format";
import { BodyViewer } from "./BodyViewer";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { useEditorStore } from "../../stores/editorStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThemeStore } from "../../stores/themeStore";

type Half = "response" | "request";

interface ExamplePaneProps {
  example: ApiExample | null;
  name: string;
  onNameChange: (name: string) => void;
  onSave: () => void;
  dirty: boolean;
  /** Opens the request this was kept against, when it is still there. */
  onOpenRequest: (() => void) | null;
  onDelete: () => void;
  /** Keeps a selected piece of the kept response as a variable. */
  onSaveVariable: (value: string) => void;
}

function Rows({ rows }: { rows: { name: string; value: string }[] }) {
  if (rows.length === 0) {
    return <div className="px-3 py-2 text-[11px] text-ft-text-muted">None.</div>;
  }
  return (
    <div className="flex flex-col text-[11px] font-mono">
      {rows.map((row, index) => (
        <div
          key={`${row.name}-${index}`}
          className="flex gap-3 px-3 py-1 border-b border-ft-border-subtle"
        >
          <span className="w-[38%] shrink-0 truncate text-ft-text-secondary">{row.name}</span>
          <span className="flex-1 break-all text-ft-text">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

export function ExamplePane({
  example,
  name,
  onNameChange,
  onSave,
  dirty,
  onOpenRequest,
  onDelete,
  onSaveVariable,
}: ExamplePaneProps) {
  const [half, setHalf] = useState<Half>("response");
  const [pretty, setPretty] = useState(true);
  /** Where the right-click landed, or null when no menu is open. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const theme = useThemeStore((s) => s.theme);
  const settings = useSettingsStore((s) => s.settings);
  const editorSettings = useEditorStore((s) => s.settings);

  const request = useMemo(
    () => (example ? exampleRequest(example, () => crypto.randomUUID()) : null),
    [example]
  );

  const body = example?.body ?? "";
  const formatted = useMemo(() => prettyJson(body), [body]);
  const shown = pretty && formatted !== null ? formatted : body;

  if (!example) {
    return (
      <div className="flex flex-1 items-center justify-center text-[11px] text-ft-text-muted">
        That example is no longer there.
      </div>
    );
  }

  const kind = contentKind(exampleContentType(example));

  /*
    The same right-click menu the live response has.

    An example *is* a response — the pane draws it with the same viewer — and
    a menu that appears on one and not the other would read as the example
    being a lesser thing rather than a kept one. Built when the menu opens, so
    the selection and the half on screen are what is true at that moment.
  */
  const menuItems = (): MenuItem[] => {
    const selected = window.getSelection()?.toString() ?? "";
    const copy = (text: string) =>
      void navigator.clipboard?.writeText(text).catch(() => undefined);

    const headers = example.headers ?? [];

    return [
      {
        label: "Copy selection",
        icon: <Copy size={12} />,
        disabled: selected === "",
        onClick: () => copy(selected),
      },
      {
        label: "Copy body",
        detail: formatBytes(body.length),
        icon: <FileJson size={12} />,
        disabled: body === "",
        onClick: () => copy(body),
      },
      {
        label: "Copy response headers",
        detail: String(headers.length),
        icon: <List size={12} />,
        disabled: headers.length === 0,
        onClick: () =>
          copy(headers.map((header) => `${header.name}: ${header.value}`).join("\n")),
      },
      {
        label: "Copy status",
        icon: <Copy size={12} />,
        disabled: example.status === null,
        onClick: () => copy(`${example.status ?? ""} ${example.statusText ?? ""}`.trim()),
      },
      { separator: true },
      {
        label: "Set as a variable…",
        icon: <VariableIcon size={12} />,
        disabled: selected === "",
        onClick: () => onSaveVariable(selected),
      },
      ...(formatted !== null && half === "response"
        ? [
            { separator: true },
            {
              label: pretty ? "Show raw" : "Show pretty",
              icon: <TextQuote size={12} />,
              onClick: () => setPretty(!pretty),
            },
          ]
        : []),
      { separator: true },
      ...(onOpenRequest
        ? [
            {
              label: "Open the request",
              icon: <CornerUpLeft size={12} />,
              onClick: onOpenRequest,
            },
          ]
        : []),
      {
        label: "Delete this example",
        icon: <Trash2 size={12} />,
        danger: true,
        onClick: onDelete,
      },
    ];
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={name || "Example"}
          items={menuItems()}
          onClose={() => setMenu(null)}
        />
      )}

      {/* The name, which is the one thing here that can be changed. */}
      <div className="flex items-center gap-2 px-2 py-2 shrink-0 border-b border-ft-border">
        <span className="api-eg shrink-0">e.g.</span>
        <input
          className="api-url flex-1 min-w-0 max-w-[340px]"
          value={name}
          spellCheck={false}
          placeholder="Example name"
          onChange={(e) => onNameChange(e.target.value)}
          aria-label="Example name"
        />

        <span
          className={`shrink-0 text-[11px] font-semibold ${
            example.status === null ? "text-ft-text-muted" : toneClass(statusTone(example.status))
          }`}
        >
          {example.status ?? "—"} {example.statusText ?? ""}
        </span>
        <span className="shrink-0 text-[10px] text-ft-text-muted">{formatBytes(body.length)}</span>

        <div className="flex-1" />

        {onOpenRequest && (
          <button
            className="api-button-quiet flex items-center gap-1.5"
            onClick={onOpenRequest}
            title="Open the request this was kept against"
          >
            <CornerUpLeft size={11} />
            Request
          </button>
        )}
        <button
          className="api-rail-action danger"
          onClick={onDelete}
          title="Delete this example"
          aria-label="Delete this example"
        >
          <Trash2 size={13} />
        </button>
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
          className={`api-tab ${half === "response" ? "selected" : ""}`}
          onClick={() => setHalf("response")}
        >
          Response
          {example.headers && example.headers.length > 0 && (
            <span className="api-tab-badge">{example.headers.length}</span>
          )}
        </button>
        <button
          className={`api-tab ${half === "request" ? "selected" : ""}`}
          onClick={() => setHalf("request")}
          title="What was sent to produce this"
        >
          Request
        </button>

        {half === "response" && formatted !== null && (
          <div className="ml-auto flex items-center gap-1">
            <button
              className={`api-tab ${pretty ? "selected" : ""}`}
              onClick={() => setPretty(true)}
            >
              Pretty
            </button>
            <button
              className={`api-tab ${pretty ? "" : "selected"}`}
              onClick={() => setPretty(false)}
            >
              Raw
            </button>
          </div>
        )}
      </div>

      {half === "response" ? (
        <div className="flex flex-1 min-h-0 flex-col">
          {example.headers && example.headers.length > 0 && (
            <details className="shrink-0 border-b border-ft-border-subtle">
              <summary className="px-3 py-1.5 text-[10px] text-ft-text-muted">
                {example.headers.length} response header
                {example.headers.length === 1 ? "" : "s"}
              </summary>
              <Rows rows={example.headers} />
            </details>
          )}

          {body === "" ? (
            <div className="px-3 py-3 text-[11px] text-ft-text-muted">
              This example kept no body.
            </div>
          ) : (
            <BodyViewer
              text={shown}
              kind={kind}
              wrap
              dark={theme === "dark"}
              fontFamily={editorSettings.fontFamily || settings.fontFamily}
              fontSize={editorSettings.fontSize || settings.fontSize}
              lineHeight={editorSettings.lineHeight}
            />
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          {!request ? (
            <div className="px-3 py-4 text-[11px] leading-relaxed text-ft-text-muted">
              This example has no record of what was sent. The format keeps the
              request beside the response, and whatever wrote this one did not —
              so the answer is here and the question is not.
            </div>
          ) : (
            <>
              <div className="flex items-baseline gap-2 px-3 py-2 border-b border-ft-border-subtle">
                <span className="api-method-chip text-ft-accent">{request.method}</span>
                <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-ft-text">
                  {request.url}
                </span>
              </div>

              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-ft-text-muted">
                Headers
              </div>
              <Rows
                rows={request.headers
                  .filter((header) => header.enabled && header.name !== "")
                  .map((header) => ({ name: header.name, value: header.value }))}
              />

              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-ft-text-muted">
                Body
              </div>
              {request.body.mode === "none" ? (
                <div className="px-3 pb-3 text-[11px] text-ft-text-muted">No body was sent.</div>
              ) : request.body.fields?.length ? (
                <Rows
                  rows={request.body.fields.map((field) => ({
                    name: field.key,
                    value: field.filePath ?? field.value,
                  }))}
                />
              ) : (
                <pre className="px-3 pb-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-ft-text">
                  {request.body.text}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
