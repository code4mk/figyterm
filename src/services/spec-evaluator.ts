/**
 * Evaluates a raw .ts spec file at runtime.
 *
 * Strips TypeScript-specific syntax (type annotations, interfaces, imports)
 * and evaluates the remaining JavaScript to extract the default export.
 */
export function evaluateSpec(tsContent: string): unknown {
  let code = tsContent;

  // Remove // @ts-nocheck and similar
  code = code.replace(/\/\/\s*@ts-\w+.*/g, "");

  // Remove import statements
  code = code.replace(/^import\s+.*?;?\s*$/gm, "");

  // Remove interface/type declarations (single and multi-line)
  code = code.replace(/^(export\s+)?(interface|type)\s+\w+[\s\S]*?^\}/gm, "");

  // Remove type annotations on declarations:
  // `: Figy.Spec =`, `: Figy.Generator["postProcess"] =`, `: Record<string, Figy.Arg> =`
  code = code.replace(/:\s*(?:Figy|Fig)\.\w+(?:\[["'\w]+\])?(?:\[\])?\s*=/g, " =");
  code = code.replace(/:\s*Record<[^>]+>\s*=/g, " =");
  code = code.replace(/:\s*(?:Partial|Required|Readonly|Pick|Omit)<[^>]+>\s*=/g, " =");

  // Remove simple type annotations: `: string`, `: number`, `: boolean`, `: any`
  code = code.replace(/:\s*(string|number|boolean|any|void|never|unknown)(\[\])?\s*/g, " ");

  // Remove `as Figy.X[]` or `as Figy.X` casts
  code = code.replace(/\s+as\s+(?:Figy|Fig)\.\w+(?:\[\])?\s*/g, " ");
  code = code.replace(/\s+as\s+const/g, "");

  // Remove `export default completionSpec;` and capture the variable name
  const defaultExportMatch = code.match(/export\s+default\s+(\w+)\s*;?/);
  if (defaultExportMatch) {
    code = code.replace(/export\s+default\s+\w+\s*;?/, "");
  }

  // Remove `export` keyword from remaining declarations
  code = code.replace(/^export\s+/gm, "");

  // Build the evaluation: wrap in a function that returns the spec
  const varName = defaultExportMatch?.[1] || "completionSpec";

  const wrapped = `
    (function() {
      ${code}
      return typeof ${varName} !== 'undefined' ? ${varName} : null;
    })()
  `;

  try {
    // eslint-disable-next-line no-eval
    const result = eval(wrapped);
    return result;
  } catch (err) {
    console.error("[spec-evaluator] Failed to evaluate spec:", err);
    return null;
  }
}
