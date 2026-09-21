/**
 * The right half: what came back, or what somebody kept.
 *
 * Four tabs, and the third is the important one. "Request" shows the message as
 * the client actually assembled it — the `Content-Length` nobody typed, the
 * `Authorization` a cross-origin redirect dropped, the URL a redirect really
 * ended at. When an API call behaves in a way the editor above cannot explain,
 * that tab is where the explanation is.
 *
 * An example is a response somebody chose to keep — the 200 that shows what the
 * shape is, the 422 that shows what a validation error looks like — and it is
 * what turns a collection from a list of URLs into documentation.
 *
 * They are shown **here, in the request's own tab**, alongside Live. One tab
 * per request, not one per example: a request with six kept responses is
 * ordinary, and a tab apiece turns reading them into housekeeping — six tabs
 * all named after the same request. The sidebar lists them under the request
 * too, and clicking one there opens this tab pointed at it.
 *
 * The pane draws an example exactly as it draws a live response, because that
 * is what it is; the strip above says which one, so the two are never confused.
 */

import { useMemo, useState } from "react";
import {
  Bookmark,
  Check,
  CircleAlert,
  Copy,
  FileJson,
  List,
  ShieldAlert,
  TextQuote,
  Variable as VariableIcon,
  WrapText,
  X as Cross,
} from "lucide-react";
import { ApiError, ApiExample, ApiResponse } from "../../types/api";
import { BodyViewer, PARSE_LIMIT } from "./BodyViewer";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { exampleRequest } from "../../services/api/example";
import { ScriptRun } from "../../stores/apiStore";
import {
  contentKind,
  formatBytes,
  formatDuration,
  headerValue,
  prettyJson,
  statusTone,
  toneClass,
} from "../../services/api/format";

export type ResponseTab = "body" | "tests" | "headers" | "request" | "timing";

