import { type as schema } from "arktype";

import { createHash } from "node:crypto";

import { defineTool } from "../../defineTool.js";
import { defineKit } from "../../defineKit.js";
import type { Kit } from "../../types.js";

import {
  PullRequestReviewCommentListSchema,
  PullRequestReviewCommentSchema,
  ThreadCardListSchema,
  ThreadCardSchema,
  ThreadCommentSchema,
  ThreadSchema,
  StreamItemListSchema,
} from "./internal/dtos.js";
import { createGithubClients } from "./internal/client.js";
import { decodeCursor, encodeCursor } from "./internal/cursor.js";
import { toGithubError } from "./internal/errors.js";
import {
  mapRestIssueCommentToThreadComment,
  mapRestPullRequestReviewCommentToPullRequestReviewComment,
  mapRestThreadToThread,
  mapRestThreadToThreadCard,
  mapSearchItemToThreadCard,
} from "./internal/mappers.js";
import { buildSearchThreadsQuery } from "./internal/searchQuery.js";
import { parseLinkHeaderPages } from "./internal/linkHeader.js";
import { collectStreamItemsFromPages } from "./internal/streamPager.js";
import {
  mapRestTimelineItemToStreamItem,
  normalizeStreamEventTypes,
} from "./internal/timeline.js";
import { truncateTextMiddle } from "./internal/truncate.js";

const githubKitName = "github";
const githubKitSummary = "Read-only GitHub Threads vision (issues + PRs)";

export const githubKitImport = "@reify-ai/reify/kits/github";

function toolLink(name: string): string {
  return `reify:tool/${githubKitImport}#${name}`;
}

function docLink(name: string): string {
  return `reify:doc/${githubKitImport}#${name}`;
}

function parseOwnerRepo(raw: string, label: string): { owner: string; repo: string; full: string } {
  const trimmed = raw.trim();
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  if (!match) {
    throw new TypeError(`${label} must be in owner/repo form`);
  }

  return { owner: match[1], repo: match[2], full: `${match[1]}/${match[2]}` };
}

function parsePositiveInt(raw: string, label: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }

  return n;
}

function normalizeIntInRange(label: string, value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer`);
  }
  if (value < min || value > max) {
    throw new TypeError(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

function sha256Base64Url(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("base64url");
}

// NOTE: Tool schemas are defined up-front to keep `inspectTool()` useful.
// Implementation arrives task-by-task under strict TDD.

export const parseRef = defineTool({
  kit: githubKitName,
  name: "parseRef",
  summary: "Parse an issue/PR ref (URL or shorthand) into repo + kind + number",
  hidden: true,
  input: schema({
    ref: schema("string").describe("URL or shorthand (e.g. owner/repo#123, #123)"),
    defaultRepo: schema("string")
      .describe("Fallback repo used for local shorthand refs like #123")
      .optional(),
  }),
  output: schema({
    repo: "string",
    kind: "'issue' | 'pull'",
    number: "number",
    url: "string",
  }),
  validateOutput: true,
  doc: [
    "Parse a GitHub issue/PR reference into a normalized object.",
    "",
    "Shorthand like `owner/repo#123` (or `#123` with `defaultRepo`) is treated as an issue ref.",
    "URLs can be either `/issues/<n>` or `/pull/<n>`.",
    "",
    "This is a supported-but-unlisted helper (hidden from `listTools()` by default).",
  ].join("\n"),
  fn: async ({ ref, defaultRepo }) => {
    const trimmed = ref.trim();

    // URL form: normalize to owner/repo/(issues|pull)/N.
    let u: URL | null = null;
    try {
      u = new URL(trimmed);
    } catch {
      u = null;
    }

    if (u) {
      if (u.hostname !== "github.com" && u.hostname !== "www.github.com") {
        throw new TypeError("ref URL must be a github.com URL");
      }

      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length < 4) {
        throw new TypeError("ref URL must include /owner/repo/(issues|pull)/<number>");
      }

      const owner = parts[0];
      const repo = parts[1];
      const kindSeg = parts[2];
      const num = parsePositiveInt(parts[3], "ref number");

      if (kindSeg === "issues") {
        return {
          repo: `${owner}/${repo}`,
          kind: "issue" as const,
          number: num,
          url: `${u.origin}/${owner}/${repo}/issues/${num}`,
        };
      }

      if (kindSeg === "pull") {
        return {
          repo: `${owner}/${repo}`,
          kind: "pull" as const,
          number: num,
          url: `${u.origin}/${owner}/${repo}/pull/${num}`,
        };
      }

      throw new TypeError("ref URL must include /issues/ or /pull/");
    }

    const local = /^#(\d+)$/.exec(trimmed);
    if (local) {
      if (!defaultRepo) {
        throw new TypeError("defaultRepo is required when ref is in #<number> form");
      }
      const { full } = parseOwnerRepo(defaultRepo, "defaultRepo");
      const num = parsePositiveInt(local[1], "ref number");
      return {
        repo: full,
        kind: "issue" as const,
        number: num,
        url: `https://github.com/${full}/issues/${num}`,
      };
    }

    const repoMatch = /^([^/\s]+)\/([^/\s]+)#(\d+)$/.exec(trimmed);
    if (repoMatch) {
      const full = `${repoMatch[1]}/${repoMatch[2]}`;
      const num = parsePositiveInt(repoMatch[3], "ref number");
      return {
        repo: full,
        kind: "issue" as const,
        number: num,
        url: `https://github.com/${full}/issues/${num}`,
      };
    }

    throw new TypeError(
      "ref must be a GitHub URL (/issues/N or /pull/N), owner/repo#N, or #N with defaultRepo",
    );
  },
});

