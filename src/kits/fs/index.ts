import { type as schema } from "arktype";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { classifyDirent } from "./_dirent.js";
import { LineScanner, type LineScanSink } from "./_lineScanner.js";
import { defineTool } from "../../defineTool.js";
import { defineKit } from "../../defineKit.js";
import type { Kit } from "../../types.js";

const fsKitName = "fs";
const fsKitSummary = "Bounded filesystem browsing (scan + windowed reads)";
export const fsKitImport = "@reify-ai/reify/kits/fs";

const READ_CHUNK_BYTES = 64 * 1024;

// Hard caps: callers can always request smaller budgets, but allowing arbitrarily
// large budgets defeats the kit's "bounded browsing" posture.
const MAX_SCAN_TREE_DEPTH = 32;
const MAX_SCAN_TREE_ENTRIES = 5000;
const MAX_SCAN_TREE_ENTRIES_PER_DIR = 500;

function toolLink(name: string): string {
  return `reify:tool/${fsKitImport}#${name}`;
}

function docLink(name: string): string {
  return `reify:doc/${fsKitImport}#${name}`;
}

async function scanUtf8TextFile(
  path: string,
  scanner: LineScanner,
  sink: LineScanSink,
): Promise<{ stopped: boolean }> {
  const fh = await open(path, "r");
  try {
    const decoder = new TextDecoder("utf-8");
    const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let stopped = false;

    while (!stopped) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      const chunk = decoder.decode(buf.subarray(0, bytesRead), { stream: true });
      if (chunk.length > 0) {
        stopped = scanner.write(chunk, sink);
      }
    }

    if (!stopped) {
      const tail = decoder.decode();
      if (tail.length > 0) {
        stopped = scanner.write(tail, sink);
      }
    }

    if (!stopped) {
      stopped = scanner.end(sink);
    }

    return { stopped };
  } finally {
    await fh.close();
  }
}

