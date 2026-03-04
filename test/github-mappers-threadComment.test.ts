import { expect, test } from "bun:test";

import { mapRestIssueCommentToThreadComment } from "../src/kits/github/internal/mappers";

test("mapRestIssueCommentToThreadComment maps a comment and truncates body", () => {
  const comment = {
    id: 555,
    html_url: "https://github.com/o/r/issues/123#issuecomment-555",
    user: { login: "alice", html_url: "https://github.com/alice", type: "User" },
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2020-01-02T00:00:00Z",
    body: "x".repeat(200),
    issue_url: "https://api.github.com/repos/o/r/issues/123",
  };

  const out = mapRestIssueCommentToThreadComment(comment, { repo: "o/r", maxBodyChars: 80 });
  expect(out.repo).toBe("o/r");
  expect(out.number).toBe(123);
  expect(out.commentId).toBe(555);
  expect(out.body.length).toBe(80);
  expect(out.bodyTruncated).toBe(true);
});

test("mapRestIssueCommentToThreadComment rejects missing issue_url", () => {
  const comment = {
    id: 1,
    html_url: "https://github.com/o/r/issues/1#issuecomment-1",
    user: null,
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2020-01-01T00:00:00Z",
    body: "hi",
  };

  expect(() =>
    mapRestIssueCommentToThreadComment(comment, { repo: "o/r", maxBodyChars: 1000 }),
  ).toThrow(/issue_url/i);
});