export const searchThreads = defineTool({
  kit: githubKitName,
  name: "searchThreads",
  summary: "Search threads (issues + PRs) within a single repo (bounded, paginated)",
  input: schema({
    repo: schema("string").describe("Repository in owner/repo form (required)"),
    kind: schema("'any' | 'issue' | 'pull'")
      .describe("Thread kind filter")
      .default("any"),
    text: schema("string").describe("Free-text search query").optional(),
    state: schema("'open' | 'closed' | 'all'")
      .describe("Thread state filter")
      .default("open"),
    labels: schema("string[]").describe("Labels that must all be present").optional(),
    sort: schema("'comments' | 'created' | 'updated'")
      .describe("Search sort key")
      .default("updated"),
    order: schema("'asc' | 'desc'")
      .describe("Sort direction")
      .default("desc"),
    limit: schema("number").describe("Items per page (1-100)").default(20),
    cursor: schema("string").describe("Opaque pagination cursor").optional(),
    query: schema("string")
      .describe("Escape hatch: raw additional GitHub search qualifiers")
      .optional(),
    authToken: schema("string").describe("GitHub token (defaults to env/gh)").optional(),
  }),
  output: schema({
    executedQuery: "string",
    items: ThreadCardListSchema,
    "totalCount?": "number",
    "nextCursor?": "string",
  }),
  validateOutput: true,
  doc: [
    "Search threads (issues + PRs) within one repository.",
    "",
    "Notes:",
    "- Repo scoping is required to reduce noise.",
    "- Results are bounded and paginated.",
    "- Cursors are integrity-checked and bound to request-shaping inputs; if inputs change between pages you'll get: cursor mismatch; restart without cursor.",
  ].join("\n"),
  fn: async ({
    repo,
    kind,
    text,
    state,
    labels,
    sort,
    order,
    limit,
    cursor,
    query,
    authToken,
  }) => {
    const parsedRepo = parseOwnerRepo(repo, "repo");
    const perPage = normalizeIntInRange("limit", limit, 1, 100);
    const { executedQuery, sig: querySig } = buildSearchThreadsQuery({
      repo: parsedRepo.full,
      kind,
      text,
      state,
      labels,
      query,
    });
    const cursorSig = `${querySig}|sort:${sort}|order:${order}|limit:${perPage}`;

    const page = cursor
      ? decodeCursor<{ page: number }>(cursor, cursorSig).data.page
      : 1;
    const pageInt = normalizeIntInRange("cursor.page", page, 1, 10_000);

    const { rest } = createGithubClients({ authToken });

    try {
      const res = await rest.request("GET /search/issues", {
        q: executedQuery,
        sort,
        order,
        per_page: perPage,
        page: pageInt,
      });

      const totalCount =
        typeof res?.data?.total_count === "number" && Number.isFinite(res.data.total_count)
          ? res.data.total_count
          : undefined;
      const rawItems: unknown[] = Array.isArray(res?.data?.items) ? res.data.items : [];
      const items = rawItems
        .map((it) => mapSearchItemToThreadCard(it, { repo: parsedRepo.full }));

      // GitHub Search API only returns the first 1000 results. Use total_count as a hint,
      // but also fall back to page-size heuristics when total_count is missing.
      const totalCap = typeof totalCount === "number" ? Math.min(totalCount, 1000) : null;
      const hasMore = totalCap !== null ? pageInt * perPage < totalCap : rawItems.length === perPage;

      const out: any = { executedQuery, items };
      if (totalCount !== undefined) out.totalCount = totalCount;
      if (hasMore) out.nextCursor = encodeCursor(cursorSig, { page: pageInt + 1 });
      return out;
    } catch (err) {
      throw toGithubError(err, { operation: "github.searchThreads" });
    }
  },
});

