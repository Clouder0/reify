import { expect, test } from "bun:test";

import { mapSearchItemToThreadCard } from "../src/kits/github/internal/mappers";
import { buildSearchThreadsQuery } from "../src/kits/github/internal/searchQuery";

test("buildSearchThreadsQuery scopes to repo", () => {
  const out = buildSearchThreadsQuery({ repo: "o/r", text: "bug" });
  expect(out.executedQuery).toBe("repo:o/r is:open bug");
});

test("buildSearchThreadsQuery sorts and quotes labels", () => {
  const out = buildSearchThreadsQuery({
    repo: "o/r",
    labels: ["good first issue", "bug"],
  });
  expect(out.executedQuery).toBe(
    'repo:o/r is:open label:"bug" label:"good first issue"',
  );
});

test("buildSearchThreadsQuery appends raw qualifiers via query escape hatch", () => {
  const out = buildSearchThreadsQuery({ repo: "o/r", text: "panic", query: "in:title" });
  expect(out.executedQuery).toBe("repo:o/r is:open panic in:title");
});

test("buildSearchThreadsQuery signature changes with request-shaping inputs", () => {
  const a = buildSearchThreadsQuery({ repo: "o/r", text: "bug", state: "open" });
  const b = buildSearchThreadsQuery({ repo: "o/r", text: "bug", state: "closed" });
  expect(a.sig).not.toBe(b.sig);
});

test("mapSearchItemToThreadCard maps issue search items deterministically", () => {
  const item = {
    number: 123,
    title: "Fix panic",
    state: "open",
    state_reason: null,
    html_url: "https://github.com/o/r/issues/123",
    user: { login: "alice", html_url: "https://github.com/alice", type: "User" },
    labels: [{ name: "good first issue" }, { name: "bug" }],
    assignees: [{ login: "bob" }, { login: "carol" }],
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2020-01-02T00:00:00Z",
    comments: 5,
  };

  expect(mapSearchItemToThreadCard(item, { repo: "o/r" })).toEqual({
    kind: "issue",
    repo: "o/r",
    number: 123,
    url: "https://github.com/o/r/issues/123",
    title: "Fix panic",
    state: "open",
    author: { login: "alice", url: "https://github.com/alice", type: "User" },
    labels: ["bug", "good first issue"],
    assignees: ["bob", "carol"],
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt: "2020-01-02T00:00:00Z",
    commentsCount: 5,
  });
});

test("mapSearchItemToThreadCard maps pull request search items deterministically", () => {
  const item = {
    number: 456,
    title: "Fix panic (PR)",
    state: "closed",
    state_reason: null,
    html_url: "https://github.com/o/r/pull/456",
    pull_request: { url: "https://api.github.com/repos/o/r/pulls/456" },
    user: { login: "alice", html_url: "https://github.com/alice", type: "User" },
    labels: [{ name: "bug" }],
    assignees: [],
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2020-01-02T00:00:00Z",
    comments: 0,
  };

  expect(mapSearchItemToThreadCard(item, { repo: "o/r" })).toEqual({
    kind: "pull",
    repo: "o/r",
    number: 456,
    url: "https://github.com/o/r/pull/456",
    title: "Fix panic (PR)",
    state: "closed",
    author: { login: "alice", url: "https://github.com/alice", type: "User" },
    labels: ["bug"],
    assignees: [],
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt: "2020-01-02T00:00:00Z",
    commentsCount: 0,
  });
});
