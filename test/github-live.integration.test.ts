import { expect, test } from "bun:test";

import { getThread, getThreadComment, listThreadStream, searchThreads } from "../src/kits/github/index";

const shouldRun = process.env.REIFY_GITHUB_LIVE === "1";
const liveTest = shouldRun ? test : test.skip;

liveTest(
  "github live: threads vision end-to-end",
  { timeout: 30_000 },
  async () => {
  const authToken = process.env.GITHUB_TOKEN;

  // Avoid passing `undefined` explicitly, since tool schemas treat optional fields as
  // "omit or provide a valid value".
  const auth = {
    ...(authToken ? { authToken } : {}),
  };

  const repo = process.env.GITHUB_TEST_REPO ?? "octocat/Hello-World";
  const explicitNumber = process.env.GITHUB_TEST_ISSUE ? Number(process.env.GITHUB_TEST_ISSUE) : null;

  const number = (() => {
    if (explicitNumber && Number.isInteger(explicitNumber) && explicitNumber > 0) return explicitNumber;
    return null;
  })();

  const targetNumber =
    number ??
    (await (async () => {
      const res = await searchThreads({
        repo,
        text: "bug",
        state: "all",
        limit: 5,
        ...auth,
      });

      expect(res.items.length).toBeGreaterThan(0);
      return res.items[0]!.number;
    })());

  const thread = await getThread({
    repo,
    number: targetNumber,
    maxBodyChars: 200,
    ...auth,
  });
  expect(thread.number).toBe(targetNumber);
  expect(thread.body.length).toBeLessThanOrEqual(200);

  const page1 = await listThreadStream({
    repo,
    number: targetNumber,
    limit: 20,
    maxThreadBodyChars: 200,
    maxCommentBodyChars: 200,
    ...auth,
  });
  expect(page1.thread.number).toBe(targetNumber);
  expect(page1.items.length).toBeGreaterThan(0);

  // Also smoke newest-first paging.
  const desc1 = await listThreadStream({
    repo,
    number: targetNumber,
    order: "desc",
    limit: 5,
    maxThreadBodyChars: 200,
    maxCommentBodyChars: 200,
    ...auth,
  });
  expect(desc1.items.length).toBeGreaterThan(0);

  // Cursor mismatch guard: changing request-shaping inputs must fail.
  if (page1.nextCursor) {
    await expect(
      listThreadStream({
        repo,
        number: targetNumber,
        limit: 10, // different limit
        cursor: page1.nextCursor,
        ...auth,
      }),
    ).rejects.toThrow(/cursor mismatch/i);
  }

  // Zoom any truncated comment.
  const truncatedComment = page1.items.find(
    (i): i is any => i.kind === "comment" && i.bodyTruncated === true,
  );

  if (truncatedComment) {
    const full = await getThreadComment({
      repo,
      commentId: truncatedComment.commentId,
      maxBodyChars: 50_000,
      ...auth,
    });
    expect(full.commentId).toBe(truncatedComment.commentId);
    expect(full.body.length).toBeGreaterThanOrEqual(truncatedComment.body.length);
  }
  },
);