export const getThread = defineTool({
  kit: githubKitName,
  name: "getThread",
  summary: "Fetch a single thread (issue or pull request)",
  input: schema({
    repo: schema("string").describe("Repository in owner/repo form"),
    number: schema("number").describe("Issue or pull request number"),
    maxBodyChars: schema("number").describe("Maximum chars for the thread body").default(20_000),
    authToken: schema("string").describe("GitHub token (defaults to env/gh)").optional(),
  }),
  output: ThreadSchema,
  validateOutput: true,
  doc: [
    "Fetch a single thread (issue or pull request) and return a bounded DTO.",
    "",
    "Use `maxBodyChars` to bound the body; `bodyTruncated` tells you when zooming might be needed.",
  ].join("\n"),
  fn: async ({ repo, number, maxBodyChars, authToken }) => {
    const parsedRepo = parseOwnerRepo(repo, "repo");
    const numberInt = normalizeIntInRange("number", number, 1, 1_000_000_000);
    const maxBodyCharsInt = normalizeIntInRange("maxBodyChars", maxBodyChars, 0, 1_000_000);

    const { rest } = createGithubClients({ authToken });
    try {
      const res = await rest.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        owner: parsedRepo.owner,
        repo: parsedRepo.repo,
        issue_number: numberInt,
      });

      return mapRestThreadToThread(res?.data, { repo: parsedRepo.full, maxBodyChars: maxBodyCharsInt });
    } catch (err) {
      throw toGithubError(err, { operation: "github.getThread" });
    }
  },
});

export const getThreadComment = defineTool({
  kit: githubKitName,
  name: "getThreadComment",
  summary: "Fetch a single thread comment by id (zoom helper)",
  hidden: true,
  input: schema({
    repo: schema("string").describe("Repository in owner/repo form"),
    commentId: schema("number").describe("Thread comment database id"),
    maxBodyChars: schema("number").describe("Maximum chars for the comment body").default(50_000),
    authToken: schema("string").describe("GitHub token (defaults to env/gh)").optional(),
  }),
  output: ThreadCommentSchema,
  validateOutput: true,
  doc: [
    "Zoom into a single comment when its body was truncated in `listThreadStream()`.",
    "",
    "This is a supported-but-unlisted helper (hidden from `listTools()` by default).",
  ].join("\n"),
  fn: async ({ repo, commentId, maxBodyChars, authToken }) => {
    const parsedRepo = parseOwnerRepo(repo, "repo");
    const commentIdInt = normalizeIntInRange("commentId", commentId, 1, 1_000_000_000_000);
    const maxBodyCharsInt = normalizeIntInRange("maxBodyChars", maxBodyChars, 0, 1_000_000);

    const { rest } = createGithubClients({ authToken });
    try {
      const res = await rest.request("GET /repos/{owner}/{repo}/issues/comments/{comment_id}", {
        owner: parsedRepo.owner,
        repo: parsedRepo.repo,
        comment_id: commentIdInt,
      });

      return mapRestIssueCommentToThreadComment(res?.data, {
        repo: parsedRepo.full,
        maxBodyChars: maxBodyCharsInt,
      });
    } catch (err) {
      throw toGithubError(err, { operation: "github.getThreadComment" });
    }
  },
});

