# GitHub Issues Readonly Kit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a built-in Reify `github` kit that supports a read-only "issues vision" workflow:
search issues -> open issue -> read a unified stream (comments + key events) -> zoom into a single large comment when needed.

**Architecture:** Implement tools as normal async functions via `defineTool` + `defineKit`, with explicit ArkType contracts and deterministic DTOs.
Use REST for `searchIssues`/`getIssue`/`getIssueComment` and the REST timeline endpoint for `listIssueStream` interleaving.
Keep all bodies bounded via truncation + explicit `*Truncated` booleans.
Adopt the current Reify philosophy that some tools are **supported-but-unlisted helpers** (`meta.hidden: true`): hidden from `listTools()` and primarily disclosed via docs/tool-docs (mirrors fs kit).

**Tech Stack:** TypeScript (NodeNext; internal imports use `.js`), Bun (`bun test`), ArkType, Octokit core.

---

## Progress Tracker (update this file as you work)

- [x] Task 0: Create isolated git worktree on a feat branch (no `git checkout`)
- [x] Task 1: Add this plan doc and keep it updated
- [x] Task 2: Scaffold github kit + discovery wiring + exports + metadata tests
- [x] Task 3: Add "surface/visibility" tests (primary tools listed, helpers hidden, docs disclose helpers)
- [x] Task 4: Implement hidden helper `parseRef` (TDD)
- [x] Task 5: Internal helpers: truncation + integrity-checked cursors + error normalization (TDD)
- [x] Task 6: Octokit client helpers (REST, GitHub.com-only) (TDD)
- [x] Task 7: Implement primary tool `searchIssues` (REST) + unit/fixture tests + live tryout
- [x] Task 8: Implement primary tool `getIssue` (REST, PR guard) + tests + live tryout
- [x] Task 9: Implement hidden helper `getIssueComment` (REST zoom) + tests + live tryout
- [x] Task 10: Implement primary tool `listIssueStream` (REST timeline) + tests + live tryout
- [x] Task 11: Docs (primary path + hidden helpers) + doc-link consistency tests
- [x] Task 12: Live integration test (real GitHub; explicit opt-in env var) for end-to-end flow
- [x] Task 13: Review + polish round 1 (deep self-review) + fixups + re-verify
- [x] Task 14: "User agent" usability self-test (docs + public API only; no additional code reading) + fixups
- [x] Task 15: Review + polish round 2 (deep self-review) + final tightening + re-verify
- [x] Task 16: Final verification: `bun test`, `bun run typecheck`, `bun run build`

> **Implementation constraint:** No subagents.

Notes:
- `listIssueStream()` now uses the REST timeline endpoint, so it works without a token for public repos.
- To run the live test locally: `REIFY_GITHUB_LIVE=1 bun test test/github-live.integration.test.ts` (token optional; recommended for higher rate limits).

---

## Tool Visibility Policy (match current Reify philosophy)

**Primary tools (listed by `listTools(githubKit)`):**
- `searchIssues`
- `getIssue`
- `listIssueStream`

**Supported-but-unlisted helpers (tool exists + exported, but `hidden: true`):**
- `parseRef` (pure convenience parsing)
- `getIssueComment` (zoom helper for truncated comments)

Docs MUST explicitly disclose hidden helpers (see fs kit docs pattern).

---

## DTO + Contracts (v1)

**Common inputs:**
- `repo: string` (required, `owner/repo`)
- `authToken?: string` (fallback: `process.env.GITHUB_TOKEN` / `process.env.GH_TOKEN` / `gh auth token`)

**Deterministic, bounded outputs:**
- `IssueCard`: `{ repo, issueNumber, url, title, state, stateReason?, author, labels[], assignees[], createdAt, updatedAt, commentsCount }`
- `Issue`: `IssueCard & { body, bodyTruncated, locked }`
- `StreamItem` union: `issue` prelude (optional), `comment`, `event` (tight subset)

**Pagination:** opaque, integrity-checked cursor `{ v:1, sig:"...", data:{...} }` base64url-encoded.
- On signature mismatch: throw `"cursor mismatch; restart without cursor"`.

