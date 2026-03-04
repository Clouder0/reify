import { expect, test } from "bun:test";

import githubKit, {
  getPullRequestReviewComment,
  getThreadComment,
  githubKitImport,
  listPullRequestReviewComments,
  listThreadStream,
  parseRef,
} from "../src/kits/github/index";
import { listTools } from "../src/listTools";

test("github kit exposes a compact primary surface", () => {
  expect(listTools(githubKit)).toEqual([
    { name: "getThread", summary: expect.any(String) },
    { name: "listThreadStream", summary: expect.any(String) },
    { name: "searchThreads", summary: expect.any(String) },
  ]);

  expect(parseRef.meta.hidden).toBe(true);
  expect(getThreadComment.meta.hidden).toBe(true);
  expect(listPullRequestReviewComments.meta.hidden).toBe(true);
  expect(getPullRequestReviewComment.meta.hidden).toBe(true);
});

test("github docs disclose supported-but-unlisted helpers", () => {
  expect(githubKit.docs["index"].doc).toContain(`reify:tool/${githubKitImport}#parseRef`);
  expect(githubKit.docs["index"].doc).toContain(`reify:tool/${githubKitImport}#getThreadComment`);
  expect(githubKit.docs["index"].doc).toContain(
    `reify:tool/${githubKitImport}#listPullRequestReviewComments`,
  );
  expect(githubKit.docs["index"].doc).toContain(
    `reify:tool/${githubKitImport}#getPullRequestReviewComment`,
  );

  // Stream pagination often truncates a long comment body; docs should teach the zoom step.
  expect(listThreadStream.meta.doc).toContain(`reify:tool/${githubKitImport}#getThreadComment`);
});