export const listPullRequestReviewComments = defineTool({
  kit: githubKitName,
  name: "listPullRequestReviewComments",
  summary: "List inline pull request review comments with cursor paging",
  hidden: true,
  input: schema({
    repo: schema("string").describe("Repository in owner/repo form"),
    pullNumber: schema("number").describe("Pull request number"),
    limit: schema("number").describe("Items per page (1-100)").default(30),
    cursor: schema("string").describe("Opaque pagination cursor").optional(),
    maxBodyChars: schema("number")
      .describe("Maximum chars for review comment bodies")
      .default(4000),
    maxDiffHunkChars: schema("number")
      .describe("Maximum chars for diff hunks")
      .default(4000),
    authToken: schema("string").describe("GitHub token (defaults to env/gh)").optional(),
  }),
  output: schema({
    items: PullRequestReviewCommentListSchema,
    "nextCursor?": "string",
  }),
  validateOutput: true,
  doc: [
    "List inline pull request review comments (code review comments).",
    "",
    "This is a supported-but-unlisted helper for PR threads when `listThreadStream()` omits inline review comments.",
    "Cursors are integrity-checked and bound to request-shaping inputs; if inputs change between pages you'll get: cursor mismatch; restart without cursor.",
  ].join("\n"),
  fn: async ({
    repo,
    pullNumber,
    limit,
    cursor,
    maxBodyChars,
    maxDiffHunkChars,
    authToken,
  }) => {
    const parsedRepo = parseOwnerRepo(repo, "repo");
    const pullNumberInt = normalizeIntInRange("pullNumber", pullNumber, 1, 1_000_000_000);
    const perPage = normalizeIntInRange("limit", limit, 1, 100);
    const maxBodyCharsInt = normalizeIntInRange("maxBodyChars", maxBodyChars, 0, 1_000_000);
    const maxDiffHunkCharsInt = normalizeIntInRange(
      "maxDiffHunkChars",
      maxDiffHunkChars,
      0,
      1_000_000,
    );

    const sig = sha256Base64Url(
      JSON.stringify({
        repo: parsedRepo.full,
        pullNumber: pullNumberInt,
        limit: perPage,
        maxBodyChars: maxBodyCharsInt,
        maxDiffHunkChars: maxDiffHunkCharsInt,
      }),
    );

    const page = cursor ? decodeCursor<{ page: number }>(cursor, sig).data.page : 1;
    const pageInt = normalizeIntInRange("cursor.page", page, 1, 10_000_000);

    const { rest } = createGithubClients({ authToken });
    try {
      const res = await rest.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
        owner: parsedRepo.owner,
        repo: parsedRepo.repo,
        pull_number: pullNumberInt,
        per_page: perPage,
        page: pageInt,
      });

      const rawItems: unknown[] = Array.isArray(res?.data) ? res.data : [];
      const items = rawItems.map((it) =>
        mapRestPullRequestReviewCommentToPullRequestReviewComment(it, {
          repo: parsedRepo.full,
          pullNumber: pullNumberInt,
          maxBodyChars: maxBodyCharsInt,
          maxDiffHunkChars: maxDiffHunkCharsInt,
        }),
      );

      const link =
        res && typeof (res as any).headers?.link === "string" ? ((res as any).headers.link as string) : null;
      const links = parseLinkHeaderPages(link);
      const hasMore = link ? typeof links.next === "number" : rawItems.length === perPage;

      const out: any = { items };
      if (hasMore) out.nextCursor = encodeCursor(sig, { page: pageInt + 1 });
      return out;
    } catch (err) {
      throw toGithubError(err, { operation: "github.listPullRequestReviewComments" });
    }
  },
});

