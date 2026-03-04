# Tool Input `undefined` Omission Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make JS/TS callers able to pass optional tool inputs as `undefined` (e.g. `cursor`, `authToken`) without runtime schema failures, by treating top-level `undefined` values as “omitted keys” (JSON semantics). Update `SKILL.md` so LLM agents learn the rule explicitly.

**Architecture:** Implement a small, shallow normalization step inside `defineTool()` (the single boundary for all tool calls). It removes top-level keys whose value is exactly `undefined` before ArkType validation. This preserves the JSON contract (JSON has no `undefined`) while keeping strict validation for all real values, including `null`.

**Tech Stack:** TypeScript, ArkType schemas, Bun tests.

---

### Task 0: Baseline (prove current behavior)

**Files:**
- None (verification only)

**Step 1: Run the existing `defineTool` tests**

Run: `bun test test/defineTool.test.ts`

Expected: PASS (baseline green)

---

### Task 1: Add a failing test for `undefined` optional inputs

**Files:**
- Modify: `test/defineTool.test.ts`

**Step 1: Write a new failing test**

Add a test that calls a tool with an optional field set to `undefined`.

```ts
test("treats top-level undefined keys as omitted", async () => {
  const tool = defineTool({
    kit: "k",
    name: "t",
    summary: "s",
    input: schema({ cursor: schema("string").optional() }),
    output: schema({ hasCursor: "boolean" }),
    fn: async (input) => ({ hasCursor: Object.prototype.hasOwnProperty.call(input, "cursor") }),
  });

  await expect(tool({ cursor: undefined })).resolves.toEqual({ hasCursor: false });
});
```

Rationale: this is the common agent pattern (`{ cursor }`) and should behave like JSON (key omitted).

**Step 2: Run just this test file and confirm it fails for the right reason**

Run: `bun test test/defineTool.test.ts`

Expected: FAIL with an ArkType validation error mentioning `cursor` and `undefined`.

---

### Task 2: Implement shallow `undefined` omission in `defineTool`

**Files:**
- Modify: `src/defineTool.ts`

**Step 1: Implement a helper to omit `undefined` keys (shallow)**

Add a local helper (or small private function) in `src/defineTool.ts`:

```ts
function omitUndefinedShallow(value: Record<string, unknown>): Record<string, unknown> {
  // Fast path: avoid copying unless needed.
  for (const k of Object.keys(value)) {
    if (value[k] === undefined) {
      // Use object spread so "__proto__" is copied as data.
      const out: Record<string, unknown> = { ...value };
      for (const key of Object.keys(out)) {
        if (out[key] === undefined) delete out[key];
      }
      return out;
    }
  }
  return value;
}
```

Design notes:
- **Shallow only**: fixes common agent ergonomics without unexpected deep transformations.
- **No coercion**: we only remove keys with value exactly `undefined`.
- **Keep `null` strict**: `null` should still validate (and often fail) explicitly.

**Step 2: Apply it before ArkType validation**

In the tool wrapper, after the `isObjectPayload(raw)` guard and before `def.input.assert(raw)`:

```ts
const sanitized = omitUndefinedShallow(raw);
const parsed = def.input.assert(sanitized) as ObjectPayload<I["infer"]>;
```

**Step 3: Run the test and confirm it now passes**

Run: `bun test test/defineTool.test.ts`

Expected: PASS.

---

### Task 3: Add guardrail tests (don’t hide real errors)

**Files:**
- Modify: `test/defineTool.test.ts`

**Step 1: `null` is NOT treated as omitted**

```ts
test("does not treat null as omitted", async () => {
  const tool = defineTool({
    kit: "k",
    name: "t",
    summary: "s",
    input: schema({ cursor: schema("string").optional() }),
    output: schema("string"),
    fn: async ({ cursor }) => cursor ?? "none",
  });

  await expect(tool({ cursor: null as any })).rejects.toBeInstanceOf(Error);
});
```

**Step 2: Nested `undefined` is NOT silently cleaned**

```ts
test("does not deep-strip undefined in nested objects", async () => {
  const tool = defineTool({
    kit: "k",
    name: "t",
    summary: "s",
    input: schema({ inner: schema({ x: "string" }) }),
    output: schema("string"),
    fn: async ({ inner }) => inner.x,
  });

  await expect(tool({ inner: { x: undefined as any } })).rejects.toBeInstanceOf(Error);
});
```

**Step 3: Required keys still reject `undefined`**

```ts
test("still rejects undefined for required keys", async () => {
  const tool = defineTool({
    kit: "k",
    name: "t",
    summary: "s",
    input: schema({ repo: "string" }),
    output: schema("string"),
    fn: async ({ repo }) => repo,
  });

  await expect(tool({ repo: undefined as any })).rejects.toBeInstanceOf(Error);
});
```

**Step 4: Re-run test file**

Run: `bun test test/defineTool.test.ts`

Expected: PASS.

---

### Task 4: Teach agents in `SKILL.md` (single source of truth)

**Files:**
- Modify: `SKILL.md`

**Step 1: Add a clear tool-calling invariant about `undefined` omission**

In `## Hard Invariants (Do Not Guess)` → `- **Tool calling**`, add a short bullet explaining:

- Inputs are JSON-like.
- Top-level keys whose value is exactly `undefined` are treated as omitted before ArkType validation (shallow only).
- `null` is validated normally (do not pass `null` for optional strings).

**Step 2: Add a small JS/TS example showing the common agent pattern**

Add an example that demonstrates the "natural" calling style (no conditional object spreading):

```ts
const cursor: string | undefined = undefined;
await someTool({ cursor });
// Equivalent to: await someTool({})
```

**Step 3: Keep kit docs DRY**

Do not add or duplicate this note in kit docs unless a kit has a truly kit-specific footgun. If a kit doc needs a reminder, prefer a short pointer like “See `SKILL.md` for JS/TS calling conventions” rather than repeating the full rule.

---

### Task 5: Verification (evidence before claims)

**Step 1: Targeted tests**

Run:
- `bun test test/defineTool.test.ts`
- `bun test test/github-*.test.ts`

Expected: all pass.

**Step 2: Full suite + build**

Run:
- `bun test`
- `bun run typecheck`
- `bun run build`

Expected: all pass.

**Step 3: Real “agent-style” smoke run**

After `bun run build`, run a small script that uses the natural loop:

```ts
let cursor: string | undefined;
do {
  const page = await listThreadStream({ repo, number, cursor });
  cursor = page.nextCursor;
} while (cursor);
```

Expected: no validation error on the first call (when `cursor` is `undefined`).
