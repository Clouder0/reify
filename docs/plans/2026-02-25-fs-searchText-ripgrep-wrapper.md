# fs `searchText` (ripgrep JSON wrapper) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a production-grade `searchText` tool to the `fs` kit that wraps ripgrep (`rg --json`) to provide bounded, deterministic, typed search results with progressive-disclosure hints into `readTextWindow`.

**Architecture:**
- Treat ripgrep as the search engine and Reify as the *typed contract + budgeting + determinism layer*.
- Spawn `rg` with `--json` and `--sort=path` to get stable ordering; parse JSON Lines incrementally.
- Enforce strict output budgets in-process (global + per-file), truncate previews, and provide “open context” hints pointing at `readTextWindow`.
- Respect `.gitignore`/ignore files by default, but keep results deterministic by default by scoping ignore discovery to the requested root (no parent ignore files, no global gitignore, no `.git/info/exclude`). Allow override back to ripgrep defaults.

**Tech Stack:** TypeScript (NodeNext ESM), Node `child_process.spawn`, `TextDecoder`, ArkType schemas, Bun tests.

---

## Design Notes (aligns with Reify philosophy)

- **Function-native + typed contracts:** `searchText` is a normal async function exported from `src/kits/fs/index.ts` with ArkType input/output.
- **Progressive disclosure:** `searchText` returns lightweight match metadata + `hint` objects that call `readTextWindow` for bounded context reads.
- **Bounded output:** budgets (`maxMatches`, `maxFilesWithMatches`, `maxMatchesPerFile`, `maxPreviewChars`) ensure the result is always small.
- **Deterministic output:** use `rg --sort=path` and then sort matches by path/line in the wrapper as a second line of defense.
- **Ignore behavior:** default is “sane developer search” by respecting ignore files, but in a deterministic, root-scoped way. Callers can opt back into ripgrep’s native ignore discovery when needed.

---

## Proposed Tool Contract

### Input

```ts
{
  path: string;              // root directory to search
  pattern: string;           // ripgrep pattern (regex by default)
  fixedStrings?: boolean;    // if true, pass --fixed-strings
  caseSensitive?: boolean;   // if false, pass --ignore-case
  smartCase?: boolean;       // if true, pass --smart-case (default true)

  hidden?: boolean;          // include dotfiles (default true for consistency with scanTree)
  respectIgnore?: boolean;   // respect ignore files (.gitignore, .ignore, etc). default true
  ignorePolicy?: "scoped" | "rg"; // when respectIgnore is true: deterministic root-scoped ignores vs ripgrep defaults
  excludeDirs?: string[];    // extra directory basenames to exclude (default: same as scanTree default excludes)

  maxMatches?: number;       // global matching-line cap (default 200)
  maxFilesWithMatches?: number; // cap files returned (default 50)
  maxMatchesPerFile?: number;   // cap matching lines per file (default 20; also passed to rg --max-count)
  maxPreviewChars?: number;  // preview truncation cap (default 200)

  contextLinesBefore?: number; // for readTextWindow hint (default 2)
  contextLinesAfter?: number;  // for readTextWindow hint (default 2)

  rgPath?: string;           // optional override (default "rg")
  timeoutMs?: number;        // kill rg if it runs too long (default 15000)
}
```

### Output

```ts
{
  root: string; // absolute real path
  pattern: string;
  truncated: boolean; // true if we hit budgets or timed out
  files: Array<{
    path: string; // absolute path
    matches: Array<{
      line: number; // 1-based
      preview: string; // bounded/truncated line preview (no trailing newline)
      submatches: Array<{ startByte: number; endByte: number }>; // byte offsets per rg
      hint: { toolRef: string; input: { path: string; startLine: number; maxLines: number } };
    }>;
    more: boolean; // true when file may have more matches than returned
  }>;
  stats?: {
    searches: number;
    searchesWithMatch: number;
    matchedLines: number;
    matches: number;
    bytesSearched: number;
    elapsedMs: number;
  };
  errors: string[]; // rg error events + stderr (bounded)
}
```

Notes:
- We intentionally use `hint -> readTextWindow` (not `readTextLineWindow`) to avoid converting rg byte offsets to JS UTF-16 offsets.
- `preview` truncation uses the same `safeTruncateUtf16` helper + `TRUNCATION_MARKER` to avoid surrogate splits.

---

## Task 0: Preflight

**Files:** none

**Step 1: Verify ripgrep is available**

Run:
```bash
rg --version
```
Expected: prints a version (e.g. `ripgrep 14.x`).

If `rg` is not available, decide up front:
- either treat `searchText` as a “requires rg in PATH” feature and throw a clear error, or
- add a bundled rg dependency (future enhancement; out of scope unless requested).

---

## Task 1: Add Failing Tests (RED)

**Files:**
- Create: `test/searchText.test.ts`

**Step 1: Create a minimal fixture repo in a temp dir**

In `test/searchText.test.ts`, create a helper that:
- creates a temp directory
- writes:
  - `src/a.txt` containing `hello pattern` (match)
  - `src/b.txt` containing `nope`
  - `.hidden.txt` containing `pattern` (hidden)
  - `ignored.txt` containing `pattern` (should be ignored via `.gitignore`)
  - `.gitignore` containing `ignored.txt`

**Step 2: Test basic search returns matches with deterministic ordering**

```ts
test("searchText returns bounded matches grouped by file", async () => {
  const out = await searchText({ path: root, pattern: "pattern", maxMatches: 10 });
  expect(out.files.length).toBeGreaterThan(0);
  expect(out.files[0].path.endsWith(".hidden.txt") || out.files[0].path.includes("src")).toBe(true);
  expect(out.truncated).toBe(false);
});
```

