/**
 * The response body, in the editor rather than in a `<pre>`.
 *
 * A `<pre>` cannot fold a four-thousand-line JSON body, cannot search it, and
 * cannot tell you which line you are on — and those three are most of what
 * anybody does with a response they did not expect. CodeMirror is already in
 * this app for the code editor, and this uses its theme, so a response and a
 * file look like the same application in both light and dark.
 *
 * **Read-only, but not `editable: false`.** `EditorState.readOnly` stops edits
 * while leaving a caret, a selection and a working keymap; turning off
 * `editable` would also take away focus, and with it the ability to search or
 * to select a line to copy.
 *
 * **Big bodies.** Above `PARSE_LIMIT` the language extension is left out, so
 * the body is shown but not parsed. The parse is what costs: CodeMirror draws
 * only the visible lines whatever the size, but a Lezer parse of four megabytes
 * of JSON locks the window for seconds. It says so, and offers to do it anyway.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Compartment, EditorState, Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { bracketMatching, codeFolding, foldGutter, foldKeymap } from "@codemirror/language";
import { defaultKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { html } from "@codemirror/lang-html";
import { editorTheme } from "../Editor/editorTheme";
import { ContentKind } from "../../services/api/format";
import { useFindPanel } from "./useFindPanel";

/**
 * Above this, the body is shown without being parsed.
 *
 * Half a megabyte: a response anybody reads is far below it, and the ones above
 * it are dumps where highlighting is worth less than the window staying
 * responsive.
 */
export const PARSE_LIMIT = 512 * 1024;

interface BodyViewerProps {
  /** The text to show. Never null — the caller decides what to draw instead. */
  text: string;
  kind: ContentKind;
  wrap: boolean;
  dark: boolean;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

function languageFor(kind: ContentKind): Extension | null {
  switch (kind) {
    case "json":
      return json();
    case "xml":
      return xml();
    case "html":
      return html();
    default:
      return null;
  }
}

export function BodyViewer({
  text,
  kind,
  wrap,
  dark,
  fontFamily,
  fontSize,
  lineHeight,
}: BodyViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  /** Set when somebody asked for a body over the limit to be parsed anyway. */
  const [forceParse, setForceParse] = useState(false);
  const big = text.length > PARSE_LIMIT;
  const parsing = !big || forceParse;

  // A different body is a different question about parsing it.
  useEffect(() => setForceParse(false), [text]);

  // One compartment each, so a theme change or a wrap toggle reconfigures
  // rather than rebuilding the state — which would lose the scroll position and
  // whatever was selected.
  const find = useFindPanel({ allowReplace: false });

  const compartments = useMemo(
    () => ({
      theme: new Compartment(),
      wrap: new Compartment(),
      language: new Compartment(),
    }),
    []
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          codeFolding(),
          foldGutter(),
          bracketMatching(),
          highlightSelectionMatches(),
          // The editor window's panel. Replace is off: the document is
          // read-only, and a replace row over one that refuses changes is a
          // button that does nothing and does not say why.
          find.extension,
          // No highlight style here: `editorTheme` carries its own, picked
          // against each theme's background, and a second one would win or
          // lose by extension order rather than by intent.
          // `defaultKeymap` last: the search and fold bindings are the ones
          // worth having here, and a conflict should go their way.
          keymap.of([...searchKeymap, ...foldKeymap, ...defaultKeymap]),
          EditorState.readOnly.of(true),
          EditorView.contentAttributes.of({ "aria-label": "Response body" }),
          compartments.theme.of(editorTheme({ dark, fontFamily, fontSize, lineHeight })),
          compartments.wrap.of(wrap ? EditorView.lineWrapping : []),
          compartments.language.of(parsing ? (languageFor(kind) ?? []) : []),
        ],
      }),
      parent: container,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Built once. Everything that can change is a compartment below, except the
    // document itself, which is dispatched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compartments]);

  /** A new body replaces the document rather than the view. */
  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === text) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      // Back to the top: this is a different response, and the line somebody
      // had scrolled to in the last one means nothing in this one.
      selection: { anchor: 0 },
      scrollIntoView: true,
    });
  }, [text]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.theme.reconfigure(
        editorTheme({ dark, fontFamily, fontSize, lineHeight })
      ),
    });
  }, [compartments, dark, fontFamily, fontSize, lineHeight]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [compartments, wrap]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.language.reconfigure(parsing ? (languageFor(kind) ?? []) : []),
    });
  }, [compartments, kind, parsing]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {big && !forceParse && (
        <div className="flex items-center gap-2 px-3 py-1.5 shrink-0 border-b border-ft-border-subtle text-[11px] text-ft-text-muted">
          <span>
            Shown without highlighting — this body is large enough that parsing it
            would hold the window up.
          </span>
          <button className="api-button-quiet" onClick={() => setForceParse(true)}>
            Highlight anyway
          </button>
        </div>
      )}
      <div ref={containerRef} className="api-body-viewer flex-1 min-h-0 overflow-hidden">
        {find.render(viewRef.current)}
      </div>
    </div>
  );
}
