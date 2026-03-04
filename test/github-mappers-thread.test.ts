import { expect, test } from "bun:test";

import { mapRestThreadToThread } from "../src/kits/github/internal/mappers";

test("mapRestThreadToThread maps an issue and truncates the body", () => {
  const issue = {
    number: 123,
    title: "Fix panic",
    state: "open",
    state_reason: null,
    html_url: "https://github.com/o/r/issues/123",
    user: { login: "alice", html_url: "https://github.com/alice", type: "User" },
    labels: [{ name: "good first issue" }, { name: "bug" }],
    assignees: [{ login: "carol" }, { login: "bob" }],
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2020-01-02T00:00:00Z",
    comments: 5,
    locked: false,
    body: "x".repeat(200),
  };

  const out = mapRestThreadToThread(issue, { repo: "o/r", maxBodyChars: 80 });
  expect(out.repo).toBe("o/r");
  expect(out.kind).toBe("issue");
  expect(out.number).toBe(123);
  expect(out.body.length).toBe(80);
  expect(out.bodyTruncated).toBe(true);
  expect(out.labels).toEqual(["bug", "good first issue"]);
  expect(out.assignees).toEqual(["bob", "carol"]);
});

test("mapRestThreadToThread maps a pull request thread", () => {
  const prLike = {
    number: 1,
    title: "PR",
    state: "open",
    html_url: "https://github.com/o/r/pull/1",
    user: { login: "alice", html_url: "https://github.com/alice", type: "User" },
    labels: [],
    assignees: [],
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2020-01-01T00:00:00Z",
    comments: 0,
    locked: false,
    body: "",
    pull_request: {},
  };

  const out = mapRestThreadToThread(prLike, { repo: "o/r", maxBodyChars: 1000 });
  expect(out.kind).toBe("pull");
  expect(out.number).toBe(1);
  expect(out.url).toBe("https://github.com/o/r/pull/1");
});
