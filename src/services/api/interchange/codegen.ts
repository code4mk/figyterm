/**
 * A request, written out as code.
 *
 * The other half of cURL import: a request is worth having here only if it can
 * leave again. Someone debugging with this window and then writing the call
 * into their service should not have to retype the headers.
 *
 * Every generator writes code that runs as it stands — no placeholders, no
 * `// TODO: add headers`. The output is meant to be pasted, and something that
 * has to be finished before it works is worse than nothing, because it looks
 * finished.
 */

import { BodyField, HeaderRow, RequestBody } from "../../../types/api";
import { URLENCODED_TYPE } from "./schema";

export type CodeTarget = "curl" | "fetch" | "axios" | "python" | "go" | "php";

export const CODE_TARGETS: { id: CodeTarget; label: string }[] = [
  { id: "curl", label: "cURL" },
  { id: "fetch", label: "JavaScript · fetch" },
  { id: "axios", label: "JavaScript · axios" },
  { id: "python", label: "Python · requests" },
  { id: "go", label: "Go" },
  { id: "php", label: "PHP" },
];

export interface CodeRequest {
  method: string;
  url: string;
  headers: HeaderRow[];
  body: RequestBody;
}

function sendable(headers: HeaderRow[]): HeaderRow[] {
  return headers.filter((header) => header.enabled && header.name.trim() !== "");
}

function sendableFields(body: RequestBody): BodyField[] {
  return (body.fields ?? []).filter((field) => field.enabled && field.key.trim() !== "");
}

/**
 * The body, reduced to the three shapes a generator has to know about.
 *
 * Text covers raw, form and GraphQL — all three are a string and a content
 * type by the time they reach the wire, and the differences between them are
 * decided before this. What is left is the two that are not a string at all.
 */
type WireBody =
  | { kind: "none" }
  | { kind: "text"; text: string; contentType: string }
  | { kind: "multipart"; fields: BodyField[] }
  | { kind: "file"; path: string; contentType: string };

