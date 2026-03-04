import { expect, test } from "bun:test";

import { truncateTextMiddle } from "../src/kits/github/internal/truncate";

test("truncateTextMiddle returns input when under budget", () => {
  expect(truncateTextMiddle("hello", 10)).toEqual({ text: "hello", truncated: false });
});

test("truncateTextMiddle bounds output and preserves head and tail", () => {
  const input = `HEAD-${"x".repeat(200)}-TAIL`;
  const out = truncateTextMiddle(input, 80);

  expect(out.truncated).toBe(true);
  expect(out.text.length).toBe(80);
  expect(out.text.startsWith("HEAD-")).toBe(true);
  expect(out.text.endsWith("-TAIL")).toBe(true);
  expect(out.text).toContain("<truncated");
});

test("truncateTextMiddle returns empty string for non-positive budgets", () => {
  expect(truncateTextMiddle("hello", 0)).toEqual({ text: "", truncated: true });
  expect(truncateTextMiddle("", 0)).toEqual({ text: "", truncated: false });
  expect(truncateTextMiddle("hello", -5)).toEqual({ text: "", truncated: true });
});

test("truncateTextMiddle can degrade to a marker slice when max is tiny", () => {
  const out = truncateTextMiddle("a".repeat(100), 5);
  expect(out.truncated).toBe(true);
  expect(out.text.length).toBe(5);
});