export const getPullRequestReviewComment = defineTool({
  kit: githubKitName,
  name: "getPullRequestReviewComment",
  summary: "Fetch a single pull request review comment by id (zoom helper)",
  hidden: true,
  input: schema({
    repo: schema("string").describe("Repository in owner/repo form"),
    commentId: schema("number").describe("Pull request review comment database id"),
    maxBodyChars: schema("number")
      .describe("Maximum chars for the review comment body")
      .default(50_000),
    maxDiffHunkChars: schema("number").describe("Maximum chars for diff hunks").default(50_000),
    authToken: schema("string").describe("GitHub token (defaults to env/gh)").optional(),
  }),
  output: PullRequestReviewCommentSchema,
  validateOutput: true,
  doc: [
    "Zoom into a single pull request review comment (inline review comment).",
    "",
    "This is a supported-but-unlisted helper (hidden from `listTools()` by default).",
  ].join("\n"),
  fn: async ({ repo, commentId, maxBodyChars, maxDiffHunkChars, authToken }) => {
    const parsedRepo = parseOwnerRepo(repo, "repo");
    const commentIdInt = normalizeIntInRange("commentId", commentId, 1, 1_000_000_000_000);
    const maxBodyCharsInt = normalizeIntInRange("maxBodyChars", maxBodyChars, 0, 1_000_000);
    const maxDiffHunkCharsInt = normalizeIntInRange(
      "maxDiffHunkChars",
      maxDiffHunkChars,
      0,
      1_000_000,
    );

    const { rest } = createGithubClients({ authToken });
    try {
      const res = await rest.request("GET /repos/{owner}/{repo}/pulls/comments/{comment_id}", {
        owner: parsedRepo.owner,
        repo: parsedRepo.repo,
        comment_id: commentIdInt,
      });

      return mapRestPullRequestReviewCommentToPullRequestReviewComment(res?.data, {
        repo: parsedRepo.full,
        maxBodyChars: maxBodyCharsInt,
        maxDiffHunkChars: maxDiffHunkCharsInt,
      });
    } catch (err) {
      throw toGithubError(err, { operation: "github.getPullRequestReviewComment" });
    }
  },
});

