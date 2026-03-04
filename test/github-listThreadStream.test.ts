import { expect, test } from "bun:test";

import { listThreadStream } from "../src/kits/github/index";
import { __testing } from "../src/kits/github/internal/client";

function createTimelineLinkHeader(baseUrl: string, perPage: number, page: number): string | null {
  const mk = (p: number, rel: string) =>
    `<${baseUrl}/repos/o/r/issues/1/timeline?per_page=${perPage}&page=${p}>; rel="${rel}"`;

  // 3 pages total in our fixture.
  const last = 3;
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

      if (req.method === "GET" && url.pathname === "/repos/o/r/issues/1") {
        return Response.json({
          number: 1,
          html_url: "https://github.com/o/r/issues/1",
          title: "Title",
          state: "open",
          state_reason: null,
          user: { login: "alice", html_url: "https://github.com/alice", type: "User" },
          created_at: "2020-01-01T00:00:00Z",
          updated_at: "2020-01-02T00:00:00Z",
          labels: [{ name: "b" }, { name: "a" }],
          assignees: [{ login: "carol" }, { login: "bob" }],
          comments: 3,
          locked: false,
          body: "BODY-" + "x".repeat(50),
        });
      }

      if (req.method === "GET" && url.pathname === "/repos/o/r/issues/1/timeline") {
        const page = Number(url.searchParams.get("page") ?? "1");
        const perPage = Number(url.searchParams.get("per_page") ?? "30");
        const itemsByPage: Record<number, unknown[]> = {
          1: [
            {
              event: "labeled",
              created_at: "2020-01-01T00:10:00Z",
              actor: { login: "bob", html_url: "https://github.com/bob", type: "User" },
              label: { name: "bug" },
            },
            {
              event: "commented",
              id: 101,
              html_url: "https://github.com/o/r/issues/1#issuecomment-101",
              user: { login: "carol", html_url: "https://github.com/carol", type: "User" },
              created_at: "2020-01-01T01:00:00Z",
              updated_at: "2020-01-01T01:00:00Z",
              body: "first comment",
            },
          ],
          2: [
            {
              event: "commented",
              id: 102,
              html_url: "https://github.com/o/r/issues/1#issuecomment-102",
              user: { login: "carol", html_url: "https://github.com/carol", type: "User" },
              created_at: "2020-01-01T02:00:00Z",
              updated_at: "2020-01-01T02:00:00Z",
              body: "second comment",
            },
            {
              event: "closed",
              created_at: "2020-01-01T03:00:00Z",
              actor: { login: "bob", html_url: "https://github.com/bob", type: "User" },
              state_reason: "completed",
            },
          ],
          3: [
            {
              event: "commented",
              id: 103,
              html_url: "https://github.com/o/r/issues/1#issuecomment-103",
              user: { login: "carol", html_url: "https://github.com/carol", type: "User" },
              created_at: "2020-01-01T04:00:00Z",
              updated_at: "2020-01-01T04:00:00Z",
              body: "third comment",
            },
          ],
        };

        const items = itemsByPage[page] ?? [];
        const link = createTimelineLinkHeader(`http://${server.hostname}:${server.port}`, perPage, page);

        return Response.json(items, {
          headers: link ? { Link: link } : undefined,
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

test("listThreadStream (asc) uses REST timeline and returns cursor", async () => {
  const fx = serveGithubFixture();
  try {
    await __testing.withTestRestBaseUrl(fx.baseUrl, async () => {
      const page1 = await listThreadStream({
        repo: "o/r",
        number: 1,
        order: "asc",
        limit: 2,
        includeThreadItem: true,
        includeComments: true,
        includeEvents: true,
        maxThreadBodyChars: 12,
        maxCommentBodyChars: 1000,
      });

      expect(page1.thread).toMatchObject({
        kind: "issue",
        repo: "o/r",
        number: 1,
        url: "https://github.com/o/r/issues/1",
        title: "Title",
        state: "open",
        labels: ["a", "b"],
        assignees: ["bob", "carol"],
        commentsCount: 3,
      });

      expect(page1.items[0]).toMatchObject({ kind: "thread", bodyTruncated: true });
      expect((page1.items[0] as any).body.length).toBeLessThanOrEqual(12);

      expect(page1.items.slice(1)).toEqual([
        {
          kind: "event",
          eventType: "labeled",
          createdAt: "2020-01-01T00:10:00Z",
          actor: { login: "bob", url: "https://github.com/bob", type: "User" },
          label: "bug",
        },
        {
          kind: "comment",
          commentId: 101,
          url: "https://github.com/o/r/issues/1#issuecomment-101",
          author: { login: "carol", url: "https://github.com/carol", type: "User" },
          createdAt: "2020-01-01T01:00:00Z",
          updatedAt: "2020-01-01T01:00:00Z",
          body: "first comment",
          bodyTruncated: false,
        },
      ]);

      expect(page1.nextCursor).toBeTruthy();

      // Ensure we hit REST issue + timeline endpoints.
      const paths = fx.requests.map((r) => `${r.method} ${r.pathname}`);
      expect(paths).toContain("GET /repos/o/r/issues/1");
      expect(paths).toContain("GET /repos/o/r/issues/1/timeline");

      const page2 = await listThreadStream({
        repo: "o/r",
        number: 1,
        order: "asc",
        limit: 2,
        cursor: page1.nextCursor,
        includeThreadItem: true,
        includeComments: true,
        includeEvents: true,
        maxThreadBodyChars: 12,
        maxCommentBodyChars: 1000,
      });

      expect(page2.items[0]).not.toMatchObject({ kind: "thread" });
      expect(page2.items).toEqual([
        {
          kind: "comment",
          commentId: 102,
          url: "https://github.com/o/r/issues/1#issuecomment-102",
          author: { login: "carol", url: "https://github.com/carol", type: "User" },
          createdAt: "2020-01-01T02:00:00Z",
          updatedAt: "2020-01-01T02:00:00Z",
          body: "second comment",
          bodyTruncated: false,
        },
        {
          kind: "event",
          eventType: "closed",
          createdAt: "2020-01-01T03:00:00Z",
          actor: { login: "bob", url: "https://github.com/bob", type: "User" },
          stateReason: "completed",
        },
      ]);
    });
  } finally {
    fx.stop();
  }
});

test("listThreadStream (desc) starts at newest timeline items", async () => {
  const fx = serveGithubFixture();
  try {
    await __testing.withTestRestBaseUrl(fx.baseUrl, async () => {
      const page1 = await listThreadStream({
        repo: "o/r",
        number: 1,
        order: "desc",
        limit: 2,
        includeThreadItem: true,
        includeComments: true,
        includeEvents: true,
        maxThreadBodyChars: 100,
        maxCommentBodyChars: 1000,
      });

      // Prelude + newest comment + then the prior event.
      expect(page1.items[0]).toMatchObject({ kind: "thread" });
      expect(page1.items.slice(1)).toEqual([
        {
          kind: "comment",
          commentId: 103,
          url: "https://github.com/o/r/issues/1#issuecomment-103",
          author: { login: "carol", url: "https://github.com/carol", type: "User" },
          createdAt: "2020-01-01T04:00:00Z",
          updatedAt: "2020-01-01T04:00:00Z",
          body: "third comment",
          bodyTruncated: false,
        },
        {
          kind: "event",
          eventType: "closed",
          createdAt: "2020-01-01T03:00:00Z",
          actor: { login: "bob", url: "https://github.com/bob", type: "User" },
          stateReason: "completed",
        },
      ]);
      expect(page1.nextCursor).toBeTruthy();

      const page2 = await listThreadStream({
        repo: "o/r",
        number: 1,
        order: "desc",
        limit: 2,
        cursor: page1.nextCursor,
        includeThreadItem: true,
        includeComments: true,
        includeEvents: true,
        maxThreadBodyChars: 100,
        maxCommentBodyChars: 1000,
      });

      expect(page2.items).toEqual([
        {
          kind: "comment",
          commentId: 102,
          url: "https://github.com/o/r/issues/1#issuecomment-102",
          author: { login: "carol", url: "https://github.com/carol", type: "User" },
          createdAt: "2020-01-01T02:00:00Z",
          updatedAt: "2020-01-01T02:00:00Z",
          body: "second comment",
          bodyTruncated: false,
        },
        {
          kind: "comment",
          commentId: 101,
          url: "https://github.com/o/r/issues/1#issuecomment-101",
          author: { login: "carol", url: "https://github.com/carol", type: "User" },
          createdAt: "2020-01-01T01:00:00Z",
          updatedAt: "2020-01-01T01:00:00Z",
          body: "first comment",
          bodyTruncated: false,
        },
      ]);

      // Cursor mismatch guard: changing request-shaping inputs must fail.
      await expect(
        listThreadStream({
          repo: "o/r",
          number: 1,
          order: "desc",
          limit: 1, // different limit
          cursor: page1.nextCursor,
        }),
      ).rejects.toThrow(/cursor mismatch/i);
    });
  } finally {
    fx.stop();
  }
});