**Truncation semantics:** middle truncation that preserves tails (mirror `src/formatValue.ts`). Always return `*Truncated` booleans.

---

## Task 0: Worktree + Feat Branch (mandatory)

No `git checkout`.

1. Create worktree on `feat/github-issues-kit`.
2. `bun install` in the worktree.
3. Baseline verify: `bun test` passes before changes.

---

## Task 2: Scaffold `github` kit + discovery wiring

**Files:**
- Create: `src/kits/github/index.ts`
- Modify: `src/listKits.ts`
- Modify: `package.json` (exports)
- Modify: `test/kit-metadata-consistency.test.ts`

**Steps (TDD where applicable):**
1. Add minimal kit skeleton with docs pages.
2. Add placeholder tools with correct `.meta` wiring.
3. Add package export `./kits/github`.
4. Extend kit metadata consistency tests for github docs links.
5. Verify: `bun test`.

---

## Task 3: Surface/Visibility tests (lock in "hidden tools" philosophy)

**Files:**
- Create: `test/github-kit.test.ts`

**Tests:**
1. `listTools(githubKit)` returns only primary tools.
2. Hidden helpers have `meta.hidden === true` and are absent from `listTools()`.
3. `githubKit.docs["index"].doc` contains `reify:tool/...#parseRef` and `...#getIssueComment`.
4. `listIssueStream.meta.doc` mentions the hidden zoom helper with a fully-qualified tool link.

---

## Task 4: Hidden helper `parseRef`

Pure parsing helper.

**Tests:**
- GitHub URL: `.../issues/123`, `.../pull/45`
- Shorthand: `owner/repo#9`
- Local shorthand: `#9` with `defaultRepo`
- Reject malformed refs

---

## Task 5: Internal helpers

**Files:**
- Create: `src/kits/github/internal/truncate.ts`
- Create: `src/kits/github/internal/cursor.ts`
- Create: `src/kits/github/internal/errors.ts`

**Notes:**
- Truncation must be deterministic and return `{ text, truncated }`.
- Cursor signature must cover every param that shapes results.
- Error normalization must not leak tokens.

---

## Task 6: Octokit client (REST, GitHub.com-only)

**Deps:**
- `@octokit/core`

**Behavior:**
- GitHub.com only (`github.com` / `api.github.com`).
- Prefer actionable errors over silent long sleeps on rate limit.

---

## Task 7-10: Primary/Helper tools

Primary:
- `searchIssues` (REST search, repo-scoped, issue-only)
- `getIssue` (REST, PR guard)
- `listIssueStream` (REST timeline; comments + selected events)

Hidden helper:
- `getIssueComment` (REST zoom; used when comment bodies are truncated in the stream)

Each tool must be implemented via strict TDD: write failing test -> run (RED) -> implement minimal (GREEN) -> refactor.

---

## Task 11: Docs

Docs must teach progressive disclosure AND reveal hidden helpers:
- `index`: Primary tools + Supported-but-unlisted helpers
- `recipes/issues-vision`: canonical flow, includes zoom via hidden helper
- `concepts/auth`: token + `gh` fallback
- `concepts/pagination`: cursor mismatch semantics

---

## Task 12: Live integration test (explicit opt-in)

Create `test/github-live.integration.test.ts` that only runs when:
- `REIFY_GITHUB_LIVE=1`

Token optional (recommended for higher rate limits).

Flow:
1. `searchIssues` selects an issue.
2. `getIssue` fetches it with forced-small max to exercise truncation flag.
3. `listIssueStream` fetches 1-2 pages; if truncated comment exists, call hidden `getIssueComment`.

---

## Task 13-15: Two polish rounds + usability self-test

Round 1:
- contracts, output bounds, determinism, errors, docs accuracy

Usability self-test:
- Act as a user agent using only `SKILL.md`, `listKits()`, `listTools()`, `listDocs()`, kit docs, and `inspectTool()`.
- Follow the recipe without consulting implementation details.

Round 2:
- simplify surface, remove ambiguity, tighten docs, re-run all verification.

---

## Task 16: Final verification (evidence before claims)

Run fresh:
- `bun test`
- `bun run typecheck`
- `bun run build`

Only after fresh green output: declare completion.