export type DirListing = {
  /** Directory basenames (sorted). */
  dirs?: string[];

  /** File basenames (sorted). */
  files?: string[];

  /**
   * Local incompleteness marker.
   * - `true`: directory was not expanded; contents unknown (depth/budget early-stop).
   * - `number`: omitted eligible direct-children count (known, from clipping).
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

   /** Maximum expansion depth, inclusive (root is depth 0). */
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

export const formatPath = defineTool({
  kit: fsKitName,
  name: "formatPath",
  summary: "Resolve and format a filesystem path as an absolute string",
  hidden: true,
  input: schema({
    path: schema("string").describe("Path to format (absolute or relative)"),
    cwd: schema("string")
      .describe("Base directory used to resolve relative paths")
      .default(() => process.cwd()),
    style: schema("'native' | 'posix'")
      .describe("Separator style for the returned path")
      .default("posix"),
  }),
  output: schema("string"),
  doc: [
    "Resolve + normalize a path for agent-friendly display.",
    "",
    "- Resolves `path` against `cwd` (default: `process.cwd()`).",
    "- Pure formatting: no existence checks, no `realpath`/symlink resolution.",
    "- On Windows, `style: \"posix\"` replaces `\\\\` with `/` for stable output.",
    "",
    "Example:",
    "```ts",
    'const p = await formatPath({ path: \"./foo\" });',
    "```",
  ].join("\n"),
  fn: ({ path, cwd, style }) => {
    const abs = resolve(cwd, path);
    if (style === "posix" && process.platform === "win32") {
      return abs.replace(/\\/g, "/");
    }
    return abs;
  },
});

const DEFAULT_MAX_LINE_CHARS = 1024;
const MAX_MAX_LINE_CHARS = 8192;
const TRUNCATION_MARKER = "<<<REIFY_LINE_TRUNCATED>>>";

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function safeTruncateUtf16(
  text: string,
  maxCodeUnits: number,
  opts?: { treatAsTruncated?: boolean },
): string {
  if (maxCodeUnits <= 0) return "";

  const end = Math.min(text.length, maxCodeUnits);
  if (end === 0) return "";

  // Avoid producing an unpaired high surrogate at the truncation boundary.
  const isTruncating = end < text.length || opts?.treatAsTruncated === true;
  if (isTruncating && isHighSurrogate(text.charCodeAt(end - 1))) {
    return text.slice(0, end - 1);
  }

  return text.slice(0, end);
}

const ReadTextLineWindowHintInputSchema = schema({
  path: "string",
  line: "number",
  startChar: "number",
  maxChars: "number",
});

const ReadTextLineWindowHintSchema = schema({
  toolRef: "string",
  input: ReadTextLineWindowHintInputSchema,
});

const ReadTextWindowTruncationLineSchema = schema({
  line: "number",
  shownChars: "number",
  omittedChars: "number",
  nextStartChar: "number",
  hint: ReadTextLineWindowHintSchema,
});

const ReadTextWindowTruncationSchema = schema("null").or(
  schema({
    maxLineChars: "number",
    marker: "string",
    lines: ReadTextWindowTruncationLineSchema.array(),
  }),
);

export const readTextWindow = defineTool({
  kit: fsKitName,
  name: "readTextWindow",
  summary: "Read a line window from a UTF-8 text file",
  input: schema({
    path: schema("string").describe("File path to read"),
    startLine: schema("number").describe("1-based starting line").default(1),
    maxLines: schema("number").describe("Maximum number of lines (1-1000)").default(200),
    maxLineChars: schema("number")
      .describe("Maximum characters per line before truncation (1-8192)")
      .default(DEFAULT_MAX_LINE_CHARS),
  }),
  output: schema({
    text: "string",
    startLine: "number",
    endLine: "number | null",
    nextStartLine: "number | null",
    truncation: ReadTextWindowTruncationSchema,
  }),
  doc: [
    "Read a contiguous line window from a UTF-8 file.",
    "",
    "- Line indexing is 1-based.",
    "- Defaults: `startLine = 1` and `maxLines = 200`.",
    "- `maxLines` must be an integer between 1 and 1000.",
    `- Long lines are truncated by default to \`maxLineChars = ${DEFAULT_MAX_LINE_CHARS}\` characters (excluding the line ending).`,
    "  - Character counting uses JS string offsets (UTF-16 code units). To avoid splitting surrogate pairs, the shown prefix may be shorter than maxLineChars.",
    `  - When truncated, the returned \`text\` contains an inline marker: \`${TRUNCATION_MARKER}\`.`,
    "  - Details + continuation hints are returned in the `truncation` field.",
    "- Line endings are preserved exactly (`\\n` and `\\r\\n`).",
    "- If `startLine` is past EOF, returns `text: \"\"`, `endLine: null`, `nextStartLine: null`.",
    "- `nextStartLine: null` means there are no more lines to read.",
    "",
    "Example:",
    "```ts",
    'const out = await readTextWindow({ path: "README.md", startLine: 1, maxLines: 50 });',
    "```",
  ].join("\n"),
  fn: async ({ path, startLine, maxLines, maxLineChars }) => {
    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new TypeError("startLine must be an integer >= 1");
    }

    if (!Number.isInteger(maxLines) || maxLines < 1) {
      throw new TypeError("maxLines must be an integer >= 1");
    }

    if (maxLines > 1000) {
      throw new TypeError("maxLines must be <= 1000");
    }

    if (!Number.isInteger(maxLineChars) || maxLineChars < 1) {
      throw new TypeError("maxLineChars must be an integer >= 1");
    }

    if (maxLineChars > MAX_MAX_LINE_CHARS) {
      throw new TypeError(`maxLineChars must be <= ${MAX_MAX_LINE_CHARS}`);
    }

    const windowEndLine = startLine + maxLines - 1;

    let lineNo = 0;
    let endLine: number | null = null;
    let nextStartLine: number | null = null;
    let checkingForMore = false;

    let currentContentLen = 0;
    let currentPrefix = "";
    const resetCurrent = () => {
      currentContentLen = 0;
      currentPrefix = "";
    };

    const truncations: Array<{
      line: number;
      shownChars: number;
      omittedChars: number;
      nextStartChar: number;
      hint: { toolRef: string; input: { path: string; line: number; startChar: number; maxChars: number } };
    }> = [];

    const rendered: string[] = [];

    const scanner = new LineScanner();
    const sink: LineScanSink = {
      onContent: (segment) => {
        if (checkingForMore) {
          if (segment.length > 0) {
            nextStartLine = (endLine ?? windowEndLine) + 1;
            return true;
          }
          return;
        }

        const currentLine = lineNo + 1;
        if (currentLine < startLine || currentLine > windowEndLine) return;

        currentContentLen += segment.length;
        if (currentPrefix.length < maxLineChars) {
          const remaining = maxLineChars - currentPrefix.length;
          currentPrefix += segment.slice(0, remaining);
        }
      },
      onLineEnd: (eol) => {
        if (checkingForMore) {
          nextStartLine = (endLine ?? windowEndLine) + 1;
          return true;
        }

        const completedLine = lineNo + 1;

        if (completedLine < startLine) {
          lineNo += 1;
          resetCurrent();
          return;
        }

        if (completedLine > windowEndLine) {
          lineNo += 1;
          resetCurrent();
          return;
        }

        if (currentContentLen <= maxLineChars) {
          rendered.push(`${currentPrefix}${eol}`);
        } else {
          const shown = safeTruncateUtf16(currentPrefix, maxLineChars, { treatAsTruncated: true });
          rendered.push(`${shown}${TRUNCATION_MARKER}${eol}`);
          const shownChars = shown.length;
          truncations.push({
            line: completedLine,
            shownChars,
            omittedChars: currentContentLen - shownChars,
            nextStartChar: shownChars,
            hint: {
              toolRef: toolLink("readTextLineWindow"),
              input: {
                path,
                line: completedLine,
                startChar: shownChars,
                // readTextLineWindow enforces surrogate-pair safety. If maxLineChars=1
                // and the next character is astral (2 UTF-16 code units), a maxChars=1
                // hint would be unusable.
                maxChars: Math.max(2, maxLineChars),
              },
            },
          });
        }

        endLine = completedLine;
        lineNo += 1;
        resetCurrent();

        if (completedLine === windowEndLine) {
          if (eol === "") {
            nextStartLine = null;
          } else {
            checkingForMore = true;
          }
        }
      },
    };

    await scanUtf8TextFile(path, scanner, sink);

    if (endLine === null) {
      return {
        text: "",
        startLine,
        endLine: null,
        nextStartLine: null,
        truncation: null,
      };
    }

    return {
      text: rendered.join(""),
      startLine,
      endLine,
      nextStartLine,
      truncation:
        truncations.length === 0
          ? null
          : {
              maxLineChars,
              marker: TRUNCATION_MARKER,
              lines: truncations,
            },
    };
  },
});

