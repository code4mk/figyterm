/**
 * A data file: one row per iteration, each row a set of variables.
 *
 * This is what turns a run of one request into a run of fifty — the same call
 * against fifty rows of a CSV. The format supports CSV and JSON, and so does
 * this.
 *
 * The CSV reader is written rather than borrowed because the one rule that
 * matters is quoting: a column holding `{"a": 1, "b": 2}` has a comma in it,
 * and a reader that splits on commas turns one row into two and every
 * subsequent column into the wrong one. That failure is silent — the run goes
 * green against nonsense — which is why it is worth fifty lines and a test.
 */

/** Every value is a string: it is going into a `{{template}}`. */
export type DataRow = Record<string, string>;

export interface DataFile {
  rows: DataRow[];
  /** The columns, in the order the file had them. */
  columns: string[];
  /** Anything worth saying about the file — never a reason to refuse it. */
  notes: string[];
}

const EMPTY: DataFile = { rows: [], columns: [], notes: [] };

/**
 * Splits one CSV line into its fields.
 *
 * Quoted fields may hold commas, newlines and doubled quotes (`""` for one).
 * Exported because the line splitting above it has to know where a quoted field
 * ends, and the two are easier to follow apart than folded together.
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index]!;

    if (quoted) {
      if (character === '"') {
        // A doubled quote inside a quoted field is one quote.
        if (line[index + 1] === '"') {
          current += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === ",") {
      fields.push(current);
      current = "";
      continue;
    }
    current += character;
  }

  fields.push(current);
  return fields;
}

/**
 * Splits a CSV into lines, keeping a newline inside a quoted field.
 *
 * A JSON column spanning two lines is the case this exists for; splitting on
 * `\n` first would cut it in half.
 */
function csvLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;

    if (character === '"') {
      quoted = !quoted || text[index + 1] === '"';
      if (quoted && text[index + 1] === '"') index++;
      current += character;
      continue;
    }

    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && text[index + 1] === "\n") index++;
      lines.push(current);
      current = "";
      continue;
    }
    current += character;
  }

  if (current !== "") lines.push(current);
  return lines;
}

export function readCsv(text: string): DataFile {
  const lines = csvLines(text).filter((line) => line.trim() !== "");
  if (lines.length === 0) return { ...EMPTY, notes: ["The file is empty."] };

  const columns = splitCsvLine(lines[0]!).map((column) => column.trim());
  const notes: string[] = [];
  const rows: DataRow[] = [];

  for (const line of lines.slice(1)) {
    const fields = splitCsvLine(line);
    const row: DataRow = {};
    columns.forEach((column, index) => {
      if (column !== "") row[column] = fields[index] ?? "";
    });
    rows.push(row);
  }

  if (columns.some((column) => column === "")) {
    notes.push("A column with no name was skipped.");
  }
  return { rows, columns: columns.filter((column) => column !== ""), notes };
}

export function readJsonData(text: string): DataFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ...EMPTY, notes: [`That is not valid JSON: ${(error as Error).message}`] };
  }

  if (!Array.isArray(parsed)) {
    return { ...EMPTY, notes: ["A JSON data file is a list of objects, one per iteration."] };
  }

  const columns: string[] = [];
  const rows: DataRow[] = parsed.map((entry) => {
    const row: DataRow = {};
    if (typeof entry !== "object" || entry === null) return row;
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      if (!columns.includes(key)) columns.push(key);
      // Everything becomes text: it is going into a `{{template}}`, and a
      // number that arrived as a number must not become "1.0" on the way.
      row[key] =
        value === null || value === undefined
          ? ""
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value);
    }
    return row;
  });

  return { rows, columns, notes: [] };
}

/** Reads whichever it is, from the file's name and its contents. */
export function readDataFile(text: string, name: string): DataFile {
  const looksJson = name.toLowerCase().endsWith(".json") || text.trimStart().startsWith("[");
  return looksJson ? readJsonData(text) : readCsv(text);
}
