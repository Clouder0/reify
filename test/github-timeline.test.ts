import { expect, test } from "bun:test";

import {
  mapRestTimelineItemToStreamItem,
  normalizeStreamEventTypes,
} from "../src/kits/github/internal/timeline";

test("normalizeStreamEventTypes defaults to stable supported set", () => {
  expect(normalizeStreamEventTypes(undefined)).toEqual([
    "labeled",
    "unlabeled",
    "assigned",
    "unassigned",
    "closed",
    "reopened",
    "cross-referenced",
  ]);
});

test("normalizeStreamEventTypes treats eventTypes as a set with stable order", () => {
  expect(normalizeStreamEventTypes(["ASSIGNED", " labeled ", "assigned"])).toEqual([
    "labeled",
    "assigned",
  ]);
});

test("normalizeStreamEventTypes allows empty list (no events)", () => {
  expect(normalizeStreamEventTypes([])).toEqual([]);
});

test("normalizeStreamEventTypes rejects unknown values", () => {
  expect(() => normalizeStreamEventTypes(["nope"])).toThrow(/eventTypes/i);
});

test("mapRestTimelineItemToStreamItem maps commented -> StreamCommentItem with truncation", () => {
  const item = {
    event: "commented",
    id: 113,
    html_url: "https://github.com/o/r/issues/1#issuecomment-113",
    user: { login: "alice", html_url: "https://github.com/alice", type: "User" },
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2020-01-02T00:00:00Z",
    body: "x".repeat(200),
  };

  const out = mapRestTimelineItemToStreamItem(item, {
    includeComments: true,
    includeEvents: false,
    allowedEventTypes: new Set(),
    maxCommentBodyChars: 80,
  });

  expect(out).toMatchObject({
    kind: "comment",
    commentId: 113,
    bodyTruncated: true,
    author: { login: "alice" },
  });
  expect((out as any).body.length).toBe(80);
});

test("mapRestTimelineItemToStreamItem skips commented when includeComments=false", () => {
  const item = {
    event: "commented",
    id: 113,
    html_url: "https://github.com/o/r/issues/1#issuecomment-113",
    user: { login: "alice", html_url: "https://github.com/alice", type: "User" },
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2020-01-02T00:00:00Z",
    body: "hello",
  };

  expect(
    mapRestTimelineItemToStreamItem(item, {
      includeComments: false,
      includeEvents: true,
      allowedEventTypes: new Set(["commented"]),
      maxCommentBodyChars: 80,
    }),
  ).toBeNull();
});

test("mapRestTimelineItemToStreamItem maps labeled event", () => {
  const item = {
    event: "labeled",
    created_at: "2020-01-01T00:00:00Z",
    actor: { login: "alice", html_url: "https://github.com/alice", type: "User" },
    label: { name: "bug" },
  };

  expect(
    mapRestTimelineItemToStreamItem(item, {
      includeComments: false,
      includeEvents: true,
      allowedEventTypes: new Set(["labeled"]),
      maxCommentBodyChars: 9999,
    }),
  ).toEqual({
    kind: "event",
    eventType: "labeled",
    createdAt: "2020-01-01T00:00:00Z",
    actor: { login: "alice", url: "https://github.com/alice", type: "User" },
    label: "bug",
  });
});

test("mapRestTimelineItemToStreamItem maps closed event with normalized stateReason", () => {
  const item = {
    event: "closed",
    created_at: "2020-01-01T00:00:00Z",
    actor: { login: "alice", html_url: "https://github.com/alice", type: "User" },
    state_reason: "not_planned",
  };

  expect(
    mapRestTimelineItemToStreamItem(item, {
      includeComments: false,
      includeEvents: true,
      allowedEventTypes: new Set(["closed"]),
      maxCommentBodyChars: 9999,
    }),
  ).toEqual({
    kind: "event",
    eventType: "closed",
    createdAt: "2020-01-01T00:00:00Z",
    actor: { login: "alice", url: "https://github.com/alice", type: "User" },
    stateReason: "not_planned",
  });
});

test("mapRestTimelineItemToStreamItem maps cross-referenced event and infers pull vs issue", () => {
  const item = {
    event: "cross-referenced",
    created_at: "2020-01-01T00:00:00Z",
    actor: { login: "alice", html_url: "https://github.com/alice", type: "User" },
    source: {
      issue: {
        number: 42,
        html_url: "https://github.com/o/r/pull/42",
        title: "Add feature",
        pull_request: { url: "https://api.github.com/repos/o/r/pulls/42" },
      },
    },
  };

  expect(
    mapRestTimelineItemToStreamItem(item, {
      includeComments: false,
      includeEvents: true,
      allowedEventTypes: new Set(["cross-referenced"]),
      maxCommentBodyChars: 9999,
    }),
  ).toEqual({
    kind: "event",
    eventType: "cross-referenced",
    createdAt: "2020-01-01T00:00:00Z",
    actor: { login: "alice", url: "https://github.com/alice", type: "User" },
    source: {
      kind: "pull",
      repo: "o/r",
      number: 42,
      url: "https://github.com/o/r/pull/42",
      title: "Add feature",
    },
  });
});

test("mapRestTimelineItemToStreamItem skips unsupported events safely", () => {
  const item = { event: "locked", created_at: "2020-01-01T00:00:00Z" };
  expect(
    mapRestTimelineItemToStreamItem(item, {
      includeComments: false,
      includeEvents: true,
      allowedEventTypes: new Set(["locked"]),
      maxCommentBodyChars: 9999,
    }),
  ).toBeNull();
});
