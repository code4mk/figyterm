/**
 * The line that appears when a send was refused.
 *
 * It used to list every variable in the request with its value, because the URL
 * bar was a plain input that could not show them. It is not any more: the bar,
 * the header values, the parameter values and the auth fields all colour their
 * own variables now and explain one on hover, so the strip was repeating —
 * under every request, permanently — what is already visible in the place it
 * applies to.
 *
 * What is left is the case none of those can cover: a request with `{{token}}`
 * and no token does not go out, because an empty `Authorization` header
 * produces a 401 that looks like a server fault and costs an afternoon. This
 * says which names are missing and offers to send anyway, for the rare case
 * where the braces were meant literally.
 */

import { TriangleAlert } from "lucide-react";

interface VariableStripProps {
  /** Names the last attempt to send could not resolve. */
  unresolved: string[];
  onSendAnyway: () => void;
  onOpenEnvironments: () => void;
}

export function VariableStrip({
  unresolved,
  onSendAnyway,
  onOpenEnvironments,
}: VariableStripProps) {
  // Nothing to say unless something is actually wrong.
  if (unresolved.length === 0) return null;

  return (
    <div className="api-variable-strip flex items-center gap-2 px-2 py-1 shrink-0 border-b border-ft-border-subtle">
      <TriangleAlert size={11} className="text-ft-warning shrink-0" />
      <span className="min-w-0 flex-1 truncate text-[10px] text-ft-warning">
        {unresolved.length === 1
          ? `{{${unresolved[0]}}} has no value, so nothing was sent.`
          : `${unresolved.length} variables have no value, so nothing was sent: ${unresolved
              .map((name) => `{{${name}}}`)
              .join(", ")}`}
      </span>
      <button className="api-chip-action shrink-0" onClick={onOpenEnvironments}>
        Set them
      </button>
      <button className="api-chip-action shrink-0" onClick={onSendAnyway}>
        Send anyway
      </button>
    </div>
  );
}
