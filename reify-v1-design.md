# Reify v1 Design (Kit-Major, Function-Native)

Reify v1 is a **code-first, typed toolkit for agents**.

The v1 design is intentionally minimal:

- **Tools are normal async functions** you import and call.
- **Kits are the unit of navigation** (docs + dynamic dispatch live on the kit object).
- The package root provides only:
  - a **built-in kit list** (`listKits()`) that tells you what to import
  - **inspection helpers** for readable, JSON-friendly tool details.

This document is the normative v1 spec for this repository.

---

## Goals

1. **Function-native execution**: calling a tool should look like calling any other TypeScript function.
2. **Typed contracts**: tools declare ArkType input/output schemas and attach them as metadata.
3. **Progressive disclosure without global registries**: agents discover kits globally, then operate within a chosen kit.
4. **Docs live with code**: kits ship small markdown pages in a map for direct lookup.

## Non-Goals (v1)

- No protocol-first invocation layer (MCP/HTTP) as the primary interface.
- No scanning `node_modules`/lockfiles to discover installed kits.
- No global ref-inspection registry that must resolve every tool/doc string.
- No capability sandboxing/policy framework in core.

---

## Public API

### Package root (`@reify-ai/reify`)

The package root exports:

- `defineTool(...)` (authoring)
- `defineKit(...)` (authoring + invariant validation)
- `inspectTool(tool)` (JSON-friendly tool inspection)
- `listTools(kit)` / `listDocs(kit)` (kit-scoped progressive-disclosure indexes)
- `listKits()` (built-in kit discovery)

It intentionally does **not** export a global ref resolver/registry inspector.

### Kit modules (`@reify-ai/reify/kits/<kit>`)

Each kit module exports:

- Named exports for each tool function (the primary calling surface)
- `default` export: a `kit` object containing `docs` and `tools` tables

Example usage:

```ts
import fsKit, { readTextWindow } from "@reify-ai/reify/kits/fs";

// Function-native calling (primary path)
const out = await readTextWindow({ path: "README.md", startLine: 1, maxLines: 50 });
console.log(out.text);

// Kit navigation (docs + dynamic dispatch)
const index = fsKit.docs["index"];
const dynamic = fsKit.tools["readTextWindow"];
```

---

## Data Model

### Tool

A tool is an async function with attached metadata.

Tool metadata includes:

- `kit`: kit name (string)
- `name`: tool name (string)
- `summary`: one-line description for listing
- `hidden`: boolean (defaults to `false`); when `true`, the tool is supported but unlisted (omitted from `listTools(kit)`) to reduce index bloat.
- `input`: ArkType object schema (single-object input enforced)
- `output`: ArkType schema (required)
- `doc?`: optional markdown (examples, nuance)

`hidden` is for progressive disclosure only. It is not a security boundary and does not affect whether a tool exists in `kit.tools` or can be called.

Tools are trusted code; outputs are not validated by default.
Tool authors can opt in per tool with `validateOutput: true` in `defineTool`.

### Kit

A kit is a plain object with:

- `name`: kit name
- `summary`: one-line kit summary
- `docs`: a map from doc name to `{ summary, doc }`
- `tools`: a map from tool name to tool function

Docs are stored as a map (not an array) so a caller can directly access:

```ts
kit.docs["recipes/browse-read"]
```

The `tools` table is for dynamic selection and enumeration; function-native usage should prefer named imports.

---

## `defineKit` Invariants

`defineKit` validates at module initialization time and throws clear errors if a kit is internally inconsistent.

Required invariants:

1. For every tool entry:
   - the record key equals `tool.meta.name`
   - `tool.meta.kit` equals `kit.name`
2. Docs are well-formed map entries with string `summary` and `doc`.

Why this exists:

- `satisfies Kit` only checks structural shape. It cannot reliably enforce relational invariants between record keys and tool metadata (especially if tool metadata types are widened to `string`).
- Agents rely on metadata for calling correctness; failing fast avoids silent drift.

---

## Tool Inspection (`inspectTool`)

Reify avoids printing raw schema internals. Instead, `inspectTool(tool)` returns expression-first ArkType contract details suitable for:

```ts
import { inspectTool } from "@reify-ai/reify";
import { readTextWindow } from "@reify-ai/reify/kits/fs";

console.log(JSON.stringify(inspectTool(readTextWindow), null, 2));
```

Expected output shape:

- `kit`, `name`, `summary`
- `hidden?`: present and set to `true` for supported-but-unlisted tools; omitted otherwise.
- `input`: `{ expression: string; description?: string }`
- `output`: `{ expression: string; description?: string }`
- `doc?`: markdown if provided

