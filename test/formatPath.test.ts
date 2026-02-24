import { expect, test } from "bun:test";

import { resolve } from "node:path";

import { formatPath } from "../src/kits/fs/index";

test("formatPath resolves relative paths against cwd", async () => {
  const cwd = process.cwd();
  const out = await formatPath({ path: "a/b", cwd, style: "native" });
  expect(out).toBe(resolve(cwd, "a/b"));
});

test("formatPath defaults to posix separators", async () => {
  const cwd = process.cwd();
  const expectedNative = resolve(cwd, "a/b");
  const out = await formatPath({ path: "a/b", cwd });
  expect(out).toBe(expectedNative.replace(/\\/g, "/"));
});

test("formatPath is hidden from listTools by default", () => {
  expect(formatPath.meta.hidden).toBe(true);
});
