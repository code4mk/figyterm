import { useEffect, useRef, useState } from "react";
import { useThemeStore } from "../../stores/themeStore";

/**
 * A Mermaid diagram, from a ```mermaid fence.
 *
 * ## Why this is the one thing that gets to inject markup
 *
 * `Markdown` renders everything else into React elements and never touches
 * `dangerouslySetInnerHTML`, which makes markup injection structurally
 * impossible rather than a question of sanitising correctly. A diagram cannot
 * work that way: Mermaid's whole output is an SVG document it builds itself,
 * and there is no API that hands back a tree to walk.
 *
 * So the guarantee is narrowed rather than dropped, in three ways:
 *
 * - **Only in the `document` variant**, which is the editor's preview of a
 *   file on your own disk. Release notes are remote, author-controlled text
 *   and keep the structural guarantee untouched — they show the diagram's
 *   source as a code block, exactly as before.
 * - **Only the SVG Mermaid produced**, assigned to one element this component
 *   owns, never the Markdown source. Mermaid parses the fence itself and runs
 *   DOMPurify over what it emits under its default `strict` level, which is
 *   also what stops `<a href="javascript:">` in a node label.
 * - **Scripts stripped again on the way in.** Belt and braces against a
 *   sanitiser bypass in a dependency this size: the parsed fragment is walked
 *   and any `<script>`, `<foreignObject>` or `on*` attribute is dropped before
 *   the node is adopted. Cheap, and it means a Mermaid CVE is not immediately
 *   our CVE too.
 *
 * ## Why it is loaded the way it is
 *
 * Mermaid with its graph layout engines is megabytes — far more than the
 * editor itself — so it arrives by dynamic `import()` on the first diagram
 * anybody actually previews, and a `.md` file without one never pays for it.
 * The same rule the grammars and the editor follow.
 */

/** Ids have to be unique per render; Mermaid puts them in the SVG it builds. */
let sequence = 0;

/**
 * Elements that have no business in a diagram.
 *
 * `foreignObject` is deliberately **not** here, though it is the tag that lets
 * arbitrary HTML inside an SVG. Mermaid uses it for `htmlLabels`, and while
 * that is switched off below, Mermaid 11 reads the setting per diagram type
 * and not every type has one — so a type that ignored it would have had every
 * label stripped and rendered as an elegant diagram of empty boxes. The
 * attribute scrub below is what actually closes the hole, and it reaches
 * inside a `foreignObject` like anywhere else.
 */
const FORBIDDEN = new Set(["SCRIPT", "IFRAME", "OBJECT", "EMBED"]);

