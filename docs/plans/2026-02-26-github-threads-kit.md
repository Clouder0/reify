# GitHub Threads (Issues + PR) Kit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the issue-only GitHub kit surface with a unified, agent-friendly "threads" surface that can read both issues and pull requests, while keeping the main stream limited to issue comments + key events. Add supported-but-unlisted zoom helpers for PR review comments.

**Architecture:** Keep the primary surface minimal (3 tools) and deterministic. Treat both issues and PRs as "threads" with a shared core DTO and a shared stream. PR-only complexity (inline review comments) stays behind hidden zoom tools. GitHub.com-only, fail-fast behavior; do not expose `apiBaseUrl` in tool schemas.

**Tech Stack:** TypeScript, Bun (`bun test`), ArkType contracts, Octokit Core REST.

---

## Design Decisions (lock these before coding)

1. **Primary tools (listed by `listTools(githubKit)`):**
   - `searchThreads`
   - `getThread`
   - `listThreadStream`

2. **Supported-but-unlisted helpers (`meta.hidden: true`):**
   - Keep `parseRef` (still useful; returns `{ repo, kind, number, url }`)
   - Rename `getIssueComment` -> `getThreadComment` (issue-comment zoom for both issue and PR threads)
   - Add PR zoom:
     - `listPullRequestReviewComments`
     - `getPullRequestReviewComment`

3. **Thread DTO:** include `kind: "issue" | "pull"` and rename `issueNumber` -> `number` across thread-shaped outputs.

4. **Stream scope:** `listThreadStream` includes only:
   - thread prelude (opening post)
   - issue comments
   - curated key events (same set as today)
   It does **not** include PR inline review comments.

5. **Search default:** `searchThreads.kind` defaults to `"any"` (max recall) unless there is strong reason to default to `"issue"`.

6. **Backcompat:** This plan assumes breaking renames are acceptable. If you need compatibility, keep old names as hidden wrappers for one release and document in `migrations`.

> **Implementation constraint:** No subagents.

---

### Task 0: Prep + baseline verification

**Files:**
- None

**Step 1: Verify baseline tests in current worktree**

Run: `bun test`
Expected: PASS

**Step 2: Verify typecheck/build baseline**

Run: `bun run typecheck`
Expected: exit 0

Run: `bun run build`
Expected: exit 0

---

### Task 1: Add Thread schemas + rename core field `issueNumber` -> `number`

**Files:**
- Modify: `src/kits/github/internal/dtos.ts`
- Test: `test/github-kit.test.ts`

**Step 1: Write failing test for new surface names + docs links**

Update `test/github-kit.test.ts` to expect `listTools(githubKit)` lists only:

```ts
[
  { name: "getThread", summary: expect.any(String) },
  { name: "listThreadStream", summary: expect.any(String) },
  { name: "searchThreads", summary: expect.any(String) },
]
```

and that docs mention `getThreadComment` + PR zoom helpers.

**Step 2: Run test to verify RED**

Run: `bun test test/github-kit.test.ts`
Expected: FAIL (tools/docs not renamed yet)

**Step 3: Update DTO schemas to Thread equivalents**

In `src/kits/github/internal/dtos.ts`, introduce:

- `ThreadKindSchema = schema("'issue' | 'pull'")`
- `ThreadCardSchema` (like `IssueCardSchema` but with `kind` + `number`)
- `ThreadSchema` (like `IssueSchema` but with `kind` + `number`)
- `ThreadCommentSchema` (like `IssueCommentSchema` but `number`)

Also update the stream schemas:

- Rename prelude item `kind` from `'issue'` to `'thread'` and rename schema accordingly.

Keep event schemas as-is, except ensure cross-ref `source.kind` stays `'issue' | 'pull'`.

**Step 4: Run the whole suite (expect lots of failures)**

Run: `bun test`
Expected: FAIL (call sites still using Issue schemas)

**Step 5: Commit (optional when executing)**

```bash
git add src/kits/github/internal/dtos.ts test/github-kit.test.ts
git commit -m "refactor(github): introduce thread DTO schemas"
```

---

### Task 2: Generalize search query builder to threads (issues + PRs)

**Files:**
- Modify: `src/kits/github/internal/searchQuery.ts`
- Move/Modify: `test/github-searchIssues.test.ts` -> `test/github-searchThreads.test.ts`

**Step 1: Write failing tests for `buildSearchThreadsQuery`**

Create/rename tests to cover:

