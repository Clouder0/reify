import { type as schema } from "arktype";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defineTool } from "../../defineTool.js";
import { defineKit } from "../../defineKit.js";
import type { Kit } from "../../types.js";

const fsKitName = "fs";
const fsKitSummary = "Filesystem operations (read/write/list)";
export const fsKitImport = "@reify-ai/reify/kits/fs";

function toolLink(name: string): string {
  return `reify:tool/${fsKitImport}#${name}`;
}

function docLink(name: string): string {
  return `reify:doc/${fsKitImport}#${name}`;
}

function splitLinesWithEndings(text: string): string[] {
  if (text.length === 0) return [];

  const lines: string[] = [];
  let start = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch !== 10 && ch !== 13) {
      i += 1;
      continue;
    }

    if (ch === 13 && i + 1 < text.length && text.charCodeAt(i + 1) === 10) {
      i += 2;
    } else {
      i += 1;
    }

    lines.push(text.slice(start, i));
    start = i;
  }

  if (start < text.length) {
    lines.push(text.slice(start));
  }

  return lines;
}

export const readText = defineTool({
  kit: fsKitName,
  name: "readText",
  summary: "Read a file as UTF-8 text",
  input: schema({
    path: schema("string").describe("File path to read"),
  }),
  output: schema("string"),
  doc: [
    "Read the entire contents of a file as a UTF-8 string.",
    "",
    "Example:",
    "```ts",
    'const s = await readText({ path: "README.md" });',
    "```",
  ].join("\n"),
  fn: async ({ path }) => {
    return await readFile(path, "utf8");
  },
});

export const readTextWindow = defineTool({
  kit: fsKitName,
  name: "readTextWindow",
  summary: "Read a line window from a UTF-8 text file",
  input: schema({
    path: schema("string").describe("File path to read"),
    startLine: schema("number").describe("1-based starting line").default(1),
    maxLines: schema("number").describe("Maximum number of lines (1-1000)").default(200),
  }),
  output: schema({
    text: "string",
    startLine: "number",
    endLine: "number | null",
    nextStartLine: "number | null",
  }),
  doc: [
    "Read a contiguous line window from a UTF-8 file.",
    "",
    "- Line indexing is 1-based.",
    "- Defaults: `startLine = 1` and `maxLines = 200`.",
    "- `maxLines` must be an integer between 1 and 1000.",
    "- Line endings are preserved exactly (`\\n` and `\\r\\n`).",
    "- If `startLine` is past EOF, returns `text: \"\"`, `endLine: null`, `nextStartLine: null`.",
    "- `nextStartLine: null` means there are no more lines to read.",
    "",
    "Example:",
    "```ts",
    'const out = await readTextWindow({ path: "README.md", startLine: 1, maxLines: 50 });',
    "```",
  ].join("\n"),
  fn: async ({ path, startLine, maxLines }) => {
    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new TypeError("startLine must be an integer >= 1");
    }

    if (!Number.isInteger(maxLines) || maxLines < 1) {
      throw new TypeError("maxLines must be an integer >= 1");
    }

    if (maxLines > 1000) {
      throw new TypeError("maxLines must be <= 1000");
    }

    const sourceText = await readFile(path, "utf8");
    const lines = splitLinesWithEndings(sourceText);

    if (startLine > lines.length) {
      return {
        text: "",
        startLine,
        endLine: null,
        nextStartLine: null,
      };
    }

    const window = lines.slice(startLine - 1, startLine - 1 + maxLines);
    const endLine = startLine + window.length - 1;
    return {
      text: window.join(""),
      startLine,
      endLine,
      nextStartLine: endLine < lines.length ? endLine + 1 : null,
    };
  },
});

export const writeText = defineTool({
  kit: fsKitName,
  name: "writeText",
  summary: "Write UTF-8 text to a file",
  input: schema({
    path: schema("string").describe("File path to write"),
    content: schema("string").describe("Text content"),
  }),
  output: schema({ bytesWritten: "number" }),
  doc: [
    "Write text to a file (creates or overwrites).",
    "",
    "Example:",
    "```ts",
    'await writeText({ path: "out.txt", content: "hello" });',
    "```",
  ].join("\n"),
  fn: async ({ path, content }) => {
    await writeFile(path, content, "utf8");
    return { bytesWritten: Buffer.byteLength(content, "utf8") };
  },
});

export const listDir = defineTool({
  kit: fsKitName,
  name: "listDir",
  summary: "List directory entries (optionally recursive)",
  input: schema({
    path: schema("string").describe("Directory path"),
    recursive: schema("boolean").describe("List recursively").default(false),
  }),
  output: schema("string[]"),
  doc: [
    "List directory entries.",
    "",
    "- If `recursive` is false, returns the direct entries.",
    "- If `recursive` is true, returns file paths relative to the given directory.",
    "- Recursive mode skips symlinks to avoid path cycles and dangling-link errors.",
    "",
    "Example:",
    "```ts",
    'const entries = await listDir({ path: ".", recursive: false });',
    "```",
  ].join("\n"),
  fn: async ({ path, recursive }) => {
    if (!recursive) {
      return (await readdir(path)).sort();
    }

    const out: string[] = [];

    async function walk(dir: string, prefix = ""): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const name = entry.name;
        const full = join(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;

        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(full, rel);
        else out.push(rel);
      }
    }

    await walk(path);
    return out.sort();
  },
});

export const fsKit: Kit = defineKit({
  name: fsKitName,
  summary: fsKitSummary,
  docs: {
    index: {
      summary: "Filesystem kit overview",
      doc: [
        "# fs kit",
        "",
        "Use this kit for basic local filesystem tasks.",
        "",
        "Tools:",
        `- \`${toolLink("readText")}\``,
        `- \`${toolLink("readTextWindow")}\``,
        `- \`${toolLink("writeText")}\``,
        `- \`${toolLink("listDir")}\``,
        "",
        "Docs:",
        `- \`${docLink("recipes/read-write")}\``,
      ].join("\n"),
    },
    "recipes/read-write": {
      summary: "Recipe: read-modify-write",
      doc: [
        "# Recipe: read-modify-write",
        "",
        "```ts",
        "import { readText, writeText } from \"@reify-ai/reify/kits/fs\";",
        "const s = await readText({ path: \"a.txt\" });",
        "await writeText({ path: \"a.txt\", content: s + \"\\nmore\" });",
        "```",
      ].join("\n"),
    },
    "concepts/paths": {
      summary: "Concepts: paths and cwd",
      doc: [
        "# Paths",
        "",
        "Prefer absolute paths when running from tools/agents.",
      ].join("\n"),
    },
    migrations: {
      summary: "Breaking changes and migrations",
      doc: "# Migrations\n\nNo migrations yet.",
    },
    changelog: {
      summary: "Recent changes",
      doc: "# Changelog\n\nInitial version.",
    },
  },
  tools: {
    readText,
    readTextWindow,
    writeText,
    listDir,
  },
});

export default fsKit;
