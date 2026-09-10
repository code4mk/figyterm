import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import {
  gotoLine,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import { Compartment, EditorState, Extension, Prec, Text } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { loadLanguage } from "../../services/editor-lang";
import { editorTheme } from "./editorTheme";

/**
 * The text-editing surface: one CodeMirror view, many documents.
 *
 * Tabs are implemented by keeping an `EditorState` per buffer and swapping the
 * view's state, rather than by mounting a view per tab. That's CodeMirror's own
 * recommendation for this shape of UI and it buys three things: undo history,
 * selection and fold state survive a tab switch for free; there is exactly one
 * editor in the DOM, so character measurement is always taken from a laid-out
 * element; and twelve open files cost twelve immutable documents rather than
 * twelve live editors.
 *
 * Scroll position is the one thing an `EditorState` does *not* carry — that
 * lives in the DOM — so it's saved and restored by hand on either side of the
 * swap.
 *
 * Nothing here touches the store on a keystroke. The surface reports dirtiness
 * only when it actually changes, and the cursor to a callback the modal keeps
 * in local state, so typing re-renders the status bar and nothing else.
 */

/** Compartments are keys, not values, so one set is shared by every state. */
const languageComp = new Compartment();
const readOnlyComp = new Compartment();
const themeComp = new Compartment();
const wrapComp = new Compartment();
const indentComp = new Compartment();

/**
 * Above this, word completion stops scanning the document. It walks the whole
 * text, and on a large file that's long enough to feel it between keystrokes.
 */
const COMPLETION_MAX_DOC = 200_000;

/** How long a scanned word list stays good for. */
const COMPLETION_CACHE_MS = 1500;

export type SurfaceCommand =
  | "find"
  | "gotoLine"
  | "undo"
  | "redo"
  | "toggleWrap"
  | "selectAll";

export interface EditorSurfaceHandle {
  /** The buffer's current text, or null if it was never opened. */
  getContent: (bufferId: string) => string | null;
  /** Called after a successful save: the current document becomes the baseline. */
  markSaved: (bufferId: string) => void;
  /**
   * Replaces a buffer's text.
   *
   * `clean` decides what the new text means: `true` (the default) is a reload
   * from disk, so the text becomes the saved baseline and the buffer is no
   * longer dirty. `false` is a recovered draft — the text differs from what's
   * on disk *on purpose*, and the buffer must stay dirty so it can be saved.
   */
  setContent: (bufferId: string, content: string, options?: { clean?: boolean }) => void;
  /** Drops a closed buffer's state. */
  forget: (bufferId: string) => void;
  /** Drops every buffer's state — switching workspaces empties the tab strip. */
  forgetAll: () => void;
  focus: () => void;
  /**
   * Scrolls so `line` sits at the top, without moving the cursor.
   *
   * Used by the preview's scroll sync, which is about what's *visible* — moving
   * the caret to follow a scroll would be both surprising and, since the caret
   * is scrolled into view, circular.
   */
  scrollToLine: (line: number) => void;
  /** The first line currently visible, or null before the view exists. */
  topLine: () => number | null;
  /**
   * Re-measures after the editor was hidden. CodeMirror caches character
   * metrics, and metrics taken from a `display: none` element are all zero —
   * which is what leaves the cursor parked in the wrong column after the modal
   * is reopened.
   */
  refresh: () => void;
  /** Moves the cursor and scrolls it into view. `line` is 1-based. */
  goTo: (line: number, column?: number) => void;
  command: (command: SurfaceCommand) => void;
  isWrapped: () => boolean;
  /**
   * The buffer's cursor, or null while its state is still being built.
   *
   * The modal reads this after a tab switch rather than waiting to be told.
   * Pushing the cursor once at activation looked right and wasn't reliable:
   * a buffer's state is created asynchronously (its grammar is a dynamic
   * import), and if the user switched tabs again during that await the push
   * was skipped and the status bar kept the previous tab's line number.
   */
  getCursor: (bufferId: string) => { line: number; column: number } | null;
}

interface BufferRecord {
  state: EditorState;
  /** The document as it is on disk; dirtiness is a comparison against this. */
  savedDoc: Text;
  dirty: boolean;
  scrollTop: number;
  themeVersion: number;
  languageId: string;
  words?: { list: string[]; at: number };
}

interface EditorSurfaceProps {
  /** Null when no file is open; the surface shows an empty read-only document. */
  bufferId: string | null;
  /** Seed text, read once when a buffer is first shown. */
  initialContent: string;
  languageId: string;
  readOnly: boolean;
  /** Size-limited files skip highlighting entirely. */
  highlight: boolean;
  dark: boolean;
  fontFamily: string;
  fontSize: number;

  onDirtyChange: (bufferId: string, dirty: boolean) => void;
  onCursorChange: (line: number, column: number) => void;
  /** Fired on every document change, for draft journalling. */
  onEdited: (bufferId: string) => void;
  /** The first visible line, on every scroll. Throttled to a frame. */
  onScrollLine: (line: number) => void;

  onSave: () => void;
  onSaveAll: () => void;
  onQuickOpen: () => void;
  onGlobalSearch: () => void;
  onCloseTab: () => void;
  onToggleExplorer: () => void;
  onSelectTab: (index: number) => void;
}

/**
 * The first line visible in the scroller.
 *
 * Read by hitting the top-left of the viewport with `posAtCoords` rather than
 * doing arithmetic on scroll offsets: line heights vary once a document has
 * wrapped lines, folded ranges or a heading in a larger size, and the
 * arithmetic version drifts on exactly the documents where sync matters.
 */
function topVisibleLine(view: EditorView): number | null {
  const rect = view.scrollDOM.getBoundingClientRect();
  // A couple of pixels in, so the probe lands inside the first line's box
  // rather than on the boundary above it.
  const pos = view.posAtCoords({ x: rect.left + 8, y: rect.top + 2 });
  if (pos === null) return null;
  return view.state.doc.lineAt(pos).number;
}

/**
 * Guesses a file's indentation from its own content.
 *
 * Reformatting somebody's tab-indented file because the editor prefers two
 * spaces is the kind of change that shows up as a hundred-line diff for a
 * one-line edit, so what the file already does wins. Ties and empty files fall
 * back to two spaces.
 */
function detectIndent(content: string): string {
  let tabs = 0;
  const widths = new Map<number, number>();

  // The first few hundred indented lines are plenty, and bounding it keeps this
  // off the critical path when a large file opens.
  let seen = 0;
  for (const line of content.split("\n")) {
    if (seen >= 400) break;
    if (line.startsWith("\t")) {
      tabs++;
      seen++;
      continue;
    }
    const spaces = line.length - line.trimStart().length;
    if (spaces > 0 && spaces <= 8) {
      widths.set(spaces, (widths.get(spaces) ?? 0) + 1);
      seen++;
    }
  }

  const spaceLines = [...widths.values()].reduce((a, b) => a + b, 0);
  if (tabs > spaceLines) return "\t";

  // The most common indent *step*, not the most common depth: a file indented
  // in fours has plenty of 8s and 12s too, and the smallest frequent value is
  // the unit.
  const candidates = [2, 4, 3, 8].filter((width) => (widths.get(width) ?? 0) > 0);
  const best = candidates.sort(
    (a, b) => (widths.get(b) ?? 0) - (widths.get(a) ?? 0) || a - b
  )[0];
  return " ".repeat(best ?? 2);
}

/**
 * Completion from words already in the file.
 *
 * There is no language server here (see `docs/CODE-EDITOR.md`), so this is what
 * ⌃Space offers: the identifiers the file already contains. It is not
 * IntelliSense and doesn't pretend to be, but for the "finish this variable
 * name" case — which is most of them — it's most of the value.
 */
function wordCompletionSource(record: () => BufferRecord | null) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\w{2,}/);
    if (!before) return null;

    const doc = context.state.doc;
    if (doc.length > COMPLETION_MAX_DOC) return null;

    const current = record();
    const now = Date.now();
    let words = current?.words;

    if (!words || now - words.at > COMPLETION_CACHE_MS) {
      const found = new Set<string>();
      for (const match of doc.toString().matchAll(/[A-Za-z_$][\w$]{2,}/g)) {
        found.add(match[0]);
        if (found.size > 4000) break;
      }
      words = { list: [...found], at: now };
      if (current) current.words = words;
    }

    const typed = before.text;
    return {
      from: before.from,
      options: words.list
        // The word being typed is in the document by definition; offering it
        // back is noise.
        .filter((word) => word !== typed)
        .map((word) => ({ label: word, type: "text" })),
      validFor: /^[\w$]*$/,
    };
  };
}

