import { expect, test } from "bun:test";

import { toGithubError } from "../src/kits/github/internal/errors";

test("toGithubError includes operation and status when present", () => {
  const err = { status: 403, message: "Forbidden" };
  const out = toGithubError(err, { operation: "github.searchThreads" });
  expect(out.message).toContain("github.searchThreads");
  expect(out.message).toContain("status 403");
  expect(out.message).toContain("Forbidden");
});

test("toGithubError redacts GitHub tokens", () => {
  const token = `ghp_${"a".repeat(36)}`;
  const out = toGithubError(new Error(`bad token ${token}`), { operation: "github.getThread" });
  expect(out.message).not.toContain(token);
});

test("toGithubError adds an actionable hint for rate limits", () => {
  const err = {
    status: 403,
    message:
      "API rate limit exceeded for 1.2.3.4. (But here's the good news: Authenticated requests get a higher rate limit.)",
  };
  const out = toGithubError(err, { operation: "github.listThreadStream" });
  expect(out.message).toContain("rate limit");
  expect(out.message).toContain("gh auth login");
  expect(out.message).toContain("GITHUB_TOKEN");
});
