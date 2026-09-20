/**
 * Where the `{{variables}}` are in a piece of text, and what each one means.
 *
 * `findTemplates` answers "which names are in here", which is what the strip
 * under the URL bar needs. Drawing them *in place* needs something else: the
 * exact character range of each one, including the braces, in the order they
 * appear and with the duplicates kept — because two mentions of `{{host}}` are
 * two things to colour.
 *
 * Pure, and its own module, because three separate pieces of editor machinery
 * read it — the decorations, the completion list and the hover — and an
 * off-by-one here colours the wrong half of a URL.
 */

import { isDynamic, lookup, Scope, ScopeKind } from "./template";

/** One `{{name}}` in the text. `from` and `to` span the braces too. */
export interface TemplateSpan {
  from: number;
  to: number;
  name: string;
}

/**
 * The same expression `template.ts` resolves with.
 *
 * Kept here as its own instance rather than shared: a global regex carries a
 * `lastIndex` between calls, and two modules taking turns with one would each
 * skip the matches the other had just consumed.
 */
const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function scanTemplates(text: string): TemplateSpan[] {
  const spans: TemplateSpan[] = [];
  for (const match of text.matchAll(TEMPLATE)) {
    if (match.index === undefined) continue;
    spans.push({
      from: match.index,
      to: match.index + match[0].length,
      name: match[1]!,
    });
  }
  return spans;
}

/** What a name turned out to be. */
export type TemplateState = "resolved" | "empty" | "missing" | "dynamic";

export interface TemplateMeaning {
  state: TemplateState;
  /** The value, when there is one. */
  value: string | null;
  /** Which scope answered, for the hover. */
  from: string | null;
}

/**
 * What one name means, given the scopes in play.
 *
 * `empty` is deliberately not `resolved`: a variable defined as the empty
 * string is a real answer, and it is also the single most confusing state to be
 * in — the request goes out with nothing where a token should be, and the
 * window said the variable was fine. It gets its own colour for that reason.
 */
export function meaningOf(name: string, scopes: Scope[]): TemplateMeaning {
  if (isDynamic(name)) return { state: "dynamic", value: null, from: null };

  const found = lookup(name, scopes);
  if (!found) return { state: "missing", value: null, from: null };
  return {
    state: found.value === "" ? "empty" : "resolved",
    value: found.value,
    from: found.from,
  };
}

/** The sentence a hover shows. */
export function describe(meaning: TemplateMeaning): string {
  switch (meaning.state) {
    case "dynamic":
      return "Generated fresh for every send.";
    case "missing":
      return "No value in any scope — this request will not be sent.";
    case "empty":
      return `Set to nothing, by ${meaning.from}.`;
    default:
      return `${meaning.value} — from ${meaning.from}`;
  }
}

/**
 * Whether the caret is somewhere a variable name is being typed, and what has
 * been typed so far.
 *
 * Returns the range to replace, so a completion can overwrite a half-typed name
 * rather than appending to it. `null` when the caret is not inside an open
 * `{{`, which is what stops the list appearing over ordinary text.
 *
 * The opening braces are found by scanning backwards for the nearest `{{` with
 * no `}}` between it and the caret. A regex would have to decide what a name
 * can contain before the person has finished typing it, and the answer is
 * "anything but a brace".
 */
export function completionRange(
  text: string,
  caret: number
): { from: number; to: number; typed: string } | null {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf("{{");
  if (open === -1) return null;

  const between = before.slice(open + 2);
  // A `}}` between the braces and the caret means that template is closed and
  // the caret is past it, not inside it.
  if (between.includes("}}") || between.includes("{")) return null;

  // Replace the closing braces too when they are already there, so completing
  // inside `{{ba|}}` does not leave `{{base_url}}}}`.
  const after = text.slice(caret);
  const closing = after.startsWith("}}") ? 2 : 0;

  return { from: open + 2, to: caret + closing, typed: between.trim() };
}

/** Every name a completion could offer, innermost scope first, without
 * duplicates — an inner scope's value is the one that would win. */
export function namesInScope(
  scopes: Scope[]
): { name: string; value: string; from: string; kind: ScopeKind }[] {
  const seen = new Set<string>();
  const found: { name: string; value: string; from: string; kind: ScopeKind }[] = [];

  for (const scope of scopes) {
    for (const variable of scope.variables) {
      if (!variable.enabled || variable.key === "" || seen.has(variable.key)) continue;
      seen.add(variable.key);
      found.push({
        name: variable.key,
        value: variable.value,
        from: scope.label,
        // A scope built by hand — a script's changes, a test — has no kind.
        // "environment" is what an unmarked one behaves as.
        kind: scope.kind ?? "environment",
      });
    }
  }
  return found;
}
