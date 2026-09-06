import React from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";

/**
 * A deliberately small Markdown renderer for GitHub release notes.
 *
 * Release bodies are remote, user-authored content, so this never touches
 * `dangerouslySetInnerHTML` and has no HTML passthrough: everything becomes
 * React elements, which makes markup injection structurally impossible rather
 * than a matter of sanitising correctly. Unsupported syntax degrades to plain
 * text, which is the right failure mode for a changelog.
 */

const INLINE_PATTERN = new RegExp(
  [
    "(`[^`\\n]+`)", // inline code
    "(\\*\\*[^*\\n]+\\*\\*)", // bold
    "(__[^_\\n]+__)", // bold (underscore)
    "(\\*[^*\\n]+\\*)", // italic
    "(\\[[^\\]\\n]*\\]\\([^)\\s]+\\))", // [text](url)
    "(https?://[^\\s<>()\\[\\]]+)", // bare url
  ].join("|"),
  "g"
);

function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  if (!isSafeHref(href)) return <>{children}</>;
  return (
    <button
      type="button"
      onClick={() => openExternal(href).catch(() => {})}
      className="text-ft-accent hover:underline break-all text-left"
    >
      {children}
    </button>
  );
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  INLINE_PATTERN.lastIndex = 0;
  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-i${i++}`;

    if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key}
          className="px-1 py-0.5 rounded bg-ft-elevated font-mono text-[11px] text-ft-text"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(
        <strong key={key} className="font-semibold text-ft-text">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("*")) {
      nodes.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>
      );
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      nodes.push(
        <ExternalLink key={key} href={href}>
          {label || href}
        </ExternalLink>
      );
    } else {
      nodes.push(
        <ExternalLink key={key} href={token}>
          {token}
        </ExternalLink>
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];

  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index];

    // Fenced code block
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        body.push(lines[index]);
        index++;
      }
      index++; // closing fence (or end of input)
      blocks.push(
        <pre
          key={`b${key++}`}
          className="my-2 p-3 rounded-lg bg-ft-elevated overflow-x-auto text-[11px] font-mono text-ft-text-secondary"
        >
          <code>{body.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // Heading
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const size = level <= 2 ? "text-xs" : "text-[11px]";
      blocks.push(
        <div
          key={`b${key++}`}
          className={`${size} font-semibold text-ft-text mt-4 mb-1.5 first:mt-0`}
        >
          {renderInline(heading[2], `b${key}`)}
        </div>
      );
      index++;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push(<hr key={`b${key++}`} className="my-3 border-ft-border-subtle" />);
      index++;
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ""));
        index++;
      }
      blocks.push(
        <blockquote
          key={`b${key++}`}
          className="my-2 pl-3 border-l-2 border-ft-border-subtle text-ft-text-muted"
        >
          {renderInline(body.join(" "), `b${key}`)}
        </blockquote>
      );
      continue;
    }

    // Lists (unordered and ordered)
    const bullet = /^\s*[-*+]\s+(.*)$/;
    const numbered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const pattern = ordered ? numbered : bullet;
      const items: string[] = [];
      while (index < lines.length && pattern.test(lines[index])) {
        items.push(lines[index].match(pattern)![1]);
        index++;
      }
      const listKey = `b${key++}`;
      const content = items.map((item, i) => (
        <li key={`${listKey}-${i}`} className="ml-4 list-outside">
          {renderInline(item, `${listKey}-${i}`)}
        </li>
      ));
      blocks.push(
        ordered ? (
          <ol key={listKey} className="my-1.5 space-y-1 list-decimal">
            {content}
          </ol>
        ) : (
          <ul key={listKey} className="my-1.5 space-y-1 list-disc">
            {content}
          </ul>
        )
      );
      continue;
    }

    // Blank line
    if (!line.trim()) {
      index++;
      continue;
    }

    // Paragraph — consume until a blank line or the start of another block
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*(```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[index])
    ) {
      paragraph.push(lines[index].trim());
      index++;
    }
    const paraKey = `b${key++}`;
    blocks.push(
      <p key={paraKey} className="my-1.5 leading-relaxed">
        {renderInline(paragraph.join(" "), paraKey)}
      </p>
    );
  }

  return <div className="text-[11px] text-ft-text-secondary">{blocks}</div>;
}
