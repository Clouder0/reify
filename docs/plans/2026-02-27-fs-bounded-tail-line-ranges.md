# fs Tail-Line Reads: Bounded Memory for Huge Negative Indexes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make negative line indexing (`readTextWindow.startLine < 0`, `readTextLineWindow.line < 0`) **memory-bounded** even when `abs(startLine)` / `abs(line)` is huge, without changing any user-visible semantics.

**Architecture:**
- Keep the existing reverse byte-scan algorithm (it’s correct and already chunked).
- Split “how many lines we must *count*” from “how many line ranges we must *store*”.
- Add an optional `keep` option to `collectTailLineRanges()` that stores only the last `keep` discovered ranges in a ring buffer, while still counting all discovered lines until the requested `count` is reached (or BOF).
- Update `readTextWindow` and `readTextLineWindow` negative-index branches to pass an appropriate `keep` (`<= maxLines` or `1`) so memory stays proportional to output budget.

**Tech Stack:** TypeScript (NodeNext ESM), Node `fs/promises` `FileHandle` + `Buffer`, Bun tests (`bun test`).

---

## Progress (checklist)

- [x] Task 0: Baseline verification
- [x] Task 1: RED - add bounded-keep tailLines test
- [x] Task 2: GREEN - implement `keep` ring buffer + `available`
- [x] Task 3: GREEN - wire `keep` into negative indexing call sites
- [x] Task 4: Full verification (tests/typecheck/build)
- [x] Task 5: RED - add tests for escaping *fatal thrown* `searchText` errors
- [x] Task 6: GREEN - sanitize thrown `searchText` + ripgrep preflight error messages
- [x] Task 7: Full verification (tests/typecheck/build)

## Background / Problem Summary

Today, we already scan backwards with a fixed-size buffer (`src/kits/fs/_tailLines.ts`, `TAIL_READ_CHUNK_BYTES = 64KiB`) so I/O chunking is bounded.

The memory issue is that `collectTailLineRanges(fh, count)` stores **one `TailLineRange` per discovered line** until it hits `count`.

That means a call like:

```ts
await readTextWindow({ path, startLine: -100000000, maxLines: 20 });
```

can allocate millions of `TailLineRange` objects if the file has that many lines, even though `readTextWindow.maxLines` is capped to `<= 1000` and only a small window is ever returned.

**Approach A (chosen):** bounded memory only (semantics unchanged). Runtime can still be large for absurd negative indexes.

---

## Acceptance Criteria

1. Existing behavior stays unchanged (all current tests pass).
2. For negative indexing:
   - `readTextWindow` stores at most `min(maxLines, abs(startLine))` tail ranges.
   - `readTextLineWindow` stores at most `1` tail range.
3. `collectTailLineRanges()` continues to:
   - correctly classify `\n`, `\r`, and `\r\n` (including split across 64KiB chunk boundaries)
   - treat a missing trailing newline as `eol: ""` for the last line
4. Full verification passes:
   - `bun test`
   - `bun run typecheck`
   - `bun run build`

5. `searchText` fatal thrown errors (TypeError) do not include raw terminal control characters.
   - Throw messages derived from rg stderr are escaped for safe printing.
   - Ripgrep preflight/version errors also escape `rgPath` and stderr/stdout first lines.

---

## Current Code Map

- Tail scanner: `src/kits/fs/_tailLines.ts:16` `collectTailLineRanges(fh, count)`
- Negative `readTextWindow` path: `src/kits/fs/index.ts:508` (calls `collectTailLineRanges(fh, kRequested)`)
- Negative `readTextLineWindow` path: `src/kits/fs/index.ts:792` (calls `collectTailLineRanges(fh, k)`)

---

### Task 0: Worktree + Baseline Verification (recommended)

**Files:** none

**Step 1: Choose a worktree location (project-local preferred)**

Run:
```bash
ls -d .worktrees 2>/dev/null || true
ls -d worktrees 2>/dev/null || true
```

Expected: either `.worktrees/` or `worktrees/` exists, or neither.

**Step 2: If using a project-local worktree dir, verify it is ignored**

Run:
```bash
git check-ignore -q .worktrees || git check-ignore -q worktrees
```

Expected: exit code `0` if the directory is ignored. If not ignored, decide whether to add it to `.gitignore` (and commit that separately).

**Step 3: Create a worktree**

Run (example):
```bash
git worktree add .worktrees/fix-fs-tail-lines-bounded-memory -b fix/fs-tail-lines-bounded-memory
```

Expected: a new working directory created.

**Step 4: Install deps (if needed) and run baseline tests**

Run:
```bash
bun install
bun test
```

Expected: PASS.

> **Note:** If working in the main repo (no worktree), still run baseline tests before changing code.

---

### Task 1: Add a failing unit test that proves ranges are kept bounded (RED)

**Files:**
- Create: `test/tailLines.test.ts`

**Step 1: Create the failing test**

