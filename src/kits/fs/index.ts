import { type as schema } from "arktype";
import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

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

export type DirListing = {
  /** Directory basenames (sorted). */
  dirs?: string[];

  /** File basenames (sorted). */
  files?: string[];

  /**
   * Local incompleteness marker.
   * - `true`: omitted children exist but count is unknown (depth/global early-stop).
   * - `number`: omitted direct-children count (known).
   */
  more?: true | number;

  /** Unreadable directory marker (errno code preferred). */
  error?: string;
};

export type ScanTreeOutput = {
  /** Resolved absolute root path. */
  root: string;

  /** Root-relative POSIX directory path -> listing (root key is "."). */
  nodes: Record<string, DirListing>;
};

export type ScanTreeInput = {
  /** Root directory to scan. */
  path: string;

  /** Maximum expansion depth (root is 0). */
  maxDepth?: number;

  /** Global budget for emitted entries (dirs + files). */
  maxEntries?: number;

  /** Per-directory budget for emitted direct children. */
  maxEntriesPerDir?: number;

  /** Directory basenames to exclude anywhere in the tree. */
  excludeDirs?: string[];
};

const DirListingSchema = schema({
  "dirs?": "string[]",
  "files?": "string[]",
  "more?": "true | number",
  "error?": "string",
});

const NodesSchema = schema({ "[string]": DirListingSchema });
const ScanTreeOutputSchema = schema({ root: "string", nodes: NodesSchema });

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

function normalizeIntGE0(name: string, value: number, fallback: number): number {
  const n = Number.isFinite(value) ? Math.floor(value) : fallback;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`${name} must be an integer >= 0`);
  }

  return n;
}

function joinRelPosix(parent: string, name: string): string {
  return parent === "." ? name : `${parent}/${name}`;
}

function fsPathForRel(root: string, rel: string): string {
  if (rel === ".") return root;
  return join(root, ...rel.split("/"));
}

function errCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  return err instanceof Error ? err.name : "Error";
}

export const scanTree = defineTool({
  kit: fsKitName,
  name: "scanTree",
  summary: "Scan a directory into a bounded, deterministic nodes map",
  input: schema({
    path: schema("string").describe("Root directory to scan"),
    maxDepth: schema("number").describe("Maximum scan depth (0+)").default(6),
    maxEntries: schema("number").describe("Global entry budget (0+)").default(500),
    maxEntriesPerDir: schema("number").describe("Per-directory entry budget (0+)").default(50),
    excludeDirs: schema("string[]")
      .describe("Directory basenames to exclude")
      .default(() => [".git", "node_modules"]),
  }),
  output: ScanTreeOutputSchema,
  doc: [
    "Scan a directory tree into a bounded, deterministic map for progressive disclosure.",
    "",
    "Output shape:",
    "- `nodes` is a map keyed by root-relative POSIX paths (root key is `\".\"`).",
    "- Each `DirListing` contains sorted `dirs` and `files` basenames.",
    "- `more: true` means the directory exists but wasn't expanded (depth/budget).",
    "- `more: N` means `N` direct children were omitted (per-dir/global clipping).",
    "- Symlinks are skipped.",
    "",
    "Example:",
    "```ts",
    'import { scanTree, viewTree } from "@reify-ai/reify/kits/fs";',
    'const scan = await scanTree({ path: ".", maxEntries: 300 });',
    "console.log(await viewTree(scan));",
    "```",
  ].join("\n"),
  fn: async ({
    path,
    maxDepth,
    maxEntries,
    maxEntriesPerDir,
    excludeDirs,
  }: ScanTreeInput): Promise<ScanTreeOutput> => {
    const depthLimit = normalizeIntGE0("maxDepth", maxDepth ?? 6, 6);
    let remaining = normalizeIntGE0("maxEntries", maxEntries ?? 500, 500);
    const perDir = normalizeIntGE0("maxEntriesPerDir", maxEntriesPerDir ?? 50, 50);
    const exclude = new Set(excludeDirs ?? [".git", "node_modules"]);

    const root = await realpath(path);
    const st = await stat(root);
    if (!st.isDirectory()) {
      throw new TypeError("scanTree path must be an existing directory");
    }

    const nodes: Record<string, DirListing> = { ".": {} };
    const queue: Array<{ rel: string; depth: number }> = [{ rel: ".", depth: 0 }];
    const visited = new Set<string>();

    for (let i = 0; i < queue.length; i += 1) {
      const { rel, depth } = queue[i];
      if (visited.has(rel)) continue;
      visited.add(rel);

      let listing = nodes[rel];
      if (!listing) {
        listing = {};
        nodes[rel] = listing;
      }
      if (listing.error) continue;

      if (depth >= depthLimit) {
        listing.more ??= true;
        continue;
      }

      if (remaining <= 0) {
        listing.more ??= true;
        continue;
      }

      const full = fsPathForRel(root, rel);
      let entries: Dirent[];
      try {
        entries = await readdir(full, { withFileTypes: true });
      } catch (err) {
        listing.error = errCode(err);
        continue;
      }

      const dirs: string[] = [];
      const files: string[] = [];

      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;

        if (entry.isDirectory()) {
          if (exclude.has(entry.name)) continue;
          dirs.push(entry.name);
        } else {
          files.push(entry.name);
        }
      }

      dirs.sort();
      files.sort();

      const total = dirs.length + files.length;
      const includeLimit = Math.min(perDir, remaining);
      const includeDirs = dirs.slice(0, Math.min(dirs.length, includeLimit));
      const leftover = includeLimit - includeDirs.length;
      const includeFiles =
        leftover > 0 ? files.slice(0, Math.min(files.length, leftover)) : [];

      const included = includeDirs.length + includeFiles.length;
      remaining -= included;

      if (includeDirs.length > 0) listing.dirs = includeDirs;
      if (includeFiles.length > 0) listing.files = includeFiles;
      if (total > included) listing.more = total - included;

      for (const name of includeDirs) {
        const childRel = joinRelPosix(rel, name);
        let child = nodes[childRel];
        if (!child) {
          child = {};
          nodes[childRel] = child;
        }

        if (depth + 1 >= depthLimit) {
          child.more ??= true;
          continue;
        }

        queue.push({ rel: childRel, depth: depth + 1 });
      }
    }

    return { root, nodes };
  },
});