```ts
test("buildSearchThreadsQuery scopes to repo and threads", () => {
  const out = buildSearchThreadsQuery({ repo: "o/r", text: "bug" });
  expect(out.executedQuery).toBe("repo:o/r is:open bug");
});

test("buildSearchThreadsQuery can restrict to issues", () => {
  const out = buildSearchThreadsQuery({ repo: "o/r", kind: "issue", text: "bug" });
  expect(out.executedQuery).toBe("repo:o/r is:issue is:open bug");
});

test("buildSearchThreadsQuery can restrict to PRs", () => {
  const out = buildSearchThreadsQuery({ repo: "o/r", kind: "pull", text: "bug" });
  expect(out.executedQuery).toBe("repo:o/r is:pr is:open bug");
});
```

Also verify signature changes when `kind` changes.

**Step 2: Run tests to verify RED**

Run: `bun test test/github-searchThreads.test.ts`
Expected: FAIL (function not implemented / wrong behavior)

**Step 3: Implement `buildSearchThreadsQuery`**

In `src/kits/github/internal/searchQuery.ts`:
- Rename types to `SearchThreadsQueryInput`
- Support `kind?: "any" | "issue" | "pull"` (default `"any"`)
- For `kind:"any"`, omit `is:issue`/`is:pr`
- For `issue`, add `is:issue`
- For `pull`, add `is:pr`
- Keep label quoting/sorting deterministic
- Include `kind` in the signature JSON

**Step 4: Re-run tests to verify GREEN**

Run: `bun test test/github-searchThreads.test.ts`
Expected: PASS

**Step 5: Commit (optional when executing)**

```bash
git add src/kits/github/internal/searchQuery.ts test/github-searchThreads.test.ts
git commit -m "feat(github): add thread search query builder"
```

---

### Task 3: Update mappers for Thread cards and Thread payloads

**Files:**
- Modify: `src/kits/github/internal/mappers.ts`
- Move/Modify: `test/github-mappers-issueCard.test.ts` (update expectations)
- Move/Modify: `test/github-getIssue.test.ts` -> `test/github-getThread.test.ts`
- Move/Modify: `test/github-getIssueComment.test.ts` -> `test/github-getThreadComment.test.ts`

**Step 1: Write failing tests for PR mapping**

Add a test that a search item with `pull_request: {}` maps to `kind: "pull"` and uses `number`:

```ts
expect(mapSearchItemToThreadCard({ number: 45, html_url: ".../pull/45", pull_request: {}, ... }, { repo: "o/r" }))
  .toMatchObject({ kind: "pull", number: 45, repo: "o/r" });
```

Add a test that a thread payload with `pull_request: {}` maps to `kind: "pull"` and does not throw.

**Step 2: Run tests to verify RED**

Run: `bun test test/github-mappers-issueCard.test.ts test/github-getThread.test.ts`
Expected: FAIL

**Step 3: Implement mapper changes**

In `src/kits/github/internal/mappers.ts`:
- Rename `mapSearchItemToIssueCard` -> `mapSearchItemToThreadCard`
  - Determine kind via presence of `pull_request` key
  - Rename `issueNumber` -> `number`
- Rename `mapRestIssueToIssue` -> `mapRestThreadToThread`
  - Remove PR guard and instead set `kind`
  - Rename `issueNumber` -> `number`
- Rename `mapRestIssueCommentToIssueComment` -> `mapRestIssueCommentToThreadComment`
  - Rename `issueNumber` -> `number`

**Step 4: Re-run tests to verify GREEN**

Run: `bun test test/github-mappers-issueCard.test.ts test/github-getThread.test.ts test/github-getThreadComment.test.ts`
Expected: PASS

**Step 5: Commit (optional when executing)**

```bash
git add src/kits/github/internal/mappers.ts test/github-*.test.ts
git commit -m "refactor(github): map issues and PRs as threads"
```

---

### Task 4: Rename primary tools to thread surface (search/get/stream)

**Files:**
- Modify: `src/kits/github/index.ts`
- Modify: `test/github-listIssueStream.test.ts` (rename + expectations)
- Modify: `test/github-live.integration.test.ts`
- Modify: `test/github-kit.test.ts`

**Step 1: Write failing tests for renamed stream output**

Update stream fixture tests to expect:
- tool name `listThreadStream`
- output shape `{ thread, items, nextCursor? }`
- prelude item `kind: "thread"` (not `"issue"`)

**Step 2: Run the stream tests to verify RED**

Run: `bun test test/github-listThreadStream.test.ts`
Expected: FAIL

**Step 3: Implement tool renames in `src/kits/github/index.ts`**

- Replace `searchIssues` with `searchThreads`:
  - call `buildSearchThreadsQuery`
  - map items via `mapSearchItemToThreadCard`
  - output `ThreadCardListSchema`
- Replace `getIssue` with `getThread`:
  - call `GET /repos/{owner}/{repo}/issues/{issue_number}`
  - map via `mapRestThreadToThread`
- Replace `listIssueStream` with `listThreadStream`:
  - still uses `GET /repos/{owner}/{repo}/issues/{number}` and `/timeline`
  - output `{ thread: ThreadCardSchema, items: StreamItemListSchema, nextCursor? }`
  - prelude item uses `kind: "thread"`
