# GitHub Kit "gh auth" Fallback Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the GitHub kit automatically reuse GitHub CLI auth (`gh auth login`) by default, while keeping explicit `authToken` / env vars as highest priority.

**Architecture:** Extend `createGithubClients()` auth resolution with a small provider chain:
1) explicit tool input `authToken`
2) env `GITHUB_TOKEN`
3) env `GH_TOKEN`
4) `gh auth token` (if available + logged in, unless opted out)
5) unauthenticated

Cache only *successful* `gh auth token` reads in-process to avoid spawning `gh` on every tool call.

**Tech Stack:** Bun (`bun:test`), TypeScript, Octokit Core, Node `child_process`.

---

### Task 1: Auth resolution tests (TDD)

**Files:**
- Create: `test/github-authToken-resolution.test.ts`

**Step 1: Write failing tests**
- explicit `authToken` wins (does not call `gh`)
- env `GITHUB_TOKEN` wins over `GH_TOKEN` and `gh`
- env `GH_TOKEN` wins over `gh`
- `gh auth token` is used when no explicit/env token exists
- `REIFY_GITHUB_DISABLE_GH=1` disables `gh` fallback

**Step 2: Run test to verify RED**
Run: `bun test test/github-authToken-resolution.test.ts`
Expected: FAIL (feature missing).

---

### Task 2: Implement provider chain + `gh` fallback

**Files:**
- Modify: `src/kits/github/internal/client.ts`
- Test: `test/github-authToken-resolution.test.ts`

**Step 1: Implement `gh` hostname selection**
- GitHub.com: run `gh auth token --hostname github.com`.
- Skip `gh` fallback entirely for loopback hosts (`localhost`, `127.0.0.1`, `::1`) to avoid fixture-test overhead.

**Step 2: Implement `tryGetGhAuthToken()`**
- Non-interactive `execFileSync("gh", ["auth","token", ...])`, stdout only.
- Never log token.
- On `ENOENT`, mark `ghMissing` and stop retrying.
- Do not cache failures (so users can `gh auth login` and retry).

**Step 3: Add in-process caching for successful `gh` tokens**
- Cache per process.

**Step 4: Update resolver signature**
- `resolveAuthToken(explicit, { restBaseUrl })`
- Export `__testing.resetGhTokenCache()` for deterministic tests.

**Step 5: Run tests**
Run: `bun test test/github-authToken-resolution.test.ts`
Expected: PASS.

---

### Task 3: Wire resolver into `createGithubClients()`

**Files:**
- Modify: `src/kits/github/internal/client.ts`

**Step 1: Use resolver inside `createGithubClients()`**
- Compute `restBaseUrl`, then resolve token via provider chain.

**Step 2: Run full suite**
Run: `bun test`
Expected: PASS.

---

### Task 4: Docs updates (progressive disclosure)

**Files:**
- Modify: `src/kits/github/index.ts`

**Step 1: Update index + auth docs**
- Mention `gh` dependency and `gh auth login` quickstart.
- Mention env vars `GITHUB_TOKEN` and `GH_TOKEN`.
- Document opt-out: `REIFY_GITHUB_DISABLE_GH=1`.

**Step 2: Run tests**
Run: `bun test`
Expected: PASS.

---

### Task 5: Rate-limit error guidance

**Files:**
- Modify: `src/kits/github/internal/errors.ts`
- Modify: `test/github-internal-errors.test.ts`

**Step 1: Append an auth hint for 403 rate limits**
- Tip: run `gh auth login` or set `GITHUB_TOKEN`/`GH_TOKEN`.

**Step 2: Test it**
Run: `bun test test/github-internal-errors.test.ts`
Expected: PASS.

---

### Task 6: Final verification

Run:
- `bun test`
- `bun run typecheck`
- `bun run build`
