import { expect, test } from "bun:test";

import { parseRef } from "../src/kits/github/index";

test("parseRef parses issue URL", async () => {
  const out = await parseRef({ ref: "https://github.com/octocat/Hello-World/issues/123" });
  expect(out).toEqual({
    repo: "octocat/Hello-World",
    kind: "issue",
    number: 123,
    url: "https://github.com/octocat/Hello-World/issues/123",
  });
});

test("parseRef parses pull URL", async () => {
  const out = await parseRef({ ref: "https://github.com/octocat/Hello-World/pull/45" });
  expect(out).toEqual({
    repo: "octocat/Hello-World",
    kind: "pull",
    number: 45,
    url: "https://github.com/octocat/Hello-World/pull/45",
  });
});

test("parseRef rejects non-github.com URL refs", async () => {
  await expect(parseRef({ ref: "https://ghe.example.com/octocat/Hello-World/issues/123" })).rejects.toThrow(
    /github\.com/i,
  );
});

test("parseRef parses owner/repo#number shorthand as an issue", async () => {
  const out = await parseRef({ ref: "octocat/Hello-World#9" });
  expect(out).toEqual({
    repo: "octocat/Hello-World",
    kind: "issue",
    number: 9,
    url: "https://github.com/octocat/Hello-World/issues/9",
  });
});

test("parseRef parses #number shorthand using defaultRepo", async () => {
  const out = await parseRef({ ref: "#9", defaultRepo: "octocat/Hello-World" });
  expect(out).toEqual({
    repo: "octocat/Hello-World",
    kind: "issue",
    number: 9,
    url: "https://github.com/octocat/Hello-World/issues/9",
  });
});

test("parseRef rejects #number shorthand without defaultRepo", async () => {
  await expect(parseRef({ ref: "#9" })).rejects.toThrow(/defaultRepo/i);
});

test("parseRef rejects malformed refs", async () => {
  await expect(parseRef({ ref: "nope" })).rejects.toThrow();
  await expect(parseRef({ ref: "octocat/Hello-World#" })).rejects.toThrow();
});

test("parseRef reports structural errors for URL refs", async () => {
  await expect(parseRef({ ref: "https://github.com/octocat/Hello-World/" })).rejects.toThrow(/ref URL/i);
});