export const EditorSurface = forwardRef<EditorSurfaceHandle, EditorSurfaceProps>(
  function EditorSurface(props, ref) {
    const {
      bufferId,
      initialContent,
      languageId,
      readOnly,
      highlight,
      dark,
      fontFamily,
      fontSize,
      onDirtyChange,
    } = props;

    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const records = useRef<Map<string, BufferRecord>>(new Map());
    const currentRef = useRef<string | null>(null);
    const wrappedRef = useRef(false);
    /** Last position handed to `onCursorChange`, to avoid redundant renders. */
    const reported = useRef({ line: 0, column: 0 });

    /**
     * Props the CodeMirror keymap needs to reach.
     *
     * The keymap is baked into each buffer's state, so it can't close over
     * props directly without going stale the moment a callback identity
     * changes — which for these is every render of the modal.
     */
    const handlers = useRef(props);
    handlers.current = props;

    /** Bumped on every theme change, so stale buffer states can be spotted. */
    const themeVersion = useRef(0);
    const themeRef = useRef({ dark, fontFamily, fontSize });
    themeRef.current = { dark, fontFamily, fontSize };

    const recordOf = useCallback(
      (id: string | null) => (id ? records.current.get(id) ?? null : null),
      []
    );

    const currentRecord = useCallback(() => recordOf(currentRef.current), [recordOf]);

    /** Everything that isn't per-buffer or per-theme. */
    const baseExtensions = useCallback(
      (id: string): Extension[] => [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter({ openText: "⌄", closedText: "›" }),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({
          override: [wordCompletionSource(currentRecord)],
          activateOnTyping: false,
        }),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),

        // Ahead of CodeMirror's own bindings, which claim some of the same
        // chords (`Mod-g` is find-next there, and go-to-line here).
        Prec.high(
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (handlers.current.onSave(), true) },
            {
              key: "Mod-Alt-s",
              preventDefault: true,
              run: () => (handlers.current.onSaveAll(), true),
            },
            {
              key: "Mod-p",
              preventDefault: true,
              run: () => (handlers.current.onQuickOpen(), true),
            },
            {
              key: "Mod-Shift-f",
              preventDefault: true,
              run: () => (handlers.current.onGlobalSearch(), true),
            },
            {
              key: "Mod-w",
              preventDefault: true,
              run: () => (handlers.current.onCloseTab(), true),
            },
            {
              key: "Mod-b",
              preventDefault: true,
              run: () => (handlers.current.onToggleExplorer(), true),
            },
            { key: "Mod-g", preventDefault: true, run: gotoLine },
            { key: "Mod-h", preventDefault: true, run: openSearchPanel },
            // ⌘1-9 picks a tab, matching the terminal's own tab shortcuts.
            ...Array.from({ length: 9 }, (_, index) => ({
              key: `Mod-${index + 1}`,
              preventDefault: true,
              run: () => (handlers.current.onSelectTab(index), true),
            })),
          ])
        ),

        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          // Last: Tab is a completion key first and an indent key second.
          indentWithTab,
        ]),

        EditorView.updateListener.of((update) => {
          const record = records.current.get(id);
          if (!record) return;

          // Kept in step continuously so switching tabs is a pointer swap
          // rather than a snapshot.
          record.state = update.state;

          if (update.docChanged) {
            const dirty = !update.state.doc.eq(record.savedDoc);
            if (dirty !== record.dirty) {
              record.dirty = dirty;
              handlers.current.onDirtyChange(id, dirty);
            }
            handlers.current.onEdited(id);
          }

          // Compared against the last reported position rather than gated on
          // `selectionSet`: a change anywhere before the cursor moves it
          // without the selection being explicitly set.
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          const column = head - line.from + 1;
          if (reported.current.line !== line.number || reported.current.column !== column) {
            reported.current = { line: line.number, column };
            handlers.current.onCursorChange(line.number, column);
          }
        }),
      ],
      [currentRecord]
    );

    /** Builds a buffer's state, loading its grammar first. */
    const createRecord = useCallback(
      async (
        id: string,
        content: string,
        language: string,
        readonly: boolean,
        withHighlight: boolean
      ): Promise<BufferRecord> => {
        const languageExtension = withHighlight ? await loadLanguage(language) : null;
        const doc = Text.of(content.split("\n"));
        const { dark: isDark, fontFamily: family, fontSize: size } = themeRef.current;

        const state = EditorState.create({
          doc,
          extensions: [
            ...baseExtensions(id),
            languageComp.of(languageExtension ?? []),
            readOnlyComp.of(EditorState.readOnly.of(readonly)),
            themeComp.of(editorTheme({ dark: isDark, fontFamily: family, fontSize: size })),
            wrapComp.of(wrappedRef.current ? EditorView.lineWrapping : []),
            indentComp.of(indentUnit.of(detectIndent(content))),
          ],
        });

        return {
          state,
          savedDoc: doc,
          dirty: false,
          scrollTop: 0,
          themeVersion: themeVersion.current,
          languageId: language,
        };
      },
      [baseExtensions]
    );

    // --- The view ------------------------------------------------------------

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const view = new EditorView({
        state: EditorState.create({
          extensions: [
            themeComp.of(
              editorTheme({
                dark: themeRef.current.dark,
                fontFamily: themeRef.current.fontFamily,
                fontSize: themeRef.current.fontSize,
              })
            ),
            EditorState.readOnly.of(true),
          ],
        }),
        parent: container,
      });
      viewRef.current = view;

      /*
        One listener for the life of the view: swapping buffer states reuses the
        same scroller element, so this doesn't need re-attaching per tab.
        Coalesced to a frame — a trackpad flick fires scroll events far faster
        than anything downstream can use them.
      */
      let frame = 0;
      const onScroll = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          const line = topVisibleLine(view);
          if (line !== null) handlers.current.onScrollLine(line);
        });
      };
      view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });

      return () => {
        if (frame) cancelAnimationFrame(frame);
        view.scrollDOM.removeEventListener("scroll", onScroll);
        view.destroy();
        viewRef.current = null;
      };
    }, []);

    // --- Switching buffers ---------------------------------------------------

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;

      // Remember where the outgoing buffer was scrolled to; an `EditorState`
      // doesn't carry that.
      const outgoing = recordOf(currentRef.current);
      if (outgoing) outgoing.scrollTop = view.scrollDOM.scrollTop;

      if (!bufferId) {
        currentRef.current = null;
        view.setState(
          EditorState.create({
            extensions: [
              themeComp.of(editorTheme(themeRef.current)),
              EditorState.readOnly.of(true),
            ],
          })
        );
        return;
      }

      let cancelled = false;

      const activate = async () => {
        let record = records.current.get(bufferId);
        if (!record) {
          record = await createRecord(
            bufferId,
            initialContent,
            languageId,
            readOnly,
            highlight
          );
          if (cancelled) return;
          records.current.set(bufferId, record);
        }

        // A buffer opened before the last theme change carries the old one.
        if (record.themeVersion !== themeVersion.current) {
          record.state = record.state.update({
            effects: themeComp.reconfigure(editorTheme(themeRef.current)),
          }).state;
          record.themeVersion = themeVersion.current;
        }

        currentRef.current = bufferId;
        view.setState(record.state);

        // Both deferred a frame: the view has just been handed a new state and
        // hasn't measured it, so focusing lands against stale geometry and a
        // scroll offset set now is undone when CodeMirror re-anchors.
        const restore = record.scrollTop;
        requestAnimationFrame(() => {
          if (cancelled || viewRef.current !== view) return;
          view.scrollDOM.scrollTop = restore;
          view.focus();
        });

        const head = record.state.selection.main.head;
        const line = record.state.doc.lineAt(head);
        const column = head - line.from + 1;
        reported.current = { line: line.number, column };
        handlers.current.onCursorChange(line.number, column);
      };

      void activate();
      return () => {
        cancelled = true;
      };
      // `initialContent`, `languageId`, `readOnly` and `highlight` are read only
      // when a record is first built, and belong to whichever buffer is being
      // activated — re-running on their identity would rebuild states for no
      // reason.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bufferId, createRecord, recordOf]);

    // --- Theme ---------------------------------------------------------------

    useEffect(() => {
      themeVersion.current++;
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: themeComp.reconfigure(editorTheme({ dark, fontFamily, fontSize })),
      });
      const record = currentRecord();
      if (record) {
        record.state = view.state;
        record.themeVersion = themeVersion.current;
      }
    }, [dark, fontFamily, fontSize, currentRecord]);

    // --- Language and read-only changes on the open buffer -------------------

    useEffect(() => {
      const view = viewRef.current;
      const record = currentRecord();
      if (!view || !record || record.languageId === languageId) return;

      let cancelled = false;
      void (async () => {
        const extension = highlight ? await loadLanguage(languageId) : null;
        if (cancelled || !viewRef.current) return;
        viewRef.current.dispatch({
          effects: languageComp.reconfigure(extension ?? []),
        });
        record.languageId = languageId;
        record.state = viewRef.current.state;
      })();

      return () => {
        cancelled = true;
      };
    }, [languageId, highlight, currentRecord]);

    useEffect(() => {
      const view = viewRef.current;
      const record = currentRecord();
      if (!view || !record) return;
      view.dispatch({
        effects: readOnlyComp.reconfigure(EditorState.readOnly.of(readOnly)),
      });
      record.state = view.state;
    }, [readOnly, currentRecord]);

    // --- Imperative surface --------------------------------------------------

    useImperativeHandle(
      ref,
      (): EditorSurfaceHandle => ({
        getContent: (id) => records.current.get(id)?.state.doc.toString() ?? null,

        markSaved: (id) => {
          const record = records.current.get(id);
          if (!record) return;
          record.savedDoc = record.state.doc;
          if (record.dirty) {
            record.dirty = false;
            onDirtyChange(id, false);
          }
        },

        setContent: (id, content, options) => {
          const record = records.current.get(id);
          if (!record) return;

          const clean = options?.clean !== false;
          const doc = Text.of(content.split("\n"));
          const isCurrent = currentRef.current === id;
          const view = viewRef.current;

          if (isCurrent && view) {
            // Through the view so the change is undoable — a reload the user
            // didn't expect should be reversible like anything else.
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: content },
              // Selection is clamped rather than reset: a reload from disk
              // usually leaves the user near where they were.
              selection: {
                anchor: Math.min(view.state.selection.main.anchor, content.length),
              },
            });
            record.state = view.state;
          } else {
            record.state = record.state.update({
              changes: { from: 0, to: record.state.doc.length, insert: content },
            }).state;
          }

          if (clean) {
            record.savedDoc = doc;
            if (record.dirty) {
              record.dirty = false;
              onDirtyChange(id, false);
            }
          } else {
            // A recovered draft: the baseline stays whatever is on disk, so the
            // difference between them is what makes the buffer dirty.
            const dirty = !record.state.doc.eq(record.savedDoc);
            if (dirty !== record.dirty) {
              record.dirty = dirty;
              onDirtyChange(id, dirty);
            }
          }
        },

        forget: (id) => {
          records.current.delete(id);
          if (currentRef.current === id) currentRef.current = null;
        },

        forgetAll: () => {
          records.current.clear();
          currentRef.current = null;
        },

        focus: () => viewRef.current?.focus(),

        refresh: () => {
          const view = viewRef.current;
          if (!view) return;
          view.requestMeasure();
        },

        scrollToLine: (line) => {
          const view = viewRef.current;
          if (!view) return;
          const target = Math.max(1, Math.min(line, view.state.doc.lines));
          const pos = view.state.doc.line(target).from;
          view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start" }) });
        },

        topLine: () => (viewRef.current ? topVisibleLine(viewRef.current) : null),

        goTo: (line, column = 1) => {
          const view = viewRef.current;
          if (!view) return;
          // Clamped: a stack trace can name a line past the end of a file that
          // has since been edited.
          const target = Math.max(1, Math.min(line, view.state.doc.lines));
          const found = view.state.doc.line(target);
          const position = Math.min(found.from + column - 1, found.to);
          view.dispatch({
            selection: { anchor: position },
            effects: EditorView.scrollIntoView(position, { y: "center" }),
          });
          view.focus();
        },

        command: (command) => {
          const view = viewRef.current;
          if (!view) return;
          switch (command) {
            case "find":
              openSearchPanel(view);
              break;
            case "gotoLine":
              gotoLine(view);
              break;
            case "selectAll":
              view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
              break;
            case "toggleWrap": {
              wrappedRef.current = !wrappedRef.current;
              const wrap = wrappedRef.current ? EditorView.lineWrapping : [];
              view.dispatch({ effects: wrapComp.reconfigure(wrap) });
              // Every other open buffer picks it up when it next activates.
              records.current.forEach((record) => {
                if (record.state !== view.state) {
                  record.state = record.state.update({
                    effects: wrapComp.reconfigure(wrap),
                  }).state;
                }
              });
              const record = currentRecord();
              if (record) record.state = view.state;
              break;
            }
            case "undo":
            case "redo": {
              // Imported lazily: the palette and the menu are the only callers,
              // and `historyKeymap` already covers the keyboard.
              void import("@codemirror/commands").then((mod) => {
                if (viewRef.current) {
                  (command === "undo" ? mod.undo : mod.redo)(viewRef.current);
                }
              });
              break;
            }
          }
        },

        isWrapped: () => wrappedRef.current,

        getCursor: (id) => {
          const record = records.current.get(id);
          if (!record) return null;
          // The live view is the truth for the buffer on screen; a background
          // buffer's stored state is the truth for it.
          const state =
            currentRef.current === id && viewRef.current
              ? viewRef.current.state
              : record.state;
          const head = state.selection.main.head;
          const line = state.doc.lineAt(head);
          return { line: line.number, column: head - line.from + 1 };
        },
      }),
      [currentRecord, onDirtyChange]
    );

    return <div ref={containerRef} className="editor-surface h-full w-full min-h-0" />;
  }
);