**Step 3: Test `.gitignore` is respected by default**

```ts
test("searchText respects ignore files by default", async () => {
  const out = await searchText({ path: root, pattern: "pattern" });
  expect(out.files.some((f) => f.path.endsWith("ignored.txt"))).toBe(false);
});
```

**Step 4: Test ignore override finds ignored file**

```ts
test("searchText can disable ignore files", async () => {
  const out = await searchText({ path: root, pattern: "pattern", respectIgnore: false });
  expect(out.files.some((f) => f.path.endsWith("ignored.txt"))).toBe(true);
});
```

**Step 5: Test hidden default includes dotfiles**

```ts
test("searchText searches hidden files by default", async () => {
  const out = await searchText({ path: root, pattern: "pattern" });
  expect(out.files.some((f) => f.path.endsWith(".hidden.txt"))).toBe(true);
});
```

**Step 6: Test global budgeting truncates deterministically**

```ts
test("searchText enforces maxMatches budget", async () => {
  const out = await searchText({ path: root, pattern: "pattern", maxMatches: 1 });
  const total = out.files.reduce((n, f) => n + f.matches.length, 0);
  expect(total).toBe(1);
  expect(out.truncated).toBe(true);
});
```

**Step 7: Run tests and confirm they fail**

Run:
```bash
bun test test/searchText.test.ts
```
Expected: FAIL (tool not implemented / export missing).

---

## Task 2: Implement `rg --json` Runner (GREEN)

**Files:**
- Create: `src/kits/fs/_ripgrepJson.ts`

**Step 1: Implement a streaming JSON-lines parser**

Create a helper that:
- spawns `rg` using `spawn(rgPath, args, { cwd: root })`
- reads stdout as UTF-8 text
- buffers partial chunks until `\n`, then `JSON.parse` per line
- ignores empty lines

**Step 2: Implement early-stop logic for budgets**

When budgets are hit:
- set `truncated = true`
- call `child.kill()`
- resolve with results collected so far

**Step 3: Handle exit codes**

Interpret ripgrep exit codes:
- `0`: matches found
- `1`: no matches found (not an error)
- `>1`: error; capture stderr and return it via `errors` (and consider throwing only if no partial results).

**Step 4: Add a timeout**

If `timeoutMs` elapses:
- kill the process
- set `truncated = true`
- include an error like `"rg timed out after Xms"`

---

## Task 3: Implement `searchText` Tool (GREEN)

**Files:**
- Modify: `src/kits/fs/index.ts`

**Step 1: Define the tool with ArkType input/output**

Add `export const searchText = defineTool({ ... })` with:
- `kit: fsKitName`
- `name: "searchText"`
- `summary: "Search text under a directory (ripgrep wrapper)"`

**Step 2: Validate and normalize inputs**

- Ensure `path` exists and is a directory (`await stat(path)`)
- Resolve `root = await realpath(path)`
- Validate numeric budgets and clamp/throw for invalid values

**Step 3: Build rg args (deterministic + sane defaults)**

Always include:
- `--json`
- `--sort=path`

Defaults:
- `hidden: true` => pass `--hidden`
- `respectIgnore: true` => do nothing (rg default)
- `respectIgnore: false` => pass `--no-ignore`
- `maxMatchesPerFile` => pass `--max-count=<N>`

Extra excludes:
- For each `excludeDirs` entry, pass `--glob=!**/<dir>/**`

Search target:
- use `rg <pattern> .` with `cwd = root`

**Step 4: Parse match events into bounded, typed output**

For each `match` event:
- compute `absPath` (join `root` with `data.path.text` if relative)
- build a `preview` string:
  - take `data.lines.text`
  - strip a single trailing line ending (`\r\n`, `\n`, or `\r`)
  - truncate to `maxPreviewChars` with `safeTruncateUtf16(..., { treatAsTruncated: true })`
  - append `TRUNCATION_MARKER` if truncated
- add `submatches` as `{ startByte, endByte }`
- add `hint`:
  - `toolRef: toolLink("readTextWindow")`
  - `input: { path: absPath, startLine: max(1, line - contextBefore), maxLines: contextBefore + 1 + contextAfter }`

**Step 5: Compute `more` flags**

- `file.more = true` when `matches.length === maxMatchesPerFile` (means “maybe more”).
- `out.truncated = true` when global `maxMatches` is hit or timeout triggers.

**Step 6: Add tool to kit export table**

In the default kit export at bottom of `src/kits/fs/index.ts`, add `searchText` to `tools`.

**Step 7: Run the new tests**

Run:
```bash
bun test test/searchText.test.ts
```
Expected: PASS.

---

## Task 4: Docs + Changelog

**Files:**
- Modify: `src/kits/fs/index.ts` (docs map)

**Step 1: Document `searchText` in the fs kit index and migrations**

Add:
- What it does
- How it respects `.gitignore` by default
- Budget fields and deterministic behavior (`--sort=path`)
- How to follow a match with `readTextWindow` via hints

---

## Task 5: Full Verification

**Files:** none

**Step 1: Run full test suite**

Run:
```bash
bun test
```
Expected: PASS.

**Step 2: Run typecheck**

Run:
```bash
bun run typecheck
```
Expected: PASS.

---

## Task 6: Commit (optional, only if requested)

Suggested commit structure:
- `test(fs): specify searchText ripgrep wrapper behavior`
- `feat(fs): add searchText ripgrep JSON wrapper`
- `docs(fs): document searchText`
