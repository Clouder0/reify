# Reify

**Code-first, typed toolkit for AI agents.**

```ts
import { readTextWindow } from "@reify-ai/reify/kits/fs";

const page = await readTextWindow({ path: "src/index.ts", startLine: 1, maxLines: 80 });
console.log(page.text);
```

That's a tool call. It's also just a function call.

## Why Reify

Most agent tool frameworks put a protocol between the agent and the work. MCP servers, HTTP endpoints, JSON-RPC dispatchers — the agent proposes a tool call as structured data, a dispatcher routes it, the result comes back, and the agent reasons about what to do next. Each tool call is a round-trip through the LLM.

Reify removes this boundary. **Tools are normal TypeScript functions.** You import them and call them. This has consequences that go beyond ergonomics:

**One interface for agents and humans.** A function an agent calls is the same function a developer imports in an application, a test, or a script. There is no "agent API" separate from the "human API." Code written by an agent is reusable by a human, and vice versa. Any npm package or standard library function works alongside Reify tools — you are not locked into a tool catalog.

**Composition in one execution.** Because tools are code, an agent can chain multiple calls, transform outputs, use conditionals, and handle errors — all in a single execution. Intermediate results stay in local variables, not the context window. What takes 5+ round-trips in a protocol-based framework becomes one step:

```ts
import { searchText, readTextWindow } from "@reify-ai/reify/kits/fs";

const hits = await searchText({ path: "src", pattern: "export default", limit: 10 });

const summaries = [];
for (const hit of hits.matches.slice(0, 3)) {
  const page = await readTextWindow({ path: hit.path, startLine: Math.max(1, hit.line - 5), maxLines: 20 });
  summaries.push({ file: hit.path, context: page.text });
}

console.log(summaries);
```