export const readTextLineWindow = defineTool({
  kit: fsKitName,
  name: "readTextLineWindow",
  summary: "Read a character window within a single line (helper)",
  hidden: true,
  input: schema({
    path: schema("string").describe("File path to read"),
    line: schema("number").describe("1-based line number to page within"),
    startChar: schema("number")
      .describe("0-based starting character offset within the line")
      .default(0),
    maxChars: schema("number")
      .describe("Maximum characters to return (1-8192)")
      .default(DEFAULT_MAX_LINE_CHARS),
  }),
  output: schema({
    found: "boolean",
    line: "number",
    startChar: "number",
    endChar: "number | null",
    nextStartChar: "number | null",
    text: "string",
    eol: "string",
  }),
  doc: [
    "Read a bounded character window within a single line.",
    "",
    "This is a supported-but-unlisted helper used for progressive disclosure when `readTextWindow` truncates long lines.",
    "",
    "Notes:",
    "- Line indexing is 1-based.",
    "- `startChar` and `maxChars` operate on JS string character offsets (UTF-16 code units).",
    "- The returned `text` never includes the line ending; the original ending is returned as `eol`.",
    "- `nextStartChar: null` means there are no more characters in the line.",
    "",
    "Example:",
    "```ts",
    'const chunk = await readTextLineWindow({ path: "README.md", line: 10, startChar: 0, maxChars: 200 });',
    "```",
  ].join("\n"),
  fn: async ({ path, line, startChar, maxChars }) => {
    if (!Number.isInteger(line) || line < 1) {
      throw new TypeError("line must be an integer >= 1");
    }

    if (!Number.isInteger(startChar) || startChar < 0) {
      throw new TypeError("startChar must be an integer >= 0");
    }

    if (!Number.isInteger(maxChars) || maxChars < 1) {
      throw new TypeError("maxChars must be an integer >= 1");
    }

    if (maxChars > MAX_MAX_LINE_CHARS) {
      throw new TypeError(`maxChars must be <= ${MAX_MAX_LINE_CHARS}`);
    }

    // Stream the file until we reach the target line, then page within it.
    const targetEndCandidate = startChar + maxChars;

    let lineNo = 0;
    let currentPos = 0;
    let prevCodeUnitInLine: number | null = null;

    let outText = "";
    let pendingEndSurrogateCheck = false;
    let startBoundaryChecked = startChar === 0;

    let found = false;
    let endChar: number | null = null;
    let nextStartChar: number | null = null;
    let eol = "";

    const scanner = new LineScanner();
    const sink: LineScanSink = {
      onContent: (segment) => {
        const currentLine = lineNo + 1;
        if (currentLine !== line) return;

        // If we ended exactly at the candidate boundary on the prior segment,
        // the next code unit is the first of this segment.
        if (pendingEndSurrogateCheck && segment.length > 0) {
          const nextCu = segment.charCodeAt(0);
          if (isLowSurrogate(nextCu)) {
            outText = outText.slice(0, -1);
            if (outText.length === 0) {
              throw new TypeError(
                "maxChars is too small to return a slice without splitting a surrogate pair",
              );
            }
          }
          pendingEndSurrogateCheck = false;
        }

        // Validate the start boundary when we first reach it.
        if (!startBoundaryChecked && startChar > 0) {
          const rel = startChar - currentPos;
          if (rel >= 0 && rel < segment.length) {
            const cur = segment.charCodeAt(rel);
            const prev = rel === 0 ? prevCodeUnitInLine : segment.charCodeAt(rel - 1);
            if (prev !== null && isHighSurrogate(prev) && isLowSurrogate(cur)) {
              throw new TypeError("startChar must not point into the middle of a surrogate pair");
            }
            startBoundaryChecked = true;
          }
        }

        const segStart = currentPos;
        const segEnd = currentPos + segment.length;

        const collectStart = Math.max(segStart, startChar);
        const collectEnd = Math.min(segEnd, targetEndCandidate);
        if (collectStart < collectEnd) {
          outText += segment.slice(collectStart - segStart, collectEnd - segStart);
        }

        // If we reached the candidate end within this segment, ensure we didn't split a surrogate pair.
        if (segStart < targetEndCandidate && segEnd >= targetEndCandidate) {
          const lastCu = outText.length > 0 ? outText.charCodeAt(outText.length - 1) : null;
          const endsHigh = lastCu !== null && isHighSurrogate(lastCu);

          if (segEnd > targetEndCandidate) {
            const nextCu = segment.charCodeAt(targetEndCandidate - segStart);
            if (endsHigh && isLowSurrogate(nextCu)) {
              outText = outText.slice(0, -1);
              if (outText.length === 0) {
                throw new TypeError(
                  "maxChars is too small to return a slice without splitting a surrogate pair",
                );
              }
            }
            pendingEndSurrogateCheck = false;
          } else {
            pendingEndSurrogateCheck = endsHigh;
          }
        }

        currentPos = segEnd;
        if (segment.length > 0) {
          prevCodeUnitInLine = segment.charCodeAt(segment.length - 1);
        }
      },
      onLineEnd: (lineEol) => {
        const completedLine = lineNo + 1;

        if (completedLine < line) {
          lineNo += 1;
          return;
        }

        if (completedLine === line) {
          found = true;
          eol = lineEol;
          pendingEndSurrogateCheck = false;

          const contentLen = currentPos;
          if (startChar > contentLen) {
            throw new TypeError("startChar must be <= line length");
          }

          const end = startChar + outText.length;
          endChar = end;
          nextStartChar = end < contentLen ? end : null;
          return true;
        }

        // We passed the target line; stop scanning.
        return true;
      },
    };

    await scanUtf8TextFile(path, scanner, sink);

    if (!found) {
      return {
        found: false,
        line,
        startChar,
        endChar: null,
        nextStartChar: null,
        text: "",
        eol: "",
      };
    }

    return {
      found: true,
      line,
      startChar,
      endChar,
      nextStartChar,
      text: outText,
      eol,
    };
  },
});

