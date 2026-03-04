import { expect, test } from "bun:test";

import {
  getPullRequestReviewComment,
  listPullRequestReviewComments,
} from "../src/kits/github/index";
import { __testing } from "../src/kits/github/internal/client";

function createLinkHeader(baseUrl: string, perPage: number, page: number): string | null {
  const mk = (p: number, rel: string) =>
    `<${baseUrl}/repos/o/r/pulls/1/comments?per_page=${perPage}&page=${p}>; rel="${rel}"`;

  const last = 2;
  const parts: string[] = [];
  if (page > 1) parts.push(mk(page - 1, "prev"));
  if (page < last) parts.push(mk(page + 1, "next"));
  parts.push(mk(1, "first"));
  parts.push(mk(last, "last"));
  return parts.join(", ");
}

function serveGithubFixture() {
  const requests: Array<{ method: string; pathname: string; search: string }> = [];

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push({ method: req.method, pathname: url.pathname, search: url.search });

      if (req.method === "GET" && url.pathname === "/repos/o/r/pulls/1/comments") {
        const page = Number(url.searchParams.get("page") ?? "1");
        const perPage = Number(url.searchParams.get("per_page") ?? "30");

        const itemsByPage: Record<number, unknown[]> = {
          1: [
            {
              id: 9001,
              html_url: "https://github.com/o/r/pull/1#discussion_r9001",
              user: { login: "alice", html_url: "https://github.com/alice", type: "User" },
              created_at: "2020-01-01T00:00:00Z",
              updated_at: "2020-01-01T00:00:00Z",
              body: "BODY-" + "x".repeat(50),
              diff_hunk: "HUNK-" + "y".repeat(50),
              path: "src/main.c",
              line: 12,
              side: "RIGHT",
              pull_request_url: "https://api.github.com/repos/o/r/pulls/1",
            },
          ],
          2: [
            {
              id: 9002,
              html_url: "https://github.com/o/r/pull/1#discussion_r9002",
              user: { login: "bob", html_url: "https://github.com/bob", type: "User" },
              created_at: "2020-01-01T01:00:00Z",
              updated_at: "2020-01-01T01:00:00Z",
              body: "second",
              diff_hunk: "HUNK-2",
              path: "src/main.c",
              line: null,
              side: null,
              pull_request_url: "https://api.github.com/repos/o/r/pulls/1",
              in_reply_to_id: 9001,
            },
          ],
        };

        const items = itemsByPage[page] ?? [];
        const link = createLinkHeader(`http://${server.hostname}:${server.port}`, perPage, page);
        return Response.json(items, {
          headers: link ? { Link: link } : undefined,
        });
      }

      if (req.method === "GET" && url.pathname === "/repos/o/r/pulls/comments/9001") {
        return Response.json({
          id: 9001,
          html_url: "https://github.com/o/r/pull/1#discussion_r9001",
          user: { login: "alice", html_url: "https://github.com/alice", type: "User" },
          created_at: "2020-01-01T00:00:00Z",
          updated_at: "2020-01-01T00:00:00Z",
          body: "BODY-" + "x".repeat(50),
          diff_hunk: "HUNK-" + "y".repeat(50),
          path: "src/main.c",
          line: 12,
          side: "RIGHT",
          pull_request_url: "https://api.github.com/repos/o/r/pulls/1",
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  const baseUrl = `http://${server.hostname}:${server.port}`;
  return {
    baseUrl,
    requests,
    stop: () => server.stop(true),
  };
}

test("listPullRequestReviewComments pages deterministically with cursor", async () => {
  const fx = serveGithubFixture();
  try {
    await __testing.withTestRestBaseUrl(fx.baseUrl, async () => {
      const page1 = await listPullRequestReviewComments({
        repo: "o/r",
        pullNumber: 1,
        limit: 1,
        maxBodyChars: 10,
        maxDiffHunkChars: 12,
      });

      expect(page1.items).toHaveLength(1);
      expect(page1.items[0]).toMatchObject({
        repo: "o/r",
        pullNumber: 1,
        commentId: 9001,
        url: "https://github.com/o/r/pull/1#discussion_r9001",
        author: { login: "alice", url: "https://github.com/alice", type: "User" },
        path: "src/main.c",
        line: 12,
        side: "RIGHT",
        bodyTruncated: true,
        diffHunkTruncated: true,
      });
      expect(page1.nextCursor).toBeTruthy();

      const paths = fx.requests.map((r) => `${r.method} ${r.pathname}${r.search}`);
      expect(paths).toContain("GET /repos/o/r/pulls/1/comments?per_page=1&page=1");

      const page2 = await listPullRequestReviewComments({
        repo: "o/r",
        pullNumber: 1,
        limit: 1,
        cursor: page1.nextCursor,
        maxBodyChars: 10,
        maxDiffHunkChars: 12,
      });

      expect(page2.items).toHaveLength(1);
      expect(page2.items[0]).toMatchObject({ commentId: 9002, inReplyToId: 9001 });
      expect(page2.nextCursor).toBeUndefined();

      await expect(
        listPullRequestReviewComments({
          repo: "o/r",
          pullNumber: 1,
          limit: 2,
          cursor: page1.nextCursor,
          maxBodyChars: 10,
          maxDiffHunkChars: 12,
        }),
      ).rejects.toThrow(/cursor mismatch/i);
    });
  } finally {
    fx.stop();
  }
});

test("getPullRequestReviewComment returns a bounded DTO", async () => {
  const fx = serveGithubFixture();
  try {
    await __testing.withTestRestBaseUrl(fx.baseUrl, async () => {
      const out = await getPullRequestReviewComment({
        repo: "o/r",
        commentId: 9001,
        maxBodyChars: 10,
        maxDiffHunkChars: 12,
      });

      expect(out).toMatchObject({
        repo: "o/r",
        pullNumber: 1,
        commentId: 9001,
        url: "https://github.com/o/r/pull/1#discussion_r9001",
        author: { login: "alice", url: "https://github.com/alice", type: "User" },
        path: "src/main.c",
        line: 12,
        side: "RIGHT",
        bodyTruncated: true,
        diffHunkTruncated: true,
      });
    });
  } finally {
    fx.stop();
  }
});
