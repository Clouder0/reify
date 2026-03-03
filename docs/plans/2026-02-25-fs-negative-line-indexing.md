# fs Negative Line Indexing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add negative line indexing to `readTextWindow` and `readTextLineWindow` so callers can do tail-style reads where `-1` is the last line, while preserving bounded output and progressive-disclosure truncation hints.

**Architecture:**
- Keep existing forward-scan behavior untouched for `startLine >= 1` / `line >= 1`.
- Add an internal “tail line range” helper that scans the file backwards at the byte level (LF/CR/CRLF) to locate the last K line byte ranges without reading the whole file.
- Add an internal UTF-8 range reader (`TextDecoder` streaming) to decode a known `[startByte, endByteExclusive)` range; reuse it to compute per-line prefix + total length (for `readTextWindow`) and to page within a line (for `readTextLineWindow`).

**Tech Stack:** TypeScript (NodeNext ESM), Node `fs/promises` FileHandle + `Buffer` + `TextDecoder`, Bun tests (`bun test`).

---

## Current Code Map (read this first)

- Public tool: `src/kits/fs/index.ts:229` `readTextWindow`.
  - Validates `startLine >= 1` today; streams file via `scanUtf8TextFile` + `LineScanner`.
  - Truncates long lines to `maxLineChars` and returns `truncation.lines[].hint` pointing at `readTextLineWindow`.
- Hidden helper: `src/kits/fs/index.ts:421` `readTextLineWindow`.
  - Validates `line >= 1` today; streams the whole file until the target line via `LineScanner`.
  - Pages within a line using UTF-16 code unit offsets; enforces surrogate-pair safety.
- Streaming line splitter: `src/kits/fs/_lineScanner.ts`.
  - Preserves `\n`, `\r`, `\r\n`, and emits `eol: ""` at EOF only if there was content since the last line end.

## Contract / Semantics (decisions to implement)

1. **Negative line indexing**
   - `readTextWindow.startLine` accepts any non-zero integer.
     - `startLine >= 1`: existing semantics (1-based from BOF).
     - `startLine <= -1`: count from EOF, where `-1` is the last line, `-2` is the second-to-last, etc.
   - `readTextLineWindow.line` accepts any non-zero integer with the same convention.

2. **Output coordinate system**
   - When negative indexing is used, output line numbers are also negative.
   - `nextStartLine` continues in the same coordinate system.
     - For negative reads, page “toward EOF”: `nextStartLine = endLine + 1` unless `endLine === -1`.

3. **Out-of-range behavior**
   - `readTextWindow` with negative `startLine` clamps when the file has fewer lines than requested.
     - Example: file has 4 lines, request `startLine = -99` -> treat as `startLine = -4` and return from the first line.
     - Rationale: makes paging coherent; avoids returning nonsense `nextStartLine` values.
   - `readTextLineWindow` with out-of-range negative `line` returns `found: false` (no clamping).

4. **Line ending preservation**
   - Maintain the existing guarantee: returned `text` preserves exact `\n` / `\r` / `\r\n` bytes.
   - Tail scanning must correctly classify CRLF even when `\r` and `\n` straddle an internal chunk boundary.

---

### Task 0: Worktree + Baseline Verification

**Files:** none

**Step 1: Create an isolated worktree (recommended)**

Run (example):
```bash
git worktree add ../reify-neg-lines -b feat/fs-negative-lines
```
Expected: a new working directory at `../reify-neg-lines`.

**Step 2: Run baseline tests**

Run:
```bash
bun test
```
Expected: PASS (establishes a clean baseline before changes).

---

### Task 1: Add Failing Tests for `readTextWindow` Negative `startLine`

**Files:**
- Modify: `test/readTextWindow.test.ts`

**Step 1: Add a basic negative-index window test (should fail initially)**