**Typed contracts.** Every tool declares [ArkType](https://arktype.io/) input/output schemas. Types serve as documentation, validation, and introspection in one artifact. Wrong inputs fail fast at the boundary with clear errors, not deep inside implementation code.

**Progressive disclosure.** Agents operating under token budgets shouldn't ingest a full API reference upfront. Reify structures discovery in layers — `listKits()` → `listTools(kit)` → `inspectTool(tool)` → `kit.docs[...]` — each one small, each one sufficient to decide whether to go deeper.

**Bounded by default.** Every operation that touches external state has hard caps. `scanTree` limits entries. `searchText` limits matches. `readTextWindow` returns a page, not the whole file. Unbounded output is the enemy of agent context windows; Reify tools never produce it.

## Install

Reify is an agent tool, not a project dependency. Install it globally so agents can use it from any project:

```bash
bun install -g @reify-ai/reify
```

### Agent skill setup

Beyond the npm package, agents need the **skill document** (`SKILL.md`) loaded into their context. This teaches the agent the Reify philosophy, discovery workflow, and calling conventions.

**Manual setup:** Copy `SKILL.md` into your agent host's skill system. For Claude Code:

```bash
mkdir -p .claude/skills
cp "$(bun -e 'import{createRequire as c}from"module";console.log(c(import.meta.url).resolve("@reify-ai/reify/SKILL.md"))')" .claude/skills/reify.md
```

**Agent self-setup:** Point your agent at [`onboarding.md`](onboarding.md) — a step-by-step runbook written for agents to install the package and skill document themselves. Give it to an agent via URL or file path and let it follow the instructions.

## Getting Started

### Discover kits

A **kit** is a cohesive collection of tools and documentation, exported as a module.

```ts
import { listKits } from "@reify-ai/reify";

console.log(listKits());
// [
//   { name: "fs",     summary: "Bounded filesystem browsing ...", import: "@reify-ai/reify/kits/fs" },
//   { name: "github", summary: "Read-only GitHub threads ...",    import: "@reify-ai/reify/kits/github" }
// ]
```

### Call tools

Import a kit's tools by name and call them like any async function. Every tool takes a single typed input object:

```ts
import { scanTree, searchText } from "@reify-ai/reify/kits/fs";

const tree = await scanTree({ path: ".", maxDepth: 3 });
const hits = await searchText({ path: "src", pattern: "TODO" });
```

### Inspect and navigate

Each kit also has a default export — an object with `docs` and `tools` maps for introspection and dynamic dispatch:

```ts
import { listTools, listDocs, inspectTool } from "@reify-ai/reify";
import fsKit, { readTextWindow } from "@reify-ai/reify/kits/fs";

listTools(fsKit);     // [{ name: "scanTree", summary: "..." }, ...]
listDocs(fsKit);      // [{ name: "index", summary: "..." }, ...]

inspectTool(readTextWindow);
// { kit: "fs", name: "readTextWindow", summary: "...",
//   input:  { expression: "{ path: string; startLine?: number; ... }" },
//   output: { expression: "{ text: string; lineRange: [number, number]; ... }" } }

fsKit.docs["recipes/browse-read"].doc;  // Markdown
```

### Format output

`formatValue()` replaces `JSON.stringify` for structured output. It uses stable key ordering, minimal whitespace, and middle-truncation (preserving the tail, where errors tend to appear). Default cap is 20,000 characters.

```ts
import { formatValue } from "@reify-ai/reify";

console.log(formatValue(result));
```

## Available Kits

### Filesystem (`@reify-ai/reify/kits/fs`)

Bounded filesystem browsing — scan, search, windowed reads, and atomic edits.

| Tool | Description |
|------|-------------|
| `scanTree` | Recursively scan a directory tree with hard caps on depth and entries |
| `searchText` | Bounded text search via ripgrep with regex support |
| `readTextWindow` | Read a bounded window of lines from a text file |
| `editText` | Compare-and-swap text replacement with atomic writes |

### GitHub (`@reify-ai/reify/kits/github`)

Read-only access to GitHub issues and pull requests, unified as **threads**.

| Tool | Description |
|------|-------------|
| `searchThreads` | Search issues and PRs within a repo |
| `getThread` | Fetch a single issue or pull request |
| `listThreadStream` | Page through comments and key events on a thread |

Authentication resolves automatically: explicit token > `GITHUB_TOKEN` / `GH_TOKEN` env vars > `gh` CLI fallback.

## Authoring Kits

`defineTool` and `defineKit` let you build your own kits with full schema validation.

```ts
import { type } from "arktype";
import { defineTool, defineKit } from "@reify-ai/reify";

const greet = defineTool({
  kit: "hello",
  name: "greet",
  summary: "Greet a user by name",
  input: type({ name: "string" }),
  output: type({ message: "string" }),
  fn: async ({ name }) => ({ message: `Hello, ${name}!` }),
});

export default defineKit({
  name: "hello",
  summary: "A minimal greeting kit",
  docs: {
    index: { summary: "Overview", doc: "# Hello Kit\n\nA simple example kit." },
  },
  tools: { greet },
});

export { greet };
```

`defineKit` validates invariants at module initialization — mismatched names, invalid schemas, and structural problems fail immediately, not at runtime.

## Project Structure

```
src/
  index.ts              # Public exports
  types.ts              # Core type definitions (Kit, Tool, ToolMeta)
  defineTool.ts         # Tool definition with schema validation
  defineKit.ts          # Kit definition with invariant checks
  inspectTool.ts        # JSON-friendly tool introspection
  listKits.ts           # Built-in kit discovery
  listTools.ts          # Kit-scoped tool listing
  listDocs.ts           # Kit-scoped doc listing
  formatValue.ts        # Token-efficient value formatter
  kits/
    fs/                 # Filesystem kit
    github/             # GitHub threads kit
```

## Requirements

- **Runtime:** [Bun](https://bun.sh/) (preferred) or Node.js
- **TypeScript:** 5.0+
- **System (for fs kit):** [ripgrep](https://github.com/BurntSushi/ripgrep) >= 14.0 (for `searchText`)

## License

MIT