function wireBody(body: RequestBody): WireBody {
  switch (body.mode) {
    case "raw":
      return body.text === ""
        ? { kind: "none" }
        : { kind: "text", text: body.text, contentType: body.contentType };

    case "urlencoded": {
      const fields = sendableFields(body);
      if (fields.length === 0) return { kind: "none" };
      return {
        kind: "text",
        text: fields
          .map(
            (field) =>
              `${encodeURIComponent(field.key)}=${encodeURIComponent(field.value)}`
          )
          .join("&"),
        contentType: URLENCODED_TYPE,
      };
    }

    case "graphql":
      return body.text.trim() === ""
        ? { kind: "none" }
        : {
            kind: "text",
            text: JSON.stringify(
              {
                query: body.text,
                ...(body.graphqlVariables?.trim()
                  ? { variables: safeJson(body.graphqlVariables) }
                  : {}),
              },
              null,
              2
            ),
            contentType: "application/json",
          };

    case "formdata": {
      const fields = sendableFields(body);
      return fields.length === 0 ? { kind: "none" } : { kind: "multipart", fields };
    }

    case "file":
      return body.filePath
        ? { kind: "file", path: body.filePath, contentType: body.contentType }
        : { kind: "none" };

    default:
      return { kind: "none" };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The headers actually sent, including the content type the editor adds.
 *
 * Multipart is the exception: its type carries a boundary that the client
 * chooses, so generated code that set the header by hand would produce a
 * request the server cannot parse.
 */
function effectiveHeaders(request: CodeRequest): HeaderRow[] {
  const headers = sendable(request.headers);
  const body = wireBody(request.body);
  const hasType = headers.some((header) => header.name.toLowerCase() === "content-type");

  if (!hasType && (body.kind === "text" || body.kind === "file") && body.contentType) {
    return [
      ...headers,
      { id: "content-type", name: "Content-Type", value: body.contentType, enabled: true },
    ];
  }
  return headers;
}

/** Single quotes for a POSIX shell: the only character that matters is `'`. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function jsString(text: string): string {
  return JSON.stringify(text);
}

function curl(request: CodeRequest): string {
  const lines = [`curl --request ${request.method} \\`, `  --url ${shellQuote(request.url)}`];
  const add = (text: string) => {
    lines[lines.length - 1] += " \\";
    lines.push(text);
  };

  for (const header of effectiveHeaders(request)) {
    add(`  --header ${shellQuote(`${header.name}: ${header.value}`)}`);
  }

  const body = wireBody(request.body);
  if (body.kind === "text") add(`  --data ${shellQuote(body.text)}`);
  if (body.kind === "file") add(`  --data-binary ${shellQuote(`@${body.path}`)}`);
  if (body.kind === "multipart") {
    for (const field of body.fields) {
      if (field.kind !== "file") {
        add(`  --form ${shellQuote(`${field.key}=${field.value}`)}`);
        continue;
      }
      // The flag repeated with the same name is how curl spells several files
      // in one field, and it is what `curl.ts` reads back.
      for (const path of field.filePaths ?? [""]) {
        add(`  --form ${shellQuote(`${field.key}=@${path}`)}`);
      }
    }
  }
  return lines.join("\n");
}

/** The lines that build a `FormData`, shared by the two JavaScript targets. */
function formDataLines(fields: BodyField[]): string[] {
  const lines = ["const form = new FormData();"];
  for (const field of fields) {
    if (field.kind === "file") {
      const files = field.filePaths ?? [];
      lines.push(
        `// ${field.key}: attach ${
          files.length > 1 ? `${files.length} files` : "the file"
        } yourself — a browser cannot read ${
          files.length > 0 ? files.join(", ") : "a path"
        }`
      );
      // `append` repeated under one name is how FormData carries a list, and
      // it matches what a `multiple` file input produces.
      files.forEach((_, index) => {
        lines.push(`form.append(${jsString(field.key)}, fileInput.files[${index}]);`);
      });
      if (files.length === 0) {
        lines.push(`form.append(${jsString(field.key)}, fileInput.files[0]);`);
      }
    } else {
      lines.push(`form.append(${jsString(field.key)}, ${jsString(field.value)});`);
    }
  }
  return lines;
}

function fetchCode(request: CodeRequest): string {
  const headers = effectiveHeaders(request);
  const body = wireBody(request.body);
  const before: string[] = [];
  const parts = [`  method: ${jsString(request.method)},`];

  if (headers.length > 0) {
    parts.push("  headers: {");
    for (const header of headers) {
      parts.push(`    ${jsString(header.name)}: ${jsString(header.value)},`);
    }
    parts.push("  },");
  }

  if (body.kind === "text") parts.push(`  body: ${jsString(body.text)},`);
  if (body.kind === "multipart") {
    before.push(...formDataLines(body.fields), "");
    parts.push("  body: form,");
  }
  if (body.kind === "file") {
    before.push(
      `// The file at ${body.path}, as bytes — a browser needs it from an input.`,
      "const file = await fs.readFile(" + jsString(body.path) + ");",
      ""
    );
    parts.push("  body: file,");
  }

  return [
    ...before,
    `const response = await fetch(${jsString(request.url)}, {`,
    ...parts,
    "});",
    "",
    "console.log(await response.text());",
  ].join("\n");
}

function axios(request: CodeRequest): string {
  const headers = effectiveHeaders(request);
  const body = wireBody(request.body);
  const before: string[] = [];
  const parts = [
    `  method: ${jsString(request.method.toLowerCase())},`,
    `  url: ${jsString(request.url)},`,
  ];

  if (headers.length > 0) {
    parts.push("  headers: {");
    for (const header of headers) {
      parts.push(`    ${jsString(header.name)}: ${jsString(header.value)},`);
    }
    parts.push("  },");
  }

  if (body.kind === "text") parts.push(`  data: ${jsString(body.text)},`);
  if (body.kind === "multipart") {
    before.push(...formDataLines(body.fields), "");
    parts.push("  data: form,");
  }
  if (body.kind === "file") {
    before.push(`const file = await fs.readFile(${jsString(body.path)});`, "");
    parts.push("  data: file,");
  }

  return [
    `import axios from "axios";`,
    "",
    ...before,
    "const response = await axios({",
    ...parts,
    "});",
    "",
    "console.log(response.data);",
  ].join("\n");
}

/** Python string literals are close enough to JSON's for this purpose. */
function pythonString(text: string): string {
  return JSON.stringify(text);
}

function python(request: CodeRequest): string {
  const headers = effectiveHeaders(request);
  const body = wireBody(request.body);
  const lines = ["import requests", ""];

  if (headers.length > 0) {
    lines.push("headers = {");
    for (const header of headers) {
      lines.push(`    ${pythonString(header.name)}: ${pythonString(header.value)},`);
    }
    lines.push("}", "");
  }

  const args = [pythonString(request.url)];
  if (headers.length > 0) args.push("headers=headers");

  if (body.kind === "text") {
    lines.push(`payload = ${pythonString(body.text)}`, "");
    args.push("data=payload");
  }
  if (body.kind === "multipart") {
    const text = body.fields.filter((field) => field.kind !== "file");
    const attached = body.fields.filter((field) => field.kind === "file");
    if (text.length > 0) {
      lines.push("data = {");
      for (const field of text) {
        lines.push(`    ${pythonString(field.key)}: ${pythonString(field.value)},`);
      }
      lines.push("}", "");
      args.push("data=data");
    }
    if (attached.length > 0) {
      /*
        A dict cannot repeat a key, so a field with several files has to be
        written as the list of pairs `requests` also accepts. The dict is kept
        for the ordinary case because it is what anybody reading the snippet
        expects to see.
      */
      const repeats = attached.some((field) => (field.filePaths ?? []).length > 1);
      if (repeats) {
        lines.push("files = [");
        for (const field of attached) {
          for (const path of field.filePaths ?? []) {
            lines.push(
              `    (${pythonString(field.key)}, open(${pythonString(path)}, "rb")),`
            );
          }
        }
        lines.push("]", "");
      } else {
        lines.push("files = {");
        for (const field of attached) {
          lines.push(
            `    ${pythonString(field.key)}: open(${pythonString(
              (field.filePaths ?? [])[0] ?? ""
            )}, "rb"),`
          );
        }
        lines.push("}", "");
      }
      args.push("files=files");
    }
  }
  if (body.kind === "file") {
    lines.push(`payload = open(${pythonString(body.path)}, "rb")`, "");
    args.push("data=payload");
  }

  lines.push(
    `response = requests.request(${pythonString(request.method)}, ${args.join(", ")})`,
    "",
    "print(response.text)"
  );
  return lines.join("\n");
}

function go(request: CodeRequest): string {
  const headers = effectiveHeaders(request);
  const body = wireBody(request.body);

  const imports = ['\t"fmt"', '\t"io"', '\t"net/http"'];
  if (body.kind === "text") imports.push('\t"strings"');
  if (body.kind === "file") imports.push('\t"os"');
  if (body.kind === "multipart") {
    imports.push('\t"bytes"', '\t"mime/multipart"', '\t"os"');
    imports.sort();
  }

  const lines = ["package main", "", "import (", ...imports, ")", "", "func main() {"];

  if (body.kind === "multipart") {
    lines.push(
      "\tvar buffer bytes.Buffer",
      "\twriter := multipart.NewWriter(&buffer)"
    );
    for (const field of body.fields) {
      if (field.kind === "file") {
        // One block per attachment; the part name repeats, which is how
        // multipart carries several files under one field.
        for (const path of field.filePaths ?? [""]) {
        lines.push(
          `\tfile, err := os.Open(${jsString(path)})`,
          "\tif err != nil {",
          "\t\tpanic(err)",
          "\t}",
          `\tpart, err := writer.CreateFormFile(${jsString(field.key)}, file.Name())`,
          "\tif err != nil {",
          "\t\tpanic(err)",
          "\t}",
          "\tio.Copy(part, file)",
          "\tfile.Close()"
        );
        }
      } else {
        lines.push(
          `\twriter.WriteField(${jsString(field.key)}, ${jsString(field.value)})`
        );
      }
    }
    lines.push("\twriter.Close()", "");
  }

  const source =
    body.kind === "text"
      ? `strings.NewReader(${jsString(body.text)})`
      : body.kind === "multipart"
        ? "&buffer"
        : body.kind === "file"
          ? "file"
          : "nil";

  if (body.kind === "file") {
    lines.push(
      `\tfile, err := os.Open(${jsString(body.path)})`,
      "\tif err != nil {",
      "\t\tpanic(err)",
      "\t}",
      "\tdefer file.Close()",
      ""
    );
  }

  lines.push(
    `\treq, err := http.NewRequest(${jsString(request.method)}, ${jsString(request.url)}, ${source})`
  );
  lines.push("\tif err != nil {", "\t\tpanic(err)", "\t}");

  if (body.kind === "multipart") {
    // The boundary is the writer's, so the header has to come from it.
    lines.push('\treq.Header.Set("Content-Type", writer.FormDataContentType())');
  }

  for (const header of headers) {
    lines.push(`\treq.Header.Set(${jsString(header.name)}, ${jsString(header.value)})`);
  }

  lines.push(
    "",
    "\tres, err := http.DefaultClient.Do(req)",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tdefer res.Body.Close()",
    "",
    "\tout, _ := io.ReadAll(res.Body)",
    "\tfmt.Println(string(out))",
    "}"
  );
  return lines.join("\n");
}

/** PHP single-quoted strings escape only `\` and `'`. */
function phpString(text: string): string {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function php(request: CodeRequest): string {
  const headers = effectiveHeaders(request);
  const body = wireBody(request.body);
  const lines = [
    "<?php",
    "",
    "$curl = curl_init();",
    "",
    "curl_setopt_array($curl, [",
    `    CURLOPT_URL => ${phpString(request.url)},`,
    "    CURLOPT_RETURNTRANSFER => true,",
    `    CURLOPT_CUSTOMREQUEST => ${phpString(request.method)},`,
  ];

  if (body.kind === "text") {
    lines.push(`    CURLOPT_POSTFIELDS => ${phpString(body.text)},`);
  }
  if (body.kind === "file") {
    lines.push(`    CURLOPT_POSTFIELDS => file_get_contents(${phpString(body.path)}),`);
  }
  if (body.kind === "multipart") {
    // An array rather than a string is what makes cURL send multipart, and a
    // `CURLFile` is what makes a part a file rather than its own path as text.
    lines.push("    CURLOPT_POSTFIELDS => [");
    for (const field of body.fields) {
      if (field.kind !== "file") {
        lines.push(`        ${phpString(field.key)} => ${phpString(field.value)},`);
        continue;
      }
      const files = field.filePaths ?? [""];
      // A PHP array cannot repeat a key either, so several files under one
      // name take the `name[0]`, `name[1]` form cURL understands. One file
      // keeps the plain name, which is what nearly every snippet has.
      files.forEach((path, index) => {
        const key = files.length > 1 ? `${field.key}[${index}]` : field.key;
        lines.push(`        ${phpString(key)} => new CURLFile(${phpString(path)}),`);
      });
    }
    lines.push("    ],");
  }
  if (headers.length > 0) {
    lines.push("    CURLOPT_HTTPHEADER => [");
    for (const header of headers) {
      lines.push(`        ${phpString(`${header.name}: ${header.value}`)},`);
    }
    lines.push("    ],");
  }

  lines.push(
    "]);",
    "",
    "$response = curl_exec($curl);",
    "curl_close($curl);",
    "",
    "echo $response;"
  );
  return lines.join("\n");
}

export function generate(target: CodeTarget, request: CodeRequest): string {
  switch (target) {
    case "curl":
      return curl(request);
    case "fetch":
      return fetchCode(request);
    case "axios":
      return axios(request);
    case "python":
      return python(request);
    case "go":
      return go(request);
    case "php":
      return php(request);
  }
}