interface ResponsePaneProps {
  response: ApiResponse | null;
  error: ApiError | null;
  sending: boolean;
  received: number;
  tab: ResponseTab;
  onTabChange: (tab: ResponseTab) => void;
  pretty: boolean;
  onPrettyChange: (pretty: boolean) => void;
  wrap: boolean;
  onWrapChange: (wrap: boolean) => void;
  /** The editor's own look, so a response and a file match. */
  dark: boolean;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  /** Offered when a send failed on the certificate, and only then. */
  onRetryWithoutTls: () => void;
  /**
   * Responses kept against this request, and which one is on screen.
   *
   * `viewingExample` is still honoured — a caller may point this pane at a
   * kept answer — but nothing in this window does any more: examples have a
   * tab of their own. It stays because the pane draws an example exactly as it
   * draws a live response, which is the property worth keeping.
   */
  examples: ApiExample[];
  viewingExample: string | null;
  /** Absent when there is nowhere to keep one — a request not in a collection. */
  onSaveExample: (() => void) | null;
  /** Keeps a selected piece of the response as a variable. */
  onSaveVariable: (value: string) => void;
  /** What the scripts around this send did, when there were any. */
  scripts: ScriptRun | null;
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

function Failure({ error, onRetryWithoutTls }: { error: ApiError; onRetryWithoutTls: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      {error.kind === "tls" ? (
        <ShieldAlert size={20} className="text-ft-warning" />
      ) : (
        <CircleAlert size={20} className="text-ft-error" />
      )}
      <div className="text-[12px] text-ft-text">{HEADLINE[error.kind]}</div>
      <div className="text-[11px] font-mono text-ft-text-muted break-all">{error.message}</div>
      {error.kind === "tls" && (
        <button className="api-button-quiet" onClick={onRetryWithoutTls}>
          Send again without verifying the certificate
        </button>
      )}
    </div>
  );
}

/** One line per failure kind, saying what happened rather than what failed. */
const HEADLINE: Record<ApiError["kind"], string> = {
  "invalid-request": "That request could not be built",
  connect: "Could not reach the server",
  tls: "The certificate was not accepted",
  timeout: "The server did not answer in time",
  "too-many-redirects": "The redirects went round in circles",
  cancelled: "Cancelled",
  body: "The connection dropped while the body was arriving",
  other: "The request failed",
};

/**
 * An example, shaped like a response so the pane draws it unchanged.
 *
 * The timings are zeros, and the Timing tab says why rather than showing
 * "0 ms" as though it had been measured: a stored answer was not timed, and
 * inventing a duration for it would be inventing a measurement.
 */
function asResponse(example: ApiExample): ApiResponse {
  const body = example.body ?? "";
  return {
    id: example.id,
    status: example.status ?? 0,
    statusText: example.statusText ?? "",
    httpVersion: "",
    headers: example.headers ?? [],
    body: { text: body, base64: null, bytes: body.length, truncated: false },
    timing: { totalMs: 0, waitMs: 0, downloadMs: 0 },
    finalUrl: "",
    remoteAddress: null,
    redirects: [],
    sent: { method: "", url: "", headers: [], bodyBytes: 0 },
  };
}

export function ResponsePane({
  response,
  error,
  sending,
  received,
  tab,
  onTabChange,
  pretty,
  onPrettyChange,
  wrap,
  onWrapChange,
  dark,
  fontFamily,
  fontSize,
  lineHeight,
  onRetryWithoutTls,
  examples,
  viewingExample,
  onSaveExample,
  onSaveVariable,
  scripts,
}: ResponsePaneProps) {
  const example = examples.find((entry) => entry.id === viewingExample) ?? null;
  const shown = example ? asResponse(example) : response;

  /** Where the right-click landed, or null when no menu is open. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  /**
   * The body, pretty-printed — or null when there is nothing to pretty-print.
   *
   * Memoised, and skipped entirely above the parse limit. It used to run on
   * every render: a parse and a re-serialise of the whole body each time the
   * pane drew, which on a large response is most of a second spent producing a
   * string identical to the one already on screen.
   */
  /** What the example recorded being sent, when it recorded anything. */
  const keptRequest = useMemo(
    () => (example ? exampleRequest(example, () => crypto.randomUUID()) : null),
    [example]
  );

  const text = shown?.body.text ?? null;
  const formatted = useMemo(
    () => (text === null || text.length > PARSE_LIMIT ? null : prettyJson(text)),
    [text]
  );

  /**
   * A line about the example on screen — not a list of them.
   *
   * The list used to live here, and it was a second copy of something the
   * sidebar now shows properly: every example hangs under its request, with
   * its status, where the tree already is. Two places to pick from is two
   * places to keep in step, and the one in here cost a row of the response
   * pane on every request that had ever kept an answer.
   *
   * What is left is the part only this pane can say: *you are looking at a
   * stored answer, not a live one*, and the way back. Without that, a pane
   * showing a 200 from last March is indistinguishable from one showing a 200
   * from ten seconds ago.
   */
  /**
   * No strip of examples here.
   *
   * They have a tab of their own now, and the sidebar lists them under the
   * request. A third place to pick one from would be a third place to keep in
   * step — and it cost a row of this pane on every request that had ever kept
   * an answer.
   */
  const strip = null;

  /**
   * A title, on every state including the empty one.
   *
   * The pane used to start as an unlabelled empty area below the request,
   * which reads as the window not having finished loading. A heading and a
   * border say what the space is *for* before there is anything in it — and on
   * the stacked layout, where the two panes share an edge, the border is also
   * what tells them apart.
   */
  const frame = (children: React.ReactNode) => (
    <div className="api-response flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 h-7 shrink-0 border-b border-ft-border">
        <span className="text-[11px] font-semibold text-ft-text">Response</span>
        <span className="text-[10px] text-ft-text-muted">{sending ? "waiting…" : ""}</span>
      </div>
      {strip}
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );

  if (sending) {
    return frame(
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[11px] text-ft-text-muted">
        <span>Waiting for a response…</span>
        {received > 0 && <span className="font-mono">{formatBytes(received)} received</span>}
      </div>
    );
  }

  // An example on screen outlives the failure that follows it: looking at what
  // the endpoint should return is exactly what you do when a send has failed.
  if (error && !example) {
    return frame(<Failure error={error} onRetryWithoutTls={onRetryWithoutTls} />);
  }

  if (!shown) {
    return frame(
      <div className="flex h-full items-center justify-center px-8 text-center text-[11px] text-ft-text-muted">
        Send a request and the response appears here.
      </div>
    );
  }

  const type = headerValue(shown.headers, "content-type");
  const kind = contentKind(type);
  const body = pretty && formatted !== null ? formatted : shown.body.text;

  /*
    The right-click menu for the whole pane.

    Built when the menu is opened rather than held in state, so what it offers
    is what is true at that moment — a selection that exists now, the tab that
    is open now — and never a stale copy of either.
  */
  const menuItems = (): MenuItem[] => {
    const selected = window.getSelection()?.toString() ?? "";
    const copy = (text: string) =>
      void navigator.clipboard?.writeText(text).catch(() => undefined);

    const headerText = shown.headers
      .map((header) => `${header.name}: ${header.value}`)
      .join("\n");

    return [
      {
        label: "Copy selection",
        icon: <Copy size={12} />,
        // Nothing selected is not an error, it is just nothing to copy — so
        // the item is there and dimmed rather than missing.
        disabled: selected === "",
        onClick: () => copy(selected),
      },
      {
        label: "Copy body",
        detail: formatBytes(shown.body.bytes),
        icon: <FileJson size={12} />,
        disabled: body === null || body === "",
        onClick: () => copy(body ?? ""),
      },
      {
        label: "Copy response headers",
        detail: String(shown.headers.length),
        icon: <List size={12} />,
        disabled: shown.headers.length === 0,
        onClick: () => copy(headerText),
      },
      {
        label: "Copy status",
        icon: <Copy size={12} />,
        onClick: () => copy(`${shown.status} ${shown.statusText}`),
      },
      { separator: true },
      {
        // The thing people do a hundred times a day: find the token in what
        // came back and put it where the next request can reach it.
        label: "Set as a variable…",
        icon: <VariableIcon size={12} />,
        disabled: selected === "",
        onClick: () => onSaveVariable(selected),
      },
      { separator: true },
      ...(formatted !== null
        ? [
            {
              label: pretty ? "Show raw" : "Show pretty",
              icon: <TextQuote size={12} />,
              onClick: () => onPrettyChange(!pretty),
            },
          ]
        : []),
      {
        label: wrap ? "Stop wrapping lines" : "Wrap long lines",
        icon: <WrapText size={12} />,
        onClick: () => onWrapChange(!wrap),
      },
      ...(onSaveExample && !example
        ? [
            { separator: true },
            {
              label: "Save as example",
              icon: <Bookmark size={12} />,
              onClick: onSaveExample,
            },
          ]
        : []),
    ];
  };

  return (
    <div
      className="api-response flex h-full min-h-0 flex-col"
      onContextMenu={(event) => {
        // The window's own menu is suppressed everywhere in here; this is
        // what replaces it, rather than leaving a dead right-click.
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={`${shown.status} ${shown.statusText}`}
          items={menuItems()}
          onClose={() => setMenu(null)}
        />
      )}

      {/*
        The title and the status, on one row.

        These were two, and the first of them held a single word: `Response`
        alone in a 28px row, above a second row saying `200 OK · 412ms · 1.2K`.
        Three stacked rows of chrome — title, status, tabs — before any of the
        answer, in a pane whose whole job is to show the answer. The heading
        earns its place on the empty states, where it says what the space is
        for; once there is a response in it, the status line is the heading, and
        the word only needs to be the first thing on it.

        Left to right it reads as one sentence: what this is, how it went, how
        long, how big, and what you can do with it.
      */}
      <div className="flex items-center gap-2.5 px-3 h-7 shrink-0 border-b border-ft-border text-[11px]">
        <span className="font-semibold text-ft-text">Response</span>
        {/* The same hairline the status bar puts between its own groups. */}
        <span className="w-px h-3 shrink-0 bg-ft-border-subtle" />

        <span className={`font-semibold ${toneClass(statusTone(shown.status))}`}>
          {shown.status} {shown.statusText}
        </span>
        {example ? (
          <span className="text-ft-text-muted">saved example</span>
        ) : (
          <span className="text-ft-text-muted">{formatDuration(shown.timing.totalMs)}</span>
        )}
        <span className="text-ft-text-muted">{formatBytes(shown.body.bytes)}</span>
        {shown.redirects.length > 0 && (
          <span className="text-ft-accent">
            {shown.redirects.length} redirect{shown.redirects.length === 1 ? "" : "s"}
          </span>
        )}

        <div className="flex-1" />

        {/* Keeping an answer is an action on the answer, so it belongs on the
            line that describes it, rather than on the strip that lists them.
            Absent on a request not in a collection, which has nowhere to keep
            one, and while looking at an example, which is already kept. */}
        {onSaveExample && response && !example && (
          <button
            className="api-chip-action shrink-0"
            onClick={onSaveExample}
            title="Keep this response under the request, where the sidebar will list it"
          >
            <Bookmark size={10} />
            Save as example
          </button>
        )}
      </div>
      {strip}

      <div className="api-tabstrip flex items-center gap-1 px-2 h-7 shrink-0 border-b border-ft-border">
        {(["body", "tests", "headers", "request", "timing"] as ResponseTab[]).map((name) => {
          // The Tests tab is absent where nothing ran, rather than present and
          // empty — a tab that never has anything in it is noise.
          if (name === "tests" && !scripts) return null;
          const failed = scripts?.tests.filter((entry) => !entry.passed).length ?? 0;

          return (
            <button
              key={name}
              className={`api-tab ${tab === name ? "selected" : ""}`}
              onClick={() => onTabChange(name)}
            >
              {name === "body"
                ? "Body"
                : name === "tests"
                  ? "Tests"
                  : name === "headers"
                    ? "Headers"
                    : name === "request"
                      ? "Request"
                      : "Timing"}
              {name === "headers" && (
                <span className="api-tab-badge">{shown.headers.length}</span>
              )}
              {name === "tests" && scripts && (
                <span
                  className={`api-tab-badge ${
                    failed > 0 || scripts.errors.length > 0 ? "failing" : ""
                  }`}
                >
                  {failed > 0
                    ? `${failed} failed`
                    : scripts.errors.length > 0
                      ? "error"
                      : scripts.tests.length}
                </span>
              )}
            </button>
          );
        })}

        {tab === "body" && (
          <div className="ml-auto flex items-center gap-1">
            {formatted !== null && (
              <>
                <button
                  className={`api-tab ${pretty ? "selected" : ""}`}
                  onClick={() => onPrettyChange(true)}
                >
                  Pretty
                </button>
                <button
                  className={`api-tab ${pretty ? "" : "selected"}`}
                  onClick={() => onPrettyChange(false)}
                >
                  Raw
                </button>
              </>
            )}
            <button
              className={`api-tab ${wrap ? "selected" : ""}`}
              onClick={() => onWrapChange(!wrap)}
              title={wrap ? "Stop wrapping long lines" : "Wrap long lines"}
              aria-label={wrap ? "Stop wrapping long lines" : "Wrap long lines"}
              aria-pressed={wrap}
            >
              <WrapText size={11} />
            </button>
          </div>
        )}
      </div>

      {/* The body tab is its own scroller — CodeMirror does that itself, and
          nesting it inside one would give the pane two. */}
      {tab === "body" ? (
        <div className="flex-1 min-h-0 flex flex-col">
          {shown.body.truncated && (
            <div className="px-3 py-1.5 shrink-0 text-[11px] text-ft-warning border-b border-ft-border-subtle">
              Only the first {formatBytes(shown.body.bytes)} were kept — the rest of this
              response was not downloaded.
            </div>
          )}
          {body === null ? (
            <div className="px-3 py-3 text-[11px] text-ft-text-muted">
              {formatBytes(shown.body.bytes)} of {kind === "image" ? "image" : "binary"} data
              {type ? ` (${type})` : ""}. Viewing and saving it comes with the phase that streams
              large bodies to disk.
            </div>
          ) : body === "" ? (
            <div className="px-3 py-3 text-[11px] text-ft-text-muted">Empty body.</div>
          ) : (
            <BodyViewer
              text={body}
              kind={kind}
              wrap={wrap}
              dark={dark}
              fontFamily={fontFamily}
              fontSize={fontSize}
              lineHeight={lineHeight}
            />
          )}
        </div>
      ) : (
      <div className="flex-1 min-h-0 overflow-auto">

        {tab === "tests" && scripts && (
          <div className="flex flex-col text-[11px]">
            {scripts.errors.map((failure, index) => (
              <div
                key={`error-${index}`}
                className="flex gap-2 px-3 py-1.5 border-b border-ft-border-subtle"
              >
                <CircleAlert size={12} className="mt-[1px] shrink-0 text-ft-error" />
                <div className="flex-1 min-w-0">
                  <div className="text-ft-error">
                    The script from {failure.from} did not finish
                  </div>
                  <div className="font-mono text-[10px] text-ft-text-muted break-all">
                    {failure.message}
                  </div>
                </div>
              </div>
            ))}

            {scripts.tests.map((entry, index) => (
              <div
                key={`test-${index}`}
                className="flex gap-2 px-3 py-1.5 border-b border-ft-border-subtle"
              >
                {entry.passed ? (
                  <Check size={12} className="mt-[1px] shrink-0 text-ft-success" />
                ) : (
                  <Cross size={12} className="mt-[1px] shrink-0 text-ft-error" />
                )}
                <div className="flex-1 min-w-0">
                  <div className={entry.passed ? "text-ft-text" : "text-ft-error"}>
                    {entry.name}
                  </div>
                  {entry.error && (
                    <div className="font-mono text-[10px] text-ft-text-muted break-all">
                      {entry.error}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {scripts.logs.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-ft-text-muted border-b border-ft-border-subtle">
                  Console
                </div>
                {scripts.logs.map((line, index) => (
                  <div
                    key={`log-${index}`}
                    className={`px-3 py-1 font-mono text-[10px] whitespace-pre-wrap break-all ${
                      line.level === "error"
                        ? "text-ft-error"
                        : line.level === "warn"
                          ? "text-ft-warning"
                          : "text-ft-text-secondary"
                    }`}
                  >
                    {line.text}
                  </div>
                ))}
              </>
            )}

            {scripts.tests.length === 0 &&
              scripts.errors.length === 0 &&
              scripts.logs.length === 0 && (
                <div className="px-3 py-3 text-ft-text-muted">
                  The scripts ran and asserted nothing.
                </div>
              )}
          </div>
        )}

        {tab === "headers" && <Rows rows={shown.headers} />}

        {tab === "request" &&
          (example ? (
            // The format keeps the request beside the response, so a kept
            // answer can show what earned it — which is most of what makes one
            // documentation rather than a blob.
            keptRequest ? (
              <div className="flex flex-col">
                <div className="px-3 py-2 font-mono text-[11px] text-ft-text-secondary border-b border-ft-border-subtle break-all">
                  {keptRequest.method} {keptRequest.url}
                </div>
                <Rows
                  rows={keptRequest.headers
                    .filter((header) => header.enabled && header.name !== "")
                    .map((header) => ({ name: header.name, value: header.value }))}
                />
                <div className="px-3 py-2 text-[11px] text-ft-text-muted">
                  {keptRequest.body.mode === "none"
                    ? "No body was sent."
                    : keptRequest.body.fields?.length
                      ? `${keptRequest.body.fields.length} field${
                          keptRequest.body.fields.length === 1 ? "" : "s"
                        } sent as ${keptRequest.body.mode}.`
                      : keptRequest.body.text}
                </div>
              </div>
            ) : (
              <div className="px-3 py-3 text-[11px] leading-relaxed text-ft-text-muted">
                This example has no record of what was sent. The format keeps the
                request beside the response, and whatever wrote this one did not —
                so the answer is here and the question is not.
              </div>
            )
          ) : (
            <div className="flex flex-col">
              <div className="px-3 py-2 font-mono text-[11px] text-ft-text-secondary border-b border-ft-border-subtle break-all">
                {shown.sent.method} {shown.sent.url}
              </div>
              <Rows rows={shown.sent.headers} />
              <div className="px-3 py-2 text-[11px] text-ft-text-muted">
                {shown.sent.bodyBytes === 0
                  ? "No body sent."
                  : `${formatBytes(shown.sent.bodyBytes)} of body sent.`}
              </div>
            </div>
          ))}

        {tab === "timing" &&
          (example ? (
            <div className="px-3 py-3 text-[11px] text-ft-text-muted">
              A saved response was not timed, so there is nothing here to report.
            </div>
          ) : (
            <div className="flex flex-col text-[11px]">
              <Rows
                rows={[
                  { name: "Waiting", value: formatDuration(shown.timing.waitMs) },
                  { name: "Downloading", value: formatDuration(shown.timing.downloadMs) },
                  { name: "Total", value: formatDuration(shown.timing.totalMs) },
                  { name: "Protocol", value: shown.httpVersion },
                  { name: "Server", value: shown.remoteAddress ?? "—" },
                  { name: "Final URL", value: shown.finalUrl },
                ]}
              />
              {shown.redirects.length > 0 && (
                <>
                  <div className="px-3 py-1.5 text-ft-text-muted border-b border-ft-border-subtle">
                    Redirects
                  </div>
                  <Rows
                    rows={shown.redirects.map((hop) => ({
                      name: `${hop.status} · ${formatDuration(hop.elapsedMs)}`,
                      value: `${hop.from} → ${hop.to}`,
                    }))}
                  />
                </>
              )}
              <div className="px-3 py-2 text-ft-text-muted">
                DNS, connect and TLS are not broken out: measuring them needs a connector of our
                own, which is a later phase.
              </div>
            </div>
          ))}
      </div>
      )}
    </div>
  );
}
