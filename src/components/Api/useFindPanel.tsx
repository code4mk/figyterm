/**
 * The editor window's find panel, in the API window's editors.
 *
 * `FindPanel` is already a proper React panel with a match count, regex and
 * whole-word toggles and a replace row; CodeMirror's built-in one is a text
 * box and four checkboxes with no count, which is the part people actually
 * use — without "3 of 17" there is no way to know whether Enter is about to
 * wrap. Rather than restyle the library's panel into something approximating
 * ours, this mounts ours, exactly as `EditorSurface` does.
 *
 * It is still CodeMirror's panel in the sense that matters: `createPanel`
 * hands over the panel's own DOM node, so the match highlighting, the layout
 * that pushes the text down rather than covering it, the open/close lifecycle
 * and Escape are all the library's. Only the markup is ours.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EditorView } from "@codemirror/view";
import { Extension } from "@codemirror/state";
import { search } from "@codemirror/search";
import { FindPanel } from "../Editor/FindPanel";

export interface FindPanelHost {
  /** Goes into the editor's extensions, once, at build time. */
  extension: Extension;
  /** Rendered next to the editor; null while the panel is closed. */
  render: (view: EditorView | null) => React.ReactNode;
}

export function useFindPanel(options: { allowReplace?: boolean } = {}): FindPanelHost {
  const allowReplace = options.allowReplace ?? true;

  const [host, setHost] = useState<HTMLElement | null>(null);
  /**
   * Bumped while the panel is open on anything that changes what the count
   * should say. Gated on the panel existing: this is the one thing here that
   * re-renders on a keystroke, and it must not do so otherwise.
   */
  const [tick, setTick] = useState(0);
  const open = useRef(false);

  const extension = useMemo<Extension>(
    () => [
      search({
        top: true,
        createPanel: () => {
          const dom = document.createElement("div");
          dom.className = "editor-find-host";
          return {
            dom,
            top: true,
            mount: () => {
              open.current = true;
              setHost(dom);
            },
            destroy: () => {
              open.current = false;
              // Compared before clearing: a panel that has already been
              // replaced by a newer one must not clear the newer one's host.
              setHost((current) => (current === dom ? null : current));
            },
          };
        },
      }),
      EditorView.updateListener.of((update) => {
        if (!open.current) return;
        if (update.docChanged || update.selectionSet) setTick((value) => value + 1);
      }),
    ],
    []
  );

  const render = useCallback(
    (view: EditorView | null) =>
      host && view
        ? createPortal(
            <FindPanel
              view={view}
              withReplace={false}
              tick={tick}
              allowReplace={allowReplace}
            />,
            host
          )
        : null,
    [host, tick, allowReplace]
  );

  return { extension, render };
}
