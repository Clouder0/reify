# Reify (Skill / Meta Doc)

Reify is a **code-first, typed toolkit for agents**.

You do not "invoke tools" through a framework. You **import normal functions** and call them.

Reify v1 is **kit-major**:

- The package root helps you discover built-in kits and inspect tool details.
- Once you pick a kit, you operate within that kit (docs + dynamic dispatch live on the kit object).

This document is meant to be installed into your agent host as a "skill" so you can reliably
discover and use Reify without reading source.

In code examples, replace `<REIFY_IMPORT>` with the module specifier you import Reify from
in your environment (canonical: `@reify-ai/reify`).

## Runtime Convention (Bun-First)

Unless explicitly instructed otherwise, use Bun for all JavaScript/TypeScript execution.

- Preferred runtime and package manager: `bun`
- Prefer commands: `bun -e`
- Do not default to: `node`, `npm`, `npx`
- If Bun is unavailable, state that explicitly, then use Node equivalents as a fallback

## Reify Philosophy (General Agent Behavior)

Reify is not only an API shape; it is an operating style for agent work.

- **Use CodeAct loops for all tasks**, even when you are not calling Reify tools:
  1. Check current context and available interfaces.
  2. Choose the smallest useful next action.
  3. Execute with concrete code/tool calls.
  4. Observe outputs/errors.
  5. Iterate or finish with explicit verification.
- **Prefer action over speculation**: keep reasoning short, then run the next concrete step.
- **Use progressive disclosure everywhere**: start from compact indexes/summaries, then drill into details only when needed.
- **Keep contracts explicit**: prefer structured inputs/outputs, typed boundaries, and inspectable metadata over ad-hoc strings.
- **Evidence before claims**: verify with fresh command/tool output before stating success.

## What Reify Provides

- Root exports:
  - `listKits()`
  - `inspectTool(tool)`
  - `listTools(kit)` / `listDocs(kit)`
  - `defineTool(...)` / `defineKit(...)` (authoring)
- Kit modules (example: `<REIFY_IMPORT>/kits/fs`):
  - Named exports for tools (primary calling surface)
  - Default export: the kit object (docs + dynamic dispatch)

## Hard Invariants (Do Not Guess)

- **Tool calling**:
  - Tools take exactly one input object (validated by ArkType contracts).
  - Tools are async (`await` everything).
  - Output schemas exist for inspection; outputs are not validated by default, but authors can enable per-tool validation with `validateOutput: true` in `defineTool`.
- **Kit surface**:
  - `kit.docs` is a map: `kit.docs["index"]`, `kit.docs["recipes/browse-read"]`, ...
  - `kit.tools` is a map for dynamic dispatch; prefer named imports for normal calling.
- **Unlisted tools (`meta.hidden`)**:
  - `listTools(kit)` is a curated index: tools with `tool.meta.hidden === true` are omitted to reduce index bloat.
  - Unlisted tools are still supported and callable: they remain present in `kit.tools`, and kit docs may link to them via `reify:` tool links.
- **Link convention** inside Markdown docs:
  - Tool: `reify:tool/<kitImport>#<toolName>`
  - Doc: `reify:doc/<kitImport>#<docName>`
  - To follow a link: import the kit module, then use `kit.tools[...]` / `kit.docs[...]`.

## Agent Workflow (Canonical)

Use the Reify philosophy above as your default loop across the whole task. The steps below are the Reify-specific path once you are working with Reify kits.

0. Verify runtime with `bun --version` (or explicitly declare fallback if Bun is unavailable).
1. Call `listKits()` to discover built-in kits and their import specifiers.
2. Import the kit module you want.
3. Use `listTools(kit)` / `listDocs(kit)` for compact progressive-disclosure indexes (note: `listTools` omits unlisted tools).
4. Read kit docs via `kit.docs[...]` when you need guidance.
5. Inspect tool details via `inspectTool(tool)` when you need exact I/O.
6. Import the tool by name and call it like normal code.

### Running snippets (Bun)

```bash
bun -e 'import { listKits } from "<REIFY_IMPORT>"; console.log(JSON.stringify(listKits(), null, 2));'
```

## Examples

### Discover built-in kits

```ts
import { listKits } from "<REIFY_IMPORT>";

console.log(JSON.stringify(listKits(), null, 2));
```

### Read a kit doc page

```ts
import fsKit from "<REIFY_IMPORT>/kits/fs";

console.log(fsKit.docs["index"].doc);
```

### Inspect tool details and then call it

```ts
import { inspectTool } from "<REIFY_IMPORT>";
import { readTextWindow } from "<REIFY_IMPORT>/kits/fs";

console.log(JSON.stringify(inspectTool(readTextWindow), null, 2));
const out = await readTextWindow({ path: "README.md", startLine: 1, maxLines: 50 });
console.log(out.text);
```

### Format arbitrary values for LLM display

Tool calls often produce structured JS values. Use `formatValue()` to turn any value into a
compact, prompt-safe string (defaults to a 20k char cap, stable ordering, and tail-preserving
middle truncation).

```ts
import { formatValue, inspectTool } from "<REIFY_IMPORT>";
import { readTextWindow } from "<REIFY_IMPORT>/kits/fs";

console.log(formatValue(inspectTool(readTextWindow)));
```

You can override the cap when needed:

```ts
console.log(formatValue(inspectTool(readTextWindow), { maxChars: 5_000 }));
```

### List tools/docs from a kit

```ts
import { listDocs, listTools } from "<REIFY_IMPORT>";
import fsKit from "<REIFY_IMPORT>/kits/fs";

console.log(listTools(fsKit));
console.log(listDocs(fsKit));
```

## Common Failure Modes

- **Runtime drift**: defaulting to `node`/`npm`/`npx` by habit.
  - Fix by switching to Bun equivalents: `bun --eval`, `bun run`, `bun test`, `bun x`.
- **ArkType input validation errors**: your input object doesn't match the tool schema.
  - Fix by printing `inspectTool(tool).input.expression` and matching that contract exactly.
- **Missing kit/tool/doc**: you imported the wrong kit module or used the wrong key.
  - Fix by starting from `listKits()`, then use `listTools(kit)` / `listDocs(kit)`.
- **Tool not found in `listTools(kit)`**: it may be a supported-but-unlisted helper tool (`tool.meta.hidden === true`).
  - Fix by following kit docs and/or checking the kit's `tools` table (`kit.tools["..."]`).
