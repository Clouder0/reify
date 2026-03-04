import { expect, test } from "bun:test";

test("github internal modules do not export issues-only helpers", async () => {
  const mappers = await import("../src/kits/github/internal/mappers");
  expect("mapSearchItemToIssueCard" in mappers).toBe(false);
  expect("mapRestIssueToIssue" in mappers).toBe(false);
  expect("mapRestIssueToIssueCard" in mappers).toBe(false);
  expect("mapRestIssueCommentToIssueComment" in mappers).toBe(false);

  const searchQuery = await import("../src/kits/github/internal/searchQuery");
  expect("buildSearchIssuesQuery" in searchQuery).toBe(false);
});
