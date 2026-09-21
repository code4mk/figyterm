/**
 * The body, in whichever shape this request sends.
 *
 * Every mode's state is kept when you switch away from it — the form fields
 * survive a trip to Raw and back, and the query survives a trip to None. Only
 * the selected mode is sent. Losing a payload to a mis-click on a dropdown is
 * the kind of small betrayal that makes people stop trusting a tool.
 *
 * A file part holds a *path*, and a path belongs to the machine that chose it.
 * That is why an imported form with a file field shows the path it came with
 * and a way to repoint it, rather than pretending the file is there.
 */

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileUp, Paperclip, Trash2, X } from "lucide-react";
import { BodyField, BodyMode, RequestBody } from "../../types/api";
import { blankField, isBlankField } from "../../services/api/request";
import { json } from "@codemirror/lang-json";
import { CodeArea } from "./CodeArea";
import { Select } from "./Select";
import { useBlankRow } from "./useBlankRow";
import { Scope } from "../../services/api/template";
import { VariableInput } from "./VariableInput";

/** Content types worth one click for a raw body. Anything else is a header. */
const CONTENT_TYPES = [
  "application/json",
  "text/plain",
  "application/xml",
  "text/html",
  "application/x-www-form-urlencoded",
];

/**
 * The modes, named the way the format and every other client names them.
 *
 * `file` is "binary" to everybody outside this codebase, and `urlencoded` is
 * written out in full — these are the words people arrive already knowing, and
 * a client that renames them makes its user translate.
 */
const MODES: { id: BodyMode; label: string; hint: string }[] = [
  { id: "none", label: "none", hint: "No body at all" },
  { id: "formdata", label: "form-data", hint: "Multipart, which is what a file upload needs" },
  {
    id: "urlencoded",
    label: "x-www-form-urlencoded",
    hint: "Key and value pairs, encoded into the body like a query string",
  },
  { id: "raw", label: "raw", hint: "Type it yourself — JSON, XML, anything" },
  { id: "file", label: "binary", hint: "One file on disk, sent as the whole body" },
  { id: "graphql", label: "GraphQL", hint: "A query and its variables" },
];

interface BodyPanelProps {
  body: RequestBody;
  onChange: (body: RequestBody) => void;
  /** The chain in play, so a `{{variable}}` in a field value is coloured,
   * completed and explained here as it is everywhere else. */
  scopes: Scope[];
}