`inspectTool` is a pure inspection helper over `tool.meta`. It does not perform lookup and does not attempt to manufacture a canonical import string.

---

## Kit-Scoped Progressive Disclosure (`listTools`, `listDocs`)

For a chosen kit object, Reify provides compact summary indexes:

```ts
import fsKit from "@reify-ai/reify/kits/fs";
import { listDocs, listTools } from "@reify-ai/reify";

console.log(listTools(fsKit));
console.log(listDocs(fsKit));
```

- `listTools(kit)` returns sorted `{ name, summary }` entries derived from `kit.tools`.
- `listTools(kit)` omits tools where `tool.meta.hidden === true` (supported-but-unlisted helper tools).
- `listDocs(kit)` returns sorted `{ name, summary }` entries derived from `kit.docs`.

These are convenience helpers only; the source of truth remains `kit.tools` and `kit.docs`.

---

## Built-In Discovery (`listKits`)

`listKits()` is the only global enumerator. It returns a stable list of built-in kits, each including a copy/pasteable module specifier:

```ts
import { listKits } from "@reify-ai/reify";

console.log(listKits());
// [{ name: "fs", summary: "...", import: "@reify-ai/reify/kits/fs" }, ...]
```

This is the only place Reify promises an authoritative import string.

---

## `reify:` Link Convention (Fully-Qualified)

Docs may link to tools/docs using a fully-qualified convention that includes the kit import specifier:

- Tool: `reify:tool/<kitImport>#<toolName>`
- Doc: `reify:doc/<kitImport>#<docName>`

Examples:

- `reify:tool/@reify-ai/reify/kits/fs#readTextWindow`
- `reify:doc/@reify-ai/reify/kits/fs#recipes/browse-read`

Resolution is deterministic:

1. Parse the kind (`tool`/`doc`), kit import specifier, and target after `#`.
2. `await import(kitImport)`
3. Use the kit default export:
   - `kit.tools[toolName]`
   - `kit.docs[docName]`

This avoids ambiguous global names (multiple packages can define an `fs` kit) and eliminates the need for a global registry-based ref resolver.

---

## Recommended Authoring Pattern

Kits should export named tools and a default kit that points to those named exports:

```ts
import { type as schema } from "arktype";
import { defineKit, defineTool } from "@reify-ai/reify";

export const hello = defineTool({
  kit: "demo",
  name: "hello",
  summary: "Say hello",
  input: schema({ name: schema("string").describe("Name") }),
  output: schema("string"),
  fn: async ({ name }) => `hello ${name}`,
});

const kit = defineKit({
  name: "demo",
  summary: "Demo kit",
  docs: {
    index: { summary: "Overview", doc: "# Demo" },
  },
  tools: { hello },
});

export default kit;
```

---

## Testing Expectations

- `defineKit` should have unit tests proving it fails fast on mismatched tool keys / kit names.
- `inspectTool` should have unit tests proving readable schema inspection output.
- Each built-in kit should have at least one integration test exercising real tool behavior.

---

## Adding a Built-In Kit (Current Repo Pattern)

When adding a built-in kit, keep discovery and runtime behavior aligned through the kit module itself.

1. Create `src/kits/<kit>/index.ts` that exports:
   - named tool functions
   - `default` kit object (`defineKit({...})`)
   - a kit import constant (for example `export const demoKitImport = "@reify-ai/reify/kits/demo"`)
2. Add a package subpath export in `package.json`:
   - `"./kits/<kit>": { "types": "...", "default": "..." }`
3. Register the kit in `src/listKits.ts` by importing the kit default export + import constant.
4. Build `reify:` links from the same import constant to avoid drift:
   - `reify:tool/<kitImport>#<toolName>`
   - `reify:doc/<kitImport>#<docName>`
5. Add/extend tests to verify:
   - the kit appears in `listKits()`
   - docs links resolve to existing `kit.tools[...]` / `kit.docs[...]`
   - real tool behavior works via integration tests.

Minimal shape:

```ts
// src/kits/demo/index.ts
export const demoKitImport = "@reify-ai/reify/kits/demo";

export const hello = defineTool({ /* ... */ });

const kit = defineKit({
  name: "demo",
  summary: "Demo kit",
  docs: {
    index: {
      summary: "Overview",
      doc: `See ${"reify:tool/" + demoKitImport + "#hello"}`,
    },
  },
  tools: { hello },
});

export default kit;
```