export const listThreadStream = defineTool({
  kit: githubKitName,
  name: "listThreadStream",
  summary: "List a thread stream (comments + key events) with cursor paging",
  input: schema({
    repo: schema("string").describe("Repository in owner/repo form"),
    number: schema("number").describe("Issue or pull request number"),
    order: schema("'asc' | 'desc'")
      .describe("Stream order (oldest-first vs newest-first)")
      .default("asc"),
    limit: schema("number").describe("Items per page (1-100)").default(30),
    cursor: schema("string").describe("Opaque pagination cursor").optional(),
    includeThreadItem: schema("boolean")
      .describe("Include a leading 'thread' item on the first page")
      .default(true),
    includeComments: schema("boolean").describe("Include thread comments").default(true),
    includeEvents: schema("boolean").describe("Include key thread events").default(true),
    eventTypes: schema("string[]")
      .describe("Event types to include when includeEvents=true")
      .optional(),
    maxThreadBodyChars: schema("number").describe("Maximum chars for thread body").default(8000),
    maxCommentBodyChars: schema("number").describe("Maximum chars for comment bodies").default(4000),
    authToken: schema("string").describe("GitHub token (defaults to env/gh)").optional(),
  }),
  output: schema({
    thread: ThreadCardSchema,
    items: StreamItemListSchema,
    "nextCursor?": "string",
  }),
  validateOutput: true,
  doc: [
    "List a unified thread stream for progressive disclosure.",
    "",
    "This uses the GitHub REST timeline endpoint.",
    "It works without authentication for public repos, but unauthenticated requests are heavily rate limited.",
    "For higher rate limits (and for private repos), authenticate via `authToken`, env (`GITHUB_TOKEN`/`GH_TOKEN`), or `gh auth login`.",
    "Cursors are integrity-checked and bound to request-shaping inputs; if inputs change between pages you'll get: cursor mismatch; restart without cursor.",
    "",
    "Event filtering:",
    "- If `includeEvents` is true, you can optionally pass `eventTypes` from:",
    "  labeled, unlabeled, assigned, unassigned, closed, reopened, cross-referenced",
    "",
    "If any returned comment has `bodyTruncated: true`, use the supported-but-unlisted zoom helper:",
    `- \`${toolLink("getThreadComment")}\``,
    "",
    "Note: for pull request threads, inline review comments are intentionally excluded from this stream.",
    "Use these supported-but-unlisted zoom helpers instead:",
    `- \`${toolLink("listPullRequestReviewComments")}\``,
    `- \`${toolLink("getPullRequestReviewComment")}\``,
  ].join("\n"),
  fn: async ({
    repo,
    number,
    order,
    limit,
    cursor,
    includeThreadItem,
    includeComments,
    includeEvents,
    eventTypes,
    maxThreadBodyChars,
    maxCommentBodyChars,
    authToken,
  }) => {
    const parsedRepo = parseOwnerRepo(repo, "repo");
    const numberInt = normalizeIntInRange("number", number, 1, 1_000_000_000);
    const limitInt = normalizeIntInRange("limit", limit, 1, 100);
    const maxThreadBodyCharsInt = normalizeIntInRange(
      "maxThreadBodyChars",
      maxThreadBodyChars,
      0,
      1_000_000,
    );
    const maxCommentBodyCharsInt = normalizeIntInRange(
      "maxCommentBodyChars",
      maxCommentBodyChars,
      0,
      1_000_000,
    );

    if (!includeComments && !includeEvents) {
      throw new TypeError("At least one of includeComments/includeEvents must be true");
    }

    const normalizedEventTypes = includeEvents ? normalizeStreamEventTypes(eventTypes) : [];

    if (!includeComments && normalizedEventTypes.length === 0) {
      throw new TypeError("No stream item types selected (check includeComments/includeEvents/eventTypes)");
    }

    const sig = sha256Base64Url(
      JSON.stringify({
        repo: parsedRepo.full,
        number: numberInt,
        order,
        limit: limitInt,
        includeThreadItem,
        includeComments,
        includeEvents,
        eventTypes: normalizedEventTypes,
        maxThreadBodyChars: maxThreadBodyCharsInt,
        maxCommentBodyChars: maxCommentBodyCharsInt,
      }),
    );

    const cursorData = cursor
      ? decodeCursor<{ page: number; index: number }>(cursor, sig).data
      : null;

    const cursorPage = cursorData
      ? normalizeIntInRange("cursor.page", (cursorData as any).page, 1, 10_000_000)
      : null;
    const cursorIndex = cursorData
      ? normalizeIntInRange("cursor.index", (cursorData as any).index, 0, 1_000_000_000)
      : null;

    const { rest } = createGithubClients({ authToken });

    try {
      const issueRes = await rest.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        owner: parsedRepo.owner,
        repo: parsedRepo.repo,
        issue_number: numberInt,
      });

      const threadCard = mapRestThreadToThreadCard(issueRes?.data, { repo: parsedRepo.full });

      const perPage = limitInt;
      const timelineHeaders = { accept: "application/vnd.github+json" };

      const timelineCache = new Map<number, { items: unknown[]; hasMore: boolean }>();

      const requestTimelinePageRaw = async (page: number) => {
        const res = await rest.request("GET /repos/{owner}/{repo}/issues/{issue_number}/timeline", {
          owner: parsedRepo.owner,
          repo: parsedRepo.repo,
          issue_number: numberInt,
          per_page: perPage,
          page,
          headers: timelineHeaders,
        });

        const items: unknown[] = Array.isArray(res?.data) ? res.data : [];
        const link =
          res && typeof (res as any).headers?.link === "string" ? ((res as any).headers.link as string) : null;
        const links = parseLinkHeaderPages(link);
        return { items, links };
      };

      const fetchTimelinePage = async (page: number) => {
        const cached = timelineCache.get(page);
        if (cached) return cached;

        const { items, links } = await requestTimelinePageRaw(page);
        const hasMore = order === "asc" ? typeof links.next === "number" : typeof links.prev === "number";
        const out = { items, hasMore };
        timelineCache.set(page, out);
        return out;
      };

      let start: { page: number; index: number };

      if (cursorPage !== null && cursorIndex !== null) {
        start = { page: cursorPage, index: cursorIndex };
      } else if (order === "asc") {
        start = { page: 1, index: 0 };
      } else {
        // Desc requires starting at the last page. REST pagination doesn't provide a direct sort toggle.
        const first = await requestTimelinePageRaw(1);
        const lastPage = typeof first.links.last === "number" ? first.links.last : 1;
        const hasMore = typeof first.links.prev === "number";
        timelineCache.set(1, { items: first.items, hasMore });
        start = { page: lastPage, index: 0 };
      }

      const allowedEventTypes = new Set(normalizedEventTypes);

      const collected = await collectStreamItemsFromPages({
        order,
        limit: limitInt,
        start,
        fetchPage: fetchTimelinePage,
        mapItem: (it) =>
          mapRestTimelineItemToStreamItem(it, {
            includeComments,
            includeEvents,
            allowedEventTypes,
            maxCommentBodyChars: maxCommentBodyCharsInt,
          }),
        maxPagesPerCall: 5,
      });

      const items: any[] = collected.items.slice();

      if (includeThreadItem && !cursor) {
        const bodyRaw =
          issueRes && typeof (issueRes as any).data?.body === "string" ? ((issueRes as any).data.body as string) : "";
        const truncated = truncateTextMiddle(bodyRaw, maxThreadBodyCharsInt);

        items.unshift({
          kind: "thread",
          url: threadCard.url,
          author: threadCard.author,
          createdAt: threadCard.createdAt,
          body: truncated.text,
          bodyTruncated: truncated.truncated,
        });
      }

      const out: any = { thread: threadCard, items };
      if (collected.next) {
        out.nextCursor = encodeCursor(sig, collected.next);
      }

      return out;
    } catch (err) {
      throw toGithubError(err, { operation: "github.listThreadStream" });
    }
  },
});