function escapeTreeName(name: string): string {
  // Preserve one-item-per-line rendering.
  return name.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

function dirSuffix(listing: DirListing | undefined): string {
  if (!listing) return "/...";
  if (listing.error) return `/! (${listing.error})`;
  if (listing.more !== undefined) {
    return listing.more === true ? "/..." : `/... (+${listing.more})`;
  }

  return "/";
}

export const viewTree = defineTool({
  kit: fsKitName,
  name: "viewTree",
  summary: "Render a scanTree() result as a compact indented tree",
  input: ScanTreeOutputSchema,
  output: schema("string"),
  doc: [
    "Render a `scanTree()` result into a token-efficient tree string.",
    "",
    "- Fixed format: 2-space indentation, directories first, then files.",
    "- `name/...` means the directory is incomplete or unexpanded.",
    "- `name/... (+N)` includes the omitted direct children count when known.",
    "- `name/! (EACCES)` indicates an unreadable directory.",
    "",
    "Example:",
    "```ts",
    'import { scanTree, viewTree } from "@reify-ai/reify/kits/fs";',
    'const scan = await scanTree({ path: "." });',
    "console.log(await viewTree(scan));",
    "```",
  ].join("\n"),
  fn: (scan: ScanTreeOutput) => {
    const nodes = scan.nodes;
    const rootListing = nodes["."];
    const rootLabel = basename(scan.root) || scan.root;
    const lines: string[] = [`${escapeTreeName(rootLabel)}${dirSuffix(rootListing)}`];
    const visited = new Set<string>();

    function renderDir(rel: string, depth: number): void {
      if (visited.has(rel)) return;
      visited.add(rel);

      const listing = nodes[rel];
      if (!listing || listing.error) return;

      const indent = "  ".repeat(depth);

      const dirs = (listing.dirs ?? []).slice().sort();
      const files = (listing.files ?? []).slice().sort();

      for (const name of dirs) {
        const childRel = rel === "." ? name : `${rel}/${name}`;
        const child = nodes[childRel];
        lines.push(`${indent}${escapeTreeName(name)}${dirSuffix(child)}`);
        renderDir(childRel, depth + 1);
      }

      for (const name of files) {
        lines.push(`${indent}${escapeTreeName(name)}`);
      }
    }

    renderDir(".", 1);
    return lines.join("\n");
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
        `- \`${toolLink("scanTree")}\``,
        `- \`${toolLink("viewTree")}\``,
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
    scanTree,
    viewTree,
  },
});

export default fsKit;
