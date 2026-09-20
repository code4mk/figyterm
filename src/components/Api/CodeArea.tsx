/**
 * An editable code field, for the places in this window that hold code.
 *
 * The scripts are JavaScript and were plain textareas: no highlighting, no
 * bracket matching, no indentation, and a `pm.test(` whose closing paren you
 * type yourself. A ten-line script survives that; the fifty-line one somebody
 * writes to sign a request does not.
 *
 * Separate from `BodyViewer`, which is read-only, and from `VariableInput`,
 * which is one line by construction. This is the third case: editable, many
 * lines, a real language.
 *
 * It reads the app's editor settings itself rather than taking them as props.
 * The look of code is an application-wide setting — the same face and size as
 * the editor window and the terminal — not a decision the pane above it makes,
 * and threading four props through two intermediate components to say so would
 * be four props that only ever have one value.
 */

import { useEffect, useMemo, useRef } from "react";
import { Compartment, EditorState, Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
  tooltips,
} from "@codemirror/view";
import {
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { editorTheme } from "../Editor/editorTheme";
import { useEditorStore } from "../../stores/editorStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThemeStore } from "../../stores/themeStore";
import { Scope } from "../../services/api/template";
import { useFindPanel } from "./useFindPanel";
import { scopesEffect, variableExtensions } from "./variableExtensions";

interface CodeAreaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Extra extensions — a completion source, say. Read once, at build time. */
  extensions?: readonly unknown[];
  /**
   * The language to parse as. Omitted means JavaScript, which is what the
   * scripts are; the raw body passes JSON and the GraphQL boxes pass none.
   */
  language?: Extension | null;
  /**
   * When given, `{{variables}}` are coloured, completed and explained here as
   * they are in every other field. A raw JSON body full of `{{client_id}}` is
   * the single most common place to write one.
   */
  scopes?: Scope[];
  ariaLabel?: string;
}

export function CodeArea({
  value,
  onChange,
  placeholder,
  extensions,
  language,
  scopes,
  ariaLabel,
}: CodeAreaProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Through a ref, so the view is built once: rebuilding it per render would
  // lose the caret, the selection and the undo history on every keystroke.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const theme = useThemeStore((s) => s.theme);
  const settings = useSettingsStore((s) => s.settings);
  const editorSettings = useEditorStore((s) => s.settings);
  // The editor's sentinel rule: a blank face or a zero size means "follow the
  // terminal", so somebody who never chose one still moves when it does.
  const look = useMemo(
    () => ({
      dark: theme === "dark",
      fontFamily: editorSettings.fontFamily || settings.fontFamily,
      fontSize: editorSettings.fontSize || settings.fontSize,
      lineHeight: editorSettings.lineHeight,
    }),
    [
      theme,
      editorSettings.fontFamily,
      editorSettings.fontSize,
      editorSettings.lineHeight,
      settings.fontFamily,
      settings.fontSize,
    ]
  );

  const find = useFindPanel();

  const compartments = useMemo(
    () => ({ theme: new Compartment(), placeholder: new Compartment() }),
    []
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          codeFolding(),
          foldGutter(),
          history(),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          indentUnit.of("  "),
          highlightSelectionMatches(),
          // The editor window's find panel, not CodeMirror's — it has the
          // match count, which is the half of a find bar people use.
          find.extension,
          // `undefined` means JavaScript — the scripts, which is what this was
          // built for. `null` means none, for a body whose shape nobody knows.
          language === undefined ? javascript() : (language ?? []),
          // Only where variables can go. The extension brings a completion
          // source with it, and a second one in a state is a config conflict
          // that throws out of `EditorState.create`.
          ...(scopes ? [variableExtensions()] : []),
          // Parented to the body: this sits several clipping scrollers deep
          // inside a modal, and a completion list left inside the editor is
          // cut off at its edge.
          tooltips({ position: "fixed", parent: document.body }),
          EditorView.lineWrapping,
          keymap.of([
            ...closeBracketsKeymap,
            ...searchKeymap,
            ...foldKeymap,
            ...historyKeymap,
            // Tab indents rather than leaving the field. It is the last
            // binding, so nothing that wants Tab for itself loses it — and
            // Escape then Tab still gets out, which is the accessible way.
            indentWithTab,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.contentAttributes.of(ariaLabel ? { "aria-label": ariaLabel } : {}),
          compartments.theme.of(editorTheme(look)),
          compartments.placeholder.of(placeholder ? placeholderExt(placeholder) : []),
          ...((extensions ?? []) as never[]),
        ],
      }),
      parent: container,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Built once; everything that changes is a compartment or a dispatch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compartments]);

  /** A value changed from outside — a different request, a reverted draft. */
  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;

    const caret = view.state.selection.main.head;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: Math.min(caret, value.length) },
    });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.theme.reconfigure(editorTheme(look)) });
  }, [compartments, look]);

  /** Switching environment changes what resolves without changing a
   * character, so the scopes are pushed in rather than captured. */
  useEffect(() => {
    if (!scopes) return;
    viewRef.current?.dispatch({ effects: scopesEffect(scopes) });
  }, [scopes]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.placeholder.reconfigure(
        placeholder ? placeholderExt(placeholder) : []
      ),
    });
  }, [compartments, placeholder]);

  return (
    <div ref={containerRef} className="api-code-area flex-1 min-h-0 overflow-hidden">
      {find.render(viewRef.current)}
    </div>
  );
}