function normalizeIntGE0(name: string, value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be an integer >= 0`);
  }

  return value;
}

function heapSwap(heap: string[], i: number, j: number): void {
  const tmp = heap[i];
  heap[i] = heap[j];
  heap[j] = tmp;
}

// Maintain a max-heap of the smallest K strings seen so far.
function heapUpMax(heap: string[], idx: number): void {
  while (idx > 0) {
    const parent = (idx - 1) >> 1;
    if (heap[parent] >= heap[idx]) return;
    heapSwap(heap, parent, idx);
    idx = parent;
  }
}

function heapDownMax(heap: string[], idx: number): void {
  const n = heap.length;
  while (true) {
    const left = idx * 2 + 1;
    if (left >= n) return;
    const right = left + 1;
    let largest = left;
    if (right < n && heap[right] > heap[left]) largest = right;
    if (heap[idx] >= heap[largest]) return;
    heapSwap(heap, idx, largest);
    idx = largest;
  }
}

function pushSmallestK(heap: string[], value: string, k: number): void {
  if (k <= 0) return;
  if (heap.length < k) {
    heap.push(value);
    heapUpMax(heap, heap.length - 1);
    return;
  }

  // heap[0] is the largest of the kept "smallest K" values.
  if (value >= heap[0]) return;
  heap[0] = value;
  heapDownMax(heap, 0);
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
    maxDepth: schema("number")
      .describe(
        `Maximum expansion depth, inclusive (integer 0+; root is depth 0; hard cap: ${MAX_SCAN_TREE_DEPTH})`,
      )
      .default(6),
    maxEntries: schema("number")
      .describe(`Global entry budget (integer 0+; hard cap: ${MAX_SCAN_TREE_ENTRIES})`)
      .default(500),
    maxEntriesPerDir: schema("number")
      .describe(`Per-directory entry budget (integer 0+; hard cap: ${MAX_SCAN_TREE_ENTRIES_PER_DIR})`)
      .default(50),
    excludeDirs: schema("string[]")
      .describe("Directory basenames to exclude")
      .default(() => [".git", "node_modules"]),
  }),
  output: ScanTreeOutputSchema,
  doc: [
    "Scan a directory tree into a bounded, deterministic map for progressive disclosure.",
    "",
    "Depth semantics:",
    "- `maxDepth` is inclusive and root is depth 0.",
    "  - `maxDepth=0` lists only the root directory's direct children.",
    "  - `maxDepth=1` also expands those child directories.",
    "",
    "Output shape:",
    "- `root` is resolved via `realpath(path)` (a symlink passed as `path` is followed).",
    `- \`root\` uses platform-native separators; for stable display strings use the unlisted helper \`${toolLink("formatPath")}\`.`,
    "- `nodes` is a map keyed by root-relative POSIX paths (root key is `\".\"`).",
    "  - `nodes` has a null prototype; prefer `Object.hasOwn(nodes, key)` over `nodes.hasOwnProperty(...)`.",
    "- Each `DirListing` contains sorted `dirs` and `files` basenames.",
    "- Under budgets, directories are included before files.",
    "- `more: true` means the directory exists but wasn't expanded (depth/budget); contents unknown.",
    "- `more: N` means `N` eligible direct children were omitted (per-dir/global clipping).",
    "- Symlinks are skipped.",
    "- `excludeDirs` directories are omitted and not counted in `more`.",
    "",
    "Budget notes:",
    "- Budgets bound output size; scanning very large directories can still be expensive.",
    `- Hard caps: maxDepth <= ${MAX_SCAN_TREE_DEPTH}, maxEntries <= ${MAX_SCAN_TREE_ENTRIES}, maxEntriesPerDir <= ${MAX_SCAN_TREE_ENTRIES_PER_DIR}.`,
    "- To keep results deterministic and compute exact omitted counts, entries are read and classified before clipping.",
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
    const depthLimit = normalizeIntGE0("maxDepth", maxDepth ?? 6);
    let remaining = normalizeIntGE0("maxEntries", maxEntries ?? 500);
    const perDir = normalizeIntGE0("maxEntriesPerDir", maxEntriesPerDir ?? 50);

    if (depthLimit > MAX_SCAN_TREE_DEPTH) {
      throw new TypeError(`maxDepth must be <= ${MAX_SCAN_TREE_DEPTH}`);
    }

    if (remaining > MAX_SCAN_TREE_ENTRIES) {
      throw new TypeError(`maxEntries must be <= ${MAX_SCAN_TREE_ENTRIES}`);
    }

    if (perDir > MAX_SCAN_TREE_ENTRIES_PER_DIR) {
      throw new TypeError(`maxEntriesPerDir must be <= ${MAX_SCAN_TREE_ENTRIES_PER_DIR}`);
    }
    const exclude = new Set(excludeDirs ?? [".git", "node_modules"]);

    const root = await realpath(path);
    const st = await stat(root);
    if (!st.isDirectory()) {
      throw new TypeError("scanTree path must be an existing directory");
    }

    // Use a null-prototype dictionary so paths like "__proto__" are safe keys.
    const nodes = Object.create(null) as Record<string, DirListing>;
    nodes["."] = {};
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

      if (depth > depthLimit) {
        listing.more ??= true;
        continue;
      }

      if (remaining <= 0) {
        listing.more ??= true;
        continue;
      }

      const full = fsPathForRel(root, rel);
      const includeLimit = Math.min(perDir, remaining);
      let dirCount = 0;
      let fileCount = 0;
      const dirHeap: string[] = [];
      const fileHeap: string[] = [];

      let dir: Awaited<ReturnType<typeof opendir>> | undefined;
      try {
        dir = await opendir(full);
        for await (const entry of dir) {
          const kind = await classifyDirent(full, entry);
          if (kind === "skip") continue;

          if (kind === "dir") {
            if (exclude.has(entry.name)) continue;
            dirCount += 1;
            pushSmallestK(dirHeap, entry.name, includeLimit);
          } else {
            fileCount += 1;
            pushSmallestK(fileHeap, entry.name, includeLimit);
          }
        }
      } catch (err) {
        listing.error = errCode(err);
        continue;
      } finally {
        try {
          await dir?.close();
        } catch {
          // Best-effort close.
        }
      }

      const total = dirCount + fileCount;
      const includeDirCount = Math.min(dirCount, includeLimit);
      const includeFileLimit = includeLimit - includeDirCount;
      const includeDirs = includeDirCount > 0 ? dirHeap.slice().sort() : [];
      const includeFiles =
        includeFileLimit > 0 ? fileHeap.slice().sort().slice(0, includeFileLimit) : [];

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

        if (depth + 1 > depthLimit) {
          child.more ??= true;
          continue;
        }

        queue.push({ rel: childRel, depth: depth + 1 });
      }
    }

    return { root, nodes };
  },
});