/** The last path segment, which is all there is room for. */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function BodyPanel({ body, onChange, scopes }: BodyPanelProps) {
  const blank = useBlankRow();
  const multipart = body.mode === "formdata";

  // The trailing blank is conjured here rather than stored, and its id is held
  // steady — a fresh one per render remounts the row, and a field that
  // remounts while you type in it loses focus mid-word.
  const stored = body.fields ?? [];
  const last = stored[stored.length - 1];
  const fields = last && isBlankField(last) ? stored : [...stored, blankField(blank.id)];

  const setFields = (next: BodyField[]) => {
    if (next.some((field) => field.id === blank.id && !isBlankField(field))) blank.renew();
    onChange({ ...body, fields: next.filter((field) => !isBlankField(field)) });
  };

  const update = (id: string, patch: Partial<BodyField>) =>
    setFields(fields.map((field) => (field.id === id ? { ...field, ...patch } : field)));

  /**
   * Adds files to a part, rather than replacing what is there.
   *
   * Multipart allows several files under one name, so the picker is opened
   * with `multiple` and what comes back is appended — picking again is how you
   * add a second batch, and the remove button on each chip is how you take one
   * out. Replacing on every pick would make a five-file upload five trips
   * through the dialog with no way to fix a mistake in the middle.
   *
   * Duplicates are dropped: the same file twice in one field is a mis-click,
   * not a request anybody means to send.
   */
  const pickFor = async (id: string) => {
    const picked = await openDialog({ multiple: true, title: "Choose files to upload" });
    if (!picked) return;
    const chosen = Array.isArray(picked) ? picked : [picked];
    const field = fields.find((row) => row.id === id);
    const already = field?.filePaths ?? [];
    update(id, {
      kind: "file",
      filePaths: [...already, ...chosen.filter((path) => !already.includes(path))],
    });
  };

  const dropFile = (id: string, path: string) => {
    const field = fields.find((row) => row.id === id);
    update(id, { filePaths: (field?.filePaths ?? []).filter((entry) => entry !== path) });
  };

  const pickWhole = async () => {
    const picked = await openDialog({ multiple: false, title: "Choose the file to send" });
    if (!picked || Array.isArray(picked)) return;
    onChange({ ...body, filePath: picked });
  };

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 h-7 shrink-0 text-[11px] text-ft-text-muted border-b border-ft-border-subtle">
        {/* A row of radios rather than a dropdown.
            All six are worth seeing at once — which one a request uses is part
            of reading it — and a dropdown hides five of them behind a click
            and the memory of what was in there. */}
        <div
          className="flex items-center gap-3 flex-wrap"
          role="radiogroup"
          aria-label="Body type"
        >
          {MODES.map((mode) => {
            // The label and the id differ for one of them: `binary` is what
            // everybody calls it, `file` is what this app and the format
            // store. The word is theirs, the value is ours.
            const on = body.mode === mode.id;

            return (
              <label key={mode.id} className="api-body-mode" title={mode.hint}>
                <input
                  type="radio"
                  name="body-mode"
                  className="w-3 h-3 accent-[color:var(--ft-accent)]"
                  checked={on}
                  onChange={() => onChange({ ...body, mode: mode.id })}
                />
                <span className={on ? "text-ft-text" : ""}>{mode.label}</span>
              </label>
            );
          })}
        </div>

        {body.mode === "raw" && (
          <>
            <Select
              className="w-[190px]"
              value={body.contentType}
              options={CONTENT_TYPES.map((type) => ({ value: type, label: type }))}
              fallbackLabel={body.contentType}
              onChange={(contentType) => onChange({ ...body, contentType })}
              ariaLabel="Content type"
            />
            <span className="ml-auto truncate">
              Sent as Content-Type unless a header sets one
            </span>
          </>
        )}

        {(body.mode === "urlencoded" || multipart) && (
          <span className="ml-auto truncate">
            {multipart
              ? "Sent as multipart, with a boundary chosen at send time"
              : "Sent form-encoded, whatever the header table says"}
          </span>
        )}

        {body.mode === "graphql" && (
          <span className="ml-auto truncate">Sent as JSON: query and variables</span>
        )}
      </div>

      {body.mode === "none" && (
        <div className="flex flex-1 items-center justify-center text-[11px] text-ft-text-muted">
          This request sends no body.
        </div>
      )}

      {body.mode === "raw" && (
        // A real editor, and one that knows about variables: a raw JSON body
        // full of `{{client_id}}` is the single most common place to write
        // one, and it was the one place they were plain grey text.
        <CodeArea
          value={body.text}
          onChange={(text) => onChange({ ...body, text })}
          placeholder={'{\n  "key": "value"\n}'}
          language={body.contentType.includes("json") ? json() : null}
          scopes={scopes}
          ariaLabel="Request body"
        />
      )}

      {(body.mode === "urlencoded" || multipart) && (
        <div className="flex-1 min-h-0 overflow-auto text-[11px]">
          <div className="flex items-center gap-2 px-3 py-1.5 text-ft-text-muted border-b border-ft-border-subtle">
            <span className="w-4" />
            <span className="flex-1">Name</span>
            <span className="flex-[1.6]">Value</span>
            <span className={multipart ? "w-14" : "w-0"} />
            <span className="w-6" />
          </div>

          {fields.map((field) => (
            <div
              key={field.id}
              className="flex items-center gap-2 px-3 py-1 border-b border-ft-border-subtle group"
            >
              <input
                type="checkbox"
                className="w-3.5 h-3.5 accent-[color:var(--ft-accent)]"
                checked={field.enabled}
                disabled={isBlankField(field)}
                onChange={(e) => update(field.id, { enabled: e.target.checked })}
                aria-label={field.key ? `Send ${field.key}` : "Send this field"}
              />
              {/*
                A part with no name is dropped at send — multipart has nowhere
                to put it, and the server would have nothing to read it by. It
                used to be dropped silently, which for a file part meant the
                row sat there naming the file you picked while the upload never
                happened. The border is what turns that into something you can
                see before pressing Send.
              */}
              <input
                className={`api-cell flex-1 ${
                  (field.filePaths ?? []).length > 0 && field.key.trim() === ""
                    ? "needs-name"
                    : ""
                }`}
                value={field.key}
                spellCheck={false}
                placeholder="name"
                title={
                  (field.filePaths ?? []).length > 0 && field.key.trim() === ""
                    ? "This part needs a name, or it will not be sent"
                    : undefined
                }
                onChange={(e) => update(field.id, { key: e.target.value })}
              />

              {field.kind === "file" ? (
                /*
                  A chip per attachment, and a button to add more.

                  Not a dropdown: a select chooses from a list somebody already
                  has, and these come from the OS file dialog — there is no set
                  of options to present, only what has been picked so far. What
                  the control has to do is show which files are attached, in
                  order, and let one be taken out; chips do that in the width of
                  a table cell, and a select would show one line and hide the
                  rest behind a click.
                */
                <div className="flex flex-[1.6] min-w-0 flex-wrap items-center gap-1">
                  {(field.filePaths ?? []).map((path) => (
                    <span key={path} className="api-file-chip" title={path}>
                      <span className="truncate">{fileName(path)}</span>
                      <button
                        className="api-file-chip-x"
                        onClick={() => dropFile(field.id, path)}
                        title={`Remove ${fileName(path)}`}
                        aria-label={`Remove ${fileName(path)}`}
                      >
                        <X size={9} />
                      </button>
                    </span>
                  ))}
                  <button
                    className={`api-file-add ${
                      (field.filePaths ?? []).length === 0 ? "empty" : ""
                    }`}
                    onClick={() => void pickFor(field.id)}
                    title={
                      (field.filePaths ?? []).length === 0
                        ? "Choose one or more files"
                        : "Add more files to this part"
                    }
                  >
                    <Paperclip size={9} />
                    {(field.filePaths ?? []).length === 0 ? "Choose files…" : "Add"}
                  </button>
                </div>
              ) : (
                /* A form value is where `{{user_id}}` lives as often as a
                   query value is, so it gets the same field. The *name* keeps
                   a plain input: a field is called `email`, and an editor per
                   cell in a form of twenty is twenty editors. */
                <VariableInput
                  className="api-cell flex-[1.6]"
                  value={field.value}
                  scopes={scopes}
                  placeholder="value"
                  onChange={(value) => update(field.id, { value })}
                  ariaLabel={field.key ? `Value of ${field.key}` : "Field value"}
                />
              )}

              {multipart && (
                <Select
                  className="w-[74px]"
                  value={field.kind}
                  options={[
                    { value: "text", label: "Text" },
                    { value: "file", label: "File" },
                  ]}
                  onChange={(kind) => update(field.id, { kind })}
                  ariaLabel="Part type"
                />
              )}

              <button
                className="w-6 shrink-0 rounded p-1 text-ft-text-muted opacity-0 group-hover:opacity-100 hover:bg-ft-surface hover:text-ft-error disabled:invisible"
                disabled={isBlankField(field)}
                onClick={() => setFields(fields.filter((row) => row.id !== field.id))}
                title="Remove"
                aria-label={`Remove ${field.key || "field"}`}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {body.mode === "file" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          {body.filePath ? (
            <>
              <div className="text-[12px] text-ft-text break-all">{fileName(body.filePath)}</div>
              <div className="text-[10px] text-ft-text-muted break-all">{body.filePath}</div>
              <div className="flex items-center gap-2">
                <button className="api-button-quiet" onClick={() => void pickWhole()}>
                  Choose another
                </button>
                <button
                  className="api-button-quiet flex items-center gap-1"
                  onClick={() => onChange({ ...body, filePath: undefined })}
                >
                  <X size={11} /> Clear
                </button>
              </div>
            </>
          ) : (
            <button
              className="api-button-quiet flex items-center gap-1.5"
              onClick={() => void pickWhole()}
            >
              <FileUp size={12} /> Choose a file
            </button>
          )}
          <span className="text-[10px] text-ft-text-muted">
            The whole file is the body. Set its Content-Type in the header table.
          </span>
        </div>
      )}

      {body.mode === "graphql" && (
        <div className="flex flex-1 min-h-0 flex-col">
          <CodeArea
            value={body.text}
            onChange={(text) => onChange({ ...body, text })}
            placeholder={"query {\n  me {\n    id\n  }\n}"}
            // No GraphQL grammar is loaded, and adding one for a box people
            // paste a query into is a parser for a highlight.
            language={null}
            scopes={scopes}
            ariaLabel="GraphQL query"
          />
          <div className="px-3 py-1 shrink-0 text-[10px] text-ft-text-muted border-t border-ft-border-subtle">
            Variables, as JSON
          </div>
          <div className="flex h-[30%] shrink-0 flex-col border-t border-ft-border-subtle">
            <CodeArea
              value={body.graphqlVariables ?? ""}
              onChange={(graphqlVariables) => onChange({ ...body, graphqlVariables })}
              placeholder={'{\n  "id": 1\n}'}
              language={json()}
              scopes={scopes}
              ariaLabel="GraphQL variables"
            />
          </div>
        </div>
      )}
    </div>
  );
}
