import { expect, test } from "bun:test";

import { mapRestThreadToThreadCard } from "../src/kits/github/internal/mappers";

test("mapRestThreadToThreadCard maps deterministic ThreadCard", () => {
  const issue = {
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
    comments: 7,
  };

  expect(mapRestThreadToThreadCard(issue, { repo: "o/r" })).toEqual({
    kind: "issue",
    repo: "o/r",
    number: 1,
    url: "https://github.com/o/r/issues/1",
    title: "Title",
    state: "open",
    author: { login: "alice", url: "https://github.com/alice", type: "User" },
    labels: ["a", "b"],
    assignees: ["bob", "carol"],
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt: "2020-01-02T00:00:00Z",
    commentsCount: 7,
  });
});

test("mapRestThreadToThreadCard maps deterministic PR ThreadCard", () => {
  const issue = {
    number: 2,
    html_url: "https://github.com/o/r/pull/2",
    title: "PR",
    state: "open",
    pull_request: { url: "https://api.github.com/repos/o/r/pulls/2" },
    user: { login: "alice", html_url: "https://github.com/alice", type: "User" },
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2020-01-02T00:00:00Z",
    labels: [],
    assignees: [],
    comments: 0,
  };

  expect(mapRestThreadToThreadCard(issue, { repo: "o/r" })).toEqual({
    kind: "pull",
    repo: "o/r",
    number: 2,
    url: "https://github.com/o/r/pull/2",
    title: "PR",
    state: "open",
    author: { login: "alice", url: "https://github.com/alice", type: "User" },
    labels: [],
    assignees: [],
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt: "2020-01-02T00:00:00Z",
    commentsCount: 0,
  });
});
