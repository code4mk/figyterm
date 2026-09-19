/**
 * A one-line field that knows what `{{a_variable}}` is.
 *
 * `{{base_url}}` typed into a plain `<input>` is grey text on grey whether it
 * resolves or not — and this is the single most-used feature of the whole
 * client. Here it is coloured in place, completed on `{{`, and explained on
 * hover, which between them answer the three questions people actually have:
 * is this name real, what is it called, and what is it worth right now.
 *
 * **One line, enforced.** CodeMirror is a text editor and will happily take a
 * newline; a URL bar will not. Newlines are filtered out of every transaction,
 * including pasted ones — a URL copied out of a terminal often arrives with a
 * trailing one, and it should paste as a URL rather than as two lines.
 *
 * It is not a drop-in `<input>`: it is heavier, and every one of these builds
 * an editor. It is worth it where variables go, and a plain input is still
 * right everywhere else.
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder as placeholderExt,
  tooltips,
} from "@codemirror/view";
import { closeCompletion, completionKeymap, startCompletion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Scope } from "../../services/api/template";
import { scopesEffect, variableExtensions } from "./variableExtensions";

/** What the window can ask of one of these from outside. */
export interface VariableInputHandle {
  focus: () => void;
}

interface VariableInputProps {
  value: string;
  onChange: (value: string) => void;
  /** The chain in play, for the colours, the list and the hover. */
  scopes: Scope[];
  placeholder?: string;
  /** Fired on Enter. A URL bar sends; a table cell does nothing. */
  onEnter?: () => void;
  /** Pasting a cURL command into the URL bar becomes the whole request.
   * Return true to say the paste was taken and should not be inserted. */
  onPaste?: (text: string) => boolean;
  className?: string;
  ariaLabel?: string;
}

/**
 * The scopes, in a field so the extensions can read the current ones.
 *
 * A closure over the prop would capture the scopes as they were when the view
 * was built, and go stale the moment somebody switched environment — which is
 * exactly when the colours matter most.
 */
export const VariableInput = forwardRef<VariableInputHandle, VariableInputProps>(function VariableInput(
  { value, onChange, scopes, placeholder, onEnter, onPaste, className, ariaLabel },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // The callbacks through a ref, so the view is built once: rebuilding it on
  // every render would lose the caret on every keystroke.
  const handlers = useRef({ onChange, onEnter, onPaste });
  handlers.current = { onChange, onEnter, onPaste };

  const compartments = useMemo(() => ({ placeholder: new Compartment() }), []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          variableExtensions(),
          /*
            Tooltips go on `document.body`, not inside the editor.

            This field lives several nested scrollers deep inside a modal, and
            every one of them clips. Left where CodeMirror puts them, the hover
            and the completion list are cut off at the edge of a 26px-high URL
            bar — which is to say invisible. A fixed-position tooltip parented
            to the body escapes all of it, and is the arrangement CodeMirror
            documents for exactly this case.
          */
          tooltips({ position: "fixed", parent: document.body }),
          history(),
          EditorState.transactionFilter.of((transaction) => {
            // One line, always. A pasted newline becomes a space rather than
            // being dropped: a URL split across two lines pastes as one.
            if (!transaction.docChanged) return transaction;
            const text = transaction.newDoc.toString();
            if (!text.includes("\n") && !text.includes("\r")) return transaction;
            return {
              changes: {
                from: 0,
                to: transaction.startState.doc.length,
                insert: text.replace(/[\r\n]+/g, " "),
              },
            };
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            paste: (event, view) => {
              const text = event.clipboardData?.getData("text") ?? "";
              if (!handlers.current.onPaste?.(text)) return false;
              event.preventDefault();
              // The whole request was replaced from the clipboard, so this
              // field's own text is no longer this field's business.
              closeCompletion(view);
              return true;
            },
          }),
          keymap.of([
            {
              key: "Enter",
              run: () => {
                handlers.current.onEnter?.();
                // Always handled, so Enter never inserts a newline even where
                // there is nothing to submit to.
                return true;
              },
            },
            // `⌘Space`-free: the list opens as soon as `{{` is typed, and this
            // is for asking again after dismissing it.
            { key: "Mod-Space", run: startCompletion },
            ...completionKeymap,
            ...historyKeymap,
            ...defaultKeymap.filter((binding) => binding.key !== "Enter"),
          ]),
          compartments.placeholder.of(placeholder ? placeholderExt(placeholder) : []),
          EditorView.contentAttributes.of(ariaLabel ? { "aria-label": ariaLabel } : {}),
          /*
            Vertically centred, like the `<input>` it replaces.

            The editor is sized to its one line — `height: auto`, not 100% —
            and the wrapper is a flex box that centres it. Centring *inside*
            the editor does not work: CodeMirror's own styles give `.cm-content`
            `flex-grow` and `min-height: 100%`, so it fills whatever height it
            is given and draws its line at the top of that. Both have to be
            undone, and at that point the editor may as well be the height of
            its content and let the wrapper do the rest.

            This is what left the URL and the auth fields reading as
            top-aligned against every plain input beside them.
          */
          EditorView.theme({
            "&": { height: "auto", width: "100%" },
            ".cm-scroller": { overflow: "hidden", lineHeight: "1.45" },
            ".cm-content": {
              padding: "0",
              width: "100%",
              minHeight: "0",
              flexGrow: "0",
            },
            ".cm-line": { padding: "0" },
            "&.cm-focused": { outline: "none" },
          }),
        ],
      }),
      parent: container,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Built once; everything that changes is dispatched below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compartments]);

  /**
   * A value changed from outside — a cURL paste, a tab switch, a script.
   *
   * The caret is put back where it was rather than left to the default, which
   * for a whole-document replacement is the end. Without that, anything that
   * round-trips the value through the store while somebody is mid-word sends
   * the cursor to the end of the field on the next keystroke.
   */
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
    viewRef.current?.dispatch({ effects: scopesEffect(scopes) });
  }, [scopes]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.placeholder.reconfigure(
        placeholder ? placeholderExt(placeholder) : []
      ),
    });
  }, [compartments, placeholder]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      const view = viewRef.current;
      if (!view) return;
      view.focus();
      // To the end, as focusing a text input does. Landing at character zero
      // of a URL somebody is about to edit is not where anybody wants to be.
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    },
  }));

  return <div ref={containerRef} className={`api-var-input ${className ?? ""}`} />;
});