Create `test/tailLines.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { collectTailLineRanges } from "../src/kits/fs/_tailLines";

async function readUtf8Range(fh: FileHandle, startByte: number, endByte: number): Promise<string> {
  const len = endByte - startByte;
  if (len <= 0) return "";
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, startByte);
  expect(bytesRead).toBe(len);
  return buf.toString("utf8");
}

test("collectTailLineRanges supports keep to bound returned ranges", async () => {
  const dir = join(process.cwd(), ".tmp-reify-tail-lines-keep");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    const text = Array.from({ length: 10 }, (_, i) => `line-${i + 1}\n`).join("");
    await writeFile(path, text, "utf8");

    const fh = await open(path, "r");
    try {
      // keep=2 should force an O(2) ranges array even though count=10.
      const out = await collectTailLineRanges(fh, 10, { keep: 2 });
      expect(out.available).toBe(10);
      expect(out.ranges.length).toBe(2);

      const a = out.ranges[0];
      const b = out.ranges[1];
      expect(a.eol).toBe("\n");
      expect(b.eol).toBe("\n");

      expect(await readUtf8Range(fh, a.startByte, a.endByte)).toBe("line-2");
      expect(await readUtf8Range(fh, b.startByte, b.endByte)).toBe("line-1");
    } finally {
      await fh.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

**Why this fails today:** `collectTailLineRanges()` ignores `keep` and returns no `available` field.

**Step 2: Run just this test to verify RED**

Run:
```bash
bun test test/tailLines.test.ts
```

Expected: FAIL (assertion failure due to `available` missing and/or `ranges.length` not bounded).

---

### Task 2: Implement `keep` + `available` in `collectTailLineRanges` (GREEN)

**Files:**
- Modify: `src/kits/fs/_tailLines.ts`

**Step 1: Update the signature and return type**

Change:

```ts
export async function collectTailLineRanges(
  fh: FileHandle,
  count: number,
): Promise<{ ranges: TailLineRange[] }> {
```

to:

```ts
export type CollectTailLineRangesOptions = {
  /**
   * Max number of ranges to keep in memory.
   * Defaults to `count` (current behavior).
   */
  keep?: number;
};

export async function collectTailLineRanges(
  fh: FileHandle,
  count: number,
  options: CollectTailLineRangesOptions = {},
): Promise<{ ranges: TailLineRange[]; available: number }> {
```

**Step 2: Validate `options.keep` and compute `keepCount`**

Add near the top (after validating `count`):

```ts
const keepRaw = options.keep ?? count;
if (!Number.isInteger(keepRaw) || keepRaw < 0) {
  throw new TypeError("keep must be an integer >= 0");
}

const keepCount = Math.min(count, keepRaw);
```

**Step 3: Replace the unbounded `ranges.push(...)` behavior with: counter + ring buffer**

Replace `const ranges: TailLineRange[] = [];` with:

```ts
let foundLines = 0;
const kept: TailLineRange[] = [];
let ringIndex = 0; // next index to overwrite (oldest)

const keepRange = (range: TailLineRange) => {
  foundLines += 1;

  if (keepCount === 0) return;

  if (kept.length < keepCount) {
    kept.push(range);
    return;
  }

  kept[ringIndex] = range;
  ringIndex = (ringIndex + 1) % keepCount;
};
```

Then, for every place that currently does:

```ts
ranges.push({ startByte: ..., endByte: ..., eol: ... });
```

replace with:

```ts
keepRange({ startByte: ..., endByte: ..., eol: ... });
```

**Step 4: Update scan loop conditions to use `foundLines` (not stored ranges length)**

Change:
```ts
while (ranges.length < count && pos > 0) {
```

to:

```ts
while (foundLines < count && pos > 0) {
```

Similarly replace inner `ranges.length < count` checks with `foundLines < count`.

**Step 5: Emit BOF line only if we still need one (same semantics)**

Change:

```ts
if (ranges.length < count) {
  ranges.push({ startByte: 0, endByte: cursor, eol: currentEol });
}
```

to:

```ts
if (foundLines < count) {
  keepRange({ startByte: 0, endByte: cursor, eol: currentEol });
}
```

**Step 6: Reconstruct kept ranges in correct order (EOF → BOF) and return**

At the end, add:

```ts
const ranges =
  kept.length < keepCount || keepCount === 0
    ? kept
    : [...kept.slice(ringIndex), ...kept.slice(0, ringIndex)];

return { ranges, available: foundLines };
```

**Step 7: Run the new unit test**

Run:
```bash
bun test test/tailLines.test.ts
```

Expected: PASS.

---

### Task 3: Wire bounded tail keeping into negative indexing call sites (GREEN)

**Files:**
- Modify: `src/kits/fs/index.ts`

**Step 1: Update `readTextWindow` negative branch to pass `keep` and use `available`**

In `src/kits/fs/index.ts` inside `if (startLine < 0) { ... }`:

1. Compute `keep`:

```ts
const keep = Math.min(maxLines, kRequested);
```

2. Change the call:

```ts
const { ranges: tailRanges, available } = await collectTailLineRanges(fh, kRequested, { keep });
```

3. Replace the old slicing logic with simply reversing the kept window:

```ts
const windowRanges = tailRanges.toReversed();
```

(If `toReversed()` isn’t available in the project’s TS target, use `tailRanges.slice().reverse()`.)

4. Keep the existing clamping semantics using `available`:

```ts
const resolvedStartLine = available < kRequested ? -available : startLine;
```

**Step 2: Update `readTextLineWindow` negative branch to pass `keep: 1` and use `available`**

In `src/kits/fs/index.ts` inside `if (line < 0) { ... }`:

1. Replace:

```ts
const { ranges } = await collectTailLineRanges(fh, k);
if (ranges.length < k) { ... }
const target = ranges[k - 1];
```

with:

```ts
const { ranges, available } = await collectTailLineRanges(fh, k, { keep: 1 });
if (available < k) { ... }
const target = ranges[0];
```

**Step 3: Run the existing negative-indexing tests**

Run:
```bash
bun test test/readTextWindow.test.ts
bun test test/readTextLineWindow.test.ts
```

Expected: PASS.

---

### Task 4: Full verification (keep it boring)

**Files:** none

**Step 1: Full test suite**

Run:
```bash
bun test
```

Expected: PASS.

**Step 2: Typecheck**

Run:
```bash
bun run typecheck
```

Expected: PASS.

**Step 3: Build**

Run:
```bash
bun run build
```

Expected: PASS.

---

### Task 5: Add failing tests for escaping fatal thrown `searchText` errors (RED)

**Files:**
- Modify: `test/searchText.test.ts`

**Step 1: Add a test that a fatal rg invocation error is escaped (POSIX only)**

Add under a `process.platform !== "win32"` guard:

```ts
test("searchText escapes fatal thrown rg stderr (no raw ANSI control chars)", async () => {
  const dir = join(process.cwd(), ".tmp-reify-searchText-fatal-error-escape");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    await writeFixture(dir);

    const fakeRgPath = join(dir, "fake-rg-fatal-ansi.sh");
    const esc = "\x1b";
    await writeFile(
      fakeRgPath,
      [
        "#!/bin/sh",
        "for arg in \"$@\"; do",
        "  if [ \"$arg\" = \"--version\" ]; then",
        "    echo \"ripgrep 99.0.0\"",
        "    exit 0",
        "  fi",
        "done",
        `printf "fatal ${esc}[31mboom${esc}[0m\\n" 1>&2`,
        "exit 2",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeRgPath, 0o755);

    const searchText = requireSearchText();
    try {
      await searchText({ path: dir, pattern: "pattern", rgPath: fakeRgPath });
      throw new Error("expected searchText to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg.includes(esc)).toBe(false);
      expect(msg).toContain("\\x1b");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

**Step 2: Add a test that ripgrep preflight errors escape `rgPath` (POSIX only)**

Add:

```ts
test("searchText escapes rgPath in ripgrep preflight errors", async () => {
  const dir = join(process.cwd(), ".tmp-reify-searchText-preflight-rgPath-escape");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    await writeFixture(dir);

    const esc = "\x1b";
    const searchText = requireSearchText();
    await expect(searchText({ path: dir, pattern: "pattern", rgPath: `nope-${esc}-rg` })).rejects.toThrow();
    try {
      await searchText({ path: dir, pattern: "pattern", rgPath: `nope-${esc}-rg` });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg.includes(esc)).toBe(false);
      expect(msg).toContain("\\x1b");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

**Step 3: Run the test file and confirm RED**

Run:
```bash
bun test test/searchText.test.ts
```

Expected: FAIL (today the thrown error messages include raw `\x1b`).

---

### Task 6: Sanitize fatal thrown `searchText` + ripgrep preflight error messages (GREEN)

**Files:**
- Modify: `src/kits/fs/index.ts`

**Step 1: Add a small helper that matches `errors[]` escaping policy**

Add near `escapeTreeName()`:

```ts
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
```

**Step 2: Apply it to the fatal-throw branch in `searchText`**

At the throw site (`src/kits/fs/index.ts:1864`), sanitize the first stderr line before embedding it in the thrown TypeError message.

**Step 3: Apply it to ripgrep preflight errors**

Update `readRipgrepVersion()` to sanitize:
- `rgPath` when embedded in error strings
- stderr/stdout “first line” when embedded in error strings

**Step 4: Run searchText tests**

Run:
```bash
bun test test/searchText.test.ts
```

Expected: PASS.

---

### Task 7: Full verification (keep it boring)

Run:
```bash
bun test
bun run typecheck
bun run build
```

Expected: PASS.

---

## Optional Follow-ups (NOT part of Approach A)

If you also want to bound runtime / DoS risk from absurd negative indexes, add a scan budget (bytes or lines) and surface a “truncated due to scan budget” mode. That is a semantic/product decision, so it’s intentionally out of scope for this plan.
