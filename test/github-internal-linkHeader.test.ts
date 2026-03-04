import { expect, test } from "bun:test";

import { parseLinkHeaderPages } from "../src/kits/github/internal/linkHeader";

test("parseLinkHeaderPages returns empty for null", () => {
  expect(parseLinkHeaderPages(null)).toEqual({});
});

test("parseLinkHeaderPages extracts rel page numbers", () => {
  const link = [
    '<https://api.github.com/x?page=2&per_page=30>; rel="next"',
    '<https://api.github.com/x?page=9&per_page=30>; rel="last"',
    '<https://api.github.com/x?page=1&per_page=30>; rel="prev"',
  ].join(", ");
  expect(parseLinkHeaderPages(link)).toEqual({ next: 2, prev: 1, last: 9 });
});

test("parseLinkHeaderPages ignores invalid segments safely", () => {
  expect(parseLinkHeaderPages('garbage, <https://api.github.com/x?page=3>; rel="next"')).toEqual({
    next: 3,
  });
});
