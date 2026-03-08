# Reify Onboarding

This is a one-time setup. After completing these steps, Reify tools and the Reify skill document will be available in your environment permanently.

Reify is a typed toolkit where tools are normal TypeScript functions you import and call. It also provides a philosophy and workflow for how to approach agent work in general.

There are two things to install:

1. **The npm package** (`@reify-ai/reify`) — provides the tools you call in code.
2. **The skill document** (`SKILL.md`) — teaches you the philosophy, workflow, and rules. This must be installed into your agent host so it is loaded into your context on every session.

## Step 1. Install the npm package globally

```bash
bun install -g @reify-ai/reify
```

This installs Reify system-wide so you can import it from any project directory. Reify is an agent tool, not a project dependency — it should not go into a project's `package.json`.

## Step 2. Verify the package works

```bash
bun -e 'import { listKits } from "@reify-ai/reify"; console.log(listKits());'
```

You should see output like:

```
[
  { name: "fs", summary: "...", import: "@reify-ai/reify/kits/fs" },
  { name: "github", summary: "...", import: "@reify-ai/reify/kits/github" }
]
```

If you see an import error, the package did not install correctly. Re-run step 1.

If Bun is not available, use Node as a fallback:

```bash
node --input-type=module -e 'import { listKits } from "@reify-ai/reify"; console.log(listKits());'
```

## Step 3. Install the skill document

The skill document (`SKILL.md`) needs to be copied into your agent host's skill directory so it is loaded into your context automatically.

### Locate SKILL.md

After installing the npm package, `SKILL.md` is inside the installed package directory. Find it:

```bash
REIFY_SKILL="$(bun -e 'import { createRequire } from "module"; const r = createRequire(import.meta.url); console.log(r.resolve("@reify-ai/reify/SKILL.md"));')"
echo "$REIFY_SKILL"
```

If you fetched this onboarding document from a URL, you can also fetch `SKILL.md` from the same base URL (replace `onboarding.md` with `SKILL.md` in the URL).

### Copy to your agent host

**Claude Code** (project-level):

```bash
mkdir -p .claude/skills
cp "$REIFY_SKILL" .claude/skills/reify.md
```

**Claude Code** (user-level, applies to all projects):

```bash
mkdir -p ~/.claude/skills
cp "$REIFY_SKILL" ~/.claude/skills/reify.md
```

**Other agent hosts:**

Copy the contents of `SKILL.md` into your system prompt, skill registry, or knowledge base. The exact mechanism depends on your host.

## Step 4. Verify the skill is installed

Start a new session (or reload your skills) and confirm you can access the Reify workflow. Run:

```bash
bun -e 'import { inspectTool, formatValue } from "@reify-ai/reify"; import { readTextWindow } from "@reify-ai/reify/kits/fs"; console.log(formatValue(inspectTool(readTextWindow)));'
```

If you see the tool's schema (kit, name, summary, input/output expressions), the setup is complete.

## Step 5. Optional — verify ripgrep

The `searchText` tool in the fs kit requires ripgrep >= 14.1.1. All other tools work without it.

```bash
rg --version
```

If ripgrep is missing or too old, `searchText` will fail with a clear error. You can still use `scanTree`, `readTextWindow`, and `editText`.

## Done

Reify is installed. The skill document is in your agent host. From now on, start any Reify workflow with `listKits()` and follow the discovery path described in the skill document.
