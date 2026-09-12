/**
 * Rendering a server's documentation into a tooltip, safely.
 *
 * Hover text and completion documentation are **another program's output**, and
 * they arrive as Markdown that servers generate from source comments — which
 * means they can contain anything a comment can contain. Nothing here ever
 * touches `innerHTML`: every piece of text goes in through `textContent`, so
 * the worst a hostile string can do is look odd.
 *
 * This is deliberately not a Markdown implementation. It handles the three
 * things language servers actually emit — fenced code, inline code, and
 * paragraphs — and renders everything else as the text it is. A signature with
 * an asterisk in it should look like a signature with an asterisk in it, not
 * like the start of an emphasis run that never ends.
 */

/** Builds a tooltip body from a server's markup. */
export function renderMarkup(text: string, kind: "markdown" | "plaintext" = "markdown"): HTMLElement {
  const root = document.createElement("div");
  root.className = "cm-lsp-doc";

  if (!text.trim()) return root;

  if (kind === "plaintext") {
    const block = document.createElement("div");
    block.className = "cm-lsp-doc-text";
    block.textContent = text;
    root.append(block);
    return root;
  }

  const sections = split(text);
  let seenCode = false;

  for (const section of sections) {
    if (section.rule) {
      // Servers put a `---` between the signature and the prose. It is a real
      // separator and worth keeping as one rather than printing three dashes.
      root.append(document.createElement("hr"));
      continue;
    }

    if (section.code) {
      const pre = document.createElement("pre");
      /*
        The *first* code block is the signature — every server in the table
        leads with it — so it is styled as a header rather than as a sample.
        That is the line the tooltip exists to show, and giving it the same
        weight as an example from a doc comment buries it.
      */
      pre.className = seenCode ? "cm-lsp-doc-code" : "cm-lsp-doc-code is-signature";
      seenCode = true;
      const code = document.createElement("code");
      code.textContent = section.text;
      pre.append(code);
      root.append(pre);
    } else {
      const block = document.createElement("div");
      block.className = "cm-lsp-doc-text";
      inline(block, section.text);
      root.append(block);
    }
  }

  return root;
}

interface Section {
  code: boolean;
  rule?: boolean;
  text: string;
}

/**
 * Splits on fenced code blocks and horizontal rules — the only two pieces of
 * structure a language server's documentation reliably carries.
 */
function split(text: string): Section[] {
  const sections: Section[] = [];
  const lines = text.split("\n");

  let buffer: string[] = [];
  let inCode = false;

  const flush = (code: boolean) => {
    const joined = buffer.join("\n").replace(/^\n+|\n+$/g, "");
    if (joined) sections.push({ code, text: joined });
    buffer = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flush(inCode);
      inCode = !inCode;
      continue;
    }
    // Only outside a fence: three dashes inside one are three dashes.
    if (!inCode && /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush(false);
      sections.push({ code: false, rule: true, text: "" });
      continue;
    }
    buffer.push(line);
  }
  flush(inCode);

  return sections;
}

/**
 * Inline `code` spans, and nothing else.
 *
 * Bold and italic are left as written on purpose: they are far more often an
 * asterisk in a type signature or an underscore in an identifier than they are
 * emphasis, and getting that wrong garbles the one thing the tooltip exists to
 * show.
 */
function inline(parent: HTMLElement, text: string): void {
  const pattern = /`([^`\n]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > last) {
      parent.append(document.createTextNode(text.slice(last, match.index)));
    }
    const code = document.createElement("code");
    code.textContent = match[1];
    parent.append(code);
    last = match.index + match[0].length;
  }

  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}
