import { type as schema } from "arktype";
import { spawn } from "node:child_process";
import { open, opendir, readFile, realpath, rename, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { classifyDirent } from "./_dirent.js";
import { LineScanner, type LineScanSink } from "./_lineScanner.js";
import { collectTailLineRanges, type TailLineRange } from "./_tailLines.js";
import { runRipgrepJson, type RunRipgrepJsonResult } from "./_ripgrepJson.js";
import { defineTool } from "../../defineTool.js";
import { defineKit } from "../../defineKit.js";
import type { Kit } from "../../types.js";

const fsKitName = "fs";
const fsKitSummary = "Bounded filesystem browsing (scan + search + windowed reads + CAS edits)";
export const fsKitImport = "@reify-ai/reify/kits/fs";

const READ_CHUNK_BYTES = 64 * 1024;

// Hard caps: callers can always request smaller budgets, but allowing arbitrarily
// large budgets defeats the kit's "bounded browsing" posture.
const MAX_SCAN_TREE_DEPTH = 32;
const MAX_SCAN_TREE_ENTRIES = 5000;
const MAX_SCAN_TREE_ENTRIES_PER_DIR = 500;

const MAX_SEARCH_TEXT_MATCHES = 1000;
const MAX_SEARCH_TEXT_FILES_WITH_MATCHES = 200;
const MAX_SEARCH_TEXT_MATCHES_PER_FILE = 200;
const MAX_SEARCH_TEXT_PREVIEW_CHARS = 1024;
const MAX_SEARCH_TEXT_TIMEOUT_MS = 60_000;
const MAX_SEARCH_TEXT_CONTEXT_LINES = 20;

const DEFAULT_SEARCH_TEXT_RG_JSON_LINE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_TEXT_RG_JSON_LINE_BYTES = 8 * 1024 * 1024;

const DEFAULT_EDIT_TEXT_MAX_CHARS = 1024 * 1024; // 1MB max file size

const MIN_RIPGREP_VERSION = { major: 14, minor: 1, patch: 1 };
const MIN_RIPGREP_VERSION_TEXT = `${MIN_RIPGREP_VERSION.major}.${MIN_RIPGREP_VERSION.minor}.${MIN_RIPGREP_VERSION.patch}`;

const DEFAULT_SCAN_TREE_EXCLUDE_DIRS = [
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "target",
  ".cache",
];

type Semver = { major: number; minor: number; patch: number };

function formatSemver(v: Semver): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

function parseRipgrepVersion(text: string): Semver | null {
  const m = /ripgrep\s+(\d+)\.(\d+)\.(\d+)/i.exec(text);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

async function readRipgrepVersion(rgPath: string, cwd: string): Promise<Semver> {
  const MAX_STDOUT_BYTES = 8 * 1024;
  const MAX_STDERR_BYTES = 8 * 1024;
  const timeoutMs = 2_000;

  return await new Promise((resolve, reject) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(rgPath, ["--version"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: useProcessGroup,
    });

    const killChild = (signal: NodeJS.Signals) => {
      try {
        if (useProcessGroup && typeof child.pid === "number") {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // ignore
      }
    };

    let done = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
    };

    const settleReject = (err: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    const settleResolve = (v: Semver) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(v);
    };

    timer = setTimeout(() => {
      timedOut = true;
      killChild("SIGKILL");
      // Ensure we settle even if the child never closes (e.g. uninterruptible I/O).
      try {
        child.stdout?.destroy();
      } catch {
        // ignore
      }
      try {
        child.stderr?.destroy();
      } catch {
        // ignore
      }
      try {
        child.unref();
      } catch {
        // ignore
      }
       const safeRgPath = sanitizeForSingleLineError(rgPath);
       settleReject(
         new TypeError(`ripgrep --version timed out after ${timeoutMs}ms (rgPath: ${safeRgPath})`),
       );
     }, timeoutMs);

    child.on("error", (e) => {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") {
        const safeRgPath = sanitizeForSingleLineError(rgPath);
        settleReject(new TypeError(`ripgrep executable not found (rgPath: ${safeRgPath})`));
        return;
      }
      settleReject(e instanceof Error ? e : new TypeError(String(e)));
    });

    child.stdout?.on("error", (e) => {
      settleReject(e instanceof Error ? e : new TypeError(String(e)));
    });

    child.stderr?.on("error", (e) => {
      settleReject(e instanceof Error ? e : new TypeError(String(e)));
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= MAX_STDOUT_BYTES) return;
      const remaining = MAX_STDOUT_BYTES - stdoutBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stdout += slice.toString("utf8");
      stdoutBytes += slice.length;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const remaining = MAX_STDERR_BYTES - stderrBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stderr += slice.toString("utf8");
      stderrBytes += slice.length;
    });

    child.on("close", (exitCode) => {
      if (done) return;
      cleanup();
      if (timedOut) {
        const safeRgPath = sanitizeForSingleLineError(rgPath);
        settleReject(
          new TypeError(`ripgrep --version timed out after ${timeoutMs}ms (rgPath: ${safeRgPath})`),
        );
        return;
      }
      if (exitCode !== 0) {
        const firstLineRaw = `${stderr}\n${stdout}`.trim().split(/\r?\n/)[0];
        const firstLine = sanitizeForSingleLineError(firstLineRaw);
        const safeRgPath = sanitizeForSingleLineError(rgPath);
        settleReject(
          new TypeError(
            firstLine
              ? `ripgrep --version failed: ${firstLine} (rgPath: ${safeRgPath})`
              : `ripgrep --version failed (exit code ${exitCode}; rgPath: ${safeRgPath})`,
          ),
        );
        return;
      }

      const v = parseRipgrepVersion(stdout) ?? parseRipgrepVersion(stderr);
      if (!v) {
        const firstLineRaw = `${stdout}\n${stderr}`.trim().split(/\r?\n/)[0];
        const firstLine = sanitizeForSingleLineError(firstLineRaw);
        const safeRgPath = sanitizeForSingleLineError(rgPath);
        settleReject(
          new TypeError(
            firstLine
              ? `failed to parse ripgrep version: ${firstLine} (rgPath: ${safeRgPath})`
              : `failed to parse ripgrep version (rgPath: ${safeRgPath})`,
          ),
        );
        return;
      }

      settleResolve(v);
    });
  });
}

