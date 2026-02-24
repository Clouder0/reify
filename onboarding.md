# Reify Onboarding (Send This To Agents)

This document is a **minimal install + verify runbook**.

It intentionally does not assume a specific agent host. Your agent runtime should know how to
install a skill doc; the Reify meta doc is in `SKILL.md`.

In commands below, replace:

- `<REIFY_PACKAGE>` with `@reify-ai/reify`.
- `<REIFY_IMPORT>` with the module specifier you will use in code.
  - Use the canonical value: `@reify-ai/reify`.

## 1) Install Reify

### Option A: Global install (Bun)

```bash
bun install -g <REIFY_PACKAGE>
```

> Note: Some runtimes cannot import globally-installed packages by name.
> If imports fail, use the project-local install option below.

### Option B: Project-local install (Bun)

```bash
bun add <REIFY_PACKAGE>
```

## 2) Verify You Can Import + Discover

Run one of these quick checks.

### With Bun

```bash
bun -e 'import("<REIFY_IMPORT>").then((r) => console.log(JSON.stringify(r.listKits(), null, 2)))'
```

### With Node

```bash
node --input-type=module -e 'import("<REIFY_IMPORT>").then((r) => console.log(JSON.stringify(r.listKits(), null, 2)))'
```

If that works, also verify you can inspect tool details and import a kit module:

```bash
bun -e 'Promise.all([import("<REIFY_IMPORT>"), import("<REIFY_IMPORT>/kits/fs")]).then(([r, fs]) => console.log(JSON.stringify(r.inspectTool(fs.readTextWindow), null, 2)))'
```

## 3) Install The Reify Skill Doc

Install the contents of `SKILL.md` into your agent host using your host's standard "skill"
mechanism.

After installing the skill, your canonical workflow is:

0. Use Reify philosophy as your default **CodeAct** mode across the full task (not only Reify tool calls): short reasoning, concrete action, observe output, iterate, verify.

1. `listKits()`
2. Import the kit module you want
3. Use `listTools(kit)` / `listDocs(kit)` for compact indexes
   - Note: `listTools(kit)` omits supported-but-unlisted helper tools (`tool.meta.hidden === true`) to reduce index bloat; kit docs may link to them.
4. Read docs via `kit.docs[...]` when needed
5. Use `inspectTool(tool)` to see exact input/output
6. Import and call the tool