function scrub(root: Element): void {
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (FORBIDDEN.has(element.tagName.toUpperCase())) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.replace(/\s+/g, "").toLowerCase();
      const isUrl = name === "href" || name === "xlink:href" || name === "src";
      if (name.startsWith("on") || (isUrl && value.startsWith("javascript:"))) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

interface MermaidProps {
  /** The fence's contents, verbatim. */
  code: string;
  /** Shown when the diagram will not parse. */
  fallback: React.ReactNode;
}

export function Mermaid({ code, fallback }: MermaidProps) {
  const host = useRef<HTMLDivElement>(null);
  const dark = useThemeStore((state) => state.theme === "dark");
  /*
    Three states, and the middle one has to exist.

    Mermaid is megabytes and arrives on first use, so there is a real gap
    between this mounting and a diagram appearing — and an empty `<div>` during
    it is indistinguishable from the feature being broken. That ambiguity cost
    a round of debugging: "nothing happens" reads the same whether the chunk is
    still downloading, the import failed outright, or the branch was never
    reached at all. Now the only way to see nothing is for this component not
    to be rendering.
  */
  const [status, setStatus] = useState<"loading" | "drawn" | "failed">("loading");
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setFailed(null);

    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        // Re-initialised per render because the theme can change under it, and
        // Mermaid reads the theme when it renders rather than when it draws.
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          /*
            Labels as SVG text rather than HTML in a `foreignObject`: one less
            way for markup to reach the document, and labels that scale and
            print properly. Set per diagram type as well as at the top level,
            because Mermaid 11 reads the per-type one where it has one — and
            a type that has neither is why `scrub` tolerates `foreignObject`
            rather than deleting it.
          */
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          class: { htmlLabels: false },
          theme: dark ? "dark" : "default",
          /*
            A real stack, not `inherit`. Mermaid measures label text to size
            the boxes around it, and it does that in a container of its own
            attached to `document.body` — where `inherit` resolves to the
            body's font and not the preview's, so the measuring and the drawing
            could disagree about the width of every node.
          */
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        });

        const id = `figy-mermaid-${++sequence}`;
        const { svg } = await mermaid.render(id, code);
        if (cancelled || !host.current) return;

        /*
          Parsed into an inert document rather than assigned as `innerHTML`, so
          nothing runs on the way through and the scrub below happens before the
          node is ever in the page.

          **Parsed as HTML, not as `image/svg+xml`.** Mermaid's output is not
          guaranteed to be well-formed XML — it emits named entities like
          `&nbsp;` in labels, and XML defines only five — so an XML parse
          returns a `parsererror` for the whole document and the diagram simply
          never appeared. HTML parsing is lenient about exactly that, and the
          HTML5 parser still puts `<svg>` and its children in the SVG namespace,
          so what comes out is a real SVG tree either way.
        */
        const parsed = new DOMParser().parseFromString(svg, "text/html");
        const root = parsed.body.querySelector("svg");
        if (!root) {
          setFailed("Mermaid returned something that was not a diagram.");
          setStatus("failed");
          return;
        }
        scrub(root);

        /*
          Mermaid's own `width` and `style` are left exactly as they are.

          Stripping them was how this came to render a silent empty box: an SVG
          carrying only a `viewBox` has no intrinsic size, and inside a flex
          container with `height: auto` it resolves to nothing at all. The
          diagram had been built, so there was no error to report, and nothing
          to see either — the worst of both.

          Fitting it to the pane is the stylesheet's job, where `max-width` and
          `height: auto` act on a box that still knows how big it wants to be.
        */

        host.current.replaceChildren(document.importNode(root, true));
        setStatus("drawn");
      } catch (error) {
        if (cancelled) return;
        /*
          A diagram that does not parse is a thing the author is still writing
          — the preview updates as they type — so this says so quietly and
          shows the source underneath rather than throwing a wall of Mermaid's
          own error text at them.
        */
        setFailed(error instanceof Error ? error.message : String(error));
        setStatus("failed");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, dark]);

  if (status === "failed" && failed !== null) {
    /*
      Mermaid's own words, trimmed to one line. "Parse error on line 3" is the
      entire answer to "why is nothing showing", and a note that only said
      something went wrong sent the author hunting through a diagram that is
      usually fine apart from one arrow.
    */
    const reason = failed.split("\n")[0].slice(0, 160);
    return (
      <div className="editor-mermaid-failed">
        <div className="editor-mermaid-note" title={failed}>
          Diagram not drawn{reason ? ` — ${reason}` : ""}
        </div>
        {fallback}
      </div>
    );
  }

  return (
    <>
      {/*
        A class, not the `hidden` attribute — the same trap `EditorModal`
        documents. Tailwind's preflight sets `[hidden] { display: none }` with
        no `!important`, and `.editor-mermaid` sets `display: flex` at equal
        specificity further down the stylesheet, so `hidden` would lose and the
        empty box would show through the loading note. Two classes beat one
        whatever the order.

        Mounted throughout rather than rendered on completion: the effect
        writes the diagram into this element, so the ref has to be attached
        before there is anything to write.
      */}
      <div
        ref={host}
        className={`editor-mermaid ${status === "drawn" ? "" : "is-pending"}`}
        role="img"
        aria-label="Diagram"
      />
      {status === "loading" && (
        <div className="editor-mermaid-failed">
          <div className="editor-mermaid-note">Drawing diagram…</div>
        </div>
      )}
    </>
  );
}