export const githubKit: Kit = defineKit({
  name: githubKitName,
  summary: githubKitSummary,
  docs: {
    index: {
      summary: "GitHub kit overview",
      doc: [
        "# github kit",
        "",
        "Read-only GitHub Threads tools (issues + PRs) for an agent-friendly workflow.",
        "",
        "Authentication (recommended for reliable agents):",
        "- If `authToken`/env vars are absent, the kit will try to reuse GitHub CLI auth via `gh auth token`.",
        "- One-time setup: install `gh`, run `gh auth login`, and verify with `gh auth status`.",
        "- Alternatively: set `GITHUB_TOKEN` or `GH_TOKEN` (or pass `authToken` per call).",
        "- Opt-out: set `REIFY_GITHUB_DISABLE_GH=1` to disable `gh` fallback.",
        "",
        "This kit is designed for the workflow:",
        "- search threads -> open thread -> read stream (comments + key events) -> zoom a large comment when needed",
        "- for PRs, zoom into inline review comments separately",
        "",
        "Primary tools:",
        `- \`${toolLink("searchThreads")}\``,
        `- \`${toolLink("getThread")}\``,
        `- \`${toolLink("listThreadStream")}\``,
        "",
        "Supported-but-unlisted helpers:",
        `- \`${toolLink("parseRef")}\``,
        `- \`${toolLink("getThreadComment")}\``,
        `- \`${toolLink("listPullRequestReviewComments")}\``,
        `- \`${toolLink("getPullRequestReviewComment")}\``,
        "",
        "Quickstart:",
        `1. Use \`${toolLink("searchThreads")}\` to find a thread in a repo.`,
        `2. Use \`${toolLink("getThread")}\` to fetch the thread body (bounded).`,
        `3. Use \`${toolLink("listThreadStream")}\` to page through comments + key events.`,
        `4. If any comment has \`bodyTruncated: true\`, call \`${toolLink("getThreadComment")}\` to zoom.`,
        "",
        "Docs:",
        `- \`${docLink("recipes/threads-vision")}\``,
        `- \`${docLink("concepts/auth")}\``,
        `- \`${docLink("concepts/pagination")}\``,
      ].join("\n"),
    },
    "recipes/threads-vision": {
      summary: "Recipe: threads vision",
      doc: [
        "# Recipe: threads vision",
        "",
        "Goal: given a repo and a question, identify the relevant thread(s) (issues or PRs) and read the full conversation\n",
        "without cloning a repository.",
        "",
        "Optional normalization:",
        `- Use \`${toolLink("parseRef")}\` to turn an issue URL or shorthand (e.g. \`owner/repo#123\`) into { repo, number }.`,
        "",
        "Typical flow:",
        `1. \`${toolLink("searchThreads")}\` (repo-scoped search)`,
        `2. \`${toolLink("getThread")}\` (thread body + metadata)`,
        `3. \`${toolLink("listThreadStream")}\` (unified stream; paginate)`,
        `4. \`${toolLink("getThreadComment")}\` when a comment body is truncated`,
        "5. If the thread is a PR and you need inline review comments:",
        `   - \`${toolLink("listPullRequestReviewComments")}\` / \`${toolLink("getPullRequestReviewComment")}\``,
        "",
        "Example (Bun):",
        "```ts",
        "import { searchThreads, getThread, listThreadStream, getThreadComment } from \"<REIFY_IMPORT>/kits/github\";",
        "",
        "const repo = \"owner/repo\";",
        "const results = await searchThreads({ repo, text: \"panic\", state: \"open\", limit: 3 });",
        "const hit = results.items[0];",
        "if (!hit) throw new Error(\"No matches\");",
        "",
        "const thread = await getThread({ repo, number: hit.number, maxBodyChars: 8000 });",
        "",
        "let cursor: string | undefined;",
        "do {",
        "  const page = await listThreadStream({ repo, number: hit.number, limit: 30, cursor });",
        "  for (const item of page.items) {",
        "    if (item.kind === \"comment\" && item.bodyTruncated) {",
        "      const full = await getThreadComment({ repo, commentId: item.commentId, maxBodyChars: 50_000 });",
        "      // ... use full.body",
        "    }",
        "  }",
        "  cursor = page.nextCursor;",
        "} while (cursor);",
        "```",
        "",
        "Tips:",
        "- `listThreadStream()` works without a token for public repos, but unauthenticated rate limits are low.",
        "- Treat cursors as opaque; if inputs change you'll get a cursor mismatch error.",
      ].join("\n"),
    },
    "recipes/issues-vision": {
      summary: "Recipe: issues vision (migrated)",
      doc: [
        "# Recipe: issues vision",
        "",
        "This kit evolved from issues-only to unified threads (issues + PRs).",
        "Use the updated recipe:",
        `- \`${docLink("recipes/threads-vision")}\``,
      ].join("\n"),
    },
    "concepts/auth": {
      summary: "Concepts: auth",
      doc: [
        "# Auth",
        "",
        "Tools can access public GitHub resources without authentication, but rate limits are very low.",
        "For private repos (and for higher rate limits), you should authenticate.",
        "",
        "You can provide auth in three ways:",
        "- Pass `authToken` to each tool call.",
        "- Set `GITHUB_TOKEN` or `GH_TOKEN` in the environment.",
        "- Install GitHub CLI (`gh`) and run `gh auth login` (the kit will reuse `gh auth token` automatically).",
        "",
        "This kit targets GitHub.com only (`github.com` / `api.github.com`).",
        "",
        "Opt-out:",
        "- Set `REIFY_GITHUB_DISABLE_GH=1` to disable `gh` fallback.",
        "",
        "Notes:",
        "- Never log or echo tokens.",
        "- Rate limits and secondary limits are reported as errors (no long silent sleeps).",
      ].join("\n"),
    },
    "concepts/pagination": {
      summary: "Concepts: cursor paging",
      doc: [
        "# Pagination",
        "",
        "List tools return bounded pages and an opaque cursor:",
        "- `nextCursor` is either a string or absent.",
        "- Pass it back as `cursor` to continue listing.",
        "",
        "`listThreadStream()` supports both oldest-first (`order: \"asc\"`) and newest-first (`order: \"desc\"`).",
        "When `order` is \"desc\", paging moves toward older items.",
        "",
        "Cursors are integrity-checked and bound to request-shaping inputs.",
        "",
        "If you change any request-shaping inputs between pages (e.g. `repo`, `sort`, `order`, `limit`, `eventTypes`),",
        "the tool throws:",
        "",
        "- `cursor mismatch; restart without cursor`",
        "",
        "Treat cursors as opaque: do not parse, modify, or persist them across unrelated runs.",
      ].join("\n"),
    },
    migrations: {
      summary: "Breaking changes and migrations",
      doc: [
        "# Migrations",
        "",
        "## 2026-02-26: Issues -> Threads",
        "",
        "This kit evolved from an issues-only MVP to unified threads (issues + pull requests).",
        "",
        "Breaking changes:",
        "- Tools renamed: `searchIssues` -> `searchThreads`, `getIssue` -> `getThread`, `listIssueStream` -> `listThreadStream`, `getIssueComment` -> `getThreadComment`",
        "- Output fields renamed: `issueNumber` -> `number`, container `issue` -> `thread`",
        "- Search now defaults to `kind: \"any\"` (issues + PRs)",
        "",
        "New supported-but-unlisted tools:",
        `- \`${toolLink("listPullRequestReviewComments")}\` / \`${toolLink("getPullRequestReviewComment")}\` for PR inline review comments`,
      ].join("\n"),
    },
    changelog: {
      summary: "Recent changes",
      doc: [
        "# Changelog",
        "",
        "## 2026-02-26",
        "- Unified issues + PRs under threads (search defaults to `kind: \"any\"`).",
        "- Renamed primary tools to `searchThreads` / `getThread` / `listThreadStream`.",
        "- Added hidden zoom helpers for PR inline review comments.",
      ].join("\n"),
    },
  },
  tools: {
    parseRef,
    searchThreads,
    getThread,
    listThreadStream,
    getThreadComment,
    listPullRequestReviewComments,
    getPullRequestReviewComment,
  },
});

export default githubKit;
