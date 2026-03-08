# Reify

Reify is a typed toolkit for agents. Tools are normal TypeScript functions — import them and call them like any code.

## Quick Start

```ts
import { listKits } from "@reify-ai/reify";
console.log(listKits());
```

Output:

```
[
  { name: "fs",     summary: "Bounded filesystem browsing (scan + search + windowed reads + CAS edits)", import: "@reify-ai/reify/kits/fs" },
  { name: "github", summary: "Read-only GitHub Threads vision (issues + PRs)",                          import: "@reify-ai/reify/kits/github" }
]
```

Pick a kit, import it, call its tools:

```ts
import { readTextWindow } from "@reify-ai/reify/kits/fs";

const page = await readTextWindow({ path: "src/index.ts", startLine: 1, maxLines: 50 });
console.log(page.text);
```

That is a complete tool call. No protocol, no dispatcher — just a function.

## Philosophy

Reify is not just a set of tools. It is a way of working. These principles apply to everything you do — whether you are calling Reify tools, writing general code, or reasoning about a task.

### Tools are code

In most agent frameworks, tools live behind a protocol. The agent sends a JSON request, a dispatcher routes it, and a result comes back. Each tool call is a round-trip through the LLM.

Reify removes this boundary. Tools are TypeScript functions. This means:

- **You can use any library alongside Reify.** Need to parse JSON, manipulate paths, format dates? Use the standard library or any npm package. You are not locked into a tool catalog.
- **The same code works for agents and humans.** A function an agent calls is the same function a developer imports in an application, a test, or a script. There is no "agent API" vs "human API."
- **Tool results are values, not messages.** You can `.filter()`, `.map()`, destructure, or transform results with normal code before they reach your context window.

### Compose freely in one execution

Because tools are code, you can do many things in a single execution. When you are confident about a sequence of steps, batch them:

```ts
import { scanTree, searchText, readTextWindow } from "@reify-ai/reify/kits/fs";

// One execution: scan, search, read the first match, extract what you need
const tree = await scanTree({ path: "src", maxDepth: 2 });
const hits = await searchText({ path: "src", pattern: "export default", limit: 10 });

const summaries = [];
for (const hit of hits.matches.slice(0, 3)) {
  const page = await readTextWindow({ path: hit.path, startLine: Math.max(1, hit.line - 5), maxLines: 20 });
  summaries.push({ file: hit.path, context: page.text });
}

console.log(summaries);
```

This does in one step what would take 5+ round-trips in a protocol-based framework. Intermediate results never touch the context window — only the final output matters.

The same applies to mixing Reify with general code:

```ts
import { readTextWindow } from "@reify-ai/reify/kits/fs";
import { resolve } from "node:path";

const configPath = resolve("tsconfig.json");
const page = await readTextWindow({ path: configPath, startLine: 1, maxLines: 100 });
const config = JSON.parse(page.text);
console.log("Compiler target:", config.compilerOptions?.target);
```

You are writing code. Use the full language.

### Scale effort to confidence

Composition is powerful, but only when you know what you are doing.

- **High confidence** — batch multiple steps into one execution. You know the files exist, you know the format, you know what to extract. Run it all at once.
- **Low confidence** — take one small step. Run it. Read the output. Decide the next step based on what you see.

This is not a binary choice. It is a spectrum. A single task might start with cautious one-step exploration, then shift to confident multi-step batches once you understand the structure.

The default when uncertain: **act, then observe.** Run the smallest useful step. Look at the actual output. One executed command teaches more than ten lines of planning.

### Start small, drill deeper

Information should be consumed in layers, not all at once.

In Reify, discovery is layered: `listKits()` → `listTools(kit)` → `inspectTool(tool)` → `kit.docs[...]`. Each layer is small. You only go deeper when the summary is not enough.

This principle applies to all work:
- Scan a directory before reading individual files.
- Read a file window before reading the whole file.
- Search with a broad pattern before narrowing.
- Skim structure before diving into implementation.

### Verify with evidence

Check results with actual output before claiming success.

- Changed a file? Read it back.
- Fixed a bug? Run the test.
- Installed a package? Verify the import works.

Evidence first, conclusions second.

### Respect boundaries

Every Reify tool is bounded — capped entries, windowed reads, limited results. This is intentional. Unbounded output wastes your context window and produces worse results. Work within the bounds: page through results, narrow your search, read specific line ranges.

### Keep outputs compact

Tool results go back into your context window. Use `formatValue()` instead of `JSON.stringify()` to keep them compact. Fewer tokens spent on output means more room for reasoning.

```ts
import { formatValue } from "@reify-ai/reify";
console.log(formatValue(result));
```

`formatValue()` uses stable key ordering, minimal whitespace, and middle-truncation (preserving the tail, where errors tend to appear). Default cap is 20,000 characters.

## Workflow

Follow these steps when discovering and using Reify tools.

**Step 1.** Call `listKits()` to see available kits and their import paths.

**Step 2.** Import the kit you need. Each kit has two kinds of exports:
  - **Named exports** = tool functions you call directly (e.g. `readTextWindow`, `scanTree`)
  - **Default export** = the kit object, which holds docs and a tools map

**Step 3.** Use `listTools(kit)` to see the kit's tools. Use `listDocs(kit)` to see its doc pages.

```ts
import { listTools, listDocs } from "@reify-ai/reify";
import fsKit from "@reify-ai/reify/kits/fs";

console.log(listTools(fsKit));
// [ { name: "editText", summary: "..." },
//   { name: "readTextWindow", summary: "..." },
//   { name: "scanTree", summary: "..." },
//   { name: "searchText", summary: "..." } ]

console.log(listDocs(fsKit));
// [ { name: "changelog", summary: "..." },
//   { name: "concepts/paths", summary: "..." },
//   { name: "index", summary: "..." },
//   { name: "recipes/browse-read", summary: "..." }, ... ]
```

**Step 4.** When you need exact input/output types for a tool, use `inspectTool()`:

```ts
import { inspectTool, formatValue } from "@reify-ai/reify";
import { readTextWindow } from "@reify-ai/reify/kits/fs";

console.log(formatValue(inspectTool(readTextWindow)));
```

**Step 5.** When you need workflow guidance, read a kit doc page:

```ts
console.log(fsKit.docs["recipes/browse-read"].doc);
```

**Step 6.** Import the tool by name and call it.

## Rules

These are hard constraints. Follow them exactly.

1. **Every tool takes one input object.** Pass a single `{ key: value }` object, not positional arguments.

2. **Every tool is async.** Always use `await`.

3. **Optional keys can be omitted or set to `undefined`.** Both are treated the same way. Required keys must always be provided.

4. **`listTools()` shows primary tools only.** Some kits have hidden helper tools (`meta.hidden: true`). These are still callable — find them in kit docs or via `kit.tools["toolName"]`.

5. **Inputs are validated at the boundary.** If you get a validation error, run `inspectTool(tool)` to see the exact schema, then fix your input to match.

## Runtime

Use `bun` for all execution unless instructed otherwise.

```bash
bun -e 'import { listKits } from "@reify-ai/reify"; console.log(listKits());'
```

If `bun` is unavailable, use `node` as a fallback and state that explicitly.

## Error Recovery

If a tool call fails:

1. Read the error message — it usually tells you what went wrong.
2. Run `inspectTool(tool)` to see the exact input schema.
3. Fix your input to match the schema.
4. Retry.

If a kit or tool is not found:

1. Run `listKits()` to verify available kits.
2. Run `listTools(kit)` to verify available tools.
3. Check `kit.tools["name"]` for hidden helper tools not shown by `listTools`.
