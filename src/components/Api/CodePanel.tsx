/**
 * The request, as code.
 *
 * A tab in the request pane rather than a modal, because it is something people
 * read *while* editing the request beside it — every change should show up here
 * as they type, which a dialog cannot do.
 *
 * The copy button is the whole point of the panel, so it is the first thing in
 * it rather than hidden at the bottom of the code.
 */

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { RequestDraft } from "../../types/api";
import { CODE_TARGETS, CodeTarget, generate } from "../../services/api/interchange/codegen";
import { Select } from "./Select";
import { normalizeUrl } from "../../services/api/url";

interface CodePanelProps {
  draft: RequestDraft;
  target: CodeTarget;
  onTargetChange: (target: CodeTarget) => void;
}

export function CodePanel({ draft, target, onTargetChange }: CodePanelProps) {
  const [copied, setCopied] = useState(false);

  // The URL as it would actually be sent, not as it is half-typed: code that
  // says `example.com` without a scheme does not run anywhere.
  const code = generate(target, {
    method: draft.method,
    url: normalizeUrl(draft.url) || draft.url,
    headers: draft.headers,
    body: draft.body,
  });

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // A clipboard that refuses is not worth an error panel; the code is on
      // screen and can be selected.
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 h-7 shrink-0 border-b border-ft-border-subtle">
        <Select
          className="w-[180px]"
          value={target}
          options={CODE_TARGETS.map((entry) => ({ value: entry.id, label: entry.label }))}
          onChange={onTargetChange}
          ariaLabel="Language"
        />

        <button className="api-button-quiet flex items-center gap-1.5" onClick={() => void copy()}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <pre className="flex-1 min-h-0 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre text-ft-text">
        {code}
      </pre>
    </div>
  );
}