const ripgrepVersionCheckCache = new Map<string, Promise<void>>();

async function ensureRipgrepVersion(rgPath: string, cwd: string): Promise<void> {
  let cached = ripgrepVersionCheckCache.get(rgPath);
  if (!cached) {
    cached = (async () => {
      const v = await readRipgrepVersion(rgPath, cwd);
      if (compareSemver(v, MIN_RIPGREP_VERSION) < 0) {
        const safeRgPath = sanitizeForSingleLineError(rgPath);
        throw new TypeError(
          `ripgrep >= ${MIN_RIPGREP_VERSION_TEXT} is required (found ${formatSemver(v)}; rgPath: ${safeRgPath})`,
        );
      }
    })();
    ripgrepVersionCheckCache.set(rgPath, cached);
  }

  await cached;
}

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

async function scanUtf8TextRange(
  fh: FileHandle,
  startByte: number,
  endByteExclusive: number,
  onText: (segment: string) => void,
): Promise<void> {
  if (!Number.isInteger(startByte) || startByte < 0) {
    throw new TypeError("startByte must be an integer >= 0");
  }
  if (!Number.isInteger(endByteExclusive) || endByteExclusive < 0) {
    throw new TypeError("endByteExclusive must be an integer >= 0");
  }
  if (endByteExclusive < startByte) {
    throw new TypeError("endByteExclusive must be >= startByte");
  }
  if (endByteExclusive === startByte) return;

  const decoder = new TextDecoder("utf-8");
  const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let pos = startByte;

  while (pos < endByteExclusive) {
    const toRead = Math.min(buf.length, endByteExclusive - pos);
    const { bytesRead } = await fh.read(buf, 0, toRead, pos);
    if (bytesRead === 0) break;

    const chunk = decoder.decode(buf.subarray(0, bytesRead), { stream: true });
    if (chunk.length > 0) onText(chunk);
    pos += bytesRead;
  }

  const tail = decoder.decode();
  if (tail.length > 0) onText(tail);
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
    startLine: schema("number")
      .describe("Starting line: 1-based from start; negative from end (-1 is last line)")
      .default(1),
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
    "- Line indexing: 1-based from start; negative from end (-1 is last line).",
    "- `startLine` must be a non-zero integer (>= 1 or <= -1).",
    "  - If `startLine` is negative and its magnitude exceeds the file's line count, it clamps to the first line.",
    "- Defaults: `startLine = 1` and `maxLines = 200`.",
    "- `maxLines` must be an integer between 1 and 1000.",
    `- Long lines are truncated by default to \`maxLineChars = ${DEFAULT_MAX_LINE_CHARS}\` characters (excluding the line ending).`,
    "  - Character counting uses JS string offsets (UTF-16 code units). To avoid splitting surrogate pairs, the shown prefix may be shorter than maxLineChars.",
    `  - When truncated, the returned \`text\` contains an inline marker: \`${TRUNCATION_MARKER}\`.`,
    "  - Details + continuation hints are returned in the `truncation` field.",
    "- Line endings are preserved exactly (`\\n`, `\\r`, and `\\r\\n`).",
    "- If `startLine` is past EOF, returns `text: \"\"`, `endLine: null`, `nextStartLine: null`.",
    "- `nextStartLine: null` means there are no more lines to read.",
    "",
    "Example:",
    "```ts",
    'const out = await readTextWindow({ path: "README.md", startLine: 1, maxLines: 50 });',
    "```",
  ].join("\n"),
  fn: async ({ path, startLine, maxLines, maxLineChars }) => {
    if (!Number.isInteger(startLine) || startLine === 0) {
      throw new TypeError("startLine must be an integer >= 1 or <= -1");
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

    if (startLine < 0) {
      const kRequested = -startLine;

      const fh = await open(path, "r");
      try {
        const keep = Math.min(maxLines, kRequested);
        const { ranges: tailRanges, available } = await collectTailLineRanges(fh, kRequested, { keep });

        if (available === 0) {
          return {
            text: "",
            startLine,
            endLine: null,
            nextStartLine: null,
            truncation: null,
          };
        }

        const resolvedStartLine = available < kRequested ? -available : startLine;
        // tailRanges are returned from EOF backward; reverse for output order.
        const windowRanges = tailRanges.slice().reverse();

        const truncations: Array<{
          line: number;
          shownChars: number;
          omittedChars: number;
          nextStartChar: number;
          hint: { toolRef: string; input: { path: string; line: number; startChar: number; maxChars: number } };
        }> = [];

        const rendered: string[] = [];

        for (let i = 0; i < windowRanges.length; i += 1) {
          const range: TailLineRange = windowRanges[i];
          const lineNo = resolvedStartLine + i;

          let contentLen = 0;
          let prefix = "";
          await scanUtf8TextRange(fh, range.startByte, range.endByte, (segment) => {
            contentLen += segment.length;
            if (prefix.length < maxLineChars) {
              const remaining = maxLineChars - prefix.length;
              prefix += segment.slice(0, remaining);
            }
          });

          if (contentLen <= maxLineChars) {
            rendered.push(`${prefix}${range.eol}`);
          } else {
            const shown = safeTruncateUtf16(prefix, maxLineChars, { treatAsTruncated: true });
            rendered.push(`${shown}${TRUNCATION_MARKER}${range.eol}`);
            const shownChars = shown.length;
            truncations.push({
              line: lineNo,
              shownChars,
              omittedChars: contentLen - shownChars,
              nextStartChar: shownChars,
              hint: {
                toolRef: toolLink("readTextLineWindow"),
                input: {
                  path,
                  line: lineNo,
                  startChar: shownChars,
                  maxChars: Math.max(2, maxLineChars),
                },
              },
            });
          }
        }

        const endLine = resolvedStartLine + windowRanges.length - 1;
        const nextStartLine = endLine === -1 ? null : endLine + 1;

        return {
          text: rendered.join(""),
          startLine: resolvedStartLine,
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
      } finally {
        await fh.close();
      }
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
    line: schema("number")
      .describe("Line number: 1-based from start; negative from end (-1 is last line)"),
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
    "- Line indexing: 1-based from start; negative from end (-1 is last line).",
    "  - If `line` is negative and its magnitude exceeds the file's line count, returns `found: false`.",
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
    if (!Number.isInteger(line) || line === 0) {
      throw new TypeError("line must be an integer >= 1 or <= -1");
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

    if (line < 0) {
      const k = -line;
      const fh = await open(path, "r");
      try {
        const { ranges, available } = await collectTailLineRanges(fh, k, { keep: 1 });
        if (available < k) {
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

        const target = ranges[0];
        const targetEndCandidate = startChar + maxChars;

        let currentPos = 0;
        let prevCodeUnitInLine: number | null = null;

        let outText = "";
        let pendingEndSurrogateCheck = false;
        let startBoundaryChecked = startChar === 0;

        await scanUtf8TextRange(fh, target.startByte, target.endByte, (segment) => {
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
        });

        const contentLen = currentPos;
        if (startChar > contentLen) {
          throw new TypeError("startChar must be <= line length");
        }

        const end = startChar + outText.length;
        return {
          found: true,
          line,
          startChar,
          endChar: end,
          nextStartChar: end < contentLen ? end : null,
          text: outText,
          eol: target.eol,
        };
      } finally {
        await fh.close();
      }
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
      .describe("Directory basenames to exclude (defaults skip common deps/env/cache dirs)")
      .default(() => [...DEFAULT_SCAN_TREE_EXCLUDE_DIRS]),
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
    "  - Defaults: `.git`, `node_modules`, `.venv`, `venv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `target`, `.cache`.",
    "  - Override by passing `excludeDirs` explicitly (for example `excludeDirs: []` to include everything).",
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
    const exclude = new Set(excludeDirs ?? DEFAULT_SCAN_TREE_EXCLUDE_DIRS);

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

type SearchTextInput = {
  /** Root directory to search. */
  path: string;

  /** Ripgrep pattern (regex by default). */
  pattern: string;

  /** Treat pattern as a literal string. */
  fixedStrings?: boolean;

  /** If set, forces case sensitivity. When unset, smartCase controls behavior. */
  caseSensitive?: boolean;

  /** Enable smart-case matching (default true). */
  smartCase?: boolean;

  /** Include dotfiles and dot-directories (default true). */
  hidden?: boolean;

  /** Respect ignore files (.gitignore, .ignore, etc). Default true. */
  respectIgnore?: boolean;

  /**
   * Ignore behavior policy when respectIgnore is true.
   *
   * - "scoped" (default): deterministic, root-scoped ignore discovery.
   * - "rg": ripgrep defaults (may consult global ignore, parent ignore files, etc).
   */
  ignorePolicy?: "scoped" | "rg";

  /** Directory basenames to exclude anywhere in the tree. */
  excludeDirs?: string[];

  /** Global matching-line cap. */
  maxMatches?: number;

  /** Maximum number of files (with matches) to return. */
  maxFilesWithMatches?: number;

  /** Maximum matching lines to return per file. */
  maxMatchesPerFile?: number;

  /** Maximum characters to include in the preview line (excluding EOL). */
  maxPreviewChars?: number;

  /** Lines before a match to include in the readTextWindow hint. */
  contextLinesBefore?: number;

  /** Lines after a match to include in the readTextWindow hint. */
  contextLinesAfter?: number;

  /** Kill rg if it runs too long (default 15000ms). */
  timeoutMs: number;

  /** Maximum bytes allowed for any single rg --json record line. */
  maxRgJsonLineBytes: number;
};

type SearchTextSubmatch = {
  startByte: number;
  endByte: number;
};

type SearchTextMatch = {
  line: number;
  preview: string;
  submatches: SearchTextSubmatch[];
  hint: { toolRef: string; input: { path: string; startLine: number; maxLines: number } };
};

type SearchTextFile = {
  path: string;
  displayPath: string;
  matches: SearchTextMatch[];
  more: boolean;
};

type SearchTextStats = {
  searches: number;
  searchesWithMatch: number;
  matchedLines: number;
  matches: number;
  bytesSearched: number;
  elapsedMs: number;
};

type SearchTextOutput = {
  root: string;
  pattern: string;
  truncated: boolean;
  files: SearchTextFile[];
  stats?: SearchTextStats;
  errors: string[];
};

const SearchTextHintSchema = schema({
  toolRef: "string",
  input: schema({
    path: "string",
    startLine: "number",
    maxLines: "number",
  }),
});

const SearchTextSubmatchSchema = schema({
  startByte: "number",
  endByte: "number",
});

const SearchTextMatchSchema = schema({
  line: "number",
  preview: "string",
  submatches: SearchTextSubmatchSchema.array(),
  hint: SearchTextHintSchema,
});

const SearchTextFileSchema = schema({
  path: "string",
  displayPath: "string",
  matches: SearchTextMatchSchema.array(),
  more: "boolean",
});

const SearchTextStatsSchema = schema({
  searches: "number",
  searchesWithMatch: "number",
  matchedLines: "number",
  matches: "number",
  bytesSearched: "number",
  elapsedMs: "number",
});

const SearchTextOutputSchema = schema({
  root: "string",
  pattern: "string",
  truncated: "boolean",
  files: SearchTextFileSchema.array(),
  "stats?": SearchTextStatsSchema,
  errors: "string[]",
});

function stripSingleLineEnding(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n") || text.endsWith("\r")) return text.slice(0, -1);
  return text;
}

export const searchText = defineTool({
  kit: fsKitName,
  name: "searchText",
  summary: "Search text under a directory (ripgrep wrapper)",
  input: schema({
    path: schema("string").describe("Root directory to search"),
    pattern: schema("string").describe("Ripgrep pattern (regex by default)"),
    fixedStrings: schema("boolean").describe("Treat pattern as a literal string").default(false),
    "caseSensitive?": schema("boolean").describe("Force case sensitivity (overrides smartCase)"),
    smartCase: schema("boolean").describe("Enable smart-case matching").default(true),
    hidden: schema("boolean").describe("Include dotfiles and dot-directories").default(true),
    respectIgnore: schema("boolean").describe("Respect ignore files like .gitignore").default(true),
    ignorePolicy: schema("'scoped' | 'rg'")
      .describe("Ignore discovery policy when respectIgnore is true")
      .default("scoped"),
    excludeDirs: schema("string[]")
      .describe("Directory basenames to exclude (defaults skip common deps/env/cache dirs)")
      .default(() => [...DEFAULT_SCAN_TREE_EXCLUDE_DIRS]),
    maxMatches: schema("number")
      .describe(`Global matching-line cap (integer 0+; hard cap: ${MAX_SEARCH_TEXT_MATCHES})`)
      .default(200),
    maxFilesWithMatches: schema("number")
      .describe(
        `Maximum number of files (with matches) to return (integer 0+; hard cap: ${MAX_SEARCH_TEXT_FILES_WITH_MATCHES})`,
      )
      .default(50),
    maxMatchesPerFile: schema("number")
      .describe(`Maximum matching lines per file (integer 0+; hard cap: ${MAX_SEARCH_TEXT_MATCHES_PER_FILE})`)
      .default(20),
    maxPreviewChars: schema("number")
      .describe(`Maximum preview characters per match line (integer 0+; hard cap: ${MAX_SEARCH_TEXT_PREVIEW_CHARS})`)
      .default(200),
    contextLinesBefore: schema("number")
      .describe(
        `Lines before each match to include in the readTextWindow hint (integer 0+; hard cap: ${MAX_SEARCH_TEXT_CONTEXT_LINES})`,
      )
      .default(2),
    contextLinesAfter: schema("number")
      .describe(
        `Lines after each match to include in the readTextWindow hint (integer 0+; hard cap: ${MAX_SEARCH_TEXT_CONTEXT_LINES})`,
      )
      .default(2),
    timeoutMs: schema("number")
      .describe(`Timeout for the rg process (integer > 0; hard cap: ${MAX_SEARCH_TEXT_TIMEOUT_MS})`)
      .default(15000),
    maxRgJsonLineBytes: schema("number")
      .describe(
        `Maximum bytes allowed for any single rg --json record line (integer > 0; hard cap: ${MAX_SEARCH_TEXT_RG_JSON_LINE_BYTES})`,
      )
      .default(DEFAULT_SEARCH_TEXT_RG_JSON_LINE_BYTES),
  }),
  output: SearchTextOutputSchema,
  doc: [
    "Search for a pattern under a directory using ripgrep (rg) and return bounded, deterministic results.",
    "",
    "Output posture:",
    "- Results are grouped by file and sorted by absolute path.",
    "- Files include the raw absolute `path` and an escaped `displayPath` for safe printing.",
    "- Match previews strip the trailing line ending, escape control/bidi characters for safe display, and truncate to maxPreviewChars without splitting escape sequences (surrogate-safe).",
    `  - When truncated, the preview includes the marker: \`${TRUNCATION_MARKER}\`.`,
    "- If rg emits an oversized JSON record (for example: a match on a huge/minified line), the search stops early and reports an error.",
    "- Each match includes a `readTextWindow` hint for bounded context reads.",
    "",
    "Defaults:",
    "- Respects ignore files (.gitignore, .ignore, etc) by default.",
    "- Uses ignorePolicy: \"scoped\" by default (avoids global/parent ignore sources for determinism).",
    "- Searches hidden files by default (pass hidden: false to match rg defaults).",
    `- Excludes common deps/env/cache directories by default (same as \`${toolLink("scanTree")}\` defaults).`,
    "",
    "Determinism:",
    "- Uses `rg --sort=path` and wrapper-side sorting as a backstop.",
    `- Requires ripgrep (rg) >= ${MIN_RIPGREP_VERSION_TEXT}.`,
    "- Uses `--no-config` to disable ripgrep config files.",
  ].join("\n"),
  fn: async ({
    path,
    pattern,
    fixedStrings,
    caseSensitive,
    smartCase,
    hidden,
    respectIgnore,
    ignorePolicy,
    excludeDirs,
    maxMatches,
    maxFilesWithMatches,
    maxMatchesPerFile,
    maxPreviewChars,
    contextLinesBefore,
    contextLinesAfter,
    timeoutMs,
    maxRgJsonLineBytes,
  }: SearchTextInput): Promise<SearchTextOutput> => {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new TypeError("pattern must be a non-empty string");
    }

    const maxMatchesBudget = normalizeIntGE0("maxMatches", maxMatches ?? 200);
    const maxFilesBudget = normalizeIntGE0("maxFilesWithMatches", maxFilesWithMatches ?? 50);
    const maxPerFile = normalizeIntGE0("maxMatchesPerFile", maxMatchesPerFile ?? 20);
    const previewChars = normalizeIntGE0("maxPreviewChars", maxPreviewChars ?? 200);
    const before = normalizeIntGE0("contextLinesBefore", contextLinesBefore ?? 2);
    const after = normalizeIntGE0("contextLinesAfter", contextLinesAfter ?? 2);

    if (maxMatchesBudget > MAX_SEARCH_TEXT_MATCHES) {
      throw new TypeError(`maxMatches must be <= ${MAX_SEARCH_TEXT_MATCHES}`);
    }
    if (maxFilesBudget > MAX_SEARCH_TEXT_FILES_WITH_MATCHES) {
      throw new TypeError(`maxFilesWithMatches must be <= ${MAX_SEARCH_TEXT_FILES_WITH_MATCHES}`);
    }
    if (maxPerFile > MAX_SEARCH_TEXT_MATCHES_PER_FILE) {
      throw new TypeError(`maxMatchesPerFile must be <= ${MAX_SEARCH_TEXT_MATCHES_PER_FILE}`);
    }
    if (previewChars > MAX_SEARCH_TEXT_PREVIEW_CHARS) {
      throw new TypeError(`maxPreviewChars must be <= ${MAX_SEARCH_TEXT_PREVIEW_CHARS}`);
    }
    if (before > MAX_SEARCH_TEXT_CONTEXT_LINES) {
      throw new TypeError(`contextLinesBefore must be <= ${MAX_SEARCH_TEXT_CONTEXT_LINES}`);
    }
    if (after > MAX_SEARCH_TEXT_CONTEXT_LINES) {
      throw new TypeError(`contextLinesAfter must be <= ${MAX_SEARCH_TEXT_CONTEXT_LINES}`);
    }

    if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be an integer > 0");
    }
    if (timeoutMs > MAX_SEARCH_TEXT_TIMEOUT_MS) {
      throw new TypeError(`timeoutMs must be <= ${MAX_SEARCH_TEXT_TIMEOUT_MS}`);
    }

    if (!Number.isFinite(maxRgJsonLineBytes) || !Number.isInteger(maxRgJsonLineBytes) || maxRgJsonLineBytes <= 0) {
      throw new TypeError("maxRgJsonLineBytes must be an integer > 0");
    }
    if (maxRgJsonLineBytes > MAX_SEARCH_TEXT_RG_JSON_LINE_BYTES) {
      throw new TypeError(`maxRgJsonLineBytes must be <= ${MAX_SEARCH_TEXT_RG_JSON_LINE_BYTES}`);
    }

    for (const dir of excludeDirs ?? DEFAULT_SCAN_TREE_EXCLUDE_DIRS) {
      if (typeof dir !== "string" || dir.length === 0) {
        throw new TypeError("excludeDirs entries must be non-empty strings");
      }
      if (dir.includes("/") || dir.includes("\\")) {
        throw new TypeError("excludeDirs entries must be directory basenames (no separators)");
      }
      // We pass excludeDirs through to `--glob` patterns; reject glob metacharacters
      // so entries behave like literal basenames.
      if (/[*?\[\]{}!]/.test(dir)) {
        throw new TypeError("excludeDirs entries must not contain glob metacharacters");
      }
    }

    // Path validation: return structured error instead of throwing for consistency
    let root: string;
    try {
      root = await realpath(path);
      const st = await stat(root);
      if (!st.isDirectory()) {
        return {
          root: path,
          pattern,
          truncated: false,
          files: [],
          errors: ["searchText path must be an existing directory"],
        };
      }
    } catch (e) {
      return {
        root: path,
        pattern,
        truncated: false,
        files: [],
        errors: [e instanceof Error ? e.message : String(e)],
      };
    }

    const rgPath = "rg";

    if (maxMatchesBudget === 0 || maxFilesBudget === 0 || maxPerFile === 0) {
      return { root, pattern, truncated: false, files: [], errors: [] };
    }

    await ensureRipgrepVersion(rgPath, root);

    // Deterministic behavior:
    // - require a modern rg (version-checked)
    // - use --no-config
    const baseArgs: string[] = ["--json", "--sort=path", "--no-config"];
    const restArgs: string[] = [];

    if (fixedStrings === true) restArgs.push("--fixed-strings");

    if (caseSensitive === false) {
      restArgs.push("--ignore-case");
    } else if (caseSensitive === undefined && smartCase !== false) {
      restArgs.push("--smart-case");
    } else {
      restArgs.push("--case-sensitive");
    }

    if (hidden !== false) restArgs.push("--hidden");
    if (respectIgnore === false) {
      restArgs.push("--no-ignore");
    } else if (ignorePolicy !== "rg") {
      // Default posture: keep ignore behavior root-scoped + deterministic.
      restArgs.push("--no-ignore-global", "--no-ignore-exclude", "--no-ignore-parent", "--no-require-git");
    }

    restArgs.push(`--max-count=${maxPerFile}`);

    const exclude = new Set(excludeDirs ?? DEFAULT_SCAN_TREE_EXCLUDE_DIRS);
    for (const dir of exclude) {
      restArgs.push(`--glob=!**/${dir}/**`);
    }

    // Use cwd=root and search "." so ignore-file discovery stays scoped to the target directory.
    restArgs.push("--", pattern, ".");

    type SearchRun = {
      errors: string[];
      filesByPath: Map<string, SearchTextFile>;
      truncated: boolean;
      totalMatches: number;
      sawErrorEvent: boolean;
      stats: SearchTextStats | undefined;
      result: RunRipgrepJsonResult;
    };

    const makePushError = (errors: string[]) => (msg: string) => {
      if (errors.length >= 20) return;
      let s = msg.replaceAll("\r\n", "\n").trim();
      if (s.length === 0) return;

      s = escapeTreeName(s);

      const MAX_ERROR_CHARS = 800;
      if (s.length > MAX_ERROR_CHARS) {
        const prefix = safeTruncateUtf16(s, MAX_ERROR_CHARS, { treatAsTruncated: true });
        s = `${prefix}${TRUNCATION_MARKER}`;
      }

      errors.push(s);
    };

    const MAX_SUBMATCHES = 20;

    const runOnce = async (args: string[]): Promise<SearchRun> => {
      const errors: string[] = [];
      const pushError = makePushError(errors);
      const filesByPath = new Map<string, SearchTextFile>();
      let truncated = false;
      let totalMatches = 0;
      let sawErrorEvent = false;
      let stats: SearchTextStats | undefined;

      const result = await (async () => {
        try {
          return await runRipgrepJson({
            cwd: root,
            rgPath,
            args,
            timeoutMs,
            maxJsonLineBytes: maxRgJsonLineBytes,
            onEvent: (event) => {
              if (truncated) return true;

              if (event.type === "match") {
                const data = event.data as any;
                const pathText = data?.path?.text;
                const line = data?.line_number;
                const lineText = data?.lines?.text;
                if (typeof pathText !== "string" || typeof line !== "number" || typeof lineText !== "string") {
                  return;
                }

                const absPath = resolve(root, pathText);
                const relFromRoot = relative(root, absPath);
                if (
                  isAbsolute(relFromRoot) ||
                  relFromRoot === ".." ||
                  relFromRoot.startsWith("../") ||
                  (process.platform === "win32" && relFromRoot.startsWith("..\\"))
                ) {
                  pushError(`rg produced a path outside the requested root: ${pathText}`);
                  return;
                }

                let file = filesByPath.get(absPath);
                if (!file) {
                  if (filesByPath.size >= maxFilesBudget) {
                    truncated = true;
                    return true;
                  }
                  file = { path: absPath, displayPath: escapeTreeName(absPath), matches: [], more: false };
                  filesByPath.set(absPath, file);
                }

                if (file.matches.length >= maxPerFile) {
                  file.more = true;
                  return;
                }

                if (totalMatches >= maxMatchesBudget) {
                  truncated = true;
                  return true;
                }

                const stripped = stripSingleLineEnding(lineText);
                const preview = escapeTreeNamePreview(stripped, previewChars);

                const rawSubmatches = Array.isArray(data?.submatches) ? (data.submatches as any[]) : [];
                const submatches: SearchTextSubmatch[] = [];
                for (let i = 0; i < rawSubmatches.length && submatches.length < MAX_SUBMATCHES; i += 1) {
                  const sm = rawSubmatches[i];
                  const start = sm?.start;
                  const end = sm?.end;
                  if (typeof start === "number" && typeof end === "number") {
                    submatches.push({ startByte: start, endByte: end });
                  }
                }

                const startLine = Math.max(1, line - before);
                const maxLinesHint = before + 1 + after;

                file.matches.push({
                  line,
                  preview,
                  submatches,
                  hint: {
                    toolRef: toolLink("readTextWindow"),
                    input: { path: absPath, startLine, maxLines: maxLinesHint },
                  },
                });
                totalMatches += 1;
                if (file.matches.length === maxPerFile) file.more = true;

                if (totalMatches >= maxMatchesBudget) {
                  truncated = true;
                  return true;
                }
                return;
              }

              if (event.type === "error") {
                sawErrorEvent = true;
                const data = event.data as any;
                const p = data?.path?.text;
                const e = data?.error?.text ?? data?.error?.message ?? data?.error;
                const msg = typeof e === "string" ? e : e ? JSON.stringify(e) : "rg error";
                pushError(typeof p === "string" ? `${p}: ${msg}` : msg);
                return;
              }

              if (event.type === "summary") {
                const data = event.data as any;
                const s = data?.stats;
                const elapsed = data?.elapsed_total ?? s?.elapsed;
                const secs = typeof elapsed?.secs === "number" ? elapsed.secs : 0;
                const nanos = typeof elapsed?.nanos === "number" ? elapsed.nanos : 0;

                if (
                  s &&
                  typeof s.searches === "number" &&
                  typeof s.searches_with_match === "number" &&
                  typeof s.matched_lines === "number" &&
                  typeof s.matches === "number" &&
                  typeof s.bytes_searched === "number"
                ) {
                  stats = {
                    searches: s.searches,
                    searchesWithMatch: s.searches_with_match,
                    matchedLines: s.matched_lines,
                    matches: s.matches,
                    bytesSearched: s.bytes_searched,
                    elapsedMs: secs * 1000 + nanos / 1e6,
                  };
                }
                return;
              }

              return;
            },
          });
        } catch (e) {
          const code = (e as NodeJS.ErrnoException | null)?.code;
          if (code === "ENOENT") {
            const safeRgPath = sanitizeForSingleLineError(rgPath);
            throw new TypeError(`ripgrep executable not found (rgPath: ${safeRgPath})`);
          }
          throw e;
        }
      })();

      return {
        errors,
        filesByPath,
        truncated,
        totalMatches,
        sawErrorEvent,
        stats,
        result,
      };
    };

    const args: string[] = [...baseArgs, ...restArgs];
    const run = await runOnce(args);

    let { errors, filesByPath, truncated, totalMatches, sawErrorEvent, stats, result } = run;
    const pushError = makePushError(errors);

    const stderrTrimmed = result.stderr.trim();

    if (result.outputTooLarge) {
      truncated = true;
      pushError(`rg produced an oversized JSON record (maxRgJsonLineBytes: ${maxRgJsonLineBytes})`);
    }
    if (result.timedOut) {
      truncated = true;
      pushError(`rg timed out after ${timeoutMs}ms`);
    }

    for (const msg of result.parseErrors) pushError(msg);
    if (stderrTrimmed.length > 0) {
      for (const line of stderrTrimmed.split(/\r?\n/)) {
        pushError(line);
      }
    }

    // Note: rg exit code 2 with no error events and no matches indicates a fatal
    // invocation/pattern error (e.g. invalid regex). The stderr message has already
    // been added to the errors array above; we return it as a structured error
    // rather than throwing, for consistent error handling across all failure modes.

    if (!truncated) {
      if (typeof result.exitCode === "number" && result.exitCode > 1) {
        pushError(`rg exited with code ${result.exitCode}`);
      } else if (result.exitCode === null && result.signal) {
        pushError(`rg terminated with signal ${result.signal}`);
      }
    }

    const files = [...filesByPath.values()]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => ({
        ...f,
        matches: f.matches.slice().sort((x, y) => x.line - y.line),
      }));

    return {
      root,
      pattern,
      truncated,
      files,
      ...(stats ? { stats } : {}),
      errors,
    };
  },
});

// ---------------------------------------------------------------------------
// editText
// ---------------------------------------------------------------------------

function detectLineEnding(content: string): string {
  const match = content.match(/\r\n|\r|\n/);
  return match ? match[0] : "\n";
}

function normalizeLineEndings(text: string, lineEnding: string): string {
  // Normalize all line endings in text to the target line ending
  return text.replace(/\r\n|\r|\n/g, lineEnding);
}

const EditTextSuccessSchema = schema({
  success: "true",
  lineChanged: "number",
  bytesWritten: "number",
});

const EditTextErrorSchema = schema({
  success: "false",
  error: "string",
  errorCode: "string",
  "matches?": "number",
});

const EditTextOutputSchema = EditTextSuccessSchema.or(EditTextErrorSchema);

export const editText = defineTool({
  kit: fsKitName,
  name: "editText",
  summary: "Replace a unique text occurrence in a file (CAS-safe)",
  input: schema({
    path: schema("string").describe("File path to edit"),
    oldText: schema("string").describe("Content to replace (must be non-empty and match exactly once)"),
    newText: schema("string").describe("Replacement content"),
    startLine: schema("number > 0")
      .describe("Optional: 1-based start line to narrow search scope")
      .optional(),
    endLine: schema("number > 0")
      .describe("Optional: 1-based end line to narrow search scope (>= startLine)")
      .optional(),
  }),
  output: EditTextOutputSchema,
  doc: [
    "Replace a unique occurrence of `oldText` with `newText` in a file.",
    "",
    "Safety guarantees:",
    "- **CAS (Compare-And-Swap)**: `oldText` must match exactly once in the search scope.",
    "- **Atomic write**: changes are written to a temp file, then renamed into place.",
    "- **Line ending preservation**: detects the file's line ending style and normalizes `newText` to match.",
    "",
    "Optional `startLine`/`endLine` narrow the search scope (1-based, inclusive).",
    "The scope is automatically extended by the number of lines in `oldText` to catch",
    "matches that span line boundaries.",
    "",
    "Error codes:",
    "- `FILE_NOT_FOUND` - file does not exist",
    "- `FILE_READ_ERROR` - failed to read file",
    "- `FILE_WRITE_ERROR` - failed to write file",
    "- `INVALID_LINE_RANGE` - invalid startLine/endLine",
    "- `OLD_TEXT_EMPTY` - oldText is empty",
    "- `OLD_TEXT_NOT_FOUND` - oldText not found in scope",
    "- `OLD_TEXT_NOT_UNIQUE` - oldText found multiple times globally",
    "- `OLD_TEXT_NOT_UNIQUE_SCOPED` - oldText found multiple times in scoped range",
    "",
    "Example:",
    "```ts",
    'const result = await editText({',
    '  path: "src/app.ts",',
    '  oldText: "const x = 1;",',
    '  newText: "const x = 2;",',
    "});",
    "```",
  ].join("\n"),
  fn: async ({ path, oldText, newText, startLine, endLine }) => {
    // 1. Validate oldText is non-empty
    if (oldText.length === 0) {
      return {
        success: false as const,
        error: "oldText cannot be empty",
        errorCode: "OLD_TEXT_EMPTY",
      };
    }

    // 2. Validate line range
    if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
      return {
        success: false as const,
        error: `Invalid line range: endLine (${endLine}) must be >= startLine (${startLine})`,
        errorCode: "INVALID_LINE_RANGE",
      };
    }

    // 3. Resolve and validate file path
    const resolved = isAbsolute(path) ? path : resolve(process.cwd(), path);

    let fileStat;
    try {
      fileStat = await stat(resolved);
    } catch {
      return {
        success: false as const,
        error: `File not found: ${path}`,
        errorCode: "FILE_NOT_FOUND",
      };
    }

    if (!fileStat.isFile()) {
      return {
        success: false as const,
        error: `File not found: ${path} (path is not a regular file)`,
        errorCode: "FILE_NOT_FOUND",
      };
    }

    // 4. Read file content
    let content: string;
    try {
      content = await readFile(resolved, "utf8");
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        success: false as const,
        error: `Failed to read file: ${reason}`,
        errorCode: "FILE_READ_ERROR",
      };
    }

    // 5. Check file size limit
    if (content.length > DEFAULT_EDIT_TEXT_MAX_CHARS) {
      return {
        success: false as const,
        error: `File too large for editText (${content.length} chars, limit ${DEFAULT_EDIT_TEXT_MAX_CHARS})`,
        errorCode: "FILE_READ_ERROR",
      };
    }

    // 6. Detect line ending style and normalize newText
    const lineEnding = detectLineEnding(content);
    const normalizedNewText = normalizeLineEndings(newText, lineEnding);

    // 7. Determine search scope
    let searchContent: string;
    let scopeOffset: number; // byte offset where the scope starts in the full content
    const isScoped = startLine !== undefined || endLine !== undefined;

    if (isScoped) {
      const lines = content.split(/\r\n|\r|\n/);
      const totalLines = lines.length;

      const effStart = startLine ?? 1;
      const effEnd = endLine ?? totalLines;

      if (effStart > totalLines) {
        return {
          success: false as const,
          error: `Invalid line range: startLine (${effStart}) exceeds file length (${totalLines} lines)`,
          errorCode: "INVALID_LINE_RANGE",
        };
      }

      // Smart extension: extend by number of lines in oldText
      const oldTextLineCount = oldText.split(/\r\n|\r|\n/).length;
      const extendedStart = Math.max(1, effStart - oldTextLineCount);
      const extendedEnd = Math.min(totalLines, effEnd + oldTextLineCount);

      // Build the search scope text and compute offset
      // We need the character offset of extendedStart within the original content
      let charOffset = 0;
      for (let i = 0; i < extendedStart - 1; i++) {
        charOffset += lines[i].length + lineEnding.length;
      }
      scopeOffset = charOffset;

      // Build scoped content from lines
      const scopedLines = lines.slice(extendedStart - 1, extendedEnd);
      searchContent = scopedLines.join(lineEnding);
    } else {
      searchContent = content;
      scopeOffset = 0;
    }

    // 8. Count occurrences of oldText in scope
    let count = 0;
    let matchIndex = -1;
    let pos = 0;
    while (true) {
      const idx = searchContent.indexOf(oldText, pos);
      if (idx === -1) break;
      count++;
      matchIndex = idx;
      pos = idx + 1;
    }

    // 9. Handle no match
    if (count === 0) {
      return {
        success: false as const,
        error: "oldText not found in file",
        errorCode: "OLD_TEXT_NOT_FOUND",
      };
    }

    // 10. Handle multiple matches
    if (count > 1) {
      if (isScoped) {
        const effStart = startLine ?? 1;
        const effEnd = endLine ?? "end";
        return {
          success: false as const,
          error: `oldText found ${count} times in lines ${effStart}-${effEnd} - provide more context`,
          errorCode: "OLD_TEXT_NOT_UNIQUE_SCOPED",
          matches: count,
        };
      }
      return {
        success: false as const,
        error: `oldText found ${count} times - provide more context or line constraints`,
        errorCode: "OLD_TEXT_NOT_UNIQUE",
        matches: count,
      };
    }

    // 11. Unique match — perform the replacement
    const globalMatchIndex = scopeOffset + matchIndex;
    const newContent =
      content.substring(0, globalMatchIndex) +
      normalizedNewText +
      content.substring(globalMatchIndex + oldText.length);

    // Calculate 1-based line number where the change occurred
    const beforeMatch = content.substring(0, globalMatchIndex);
    const lineChanged = beforeMatch.split(/\r\n|\r|\n/).length;

    // 12. Atomic write: temp file + rename
    const tempPath = `${resolved}.tmp-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await writeFile(tempPath, newContent, "utf8");
      await rename(tempPath, resolved);
    } catch (err: unknown) {
      // Clean up temp file on failure
      try {
        await unlink(tempPath);
      } catch {
        // ignore cleanup errors
      }
      const reason = err instanceof Error ? err.message : String(err);
      return {
        success: false as const,
        error: `Failed to write file: ${reason}`,
        errorCode: "FILE_WRITE_ERROR",
      };
    }

    const bytesWritten = Buffer.byteLength(newContent, "utf8");

    return {
      success: true as const,
      lineChanged,
      bytesWritten,
    };
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

function sanitizeForSingleLineError(raw: string, maxChars = 800): string {
  let s = raw.replaceAll("\r\n", "\n").trim();
  if (s.length === 0) return "";

  s = escapeTreeName(s);

  if (s.length > maxChars) {
    const prefix = safeTruncateUtf16(s, maxChars, { treatAsTruncated: true });
    return `${prefix}${TRUNCATION_MARKER}`;
  }

  return s;
}

function escapeTreeNamePreview(name: string, maxChars: number): string {
  if (maxChars <= 0) {
    return name.length === 0 ? "" : TRUNCATION_MARKER;
  }

  let out = "";
  let i = 0;

  while (i < name.length) {
    const codePoint = name.codePointAt(i);
    if (codePoint === undefined) break;
    const ch = String.fromCodePoint(codePoint);
    i += ch.length;

    let token: string;
    if (ch === "\n") {
      token = "\\n";
    } else if (ch === "\r") {
      token = "\\r";
    } else if (ch === "\t") {
      token = "\\t";
    } else if (codePoint <= 0x1f || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f)) {
      token = `\\x${codePoint.toString(16).padStart(2, "0")}`;
    } else if (codePoint === 0x2028 || codePoint === 0x2029 || isBidiControl(codePoint)) {
      token = `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else {
      token = ch;
    }

    if (out.length + token.length > maxChars) {
      return `${out}${TRUNCATION_MARKER}`;
    }

    out += token;
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
        "Use this kit for bounded filesystem browsing, reading, and editing.",
        "",
        "Primary tools:",
        `- \`${toolLink("scanTree")}\``,
        `- \`${toolLink("searchText")}\``,
        `- \`${toolLink("readTextWindow")}\``,
        `- \`${toolLink("editText")}\``,
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
        `- Added \`searchText\` for bounded, deterministic text search (ripgrep wrapper). Requires \`rg >= ${MIN_RIPGREP_VERSION_TEXT}\`.`,
        "- `readTextWindow` supports negative `startLine` for tail-style reads (`-1` is the last line).",
        "- `readTextLineWindow` supports negative `line` with the same convention.",
        "- `scanTree` now enforces hard caps on maxDepth/maxEntries/maxEntriesPerDir to keep results bounded.",
        "- `scanTree` expanded default `excludeDirs` to skip common deps/env/cache directories (for example `.venv` and `target`).",
        "- Use `readTextWindow` for bounded reads.",
        "- Use `scanTree` (and supported-but-unlisted `viewTree`) for browsing.",
        "- Added `editText` for CAS-safe text replacement with atomic writes.",
      ].join("\n"),
    },
    changelog: {
      summary: "Recent changes",
      doc: [
        "# Changelog",
        "",
        "- Refined the fs kit surface to bounded browse/read tools; removed legacy helpers.",
        "- `readTextWindow` now truncates very long lines by default; added hidden `readTextLineWindow` helper.",
        `- Added \`searchText\` for bounded, deterministic text search (ripgrep wrapper). Requires \`rg >= ${MIN_RIPGREP_VERSION_TEXT}\`.`,
        "- `readTextWindow` and `readTextLineWindow` now support negative line indexing for tail-style reads.",
        "- `scanTree` expanded default excludes to skip common deps/env/cache directories.",
        "- Added `editText` for CAS-safe (Compare-And-Swap) text replacement with atomic writes.",
      ].join("\n"),
    },
  },
  tools: {
    editText,
    formatPath,
    readTextLineWindow,
    readTextWindow,
    scanTree,
    searchText,
    viewTree,
  },
});

export default fsKit;