Add:
```ts
test("readTextWindow supports negative startLine (-1 is last line)", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-negative");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "a\nb\nc\nd\n", "utf8");

    const out = await readTextWindow({ path, startLine: -2, maxLines: 2 });

    expect(out).toEqual({
      text: "c\nd\n",
      startLine: -2,
      endLine: -1,
      nextStartLine: null,
      truncation: null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

**Step 2: Add a paging test (should fail initially)**

Add:
```ts
test("readTextWindow negative paging uses nextStartLine toward EOF", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-negative-page");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "a\nb\nc\nd\n", "utf8");

    const out = await readTextWindow({ path, startLine: -4, maxLines: 2 });
    expect(out).toEqual({
      text: "a\nb\n",
      startLine: -4,
      endLine: -3,
      nextStartLine: -2,
      truncation: null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

**Step 3: Add a clamping test for out-of-range negative startLine (should fail initially)**

Add:
```ts
test("readTextWindow clamps negative startLine when abs(startLine) exceeds file lines", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-negative-clamp");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "a\nb\nc\nd\n", "utf8");

    const out = await readTextWindow({ path, startLine: -99, maxLines: 2 });

    expect(out).toEqual({
      text: "a\nb\n",
      startLine: -4,
      endLine: -3,
      nextStartLine: -2,
      truncation: null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

**Step 4: Add a negative test for no trailing newline (should fail initially)**

Add:
```ts
test("readTextWindow negative indexing handles last line without newline", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-negative-no-eol");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "a\nb\nc", "utf8");

    const out = await readTextWindow({ path, startLine: -1, maxLines: 1 });
    expect(out).toEqual({
      text: "c",
      startLine: -1,
      endLine: -1,
      nextStartLine: null,
      truncation: null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

**Step 5: Add a CRLF cross-chunk regression test (should fail initially)**

Add (keeps output small by truncating the long last line):
```ts
test("readTextWindow negative indexing preserves CRLF even across chunk boundaries", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-negative-crlf-chunk");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");

    // Construct a file where a CRLF occurs exactly at a 64KiB boundary in the
    // tail-scanner's backward reads. The last line length is (64KiB - 1).
    const big = "b".repeat(64 * 1024 - 1);
    await writeFile(path, `a\r\n${big}\n`, "utf8");

    const out = await readTextWindow({ path, startLine: -2, maxLines: 2, maxLineChars: 3 });

    expect(out.text).toBe(`a\r\nbbb<<<REIFY_LINE_TRUNCATED>>>\n`);
    expect(out.startLine).toBe(-2);
    expect(out.endLine).toBe(-1);
    expect(out.nextStartLine).toBeNull();
    expect(out.truncation).not.toBeNull();
    expect(out.truncation!.lines[0].line).toBe(-1);
    expect(out.truncation!.lines[0].hint.input.line).toBe(-1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

**Step 6: Update the existing validation test expectations**

Update the “rejects invalid startLine” test to keep rejecting `0` and non-integers, but no longer reject negatives.

Example change:
```ts
await expect(readTextWindow({ path, startLine: 0, maxLines: 1 })).rejects.toThrow(
  "startLine must be an integer >= 1 or <= -1",
);
await expect(readTextWindow({ path, startLine: 1.5, maxLines: 1 })).rejects.toThrow(
  "startLine must be an integer >= 1 or <= -1",
);
```

**Step 7: Run the test file and confirm it fails**

Run:
```bash
bun test test/readTextWindow.test.ts
```
Expected: FAIL (currently `startLine` rejects negatives).

**Step 8: Commit the failing tests**

Run:
```bash
```

---

### Task 2: Implement Tail Line Range Scanning (Internal Helper)

**Files:**
- Create: `src/kits/fs/_tailLines.ts`
- Modify: `src/kits/fs/index.ts` (import + usage)

**Step 1: Create `src/kits/fs/_tailLines.ts` skeleton**

Create:
```ts
import type { FileHandle } from "node:fs/promises";

const TAIL_READ_CHUNK_BYTES = 64 * 1024;

export type TailLineRange = {
  startByte: number;
  endByte: number; // exclusive, content only
  eol: "\n" | "\r" | "\r\n" | "";
};

export async function collectTailLineRanges(
  fh: FileHandle,
  count: number,
): Promise<{ ranges: TailLineRange[]; totalLines: number }> {
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError("count must be an integer >= 0");
  }
  // Implementation filled in next steps.
  return { ranges: [], totalLines: 0 };
}
```

**Step 2: Implement trailing-EOL detection to match `_lineScanner.ts` semantics**

Replace the placeholder return with:
```ts
const st = await fh.stat();
const size = st.size;
if (size === 0 || count === 0) return { ranges: [], totalLines: 0 };

// Determine the EOL for the last line and the initial cursor (end of last-line content).
let cursor = size;
let currentEol: TailLineRange["eol"] = "";

const tailLen = Math.min(2, size);
const tail = Buffer.allocUnsafe(tailLen);
await fh.read(tail, 0, tailLen, size - tailLen);
const last = tail[tailLen - 1];
const prev = tailLen >= 2 ? tail[tailLen - 2] : null;

if (last === 0x0a) {
  if (prev === 0x0d) {
    currentEol = "\r\n";
    cursor = size - 2;
  } else {
    currentEol = "\n";
    cursor = size - 1;
  }
} else if (last === 0x0d) {
  currentEol = "\r";
  cursor = size - 1;
}
```

**Step 3: Implement the backward scan to collect up to `count` ranges**

Add after Step 2:
```ts
const buf = Buffer.allocUnsafe(TAIL_READ_CHUNK_BYTES);
const ranges: TailLineRange[] = [];

let pos = cursor;
while (ranges.length < count && pos > 0) {
  const readStart = Math.max(0, pos - buf.length);
  const toRead = pos - readStart;
  const { bytesRead } = await fh.read(buf, 0, toRead, readStart);
  if (bytesRead === 0) break;

  // Scan this chunk backwards. When we find a line break, emit the current line
  // (which ends at `cursor` with `currentEol`) and then shift `cursor` to the
  // start of the separator we found.
  for (let i = bytesRead - 1; i >= 0 && ranges.length < count; i -= 1) {
    const b = buf[i];
    if (b !== 0x0a && b !== 0x0d) continue;

    // Identify separator.
    let sepStart = readStart + i;
    let sepEnd = readStart + i + 1;
    let sepEol: TailLineRange["eol"] = b === 0x0a ? "\n" : "\r";

    if (b === 0x0a) {
      // LF: maybe CRLF.
      if (i > 0 && buf[i - 1] === 0x0d) {
        sepStart = readStart + i - 1;
        sepEnd = readStart + i + 1;
        sepEol = "\r\n";
        i -= 1; // skip the CR
      } else if (i === 0 && readStart > 0) {
        // CRLF split across chunks: check the preceding byte.
        const one = Buffer.allocUnsafe(1);
        const { bytesRead: oneRead } = await fh.read(one, 0, 1, readStart - 1);
        if (oneRead === 1 && one[0] === 0x0d) {
          sepStart = readStart - 1;
          sepEnd = readStart + i + 1;
          sepEol = "\r\n";
        }
      }
    }

    ranges.push({ startByte: sepEnd, endByte: cursor, eol: currentEol });
    cursor = sepStart;
    currentEol = sepEol;

    // Continue scanning earlier bytes; if cursor moved earlier than this chunk's start,
    // the outer loop will load the next chunk.
    if (cursor < readStart) {
      pos = cursor;
      break;
    }
    pos = cursor;
    i = cursor - readStart; // loop will i-- next
  }

  if (pos === readStart) {
    pos = readStart;
  }
}

// If we still need a line (or we reached BOF), emit the first line.
if (ranges.length < count) {
  ranges.push({ startByte: 0, endByte: cursor, eol: currentEol });
}

return { ranges, totalLines: ranges.length };
```

**Step 4: Run the `readTextWindow` tests again (still failing, but for new reasons)**

Run:
```bash
bun test test/readTextWindow.test.ts
```
Expected: still FAIL because `readTextWindow` isn’t wired to use negative indexing yet.

**Step 5: Commit helper**

Run:
```bash
```

---

### Task 3: Implement `readTextWindow` Negative `startLine` Using Tail Ranges

**Files:**
- Modify: `src/kits/fs/index.ts:229`
- Modify: `src/kits/fs/index.ts:44` (add a UTF-8 range reader helper)

**Step 1: Add a reusable UTF-8 range scanner helper near `scanUtf8TextFile`**

Add in `src/kits/fs/index.ts` (near `scanUtf8TextFile`):
```ts
import type { FileHandle } from "node:fs/promises";

async function scanUtf8TextRange(
  fh: FileHandle,
  startByte: number,
  endByteExclusive: number,
  onText: (segment: string) => void,
): Promise<void> {
  if (!Number.isInteger(startByte) || !Number.isInteger(endByteExclusive) || startByte < 0) {
    throw new TypeError("invalid byte range");
  }
  if (endByteExclusive < startByte) {
    throw new TypeError("invalid byte range");
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
```

**Step 2: Import the tail helper**

At the top of `src/kits/fs/index.ts`, add:
```ts
import { collectTailLineRanges, type TailLineRange } from "./_tailLines.js";
```

**Step 3: Update `readTextWindow` validation + docs to allow negative startLine**

In the tool docs, replace the “Line indexing is 1-based” bullet with:

```ts
"- Line indexing: 1-based from start; negative from end (-1 is last line).",
"- startLine must be an integer >= 1 or <= -1 (0 is invalid).",
```

In validation, change:
```ts
if (!Number.isInteger(startLine) || startLine < 1) {
  throw new TypeError("startLine must be an integer >= 1");
}
```
to:
```ts
if (!Number.isInteger(startLine) || startLine === 0) {
  throw new TypeError("startLine must be an integer >= 1 or <= -1");
}
```

**Step 4: Implement the negative branch in `readTextWindow.fn`**

Add a branch near the start of the function:
```ts
if (startLine < 0) {
  const kRequested = -startLine;

  const fh = await open(path, "r");
  try {
    const { ranges: tailRanges } = await collectTailLineRanges(fh, kRequested);
    const available = tailRanges.length;
    if (available === 0) {
      return { text: "", startLine, endLine: null, nextStartLine: null, truncation: null };
    }

    const resolvedStartLine = available < kRequested ? -available : startLine;
    const linesToReturn = Math.min(maxLines, available);
    const windowRanges = tailRanges.slice(available - linesToReturn, available).reverse();

    const truncations: Array<{
      line: number;
      shownChars: number;
      omittedChars: number;
      nextStartChar: number;
      hint: { toolRef: string; input: { path: string; line: number; startChar: number; maxChars: number } };
    }> = [];
    const rendered: string[] = [];

    for (let i = 0; i < windowRanges.length; i += 1) {
      const range = windowRanges[i];
      const lineNo = resolvedStartLine + i;

      let contentLen = 0;
      let prefix = "";
      await scanUtf8TextRange(fh, range.startByte, range.endByte, (seg) => {
        contentLen += seg.length;
        if (prefix.length < maxLineChars) {
          prefix += seg.slice(0, maxLineChars - prefix.length);
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
```

**Step 5: Run the `readTextWindow` tests**

Run:
```bash
bun test test/readTextWindow.test.ts
```
Expected: PASS.

**Step 6: Commit**

Run:
```bash
```

---

### Task 4: Add Failing Tests for `readTextLineWindow` Negative `line`

**Files:**
- Modify: `test/readTextLineWindow.test.ts`

**Step 1: Add a basic negative line test (should fail initially)**

Add:
```ts
test("readTextLineWindow supports negative line (-1 is last line)", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-line-window-negative");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "first\nsecond\n", "utf8");

    const out = await readTextLineWindow({ path, line: -1, startChar: 1, maxChars: 3 });
    expect(out).toEqual({
      found: true,
      line: -1,
      startChar: 1,
      endChar: 4,
      nextStartChar: 4,
      text: "eco",
      eol: "\n",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

**Step 2: Add an out-of-range negative line test (should fail initially)**

Add:
```ts
test("readTextLineWindow returns found=false when negative line is past BOF", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-line-window-negative-oob");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "only\n", "utf8");

    const out = await readTextLineWindow({ path, line: -2, startChar: 0, maxChars: 10 });
    expect(out).toEqual({
      found: false,
      line: -2,
      startChar: 0,
      endChar: null,
      nextStartChar: null,
      text: "",
      eol: "",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

**Step 3: Add a surrogate-pair safety test on negative line (should fail initially)**

Add:
```ts
test("readTextLineWindow negative line does not split surrogate pairs", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-line-window-negative-surrogate");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "x\nab😀cd\n", "utf8");

    const a = await readTextLineWindow({ path, line: -1, startChar: 0, maxChars: 3 });
    expect(a.text).toBe("ab");

    const b = await readTextLineWindow({ path, line: -1, startChar: 2, maxChars: 3 });
    expect(b.text).toBe("😀c");

    await expect(readTextLineWindow({ path, line: -1, startChar: 3, maxChars: 2 })).rejects.toThrow(
      "startChar must not point into the middle of a surrogate pair",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

**Step 4: Update/extend validation tests to reject `line = 0`**

Add:
```ts
await expect(readTextLineWindow({ path, line: 0, startChar: 0, maxChars: 1 })).rejects.toThrow(
  "line must be an integer >= 1 or <= -1",
);
```

**Step 5: Run tests and confirm failure**

Run:
```bash
bun test test/readTextLineWindow.test.ts
```
Expected: FAIL (negative `line` currently rejected).

**Step 6: Commit failing tests**

Run:
```bash
```

---

### Task 5: Implement `readTextLineWindow` Negative `line` Using Tail Ranges

**Files:**
- Modify: `src/kits/fs/index.ts:421`

**Step 1: Update docs + validation to allow negative `line`**

Change validation from:
```ts
if (!Number.isInteger(line) || line < 1) {
  throw new TypeError("line must be an integer >= 1");
}
```
to:
```ts
if (!Number.isInteger(line) || line === 0) {
  throw new TypeError("line must be an integer >= 1 or <= -1");
}
```

Update docs bullet:
```ts
"- Line indexing: 1-based from start; negative from end (-1 is last line).",
```

**Step 2: Add a `line < 0` branch that locates the line range via `collectTailLineRanges`**

Add near the start of `fn` (after maxChars/startChar validation):
```ts
if (line < 0) {
  const k = -line;
  const fh = await open(path, "r");
  try {
    const { ranges } = await collectTailLineRanges(fh, k);
    if (ranges.length < k) {
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

    const target = ranges[k - 1]; // ranges are collected from EOF backward

    // Stream-decode the line content bytes and reuse the existing surrogate-safe window logic.
    const targetEndCandidate = startChar + maxChars;
    let currentPos = 0;
    let prevCodeUnitInLine: number | null = null;
    let outText = "";
    let pendingEndSurrogateCheck = false;
    let startBoundaryChecked = startChar === 0;

    await scanUtf8TextRange(fh, target.startByte, target.endByte, (segment) => {
      // (Copy the existing onContent logic from the positive-branch implementation,
      // but without the `currentLine !== line` guard.)
      // Ensure it updates `currentPos`, `prevCodeUnitInLine`, `outText`, and checks
      // surrogate boundaries exactly the same way.
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
```

**Step 3: Implement the negative-branch segment handler by extracting a shared helper**

To avoid duplicating subtle surrogate-pair logic, extract the segment-processing code into a local helper used by both branches.

Example refactor inside `readTextLineWindow.fn`:
```ts
type WindowState = {
  currentPos: number;
  prevCodeUnitInLine: number | null;
  outText: string;
  pendingEndSurrogateCheck: boolean;
  startBoundaryChecked: boolean;
};

function consumeSegment(
  state: WindowState,
  segment: string,
  startChar: number,
  targetEndCandidate: number,
): void {
  // Move the existing onContent body here, replacing references with `state.*`.
}
```

Then in the positive branch `onContent`, call `consumeSegment(...)` only when on the target line.
In the negative branch, call `consumeSegment(...)` for every segment decoded from the known line range.

**Step 4: Run `readTextLineWindow` tests**

Run:
```bash
bun test test/readTextLineWindow.test.ts
```
Expected: PASS.

**Step 5: Run the full suite**

Run:
```bash
bun test
```
Expected: PASS.

**Step 6: Commit**

Run:
```bash
```

---

### Task 6: Update Kit Docs + Build Artifacts

**Files:**
- Modify: `src/kits/fs/index.ts` docs for `readTextWindow`, `readTextLineWindow`, `docs.migrations`, `docs.changelog`.

**Step 1: Update migrations/changelog bullets**

Add to migrations (Unreleased) and changelog:
- `readTextWindow` supports negative `startLine` for tail-style reads (`-1` is the last line).
- `readTextLineWindow` supports negative `line` with the same convention.

**Step 2: Run typecheck**

Run:
```bash
bun run typecheck
```
Expected: PASS.

**Step 3: Build dist**

Run:
```bash
bun run build
```
Expected: dist updated, no TS errors.

**Step 4: Commit dist + docs updates**

Run:
```bash
```

---

## Notes / Risks

- Correct CRLF handling across chunk boundaries is the main correctness risk; keep the explicit regression test.
- This plan keeps the output contract deterministic and bounded, but runtime is still proportional to:
  - the bytes needed to find K line breaks from EOF, plus
  - the total byte length of the returned lines (for exact omitted char counts and accurate `nextStartChar`).