function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function escapeTreeName(name: string): string {
  // Preserve one-item-per-line rendering and avoid terminal/log escape injection.
  // POSIX filenames can contain ASCII control characters (incl. ESC), so we
  // escape control characters and the most common display-spoofing Unicode
  // controls (bidi) as visible sequences.
  let out = "";
  for (let i = 0; i < name.length; i += 1) {
    const ch = name[i];
    if (ch === "\n") {
      out += "\\n";
      continue;
    }
    if (ch === "\r") {
      out += "\\r";
      continue;
    }
    if (ch === "\t") {
      out += "\\t";
      continue;
    }

    const code = ch.charCodeAt(0);
    // Escape C0 + DEL + C1 controls.
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }

    // Unicode line separators and bidi controls can break one-item-per-line or
    // spoof display order in logs/terminals.
    if (code === 0x2028 || code === 0x2029 || isBidiControl(code)) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }

    out += ch;
  }

  return out;
}

function dirSuffix(listing: DirListing | undefined): string {
  if (!listing) return "/...";
  if (listing.error) return `/! (${escapeTreeName(listing.error)})`;
  if (listing.more !== undefined) {
    return listing.more === true ? "/..." : `/... (+${listing.more})`;
  }

  return "/";
}

export const viewTree = defineTool({
  kit: fsKitName,
  name: "viewTree",
  summary: "Render a scanTree() result as a compact indented tree",
  hidden: true,
  input: ScanTreeOutputSchema,
  output: schema("string"),
  doc: [
    "Render a `scanTree()` result into a token-efficient tree string.",
    "",
    "- Fixed format: 2-space indentation, directories first, then files.",
    "- Names escape control characters for safe terminal/log rendering.",
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
    const base = basename(scan.root);
    // On Windows, path.basename("C:\\") is "". In that case, derive a label from the
    // root path by trimming trailing separators. Only do this in the root fallback
    // case so we don't corrupt legitimate POSIX basenames like "foo\\".
    const rootLabel = base || scan.root.replace(/[\\/]+$/, "");
    const lines: string[] = [`${escapeTreeName(rootLabel)}${dirSuffix(rootListing)}`];
    const visited = new Set<string>();

    function ensureSorted(names: string[] | undefined): string[] {
      if (!names || names.length <= 1) return names ?? [];
      for (let i = 1; i < names.length; i += 1) {
        if (names[i - 1] > names[i]) return names.slice().sort();
      }
      return names;
    }

    function walk(rel: string, depth: number): void {
      if (visited.has(rel)) return;
      visited.add(rel);

      const listing = nodes[rel];
      if (!listing || listing.error) return;

      const indent = "  ".repeat(depth);

      for (const name of ensureSorted(listing.dirs)) {
        const childRel = rel === "." ? name : `${rel}/${name}`;
        lines.push(`${indent}${escapeTreeName(name)}${dirSuffix(nodes[childRel])}`);
        walk(childRel, depth + 1);
      }

      for (const name of ensureSorted(listing.files)) {
        lines.push(`${indent}${escapeTreeName(name)}`);
      }
    }

    walk(".", 1);

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
        "Use this kit for bounded filesystem browsing and reading.",
        "",
        "Primary tools:",
        `- \`${toolLink("scanTree")}\``,
        `- \`${toolLink("readTextWindow")}\``,
        "",
        "Supported-but-unlisted helpers:",
        `- \`${toolLink("readTextLineWindow")}\``,
        `- \`${toolLink("viewTree")}\``,
        `- \`${toolLink("formatPath")}\``,
        "",
        "Docs:",
        `- \`${docLink("recipes/browse-read")}\``,
      ].join("\n"),
    },
    "recipes/browse-read": {
      summary: "Recipe: browse + read",
      doc: [
        "# Recipe: browse + read",
        "",
        "```ts",
        "import { scanTree, viewTree, readTextWindow } from \"@reify-ai/reify/kits/fs\";",
        "",
        "const scan = await scanTree({ path: \".\", maxEntries: 300 });",
        "console.log(await viewTree(scan));",
        "",
        "const page = await readTextWindow({ path: \"README.md\", startLine: 1, maxLines: 80 });",
        "console.log(page.text);",
        "if (page.truncation) console.log(page.truncation);",
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
      doc: [
        "# Migrations",
        "",
        "## Unreleased",
        "",
        "- Removed legacy/unbounded tools: `readText`, `writeText`, `listDir`.",
        "- `readTextWindow` now truncates very long lines by default and returns `truncation` metadata.",
        `  - Use the supported-but-unlisted helper \`${toolLink("readTextLineWindow")}\` to page within a long line.`,
        "- `scanTree` now enforces hard caps on maxDepth/maxEntries/maxEntriesPerDir to keep results bounded.",
        "- Use `readTextWindow` for bounded reads.",
        "- Use `scanTree` (and supported-but-unlisted `viewTree`) for browsing.",
      ].join("\n"),
    },
    changelog: {
      summary: "Recent changes",
      doc: [
        "# Changelog",
        "",
        "- Refined the fs kit surface to bounded browse/read tools; removed legacy helpers.",
        "- `readTextWindow` now truncates very long lines by default; added hidden `readTextLineWindow` helper.",
      ].join("\n"),
    },
  },
  tools: {
    formatPath,
    readTextLineWindow,
    readTextWindow,
    scanTree,
    viewTree,
  },
});

export default fsKit;