- Rename hidden comment zoom tool `getIssueComment` -> `getThreadComment`.

**Step 4: Update kit docs pages to use new names**

In `src/kits/github/index.ts` docs:
- `index`: update tool links + description (now threads)
- `recipes/issues-vision`: either rename doc slug or update wording; keep workflow the same
- `concepts/pagination`: replace `listIssueStream` mention with `listThreadStream`
- `migrations`: document rename + field rename (`issueNumber` -> `number`, `issue` -> `thread`)

**Step 5: Re-run focused tests to verify GREEN**

Run: `bun test test/github-kit.test.ts test/github-listThreadStream.test.ts test/github-live.integration.test.ts`
Expected: PASS (live test only passes if opted-in)

**Step 6: Commit (optional when executing)**

```bash
git add src/kits/github/index.ts test/github-*.test.ts
git commit -m "feat(github): rename issue tools to thread surface"
```

---

### Task 5: Add PR review comment zoom tools (hidden)

**Files:**
- Modify: `src/kits/github/internal/dtos.ts`
- Modify: `src/kits/github/internal/mappers.ts`
- Modify: `src/kits/github/index.ts`
- Create: `test/github-pullRequestReviewComments.test.ts`
- Create: `test/github-listPullRequestReviewComments.test.ts`

**Step 1: Write failing fixture test for review comment listing + paging**

Create a Bun fixture server that serves:
- `GET /repos/o/r/pulls/1/comments?per_page=...&page=...` (paged arrays)
- `GET /repos/o/r/pulls/comments/9001` (single comment)

Test expectations:
- returns bounded bodies (`bodyTruncated`)
- cursor mismatch if `limit` or truncation caps change
- docs link exists in `listThreadStream.meta.doc`

**Step 2: Run tests to verify RED**

Run: `bun test test/github-listPullRequestReviewComments.test.ts`
Expected: FAIL

**Step 3: Add DTO schemas**

In `src/kits/github/internal/dtos.ts` add:
- `PullRequestReviewCommentSchema`
- list schema

Keep fields minimal and stable, suggested:
- `repo`, `pullNumber`, `commentId`, `url`
- `author`, `createdAt`, `updatedAt`
- `path`, `line?`, `side?`
- `body`, `bodyTruncated`
- `diffHunk?`, `diffHunkTruncated?` (optional but useful)

**Step 4: Add mappers**

In `src/kits/github/internal/mappers.ts` implement:
- `mapRestPullRequestReviewCommentToPullRequestReviewComment` (with truncation)

**Step 5: Implement tools (hidden) in `src/kits/github/index.ts`**

- `listPullRequestReviewComments({ repo, pullNumber, limit, cursor, maxBodyChars, maxDiffHunkChars, authToken? })`
  - REST: `GET /repos/{owner}/{repo}/pulls/{pull_number}/comments`
  - deterministic paging cursor (page number)
- `getPullRequestReviewComment({ repo, commentId, maxBodyChars, maxDiffHunkChars, authToken? })`
  - REST: `GET /repos/{owner}/{repo}/pulls/comments/{comment_id}`

Update `listThreadStream` docs to explicitly say:
"For PR threads, this stream omits inline review comments; use `listPullRequestReviewComments` / `getPullRequestReviewComment`."

**Step 6: Re-run tests to verify GREEN**

Run: `bun test test/github-listPullRequestReviewComments.test.ts test/github-kit.test.ts`
Expected: PASS

**Step 7: Commit (optional when executing)**

```bash
git add src/kits/github/internal/dtos.ts src/kits/github/internal/mappers.ts src/kits/github/index.ts test/github-*.test.ts
git commit -m "feat(github): add PR review comment zoom tools"
```

---

### Task 6: Final cleanup (remove old names or keep hidden aliases)

**Files:**
- Modify: `src/kits/github/index.ts`
- Modify: `src/kits/github/docs` strings (in `index.ts`)
- Modify: `test/github-*.test.ts`

**Step 1: Decide compatibility policy**

- If breaking OK: remove `searchIssues`, `getIssue`, `listIssueStream`, `getIssueComment` exports entirely.
- If compat desired: keep them as `hidden: true` wrappers that call the new tools and document in `migrations`.

**Step 2: Run full suite**

Run: `bun test`
Expected: PASS

**Step 3: Commit (optional when executing)**

```bash
git commit -am "chore(github): finalize thread surface migration"
```

---

### Task 7: Final verification (evidence before claims)

Run fresh:
- `bun test`
- `bun run typecheck`
- `bun run build`

Optional live:
- `REIFY_GITHUB_LIVE=1 bun test test/github-live.integration.test.ts`
